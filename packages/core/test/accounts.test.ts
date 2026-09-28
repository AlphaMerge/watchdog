import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { AccessService } from '../src/auth/access.js';
import { sessionIdFor } from '../src/auth/passwords.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { testActor } from './support/tree.js';

/**
 * Accounts, sessions and login throttling (`A-01`).
 *
 * **Most of what is asserted here is what does *not* happen.** That a wrong password and an
 * absent account are indistinguishable from the outside; that a database row does not contain
 * anything that would let its reader log in; that a disabled account's sessions stop working
 * without anybody having to remember to end them; and that throttling cannot be turned into a
 * way to lock an operator out of their own system.
 */

const available = await databaseAvailable();

describe('accounts and sessions', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let accounts: AccountService;
  let sessions: SessionService;

  before(async () => {
    scratch = await createScratchDatabase('accounts');
    db = scratch.db;
    // The tree harness is what usually runs these; nothing here needs an object tree, so the
    // migrator is driven directly rather than standing one up to get a schema.
    await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_session');
    await db.query('DELETE FROM login_attempt');
    await db.query('DELETE FROM user_account');
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
    sessions = new SessionService({ db, logger: silentLogger });
  });

  const makeAccount = async (over: Partial<Parameters<AccountService['create']>[0]> = {}) =>
    accounts.create(
      {
        login: 'ops',
        password: 'correct-horse-battery',
        role: 'readwrite',
        ...over,
      },
      testActor,
    );

  describe('passwords', () => {
    it('accepts the right one and refuses the wrong one', async () => {
      await makeAccount();
      assert.equal((await accounts.authenticate('ops', 'correct-horse-battery')).kind, 'ok');
      assert.equal((await accounts.authenticate('ops', 'wrong')).kind, 'rejected');
    });

    it('never stores the password itself', async () => {
      await makeAccount();
      const rows = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM user_account',
      );
      const stored = rows[0]?.password_hash ?? '';
      assert.ok(stored.startsWith('$argon2id$'), 'stored as argon2id');
      assert.equal(stored.includes('correct-horse-battery'), false);
    });

    it('treats the login case-insensitively, because 3am typing is not a different person', async () => {
      await makeAccount({ login: 'Ops' });
      assert.equal((await accounts.authenticate('oPS', 'correct-horse-battery')).kind, 'ok');
    });

    it('refuses a second account differing only in case', async () => {
      await makeAccount({ login: 'ops' });
      await assert.rejects(() => makeAccount({ login: 'OPS' }), /already exists/);
    });

    it('refuses a password short enough to be guessed', async () => {
      await assert.rejects(() => makeAccount({ password: 'short' }), /at least 12/);
    });

    it('gives the same answer for a wrong password as for no such account', async () => {
      // Both must be `rejected`; the *reason* exists for the log and never leaves the service.
      await makeAccount();
      const wrong = await accounts.authenticate('ops', 'nope');
      const absent = await accounts.authenticate('nobody', 'nope');
      assert.equal(wrong.kind, 'rejected');
      assert.equal(absent.kind, 'rejected');
    });

    it('spends comparable time on an account that does not exist', async () => {
      // The timing side of the same claim. A missing account that returns in a microsecond while
      // a real one takes 45 ms is a login enumerator, and a login is half a credential. Generous
      // bounds: this asserts the decoy verification happens at all, not a precise duration.
      await makeAccount();
      const timeOf = async (login: string): Promise<number> => {
        const started = process.hrtime.bigint();
        await accounts.authenticate(login, 'some-wrong-password');
        return Number(process.hrtime.bigint() - started) / 1e6;
      };
      const real = await timeOf('ops');
      const absent = await timeOf('does-not-exist');
      assert.ok(
        absent > real / 4,
        `an absent account answered in ${absent.toFixed(1)} ms against ${real.toFixed(1)} ms for a real one`,
      );
    });

    it('refuses a disabled account, but only after checking the password', async () => {
      // Order matters: answering "disabled" before verifying would be faster for a disabled
      // account than for an enabled one, which says whether the login exists.
      const account = await makeAccount();
      await accounts.update(account.id, { disabled: true }, testActor);
      const outcome = await accounts.authenticate('ops', 'correct-horse-battery');
      assert.equal(outcome.kind, 'rejected');
      assert.equal(outcome.reason, 'disabled');
    });

    it('requires the current password to change it, unless an administrator resets it', async () => {
      const account = await makeAccount();
      await assert.rejects(
        () =>
          accounts.changePassword(account.id, 'a-brand-new-password', testActor, {
            current: 'wrong',
          }),
        /not accepted/,
      );
      await accounts.changePassword(account.id, 'a-brand-new-password', testActor, {
        current: 'correct-horse-battery',
      });
      assert.equal((await accounts.authenticate('ops', 'a-brand-new-password')).kind, 'ok');
    });

    it('forces a reset password to be replaced at the next login', async () => {
      // The password an administrator chose must not outlive the conversation it was
      // communicated in.
      const account = await makeAccount();
      await accounts.changePassword(account.id, 'temporary-for-now', testActor, {
        byAdministrator: true,
      });
      const stored = await accounts.get(account.id);
      assert.equal(stored?.mustChangePassword, true);
    });
  });

  describe('the first administrator', () => {
    it('is created when there are none, with a password nobody chose', async () => {
      const first = await accounts.ensureFirstAdministrator();
      assert.ok(first !== null);
      assert.equal(first.login, 'admin');
      assert.ok(first.password.length >= 20, 'generated, not a default anybody could guess');

      const account = await accounts.byLogin('admin');
      assert.equal(account?.role, 'admin');
      assert.equal(account.mustChangePassword, true, 'and it does not survive the first login');
    });

    it('can actually administer the installation it was created for', async () => {
      // **`role: 'admin'` is not a right on any object.** `AccessService` grants `full` on
      // everything through membership of a group with `is_admin`, and otherwise falls through to
      // per-object grants — of which a brand new installation has none. Without the membership
      // the only account on a fresh box passes every role bar and is refused by all 32
      // object-scoped routes, which is most of the API.
      //
      // Invisible for as long as it existed, because migration 032 backfills every account that
      // already exists into a group: an upgraded database has a working administrator and only a
      // database created after 032 does not. The install smoke test builds one of those, and
      // found this the first time it had a credential to be refused with (`U-20`).
      await accounts.ensureFirstAdministrator();
      const account = await accounts.byLogin('admin');
      assert.ok(account !== null, 'the bootstrap account exists');

      const access = new AccessService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
      });
      const resolved = await access.resolve(account.id, 999_999);
      assert.equal(resolved.right, 'full');
      assert.equal(
        resolved.viaAdminGroup,
        true,
        'and by being an administrator, not by a grant on one object',
      );
    });

    it('does nothing at all once any account exists', async () => {
      // This runs at every start-up. Creating a second administrator on each restart, or
      // resetting the first one's password, would be worse than not running.
      await makeAccount();
      assert.equal(await accounts.ensureFirstAdministrator(), null);
      assert.equal((await accounts.list()).length, 1);
    });
  });

  describe('sessions', () => {
    const context = { remoteAddress: '10.0.0.9', userAgent: 'test' };

    it('resolves the token it issued', async () => {
      const account = await makeAccount();
      const { token } = await sessions.start(account, context);
      const principal = await sessions.resolve(token);
      assert.equal(principal?.login, 'ops');
      assert.equal(principal.role, 'readwrite');
    });

    it('stores a hash, so the row is not a login', async () => {
      // The claim `R-01` makes about probe keys, made here about sessions: a database dump, a
      // backup or a SELECT in a bug report must not yield a working session.
      const account = await makeAccount();
      const { token } = await sessions.start(account, context);
      const rows = await db.query<{ id: string }>('SELECT id FROM user_session');
      const stored = rows[0]?.id ?? '';
      assert.equal(stored, sessionIdFor(token));
      assert.notEqual(stored, token);
      assert.equal(await sessions.resolve(stored), null, 'the stored value is not a key');
    });

    it('refuses a token it never issued', async () => {
      assert.equal(await sessions.resolve('not-a-real-token'), null);
    });

    it('stops resolving once the session is ended', async () => {
      const account = await makeAccount();
      const { token } = await sessions.start(account, context);
      await sessions.end(token);
      assert.equal(await sessions.resolve(token), null);
    });

    it('ends every session an account holds, which is what a password change needs', async () => {
      // The reason somebody changes a password is usually that they think somebody else knows
      // it. Leaving the sessions it opened is leaving the door they were worried about.
      const account = await makeAccount();
      const first = await sessions.start(account, context);
      const second = await sessions.start(account, context);
      assert.equal(await sessions.endAllFor(account.id), 2);
      assert.equal(await sessions.resolve(first.token), null);
      assert.equal(await sessions.resolve(second.token), null);
    });

    it('can keep the session doing the ending, so changing your own password does not log you out', async () => {
      const account = await makeAccount();
      const keep = await sessions.start(account, context);
      const other = await sessions.start(account, context);
      const principal = await sessions.resolve(keep.token);
      assert.equal(await sessions.endAllFor(account.id, principal?.sessionId), 1);
      assert.ok(await sessions.resolve(keep.token));
      assert.equal(await sessions.resolve(other.token), null);
    });

    it('stops resolving when the account is disabled, without anyone ending the session', async () => {
      // Disabling an account has to take effect now, not when its sessions happen to expire.
      const account = await makeAccount();
      const { token } = await sessions.start(account, context);
      await accounts.update(account.id, { disabled: true }, testActor);
      assert.equal(await sessions.resolve(token), null);
    });

    it('expires an idle session, and prunes it', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const shortLived = new SessionService({
        db,
        logger: silentLogger,
        idleTimeoutMs: 60_000,
        now: () => clock,
      });
      const account = await makeAccount();
      const { token } = await shortLived.start(account, context);

      clock = new Date('2026-08-28T09:00:30.000Z');
      assert.ok(await shortLived.resolve(token), 'still inside the idle window');

      clock = new Date('2026-08-28T09:02:00.000Z');
      assert.equal(await shortLived.resolve(token), null, 'past it');
      assert.equal(await shortLived.prune(), 1);
    });

    it('rolls the expiry forward as it is used, so a long shift is not interrupted', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const rolling = new SessionService({
        db,
        logger: silentLogger,
        idleTimeoutMs: 60_000,
        now: () => clock,
      });
      const account = await makeAccount();
      const { token } = await rolling.start(account, context);

      // Used every 45 seconds for four minutes: never idle for a minute, so never expired,
      // even though four minutes is well past the idle timeout.
      for (let step = 1; step <= 5; step += 1) {
        clock = new Date(clock.getTime() + 45_000);
        assert.ok(await rolling.resolve(token), `still valid at step ${String(step)}`);
      }
    });

    it('will not roll past the absolute ceiling, however busy the session', async () => {
      // Rolling expiry without a ceiling is a session that never ends, which is the thing an
      // absolute timeout exists to prevent.
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const capped = new SessionService({
        db,
        logger: silentLogger,
        idleTimeoutMs: 60_000,
        absoluteTimeoutMs: 120_000,
        now: () => clock,
      });
      const account = await makeAccount();
      const { token } = await capped.start(account, context);

      clock = new Date(clock.getTime() + 45_000);
      assert.ok(await capped.resolve(token));
      clock = new Date(clock.getTime() + 45_000);
      assert.ok(await capped.resolve(token));
      clock = new Date(clock.getTime() + 45_000);
      assert.equal(await capped.resolve(token), null, 'past two minutes from creation');
    });
  });

  describe('login throttling', () => {
    const addressOf = (n: number) => `192.0.2.${String(n)}`;

    it('delays an account that keeps failing, rather than locking it', async () => {
      // **Locking is a denial of service.** Anybody who knows an operator's login could lock
      // them out of their own monitoring system by failing to log in as them — during the
      // outage they are trying to investigate.
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await throttle.record('ops', addressOf(attempt), false);
      }
      const verdict = await throttle.check('ops', addressOf(99));
      assert.equal(verdict.refused, false, 'the account is never locked by somebody else');
      assert.ok(verdict.delayMs > 0, 'but every attempt against it is slowed');
    });

    it('refuses an address that keeps failing, whatever it is guessing at', async () => {
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 3 },
        sleep: () => Promise.resolve(),
      });
      // Failing against logins that do not exist is exactly the traffic worth stopping: it is
      // an enumerator, and no honest client produces it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await throttle.record(`guess-${String(attempt)}`, '198.51.100.7', false);
      }
      const verdict = await throttle.check('anything', '198.51.100.7');
      assert.equal(verdict.refused, true);
      assert.ok(verdict.retryAfterSeconds > 0, 'and says when to come back');
    });

    it('leaves other addresses alone when one is refused', async () => {
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 3 },
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await throttle.record('ops', '198.51.100.7', false);
      }
      assert.equal((await throttle.check('ops', '198.51.100.8')).refused, false);
    });

    it('does not count successes towards either limit', async () => {
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 2 },
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await throttle.record('ops', '198.51.100.9', true);
      }
      const verdict = await throttle.check('ops', '198.51.100.9');
      assert.equal(verdict.refused, false);
      assert.equal(verdict.delayMs, 0);
    });

    it('forgets failures once they fall outside the window', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 2, windowMs: 60_000 },
        now: () => clock,
        sleep: () => Promise.resolve(),
      });
      await throttle.record('ops', '203.0.113.4', false);
      await throttle.record('ops', '203.0.113.4', false);
      assert.equal((await throttle.check('ops', '203.0.113.4')).refused, true);

      clock = new Date(clock.getTime() + 120_000);
      assert.equal((await throttle.check('ops', '203.0.113.4')).refused, false);
    });

    it('survives a restart, because a crash must not hand out a fresh allowance', async () => {
      // Counted in the database rather than in memory for exactly this. An attacker who can make
      // a service restart should not get their attempt budget back for doing it.
      const first = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 2 },
        sleep: () => Promise.resolve(),
      });
      await first.record('ops', '203.0.113.9', false);
      await first.record('ops', '203.0.113.9', false);

      const afterRestart = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 2 },
        sleep: () => Promise.resolve(),
      });
      assert.equal((await afterRestart.check('ops', '203.0.113.9')).refused, true);
    });

    it('prunes attempts old enough to be irrelevant', async () => {
      let clock = new Date('2026-08-28T09:00:00.000Z');
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { windowMs: 60_000 },
        now: () => clock,
        sleep: () => Promise.resolve(),
      });
      await throttle.record('ops', '203.0.113.5', false);
      clock = new Date(clock.getTime() + 10 * 60_000);
      assert.equal(await throttle.prune(), 1);
    });
  });
});
