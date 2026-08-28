import type { Migration } from './types.js';

/**
 * TOTP multi-factor authentication (`A-07`).
 *
 * **Enrolment is two steps, and the schema is what makes the first one harmless.** A secret is
 * generated and stored *unconfirmed*; it does nothing until the person proves they can read a
 * code from it. Storing a confirmed secret straight away is how somebody locks themselves out
 * with a mistyped setup — the authenticator app never got it, and now the account demands codes
 * from it.
 *
 * **Recovery codes are hashed, single-use, and the reason they exist is a lost phone.** An
 * installation that can only be entered with a device somebody is holding is an installation
 * that a dropped phone takes down. They are hashed like passwords rather than like tokens: each
 * is short enough to be worth attacking offline if the table leaks.
 *
 * **Enforcement is a property of a *group*, not of an account.** "Everybody who can change the
 * monitoring configuration uses MFA" is the policy an administrator actually wants to write, and
 * writing it per account means remembering it every time somebody joins.
 */
export const migration036: Migration = {
  id: 36,
  name: 'totp',

  up: `
    CREATE TABLE user_totp (
      user_id      bigint PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,

      -- The shared secret, base32. **Encrypted at rest is not attempted here and that is a
      -- deliberate limitation**: the core needs the plaintext on every verification, so any key
      -- it could use lives beside the data it protects. The honest protection is that this table
      -- is no more sensitive than password_hash beside it, and both are covered by the same
      -- database access controls.
      secret       text NOT NULL CHECK (length(secret) BETWEEN 16 AND 128),

      -- **Unconfirmed until a code from it verifies.** Until then the account authenticates
      -- exactly as it did before, so an abandoned enrolment costs nothing.
      confirmed_at timestamptz,

      -- The last step number accepted, so a code cannot be replayed inside its own window.
      -- Without it, an observed code works for the whole 30 seconds it is displayed, which is
      -- the entire attack against somebody reading over a shoulder.
      last_step    bigint,

      created_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_recovery_code (
      id         bigserial PRIMARY KEY,
      user_id    bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
      -- argon2id, like a password: each code is short enough to be worth attacking offline.
      code_hash  text NOT NULL,
      used_at    timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX user_recovery_code_user_idx ON user_recovery_code (user_id) WHERE used_at IS NULL;

    -- **Required of a group, so the policy is written once.** An account is required to use MFA
    -- if any group it belongs to requires it — the same "highest wins" shape as A-03's rights,
    -- and for the same reason: joining a group must never quietly relax a requirement.
    ALTER TABLE user_group
      ADD COLUMN requires_mfa boolean NOT NULL DEFAULT false;
  `,

  down: `
    ALTER TABLE user_group DROP COLUMN IF EXISTS requires_mfa;
    DROP TABLE IF EXISTS user_recovery_code;
    DROP TABLE IF EXISTS user_totp;
  `,
};
