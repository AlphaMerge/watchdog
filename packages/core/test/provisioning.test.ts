import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { classify, type Evidence } from '@ms/shared';
import { DeviceTemplateCatalogue, type DeviceTemplate } from '../src/device-templates/index.js';
import { DiscoveryError } from '../src/discovery/errors.js';
import { checkFingerprint } from '../src/discovery/fingerprint.js';
import {
  ProvisionService,
  provisionRun,
  runVoucher,
  type ExistingDevice,
  type ExistingSensor,
  type RunProvisioning,
} from '../src/discovery/provision.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import {
  DiscoveryService,
  type DiscoveredHost,
  type DiscoveryRunRow,
  type DispatchMessage,
} from '../src/discovery/service.js';
import type { Actor } from '../src/objects/audit.js';
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

describe('who vouches for where a run sends credentials (A-41)', () => {
  const rights = (): Promise<Map<number, 'none'>> => Promise.resolve(new Map<number, 'none'>());
  const writerOfRule = (ruleId: number) => (asked: number) => {
    assert.equal(asked, ruleId);
    return Promise.resolve({ kind: 'account' as const, userId: 42 });
  };

  it('is the account that started it', async () => {
    const voucher = await runVoucher(
      { createdBy: 7, scheduleId: 3 },
      { authRequired: true, ruleWriter: writerOfRule(3), rights },
    );
    assert.equal(voucher?.kind === 'account' && voucher.userId, 7);
  });

  it('is the rule’s last writer for a run a rule started', async () => {
    const voucher = await runVoucher(
      { createdBy: null, scheduleId: 3 },
      { authRequired: true, ruleWriter: writerOfRule(3), rights },
    );
    assert.equal(voucher?.kind === 'account' && voucher.userId, 42);
    const byInstallation = await runVoucher(
      { createdBy: null, scheduleId: 3 },
      {
        authRequired: true,
        ruleWriter: () => Promise.resolve({ kind: 'installation' }),
        rights,
      },
    );
    assert.deepEqual(byInstallation, { kind: 'installation' });
  });

  it('is nobody for a rule nobody on record wrote', async () => {
    const voucher = await runVoucher(
      { createdBy: null, scheduleId: 3 },
      { authRequired: true, ruleWriter: () => Promise.resolve(null), rights },
    );
    assert.ok(voucher?.kind === 'account');
    assert.equal(voucher.userId, null);
    assert.deepEqual([...(await voucher.writes({} as never, [1, 2]))], [], 'vouches for nothing');
  });

  it('is not anybody for a run whose rule is gone, so deleting one hands nothing over', async () => {
    const voucher = await runVoucher(
      { createdBy: null, scheduleId: null },
      {
        authRequired: true,
        ruleWriter: () => assert.fail('there is no rule to ask about'),
        rights,
      },
    );
    assert.equal(voucher, null);
  });

  it('is the installation with the authorisation layer off, as every write is', async () => {
    const voucher = await runVoucher(
      { createdBy: 7, scheduleId: 3 },
      { authRequired: false, ruleWriter: writerOfRule(3), rights },
    );
    assert.deepEqual(voucher, { kind: 'installation' });
  });
});

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
    sensors: [{ type: 'icmp.ping', name: 'Ping', master: true }],
    tags: ['auto-discovered'],
  },
  {
    id: 'test.linux',
    name: 'Linux',
    description: '',
    match: { kind: ['linux'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping', master: true },
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
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      dispatch: () => ({ kind: 'sent' }),
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
    discovery.start({ groupId, probeId, range: '10.0.0.0/29' }, testActor);

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
      credentials: { kind: 'installation' },
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

    it('provisions a host the target policy refused as it does any host nothing identified (A-69)', async () => {
      // The rule for a host nothing identified is the case above: a device and a Ping, never
      // nothing. A refused host is one of those: it answered the sweep and identification sent
      // it nothing (`A-63`). The run's summary says why.
      const address = '169.254.10.20';
      const why = `not identified: refusing to identify ${address}, which is link-local`;
      const check = checkFingerprint({
        address,
        kind: 'unknown',
        ports: [],
        confidence: 0,
        evidence: [why],
        refused: why,
      });
      assert.ok(check.ok);
      const refusedHost: DiscoveredHost = { address, rttMs: 1, fingerprint: check.fingerprint };
      credentials = new Set(['snmp']);
      const record = await run();
      const report = await provision([refusedHost], record);
      assert.equal(report.devicesCreated, 1);
      assert.deepEqual(report.devices[0]?.sensors, ['Ping'], 'the credential added nothing');
      assert.deepEqual(report.problems, []);

      // **A site's own template can still put a sensor that connects on it**, and the core does
      // not stop it: a template with no criteria matches every host, this one included. What
      // holds is the probe. The device is given the address itself as its host, never a name,
      // so every type that connects reads the address the policy refused and fails that check
      // with the policy's sentence before a socket exists, the types held to an address only
      // (databases, Windows) among them. `target-policy-transports.test.ts` in `@ms/sensors`
      // runs the transports against exactly this device ("a device on a link-local address"),
      // and the address-only ones in the block before it.
      const site = new DeviceTemplateCatalogue(() => true);
      for (const template of TEMPLATES) site.register(template, 'test');
      site.register(
        {
          id: 'site.everything',
          name: 'Everything we own',
          description: '',
          match: {},
          sensors: [
            { type: 'snmp.traffic', name: 'Uplink', params: { port: 7 }, credential: 'snmp' },
          ],
        },
        'site',
      );
      provisioner = new ProvisionService({
        objects: harness.service,
        templates: site.seal(),
        logger: silentLogger,
        credentialsFor: () => Promise.resolve(credentials),
        recordDevice: () => Promise.resolve(),
      });
      const again = await provision([refusedHost], record);
      assert.equal(again.matched, 1);
      assert.deepEqual(again.devices[0]?.sensors, ['Uplink']);
      const held = await existing();
      assert.deepEqual(
        held.devices.map((one) => one.host),
        [address],
        'the device’s host is the refused address, which is what the probe checks',
      );
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

  describe('the template filter', () => {
    it('uses every template when none are named', async () => {
      const record = await run();
      const report = await provision([host('10.0.0.1', { ports: ports(80) })], record);
      // `test.generic` and `test.web` both match; both name Ping, which deduplicates to one.
      assert.equal(report.sensorsCreated, 1);
    });

    it('uses only the templates a run named', async () => {
      // A filter rather than a fourth level (`D-06`), because "detailed, but only these
      // templates" is a thing somebody wants and a level could not express it.
      credentials = new Set(['snmp']);
      const record = await discovery.start(
        {
          groupId,
          probeId,
          range: '10.0.0.0/29',
          templates: ['test.generic'],
        },
        testActor,
      );
      const report = await provision([host('10.0.0.1', { sysDescr: 'Linux one 5.15' })], record);
      assert.deepEqual(report.devices[0]?.sensors, ['Ping'], 'test.linux was not consulted');
    });

    it('creates nothing at all when the named templates match nothing', async () => {
      // Honest rather than helpful: a run filtered to templates that do not apply should say so
      // by creating nothing, not by quietly falling back to the generic set the operator
      // excluded.
      const record = await discovery.start(
        {
          groupId,
          probeId,
          range: '10.0.0.0/29',
          templates: ['test.web'],
        },
        testActor,
      );
      const report = await provision([host('10.0.0.1')], record);
      assert.equal(report.devicesCreated, 1, 'the device is still made');
      assert.deepEqual(report.devices[0]?.sensors, []);
      assert.equal(report.mastersSet, 0);
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

    it('refuses the sensors whose credentials its voucher cannot send there, and makes the rest', async () => {
      // `A-41`: the addresses are the run's, so whoever chose them vouches for sending the group's
      // credentials to them — and one who cannot write where they are stored does not.
      credentials = new Set(['snmp']);
      await harness.service.setCredential(testActor, groupId, 'snmp', {
        version: 'v2c',
        community: 'dc-secret',
      });
      const record = await run();
      const report = await provisioner.provision({
        run: record,
        hosts: [host('10.0.0.1', { sysDescr: 'Linux web01 5.15' })],
        existingDevices: [],
        existingSensors: [],
        actor: testActor,
        credentials: { kind: 'account', userId: 7, writes: () => Promise.resolve(new Set()) },
      });

      assert.equal(report.devicesCreated, 1);
      assert.ok(!(report.devices[0]?.sensors ?? []).some((name) => name.startsWith('Traffic')));
      assert.ok((report.devices[0]?.sensors ?? []).includes('Ping'), 'the rest were made');
      assert.ok(report.problems.length >= 2);
      for (const { problem } of report.problems) {
        assert.match(
          problem,
          /^snmp\.traffic: bringing the snmp credentials on group "Datacentre"/,
        );
        assert.doesNotMatch(problem, /dc-secret/);
      }
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

  /**
   * The master object (`D-05`).
   *
   * `WORKFLOW.MD §2`: auto-discovery sets each device's reachability sensor as master object for
   * the parent device, so the whole sensor set pauses when the device is unreachable — one
   * outage, one alarm, which is the rule the system is built around. `M-11` already had the
   * mechanism; what is here is discovery using it, and the two places it deliberately does not.
   */
  describe('the master dependency', () => {
    /** What the device's own setting points at, which is where `M-11` keeps it. */
    const masterOf = async (deviceId: number): Promise<number | null> => {
      const rows = await db.query<{ value: string }>(
        `SELECT value #>> '{}' AS value FROM object_setting
         WHERE object_id = $1 AND key = 'dependency.masterId'`,
        [deviceId],
      );
      const value = rows[0]?.value;
      return value === undefined ? null : Number(value);
    };

    it('makes the sensor the template marked into the device’s master', async () => {
      const record = await run();
      const report = await provision([host('10.0.0.1')], record);
      assert.equal(report.mastersSet, 1);

      const device = report.devices[0];
      assert.ok(device !== undefined);
      const master = await masterOf(device.deviceId);
      assert.ok(master !== null, 'the device has a master');

      const rows = await db.query<{ name: string; type: string }>(
        `SELECT o.name, sc.type FROM object o
         JOIN sensor_config sc ON sc.object_id = o.id WHERE o.id = $1`,
        [master],
      );
      assert.equal(rows[0]?.type, 'icmp.ping', 'and it is the reachability sensor');
    });

    it('writes it on the device, so every other sensor inherits it', async () => {
      // `device` mode is the whole trick: the setting lands on the device, every sensor under it
      // inherits that sensor as their master, and the master is excluded from its own dependency
      // — which is what keeps it scanning while its dependents are paused.
      credentials = new Set(['snmp']);
      const record = await run();
      const report = await provision([host('10.0.0.1', { sysDescr: 'Linux one 5.15' })], record);
      const device = report.devices[0];
      assert.ok(device !== undefined);

      const master = await masterOf(device.deviceId);
      const onSensors = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM object_setting os
         JOIN object o ON o.id = os.object_id
         WHERE o.parent_id = $1 AND os.key = 'dependency.masterId'`,
        [device.deviceId],
      );
      assert.ok(master !== null);
      assert.equal(Number(onSensors[0]?.count ?? -1), 0, 'and on none of the sensors');
    });

    it('does not touch a device it only matched', async () => {
      // **The decision that matters.** A device an operator already set up has dependency
      // choices of its own — possibly "none", deliberately — and a discovery that overwrote them
      // would be editing a decision somebody made on purpose, silently, on every re-run.
      const record = await run();
      const first = await provision([host('10.0.0.1')], record);
      const device = first.devices[0];
      assert.ok(device !== undefined);

      // The operator changes their mind.
      await db.query(
        `DELETE FROM object_setting WHERE object_id = $1 AND key = 'dependency.masterId'`,
        [device.deviceId],
      );

      const second = await provision([host('10.0.0.1')], record);
      assert.equal(second.matched, 1);
      assert.equal(second.mastersSet, 0, 'nothing was set the second time');
      assert.equal(await masterOf(device.deviceId), null, 'and the operator’s choice stands');
    });

    it('does not re-master a matched device even when it recreates the master sensor', async () => {
      // The sharper version of the rule above. An operator who deleted the Ping *and* the
      // dependency has made two decisions; a re-run that restored the sensor may — but
      // restoring the dependency would undo the second one, silently, on every future run.
      const record = await run();
      const first = await provision([host('10.0.0.1')], record);
      const device = first.devices[0];
      assert.ok(device !== undefined);

      await db.query(
        `DELETE FROM object_setting WHERE object_id = $1 AND key = 'dependency.masterId'`,
        [device.deviceId],
      );
      await db.query(`DELETE FROM object WHERE parent_id = $1 AND kind = 'sensor'`, [
        device.deviceId,
      ]);

      const second = await provision([host('10.0.0.1')], record);
      assert.equal(second.matched, 1);
      assert.ok(second.sensorsCreated > 0, 'the sensor came back');
      assert.equal(second.mastersSet, 0, 'and the dependency did not');
      assert.equal(await masterOf(device.deviceId), null);
    });

    it('takes the master of the most specific template that marks one', async () => {
      // Several templates match a device and each may mark its own; `validateTemplate` only
      // rules out two within *one* template. The first spec wins, and `plan` orders by how
      // specific the template is — so a vendor template's choice beats the generic one's rather
      // than depending on which happened to be created last.
      const held = new DeviceTemplateCatalogue(() => true);
      held.register(
        {
          id: 'a.generic',
          name: 'Generic',
          description: '',
          match: {},
          sensors: [{ type: 'core.factory', name: 'Fallback master', master: true }],
        },
        'test',
      );
      held.register(
        {
          id: 'b.specific',
          name: 'Specific',
          description: '',
          match: { kind: ['linux'] },
          sensors: [{ type: 'icmp.ping', name: 'Real master', master: true }],
        },
        'test',
      );
      const picky = new ProvisionService({
        objects: harness.service,
        templates: held.seal(),
        logger: silentLogger,
        credentialsFor: () => Promise.resolve(credentials),
        recordDevice: () => Promise.resolve(),
      });

      const record = await run();
      const report = await picky.provision({
        run: record,
        hosts: [host('10.0.0.1', { sysDescr: 'Linux one 5.15' })],
        existingDevices: [],
        existingSensors: [],
        actor: testActor,
        credentials: { kind: 'installation' },
      });
      assert.equal(report.mastersSet, 1);
      const device = report.devices[0];
      assert.ok(device !== undefined);
      const master = await masterOf(device.deviceId);
      const rows = await db.query<{ name: string }>(`SELECT name FROM object WHERE id = $1`, [
        master,
      ]);
      assert.equal(rows[0]?.name, 'Real master');
    });

    it('leaves a device with no master when nothing reachable could be created', async () => {
      // A master that cannot scan would pause every sensor on the device for ever, so a template
      // whose master spec was filtered out — closed port, missing credential — gets none.
      const held = new DeviceTemplateCatalogue(() => true);
      held.register(
        {
          id: 'test.nomaster',
          name: 'No master',
          description: '',
          match: {},
          sensors: [
            { type: 'icmp.ping', name: 'Ping', master: true, requires: { portsAll: [9999] } },
            { type: 'core.factory', name: 'Rollup' },
          ],
        },
        'test',
      );
      const withoutMaster = new ProvisionService({
        objects: harness.service,
        templates: held.seal(),
        logger: silentLogger,
        credentialsFor: () => Promise.resolve(credentials),
        recordDevice: () => Promise.resolve(),
      });

      const record = await run();
      const report = await withoutMaster.provision({
        run: record,
        hosts: [host('10.0.0.1')],
        existingDevices: [],
        existingSensors: [],
        actor: testActor,
        credentials: { kind: 'installation' },
      });
      assert.equal(report.mastersSet, 0);
      assert.deepEqual(report.problems, [], 'and it is not an error');
      assert.equal(await masterOf(report.devices[0]?.deviceId ?? 0), null);
    });

    it('sets one master even when several templates mark one', async () => {
      // Which one won would otherwise depend on template order, and a dependency that moves when
      // somebody reorders a file is worse than no dependency at all.
      const record = await run();
      // `test.generic` and `test.linux` both mark their Ping; `plan` deduplicates to one spec.
      const report = await provision([host('10.0.0.1', { sysDescr: 'Linux one 5.15' })], record);
      assert.equal(report.mastersSet, 1);
    });
  });

  describe('a run whose rule was deleted (A-41)', () => {
    // Nobody stands behind the addresses such a run found: its rule's writer vouched for sending
    // the group's credentials there, and deleting the rule withdraws that. So it creates nothing,
    // and it says why — the run fails with the reason, and the audit records it.
    let sent: DispatchMessage[] = [];
    let clock = new Date('2026-08-31T00:00:00Z');
    let authRequired = true;
    let writer: Actor;
    let runs: DiscoveryService;
    let rules: RediscoveryService;

    const unattended: Actor = { kind: 'anonymous', remoteAddress: 'scheduled-rediscovery' };

    /** What `main.ts` gives `provisionRun`, over this file's tree. */
    const wiring = (): RunProvisioning => ({
      discovery: runs,
      provisioner,
      existing,
      vouchers: {
        authRequired,
        ruleWriter: (ruleId) => rules.writerOf(ruleId),
        rights: () => Promise.resolve(new Map<number, 'none'>()),
      },
    });

    beforeEach(async () => {
      sent = [];
      clock = new Date('2026-08-31T00:00:00Z');
      authRequired = true;
      const [person] = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, password_hash, role)
         VALUES ('rule-writer-' || $1, 'x', 'readwrite') RETURNING id::text`,
        [String(process.hrtime.bigint())],
      );
      writer = { kind: 'user', userId: Number(person?.id), login: 'rule-writer' };
      runs = new DiscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        dispatch: (_probe, message) => {
          sent.push(message);
          return { kind: 'sent' };
        },
        onFinished: async (runId) => {
          await rules.runFinished(runId);
        },
      });
      rules = new RediscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        discovery: runs,
        windowFor: () => Promise.resolve(null),
        provision: async (runId) => {
          await provisionRun(wiring(), runId, unattended);
        },
        now: () => clock,
      });
    });

    /** A rule that has fired, and its run, which has swept two live hosts and not finished. */
    const firing = async (autoProvision: boolean): Promise<{ ruleId: number; runId: number }> => {
      const rule = await rules.create(
        {
          groupId,
          probeId,
          name: 'Nightly',
          range: '10.0.0.0/29',
          cadence: 'daily',
          cadenceMinute: 3 * 60,
          timezone: 'UTC',
          level: 'ping',
          autoProvision,
          enabled: true,
        },
        writer,
      );
      clock = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rules.tick(), 1);
      const runId = (await rules.get(rule.id))?.lastRunId ?? assert.fail('the rule started no run');
      await runs.progress(
        probeId,
        runId,
        6,
        [
          { address: '10.0.0.1', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 1 },
        ],
        0,
      );
      return { ruleId: rule.id, runId };
    };

    const count = async (sql: string, values: unknown[] = []): Promise<number> => {
      const [row] = await db.query<{ n: string }>(sql, values);
      return Number(row?.n);
    };
    const objectsInGroup = (): Promise<number> =>
      count(
        `WITH RECURSIVE below AS (
           SELECT id FROM object WHERE parent_id = $1
           UNION ALL SELECT o.id FROM object o JOIN below b ON o.parent_id = b.id
         )
         SELECT count(*)::text AS n FROM below`,
        [groupId],
      );
    const failures = async (runId: number): Promise<Record<string, unknown>[]> =>
      (
        await db.query<{ summary: Record<string, unknown> }>(
          `SELECT summary FROM audit_log
           WHERE action = 'discovery.failed' AND (summary->>'runId')::bigint = $1`,
          [runId],
        )
      ).map((row) => row.summary);

    it('provisions what its rule found while the rule is there', async () => {
      // What the cases below would see if deleting the rule changed nothing.
      const { runId } = await firing(true);
      await runs.finished(probeId, runId, 'done', 8, '');
      assert.equal((await runs.get(runId))?.status, 'done');
      assert.equal(await objectsInGroup(), 4, 'two devices, each with its Ping');
    });

    it('creates nothing, pages nobody, and fails with the reason when the rule goes mid-run', async () => {
      const requests = await count('SELECT count(*)::text AS n FROM notification_request');
      const { ruleId, runId } = await firing(true);
      assert.equal(await rules.remove(ruleId, writer), true);
      assert.ok(
        sent.some((message) => message.kind === 'cancel' && message.runId === runId),
        'the probe is told to stop',
      );

      // It had not heard yet, and reports the sweep done.
      await runs.finished(probeId, runId, 'done', 8, '');

      const ended = await runs.get(runId);
      assert.ok(ended !== null);
      assert.equal(ended.status, 'failed');
      assert.equal(ended.message, 'its rule was deleted');
      assert.equal(await objectsInGroup(), 0, 'not one object');
      // Nothing exists that could go Unknown, and nothing was asked to page.
      assert.equal(await count('SELECT count(*)::text AS n FROM notification_request'), requests);
      assert.deepEqual(await failures(runId), [
        { runId, range: '10.0.0.0/29', reason: 'its rule was deleted' },
      ]);
    });

    it('fails a finished run whose rule is gone when it is asked to provision, and creates nothing', async () => {
      const { ruleId, runId } = await firing(false);
      await runs.finished(probeId, runId, 'done', 8, '');
      assert.equal(await rules.remove(ruleId, writer), true);
      assert.equal((await runs.get(runId))?.status, 'done', 'a finished run is left finished');

      // An operator with write on the group asks for it anyway.
      await assert.rejects(
        provisionRun(wiring(), runId, writer),
        (error: unknown) =>
          error instanceof DiscoveryError &&
          error.code === 'DISCOVERY_RUN_FAILED' &&
          error.status === 409 &&
          error.message.includes('its rule was deleted'),
      );
      const ended = await runs.get(runId);
      assert.ok(ended !== null);
      assert.equal(ended.status, 'failed');
      assert.equal(ended.message, 'its rule was deleted');
      assert.equal(await objectsInGroup(), 0);

      // Asking again is refused the same way and records nothing twice.
      await assert.rejects(provisionRun(wiring(), runId, writer), /its rule was deleted/);
      assert.equal((await failures(runId)).length, 1);
    });

    it('keeps a run it failed failed, and unprovisioned, when its probe reports it done', async () => {
      // `failed` is terminal whatever the reason and whether or not the rule is still there: a
      // run the core ended must not come back `done` and be provisioned by its rule.
      const { runId } = await firing(true);
      await runs.fail(runId, 'its group moved to another probe', writer);
      await runs.finished(probeId, runId, 'done', 8, '');
      const ended = await runs.get(runId);
      assert.ok(ended !== null);
      assert.equal(ended.status, 'failed');
      assert.equal(ended.message, 'its group moved to another probe');
      assert.equal(await objectsInGroup(), 0);
    });

    it('with the authorisation layer off, provisions it as the installation, as before', async () => {
      authRequired = false;
      const { ruleId, runId } = await firing(false);
      await runs.finished(probeId, runId, 'done', 8, '');
      assert.equal(await rules.remove(ruleId, writer), true);
      const report = await provisionRun(wiring(), runId, writer);
      assert.equal(report.devicesCreated, 2);
      assert.equal((await runs.get(runId))?.status, 'done');
      assert.deepEqual(await failures(runId), []);
    });
  });
});
