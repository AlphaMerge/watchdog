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
import { TemplateService } from '../src/notifications/templates.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const T0 = new Date('2026-10-04T15:15:06.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** Probe Health's recovery hold (`M-18`), which is what the rehearsal's recovery waited out. */
const HOLD_SECONDS = 300;

/** The template's default window, fifteen minutes. */
const WINDOW_SECONDS = 900;

/**
 * `N-20`: what a recipient sees, in order, when an alarm is held for a digest and recovers.
 *
 * Found by the field-test dress rehearsal (`docs/findings/2026-10-04-field-test-dress-rehearsal.md`).
 * Probe Health went to Warning at 15:15:06, and the default mode, `first-down-and-up`, holds a
 * Warning for the digest. It relapsed twice and was back for good at 15:17:36. Its recovery was
 * the window's first Up, so it went out at once when the five-minute hold ended, at 15:22:36: *the
 * probe is up*. The Warning came at 15:30:36, in the digest. Told it was back eight minutes before
 * being told anything was wrong, and then told about something already over.
 *
 * The scenario plays that sequence through the real engine, scheduler and dispatcher, on a ping
 * sensor whose trigger carries Probe Health's hold. The transport records rather than delivers:
 * what is asserted is the order and the count of the messages, which a mailbox sorted by its own
 * clock cannot show reliably.
 */
describe(
  'a held alarm and its recovery',
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
    let seen: OutgoingMessage[];
    let sensor: number;

    before(async () => {
      scratch = await createScratchDatabase('heldrecovery');
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
        siteName: 'Rehearsal',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
      seen = [];
      dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [
          {
            method: 'email',
            send: (message: OutgoingMessage) => {
              seen.push(message);
              return Promise.resolve({ ok: true, detail: 'recorded' } as const);
            },
          },
        ],
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_summary');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query('DELETE FROM notification_template');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);
      seen.length = 0;

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'rehearsal-target',
        host: '192.0.2.40',
      });
      sensor = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'ping',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    /** The runbook's template: one for the alarm and its recovery, in the default mode. */
    async function template(windowSeconds = WINDOW_SECONDS): Promise<number> {
      const created = await templates.create(testActor, {
        name: `On-call ${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor is %status',
        body: '%sensor is %status',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        summaryWindowSeconds: windowSeconds,
      });
      assert.equal(created.summarisation, 'first-down-and-up', 'the default mode');
      return created.id;
    }

    async function trigger(settings: Record<string, unknown>): Promise<void> {
      await triggers.create(testActor, h.rootId, { kind: 'state', settings });
    }

    /** One scan of the sensor, the way ingestion writes it. */
    async function scan(ok: boolean, seconds: number): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = [
        {
          sensorId: sensor,
          at: at(seconds),
          outcome: ok ? 'ok' : 'error',
          message: ok ? 'reachable' : 'no ICMP reply',
        },
      ];
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, [sensor], at(seconds));
      });
    }

    /** The alarm sweep and the delivery loop, at one moment, until the queue stops moving. */
    async function tick(seconds: number): Promise<void> {
      await scheduler.sweep(at(seconds));
      for (let round = 0; round < 20; round += 1) {
        if ((await dispatcher.dispatch(at(seconds))) === 0) return;
      }
      assert.fail('the queue never drained');
    }

    /** What the recipient has, oldest first: the subject, and each line of the body. */
    function inbox(): { subject: string; lines: string[] }[] {
      return seen.map((message) => ({ subject: message.subject, lines: message.body.split('\n') }));
    }

    async function requests(): Promise<string[]> {
      const rows = await db.query<{ reason: string; disposition: string; status: string }>(
        'SELECT reason, disposition, status FROM notification_request ORDER BY id',
      );
      return rows.map((row) => `${row.reason}/${row.disposition}/${row.status}`);
    }

    /**
     * The rehearsal: Warning at +0, +60 and +120 with returns between, back for good at +150.
     * The hold ends at +450, and the window opened at +1 is due at +901.
     */
    async function rehearsalOutage(): Promise<void> {
      await scan(false, 0);
      await tick(1);
      await scan(true, 30);
      await tick(31);
      await scan(false, 60);
      await tick(61);
      await scan(true, 90);
      await tick(91);
      await scan(false, 120);
      await tick(121);
      await scan(true, 150);
      await tick(151);
    }

    it('delivers a held Warning and its recovery together, the Warning first', async () => {
      const templateId = await template();
      await trigger({
        state: 'warning',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
        recoveryHoldSeconds: HOLD_SECONDS,
      });

      await rehearsalOutage();
      assert.deepEqual(inbox(), [], 'the Warning is held for the digest, as the mode says');

      // 15:22:36 in the rehearsal: the hold is over, and the recovery is owed.
      await tick(HOLD_SECONDS + 151);
      assert.deepEqual(
        inbox(),
        [],
        'the recovery waits for its Warning rather than arriving eight minutes before it',
      );
      assert.deepEqual(await requests(), ['initial/held/pending', 'recovery/held/pending']);

      // 15:30:36: the window closes.
      await tick(WINDOW_SECONDS + 1);
      assert.deepEqual(inbox(), [
        {
          subject: 'Rehearsal: 2 notifications — 1 up, 1 other',
          lines: ['ping is warning', 'ping is up'],
        },
      ]);
      assert.deepEqual(
        await requests(),
        ['initial/held/sent', 'recovery/held/sent'],
        'three Warnings were one alarm and one recovery, in one message',
      );

      // And nothing follows it.
      await tick(2 * WINDOW_SECONDS);
      assert.equal(seen.length, 1);
    });

    it('sends the recovery on its own once the digest has already told the Warning', async () => {
      // A one-minute window, so the digest goes before the hold ends: the recovery is then the
      // window's first Up, and goes at once, after the message it answers.
      const templateId = await template(60);
      await trigger({
        state: 'warning',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
        recoveryHoldSeconds: HOLD_SECONDS,
      });

      await rehearsalOutage();
      assert.deepEqual(inbox(), [
        { subject: 'Rehearsal: 1 notification — 1 other', lines: ['ping is warning'] },
      ]);

      await tick(HOLD_SECONDS + 151);
      assert.deepEqual(inbox(), [
        { subject: 'Rehearsal: 1 notification — 1 other', lines: ['ping is warning'] },
        { subject: 'ping is up', lines: ['ping is up'] },
      ]);
      assert.deepEqual(await requests(), ['initial/held/sent', 'recovery/immediate/sent']);
    });

    it('sends a Down at once and its recovery at once after it', async () => {
      // The first Down of a window is not held, so there is nothing for its recovery to wait
      // for: the default mode's two immediate messages, in order.
      const templateId = await template();
      await trigger({
        state: 'down',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
      });

      await scan(false, 0);
      await scan(false, 60);
      await tick(61);
      await scan(true, 90);
      await tick(91);

      assert.deepEqual(inbox(), [
        { subject: 'ping is down', lines: ['ping is down'] },
        { subject: 'ping is up', lines: ['ping is up'] },
      ]);
      assert.deepEqual(await requests(), ['initial/immediate/sent', 'recovery/immediate/sent']);
    });

    it('says nothing about a Down that recovers inside its latency', async () => {
      const templateId = await template();
      await trigger({
        state: 'down',
        initialLatencySeconds: 300,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
      });

      await scan(false, 0);
      await scan(false, 60);
      await tick(61);
      await scan(true, 90);
      await tick(91);
      await tick(WINDOW_SECONDS + 100);

      assert.deepEqual(inbox(), []);
      assert.deepEqual(await requests(), [], 'no alarm, so no recovery either');
    });
  },
);
