import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AccessService, cappedBy, type AccessRight } from '../src/auth/access.js';
import { AccountService, type AccountRole } from '../src/auth/accounts.js';
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
 * Read-only account restrictions (`A-04`).
 *
 * **A role is a ceiling, not a starting point**, and every test here is a way of trying to get
 * around that. A read-only account in a group that holds `full`; a read-only account added to
 * the administrators group; an account made read-only *after* it was already administering
 * something. Each of those is a route to an account somebody believes is read-only that is not,
 * which is a silent and total failure — so each is refused, and refused with a sentence rather
 * than by being quietly adjusted.
 */

const available = await databaseAvailable();

describe('read-only accounts', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let accounts: AccountService;
  let groups: GroupService;
  let access: AccessService;
  let deviceId = 0;
  let teamId = 0;

  before(async () => {
    scratch = await createScratchDatabase('readonlyaccounts');
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

    accounts = new AccountService({ db, logger: silentLogger });
    groups = new GroupService({ db, logger: silentLogger });
    access = new AccessService({ db, logger: silentLogger });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'web01',
      host: '127.0.0.1',
    });
    deviceId = device.id;
    teamId = (await groups.create({ name: 'Team' })).id;
  });

  const makeAccount = async (role: AccountRole, login = 'someone') =>
    accounts.create({ login, password: 'correct-horse-battery', role });

  const adminGroup = async () => {
    const found = (await groups.list()).find((g) => g.isAdmin);
    assert.ok(found);
    return found;
  };

  describe('the ceiling', () => {
    it('caps a read-only account at read, however much its group grants', async () => {
      // The whole ticket in one test. Somebody made this account read-only on purpose, and a
      // group membership is not a way to undo that.
      const account = await makeAccount('readonly');
      await groups.addMember(teamId, account.id);
      await access.grant(deviceId, teamId, 'full', 'test');

      assert.equal((await access.resolve(account.id, deviceId)).right, 'full', 'the groups grant full');
      const capped = await access.resolveFor(
        { userId: account.id, role: 'readonly' },
        deviceId,
      );
      assert.equal(capped.right, 'read', 'and the account may still only read');
      assert.equal(capped.cappedByRole, true);
    });

    it('says the cap is why, rather than leaving it inexplicable', async () => {
      // "You have full on this device and may not edit it" is incomprehensible without this.
      const account = await makeAccount('readonly');
      await groups.addMember(teamId, account.id);
      await access.grant(deviceId, teamId, 'full', 'test');

      await assert.rejects(
        () => access.requireFor({ userId: account.id, role: 'readonly' }, deviceId, 'write'),
        (error: unknown) => {
          const app = error as { code: string; context: Record<string, unknown> };
          assert.equal(app.code, 'AUTH_FORBIDDEN');
          assert.equal(app.context['cappedByRole'], 'readonly');
          return true;
        },
      );
    });

    it('does not cap a read-write account', async () => {
      const account = await makeAccount('readwrite');
      await groups.addMember(teamId, account.id);
      await access.grant(deviceId, teamId, 'full', 'test');
      const resolved = await access.resolveFor(
        { userId: account.id, role: 'readwrite' },
        deviceId,
      );
      assert.equal(resolved.right, 'full');
      assert.equal(resolved.cappedByRole, undefined);
    });

    it('never *raises* a right — the ceiling only lowers', async () => {
      // A read-write account with no grant has nothing, and the ceiling must not invent one.
      const account = await makeAccount('readwrite');
      await groups.addMember(teamId, account.id);
      const resolved = await access.resolveFor(
        { userId: account.id, role: 'readwrite' },
        deviceId,
      );
      assert.equal(resolved.right, 'none');
    });

    it('caps every right the same way, as a table', () => {
      const table: [AccountRole, AccessRight, AccessRight][] = [
        ['readonly', 'none', 'none'],
        ['readonly', 'read', 'read'],
        ['readonly', 'write', 'read'],
        ['readonly', 'full', 'read'],
        ['readwrite', 'write', 'write'],
        ['readwrite', 'full', 'full'],
        ['admin', 'full', 'full'],
        ['admin', 'none', 'none'],
      ];
      for (const [role, granted, expected] of table) {
        assert.equal(cappedBy(role, granted), expected, `${role} + ${granted}`);
      }
    });
  });

  describe('read-only accounts and administrator groups', () => {
    it('refuses to add one to an admin group', async () => {
      const account = await makeAccount('readonly');
      const admins = await adminGroup();
      await assert.rejects(
        () => groups.addMember(admins.id, account.id),
        /read-only and cannot join a group that administers/,
      );
    });

    it('refuses to make an account read-only while it administers something', async () => {
      // The other direction into the same broken state. Refused rather than resolved: dropping
      // the role change and removing the account from the group mean completely different
      // things, and picking one would be guessing at intent where guessing is worst.
      const account = await makeAccount('readwrite');
      const admins = await adminGroup();
      await groups.addMember(admins.id, account.id);

      await assert.rejects(
        () => accounts.update(account.id, { role: 'readonly' }),
        (error: unknown) => {
          const app = error as { code: string };
          assert.equal(app.code, 'ACCOUNT_READONLY_ADMIN');
          return true;
        },
      );
      assert.equal((await accounts.get(account.id))?.role, 'readwrite', 'and nothing changed');
    });

    it('allows it once the account has left the admin group', async () => {
      const account = await makeAccount('readwrite');
      const admins = await adminGroup();
      await groups.addMember(admins.id, account.id);
      await groups.removeMember(admins.id, account.id);
      const updated = await accounts.update(account.id, { role: 'readonly' });
      assert.equal(updated.role, 'readonly');
    });

    it('lets a read-only account join an ordinary group', async () => {
      const account = await makeAccount('readonly');
      await groups.addMember(teamId, account.id);
      assert.equal((await groups.membershipsOf(account.id)).length, 1);
    });

    it('refuses a group being made administrative under a read-only member', async () => {
      // The third route: leave the account and the membership alone, and change the *group*.
      const account = await makeAccount('readonly');
      await groups.addMember(teamId, account.id);
      await assert.rejects(
        () => db.query(`UPDATE user_group SET is_admin = true WHERE id = $1`, [teamId]),
        /read-only|check/i,
      );
    });
  });

  describe('acknowledging', () => {
    it('is off by default, because a permission that grants itself is not one', async () => {
      const account = await makeAccount('readonly');
      assert.equal(account.mayAcknowledge, false);
    });

    it('can be granted, and shows on the account', async () => {
      // An operator who may look but not change is exactly the person on the end of a phone at
      // 3am; "silence this, I am dealing with it" is a note on an alarm, not a change to the
      // monitored estate.
      const account = await makeAccount('readonly');
      const updated = await accounts.update(account.id, { mayAcknowledge: true });
      assert.equal(updated.mayAcknowledge, true);
      assert.equal((await accounts.get(account.id))?.mayAcknowledge, true);
    });

    it('survives an unrelated update', async () => {
      const account = await makeAccount('readonly');
      await accounts.update(account.id, { mayAcknowledge: true });
      const updated = await accounts.update(account.id, { displayName: 'Night shift' });
      assert.equal(updated.mayAcknowledge, true, 'a COALESCE that dropped this would be silent');
    });

    it('can be taken away again', async () => {
      const account = await makeAccount('readonly');
      await accounts.update(account.id, { mayAcknowledge: true });
      const updated = await accounts.update(account.id, { mayAcknowledge: false });
      assert.equal(updated.mayAcknowledge, false);
    });
  });

  describe('credentials', () => {
    it('are not readable by anybody, which is the stronger claim', async () => {
      // `PLAN.md` Phase 9's second exit criterion is that a read-only user cannot retrieve a
      // credential by any route. The system's answer is not a role check — it is that no route
      // returns one to anyone, redacted at ObjectService.#redact, and that `credentialView` has
      // no field a secret could occupy. This asserts the shape of that, so a field added later
      // has to be a deliberate act.
      const { credentialViewSchema } = await import('../src/api/schemas/objects.js');
      const properties = Object.keys(credentialViewSchema.properties);
      assert.deepEqual(properties.sort(), ['kind', 'publicParams', 'source', 'updatedAt']);
      assert.equal(credentialViewSchema.additionalProperties, false);
    });
  });
});
