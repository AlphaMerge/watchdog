import { strict as assert } from 'node:assert';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import { testCatalogue } from './support/sensor-types.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import type { LookupCatalogue } from '../src/lookups/catalogue.js';
import { loadLookups } from '../src/lookups/loader.js';
import { Ingestor, type IngestTarget } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { IngestionService } from '../src/ingestion/service.js';
import { SensorStateService } from '../src/state/service.js';
import { writeStateHistory } from '../src/state/runtime.js';
import { resolveAcknowledgement } from '../src/state/acknowledgement.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

const AT = new Date('2026-08-25T12:00:00.000Z');
const at = (minutes: number): string => new Date(AT.getTime() + minutes * 60_000).toISOString();

interface HistoryRow {
  state: SensorState;
  previous_state: SensorState | null;
  cause: SensorStateCause;
  message: string;
}

/**
 * The state machine against a real database, through the path a probe actually takes.
 *
 * The pure model is checked exhaustively in `state-machine.test.ts`. What is here is everything
 * that model cannot see: that the transitions and the readings commit together, that a resent
 * batch does not count its failures twice, and that a restart resumes the two-step rule rather
 * than starting it again.
 */
describe(
  'state ingestion',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let lookups: LookupCatalogue;
    let probeId: number;
    let deviceId: number;
    let sensorId: number;
    let app: FastifyInstance;

    before(async () => {
      lookups = await loadLookups({ logger: silent });
      scratch = await createScratchDatabase('stateing');
      db = scratch.db;
      harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'State probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'State device',
        host: '192.0.2.30',
      });
      deviceId = device.id;
      probeId = probe.id;

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        lookups,
      });
      await server.build('9.9.9', harness.service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `sensor-${String(process.hrtime.bigint())}`,
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;
    });

    // -------------------------------------------------------------------------------------
    // Harness.
    // -------------------------------------------------------------------------------------

    function build(target?: IngestTarget): {
      service: IngestionService;
      ingestor: Ingestor;
      states: SensorStateService;
      channels: ChannelResolver;
    } {
      const states = new SensorStateService({
        db,
        logger: silent,
        settings: harness.resolver,
        pauses: new PauseRepository(),
      });
      const channels = new ChannelResolver({ logger: silent, lookups });
      const ingestor = new Ingestor({ db: target ?? db, logger: silent, config: CONFIG });
      return {
        states,
        channels,
        ingestor,
        service: new IngestionService({
          db,
          logger: silent,
          ingestor,
          states,
          resolver: channels,
        }),
      };
    }

    /** A failed check, which carries no readings — no-data is not zero. */
    function failedResult(minutes: number): CheckResult {
      return result({ at: at(minutes), outcome: 'error', message: 'no reply', channels: [] });
    }

    function result(overrides: Partial<CheckResult> = {}): CheckResult {
      return {
        sensorId,
        at: at(0),
        outcome: 'ok',
        message: '',
        durationMs: 12,
        channels: [{ key: 'rtt', value: 1.5, name: 'Response time', unit: 'ms' }],
        ...overrides,
      };
    }

    /** One batch, start to finish, exactly as the probe endpoint delivers it. */
    async function deliver(
      service: IngestionService,
      ingestor: Ingestor,
      results: readonly CheckResult[],
      batchId = 'b1',
    ): Promise<string> {
      const reply = await service.acceptResults('probe-state', {
        type: 'results',
        batchId,
        results: [...results],
      });
      await ingestor.stop();
      return reply.type;
    }

    async function acknowledgedAt(id = sensorId): Promise<Date | null> {
      const rows = await db.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM sensor_runtime WHERE object_id = $1',
        [id],
      );
      return rows[0]?.acknowledged_at ?? null;
    }

    async function history(id = sensorId): Promise<HistoryRow[]> {
      return db.query<HistoryRow>(
        `SELECT state, previous_state, cause, message
         FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
        [id],
      );
    }

    async function runtime(id = sensorId): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      consecutive_failures: number;
      last_result_at: Date | null;
      since: Date;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        message: string;
        consecutive_failures: number;
        last_result_at: Date | null;
        since: Date;
      }>(
        `SELECT state, cause, message, consecutive_failures, last_result_at, since
         FROM sensor_runtime WHERE object_id = $1`,
        [id],
      );
      assert.ok(rows[0], 'no runtime row');
      return rows[0];
    }

    // -------------------------------------------------------------------------------------
    // Every sensor has a row, from the moment it exists.
    // -------------------------------------------------------------------------------------

    describe('provisioning', () => {
      async function runtimeRows(id: number): Promise<number> {
        const rows = await db.query<{ count: string }>(
          'SELECT count(*) AS count FROM sensor_runtime WHERE object_id = $1',
          [id],
        );
        return Number(rows[0]?.count ?? 0);
      }

      it('gives a new sensor its row before it has ever reported', async () => {
        // Not an optimisation. M-08 onwards set pause flags with an UPDATE, and against a row
        // that does not exist yet that is a pause which silently does nothing.
        assert.equal(await runtimeRows(sensorId), 1);
        assert.equal((await runtime()).state, 'unknown');
      });

      it('gives a cloned sensor one too, which is the path an insert beside create would miss', async () => {
        const clone = await harness.service.clone(testActor, deviceId, {
          name: `clone-${String(process.hrtime.bigint())}`,
        });
        const sensors = await db.query<{ id: string }>(
          `SELECT o.id::text AS id FROM object o
           WHERE o.parent_id = $1 AND o.kind = 'sensor'`,
          [clone.object.id],
        );
        assert.ok(sensors.length > 0, 'the clone brought its sensors');
        for (const sensor of sensors) {
          assert.equal(await runtimeRows(Number(sensor.id)), 1, `sensor ${sensor.id}`);
        }
      });

      it('takes the row with the sensor when it is deleted', async () => {
        const doomed = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `gone-${String(process.hrtime.bigint())}`,
          sensorType: 'icmp.ping',
        });
        await harness.service.delete(testActor, doomed.id, { kind: 'leafOnly' }, { kind: 'none' });
        assert.equal(await runtimeRows(doomed.id), 0);
      });
    });

    // -------------------------------------------------------------------------------------
    // A sensor that works, then does not.
    // -------------------------------------------------------------------------------------

    it('turns the first successful result into Up, with its reading', async () => {
      const { service, ingestor } = build();
      assert.equal(await deliver(service, ingestor, [result()]), 'results-ack');

      assert.deepEqual(await history(), [
        { state: 'up', previous_state: 'unknown', cause: 'scan', message: '' },
      ]);
      const current = await runtime();
      assert.equal(current.state, 'up');
      assert.equal(current.consecutive_failures, 0);
      assert.equal(current.last_result_at?.toISOString(), at(0));

      const samples = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM sample s
         JOIN channel c ON c.id = s.channel_id WHERE c.sensor_id = $1`,
        [sensorId],
      );
      assert.equal(Number(samples[0]?.count), 1);
    });

    it('records the two-step failure, and records no readings while it is failing', async () => {
      const { service, ingestor } = build();
      const failure = (minutes: number): CheckResult =>
        result({
          at: at(minutes),
          outcome: 'error',
          message: 'connect ETIMEDOUT 192.0.2.30:0',
          // A probe should send none; a sensor type that gets it wrong must not be able to
          // draw a graph line through an outage (CLAUDE.md: no-data is not zero).
          channels: [{ key: 'rtt', value: 0 }],
        });

      await deliver(service, ingestor, [result(), failure(1), failure(2), failure(3)]);

      assert.deepEqual(
        (await history()).map((row) => `${row.previous_state ?? '-'}->${row.state}:${row.cause}`),
        ['unknown->up:scan', 'up->warning:scan', 'warning->down:scan'],
        'the third failure changed nothing, so it recorded nothing',
      );
      assert.equal((await history())[2]?.message, 'connect ETIMEDOUT 192.0.2.30:0');

      const current = await runtime();
      assert.equal(current.state, 'down');
      assert.equal(current.consecutive_failures, 3);

      const samples = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM sample s
         JOIN channel c ON c.id = s.channel_id WHERE c.sensor_id = $1`,
        [sensorId],
      );
      assert.equal(Number(samples[0]?.count), 1, 'only the successful scan left a reading');
    });

    it('dates the state from when it changed, not from the last result that confirmed it', async () => {
      const { service, ingestor } = build();
      await deliver(service, ingestor, [
        result({ at: at(0), outcome: 'error', channels: [] }),
        result({ at: at(1), outcome: 'error', channels: [] }),
        result({ at: at(2), outcome: 'error', channels: [] }),
      ]);
      const current = await runtime();
      assert.equal(current.state, 'down');
      assert.equal(current.since.toISOString(), at(1), '"Down for 2h 15m" starts when Down did');
    });

    // -------------------------------------------------------------------------------------
    // The protocol is at-least-once. The machine has to survive that.
    // -------------------------------------------------------------------------------------

    it('does not count a resent batch twice', async () => {
      const first = build();
      const failure = result({ at: at(1), outcome: 'error', message: 'gone', channels: [] });
      await deliver(first.service, first.ingestor, [result(), failure]);
      assert.equal((await runtime()).state, 'warning');

      // A lost acknowledgement: the probe offers the same batch again, to the same core.
      const again = build();
      await deliver(again.service, again.ingestor, [result(), failure], 'b2');

      assert.equal(
        (await runtime()).state,
        'warning',
        'one outage advanced the two-step by one step, not two',
      );
      assert.equal((await runtime()).consecutive_failures, 1);
      assert.equal((await history()).length, 2, 'and the timeline did not gain a duplicate');
      assert.equal(
        again.service.stats().state?.resultsStale,
        2,
        'and both were counted, not dropped in silence',
      );
    });

    it('applies a batch in time order, whatever order it arrived in', async () => {
      const { service, ingestor } = build();
      await deliver(service, ingestor, [
        result({ at: at(2), outcome: 'error', channels: [] }),
        result({ at: at(0) }),
        result({ at: at(1), outcome: 'error', channels: [] }),
      ]);
      assert.deepEqual(
        (await history()).map((row) => row.state),
        ['up', 'warning', 'down'],
      );
    });

    // -------------------------------------------------------------------------------------
    // The readings and the state are one write.
    // -------------------------------------------------------------------------------------

    it('rolls the state back with the readings, and records it when the probe resends', async () => {
      let failing = true;
      // Only the ingestor's write target fails; the state service reads through the real pool,
      // which is the shape of a storage failure that hits the write and not the read.
      const broken: IngestTarget = {
        tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
          if (failing) throw new Error('storage is down');
          return db.tx(fn);
        },
      };

      const { service, ingestor, states } = build(broken);
      const reply = await service.acceptResults('probe-state', {
        type: 'results',
        batchId: 'b1',
        results: [result()],
      });
      await ingestor.stop();

      assert.equal(reply.type, 'results-nack');
      assert.deepEqual(await history(), [], 'nothing committed');
      assert.equal((await runtime()).state, 'unknown');
      assert.equal(states.peek(sensorId), undefined, 'and the machine rewound to match');

      // The probe was never acknowledged, so it offers the batch again — and this time the
      // change must be recorded, not skipped as something already seen.
      failing = false;
      const second = build();
      await deliver(second.service, second.ingestor, [result()], 'b2');
      assert.deepEqual(
        (await history()).map((row) => row.state),
        ['up'],
      );
    });

    // -------------------------------------------------------------------------------------
    // Restart.
    // -------------------------------------------------------------------------------------

    it('resumes the two-step rule after a restart rather than starting it again', async () => {
      const before = build();
      await deliver(before.service, before.ingestor, [
        result(),
        result({ at: at(1), outcome: 'error', message: 'gone', channels: [] }),
      ]);
      assert.equal((await runtime()).state, 'warning');

      // A new process: nothing in memory, everything in the table.
      const afterwards = build();
      await deliver(
        afterwards.service,
        afterwards.ingestor,
        [result({ at: at(2), outcome: 'error', message: 'still gone', channels: [] })],
        'b2',
      );

      assert.equal(
        (await runtime()).state,
        'down',
        'a deploy between the first and second failure must not hold a down sensor at Warning',
      );
      assert.equal((await history()).at(-1)?.previous_state, 'warning');
    });

    // -------------------------------------------------------------------------------------
    // Things that are not a sensor any more.
    // -------------------------------------------------------------------------------------

    it('counts results for a deleted sensor instead of failing the batch', async () => {
      const doomed = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `doomed-${String(process.hrtime.bigint())}`,
        sensorType: 'icmp.ping',
      });
      await harness.service.delete(testActor, doomed.id, { kind: 'leafOnly' }, { kind: 'none' });

      const { service, ingestor } = build();
      const reply = await deliver(service, ingestor, [
        result(),
        result({ sensorId: doomed.id, at: at(1) }),
      ]);

      assert.equal(reply, 'results-ack', 'one dead sensor does not fail the whole batch');
      assert.equal(service.stats().state?.resultsUnknownSensor, 1);
      assert.equal((await runtime()).state, 'up', 'and the live sensor was decided as normal');
    });

    // -------------------------------------------------------------------------------------
    // What the rest of the system sees.
    // -------------------------------------------------------------------------------------

    it('does not bump the sensor version, so a scan is not a configuration change', async () => {
      const versionOf = async (): Promise<number> => {
        const rows = await db.query<{ version: number }>(
          'SELECT version FROM object WHERE id = $1',
          [sensorId],
        );
        return rows[0]?.version ?? -1;
      };
      const before = await versionOf();

      const { service, ingestor } = build();
      await deliver(service, ingestor, [
        result(),
        result({ at: at(1), outcome: 'error', channels: [] }),
      ]);

      assert.equal(
        await versionOf(),
        before,
        'R-04 diffs a probe subtree on these versions — a state change must not push config',
      );
    });

    it('reaches the listing, where the tree and the overview read it', async () => {
      const { service, ingestor } = build();
      await deliver(service, ingestor, [result()]);

      const page = await harness.service.list(
        { parentId: deviceId, kinds: ['sensor'] },
        { limit: 100, sort: 'name', cursor: null },
      );
      const summary = page.items.find((item) => item.id === sensorId);
      assert.equal(summary?.state, 'up');
      const device = await harness.service.get(deviceId);
      assert.equal('state' in device, false, 'and a device has no state to report');
    });

    // -------------------------------------------------------------------------------------
    // The failure policy (M-03), resolved through the tree like any other setting.
    // -------------------------------------------------------------------------------------

    describe('failure policy', () => {
      const failing = (minutes: number, id = sensorId): CheckResult =>
        result({ sensorId: id, at: at(minutes), outcome: 'error', message: 'gone', channels: [] });

      async function statesFor(outcomes: number, id = sensorId): Promise<SensorState[]> {
        const { service, ingestor } = build();
        await deliver(
          service,
          ingestor,
          Array.from({ length: outcomes }, (_, index) => failing(index, id)),
        );
        return (await history(id)).map((row) => row.state);
      }

      it('warns once then goes Down, when nothing overrides the default', async () => {
        assert.deepEqual(await statesFor(2), ['warning', 'down']);
      });

      it('goes Down on the first failure when a sensor sets zero', async () => {
        await harness.service.setSetting(testActor, sensorId, 'scan.retryWarnings', 0, {
          kind: 'none',
        });
        assert.deepEqual(
          await statesFor(1),
          ['down'],
          'immediate-down, PRTG’s errorintervalsdown=0',
        );
      });

      it('inherits the policy from an ancestor, like every other setting', async () => {
        // Set on the *device*, read by the sensor. The whole point of the setting being
        // inheritable: an operator tunes a flaky site once, not once per sensor.
        await harness.service.setSetting(testActor, deviceId, 'scan.retryWarnings', 3, {
          kind: 'none',
        });
        try {
          assert.deepEqual(await statesFor(4), ['warning', 'down'], 'three warnings, one row');
          const rows = await history();
          assert.equal(rows[0]?.state, 'warning');
          assert.equal(rows[1]?.state, 'down');
          assert.equal((await runtime()).consecutive_failures, 4);
        } finally {
          await harness.service.clearSetting(testActor, deviceId, 'scan.retryWarnings', {
            kind: 'none',
          });
        }
      });

      it('lets a sensor override what its device says', async () => {
        await harness.service.setSetting(testActor, deviceId, 'scan.retryWarnings', 5, {
          kind: 'none',
        });
        await harness.service.setSetting(testActor, sensorId, 'scan.retryWarnings', 0, {
          kind: 'none',
        });
        try {
          assert.deepEqual(await statesFor(1), ['down']);
        } finally {
          await harness.service.clearSetting(testActor, deviceId, 'scan.retryWarnings', {
            kind: 'none',
          });
        }
      });

      it('takes effect on the next scan, without restarting the core', async () => {
        const running = build();
        const invalidator = new ResultCacheInvalidator({
          channels: running.channels,
          sensors: running.states,
          logger: silent,
        });
        harness.audit.also = invalidator;
        try {
          // Warm the policy cache under the default, and land on Warning.
          await deliver(running.service, running.ingestor, [failing(0)]);
          assert.equal((await runtime()).state, 'warning');

          // An ancestor's setting, changed while the cache is warm.
          await harness.service.setSetting(testActor, deviceId, 'scan.retryWarnings', 0, {
            kind: 'none',
          });

          const again = new Ingestor({ db, logger: silent, config: CONFIG });
          const sameService = new IngestionService({
            db,
            logger: silent,
            ingestor: again,
            states: running.states,
            resolver: running.channels,
          });
          await deliver(sameService, again, [failing(1)], 'b2');
          assert.equal(
            (await runtime()).state,
            'down',
            'the invalidator dropped a policy an ancestor’s edit made stale',
          );
        } finally {
          harness.audit.also = undefined;
          invalidator.stop();
          await harness.service.clearSetting(testActor, deviceId, 'scan.retryWarnings', {
            kind: 'none',
          });
        }
      });

      it('goes back to Warning when the policy is relaxed past the failure count', async () => {
        // The transition M-03 found missing from the table. It is what an operator asked for:
        // raising the threshold above the current count says "this many failures is not yet
        // Down", and the sensor should say so at its next scan.
        const first = build();
        await deliver(first.service, first.ingestor, [failing(0), failing(1)]);
        assert.equal((await runtime()).state, 'down');

        await harness.service.setSetting(testActor, sensorId, 'scan.retryWarnings', 5, {
          kind: 'none',
        });
        const second = build();
        await deliver(second.service, second.ingestor, [failing(2)], 'b2');

        const last = (await history()).at(-1);
        assert.equal(last?.previous_state, 'down');
        assert.equal(last.state, 'warning');
        assert.equal(last.cause, 'scan');
      });

      it('re-resolves after a move, because the chain it inherits from changed', async () => {
        // The branch that a "forget the object that changed" invalidator would miss entirely:
        // nothing about the sensor was edited. What changed is which ancestors it has.
        const strict = await harness.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: `strict-${String(process.hrtime.bigint())}`,
        });
        await harness.service.setSetting(testActor, strict.id, 'scan.retryWarnings', 0, {
          kind: 'none',
        });

        const running = build();
        const invalidator = new ResultCacheInvalidator({
          channels: running.channels,
          sensors: running.states,
          logger: silent,
        });
        harness.audit.also = invalidator;
        try {
          // Warm the cache with the default policy, where one failure is only a Warning.
          await deliver(running.service, running.ingestor, [failing(0)]);
          assert.equal((await runtime()).state, 'warning');

          await harness.service.move(testActor, deviceId, strict.id, { kind: 'none' });

          const again = new Ingestor({ db, logger: silent, config: CONFIG });
          const sameService = new IngestionService({
            db,
            logger: silent,
            ingestor: again,
            states: running.states,
            resolver: running.channels,
          });
          await deliver(sameService, again, [failing(1)], 'b2');
          assert.equal((await runtime()).state, 'down', 'the new branch says down immediately');
        } finally {
          harness.audit.also = undefined;
          invalidator.stop();
          // Put the device back where the rest of the suite expects it.
          await harness.service.move(testActor, deviceId, probeId, { kind: 'none' });
        }
      });

      it('falls back to the default when the stored value is not a count', async () => {
        // Only reachable by hand-editing a row, and the failure it prevents is silent:
        // `consecutiveFailures > NaN` is false for every value, so the sensor would sit at
        // Warning for ever with nothing to look at but a sensor that never alarms.
        await db.query(
          `INSERT INTO object_setting (object_id, key, value)
           VALUES ($1, 'scan.retryWarnings', '"three"'::jsonb)
           ON CONFLICT (object_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [sensorId],
        );
        assert.deepEqual(await statesFor(2), ['warning', 'down'], 'the default, not silence');
      });

      it('refuses a policy the registry does not allow', async () => {
        await assert.rejects(
          () =>
            harness.service.setSetting(testActor, sensorId, 'scan.retryWarnings', 99, {
              kind: 'none',
            }),
          /scan\.retryWarnings/,
        );
      });
    });

    // -------------------------------------------------------------------------------------
    // The history keeps every transition it is given (P-108).
    // -------------------------------------------------------------------------------------

    describe('two transitions at one instant', () => {
      async function pauseFlag(column: string, on: boolean, states: SensorStateService, at: Date) {
        await db.tx(async (q) => {
          await q.query(`UPDATE sensor_runtime SET ${column} = $2 WHERE object_id = $1`, [
            sensorId,
            on,
          ]);
          await states.reevaluate(q, [sensorId], at, { message: '' });
        });
      }

      it('keeps the second one rather than letting the unique index eat it', async () => {
        // **`P-108`, findings 8 and 22.** `sensor_state` is keyed on `(sensor_id, time)` with
        // `ON CONFLICT DO NOTHING`, and two callers reuse one timestamp: `sweepPauses` passes a
        // single `now` to `releaseElapsed` and to both of its loops, and `CompositeAuditSink`
        // hands `ScheduleSync` and `DependencySync` the same `at` — both of which react to
        // `object.moved`. `writeStateChanges` has no conflict guard, so `sensor_runtime` took
        // the change the history discarded, and the two disagreed permanently about what the
        // sensor is. Uptime is computed from the one that lost the row.
        const first = build();
        await deliver(first.service, first.ingestor, [result({ at: at(0) })]);

        const states = build().states;
        const when = new Date(AT.getTime() + 60_000);
        await pauseFlag('paused_by_schedule', true, states, when);
        await pauseFlag('paused_by_dependency', true, states, when);

        const rows = await history();
        const runtime = await db.query<{ cause: SensorStateCause }>(
          'SELECT cause FROM sensor_runtime WHERE object_id = $1',
          [sensorId],
        );
        assert.equal(runtime[0]?.cause, 'dependency', 'the row moved to the second source');
        assert.equal(
          rows.at(-1)?.cause,
          'dependency',
          'and the history agrees, instead of stopping at the first',
        );
      });

      it('still lets a genuine replay collide, which is what keeps it idempotent', async () => {
        // The half that must not change. `ON CONFLICT DO NOTHING` is what makes a batch the
        // probe re-offered write into the rows it wrote before; advancing *those* would
        // duplicate the timeline instead of deduplicating it. Same sensor, same instant, same
        // state and cause is the batch arriving twice.
        const first = build();
        await deliver(first.service, first.ingestor, [result({ at: at(0) })]);
        const before = (await history()).length;

        await db.tx((q) =>
          writeStateHistory(q, [
            {
              sensorId,
              at: new Date(at(0)),
              state: 'up',
              previousState: 'unknown',
              cause: 'scan',
              message: '',
            },
          ]),
        );
        assert.equal((await history()).length, before, 'no second row for the same fact');
      });

      it('orders a core-clock transition after a probe whose clock runs ahead', async () => {
        // **Finding 9.** Result-driven transitions carry the probe's wall clock — the protocol
        // says the core does not rewrite it — and every other transition carries the core's. A
        // probe two minutes fast leaves its sensors' newest row *ahead* of the core, so a pause
        // written now sorts *before* it: `GET /state-log` reports the old state with no duration
        // while the badge says Paused, the `previous_state` chain reads backwards, and any
        // uptime computed from the table books the whole maintenance window as monitored Up.
        const first = build();
        const ahead = new Date(AT.getTime() + 120_000);
        await deliver(first.service, first.ingestor, [
          result({ at: ahead.toISOString(), outcome: 'error', message: 'no reply', channels: [] }),
        ]);

        const states = build().states;
        await pauseFlag('paused_manually', true, states, new Date(AT.getTime() + 30_000));

        const rows = await db.query<{ time: Date; state: SensorState }>(
          'SELECT time, state FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
          [sensorId],
        );
        assert.equal(rows.at(-1)?.state, 'paused', 'the newest row is the newest fact');
        assert.ok(
          (rows.at(-1)?.time.getTime() ?? 0) > ahead.getTime(),
          'stamped after the probe’s own clock, not before it',
        );
      });
    });

    // -------------------------------------------------------------------------------------
    // A clock that cannot be believed (P-99).
    // -------------------------------------------------------------------------------------

    describe('a result stamped in the future', () => {
      it('is refused, rather than freezing the sensor’s history for ever', async () => {
        // **`P-99`.** `CheckResult.at` was bounded only by "parses to a number", and
        // `last_result_at` is a high-water mark: `isStaleResult` discards everything no newer
        // and `writeRuntimes` refuses to move a row backwards. So one result from a probe whose
        // RTC is wrong — a VM restored from a snapshot, a dead CMOS battery — made every
        // genuine result after it stale, including the ones reporting a real outage.
        //
        // Nothing self-healed: the only thing that ever reset `last_result_at` was a resume, and
        // `P-97` stopped even that. The sensor's SLA reads 100% through a multi-day outage and
        // no alarm can fire, because the state never moves again.
        const first = build();
        await deliver(first.service, first.ingestor, [result({ at: at(0) })]);

        const wrong = build();
        await deliver(
          wrong.service,
          wrong.ingestor,
          [result({ at: new Date('2030-01-01T00:00:00Z').toISOString() })],
          'b2',
        );
        assert.equal(wrong.service.stats().discardedFutureTime, 1, 'refused, and counted');

        const current = await runtime();
        assert.equal(
          current.last_result_at?.toISOString(),
          at(0),
          'the high-water mark did not move to a time nobody measured',
        );

        // And the sensor still works, which is the whole point.
        const later = build();
        await deliver(later.service, later.ingestor, [failedResult(5)], 'b3');
        assert.equal(later.service.stats().discardedFutureTime, 0);
        assert.equal((await runtime()).consecutive_failures, 1, 'the next real result applies');
      });

      it('allows the ordinary forward skew of a probe host a little fast', async () => {
        // The bound is generous on purpose. Honest forward skew is seconds — a host slightly
        // fast, a batch assembled just before it was sent — and a tight bound would discard good
        // data during ordinary NTP drift. What is being excluded is a clock that is years out.
        const near = build();
        const soon = new Date(Date.now() + 60_000).toISOString();
        await deliver(near.service, near.ingestor, [result({ at: soon })], 'b9');
        assert.equal(near.service.stats().discardedFutureTime, 0);
      });
    });

    // -------------------------------------------------------------------------------------
    // The resume watermark (P-97): what a resume must and must not erase.
    // -------------------------------------------------------------------------------------

    describe('results either side of a resume', () => {
      /** Pause and then resume through the flags, which is what every pause source does. */
      async function pauseThenResume(states: SensorStateService, at: Date): Promise<void> {
        await db.tx(async (q) => {
          await q.query('UPDATE sensor_runtime SET paused_manually = true WHERE object_id = $1', [
            sensorId,
          ]);
          await states.reevaluate(q, [sensorId], at, { message: 'maintenance' });
        });
        await db.tx(async (q) => {
          await q.query('UPDATE sensor_runtime SET paused_manually = false WHERE object_id = $1', [
            sensorId,
          ]);
          await states.reevaluate(q, [sensorId], at, { message: '' });
        });
      }

      const failed = (minutes: number): CheckResult =>
        result({ at: at(minutes), outcome: 'error', message: 'no reply', channels: [] });

      it('discards a re-offered batch after a resume, rather than replaying it as new', async () => {
        // **`P-97`, findings 7 and 28.** `last_result_at` was doing two jobs: the high-water
        // mark that makes the at-least-once probe protocol safe, and "nothing measured since the
        // resume", expressed by nulling it. §3 needs the second; the spool's guarantee that "a
        // dropped connection costs a duplicate write rather than a lost reading" needs the
        // first. Nulling it meant that after any resume, duplicates stopped being duplicates.
        //
        // The probe keeps a batch spooled until the core acknowledges it, so a core that stored
        // a batch and died before replying is re-offered exactly this.
        const first = build();
        await deliver(first.service, first.ingestor, [failed(1), failed(2)]);
        assert.equal((await runtime()).consecutive_failures, 2);

        const states = build().states;
        await pauseThenResume(states, new Date(AT.getTime() + 5 * 60_000));
        assert.equal((await runtime()).state, 'unknown', '§3: it awaits its next scan');

        const again = build();
        await deliver(again.service, again.ingestor, [failed(1), failed(2)], 'b2');

        assert.equal(again.states.stats().resultsStale, 2, 'both were already applied');
        const current = await runtime();
        assert.equal(current.state, 'unknown', 'still awaiting a scan, not Down again');
        assert.equal(current.consecutive_failures, 0, 'and the two-step rule did not re-advance');
      });

      it('discards results a disconnected probe measured inside the pause window', async () => {
        // The other half, and a state neither the spec nor the code had a name for. §3 says "a
        // paused sensor is not in its probe's configuration at all", which is true only of a
        // probe currently connected to receive that configuration. One that lost its link keeps
        // scanning and spooling, so its spool holds readings from inside a window it never heard
        // about — and those wrote Up and Down transitions into a planned maintenance window that
        // uptime and SLA are then computed from.
        const first = build();
        await deliver(first.service, first.ingestor, [result({ at: at(0) })]);

        const states = build().states;
        await pauseThenResume(states, new Date(AT.getTime() + 5 * 60_000));

        // Measured at +2 and +3 minutes: after the last result, before the resume.
        const late = build();
        await deliver(late.service, late.ingestor, [failed(2), failed(3)], 'b2');

        assert.equal(late.states.stats().resultsStale, 2, 'measured before the resume');
        assert.equal((await runtime()).state, 'unknown');
        const inside = (await history()).filter(
          (row) => row.state === 'warning' || row.state === 'down',
        );
        assert.deepEqual(inside, [], 'no outage inside a window the operator paused');
      });

      it('still applies a result measured after the resume', async () => {
        // The guard has to be a floor, not a wall: the whole point of resuming is to start
        // scanning again.
        const first = build();
        await deliver(first.service, first.ingestor, [result({ at: at(0) })]);

        const states = build().states;
        await pauseThenResume(states, new Date(AT.getTime() + 5 * 60_000));

        const after = build();
        await deliver(after.service, after.ingestor, [result({ at: at(9) })], 'b2');

        assert.equal(after.states.stats().resultsStale, 0);
        assert.equal((await runtime()).state, 'up');
      });
    });

    // -------------------------------------------------------------------------------------
    // Channel limits (M-04). A successful check that measured something alarming.
    // -------------------------------------------------------------------------------------

    describe('channel limits', () => {
      async function setLimits(
        key: string,
        limits: Record<string, unknown>,
        id = sensorId,
      ): Promise<{ status: number; body: Record<string, unknown> }> {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/objects/${String(id)}/channels/${key}`,
          payload: { limits },
        });
        return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
      }

      /** A successful check that measured `rtt`. The channel exists after the first one. */
      const measured = (minutes: number, value: number): CheckResult =>
        result({
          at: at(minutes),
          channels: [{ key: 'rtt', value, name: 'Response time', unit: 'ms' }],
        });

      it('goes Down on the very first reading past an error limit, with no two-step', async () => {
        // WORKFLOW.MD §4 rule 2. The two-step rule exists to absorb a dropped packet; a disk
        // that is 99% full is 99% full, and waiting another interval to say so helps nobody.
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        assert.equal((await runtime()).state, 'up');

        assert.equal((await setLimits('rtt', { upperError: 500 })).status, 200);

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 812)], 'b2');

        const current = await runtime();
        assert.equal(current.state, 'down');
        assert.equal(current.cause, 'limit');
        assert.equal(current.consecutive_failures, 0, 'the check succeeded; the reading did not');
        assert.equal(
          (await history()).at(-1)?.message,
          'Response time is 812 ms, above the error limit of 500 ms',
        );
      });

      it('stores the reading that breached the limit, unlike a failed check', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        await setLimits('rtt', { upperError: 500 });
        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 812)], 'b2');

        const rows = await db.query<{ value: number }>(
          `SELECT s.value FROM sample s JOIN channel c ON c.id = s.channel_id
           WHERE c.sensor_id = $1 AND c.key = 'rtt' ORDER BY s.time`,
          [sensorId],
        );
        assert.deepEqual(
          rows.map((row) => row.value),
          [10, 812],
          'the check ran and measured something; the graph must show what it measured',
        );
      });

      it('recovers to Warning when the reading improves into the warning band', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        await setLimits('rtt', { upperError: 500, upperWarning: 200 });

        const second = build();
        await deliver(
          second.service,
          second.ingestor,
          [measured(1, 812), measured(2, 300), measured(3, 50)],
          'b2',
        );

        assert.deepEqual(
          (await history()).map((row) => `${row.previous_state ?? '-'}->${row.state}:${row.cause}`),
          ['unknown->up:scan', 'up->down:limit', 'down->warning:limit', 'warning->up:scan'],
        );
      });

      it('blames the scan, not the limit, when the check itself failed', async () => {
        // §2.3: a failed check records no channel values, so there is nothing to compare
        // against a limit. Carrying the last breach forward would attribute an outage to a
        // threshold somebody set weeks ago.
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        await setLimits('rtt', { upperError: 500 });

        const second = build();
        await deliver(
          second.service,
          second.ingestor,
          [
            measured(1, 812),
            result({ at: at(2), outcome: 'error', message: 'gone', channels: [] }),
          ],
          'b2',
        );

        const last = (await history()).at(-1);
        assert.equal(last?.state, 'warning', 'the first failed scan, under the two-step rule');
        assert.equal(last.cause, 'scan');
        assert.equal(last.message, 'gone');
      });

      it('takes effect on the next scan, without restarting the core', async () => {
        // The cache is what makes ingestion affordable, and the cost of a cache is that
        // something has to notice an edit. The invalidator rides the audit sink for exactly
        // this: an operator who lowers a threshold expects the next scan to act on it.
        const running = build();
        const invalidator = new ResultCacheInvalidator({
          channels: running.channels,
          sensors: running.states,
          logger: silent,
        });
        harness.audit.also = invalidator;
        try {
          // Warm the cache with no limits at all.
          await deliver(running.service, running.ingestor, [measured(0, 10)]);
          assert.equal((await runtime()).state, 'up');

          await harness.service.patchChannel(testActor, sensorId, 'rtt', {
            limits: { upperError: 100 },
          });

          // The *same* service, still running, with a cache that was warm before the edit.
          const next = build();
          next.channels.clear();
          await deliver(next.service, next.ingestor, [measured(1, 812)], 'b2');
          assert.equal((await runtime()).state, 'down', 'a fresh cache acts on it');

          // And the one whose cache was warm when the edit happened.
          const again = new Ingestor({ db, logger: silent, config: CONFIG });
          const sameService = new IngestionService({
            db,
            logger: silent,
            ingestor: again,
            states: running.states,
            resolver: running.channels,
          });
          await deliver(sameService, again, [measured(2, 900)], 'b3');
          assert.equal(
            (await runtime()).state,
            'down',
            'the invalidator dropped the entry the edit made stale',
          );
        } finally {
          harness.audit.also = undefined;
          invalidator.stop();
        }
      });

      it('refuses limits that contradict each other, with the reason', async () => {
        const response = await setLimits('rtt', { upperError: 100, upperWarning: 200 });
        assert.equal(response.status, 400);
        const error = response.body['error'] as { code: string; details: { problems: string[] } };
        assert.equal(error.code, 'OBJECT_INVALID');
        assert.ok(error.details.problems[0]?.includes('never be reached'));
      });

      it('patches one threshold without wiping the others', async () => {
        await setLimits('rtt', { upperError: 500, upperWarning: 200, warningMessage: 'slow' });
        const patched = await setLimits('rtt', { upperError: 900 });
        assert.deepEqual(patched.body['limits'], {
          enabled: true,
          upperError: 900,
          upperWarning: 200,
          lowerWarning: null,
          lowerError: null,
          errorMessage: '',
          warningMessage: 'slow',
        });

        const cleared = await setLimits('rtt', { upperWarning: null });
        assert.equal(
          (cleared.body['limits'] as { upperWarning: number | null }).upperWarning,
          null,
        );
        assert.equal((cleared.body['limits'] as { upperError: number }).upperError, 900);
      });

      it('records who changed a limit and what it was', async () => {
        // Through the real sink, into the real table: a limit is what decides an alarm, and
        // "the sensor went Down because of a limit" is only answerable if the log says who set
        // that limit and to what.
        harness.audit.also = new DatabaseAuditSink();
        try {
          await setLimits('rtt', { upperError: 500 });
        } finally {
          harness.audit.also = undefined;
        }
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/audit?limit=5`,
        });
        const entries = response.json<{ items: { action: string; diff: unknown[] }[] }>().items;
        const entry = entries.find((each) => each.action === 'channel.limits.set');
        assert.ok(entry, 'a limit is what decides an alarm; the log has to say who set it');
        assert.deepEqual(entry.diff, [
          { field: 'channel.rtt.upperError', before: null, after: 500 },
        ]);
      });

      it('keeps a limit breach across every path that re-decides without a reading', async () => {
        // **The channel verdict is state, and it has to be persisted like the rest of it.**
        // `reevaluate` rebuilds the facts from `sensor_runtime` and re-runs the machine, so
        // every fact the machine reads has to survive that round trip. A limit breach carries
        // `consecutive_failures = 0` — the check succeeded, the reading did not — so a
        // non-persisted channel verdict rebuilds as "last scan OK, nothing judged" and layer 5
        // answers Up. Acknowledging is the sharpest way to see it: `acknowledge` writes the
        // columns and then calls `reevaluate` in the same transaction.
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        await setLimits('rtt', { upperError: 500 });
        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 812)], 'b2');
        assert.equal((await runtime()).state, 'down');

        const resolved = resolveAcknowledgement({ kind: 'indefinite' }, 'ticket 41', AT);
        assert.ok('acknowledgement' in resolved);
        await db.tx((q) =>
          build().states.acknowledge(
            q,
            [sensorId],
            resolved.acknowledgement,
            { kind: 'user', label: 'tester' },
            AT,
          ),
        );

        const current = await runtime();
        assert.equal(current.state, 'down_acknowledged', 'not Up: nothing new was measured');
        assert.equal(current.cause, 'user');
        assert.notEqual(
          await acknowledgedAt(),
          null,
          'the acknowledgement survives the reevaluate that acknowledging itself triggers',
        );
        assert.equal(
          (await history()).filter((row) => row.state === 'up').length,
          1,
          'one Up, from the first clean reading — a recovery nobody measured is not a recovery',
        );
      });

      it('keeps it across a probe reconnect and a lifted simulated error too', async () => {
        // The same reset reached through the other two doors. `ProbeReachability.found` and
        // `simulate(false)` both promise the sensor goes back to what its last reading said;
        // for a limit breach that promise is only kept if the verdict was stored.
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 10)]);
        await setLimits('rtt', { upperError: 500 });
        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 812)], 'b2');

        const states = build().states;
        await db.tx((q) => states.simulate(q, [sensorId], true, 'rehearsal', AT));
        assert.equal((await runtime()).state, 'down');
        await db.tx((q) => states.simulate(q, [sensorId], false, '', AT));

        const current = await runtime();
        assert.equal(current.state, 'down', 'back to the truth, and the truth was a breach');
        assert.equal(current.cause, 'limit');
      });

      it('404s for a channel the sensor does not have', async () => {
        assert.equal((await setLimits('nonexistent', { upperError: 1 })).status, 404);
      });

      it('refuses to put limits on something that is not a sensor', async () => {
        assert.equal((await setLimits('rtt', { upperError: 1 }, deviceId)).status, 409);
      });
    });

    // -------------------------------------------------------------------------------------
    // Scaling and the spike filter (M-07), between the reading arriving and being judged.
    // -------------------------------------------------------------------------------------

    describe('reading processing', () => {
      async function setProcessing(
        key: string,
        processing: Record<string, unknown>,
      ): Promise<{ status: number; body: Record<string, unknown> }> {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/objects/${String(sensorId)}/channels/${key}`,
          payload: { processing },
        });
        return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
      }

      const measured = (minutes: number, value: number): CheckResult =>
        result({
          at: at(minutes),
          channels: [{ key: 'rtt', value, name: 'Response time', unit: 'ms' }],
        });

      async function storedRtt(): Promise<number[]> {
        const rows = await db.query<{ value: number }>(
          `SELECT s.value FROM sample s JOIN channel c ON c.id = s.channel_id
           WHERE c.sensor_id = $1 AND c.key = 'rtt' ORDER BY s.time`,
          [sensorId],
        );
        return rows.map((row) => row.value);
      }

      it('stores the scaled value, so nothing downstream has to scale it again', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 1_000)]);
        assert.equal((await setProcessing('rtt', { scaleDiv: '1000' })).status, 200);

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 2_000)], 'b2');

        assert.deepEqual(
          await storedRtt(),
          [1_000, 2],
          'the graph steps where the factor changed, and every later reading is in the new unit',
        );
      });

      it('judges the scaled value, so the alarm and the graph agree', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 1)]);
        await setProcessing('rtt', { scaleMul: '8' });
        await harness.service.patchChannel(testActor, sensorId, 'rtt', {
          limits: { upperError: 100 },
        });

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 20)], 'b2');

        // 20 × 8 = 160, over the limit of 100. Judged raw it would have been under it.
        assert.equal((await runtime()).state, 'down');
        assert.equal(
          (await history()).at(-1)?.message,
          'Response time is 160 ms, above the error limit of 100 ms',
        );
        assert.deepEqual((await storedRtt()).at(-1), 160, 'and the stored value is the same 160');
      });

      it('discards a spike, leaving a gap rather than a zero', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 5)]);
        await setProcessing('rtt', { spikeMax: 1_000 });

        const second = build();
        await deliver(
          second.service,
          second.ingestor,
          [measured(1, 4_000_000_000), measured(2, 7)],
          'b2',
        );

        assert.deepEqual(
          await storedRtt(),
          [5, 7],
          'a wrapped counter must not flatten a graph, and a zero would just move the lie',
        );
        assert.equal(second.service.stats().discardedSpike, 1, 'counted, never silent');
      });

      it('lets a discarded spike decide nothing about the sensor’s state', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 5)]);
        await setProcessing('rtt', { spikeMax: 1_000 });
        await harness.service.patchChannel(testActor, sensorId, 'rtt', {
          limits: { upperError: 100 },
        });

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 4_000_000_000)], 'b2');
        assert.equal(
          (await runtime()).state,
          'up',
          'the reading was thrown away, so it cannot breach a limit either',
        );
      });

      it('filters on the scaled value, because both bounds are in the channel’s unit', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 5)]);
        await setProcessing('rtt', { scaleMul: '8', spikeMax: 5_000 });

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 1_000)], 'b2');
        assert.deepEqual(await storedRtt(), [5], '1,000 × 8 is 8,000, over the 5,000 bound');
      });

      it('takes effect on the next scan, without restarting the core', async () => {
        const running = build();
        const invalidator = new ResultCacheInvalidator({
          channels: running.channels,
          sensors: running.states,
          logger: silent,
        });
        harness.audit.also = invalidator;
        try {
          await deliver(running.service, running.ingestor, [measured(0, 1_000)]);
          await harness.service.patchChannel(testActor, sensorId, 'rtt', {
            processing: { scaleDiv: '1000' },
          });

          const again = new Ingestor({ db, logger: silent, config: CONFIG });
          const sameService = new IngestionService({
            db,
            logger: silent,
            ingestor: again,
            states: running.states,
            resolver: running.channels,
          });
          await deliver(sameService, again, [measured(1, 2_000)], 'b2');
          assert.deepEqual(await storedRtt(), [1_000, 2]);
        } finally {
          harness.audit.also = undefined;
          invalidator.stop();
        }
      });

      it('refuses a factor of zero and an inverted spike range, with the reason', async () => {
        const zero = await setProcessing('rtt', { scaleDiv: '0' });
        assert.equal(zero.status, 400);
        const inverted = await setProcessing('rtt', { spikeMin: 100, spikeMax: 10 });
        assert.equal(inverted.status, 400);
        const error = inverted.body['error'] as { details: { problems: string[] } };
        assert.ok(error.details.problems[0]?.includes('every reading would be discarded'));
      });

      it('patches one field without disturbing the others', async () => {
        await setProcessing('rtt', { scaleMul: '8', decimals: 2, spikeMax: 500 });
        const patched = await setProcessing('rtt', { decimals: 0 });
        assert.equal(patched.body['scaleMul'], '8');
        assert.equal(patched.body['decimals'], 0);
        assert.equal(patched.body['spikeMax'], 500);

        const cleared = await setProcessing('rtt', { spikeMax: null, decimals: null });
        assert.equal(cleared.body['spikeMax'], null);
        assert.equal(cleared.body['decimals'], null, 'null is automatic, not zero');
      });

      it('shows a value to the declared precision in the message it writes', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [measured(0, 1)]);
        await setProcessing('rtt', { decimals: 1 });
        await harness.service.patchChannel(testActor, sensorId, 'rtt', {
          limits: { upperError: 10 },
        });

        const second = build();
        await deliver(second.service, second.ingestor, [measured(1, 12.3456)], 'b2');
        assert.equal(
          (await history()).at(-1)?.message,
          'Response time is 12.3 ms, above the error limit of 10.0 ms',
        );
      });

      it('records who changed a factor, which is what answers a graph that jumped', async () => {
        harness.audit.also = new DatabaseAuditSink();
        try {
          await setProcessing('rtt', { scaleMul: '8' });
        } finally {
          harness.audit.also = undefined;
        }
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/audit?limit=5`,
        });
        const entries = response.json<{ items: { action: string; diff: unknown[] }[] }>().items;
        const entry = entries.find((each) => each.action === 'channel.processing.set');
        assert.ok(entry);
        assert.deepEqual(entry.diff, [{ field: 'channel.rtt.scaleMul', before: '1', after: '8' }]);
      });
    });

    // -------------------------------------------------------------------------------------
    // Lookups (M-06). A reading that is a status code, not a measurement.
    // -------------------------------------------------------------------------------------

    describe('channel lookups', () => {
      async function setLookup(
        key: string,
        lookupId: string | null,
        id = sensorId,
      ): Promise<{ status: number; body: Record<string, unknown> }> {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/objects/${String(id)}/channels/${key}`,
          payload: { lookupId },
        });
        return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
      }

      /** A successful check reporting an interface status code. */
      const reported = (minutes: number, value: number): CheckResult =>
        result({
          at: at(minutes),
          channels: [{ key: 'status', value, name: 'Interface status' }],
        });

      it('goes Down on the first reading a lookup maps to down, attributed to the lookup', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        assert.equal((await runtime()).state, 'up', 'ifOperStatus 1 is up');

        assert.equal((await setLookup('status', 'ms.snmp.if-oper-status')).status, 200);

        const second = build();
        await deliver(second.service, second.ingestor, [reported(1, 2)], 'b2');

        const current = await runtime();
        assert.equal(current.state, 'down');
        assert.equal(current.cause, 'lookup');
        assert.equal(current.consecutive_failures, 0, 'the check succeeded; the interface did not');
        assert.equal((await history()).at(-1)?.message, 'Interface status is 2 (down)');
      });

      it('keeps storing the reading, because the check succeeded', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        await setLookup('status', 'ms.snmp.if-oper-status');
        const second = build();
        await deliver(second.service, second.ingestor, [reported(1, 2)], 'b2');

        const rows = await db.query<{ value: number }>(
          `SELECT s.value FROM sample s JOIN channel c ON c.id = s.channel_id
           WHERE c.sensor_id = $1 AND c.key = 'status' ORDER BY s.time`,
          [sensorId],
        );
        assert.deepEqual(
          rows.map((row) => row.value),
          [1, 2],
        );
      });

      it('names the lookup when the device returns a code it does not define', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        await setLookup('status', 'ms.snmp.if-oper-status');
        const second = build();
        await deliver(second.service, second.ingestor, [reported(1, 99)], 'b2');

        const current = await runtime();
        assert.equal(current.state, 'warning', 'the lookup’s undefinedState');
        assert.equal(current.cause, 'lookup');
        assert.equal(
          current.message,
          'Interface status is 99, which ms.snmp.if-oper-status does not define',
        );
      });

      it('takes effect on the next scan, without restarting the core', async () => {
        const running = build();
        const invalidator = new ResultCacheInvalidator({
          channels: running.channels,
          sensors: running.states,
          logger: silent,
        });
        harness.audit.also = invalidator;
        try {
          await deliver(running.service, running.ingestor, [reported(0, 2)]);
          assert.equal((await runtime()).state, 'up', 'no lookup yet, and no limits either');

          await harness.service.patchChannel(testActor, sensorId, 'status', {
            lookupId: 'ms.snmp.if-oper-status',
          });

          const again = new Ingestor({ db, logger: silent, config: CONFIG });
          const sameService = new IngestionService({
            db,
            logger: silent,
            ingestor: again,
            states: running.states,
            resolver: running.channels,
          });
          await deliver(sameService, again, [reported(1, 2)], 'b2');
          assert.equal((await runtime()).state, 'down', 'the cached channel was dropped');
        } finally {
          harness.audit.also = undefined;
          invalidator.stop();
        }
      });

      it('accepts a lookup nobody loaded, and says so in Warning rather than guessing', async () => {
        // A sensor type can ship ahead of its lookup file, so refusing the configuration would
        // leave the operator unable to write down what they mean. Falling back to the limit
        // below would put a threshold they did not intend in charge; saying nothing would let a
        // broken configuration read as healthy.
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        assert.equal((await setLookup('status', 'acme.not-loaded')).status, 200);
        await harness.service.patchChannel(testActor, sensorId, 'status', {
          limits: { upperError: 0 },
        });

        const second = build();
        await deliver(second.service, second.ingestor, [reported(1, 2)], 'b2');
        const current = await runtime();
        assert.equal(current.state, 'warning', 'not Down: the limit is not in charge');
        assert.equal(current.cause, 'lookup');
        assert.ok(current.message.includes('acme.not-loaded'));
        assert.equal(second.channels.unresolvedLookups, 1, 'and it is counted, not assumed away');
      });

      it('serves the id whatever the installation has, so a UI can say it is missing', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        await setLookup('status', 'acme.not-loaded');
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/channels`,
        });
        const items = response.json<{ items: { key: string; lookupId: string | null }[] }>().items;
        assert.equal(items.find((item) => item.key === 'status')?.lookupId, 'acme.not-loaded');
      });

      it('clears a lookup with null, putting limits back in charge', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        await setLookup('status', 'ms.snmp.if-oper-status');
        const cleared = await setLookup('status', null);
        assert.equal(cleared.body['lookupId'], null);
      });

      it('records who pointed a channel at which lookup', async () => {
        const first = build();
        await deliver(first.service, first.ingestor, [reported(0, 1)]);
        harness.audit.also = new DatabaseAuditSink();
        try {
          await setLookup('status', 'ms.snmp.if-oper-status');
        } finally {
          harness.audit.also = undefined;
        }
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/audit?limit=5`,
        });
        const entries = response.json<{ items: { action: string; diff: unknown[] }[] }>().items;
        const entry = entries.find((each) => each.action === 'channel.lookup.set');
        assert.ok(entry);
        assert.deepEqual(entry.diff, [
          { field: 'channel.status.lookup', before: null, after: 'ms.snmp.if-oper-status' },
        ]);
      });

      it('lists what loaded, so an operator can see what a channel may name', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/lookups' });
        assert.equal(response.statusCode, 200);
        const body = response.json<{
          items: { id: string; entryCount: number }[];
          problems: unknown[];
        }>();
        assert.ok(body.items.some((item) => item.id === 'ms.snmp.if-oper-status'));
        assert.deepEqual(body.problems, [], 'the built-ins validate');
      });

      it('serves one lookup with every entry, which is what the fix needs', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/lookups/ms.snmp.if-oper-status',
        });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ entries: { value: number; text: string }[] }>();
        assert.equal(body.entries.find((entry) => entry.value === 2)?.text, 'down');
      });

      it('404s for a lookup nobody loaded', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/lookups/acme.nope' });
        assert.equal(response.statusCode, 404);
      });
    });

    // -------------------------------------------------------------------------------------
    // GET /sensors/:id/state — the whole answer for one sensor.
    // -------------------------------------------------------------------------------------

    describe('the state endpoint', () => {
      async function read(id: number): Promise<{
        status: number;
        cacheControl: string | undefined;
        body: Record<string, unknown>;
      }> {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sensors/${String(id)}/state`,
        });
        return {
          status: response.statusCode,
          cacheControl: response.headers['cache-control'],
          body: response.statusCode === 200 ? response.json<Record<string, unknown>>() : {},
        };
      }

      it('reports the state, the cause and since when', async () => {
        const { service, ingestor } = build();
        await deliver(service, ingestor, [
          result(),
          result({ at: at(1), outcome: 'error', message: 'gone', channels: [] }),
        ]);

        const response = await read(sensorId);
        assert.equal(response.status, 200);
        assert.equal(response.body['state'], 'warning');
        assert.equal(response.body['cause'], 'scan');
        assert.equal(response.body['message'], 'gone');
        assert.equal(response.body['consecutiveFailures'], 1);
        assert.equal(response.body['since'], at(1));
        assert.deepEqual(response.body['pausedBy'], []);
      });

      it('is never cached, because it is the one thing that changes on its own', async () => {
        assert.equal((await read(sensorId)).cacheControl, 'no-store');
      });

      it('reads Unknown for a sensor that has never reported, rather than 404', async () => {
        const response = await read(sensorId);
        assert.equal(response.status, 200);
        assert.equal(response.body['state'], 'unknown');
        assert.equal(response.body['lastResultAt'], null);
      });

      it('404s for an object that is not a sensor', async () => {
        assert.equal((await read(deviceId)).status, 404);
      });

      it('lists every pause source, not only the one being reported', async () => {
        // The set-not-chain rule, at the boundary a UI reads: offering "resume" against the
        // reported cause alone would leave the sensor paused and look broken.
        await db.query(
          `UPDATE sensor_runtime
           SET state = 'paused', cause = 'parent', paused_by_parent = true, paused_manually = true
           WHERE object_id = $1`,
          [sensorId],
        );
        const response = await read(sensorId);
        assert.equal(response.body['cause'], 'parent');
        assert.deepEqual(response.body['pausedBy'], ['parent', 'manual']);
      });
    });
  },
);
