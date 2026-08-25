import type { Migration } from './types.js';

/**
 * Binding a probe object to the probe that connects (R-04).
 *
 * A `probe` object and a connected probe were, until now, unrelated things: the object is a
 * branch of the tree, the connection is a GID the core issued at the handshake, and nothing
 * joined them. "Each probe receives only its own subtree" cannot mean anything without that
 * join, so this is the storage half of it.
 *
 * **It is not R-01.** Approval queues, per-GID access keys, source-IP allowlists and revocation
 * are still that task's, and `TASKS.md` already records that enrolment will replace creating a
 * probe by `POST /objects` — a documented pre-1.0 API break. What is here is the column that
 * break will keep.
 */
export const migration007: Migration = {
  id: 7,
  name: 'probe-identity',

  up: `
    -- A side table rather than a column on object, matching device_config and sensor_config:
    -- the kind-specific fields live beside the row, and the trigger that invalidates an ETag
    -- already fires for these tables.
    CREATE TABLE probe_config (
      object_id  bigint PRIMARY KEY REFERENCES object(id) ON DELETE CASCADE,
      -- Nullable, and null means "no probe has claimed this branch yet". Not an empty string:
      -- an unclaimed probe object and one claimed by a probe with an empty identity would then
      -- be the same row, and the unique index below would allow only one of them to exist.
      gid text,
      last_seen_at timestamptz
    );

    -- One branch per probe, and one probe per branch. Without this a second probe could claim
    -- an already-claimed branch and the two would scan the same sensors, which is the
    -- duplicate-alarm failure CLAUDE.md's "one outage, one alarm" rule exists to prevent.
    -- Partial, so any number of objects may sit unclaimed.
    CREATE UNIQUE INDEX probe_config_gid_unique ON probe_config (gid) WHERE gid IS NOT NULL;

    -- Every existing probe object gets a row, so the join is always present and reads never
    -- have to distinguish "no row" from "no gid".
    INSERT INTO probe_config (object_id)
    SELECT id FROM object WHERE kind = 'probe';

    -- Same trigger the other side tables use, so claiming a probe invalidates its ETag.
    CREATE TRIGGER probe_config_touch_owner
      AFTER INSERT OR UPDATE OR DELETE ON probe_config
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();
  `,

  down: `
    DROP TRIGGER IF EXISTS probe_config_touch_owner ON probe_config;
    DROP INDEX IF EXISTS probe_config_gid_unique;
    DROP TABLE IF EXISTS probe_config;
  `,
};
