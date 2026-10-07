import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { SummaryRepository } from '../src/notifications/summaries.js';
import { TemplateService } from '../src/notifications/templates.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { SensorState } from '../src/state/tables.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

describe(
  'notification summarisation',
  { skip: available ? false : 'no PostgreSQL on MS_TEST_DB_HOST' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let templates: TemplateService;
    let contexts: MessageContextLoader;
    let sensors: number[];

    before(async () => {
      scratch = await createScratchDatabase('notifsummary');
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
      for (const name of ['Ping', 'HTTP', 'SSH', 'DNS', 'SNMP']) {
        const sensor = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name,
          sensorType: 'icmp.ping',
        });
        sensors.push(sensor.id);
      }

      // All Down, so a message has something true to say.
      const states = h.states;
      assert.ok(states !== undefined);
      const base = new Date(Date.now() - 600_000);
      for (const offset of [0, 60_000]) {
        const when = new Date(base.getTime() + offset);
        const results: SensorResult[] = sensors.map((sensorId) => ({
          sensorId,
          at: when,
          outcome: 'error' as const,
          message: 'no ICMP reply',
        }));
        const decisions = await states.decide(results);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
        });
      }
    });

    /** The nth sensor, asserted rather than indexed, because strict indexing says it may be gone. */
    function sensorAt(index: number): number {
      const id = sensors[index];
      assert.ok(id !== undefined, `no sensor ${String(index)}`);
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
        ...overrides,
      });
      return created.id;
    }

    /** Queues one notification, the way the alarm engine does. */
    async function queue(
      templateId: number,
      options: {
        sensor?: number | undefined;
        reason?: string | undefined;
        state?: SensorState | null | undefined;
        triggerKind?: string | undefined;
        triggerId?: number | undefined;
        channelKey?: string | undefined;
      } = {},
    ): Promise<number> {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO notification_request
           (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message,
            channel_key)
         VALUES (now(), $1, $7, $5, $2, $3, $4, 'no ICMP reply', $6)
         RETURNING id::text AS id`,
        [
          options.sensor ?? sensorAt(0),
          templateId,
          options.reason ?? 'initial',
          options.state ?? 'down',
          options.triggerKind ?? 'state',
          options.channelKey ?? null,
          options.triggerId ?? null,
        ],
      );
      return Number(rows[0]?.id ?? 0);
    }

    /** A transport that records every message it was handed and always succeeds. */
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
                : ({ ok: false, retryable: decided.retryable ?? true, error: 'refused' } as const),
            );
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

    async function dispositions(): Promise<{ disposition: string; status: string }[]> {
      return db.query<{ disposition: string; status: string }>(
        'SELECT disposition, status FROM notification_request ORDER BY id',
      );
    }

    async function openWindows(): Promise<{ id: number; dueAt: Date }[]> {
      const rows = await db.query<{ id: string; due_at: Date }>(
        'SELECT id::text AS id, due_at FROM notification_summary WHERE closed_at IS NULL',
      );
      return rows.map((row) => ({ id: Number(row.id), dueAt: row.due_at }));
    }

    /** Moves every open window's due time into the past, which is what waiting would do. */
    async function elapse(): Promise<void> {
      await db.query(
        "UPDATE notification_summary SET due_at = now() - interval '1 second' WHERE closed_at IS NULL",
      );
    }

    // ---------------------------------------------------------------------------------------
    // The default, which is what most installations will run.
    // ---------------------------------------------------------------------------------------

    it('sends the first Down at once and collects the rest of the storm', async () => {
      // `WORKFLOW.MD §6`: an operator who has to wait fifteen minutes to hear that a datacentre
      // is down has not been notified. One message now, one digest later.
      const templateId = await template();
      for (const sensor of sensors) await queue(templateId, { sensor });

      const { seen, transport } = recorder();
      await dispatcherWith(transport).dispatch();

      assert.equal(seen.length, 1, 'one message went out immediately');
      assert.equal(seen[0]?.subject, 'Ping on edge-router is down');
      assert.deepEqual(
        (await dispositions()).map((row) => `${row.disposition}/${row.status}`),
        ['immediate/sent', 'held/pending', 'held/pending', 'held/pending', 'held/pending'],
      );
      assert.equal((await openWindows()).length, 1, 'and a window is collecting the rest');
    });

    it('sends the digest when the window closes, in the operator’s own words', async () => {
      const templateId = await template();
      for (const sensor of sensors) await queue(templateId, { sensor });

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      await elapse();
      await dispatcher.dispatch();

      assert.equal(seen.length, 2, 'the immediate one and one digest');
      const digest = seen[1];
      assert.ok(digest !== undefined);
      // Generated, because their subject is written about one sensor: "%sensor on %device is
      // %status" says nothing useful about four of them.
      assert.equal(digest.subject, 'Acme production: 4 notifications — 4 down');
      // Their wording is not thrown away — it becomes the lines.
      assert.deepEqual(digest.body.split('\n'), [
        'HTTP on edge-router is down',
        'SSH on edge-router is down',
        'DNS on edge-router is down',
        'SNMP on edge-router is down',
      ]);
      // **Every sensor it lists, not only the first** (`M-19`): a person is sent a digest only
      // if they may read all of it, so the rule has to be asked about all of it.
      assert.deepEqual(seen[0]?.about, [sensorAt(0)]);
      assert.deepEqual(
        [...digest.about].sort((a, b) => a - b),
        sensors.slice(1).sort((a, b) => a - b),
      );
      assert.deepEqual(
        (await dispositions()).map((row) => row.status),
        ['sent', 'sent', 'sent', 'sent', 'sent'],
      );
    });

    it('lets the first recovery through as well, which is what the default is for', async () => {
      const templateId = await template();
      await queue(templateId, { sensor: sensorAt(0) });
      await queue(templateId, { sensor: sensorAt(1) });
      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      await queue(templateId, { sensor: sensorAt(1), reason: 'recovery', state: 'up' });

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      // Two passes: a recovery is decided after its alarm has been (`N-20`).
      await dispatcher.dispatch();
      await dispatcher.dispatch();
      assert.equal(seen.length, 2, 'the first Down and the first Up');
      assert.deepEqual(
        (await dispositions()).map((row) => row.disposition),
        ['immediate', 'held', 'immediate', 'held'],
      );
    });

    // ---------------------------------------------------------------------------------------
    // A recovery is never told before its alarm (`N-20`).
    // ---------------------------------------------------------------------------------------

    it('holds a recovery beside its held alarm, so the digest tells the alarm first', async () => {
      // The rehearsal: a Warning is held, and its recovery was the window's first Up, so it went
      // out at once and the Warning came eight minutes later.
      const templateId = await template();
      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);

      await queue(templateId, { sensor: sensorAt(0), state: 'warning' });
      await dispatcher.dispatch();
      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      await dispatcher.dispatch();
      assert.equal(seen.length, 0, 'the recovery waits with its Warning');
      assert.deepEqual(
        (await dispositions()).map((row) => `${row.disposition}/${row.status}`),
        ['held/pending', 'held/pending'],
      );

      // Another sensor's recovery, with no alarm held, is still the window's first Up.
      await queue(templateId, { sensor: sensorAt(1), reason: 'recovery', state: 'up' });
      await dispatcher.dispatch();
      assert.deepEqual(
        seen.map((message) => message.subject),
        ['HTTP on edge-router is up'],
      );

      await elapse();
      await dispatcher.dispatch();
      assert.equal(seen.length, 2);
      assert.equal(seen[1]?.subject, 'Acme production: 2 notifications — 1 up, 1 other');
      assert.deepEqual(seen[1].body.split('\n'), [
        'Ping on edge-router is warning',
        'Ping on edge-router is up',
      ]);
    });

    it('decides a recovery a pass after its alarm when both are waiting together', async () => {
      // Decided in one pass, the recovery would be read before its alarm had a window to be
      // found in, and go first.
      const templateId = await template();
      await queue(templateId, { sensor: sensorAt(0), state: 'warning' });
      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.deepEqual(
        (await dispositions()).map((row) => row.disposition),
        ['held', 'undecided'],
      );
      await dispatcher.dispatch();
      assert.deepEqual(
        (await dispositions()).map((row) => row.disposition),
        ['held', 'held'],
      );
      assert.equal(seen.length, 0);
    });

    it('keeps a recovery behind its alarm held in another template’s digest', async () => {
      const alarms = await template();
      const recoveries = await template();
      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);

      await queue(alarms, { sensor: sensorAt(0), state: 'warning' });
      await dispatcher.dispatch();
      await queue(recoveries, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      await dispatcher.dispatch();
      assert.equal(seen.length, 0, 'it cannot join that digest, so it waits for it');
      assert.deepEqual(
        (await dispositions()).map((row) => row.disposition),
        ['held', 'undecided'],
      );

      await elapse();
      await dispatcher.dispatch();
      await dispatcher.dispatch();
      assert.deepEqual(
        seen.map((message) => message.subject),
        ['Acme production: 1 notification — 1 other', 'Ping on edge-router is up'],
      );
    });

    it('does not keep a recovery waiting for a digest that cannot be sent', async () => {
      const alarms = await template();
      const recoveries = await template();
      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);

      await queue(alarms, { sensor: sensorAt(0), state: 'warning' });
      await dispatcher.dispatch();
      await db.query('UPDATE notification_template SET enabled = false WHERE id = $1', [alarms]);
      await queue(recoveries, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      await dispatcher.dispatch();
      assert.deepEqual(
        seen.map((message) => message.subject),
        ['Ping on edge-router is up'],
      );
    });

    it('keeps a recovery beside its alarm while their digest waits out a refusal', async () => {
      const templateId = await template();
      let succeed = false;
      const { seen, transport } = recorder(() => ({ ok: succeed, retryable: true }));
      const dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport],
        retry: { firstDelayMs: 60_000, maxDelayMs: 60_000 },
        leaseMs: 0,
      });

      await queue(templateId, { sensor: sensorAt(0), state: 'warning' });
      await dispatcher.dispatch();
      await elapse();
      await dispatcher.dispatch();
      assert.equal(seen.length, 1, 'the digest of the Warning, refused');

      // The recovery arrives while the refused digest is waiting for its next try.
      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      succeed = true;
      await dispatcher.dispatch();
      assert.equal(seen.length, 1, 'not sent ahead of the Warning it answers');

      await dispatcher.dispatch(new Date(Date.now() + 60 * 60 * 1000));
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[1]?.body.split('\n'), [
        'Ping on edge-router is warning',
        'Ping on edge-router is up',
      ]);
    });

    it('holds only the alarm’s own recovery: same sensor, trigger and channel', async () => {
      type Queued = Parameters<typeof queue>[1];
      const breach = (channelKey: string): Queued => ({
        sensor: sensorAt(1),
        reason: 'threshold',
        state: 'warning',
        triggerKind: 'threshold',
        channelKey,
      });
      const clear = (channelKey?: string): Queued => ({
        sensor: sensorAt(1),
        reason: 'clear',
        state: 'up',
        triggerKind: 'threshold',
        channelKey,
      });
      // Two triggers on one sensor, so a recovery can be told apart from another trigger's.
      const triggerIds: number[] = [];
      for (let index = 0; index < 2; index += 1) {
        const rows = await db.query<{ id: string }>(
          `INSERT INTO notification_trigger (object_id, kind, settings)
           VALUES ($1, 'state', '{}'::jsonb) RETURNING id::text AS id`,
          [h.rootId],
        );
        triggerIds.push(Number(rows[0]?.id));
      }
      const [first, second] = triggerIds;
      const cases: { name: string; alarm: Queued; recovery: Queued; expected: string }[] = [
        {
          name: 'its own trigger’s recovery',
          alarm: { sensor: sensorAt(0), state: 'warning', triggerId: first },
          recovery: { sensor: sensorAt(0), reason: 'recovery', state: 'up', triggerId: first },
          expected: 'held',
        },
        {
          name: 'another trigger of the same kind',
          alarm: { sensor: sensorAt(0), state: 'warning', triggerId: first },
          recovery: { sensor: sensorAt(0), reason: 'recovery', state: 'up', triggerId: second },
          expected: 'immediate',
        },
        {
          name: 'its own recovery',
          alarm: { sensor: sensorAt(0), state: 'warning' },
          recovery: { sensor: sensorAt(0), reason: 'recovery', state: 'up' },
          expected: 'held',
        },
        {
          name: 'another sensor',
          alarm: { sensor: sensorAt(0), state: 'warning' },
          recovery: { sensor: sensorAt(1), reason: 'recovery', state: 'up' },
          expected: 'immediate',
        },
        {
          // No channel on either, so only the kind tells them apart.
          name: 'another kind of trigger',
          alarm: { sensor: sensorAt(1), state: 'warning' },
          recovery: clear(),
          expected: 'immediate',
        },
        { name: 'its own clear', alarm: breach('loss'), recovery: clear('loss'), expected: 'held' },
        {
          name: 'the same trigger, another channel',
          alarm: breach('loss'),
          recovery: clear('rtt'),
          expected: 'immediate',
        },
      ];

      for (const entry of cases) {
        await db.query('DELETE FROM notification_request');
        const templateId = await template();
        const dispatcher = dispatcherWith(recorder().transport);
        // A Down first, so that a threshold breach, which counts as one, is held as well.
        await queue(templateId, { sensor: sensorAt(2) });
        await queue(templateId, entry.alarm);
        await dispatcher.dispatch();
        await queue(templateId, entry.recovery);
        await dispatcher.dispatch();
        assert.deepEqual(
          (await dispositions()).map((row) => row.disposition),
          ['immediate', 'held', entry.expected],
          entry.name,
        );
      }
    });

    // ---------------------------------------------------------------------------------------
    // A recovery is not told before an alarm that is waiting out a retry (`N-21`).
    // ---------------------------------------------------------------------------------------

    it('keeps a recovery behind its immediate alarm while that alarm waits out a refusal', async () => {
      const templateId = await template();
      let succeed = false;
      const { seen, transport } = recorder(() => ({ ok: succeed, retryable: true }));
      const dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport],
        retry: { firstDelayMs: 60_000, maxDelayMs: 60_000, jitter: 0 },
        leaseMs: 0,
      });

      await queue(templateId, { sensor: sensorAt(0) });
      await dispatcher.dispatch();
      assert.equal(seen.length, 1, 'the Down, sent at once and refused');

      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });
      succeed = true;
      await dispatcher.dispatch();
      await dispatcher.dispatch();
      assert.equal(seen.length, 1, 'the Up is not sent inside the Down’s retry delay');
      assert.deepEqual(
        (await dispositions()).map((row) => `${row.disposition}/${row.status}`),
        ['immediate/pending', 'undecided/pending'],
      );

      const later = new Date(Date.now() + 60 * 60 * 1000);
      await dispatcher.dispatch(later);
      await dispatcher.dispatch(later);
      assert.deepEqual(
        seen.map((message) => message.subject),
        ['Ping on edge-router is down', 'Ping on edge-router is down', 'Ping on edge-router is up'],
      );
    });

    it('keeps a recovery waiting only on an owed alarm that something will send', async () => {
      const summaries = new SummaryRepository();
      interface Case {
        name: string;
        /** Whether the alarm went to the recovery's own template or to another. */
        own: boolean;
        disposition: 'immediate' | 'held';
        status: 'pending' | 'sent' | 'failed';
        /** What has happened to the alarm's template. */
        template?: 'disabled' | 'suppressed' | 'untransported';
        waits: boolean;
      }
      const owed = { disposition: 'immediate', status: 'pending' } as const;
      const cases: Case[] = [
        { name: 'awaiting a retry', own: true, ...owed, waits: true },
        { name: 'delivered', own: true, ...owed, status: 'sent', waits: false },
        { name: 'given up on', own: true, ...owed, status: 'failed', waits: false },
        { name: 'another template’s, awaiting a retry', own: false, ...owed, waits: true },
        {
          name: 'another template’s, given up on',
          own: false,
          ...owed,
          status: 'failed',
          waits: false,
        },
        {
          name: 'another template’s, disabled',
          own: false,
          ...owed,
          template: 'disabled',
          waits: false,
        },
        {
          name: 'another template’s, outside its activation schedule',
          own: false,
          ...owed,
          template: 'suppressed',
          waits: false,
        },
        {
          name: 'another template’s, with no transport in this build',
          own: false,
          ...owed,
          template: 'untransported',
          waits: false,
        },
        {
          // Nothing will send the recovery either until the template is enabled again, and
          // then the alarm goes first.
          name: 'its own template’s, disabled',
          own: true,
          ...owed,
          template: 'disabled',
          waits: true,
        },
        {
          // A held request whose window has gone is sent as a message of its own.
          name: 'held with no window',
          own: true,
          ...owed,
          disposition: 'held',
          waits: true,
        },
      ];

      for (const entry of cases) {
        await db.query('DELETE FROM notification_request');
        const recoveries = await template();
        const alarms = entry.own ? recoveries : await template();
        const alarm = await queue(alarms, { sensor: sensorAt(0) });
        await db.query(
          `UPDATE notification_request
           SET disposition = $2, status = $3, attempts = 1,
               next_attempt_at = now() + interval '1 minute'
           WHERE id = $1`,
          [alarm, entry.disposition, entry.status],
        );
        if (entry.template === 'disabled') {
          await db.query('UPDATE notification_template SET enabled = false WHERE id = $1', [
            alarms,
          ]);
        }
        const recovery = await queue(recoveries, {
          sensor: sensorAt(0),
          reason: 'recovery',
          state: 'up',
        });
        const suppressed = entry.template === 'suppressed' ? [alarms] : [];
        const methods = entry.template === 'untransported' ? [] : ['email'];
        const decidable = await db.tx((q) => summaries.undecided(q, 100, suppressed, methods));
        assert.equal(
          decidable.some((request) => request.id === recovery),
          !entry.waits,
          entry.name,
        );
      }
    });

    // ---------------------------------------------------------------------------------------
    // The other five modes, where they differ.
    // ---------------------------------------------------------------------------------------

    it('never opens a window for a template that always sends immediately', async () => {
      const templateId = await template({ summarisation: 'always-immediate' });
      for (const sensor of sensors) await queue(templateId, { sensor });

      const { seen, transport } = recorder();
      await dispatcherWith(transport).dispatch();
      assert.equal(seen.length, 5);
      assert.deepEqual(await openWindows(), [], 'and nothing to close later');
    });

    it('holds even the first message when the mode says always summarise', async () => {
      const templateId = await template({ summarisation: 'always-summarise' });
      await queue(templateId);

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.equal(seen.length, 0, 'nothing goes out yet');

      await elapse();
      await dispatcher.dispatch();
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.subject, 'Acme production: 1 notification — 1 down');
    });

    it('sends every Down but collects the recoveries', async () => {
      const templateId = await template({ summarisation: 'downs-immediate' });
      for (const sensor of sensors) await queue(templateId, { sensor });
      await queue(templateId, { sensor: sensorAt(0), reason: 'recovery', state: 'up' });

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      // Two passes: a recovery is decided after its alarm has been (`N-20`).
      await dispatcher.dispatch();
      await dispatcher.dispatch();
      assert.equal(seen.length, 5, 'every Down');
      assert.deepEqual(
        (await dispositions()).map((row) => row.disposition),
        ['immediate', 'immediate', 'immediate', 'immediate', 'immediate', 'held'],
      );
    });

    // ---------------------------------------------------------------------------------------
    // Methods that are never summarised.
    // ---------------------------------------------------------------------------------------

    it('refuses to store a summarisation mode a method will not honour', async () => {
      // `CAPABILITIES.MD §5.2`: Slack, Teams, HTTP action and execute program always send
      // immediately. Forced rather than accepted-and-ignored, so a form cannot show a mode the
      // dispatcher does not obey.
      const created = await templates.create(testActor, {
        name: `Chat-${String(process.hrtime.bigint())}`,
        method: 'slack',
        settings: { webhookUrl: 'https://hooks.example.test/x' },
        subject: '%sensor is %status',
        body: '%lastmessage',
        summarisation: 'always-summarise',
      });
      assert.equal(created.summarisation, 'always-immediate');
      assert.equal(created.summarisable, false);
    });

    it('never holds a message for a method that is never summarised', async () => {
      // Belt and braces: even a row written past the service — by an older build, or by hand —
      // is sent rather than collected, because the dispatcher asks the method and not the row.
      const created = await templates.create(testActor, {
        name: `Chat-${String(process.hrtime.bigint())}`,
        method: 'slack',
        settings: { webhookUrl: 'https://hooks.example.test/x' },
        subject: '%sensor is %status',
        body: '%lastmessage',
      });
      await db.query('UPDATE notification_template SET summarisation = $2 WHERE id = $1', [
        created.id,
        'always-summarise',
      ]);
      for (const sensor of sensors) await queue(created.id, { sensor });

      const { seen, transport } = recorder();
      await dispatcherWith({ ...transport, method: 'slack' }).dispatch();
      assert.equal(seen.length, 5);
      assert.deepEqual(await openWindows(), []);
    });

    // ---------------------------------------------------------------------------------------
    // The caps, and what happens when a storm is bigger than one message.
    // ---------------------------------------------------------------------------------------

    it('splits an overflowing digest and still delivers every notification', async () => {
      const templateId = await template({ summarisation: 'always-summarise' });
      for (let index = 0; index < 60; index += 1) {
        await queue(templateId, { sensor: sensorAt(index % sensors.length) });
      }

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      await elapse();
      await dispatcher.dispatch();

      assert.equal(seen.length, 3, '25 + 25 + 10');
      assert.deepEqual(
        seen.map((message) => message.subject),
        [
          'Acme production: 25 notifications — 25 down (1 of 3)',
          'Acme production: 25 notifications — 25 down (2 of 3)',
          'Acme production: 10 notifications — 10 down (3 of 3)',
        ],
      );
      const rows = await dispositions();
      assert.equal(rows.length, 60);
      assert.ok(
        rows.every((row) => row.status === 'sent'),
        'nothing was dropped on the floor',
      );
    });

    // ---------------------------------------------------------------------------------------
    // Durability, and the guards.
    // ---------------------------------------------------------------------------------------

    it('holds a request out of the immediate queue until its window closes', async () => {
      const templateId = await template({ summarisation: 'always-summarise' });
      await queue(templateId);

      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      for (let pass = 0; pass < 3; pass += 1) await dispatcher.dispatch();
      assert.equal(seen.length, 0, 'a held request is the digest’s, not the queue’s');
    });

    it('survives a restart, because a window is a row and not a timer', async () => {
      const templateId = await template();
      for (const sensor of sensors) await queue(templateId, { sensor });
      await dispatcherWith(recorder().transport).dispatch();
      await elapse();

      // A fresh dispatcher holding nothing: what a restarted ms-core has.
      const { seen, transport } = recorder();
      await dispatcherWith(transport).dispatch();
      assert.equal(seen.length, 1, 'the digest goes out late rather than never');
      assert.match(String(seen[0]?.subject), /4 notifications/);
    });

    it('decides once, so a failed immediate message is not folded into a digest', async () => {
      // The reason the decision is a column. Re-deciding on a retry would move a message an
      // operator was promised at once into a digest fifteen minutes later.
      const templateId = await template();
      for (const sensor of sensors) await queue(templateId, { sensor });

      let succeed = false;
      const { seen, transport } = recorder(() => ({ ok: succeed, retryable: true }));
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.equal(seen.length, 1);

      succeed = true;
      await dispatcher.dispatch();
      assert.equal(seen.length, 2, 'the same message was tried again');
      assert.equal(seen[1]?.subject, 'Ping on edge-router is down', 'and it is still a message');
    });

    it('keeps every member of a failed digest owed', async () => {
      const templateId = await template({ summarisation: 'always-summarise' });
      for (const sensor of sensors) await queue(templateId, { sensor });

      let succeed = false;
      const { seen, transport } = recorder(() => ({ ok: succeed, retryable: true }));
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      await elapse();
      await dispatcher.dispatch();

      assert.equal(seen.length, 1, 'one digest, refused');
      assert.deepEqual(
        (await dispositions()).map((row) => row.status),
        ['pending', 'pending', 'pending', 'pending', 'pending'],
      );

      succeed = true;
      await dispatcher.dispatch();
      assert.equal(seen.length, 2, 'and tried again as a digest, not as five messages');
      assert.deepEqual(
        (await dispositions()).map((row) => row.status),
        ['sent', 'sent', 'sent', 'sent', 'sent'],
      );
    });

    it('sends a held request whose window has disappeared rather than losing it', async () => {
      const templateId = await template({ summarisation: 'always-summarise' });
      await queue(templateId);
      const { seen, transport } = recorder();
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.equal(seen.length, 0);

      // Nothing does this in production. It is the state a bug or a hand-run DELETE would leave,
      // and an obligation with nowhere to wait must still be met.
      await db.query('DELETE FROM notification_summary');
      await dispatcher.dispatch();
      assert.equal(seen.length, 1, 'sent on its own rather than waiting for ever');
    });

    it('does not let a window nothing can send starve every other template', async () => {
      // **`P-122`.** A closed window whose template has since been disabled holds requests the
      // claim will never take, so it came back from `owing` on every pass, produced no members,
      // and consumed one of the caller's slots for ever. With `maxDigests` of one — the shape the
      // defect takes at any size — the working template's digest simply never arrived, and
      // nothing anywhere said so: each pass looked like an ordinary quiet one.
      const stuck = await template();
      const working = await template();
      await queue(stuck);
      await queue(working);
      const first = recorder();
      const dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [first.transport],
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
        maxDigests: 1,
      });
      // The first pass releases each template's first Down immediately and opens both windows.
      await dispatcher.dispatch();
      await queue(stuck);
      await queue(working);
      await elapse();

      // The stuck template is switched off while its window is closing.
      await db.query('UPDATE notification_template SET enabled = false WHERE id = $1', [stuck]);

      const before = first.seen.length;
      await dispatcher.dispatch();
      assert.ok(
        first.seen.length > before,
        'the working template\u2019s digest should have been sent, not blocked behind a dead window',
      );
    });

    it('gives every member of a failed digest the same retry time', async () => {
      // **`P-123`.** `#record` drew a jittered delay per request, so a digest of forty that failed
      // came back due at forty different moments. The next pass claimed whichever handful had
      // ripened, assembled them into a digest of their own, and labelled it "part 1 of 1": one
      // outage arrived as several fragments, in an order the jitter chose, each claiming to be
      // complete. Asserted on the stored `next_attempt_at`, which is where the fragmentation
      // starts — reproducing the fragments themselves would be a test of the jitter.
      const templateId = await template();
      for (const sensor of sensors) await queue(templateId, { sensor });
      for (const sensor of sensors) await queue(templateId, { sensor });
      const failing = recorder(() => ({ ok: false, retryable: true }));
      const dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [failing.transport],
        // A real backoff with real jitter: with `firstDelayMs: 0` every row would agree by
        // accident, which is the pass this test must not have.
        retry: { firstDelayMs: 60_000, maxDelayMs: 600_000, jitter: 0.5 },
        leaseMs: 0,
      });
      await dispatcher.dispatch();
      await elapse();
      await dispatcher.dispatch();

      const times = await db.query<{ next_attempt_at: Date | null }>(
        `SELECT next_attempt_at FROM notification_request
         WHERE status = 'pending' AND summary_id IS NOT NULL AND attempts > 0`,
      );
      assert.ok(times.length > 1, 'the digest should have had several members to retry');
      const distinct = new Set(times.map((row) => row.next_attempt_at?.getTime() ?? 0));
      assert.equal(
        distinct.size,
        1,
        `the members of one digest fell due at ${String(distinct.size)} different times`,
      );
    });

    it('tidies away the windows that closed with nothing in them', async () => {
      // The common case for a template that notifies about one sensor at a time: a window opens,
      // releases the first Down immediately and never collects anything.
      const templateId = await template();
      await queue(templateId);
      const dispatcher = dispatcherWith(recorder().transport);
      await dispatcher.dispatch();
      assert.equal((await openWindows()).length, 1);

      await elapse();
      await dispatcher.dispatch();
      // An hour later, with nothing else to do — housekeeping happens when the queue is idle,
      // and a window is kept a while after it closes so it stays visible to a query.
      await dispatcher.dispatch(new Date(Date.now() + 2 * 60 * 60 * 1000));
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_summary',
      );
      assert.equal(rows[0]?.n, '0');
    });
  },
);
