import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { TriggerSync } from '../src/notifications/sync.js';
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

/**
 * A minute ago, on a whole second.
 *
 * Relative to the real clock rather than a fixed instant, because `TriggerSync` reacts at the
 * mutation's own time — the wall clock — and a reading stamped in the future is not a reading:
 * `currentValues` refuses samples ahead of `now`, so that a probe whose clock runs fast cannot
 * make a threshold fire against a value nothing has measured yet.
 */
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const TRIGGER_TEMPLATE = 201;
const CLEAR_TEMPLATE = 202;

/**
 * `N-03`: the threshold trigger, against a real database.
 *
 * `threshold-trigger.test.ts` proves the decisions. This proves the value they decide against
 * comes from somewhere real — the same hypertable a graph reads — and that a threshold trigger
 * and a channel limit stay the separate things `CAPABILITIES.MD §5.1` and `M-04` describe: one
 * decides who is told, the other decides what the sensor *is*.
 */
describe(
  'the threshold trigger engine',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let alarms: AlarmRepository;
    let triggers: TriggerService;
    let deviceId: number;
    let sensorId: number;
    let rttChannel: number;
    let lossChannel: number;

    before(async () => {
      scratch = await createScratchDatabase('thresholds');
      db = scratch.db;
      alarms = new AlarmRepository();
      engine = new AlarmEngine({ logger: silent, alarms });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: 'device',
          host: '192.0.2.20',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      const channels = await db.query<{ id: string; key: string }>(
        'SELECT id::text AS id, key FROM channel WHERE sensor_id = $1',
        [sensorId],
      );
      const byKey = new Map(channels.map((row) => [row.key, Number(row.id)]));
      const rtt = byKey.get('rtt');
      const loss = byKey.get('loss');
      assert.ok(rtt !== undefined && loss !== undefined, 'icmp.ping declares rtt and loss');
      rttChannel = rtt;
      lossChannel = loss;
    });

    // ---------------------------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------------------------

    /**
     * Exactly what `Ingestor` does after writing a batch (`P-104`).
     *
     * These helpers used to call `engine.react` unconditionally for the sensor, which is more
     * generous than production has ever been: the ingestion path reacted only when the batch
     * produced a *state transition*. A threshold trigger fires on a reading, and a reading
     * changes without the state changing — so a breach on a stable Up sensor never armed, and a
     * breach that cleared while the sensor stayed Up was never stood down. Every case in this
     * file passed anyway, because the helper supplied the call production did not make.
     *
     * Mirroring the rule rather than restating it: whichever way the gate goes, these tests see
     * what an operator would.
     */
    async function reactLikeIngestion(
      q: Queryable,
      moved: readonly number[],
      when: Date,
    ): Promise<void> {
      const scanned = (await engine.reconcilesReadings(q)) ? [sensorId] : [...new Set(moved)];
      if (scanned.length > 0) await engine.react(q, scanned, when);
    }

    /** One scan that produced a reading, written the way ingestion writes it. */
    async function scan(value: number, when: Date, channel = rttChannel): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = [{ sensorId, at: when, outcome: 'ok', message: 'reachable' }];
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await q.query('INSERT INTO sample (time, channel_id, value) VALUES ($1, $2, $3)', [
          when,
          channel,
          value,
        ]);
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await reactLikeIngestion(
          q,
          decisions.transitions.map((one) => one.sensorId),
          when,
        );
      });
    }

    /** A scan that failed, which records no channel values at all. */
    async function failed(when: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide([
        { sensorId, at: when, outcome: 'error', message: 'no ICMP reply' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await reactLikeIngestion(
          q,
          decisions.transitions.map((one) => one.sensorId),
          when,
        );
      });
    }

    async function sweep(when: Date): Promise<number> {
      return (await db.tx((q) => engine.sweep(q, when))).fired;
    }

    async function queued(): Promise<
      {
        reason: string;
        templateId: number | null;
        channelKey: string | null;
        observed: number | null;
      }[]
    > {
      const rows = await db.query<{
        reason: string;
        template_id: string | null;
        channel_key: string | null;
        observed: number | null;
      }>(
        `SELECT reason, template_id::text AS template_id, channel_key, observed
         FROM notification_request ORDER BY id`,
      );
      return rows.map((row) => ({
        reason: row.reason,
        templateId: row.template_id === null ? null : Number(row.template_id),
        channelKey: row.channel_key,
        observed: row.observed,
      }));
    }

    async function standing(): Promise<
      { kind: string; channelKey: string | null; observed: number | null; phase: string }[]
    > {
      const rows = await db.query<{
        kind: string;
        channel_key: string | null;
        observed: number | null;
        phase: string;
      }>('SELECT kind, channel_key, observed, phase FROM notification_alarm ORDER BY id');
      return rows.map((row) => ({
        kind: row.kind,
        channelKey: row.channel_key,
        observed: row.observed,
        phase: row.phase,
      }));
    }

    async function loadTrigger(settings: Record<string, unknown> = {}): Promise<number> {
      const created = await triggers.create(testActor, deviceId, {
        kind: 'threshold',
        settings: {
          channelKey: 'rtt',
          condition: 'above',
          value: 80,
          triggerTemplateId: TRIGGER_TEMPLATE,
          clearTemplateId: CLEAR_TEMPLATE,
          ...settings,
        },
      });
      return created.id;
    }

    // ---------------------------------------------------------------------------------------
    // Arming and clearing.
    // ---------------------------------------------------------------------------------------

    it('arms when a channel goes over, and notifies at zero latency', async () => {
      await loadTrigger();
      await scan(95, T0);

      const [armed] = await standing();
      assert.ok(armed !== undefined);
      assert.equal(armed.kind, 'threshold');
      assert.equal(armed.channelKey, 'rtt');
      assert.equal(armed.observed, 95);

      assert.equal(await sweep(at(1)), 1);
      const sent = await queued();
      assert.equal(sent.length, 1);
      const [first] = sent;
      assert.ok(first !== undefined);
      assert.equal(first.reason, 'threshold');
      assert.equal(first.templateId, TRIGGER_TEMPLATE);
      assert.equal(first.channelKey, 'rtt');
      // The value the notification is about, frozen: by the time anything delivers it the
      // channel has moved on, and a message quoting the value *now* is a different breach.
      assert.equal(first.observed, 95);
    });

    it('leaves a channel inside its threshold alone', async () => {
      await loadTrigger();
      await scan(40, T0);
      assert.deepEqual(await standing(), []);
      assert.deepEqual(await queued(), []);
    });

    it('notifies nobody about a breach that clears before its latency', async () => {
      await loadTrigger({ latencySeconds: 300 });
      await scan(95, T0);
      assert.equal((await standing()).length, 1, 'armed');
      assert.equal(await sweep(at(60)), 0, 'not yet due');

      await scan(40, at(120));
      assert.deepEqual(await standing(), [], 'and gone');
      assert.deepEqual(await queued(), [], 'with no clear notification either');
    });

    it('waits out the latency, then notifies and clears', async () => {
      await loadTrigger({ latencySeconds: 300 });
      await scan(95, T0);
      assert.equal(await sweep(at(299)), 0);
      assert.equal(await sweep(at(301)), 1);

      await scan(40, at(400));
      assert.deepEqual(
        (await queued()).map((request) => [request.reason, request.templateId]),
        [
          ['threshold', TRIGGER_TEMPLATE],
          ['clear', CLEAR_TEMPLATE],
        ],
      );
      assert.deepEqual(await standing(), []);
    });

    it('tracks the value while the breach stands', async () => {
      // The row is where "what is this about to page somebody about" is answered, and a stale
      // number there is worse than none.
      await loadTrigger({ latencySeconds: 600 });
      await scan(95, T0);
      assert.equal((await standing())[0]?.observed, 95);
      await scan(140, at(60));
      assert.equal((await standing())[0]?.observed, 140);
      assert.equal((await standing())[0]?.phase, 'pending', 'still inside its latency');
    });

    it('sends one notification for a breach that holds, not one per reading', async () => {
      await loadTrigger();
      await scan(95, T0);
      await sweep(at(1));
      for (const [index, value] of [96, 97, 98, 99].entries()) {
        await scan(value, at(60 * (index + 1)));
        await sweep(at(60 * (index + 1) + 1));
      }
      assert.equal((await queued()).length, 1, 'one breach, one notification');
    });

    // ---------------------------------------------------------------------------------------
    // No-data is not zero.
    // ---------------------------------------------------------------------------------------

    it('does not call losing the reading a clear', async () => {
      // A disk that was 95% full when its sensor went Down is not a disk that emptied. The alarm
      // is stood down — we no longer know — but silently.
      await loadTrigger();
      await scan(95, T0);
      await sweep(at(1));
      assert.equal((await queued()).length, 1);

      await failed(at(60));
      await failed(at(120));
      assert.deepEqual(await standing(), [], 'the alarm is over');
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['threshold'],
        'and nobody was told it cleared, because it did not',
      );
    });

    it('never arms a `below` trigger on a sensor that stopped reporting', async () => {
      // The failure mode of treating absence as zero: every `below` trigger in the installation
      // fires the moment a probe goes away.
      await loadTrigger({ condition: 'below', value: 10 });
      await failed(T0);
      await failed(at(60));
      assert.deepEqual(await standing(), []);
      assert.deepEqual(await queued(), []);
    });

    it('ignores a reading older than the value lookback', async () => {
      // A threshold is a claim about the present. A sensor whose last reading was yesterday has
      // no current value, which is not the same as a value of zero.
      const shortMemory = new AlarmEngine({ logger: silent, valueLookbackMs: 60_000 });
      await loadTrigger();
      await db.query('INSERT INTO sample (time, channel_id, value) VALUES ($1, $2, $3)', [
        at(-3_600),
        rttChannel,
        95,
      ]);
      await db.tx((q) => shortMemory.react(q, [sensorId], T0));
      assert.deepEqual(await standing(), []);
    });

    // ---------------------------------------------------------------------------------------
    // What a threshold trigger is not.
    // ---------------------------------------------------------------------------------------

    it('notifies without changing what the sensor is', async () => {
      // The whole distinction from a channel limit (M-04): "page me at 80% but do not call the
      // disk Down until 95%" needs both, and conflating them makes one of them impossible.
      await loadTrigger();
      await scan(95, T0);
      await sweep(at(1));

      const runtime = await db.query<{ state: string; cause: string }>(
        'SELECT state, cause FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      assert.equal(runtime[0]?.state, 'up', 'the sensor is fine');
      assert.equal((await queued()).length, 1, 'and somebody was told anyway');
    });

    it('watches the channel it names and no other', async () => {
      await loadTrigger({ channelKey: 'loss' });
      await scan(95, T0, rttChannel);
      assert.deepEqual(await standing(), [], 'rtt is not loss');

      await scan(99, at(60), lossChannel);
      assert.equal((await standing()).length, 1);
      assert.equal((await standing())[0]?.channelKey, 'loss');
    });

    it('stands an alarm down when the trigger is pointed at another channel', async () => {
      const triggerId = await loadTrigger();
      await scan(95, T0);
      assert.equal((await standing()).length, 1);

      await triggers.update(testActor, triggerId, {
        kind: 'threshold',
        settings: { channelKey: 'loss', condition: 'above', value: 80 },
      });
      assert.deepEqual(await standing(), [], 'nothing cleared, so nothing was said');
      assert.deepEqual(await queued(), []);
    });

    it('runs a threshold trigger and a state trigger on one sensor independently', async () => {
      // Accumulating inheritance (N-01) means a sensor carries both, and they answer different
      // questions about it.
      await loadTrigger();
      await triggers.create(testActor, h.rootId, {
        kind: 'state',
        settings: { state: 'down', initialTemplateId: 301 },
      });
      await scan(95, T0);
      await sweep(at(1));
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['threshold'],
        'the sensor is Up, so only the threshold has anything to say',
      );

      await failed(at(60));
      await failed(at(120));
      await sweep(at(121));
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['threshold', 'initial'],
        'and now the outage does — while the threshold stays quiet, having lost its reading',
      );
    });

    // ---------------------------------------------------------------------------------------
    // Configuration and durability.
    // ---------------------------------------------------------------------------------------

    it('arms a breach that is already in progress when the trigger is created', async () => {
      await scan(95, T0);
      assert.deepEqual(await standing(), [], 'nothing was watching');
      await loadTrigger();
      assert.equal((await standing()).length, 1, 'and now something is');
      assert.equal((await standing())[0]?.observed, 95);
    });

    it('survives a restart, because the due time and the value are both in the table', async () => {
      await loadTrigger({ latencySeconds: 300 });
      await scan(95, T0);
      const restarted = new AlarmEngine({ logger: silent });
      const fired = await db.tx((q) => restarted.sweep(q, at(400)));
      assert.equal(fired.fired, 1);
      assert.equal((await queued())[0]?.observed, 95);
    });

    it('reads no channel values when no threshold trigger names any', async () => {
      // `currentValues` is bounded by the keys some trigger actually names. With none it returns
      // without a statement, so an installation with only state triggers pays nothing for N-03.
      assert.equal((await alarms.currentValues(db, [sensorId], [], T0, 60_000)).size, 0);
      assert.equal((await alarms.currentValues(db, [], ['rtt'], T0, 60_000)).size, 0);
    });

    it('reads the newest value within the lookback, and only the channels asked for', async () => {
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])`,
        [
          [at(-120), at(-60), at(-30)],
          [rttChannel, rttChannel, lossChannel],
          [10, 20, 3],
        ],
      );
      const values = await alarms.currentValues(db, [sensorId], ['rtt'], T0, 600_000);
      assert.deepEqual([...(values.get(sensorId) ?? [])], [['rtt', 20]], 'the newest rtt, no loss');
    });
  },
);
