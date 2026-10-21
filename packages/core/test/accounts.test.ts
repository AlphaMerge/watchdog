import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle, type LoginThrottleConfig } from '../src/auth/throttle.js';
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
      //
      // **Each side is the median of seven logins, taken in turn** (`P-428`). One login against
      // one other let a single stall decide it: 111 ms for the absent account against 600 for the
      // real one, on a VM another run was sharing. Taken in turn, a slow stretch of the machine
      // lands on both sides, and a median needs four slow logins on one side to move.
      await makeAccount();
      const timeOf = async (login: string): Promise<number> => {
        const started = process.hrtime.bigint();
        await accounts.authenticate(login, 'some-wrong-password');
        return Number(process.hrtime.bigint() - started) / 1e6;
      };
      const reals: number[] = [];
      const absents: number[] = [];
      for (let turn = 0; turn < 7; turn += 1) {
        reals.push(await timeOf('ops'));
        absents.push(await timeOf('does-not-exist'));
      }
      const median = (times: readonly number[]): number =>
        [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? Number.NaN;
      const real = median(reals);
      const absent = median(absents);
      const listed = (times: readonly number[]): string =>
        times.map((ms) => ms.toFixed(1)).join(', ');
      assert.ok(
        absent > real / 4,
        `an absent account answered in a median ${absent.toFixed(1)} ms against ` +
          `${real.toFixed(1)} ms for a real one (absent ${listed(absents)}; real ${listed(reals)})`,
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

    it('applies an idle timeout lowered since a session was last used (A-47)', async () => {
      // The wall-display recipe set it to three days; set back to twelve hours, a tab nobody has
      // touched since has to lapse at twelve hours, not whenever three days would have run out.
      const HOUR = 3_600_000;
      let clock = new Date('2026-09-29T09:00:00.000Z');
      const options = { db, logger: silentLogger, absoluteTimeoutMs: 30 * 24 * HOUR };
      const generous = new SessionService({
        ...options,
        idleTimeoutMs: 3 * 24 * HOUR,
        now: () => clock,
      });
      const account = await makeAccount();
      const idle = await generous.start(account, context);
      const used = await generous.start(account, context);
      assert.ok(await generous.resolve(idle.token), 'extended under the old timeout');
      assert.ok(await generous.resolve(used.token));

      const lowered = new SessionService({
        ...options,
        idleTimeoutMs: 12 * HOUR,
        now: () => clock,
      });
      const asked = [{ id: sessionIdFor(idle.token), userId: account.id }];

      clock = new Date(clock.getTime() + 11 * HOUR);
      assert.deepEqual(await lowered.lapsed(asked), new Map(), 'inside twelve hours');
      assert.ok(await lowered.resolve(used.token), 'and a session in use goes on');

      clock = new Date(clock.getTime() + 2 * HOUR);
      assert.deepEqual(await lowered.lapsed(asked), new Map([[asked[0]?.id, 'expired']]));
      assert.equal(await lowered.resolve(idle.token), null, 'thirteen hours idle is past twelve');
      assert.ok(await lowered.resolve(used.token), 'two hours idle is not');
    });
  });

  describe('login throttling', () => {
    const addressOf = (n: number) => `192.0.2.${String(n)}`;

    it('delays an account that keeps failing, rather than locking it', async () => {
      // **Locking is a denial of service.** Anybody who knows an operator's login could lock
      // them out of their own monitoring system by failing to log in as them — during the
      // outage they are trying to investigate.
      let clock = new Date('2026-09-29T09:00:00.000Z');
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        now: () => clock,
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await throttle.record('ops', addressOf(attempt), false);
      }
      // Five failures: a gate of 2.5 s from the last, which an attempt inside it meets unverified
      // (`A-47`), from anywhere.
      const early = await throttle.check('ops', addressOf(99));
      assert.deepEqual(early, { refused: true, why: 'login', retryAfterSeconds: 3 });

      clock = new Date(clock.getTime() + 2_500);
      const verdict = await throttle.check('ops', addressOf(99));
      assert.equal(verdict.refused, false, 'the account is never locked by somebody else');
      assert.equal(verdict.delayMs, 3_000, 'but a sixth failure closes it for longer');
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
        await throttle.record(`guess-${String(attempt)}`, '198.51.100.7', false);
      }
      assert.equal((await throttle.check('ops', '198.51.100.7')).refused, true);
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

    // `P-247`: the stamps are wall-clock, and a backward step of the clock left every failure before
    // it in the future: the address stayed blocked for the step and the block besides.
    it('blocks for the block and no longer across a backward step of the clock', async () => {
      let clock = new Date('2026-09-29T09:00:00.000Z');
      const throttle = new LoginThrottle({
        db,
        logger: silentLogger,
        config: { maxPerAddress: 2, windowMs: 60_000, addressBlockMs: 60_000 },
        now: () => clock,
        sleep: () => Promise.resolve(),
      });
      await throttle.record('ops', '203.0.113.21', false);
      await throttle.record('ops', '203.0.113.21', false);

      // The clock is put back an hour.
      clock = new Date(clock.getTime() - 3_600_000);
      const blocked = await throttle.check('ops', '203.0.113.21');
      assert.equal(blocked.refused, true, 'the failures still count, as now');
      assert.ok(
        blocked.retryAfterSeconds <= 60,
        `a minute's block, not an hour and a minute: ${JSON.stringify(blocked)}`,
      );

      clock = new Date(clock.getTime() + 61_000);
      assert.equal(
        (await throttle.check('ops', '203.0.113.21')).refused,
        false,
        'free once the block has passed on the clock as it now reads',
      );
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

    describe('the gate, one verification at a time, and the known address (A-47)', () => {
      let clock: Date;
      const make = (config: Partial<LoginThrottleConfig> = {}, database: Database = db) =>
        new LoginThrottle({
          db: database,
          logger: silentLogger,
          config,
          now: () => clock,
          sleep: () => Promise.resolve(),
        });

      beforeEach(() => {
        clock = new Date('2026-09-29T09:00:00.000Z');
      });

      /** Where the clock is now plus `ms`. */
      const advance = (ms: number): void => {
        clock = new Date(clock.getTime() + ms);
      };

      it('closes the gate for as long as a failure’s answer is waited out, and no longer', async () => {
        const slept: number[] = [];
        const throttle = new LoginThrottle({
          db,
          logger: silentLogger,
          now: () => clock,
          sleep: (ms) => {
            slept.push(ms);
            return Promise.resolve();
          },
        });
        const first = await throttle.admit('ops', '198.51.100.1');
        assert.ok(first.admitted);
        await throttle.record('ops', '198.51.100.1', false);
        first.release();
        await throttle.waitOut(first);
        assert.deepEqual(slept, [500]);

        advance(499);
        assert.deepEqual(await throttle.admit('ops', '198.51.100.2'), {
          admitted: false,
          why: 'login',
          retryAfterSeconds: 1,
        });
        advance(1);
        const second = await throttle.admit('ops', '198.51.100.2');
        assert.ok(second.admitted, 'a client that waited for its answer finds the gate open');
        assert.equal(second.delayMs, 1_000);
        second.release();
      });

      it('never grows the gate past its ceiling', async () => {
        const throttle = make();
        for (let n = 0; n < 40; n += 1) await throttle.record('ops', addressOf(n), false);
        assert.deepEqual(await throttle.check('ops', addressOf(99)), {
          refused: true,
          why: 'login',
          retryAfterSeconds: 5,
        });
        advance(5_000);
        const verdict = await throttle.check('ops', addressOf(99));
        assert.deepEqual(verdict, { refused: false, delayMs: 5_000 });
      });

      it('lets one attempt per login be verified at a time, whatever its spelling', async () => {
        const throttle = make();
        const held = await throttle.admit('ops', '198.51.100.1');
        assert.ok(held.admitted);
        assert.deepEqual(await throttle.admit('OPS', '203.0.113.1'), {
          admitted: false,
          why: 'in-flight',
          retryAfterSeconds: 1,
        });
        const other = await throttle.admit('admin', '198.51.100.1');
        assert.ok(other.admitted, 'another login is not held up');
        other.release();

        held.release();
        const next = await throttle.admit('ops', '203.0.113.1');
        assert.ok(next.admitted, 'given back');
        held.release();
        assert.deepEqual(
          await throttle.admit('ops', '203.0.113.2'),
          { admitted: false, why: 'in-flight', retryAfterSeconds: 1 },
          'and giving it back twice does not give back the one another attempt took since',
        );
        next.release();
      });

      /**
       * A throttle whose next reading of the counts is held after it returns, so a test can record
       * an attempt between the counts being read and the slot being taken.
       */
      const pausing = (): {
        throttle: LoginThrottle;
        pauseNext: () => { counted: Promise<void>; resume: () => void };
      } => {
        let paused: { reached: () => void; hold: Promise<void> } | undefined;
        const database = {
          query: async (text: string, values?: readonly unknown[]) => {
            const rows = await db.query(text, values);
            const pause = paused;
            if (pause !== undefined && text.includes('AS by_login')) {
              paused = undefined;
              pause.reached();
              await pause.hold;
            }
            return rows;
          },
        } as unknown as Database;
        return {
          throttle: make({}, database),
          pauseNext: () => {
            let reached: () => void = () => undefined;
            let resume: () => void = () => undefined;
            const counted = new Promise<void>((resolve) => {
              reached = resolve;
            });
            const hold = new Promise<void>((resolve) => {
              resume = resolve;
            });
            paused = { reached, hold };
            return { counted, resume };
          },
        };
      };

      it('turns away an attempt whose counts were read before a failure it did not see', async () => {
        // The window between reading the counts and taking the slot: B reads no failures, A fails
        // and gives the slot back, and B would take it with the gate A just closed in its face.
        const { throttle, pauseNext } = pausing();
        const a = await throttle.admit('ops', '198.51.100.1');
        assert.ok(a.admitted);
        const { counted, resume } = pauseNext();
        const b = throttle.admit('ops', '198.51.100.2');
        await counted;
        await throttle.record('ops', '198.51.100.1', false);
        a.release();
        resume();
        assert.deepEqual(await b, { admitted: false, why: 'in-flight', retryAfterSeconds: 1 });

        // And the next one reads the failure, so it meets the gate.
        assert.deepEqual(await throttle.admit('ops', '198.51.100.2'), {
          admitted: false,
          why: 'login',
          retryAfterSeconds: 1,
        });
      });

      it('lets an attempt in that was deciding while a success was recorded', async () => {
        const { throttle, pauseNext } = pausing();
        const a = await throttle.admit('ops', '198.51.100.1');
        assert.ok(a.admitted);
        const { counted, resume } = pauseNext();
        const b = throttle.admit('ops', '198.51.100.2');
        await counted;
        await throttle.record('ops', '198.51.100.1', true);
        a.release();
        resume();
        const admitted = await b;
        assert.ok(admitted.admitted, 'a success closes no gate');
        admitted.release();
      });

      it('lets the address that logged in as a login skip its gate while an attacker fails', async () => {
        const throttle = make();
        await throttle.record('ops', '203.0.113.50', true);
        advance(60_000);
        // An attacker keeps the gate shut from everywhere else.
        for (let n = 0; n < 30; n += 1) {
          await throttle.record('ops', addressOf(n), false);
          advance(100);
          const attacker = await throttle.admit('ops', addressOf(n + 100));
          assert.equal(attacker.admitted, false, `attacker ${String(n)}`);
          const victim = await throttle.admit('ops', '203.0.113.50');
          assert.ok(victim.admitted, `the victim, round ${String(n)}`);
          assert.equal(victim.delayMs, 0, 'and does not wait out a mistyped password either');
          victim.release();
        }
        const elsewhere = await throttle.admit('ops', '203.0.113.51');
        assert.equal(
          elsewhere.admitted,
          false,
          'from somewhere new, the victim waits like anybody',
        );
        const failedFrom = await throttle.admit('ops', addressOf(29));
        assert.equal(
          failedFrom.admitted,
          false,
          'and an address that has only failed as the login is not one it logged in from',
        );
      });

      it('still holds the known address to one verification at a time, and to its failures', async () => {
        const throttle = make({ maxPerAddress: 3 });
        await throttle.record('ops', '203.0.113.50', true);
        const attacker = await throttle.admit('ops', '198.51.100.1');
        assert.ok(attacker.admitted);
        assert.deepEqual(await throttle.admit('ops', '203.0.113.50'), {
          admitted: false,
          why: 'in-flight',
          retryAfterSeconds: 1,
        });
        attacker.release();

        // Somebody guessing from the known address is held by that address's limit.
        for (let n = 0; n < 3; n += 1)
          await throttle.record(`guess-${String(n)}`, '203.0.113.50', false);
        assert.deepEqual(await throttle.admit('ops', '203.0.113.50'), {
          admitted: false,
          why: 'address',
          retryAfterSeconds: 900,
        });
      });

      it('knows an address for thirty days, for that login, from its /64', async () => {
        const throttle = make();
        await throttle.record('ops', '2001:db8:5:6::1', true);
        await throttle.record('ops', addressOf(1), false);
        const sameSubnet = await throttle.check('ops', '2001:db8:5:6:ffff::9');
        assert.deepEqual(sameSubnet, { refused: false, delayMs: 0 }, 'the /64 is the address');
        assert.equal((await throttle.check('admin', '2001:db8:5:6::1')).refused, false);
        await throttle.record('admin', addressOf(2), false);
        assert.equal(
          (await throttle.check('admin', '2001:db8:5:6::1')).refused,
          true,
          'known for the login it logged in as, not for another',
        );

        advance(30 * 24 * 3_600_000 - 1_000);
        await throttle.record('ops', addressOf(3), false);
        assert.deepEqual(await throttle.check('ops', '2001:db8:5:6::1'), {
          refused: false,
          delayMs: 0,
        });
        advance(2_000);
        await throttle.record('ops', addressOf(4), false);
        assert.equal(
          (await throttle.check('ops', '2001:db8:5:6::1')).refused,
          true,
          'and not after thirty days',
        );
      });

      it('refuses a /64 whose addresses have each failed once', async () => {
        const throttle = make();
        for (let n = 1; n <= 20; n += 1) {
          await throttle.record(`guess-${String(n)}`, `2001:db8:7:8::${n.toString(16)}`, false);
        }
        assert.deepEqual(await throttle.check('anything', '2001:db8:7:8:abcd::1'), {
          refused: true,
          why: 'address',
          retryAfterSeconds: 900,
        });
        assert.equal((await throttle.check('anything', '2001:db8:7:9::1')).refused, false);
      });

      it('counts an IPv4-mapped address as the IPv4 address it is', async () => {
        const throttle = make({ maxPerAddress: 3 });
        await throttle.record('guess-1', '::ffff:198.51.100.20', false);
        await throttle.record('guess-2', '198.51.100.20', false);
        await throttle.record('guess-3', '::ffff:198.51.100.20', false);
        assert.equal((await throttle.check('x', '198.51.100.20')).refused, true);
        assert.equal((await throttle.check('x', '::ffff:198.51.100.21')).refused, false);
      });

      it('records the key beside the address', async () => {
        const throttle = make();
        await throttle.record('ops', '2001:db8:5:6::1', false);
        await throttle.record('ops', '::ffff:192.0.2.1', true);
        const rows = await db.query<{ remote_address: string; address_key: string }>(
          'SELECT remote_address, address_key FROM login_attempt ORDER BY id',
        );
        assert.deepEqual(
          rows.map((row) => [row.remote_address, row.address_key]),
          [
            ['2001:db8:5:6::1', '2001:db8:5:6::/64'],
            ['::ffff:192.0.2.1', '192.0.2.1'],
          ],
        );
      });

      it('prunes a success only once it no longer makes its address known', async () => {
        const throttle = make({ windowMs: 60_000 });
        await throttle.record('ops', '203.0.113.50', true);
        await throttle.record('ops', '203.0.113.50', false);
        advance(10 * 60_000);
        assert.equal(await throttle.prune(), 1, 'the failure goes');
        advance(30 * 24 * 3_600_000);
        assert.equal(await throttle.prune(), 1, 'and the success, thirty days on');
      });
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
