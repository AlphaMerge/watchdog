import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { ProbeReachability } from '../src/probes/reachability.js';
import { ALL_CLEAR } from '../src/state/limits.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import { SensorStateService, type ReevaluationCause } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

const LOST = 'the probe carrying this sensor stopped answering';
const BACK =
  'the probe carrying this sensor is answering again; until its next result it stands where it ' +
  'stood before the probe was lost';

/** Long enough for a call that does not wait its turn to have started its re-decision. */
const UNWAITED_MS = 150;

/** Whether a statement is `lost`'s read of the sensors beneath the probe. */
const readsTheTree = (sql: string): boolean => sql.includes('WITH RECURSIVE below');

/**
 * A probe's loss and its return, one at a time (`P-416`).
 *
 * `lost` and `found` changed the overlay as they were called and re-decided the probe's sensors
 * in a transaction of their own. A `lost` during `found`'s write read the hold's Unknown that
 * write had not yet replaced, decided nothing, and `found` then committed the last reading for a
 * probe that was gone; the mirror left a connected probe's sensors Unknown; and a `found` during
 * `lost`'s tree read found no hold to let go of. Now each call runs whole, in the order they were
 * made. Each test holds one call open across the others.
 */
describe(
  'a probe’s loss and return, one at a time (P-416)',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Awaited<ReturnType<typeof buildHarness>>;
    let states: SensorStateService;
    let reachability: ProbeReachability;
    let probeId = 0;
    let deviceId = 0;
    let sensorId = 0;
    /** What each re-decision was asked to say, in the order they began. */
    let began: string[] = [];
    /** The next re-decision waits here, after it has written and before it commits. */
    let gate: { open: Promise<void>; reached: () => void; fail: boolean } | undefined;
    /** The next read of the tree beneath the probe waits here. */
    let treeGate: { open: Promise<void>; reached: () => void } | undefined;

    before(async () => {
      scratch = await createScratchDatabase('probe_turns');
      db = scratch.db;
      harness = await buildHarness(db, { states: true });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
      began = [];
      gate = undefined;
      treeGate = undefined;
      reachability = undefined as unknown as ProbeReachability;
      states = new SensorStateService({
        db,
        logger: silentLogger,
        settings: harness.resolver,
        pauses: new PauseRepository(),
        lostSensors: () => reachability.heldWords('link'),
        silentSensors: () => reachability.heldWords('silence'),
      });
      const real = states;
      const watched = new Proxy(db, {
        get(target, property) {
          if (property === 'query') {
            return async (sql: string, values?: readonly unknown[]): Promise<unknown> => {
              const held = treeGate;
              if (held !== undefined && readsTheTree(sql)) {
                treeGate = undefined;
                held.reached();
                await held.open;
              }
              return target.query(sql, values);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (this: Database, ...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      reachability = new ProbeReachability({
        db: watched,
        logger: silentLogger,
        states: {
          reevaluate: async (q: Queryable, ids, at, cause: ReevaluationCause) => {
            began.push(cause.message);
            const count = await real.reevaluate(q, ids, at, cause);
            const held = gate;
            if (held !== undefined) {
              gate = undefined;
              held.reached();
              await held.open;
              if (held.fail) await q.query('SELECT 1/0');
            }
            return count;
          },
          forgetSensors: (ids) => {
            real.forgetSensors(ids);
          },
        },
        dependencies: harness.dependencies ?? { recompute: () => Promise.resolve({ moved: 0 }) },
        coreEvaluatedTypes: ['core.factory', 'ms.core.health'],
      });

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'web01',
        host: '127.0.0.1',
      });
      deviceId = device.id;
      sensorId = (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
          params: { count: 3 },
        })
      ).id;
      // One good reading, so the sensor is Up and has something to return to.
      const decisions = await states.decide([
        { sensorId, at: new Date(), outcome: 'ok', message: '4/4 replies', channels: ALL_CLEAR },
      ]);
      await db.tx(async (q) => {
        await writeRuntimes(q, decisions.runtimes);
        await writeStateHistory(q, decisions.transitions);
      });
    });

    /** Holds the next re-decision open once it has written; `release` lets it commit, or fail. */
    function holdNext(fail = false): { atGate: Promise<void>; release: () => void } {
      let reached = (): void => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release = (): void => undefined;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { open, reached, fail };
      return { atGate, release };
    }

    /** Holds the next read of the tree beneath the probe. */
    function holdTreeRead(): { atGate: Promise<void>; release: () => void } {
      let reached = (): void => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release = (): void => undefined;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      treeGate = { open, reached };
      return { atGate, release };
    }

    const unwaited = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, UNWAITED_MS));

    const row = async (): Promise<{ state: string; cause: string; message: string }> => {
      const rows = await db.query<{ state: string; cause: string; message: string }>(
        `SELECT state::text AS state, cause::text AS cause, message
         FROM sensor_runtime WHERE object_id = $1`,
        [sensorId],
      );
      const one = rows[0];
      assert.ok(one !== undefined);
      return one;
    };

    it('decides a probe lost while its return is still writing from what the return wrote', async () => {
      await reachability.lost(probeId);
      assert.deepEqual([(await row()).state, (await row()).cause], ['unknown', 'probe']);

      const { atGate, release } = holdNext();
      const finding = reachability.found(probeId);
      let losing: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the return’s write held open', atGate);
        began = [];
        losing = reachability.lost(probeId);
        await unwaited();
        assert.deepEqual(began, [], 'the loss waits for the return to commit before it re-decides');
      } finally {
        release();
      }
      await within(5_000, 'the return committing', finding);
      await within(5_000, 'the loss committing', losing);

      assert.deepEqual(await row(), { state: 'unknown', cause: 'probe', message: LOST });
      assert.equal(reachability.reachable(sensorId), false);
    });

    it('decides a probe found while its loss is still writing from what the loss wrote', async () => {
      const { atGate, release } = holdNext();
      const losing = reachability.lost(probeId);
      let finding: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the loss’s write held open', atGate);
        began = [];
        finding = reachability.found(probeId);
        await unwaited();
        assert.deepEqual(began, [], 'the return waits for the loss to commit before it re-decides');
        assert.equal(reachability.reachable(sensorId), false, 'and lets go of nothing until then');
      } finally {
        release();
      }
      await within(5_000, 'the loss committing', losing);
      await within(5_000, 'the return committing', finding);

      assert.deepEqual(await row(), { state: 'up', cause: 'scan', message: BACK });
      assert.equal(reachability.reachable(sensorId), true);
      assert.equal(reachability.heldBy(probeId), undefined);
    });

    it('decides a silent probe resumed while its silence is still writing from what that wrote', async () => {
      const { atGate, release } = holdNext();
      const silencing = reachability.lost(probeId, 'silence');
      let resuming: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the silence’s write held open', atGate);
        began = [];
        resuming = reachability.resumed(probeId);
        await unwaited();
        assert.deepEqual(began, [], 'the resumption waits for the silence to commit');
      } finally {
        release();
      }
      await within(5_000, 'the silence committing', silencing);
      await within(5_000, 'the resumption committing', resuming);

      assert.deepEqual(await row(), { state: 'up', cause: 'scan', message: BACK });
      assert.equal(reachability.heldBy(probeId), undefined);
    });

    it('lets go of a loss whose return arrived while it was still reading the tree', async () => {
      const { atGate, release } = holdTreeRead();
      const losing = reachability.lost(probeId);
      let finding: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the loss reading the tree', atGate);
        finding = reachability.found(probeId);
        await unwaited();
      } finally {
        release();
      }
      await within(5_000, 'the loss', losing);
      assert.ok((await within(5_000, 'the return', finding)) > 0, 'the return re-decided');

      assert.deepEqual(await row(), { state: 'up', cause: 'scan', message: BACK });
      assert.equal(reachability.heldBy(probeId), undefined);
      assert.equal(reachability.reachable(sensorId), true);
    });

    it('takes a loss, a return, a loss and a return in the order they were called, each in its own words', async () => {
      const { atGate, release } = holdNext();
      const calls: Promise<number>[] = [reachability.lost(probeId)];
      try {
        await within(5_000, 'the first loss’s write held open', atGate);
        calls.push(reachability.found(probeId));
        calls.push(reachability.lost(probeId));
        calls.push(reachability.found(probeId));
      } finally {
        release();
      }
      await within(10_000, 'every call settled', Promise.all(calls));

      assert.deepEqual(began, [LOST, BACK, LOST, BACK]);
      assert.deepEqual(await row(), { state: 'up', cause: 'scan', message: BACK });
      assert.equal(reachability.heldBy(probeId), undefined);
    });

    it('takes a failed loss, a return and a newer loss in that order', async () => {
      const { atGate, release } = holdNext(true);
      const first = reachability.lost(probeId);
      let finding: Promise<number> = Promise.resolve(0);
      let second: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the first loss’s write held open', atGate);
        finding = reachability.found(probeId);
        second = reachability.lost(probeId);
        await unwaited();
        assert.notEqual(reachability.heldBy(probeId), undefined, 'the return has not run yet');
      } finally {
        release();
      }
      assert.equal(await within(5_000, 'the first loss failing', first), 0);
      assert.equal(await within(5_000, 'the return', finding), 0, 'nothing left to let go of');
      await within(5_000, 'the second loss committing', second);

      assert.deepEqual(await row(), { state: 'unknown', cause: 'probe', message: LOST });
      assert.notEqual(reachability.heldBy(probeId), undefined, 'the second loss’s hold stands');
      assert.equal(reachability.reachable(sensorId), false);
    });

    it('puts a failed return’s hold back before a loss called after it runs', async () => {
      await reachability.lost(probeId);
      const was = reachability.heldBy(probeId)?.since;
      assert.ok(was !== undefined);
      assert.equal(reachability.stats().outages, 1);

      const { atGate, release } = holdNext(true);
      const finding = reachability.found(probeId);
      let losing: Promise<number> = Promise.resolve(0);
      try {
        await within(5_000, 'the return’s write held open', atGate);
        losing = reachability.lost(probeId);
      } finally {
        release();
      }
      assert.equal(await within(5_000, 'the return failing', finding), 0);
      assert.equal(await within(5_000, 'the loss', losing), 0, 'the probe is already held');

      assert.equal(reachability.heldBy(probeId)?.since, was, 'the first loss’s hold, put back');
      assert.equal(reachability.stats().outages, 1, 'one outage, not a second');
      assert.deepEqual([(await row()).state, (await row()).cause], ['unknown', 'probe']);
    });

    it('lets go of every sensor a failed loss held, as a tree change re-read them meanwhile', async () => {
      const { atGate, release } = holdNext(true);
      const losing = reachability.lost(probeId);
      let arrived = 0;
      try {
        await within(5_000, 'the loss’s write held open', atGate);
        arrived = (
          await within(
            5_000,
            'a sensor created under the probe',
            harness.service.create(testActor, {
              kind: 'sensor',
              parentId: deviceId,
              name: 'HTTP',
              sensorType: 'icmp.ping',
              params: { count: 3 },
            }),
          )
        ).id;
        await within(
          5_000,
          'the tree change’s resync',
          db.tx((q) => reachability.resync(q)),
        );
        assert.deepEqual(
          [...(reachability.heldBy(probeId)?.sensorIds ?? [])].sort((a, b) => a - b),
          [sensorId, arrived].sort((a, b) => a - b),
          'the hold re-read with the sensor that arrived',
        );
      } finally {
        release();
      }
      assert.equal(await within(5_000, 'the loss failing', losing), 0);

      assert.equal(reachability.heldBy(probeId), undefined, 'a hold that was never written');
      assert.equal(reachability.reachable(sensorId), true);
      assert.equal(reachability.reachable(arrived), true);
      assert.deepEqual([(await row()).state, (await row()).cause], ['up', 'scan']);
    });
  },
);
