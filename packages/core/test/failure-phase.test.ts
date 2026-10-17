import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckFailure } from '@ms/shared';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { Reach, Visibility } from '../src/auth/access.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MOVED_OFF_MESSAGE } from '../src/probes/not-started.js';
import { PROBE_SOURCE } from '../src/probes/reachability.js';
import {
  readSensorState,
  sameFailure,
  writeRuntimes,
  writeStateHistory,
  type HeldWords,
} from '../src/state/runtime.js';
import { RELEASED_FROM_WITHHOLDING, type SensorResult } from '../src/state/service.js';
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

/** What a probe that could not start a check says, and where it stopped (`P-265`). */
const GAVE_UP = 'the probe took 10012 ms to start the check and gave up';
const STARTUP: CheckFailure = { phase: 'startup' };
/** What a probe that refused a check says, and where (`A-41c`). */
const REFUSED = 'Not scanned: app.dc.test did not resolve before the check’s timeout.';
const RESOLVE: CheckFailure = { phase: 'resolve', target: 'app.dc.test' };
const CHECK: CheckFailure = { phase: 'check', target: 'app.dc.test' };

/** The holds the state service reads live, set by each test (`P-407`). */
const unstarted = new Set<number>();
const withheld = new Map<number, HeldWords>();

describe('whether two places a check stopped are the same (P-407)', () => {
  it('is the same phase and the same host, or both none', () => {
    assert.equal(sameFailure(null, null), true);
    assert.equal(sameFailure(RESOLVE, { phase: 'resolve', target: 'app.dc.test' }), true);
    assert.equal(sameFailure(STARTUP, { phase: 'startup' }), true);
    assert.equal(sameFailure(RESOLVE, null), false);
    assert.equal(sameFailure(null, STARTUP), false);
    assert.equal(sameFailure(RESOLVE, CHECK), false, 'another phase');
    assert.equal(
      sameFailure(RESOLVE, { phase: 'resolve', target: 'db.dc.test' }),
      false,
      'another host',
    );
    assert.equal(sameFailure(RESOLVE, { phase: 'resolve' }), false, 'a host and none');
  });
});

/**
 * Where a failed check failed, kept beside its message by the message's rule (`P-285`,
 * `state-machine.md` §2.2): the scan's own when its words explain the state and it failed,
 * nothing beside a limit's or a lookup's words, what is stored when a person decided the state,
 * the held result's own while a probe's refusal or a check it could not start is why the sensor
 * is held (`P-407`), and nothing once a pause, an acknowledgement, a release or the core's own
 * sentence writes words of its own. **Never a cause**: a phase that moves while the state and the
 * cause stand records no transition (§4.2, invariant 10), so it cannot add an alarm.
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
      h = await buildHarness(db, {
        states: true,
        notStartedSensors: () => unstarted,
        withheldSensors: () => withheld,
      });
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
      unstarted.clear();
      withheld.clear();
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

    /** What a hold or its release does, the way `NotStarted` and `SensorVouching` call it. */
    async function rehold(
      minutes: number,
      cause: Parameters<NonNullable<Harness['states']>['reevaluate']>[3],
    ): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      await db.tx((q) => states.reevaluate(q, [sensorId], at(minutes), cause));
    }

    async function said(): Promise<{
      state: string;
      message: string;
      failure: CheckFailure | null;
    }> {
      const runtime = await readSensorState(db, sensorId);
      assert.ok(runtime !== null);
      return { state: runtime.state, message: runtime.message, failure: runtime.failure };
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

    it('keeps where a check its probe could not start stopped, beside the hold’s words (P-407)', async () => {
      await report([ok(0)]);
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      // Held as `NotStarted.hold` holds it: the sensor in the overlay, its words and its place.
      unstarted.add(sensorId);
      await rehold(3, { message: GAVE_UP, sources: PROBE_SOURCE, failure: STARTUP });
      assert.deepEqual(await said(), { state: 'unknown', message: GAVE_UP, failure: STARTUP });
      assert.deepEqual((await transitions()).at(-1), ['unknown', 'probe', 'startup', null]);

      // A result decided while it is held keeps the hold's words, and their place with them.
      await report([failed(4, EXEC)]);
      assert.deepEqual(await said(), { state: 'unknown', message: GAVE_UP, failure: STARTUP });

      // Let go, the next result decides it, and a success names nowhere it failed. The cache is
      // forgotten here by hand because `NotStarted.release` does not yet do it (`P-409`): the
      // result decided while held is cached with the probe unreachable.
      unstarted.delete(sensorId);
      h.states?.forgetSensors([sensorId]);
      await report([ok(5)]);
      assert.deepEqual(await current(), { state: 'up', failure: null });
      assert.deepEqual((await transitions()).at(-1), ['up', 'scan', null, null]);
    });

    it('lets the place go with the hold’s words when the probe lets a sensor go', async () => {
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      unstarted.add(sensorId);
      await rehold(3, { message: GAVE_UP, sources: PROBE_SOURCE, failure: STARTUP });
      unstarted.delete(sensorId);
      // Moved off the probe that held it: the words are the release's, and say nowhere.
      await rehold(4, { message: MOVED_OFF_MESSAGE, sources: PROBE_SOURCE });
      assert.deepEqual(await said(), {
        state: 'down',
        message: MOVED_OFF_MESSAGE,
        failure: null,
      });
      assert.deepEqual((await transitions()).at(-1), ['down', 'scan', null, null]);
    });

    it('keeps where a probe refused a check beside its refusal, follows a renewal, and goes with the words', async () => {
      await report([failed(1, CONNECT)]);
      await report([failed(2, CONNECT)]);
      // Held as `SensorVouching` holds it: the probe's words and its place, from one owner.
      withheld.set(sensorId, { message: REFUSED, failure: RESOLVE });
      await rehold(3, { message: '', sources: ['access'] });
      assert.deepEqual(await said(), { state: 'unknown', message: REFUSED, failure: RESOLVE });
      assert.deepEqual((await transitions()).at(-1), [
        'unknown',
        'access',
        'resolve',
        'app.dc.test',
      ]);
      const held = await transitions();

      // The same words with a new place: written, and no transition, since nothing decided moved.
      withheld.set(sensorId, { message: REFUSED, failure: CHECK });
      await rehold(4, { message: '', sources: ['access'] });
      assert.deepEqual(await said(), { state: 'unknown', message: REFUSED, failure: CHECK });
      // A result decided while it is held keeps the refusal's words, and their place.
      await report([failed(5, EXEC)]);
      assert.deepEqual(await said(), { state: 'unknown', message: REFUSED, failure: CHECK });

      // The core's own sentence in its place: nothing beside it, since no probe named anything.
      withheld.set(sensorId, { message: 'withheld by the core', failure: null });
      await rehold(6, { message: '', sources: ['access'] });
      assert.deepEqual(await said(), {
        state: 'unknown',
        message: 'withheld by the core',
        failure: null,
      });
      assert.deepEqual(await transitions(), held, 'one hold, one Unknown, whatever it said');

      // Let go: the release's words, and nothing of where a refused check stopped.
      withheld.delete(sensorId);
      await rehold(7, { message: '', sources: ['access'] });
      assert.deepEqual(await said(), {
        state: 'down',
        message: RELEASED_FROM_WITHHOLDING,
        failure: null,
      });
      assert.deepEqual((await transitions()).at(-1), ['down', 'scan', null, null]);
    });

    it('says nothing of a refused check beside a pause’s words over the refusal', async () => {
      await report([failed(1, CONNECT)]);
      withheld.set(sensorId, { message: REFUSED, failure: RESOLVE });
      await rehold(2, { message: '', sources: ['access'] });
      assert.deepEqual(await current(), { state: 'unknown', failure: RESOLVE });
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      assert.deepEqual(await said(), { state: 'paused', message: 'maintenance', failure: null });
      assert.deepEqual((await transitions()).at(-1), ['paused', 'user', null, null]);
    });
  },
);
