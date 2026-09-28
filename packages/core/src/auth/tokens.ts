import { randomBytes } from 'node:crypto';
import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { cappedBy, grantedByLabel, type AccessRight } from './access.js';
import type { AccountRole } from './accounts.js';
import type { Lapse } from './credentials.js';
import { AuthError } from './errors.js';
import { sessionIdFor } from './passwords.js';

/**
 * API tokens (`A-06`).
 *
 * **A token acts as its owner and never as more than its owner.** Its scope can only *narrow*
 * what the account already holds: a read-only account cannot mint a token that writes, and
 * disabling the account stops every token it issued. The alternative — a token with rights of
 * its own — is a second access-control system to keep in step with the first, and the two would
 * disagree the first time somebody changed a group.
 *
 * **The token is shown once, at creation, and is unrecoverable afterwards**, which is the same
 * rule the probe access key and the session cookie follow. What is stored is a SHA-256; what is
 * *displayed* thereafter is the prefix, because a person with six tokens needs to tell them
 * apart and that is the only handle they will ever have.
 */

/** `mst_` for "MonitoringSystem token" — greppable in a log somebody is about to regret. */
const TOKEN_PREFIX = 'mst_';
const PREFIX_LENGTH = 12;

export interface ApiToken {
  id: number;
  userId: number;
  name: string;
  prefix: string;
  scope: AccessRight;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** What a presented token resolves to. Shaped like a session principal, deliberately. */
export interface TokenPrincipal {
  userId: number;
  login: string;
  role: AccountRole;
  mustChangePassword: boolean;
  mayAcknowledge: boolean;
  tokenId: number;
  /** The token's own ceiling, to be applied on top of the account's. */
  scope: AccessRight;
}

export interface TokenServiceOptions {
  db: Database;
  /**
   * Where issuing and revoking are recorded, in the change's own transaction (`A-18`). Required:
   * a token is a credential that outlives the session that made it, and one issued for somebody
   * else's account is a way into that account.
   */
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
  /** How stale `last_used_at` may be before a use writes it. */
  lastUsedResolutionMs?: number;
}

const DEFAULT_LAST_USED_MS = 60_000;

export class TokenService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #lastUsedMs: number;

  constructor(options: TokenServiceOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'api-tokens' });
    this.#now = options.now ?? ((): Date => new Date());
    this.#lastUsedMs = options.lastUsedResolutionMs ?? DEFAULT_LAST_USED_MS;
  }

  /**
   * Issues a token and returns it once.
   *
   * **The scope is capped by the owner's role here, at creation**, as well as being capped again
   * at every use. Capping only at use would let an account mint a `full` token, be demoted to
   * read-only, and leave a token in somebody's script that *looks* like it still writes — the
   * list would say `full` and the behaviour would be `read`. Capping only at creation would let
   * a later demotion be escaped entirely. Both, because they answer different questions.
   *
   * **Audited with the prefix, never the token** (`A-18`), in the same transaction: the entry names
   * the owner, which need not be the actor, and the scope it was capped to.
   */
  async issue(
    owner: { userId: number; role: AccountRole },
    request: { name: string; scope?: AccessRight; expiresAt?: Date },
    actor: Actor,
  ): Promise<{ token: ApiToken; secret: string }> {
    const name = request.name.trim();
    if (name === '' || name.length > 100) {
      throw new AuthError('TOKEN_INVALID', 'a token name must be between 1 and 100 characters');
    }
    if (request.expiresAt !== undefined && request.expiresAt <= this.#now()) {
      throw new AuthError('TOKEN_INVALID', 'a token cannot expire in the past');
    }

    const scope = cappedBy(owner.role, request.scope ?? 'read');
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const prefix = secret.slice(0, PREFIX_LENGTH);

    try {
      const token = await this.#db.tx(async (q) => {
        const rows = await q.query<TokenRow & { login: string }>(
          `WITH issued AS (
             INSERT INTO api_token (user_id, name, token_hash, prefix, scope, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${COLUMNS}
           )
           SELECT issued.*, a.login FROM issued JOIN user_account a ON a.id = issued.user_id`,
          [owner.userId, name, sessionIdFor(secret), prefix, scope, request.expiresAt ?? null],
        );
        const row = rows[0];
        if (row === undefined) throw new AuthError('TOKEN_INVALID', 'the token was not created');
        const issued = read(row);
        await this.#audit.record(
          q,
          actor,
          [
            {
              action: 'token.issued',
              objectId: null,
              tokenId: issued.id,
              accountId: issued.userId,
              login: row.login,
              name: issued.name,
              prefix: issued.prefix,
              scope: issued.scope,
              expiresAt: row.expires_at,
            },
          ],
          this.#now(),
        );
        return issued;
      });
      this.#logger.info({ userId: owner.userId, name, scope }, 'api token issued');
      return { token, secret };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AuthError('TOKEN_EXISTS', `this account already has a token named ${name}`);
      }
      throw error;
    }
  }

  /**
   * Resolves a presented token, or null.
   *
   * **One query, and it is the authentication path**, so the expiry, the revocation and the
   * account's own disabled flag are all in the `WHERE` rather than in branches afterwards — a
   * row that should not authenticate simply does not match.
   */
  async resolve(secret: string): Promise<TokenPrincipal | null> {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;

    const now = this.#now();
    const rows = await this.#db.query<{
      id: string;
      user_id: string;
      login: string;
      role: string;
      must_change_password: boolean;
      may_acknowledge: boolean;
      scope: AccessRight;
      last_used_at: Date | null;
    }>(
      `SELECT t.id::text AS id, t.user_id::text AS user_id, a.login, a.role,
              a.must_change_password, a.may_acknowledge, t.scope, t.last_used_at
       FROM api_token t JOIN user_account a ON a.id = t.user_id
       WHERE t.token_hash = $1 AND ${live('t', 'a', '$2')}`,
      [sessionIdFor(secret), now],
    );

    const row = rows[0];
    if (row === undefined) return null;

    // **Written at most once a minute.** A polling script would otherwise turn every read into a
    // write, which is a lot of WAL for a column nobody reads at that resolution.
    const stale =
      row.last_used_at === null || now.getTime() - row.last_used_at.getTime() > this.#lastUsedMs;
    if (stale) {
      await this.#db.query(`UPDATE api_token SET last_used_at = $2 WHERE id = $1`, [row.id, now]);
    }

    return {
      userId: Number(row.user_id),
      login: row.login,
      role: row.role as AccountRole,
      mustChangePassword: row.must_change_password,
      mayAcknowledge: row.may_acknowledge,
      tokenId: Number(row.id),
      scope: row.scope,
    };
  }

  /**
   * Which of these tokens no longer authenticate, and why (`A-34`).
   *
   * `resolve`'s question — the condition in `live`, below — for tokens that are not presenting
   * themselves: a stream socket opened with a token was authenticated once, at its upgrade. Asked
   * by id, since the secret is long gone, and joined to the account the socket was opened as, so
   * a disabled owner reads `disabled` rather than whatever its tokens say.
   */
  async lapsed(
    tokens: readonly { readonly id: number; readonly userId: number }[],
  ): Promise<Map<number, Lapse>> {
    if (tokens.length === 0) return new Map();
    const rows = await this.#db.query<{ id: string; lapse: Lapse }>(
      `SELECT c.id::text AS id,
              CASE WHEN a.id IS NULL OR a.disabled THEN 'disabled'
                   WHEN t.id IS NULL OR t.revoked_at IS NOT NULL THEN 'revoked'
                   ELSE 'expired'
              END AS lapse
       FROM unnest($1::bigint[], $2::bigint[]) AS c(id, user_id)
       LEFT JOIN user_account a ON a.id = c.user_id
       LEFT JOIN api_token t ON t.id = c.id AND t.user_id = c.user_id
       -- COALESCE: an answer Postgres cannot give is not "still valid".
       WHERE NOT COALESCE(t.id IS NOT NULL AND a.id IS NOT NULL AND ${live('t', 'a', '$3')}, false)`,
      [tokens.map((token) => token.id), tokens.map((token) => token.userId), this.#now()],
    );
    return new Map(rows.map((row) => [Number(row.id), row.lapse]));
  }

  /** An account's own tokens, newest first. Never the secrets — they no longer exist here. */
  async listFor(userId: number, includeRevoked = false): Promise<ApiToken[]> {
    const rows = await this.#db.query<TokenRow>(
      `SELECT ${COLUMNS} FROM api_token
       WHERE user_id = $1 AND ($2 OR revoked_at IS NULL)
       ORDER BY created_at DESC`,
      [userId, includeRevoked],
    );
    return rows.map(read);
  }

  /**
   * Revokes a token.
   *
   * Scoped to its owner by the caller passing `userId`: without that, a token id is a guessable
   * integer and revoking somebody else's would be one request away.
   *
   * `revoked_by` is the actor's login, as a grant's `granted_by` is. A revoke that found no live
   * token changes nothing and writes no entry (`A-18`).
   */
  async revoke(userId: number, tokenId: number, actor: Actor): Promise<boolean> {
    const revoked = await this.#db.tx(async (q) =>
      this.#revoke(q, `t.id = $1 AND t.user_id = $2`, [tokenId, userId], actor),
    );
    if (revoked > 0) this.#logger.info({ tokenId, userId, actor }, 'api token revoked');
    return revoked > 0;
  }

  /** Revokes every token an account holds — what a compromised account needs. One entry each. */
  async revokeAllFor(userId: number, actor: Actor): Promise<number> {
    return this.#db.tx(async (q) => this.#revoke(q, `t.user_id = $1`, [userId], actor));
  }

  async #revoke(q: Queryable, which: string, values: unknown[], actor: Actor): Promise<number> {
    const at = this.#now();
    const rows = await q.query<{
      id: string;
      user_id: string;
      name: string;
      prefix: string;
      login: string;
    }>(
      `UPDATE api_token t SET revoked_at = $${String(values.length + 1)},
                              revoked_by = $${String(values.length + 2)}
       FROM user_account a
       WHERE ${which} AND t.revoked_at IS NULL AND a.id = t.user_id
       RETURNING t.id::text AS id, t.user_id::text AS user_id, t.name, t.prefix, a.login`,
      [...values, at, grantedByLabel(actor)],
    );
    await this.#audit.record(
      q,
      actor,
      rows.map((row) => ({
        action: 'token.revoked' as const,
        objectId: null,
        tokenId: Number(row.id),
        accountId: Number(row.user_id),
        login: row.login,
        name: row.name,
        prefix: row.prefix,
      })),
      at,
    );
    return rows.length;
  }
}

/**
 * Whether token row `t` of account row `a` still authenticates at `now`: not revoked, not expired,
 * and its owner not disabled. One text, used by `resolve` and `lapsed` alike (`A-34`).
 */
function live(t: string, a: string, now: string): string {
  return `${t}.revoked_at IS NULL
         AND (${t}.expires_at IS NULL OR ${t}.expires_at > ${now})
         AND ${a}.disabled = false`;
}

const COLUMNS = `id, user_id, name, prefix, scope, expires_at, last_used_at, revoked_at, created_at`;

interface TokenRow {
  id: string | number;
  user_id: string | number;
  name: string;
  prefix: string;
  scope: AccessRight;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function read(row: TokenRow): ApiToken {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('context' in error) {
    const context = (error as { context?: Record<string, unknown> }).context;
    if (context?.['sqlstate'] === '23505') return true;
  }
  return 'code' in error && error.code === '23505';
}
