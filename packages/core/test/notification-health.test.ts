import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { DeliveryHealthReader } from '../src/notifications/health.js';
import { NotificationLogReader } from '../src/notifications/log.js';
import { TemplateService } from '../src/notifications/templates.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { ApiServer } from '../src/api/server.js';
import { HistoryService } from '../src/timeseries/history.js';
import { AuditRepository } from '../src/audit/store.js';
import { testCatalogue } from './support/sensor-types.js';

const available = await databaseAvailable();

describe(
  'delivery retry and failure surfacing',
  { skip: available ? false : 'no PostgreSQL on MS_TEST_DB_HOST' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let templates: TemplateService;
    let contexts: MessageContextLoader;
    let sensors: number[];

    before(async () => {
      scratch = await createScratchDatabase('notifhealth');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      contexts = new MessageContextLoader({
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
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_summary');
      await db.query('DELETE FROM notification_template');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'edge-router',
        host: '192.0.2.7',
      });
      sensors = [];
      for (const name of ['Ping', 'HTTP']) {
        const sensor = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name,
          sensorType: 'icmp.ping',
        });
        sensors.push(sensor.id);
      }

      const states = h.states;
      assert.ok(states !== undefined);
      const base = new Date(Date.now() - 600_000);
      for (const offset of [0, 60_000]) {
        const when = new Date(base.getTime() + offset);
        const decisions = await states.decide(
          sensors.map((sensorId): SensorResult => ({
            sensorId,
            at: when,
            outcome: 'error',
            message: 'no ICMP reply',
          })),
        );
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
        });
      }
    });

    function sensorAt(index: number): number {
      const id = sensors[index];
      assert.ok(id !== undefined);
      return id;
    }

    async function template(overrides: Record<string, unknown> = {}): Promise<number> {
      const created = await templates.create(testActor, {
        name: `On-call-${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor on %device is %status',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        summarisation: 'always-immediate',
        ...overrides,
      });
      return created.id;
    }

    async function queue(templateId: number, sensor = sensorAt(0)): Promise<number> {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO notification_request
           (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message)
         VALUES (now(), $1, NULL, 'state', $2, 'initial', 'down', 'no ICMP reply')
         RETURNING id::text AS id`,
        [sensor, templateId],
      );
      return Number(rows[0]?.id ?? 0);
    }

    /** A transport that answers however the test needs. */
    function recorder(answer: () => { ok: boolean; retryable?: boolean } = () => ({ ok: true })) {
      const seen: OutgoingMessage[] = [];
      return {
        seen,
        transport: {
          method: 'email',
          send: (outgoing: OutgoingMessage) => {
            seen.push(outgoing);
            const decided = answer();
            return Promise.resolve(
              decided.ok
                ? ({ ok: true, detail: 'test' } as const)
                : ({
                    ok: false,
                    retryable: decided.retryable ?? true,
                    error: 'the relay refused it',
                  } as const),
            );
          },
        },
      };
    }

    function dispatcherWith(
      transport: object,
      overrides: Partial<ConstructorParameters<typeof NotificationDispatcher>[0]> = {},
    ): NotificationDispatcher {
      return new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport as never],
        leaseMs: 0,
        // Exactly the computed wait, so a test can assert the shape rather than a band.
        random: () => 1,
        ...overrides,
      });
    }

    async function row(id: number): Promise<{
      status: string;
      attempts: number;
      next: Date | null;
      error: string | null;
    }> {
      const rows = await db.query<{
        status: string;
        attempts: number;
        next_attempt_at: Date | null;
        last_error: string | null;
      }>(
        'SELECT status, attempts, next_attempt_at, last_error FROM notification_request WHERE id = $1',
        [id],
      );
      const found = rows[0];
      assert.ok(found !== undefined);
      return {
        status: found.status,
        attempts: found.attempts,
        next: found.next_attempt_at,
        error: found.last_error,
      };
    }

    // ---------------------------------------------------------------------------------------
    // Backoff.
    // ---------------------------------------------------------------------------------------

    it('waits longer after each failure instead of hammering the relay', async () => {
      const templateId = await template();
      const requestId = await queue(templateId);
      const dispatcher = dispatcherWith(recorder(() => ({ ok: false })).transport, {
        retry: { firstDelayMs: 1_000, factor: 2, maxDelayMs: 8_000, jitter: 0, maxAttempts: 10 },
      });

      const waits: number[] = [];
      for (let pass = 0; pass < 4; pass += 1) {
        const now = new Date(Date.now() + pass * 60_000);
        await dispatcher.dispatch(now);
        const after = await row(requestId);
        assert.equal(after.status, 'pending', 'still owed');
        assert.ok(after.next !== null);
        waits.push(after.next.getTime() - now.getTime());
        // The next pass has to be after the backoff, or nothing is claimable.
        await db.query('UPDATE notification_request SET next_attempt_at = NULL WHERE id = $1', [
          requestId,
        ]);
      }
      assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000]);
    });

    it('leases a claimed message rather than scheduling its retry', async () => {
      // The claim happens before the send and the send happens outside the transaction, so a core
      // that dies mid-conversation leaves a row that looks claimed and is not being worked on.
      // The lease is how long that row waits before somebody else tries it; the real backoff is
      // written when the attempt is recorded.
      const templateId = await template();
      const requestId = await queue(templateId);
      const dispatcher = dispatcherWith(recorder(() => ({ ok: false })).transport, {
        leaseMs: 300_000,
        retry: { firstDelayMs: 1_000, factor: 2, maxDelayMs: 8_000, jitter: 0, maxAttempts: 10 },
      });

      const now = new Date();
      await dispatcher.dispatch(now);
      const after = await row(requestId);
      assert.ok(after.next !== null);
      assert.equal(
        after.next.getTime() - now.getTime(),
        1_000,
        'the record replaced the lease with the backoff',
      );
    });

    it('gives up after the attempts it was given, and says it will not try again', async () => {
      const templateId = await template();
      const requestId = await queue(templateId);
      const dispatcher = dispatcherWith(recorder(() => ({ ok: false })).transport, {
        retry: { firstDelayMs: 0, factor: 1, maxDelayMs: 0, jitter: 0, maxAttempts: 3 },
      });

      for (let pass = 0; pass < 5; pass += 1) await dispatcher.dispatch();
      const after = await row(requestId);
      assert.equal(after.status, 'failed');
      assert.equal(after.attempts, 3, 'three, not five');
      assert.equal(after.next, null, 'and nothing is scheduled');
      assert.match(String(after.error), /the relay refused it/);
    });

    it('does not retry a rejection no amount of waiting fixes', async () => {
      const templateId = await template();
      const requestId = await queue(templateId);
      const dispatcher = dispatcherWith(
        recorder(() => ({ ok: false, retryable: false })).transport,
        { retry: { firstDelayMs: 0, factor: 1, maxDelayMs: 0, jitter: 0, maxAttempts: 10 } },
      );

      await dispatcher.dispatch();
      const after = await row(requestId);
      assert.equal(after.status, 'failed');
      assert.equal(after.attempts, 1);
    });

    // ---------------------------------------------------------------------------------------
    // Surfacing.
    // ---------------------------------------------------------------------------------------

    it('reports nothing wrong when there is nothing wrong', async () => {
      const templateId = await template();
      await queue(templateId);
      await dispatcherWith(recorder().transport).dispatch();

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.status, 'ok');
      assert.deepEqual(report.problems, []);
      assert.equal(report.pending, 0);
      assert.ok(report.lastDeliveredAt !== null);
    });

    it('warns while a message is being retried', async () => {
      const templateId = await template();
      await queue(templateId);
      await dispatcherWith(recorder(() => ({ ok: false })).transport, {
        retry: { firstDelayMs: 60_000, factor: 2, maxDelayMs: 60_000, jitter: 0, maxAttempts: 10 },
      }).dispatch();

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.status, 'warning');
      assert.equal(report.retrying, 1);
      assert.match(report.problems.join(' '), /being retried/);
    });

    it('is Down when an alarm was given up on, because nobody received it', async () => {
      // The failure the whole subsystem exists to prevent (`WORKFLOW.MD §6`).
      const templateId = await template();
      await queue(templateId);
      await dispatcherWith(recorder(() => ({ ok: false, retryable: false })).transport).dispatch();

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.status, 'down');
      assert.equal(report.failed, 1);
      assert.match(report.problems.join(' '), /given up on/);
      assert.match(report.problems.join(' '), /the relay refused it/);
    });

    it('is Down when a message has been undeliverable for too long', async () => {
      // A relay that has refused the same message for twenty minutes is not coming back on its
      // own, whatever the attempt count says.
      const templateId = await template();
      const requestId = await queue(templateId);
      await dispatcherWith(recorder(() => ({ ok: false })).transport, {
        retry: { firstDelayMs: 60_000, factor: 2, maxDelayMs: 60_000, jitter: 0, maxAttempts: 20 },
      }).dispatch();
      await db.query(
        "UPDATE notification_request SET at = now() - interval '30 minutes' WHERE id = $1",
        [requestId],
      );

      const report = await new DeliveryHealthReader({ staleAfterMs: 15 * 60_000 }).read(db);
      assert.equal(report.status, 'down');
      assert.match(report.problems.join(' '), /undeliverable for 30 minutes/);
    });

    it('does not call a deliberate discard a fault', async () => {
      // `N-12` throws these away on purpose. Counting them as failures would have an operator
      // investigating a relay that is working perfectly.
      const templateId = await template();
      const requestId = await queue(templateId);
      await db.query(
        // `settled_at` as well, which is what the discard path writes (`P-124`): the window is
        // measured on when a request stopped being owed, not on when it fell due.
        `UPDATE notification_request
         SET status = 'discarded', last_error = 'out of hours', settled_at = now()
         WHERE id = $1`,
        [requestId],
      );

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.status, 'ok');
      assert.equal(report.discarded, 1);
      assert.equal(report.failed, 0);
    });

    it('counts a failure by when it was given up on, not by when it fell due', async () => {
      // **`P-124`.** `at` is when the obligation fell due — migration 016 says so, and that is the
      // right meaning for a digest naming when an outage started. Counting failures by it asks a
      // different question: the default retry policy spends 45 to 90 minutes on nine backoffs
      // against a 60-minute window, so a notification that exhausted its retries usually fell due
      // outside the window and counted zero — and stopped being pending at the same moment, so
      // Delivery Health flipped from Down back to `ok` at the exact instant the alarm was
      // abandoned.
      const templateId = await template();
      const requestId = await queue(templateId);
      await db.query(
        `UPDATE notification_request
         SET status = 'failed', last_error = 'the relay refused it',
             at = now() - interval '90 minutes', settled_at = now() - interval '5 minutes'
         WHERE id = $1`,
        [requestId],
      );

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.failed, 1, 'it failed five minutes ago, inside any sane window');
      assert.equal(report.status, 'down');
    });

    it('does not call a message waiting for its digest window undeliverable', async () => {
      // **`P-125`.** A request collecting into an open window is doing what an operator
      // configured. Counting it as pending drove `notifyOldest` up all night and put Core Health
      // Down with "check the relay" for a digest due at eight in the morning.
      const templateId = await template();
      const requestId = await queue(templateId);
      const summary = await db.query<{ id: string }>(
        `INSERT INTO notification_summary (template_id, opened_at, due_at)
         VALUES ($1, now() - interval '6 hours', now() + interval '2 hours')
         RETURNING id::text AS id`,
        [templateId],
      );
      await db.query(
        `UPDATE notification_request SET summary_id = $2, at = now() - interval '6 hours'
         WHERE id = $1`,
        [requestId, Number(summary[0]?.id ?? 0)],
      );

      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.pending, 0, 'nothing is waiting on a relay');
      assert.equal(report.parked, 1, 'one is waiting on the clock, and says so');
      assert.equal(report.oldestPendingAt, null);
      assert.equal(report.status, 'ok');
    });

    it('does not call a message held by an activation schedule undeliverable either', async () => {
      // The other way to be waiting on purpose. The suppressed set comes from the dispatcher,
      // which computes it every pass anyway — this reader growing its own opinion about schedules
      // would be a second place for the two to disagree.
      const templateId = await template();
      const requestId = await queue(templateId);
      await db.query(
        `UPDATE notification_request SET at = now() - interval '6 hours' WHERE id = $1`,
        [requestId],
      );

      const unparked = await new DeliveryHealthReader().read(db);
      assert.equal(unparked.pending, 1, 'ordinarily it is simply waiting to be delivered');

      const report = await new DeliveryHealthReader().read(db, new Date(), [templateId]);
      assert.equal(report.pending, 0);
      assert.equal(report.parked, 1);
    });

    it('answers the same number over HTTP, where a schema was quietly deleting it', async () => {
      // **`R06` — two defects, one symptom, and no test on this route at all.**
      //
      // The response schemas declare `additionalProperties: false`, so fast-json-stringify
      // removes any key they do not list — silently, which is the mechanism this repository
      // documents at `routes/health.ts`. `parked` was computed, spread into the reply, and
      // deleted on the way out. Requests that used to appear in `pending` appeared in neither:
      // forty alarms collecting into a digest window answered `pending: 0` with no other number
      // anywhere, and an operator asking "is anything queued" was told nothing was.
      //
      // The second half is which templates count as parked. Core Health passed the suppressed
      // set and this route did not, so the same question had two answers depending on which of
      // them you asked. The reader is given the activation service instead.
      const templateId = await template();
      const requestId = await queue(templateId);
      const summary = await db.query<{ id: string }>(
        `INSERT INTO notification_summary (template_id, opened_at, due_at)
         VALUES ($1, now() - interval '6 hours', now() + interval '2 hours')
         RETURNING id::text AS id`,
        [templateId],
      );
      await db.query(
        `UPDATE notification_request SET summary_id = $2, at = now() - interval '6 hours'
         WHERE id = $1`,
        [requestId, Number(summary[0]?.id ?? 0)],
      );

      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: false,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        deliveryHealth: new DeliveryHealthReader(),
      });
      await server.build('9.9.9', h.service);
      try {
        const response = await server.app.inject({
          method: 'GET',
          url: '/api/v1/notification-health',
        });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ pending: number; parked?: number }>();
        assert.equal(body.pending, 0, 'nothing is waiting on a relay');
        assert.equal(body.parked, 1, 'and the one that is waiting on the clock is reported');
      } finally {
        await server.app.close();
      }
    });

    it('reads the queue rather than what this process remembers', async () => {
      // A core that restarted five minutes ago would otherwise report a clean sheet over a queue
      // full of undelivered alarms.
      const templateId = await template();
      await queue(templateId);
      await dispatcherWith(recorder(() => ({ ok: false, retryable: false })).transport).dispatch();

      // A fresh reader, holding nothing: what a restarted ms-core has.
      const report = await new DeliveryHealthReader().read(db);
      assert.equal(report.status, 'down');
      assert.equal(report.failed, 1);
      const [method] = report.methods;
      assert.ok(method !== undefined);
      assert.equal(method.method, 'email');
      assert.match(String(method.lastError), /the relay refused it/);
    });

    // ---------------------------------------------------------------------------------------
    // The log, which is where "the alarm itself is never lost" is actually true.
    // ---------------------------------------------------------------------------------------

    it('keeps a failed alarm readable, with the reason', async () => {
      const templateId = await template();
      const requestId = await queue(templateId);
      await dispatcherWith(recorder(() => ({ ok: false, retryable: false })).transport).dispatch();

      const entries = await new NotificationLogReader().list(db, { status: ['failed'] });
      assert.equal(entries.length, 1);
      const [entry] = entries;
      assert.ok(entry !== undefined);
      assert.equal(entry.id, requestId);
      assert.equal(entry.sensorName, 'Ping');
      assert.equal(entry.method, 'email');
      assert.equal(entry.reason, 'initial');
      assert.equal(entry.state, 'down');
      assert.match(String(entry.lastError), /the relay refused it/);
    });

    it('lists newest first and filters by sensor', async () => {
      const templateId = await template();
      await queue(templateId, sensorAt(0));
      const second = await queue(templateId, sensorAt(1));
      await dispatcherWith(recorder().transport).dispatch();

      const log = new NotificationLogReader();
      const all = await log.list(db);
      assert.deepEqual(
        all.map((entry) => entry.id),
        [second, second - 1],
        'newest first',
      );
      const one = await log.list(db, { sensorId: sensorAt(1) });
      assert.deepEqual(
        one.map((entry) => entry.sensorName),
        ['HTTP'],
      );
    });

    it('pages backwards by id, so a new notification cannot shift a page', async () => {
      const templateId = await template();
      const ids: number[] = [];
      for (let index = 0; index < 5; index += 1) ids.push(await queue(templateId));

      const log = new NotificationLogReader();
      const first = await log.list(db, { limit: 2 });
      assert.deepEqual(
        first.map((entry) => entry.id),
        [ids[4], ids[3]],
      );
      const next = await log.list(db, { limit: 2, before: first[1]?.id ?? 0 });
      assert.deepEqual(
        next.map((entry) => entry.id),
        [ids[2], ids[1]],
      );
    });
  },
);
