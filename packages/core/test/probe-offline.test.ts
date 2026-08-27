import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ProbeReachability } from '../src/probes/reachability.js';
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
      unreachableSensors: () => reachability.unreachableSensors(),
    });
    reachability = new ProbeReachability({ db, logger: silentLogger, states });

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
