import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { splitDigest } from '../src/notifications/summarisation.js';
import { TemplateService } from '../src/notifications/templates.js';
import { readingMessage } from '../src/state/machine.js';
import { readSensorState, writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const SENSORS = 20;
const T0 = new Date(Date.now() - 10 * 60_000);
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

const BREACH = 'Response time is 812 ms, above the error limit of 500 ms';
const CHECK = '2/2 replies, min 812 ms';
const BOTH = `${BREACH} — ${CHECK}`;

describe('what a sensor whose readings decided its state says (`P-345`)', () => {
  const ROWS: readonly { channel: string; check: string; stored: string; why: string }[] = [
    { channel: BREACH, check: CHECK, stored: BOTH, why: 'both, the channel’s first' },
    { channel: BREACH, check: BREACH, stored: BREACH, why: 'once, when they say the same' },
    {
      channel: BREACH,
      check: '',
      stored: BREACH,
      why: 'the channel’s, when the check said nothing',
    },
    { channel: '', check: CHECK, stored: CHECK, why: 'the check’s, when no channel breached' },
    { channel: '', check: '', stored: '', why: 'nothing, when neither said anything' },
  ];
  for (const row of ROWS) {
    it(row.why, () => {
      assert.equal(readingMessage(row.channel, row.check), row.stored);
    });
  }
});

/**
 * **The check's sentence beside the channel's, in every notification body and digest, and no
 * more notifications for it** (`P-345`, `M-17`).
 *
 * Twenty pings breach their response-time error limit at once. An email trigger, summarised, and
 * a webhook trigger, never summarised, both at the root. Before `P-345` every body said only the
 * channel's sentence; now each says the channel's and then the check's. What must not change is
 * how many there are: one email now and one digest for the rest, one webhook each, and nothing
 * when the check's words change on the next scan while the breach stands.
 */
describe(
  'the check’s sentence in notifications and digests (`P-345`, `M-17`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let scheduler: AlarmScheduler;
    let dispatcher: NotificationDispatcher;
    const sent: { method: string; message: OutgoingMessage }[] = [];

    function recorder(method: string): object {
      return {
        method,
        send: (message: OutgoingMessage) => {
          sent.push({ method, message });
          return Promise.resolve({ ok: true, detail: 'recorded' } as const);
        },
      };
    }

    before(async () => {
      scratch = await createScratchDatabase('readingmessage');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      const contexts = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Acme production',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
      dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [recorder('email') as never, recorder('webhook') as never],
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(() => {
      sent.length = 0;
    });

    /** Results into states the way ingestion writes them: decide, write, react (`M-11`). */
    async function scan(sensors: readonly number[], when: Date, check: string): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = sensors.map((sensorId) => ({
        sensorId,
        at: when,
        outcome: 'ok',
        message: check,
        channels: {
          verdict: { state: 'down', cause: 'limit' },
          message: BREACH,
          breaches: [],
        },
      }));
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, sensors, when);
      });
    }

    async function drain(now: Date): Promise<void> {
      for (let round = 0; round < 40; round += 1) {
        if ((await dispatcher.dispatch(now)) === 0) return;
      }
      assert.fail('the queue never drained');
    }

    it('says both in every body and digest line, and sends no more for it', async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Edge probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'edge-router',
        host: '192.0.2.7',
      });
      const sensors: number[] = [];
      for (let n = 0; n < SENSORS; n += 1) {
        const sensor = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: `ping-${String(n).padStart(2, '0')}`,
          sensorType: 'icmp.ping',
        });
        sensors.push(sensor.id);
      }
      const mail = await templates.create(testActor, {
        name: 'Latency mail',
        method: 'email',
        settings: {},
        subject: '%sensor is %status: %lastmessage',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'noc@example.test' }],
        summaryWindowSeconds: 60,
      });
      const hook = await templates.create(testActor, {
        name: 'Latency hook',
        method: 'webhook',
        settings: {
          url: 'http://sink.test:9/alarms',
          verb: 'POST',
          contentType: 'application/json',
        },
        subject: '%sensor is %status',
        body: '{"message":"%lastmessage"}',
        recipients: [],
      });
      for (const templateId of [mail.id, hook.id]) {
        await triggers.create(testActor, h.rootId, {
          kind: 'state',
          settings: { state: 'down', initialLatencySeconds: 0, initialTemplateId: templateId },
        });
      }

      await scan(sensors, at(0), CHECK);
      for (const id of sensors) {
        const runtime = await readSensorState(db, id);
        assert.equal(runtime?.state, 'down');
        assert.equal(runtime.cause, 'limit');
        assert.equal(runtime.message, BOTH);
      }
      assert.equal(await scheduler.sweep(at(1)), SENSORS * 2, 'one chain per sensor per trigger');
      await drain(at(2));
      await drain(at(120));

      const emails = sent.filter((one) => one.method === 'email').map((one) => one.message);
      const hooks = sent.filter((one) => one.method === 'webhook').map((one) => one.message);
      assert.equal(hooks.length, SENSORS, 'a webhook is never summarised');

      // The first Down at once, and the other nineteen in digests. How many digests is the
      // §5.2 caps' answer for the lines as written: this subject carries `%lastmessage`, so its
      // lines are longer by the check's sentence, and a digest holds fewer of them. One line per
      // notification either way: no notification is added, and none is lost.
      const [first, ...digests] = emails;
      assert.ok(first !== undefined);
      assert.equal(first.subject, `ping-00 is down: ${BOTH}`);
      assert.equal(first.body, BOTH);
      const lines = digests.flatMap((one) => one.body.split('\n'));
      assert.equal(lines.length, SENSORS - 1, 'every other sensor, once');
      assert.ok(
        lines.every((line) => / is down: /u.test(line) && line.endsWith(`: ${BOTH}`)),
        lines.join(' | '),
      );
      const parts = splitDigest(lines.map((line) => ({ member: line, line })));
      assert.equal(digests.length, parts.length, digests.map((one) => one.subject).join(' | '));
      assert.ok(
        digests.every((one, part) =>
          one.subject.startsWith(
            `Acme production: ${String(parts[part]?.lines.length)} notifications — `,
          ),
        ),
        digests.map((one) => one.subject).join(' | '),
      );
      for (const one of hooks) {
        assert.deepEqual(JSON.parse(one.body), { message: BOTH });
      }

      // The breach stands and the check says something new: stored, and nothing sent for it.
      const queued = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      const delivered = sent.length;
      await scan(sensors, at(180), '2/2 replies, min 901 ms');
      assert.equal(await scheduler.sweep(at(181)), 0);
      await drain(at(400));
      const later = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(later[0]?.n, queued[0]?.n, 'no notification for new words');
      assert.equal(sent.length, delivered, 'and nothing sent');
      const runtime = await readSensorState(db, sensors[0] ?? 0);
      assert.equal(runtime?.message, `${BREACH} — 2/2 replies, min 901 ms`);
    });
  },
);
