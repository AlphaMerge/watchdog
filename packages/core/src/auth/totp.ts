import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { AuthError } from './errors.js';
import { hashPassword, verifyPassword } from './passwords.js';

/**
 * TOTP multi-factor authentication (`A-07`).
 *
 * **Enrolment is two steps, and the second one is what makes it safe.** A secret is generated
 * and stored *unconfirmed*, doing nothing at all, until the person proves they can read a code
 * from it. Confirming immediately is how somebody locks themselves out of their own monitoring
 * system with a mistyped setup — their authenticator never received the secret, and the account
 * now demands codes from it.
 *
 * **A used code cannot be used again inside its own window.** Without that, an observed code
 * works for the whole thirty seconds it is on screen, which is the entire attack against
 * somebody reading over a shoulder or a code pasted into the wrong chat window.
 */

const ISSUER = 'MonitoringSystem';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One step either side of now.
 *
 * **A window of one, not zero and not three.** Zero refuses anybody whose phone clock is a
 * second out, which is most phones; three accepts a code for a minute and a half either way,
 * which is most of the value of a rotating code given away. One is ±30 s, which absorbs ordinary
 * drift and the time it takes to type six digits.
 */
const WINDOW = 1;

const RECOVERY_CODE_COUNT = 10;

export interface TotpStatus {
  enrolled: boolean;
  confirmed: boolean;
  /** Unused recovery codes remaining. Zero with MFA on is a lockout waiting to happen. */
  recoveryCodesLeft: number;
  /** True when any group this account belongs to requires MFA. */
  required: boolean;
}

export interface TotpServiceOptions {
  db: Database;
  logger: Logger;
  now?: () => Date;
}

export class TotpService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: TotpServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'totp' });
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * Starts enrolment, replacing any unconfirmed attempt.
   *
   * **Replaces an unconfirmed secret, refuses to replace a confirmed one.** Somebody who
   * abandoned a setup and started again should get a fresh secret; somebody with MFA already
   * working has to disable it first, or a stolen session could silently re-enrol the account
   * onto an attacker's authenticator.
   */
  async beginEnrolment(userId: number, login: string): Promise<{ secret: string; uri: string }> {
    const existing = await this.#row(userId);
    if (existing?.confirmed_at != null) {
      throw new AuthError(
        'MFA_ALREADY_ENROLLED',
        'this account already has multi-factor authentication; disable it before enrolling again',
      );
    }

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: login,
      algorithm: 'SHA1',
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret,
    });

    await this.#db.query(
      `INSERT INTO user_totp (user_id, secret, confirmed_at, last_step, created_at)
       VALUES ($1, $2, NULL, NULL, $3)
       ON CONFLICT (user_id)
       DO UPDATE SET secret = EXCLUDED.secret, confirmed_at = NULL, last_step = NULL,
                     created_at = EXCLUDED.created_at`,
      [userId, secret.base32, this.#now()],
    );

    this.#logger.info({ userId }, 'totp enrolment started');
    // SHA1 is what every authenticator app implements. It is not a hash of anything secret here
    // — it is an HMAC key schedule — and choosing SHA256 would produce a QR code that a good
    // proportion of apps silently fail to read.
    return { secret: secret.base32, uri: totp.toString() };
  }

  /**
   * Confirms enrolment with a code, and issues recovery codes.
   *
   * The recovery codes are returned once and never again, for the same reason an API token is.
   */
  async confirmEnrolment(userId: number, code: string): Promise<{ recoveryCodes: string[] }> {
    const row = await this.#row(userId);
    if (row === null)
      throw new AuthError('MFA_NOT_ENROLLED', 'this account has not started enrolment');
    if (row.confirmed_at != null) {
      throw new AuthError('MFA_ALREADY_ENROLLED', 'this account is already enrolled');
    }

    const step = this.#verifyCode(row.secret, code, null);
    if (step === null) {
      throw new AuthError(
        'MFA_CODE_INVALID',
        'that code was not accepted; check your device clock',
      );
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    await this.#db.tx(async (q) => {
      await q.query(`UPDATE user_totp SET confirmed_at = $2, last_step = $3 WHERE user_id = $1`, [
        userId,
        this.#now(),
        String(step),
      ]);
      await q.query(`DELETE FROM user_recovery_code WHERE user_id = $1`, [userId]);
      for (const code of codes) {
        await q.query(`INSERT INTO user_recovery_code (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          await hashPassword(normaliseRecoveryCode(code)),
        ]);
      }
    });

    this.#logger.info({ userId }, 'totp enrolment confirmed');
    return { recoveryCodes: codes };
  }

  /**
   * Verifies a code at login. Accepts a TOTP code or an unused recovery code.
   *
   * **The step is recorded, so a code cannot be replayed inside its own window.** An observed
   * code would otherwise work for the whole thirty seconds it is displayed.
   */
  async verify(userId: number, code: string): Promise<boolean> {
    const row = await this.#row(userId);
    if (row === null || row.confirmed_at == null) return false;

    const step = this.#verifyCode(row.secret, code, row.last_step);
    if (step !== null) {
      await this.#db.query(`UPDATE user_totp SET last_step = $2 WHERE user_id = $1`, [
        userId,
        String(step),
      ]);
      return true;
    }

    return this.#consumeRecoveryCode(userId, code);
  }

  /**
   * Spends a recovery code, once.
   *
   * Every unused code is checked, because they are hashed and there is nothing to look up by.
   * Ten argon2 verifications is slow on purpose: this is the path somebody guesses at.
   */
  async #consumeRecoveryCode(userId: number, code: string): Promise<boolean> {
    const normalised = normaliseRecoveryCode(code);
    const rows = await this.#db.query<{ id: string; code_hash: string }>(
      `SELECT id::text AS id, code_hash FROM user_recovery_code
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );

    for (const row of rows) {
      if (!(await verifyPassword(row.code_hash, normalised))) continue;
      const spent = await this.#db.query<{ id: string }>(
        // The `used_at IS NULL` in the UPDATE is what makes it single-use under concurrency:
        // two requests racing with the same code, and only one row changes.
        `UPDATE user_recovery_code SET used_at = $2 WHERE id = $1 AND used_at IS NULL
         RETURNING id::text AS id`,
        [row.id, this.#now()],
      );
      if (spent.length === 0) return false;
      this.#logger.warn({ userId }, 'a recovery code was used to sign in');
      return true;
    }
    return false;
  }

  /** Turns MFA off, and takes the recovery codes with it. */
  async disable(userId: number): Promise<void> {
    await this.#db.tx(async (q) => {
      await q.query(`DELETE FROM user_recovery_code WHERE user_id = $1`, [userId]);
      await q.query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
    });
    this.#logger.warn({ userId }, 'totp disabled');
  }

  /** Issues a fresh set of recovery codes, invalidating the old ones. */
  async regenerateRecoveryCodes(userId: number): Promise<string[]> {
    const row = await this.#row(userId);
    if (row === null || row.confirmed_at == null) {
      throw new AuthError(
        'MFA_NOT_ENROLLED',
        'this account does not have multi-factor authentication',
      );
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    await this.#db.tx(async (q) => {
      await q.query(`DELETE FROM user_recovery_code WHERE user_id = $1`, [userId]);
      for (const code of codes) {
        await q.query(`INSERT INTO user_recovery_code (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          await hashPassword(normaliseRecoveryCode(code)),
        ]);
      }
    });
    return codes;
  }

  async status(userId: number): Promise<TotpStatus> {
    const rows = await this.#db.query<{
      confirmed_at: Date | null;
      codes_left: string;
      required: boolean;
    }>(
      `SELECT t.confirmed_at,
              (SELECT count(*) FROM user_recovery_code r
                WHERE r.user_id = $1 AND r.used_at IS NULL)::text AS codes_left,
              -- Required if *any* group demands it: joining a group must never quietly relax a
              -- requirement, the same shape A-03 gives to rights.
              EXISTS (SELECT 1 FROM user_group_member m JOIN user_group g ON g.id = m.group_id
                       WHERE m.user_id = $1 AND g.requires_mfa) AS required
       FROM (SELECT 1) AS one
       LEFT JOIN user_totp t ON t.user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return {
      enrolled: row?.confirmed_at !== undefined && row.confirmed_at !== null,
      confirmed: row?.confirmed_at != null,
      recoveryCodesLeft: Number(row?.codes_left ?? 0),
      required: row?.required ?? false,
    };
  }

  /** Whether this account must present a second factor to sign in. */
  async isRequired(userId: number): Promise<boolean> {
    const rows = await this.#db.query<{ required: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_group_member m JOIN user_group g ON g.id = m.group_id
         WHERE m.user_id = $1 AND g.requires_mfa
       ) AS required`,
      [userId],
    );
    return rows[0]?.required ?? false;
  }

  /** Whether this account *has* a working second factor. */
  async isEnrolled(userId: number): Promise<boolean> {
    const row = await this.#row(userId);
    return row?.confirmed_at != null;
  }

  async #row(
    userId: number,
  ): Promise<{ secret: string; confirmed_at: Date | null; last_step: string | null } | null> {
    const rows = await this.#db.query<{
      secret: string;
      confirmed_at: Date | null;
      last_step: string | null;
    }>(`SELECT secret, confirmed_at, last_step FROM user_totp WHERE user_id = $1`, [userId]);
    return rows[0] ?? null;
  }

  /**
   * Validates a code and returns the step it belongs to, or null.
   *
   * `lastStep` refuses anything at or before the step already spent, which is what makes a code
   * single-use within its own window.
   */
  #verifyCode(secret: string, code: string, lastStep: string | null): number | null {
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) return null;

    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      algorithm: 'SHA1',
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    const timestamp = this.#now().getTime();
    const delta = totp.validate({ token: digits, window: WINDOW, timestamp });
    if (delta === null) return null;

    const step = Math.floor(timestamp / 1000 / PERIOD_SECONDS) + delta;
    if (lastStep !== null && step <= Number(lastStep)) return null;
    return step;
  }
}

/**
 * A recovery code: ten characters from an unambiguous alphabet, shown in two groups of five.
 *
 * No `0`, `1`, `l`, `o` — these are read off a screen and typed by somebody who has just lost
 * their phone, and a code that cannot be transcribed is not a recovery code.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * The canonical form of a recovery code: no hyphen, no spaces, lower case.
 *
 * **Hashed in this form and compared in this form**, which is the bug this function exists to
 * have fixed once: hashing the displayed `abcde-fghij` and comparing the typed `abcdefghij`
 * fails every time, and looks exactly like a wrong code. Somebody typing one of these has just
 * lost their phone; insisting on the exact hyphenation would be a needless second failure.
 */
function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  // `?? ''` is unreachable — the modulo bounds the index — but `noUncheckedIndexedAccess` is
  // right to insist, and a silent `undefined` here would produce the string "undefined" inside a
  // recovery code rather than a type error.
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length] ?? '';
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
