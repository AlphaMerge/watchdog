import type { Migration } from './types.js';

/**
 * The identification stage of a discovery run (D-02).
 *
 * **A stage on the same run, not a second run.** An operator starts one discovery and watches one
 * thing finish; "sweep 10.0.0.0/24" and "identify what it found" are two halves of that, and
 * making them two rows would mean two progress bars, two cancels and a question about what
 * happens when somebody cancels only one of them.
 *
 * `status` gains `identifying`, which sits between `running` and `done`. The order matters to the
 * dispatcher: a run in either of the first two states is one the probe should be working on, and
 * the partial index below is what that question is asked through.
 *
 * `level` is the seam D-06 grows into. Two values today — sweep only, or sweep and identify — and
 * it is a column rather than a boolean because D-06 adds more of them, and a boolean that becomes
 * an enum is a migration plus every caller that read it as true or false.
 */
export const migration026: Migration = {
  id: 26,
  name: 'discovery-identify',

  up: `
    ALTER TABLE discovery_run
      DROP CONSTRAINT IF EXISTS discovery_run_status_check;
    ALTER TABLE discovery_run
      ADD CONSTRAINT discovery_run_status_check
        CHECK (status IN ('queued', 'running', 'identifying', 'done', 'cancelled', 'failed'));

    ALTER TABLE discovery_run
      ADD COLUMN level text NOT NULL DEFAULT 'identify'
        CHECK (level IN ('ping', 'identify')),
      -- How many of the found hosts have a fingerprint. Separate from "found" so a half-finished
      -- identification is visible as what it is rather than as a stalled sweep.
      ADD COLUMN identified integer NOT NULL DEFAULT 0 CHECK (identified >= 0),
      -- Where identification has got to, in the same units the sweep's cursor uses: how many
      -- hosts have been offered. Its own column because the two stages resume independently and
      -- one cursor would make a resumed identification restart the sweep.
      ADD COLUMN identify_cursor integer NOT NULL DEFAULT 0 CHECK (identify_cursor >= 0),
      -- The SNMP community identification tries, if any. Not a credential set: it is per run
      -- rather than per device, it is chosen before any device exists to attach it to, and a
      -- v2c community travels unencrypted in every packet it is used in.
      ADD COLUMN snmp_community text NOT NULL DEFAULT '';

    DROP INDEX IF EXISTS discovery_run_pending_idx;
    CREATE INDEX discovery_run_pending_idx
      ON discovery_run (probe_id, id)
      WHERE status IN ('queued', 'running', 'identifying');
  `,

  down: `
    DROP INDEX IF EXISTS discovery_run_pending_idx;
    -- Anything mid-identification becomes a finished sweep on the way back: the column that says
    -- how far it got is about to disappear, and a run claiming to be identifying with nothing to
    -- record it would be a row the older code cannot make progress on.
    UPDATE discovery_run SET status = 'done' WHERE status = 'identifying';
    ALTER TABLE discovery_run
      DROP COLUMN level,
      DROP COLUMN identified,
      DROP COLUMN identify_cursor,
      DROP COLUMN snmp_community;
    ALTER TABLE discovery_run
      DROP CONSTRAINT IF EXISTS discovery_run_status_check;
    ALTER TABLE discovery_run
      ADD CONSTRAINT discovery_run_status_check
        CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'failed'));
    CREATE INDEX discovery_run_pending_idx
      ON discovery_run (probe_id, id)
      WHERE status IN ('queued', 'running');
  `,
};
