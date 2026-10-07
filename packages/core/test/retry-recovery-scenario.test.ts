import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { DeliveryResult, OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import type { RetryPolicy } from '../src/notifications/retry.js';
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

const T0 = new Date('2026-10-07T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/**
 * `N-13`'s backoff without its jitter, so the retries fall due at known moments: the first a
 * minute after the refusal, the second two minutes after that, and the third attempt the last.
 */
const RETRY: RetryPolicy = {
  firstDelayMs: 60_000,
  factor: 2,
  maxDelayMs: 900_000,
  jitter: 0,
  maxAttempts: 3,
};

/**
 * `N-21`: what a recipient sees, in order, when an alarm sent at once is refused and its sensor
 * recovers while the alarm waits for its retry.
 *
 * `N-20` kept a held alarm's recovery behind it in the digest. An alarm that is *not* held — the
 * first Down of a window, or anything on a method that is never summarised — goes at once, and
 * when its relay refuses it the row waits out `N-13`'s backoff. Its recovery was decided and sent
 * at once as well, so inside that minute the recipient was told *ping is up*, and a minute later
 * *ping is down*, about an outage already over.
 *
 * The real engine, scheduler and dispatcher, with a transport that records every attempt and
 * refuses the ones a test tells it to. What is asserted is the order and the count of what was
 * delivered, which is what the recipient sees.
 */
describe(
  'an alarm awaiting its retry and its recovery',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let contexts: MessageContextLoader;
    let scheduler: AlarmScheduler;
    let dispatcher: NotificationDispatcher;
    /** Every attempt the transport was handed, delivered or not. */
    let attempts: string[];
    /** What reached the recipient, in the order it arrived. */
    let inbox: string[];
    /**
     * Whether to refuse this attempt, and how. Null delivers it. `attempt` counts the attempts
     * at this subject so far, this one included.
     */
    let refuse: (subject: string, attempt: number, requestId: number) => DeliveryResult | null;
    let sensor: number;

    /** A dispatcher of its own, which is what a core that has just started has. */
    function freshDispatcher(): NotificationDispatcher {
      return new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [
          {
            method: 'email',
            send: (message: OutgoingMessage) => {
              attempts.push(message.subject);
              const tries = attempts.filter((subject) => subject === message.subject).length;
              const refused = refuse(message.subject, tries, message.requestId);
              if (refused !== null) return Promise.resolve(refused);
              inbox.push(message.subject);
              return Promise.resolve({ ok: true, detail: 'recorded' } as const);
            },
          },
        ],
        retry: RETRY,
        leaseMs: 0,
      });
    }

    before(async () => {
      scratch = await createScratchDatabase('retryrecovery');
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
      contexts = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Retry',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
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
      attempts = [];
      inbox = [];
      refuse = () => null;
      dispatcher = freshDispatcher();

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'retry-target',
        host: '192.0.2.41',
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

    /**
     * A template in the default mode, so the first Down and the first Up go at once — or in
     * `always-immediate`, which is what a method that is never summarised behaves as.
     */
    async function template(
      subject = '%sensor is %status',
      summarisation?: 'always-immediate',
    ): Promise<number> {
      const created = await templates.create(testActor, {
        name: `On-call ${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject,
        body: subject,
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        ...(summarisation === undefined ? {} : { summarisation }),
      });
      assert.equal(created.summarisation, summarisation ?? 'first-down-and-up');
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

    async function requests(): Promise<string[]> {
      const rows = await db.query<{ reason: string; disposition: string; status: string }>(
        'SELECT reason, disposition, status FROM notification_request ORDER BY id',
      );
      return rows.map((row) => `${row.reason}/${row.disposition}/${row.status}`);
    }

    /** A Down that goes at once, refused on its first try, and back inside the retry delay. */
    async function refusedDownBackInsideTheDelay(): Promise<void> {
      const templateId = await template();
      await trigger({
        state: 'down',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
      });
      refuse = (subject, attempt) =>
        subject === 'ping is down' && attempt === 1
          ? { ok: false, retryable: true, error: '451 try again later' }
          : null;

      // Down at +60, its alarm sent at once and refused: the retry is due at +121.
      await scan(false, 0);
      await scan(false, 60);
      await tick(61);
      assert.deepEqual(attempts, ['ping is down'], 'the Down was tried at once');
      assert.deepEqual(inbox, [], 'and refused');
    }

    it('delivers the recovery after its alarm’s retry, not inside the retry delay', async () => {
      await refusedDownBackInsideTheDelay();

      // Back at +90, inside the minute the Down is waiting out.
      await scan(true, 90);
      await tick(91);
      assert.deepEqual(inbox, [], 'the Up waits for the Down it answers');
      assert.deepEqual(await requests(), [
        'initial/immediate/pending',
        'recovery/undecided/pending',
      ]);

      await tick(121);
      assert.deepEqual(inbox, ['ping is down', 'ping is up'], 'Down, then Up');
      assert.deepEqual(await requests(), ['initial/immediate/sent', 'recovery/immediate/sent']);

      // One outage, one alarm: nothing follows, and the refusal added no message.
      await tick(3_600);
      assert.deepEqual(inbox, ['ping is down', 'ping is up']);
    });

    it('keeps the recovery behind the retry across a restart of the core', async () => {
      await refusedDownBackInsideTheDelay();

      // The core restarts while the Down waits for its retry: nothing of the wait was in memory.
      dispatcher = freshDispatcher();
      await scan(true, 90);
      await tick(91);
      assert.deepEqual(inbox, [], 'still waiting after the restart');

      dispatcher = freshDispatcher();
      await tick(121);
      assert.deepEqual(inbox, ['ping is down', 'ping is up']);
      assert.deepEqual(await requests(), ['initial/immediate/sent', 'recovery/immediate/sent']);
    });

    it('sends the recovery on its own once its alarm has been given up on', async () => {
      // The relay refuses this Down every time. The recovery is not held for ever: it waits for
      // the alarm's retries, which are bounded, and goes once the alarm is given up on.
      const templateId = await template();
      await trigger({
        state: 'down',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
      });
      refuse = (subject) =>
        subject === 'ping is down'
          ? { ok: false, retryable: true, error: '554 message refused' }
          : null;

      await scan(false, 0);
      await scan(false, 60);
      await tick(61); // attempt 1, refused; the next due at +121
      await scan(true, 90);
      await tick(91);
      await tick(121); // attempt 2, refused; the next due at +241
      await tick(200);
      assert.deepEqual(inbox, [], 'nothing while the Down is still being tried');
      assert.deepEqual(await requests(), [
        'initial/immediate/pending',
        'recovery/undecided/pending',
      ]);

      await tick(241); // attempt 3, the last
      assert.deepEqual(attempts, ['ping is down', 'ping is down', 'ping is down', 'ping is up']);
      assert.deepEqual(inbox, ['ping is up'], 'the recovery goes once the Down is given up on');
      assert.deepEqual(await requests(), ['initial/immediate/failed', 'recovery/immediate/sent']);
    });

    it('waits for every alarm of the trigger, on whichever template it went', async () => {
      // Three actions on one trigger: the initial and the recovery to one template, the
      // escalation to another. The initial is delivered; the escalation is refused once, and the
      // sensor comes back while it waits.
      const onCall = await template();
      const escalation = await template('Escalated: %sensor is %status');
      await trigger({
        state: 'down',
        initialLatencySeconds: 0,
        initialTemplateId: onCall,
        escalationLatencySeconds: 120,
        escalationTemplateId: escalation,
        recoveryTemplateId: onCall,
      });
      refuse = (subject, attempt) =>
        subject.startsWith('Escalated') && attempt === 1
          ? { ok: false, retryable: true, error: '451 try again later' }
          : null;

      await scan(false, 0);
      await scan(false, 60);
      await tick(61);
      assert.deepEqual(inbox, ['ping is down']);

      // The escalation falls due at +180 and is refused: its retry is due at +260.
      await tick(200);
      assert.deepEqual(attempts, ['ping is down', 'Escalated: ping is down']);
      await scan(true, 210);
      await tick(211);
      assert.deepEqual(inbox, ['ping is down'], 'the Up waits for the escalation as well');

      await tick(260);
      assert.deepEqual(inbox, ['ping is down', 'Escalated: ping is down', 'ping is up']);
      assert.deepEqual(await requests(), [
        'initial/immediate/sent',
        'escalation/immediate/sent',
        'recovery/immediate/sent',
      ]);
    });

    /**
     * A Down refused, the sensor back, and Down again while the Up still waits for the first.
     * Sent at once (`always-immediate`, as a method never summarised is), so nothing but the
     * ordering stands between the second Down and the recipient.
     */
    async function downUpDownWhileTheFirstIsRefused(refusing: typeof refuse): Promise<void> {
      const templateId = await template('%sensor is %status', 'always-immediate');
      await trigger({
        state: 'down',
        initialLatencySeconds: 0,
        initialTemplateId: templateId,
        recoveryTemplateId: templateId,
      });
      refuse = refusing;

      await scan(false, 0);
      await scan(false, 60);
      await tick(61); // the first Down, refused: its retry is due at +121
      await scan(true, 90);
      await tick(91);
      await scan(false, 100);
      await scan(false, 110);
      await tick(111); // the second Down, never tried, and the relay is fine for it
      assert.deepEqual(
        await requests(),
        ['initial/immediate/pending', 'recovery/undecided/pending', 'initial/undecided/pending'],
        'the second Down is queued, and waits for the Up ahead of it',
      );
      assert.deepEqual(inbox, [], 'nothing has reached the recipient yet');
    }

    it('keeps a second Down behind the recovery that waits for the first', async () => {
      await downUpDownWhileTheFirstIsRefused((subject, attempt) =>
        subject === 'ping is down' && attempt === 1
          ? { ok: false, retryable: true, error: '503 service unavailable' }
          : null,
      );

      await tick(121);
      // Presence first, so an order assertion cannot pass on a message that never came.
      assert.equal(inbox.length, 3, 'two Downs and an Up');
      assert.ok(inbox.includes('ping is up'), 'the Up arrived');
      assert.equal(inbox.at(-1), 'ping is down', 'and the last word is that the sensor is Down');
      assert.deepEqual(inbox, ['ping is down', 'ping is up', 'ping is down']);
      assert.deepEqual(await requests(), [
        'initial/immediate/sent',
        'recovery/immediate/sent',
        'initial/immediate/sent',
      ]);
    });

    it('releases everything behind a Down once it is given up on', async () => {
      let first: number | undefined;
      await downUpDownWhileTheFirstIsRefused((subject, _attempt, requestId) => {
        if (subject === 'ping is down') first ??= requestId;
        return requestId === first
          ? { ok: false, retryable: true, error: '554 message refused' }
          : null;
      });

      await tick(121); // attempt 2, refused; the last is due at +241
      // A length rather than a deepEqual to [], which would narrow `inbox` to `never[]`.
      assert.equal(inbox.length, 0, 'still nothing while the first Down is being tried');

      await tick(241); // attempt 3, the last: the first Down is given up on
      assert.equal(inbox.length, 2, 'the Up and the second Down');
      assert.ok(inbox.includes('ping is up'), 'the Up arrived');
      assert.deepEqual(inbox, ['ping is up', 'ping is down']);
      assert.deepEqual(await requests(), [
        'initial/immediate/failed',
        'recovery/immediate/sent',
        'initial/immediate/sent',
      ]);
    });
  },
);
