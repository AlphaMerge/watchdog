import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { AccountService } from '../src/auth/accounts.js';
import { checkedGroupName, GroupService } from '../src/auth/groups.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { testActor } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { within } from './support/within.js';

/**
 * User groups and the primary group (`A-02`).
 *
 * **The invariant worth testing is "at most one primary, and never zero while they have any".**
 * The schema can enforce the first half — a partial unique index — and cannot enforce the
 * second, because a membership row exists before anything decides which is primary. So the
 * service holds it, and the interesting cases are the ones that could break it sideways:
 * removing the primary group, deleting it out from under its members, or adding somebody to a
 * group they are already in.
 */

const available = await databaseAvailable();

describe('user groups', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let groups: GroupService;
  let accounts: AccountService;
  let userId = 0;

  before(async () => {
    scratch = await createScratchDatabase('usergroups');
    db = scratch.db;
    await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_group_member');
    await db.query('DELETE FROM user_group WHERE NOT is_builtin');
    await db.query('DELETE FROM user_account');
    groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    const account = await accounts.create(
      {
        login: 'ops',
        password: 'correct-horse-battery',
        role: 'readwrite',
      },
      testActor,
    );
    userId = account.id;
  });

  const builtin = async (name: string) => {
    const all = await groups.list();
    const found = all.find((group) => group.name === name);
    assert.ok(found, `expected a built-in group named ${name}`);
    return found;
  };

  describe('the groups every installation has', () => {
    it('ships an administrators group and a default one', async () => {
      const admins = await builtin('Administrators');
      const users = await builtin('Users');
      assert.equal(admins.isAdmin, true);
      assert.equal(admins.isDefault, false, 'a new account must not land in it by default');
      assert.equal(users.isDefault, true);
      assert.equal(users.isAdmin, false, 'the default group grants nothing on its own');
    });

    it('has exactly one default group, and the database enforces it', async () => {
      // Zero would mean account creation has to ask a question nobody wants to answer; two would
      // mean it has to pick. The partial unique index is what makes this not a service rule.
      await assert.rejects(
        () => db.query(`UPDATE user_group SET is_default = true WHERE name = 'Administrators'`),
        /duplicate key|unique/i,
      );
    });

    it('refuses to delete a built-in group', async () => {
      // Deleting the administrators group is a one-way door out of your own installation.
      const admins = await builtin('Administrators');
      await assert.rejects(() => groups.delete(admins.id, testActor), /built-in/);
    });

    it('refuses to rename one, or to change what it grants', async () => {
      const admins = await builtin('Administrators');
      await assert.rejects(
        () => groups.update(admins.id, { name: 'Nobodies' }, testActor),
        /built-in/,
      );
      await assert.rejects(
        () => groups.update(admins.id, { isAdmin: false }, testActor),
        /built-in/,
      );
    });

    it('still lets one be described, which locks nobody out', async () => {
      const admins = await builtin('Administrators');
      const updated = await groups.update(
        admins.id,
        { description: 'The people on call' },
        testActor,
      );
      assert.equal(updated.description, 'The people on call');
    });
  });

  describe('membership', () => {
    it('makes the first group somebody joins their primary one', async () => {
      // A user with groups and no primary is a state nothing else is prepared for: object
      // ownership would have nothing to answer with.
      const users = await builtin('Users');
      await groups.addMember(users.id, userId, testActor);
      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]?.isPrimary, true);
    });

    it('does not move the primary when a second group is joined', async () => {
      const users = await builtin('Users');
      const oncall = await groups.create({ name: 'On call' }, testActor);
      await groups.addMember(users.id, userId, testActor);
      await groups.addMember(oncall.id, userId, testActor);

      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships.length, 2);
      assert.equal(memberships.filter((m) => m.isPrimary).length, 1);
      assert.equal(memberships[0]?.name, 'Users', 'primary first, and still the original');
    });

    it('moves it when asked to', async () => {
      const users = await builtin('Users');
      const oncall = await groups.create({ name: 'On call' }, testActor);
      await groups.addMember(users.id, userId, testActor);
      await groups.addMember(oncall.id, userId, testActor);
      await groups.setPrimary(oncall.id, userId, testActor);

      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships.filter((m) => m.isPrimary).length, 1);
      assert.equal(memberships.find((m) => m.isPrimary)?.name, 'On call');
    });

    it('refuses a primary group the account does not belong to', async () => {
      // The rule the schema cannot express. A foreign key from the account to a group could not
      // say "and they must be a member of it", and the two rules would drift the first time
      // somebody was removed from a group.
      const oncall = await groups.create({ name: 'On call' }, testActor);
      await assert.rejects(
        () => groups.setPrimary(oncall.id, userId, testActor),
        /already belongs to/,
      );
    });

    it('is idempotent: joining twice is joining once', async () => {
      const users = await builtin('Users');
      await groups.addMember(users.id, userId, testActor);
      await groups.addMember(users.id, userId, testActor);
      assert.equal((await groups.membershipsOf(userId)).length, 1);
    });

    it('never demotes an existing primary by re-adding the member', async () => {
      const users = await builtin('Users');
      await groups.addMember(users.id, userId, testActor);
      await groups.addMember(users.id, userId, testActor, false);
      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships[0]?.isPrimary, true, 're-adding must not leave them without one');
    });

    it('gives a new primary when the current one is left', async () => {
      const users = await builtin('Users');
      const oncall = await groups.create({ name: 'On call' }, testActor);
      await groups.addMember(users.id, userId, testActor);
      await groups.addMember(oncall.id, userId, testActor);
      await groups.removeMember(users.id, userId, testActor);

      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]?.isPrimary, true, 'the survivor becomes primary');
    });

    it('lets the last membership go, because belonging to nothing is a real state', async () => {
      // It is what a suspended operator looks like: no rights beyond their account role.
      const users = await builtin('Users');
      await groups.addMember(users.id, userId, testActor);
      await groups.removeMember(users.id, userId, testActor);
      assert.deepEqual(await groups.membershipsOf(userId), []);
    });

    it('gives a new primary when the primary group is deleted', async () => {
      // The cascade removes the membership row; nothing in the schema notices that it was the
      // primary one. This is the sideways route to a user with groups and no primary.
      const oncall = await groups.create({ name: 'On call' }, testActor);
      const relief = await groups.create({ name: 'Relief' }, testActor);
      await groups.addMember(oncall.id, userId, testActor);
      await groups.addMember(relief.id, userId, testActor);
      assert.equal((await groups.membershipsOf(userId))[0]?.name, 'On call');

      await groups.delete(oncall.id, testActor);
      const memberships = await groups.membershipsOf(userId);
      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]?.name, 'Relief');
      assert.equal(memberships[0].isPrimary, true);
    });

    it('does not delete the members with the group', async () => {
      const oncall = await groups.create({ name: 'On call' }, testActor);
      await groups.addMember(oncall.id, userId, testActor);
      await groups.delete(oncall.id, testActor);
      assert.ok(await accounts.get(userId), 'the account survives its group');
    });

    it('refuses to add a member to a group that does not exist', async () => {
      await assert.rejects(
        () => groups.addMember(999_999, userId, testActor),
        /no such group or account/,
      );
    });

    it('counts its members', async () => {
      const oncall = await groups.create({ name: 'On call' }, testActor);
      const second = await accounts.create(
        {
          login: 'ops2',
          password: 'correct-horse-battery',
          role: 'readonly',
        },
        testActor,
      );
      await groups.addMember(oncall.id, userId, testActor);
      await groups.addMember(oncall.id, second.id, testActor);
      assert.equal((await groups.get(oncall.id))?.memberCount, 2);
      assert.deepEqual(
        (await groups.membersOf(oncall.id)).map((m) => m.login),
        ['ops', 'ops2'],
      );
    });
  });

  describe('who administers', () => {
    it('answers from the groups, not from the account role', async () => {
      // A-01's role says what an account is allowed to be; this says what its memberships
      // currently grant. Removing somebody from the administrators group has to take effect
      // without anybody remembering to change their role too.
      const admins = await builtin('Administrators');
      assert.equal(await groups.administers(userId), false);
      await groups.addMember(admins.id, userId, testActor);
      assert.equal(await groups.administers(userId), true);
      await groups.removeMember(admins.id, userId, testActor);
      assert.equal(await groups.administers(userId), false);
    });

    it('is false for somebody in ordinary groups, however many', async () => {
      // **The mutant this exists to kill**: drop the `is_admin` filter and every test that only
      // ever adds people to Administrators still passes, because they are in nothing else. Then
      // belonging to any group at all administers the installation.
      const oncall = await groups.create({ name: 'On call' }, testActor);
      const relief = await groups.create({ name: 'Relief' }, testActor);
      const users = await builtin('Users');
      await groups.addMember(oncall.id, userId, testActor);
      await groups.addMember(relief.id, userId, testActor);
      await groups.addMember(users.id, userId, testActor);
      assert.equal(await groups.administers(userId), false);
    });

    it('is true for somebody in an admin group *and* ordinary ones', async () => {
      const oncall = await groups.create({ name: 'On call' }, testActor);
      const admins = await builtin('Administrators');
      await groups.addMember(oncall.id, userId, testActor);
      await groups.addMember(admins.id, userId, testActor);
      assert.equal(await groups.administers(userId), true);
    });

    it('is true through any admin group, not only the built-in one', async () => {
      const extra = await groups.create({ name: 'Senior operators', isAdmin: true }, testActor);
      await groups.addMember(extra.id, userId, testActor);
      assert.equal(await groups.administers(userId), true);
    });
  });

  describe('creating groups', () => {
    it('refuses a duplicate name, whatever its case', async () => {
      await groups.create({ name: 'On call' }, testActor);
      await assert.rejects(() => groups.create({ name: 'ON CALL' }, testActor), /already exists/);
    });

    it('refuses an empty name', async () => {
      await assert.rejects(() => groups.create({ name: '   ' }, testActor), /between 1 and 100/);
    });

    it('refuses a rename onto another group’s name, whatever its case (P-391)', async () => {
      await groups.create({ name: 'On call' }, testActor);
      const other = await groups.create({ name: 'Night shift' }, testActor);
      await assert.rejects(
        () => groups.update(other.id, { name: 'ON CALL' }, testActor),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'GROUP_EXISTS');
          assert.equal((error as Error).message, 'a group named ON CALL already exists');
          return true;
        },
      );
      // Its own name, in another case: nothing else is in the way.
      assert.equal(
        (await groups.update(other.id, { name: 'NIGHT SHIFT' }, testActor)).name,
        'NIGHT SHIFT',
      );
    });

    it('trims a rename as it trims a create, and refuses one of only spaces (A-81)', async () => {
      // Only a create trimmed. A rename stored what it was sent, so " On call" was a second
      // group beside "On call" whenever it came in through a rename, and a name of spaces was
      // stored as a name.
      await groups.create({ name: 'On call' }, testActor);
      const other = await groups.create({ name: '  Night shift ' }, testActor);
      assert.equal(other.name, 'Night shift');

      await assert.rejects(
        () => groups.update(other.id, { name: ' On call' }, testActor),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'GROUP_EXISTS');
          assert.equal((error as Error).message, 'a group named On call already exists');
          return true;
        },
      );
      assert.equal(
        (await groups.update(other.id, { name: ' Day shift  ' }, testActor)).name,
        'Day shift',
      );
      await assert.rejects(
        () => groups.update(other.id, { name: '   ' }, testActor),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'GROUP_INVALID');
          return true;
        },
      );
      assert.equal((await groups.get(other.id))?.name, 'Day shift', 'and nothing was written');
    });
  });

  describe('a primary group written by two at once (P-391)', () => {
    it('waits for the other, and then joins as a second group rather than a second primary', async () => {
      // The account belongs nowhere, so joining a group makes it primary. Another session makes
      // a different group its primary and has not committed: without the account's lock the
      // join passed the "belongs nowhere" check, and `user_group_primary_idx` refused it.
      await db.query('DELETE FROM user_group_member WHERE user_id = $1', [userId]);
      const first = await groups.create({ name: 'First' }, testActor);
      const second = await groups.create({ name: 'Second' }, testActor);

      let joining: Promise<unknown> = Promise.resolve();
      await db.tx(async (q) => {
        await q.query(
          "SELECT pg_advisory_xact_lock(hashtext('user_group_primary_idx'), hashtext($1::text))",
          [userId],
        );
        await q.query(
          'INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)',
          [second.id, userId],
        );
        joining = groups.addMember(first.id, userId, testActor).then(
          () => undefined,
          (error: unknown) => error,
        );
        await somebodyWaits(db, 'the join to wait on the account');
      });
      assert.equal(await within(10_000, 'the join to finish', joining), undefined);

      const rows = await db.query<{ group_id: string; is_primary: boolean }>(
        'SELECT group_id::text AS group_id, is_primary FROM user_group_member WHERE user_id = $1 ORDER BY group_id',
        [userId],
      );
      assert.deepEqual(
        rows.map((row) => [Number(row.group_id), row.is_primary]),
        [
          [first.id, false],
          [second.id, true],
        ].sort((a, b) => Number(a[0]) - Number(b[0])),
      );
    });
  });

  describe('the upgrade that created these tables', () => {
    it('put every account that already existed into a group', async () => {
      // An upgrade must not leave anybody belonging to nothing — the migration matches them by
      // the role A-01 already gave them.
      const admin = await accounts.create(
        {
          login: 'existing-admin',
          password: 'correct-horse-battery',
          role: 'admin',
        },
        testActor,
      );
      // Re-run the migration's own statement against the accounts created since.
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary)
         SELECT g.id, a.id, true
         FROM user_account a
         JOIN user_group g
           ON g.name = CASE WHEN a.role = 'admin' THEN 'Administrators' ELSE 'Users' END
         WHERE a.id = $1`,
        [admin.id],
      );
      const memberships = await groups.membershipsOf(admin.id);
      assert.equal(memberships[0]?.name, 'Administrators');
      assert.equal(memberships[0].isPrimary, true);
    });
  });
});

describe('a group name, as create and rename both store it (A-81)', () => {
  it('is trimmed, and its length is what is left', () => {
    assert.equal(checkedGroupName('  On call '), 'On call');
    assert.equal(checkedGroupName(` ${'x'.repeat(100)} `), 'x'.repeat(100));
    assert.throws(() => checkedGroupName('x'.repeat(101)), /between 1 and 100/);
    assert.throws(() => checkedGroupName(' \t\n '), /between 1 and 100/);
  });
});
