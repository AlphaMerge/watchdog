import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckFailure } from '@ms/shared';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { Reach, Visibility } from '../src/auth/access.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { readSensorState, writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** Before now, so a pause or an acknowledgement, stamped now, sorts after every result. */
const T0 = new Date(Date.now() - 60 * 60_000);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const CONNECT: CheckFailure = { phase: 'connect', target: '192.0.2.40:22' };
const AUTH: CheckFailure = { phase: 'authenticate', target: '192.0.2.40:22' };
const EXEC: CheckFailure = { phase: 'exec', target: '192.0.2.40:22' };

/**
 * Where a failed check failed, kept beside its message by the message's rule (`P-285`,
 * `state-machine.md` §2.2): the scan's own when its words explain the state and it failed,
 * nothing beside a limit's or a lookup's words, what is stored when a person decided the state,
 * and nothing once a pause, an acknowledgement or a hold writes words of its own. **Never a
 * cause**: a phase that moves while the state and the cause stand records no transition (§4.2,
 * invariant 10), so it cannot add an alarm.
 */
describe(
  'where a check failed, beside its message (`P-285`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('failure_phase_state');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
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
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'app-server',
        host: '192.0.2.40',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Load',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    /** Results into states the way ingestion writes them (`M-11`). */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    const failed = (minutes: number, failure?: CheckFailure): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'error',
      message: `failed at minute ${String(minutes)}`,
      ...(failure === undefined ? {} : { failure }),
    });
    const ok = (minutes: number): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'ok',
      message: 'load 0.5',
    });

    /** Every transition this sensor has, oldest first: state, cause and where it failed. */
    async function transitions(): Promise<[string, string, string | null, string | null][]> {
      const rows = await db.query<{
        state: string;
        cause: string;
        failure_phase: string | null;
        failure_target: string | null;
      }>(
        `SELECT state, cause, failure_phase, failure_target FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time`,
        [sensorId],
      );
      return rows.map((row) => [row.state, row.cause, row.failure_phase, row.failure_target]);
    }

    async function current(): Promise<{ state: string; failure: CheckFailure | null }> {
      const runtime = await readSensorState(db, sensorId);
      assert.ok(runtime !== null);
      return { state: runtime.state, failure: runtime.failure };
    }

    it('keeps it with the scan’s words, on the state and each transition, and both APIs say it', async () => {
      await report([ok(0)]);
      await report([failed(1, CONNECT)]);
      await report([failed(2, AUTH)]);
      assert.deepEqual(await transitions(), [
        ['up', 'scan', null, null],
        ['warning', 'scan', 'connect', '192.0.2.40:22'],
        ['down', 'scan', 'authenticate', '192.0.2.40:22'],
      ]);
      assert.deepEqual(await current(), { state: 'down', failure: AUTH });

      const state = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/state`,
      });
      assert.equal(state.statusCode, 200, state.body);
      assert.deepEqual(state.json<{ failure: unknown }>().failure, AUTH);
      const log = await app.inject({
        method: 'GET',
        url: `/api/v1/state-log?objectId=${String(sensorId)}&limit=10`,
      });
      assert.equal(log.statusCode, 200, log.body);
      assert.deepEqual(
        log
          .json<{ items: { state: string; failure: unknown }[] }>()
          .items.map((one) => [one.state, one.failure]),
        [
          ['down', AUTH],
          ['warning', CONNECT],
          ['up', null],
        ],
      );

      // Recovered: a success has nowhere it failed.
      await report([ok(3)]);
      assert.deepEqual(await current(), { state: 'up', failure: null });
      assert.deepEqual((await transitions()).at(-1), ['up', 'scan', null, null]);
    });

    it('records no transition when only the phase moves, and follows the last check', async () => {
      await report([ok(0)]);
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      const before = await transitions();
      assert.equal(before.length, 3);
      // Down on the scan throughout: the phase moves, then the probe names none.
      await report([failed(3, EXEC)]);
      assert.deepEqual(await current(), { state: 'down', failure: EXEC });
      await report([failed(4, { phase: 'timeout' })]);
      assert.deepEqual(await current(), { state: 'down', failure: { phase: 'timeout' } });
      await report([failed(5)]);
      assert.deepEqual(await current(), { state: 'down', failure: null });
      assert.deepEqual(await transitions(), before, 'one outage, one Down, whatever it failed in');
    });

    it('says nothing beside a limit’s words, which explain the state instead', async () => {
      await report([failed(1, CONNECT)]);
      await report([
        {
          sensorId,
          at: at(2),
          outcome: 'ok',
          message: '2/2 replies, min 812 ms',
          channels: {
            verdict: { state: 'down', cause: 'limit' },
            message: 'Response time is 812 ms, above the error limit of 500 ms',
            breaches: [],
          },
        },
      ]);
      assert.deepEqual(await current(), { state: 'down', failure: null });
      assert.deepEqual((await transitions()).at(-1), ['down', 'limit', null, null]);
    });

    it('goes with the words an acknowledgement writes, and stays gone while a person decides', async () => {
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      assert.deepEqual(await current(), { state: 'down', failure: CONNECT });
      await h.service.acknowledge(
        testActor,
        sensorId,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'ticket 4471',
      );
      // The operator's words explain it now, and the check's place went with the check's words.
      assert.deepEqual(await current(), { state: 'down_acknowledged', failure: null });
      assert.deepEqual((await transitions()).at(-1), ['down_acknowledged', 'user', null, null]);
      // A person decided the state, so what is stored stays, words and all (`P-285`).
      await report([failed(3, EXEC)]);
      const runtime = await readSensorState(db, sensorId);
      assert.equal(runtime?.message, 'ticket 4471');
      assert.equal(runtime.failure, null);
    });

    it('is held with the words by a pause that committed while the result was in flight (P-147)', async () => {
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      const states = h.states;
      assert.ok(states !== undefined);
      // Decided against the cache before the pause, written after it.
      const decisions = await states.decide([failed(3, EXEC)]);
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      assert.deepEqual(await current(), { state: 'paused', failure: null });
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
      const runtime = await readSensorState(db, sensorId);
      assert.equal(runtime?.state, 'paused');
      assert.equal(runtime.message, 'maintenance');
      assert.equal(
        runtime.failure,
        null,
        'the pause’s words, and nothing of the check’s beside them',
      );
    });
  },
);
