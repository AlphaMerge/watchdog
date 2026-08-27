import type { Migration } from './types.js';

/**
 * Accounts and sessions (`A-01`).
 *
 * **Everything before this ran as `anonymous`.** The `Actor` union has carried a `user` variant
 * since the audit log was written, and nothing ever produced one — four route files each had
 * their own `actorFor` returning the request's IP address. The audit log has therefore been
 * recording *that a thing happened* without being able to record *who did it*, which is half of
 * what an audit log is for.
 *
 * **Roles here, per-object rights in `A-03`.** This table carries the account-level role because
 * some things are not about a position in the tree at all — whether an account may administer
 * other accounts, whether it may see a credential, whether it may acknowledge. Rights on a
 * *branch* are a different question with a different answer per object, and putting them here
 * would mean answering it once for the whole tree.
 */
export const migration031: Migration = {
  id: 31,
  name: 'accounts',

  up: `
    CREATE TABLE user_account (
      id             bigserial PRIMARY KEY,

      -- Case-insensitive, because an operator typing their own name in the wrong case at 3am is
      -- not a different person. Stored as entered so it can be displayed as they wrote it, and
      -- compared folded, which is what the unique index below does.
      login          text NOT NULL CHECK (length(login) BETWEEN 1 AND 64),
      display_name   text NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
      email          text NOT NULL DEFAULT '' CHECK (length(email) <= 320),

      -- argon2id. **A slow hash is the right tool here and the wrong one for a probe key**
      -- (R-01): a password is drawn from a space small enough to search, and 32 random bytes is
      -- not. The parameters live with the code that verifies them, because they are tuned to the
      -- machine and have to be able to change without a migration.
      password_hash  text NOT NULL,

      -- admin:     may administer accounts and see the whole tree
      -- readwrite:  may change what their rights allow (A-03)
      -- readonly:   may look, and acknowledge if granted (A-04)
      role           text NOT NULL DEFAULT 'readonly'
                       CHECK (role IN ('admin', 'readwrite', 'readonly')),

      -- Disabled rather than deleted: an account that has changed things is referenced by every
      -- audit row it wrote, and deleting it would either orphan that history or cascade it away.
      -- Disabling stops the logins and keeps the record of who did what.
      disabled       boolean NOT NULL DEFAULT false,

      -- Set for an account created by an administrator or by the bootstrap. The first login has
      -- to replace the password somebody else chose, or the installation's first password lives
      -- for ever in whatever terminal it was printed to.
      must_change_password boolean NOT NULL DEFAULT false,

      -- Login throttling, per account (A-01). The companion per-address counter is deliberately
      -- *not* here — see the throttle for why one of them alone is a denial of service and the
      -- other alone is no defence.
      failed_attempts integer NOT NULL DEFAULT 0,
      locked_until   timestamptz,

      last_login_at  timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    -- Folded, so 'Admin' and 'admin' cannot both exist. Two accounts differing only in case is
    -- an authentication bug waiting for somebody to be confused by it.
    CREATE UNIQUE INDEX user_account_login_idx ON user_account (lower(login));

    CREATE TABLE user_session (
      -- **The stored id is a hash of the cookie, not the cookie.** Same rule as the probe access
      -- key and for the same reason: a value an API or a backup can yield is a value that ends
      -- up somewhere it should not be, and a session id read out of a database dump is a login.
      -- SHA-256 rather than argon2 because there is nothing to guess in 32 random bytes.
      id             text PRIMARY KEY CHECK (length(id) = 64),

      user_id        bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,

      -- Shown on an account's own session list, so somebody can recognise the one that is not
      -- theirs. Untrusted strings, which is why they are bounded here.
      remote_address text NOT NULL DEFAULT '' CHECK (length(remote_address) <= 64),
      user_agent     text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 400),

      created_at     timestamptz NOT NULL DEFAULT now(),
      -- Rolling: touched as the session is used, so an active operator is not logged out mid-shift
      -- while an abandoned browser tab still expires.
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL
    );

    -- The two queries this table has: resolve one session, and drop the dead ones.
    CREATE INDEX user_session_user_idx ON user_session (user_id);
    CREATE INDEX user_session_expiry_idx ON user_session (expires_at);

    -- **Failed logins are recorded by address as well as by account**, and it has to be both.
    -- Counting only per account lets anybody lock every operator out of their own system by
    -- failing to log in as them, which is a denial of service dressed as a security control.
    -- Counting only per address stops nothing distributed. Recorded here rather than in memory
    -- so a restart is not a way to clear the count.
    CREATE TABLE login_attempt (
      id             bigserial PRIMARY KEY,
      -- What was typed, not a resolved account: an attempt against a login that does not exist
      -- is exactly the attempt worth counting, and it has no account to hang from.
      login          text NOT NULL DEFAULT '' CHECK (length(login) <= 64),
      remote_address text NOT NULL DEFAULT '' CHECK (length(remote_address) <= 64),
      succeeded      boolean NOT NULL,
      at             timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX login_attempt_address_idx ON login_attempt (remote_address, at);
    CREATE INDEX login_attempt_login_idx ON login_attempt (lower(login), at);
  `,

  down: `
    DROP TABLE IF EXISTS login_attempt;
    DROP TABLE IF EXISTS user_session;
    DROP TABLE IF EXISTS user_account;
  `,
};
