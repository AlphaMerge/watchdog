import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { newSessionToken, sessionIdFor } from './passwords.js';
import type { Account, AccountRole } from './accounts.js';

/**
 * Server-side sessions (`A-01`, `ADR-001`).
 *
 * **Server-side rather than a signed token, and that is a decision worth stating.** A JWT would
 * save this table and cost the one thing an operator actually needs: the ability to end a
 * session. Revoking a stateless token means either a deny-list — a table, so nothing was saved —
 * or waiting for it to expire, which is not revocation. An operator who has just discovered a
 * laptop was stolen is not going to wait fifteen minutes.
 *
 * **The row holds a hash of the cookie, never the cookie.** Same rule as the probe access key
 * (`R-01`): a database dump, a backup, or a `SELECT` in a bug report must not yield a working
 * login.
 *
 * **Expiry is rolling.** Touched as the session is used, so an operator working a long incident
 * is not logged out mid-shift, while a tab abandoned on Friday is dead by Monday.
 */

export interface Session {
  id: string;
  userId: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  remoteAddress: string;
  userAgent: string;
}

/** What a resolved session yields: enough to authorise without a second query per request. */
export interface Principal {
  userId: number;
  login: string;
  role: AccountRole;
  mustChangePassword: boolean;
  sessionId: string;
}

export interface SessionServiceOptions {
  db: Database;
  logger: Logger;
  /** How long a session lives without being used. */
  idleTimeoutMs?: number;
  /** How long it may live at all, however active. */
  absoluteTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_IDLE_MS = 12 * 60 * 60_000;
const DEFAULT_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;

export class SessionService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #idleMs: number;
  readonly #absoluteMs: number;
  readonly #now: () => Date;

  constructor(options: SessionServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'sessions' });
    this.#idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.#absoluteMs = options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_MS;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Starts a session and returns the token for the cookie. The token is never stored. */
  async start(
    account: Account,
    context: { remoteAddress: string; userAgent: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, id } = newSessionToken();
    const expiresAt = new Date(this.#now().getTime() + this.#idleMs);
    await this.#db.query(
      `INSERT INTO user_session (id, user_id, remote_address, user_agent, created_at,
                                 last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [
        id,
        account.id,
        context.remoteAddress.slice(0, 64),
        context.userAgent.slice(0, 400),
        this.#now(),
        expiresAt,
      ],
    );
    this.#logger.info(
      { login: account.login, remoteAddress: context.remoteAddress },
      'session started',
    );
    return { token, expiresAt };
  }

  /**
   * Resolves a cookie to a principal, and extends the session in the same statement.
   *
   * **One statement, because this runs on every request.** Reading the session and then touching
   * it would double the cost of authentication and leave a window in which a just-expired session
   * is used. The `WHERE` does the expiry check, so an expired row simply matches nothing.
   */
  async resolve(token: string): Promise<Principal | null> {
    const now = this.#now();
    const rows = await this.#db.query<{
      id: string;
      user_id: string;
      login: string;
      role: string;
      must_change_password: boolean;
      disabled: boolean;
    }>(
      `UPDATE user_session s
       SET last_seen_at = $2,
           -- Rolling, but never past the absolute ceiling measured from when it was created.
           expires_at = LEAST($2::timestamptz + $3::interval, s.created_at + $4::interval)
       FROM user_account a
       WHERE s.id = $1
         AND a.id = s.user_id
         AND s.expires_at > $2
         AND s.created_at + $4::interval > $2
         AND a.disabled = false
       RETURNING s.id, s.user_id::text AS user_id, a.login, a.role, a.must_change_password,
                 a.disabled`,
      [
        sessionIdFor(token),
        now,
        `${String(Math.round(this.#idleMs / 1000))} seconds`,
        `${String(Math.round(this.#absoluteMs / 1000))} seconds`,
      ],
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: Number(row.user_id),
      login: row.login,
      role: row.role as AccountRole,
      mustChangePassword: row.must_change_password,
      sessionId: row.id,
    };
  }

  /** Ends one session — a logout. Idempotent: logging out twice is not an error. */
  async end(token: string): Promise<void> {
    await this.#db.query(`DELETE FROM user_session WHERE id = $1`, [sessionIdFor(token)]);
  }

  /**
   * Ends every session an account holds.
   *
   * **A password change calls this**, and that is the point of it: the reason somebody changes a
   * password is usually that they think somebody else knows it, and leaving the sessions that
   * password opened is leaving the door they were worried about.
   */
  async endAllFor(userId: number, except?: string): Promise<number> {
    const rows = await this.#db.query<{ id: string }>(
      `DELETE FROM user_session WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)
       RETURNING id`,
      [userId, except ?? null],
    );
    if (rows.length > 0) this.#logger.info({ userId, ended: rows.length }, 'sessions ended');
    return rows.length;
  }

  async listFor(userId: number): Promise<Session[]> {
    const rows = await this.#db.query<{
      id: string;
      user_id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      remote_address: string;
      user_agent: string;
    }>(
      `SELECT id, user_id::text AS user_id, created_at, last_seen_at, expires_at,
              remote_address, user_agent
       FROM user_session WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: Number(row.user_id),
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      remoteAddress: row.remote_address,
      userAgent: row.user_agent,
    }));
  }

  /** Drops expired sessions. Called from housekeeping. */
  async prune(): Promise<number> {
    const rows = await this.#db.query<{ id: string }>(
      `DELETE FROM user_session WHERE expires_at <= $1 RETURNING id`,
      [this.#now()],
    );
    return rows.length;
  }
}
