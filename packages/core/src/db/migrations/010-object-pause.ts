import type { Migration } from './types.js';

/**
 * Manual pause, on any object (`M-08`).
 *
 * `sensor_runtime` already holds the four pause *flags* — `M-02` added them, and the state
 * machine has evaluated them since. What it never had was anything that sets them. This is the
 * half an operator touches: a row here says "somebody paused this object, until this moment,
 * for this reason", and the flags on every sensor beneath it are derived from these rows.
 *
 * **On any object, not just a sensor.** Nobody pauses a sensor during maintenance; they pause
 * the device, or the group, or the whole probe. A device has no state of its own — its sensors
 * do — so pausing one means setting `paused_by_parent` on every sensor beneath it, and this
 * table is what remembers *why*, so a resume knows what to undo and a sensor created later
 * inherits the pause it was born into.
 *
 * Two facts and not one: `object_pause` says what an operator asked for, `sensor_runtime` says
 * what that works out to per sensor. Deriving the second on every read would be a chain walk per
 * sensor per scan; deriving it on every write is a chain walk per pause.
 */
export const migration010: Migration = {
  id: 10,
  name: 'object-pause',

  up: `
    CREATE TABLE object_pause (
      -- One pause per object. Pausing an already-paused object replaces the reason and the
      -- deadline rather than stacking, which is what an operator extending a maintenance window
      -- means and the only behaviour a single "resume" button can undo.
      object_id    bigint PRIMARY KEY REFERENCES object (id) ON DELETE CASCADE,
      paused_at    timestamptz NOT NULL DEFAULT now(),
      -- NULL is indefinite: paused until a person says otherwise. Not a far-future sentinel,
      -- which would make "indefinite" and "until the year 9999" the same row.
      paused_until timestamptz,
      message      text NOT NULL DEFAULT '' CHECK (length(message) <= 500),

      -- Who, flat, exactly as audit_log records it. "Why is this paused" is answered by the
      -- message; "who do I ask about it" is answered by these, and an operator should not have
      -- to search the audit log to find out who switched something off.
      actor_kind   text NOT NULL CHECK (length(actor_kind) BETWEEN 1 AND 40),
      actor_ref    text,
      actor_label  text,

      CONSTRAINT object_pause_not_already_over CHECK (
        paused_until IS NULL OR paused_until > paused_at
      )
    );

    -- What the expiry sweep reads: the pauses that have a deadline at all, which in a typical
    -- installation is a handful. Partial, so an indefinite pause costs the index nothing.
    CREATE INDEX object_pause_until_idx ON object_pause (paused_until)
      WHERE paused_until IS NOT NULL;

    -- The same trigger the other side tables use. Pausing *is* a configuration change: it
    -- changes what a probe should be scanning, and R-04's push is driven from these versions.
    CREATE TRIGGER object_pause_touch_owner
      AFTER INSERT OR UPDATE OR DELETE ON object_pause
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();
  `,

  down: `
    DROP TRIGGER IF EXISTS object_pause_touch_owner ON object_pause;
    DROP INDEX IF EXISTS object_pause_until_idx;
    DROP TABLE IF EXISTS object_pause;
  `,
};
