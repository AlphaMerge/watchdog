import type { Migration } from './types.js';

/**
 * User groups, and one primary group per user (`A-02`).
 *
 * **Groups exist so that rights are not granted per person.** `A-03` hangs per-object access
 * rights off a group rather than off an account, because an installation with forty operators
 * and six hundred devices cannot be administered one grant at a time — and because the grant has
 * to survive the person leaving. A right attached to a user is a right that has to be reissued
 * when somebody joins the on-call rota; a right attached to a group is one somebody is added to.
 *
 * **The primary group is not the strongest membership, it is the *default* one.** PRTG uses it
 * for one thing: which group owns an object this user creates. Every other question — what may
 * this user see, what may they change — is answered by the union of *all* their groups, because
 * anything else would make adding somebody to a second group able to take access away.
 */
export const migration032: Migration = {
  id: 32,
  name: 'user-groups',

  up: `
    CREATE TABLE user_group (
      id           bigserial PRIMARY KEY,
      name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),

      -- **A group whose members administer everything.** Kept as a flag rather than as a right
      -- on the root object, because "may do anything, including to objects that do not exist
      -- yet" is not a statement about a position in the tree. A-04 refuses to put a read-only
      -- account in one of these.
      is_admin     boolean NOT NULL DEFAULT false,

      -- The group every new account joins when nobody says otherwise. Exactly one, enforced by
      -- the partial unique index below: zero would mean account creation has to ask a question
      -- nobody wants to answer, and two would mean it has to pick.
      is_default   boolean NOT NULL DEFAULT false,

      -- Built-in groups cannot be deleted or renamed. Deleting the administrators group is a
      -- one-way door out of your own installation.
      is_builtin   boolean NOT NULL DEFAULT false,

      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX user_group_name_idx ON user_group (lower(name));
    CREATE UNIQUE INDEX user_group_default_idx ON user_group (is_default) WHERE is_default;

    CREATE TABLE user_group_member (
      group_id   bigint NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
      user_id    bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,

      -- **Which of this user's groups is their primary one.** On the membership row rather than
      -- on the account, so it cannot name a group they do not belong to — a foreign key from
      -- user_account to user_group could not express "and they must be a member of it", and the
      -- pair of rules would drift the first time somebody was removed from a group.
      is_primary boolean NOT NULL DEFAULT false,

      added_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    );

    -- At most one primary per user. Not *exactly* one, because a membership row is inserted
    -- before anything decides which is primary; the service is what guarantees a user with any
    -- group has a primary one, and this is what stops it ever being two.
    CREATE UNIQUE INDEX user_group_primary_idx
      ON user_group_member (user_id) WHERE is_primary;

    CREATE INDEX user_group_member_user_idx ON user_group_member (user_id);

    -- The two groups every installation has. Administrators, because A-01's bootstrap account
    -- needs somewhere to be; Users, because a new account needs a default that grants nothing on
    -- its own — an account that lands in the administrators group by default would make the
    -- distinction meaningless.
    INSERT INTO user_group (name, description, is_admin, is_default, is_builtin) VALUES
      ('Administrators', 'Full control of the installation and its accounts', true, false, true),
      ('Users', 'The group new accounts join; grants nothing on its own', false, true, true);

    -- Every account that already exists joins a group, so an upgrade does not leave anybody
    -- belonging to nothing. Administrators by role, everybody else by default — matching what
    -- their A-01 role already said about them.
    INSERT INTO user_group_member (group_id, user_id, is_primary)
    SELECT g.id, a.id, true
    FROM user_account a
    JOIN user_group g
      ON g.name = CASE WHEN a.role = 'admin' THEN 'Administrators' ELSE 'Users' END;
  `,

  down: `
    DROP TABLE IF EXISTS user_group_member;
    DROP TABLE IF EXISTS user_group;
  `,
};
