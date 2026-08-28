import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as OTPAuth from 'otpauth';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { TotpService } from '../src/auth/totp.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

/**
 * TOTP multi-factor authentication (`A-07`).
 *
 * **The two claims worth the most here are both about *not* accepting something.** That an
 * unconfirmed enrolment does nothing at all — so a mistyped setup cannot lock somebody out of
 * their own monitoring system — and that a code cannot be used twice inside the thirty seconds
 * it is displayed, which is the whole attack against a code read over a shoulder.
 */

const available = await databaseAvailable();

describe('totp', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let accounts: AccountService;
  let groups: GroupService;
  let userId = 0;

  /** Drives the service's clock, so a window can be stepped without waiting thirty seconds. */
  let clock = new Date('2026-08-28T09:00:00.000Z');
  let totp: TotpService;

  before(async () => {
    scratch = await createScratchDatabase('totp');
    db = scratch.db;
    await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_recovery_code');
    await db.query('DELETE FROM user_totp');
    await db.query('DELETE FROM user_group_member');
    await db.query('DELETE FROM user_group WHERE NOT is_builtin');
    await db.query('UPDATE user_group SET requires_mfa = false');
    await db.query('DELETE FROM user_account');

    clock = new Date('2026-08-28T09:00:00.000Z');
    totp = new TotpService({ db, logger: silentLogger, now: () => clock });
    accounts = new AccountService({ db, logger: silentLogger });
    groups = new GroupService({ db, logger: silentLogger });

    const account = await accounts.create({
      login: 'ops',
      password: 'correct-horse-battery',
      role: 'readwrite',
    });
    userId = account.id;
  });

  /** The code an authenticator app would be showing, for the service's current clock. */
  const codeFor = (secret: string, at: Date = clock): string =>
    new OTPAuth.TOTP({
      issuer: 'MonitoringSystem',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate({ timestamp: at.getTime() });

  const enrol = async () => {
    const { secret } = await totp.beginEnrolment(userId, 'ops');
    const { recoveryCodes } = await totp.confirmEnrolment(userId, codeFor(secret));
    return { secret, recoveryCodes };
  };

  describe('enrolment', () => {
    it('produces a secret and a URI an authenticator can read', async () => {
      const { secret, uri } = await totp.beginEnrolment(userId, 'ops');
      assert.match(secret, /^[A-Z2-7]{32}$/, 'base32');
      assert.match(uri, /^otpauth:\/\/totp\//);
      assert.match(uri, /issuer=MonitoringSystem/);
      assert.match(uri, /ops/, 'labelled, so an app with six accounts shows which is which');
    });

    it('does nothing at all until it is confirmed', async () => {
      // The failure this prevents: a mistyped setup that the authenticator never received, on an
      // account that now demands codes from it.
      const { secret } = await totp.beginEnrolment(userId, 'ops');
      assert.equal(await totp.isEnrolled(userId), false);
      assert.equal(await totp.verify(userId, codeFor(secret)), false, 'not usable yet either');

      const status = await totp.status(userId);
      assert.equal(status.confirmed, false);
    });

    it('refuses to confirm with a wrong code', async () => {
      await totp.beginEnrolment(userId, 'ops');
      await assert.rejects(() => totp.confirmEnrolment(userId, '000000'), /not accepted/);
      assert.equal(await totp.isEnrolled(userId), false);
    });

    it('confirms with a real code and hands back recovery codes', async () => {
      const { recoveryCodes } = await enrol();
      assert.equal(recoveryCodes.length, 10);
      assert.equal(await totp.isEnrolled(userId), true);
      for (const code of recoveryCodes) {
        assert.match(
          code,
          /^[a-z2-9]{5}-[a-z2-9]{5}$/,
          'transcribable by somebody without a phone',
        );
      }
    });

    it('uses an alphabet somebody can read off a screen', async () => {
      // These are typed by a person who has just lost their phone. A code they cannot
      // transcribe is not a recovery code.
      const { recoveryCodes } = await enrol();
      const all = recoveryCodes.join('');
      for (const confusing of ['0', '1', 'l', 'o']) {
        assert.equal(all.includes(confusing), false, `${confusing} is too easily misread`);
      }
    });

    it('lets an abandoned enrolment be restarted with a fresh secret', async () => {
      const first = await totp.beginEnrolment(userId, 'ops');
      const second = await totp.beginEnrolment(userId, 'ops');
      assert.notEqual(first.secret, second.secret);
      // And the abandoned one is dead. Awaited — an unawaited `assert.rejects` is an assertion
      // that never runs, which is worse than not writing it.
      await assert.rejects(
        () => totp.confirmEnrolment(userId, codeFor(first.secret)),
        /not accepted/,
      );
    });

    it('refuses to re-enrol an account that already has it working', async () => {
      // Otherwise a stolen session could silently move the account onto an attacker's
      // authenticator, and the owner would only find out at their next login.
      await enrol();
      await assert.rejects(() => totp.beginEnrolment(userId, 'ops'), /already has/);
    });

    it('stores no recovery code in the clear', async () => {
      const { recoveryCodes } = await enrol();
      const rows = await db.query<{ code_hash: string }>(
        'SELECT code_hash FROM user_recovery_code',
      );
      const stored = rows.map((r) => r.code_hash).join('|');
      for (const code of recoveryCodes) {
        assert.equal(stored.includes(code), false);
      }
      assert.ok(rows[0]?.code_hash.startsWith('$argon2id$'));
    });
  });

  describe('verifying', () => {
    it('accepts the code the app is showing', async () => {
      const { secret } = await enrol();
      clock = new Date(clock.getTime() + 60_000);
      assert.equal(await totp.verify(userId, codeFor(secret)), true);
    });

    it('refuses the same code twice, inside its own window', async () => {
      // **The claim this test exists for.** Without it, a code observed over a shoulder — or
      // pasted into the wrong window — works for the whole thirty seconds it is displayed.
      const { secret } = await enrol();
      clock = new Date(clock.getTime() + 60_000);
      const code = codeFor(secret);
      assert.equal(await totp.verify(userId, code), true);
      assert.equal(await totp.verify(userId, code), false, 'a code is single-use');
    });

    it('accepts the next window’s code straight after', async () => {
      const { secret } = await enrol();
      clock = new Date(clock.getTime() + 60_000);
      assert.equal(await totp.verify(userId, codeFor(secret)), true);
      clock = new Date(clock.getTime() + 30_000);
      assert.equal(await totp.verify(userId, codeFor(secret)), true);
    });

    it('tolerates a phone clock one step out, in both directions', async () => {
      // Zero tolerance refuses most phones. Three steps accepts a code for ninety seconds either
      // way, which gives away most of the point of rotating it.
      const { secret } = await enrol();
      clock = new Date(clock.getTime() + 300_000);
      const early = codeFor(secret, new Date(clock.getTime() - 30_000));
      assert.equal(await totp.verify(userId, early), true);

      clock = new Date(clock.getTime() + 300_000);
      const late = codeFor(secret, new Date(clock.getTime() + 30_000));
      assert.equal(await totp.verify(userId, late), true);
    });

    it('refuses a code two steps out', async () => {
      const { secret } = await enrol();
      clock = new Date(clock.getTime() + 300_000);
      const wayOff = codeFor(secret, new Date(clock.getTime() - 90_000));
      assert.equal(await totp.verify(userId, wayOff), false);
    });

    it('refuses anything that is not six digits, without touching the secret', async () => {
      await enrol();
      for (const rubbish of ['', 'abcdef', '12345', '1234567', 'not a code']) {
        assert.equal(await totp.verify(userId, rubbish), false);
      }
    });

    it('refuses everything for an account that never enrolled', async () => {
      assert.equal(await totp.verify(userId, '123456'), false);
    });
  });

  describe('recovery codes', () => {
    it('sign in when the phone is gone', async () => {
      const { recoveryCodes } = await enrol();
      const code = recoveryCodes[0] ?? '';
      assert.equal(await totp.verify(userId, code), true);
    });

    it('are single-use', async () => {
      const { recoveryCodes } = await enrol();
      const code = recoveryCodes[0] ?? '';
      assert.equal(await totp.verify(userId, code), true);
      assert.equal(await totp.verify(userId, code), false, 'spent');
    });

    it('are accepted however they were transcribed', async () => {
      // Somebody typing this has just lost their phone. Insisting on the exact casing and
      // hyphenation would be a needless second failure.
      const { recoveryCodes } = await enrol();
      const code = (recoveryCodes[0] ?? '').toUpperCase().replace('-', ' ');
      assert.equal(await totp.verify(userId, code), true);
    });

    it('leave the others usable', async () => {
      const { recoveryCodes } = await enrol();
      await totp.verify(userId, recoveryCodes[0] ?? '');
      assert.equal(await totp.verify(userId, recoveryCodes[1] ?? ''), true);
      assert.equal((await totp.status(userId)).recoveryCodesLeft, 8);
    });

    it('can be reissued, and the old ones stop working', async () => {
      const { recoveryCodes } = await enrol();
      const fresh = await totp.regenerateRecoveryCodes(userId);
      assert.equal(fresh.length, 10);
      assert.equal(await totp.verify(userId, recoveryCodes[0] ?? ''), false, 'the old set is dead');
      assert.equal(await totp.verify(userId, fresh[0] ?? ''), true);
    });

    it('cannot be reissued for an account without MFA', async () => {
      await assert.rejects(() => totp.regenerateRecoveryCodes(userId), /does not have/);
    });

    it('are counted, because zero left is a lockout waiting to happen', async () => {
      const { recoveryCodes } = await enrol();
      assert.equal((await totp.status(userId)).recoveryCodesLeft, 10);
      for (const code of recoveryCodes) await totp.verify(userId, code);
      assert.equal((await totp.status(userId)).recoveryCodesLeft, 0);
    });
  });

  describe('disabling', () => {
    it('takes the recovery codes with it', async () => {
      const { secret, recoveryCodes } = await enrol();
      await totp.disable(userId);
      assert.equal(await totp.isEnrolled(userId), false);
      assert.equal(await totp.verify(userId, codeFor(secret)), false);
      assert.equal(await totp.verify(userId, recoveryCodes[0] ?? ''), false);
      assert.equal((await totp.status(userId)).recoveryCodesLeft, 0);
    });

    it('lets the account enrol again afterwards', async () => {
      await enrol();
      await totp.disable(userId);
      const again = await totp.beginEnrolment(userId, 'ops');
      assert.ok(again.secret);
    });
  });

  describe('enforcement per group', () => {
    it('is off unless a group asks for it', async () => {
      assert.equal(await totp.isRequired(userId), false);
    });

    it('is on for a member of a group that requires it', async () => {
      const secure = await groups.create({ name: 'Change managers' });
      await db.query(`UPDATE user_group SET requires_mfa = true WHERE id = $1`, [secure.id]);
      await groups.addMember(secure.id, userId);
      assert.equal(await totp.isRequired(userId), true);
    });

    it('is on if *any* group requires it, so joining never relaxes it', async () => {
      // The same "highest wins" shape A-03 gives to rights, and for the same reason: being added
      // to a group must not quietly drop a requirement.
      const relaxed = await groups.create({ name: 'Everyone' });
      const secure = await groups.create({ name: 'Change managers' });
      await db.query(`UPDATE user_group SET requires_mfa = true WHERE id = $1`, [secure.id]);
      await groups.addMember(secure.id, userId);
      await groups.addMember(relaxed.id, userId);
      assert.equal(await totp.isRequired(userId), true);
    });

    it('stops being required once the account leaves that group', async () => {
      const secure = await groups.create({ name: 'Change managers' });
      await db.query(`UPDATE user_group SET requires_mfa = true WHERE id = $1`, [secure.id]);
      await groups.addMember(secure.id, userId);
      await groups.removeMember(secure.id, userId);
      assert.equal(await totp.isRequired(userId), false);
    });

    it('reports required and enrolled separately, because the gap is the interesting state', async () => {
      // Required but not enrolled is the account that has to be walked through setup before it
      // can do anything — a client cannot tell that from one boolean.
      const secure = await groups.create({ name: 'Change managers' });
      await db.query(`UPDATE user_group SET requires_mfa = true WHERE id = $1`, [secure.id]);
      await groups.addMember(secure.id, userId);

      const status = await totp.status(userId);
      assert.equal(status.required, true);
      assert.equal(status.confirmed, false);
    });
  });
});
