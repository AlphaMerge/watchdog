import type { Migration } from './types.js';

/**
 * API tokens (`A-06`).
 *
 * **A token acts as its owner, and never as more than its owner.** It carries a scope that can
 * only *narrow* what the account already holds — a read-only account cannot mint a token that
 * writes, and revoking somebody's account takes their tokens with it. The alternative, a token
 * with rights of its own, is a second access-control system to keep in step with the first, and
 * the two would disagree the first time somebody changed a group.
 *
 * **Stored as a hash, like every other credential here.** `R-01`'s probe keys and `A-01`'s
 * sessions follow the same rule for the same reason: a value a database dump can yield is a
 * value that works. SHA-256 rather than argon2 — there is nothing to guess in 32 random bytes,
 * and a token is presented on every request, where a slow hash would be a tax on all of them.
 *
 * **The prefix is stored in clear on purpose.** A person with six tokens needs to tell them
 * apart, and "the one starting `mst_7f3a`" is the only handle they will ever have — the rest of
 * it is unrecoverable by design. It is short enough to be useless to anybody who learns it.
 */
export const migration035: Migration = {
  id: 35,
  name: 'api-tokens',

  up: `
    CREATE TABLE api_token (
      id          bigserial PRIMARY KEY,
      user_id     bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,

      -- What the person called it. The only way they will recognise it in a list.
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),

      -- SHA-256 of the presented token, hex.
      token_hash  text NOT NULL UNIQUE CHECK (length(token_hash) = 64),

      -- The first few characters, kept so a list is readable. Never enough to use.
      prefix      text NOT NULL CHECK (length(prefix) <= 16),

      -- **A ceiling, not a grant.** The effective right is the lesser of this and what the
      -- account's groups and role allow, so a token can only ever be *less* than its owner.
      scope       access_right NOT NULL DEFAULT 'read',

      -- Optional. A token that never expires is the one still working three jobs later.
      expires_at  timestamptz,

      -- **Written at most once a minute, not on every request.** A token used by a polling
      -- script would otherwise turn every read into a write, which is a lot of WAL for a column
      -- nobody reads at that resolution.
      last_used_at timestamptz,

      -- Revoked rather than deleted, so the record of what existed survives the decision. A
      -- revoked token is refused by the same query that resolves a live one.
      revoked_at  timestamptz,
      revoked_by  text NOT NULL DEFAULT '' CHECK (length(revoked_by) <= 64),

      created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- The list an account sees of its own tokens.
    CREATE INDEX api_token_user_idx ON api_token (user_id, created_at DESC);

    -- One name per account, so "which is the backup one" has an answer. Revoked names are
    -- released: a token replaced after a leak usually wants the name of the one it replaced.
    CREATE UNIQUE INDEX api_token_name_idx
      ON api_token (user_id, lower(name)) WHERE revoked_at IS NULL;
  `,

  down: `
    DROP TABLE IF EXISTS api_token;
  `,
};
