import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { classify, type Evidence } from '@ms/shared';
import { DeviceTemplateCatalogue, type DeviceTemplate } from '../src/device-templates/index.js';
import {
  ProvisionService,
  type ExistingDevice,
  type ExistingSensor,
} from '../src/discovery/provision.js';
import {
  DiscoveryService,
  type DiscoveredHost,
  type DiscoveryRunRow,
} from '../src/discovery/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * Turning a discovery into devices and sensors (`D-04`).
 *
 * **Idempotency is the whole ticket**, so most of this file runs the same provisioning twice and
 * asserts that the second time created nothing. A discovery is re-run — on a schedule, or by an
 * operator who has just configured a credential — and a second run that duplicated everything
 * would double the object tree, double the load on every device in it, and double every alarm.
 *
 * Against a real tree, because the thing being tested is what `ObjectService.create` does with
 * these inputs and what the next run then finds.
 */

const available = await databaseAvailable();

/**
 * Templates over the *harness's* sensor types, not the shipped ones.
 *
 * The harness registers three types on purpose — `ObjectService`'s tests assert stored params
 * exactly, and the real catalogue's defaults would make them about Ajv. So these fixtures use
 * what it has: `icmp.ping` (no credential) and `snmp.traffic` (needs one), which is enough to
 * exercise every branch this file is about. That the *shipped* templates are consistent with the
 * shipped catalogue is `device-templates.test.ts`'s assertion, where the real one is in scope.
 */
const TEMPLATES: readonly DeviceTemplate[] = [
  {
    id: 'test.generic',
    name: 'Generic',
    description: '',
    match: {},
    sensors: [{ type: 'icmp.ping', name: 'Ping' }],
    tags: ['auto-discovered'],
  },
  {
    id: 'test.linux',
    name: 'Linux',
    description: '',
    match: { kind: ['linux'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.traffic', name: 'Traffic', params: { port: 1 }, credential: 'snmp' },
      {
        type: 'snmp.traffic',
        name: 'Traffic 2',
        params: { port: 2 },
        credential: 'snmp',
        requires: { sysDescr: '.' },
      },
      // Two paramless specs of *different* types, so the duplicate check has to compare the
      // type and not only the parameters — without that, a second paramless sensor would be
      // read as the first one and never created.
      { type: 'core.factory', name: 'Rollup' },
      // A *less specific* spec of a type the template also names precisely. `plan` keeps it,
      // because its parameters differ; the duplicate check should then skip it, because a
      // sensor of that type is already there and this one names nothing it lacks.
      { type: 'snmp.traffic', name: 'Traffic (any interface)', credential: 'snmp' },
    ],
    tags: ['auto-discovered', 'linux'],
  },
  {
    // A template naming a sensor that cannot be created as configured — `port` is an integer
    // here. The catalogue this file builds does not validate parameters, which is exactly the
    // state a hand-written template file is in before somebody notices.
    id: 'test.broken',
    name: 'Broken',
    description: '',
    match: { kind: ['printer'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.traffic', name: 'Impossible', params: { port: 'not a number' } },
      { type: 'core.factory', name: 'Rollup' },
    ],
  },
  {
    id: 'test.web',
    name: 'Web',
    description: '',
    match: { portsAny: [80] },
    sensors: [{ type: 'icmp.ping', name: 'Ping' }],
    tags: ['web'],
  },
];

const ports = (...list: number[]) => list.map((port) => ({ port, transport: 'tcp' as const }));

describe('provisioning', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let groupId = 0;
  let probeId = 0;
  let discovery: DiscoveryService;
  let provisioner: ProvisionService;
  let credentials = new Set<string>();
  let recorded: { address: string; deviceId: number }[] = [];

  const templates = ((): DeviceTemplateCatalogue => {
    const held = new DeviceTemplateCatalogue(() => true);
    for (const template of TEMPLATES) held.register(template, 'test');
    return held.seal();
  })();

  before(async () => {
    scratch = await createScratchDatabase('provision');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    credentials = new Set();
    recorded = [];

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
    groupId = group.id;

    discovery = new DiscoveryService({
      db,
      logger: silentLogger,
      dispatch: () => true,
    });
    provisioner = new ProvisionService({
      objects: harness.service,
      templates,
      logger: silentLogger,
      credentialsFor: () => Promise.resolve(credentials),
      recordDevice: (_runId, address, deviceId) => {
        recorded.push({ address, deviceId });
        return Promise.resolve();
      },
    });
  });

  const run = async (): Promise<DiscoveryRunRow> =>
    discovery.start({ groupId, probeId, range: '10.0.0.0/29' });

  /** Everything a group holds, so a second pass can be given what the first left behind. */
  const existing = async (): Promise<{
    devices: ExistingDevice[];
    sensors: ExistingSensor[];
  }> => {
    const devices = await db.query<{ id: string; name: string; host: string | null }>(
      `SELECT o.id, o.name, d.host FROM object o
       JOIN device_config d ON d.object_id = o.id
       WHERE o.parent_id = $1 AND o.kind = 'device'
       ORDER BY o.id`,
      [groupId],
    );
    const sensors = await db.query<{
      parent_id: string;
      type: string;
      params: Record<string, unknown>;
    }>(
      `SELECT s.parent_id, sc.type, sc.params FROM object s
       JOIN sensor_config sc ON sc.object_id = s.id
       JOIN object d ON d.id = s.parent_id
       WHERE d.parent_id = $1 AND d.kind = 'device' AND s.kind = 'sensor'`,
      [groupId],
    );
    return {
      devices: devices.map((row) => ({ id: Number(row.id), name: row.name, host: row.host ?? '' })),
      sensors: sensors.map((row) => ({
        deviceId: Number(row.parent_id),
        sensorType: row.type,
        params: row.params,
      })),
    };
  };

  const provision = async (hosts: DiscoveredHost[], record: DiscoveryRunRow) => {
    const held = await existing();
    return provisioner.provision({
      run: record,
      hosts,
      existingDevices: held.devices,
      existingSensors: held.sensors,
      actor: testActor,
    });
  };

  const host = (address: string, over: Partial<Evidence> = {}): DiscoveredHost => ({
    address,
    rttMs: 1,
    fingerprint: classify({ address, ports: [], ...over }),
  });

  describe('creating', () => {
    it('creates a device and the sensors its templates plan', async () => {
      credentials = new Set(['snmp']);
      const record = await run();
      const report = await provision([host('10.0.0.1', { sysDescr: 'Linux web01 5.15' })], record);

      assert.equal(report.devicesCreated, 1);
      assert.equal(
        report.sensorsCreated,
        4,
        `created ${String(report.sensorsCreated)}: ${JSON.stringify(report.problems)}`,
      );
      assert.deepEqual(
        report.devices[0]?.sensors,
        ['Ping', 'Traffic', 'Traffic 2', 'Rollup'],
        'and the less specific Traffic spec was satisfied by one already created',
      );
      assert.equal(report.matched, 0);
      assert.deepEqual(report.problems, []);

      const held = await existing();
      assert.equal(held.devices.length, 1);
      assert.equal(held.devices[0]?.host, '10.0.0.1');
    });

    it('names a device by what it calls itself, then DNS, then its address', async () => {
      // sysName first, because that is what an operator sees on the device's own console; a
      // reverse record is what somebody typed into DNS and is occasionally years out of date.
      const record = await run();
      await provision(
        [
          host('10.0.0.1', {
            sysDescr: 'Linux x',
            sysName: 'core-sw-01',
            reverseName: 'old.example.com',
          }),
          host('10.0.0.2', { reverseName: 'web02.example.com' }),
          host('10.0.0.3'),
        ],
        record,
      );
      const names = (await existing()).devices.map((one) => one.name).sort();
      assert.deepEqual(names, ['10.0.0.3', 'core-sw-01', 'web02.example.com']);
    });

    it('records why each device got what it got, where an operator will see it', async () => {
      const record = await run();
      await provision([host('10.0.0.1', { sysDescr: 'Linux gateway 5.15' })], record);
      const rows = await db.query<{ comments: string; tags: string[] }>(
        `SELECT comments, tags FROM object WHERE parent_id = $1 AND kind = 'device'`,
        [groupId],
      );
      assert.match(rows[0]?.comments ?? '', /Discovered as linux/);
      assert.match(rows[0]?.comments ?? '', /Linux gateway/);
      assert.ok((rows[0]?.tags ?? []).includes('auto-discovered'));
    });

    it('gives a host nothing identified a Ping sensor rather than nothing', async () => {
      const record = await run();
      const report = await provision(
        [{ address: '10.0.0.9', rttMs: 1, fingerprint: null }],
        record,
      );
      assert.equal(report.devicesCreated, 1);
      assert.deepEqual(report.devices[0]?.sensors, ['Ping']);
    });

    it('does not create a sensor nothing can authenticate', async () => {
      // Twelve SNMP sensors on a group with no SNMP credential is twelve sensors failing from
      // their first scan, which is how an operator learns to distrust discovery.
      const record = await run();
      const report = await provision([host('10.0.0.1', { sysDescr: 'Linux web01 5.15' })], record);
      assert.deepEqual(report.devices[0]?.sensors, ['Ping', 'Rollup']);
    });

    it('records which device each host became', async () => {
      const record = await run();
      await provision([host('10.0.0.1')], record);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.address, '10.0.0.1');
    });
  });

  describe('idempotency — the whole ticket', () => {
    it('creates nothing on a second identical pass', async () => {
      credentials = new Set(['snmp']);
      const record = await run();
      const hosts = [
        host('10.0.0.1', { sysDescr: 'Linux web01 5.15', ports: ports(80) }),
        host('10.0.0.2', { sysDescr: 'Linux db01 5.15' }),
        host('10.0.0.3'),
      ];

      const first = await provision(hosts, record);
      assert.equal(first.devicesCreated, 3);
      assert.ok(first.sensorsCreated > 3);

      const second = await provision(hosts, record);
      assert.equal(second.devicesCreated, 0, 'no device the second time');
      assert.equal(second.sensorsCreated, 0, 'and no sensor');
      assert.equal(second.matched, 3);
      // Everything the plan named the first time, whether it was created then or already
      // satisfied by something else the plan named.
      assert.equal(second.sensorsSkipped, first.sensorsCreated + first.sensorsSkipped);

      const held = await existing();
      assert.equal(held.devices.length, 3);
      assert.equal(held.sensors.length, first.sensorsCreated);
    });

    it('adds only what is missing when a credential appears', async () => {
      // The case an operator actually hits: discover, notice the SNMP sensors are absent,
      // configure the community, provision again.
      const record = await run();
      const hosts = [host('10.0.0.1', { sysDescr: 'Linux router 5.15' })];

      const before = await provision(hosts, record);
      assert.deepEqual(before.devices[0]?.sensors, ['Ping', 'Rollup']);

      credentials = new Set(['snmp']);
      const after = await provision(hosts, record);
      assert.equal(after.devicesCreated, 0);
      assert.equal(after.sensorsCreated, 2, `added ${String(after.sensorsCreated)}`);
      assert.equal(after.sensorsSkipped, 3, 'and left what was already there alone');
    });

    it('matches a device somebody created by name years ago', async () => {
      // The address is what the sweep found; the device was made by name. Creating a second one
      // would leave an operator with two objects for one machine and no idea which is which.
      await harness.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'Web server',
        host: 'web01.example.com',
      });
      const record = await run();
      const report = await provision(
        [host('10.0.0.1', { reverseName: 'web01.example.com' })],
        record,
      );
      assert.equal(report.devicesCreated, 0);
      assert.equal(report.matched, 1);
    });

    it('prefers the full name over a short one that also matches', async () => {
      // The order is the point. Two sites can each have a `web01`, so consulting the short name
      // first would merge `web01.london` and `web01.paris` into one device the first time both
      // were discovered — and the operator would have one object for two machines.
      const full = await harness.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'web01.london.example.com',
        host: '192.0.2.1',
      });
      await harness.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'web01',
        host: '192.0.2.2',
      });

      const record = await run();
      const report = await provision(
        [host('10.0.0.1', { reverseName: 'web01.london.example.com' })],
        record,
      );
      assert.equal(report.devicesCreated, 0);
      assert.equal(report.devices[0]?.deviceId, full.id, 'the full name won');
    });

    it('matches on a short name only when nothing better did', async () => {
      // `web01` where the device says `web01.example.com`. Consulting this first would merge
      // `web01.london` and `web01.paris` into one device.
      await harness.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'web01',
        host: '192.0.2.1',
      });
      const record = await run();
      const report = await provision(
        [host('10.0.0.1', { reverseName: 'web01.example.com' })],
        record,
      );
      assert.equal(report.matched, 1, 'the short name found it');
    });

    it('does not merge two hosts that resolve to the same name in one pass', async () => {
      // Indexed the moment it is created, so the second address finds the device the first made
      // rather than creating a duplicate.
      const record = await run();
      const report = await provision(
        [
          host('10.0.0.1', { reverseName: 'shared.example.com' }),
          host('10.0.0.2', { reverseName: 'shared.example.com' }),
        ],
        record,
      );
      assert.equal(report.devicesCreated, 1);
      assert.equal(report.matched, 1);
      assert.equal((await existing()).devices.length, 1);
    });

    it('keeps two sensors of one type that differ in their parameters', async () => {
      // Two http.request sensors on different paths are two sensors and both belong; the
      // duplicate check compares parameters, not only the type.
      const record = await run();
      credentials = new Set(['snmp']);
      await provision([host('10.0.0.1', { sysDescr: 'Linux one 5.15' })], record);
      const device = (await existing()).devices[0];
      assert.ok(device !== undefined);
      await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Traffic on port 9',
        sensorType: 'snmp.traffic',
        params: { port: 9 },
      });

      const again = await provision([host('10.0.0.1', { sysDescr: 'Linux one 5.15' })], record);
      assert.equal(again.sensorsCreated, 0, 'the template’s own sensors are still there');
      const types = (await existing()).sensors.filter((one) => one.sensorType === 'snmp.traffic');
      assert.equal(types.length, 3, 'and the hand-made one was not touched');
    });

    it('does not require a hand-made sensor to carry the template’s defaults', async () => {
      // A sensor created by hand carries every default its schema has. Requiring those to match
      // too would make every re-run create a second copy of everything.
      const record = await run();
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'By hand',
        host: '10.0.0.1',
      });
      await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'My ping',
        sensorType: 'icmp.ping',
        // Parameters the template's own Ping spec does not name. A duplicate check that
        // compared the *stored* parameters against the spec — rather than the spec's against
        // the stored — would call this a different sensor and create a second Ping on every
        // re-run, for ever.
        params: { count: 4, timeoutMs: 2_000 },
      });

      const report = await provision([host('10.0.0.1')], record);
      assert.equal(report.devicesCreated, 0);
      assert.equal(report.sensorsCreated, 0);
      assert.equal(report.sensorsSkipped, 1);
    });
  });

  describe('when something goes wrong', () => {
    it('records a sensor that cannot be created and makes the rest anyway', async () => {
      // **The defect this found live.** A built-in template named `snmp.diskfree` without the
      // mount point that type requires; the create call threw, the per-*host* catch swallowed
      // it, and the device came out with a Ping and nothing else while the report said nothing
      // was wrong. The catch is per sensor now, and the problem names the type.
      const record = await run();
      const report = await provision([host('10.0.0.1', { ports: ports(9100) })], record);

      assert.equal(report.devicesCreated, 1);
      assert.deepEqual(report.devices[0]?.sensors, ['Ping', 'Rollup'], 'the rest were made');
      assert.equal(report.problems.length, 1);
      assert.match(report.problems[0]?.problem ?? '', /^snmp\.traffic: /);
    });

    it('records the host and carries on with the rest', async () => {
      // A run that reported success while skipping a machine is worse than one that reported
      // the failure. One transaction for the lot would also roll back work that was fine.
      const record = await run();
      provisioner = new ProvisionService({
        objects: harness.service,
        templates,
        logger: silentLogger,
        credentialsFor: () => Promise.resolve(credentials),
        recordDevice: (_runId, address) =>
          address === '10.0.0.2'
            ? Promise.reject(new Error('the database said no'))
            : Promise.resolve(),
      });

      const report = await provision(
        [host('10.0.0.1'), host('10.0.0.2'), host('10.0.0.3')],
        record,
      );
      assert.equal(report.devicesCreated, 3, 'all three devices were made');
      assert.deepEqual(report.problems, [{ address: '10.0.0.2', problem: 'the database said no' }]);
      assert.equal(report.devices.length, 2, 'and the one that failed is not reported as done');
    });

    it('stores problems where an operator can read them', async () => {
      const record = await run();
      await discovery.recordProvisioning(record.id, {
        devicesCreated: 2,
        matched: 1,
        sensorsCreated: 7,
        problems: [{ address: '10.0.0.9', problem: 'the group refused it' }],
      });
      const after = await discovery.get(record.id);
      assert.ok(after !== null);
      assert.equal(after.devicesCreated, 2);
      assert.equal(after.sensorsCreated, 7);
      assert.ok(after.provisionedAt !== null);
      assert.deepEqual(await discovery.problems(record.id), [
        { address: '10.0.0.9', problem: 'the group refused it' },
      ]);
    });

    it('adds counts across passes rather than replacing them', async () => {
      // Provisioning runs twice — an operator who configured a credential — and the run's total
      // is what it created across all of them, not what the last pass happened to do.
      const record = await run();
      const once = { devicesCreated: 2, matched: 0, sensorsCreated: 3, problems: [] };
      await discovery.recordProvisioning(record.id, once);
      await discovery.recordProvisioning(record.id, {
        ...once,
        devicesCreated: 0,
        sensorsCreated: 4,
      });
      const after = await discovery.get(record.id);
      assert.ok(after !== null);
      assert.equal(after.devicesCreated, 2);
      assert.equal(after.sensorsCreated, 7);
    });

    it('replaces a problem rather than accumulating one per attempt', async () => {
      const record = await run();
      const problems = [{ address: '10.0.0.9', problem: 'first reason' }];
      await discovery.recordProvisioning(record.id, {
        devicesCreated: 0,
        matched: 0,
        sensorsCreated: 0,
        problems,
      });
      await discovery.recordProvisioning(record.id, {
        devicesCreated: 0,
        matched: 0,
        sensorsCreated: 0,
        problems: [{ address: '10.0.0.9', problem: 'still failing, differently' }],
      });
      assert.deepEqual(await discovery.problems(record.id), [
        { address: '10.0.0.9', problem: 'still failing, differently' },
      ]);
    });
  });
});
