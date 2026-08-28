import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AccessService, atLeast, type AccessRight } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * Per-object access rights (`A-03`), and `PLAN.md` Phase 9's first exit criterion: **an
 * access-control test matrix passes for every combination of role, group and tree position**.
 *
 * The three rules interact, so most of this is table-driven over a real tree rather than a
 * sequence of hand-written cases:
 *
 *   1. inheritance down the tree,
 *   2. explicit beats inherited,
 *   3. highest wins across groups.
 *
 * **The case that decides the design is the last table row.** Two groups, one holding `full`
 * high in the tree and one granted `read` on a leaf: the effective right must stay `full`,
 * because rule 2 is applied *per group* before rule 3 combines them. Resolve it the other way
 * — nearest ancestor defining a right for anybody, then combine — and granting a group `read`
 * silently strips another group's `full`. Adding a grant must never take one away.
 */

const available = await databaseAvailable();

describe('per-object access rights', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let access: AccessService;
  let accounts: AccountService;
  let groups: GroupService;

  /** probe → group → device → sensor, so every rule has somewhere to sit. */
  let probeId = 0;
  let groupId = 0;
  let deviceId = 0;
  let sensorId = 0;

  let alphaId = 0;
  let betaId = 0;
  /** A group that exists and that `ops` is deliberately not a member of. */
  let gammaId = 0;
  let userId = 0;

  before(async () => {
    scratch = await createScratchDatabase('accessrights');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object_access');
    await db.query('DELETE FROM user_group_member');
    await db.query('DELETE FROM user_group WHERE NOT is_builtin');
    await db.query('DELETE FROM user_account');
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');

    access = new AccessService({ db, logger: silentLogger });
    accounts = new AccountService({ db, logger: silentLogger });
    groups = new GroupService({ db, logger: silentLogger });

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
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: group.id,
      name: 'web01',
      host: '127.0.0.1',
    });
    deviceId = device.id;
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: device.id,
      name: 'Ping',
      sensorType: 'icmp.ping',
      params: { count: 3 },
    });
    sensorId = sensor.id;

    const alpha = await groups.create({ name: 'Alpha' });
    const beta = await groups.create({ name: 'Beta' });
    const gamma = await groups.create({ name: 'Gamma' });
    alphaId = alpha.id;
    betaId = beta.id;
    gammaId = gamma.id;

    const account = await accounts.create({
      login: 'ops',
      password: 'correct-horse-battery',
      role: 'readwrite',
    });
    userId = account.id;
    await groups.addMember(alphaId, userId);
    await groups.addMember(betaId, userId);
  });

  const rightAt = async (objectId: number): Promise<AccessRight> =>
    (await access.resolve(userId, objectId)).right;

  describe('the matrix', () => {
    /**
     * Each row: grants to lay down, the object to ask about, and the right expected.
     *
     * `ask` and `on` are resolved to real object ids at run time — writing ids into a table would make
     * it a table about this fixture rather than about the rules.
     */
    interface Row {
      name: string;
      grants: {
        on: 'probe' | 'group' | 'device' | 'sensor';
        /** `gamma` exists and the account is deliberately not in it. */
        group: 'alpha' | 'beta' | 'gamma';
        right: AccessRight;
      }[];
      ask: 'probe' | 'group' | 'device' | 'sensor';
      expect: AccessRight;
    }

    const ROWS: Row[] = [
      {
        name: 'nothing granted anywhere is nothing',
        grants: [],
        ask: 'sensor',
        expect: 'none',
      },
      {
        name: 'a grant on the object itself',
        grants: [{ on: 'sensor', group: 'alpha', right: 'read' }],
        ask: 'sensor',
        expect: 'read',
      },
      {
        name: 'inherits from the parent',
        grants: [{ on: 'device', group: 'alpha', right: 'write' }],
        ask: 'sensor',
        expect: 'write',
      },
      {
        name: 'inherits from the top of the branch',
        grants: [{ on: 'probe', group: 'alpha', right: 'read' }],
        ask: 'sensor',
        expect: 'read',
      },
      {
        name: 'explicit beats inherited, upwards',
        grants: [
          { on: 'probe', group: 'alpha', right: 'read' },
          { on: 'device', group: 'alpha', right: 'full' },
        ],
        ask: 'sensor',
        expect: 'full',
      },
      {
        name: 'explicit beats inherited, downwards too',
        grants: [
          { on: 'probe', group: 'alpha', right: 'full' },
          { on: 'device', group: 'alpha', right: 'read' },
        ],
        ask: 'sensor',
        expect: 'read',
      },
      {
        name: 'an explicit none carves a hole in a branch',
        grants: [
          { on: 'probe', group: 'alpha', right: 'write' },
          { on: 'device', group: 'alpha', right: 'none' },
        ],
        ask: 'sensor',
        expect: 'none',
      },
      {
        name: 'the hole does not extend to its siblings',
        grants: [
          { on: 'probe', group: 'alpha', right: 'write' },
          { on: 'device', group: 'alpha', right: 'none' },
        ],
        ask: 'group',
        expect: 'write',
      },
      {
        name: 'highest wins across two groups at the same level',
        grants: [
          { on: 'device', group: 'alpha', right: 'read' },
          { on: 'device', group: 'beta', right: 'full' },
        ],
        ask: 'device',
        expect: 'full',
      },
      {
        name: 'highest wins even when the lower right is nearer',
        // The design decision, stated as a test. Beta holds `full` on the probe; Alpha is
        // granted `read` on the sensor. Resolve nearest-first-across-everyone and this is
        // `read` — a grant that took access away. Per group, then combine: `full`.
        grants: [
          { on: 'probe', group: 'beta', right: 'full' },
          { on: 'sensor', group: 'alpha', right: 'read' },
        ],
        ask: 'sensor',
        expect: 'full',
      },
      {
        name: 'an explicit none for one group does not deny another group’s grant',
        grants: [
          { on: 'sensor', group: 'alpha', right: 'none' },
          { on: 'probe', group: 'beta', right: 'write' },
        ],
        ask: 'sensor',
        expect: 'write',
      },
      {
        name: 'a grant to a group the account is not in gives it nothing',
        grants: [{ on: 'sensor', group: 'gamma', right: 'full' }],
        ask: 'sensor',
        expect: 'none',
      },
      {
        name: 'and does not disturb a grant it does hold',
        grants: [
          { on: 'sensor', group: 'gamma', right: 'none' },
          { on: 'probe', group: 'alpha', right: 'read' },
        ],
        ask: 'sensor',
        expect: 'read',
      },
    ];

    for (const row of ROWS) {
      it(row.name, async () => {
        const idOf = { probe: probeId, group: groupId, device: deviceId, sensor: sensorId };
        const groupOf = { alpha: alphaId, beta: betaId, gamma: gammaId };
        for (const grant of row.grants) {
          await access.grant(idOf[grant.on], groupOf[grant.group], grant.right, 'test');
        }
        assert.equal(await rightAt(idOf[row.ask]), row.expect);
      });
    }
  });

  describe('membership is what makes a grant apply', () => {
    it('gives nothing for a group the account has left', async () => {
      await access.grant(deviceId, alphaId, 'full', 'test');
      assert.equal(await rightAt(deviceId), 'full');

      await groups.removeMember(alphaId, userId);
      assert.equal(await rightAt(deviceId), 'none', 'leaving the group takes the right with it');
    });

    it('gives nothing to an account in no groups at all', async () => {
      const stranger = await accounts.create({
        login: 'stranger',
        password: 'correct-horse-battery',
        role: 'readwrite',
      });
      await access.grant(probeId, alphaId, 'full', 'test');
      assert.equal((await access.resolve(stranger.id, sensorId)).right, 'none');
    });
  });

  describe('administrators', () => {
    it('hold full on everything without a single grant', async () => {
      // "May do anything, including to objects that do not exist yet" is not a statement about a
      // position in the tree, so it is not expressible as a row — and making it depend on one is
      // how an installation locks itself out by deleting it.
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId);

      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.right, 'full');
      assert.equal(resolved.viaAdminGroup, true);
    });

    it('are not overridden by an explicit none', async () => {
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId);
      await access.grant(sensorId, alphaId, 'none', 'test');
      assert.equal((await access.resolve(userId, sensorId)).right, 'full');
    });
  });

  describe('what the resolver reports about itself', () => {
    it('names the object and group a right came from', async () => {
      // An administrator debugging "why can this person see that?" needs the source, not just
      // the answer.
      await access.grant(deviceId, alphaId, 'write', 'test');
      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.right, 'write');
      assert.equal(resolved.sourceObjectId, deviceId);
      assert.equal(resolved.sourceGroupId, alphaId);
      assert.equal(resolved.inherited, true);
    });

    it('says a right was explicit when it sits on the object itself', async () => {
      await access.grant(sensorId, alphaId, 'read', 'test');
      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.inherited, false);
      assert.equal(resolved.sourceObjectId, sensorId);
    });
  });

  describe('granting and revoking', () => {
    it('replaces a grant rather than duplicating it', async () => {
      await access.grant(deviceId, alphaId, 'read', 'test');
      await access.grant(deviceId, alphaId, 'full', 'test');
      const grants = await access.grantsOn(deviceId);
      assert.equal(grants.length, 1);
      assert.equal(grants[0]?.right, 'full');
    });

    it('revoking restores inheritance, which granting none does not', async () => {
      // The two are different tools and an administrator needs both: one undoes a mistake, the
      // other carves a hole in a branch somebody else has access to.
      await access.grant(probeId, alphaId, 'write', 'test');
      await access.grant(deviceId, alphaId, 'none', 'test');
      assert.equal(await rightAt(sensorId), 'none');

      assert.equal(await access.revoke(deviceId, alphaId), true);
      assert.equal(await rightAt(sensorId), 'write', 'back to what it inherits');
    });

    it('reports revoking something that was never there', async () => {
      assert.equal(await access.revoke(deviceId, alphaId), false);
    });

    it('refuses a grant on an object that does not exist', async () => {
      await assert.rejects(
        () => access.grant(999_999, alphaId, 'read', 'test'),
        /no such object or group/,
      );
    });

    it('goes away with the object it was granted on', async () => {
      await access.grant(deviceId, alphaId, 'full', 'test');
      await harness.service.delete(
        testActor,
        deviceId,
        { kind: 'exact', descendants: 1 },
        { kind: 'none' },
      );
      assert.deepEqual(await access.grantsOn(deviceId), []);
    });
  });

  describe('resolving many at once', () => {
    it('agrees with resolving them one at a time', async () => {
      // The list view asks for a page of objects. A second implementation that disagreed with
      // the first would be an access-control bug that only shows up in a list.
      await access.grant(probeId, alphaId, 'read', 'test');
      await access.grant(deviceId, betaId, 'full', 'test');
      await access.grant(sensorId, alphaId, 'none', 'test');

      const ids = [probeId, groupId, deviceId, sensorId];
      const many = await access.resolveMany(userId, ids);
      for (const id of ids) {
        assert.equal(many.get(id), await rightAt(id), `object ${String(id)} disagreed`);
      }
    });

    it('answers none for an object with nothing above it', async () => {
      const many = await access.resolveMany(userId, [sensorId]);
      assert.equal(many.get(sensorId), 'none');
    });

    it('gives an administrator full on everything, in bulk too', async () => {
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId);
      const many = await access.resolveMany(userId, [probeId, sensorId]);
      assert.equal(many.get(probeId), 'full');
      assert.equal(many.get(sensorId), 'full');
    });

    it('asks nothing of the database for an empty list', async () => {
      assert.equal((await access.resolveMany(userId, [])).size, 0);
    });
  });

  describe('requiring a right', () => {
    it('passes when the account holds more than enough', async () => {
      await access.grant(deviceId, alphaId, 'full', 'test');
      await access.require(userId, deviceId, 'read');
    });

    it('refuses with what was held and what was needed', async () => {
      await access.grant(deviceId, alphaId, 'read', 'test');
      await assert.rejects(
        () => access.require(userId, deviceId, 'write'),
        (error: unknown) => {
          const app = error as { code: string; context: Record<string, unknown> };
          assert.equal(app.code, 'AUTH_FORBIDDEN');
          assert.equal(app.context['held'], 'read');
          assert.equal(app.context['needed'], 'write');
          return true;
        },
      );
    });
  });

  describe('the ordering', () => {
    it('ranks the rights the way an operator would read them', () => {
      // `max()` over the text form would order them alphabetically — full < none < read < write
      // — which is wrong in every position, so the rank exists as a function in SQL and a table
      // here, and this is what stops the two drifting.
      assert.equal(atLeast('full', 'write'), true);
      assert.equal(atLeast('write', 'read'), true);
      assert.equal(atLeast('read', 'none'), true);
      assert.equal(atLeast('read', 'write'), false);
      assert.equal(atLeast('none', 'read'), false);
      assert.equal(atLeast('read', 'read'), true);
    });

    it('agrees with the database’s own ranking', async () => {
      // Two sources of truth for one fact, which is why they are checked against each other.
      const rows = await db.query<{ r: string; rank: number }>(
        `SELECT r::text AS r, access_rank(r) AS rank
         FROM unnest(ARRAY['none','read','write','full']::access_right[]) AS r`,
      );
      const fromDb = Object.fromEntries(rows.map((row) => [row.r, row.rank]));
      assert.deepEqual(fromDb, { none: 0, read: 1, write: 2, full: 3 });
    });
  });
});
