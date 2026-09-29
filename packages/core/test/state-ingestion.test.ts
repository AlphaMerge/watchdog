import { strict as assert } from 'node:assert';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { CheckResult, HousekeepingConfig, IngestionConfig, Logger } from '@ms/shared';
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
import {
  IngestionService,
  maxResultAgeMs,
  TIME_REFUSAL_WINDOW_MS,
} from '../src/ingestion/service.js';
import { SensorStateService, type PolicySource } from '../src/state/service.js';
import { writeStateHistory } from '../src/state/runtime.js';
import { resolveAcknowledgement } from '../src/state/acknowledgement.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { Visibility } from '../src/auth/access.js';

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
    /** A second sensor, for the cases that need two probes' worth of work (`P-169`). */
    let otherSensorId: number;
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
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
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
      const other = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `other-${String(process.hrtime.bigint())}`,
        sensorType: 'icmp.ping',
      });
      otherSensorId = other.id;
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
      sentAt?: Date,
      source = 'probe-state',
    ): Promise<string> {
      const reply = await service.acceptResults(source, {
        type: 'results',
        batchId,
        results: [...results],
        // When the probe says it sent this, by its own clock. Absent by default, which is what a
        // probe below protocol 16 sends — and then the core falls back to its own clock
        // (`P-169`).
        ...(sentAt === undefined ? {} : { sentAt: sentAt.toISOString() }),
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
        const clone = await harness.service.clone(
          testActor,
          deviceId,
          {
            name: `clone-${String(process.hrtime.bigint())}`,
          },
          Visibility.EVERYTHING,
        );
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
        Visibility.EVERYTHING,
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

      it('uses a policy a forget overtook for its own batch, and does not keep it (`P-240`)', async () => {
        // An edit's second forget runs once the edit has committed, and a resolve that began
        // before then may have read the old setting. This batch must still use what it read:
        // the default instead is `P-86`'s false transition. The cache must not keep it, or the
        // edit is inert until the next one. `clear` is a delete's, and counts the same.
        await harness.service.setSetting(testActor, deviceId, 'scan.retryWarnings', 0, {
          kind: 'none',
        });
        try {
          for (const [index, overtake] of (['forgetPolicies', 'clear'] as const).entries()) {
            const overtaking: { states?: SensorStateService } = {};
            const settings: PolicySource = {
              resolveForObjects: async (ids, key) => {
                const answer = await harness.resolver.resolveForObjects(ids, key);
                overtaking.states?.[overtake]();
                return answer;
              },
            };
            const states = new SensorStateService({
              db,
              logger: silent,
              settings,
              pauses: new PauseRepository(),
            });
            overtaking.states = states;
            const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
            const service = new IngestionService({
              db,
              logger: silent,
              ingestor,
              states,
              resolver: new ChannelResolver({ logger: silent, lookups }),
            });
            await deliver(service, ingestor, [failing(index)], `b${String(index + 1)}`);
            // Down at the first failure, and the second changes nothing.
            assert.deepEqual(
              (await history()).map((row) => row.state),
              ['down'],
              `${overtake}: the batch fell back to the default instead of the policy it resolved`,
            );
            assert.equal(
              states.stats().cachedPolicies,
              0,
              `${overtake}: a resolve it overtook was kept`,
            );
          }
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

      it('keeps a spool replay at the times it was measured, not at the next millisecond', async () => {
        // **`P-145`, the half `P-108` got wrong.** `orderedAfterLast` stamps every transition
        // after that sensor's newest stored row. That is right for the core's own decisions —
        // they happen now — and wrong for results, which carry the probe's clock and arrive late
        // by design: a probe that spooled through an outage replays an hour of genuine history,
        // and every row of it was rewritten to `newest + 1 ms`, `+ 2 ms`, `+ 3 ms`. A four-hour
        // outage became four milliseconds in the table `CLAUDE.md` says uptime is computed from,
        // and the SLA read 100% through it.
        //
        // The core writes a newer row first — which is exactly what happens when a probe goes
        // away: the reachability tracker marks its sensors Unknown at the core's clock.
        const seed = build();
        await deliver(seed.service, seed.ingestor, [result({ at: at(0) })]);
        // Written straight in, because what matters is only that the *newest stored row* is
        // newer than the replay — pausing the sensor to arrange it would also stop the replayed
        // results producing any transitions at all, which is a different behaviour.
        const marker = new Date(AT.getTime() + 4 * 60 * 60_000);
        await db.query(
          `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
           VALUES ($2, $1, 'unknown', 'up', 'probe', 'the probe stopped answering')`,
          [sensorId, marker],
        );

        // Now the probe reconnects and replays the outage it spooled, hours ago.
        const replay = build();
        await deliver(
          replay.service,
          replay.ingestor,
          [
            result({
              at: new Date(AT.getTime() + 60 * 60_000).toISOString(),
              outcome: 'error',
              message: 'no reply',
              channels: [],
            }),
            result({
              at: new Date(AT.getTime() + 61 * 60_000).toISOString(),
              outcome: 'error',
              message: 'no reply',
              channels: [],
            }),
          ],
          'b-replay',
        );

        const rows = await db.query<{ time: Date; state: SensorState }>(
          'SELECT time, state FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
          [sensorId],
        );
        const replayed = rows.filter((row) => row.time.getTime() < marker.getTime());
        assert.ok(
          replayed.some((row) => row.time.getTime() >= AT.getTime() + 60 * 60_000),
          'the replayed history is stored an hour in, where it happened',
        );
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

    // -------------------------------------------------------------------------------------
    // A probe draining its spool (`P-146`).
    // -------------------------------------------------------------------------------------

    describe('a batch that is hours behind', () => {
      /** A failing result at a given instant — the shape every case in here delivers. */
      const failure = (at: Date): CheckResult =>
        result({ at: at.toISOString(), outcome: 'error', message: 'no reply', channels: [] });

      /** Records what `react` was called with, and whether readings widen the scan (`P-104`). */
      const reactionStub = (
        reacted: number[][],
        reconcilesReadings: boolean,
      ): {
        anyWork: () => Promise<boolean>;
        reconcilesReadings: () => Promise<boolean>;
        react: (q: unknown, sensorIds: readonly number[]) => Promise<void>;
      } => ({
        anyWork: () => Promise.resolve(true),
        reconcilesReadings: () => Promise.resolve(reconcilesReadings),
        react: (_q: unknown, sensorIds: readonly number[]) => {
          reacted.push([...sensorIds]);
          return Promise.resolve();
        },
      });

      /**
       * A fresh service and ingestor sharing one alarm stub.
       *
       * A fresh *pair* per batch on purpose: `deliver` stops the ingestor once it has drained,
       * which is what makes these deterministic, and a stopped ingestor accepts nothing more.
       * The stub is shared so the deferral carried between batches is the ingestor's own —
       * which is the thing under test — rather than an artefact of the harness.
       */
      const withStubbedAlarms = (
        alarms: ReturnType<typeof reactionStub>,
      ): { service: IngestionService; ingestor: Ingestor } => {
        const states = new SensorStateService({
          db,
          logger: silent,
          settings: harness.resolver,
          pauses: new PauseRepository(),
        });
        const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms });
        return {
          ingestor,
          service: new IngestionService({
            db,
            logger: silent,
            ingestor,
            states,
            resolver: new ChannelResolver({ logger: silent, lookups }),
          }),
        };
      };

      const stateOf = async (): Promise<string | undefined> =>
        (
          await db.query<{ state: string }>(
            'SELECT state FROM sensor_runtime WHERE object_id = $1',
            [sensorId],
          )
        )[0]?.state;

      it('is written to history but not reacted to, so nobody is paged for an old outage', async () => {
        // **`P-146`.** The chain's clock is not `now`: `arm` takes `initialDueAt(sensor.since)`,
        // and `since` is the *replayed result's* own timestamp. A Down replayed from six hours
        // ago armed with a due time six hours in the past, `onArmed` woke the scheduler, and the
        // sweep fired within a second — then the escalation on the next sweep, then the repeat,
        // because every deadline computed from that `since` was also in the past. The recovery
        // that ended the outage was still in the probe's spool, tens of batches behind. Every
        // blip a probe spooled was paged, escalated and repeated, and the initial latency —
        // "a 30-second blip on a five-minute latency produces no notification at all" — bought
        // nothing at all.
        const reacted: number[][] = [];
        const alarms = {
          anyWork: () => Promise.resolve(true),
          reconcilesReadings: () => Promise.resolve(false),
          react: (_q: unknown, sensorIds: readonly number[]) => {
            reacted.push([...sensorIds]);
            return Promise.resolve();
          },
        };
        // A fresh pair per batch: `deliver` stops the ingestor when it has drained, which is what
        // makes it deterministic, and a stopped ingestor accepts nothing more.
        const withStub = (): { service: IngestionService; ingestor: Ingestor } => {
          const states = new SensorStateService({
            db,
            logger: silent,
            settings: harness.resolver,
            pauses: new PauseRepository(),
          });
          const ingestor = new Ingestor({
            db,
            logger: silent,
            config: CONFIG,
            alarms,
          });
          return {
            ingestor,
            service: new IngestionService({
              db,
              logger: silent,
              ingestor,
              states,
              resolver: new ChannelResolver({ logger: silent, lookups }),
            }),
          };
        };
        const drain = withStub();

        const long = new Date(Date.now() - 6 * 60 * 60_000);
        await deliver(
          drain.service,
          drain.ingestor,
          [
            result({
              at: long.toISOString(),
              outcome: 'error',
              message: 'no reply',
              channels: [],
            }),
          ],
          'b-drain',
        );
        assert.deepEqual(reacted, [], 'a batch six hours behind cannot decide the present');
        assert.equal(drain.ingestor.stats().staleReactions, 1, 'and it is counted, not silent');

        // The history is still written — this defers the *reaction*, never the record.
        const rows = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1 AND time = $2`,
          [sensorId, long],
        );
        assert.equal(rows[0]?.n, '1');

        // And the live batch that ends the drain reconciles, as it should. Two results, because
        // the two-step rule needs a second failure to reach Down and it is the *transition* the
        // reaction is keyed on.
        const live = withStub();
        await deliver(
          live.service,
          live.ingestor,
          [
            result({
              at: new Date().toISOString(),
              outcome: 'error',
              message: 'no reply',
              channels: [],
            }),
          ],
          'b-live',
        );
        assert.ok(reacted.length >= 1, 'the batch that can see the present is the one that acts');
      });

      it('still arms an outage whose Down landed inside the batch that was skipped', async () => {
        // **`R04`, `G02` — the hole `P-146` left, and it is total.** Skipping was justified by
        // "the drain ends with a live batch, and that one decides the present correctly". It
        // does not: the reaction is keyed on *this batch's* transitions, and a sensor that goes
        // Down during the spooled window transitions once — in a skipped batch — and never
        // transitions again while the outage continues. Every later batch has it in `runtimes`
        // and not in `transitions`, so nothing arms it. One outage, zero alarms, for an outage
        // that is happening right now.
        //
        // The distinguishing detail against the test above: *both* failures go in the stale
        // batch, so the two-step rule reaches Down there rather than in the live one.
        const reacted: number[][] = [];
        const stub = reactionStub(reacted, false);

        const long = Date.now() - 6 * 60 * 60_000;
        // **One ingestor across both batches**, unlike the cases around it: what is deferred is
        // held on the ingestor, so a fresh one per batch would be testing the harness.
        const { service, ingestor } = withStubbedAlarms(stub);
        const offer = async (batchId: string, results: readonly CheckResult[]): Promise<void> => {
          await service.acceptResults('probe-state', {
            type: 'results',
            batchId,
            results: [...results],
          });
        };

        await offer('r04-drain', [
          failure(new Date(long)),
          // The second failure is what reaches Down — and it is 30 s later, still hours old.
          failure(new Date(long + 30_000)),
        ]);
        assert.deepEqual(reacted, [], 'a six-hour-old batch still cannot decide the present');
        assert.equal(await stateOf(), 'down', 'but the state it decided is on the row');
        assert.equal(
          ingestor.stats().deferredReactions,
          1,
          'the sensor that moved is held, not dropped',
        );

        // The live batch that ends the drain carries no transition — the sensor is already Down
        // and stays Down — so before this fix `scanned` was empty and nothing was ever armed.
        await offer('r04-live', [failure(new Date())]);
        await ingestor.stop();
        assert.deepEqual(
          reacted,
          [[sensorId]],
          'the outage that started during the drain was never armed',
        );
        assert.equal(
          ingestor.stats().deferredReactions,
          0,
          'and the deferral is cleared once it has been reconciled',
        );
      });

      it('does not react to a drain batch whose sensors have already reached their final state', async () => {
        // **`R16`, and the first version of this test could not fail.** Staleness was folded over
        // `transitions`, not results, while the ticket's own text says "a batch whose newest
        // *result* is older than the catch-up grace". During a drain most batches change no state
        // at all, so `transitions` is empty, the batch reads as live, and on any installation with
        // a threshold trigger anywhere `scanned` widens to every sensor in it: `react` over
        // runtime rows written from hours-old readings, arming from a `since` six hours past.
        //
        // **The discriminating detail is that the second batch must carry no transition**, and
        // the first attempt at this test got it wrong: `warnFor` is 1, so failure one is
        // unknown→warning and failure two is warning→down — two transitions, not none. Both
        // batches passed under the old rule and the new one alike. Three failures are needed
        // before a fourth changes nothing.
        const reacted: number[][] = [];
        // `reconcilesReadings: true` is the widening case — an installation with any threshold
        // trigger — and it is the one that turns this from a no-op into the storm.
        const stub = reactionStub(reacted, true);

        const long = Date.now() - 6 * 60 * 60_000;
        const drain = withStubbedAlarms(stub);
        // Two failures to reach Down, both hours old.
        await deliver(
          drain.service,
          drain.ingestor,
          [failure(new Date(long)), failure(new Date(long + 30_000))],
          'r16-a',
          // A drain sends six-hour-old results *now*: it is the gap between the two that says
          // this is a replay, and both numbers are the probe's own clock.
          new Date(),
        );
        assert.deepEqual(reacted, [], 'the batch that carries the transitions is a replay');
        assert.equal(await stateOf(), 'down', 'and it is Down, so a third failure moves nothing');

        // Now the case the ticket is about: a batch that changes no state at all. The sensor is
        // already Down, so this failure produces a runtime write and no transition.
        const second = withStubbedAlarms(stub);
        await deliver(
          second.service,
          second.ingestor,
          [failure(new Date(long + 60_000))],
          'r16-b',
          new Date(),
        );
        assert.deepEqual(
          reacted,
          [],
          'a batch with no transition at all is not therefore a current one',
        );
      });

      it('judges a replay by the probe-s own clock, not against the core-s', async () => {
        // **`R17`, and `P-157` answered it with the wrong field.** `result.at` is the probe's
        // clock — the premise of `P-145` — and backward skew is deliberately unbounded, because a
        // spool replay depends on it. Comparing those results against the *core's* now makes a
        // probe five minutes slow look like a permanent replay: connected, heartbeating,
        // delivering, and no sensor under it ever armed.
        //
        // `P-157` replaced that with the probe's `backlog`, which is worse: `backlog` is
        // `pending - batch.length`, so a live probe whose scan tick queues more than one batch
        // reports thousands and every live batch read as a replay. At 5,047 sensors and a 500-row
        // batch that is the ordinary case.
        //
        // `sentAt` is the probe's clock at the moment it sent, so `sentAt - newest result` is a
        // duration on one machine and the skew cancels.
        const reacted: number[][] = [];
        const stub = reactionStub(reacted, false);
        const slow = Date.now() - 5 * 60_000;

        const drifted = withStubbedAlarms(stub);
        await deliver(
          drifted.service,
          drifted.ingestor,
          [failure(new Date(slow)), failure(new Date(slow + 30_000))],
          'r17',
          // The probe sent it a moment after measuring it. Its clock is five minutes behind the
          // core's, and that is exactly what must not matter.
          new Date(slow + 31_000),
        );
        assert.deepEqual(
          reacted,
          [[sensorId]],
          'a batch a probe sent seconds after measuring it is live, however wrong its clock',
        );
      });

      it('falls back to the core clock when a probe sends an unreadable sentAt', async () => {
        // **`P-180`.** The wire schema is a 1-64 character string — `format: 'date-time'` is
        // deliberately omitted, because this validator runs without ajv-formats where an unknown
        // format is no validation at all. An unparseable value therefore reached the ingestor as
        // an Invalid Date, which is not `undefined`, so the documented fallback could not fire:
        // `against` was NaN, `NaN - newest > grace` is always false, and the replay guard failed
        // open **permanently** for that peer, silently, with every counter reading zero.
        const reacted: number[][] = [];
        const stub = reactionStub(reacted, false);
        const long = Date.now() - 6 * 60 * 60_000;
        const { service, ingestor } = withStubbedAlarms(stub);

        await service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'bad-sentat',
          results: [failure(new Date(long)), failure(new Date(long + 30_000))],
          // Passes the schema; `new Date` cannot read it. Worth noting that the *obvious*
          // example — '2026-09-05 14:03:11' — is not this case: V8 parses that happily as local
          // time, which is its own hazard and a milder one, because it still yields a number the
          // comparison can work with.
          sentAt: 'not a timestamp',
        });
        await ingestor.stop();

        assert.deepEqual(
          reacted,
          [],
          'an unreadable timestamp must not turn a six-hour replay into a live batch',
        );
        assert.equal(
          service.stats().discardedInvalidSentAt,
          1,
          'and it is counted, because a guard that quietly stops guarding is the worst kind',
        );
      });

      it('does not treat a wholly duplicate re-delivery as a live batch', async () => {
        // **`P-179`.** A batch re-sent after a lost `results-ack` is entirely duplicate, so
        // `decide` skips every result as stale and returns no transitions and no runtimes —
        // while the samples still reach the write. That submission registered its source as one
        // this write carried and then recorded no staleness verdict, and "no verdict" fell
        // through to *live*: the probe's whole deferred set was flushed and reacted over rows
        // the drain had written hours ago, arming from a `since` six hours past. The drain's own
        // storm, produced by its own repair — and the trigger is the modal one, because the link
        // flap that creates a spool is exactly what loses an ack.
        const reacted: number[][] = [];
        const stub = reactionStub(reacted, false);
        const long = Date.now() - 6 * 60 * 60_000;
        const { service, ingestor } = withStubbedAlarms(stub);

        // **Measured results, not failed ones**, and that detail is the test: a failed check
        // records no channel values, so a duplicate of one carries neither samples nor states
        // and never reaches the write at all. The batch that reaches it and decides nothing is
        // one with readings — which is every ordinary batch a probe re-sends.
        const drain = [
          result({ at: new Date(long).toISOString() }),
          result({ at: new Date(long + 30_000).toISOString() }),
        ];
        await service.acceptResults('probe-remote', {
          type: 'results',
          batchId: 'dup-1',
          results: drain,
          sentAt: new Date().toISOString(),
        });
        assert.deepEqual(reacted, [], 'the replay is held');
        assert.equal(ingestor.stats().deferredReactions, 1);

        // The identical batch again. Its readings are stored idempotently, but every result is
        // now older than `last_result_at`, so `decide` skips all of them: samples, no states.
        await service.acceptResults('probe-remote', {
          type: 'results',
          batchId: 'dup-2',
          results: drain,
          sentAt: new Date().toISOString(),
        });
        await ingestor.stop();

        assert.deepEqual(
          reacted,
          [],
          'a batch that decided nothing cannot be the batch that says the drain is over',
        );
        assert.equal(
          ingestor.stats().deferredReactions,
          1,
          'and the deferral is still held for a live batch from that probe',
        );
      });

      it('does not let one probe-s live batch reconcile another probe-s drain', async () => {
        // **`P-169`.** `#deferredReactions` was one process-wide set and `stale` was judged per
        // *write*, not per source — and one write coalesces submissions from every connected
        // probe. So the local probe, which is live by definition, emptied a draining remote's
        // deferred set and reacted over its hours-old runtime rows: the storm `P-146` exists to
        // prevent, restored for every installation with more than one probe.
        const reacted: number[][] = [];
        const stub = reactionStub(reacted, false);
        const long = Date.now() - 6 * 60 * 60_000;
        const { service, ingestor } = withStubbedAlarms(stub);

        // The remote probe replays an outage.
        await service.acceptResults('probe-remote', {
          type: 'results',
          batchId: 'multi-drain',
          results: [failure(new Date(long)), failure(new Date(long + 30_000))],
          sentAt: new Date().toISOString(),
        });
        assert.deepEqual(reacted, [], 'the replay is held');
        assert.equal(ingestor.stats().deferredReactions, 1);

        // The local probe delivers an ordinary live batch for a *different* sensor.
        await service.acceptResults('probe-local', {
          type: 'results',
          batchId: 'multi-live',
          results: [
            { ...failure(new Date()), sensorId: otherSensorId },
            { ...failure(new Date()), sensorId: otherSensorId },
          ],
          sentAt: new Date().toISOString(),
        });
        await ingestor.stop();

        assert.deepEqual(
          reacted.flat().filter((id) => id === sensorId),
          [],
          'the draining probe-s sensor was reconciled by a batch from a different probe',
        );
        assert.equal(
          ingestor.stats().deferredReactions,
          1,
          'and it is still held, waiting for a live batch from its own probe',
        );
      });
    });

    describe('a pause that commits while a batch is in flight', () => {
      it('is not clobbered back to Down by the batch that was already decided', async () => {
        // **`P-147`.** `acceptResults` calls `decide` before `submit`, and `decide` evaluates
        // layer 1 — a pause dominates everything — from an in-memory cache. The write that lands
        // up to `batchMaxDelayMs` later had no pause guard of its own: it set `state = 'down'` on
        // a row whose pause flags were true, and the alarm reaction in the same transaction read
        // that row back and armed a chain for the sensor an operator had just paused. Exactly the
        // alarm the pause was pressed to stop, produced by the press itself; nothing self-healed
        // until that sensor's next scan re-decided it.
        //
        // Reproduced by writing the flag between the two halves, which is what the race does.
        // One service throughout, so its cache is warm — which is the whole mechanism: `decide`
        // reads layer 1 from that cache, and the pause lands after it has been read.
        const racing = build();
        await racing.service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'b-warm',
          results: [result({ at: at(0) })],
        });

        // The operator's pause commits, setting the flags without going through `reevaluate` —
        // which is what the race amounts to: the flags are true and the cache does not know.
        await db.query(`UPDATE sensor_runtime SET paused_manually = true WHERE object_id = $1`, [
          sensorId,
        ]);

        await racing.service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'b-race',
          results: [failedResult(1), failedResult(2)],
        });
        await racing.ingestor.stop();

        const row = await runtime();
        assert.notEqual(
          row.state,
          'down',
          'the pause on the row outranks a batch decided before it existed',
        );
        assert.equal(
          row.consecutive_failures,
          2,
          'and the check still happened, so what it measured is still recorded',
        );
      });

      it('is not clobbered by a batch decided while the sensor was acknowledged either', async () => {
        // **`R05` — the guard `P-147` added was written on the cause, and the cause is shared.**
        // It exempted `user`, `parent`, `schedule` and `dependency`, reasoning that "a write
        // whose own cause *is* a pause is the pause being applied". But `user` is also the cause
        // of both halves of an acknowledgement: `acknowledged()` returns down_acknowledged/user,
        // and an acknowledgement lapsing on a still-failing sensor returns down/user. So on any
        // sensor carrying an acknowledgement — which is to say, during exactly the outage an
        // operator is most likely to pause for maintenance — the race was unguarded, and the
        // paused row was overwritten with the result's own state.
        //
        // The discriminator is the write's *state*, not its cause.
        const warm = build();
        await warm.service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'ack-a',
          results: [failedResult(1), failedResult(2)],
        });
        await warm.ingestor.stop();
        assert.equal((await runtime()).state, 'down');

        // Acknowledged for ten minutes, so the racing result — eleven minutes in — is the one
        // that *lapses* it, which `machine.ts` answers with `{ state: 'down', cause: 'user' }`.
        // That pairing is the whole point: a cause of `user` on a write that is not a pause.
        const resolved = resolveAcknowledgement({ kind: 'duration', minutes: 10 }, 'ticket 41', AT);
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
        assert.equal((await runtime()).state, 'down_acknowledged');

        // One service throughout, warmed first: `decide` reads layer 1 from that cache, and the
        // pause has to land *after* it has been read or there is no race to reproduce.
        const racing = build();
        await racing.service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'ack-b',
          results: [failedResult(3)],
        });
        await db.query(`UPDATE sensor_runtime SET paused_manually = true WHERE object_id = $1`, [
          sensorId,
        ]);
        await racing.service.acceptResults('probe-state', {
          type: 'results',
          batchId: 'ack-c',
          // Past the acknowledgement's ten minutes, so it lapses: down, cause `user`.
          results: [failedResult(11)],
        });
        await racing.ingestor.stop();

        const row = await runtime();
        assert.notEqual(
          row.state,
          'down',
          'the pause on the row outranks an acknowledged result decided before it existed',
        );
        assert.equal(row.state, 'down_acknowledged', 'the row keeps what the pause left on it');
      });
    });

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

      it('writes none of its readings either, so no half of it is believed', async () => {
        // **`P-144`.** The bound rejected the *result* — the state machine never saw it — after
        // the readings had already been turned into samples. A probe with a clock years out wrote
        // graph points stamped 2030 that nothing would overwrite and no query would reach, while
        // the sensor's own state never moved. Half of one result believed and half not is the one
        // outcome a bound like this must not produce.
        const before = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sample s
           JOIN channel c ON c.id = s.channel_id WHERE c.sensor_id = $1`,
          [sensorId],
        );

        const wrong = build();
        await deliver(
          wrong.service,
          wrong.ingestor,
          [result({ at: new Date('2031-01-01T00:00:00Z').toISOString() })],
          'b-future-readings',
        );

        const after = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sample s
           JOIN channel c ON c.id = s.channel_id WHERE c.sensor_id = $1`,
          [sensorId],
        );
        assert.equal(after[0]?.n, before[0]?.n, 'no sample was written for a result nobody read');
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

    describe('a result stamped before anything is kept (`P-231`)', () => {
      /** Every retention a test does not name, at its default. */
      function retention(
        days: Partial<HousekeepingConfig['retention']>,
      ): HousekeepingConfig['retention'] {
        return {
          rawDays: 40,
          fiveMinuteDays: 365,
          hourlyDays: 730,
          dailyDays: 3_650,
          auditDays: 730,
          stateDays: 3_650,
          reportDays: 90,
          reportRunDays: 730,
          ...days,
        };
      }

      async function samples(): Promise<string | undefined> {
        const rows = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sample s
           JOIN channel c ON c.id = s.channel_id WHERE c.sensor_id = $1`,
          [sensorId],
        );
        return rows[0]?.n;
      }

      it('is refused whole, and counted against the probe it came from', async () => {
        // A device with no RTC boots at 1970. Stored, its readings would create chunks and a
        // backfill for rows the next housekeeping pass drops from everywhere it wrote them, and
        // nothing would have said which probe sent them.
        const before = await samples();
        const was = await runtime();

        const wrong = build();
        await deliver(
          wrong.service,
          wrong.ingestor,
          [result({ at: '1970-01-01T00:02:00.000Z' })],
          'b-1970',
        );

        assert.equal(wrong.service.stats().discardedPastTime, 1, 'refused, and counted');
        assert.deepEqual(wrong.service.timeRefusals('probe-state'), { past: 1, future: 0 });
        assert.deepEqual(
          wrong.service.timeRefusals('another-probe'),
          { past: 0, future: 0 },
          'against the probe that sent it, and no other',
        );
        // Had the state machine seen it, it would have counted it stale: the sensor has results
        // newer than 1970. Not stale is not seen.
        assert.equal(wrong.states.stats().resultsStale, 0, 'the state machine never saw it');
        assert.equal(await samples(), before, 'and none of its readings was written');
        assert.deepEqual(await runtime(), was);
      });

      it('keeps anything the longest retention keeps, states included', async () => {
        // The spool is bounded by bytes, not age, so a probe cut off for a month replays a month.
        // Past the raw retention its readings still fill the rollup tiers where they hold nothing
        // (`P-226`), and a result is a state as well, which counts towards uptime for as long as
        // `stateDays`. So the bound is the longest of all of them, and no tier's alone.
        const short = { rawDays: 7, fiveMinuteDays: 30, hourlyDays: 30, dailyDays: 30 };
        assert.equal(maxResultAgeMs(retention({})), 3_650 * 86_400_000);
        assert.equal(
          maxResultAgeMs(retention({ ...short, stateDays: 400 })),
          400 * 86_400_000,
          'a state kept longer than any reading keeps the result',
        );
        assert.equal(
          maxResultAgeMs(retention({ ...short, hourlyDays: 90, stateDays: 60 })),
          90 * 86_400_000,
          'and a reading kept longer than any state',
        );
        assert.equal(
          maxResultAgeMs(
            retention({ ...short, stateDays: 7, auditDays: 9_000, reportRunDays: 9_000 }),
          ),
          30 * 86_400_000,
          'nothing a result does not carry counts',
        );

        const now = new Date(AT.getTime() + 60 * 60_000);
        const { states, channels, ingestor } = build();
        const service = new IngestionService({
          db,
          logger: silent,
          ingestor,
          states,
          resolver: channels,
          maxResultAgeMs: maxResultAgeMs(retention({ ...short, stateDays: 400 })),
          now: () => now,
        });
        const daysBack = (days: number): string =>
          new Date(now.getTime() - days * 86_400_000).toISOString();
        await deliver(
          service,
          ingestor,
          [result({ at: daysBack(399) }), result({ at: daysBack(401) })],
          'b-states',
        );
        assert.equal(service.stats().discardedPastTime, 1, 'only the one no retention keeps');
      });

      it('says so once a batch each way, not once a result', async () => {
        // A probe whose clock is wrong is wrong for every result it sends, and `P-99` logged a line
        // for each: thousands a minute, all saying one thing.
        const lines: Record<string, unknown>[] = [];
        const logger = pino(
          { level: 'warn' },
          { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
        ) as unknown as Logger;
        const { states, channels, ingestor } = build();
        const service = new IngestionService({
          db,
          logger,
          ingestor,
          states,
          resolver: channels,
        });
        await deliver(
          service,
          ingestor,
          [
            result({ at: '2031-01-01T00:00:00.000Z' }),
            result({ at: '2031-01-01T00:01:00.000Z' }),
            result({ at: '2031-01-01T00:02:00.000Z' }),
            result({ at: '1970-01-01T00:00:00.000Z' }),
            result({ at: '1970-01-01T00:05:00.000Z' }),
            result({ at: at(30) }),
          ],
          'b-mixed',
        );

        const refusals = lines.filter((line) => typeof line['refused'] === 'number');
        assert.equal(refusals.length, 2, 'one line for each bound');
        const ahead = refusals.find((line) => 'aheadMs' in line);
        const behind = refusals.find((line) => 'behindMs' in line);
        assert.ok(ahead && behind, 'one each way');
        assert.equal(ahead['refused'], 3);
        assert.equal(ahead['source'], 'probe-state');
        assert.equal(ahead['earliest'], '2031-01-01T00:00:00.000Z');
        assert.equal(ahead['latest'], '2031-01-01T00:02:00.000Z');
        assert.equal(behind['refused'], 2);
        assert.equal(behind['latest'], '1970-01-01T00:05:00.000Z');
        assert.deepEqual(service.timeRefusals('probe-state'), { past: 2, future: 3 });
      });

      it('counts against the probe for five minutes, and in the total for good', async () => {
        // Probe Health warns on the probe's count, so it has to fall back to nothing once the
        // clock is right. The fleet's total on Core Health is a counter, and keeps it.
        let monotonic = 0;
        const { states, channels, ingestor } = build();
        const service = new IngestionService({
          db,
          logger: silent,
          ingestor,
          states,
          resolver: channels,
          monotonicMs: () => monotonic,
        });
        await deliver(service, ingestor, [result({ at: '1970-01-01T00:00:00.000Z' })], 'b-window');
        assert.deepEqual(service.timeRefusals('probe-state'), { past: 1, future: 0 });

        monotonic = TIME_REFUSAL_WINDOW_MS - 5_000;
        assert.deepEqual(service.timeRefusals('probe-state'), { past: 1, future: 0 });
        monotonic = TIME_REFUSAL_WINDOW_MS;
        assert.deepEqual(service.timeRefusals('probe-state'), { past: 0, future: 0 });
        assert.equal(service.stats().discardedPastTime, 1);
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
