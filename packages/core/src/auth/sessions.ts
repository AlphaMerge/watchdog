import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { newSessionToken, sessionIdFor } from './passwords.js';
import type { Account, AccountRole } from './accounts.js';
import type { Lapse } from './credentials.js';

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
  /**
   * Whether this account may acknowledge alarms regardless of its role (`A-04`, migration 034).
   *
   * Carried on the principal rather than fetched at the acknowledgement route, for the same
   * reason the role is: one query per request, and an authorisation check that needs a second
   * round trip is one somebody will be tempted to skip.
   */
  mayAcknowledge: boolean;
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

  /**
   * Starts a session and returns the token for the cookie. The token is never stored.
   *
   * `lastsUntil` is the latest the session can live — its absolute ceiling — and is what the
   * cookie's own expiry has to be (`A-38`). The idle expiry moves on every request, and the cookie
   * is written once, at login: a cookie that expired at the *first* idle deadline was dropped by
   * the browser twelve hours after signing in however busy the operator was, and the rolling
   * expiry in `resolve` never got to roll. The server decides when a session ends; the cookie only has to
   * outlive it.
   */
  async start(
    account: Account,
    context: { remoteAddress: string; userAgent: string },
  ): Promise<{ token: string; expiresAt: Date; lastsUntil: Date }> {
    const { token, id } = newSessionToken();
    const now = this.#now().getTime();
    const lastsUntil = new Date(now + this.#absoluteMs);
    const expiresAt = new Date(Math.min(now + this.#idleMs, lastsUntil.getTime()));
    await this.#db.query(
      `INSERT INTO user_session (id, user_id, remote_address, user_agent, created_at,
                                 last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [
        id,
        account.id,
        context.remoteAddress.slice(0, 64),
        context.userAgent.slice(0, 400),
        new Date(now),
        expiresAt,
      ],
    );
    this.#logger.info(
      { login: account.login, remoteAddress: context.remoteAddress },
      'session started',
    );
    return { token, expiresAt, lastsUntil };
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
      may_acknowledge: boolean;
      disabled: boolean;
    }>(
      `UPDATE user_session s
       SET last_seen_at = $2,
           -- Rolling, but never past the absolute ceiling measured from when it was created.
           expires_at = LEAST($2::timestamptz + $3::interval, s.created_at + $4::interval)
       FROM user_account a
       WHERE s.id = $1
         AND a.id = s.user_id
         AND ${live('s', 'a', '$2', '$4')}
       RETURNING s.id, s.user_id::text AS user_id, a.login, a.role, a.must_change_password,
                 a.may_acknowledge, a.disabled`,
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
      mayAcknowledge: row.may_acknowledge,
      sessionId: row.id,
    };
  }

  /**
   * Which of these sessions no longer authenticate, and why (`A-34`).
   *
   * **`resolve`'s question, for sessions that are not presenting themselves.** A stream socket was
   * authenticated once, at its upgrade, and lives for days; this is how it is asked again, with
   * the condition `resolve` uses — `live`, below — so the two cannot disagree.
   *
   * **Asking does not extend the session**, and that is a decision rather than an omission. An
   * open stream is not activity: if it were, a browser left on a dashboard would never reach the
   * idle timeout, and the timeout would mean nothing for exactly the unattended screen it exists
   * for. A display meant to stay up uses a public share link, or a longer idle timeout.
   *
   * The account is joined by the id the socket was opened as, not through the session, so a
   * disabled account reads `disabled` whether or not its sessions are still there.
   */
  async lapsed(
    sessions: readonly { readonly id: string; readonly userId: number }[],
  ): Promise<Map<string, Lapse>> {
    if (sessions.length === 0) return new Map();
    const rows = await this.#db.query<{ id: string; lapse: Lapse }>(
      `SELECT c.id,
              CASE WHEN a.id IS NULL OR a.disabled THEN 'disabled'
                   WHEN s.id IS NULL THEN 'ended'
                   ELSE 'expired'
              END AS lapse
       FROM unnest($1::text[], $2::bigint[]) AS c(id, user_id)
       LEFT JOIN user_account a ON a.id = c.user_id
       LEFT JOIN user_session s ON s.id = c.id AND s.user_id = c.user_id
       -- COALESCE: an answer Postgres cannot give is not "still signed in".
       WHERE NOT COALESCE(s.id IS NOT NULL AND a.id IS NOT NULL
                          AND ${live('s', 'a', '$3', '$4')}, false)`,
      [
        sessions.map((session) => session.id),
        sessions.map((session) => session.userId),
        this.#now(),
        `${String(Math.round(this.#absoluteMs / 1000))} seconds`,
      ],
    );
    return new Map(rows.map((row) => [row.id, row.lapse]));
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

/**
 * Whether session row `s` of account row `a` still authenticates at `now`: under both timeouts,
 * and the account not disabled. One text, used by `resolve` and `lapsed` alike (`A-34`).
 *
 * The absolute ceiling is checked here as well as being folded into `expires_at` on every use,
 * because a ceiling lowered in configuration applies to sessions that were extended under the old
 * one.
 */
function live(s: string, a: string, now: string, absolute: string): string {
  return `${s}.expires_at > ${now}
         AND ${s}.created_at + ${absolute}::interval > ${now}
         AND ${a}.disabled = false`;
}
