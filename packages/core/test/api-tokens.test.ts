import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AccessService } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { TokenService } from '../src/auth/tokens.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, testActor } from './support/tree.js';

/**
 * API tokens (`A-06`).
 *
 * **The claim under test is that a token is never more than its owner.** Its scope narrows, and
 * only narrows: a read-only account cannot mint a writing token, a token cannot mint another
 * token, and disabling the account stops every token it holds without anybody revoking them one
 * at a time. Everything else here — the hash, the once-only secret, the prefix — is the same
 * rule the probe access key and the session cookie already follow.
 */

const available = await databaseAvailable();

describe('api tokens', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let tokens: TokenService;
  let accounts: AccountService;
  let groups: GroupService;
  let access: AccessService;
  let userId = 0;
  let teamId = 0;
  let deviceId = 0;

  before(async () => {
    scratch = await createScratchDatabase('apitokens');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM api_token');
    await db.query('DELETE FROM object_access');
    await db.query('DELETE FROM user_group_member');
    await db.query('DELETE FROM user_group WHERE NOT is_builtin');
    await db.query('DELETE FROM user_account');
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');

    tokens = new TokenService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silentLogger });

    const account = await accounts.create(
      {
        login: 'ops',
        password: 'correct-horse-battery',
        role: 'readwrite',
      },
      testActor,
    );
    userId = account.id;
    teamId = (await groups.create({ name: 'Team' }, testActor)).id;
    await groups.addMember(teamId, userId, testActor);

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
    await access.grant(deviceId, teamId, 'full', actorNamed('test'));
  });

  const ownerOf = () => ({ userId, role: 'readwrite' as const });

  describe('issuing', () => {
    it('returns the secret once and stores only its hash', async () => {
      const { token, secret } = await tokens.issue(ownerOf(), { name: 'backup script' }, testActor);
      assert.ok(secret.startsWith('mst_'), 'greppable in a log somebody is about to regret');
      assert.ok(secret.length > 30);

      const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM api_token');
      assert.notEqual(rows[0]?.token_hash, secret);
      assert.equal(rows[0]?.token_hash.length, 64, 'a SHA-256, hex');

      // And nothing anywhere gives it back.
      const listed = await tokens.listFor(userId);
      assert.equal(JSON.stringify(listed).includes(secret.slice(8)), false);
      assert.equal(token.prefix, secret.slice(0, 12));
    });

    it('refuses a second live token of the same name', async () => {
      await tokens.issue(ownerOf(), { name: 'backup script' }, testActor);
      await assert.rejects(
        () => tokens.issue(ownerOf(), { name: 'Backup Script' }, testActor),
        /already has/,
      );
    });

    it('releases the name once the token is revoked', async () => {
      // A token replaced after a leak usually wants the name of the one it replaced.
      const { token } = await tokens.issue(ownerOf(), { name: 'backup script' }, testActor);
      await tokens.revoke(userId, token.id, actorNamed('ops'));
      const again = await tokens.issue(ownerOf(), { name: 'backup script' }, testActor);
      assert.equal(again.token.name, 'backup script');
    });

    it('refuses an expiry in the past', async () => {
      await assert.rejects(
        () =>
          tokens.issue(ownerOf(), { name: 'stale', expiresAt: new Date('2020-01-01') }, testActor),
        /expire in the past/,
      );
    });

    it('defaults to read, because a token that can write should be asked for', async () => {
      const { token } = await tokens.issue(ownerOf(), { name: 'reader' }, testActor);
      assert.equal(token.scope, 'read');
    });
  });

  describe('a token is never more than its owner', () => {
    it('lowers a scope above the account’s role at creation', async () => {
      // Not refused: the request is coherent, and the answer is "that is as much as you have".
      const readonly = await accounts.create(
        {
          login: 'viewer',
          password: 'correct-horse-battery',
          role: 'readonly',
        },
        testActor,
      );
      const { token } = await tokens.issue(
        { userId: readonly.id, role: 'readonly' },
        { name: 'wishful', scope: 'full' },
        testActor,
      );
      assert.equal(token.scope, 'read');
    });

    it('caps the resolved right at the token’s scope', async () => {
      // The account's groups grant `full` on this device; the token says `read`.
      const { secret } = await tokens.issue(
        ownerOf(),
        { name: 'reader', scope: 'read' },
        testActor,
      );
      const principal = await tokens.resolve(secret);
      assert.ok(principal);

      const resolved = await access.resolveFor(
        { userId: principal.userId, role: principal.role, scope: principal.scope },
        deviceId,
      );
      assert.equal(resolved.right, 'read');
      assert.equal(resolved.cappedByToken, true);
    });

    it('does not cap when the scope is as wide as the account', async () => {
      const { secret } = await tokens.issue(
        ownerOf(),
        { name: 'writer', scope: 'full' },
        testActor,
      );
      const principal = await tokens.resolve(secret);
      assert.ok(principal);
      const resolved = await access.resolveFor(
        { userId: principal.userId, role: principal.role, scope: principal.scope },
        deviceId,
      );
      assert.equal(resolved.right, 'full');
      assert.equal(resolved.cappedByToken, undefined);
    });

    it('never raises a right the account does not have', async () => {
      // A `full` token on an object the account's groups grant nothing on is still nothing.
      const other = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      const { secret } = await tokens.issue(ownerOf(), { name: 'wide', scope: 'full' }, testActor);
      const principal = await tokens.resolve(secret);
      assert.ok(principal);
      const resolved = await access.resolveFor(
        { userId: principal.userId, role: principal.role, scope: principal.scope },
        other.id,
      );
      assert.equal(resolved.right, 'none');
    });

    it('applies both ceilings, role first then scope', async () => {
      const readonly = await accounts.create(
        {
          login: 'viewer',
          password: 'correct-horse-battery',
          role: 'readonly',
        },
        testActor,
      );
      await groups.addMember(teamId, readonly.id, testActor);
      const { secret } = await tokens.issue(
        { userId: readonly.id, role: 'readonly' },
        { name: 'both', scope: 'full' },
        testActor,
      );
      const principal = await tokens.resolve(secret);
      assert.ok(principal);
      const resolved = await access.resolveFor(
        { userId: principal.userId, role: principal.role, scope: principal.scope },
        deviceId,
      );
      assert.equal(resolved.right, 'read', 'groups grant full, role caps to read');
    });
  });

  describe('resolving', () => {
    it('resolves the token it issued', async () => {
      const { secret } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      const principal = await tokens.resolve(secret);
      assert.equal(principal?.login, 'ops');
      assert.equal(principal.role, 'readwrite');
    });

    it('refuses one it never issued', async () => {
      assert.equal(await tokens.resolve('mst_not-a-real-token'), null);
    });

    it('refuses anything without the prefix, without touching the database', async () => {
      assert.equal(await tokens.resolve('some-other-scheme'), null);
    });

    it('refuses a revoked token', async () => {
      const { token, secret } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      await tokens.revoke(userId, token.id, actorNamed('ops'));
      assert.equal(await tokens.resolve(secret), null);
    });

    it('refuses an expired one', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const expiring = new TokenService({
        audit: new DatabaseAuditSink(),
        db,
        logger: silentLogger,
        now: () => clock,
      });
      const { secret } = await expiring.issue(
        ownerOf(),
        {
          name: 'short',
          expiresAt: new Date('2026-08-28T10:00:00.000Z'),
        },
        testActor,
      );
      assert.ok(await expiring.resolve(secret));
      clock = new Date('2026-08-28T11:00:00.000Z');
      assert.equal(await expiring.resolve(secret), null);
    });

    it('stops every token the moment the account is disabled', async () => {
      // Nobody should have to revoke them one at a time during an incident.
      const first = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      const second = await tokens.issue(ownerOf(), { name: 'two' }, testActor);
      await accounts.update(userId, { disabled: true }, testActor);
      assert.equal(await tokens.resolve(first.secret), null);
      assert.equal(await tokens.resolve(second.secret), null);
    });

    it('goes away with the account', async () => {
      const { secret } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      await accounts.delete(userId, testActor);
      assert.equal(await tokens.resolve(secret), null);
      assert.equal((await db.query('SELECT id FROM api_token')).length, 0);
    });
  });

  describe('last used', () => {
    it('is recorded', async () => {
      const { token, secret } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      assert.equal(token.lastUsedAt, null);
      await tokens.resolve(secret);
      const listed = await tokens.listFor(userId);
      assert.notEqual(listed[0]?.lastUsedAt, null);
    });

    it('is not written on every single use', async () => {
      // A polling script would otherwise turn every read into a write — a lot of WAL for a
      // column nobody reads at that resolution.
      const clock = new Date('2026-08-28T09:00:00.000Z');
      const coarse = new TokenService({
        audit: new DatabaseAuditSink(),
        db,
        logger: silentLogger,
        now: () => clock,
        lastUsedResolutionMs: 60_000,
      });
      const { secret } = await coarse.issue(ownerOf(), { name: 'busy' }, testActor);
      await coarse.resolve(secret);
      const first = (await coarse.listFor(userId))[0]?.lastUsedAt;

      for (let use = 0; use < 5; use += 1) await coarse.resolve(secret);
      assert.equal(
        (await coarse.listFor(userId))[0]?.lastUsedAt,
        first,
        'unchanged within the window',
      );
    });

    it('is written again once the window has passed', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const coarse = new TokenService({
        audit: new DatabaseAuditSink(),
        db,
        logger: silentLogger,
        now: () => clock,
        lastUsedResolutionMs: 60_000,
      });
      const { secret } = await coarse.issue(ownerOf(), { name: 'busy' }, testActor);
      await coarse.resolve(secret);
      const first = (await coarse.listFor(userId))[0]?.lastUsedAt;

      clock = new Date('2026-08-28T09:05:00.000Z');
      await coarse.resolve(secret);
      assert.notEqual((await coarse.listFor(userId))[0]?.lastUsedAt, first);
    });
  });

  describe('revoking', () => {
    it('refuses to revoke somebody else’s token', async () => {
      // A token id is a small integer; without the owner check this is one guess away.
      const stranger = await accounts.create(
        {
          login: 'stranger',
          password: 'correct-horse-battery',
          role: 'readwrite',
        },
        testActor,
      );
      const { token, secret } = await tokens.issue(ownerOf(), { name: 'mine' }, testActor);
      assert.equal(await tokens.revoke(stranger.id, token.id, actorNamed('stranger')), false);
      assert.ok(await tokens.resolve(secret), 'and it still works');
    });

    it('is idempotent', async () => {
      const { token } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      assert.equal(await tokens.revoke(userId, token.id, actorNamed('ops')), true);
      assert.equal(await tokens.revoke(userId, token.id, actorNamed('ops')), false);
    });

    it('revokes every token at once, which is what a compromise needs', async () => {
      await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      await tokens.issue(ownerOf(), { name: 'two' }, testActor);
      assert.equal(await tokens.revokeAllFor(userId, actorNamed('admin')), 2);
      assert.deepEqual(await tokens.listFor(userId), []);
    });

    it('keeps revoked tokens on the record, and can show them', async () => {
      const { token } = await tokens.issue(ownerOf(), { name: 'one' }, testActor);
      await tokens.revoke(userId, token.id, actorNamed('ops'));
      assert.deepEqual(await tokens.listFor(userId), []);
      const withRevoked = await tokens.listFor(userId, true);
      assert.equal(withRevoked.length, 1);
      assert.notEqual(withRevoked[0]?.revokedAt, null);
    });
  });
});
