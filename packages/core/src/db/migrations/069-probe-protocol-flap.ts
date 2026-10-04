import type { Migration } from './types.js';

/**
 * What each probe's protocol version has done lately (`A-72`).
 *
 * The version a probe connects with decides whether it is left its named sensors (`A-41c`), so a
 * probe that alternates its version withheld them and let them go each time: an Unknown page and
 * a recovery per sensor per change. A second change within an hour of the one before is now a
 * flap, and while it lasts the probe's configurations are judged at the lowest version it has
 * spoken since, so those sensors hold where they stood. The core keeps that per probe; this is it,
 * stored, so a core restarted in the middle of a flap still holds, and still knows the version the
 * probe spoke before it stopped, which is what makes the probe's next version a change.
 *
 * One row a probe:
 *
 * - `version`: what its last configuration was built for.
 * - `changed_at`: when that version began, while it counts as a change (the run below has one).
 * - `run_since`, `run_changes`: when the run of changes it ends began, and how many it has had,
 *   each within the hour of the one before.
 * - `flap_floor`: from the run's second change, the lowest version spoken since the version before
 *   it, which is what the configurations are judged at until the version has held an hour.
 *
 * **Written only by the core, when it builds a configuration**: the first for a probe, and each
 * one under another version than the last. A steady build writes nothing. No result writes here.
 * What a probe can make the core write by what it says is its own row, once per reconnect under
 * another version, in the transaction `late_refusal_grace` is written in and under its bounds. A
 * row whose run is an hour old is not rewritten: its time says that at the next start.
 *
 * **Times are this core's wall clock**, compared at the next start with the same clock and
 * bounded there (`restoredVersion`): a time an hour or more ago is no run at all, and one later
 * than now gives the hold from that start and no more. Infinity is refused.
 *
 * The rollback drops the table. What it loses is the record, which the build before did not have:
 * that build lets a flapping probe's named sensors go and withholds them again at each change.
 */
export const migration069: Migration = {
  id: 69,
  name: 'probe-protocol-flap',

  up: `
    CREATE TABLE probe_protocol_flap (
      probe_id    bigint PRIMARY KEY REFERENCES object (id) ON DELETE CASCADE,
      version     integer NOT NULL CHECK (version > 0),
      changed_at  timestamptz CHECK (isfinite(changed_at)),
      run_since   timestamptz CHECK (isfinite(run_since)),
      run_changes integer NOT NULL DEFAULT 0 CHECK (run_changes >= 0),
      flap_floor  integer CHECK (flap_floor > 0),
      -- A run has a time it began and one it last changed, or neither, and at least one change.
      CONSTRAINT probe_protocol_flap_run CHECK (
        (changed_at IS NULL) = (run_since IS NULL)
        AND (changed_at IS NULL) = (run_changes = 0)
        AND (run_since IS NULL OR run_since <= changed_at)
      ),
      -- A floor from a run's second change, and never above the version spoken.
      CONSTRAINT probe_protocol_flap_floor CHECK (
        (flap_floor IS NULL) = (run_changes < 2)
        AND (flap_floor IS NULL OR flap_floor <= version)
      )
    );

    COMMENT ON TABLE probe_protocol_flap IS
      'Per probe: the protocol version its last configuration was built for, and the run of changes that ended in it; from a run''s second change within an hour, the version its configurations are judged at until the version has held an hour (A-72).';
  `,

  down: `
    DROP TABLE probe_protocol_flap;
  `,
};
