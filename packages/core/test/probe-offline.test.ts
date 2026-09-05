import { strict as assert } from 'node:assert';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ProbeReachability } from '../src/probes/reachability.js';
import { ReachabilitySync } from '../src/probes/reachability-sync.js';
import { SensorStateService } from '../src/state/service.js';
import { ALL_CLEAR } from '../src/state/limits.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
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
    }
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
