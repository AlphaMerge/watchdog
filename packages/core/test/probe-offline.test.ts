import { strict as assert } from 'node:assert';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ProbeReachability } from '../src/probes/reachability.js';
import { ReachabilitySync } from '../src/probes/reachability-sync.js';
import { SensorStateService } from '../src/state/service.js';
import { ALL_CLEAR } from '../src/state/limits.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
import { CompositeAuditSink } from '../src/audit/store.js';
import type { AuditSink } from '../src/objects/audit.js';
import { failingOn } from './support/failing.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * A probe going offline (`R-05`).
 *
 * **The claim is about what does *not* happen.** A lost probe must not turn every sensor it
 * carried into a Down alarm — nobody has asked those sensors anything, so Down would be a claim
 * the system cannot support, and one cable would page whoever is on call once per sensor. The
 * state machine has always known the right answer; what is under test here is that something
 * finally tells it, that the answer survives an unrelated re-evaluation, and that a probe coming
 * back does not invent a second transition per sensor.
 */

const available = await databaseAvailable();

describe('a probe going offline', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let states: SensorStateService;
  let reachability: ProbeReachability;
  let probeId = 0;
  let deviceId = 0;
  let sensorIds: number[] = [];

  before(async () => {
    scratch = await createScratchDatabase('probe_offline');
    db = scratch.db;
    harness = await buildHarness(db, { states: true });
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');

    // Its own state service, wired to its own reachability set — the harness's is built without
    // one, which is the pre-`R-05` shape and exactly what must not be under test here.
    reachability = undefined as unknown as ProbeReachability;
    states = new SensorStateService({
      db,
      logger: silentLogger,
      settings: harness.resolver,
      pauses: new PauseRepository(),
      unreachableSensors: () => reachability.unreachableSensors(),
    });
    reachability = new ProbeReachability({
      db,
      logger: silentLogger,
      states,
      // The same one the harness built, so this test and the pause sweep are looking at one
      // reactor rather than two that happen to agree (`P-135`).
      dependencies: harness.dependencies ?? { recompute: () => Promise.resolve({ moved: 0 }) },
      coreEvaluatedTypes: ['core.factory', 'ms.core.health'],
    });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
    const group = await harness.service.create(testActor, {
      kind: 'group',
      parentId: probe.id,
      name: 'Datacentre',
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: group.id,
      name: 'web01',
      host: '127.0.0.1',
    });
    deviceId = device.id;

    sensorIds = [];
    for (const name of ['Ping', 'HTTP']) {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name,
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });
      sensorIds.push(sensor.id);
    }
  });

  /**
   * One good reading each, so the sensors are Up and have something to fall back to.
   *
   * `decide` advances the cache and returns what to write; the `Ingestor` is what persists it in
   * production, and this does the same one step by hand rather than standing up an ingestion
   * pipeline to prove something about probes.
   */
  const scanned = async (ids: number[] = sensorIds) => {
    const decisions = await states.decide(
      ids.map((sensorId) => ({
        sensorId,
        at: new Date(),
        outcome: 'ok' as const,
        message: '4/4 replies',
        channels: ALL_CLEAR,
      })),
    );
    await db.tx(async (q) => {
      await writeRuntimes(q, decisions.runtimes);
      await writeStateHistory(q, decisions.transitions);
    });
  };

  const stateOf = async (sensorId: number) => {
    const rows = await db.query<{ state: string; cause: string }>(
      'SELECT state::text AS state, cause::text AS cause FROM sensor_runtime WHERE object_id = $1',
      [sensorId],
    );
    return rows[0];
  };

  /** The words on the sensor now, and on its last transition. */
  const messagesOf = async (
    sensorId: number,
  ): Promise<{ runtime: string | undefined; history: string | undefined }> => {
    const [runtime] = await db.query<{ message: string }>(
      'SELECT message FROM sensor_runtime WHERE object_id = $1',
      [sensorId],
    );
    const [history] = await db.query<{ message: string }>(
      'SELECT message FROM sensor_state WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1',
      [sensorId],
    );
    return { runtime: runtime?.message, history: history?.message };
  };
  const RETURNED =
    'the probe carrying this sensor is answering again; until its next result it stands where ' +
    'it stood before the probe was lost';

  it('turns its sensors Unknown, never Down', async () => {
    await scanned();
    assert.equal((await stateOf(sensorIds[0] ?? 0))?.state, 'up');

    const moved = await reachability.lost(probeId);
    assert.equal(moved, 2, 'both sensors moved, and only them');

    for (const sensorId of sensorIds) {
      const row = await stateOf(sensorId);
      assert.equal(row?.state, 'unknown', 'Down would be a claim the system cannot support');
      assert.equal(row.cause, 'probe', 'and the cause says where to look');
    }
  });

  it('says so in the sensor’s own message, rather than leaving it unexplained', async () => {
    await scanned();
    await reachability.lost(probeId);
    const rows = await db.query<{ message: string }>(
      'SELECT message FROM sensor_runtime WHERE object_id = $1',
      [sensorIds[0] ?? 0],
    );
    assert.match(rows[0]?.message ?? '', /probe carrying this sensor stopped answering/);
  });

  it('holds them Unknown through an unrelated re-evaluation', async () => {
    // The failure this guards against: a pause clearing, a dependency releasing or a schedule
    // window opening re-decides a sensor, `loadRuntimes` restores `probeReachable: true`
    // because there is no column for it, and the sensor flips back to Up while its probe is
    // still missing. The overlay lives in one place precisely so no path can forget.
    await scanned();
    await reachability.lost(probeId);

    await db.tx((q) => states.reevaluate(q, sensorIds, new Date(), { message: 'something else' }));
    for (const sensorId of sensorIds) {
      assert.equal((await stateOf(sensorId))?.state, 'unknown');
    }
  });

  it('leaves a healthy probe’s sensors alone while another probe is down', async () => {
    // The overlay is a broad brush — it is applied to every runtime the state service loads,
    // for every reason it loads one. The failure it invites is the opposite of the one above:
    // one probe drops, and the *whole installation* goes Unknown on its next re-evaluation
    // because the overlay stopped asking which sensors the outage actually covers.
    await scanned();
    const other = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `healthy-${String(process.hrtime.bigint())}`,
    });
    const otherDevice = await harness.service.create(testActor, {
      kind: 'device',
      parentId: other.id,
      name: 'db02',
      host: '127.0.0.1',
    });
    const otherSensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: otherDevice.id,
      name: 'Ping',
      sensorType: 'icmp.ping',
      params: { count: 3 },
    });
    await scanned([otherSensor.id]);

    await reachability.lost(probeId);
    await db.tx((q) =>
      states.reevaluate(q, [otherSensor.id], new Date(), { message: 'something else' }),
    );

    const row = await stateOf(otherSensor.id);
    assert.equal(row?.state, 'up', 'its own probe never left');
    assert.notEqual(row.cause, 'probe');
  });

  it('gives them back their last reading when it returns', async () => {
    // Not "Unknown until a fresh result": that reading is the most recent thing the system
    // actually measured, and the next scan corrects it within one interval. Holding them would
    // add a second transition per sensor for no information.
    await scanned();
    await reachability.lost(probeId);
    const moved = await reachability.found(probeId);
    assert.equal(moved, 2);

    for (const sensorId of sensorIds) {
      assert.equal((await stateOf(sensorId))?.state, 'up');
      // And says why it is Up with nothing measured since (`R-11`), where it said nothing.
      assert.deepEqual(await messagesOf(sensorId), {
        runtime: RETURNED,
        history: RETURNED,
      });
    }
  });

  it('says nothing of the probe when something else lets a sensor go from it (R-11)', async () => {
    // Words that are about something else are not the probe's to give: a caller that does not
    // speak for the probe lets go in none, as before.
    await scanned();
    await reachability.lost(probeId);
    const [sensorId] = sensorIds;
    assert.ok(sensorId !== undefined);
    // The probe is back as far as this state service knows, and the first to re-decide the
    // sensor is not the probe's path.
    const unaware = new SensorStateService({
      db,
      logger: silentLogger,
      settings: harness.resolver,
      pauses: new PauseRepository(),
      unreachableSensors: () => new Set<number>(),
    });
    await db.tx((q) =>
      unaware.reevaluate(q, [sensorId], new Date(), {
        message: 'resumed by somebody',
        sources: ['user'],
      }),
    );
    assert.equal((await stateOf(sensorId))?.state, 'up');
    assert.deepEqual(await messagesOf(sensorId), { runtime: '', history: '' });
  });

  it('re-decides on the sensor’s own failure policy, not the default', async () => {
    // **`P-86`.** §2.1's policy is inheritable and resolved per sensor, but the cache that held
    // it was written only by `decide` — so every path that re-decides without a result used
    // `warnFor: 1`. It is empty after a restart and after any setting change anywhere in the
    // installation, so this is the ordinary case rather than a corner of one.
    //
    // Two failures against `retryWarnings = 3` is Warning. A probe leaving and returning must
    // not turn that into Down: `sensor_state` is what uptime is computed from, and an alarm
    // chain armed here pages somebody for an outage the sensor's own policy says has not begun.
    const [sensorId] = sensorIds;
    assert.ok(sensorId !== undefined);
    await harness.service.setSetting(testActor, deviceId, 'scan.retryWarnings', 3);

    for (let failure = 0; failure < 2; failure += 1) {
      const decisions = await states.decide([
        { sensorId, at: new Date(), outcome: 'error', message: 'no reply' },
      ]);
      await db.tx(async (q) => {
        await writeRuntimes(q, decisions.runtimes);
        await writeStateHistory(q, decisions.transitions);
      });
    }
    assert.equal((await stateOf(sensorId))?.state, 'warning', 'two failures against three');

    // Exactly what a restart leaves behind: the row, and no resolved policy in memory.
    states.forgetPolicies();

    await reachability.lost(probeId);
    await reachability.found(probeId);

    assert.equal(
      (await stateOf(sensorId))?.state,
      'warning',
      'a probe leaving and returning is not two more failed scans',
    );
  });

  it('lets go of a sensor moved onto a live probe, which is the obvious remediation', async () => {
    // **`P-103`.** `lost` snapshots which sensors a probe was carrying, and that snapshot
    // outlived the topology it was taken from. Moving the device onto a working probe — what an
    // operator does when a probe host dies — left every moved sensor still in `#unreachable`, so
    // `#withProbeFacts` overlaid `probeReachable: false` and layer 3 answered `unknown`/`probe`
    // for every result the *new* probe delivered. No transition was written, because the state
    // did not change; the sensors were simply dark and unalarmable, for as long as the dead
    // probe stayed away — permanently, if it was decommissioned, which is why it was moved.
    //
    // Through the audit sink, not by calling `resync` here: the defect was that nothing in
    // production ran it, and a test that supplies the missing step tests the step after it.
    harness.audit.also = new ReachabilitySync({
      reachability: () => reachability,
      logger: silentLogger,
    });
    try {
      const spare = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `spare-${String(process.hrtime.bigint())}`,
      });

      await scanned();
      await reachability.lost(probeId, 'link');
      const [sensorId] = sensorIds;
      assert.ok(sensorId !== undefined);
      assert.equal((await stateOf(sensorId))?.state, 'unknown');

      await harness.service.move(testActor, deviceId, spare.id, { kind: 'none' });

      assert.equal(
        (await stateOf(sensorId))?.state,
        'up',
        'back to what its last reading says, because its probe is answering',
      );
      assert.equal(reachability.stats().sensorsUnknown, 0, 'and the overlay let go of it');
    } finally {
      harness.audit.also = undefined;
    }
  });

  it('takes over a sensor moved onto a probe that is already away', async () => {
    // The mirror. A snapshot taken before the move could not see an arrival either, so a device
    // moved *onto* a dead probe kept reading Up while nothing was scanning it.
    harness.audit.also = new ReachabilitySync({
      reachability: () => reachability,
      logger: silentLogger,
    });
    try {
      const spare = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `spare-${String(process.hrtime.bigint())}`,
      });
      const stranded = await harness.service.create(testActor, {
        kind: 'device',
        parentId: spare.id,
        name: 'moves-later',
        host: '127.0.0.2',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: stranded.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });

      await scanned([sensor.id]);
      assert.equal((await stateOf(sensor.id))?.state, 'up');

      await reachability.lost(probeId, 'link');
      await harness.service.move(testActor, stranded.id, probeId, { kind: 'none' });

      assert.equal(
        (await stateOf(sensor.id))?.state,
        'unknown',
        'nothing is scanning it now, and saying Up would be a claim nobody can support',
      );
    } finally {
      harness.audit.also = undefined;
    }
  });

  describe('P-249: what resync catches does not cost the caller its transaction', () => {
    /** A row the caller's transaction writes, which is kept only if that transaction commits. */
    const written = async (): Promise<number> =>
      Number(
        (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM p249_written'))[0]?.n ?? 0,
      );

    before(async () => {
      await db.query('CREATE TABLE IF NOT EXISTS p249_written (n int)');
    });

    beforeEach(async () => {
      await db.query('DELETE FROM p249_written');
    });

    /** A spare live probe, and the device moved onto it without anything keeping the overlay. */
    const moveAway = async (): Promise<void> => {
      const spare = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `spare-${String(process.hrtime.bigint())}`,
      });
      await harness.service.move(testActor, deviceId, spare.id, { kind: 'none' });
    };

    it('keeps the transaction when the re-evaluation fails a statement', async () => {
      // A recompute that fails a statement, once the probe is down: `resync` catches what its
      // re-evaluation throws, inside the caller's transaction, so that a move is never refused
      // for it. Without a savepoint that catch aborted the caller's transaction, and the COMMIT
      // after it rolled back the caller's every write.
      let failing = false;
      reachability = new ProbeReachability({
        db,
        logger: silentLogger,
        states,
        dependencies: {
          recompute: async (q, at) => {
            if (failing) await q.query('SELECT 1/0');
            return harness.dependencies?.recompute(q, at) ?? { moved: 0 };
          },
        },
        coreEvaluatedTypes: ['core.factory', 'ms.core.health'],
      });
      await scanned();
      await reachability.lost(probeId, 'link');
      await moveAway();
      failing = true;

      const moved = await db.tx(async (q) => {
        await q.query('INSERT INTO p249_written VALUES (1)');
        return reachability.resync(q);
      });

      assert.equal(moved, 0, 'the re-evaluation did not land');
      assert.equal(await written(), 1, 'and the caller’s transaction committed all the same');
      assert.equal(reachability.stats().sensorsUnknown, 0, 'with the overlay corrected');
    });

    it('keeps the transaction, and the other probes, when one probe’s sensors cannot be read', async () => {
      // Two probes down. The read of one fails; the other's still moves its sensors. Without a
      // savepoint around each read the failed one aborted the transaction, and everything after
      // it, the other probe's re-evaluation and the caller's COMMIT, went with it.
      const other = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      await scanned();
      await reachability.lost(probeId, 'link');
      await reachability.lost(other.id, 'link');
      await moveAway();
      const [sensorId] = sensorIds;
      assert.ok(sensorId !== undefined);
      assert.equal((await stateOf(sensorId))?.state, 'unknown');

      await db.tx(async (q) => {
        await q.query('INSERT INTO p249_written VALUES (1)');
        await reachability.resync(
          failingOn(
            q,
            (text, values) => text.includes('WITH RECURSIVE below') && values?.[0] === other.id,
          ),
        );
      });

      assert.equal(await written(), 1, 'the caller’s transaction committed');
      assert.equal(
        (await stateOf(sensorId))?.state,
        'up',
        'and the probe whose sensors could be read moved them',
      );
      assert.equal(reachability.stats().probesDown, 2, 'the other probe is still held as it was');
    });

    it('commits the mutation when whatever the sink calls fails a statement and throws', async () => {
      // `ReachabilitySync` catches anything `resync` throws so as not to refuse the mutation, and
      // that catch is inside the mutation's transaction too.
      let calls = 0;
      harness.audit.also = new ReachabilitySync({
        reachability: () => ({
          holdsAny: () => true,
          resync: async (q) => {
            calls += 1;
            await q.query('SELECT 1/0');
            return 0;
          },
        }),
        logger: silentLogger,
      });
      try {
        const spare = await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name: `spare-${String(process.hrtime.bigint())}`,
        });
        await harness.service.move(testActor, deviceId, spare.id, { kind: 'none' });
        assert.equal(calls, 2, 'the create and the move each reached it');
        const [row] = await db.query<{ parent_id: string }>(
          'SELECT parent_id::text AS parent_id FROM object WHERE id = $1',
          [deviceId],
        );
        assert.equal(Number(row?.parent_id), spare.id, 'and the move was kept');
      } finally {
        harness.audit.also = undefined;
      }
    });

    it('costs a tree change no statement while no probe is held', async () => {
      let calls = 0;
      harness.audit.also = new ReachabilitySync({
        reachability: () => ({
          holdsAny: () => false,
          resync: () => {
            calls += 1;
            return Promise.resolve(0);
          },
        }),
        logger: silentLogger,
      });
      try {
        await moveAway();
        assert.equal(calls, 0);
      } finally {
        harness.audit.also = undefined;
      }
    });
  });

  describe('P-249: the overlay follows the tree that committed', () => {
    /** `ReachabilitySync`, then a sink after it that fails: the mutation rolls back. */
    const syncThenFail = (): AuditSink =>
      new CompositeAuditSink([
        new ReachabilitySync({ reachability: () => reachability, logger: silentLogger }),
        { record: () => Promise.reject(new Error('a sink after the overlay’s failed')) },
      ]);

    const spareProbe = async (): Promise<number> =>
      (
        await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name: `spare-${String(process.hrtime.bigint())}`,
        })
      ).id;

    it('leaves the overlay alone when a move under a lost probe rolls back', async () => {
      // A device on a live probe, moved under the lost one, and the move rolled back by a sink
      // after the overlay's. The sensor is still under its live probe, and its results count.
      const spare = await spareProbe();
      const stranded = await harness.service.create(testActor, {
        kind: 'device',
        parentId: spare,
        name: 'stays-put',
        host: '127.0.0.3',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: stranded.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });
      await scanned([sensor.id]);
      await reachability.lost(probeId, 'link');
      const unknownBefore = reachability.stats().sensorsUnknown;

      harness.audit.also = syncThenFail();
      try {
        await assert.rejects(() =>
          harness.service.move(testActor, stranded.id, probeId, { kind: 'none' }),
        );
      } finally {
        harness.audit.also = undefined;
      }

      assert.equal(reachability.reachable(sensor.id), true, 'not held behind the lost probe');
      assert.equal(reachability.carrierOf(sensor.id), undefined);
      assert.equal(reachability.stats().sensorsUnknown, unknownBefore);
      await scanned([sensor.id]);
      assert.equal(
        (await stateOf(sensor.id))?.state,
        'up',
        'and what its live probe sends is counted, not short-circuited to unknown',
      );
    });

    it('forgets what a result decided against a move that rolled back (P-253)', async () => {
      // A result for the moving sensor arrives while the move is open: the state service reads
      // the committed row on its own connection and lays the moved overlay over it, so it is
      // decided Unknown and cached so. The move rolls back, and its live probe's next result
      // must count, not be decided from that cache.
      const spare = await spareProbe();
      const stranded = await harness.service.create(testActor, {
        kind: 'device',
        parentId: spare,
        name: 'decided-meanwhile',
        host: '127.0.0.5',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: stranded.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });
      await scanned([sensor.id]);
      await reachability.lost(probeId, 'link');
      await reachability.retryGivenUp();
      assert.equal(reachability.givenUp(), 0);

      let meanwhile: string | undefined;
      harness.audit.also = new CompositeAuditSink([
        new ReachabilitySync({ reachability: () => reachability, logger: silentLogger }),
        {
          record: async () => {
            const decided = await states.decide([
              {
                sensorId: sensor.id,
                at: new Date(),
                outcome: 'ok',
                message: '4/4 replies',
                channels: ALL_CLEAR,
              },
            ]);
            meanwhile = decided.runtimes[0]?.state;
            throw new Error('a sink after the overlay’s failed');
          },
        },
      ]);
      try {
        await assert.rejects(() =>
          harness.service.move(testActor, stranded.id, probeId, { kind: 'none' }),
        );
      } finally {
        harness.audit.also = undefined;
      }
      assert.equal(meanwhile, 'unknown', 'decided against the move while it was open');
      assert.equal(states.peek(sensor.id), undefined, 'and forgotten when the move rolled back');
      assert.ok(reachability.givenUp() > 0, 'and owed a re-decision, with no result promised');

      await scanned([sensor.id]);
      assert.deepEqual(await stateOf(sensor.id), { state: 'up', cause: 'scan' });
      assert.ok(states.peek(sensor.id), 'cached again by that result');
      await reachability.retryGivenUp();
      assert.equal(reachability.givenUp(), 0, 'settled by the delivery sweep');
      assert.equal((await stateOf(sensor.id))?.state, 'up');
      // A read that straddled the rollback caches the moved overlay after the undo has run, and
      // a re-decision that moves nothing would leave it there: the sweep drops what it settles.
      assert.equal(states.peek(sensor.id), undefined, 'and dropped from the cache it settled');
    });

    it('keeps owed what a rollback owes while a sweep is settling it (P-253)', async () => {
      // The sweep reads what is owed, then re-decides it. A rollback in between owes the sensor
      // again, against the overlay it has just put back, and that must outlast the sweep.
      let gate: Promise<void> | undefined;
      let open = (): void => undefined;
      let reached = (): void => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const real = states;
      reachability = new ProbeReachability({
        db,
        logger: silentLogger,
        states: {
          reevaluate: async (q, ids, at, cause) => {
            if (gate !== undefined) {
              const held = gate;
              gate = undefined;
              reached();
              await held;
            }
            return real.reevaluate(q, ids, at, cause);
          },
          forgetSensors: (ids) => {
            real.forgetSensors(ids);
          },
        },
        dependencies: harness.dependencies ?? { recompute: () => Promise.resolve({ moved: 0 }) },
        coreEvaluatedTypes: ['core.factory', 'ms.core.health'],
      });
      const spare = await spareProbe();
      const moving = await harness.service.create(testActor, {
        kind: 'device',
        parentId: spare,
        name: 'moved-twice',
        host: '127.0.0.6',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: moving.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });
      await scanned([sensor.id]);
      await reachability.lost(probeId, 'link');
      const moveThatRollsBack = async (): Promise<void> => {
        harness.audit.also = syncThenFail();
        try {
          await assert.rejects(() =>
            harness.service.move(testActor, moving.id, probeId, { kind: 'none' }),
          );
        } finally {
          harness.audit.also = undefined;
        }
      };

      await moveThatRollsBack();
      assert.ok(reachability.givenUp() > 0, 'owed by the first rollback');

      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const sweep = reachability.retryGivenUp();
      await atGate;
      await moveThatRollsBack();
      open();
      await sweep;

      assert.ok(
        reachability.givenUp() > 0,
        'the second owing outlasts the sweep that read the first',
      );
      await reachability.retryGivenUp();
      assert.equal(reachability.givenUp(), 0);
      assert.equal(reachability.reachable(sensor.id), true);
    });

    it('leaves the overlay alone when a move off a lost probe rolls back', async () => {
      // The reverse: the device stays under the lost probe, so its sensors stay held.
      await scanned();
      await reachability.lost(probeId, 'link');
      const spare = await spareProbe();

      harness.audit.also = syncThenFail();
      try {
        await assert.rejects(() =>
          harness.service.move(testActor, deviceId, spare, { kind: 'none' }),
        );
      } finally {
        harness.audit.also = undefined;
      }

      for (const sensorId of sensorIds) {
        assert.equal(reachability.reachable(sensorId), false, 'still behind the lost probe');
        assert.equal(reachability.carrierOf(sensorId), probeId);
      }
      const byNumber = (a: number, b: number): number => a - b;
      assert.deepEqual(
        [...(reachability.heldBy(probeId)?.sensorIds ?? [])].sort(byNumber),
        [...sensorIds].sort(byNumber),
      );
    });

    /** A reachability whose dependency recompute fails a statement while `failing` says so. */
    const flaky = (failing: { now: boolean }): ProbeReachability =>
      new ProbeReachability({
        db,
        logger: silentLogger,
        states,
        dependencies: {
          recompute: async (q, at) => {
            if (failing.now) await q.query('SELECT 1/0');
            return harness.dependencies?.recompute(q, at) ?? { moved: 0 };
          },
        },
        coreEvaluatedTypes: ['core.factory', 'ms.core.health'],
      });

    /** A device on a live probe moved under the lost one while the re-evaluation fails. */
    const arriveWhileFailing = async (failing: { now: boolean }): Promise<number> => {
      const spare = await spareProbe();
      const arriving = await harness.service.create(testActor, {
        kind: 'device',
        parentId: spare,
        name: 'arrives',
        host: '127.0.0.4',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: arriving.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 3 },
      });
      await scanned([sensor.id]);
      await reachability.lost(probeId, 'link');
      failing.now = true;
      harness.audit.also = new ReachabilitySync({
        reachability: () => reachability,
        logger: silentLogger,
      });
      try {
        await harness.service.move(testActor, arriving.id, probeId, { kind: 'none' });
      } finally {
        harness.audit.also = undefined;
      }
      failing.now = false;
      assert.equal(reachability.reachable(sensor.id), false, 'the overlay took it over');
      assert.equal((await stateOf(sensor.id))?.state, 'up', 'but its re-decision was given up');
      assert.ok(reachability.givenUp() > 0, 'and it is owed one');
      return sensor.id;
    };

    it('re-decides at the delivery sweep what a failed re-evaluation gave up', async () => {
      const failing = { now: false };
      reachability = flaky(failing);
      const sensorId = await arriveWhileFailing(failing);
      // What Core Health reads (`P-400`), raised by the failure.
      assert.equal(reachability.stats().sensorsOwedRedecision, reachability.givenUp());
      assert.ok(reachability.stats().sensorsOwedRedecision > 0);

      await reachability.retryGivenUp();

      assert.deepEqual(await stateOf(sensorId), { state: 'unknown', cause: 'probe' });
      assert.equal(reachability.givenUp(), 0, 'and owes nothing more');
      assert.equal(reachability.stats().sensorsOwedRedecision, 0, 'and lowered by the sweep');
    });

    it('re-decides at the next resync, though nothing crosses the overlay then', async () => {
      const failing = { now: false };
      reachability = flaky(failing);
      const sensorId = await arriveWhileFailing(failing);

      await db.tx((q) => reachability.resync(q));

      assert.deepEqual(await stateOf(sensorId), { state: 'unknown', cause: 'probe' });
      assert.equal(reachability.givenUp(), 0);
    });

    it('stays owed when the transaction that re-decided it rolls back', async () => {
      const failing = { now: false };
      reachability = flaky(failing);
      const sensorId = await arriveWhileFailing(failing);

      await assert.rejects(() =>
        db.tx(async (q) => {
          await reachability.resync(q);
          throw new Error('the caller’s transaction failed after it');
        }),
      );

      assert.equal((await stateOf(sensorId))?.state, 'up');
      assert.ok(reachability.givenUp() > 0, 'still owed');
    });
  });

  it('one outage is one transition per sensor, not two', async () => {
    await scanned();
    await reachability.lost(probeId);
    await reachability.lost(probeId);
    assert.equal(reachability.stats().probesDown, 1, 'the second disconnect is not a new outage');
    assert.equal(reachability.stats().outages, 1);
  });

  it('returning a probe that never left changes nothing', async () => {
    await scanned();
    assert.equal(await reachability.found(probeId), 0);
  });

  it('frees only its own sensors', async () => {
    // Two probes down at once is the case a single flat set gets wrong.
    await scanned();
    const other = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `other-${String(process.hrtime.bigint())}`,
    });
    const otherDevice = await harness.service.create(testActor, {
      kind: 'device',
      parentId: other.id,
      name: 'db01',
      host: '127.0.0.1',
    });
    const otherSensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: otherDevice.id,
      name: 'Ping',
      sensorType: 'icmp.ping',
      params: { count: 3 },
    });

    await reachability.lost(probeId);
    await reachability.lost(other.id);
    assert.equal(reachability.stats().sensorsUnknown, 3);

    await reachability.found(probeId);
    assert.equal(reachability.reachable(otherSensor.id), false, 'the other probe is still down');
    assert.equal(reachability.reachable(sensorIds[0] ?? 0), true);
  });

  it('leaves a core-evaluated sensor alone, because the probe never scanned it', async () => {
    // **Found while building `P-13`, and already wrong for `core.factory`.** A core-evaluated
    // sensor's readings come from rows this process holds; the probe it happens to sit under has
    // never asked it anything, and its absence says nothing about it. Marking it Unknown is a
    // false claim — and for Probe Health it is a disabling one, because the sensor whose job is
    // to raise the single alarm for a lost probe would be silenced by the outage it reports.
    const factory = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name: 'Total throughput',
      sensorType: 'core.factory',
      params: {},
    });
    await scanned([...sensorIds, factory.id]);

    await reachability.lost(probeId);

    for (const sensorId of sensorIds) {
      assert.equal((await stateOf(sensorId))?.state, 'unknown', 'a scanned sensor is Unknown');
    }
    assert.equal(
      (await stateOf(factory.id))?.state,
      'up',
      'the factory keeps the state its own evaluation gave it',
    );
    assert.equal(reachability.unreachableSensors().has(factory.id), false);
  });

  it('gives a core-evaluated sensor nothing back when the probe returns either', async () => {
    // The other half: `found` walks the set it recorded, so a sensor that was never in it must
    // not acquire a spurious transition on the way back. One outage, one transition — and for
    // this sensor, none at all.
    const factory = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name: 'Total throughput',
      sensorType: 'core.factory',
      params: {},
    });
    await scanned([...sensorIds, factory.id]);
    await reachability.lost(probeId);
    await reachability.found(probeId);

    const history = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1',
      [factory.id],
    );
    assert.equal(history[0]?.n, '1', 'the one transition its own first reading made');
  });

  it('releases the dependents of a master whose probe has gone', async () => {
    // **`P-87`'s failure, reached down a path `P-87` did not cover** (`P-135`). A master under a
    // probe that goes away becomes Unknown, and Unknown is not Down — so whatever it was holding
    // must be released. Nothing ran that: the dependency reaction is reachable from ingestion,
    // with the transitions a *result batch* produced, and a probe that has gone produces no
    // results. The dependents kept `paused_by_dependency`, dropped out of the probe
    // configuration and were never scanned again, while the pause API — which computes what is
    // holding them from the master's current state — reported nothing holding them and refused
    // to resume them. Silently unmonitored, indefinitely, and unresumable.
    const [master, dependent] = sensorIds;
    assert.ok(master !== undefined && dependent !== undefined);
    await harness.service.setDependency(testActor, dependent, 'object', master, undefined);

    await scanned();
    // The master goes Down and takes its dependent with it, the ordinary way.
    await db.query(`UPDATE sensor_runtime SET state = 'down' WHERE object_id = $1`, [master]);
    const dependencies = harness.dependencies;
    assert.ok(dependencies !== undefined);
    await db.tx((q) => dependencies.recompute(q, new Date()));
    const held = await db.query<{ paused: boolean }>(
      'SELECT paused_by_dependency AS paused FROM sensor_runtime WHERE object_id = $1',
      [dependent],
    );
    assert.equal(held[0]?.paused, true, 'held while the master is Down');

    // Now the probe carrying both of them goes away.
    await reachability.lost(probeId);

    const after = await db.query<{ paused: boolean }>(
      'SELECT paused_by_dependency AS paused FROM sensor_runtime WHERE object_id = $1',
      [dependent],
    );
    assert.equal(after[0]?.paused, false, 'an Unknown master holds nobody');
  });

  it('reports a probe with no sensors without touching anything', async () => {
    const empty = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `empty-${String(process.hrtime.bigint())}`,
    });
    assert.equal(await reachability.lost(empty.id), 0);
    assert.equal(await reachability.found(empty.id), 0);
  });

  it('finds sensors however deep under the probe they sit', async () => {
    // probe → group → device → sensor is the shallow case; a nested group is ordinary.
    const inner = await harness.service.create(testActor, {
      kind: 'group',
      parentId: (await harness.service.get(deviceId)).parentId ?? probeId,
      name: 'Rack 4',
    });
    const innerDevice = await harness.service.create(testActor, {
      kind: 'device',
      parentId: inner.id,
      name: 'web09',
      host: '127.0.0.1',
    });
    const deep = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: innerDevice.id,
      name: 'Ping',
      sensorType: 'icmp.ping',
      params: { count: 3 },
    });

    await reachability.lost(probeId);
    assert.equal(reachability.reachable(deep.id), false);
  });
});
