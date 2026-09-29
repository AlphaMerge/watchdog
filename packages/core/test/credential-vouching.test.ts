import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService, Visibility, type AccessRight } from '../src/auth/access.js';
import { AccountService, type AccountRole } from '../src/auth/accounts.js';
import { AuthError } from '../src/auth/errors.js';
import { GroupService } from '../src/auth/groups.js';
import type { Database } from '../src/db/pool.js';
import {
  CredentialVouching,
  WITHHELD_CREDENTIALS,
  declarationsOf,
  destinationOf,
  recipeOf,
  routesAtOrUnder,
  storedAccountWrites,
  verdictFor,
  type CredentialRoute,
  type CredentialTypes,
  type RouteVerdict,
} from '../src/objects/credential-vouching.js';
import { ObjectError } from '../src/objects/errors.js';
import type { Writer } from '../src/objects/sensor-reads.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { SensorVouching } from '../src/objects/vouching.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';

/**
 * Who stands behind sending a sensor its inherited credentials where it sends them (`A-41`).
 *
 * An administrator stores SNMP credentials on a group, and every sensor beneath uses them. An
 * operator who may write one device there must not be able to point it at a machine of their own
 * and be sent the community. The rules first, without a database; then every write that can
 * bring a set somewhere new, against real grants; then what a probe is sent when a grant is taken
 * away; then the secrets in a sensor's own parameters; then the boot step.
 */

// ── the rules, without a database ────────────────────────────────────────────────────────────

describe('what a write does about one sensor and kind (A-41)', () => {
  const route = (
    vouched: CredentialRoute['vouched'],
  ): Pick<CredentialRoute, 'ownerId' | 'destination' | 'vouched'> => ({
    ownerId: 12,
    destination: 'here',
    vouched,
  });
  const byInstallation = { kind: 'installation' } as const;
  const byAccount = { kind: 'account', userId: 7 } as const;

  const table: [string, CredentialRoute['vouched'], boolean, RouteVerdict][] = [
    ['nothing recorded, and the writer can vouch', null, true, 'vouch'],
    ['nothing recorded, and the writer cannot', null, false, 'refuse'],
    [
      'unchanged and the installation’s, whoever writes',
      { ownerId: 12, destination: 'here', voucher: byInstallation },
      true,
      'keep',
    ],
    [
      'unchanged and the installation’s, and the writer cannot vouch',
      { ownerId: 12, destination: 'here', voucher: byInstallation },
      false,
      'keep',
    ],
    [
      'unchanged and an account’s, and the writer can vouch: recorded again',
      { ownerId: 12, destination: 'here', voucher: byAccount },
      true,
      'vouch',
    ],
    [
      'unchanged and an account’s, and the writer cannot: a rename sends nothing anywhere',
      { ownerId: 12, destination: 'here', voucher: byAccount },
      false,
      'keep',
    ],
    [
      'somewhere new, and the writer cannot',
      { ownerId: 12, destination: 'there', voucher: byInstallation },
      false,
      'refuse',
    ],
    [
      'another owner’s set, and the writer cannot',
      { ownerId: 13, destination: 'here', voucher: byInstallation },
      false,
      'refuse',
    ],
    [
      'somewhere new, and the writer can',
      { ownerId: 12, destination: 'there', voucher: byAccount },
      true,
      'vouch',
    ],
  ];
  for (const [name, vouched, mayVouch, expected] of table) {
    it(name, () => {
      assert.equal(verdictFor(route(vouched), mayVouch), expected);
    });
  }
});

describe('where a set is sent, as a fingerprint (A-41)', () => {
  const base = {
    probeId: 1,
    host: '192.0.2.10',
    ipVersion: 'auto',
    fields: [['port', 161]] as const,
  };

  it('is the same for the same place, and different for any part of it', () => {
    assert.equal(destinationOf(base), destinationOf({ ...base, fields: [['port', 161]] }));
    const others = [
      { ...base, probeId: 2 },
      { ...base, probeId: null },
      { ...base, host: '192.0.2.11' },
      { ...base, ipVersion: 'v6' },
      { ...base, fields: [['port', 1161]] as const },
      { ...base, fields: [] as const },
    ];
    const seen = new Set([destinationOf(base), ...others.map((one) => destinationOf(one))]);
    assert.equal(seen.size, others.length + 1);
  });

  it('has a recipe that moves when a type changes what it says about a kind', () => {
    const declaring = (fields: readonly string[]): CredentialTypes => ({
      credentialedTypes: () => ['snmp.traffic'],
      credentialKinds: () => ['snmp'],
      credentialDestination: () => fields.map((field) => [field, null] as const),
    });
    assert.equal(recipeOf(declaring(['port'])), recipeOf(declaring(['port'])));
    assert.notEqual(recipeOf(declaring(['port'])), recipeOf(declaring(['port', 'version'])));
    assert.notEqual(recipeOf(declaring(['port'])), recipeOf(declaring([])));
  });

  it('keeps what a recipe declared, so the next release can compute its fingerprints', () => {
    const recipe = recipeOf({
      credentialedTypes: () => ['snmp.traffic', 'http.basic'],
      credentialKinds: (type) => (type === 'http.basic' ? ['http', 'snmp'] : ['snmp']),
      credentialDestination: (type, kind) =>
        (type === 'http.basic' && kind === 'http' ? ['port', 'tls.verify'] : ['port']).map(
          (field) => [field, null] as const,
        ),
    });
    assert.deepEqual(
      declarationsOf(recipe),
      new Map([
        [JSON.stringify(['http.basic', 'http']), ['port', 'tls.verify']],
        [JSON.stringify(['http.basic', 'snmp']), ['port']],
        [JSON.stringify(['snmp.traffic', 'snmp']), ['port']],
      ]),
    );
    // Nothing to compute from: migration 060's empty recipe, one this build cannot read, and one
    // made by another version of the fingerprint.
    for (const unusable of ['', 'not json', '{}', '[2, []]', '[1, [["t", [["k", [1]]]]]]']) {
      assert.equal(declarationsOf(unusable), null, unusable);
    }
  });
});

// ── against a real tree and real grants ──────────────────────────────────────────────────────

const available = await databaseAvailable();

interface Person {
  readonly id: number;
  readonly login: string;
  readonly role: AccountRole;
}

describe(
  'bringing an inherited credential set somewhere new (A-41)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let access: AccessService;
    let accounts: AccountService;
    let groups: GroupService;
    let vouching: SensorVouching;
    let credentials: CredentialVouching;
    let config: ProbeConfigService;

    const gate = catalogueSensorTypeGate(testCatalogue());
    const administrator = actorNamed('admin');

    /**
     * site (probe) ─ datacentre (group: the SNMP set; the team reads it)
     *                 └ racks (the team writes it) ─ switch (192.0.2.10) ─ traffic
     *              ─ branch (the team writes it; no set) ─ edge (192.0.2.20) ─ edge-traffic
     * remote (probe: the team writes it) ─ far (group)
     */
    let site = 0;
    let datacentre = 0;
    let racks = 0;
    let branch = 0;
    let remote = 0;
    let far = 0;
    let team = 0;
    let operator: Person;
    let admin: Person;

    const rights = (
      principal: { userId: number; role: AccountRole },
      objectIds: readonly number[],
      q: Parameters<AccessService['resolveManyFor']>[2],
    ): Promise<Map<number, AccessRight>> => access.resolveManyFor(principal, objectIds, q);

    /** A writer as a route builds one, for an account with grants. */
    async function as(person: Person): Promise<Writer> {
      return {
        kind: 'user',
        userId: person.id,
        login: person.login,
        voucher: {
          kind: 'account',
          userId: person.id,
          sees: await access.visibilityFor({ userId: person.id, role: person.role }),
          writes: storedAccountWrites(rights, person.id),
        },
      };
    }

    const create = async (writer: Writer, input: Record<string, unknown>): Promise<number> =>
      (await h.service.create(writer, input as never)).id;

    async function device(parentId: number, name: string, host: string): Promise<number> {
      return create(testActor, { kind: 'device', parentId, name, host });
    }

    async function traffic(parentId: number, name: string, extra = {}): Promise<number> {
      return create(testActor, {
        kind: 'sensor',
        parentId,
        name,
        sensorType: 'snmp.traffic',
        params: { port: 161, ...extra },
      });
    }

    async function hostOf(id: number): Promise<string> {
      const [row] = await db.query<{ host: string }>(
        'SELECT host FROM device_config WHERE object_id = $1',
        [id],
      );
      return row?.host ?? assert.fail(`no device ${String(id)}`);
    }

    async function recorded(
      sensorId: number,
    ): Promise<{ owner: number; by: string; user: number | null } | null> {
      const [row] = await db.query<{ owner: string; by: string; user: string | null }>(
        `SELECT owner_id::text AS owner, vouched_by AS by, vouched_by_user::text AS user
         FROM sensor_credential_voucher WHERE sensor_id = $1 AND kind = 'snmp'`,
        [sensorId],
      );
      if (row === undefined) return null;
      return {
        owner: Number(row.owner),
        by: row.by,
        user: row.user === null ? null : Number(row.user),
      };
    }

    async function runtimeOf(sensorId: number): Promise<{ state: string; message: string }> {
      const [row] = await db.query<{ state: string; message: string }>(
        `SELECT state::text AS state, message FROM sensor_runtime WHERE object_id = $1`,
        [sensorId],
      );
      return row ?? assert.fail(`sensor ${String(sensorId)} has no runtime`);
    }

    /** Measured, and Up, so that a withheld sensor is a change of state. */
    async function up(sensorId: number): Promise<void> {
      const states = h.states ?? assert.fail('no state service');
      const decisions = await states.decide([
        { sensorId, at: new Date(), outcome: 'ok', message: 'ok' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** Whether `site`'s configuration carries this sensor, and with its credentials. */
    async function sent(sensorId: number, probe = site): Promise<'with' | 'without' | 'absent'> {
      const assignment = (await config.assignmentsFor(probe)).sensors.find(
        (one) => one.sensorId === sensorId,
      );
      if (assignment === undefined) return 'absent';
      return assignment.credentials?.['snmp'] === undefined ? 'without' : 'with';
    }

    function refusedWith(pattern: RegExp): (error: unknown) => boolean {
      return (error) => {
        assert.ok(error instanceof AuthError, `expected an AuthError, got ${String(error)}`);
        assert.equal(error.code, 'AUTH_FORBIDDEN');
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /dc-secret|racks-secret/, 'never the secret');
        return true;
      };
    }

    /** The next release, which also names `timeout` as where `snmp.traffic` sends its set. */
    function nextRelease(): CredentialVouching {
      const declared = (type: string, kind: string): string[] => [
        ...gate.credentialDestination(type, kind, {}).map(([field]) => field),
        'timeout',
      ];
      const widened: CredentialTypes = {
        credentialedTypes: () => gate.credentialedTypes(),
        credentialKinds: (type) => gate.credentialKinds(type),
        credentialDestination: (type, kind, params, fields) =>
          gate.credentialDestination(type, kind, params, fields ?? declared(type, kind)),
      };
      return new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: widened,
        rights,
        vouching,
        audit: new DatabaseAuditSink(),
      });
    }

    async function lastAuditId(): Promise<number> {
      const [row] = await db.query<{ id: string | null }>(
        'SELECT max(id)::text AS id FROM audit_log',
      );
      return Number(row?.id ?? 0);
    }

    /** What the boot step wrote to the audit log since, one entry per kind. */
    async function adoptionsSince(id: number): Promise<Record<string, unknown>[]> {
      const rows = await db.query<{ summary: Record<string, unknown>; object_id: string | null }>(
        `SELECT summary, object_id FROM audit_log
         WHERE action = 'credential.adopted' AND id > $1 ORDER BY id`,
        [id],
      );
      for (const row of rows) assert.equal(row.object_id, null, 'about no one object');
      return rows.map((row) => row.summary);
    }

    before(async () => {
      scratch = await createScratchDatabase('credential_vouching');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        withheldSensors: () => vouching.withheld(),
      });
      accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const states = h.states ?? assert.fail('no state service');
      vouching = new SensorVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        sight: (principal, q) => access.visibilityFor(principal, q),
        states,
      });
      credentials = new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        rights,
        vouching,
        audit: new DatabaseAuditSink(),
      });
      // What a fresh database is: nothing in use, so nothing for the boot step to adopt.
      await credentials.adopt();
      config = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
        vault: h.vault,
        credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
        credentialCheck: credentials,
      });

      site = await create(testActor, { kind: 'probe', parentId: h.rootId, name: 'site' });
      datacentre = await create(testActor, { kind: 'group', parentId: site, name: 'datacentre' });
      racks = await create(testActor, { kind: 'group', parentId: datacentre, name: 'racks' });
      branch = await create(testActor, { kind: 'group', parentId: site, name: 'branch' });
      remote = await create(testActor, { kind: 'probe', parentId: h.rootId, name: 'remote' });
      far = await create(testActor, { kind: 'group', parentId: remote, name: 'far' });

      team = (await groups.create({ name: 'Operators' }, testActor)).id;
      await access.grant(site, team, 'read', administrator);
      await access.grant(racks, team, 'write', administrator);
      await access.grant(branch, team, 'write', administrator);
      await access.grant(remote, team, 'write', administrator);
      const made = await accounts.create(
        { login: 'operator', password: 'correct-horse-battery', role: 'readwrite' },
        testActor,
      );
      await groups.addMember(team, made.id, testActor);
      operator = { id: made.id, login: 'operator', role: 'readwrite' };
      const root = await accounts.create(
        { login: 'root', password: 'correct-horse-battery', role: 'admin' },
        testActor,
      );
      const admins = (await groups.list()).find((group) => group.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, root.id, testActor);
      admin = { id: root.id, login: 'root', role: 'admin' };

      await h.service.setCredential(testActor, datacentre, 'snmp', {
        version: 'v2c',
        community: 'dc-secret',
      });
    });

    after(async () => {
      await scratch.drop();
    });

    /** A fresh device and sensor under `racks`, and one under `branch`, for each test. */
    let rackSwitch = 0;
    let rackTraffic = 0;
    let edge = 0;
    let edgeTraffic = 0;
    beforeEach(async () => {
      const suffix = String(process.hrtime.bigint());
      rackSwitch = await device(racks, `switch-${suffix}`, '192.0.2.10');
      rackTraffic = await traffic(rackSwitch, 'traffic');
      edge = await device(branch, `edge-${suffix}`, '192.0.2.20');
      edgeTraffic = await traffic(edge, 'edge-traffic', { community: 'edge-param-secret' });
    });

    // ── the writes ─────────────────────────────────────────────────────────────────────────

    it('records the installation as voucher for what the system writes', async () => {
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'installation',
        user: null,
      });
      assert.equal(await recorded(edgeTraffic), null, 'no set reaches it, so nothing to vouch');
    });

    it('refuses to point a device elsewhere without write on where its set is stored', async () => {
      await assert.rejects(
        h.service.update(
          await as(operator),
          rackSwitch,
          { kind: 'device', host: '203.0.113.66' },
          { kind: 'none' },
        ),
        refusedWith(
          /^sensor "traffic": bringing the snmp credentials on group "datacentre" \(#\d+\) to 203\.0\.113\.66 \(port 161\) needs write on that group$/,
        ),
      );
      assert.equal(await hostOf(rackSwitch), '192.0.2.10', 'and nothing changed');
      await assert.rejects(
        h.service.update(
          await as(operator),
          rackSwitch,
          { kind: 'device', ipVersion: 'v6' },
          { kind: 'none' },
        ),
        refusedWith(/needs write on that group/),
        'the address family is part of where',
      );
    });

    it('lets the same writer rename the device, which sends nothing anywhere new', async () => {
      await h.service.update(
        await as(operator),
        rackSwitch,
        { kind: 'device', name: 'renamed' },
        { kind: 'none' },
      );
      assert.equal((await recorded(rackTraffic))?.by, 'installation');
    });

    it('refuses the port a sensor sends the set to, and not its name', async () => {
      await assert.rejects(
        h.service.update(
          await as(operator),
          rackTraffic,
          { kind: 'sensor', params: { port: 1161 } },
          { kind: 'none' },
        ),
        refusedWith(/^bringing the snmp credentials on group "datacentre" .* \(port 1161\)/),
      );
      await h.service.update(
        await as(operator),
        rackTraffic,
        { kind: 'sensor', name: 'renamed', params: { port: 161 } },
        { kind: 'none' },
      );
      assert.equal(
        (await recorded(rackTraffic))?.by,
        'installation',
        'saved unchanged: the installation still vouches',
      );
    });

    it('refuses a new sensor under the set, and not one that is sent none', async () => {
      await assert.rejects(
        create(await as(operator), {
          kind: 'sensor',
          parentId: rackSwitch,
          name: 'more traffic',
          sensorType: 'snmp.traffic',
          params: { port: 161 },
        }),
        refusedWith(/^bringing the snmp credentials on group "datacentre"/),
      );
      const [none] = await db.query(
        `SELECT 1 FROM object WHERE parent_id = $1 AND name = 'more traffic'`,
        [rackSwitch],
      );
      assert.equal(none, undefined, 'the create was rolled back');
      await create(await as(operator), {
        kind: 'sensor',
        parentId: rackSwitch,
        name: 'ping',
        sensorType: 'icmp.ping',
      });
    });

    it('refuses a created tree that would carry the set, naming the sensor', async () => {
      await assert.rejects(
        h.service.createTree(await as(operator), {
          parentId: racks,
          nodes: [
            { ref: 'd', kind: 'device', name: 'new', host: '203.0.113.7' },
            {
              kind: 'sensor',
              parentRef: 'd',
              name: 'new traffic',
              sensorType: 'snmp.traffic',
              params: { port: 161 },
            },
          ],
        } as never),
        refusedWith(/^sensor "new traffic": bringing the snmp credentials/),
      );
    });

    it('refuses to move or clone a device in under the set', async () => {
      await assert.rejects(
        h.service.move(await as(operator), edge, racks, { kind: 'none' }),
        refusedWith(/^sensor "edge-traffic": bringing the snmp credentials on group "datacentre"/),
      );
      await assert.rejects(
        h.service.clone(await as(operator), edge, { targetParentId: racks }, Visibility.EVERYTHING),
        refusedWith(/^sensor "edge-traffic": bringing the snmp credentials/),
      );
      // Out from under it is nothing new for anybody.
      await h.service.clone(
        await as(operator),
        rackSwitch,
        { targetParentId: branch },
        Visibility.EVERYTHING,
      );
    });

    it('lets an account with write on the set’s owner do all of it, and records it', async () => {
      const writer = await as(admin);
      await h.service.update(
        writer,
        rackSwitch,
        { kind: 'device', host: '198.51.100.10' },
        { kind: 'none' },
      );
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'account',
        user: admin.id,
      });
      await h.service.move(writer, edge, racks, { kind: 'none' });
      assert.deepEqual(await recorded(edgeTraffic), {
        owner: datacentre,
        by: 'account',
        user: admin.id,
      });
    });

    it('lets whoever writes a set vouch for everything beneath that it reaches', async () => {
      await h.service.setCredential(await as(operator), racks, 'snmp', {
        version: 'v2c',
        community: 'racks-secret',
      });
      try {
        assert.deepEqual(await recorded(rackTraffic), {
          owner: racks,
          by: 'account',
          user: operator.id,
        });
        // Their set, so theirs to point.
        await h.service.update(
          await as(operator),
          rackSwitch,
          { kind: 'device', host: '203.0.113.66' },
          { kind: 'none' },
        );

        // Taking it away hands the switch to the datacentre's set, at a host nobody with write
        // on the datacentre vouched for.
        await assert.rejects(
          h.service.clearCredential(await as(operator), racks, 'snmp'),
          refusedWith(/^sensor "[^"]+": bringing the snmp credentials on group "datacentre"/),
        );
        const [still] = await db.query(
          `SELECT 1 FROM credential_set WHERE object_id = $1 AND kind = 'snmp'`,
          [racks],
        );
        assert.ok(still !== undefined, 'the set is still there');
      } finally {
        await h.service.clearCredential(await as(admin), racks, 'snmp');
      }
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'account',
        user: admin.id,
      });
    });

    // ── what a probe is sent ───────────────────────────────────────────────────────────────

    it('stops sending the set when the voucher loses write, and holds the sensor Unknown', async () => {
      await h.service.setCredential(await as(operator), racks, 'snmp', {
        version: 'v2c',
        community: 'racks-secret',
      });
      try {
        await up(rackTraffic);
        assert.equal(await sent(rackTraffic), 'with');

        await access.grant(racks, team, 'read', administrator);
        assert.equal(await sent(rackTraffic), 'absent', 'not sent without it either');
        assert.deepEqual(await runtimeOf(rackTraffic), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.lostWrite,
        });
        assert.equal(vouching.withheld().get(rackTraffic), WITHHELD_CREDENTIALS.lostWrite);
        await assert.rejects(
          config.assignmentFor(rackTraffic),
          (error: unknown) =>
            error instanceof ObjectError &&
            error.code === 'OBJECT_CREDENTIALS_WITHHELD' &&
            error.status === 409 &&
            error.message === WITHHELD_CREDENTIALS.lostWrite,
          'and "check now" says so rather than failing to log in',
        );

        await access.grant(racks, team, 'write', administrator);
        assert.equal(await sent(rackTraffic), 'with');
        assert.equal(vouching.withheld().has(rackTraffic), false);
      } finally {
        await access.grant(racks, team, 'write', administrator);
        await h.service.clearCredential(await as(admin), racks, 'snmp');
      }
    });

    it('withholds for a disabled account, a deleted one, and a record that no longer matches', async () => {
      const leaver = await accounts.create(
        {
          login: `leaver-${String(process.hrtime.bigint())}`,
          password: 'correct-horse-battery',
          role: 'admin',
        },
        testActor,
      );
      const admins = (await groups.list()).find((group) => group.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, leaver.id, testActor);
      await h.service.update(
        await as({ id: leaver.id, login: leaver.login, role: 'admin' }),
        rackSwitch,
        { kind: 'device', host: '198.51.100.99' },
        { kind: 'none' },
      );
      assert.equal(await sent(rackTraffic), 'with');

      await accounts.update(leaver.id, { disabled: true }, testActor);
      assert.equal(await sent(rackTraffic), 'absent');
      assert.equal(vouching.withheld().get(rackTraffic), WITHHELD_CREDENTIALS.disabled);

      await accounts.delete(leaver.id, testActor);
      assert.equal(await sent(rackTraffic), 'absent');
      assert.equal(vouching.withheld().get(rackTraffic), WITHHELD_CREDENTIALS.deleted);

      // Saving the sensor again, as an account that can, vouches for it.
      await h.service.update(
        await as(admin),
        rackTraffic,
        { kind: 'sensor', params: { port: 161 } },
        { kind: 'none' },
      );
      assert.equal(await sent(rackTraffic), 'with');

      // A record changed behind the core's back is not a voucher for where the sensor goes.
      await db.query(
        `UPDATE sensor_credential_voucher SET destination = 'elsewhere' WHERE sensor_id = $1`,
        [rackTraffic],
      );
      assert.equal(await sent(rackTraffic), 'absent');
      assert.equal(vouching.withheld().get(rackTraffic), WITHHELD_CREDENTIALS.unvouched);
      await db.query('DELETE FROM sensor_credential_voucher WHERE sensor_id = $1', [rackTraffic]);
      assert.equal(await sent(rackTraffic), 'absent');
      assert.equal(vouching.withheld().get(rackTraffic), WITHHELD_CREDENTIALS.unvouched);

      await h.service.update(
        testActor,
        rackTraffic,
        { kind: 'sensor', params: { port: 161 } },
        { kind: 'none' },
      );
      assert.equal(await sent(rackTraffic), 'with');
    });

    it('releases a sensor that moves to another probe, whichever probe is asked first', async () => {
      // `A-29`'s set is shared, and one probe's answer must not clear another's.
      await vouching.settle('credentials:elsewhere', new Map([[edgeTraffic, 'held elsewhere']]));
      await vouching.settle(`credentials:${String(site)}`, new Map([[edgeTraffic, 'held here']]));
      await vouching.settle(`credentials:${String(site)}`, new Map());
      assert.equal(vouching.withheld().get(edgeTraffic), 'held elsewhere');
      await vouching.settle('credentials:elsewhere', new Map());
      assert.equal(vouching.withheld().has(edgeTraffic), false);
    });

    // ── the secrets in a sensor's own parameters ───────────────────────────────────────────

    async function paramsOf(sensorId: number): Promise<Record<string, unknown>> {
      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensorId],
      );
      return row?.params ?? assert.fail('no sensor');
    }

    it('clears a community a device’s new host would receive, and says so', async () => {
      h.audit.recorded.length = 0;
      await h.service.update(
        await as(operator),
        edge,
        { kind: 'device', host: '203.0.113.20' },
        { kind: 'none' },
      );
      assert.deepEqual(await paramsOf(edgeTraffic), { port: 161 });
      const entry = h.audit.recorded.find(
        (one) => one.action === 'object.updated' && one.objectId === edgeTraffic,
      );
      assert.ok(entry?.action === 'object.updated');
      assert.deepEqual(entry.secretsCleared, ['community']);
      assert.deepEqual(entry.changedParams, ['community']);
      assert.equal(
        h.audit.recorded.findIndex((one) => one.objectId === edge),
        0,
        'after the device’s own entry',
      );
    });

    it('keeps it through a rename and a move that sends it nowhere new', async () => {
      await h.service.update(
        await as(operator),
        edge,
        { kind: 'device', name: 'still the edge' },
        { kind: 'none' },
      );
      const same = await create(testActor, { kind: 'group', parentId: site, name: 'same probe' });
      await h.service.move(testActor, edge, same, { kind: 'none' });
      assert.equal((await paramsOf(edgeTraffic))['community'], 'edge-param-secret');
    });

    it('clears it on a move or a clone to another probe, and a sensor moved to another device', async () => {
      await h.service.move(await as(operator), edge, far, { kind: 'none' });
      assert.equal((await paramsOf(edgeTraffic))['community'], undefined);

      const again = await traffic(edge, 'again', { community: 'again-secret' });
      const copy = await h.service.clone(
        testActor,
        edge,
        { targetParentId: branch },
        Visibility.EVERYTHING,
      );
      const [cloned] = await db.query<{ params: Record<string, unknown> }>(
        `SELECT sc.params FROM object o JOIN sensor_config sc ON sc.object_id = o.id
         WHERE o.parent_id = $1 AND o.name = 'again'`,
        [copy.object.id],
      );
      assert.equal(cloned?.params['community'], undefined, 'the copy went to another probe');
      assert.equal((await paramsOf(again))['community'], 'again-secret', 'the source kept it');

      const other = await device(far, `other-${String(process.hrtime.bigint())}`, '203.0.113.30');
      await h.service.move(testActor, again, other, { kind: 'none' });
      assert.equal((await paramsOf(again))['community'], undefined);
    });

    it('asks only about the kinds each sensor’s own type uses', async () => {
      // One sensor under the SNMP set whose type says it uses SSH, and one whose type says SNMP.
      // The first is sent no SNMP set, so nothing about it may be vouched for or refused.
      const ping = await create(testActor, {
        kind: 'sensor',
        parentId: rackSwitch,
        name: 'ping',
        sensorType: 'icmp.ping',
      });
      const crossed: CredentialTypes = {
        credentialedTypes: () => ['icmp.ping', 'snmp.traffic'],
        credentialKinds: (type) => (type === 'icmp.ping' ? ['snmp'] : ['ssh']),
        credentialDestination: () => [],
      };
      const routes = await routesAtOrUnder(db, crossed, [rackSwitch]);
      assert.deepEqual(
        routes.map((route) => [route.sensorId, route.kind]),
        [[ping, 'snmp']],
      );
    });

    it('lets a disabled account write nothing, whatever it was granted', async () => {
      // How a discovery run's account is asked: by id, with no request to carry its rights.
      const leaver = await accounts.create(
        {
          login: `leaver-${String(process.hrtime.bigint())}`,
          password: 'correct-horse-battery',
          role: 'readwrite',
        },
        testActor,
      );
      await groups.addMember(team, leaver.id, testActor);
      const writes = storedAccountWrites(rights, leaver.id);
      assert.deepEqual([...(await writes(db, [racks, datacentre]))], [racks]);
      await accounts.update(leaver.id, { disabled: true }, testActor);
      assert.deepEqual([...(await writes(db, [racks, datacentre]))], []);
      await accounts.delete(leaver.id, testActor);
      assert.deepEqual([...(await writes(db, [racks]))], [], 'nor a deleted one');
    });

    // ── the boot step ──────────────────────────────────────────────────────────────────────

    it('adopts what is in use once, as the installation, and never again', async () => {
      await db.query('DELETE FROM sensor_credential_voucher');
      await db.query(`UPDATE credential_voucher_adoption SET pending = true, recipe = ''`);

      const since = await lastAuditId();
      const first = await credentials.adopt();
      assert.ok(first.adopted >= 1);
      assert.deepEqual(
        await adoptionsSince(since),
        [{ credentialKind: 'snmp', installation: first.adopted, carried: 0, withheld: 0 }],
        'one entry for the kind, however many sensors',
      );
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'installation',
        user: null,
      });
      assert.equal(await sent(rackTraffic), 'with');
      assert.deepEqual(
        await db.query(
          `SELECT pending, recipe <> '' AS "recipeRecorded" FROM credential_voucher_adoption`,
        ),
        [{ pending: false, recipeRecorded: true }],
      );
      assert.deepEqual(await credentials.adopt(), { adopted: 0, refingerprinted: 0, withheld: 0 });
      assert.deepEqual(await adoptionsSince(since), [
        { credentialKind: 'snmp', installation: first.adopted, carried: 0, withheld: 0 },
      ]);
    });

    it('keeps what a write recorded before the boot step ran', async () => {
      await h.service.update(
        await as(admin),
        rackSwitch,
        { kind: 'device', host: '198.51.100.77' },
        { kind: 'none' },
      );
      await db.query(`UPDATE credential_voucher_adoption SET pending = true`);
      await credentials.adopt();
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'account',
        user: admin.id,
      });
    });

    it('re-fingerprints, keeping the voucher, when a release changes what a type declares', async () => {
      await h.service.update(
        await as(admin),
        rackSwitch,
        { kind: 'device', host: '198.51.100.78' },
        { kind: 'none' },
      );
      const next = nextRelease();
      const result = await next.adopt();
      assert.equal(result.adopted, 0);
      assert.ok(result.refingerprinted >= 1);
      assert.equal(result.withheld, 0, 'every record was where the recipe before said');
      assert.deepEqual(await recorded(rackTraffic), {
        owner: datacentre,
        by: 'account',
        user: admin.id,
      });
      const widenedConfig = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
        vault: h.vault,
        credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
        credentialCheck: next,
      });
      const carried = (await widenedConfig.assignmentsFor(site)).sensors.find(
        (one) => one.sensorId === rackTraffic,
      );
      assert.ok(carried?.credentials?.['snmp'] !== undefined, 'still sent, under the new recipe');

      // And back, for the tests after this one.
      await credentials.adopt();
    });

    it('leaves withheld a record the recipe before cannot vouch for, and counts it per kind', async () => {
      // A device whose host changed without a write that checks it — the case the continuity
      // rule is for. Its record is not where it is sent now under either recipe, so a release
      // that moves every fingerprint must not carry it along with the rest.
      const moved = await device(racks, `moved-${String(process.hrtime.bigint())}`, '192.0.2.40');
      const movedTraffic = await traffic(moved, 'moved-traffic');
      const recordedBefore = await db.query<{ destination: string }>(
        `SELECT destination FROM sensor_credential_voucher WHERE sensor_id = $1`,
        [movedTraffic],
      );
      await db.query(`UPDATE device_config SET host = '203.0.113.99' WHERE object_id = $1`, [
        moved,
      ]);
      // And one recorded against another owner than the set in force: withheld whatever the
      // recipe says, so not the recipe's to touch or to count.
      const rehomed = await device(
        racks,
        `rehomed-${String(process.hrtime.bigint())}`,
        '192.0.2.41',
      );
      const rehomedTraffic = await traffic(rehomed, 'rehomed-traffic');
      await db.query(`UPDATE sensor_credential_voucher SET owner_id = $2 WHERE sensor_id = $1`, [
        rehomedTraffic,
        racks,
      ]);
      const rehomedBefore = await db.query<{ destination: string }>(
        `SELECT destination FROM sensor_credential_voucher WHERE sensor_id = $1`,
        [rehomedTraffic],
      );

      const next = nextRelease();
      const since = await lastAuditId();
      const result = await next.adopt();
      assert.equal(result.withheld, 1);
      assert.ok(result.refingerprinted >= 1, 'the rest are carried');
      assert.deepEqual(
        await db.query<{ destination: string }>(
          `SELECT destination FROM sensor_credential_voucher WHERE sensor_id = $1`,
          [movedTraffic],
        ),
        recordedBefore,
        'its record is left as it was',
      );
      assert.deepEqual(
        await db.query<{ destination: string }>(
          `SELECT destination FROM sensor_credential_voucher WHERE sensor_id = $1`,
          [rehomedTraffic],
        ),
        rehomedBefore,
        'and so is one whose owner is not the set in force',
      );
      assert.deepEqual(await adoptionsSince(since), [
        {
          credentialKind: 'snmp',
          installation: 0,
          carried: result.refingerprinted,
          withheld: 1,
        },
      ]);

      // And it is not sent: held Unknown with the sentence that says how to fix it.
      const nextConfig = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
        vault: h.vault,
        credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
        credentialCheck: next,
      });
      const assignments = await nextConfig.assignmentsFor(site);
      assert.equal(
        assignments.sensors.some((one) => one.sensorId === movedTraffic),
        false,
      );
      assert.equal(vouching.withheld().get(movedTraffic), WITHHELD_CREDENTIALS.unvouched);
      assert.ok(
        assignments.sensors.some((one) => one.sensorId === rackTraffic),
        'and the rest still are',
      );

      // Under this release too: its record names the right place, and another owner than the set
      // in force, so it is not sent either.
      assert.equal(await sent(rehomedTraffic), 'absent');
      assert.equal(vouching.withheld().get(rehomedTraffic), WITHHELD_CREDENTIALS.unvouched);

      // Back, for the tests after this one: the host where its record says, and nothing held.
      await db.query(`UPDATE device_config SET host = '192.0.2.40' WHERE object_id = $1`, [moved]);
      await db.query(`UPDATE sensor_credential_voucher SET owner_id = $2 WHERE sensor_id = $1`, [
        rehomedTraffic,
        datacentre,
      ]);
      await credentials.adopt();
      assert.equal(await sent(movedTraffic), 'with');
      assert.equal(await sent(rehomedTraffic), 'with');
    });

    it('carries nothing over a recipe it cannot read', async () => {
      await db.query(`UPDATE credential_voucher_adoption SET recipe = 'not a recipe'`);
      const result = await nextRelease().adopt();
      assert.equal(result.refingerprinted, 0);
      assert.ok(result.withheld >= 1, 'every record the release moved is left withheld');
      // Back to this release. The stored recipe is the next one's now, which it can read, and
      // every record is still where this one says: they were left alone, not moved.
      assert.deepEqual(await credentials.adopt(), { adopted: 0, refingerprinted: 0, withheld: 0 });
      assert.equal(await sent(rackTraffic), 'with');
    });

    it('runs whole or not at all', async () => {
      await db.query('DELETE FROM sensor_credential_voucher');
      await db.query(`UPDATE credential_voucher_adoption SET pending = true, recipe = ''`);
      // A failure after the rows are written and before the mark is cleared, as a crash would be.
      await db.query(
        `ALTER TABLE credential_voucher_adoption
         ADD CONSTRAINT the_power_went_out CHECK (pending)`,
      );
      try {
        await assert.rejects(credentials.adopt(), /the_power_went_out/);
      } finally {
        await db.query(
          'ALTER TABLE credential_voucher_adoption DROP CONSTRAINT the_power_went_out',
        );
      }
      assert.deepEqual(await db.query('SELECT pending FROM credential_voucher_adoption'), [
        { pending: true },
      ]);
      assert.deepEqual(
        await db.query('SELECT count(*)::int AS n FROM sensor_credential_voucher'),
        [{ n: 0 }],
        'nothing it wrote survived',
      );
      const done = await credentials.adopt();
      assert.ok(done.adopted >= 2);
      assert.equal(await sent(rackTraffic), 'with');
    });
  },
);
