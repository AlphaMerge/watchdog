import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Reach, Visibility } from '../src/auth/access.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { PROBE_SOURCE } from '../src/probes/reachability.js';
import {
  readSensorState,
  writeRuntimes,
  writeStateHistory,
  type HeldWords,
} from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** Before now, so a pause, stamped now, sorts after every result. */
const T0 = new Date(Date.now() - 60 * 60_000);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const LOST = 'the probe that runs this sensor is not connected';

/** The sensors the test says a lost probe holds, read live by the state service. */
const lost = new Set<number>();
/** The sensors whose checks their probe could not start, and the words of its latest round. */
const unstarted = new Map<number, HeldWords>();

/** What the runtime read sent, so a test can say which rows were locked. */
interface Sent {
  readonly sql: string;
  readonly ids: readonly number[];
}

const locking = (sql: string): boolean => sql.includes('FOR NO KEY UPDATE');
/** `loadRuntimes` and `lockRuntimes`, which read the columns; not `writeStateHistory`'s lock. */
const readsRuntimes = (sql: string): boolean =>
  sql.includes('object_id::text AS object_id') &&
  sql.includes('FROM sensor_runtime WHERE object_id = ANY');

/**
 * A re-decision that reads its rows, then has something else commit on another connection, then
 * writes (`P-414`). Its read takes no lock, so before this it wrote a state decided without what
 * committed in between: Unknown over a paused row, recorded after the pause as if from Up, or by
 * a reword with the history left saying paused. Now the rows it writes are locked and decided
 * again, and only what that second read says is written.
 */
describe(
  'a re-decision writes what its rows say when it writes them (P-414)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let deviceId: number;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('reevaluate_race');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        unreachableSensors: () => lost,
        notStartedSensors: () => unstarted,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    const sensor = async (): Promise<number> =>
      (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `ping-${String(process.hrtime.bigint())}`,
          sensorType: 'icmp.ping',
        })
      ).id;

    beforeEach(async () => {
      lost.clear();
      unstarted.clear();
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
          host: '192.0.2.42',
        })
      ).id;
      sensorId = await sensor();
    });

    /** Results into states the way ingestion writes them. */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    const ok = (id: number, minutes: number): SensorResult => ({
      sensorId: id,
      at: at(minutes),
      outcome: 'ok',
      message: '4/4 replies',
    });
    const failed = (minutes: number): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'error',
      message: `no reply at minute ${String(minutes)}`,
    });

    /**
     * A lost probe's re-decision of `ids`, with `meanwhile` committed on another connection once
     * its first read of the rows has come back. Returns what it sent of the runtime reads.
     */
    async function straddled(
      ids: readonly number[],
      meanwhile: () => Promise<void>,
    ): Promise<Sent[]> {
      const states = h.states;
      assert.ok(states !== undefined);
      const sent: Sent[] = [];
      let first = true;
      await db.tx(async (q) => {
        const watched = new Proxy(q, {
          get(target, property) {
            if (property === 'query') {
              return async (sql: string, values?: readonly unknown[]): Promise<unknown> => {
                const rows = await target.query(sql, values);
                if (readsRuntimes(sql)) {
                  sent.push({ sql, ids: (values?.[0] as (string | number)[]).map(Number) });
                  if (first && !locking(sql)) {
                    first = false;
                    await meanwhile();
                  }
                }
                return rows;
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function'
              ? (value as (this: Queryable, ...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
        await states.reevaluate(watched, ids, new Date(), { message: LOST, sources: PROBE_SOURCE });
      });
      assert.equal(first, false, 'the re-decision read its rows, and the change went in between');
      return sent;
    }

    async function said(): Promise<{ state: string; cause: string; message: string }> {
      const runtime = await readSensorState(db, sensorId);
      assert.ok(runtime !== null);
      return { state: runtime.state, cause: runtime.cause, message: runtime.message };
    }

    /** The sensor's transitions, oldest first: state, the state before it, and cause. */
    async function history(): Promise<[string, string | null, string][]> {
      const rows = await db.query<{ state: string; previous_state: string | null; cause: string }>(
        `SELECT state, previous_state, cause FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
        [sensorId],
      );
      return rows.map((row) => [row.state, row.previous_state, row.cause]);
    }

    it('leaves a pause that committed meanwhile, and records nothing over it', async () => {
      await report([ok(sensorId, 0)]);
      lost.add(sensorId);
      await straddled([sensorId], async () => {
        await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      });
      assert.deepEqual(await said(), { state: 'paused', cause: 'user', message: 'maintenance' });
      assert.deepEqual((await history()).at(-1), ['paused', 'up', 'user']);
    });

    it('waits for a pause still open when it writes, and leaves it', async () => {
      // The pause holds the row from its flags until it commits; here it waits on its audit
      // record until the re-decision is blocked behind it.
      await report([ok(sensorId, 0)]);
      lost.add(sensorId);
      let reached = (): void => undefined;
      const atAudit = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      h.audit.also = {
        record: async () => {
          reached();
          await gate;
        },
      };
      let pausing: Promise<unknown> = Promise.resolve();
      const released = somebodyWaits(db, 'the re-decision waiting on the open pause').finally(open);
      try {
        await straddled([sensorId], async () => {
          pausing = h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
          await within(5_000, 'the pause holding the row, open', atAudit);
        });
        await within(5_000, 'the re-decision blocked behind the pause', released);
        await within(5_000, 'the pause committing', pausing);
      } finally {
        open();
        h.audit.also = undefined;
      }
      assert.deepEqual(await said(), { state: 'paused', cause: 'user', message: 'maintenance' });
      assert.deepEqual((await history()).at(-1), ['paused', 'up', 'user']);
    });

    it('leaves a pause that committed meanwhile under a reword, which writes no transition', async () => {
      // The case the history cannot show: a check its probe could not start, held again in new
      // words (`P-410`), rewords the row with no transition, so before this the row said Unknown
      // while the history's newest row said paused.
      const ROUND = 'the probe took 10012 ms to start the check and gave up';
      const AGAIN = 'the worker pool has given up and cannot run checks';
      const states = h.states;
      assert.ok(states !== undefined);
      await report([ok(sensorId, 0)]);
      unstarted.set(sensorId, { message: ROUND, failure: null });
      await db.tx((q) =>
        states.reevaluate(q, [sensorId], new Date(), { message: ROUND, sources: PROBE_SOURCE }),
      );
      assert.deepEqual(await said(), { state: 'unknown', cause: 'probe', message: ROUND });
      unstarted.set(sensorId, { message: AGAIN, failure: null });
      const sent = await straddled([sensorId], async () => {
        await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      });
      assert.deepEqual(await said(), { state: 'paused', cause: 'user', message: 'maintenance' });
      assert.deepEqual((await history()).at(-1), ['paused', 'unknown', 'user']);
      assert.deepEqual(
        sent.filter((one) => locking(one.sql)).map((one) => one.ids),
        [[sensorId]],
        'a row it rewords with no transition is locked and decided again too',
      );
    });

    it('leaves a simulated error that committed meanwhile', async () => {
      await report([ok(sensorId, 0)]);
      lost.add(sensorId);
      await straddled([sensorId], async () => {
        await h.service.simulateError(
          testActor,
          sensorId,
          true,
          Visibility.EVERYTHING,
          Reach.EVERYTHING,
          'chain test',
        );
      });
      const now = await said();
      assert.equal(now.state, 'down', 'the force outranks a lost probe');
      assert.equal(now.cause, 'simulated');
      assert.deepEqual((await history()).at(-1), ['down', 'up', 'simulated']);
    });

    it('decides from a result that committed meanwhile: the transition is from what it said', async () => {
      await report([ok(sensorId, 0)]);
      await straddled([sensorId], async () => {
        // Decided before the probe was lost, and stored after the re-decision read the row.
        await report([failed(1)]);
        await report([failed(2)]);
        lost.add(sensorId);
      });
      assert.deepEqual(await said(), { state: 'unknown', cause: 'probe', message: LOST });
      assert.deepEqual((await history()).slice(-2), [
        ['down', 'warning', 'scan'],
        ['unknown', 'down', 'probe'],
      ]);
    });

    it('locks only the rows it writes, in id order', async () => {
      const second = await sensor();
      const third = await sensor();
      await report([ok(sensorId, 0), ok(second, 0), ok(third, 0)]);
      // Only two of the three are held: `second` is decided Up again, and changes nothing.
      lost.add(third);
      lost.add(sensorId);
      const sent = await straddled([third, second, sensorId], () => Promise.resolve());
      const locked = sent.filter((one) => locking(one.sql));
      assert.equal(locked.length, 1, 'one locking read');
      assert.deepEqual(
        [...(locked[0]?.ids ?? [])].sort((a, b) => a - b),
        [sensorId, third].sort((a, b) => a - b),
        'the two it writes, and not the one it leaves',
      );
      assert.match(locked[0]?.sql ?? '', /ORDER BY object_id FOR NO KEY UPDATE/);
    });
  },
);
