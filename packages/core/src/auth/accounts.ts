import { randomBytes } from 'node:crypto';
import { AppError, type Logger } from '@ms/shared';
import { AuthError } from './errors.js';
import type { Database, Queryable } from '../db/pool.js';
import type { AccountAudit, Actor, AuditSink } from '../objects/audit.js';
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
  /**
   * Where every change to an account is recorded, inside the change's own transaction (`A-18`).
   *
   * Required, as `AccessService`'s is: a role change is an escalation, and a sink that could be
   * left out is how accounts went unaudited from `A-01` until `A-18`.
   */
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

/** Who made the first administrator: nobody, at start-up. */
const FIRST_ADMINISTRATOR: Actor = { kind: 'system', component: 'first-administrator' };

const LOGIN_PATTERN = /^[A-Za-z0-9._@-]+$/;

export class AccountService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: AccountServiceOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'accounts' });
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Creates an account, audited in the same transaction (`A-18`). */
  async create(request: CreateAccountRequest, actor: Actor): Promise<Account> {
    const login = checked(request);
    // Hashed before the transaction opens: argon2 is slow on purpose, and a transaction held open
    // for it is a connection held for nothing.
    const hash = await hashPassword(request.password);
    try {
      const account = await this.#db.tx(async (q) => this.#insert(q, login, request, hash, actor));
      this.#logger.info({ login, role: request.role }, 'account created');
      return account;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AuthError('ACCOUNT_EXISTS', `an account named ${login} already exists`);
      }
      throw error;
    }
  }

  async #insert(
    q: Queryable,
    login: string,
    request: CreateAccountRequest,
    hash: string,
    actor: Actor,
  ): Promise<Account> {
    const rows = await q.query<AccountRow>(
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
    if (row === undefined) throw new AppError('ACCOUNT_NOT_CREATED', 'the account was not created');
    const account = read(row);
    await this.#audit.record(
      q,
      actor,
      [
        {
          action: 'account.created',
          objectId: null,
          accountId: account.id,
          after: auditOf(account),
        },
      ],
      this.#now(),
    );
    return account;
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
  async update(id: number, request: UpdateAccountRequest, actor: Actor): Promise<Account> {
    try {
      return await this.#db.tx(async (q) => this.#update(q, id, request, actor));
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

  /**
   * The change and its entry, in one transaction (`A-18`).
   *
   * **The role is the field this is for**, and the entry carries it before and after beside
   * everything else an administrator can set. The row is locked before it is read, so the `before`
   * is the one this change replaced rather than one a concurrent change already had. An update that
   * changed nothing writes nothing, as a revoke that found nothing does.
   */
  async #update(
    q: Queryable,
    id: number,
    request: UpdateAccountRequest,
    actor: Actor,
  ): Promise<Account> {
    const current = await q.query<AccountRow>(
      `SELECT ${COLUMNS} FROM user_account WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const existing = current[0];
    if (existing === undefined) {
      throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
    }
    const before = auditOf(read(existing));

    const rows = await q.query<AccountRow>(
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
    const account = read(row);
    const after = auditOf(account);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await this.#audit.record(
        q,
        actor,
        [{ action: 'account.updated', objectId: null, accountId: id, before, after }],
        this.#now(),
      );
    }
    return account;
  }

  /**
   * Replaces a password.
   *
   * `current` is required unless an administrator is doing it, which is the difference between
   * changing your own password and resetting somebody else's. A reset always sets
   * `must_change_password`, so the password an administrator chose does not outlive the
   * conversation in which they communicated it.
   *
   * **Audited as having happened, and nothing more** (`A-18`): the entry names the account and
   * whether it was a reset, never the password or its hash.
   */
  async changePassword(
    id: number,
    next: string,
    actor: Actor,
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

    const hash = await hashPassword(next);
    const reset = options.byAdministrator === true;
    await this.#db.tx(async (q) => {
      const changed = await q.query<{ login: string }>(
        `UPDATE user_account
         SET password_hash = $2, must_change_password = $3, failed_attempts = 0,
             locked_until = NULL, updated_at = now()
         WHERE id = $1
         RETURNING login`,
        [id, hash, reset],
      );
      const login = changed[0]?.login;
      if (login === undefined) {
        throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
      }
      await this.#audit.record(
        q,
        actor,
        [{ action: 'account.passwordChanged', objectId: null, accountId: id, login, reset }],
        this.#now(),
      );
    });
    this.#logger.info(
      { accountId: id, byAdministrator: options.byAdministrator === true },
      'password changed',
    );
  }

  async delete(id: number, actor: Actor): Promise<void> {
    // Disabling is what the UI offers; this exists for an account created by mistake, before it
    // has done anything. The audit log holds the actor's login as text, so removing the row does
    // not erase who did what — and the entry this writes keeps what the account was (`A-18`).
    await this.#db.tx(async (q) => {
      const rows = await q.query<AccountRow>(
        `DELETE FROM user_account WHERE id = $1 RETURNING ${COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(id)}`);
      }
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'account.deleted',
            objectId: null,
            accountId: id,
            before: auditOf(read(row)),
          },
        ],
        this.#now(),
      );
    });
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
   *
   * **It joins the Administrators group, and without that a fresh installation is unusable.**
   * `role: 'admin'` is the account-level ceiling; it is not a right on any object.
   * `AccessService.resolve` grants `full` on everything only through membership of a group with
   * `is_admin`, and otherwise falls through to per-object grants — of which a brand new
   * installation has none. So the only account on the box passed every role bar and was refused
   * by all 32 object-scoped routes, which is most of the API: reading an object, the tree, a
   * sensor's state, history, triggers, credentials, discovery.
   *
   * It was invisible for as long as it existed because no environment that anybody used was
   * *fresh*. Migration `032` backfills every account that already exists into a group —
   * "Administrators by role, everybody else by default" — so every database that upgraded into
   * user groups has an administrator that works, and only a database created after `032` does
   * not. `F-08`'s install smoke test is the one thing that builds one of those, and it could not
   * see this either until `U-20` gave it a credential to be refused with.
   */
  async ensureFirstAdministrator(
    login = 'admin',
  ): Promise<{ login: string; password: string } | null> {
    if ((await this.count()) > 0) return null;
    const password = randomBytes(18).toString('base64url');
    const request: CreateAccountRequest = {
      login,
      password,
      role: 'admin',
      displayName: 'Administrator',
      mustChangePassword: true,
    };
    const checkedLogin = checked(request);
    const hash = await hashPassword(password);

    // **The account and its membership are one change, and so one transaction** (`A-18`): an
    // administrator created with no record of how it came to administer is the gap this closes.
    await this.#db.tx(async (q) => {
      const account = await this.#insert(q, checkedLogin, request, hash, FIRST_ADMINISTRATOR);

      // The builtin group, by its flags rather than by its name: a name is a label an operator may
      // change, and this has to find the group that actually confers administration.
      const joined = await q.query<{ id: string; name: string }>(
        `WITH admins AS (SELECT id, name FROM user_group WHERE is_builtin AND is_admin),
         joined AS (
           INSERT INTO user_group_member (group_id, user_id, is_primary)
           SELECT id, $1, true FROM admins
           ON CONFLICT DO NOTHING
           RETURNING group_id
         )
         SELECT admins.id::text AS id, admins.name FROM admins JOIN joined ON joined.group_id = admins.id`,
        [account.id],
      );
      await this.#audit.record(
        q,
        FIRST_ADMINISTRATOR,
        joined.map((group) => ({
          action: 'group.memberAdded' as const,
          objectId: null,
          groupId: Number(group.id),
          groupName: group.name,
          administers: true,
          accountId: account.id,
          login: account.login,
          primary: true,
        })),
        this.#now(),
      );
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

/** The login a request would create, or the refusal it gets. */
function checked(request: CreateAccountRequest): string {
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
  return login;
}

/** What the audit log keeps of an account: what an administrator sets, nothing that signs in. */
function auditOf(account: Account): AccountAudit {
  return {
    login: account.login,
    displayName: account.displayName,
    email: account.email,
    role: account.role,
    disabled: account.disabled,
    mayAcknowledge: account.mayAcknowledge,
    mustChangePassword: account.mustChangePassword,
  };
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
