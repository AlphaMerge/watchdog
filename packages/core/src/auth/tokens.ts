import { randomBytes } from 'node:crypto';
import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { cappedBy, type AccessRight } from './access.js';
import type { AccountRole } from './accounts.js';
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
  tokenId: number;
  /** The token's own ceiling, to be applied on top of the account's. */
  scope: AccessRight;
}

export interface TokenServiceOptions {
  db: Database;
  logger: Logger;
  now?: () => Date;
  /** How stale `last_used_at` may be before a use writes it. */
  lastUsedResolutionMs?: number;
}

const DEFAULT_LAST_USED_MS = 60_000;

export class TokenService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #lastUsedMs: number;

  constructor(options: TokenServiceOptions) {
    this.#db = options.db;
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
   */
  async issue(
    owner: { userId: number; role: AccountRole },
    request: { name: string; scope?: AccessRight; expiresAt?: Date },
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
      const rows = await this.#db.query<TokenRow>(
        `INSERT INTO api_token (user_id, name, token_hash, prefix, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [owner.userId, name, sessionIdFor(secret), prefix, scope, request.expiresAt ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw new AuthError('TOKEN_INVALID', 'the token was not created');
      this.#logger.info({ userId: owner.userId, name, scope }, 'api token issued');
      return { token: read(row), secret };
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
      scope: AccessRight;
      last_used_at: Date | null;
    }>(
      `SELECT t.id::text AS id, t.user_id::text AS user_id, a.login, a.role,
              a.must_change_password, t.scope, t.last_used_at
       FROM api_token t JOIN user_account a ON a.id = t.user_id
       WHERE t.token_hash = $1
         AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > $2)
         AND a.disabled = false`,
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
      tokenId: Number(row.id),
      scope: row.scope,
    };
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
   */
  async revoke(userId: number, tokenId: number, revokedBy: string): Promise<boolean> {
    const rows = await this.#db.query<{ id: string }>(
      `UPDATE api_token SET revoked_at = $3, revoked_by = $4
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id::text AS id`,
      [tokenId, userId, this.#now(), revokedBy.slice(0, 64)],
    );
    if (rows.length > 0) this.#logger.info({ tokenId, userId, revokedBy }, 'api token revoked');
    return rows.length > 0;
  }

  /** Revokes every token an account holds — what a compromised account needs. */
  async revokeAllFor(userId: number, revokedBy: string): Promise<number> {
    const rows = await this.#db.query<{ id: string }>(
      `UPDATE api_token SET revoked_at = $2, revoked_by = $3
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING id::text AS id`,
      [userId, this.#now(), revokedBy.slice(0, 64)],
    );
    return rows.length;
  }
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
