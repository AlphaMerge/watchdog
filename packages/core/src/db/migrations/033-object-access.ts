import type { Migration } from './types.js';

/**
 * Per-object access rights (`A-03`, `CAPABILITIES.MD §14`).
 *
 * **A grant is (object, group, right) — never (object, user, right).** Rights on a person have to
 * be reissued when somebody else joins the rota and have to be revoked when they leave, and both
 * are jobs somebody forgets. `A-02` exists so this table can point at a group.
 *
 * **Inheritance is resolved per group, then combined.** Each group's right is inherited from the
 * nearest ancestor that defines one *for that group*; the account's effective right is the
 * highest across the groups it belongs to. The alternative — take the nearest ancestor defining
 * a right for *anyone*, then combine only there — has a property nobody wants: granting one
 * group `read` on a deep device would silently take away another group's inherited `full`. The
 * same rule `A-02` applies to the primary group: adding must never take away.
 *
 * **Rights are ordered, and the order is stored as a number for exactly one reason.** The
 * combining rule is a maximum, and `max()` over text would order them alphabetically — `full` <
 * `none` < `read` < `write` — which is wrong in every position. The text form is what an API and
 * an operator read; the integer is what the resolver compares.
 */
export const migration033: Migration = {
  id: 33,
  name: 'object-access',

  up: `
    -- none:  cannot see it at all, and it is not merely hidden — a right of none has to be
    --        expressible so that a grant high in the tree can be *withdrawn* lower down.
    -- read:  may look
    -- write: may edit, create and delete beneath it, acknowledge alarms, manage notifications
    -- full:  write, plus editing that object's own group rights
    CREATE TYPE access_right AS ENUM ('none', 'read', 'write', 'full');

    CREATE TABLE object_access (
      object_id  bigint NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      group_id   bigint NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
      right_     access_right NOT NULL,

      granted_at timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account: an account can be deleted, and the record of who granted
      -- a right should outlive it. The login is kept as text for the same reason the audit log
      -- keeps one.
      granted_by text NOT NULL DEFAULT '' CHECK (length(granted_by) <= 64),

      PRIMARY KEY (object_id, group_id)
    );

    -- The resolver's own query: walk the ancestors, take the shallowest row per group. Leading
    -- with object_id is what makes that walk an index lookup per level rather than a scan.
    CREATE INDEX object_access_object_idx ON object_access (object_id, group_id);

    -- The administrator's question in the other direction: what does this group hold, anywhere?
    CREATE INDEX object_access_group_idx ON object_access (group_id);

    -- **The ordering, as a function rather than a column.** Storing a rank beside the enum would
    -- be a second source of truth for the same fact, and the two would eventually disagree.
    CREATE FUNCTION access_rank(r access_right) RETURNS integer
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT CASE r
          WHEN 'none'  THEN 0
          WHEN 'read'  THEN 1
          WHEN 'write' THEN 2
          WHEN 'full'  THEN 3
        END
      $$;

    -- **The root starts readable by the default group, and that is a deliberate default.** An
    -- installation that upgrades into A-03 with an empty table would be one where every non-admin
    -- account suddenly sees nothing — an access-control change that reads to an operator as the
    -- monitoring system having lost their tree. Read is the floor; anything more is granted.
    INSERT INTO object_access (object_id, group_id, right_, granted_by)
    SELECT o.id, g.id, 'read', 'upgrade'
    FROM object o
    CROSS JOIN user_group g
    WHERE o.parent_id IS NULL AND g.is_default;
  `,

  down: `
    DROP TABLE IF EXISTS object_access;
    DROP FUNCTION IF EXISTS access_rank(access_right);
    DROP TYPE IF EXISTS access_right;
  `,
};
