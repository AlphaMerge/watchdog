import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { SensorAssignment } from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { diffAssignments, fingerprint, ProbeConfigService } from '../src/probes/config.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();
const INTERVAL = 'scan.intervalSeconds';

const assignment = (over: Partial<SensorAssignment> = {}): SensorAssignment => ({
  sensorId: 1,
  sensorType: 'icmp.ping',
  params: { count: 4 },
  target: { host: '192.0.2.1', ipVersion: 'auto' },
  intervalSeconds: 60,
  timeoutMs: 30_000,
  ...over,
});

// ── the pure half ───────────────────────────────────────────────────────────────────────────

describe('assignment fingerprints', () => {
  it('is stable across ordering, so a different row order is not a configuration change', () => {
    const a = assignment({ sensorId: 1 });
    const b = assignment({ sensorId: 2 });
    assert.equal(fingerprint([a, b]), fingerprint([b, a]));
  });

  it('is stable across parameter key order', () => {
    // Two forms that submitted the same values in a different order must not make a probe
    // re-apply its whole configuration.
    const a = assignment({ params: { count: 4, timeoutMs: 2_000 } });
    const b = assignment({ params: { timeoutMs: 2_000, count: 4 } });
    assert.equal(fingerprint([a]), fingerprint([b]));
  });

  it('moves when anything the probe acts on moves', () => {
    const base = fingerprint([assignment()]);
    const variants = [
      assignment({ sensorType: 'icmp.other' }),
      assignment({ params: { count: 5 } }),
      assignment({ target: { host: '192.0.2.2', ipVersion: 'auto' } }),
      assignment({ target: { host: '192.0.2.1', ipVersion: 'v4' } }),
      assignment({ intervalSeconds: 30 }),
      assignment({ timeoutMs: 10_000 }),
    ];
    for (const variant of variants) {
      assert.notEqual(fingerprint([variant]), base, JSON.stringify(variant));
    }
  });

  it('gives the empty set a fingerprint of its own', () => {
    // "Nothing to scan" has to compare equal to itself, or an unclaimed probe would be sent a
    // fresh empty configuration on every reconnect.
    assert.equal(fingerprint([]), fingerprint([]));
    assert.notEqual(fingerprint([]), fingerprint([assignment()]));
  });
});

describe('assignment deltas', () => {
  it('reports what was added, changed and removed', () => {
    const before = [assignment({ sensorId: 1 }), assignment({ sensorId: 2 })];
    const after = [
      assignment({ sensorId: 1 }),
      assignment({ sensorId: 2, intervalSeconds: 30 }),
      assignment({ sensorId: 3 }),
    ];

    const delta = diffAssignments(before, after);
    assert.deepEqual(
      delta.upserted.map((sensor) => sensor.sensorId).sort(),
      [2, 3],
      'unchanged sensor 1 must not be re-sent',
    );
    assert.deepEqual(delta.removed, []);

    const shrunk = diffAssignments(after, [assignment({ sensorId: 1 })]);
    assert.deepEqual(shrunk.removed.sort(), [2, 3]);
    assert.deepEqual(shrunk.upserted, []);
  });

  it('is empty when nothing moved', () => {
    const set = [assignment({ sensorId: 1 }), assignment({ sensorId: 2 })];
    assert.deepEqual(diffAssignments(set, set), { upserted: [], removed: [] });
  });
});

// ── against the database ────────────────────────────────────────────────────────────────────

describe(
  'probe configuration',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let config: ProbeConfigService;

    before(async () => {
      scratch = await createScratchDatabase('probeconfig');
      db = scratch.db;
      h = await buildHarness(db);
      config = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
      });
    });

    after(async () => {
      await scratch.drop();
    });

    let probeId: number;
    let deviceId: number;

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
        gid: `gid-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'device',
        host: '192.0.2.50',
        ipVersion: 'v4',
      });
      deviceId = device.id;
    });

    const addSensor = (name = 'Ping') =>
      h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name,
        sensorType: 'icmp.ping',
        params: { count: 4 },
      });

    it('resolves a probe branch from the GID a probe presents', async () => {
      const detail = await h.service.get(probeId);
      assert.ok(detail.kind === 'probe');
      assert.ok(detail.gid !== null);
      assert.equal(await config.probeObjectFor(detail.gid), probeId);
    });

    it('resolves nothing for a GID nobody has claimed', async () => {
      assert.equal(await config.probeObjectFor('not-a-real-gid'), null);
      assert.equal(await config.probeObjectFor(''), null, 'an empty GID is not a claim');
    });

    it('refuses to let two branches claim the same probe', async () => {
      // Two branches scanning the same sensors is the duplicate-alarm failure "one outage, one
      // alarm" exists to prevent, so the database refuses it rather than the application.
      const detail = await h.service.get(probeId);
      assert.ok(detail.kind === 'probe');
      await assert.rejects(() =>
        h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'impostor',
          gid: detail.gid,
        }),
      );
    });

    it('carries the target from the device, not from the sensor', async () => {
      const sensor = await addSensor();
      const { sensors } = await config.assignmentsFor(probeId);

      assert.equal(sensors.length, 1);
      const only = sensors[0];
      assert.ok(only);
      assert.deepEqual(only.target, { host: '192.0.2.50', ipVersion: 'v4' });
      assert.equal(only.sensorId, sensor.id);
      assert.equal(only.sensorType, 'icmp.ping');
    });

    it('carries the interval resolved through the chain, not a default', async () => {
      await addSensor();
      const before = await config.assignmentsFor(probeId);
      assert.equal(before.sensors[0]?.intervalSeconds, 60, 'the registry default');

      // Set two levels up: the probe. The sensor inherits it without knowing what a probe is.
      await h.service.setSetting(testActor, probeId, INTERVAL, 300, { kind: 'none' });
      const afterwards = await config.assignmentsFor(probeId);

      assert.equal(afterwards.sensors[0]?.intervalSeconds, 300);
      assert.notEqual(afterwards.version, before.version, 'and the fingerprint moved with it');
    });

    it('sends a probe only its own sensors', async () => {
      await addSensor('Mine');

      const other = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      const otherDevice = await h.service.create(testActor, {
        kind: 'device',
        parentId: other.id,
        name: 'other-device',
        host: '192.0.2.60',
      });
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: otherDevice.id,
        name: 'Theirs',
        sensorType: 'icmp.ping',
        params: {},
      });

      const mine = await config.assignmentsFor(probeId);
      const theirs = await config.assignmentsFor(other.id);
      assert.equal(mine.sensors.length, 1);
      assert.equal(theirs.sensors.length, 1);
      assert.notEqual(mine.version, theirs.version);
    });

    it('follows a device that moves to another probe', async () => {
      await addSensor();
      const destination = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `dest-${String(process.hrtime.bigint())}`,
      });

      await h.service.move(testActor, deviceId, destination.id, { kind: 'none' });

      assert.equal((await config.assignmentsFor(probeId)).sensors.length, 0, 'left the old probe');
      assert.equal((await config.assignmentsFor(destination.id)).sensors.length, 1);
    });

    it('is empty, with a stable fingerprint, for a probe with nothing under it', async () => {
      const first = await config.assignmentsFor(probeId);
      const second = await config.assignmentsFor(probeId);
      assert.deepEqual(first.sensors, []);
      assert.equal(first.version, second.version);
    });

    it('does not move its fingerprint when something unrelated changes', async () => {
      await addSensor();
      const before = await config.assignmentsFor(probeId);

      // A comment is configuration an operator cares about and a probe does not.
      await h.service.update(
        testActor,
        deviceId,
        { kind: 'device', comments: 'rack 4, second from the top' },
        { kind: 'none' },
      );

      assert.equal((await config.assignmentsFor(probeId)).version, before.version);
    });
  },
);
