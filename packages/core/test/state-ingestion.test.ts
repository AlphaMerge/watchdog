import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import { testCatalogue } from './support/sensor-types.js';
import { Ingestor, type IngestTarget } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { SensorStateService } from '../src/state/service.js';
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
    let deviceId: number;
    let sensorId: number;
    let app: FastifyInstance;

    before(async () => {
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

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
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
    } {
      const states = new SensorStateService({ db, logger: silent });
      const ingestor = new Ingestor({ db: target ?? db, logger: silent, config: CONFIG });
      return {
        states,
        ingestor,
        service: new IngestionService({ db, logger: silent, ingestor, states }),
      };
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
      consecutive_failures: number;
      last_result_at: Date | null;
      since: Date;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        consecutive_failures: number;
        last_result_at: Date | null;
        since: Date;
      }>(
        `SELECT state, cause, consecutive_failures, last_result_at, since
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
