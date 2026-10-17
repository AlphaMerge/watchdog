import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckFailure, IngestionConfig } from '@ms/shared';
import type { Database, Queryable } from '../src/db/pool.js';
import { Ingestor, type IngestTarget } from '../src/ingestion/ingestor.js';
import { PROBE_SOURCE } from '../src/probes/reachability.js';
import {
  readSensorState,
  writeRuntimes,
  writeStateHistory,
  type HeldWords,
  type StateDecisions,
  type StateTransition,
} from '../src/state/runtime.js';
import type { SensorResult, SensorStateService } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/** Before now, so a hold, stamped now, sorts after every result. */
const T0 = new Date(Date.now() - 60 * 60_000);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
/** After now, for a probe whose clock runs ahead of the core's. */
const ahead = (seconds: number): Date => new Date(Date.now() + seconds * 1_000);

const LOST = 'the probe carrying this sensor stopped answering';
const ROUND = 'the probe took 10012 ms to start the check and gave up';

/** The holds the state service reads live, set by each test. */
const lost = new Set<number>();
const unstarted = new Map<number, HeldWords>();

/** Whether a statement is the write's own read of its rows (`lockRuntimeStates`). */
const readsItsRows = (sql: string): boolean =>
  sql.includes('AS sensor_id, state, cause FROM sensor_runtime');

/**
 * A result decided before a probe's hold and stored after the hold reached its row (`P-415`). A
 * batch is written up to `batchMaxDelayMs` after it was decided; a probe lost in between held its
 * sensors Unknown first, and the batch then wrote its Up or Down over that, and announced it,
 * with nothing to re-decide the sensor while the probe was away. Now the write leaves the state
 * to the hold, and keeps everything else the result says.
 */
describe(
  'a result a probe’s hold reached first (P-415)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let states: SensorStateService;
    let deviceId: number;
    let sensorId: number;
    /** What the ingestor announced, in order. */
    let frames: StateTransition[];

    before(async () => {
      scratch = await createScratchDatabase('overtaken_results');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        unreachableSensors: () => lost,
        notStartedSensors: () => unstarted,
      });
      assert.ok(h.states !== undefined);
      states = h.states;
    });

    after(async () => {
      await scratch.drop();
    });

    const sensor = async (name = 'Ping'): Promise<number> =>
      (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name,
          sensorType: 'icmp.ping',
        })
      ).id;

    beforeEach(async () => {
      lost.clear();
      unstarted.clear();
      frames = [];
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: 'app-server',
          host: '192.0.2.43',
        })
      ).id;
      sensorId = await sensor();
    });

    const ok = (minutes: number | Date, id = sensorId): SensorResult => ({
      sensorId: id,
      at: minutes instanceof Date ? minutes : at(minutes),
      outcome: 'ok',
      message: '4/4 replies',
    });
    const failed = (
      minutes: number | Date,
      id = sensorId,
      failure?: CheckFailure,
    ): SensorResult => ({
      sensorId: id,
      at: minutes instanceof Date ? minutes : at(minutes),
      outcome: 'error',
      message: 'no reply',
      ...(failure === undefined ? {} : { failure }),
    });

    /** Results stored at once, the way ingestion writes them. */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** A batch decided earlier, stored now through the ingestor, as `main.ts` wires it. */
    async function store(decisions: StateDecisions, target: IngestTarget = db): Promise<void> {
      const ingestor = new Ingestor({
        db: target,
        logger: silent,
        config: CONFIG,
        holds: states,
        onStatesCommitted: (committed) => {
          frames.push(...committed);
        },
        ...(h.dependencies === undefined ? {} : { dependencies: h.dependencies }),
      });
      try {
        const outcome = await ingestor.submit({
          source: 'probe-x',
          samples: [],
          states: decisions,
        });
        assert.equal(outcome.accepted, true);
      } finally {
        await ingestor.stop();
      }
    }

    /** A probe hold's own re-decision of these sensors, as `ProbeReachability.lost` runs it. */
    async function hold(message: string, ids: readonly number[] = [sensorId]): Promise<void> {
      await db.tx(async (q) => {
        await states.reevaluate(q, ids, new Date(), { message, sources: PROBE_SOURCE });
        await h.dependencies?.recompute(q, new Date());
      });
    }

    async function row(id = sensorId): Promise<{
      state: string;
      cause: string;
      message: string;
      failures: number;
      lastResultAt: number | undefined;
      since: number;
      failure: CheckFailure | null;
    }> {
      const runtime = await readSensorState(db, id);
      assert.ok(runtime !== null);
      return {
        state: runtime.state,
        cause: runtime.cause,
        message: runtime.message,
        failures: runtime.facts.scan.kind === 'failed' ? runtime.facts.scan.consecutiveFailures : 0,
        lastResultAt: runtime.facts.lastResultAt?.getTime(),
        since: runtime.since.getTime(),
        failure: runtime.failure,
      };
    }

    /** When the sensor's newest history row was stamped. */
    async function newestAt(id = sensorId): Promise<number> {
      const rows = await db.query<{ time: Date }>(
        'SELECT time FROM sensor_state WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1',
        [id],
      );
      const newest = rows[0];
      assert.ok(newest !== undefined);
      return newest.time.getTime();
    }

    /** What the dependency engine holds on a master, and whether a dependent is held by it. */
    async function dependency(id: number): Promise<{ clearAt: number | null; held: boolean }> {
      const rows = await db.query<{
        dependency_clear_at: Date | null;
        paused_by_dependency: boolean;
      }>(
        'SELECT dependency_clear_at, paused_by_dependency FROM sensor_runtime WHERE object_id = $1',
        [id],
      );
      const one = rows[0];
      assert.ok(one !== undefined);
      return {
        clearAt: one.dependency_clear_at?.getTime() ?? null,
        held: one.paused_by_dependency,
      };
    }

    /** The sensor's transitions, oldest first: state, the state before it, and cause. */
    async function history(id = sensorId): Promise<[string, string | null, string][]> {
      const rows = await db.query<{ state: string; previous_state: string | null; cause: string }>(
        `SELECT state, previous_state, cause FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
        [id],
      );
      return rows.map((one) => [one.state, one.previous_state, one.cause]);
    }

    const framesFor = (id = sensorId): string[] =>
      frames.filter((frame) => frame.sensorId === id).map((frame) => frame.state);

    it('leaves a lost probe’s Unknown over the last batch it overtook, and keeps what the batch says', async () => {
      await report([ok(0)]);
      // Decided as it arrived, before the link dropped.
      const where: CheckFailure = { phase: 'connect', target: '192.0.2.43' };
      const decided = await states.decide([failed(1, sensorId, where), failed(2, sensorId, where)]);
      assert.deepEqual([decided.runtimes[0]?.state, decided.runtimes[0]?.failure], ['down', where]);
      lost.add(sensorId);
      await hold(LOST);
      assert.equal((await row()).state, 'unknown');
      const heldSince = await newestAt();

      await store(decided);
      assert.deepEqual(await row(), {
        state: 'unknown',
        cause: 'probe',
        message: LOST,
        failures: 2,
        lastResultAt: at(2).getTime(),
        // The hold's, not the Down's: its words, its place (none) and when it began.
        since: heldSince,
        failure: null,
      });
      // Measured before the hold, so the history keeps them, and ends where the row stands.
      assert.deepEqual(await history(), [
        ['up', 'unknown', 'scan'],
        ['warning', 'up', 'scan'],
        ['down', 'warning', 'scan'],
        ['unknown', 'up', 'probe'],
      ]);
      assert.deepEqual(framesFor(), [], 'nothing announced over the hold’s Unknown');

      // Found again: decided from what the batch stored, with the transition the history needs.
      lost.delete(sensorId);
      await hold('');
      assert.equal((await row()).state, 'down');
      assert.deepEqual((await history()).at(-1), ['down', 'unknown', 'scan']);
    });

    it('writes a batch as decided when the hold has not reached the row, and the hold then decides from it', async () => {
      await report([ok(0)]);
      const decided = await states.decide([failed(1), failed(2)]);
      // Laid, as `lost` lays it before its transaction; its re-decision has not run.
      lost.add(sensorId);
      await store(decided);
      assert.equal((await row()).state, 'down');
      assert.deepEqual(framesFor(), ['warning', 'down']);

      await hold(LOST);
      assert.deepEqual(
        [(await row()).state, (await row()).cause, (await row()).message],
        ['unknown', 'probe', LOST],
      );
      assert.deepEqual((await history()).at(-1), ['unknown', 'down', 'probe']);
    });

    it('holds the rows it asks about, so a hold that re-decides meanwhile waits for it and decides from it', async () => {
      // No transition, so nothing but the write's own lock holds this row before its UPDATE.
      await report([ok(0)]);
      const decided = await states.decide([ok(1)]);
      assert.equal(decided.transitions.length, 0);

      let locked = (): void => undefined;
      const atLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      // Laid, as `lost` lays it before its transaction; its re-decision has not run, and the
      // write asks about the row and locks it.
      lost.add(sensorId);
      const held: IngestTarget = {
        tx: (fn) =>
          db.tx((q) =>
            fn(
              new Proxy(q, {
                get(target, property) {
                  if (property === 'query') {
                    return async (sql: string, values?: readonly unknown[]): Promise<unknown> => {
                      const rows = await target.query(sql, values);
                      if (readsItsRows(sql)) {
                        locked();
                        await gate;
                      }
                      return rows;
                    };
                  }
                  const value: unknown = Reflect.get(target, property, target);
                  return typeof value === 'function'
                    ? (value as (this: Queryable, ...args: unknown[]) => unknown).bind(target)
                    : value;
                },
              }),
            ),
          ),
      };
      let holding: Promise<void> = Promise.resolve();
      try {
        const storing = store(decided, held);
        await within(5_000, 'the write holding its rows', atLock);
        holding = hold(LOST);
        // Either it waits on the write's lock, or, without one, it has already committed.
        await within(
          5_000,
          'the hold’s re-decision blocked, or done',
          Promise.race([somebodyWaits(db, 'the hold waiting on the write’s rows'), holding]),
        );
        open();
        await within(5_000, 'the write committing', storing);
        await within(5_000, 'the hold committing', holding);
      } finally {
        open();
      }
      assert.deepEqual(
        [(await row()).state, (await row()).cause, (await row()).lastResultAt],
        ['unknown', 'probe', at(1).getTime()],
      );
      assert.deepEqual((await history()).at(-1), ['unknown', 'up', 'probe']);
    });

    it('leaves a row a hold decided unchanged, which nothing else moved, and drops what is cached', async () => {
      // A check its probe could not start holds the sensor (`P-265`).
      await report([ok(0)]);
      unstarted.set(sensorId, { message: ROUND, failure: null });
      await hold(ROUND);
      assert.deepEqual([(await row()).state, (await row()).message], ['unknown', ROUND]);
      // Its started result lets it go, without a re-decision (`NotStarted.release`), and is
      // decided Up; then its probe is lost, whose re-decision finds the row as it holds it.
      unstarted.delete(sensorId);
      states.forgetSensors([sensorId]);
      const measured = ahead(5);
      const decided = await states.decide([ok(measured)]);
      assert.equal(decided.runtimes[0]?.state, 'up');
      lost.add(sensorId);
      await hold(LOST);
      assert.equal(
        states.peek(sensorId)?.state,
        'up',
        'nothing but the write drops the batch’s state',
      );

      await store(decided);
      const now = await row();
      assert.deepEqual(
        [now.state, now.cause, now.message, now.lastResultAt],
        ['unknown', 'probe', ROUND, measured.getTime()],
      );
      assert.equal(states.peek(sensorId), undefined, 'and the batch’s state is not left cached');
      // The batch's Unknown-to-Up came after the newest row, which is the hold's.
      assert.deepEqual((await history()).at(-1), ['unknown', 'up', 'probe']);
      assert.deepEqual(framesFor(), []);
    });

    it('leaves out the transitions a probe whose clock runs ahead stamped after the hold’s', async () => {
      await report([ok(0)]);
      const decided = await states.decide([failed(ahead(2)), failed(ahead(4))]);
      assert.equal(decided.transitions.length, 2);
      lost.add(sensorId);
      await hold(LOST);

      await store(decided);
      assert.deepEqual(await history(), [
        ['up', 'unknown', 'scan'],
        ['unknown', 'up', 'probe'],
      ]);
      assert.equal((await row()).failures, 2);
    });

    it('writes a batch decided under the hold that stands, as decided', async () => {
      await report([ok(0)]);
      lost.add(sensorId);
      await hold(LOST);
      const decided = await states.decide([ok(1)]);
      assert.equal(decided.runtimes[0]?.cause, 'probe');
      await store(decided);
      const now = await row();
      assert.deepEqual(
        [now.state, now.cause, now.lastResultAt],
        ['unknown', 'probe', at(1).getTime()],
      );
      assert.notEqual(states.peek(sensorId), undefined, 'written as decided, so still cached');
    });

    it('writes a row at Unknown/probe that nothing holds now as decided, while a hold holds others', async () => {
      // A check its probe could not start holds the sensor (`P-265`), and its started result
      // lets it go without a re-decision (`NotStarted.release`), so the row still says
      // Unknown/probe. Another sensor's lost probe keeps a hold in force meanwhile.
      const other = await sensor('HTTP');
      await report([ok(0), ok(0, other)]);
      unstarted.set(sensorId, { message: ROUND, failure: null });
      await hold(ROUND);
      assert.deepEqual([(await row()).state, (await row()).cause], ['unknown', 'probe']);
      unstarted.delete(sensorId);
      states.forgetSensors([sensorId]);
      lost.add(other);
      const decided = await states.decide([ok(new Date())]);
      assert.deepEqual([decided.runtimes[0]?.state, decided.runtimes[0]?.cause], ['up', 'scan']);

      await store(decided);
      assert.deepEqual([(await row()).state, (await row()).cause], ['up', 'scan']);
      assert.deepEqual((await history()).at(-1), ['up', 'unknown', 'scan']);
      assert.deepEqual(framesFor(), ['up']);
      assert.notEqual(states.peek(sensorId), undefined, 'written as decided, so still cached');
    });

    it('reacts to a master’s recovery its lost probe overtook as measured: its dependents wait the delay (M-11)', async () => {
      // In the order measured, the recovery is written first and sets the delay, and the hold
      // keeps the dependents through it. Overtaken, the hold has let them go, so the recovery
      // the history keeps must still reach the reaction, or each dependent pages.
      const master = sensorId;
      const dependent = await sensor('HTTP');
      await h.service.setDependency(testActor, master, 'device', undefined, 300);
      await report([ok(0, master), ok(0, dependent)]);
      await store(await states.decide([failed(1), failed(2)]));
      assert.equal((await dependency(dependent)).held, true, 'held by its master’s Down');
      const recovered = await states.decide([ok(3)]);
      lost.add(master);
      lost.add(dependent);
      await hold(LOST, [master, dependent]);
      assert.equal((await dependency(dependent)).held, false, 'let go: its master is Unknown');

      await store(recovered);
      assert.equal((await row(master)).state, 'unknown');
      assert.deepEqual((await history(master)).slice(-2), [
        ['up', 'down', 'scan'],
        ['unknown', 'down', 'probe'],
      ]);
      const clearAt = (await dependency(master)).clearAt;
      assert.ok(clearAt !== null && clearAt > Date.now(), 'the delay began');
      assert.equal((await dependency(dependent)).held, true, 'and holds the dependent through it');
    });

    it('reacts to a master’s Down its lost probe overtook as measured: it ends the delay (M-11)', async () => {
      // In the order measured, the Down is written first and ends the delay a recovery set
      // (`markRecoveries`), and the hold then lets the dependents go.
      const master = sensorId;
      const dependent = await sensor('HTTP');
      await h.service.setDependency(testActor, master, 'device', undefined, 300);
      await report([ok(0, master), ok(0, dependent)]);
      await db.query('UPDATE sensor_runtime SET dependency_clear_at = $2 WHERE object_id = $1', [
        master,
        new Date(Date.now() + 60 * 60_000),
      ]);
      const decided = await states.decide([failed(1), failed(2)]);
      lost.add(master);
      lost.add(dependent);
      await hold(LOST, [master, dependent]);
      assert.equal((await dependency(dependent)).held, true, 'held by the delay');

      await store(decided);
      assert.equal((await row(master)).state, 'unknown');
      assert.equal((await dependency(master)).clearAt, null, 'the delay ended');
      assert.equal((await dependency(dependent)).held, false, 'and its dependent let go');
    });

    it('reacts to a master’s recovery its lost probe overtook when its clock stamped it after the hold’s row (M-11)', async () => {
      // Left out of the history, which ends where the row does, but measured, and reacted to as
      // it would have been had it been written first: or each dependent pages.
      const master = sensorId;
      const dependent = await sensor('HTTP');
      await h.service.setDependency(testActor, master, 'device', undefined, 300);
      await report([ok(0, master), ok(0, dependent)]);
      await store(await states.decide([failed(1), failed(2)]));
      assert.equal((await dependency(dependent)).held, true, 'held by its master’s Down');
      const recovered = await states.decide([ok(ahead(5))]);
      assert.equal(recovered.transitions.length, 1);
      lost.add(master);
      lost.add(dependent);
      await hold(LOST, [master, dependent]);
      assert.equal((await dependency(dependent)).held, false, 'let go: its master is Unknown');

      await store(recovered);
      assert.equal((await row(master)).state, 'unknown');
      assert.deepEqual((await history(master)).slice(-2), [
        ['down', 'warning', 'scan'],
        ['unknown', 'down', 'probe'],
      ]);
      const clearAt = (await dependency(master)).clearAt;
      assert.ok(clearAt !== null && clearAt > Date.now(), 'the delay began');
      assert.equal((await dependency(dependent)).held, true, 'and holds the dependent through it');
    });

    it('reacts to a master’s Down its lost probe overtook when its clock stamped it after the hold’s row (M-11)', async () => {
      const master = sensorId;
      const dependent = await sensor('HTTP');
      await h.service.setDependency(testActor, master, 'device', undefined, 300);
      await report([ok(0, master), ok(0, dependent)]);
      await db.query('UPDATE sensor_runtime SET dependency_clear_at = $2 WHERE object_id = $1', [
        master,
        new Date(Date.now() + 60 * 60_000),
      ]);
      const decided = await states.decide([failed(ahead(2)), failed(ahead(4))]);
      assert.equal(decided.transitions.length, 2);
      lost.add(master);
      lost.add(dependent);
      await hold(LOST, [master, dependent]);
      assert.equal((await dependency(dependent)).held, true, 'held by the delay');

      await store(decided);
      assert.deepEqual(await history(master), [
        ['up', 'unknown', 'scan'],
        ['unknown', 'up', 'probe'],
      ]);
      assert.equal((await dependency(master)).clearAt, null, 'the delay ended');
      assert.equal((await dependency(dependent)).held, false, 'and its dependent let go');
    });

    it('takes the unheld rows its transitions move before a held row it asks about, as a release takes a master it let go of before its dependents', async () => {
      // A release locks a master and re-decides it; its dependency recompute then writes the
      // dependents' rows. A write that held a held dependent's row while it waited on the
      // master's closed a cycle with it, and one of the two was rolled back.
      const master = sensorId;
      const dependent = await sensor('HTTP');
      await report([ok(0, master), ok(0, dependent)]);
      const decided = await states.decide([failed(1, master), ok(1, dependent)]);
      assert.deepEqual(
        decided.transitions.map((transition) => transition.sensorId),
        [master],
      );
      // The dependent's probe is lost, so the write asks about its row.
      lost.add(dependent);

      let taken = (): void => undefined;
      const masterTaken = new Promise<void>((resolve) => {
        taken = resolve;
      });
      let go = (): void => undefined;
      const writeWaits = new Promise<void>((resolve) => {
        go = resolve;
      });
      const releasing = db.tx(async (q) => {
        await q.query('SELECT 1 FROM sensor_runtime WHERE object_id = $1 FOR NO KEY UPDATE', [
          master,
        ]);
        taken();
        await writeWaits;
        await q.query(
          'UPDATE sensor_runtime SET paused_by_dependency = paused_by_dependency WHERE object_id = $1',
          [dependent],
        );
      });
      let storing: Promise<void> = Promise.resolve();
      try {
        await within(5_000, 'the release holding the master', masterTaken);
        storing = store(decided);
        await somebodyWaits(db, 'the write waiting on the master', 5_000);
        go();
        await within(10_000, 'the release committing', releasing);
        await within(10_000, 'the write committing', storing);
      } finally {
        go();
        await Promise.allSettled([releasing, storing]);
      }
      assert.deepEqual(
        [(await row(master)).state, (await row(dependent)).state],
        ['warning', 'up'],
      );
    });

    it('takes the held rows it asks about together in id order, as the hold’s own re-decision takes them', async () => {
      // A probe lost while its batch is in flight: the hold locks the rows it re-decides in id
      // order (`lockRuntimes`). A write that took a moved row ahead of a steady one below it
      // waited on the hold for the steady one while the hold waited on it for the moved one.
      const steady = sensorId;
      const moving = await sensor('HTTP');
      assert.ok(steady < moving);
      await report([ok(0, steady), ok(0, moving)]);
      const decided = await states.decide([ok(1, steady), failed(1, moving)]);
      assert.deepEqual(
        decided.transitions.map((transition) => transition.sensorId),
        [moving],
      );
      // Laid, as `lost` lays it before its transaction.
      lost.add(steady);
      lost.add(moving);

      let taken = (): void => undefined;
      const steadyTaken = new Promise<void>((resolve) => {
        taken = resolve;
      });
      let go = (): void => undefined;
      const writeWaits = new Promise<void>((resolve) => {
        go = resolve;
      });
      const holding = db.tx(async (q) => {
        await q.query('SELECT 1 FROM sensor_runtime WHERE object_id = $1 FOR NO KEY UPDATE', [
          steady,
        ]);
        taken();
        await writeWaits;
        await q.query('SELECT 1 FROM sensor_runtime WHERE object_id = $1 FOR NO KEY UPDATE', [
          moving,
        ]);
      });
      let storing: Promise<void> = Promise.resolve();
      try {
        await within(5_000, 'the hold holding the steady row', steadyTaken);
        storing = store(decided);
        await somebodyWaits(db, 'the write waiting on the steady row', 5_000);
        go();
        await within(10_000, 'the hold committing', holding);
        await within(10_000, 'the write committing', storing);
      } finally {
        go();
        await Promise.allSettled([holding, storing]);
      }
      assert.deepEqual([(await row(steady)).state, (await row(moving)).state], ['up', 'warning']);
    });

    it('decides each sensor of one write on its own: one overtaken, one written as decided', async () => {
      const elsewhere = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: (
            await h.service.create(testActor, {
              kind: 'probe',
              parentId: h.rootId,
              name: `probe-${String(process.hrtime.bigint())}`,
            })
          ).id,
          name: 'db-server',
          host: '192.0.2.44',
        })
      ).id;
      const other = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: elsewhere,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      await report([ok(0), ok(0, other)]);
      const decided = await states.decide([
        failed(1),
        failed(2),
        failed(1, other),
        failed(2, other),
      ]);
      lost.add(sensorId);
      await hold(LOST);

      await store(decided);
      assert.deepEqual([(await row()).state, (await row(other)).state], ['unknown', 'down']);
      assert.deepEqual([framesFor(), framesFor(other)], [[], ['warning', 'down']]);
      assert.deepEqual((await history()).at(-1), ['unknown', 'up', 'probe']);
      assert.deepEqual((await history(other)).at(-1), ['down', 'warning', 'scan']);
    });

    it('is wired in main.ts', async () => {
      // An option a test passes and the core does not is the change reverted (`P-111`).
      const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
      const main = await readFile(join(repoRoot, 'packages', 'core', 'src', 'main.ts'), 'utf8');
      const start = main.indexOf('new Ingestor({');
      assert.ok(start >= 0, 'main.ts no longer builds an Ingestor this way');
      const end = main.indexOf('\n  });', start);
      assert.ok(end > start);
      assert.match(main.slice(start, end), /\n\s+holds: states,\n/);
    });
  },
);
