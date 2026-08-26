import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { TemplateService } from '../src/notifications/templates.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { ScheduleService } from '../src/schedules/service.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Monday 2026-08-31, in UTC, so a week-minute is arithmetic rather than a guess.
 *
 * The schedules below are active 09:00–17:00 on Monday and nothing else, which makes 10:00 an
 * hour inside office hours and 20:00 three hours outside them.
 */
const INSIDE = new Date('2026-08-31T10:00:00Z');
const OUTSIDE = new Date('2026-08-31T20:00:00Z');

describe(
  'template activation schedules',
  { skip: available ? false : 'no PostgreSQL on MS_TEST_DB_HOST' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let templates: TemplateService;
    let schedules: ScheduleService;
    let contexts: MessageContextLoader;
    let sensors: number[];

    before(async () => {
      scratch = await createScratchDatabase('templateschedule');
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
      schedules = new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_summary');
      await db.query('DELETE FROM notification_template');
      await db.query('DELETE FROM schedule WHERE built_in_id IS NULL');
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
      for (const name of ['Ping', 'HTTP', 'SSH']) {
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
      assert.ok(id !== undefined, `no sensor ${String(index)}`);
      return id;
    }

    /** Office hours: Monday 09:00–17:00 UTC and nothing else. */
    async function officeHours(name = 'Office hours'): Promise<number> {
      const created = await schedules.create(testActor, {
        name: `${name}-${String(process.hrtime.bigint())}`,
        description: '',
        polarity: 'active',
        timezone: 'UTC',
        periods: 'mo:09:00-mo:17:00',
      });
      return created.id;
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

    async function queue(templateId: number, sensor: number): Promise<number> {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO notification_request
           (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message)
         VALUES (now(), $1, NULL, 'state', $2, 'initial', 'down', 'no ICMP reply')
         RETURNING id::text AS id`,
        [sensor, templateId],
      );
      return Number(rows[0]?.id ?? 0);
    }

    function recorder() {
      const seen: OutgoingMessage[] = [];
      return {
        seen,
        transport: {
          method: 'email',
          send: (outgoing: OutgoingMessage) => {
            seen.push(outgoing);
            return Promise.resolve({ ok: true, detail: 'test' } as const);
          },
        },
      };
    }

    function dispatcherWith(transport: object): NotificationDispatcher {
      return new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport as never],
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
      });
    }

    async function statuses(): Promise<{ status: string; error: string | null }[]> {
      return db.query<{ status: string; error: string | null }>(
        'SELECT status, last_error AS error FROM notification_request ORDER BY id',
      );
    }

    // ---------------------------------------------------------------------------------------
    // The two answers, which are the whole ticket.
    // ---------------------------------------------------------------------------------------

    it('sends normally while the template is inside its schedule', async () => {
      const templateId = await template({ scheduleId: await officeHours() });
      await queue(templateId, sensorAt(0));

      const { seen, transport } = recorder();
      await dispatcherWith(transport).dispatch(INSIDE);
      assert.equal(seen.length, 1);
    });

    it('holds a message until the schedule reopens, when asked to collect', async () => {
      // "Collect and send when reactivated": a daytime team's queue wants every one of them
      // waiting on Monday morning.
      const templateId = await template({ scheduleId: await officeHours(), whenInactive: 'queue' });
      await queue(templateId, sensorAt(0));

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch(OUTSIDE);
      assert.equal(seen.length, 0, 'nothing goes out after hours');
      assert.deepEqual(
        (await statuses()).map((row) => row.status),
        ['pending'],
        'and nothing is lost either',
      );

      await dispatcher.dispatch(INSIDE);
      assert.equal(seen.length, 1, 'it arrives when the schedule reopens');
    });

    it('throws a message away when asked to discard, and says which schedule did it', async () => {
      // The opposite want, and just as real: an on-call rota that pages at 03:00 does not want
      // yesterday evening's alarms arriving at breakfast.
      const templateId = await template({
        scheduleId: await officeHours(),
        whenInactive: 'discard',
      });
      await queue(templateId, sensorAt(0));

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch(OUTSIDE);
      assert.equal(seen.length, 0);

      const [row] = await statuses();
      assert.ok(row !== undefined);
      assert.equal(row.status, 'discarded');
      assert.match(String(row.error), /outside its "Office hours/);
      assert.match(String(row.error), /active again at/);

      await dispatcher.dispatch(INSIDE);
      assert.equal(seen.length, 0, 'and it does not come back when the schedule reopens');
    });

    it('counts a discard as a discard rather than as a failure', async () => {
      // A notification nobody was meant to receive did not fail. Counting it as one would put it
      // on `N-13`'s Core Health failure count and send an operator looking for a relay problem
      // that does not exist.
      const templateId = await template({
        scheduleId: await officeHours(),
        whenInactive: 'discard',
      });
      await queue(templateId, sensorAt(0));

      const { transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch(OUTSIDE);
      assert.equal(dispatcher.stats.discarded, 1);
      assert.equal(dispatcher.stats.failed, 0);
      assert.equal(dispatcher.stats.sent, 0);
    });

    it('leaves a template with no schedule alone at every hour', async () => {
      const templateId = await template();
      await queue(templateId, sensorAt(0));
      const { seen, transport } = recorder();
      await dispatcherWith(transport).dispatch(OUTSIDE);
      assert.equal(seen.length, 1);
    });

    // ---------------------------------------------------------------------------------------
    // How a collected backlog meets N-11.
    // ---------------------------------------------------------------------------------------

    it('summarises a night’s backlog as one storm when the schedule reopens', async () => {
      // Rather than as windows that opened and closed while nobody was listening. This is why a
      // suppressed template's requests are left *undecided* rather than being decided and held.
      const templateId = await template({
        scheduleId: await officeHours(),
        whenInactive: 'queue',
        summarisation: 'first-down-and-up',
        summaryWindowSeconds: 60,
      });
      for (const sensor of sensors) await queue(templateId, sensor);

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch(OUTSIDE);
      const windows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_summary',
      );
      assert.equal(windows[0]?.n, '0', 'no window opened while the template was switched off');

      await dispatcher.dispatch(INSIDE);
      assert.equal(seen.length, 1, 'the first one, immediately');
      await db.query('UPDATE notification_summary SET due_at = $1 WHERE closed_at IS NULL', [
        new Date(INSIDE.getTime() - 1000),
      ]);
      await dispatcher.dispatch(INSIDE);
      assert.equal(seen.length, 2);
      assert.match(String(seen[1]?.subject), /2 notifications/);
    });

    // ---------------------------------------------------------------------------------------
    // The references, in both directions.
    // ---------------------------------------------------------------------------------------

    it('refuses a schedule that is not there, in words rather than a constraint name', async () => {
      await assert.rejects(template({ scheduleId: 999_999 }), (error: unknown) =>
        /no schedule 999999/.test((error as Error).message),
      );
    });

    it('refuses to delete a schedule a template is still using', async () => {
      // The database would refuse it anyway — the column is a real foreign key with RESTRICT.
      // This is the same refusal with the template's name in it.
      const scheduleId = await officeHours();
      await template({ scheduleId });
      await assert.rejects(schedules.delete(testActor, scheduleId), (error: unknown) =>
        /notification template/.test((error as Error).message),
      );
    });

    it('clears the schedule on an explicit null and keeps it when the field is absent', async () => {
      // The same absent-versus-null distinction the secret merge draws, for the same reason: a
      // form rendered from a read and sent back unchanged must not un-schedule the template.
      const scheduleId = await officeHours();
      const created = await templates.create(testActor, {
        name: `On-call-${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        scheduleId,
        whenInactive: 'discard',
      });
      assert.equal(created.scheduleId, scheduleId);
      assert.match(String(created.scheduleName), /^Office hours/);
      assert.equal(created.whenInactive, 'discard');

      const kept = await templates.update(testActor, created.id, {
        name: created.name,
        method: 'email',
        settings: {},
        subject: '%sensor',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
      });
      assert.equal(kept.scheduleId, scheduleId, 'absent means unchanged');

      const cleared = await templates.update(testActor, created.id, {
        name: created.name,
        method: 'email',
        settings: {},
        subject: '%sensor',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        scheduleId: null,
      });
      assert.equal(cleared.scheduleId, null, 'and null means always active');
      assert.equal(cleared.scheduleName, null);
    });
  },
);
