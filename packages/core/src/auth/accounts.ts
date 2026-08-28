import { randomBytes } from 'node:crypto';
import { AppError, type Logger } from '@ms/shared';
import { AuthError } from './errors.js';
import type { Database, Queryable } from '../db/pool.js';
import { hashPassword, needsRehash, verifyPassword, spendVerificationTime } from './passwords.js';

/**
 * Accounts (`A-01`).
 *
 * **The role here is account-level and deliberately coarse.** Whether an account may administer
 * other accounts, or see a credential at all, is not a question about a position in the tree —
 * it is true of the account everywhere or nowhere. Rights on a *branch* are `A-03`'s problem and
 * have a different answer per object; answering them here would mean answering them once.
 */

export type AccountRole = 'admin' | 'readwrite' | 'readonly';

export interface Account {
  id: number;
  login: string;
  displayName: string;
  email: string;
  role: AccountRole;
  disabled: boolean;
  mustChangePassword: boolean;
  /** A read-only account may acknowledge alarms (`A-04`). Off by default. */
  mayAcknowledge: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreateAccountRequest {
  login: string;
  password: string;
  role: AccountRole;
  displayName?: string;
  email?: string;
  mustChangePassword?: boolean;
}

export interface UpdateAccountRequest {
  displayName?: string;
  email?: string;
  role?: AccountRole;
  disabled?: boolean;
  mayAcknowledge?: boolean;
}

export type AuthOutcome =
  | { kind: 'ok'; account: Account }
  | { kind: 'rejected'; reason: 'no-such-account' | 'wrong-password' | 'disabled' };

export interface AccountServiceOptions {
  db: Database;
  logger: Logger;
  now?: () => Date;
}

const LOGIN_PATTERN = /^[A-Za-z0-9._@-]+$/;

export class AccountService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: AccountServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'accounts' });
    this.#now = options.now ?? ((): Date => new Date());
  }

  async create(request: CreateAccountRequest): Promise<Account> {
    const login = request.login.trim();
    if (!LOGIN_PATTERN.test(login) || login.length > 64) {
      throw new AuthError(
        'ACCOUNT_LOGIN_INVALID',
        'a login may contain only letters, digits, dot, underscore, at and dash',
      );
    }
    if (request.password.length < 12) {
      throw new AuthError('ACCOUNT_PASSWORD_WEAK', 'a password must be at least 12 characters');
    }

    const hash = await hashPassword(request.password);
    try {
      const rows = await this.#db.query<AccountRow>(
        `INSERT INTO user_account (login, display_name, email, password_hash, role,
                                   must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          login,
          request.displayName ?? login,
          request.email ?? '',
          hash,
          request.role,
          request.mustChangePassword ?? false,
        ],
      );
      const row = rows[0];
      if (row === undefined)
        throw new AppError('ACCOUNT_NOT_CREATED', 'the account was not created');
      this.#logger.info({ login, role: request.role }, 'account created');
      return read(row);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AuthError('ACCOUNT_EXISTS', `an account named ${login} already exists`);
      }
      throw error;
    }
  }

  /**
   * Checks a password, and says nothing useful when it fails.
   *
   * **Every rejection costs the same time and the caller is told the same thing.** The reason is
   * returned for the *log*, never for the response: "no such account" and "wrong password" as
   * distinguishable answers is a login enumerator, and a login is half a credential.
   */
  async authenticate(login: string, password: string): Promise<AuthOutcome> {
    const rows = await this.#db.query<AccountRow & { password_hash: string }>(
      `SELECT ${COLUMNS}, password_hash FROM user_account WHERE lower(login) = lower($1)`,
      [login],
    );
    const row = rows[0];
    if (row === undefined) {
      // Spend what a real verification would have spent, so the absence is not timeable.
      await spendVerificationTime(password);
      return { kind: 'rejected', reason: 'no-such-account' };
    }

    if (!(await verifyPassword(row.password_hash, password))) {
      return { kind: 'rejected', reason: 'wrong-password' };
    }

    // **After the password, not before.** Checking `disabled` first would answer faster for a
    // disabled account than for an enabled one, which says whether the login exists.
    if (row.disabled) return { kind: 'rejected', reason: 'disabled' };

    // A correct password at outdated parameters is upgraded in place — the one moment the
    // plaintext is available to do it with.
    if (needsRehash(row.password_hash)) {
      const rehashed = await hashPassword(password);
      await this.#db.query(`UPDATE user_account SET password_hash = $2 WHERE id = $1`, [
        row.id,
        rehashed,
      ]);
      this.#logger.info({ login: row.login }, 'password re-hashed at current parameters');
    }

    await this.#db.query(`UPDATE user_account SET last_login_at = $2 WHERE id = $1`, [
      row.id,
      this.#now(),
    ]);

    return { kind: 'ok', account: read(row) };
  }

  async get(id: number): Promise<Account | null> {
    const rows = await this.#db.query<AccountRow>(
      `SELECT ${COLUMNS} FROM user_account WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  async byLogin(login: string): Promise<Account | null> {
    const rows = await this.#db.query<AccountRow>(
      `SELECT ${COLUMNS} FROM user_account WHERE lower(login) = lower($1)`,
      [login],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  async list(): Promise<Account[]> {
    const rows = await this.#db.query<AccountRow>(
      `SELECT ${COLUMNS} FROM user_account ORDER BY lower(login)`,
    );
    return rows.map(read);
  }

  /**
   * Changes an account.
   *
   * **Making an account read-only while it administers something is refused, not silently
   * resolved.** The two ways to fix it — drop the role change, or take the account out of the
   * admin group — mean completely different things, and picking one for the administrator would
   * be guessing at intent in the one place where guessing is worst. The database refuses it too
   * (`A-04`'s trigger); this is what turns that into a sentence.
   */
  async update(id: number, request: UpdateAccountRequest): Promise<Account> {
    try {
      return await this.#update(id, request);
    } catch (error: unknown) {
      if (isReadonlyAdminViolation(error)) {
        throw new AuthError(
          'ACCOUNT_READONLY_ADMIN',
          'this account is in a group that administers the installation; remove it from that ' +
            'group before making it read-only',
          { accountId: id },
        );
      }
      throw error;
    }
  }

  async #update(id: number, request: UpdateAccountRequest): Promise<Account> {
    const rows = await this.#db.query<AccountRow>(
      `UPDATE user_account
       SET display_name    = COALESCE($2, display_name),
           email           = COALESCE($3, email),
           role            = COALESCE($4, role),
           disabled        = COALESCE($5, disabled),
           may_acknowledge = COALESCE($6, may_acknowledge),
           updated_at      = now()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [
        id,
        request.displayName ?? null,
        request.email ?? null,
        request.role ?? null,
        request.disabled ?? null,
        request.mayAcknowledge ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
    }
    return read(row);
  }

  /**
   * Replaces a password.
   *
   * `current` is required unless an administrator is doing it, which is the difference between
   * changing your own password and resetting somebody else's. A reset always sets
   * `must_change_password`, so the password an administrator chose does not outlive the
   * conversation in which they communicated it.
   */
  async changePassword(
    id: number,
    next: string,
    options: { current?: string; byAdministrator?: boolean } = {},
  ): Promise<void> {
    if (next.length < 12) {
      throw new AuthError('ACCOUNT_PASSWORD_WEAK', 'a password must be at least 12 characters');
    }

    const rows = await this.#db.query<{ password_hash: string }>(
      `SELECT password_hash FROM user_account WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
    }

    if (options.byAdministrator !== true) {
      if (
        options.current === undefined ||
        !(await verifyPassword(row.password_hash, options.current))
      ) {
        throw new AuthError('ACCOUNT_PASSWORD_WRONG', 'the current password was not accepted');
      }
    }

    await this.#db.query(
      `UPDATE user_account
       SET password_hash = $2, must_change_password = $3, failed_attempts = 0,
           locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [id, await hashPassword(next), options.byAdministrator === true],
    );
    this.#logger.info(
      { accountId: id, byAdministrator: options.byAdministrator === true },
      'password changed',
    );
  }

  async delete(id: number): Promise<void> {
    // Disabling is what the UI offers; this exists for an account created by mistake, before it
    // has done anything. The audit log holds the actor's login as text, so removing the row does
    // not erase who did what.
    const rows = await this.#db.query<{ id: string }>(
      `DELETE FROM user_account WHERE id = $1 RETURNING id::text AS id`,
      [id],
    );
    if (rows[0] === undefined) {
      throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
    }
  }

  async count(q: Queryable = this.#db): Promise<number> {
    const rows = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM user_account`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Creates the first administrator if there are none, and reports the password it generated.
   *
   * **An installation with no accounts cannot be administered, and one with a known default
   * password is worse than one with none.** So the password is generated, printed once to the
   * service log where the operator installing it can see it, never stored in plaintext, and
   * flagged `must_change_password` so it does not survive the first login. Returning null means
   * accounts already exist and nothing was touched — this runs at every start-up.
   */
  async ensureFirstAdministrator(
    login = 'admin',
  ): Promise<{ login: string; password: string } | null> {
    if ((await this.count()) > 0) return null;
    const password = randomBytes(18).toString('base64url');
    await this.create({
      login,
      password,
      role: 'admin',
      displayName: 'Administrator',
      mustChangePassword: true,
    });
    return { login, password };
  }
}

const COLUMNS = `id, login, display_name, email, role, disabled, must_change_password,
                 may_acknowledge, locked_until, last_login_at, created_at`;

interface AccountRow {
  id: string | number;
  login: string;
  display_name: string;
  email: string;
  role: string;
  disabled: boolean;
  must_change_password: boolean;
  may_acknowledge: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

function read(row: AccountRow): Account {
  return {
    id: Number(row.id),
    login: row.login,
    displayName: row.display_name,
    email: row.email,
    role: row.role as AccountRole,
    disabled: row.disabled,
    mustChangePassword: row.must_change_password,
    mayAcknowledge: row.may_acknowledge,
    lockedUntil: row.locked_until === null ? null : row.locked_until.toISOString(),
    lastLoginAt: row.last_login_at === null ? null : row.last_login_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Whether this is PostgreSQL's unique-violation, through the wrapper the pool puts around it.
 *
 * **The pool wraps every driver error in an `AppError`**, carrying the SQLSTATE in `context`
 * rather than on the error itself — so the obvious `error.code === '23505'` matches nothing and
 * a duplicate login surfaces as a 500 instead of "that name is taken". The raw shape is still
 * accepted, for a query that has not been through the pool.
 */
/**
 * The trigger `A-04` installs, seen through the pool's wrapper.
 *
 * Matched on SQLSTATE plus the sentence the trigger raises: `check_violation` alone covers every
 * CHECK constraint on the table, and reporting an unrelated one as "this account administers
 * something" would send an administrator looking in the wrong place entirely.
 */
function isReadonlyAdminViolation(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.context['sqlstate'] !== '23514') return false;
  return error.message.includes('cannot be in a group that administers');
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (error instanceof AppError && error.context['sqlstate'] === '23505') return true;
  return 'code' in error && error.code === '23505';
}
