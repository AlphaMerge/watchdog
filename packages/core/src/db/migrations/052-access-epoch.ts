import type { Migration } from './types.js';

/**
 * A counter that moves whenever what an account may see could have changed (`A-12`).
 *
 * **Why the stream needs it and nothing else does.** Every REST request resolves the caller's
 * visibility afresh, so a revoked grant takes effect on the next request by construction. A
 * WebSocket subscribes once and stays open for days; it resolves its visibility when it
 * subscribes, and something has to tell it that the answer went stale. Re-resolving on every
 * published batch would be a query per open socket per state change, and the stream is supposed
 * to cost one comparison when nothing is happening.
 *
 * **What moves it is exactly what a principal's visibility is made of**: the grants
 * (`object_access`), who is in which group (`user_group_member`), which groups administer
 * (`user_group.is_admin`, and a group's deletion), and where objects hang (`object.parent_id` — a
 * move changes what a grant point inherits from above it). Not a role: a role is a ceiling, and
 * the lowest ceiling is `read`, so no role change can take away visibility. Not an object's
 * creation or deletion either: a new object is seen or not according to the grants already above
 * it, and each stream event carries its own fresh path.
 *
 * **A row in a table, not a sequence, and that is the whole point.** `nextval` is not
 * transactional: the counter would advance the moment a grant was written, *before* it
 * committed, and a stream that noticed in that window would re-resolve against the old grants —
 * and then never look again, because the counter would not move a second time. An `UPDATE`
 * becomes visible together with the grant that caused it, or not at all.
 *
 * **Statement-level triggers**, so a bulk change is one bump and not a thousand. A statement that
 * touched no rows still bumps it, which costs one spurious re-resolution and saves a trigger
 * that has to count.
 *
 * **Contention is a non-issue by shape.** The row is locked from the bumping statement to its
 * commit. What bumps it is a grant, a membership change or a move — administrative writes, and a
 * move already holds the tree's exclusive lock. The hot paths (ingestion, state changes, object
 * creation) never touch it.
 */
export const migration052: Migration = {
  id: 52,
  name: 'access-epoch',

  up: `
    CREATE TABLE access_epoch (
      -- A single row, enforced: the value is one fact about the installation.
      only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
      value    bigint  NOT NULL DEFAULT 0
    );
    INSERT INTO access_epoch DEFAULT VALUES;

    CREATE FUNCTION access_epoch_bump() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE access_epoch SET value = value + 1;
        RETURN NULL;
      END
      $$;

    CREATE TRIGGER object_access_epoch
      AFTER INSERT OR UPDATE OR DELETE ON object_access
      FOR EACH STATEMENT EXECUTE FUNCTION access_epoch_bump();

    CREATE TRIGGER user_group_member_epoch
      AFTER INSERT OR UPDATE OR DELETE ON user_group_member
      FOR EACH STATEMENT EXECUTE FUNCTION access_epoch_bump();

    CREATE TRIGGER user_group_epoch
      AFTER UPDATE OF is_admin OR DELETE ON user_group
      FOR EACH STATEMENT EXECUTE FUNCTION access_epoch_bump();

    -- UPDATE OF parent_id fires only for a statement that names the column in its SET list,
    -- which is a move and nothing else: a rename or a re-order never does.
    CREATE TRIGGER object_parent_epoch
      AFTER UPDATE OF parent_id ON object
      FOR EACH STATEMENT EXECUTE FUNCTION access_epoch_bump();
  `,

  down: `
    DROP TRIGGER IF EXISTS object_parent_epoch ON object;
    DROP TRIGGER IF EXISTS user_group_epoch ON user_group;
    DROP TRIGGER IF EXISTS user_group_member_epoch ON user_group_member;
    DROP TRIGGER IF EXISTS object_access_epoch ON object_access;
    DROP FUNCTION IF EXISTS access_epoch_bump();
    DROP TABLE IF EXISTS access_epoch;
  `,
};
