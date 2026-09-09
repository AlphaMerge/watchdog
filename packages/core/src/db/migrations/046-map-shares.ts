import type { Migration } from './types.js';

/**
 * Public share links for a map (`G-06`, `ADR-002` Decision 1).
 *
 * **The token is stored as a hash, exactly as `api_token` stores one.** A bearer token in a
 * database column is a credential at rest: anybody who can read a backup can open every shared
 * map. SHA-256 rather than argon2 because the secret is 256 bits of randomness rather than a
 * password — there is nothing to slow down a guesser about — and because this is looked up on
 * every request a wall display makes.
 *
 * **The consequence is that the URL can be shown once and never again**, which is a property to
 * state rather than to work around: a share link that can be re-read from the system is a share
 * link that leaks with the database.
 *
 * **`expires_at` is `NOT NULL` here and nullable on `api_token`**, and the difference is the whole
 * decision. `ADR-002` makes an expiry mandatory because a share link with none is a permanent
 * unauthenticated route that nobody remembers creating; an API token at least belongs to an
 * account somebody can be asked about.
 *
 * Revoked rather than deleted, the same as `api_token`: the record of what existed outlives the
 * decision to stop it, and the same query that resolves a live token refuses a revoked one.
 */
export const migration046: Migration = {
  id: 46,
  name: 'map-shares',

  up: `
    CREATE TABLE map_share (
      id           bigserial PRIMARY KEY,
      map_id       bigint NOT NULL REFERENCES map(id) ON DELETE CASCADE,

      -- What it is for. The only way somebody deciding whether to revoke one will recognise it.
      label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),

      -- SHA-256 of the presented token, hex. The token itself is never stored.
      token_hash   text NOT NULL UNIQUE CHECK (length(token_hash) = 64),

      -- The first few characters, so a list is readable. Never enough to use.
      prefix       text NOT NULL CHECK (length(prefix) <= 16),

      -- Mandatory, unlike api_token's. ADR-002: a link with no expiry is a permanent
      -- unauthenticated route nobody remembers creating.
      expires_at   timestamptz NOT NULL,

      -- **Written at most once a minute, not on every request** — the same rule api_token
      -- follows, and it matters more here: a wall display polls, and turning every read into a
      -- write is a lot of WAL for a column read at the resolution of "recently".
      last_used_at timestamptz,

      revoked_at   timestamptz,
      revoked_by   text NOT NULL DEFAULT '' CHECK (length(revoked_by) <= 64),

      created_at   timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account, for the reason map_access gives: who made the link
      -- should outlive the account being deleted.
      created_by   text NOT NULL DEFAULT '' CHECK (length(created_by) <= 64)
    );

    -- The list shown beside a map, newest first.
    CREATE INDEX map_share_map_idx ON map_share (map_id, created_at DESC);

    -- One live label per map, so "which link is the NOC one" has an answer. Revoked labels are
    -- released: a link replaced after a leak usually wants the name of the one it replaced.
    CREATE UNIQUE INDEX map_share_label_idx
      ON map_share (map_id, lower(label)) WHERE revoked_at IS NULL;

    COMMENT ON TABLE map_share IS
      'Public share links (ADR-002 Decision 1). The token is stored only as a SHA-256, so a URL '
      'can be shown once and never recovered.';
  `,

  down: `
    DROP TABLE IF EXISTS map_share;
  `,
};
