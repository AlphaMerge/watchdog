import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  AccessService,
  atLeast,
  lower,
  type AccessPrincipal,
  type AccessRight,
} from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, testActor } from './support/tree.js';

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

    access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silentLogger });
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });

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

    const alpha = await groups.create({ name: 'Alpha' }, testActor);
    const beta = await groups.create({ name: 'Beta' }, testActor);
    const gamma = await groups.create({ name: 'Gamma' }, testActor);
    alphaId = alpha.id;
    betaId = beta.id;
    gammaId = gamma.id;

    const account = await accounts.create(
      {
        login: 'ops',
        password: 'correct-horse-battery',
        role: 'readwrite',
      },
      testActor,
    );
    userId = account.id;
    await groups.addMember(alphaId, userId, testActor);
    await groups.addMember(betaId, userId, testActor);
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
          await access.grant(idOf[grant.on], groupOf[grant.group], grant.right, actorNamed('test'));
        }
        assert.equal(await rightAt(idOf[row.ask]), row.expect);
      });
    }
  });

  describe('membership is what makes a grant apply', () => {
    it('gives nothing for a group the account has left', async () => {
      await access.grant(deviceId, alphaId, 'full', actorNamed('test'));
      assert.equal(await rightAt(deviceId), 'full');

      await groups.removeMember(alphaId, userId, testActor);
      assert.equal(await rightAt(deviceId), 'none', 'leaving the group takes the right with it');
    });

    it('gives nothing to an account in no groups at all', async () => {
      const stranger = await accounts.create(
        {
          login: 'stranger',
          password: 'correct-horse-battery',
          role: 'readwrite',
        },
        testActor,
      );
      await access.grant(probeId, alphaId, 'full', actorNamed('test'));
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
      await groups.addMember(admins.id, userId, testActor);

      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.right, 'full');
      assert.equal(resolved.viaAdminGroup, true);
    });

    it('are not overridden by an explicit none', async () => {
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId, testActor);
      await access.grant(sensorId, alphaId, 'none', actorNamed('test'));
      assert.equal((await access.resolve(userId, sensorId)).right, 'full');
    });
  });

  describe('what the resolver reports about itself', () => {
    it('names the object and group a right came from', async () => {
      // An administrator debugging "why can this person see that?" needs the source, not just
      // the answer.
      await access.grant(deviceId, alphaId, 'write', actorNamed('test'));
      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.right, 'write');
      assert.equal(resolved.sourceObjectId, deviceId);
      assert.equal(resolved.sourceGroupId, alphaId);
      assert.equal(resolved.inherited, true);
    });

    it('says a right was explicit when it sits on the object itself', async () => {
      await access.grant(sensorId, alphaId, 'read', actorNamed('test'));
      const resolved = await access.resolve(userId, sensorId);
      assert.equal(resolved.inherited, false);
      assert.equal(resolved.sourceObjectId, sensorId);
    });
  });

  describe('granting and revoking', () => {
    it('replaces a grant rather than duplicating it', async () => {
      await access.grant(deviceId, alphaId, 'read', actorNamed('test'));
      await access.grant(deviceId, alphaId, 'full', actorNamed('test'));
      const grants = await access.grantsOn(deviceId);
      assert.equal(grants.length, 1);
      assert.equal(grants[0]?.right, 'full');
    });

    it('revoking restores inheritance, which granting none does not', async () => {
      // The two are different tools and an administrator needs both: one undoes a mistake, the
      // other carves a hole in a branch somebody else has access to.
      await access.grant(probeId, alphaId, 'write', actorNamed('test'));
      await access.grant(deviceId, alphaId, 'none', actorNamed('test'));
      assert.equal(await rightAt(sensorId), 'none');

      assert.equal(await access.revoke(deviceId, alphaId, actorNamed('test')), true);
      assert.equal(await rightAt(sensorId), 'write', 'back to what it inherits');
    });

    it('reports revoking something that was never there', async () => {
      assert.equal(await access.revoke(deviceId, alphaId, actorNamed('test')), false);
    });

    it('refuses a grant on an object that does not exist', async () => {
      await assert.rejects(
        () => access.grant(999_999, alphaId, 'read', actorNamed('test')),
        /no such object or group/,
      );
    });

    it('goes away with the object it was granted on', async () => {
      await access.grant(deviceId, alphaId, 'full', actorNamed('test'));
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
      await access.grant(probeId, alphaId, 'read', actorNamed('test'));
      await access.grant(deviceId, betaId, 'full', actorNamed('test'));
      await access.grant(sensorId, alphaId, 'none', actorNamed('test'));

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
      await groups.addMember(admins.id, userId, testActor);
      const many = await access.resolveMany(userId, [probeId, sensorId]);
      assert.equal(many.get(probeId), 'full');
      assert.equal(many.get(sensorId), 'full');
    });

    it('asks nothing of the database for an empty list', async () => {
      assert.equal((await access.resolveMany(userId, [])).size, 0);
    });
  });

  describe('what a principal may see agrees with resolving it (`A-12`)', () => {
    /**
     * **The claim `Visibility` rests on, checked object by object.**
     *
     * Lists filter with a SQL condition and the stream with a path check, and neither contains a
     * right: both carry labels that `resolveMany`'s own SQL put on the principal's boundaries. What
     * they add is structure — "visibility can only change where a grant sits" — and if that were
     * wrong, a list would show an object `GET /objects/:id` refuses, or hide one it serves. That is
     * an access-control bug visible only in a list, which is what `A-03`'s agreement test was
     * written against; this is the same test for the two new consumers.
     *
     * Randomised rather than hand-picked, because the cases that break a structural shortcut are
     * the ones nobody thinks to write: a hole inside a hole, a grant re-opening a hole, a `none` on
     * the root with a branch granted beneath it, two groups disagreeing at different depths. Seeded,
     * so a failure names the seed that reproduces it.
     */
    const RIGHTS: readonly AccessRight[] = ['none', 'read', 'write', 'full'];

    /** mulberry32: small, seedable, and good enough to scatter grants over a tree. */
    function random(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Root-first path to every object, from one read of the tree. */
    async function pathsOfEverything(): Promise<Map<number, number[]>> {
      const rows = await db.query<{ id: string; parent_id: string | null }>(
        'SELECT id::text AS id, parent_id::text AS parent_id FROM object',
      );
      const parent = new Map(
        rows.map((row) => [Number(row.id), row.parent_id === null ? null : Number(row.parent_id)]),
      );
      const paths = new Map<number, number[]>();
      for (const id of parent.keys()) {
        const path: number[] = [];
        for (let at: number | null = id; at !== null; at = parent.get(at) ?? null) path.unshift(at);
        paths.set(id, path);
      }
      return paths;
    }

    /**
     * A second probe with nested groups, so there is depth to put holes in: root → probe →
     * group → group → device → sensor, beside the fixture's own branch.
     */
    async function buildNestedTree(): Promise<void> {
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'agreement-probe',
      });
      for (let g = 0; g < 2; g += 1) {
        const outer = await harness.service.create(testActor, {
          kind: 'group',
          parentId: probe.id,
          name: `outer-${String(g)}`,
        });
        const inner = await harness.service.create(testActor, {
          kind: 'group',
          parentId: outer.id,
          name: `inner-${String(g)}`,
        });
        for (const parent of [outer.id, inner.id]) {
          for (let d = 0; d < 2; d += 1) {
            const device = await harness.service.create(testActor, {
              kind: 'device',
              parentId: parent,
              name: `device-${String(parent)}-${String(d)}`,
              host: '127.0.0.1',
            });
            for (let n = 0; n < 2; n += 1) {
              await harness.service.create(testActor, {
                kind: 'sensor',
                parentId: device.id,
                name: `sensor-${String(device.id)}-${String(n)}`,
                sensorType: 'icmp.ping',
              });
            }
          }
        }
      }
    }

    /** Every role and scope a right is resolved for. */
    const principalsOf = (): { name: string; principal: AccessPrincipal }[] => [
      { name: 'readwrite', principal: { userId, role: 'readwrite' } },
      { name: 'readonly', principal: { userId, role: 'readonly' } },
      { name: 'read-scoped token', principal: { userId, role: 'readwrite', scope: 'read' } },
      { name: 'none-scoped token', principal: { userId, role: 'readwrite', scope: 'none' } },
    ];

    /** Scatters two to eight grants over the tree, from this seed's sequence. */
    async function scatterGrants(next: () => number, ids: readonly number[]): Promise<void> {
      await db.query('DELETE FROM object_access');
      const groupIds = [alphaId, betaId, gammaId];
      const grants = 2 + Math.floor(next() * 7);
      for (let g = 0; g < grants; g += 1) {
        const on = ids[Math.floor(next() * ids.length)] ?? harness.rootId;
        const group = groupIds[Math.floor(next() * groupIds.length)] ?? alphaId;
        const right = RIGHTS[Math.floor(next() * RIGHTS.length)] ?? 'none';
        await access.grant(on, group, right, actorNamed('agreement'));
      }
    }

    it('agrees on every object, for every role and scope, over randomised grants', async () => {
      await buildNestedTree();
      const paths = await pathsOfEverything();
      const ids = [...paths.keys()].sort((a, b) => a - b);
      const principals = principalsOf();

      let comparisons = 0;
      let visibleSeen = 0;
      let hiddenSeen = 0;
      let childrenChecked = 0;
      for (let seed = 1; seed <= 40; seed += 1) {
        await scatterGrants(random(seed), ids);

        for (const { name, principal } of principals) {
          const expected = await access.resolveManyFor(principal, ids);
          const visibility = await access.visibilityFor(principal);

          const values: unknown[] = [];
          const condition = visibility.where('o.id', (value) => `$${String(values.push(value))}`);
          const listed = new Set(
            (
              await db.query<{ id: string }>(
                `SELECT o.id::text AS id FROM object o WHERE ${condition}`,
                values,
              )
            ).map((row) => Number(row.id)),
          );
          // The walk-free shortcut `hasChildren` and `childCount` use: asked only of the children
          // of a visible object, where it has to give the resolver's answer with no walk at all.
          const childValues: unknown[] = [];
          const childCondition = visibility.whereChildOfVisible(
            'c.id',
            (value) => `$${String(childValues.push(value))}`,
          );
          const childOfVisible = new Map(
            (
              await db.query<{ id: string; visible: boolean }>(
                `SELECT c.id::text AS id, (${childCondition}) AS visible
                 FROM object c WHERE c.parent_id IS NOT NULL`,
                childValues,
              )
            ).map((row) => [Number(row.id), row.visible]),
          );

          for (const id of ids) {
            const readable = atLeast(expected.get(id) ?? 'none', 'read');
            const path = paths.get(id) ?? [];
            const where = `seed ${String(seed)}, ${name}, object ${String(id)}`;
            assert.equal(listed.has(id), readable, `the SQL condition disagreed: ${where}`);
            assert.equal(visibility.sees(path), readable, `the path check disagreed: ${where}`);
            const parent = path.at(-2);
            if (parent !== undefined && atLeast(expected.get(parent) ?? 'none', 'read')) {
              assert.equal(
                childOfVisible.get(id),
                readable,
                `the child-of-visible condition disagreed: ${where}`,
              );
              childrenChecked += 1;
            }
            // Trimming keeps exactly the steps the resolver would let this principal read.
            assert.deepEqual(
              visibility.trim(path),
              path.filter((step) => atLeast(expected.get(step) ?? 'none', 'read')),
              `the trimmed path disagreed: ${where}`,
            );
            comparisons += 1;
            if (readable) visibleSeen += 1;
            else hiddenSeen += 1;
          }
        }
      }

      // Not vacuous: both answers occurred plenty, so a condition that said "yes" to everything
      // or "no" to everything would have failed above.
      assert.ok(comparisons > 5000, `only ${String(comparisons)} comparisons`);
      assert.ok(visibleSeen > 500, `only ${String(visibleSeen)} visible answers`);
      assert.ok(hiddenSeen > 500, `only ${String(hiddenSeen)} hidden answers`);
      assert.ok(childrenChecked > 1000, `only ${String(childrenChecked)} children checked`);
    });

    it('finds the weakest right beneath every object, for every role and scope (A-35)', async () => {
      // **The claim `resolveSubtreesFor` rests on**: that the rights held anywhere in a subtree
      // are the ones at its top and at the boundaries inside it. Checked against the obvious
      // answer — `resolveManyFor` on every object, and the least of them over each subtree.
      await buildNestedTree();
      const paths = await pathsOfEverything();
      const ids = [...paths.keys()].sort((a, b) => a - b);
      const within = new Map<number, number[]>(ids.map((id) => [id, []]));
      for (const [id, path] of paths) for (const step of path) within.get(step)?.push(id);

      let comparisons = 0;
      let narrower = 0;
      // Twice the seeds of the test above: a subtree weaker than its top needs a grant beneath a
      // readable one that lowers the right for *both* the account's groups, and forty seeds make
      // only about thirty.
      for (let seed = 1; seed <= 80; seed += 1) {
        await scatterGrants(random(seed), ids);
        for (const { name, principal } of principalsOf()) {
          const expected = await access.resolveManyFor(principal, ids);
          const answered = await access.resolveSubtreesFor(principal, ids);
          for (const id of ids) {
            const own = expected.get(id) ?? 'none';
            const weakest = (within.get(id) ?? []).reduce<AccessRight>(
              (least, below) => lower(least, expected.get(below) ?? 'none'),
              own,
            );
            const where = `seed ${String(seed)}, ${name}, object ${String(id)}`;
            assert.deepEqual(answered.get(id), { own, weakest }, where);
            comparisons += 1;
            if (weakest !== own) narrower += 1;
          }
        }
      }
      // Not vacuous: a subtree weaker than its top — the case the ticket is about — came up
      // dozens of times, so an answer that returned the top's right for everything would have
      // failed. Seeded, so the count is fixed; the floor is there for a change to the scatter.
      assert.ok(comparisons > 10_000, `only ${String(comparisons)} comparisons`);
      assert.ok(narrower > 30, `only ${String(narrower)} subtrees weaker than their top`);
    });

    it('gives an administrator its ceiling beneath everything, holes and all (A-35)', async () => {
      assert.equal((await access.resolveSubtreesFor({ userId, role: 'readwrite' }, [])).size, 0);
      await access.grant(sensorId, alphaId, 'none', actorNamed('agreement'));
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId, testActor);
      assert.deepEqual(
        (await access.resolveSubtreesFor({ userId, role: 'admin' }, [probeId])).get(probeId),
        { own: 'full', weakest: 'full' },
      );
      // The ceilings still apply to an administrator's token, as `resolveManyFor`'s do.
      assert.deepEqual(
        (await access.resolveSubtreesFor({ userId, role: 'admin', scope: 'read' }, [probeId])).get(
          probeId,
        ),
        { own: 'read', weakest: 'read' },
      );
    });

    it('sees everything as an administrator, and nothing through a none-scoped token', async () => {
      const admins = (await groups.list()).find((g) => g.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, userId, testActor);

      const everything = await access.visibilityFor({ userId, role: 'admin' });
      assert.equal(everything.everything, true);
      assert.equal(
        everything.where('o.id', () => '$1'),
        'TRUE',
      );

      const nothing = await access.visibilityFor({ userId, role: 'admin', scope: 'none' });
      assert.equal(nothing.everything, false);
      assert.equal(nothing.sees([harness.rootId, probeId]), false);
    });

    it('hides a deleted object from a reader who sees the whole live tree', async () => {
      // The state log and the notification log outlive their sensors. A reader granted the root
      // with no holes gets no walk at all — and without `mayBeDeleted` a row naming a sensor that
      // no longer exists would pass, although the resolver answers `none` for it.
      await access.grant(harness.rootId, alphaId, 'read', actorNamed('test'));
      const visibility = await access.visibilityFor({ userId, role: 'readwrite' });
      const gone = 2 ** 40;
      assert.deepEqual(
        (await access.resolveManyFor({ userId, role: 'readwrite' }, [gone])).get(gone),
        'none',
      );

      const values: unknown[] = [gone];
      const condition = visibility.where(
        '$1::bigint',
        (value) => `$${String(values.push(value))}`,
        {
          mayBeDeleted: true,
        },
      );
      const rows = await db.query<{ visible: boolean }>(`SELECT ${condition} AS visible`, values);
      assert.equal(rows[0]?.visible, false);
    });

    it('moves the access epoch with a grant, a membership and a move, and not with a rename', async () => {
      // What the stream relies on to notice that a socket's answer has gone stale (migration 052).
      const epoch = async (): Promise<number> => access.epoch();
      let before = await epoch();

      await access.grant(deviceId, alphaId, 'read', actorNamed('test'));
      assert.ok((await epoch()) > before, 'a grant did not move it');
      before = await epoch();

      await groups.addMember(gammaId, userId, testActor);
      assert.ok((await epoch()) > before, 'joining a group did not move it');
      before = await epoch();

      await harness.service.move(testActor, deviceId, probeId, { kind: 'none' });
      assert.ok((await epoch()) > before, 'a move did not move it');
      before = await epoch();

      await harness.service.update(
        testActor,
        deviceId,
        { kind: 'device', name: 'renamed' },
        { kind: 'none' },
      );
      assert.equal(await epoch(), before, 'a rename moved it, which re-resolves every stream');
    });

    it('moves it for a group’s admin flag, and not for its name or description (A-30)', async () => {
      // The trigger is `UPDATE OF is_admin`, decided by the SET list: naming the column to write
      // it back unchanged made every edit of a group a grant change for every open stream.
      const before = await access.epoch();
      await groups.update(
        gammaId,
        { name: 'gamma, renamed', description: 'described' },
        actorNamed('test'),
      );
      assert.equal(await access.epoch(), before, 'renaming a group moved it');

      await groups.update(gammaId, { isAdmin: true }, actorNamed('test'));
      assert.ok((await access.epoch()) > before, 'making a group the administrators did not');
    });
  });

  describe('requiring a right', () => {
    it('passes when the account holds more than enough', async () => {
      await access.grant(deviceId, alphaId, 'full', actorNamed('test'));
      await access.require(userId, deviceId, 'read');
    });

    it('refuses with what was held and what was needed', async () => {
      await access.grant(deviceId, alphaId, 'read', actorNamed('test'));
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
