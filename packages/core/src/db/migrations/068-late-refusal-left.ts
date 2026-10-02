import type { Migration } from './types.js';

/**
 * What each probe was last left, beside which sensors a configuration stopped leaving it (`A-68`).
 *
 * `late_refusal_grace` (067) held one row for each sensor a configuration had stopped leaving to
 * a probe, for the ten minutes a refusal for it is late. Two things it could not say, and both
 * are a row of the same pair:
 *
 * - **What the probe is left now.** A stop is found by comparing a configuration with what the
 *   one before left the probe, and that was only in memory: a core that stopped between a change
 *   and the next configuration built for the probe started with nothing to compare with, and
 *   recorded no stop. `left_version` is set on the row of a sensor the probe's last configuration
 *   left to it, to the protocol version that configuration was built for, and NULL on any other.
 *   The version is kept because it is the one thing a probe says that decides what it is left,
 *   and the core has to tell a stop that only the version caused from one somebody configured.
 * - **When the sensor's last window began, after it is left again.** A probe that alternates its
 *   version would otherwise begin the ten minutes again each time. `stopped_at` now stays on the
 *   row, for the ten minutes and a cool-off after them, whether or not the sensor has been left
 *   to the probe again meanwhile, and is NULL for a sensor that is left and has no such window.
 *
 * So a row says at least one of the two, which is the check. Everything 067 said of the table
 * stands: written only by the core when it builds a configuration, read once at start, both ids
 * cascading, and `stopped_at` a moment on this core's wall clock.
 *
 * **The rollback gives 067's build exactly what it would have written itself**: the rows of
 * sensors that are not left, with their time. A row of a sensor that is left is removed, its
 * time with it, because 067's build reads every row as a sensor the probe is no longer left.
 */
export const migration068: Migration = {
  id: 68,
  name: 'late-refusal-left',

  up: `
    ALTER TABLE late_refusal_grace
      ALTER COLUMN stopped_at DROP NOT NULL,
      ADD COLUMN left_version integer CHECK (left_version > 0),
      ADD CONSTRAINT late_refusal_grace_says_something
        CHECK (stopped_at IS NOT NULL OR left_version IS NOT NULL);

    COMMENT ON TABLE late_refusal_grace IS
      'Per probe and sensor: whether the probe''s last configuration left it the sensor (left_version), and when the sensor''s last late-refusal window began (stopped_at) (A-61, A-68).';
  `,

  down: `
    DELETE FROM late_refusal_grace WHERE left_version IS NOT NULL OR stopped_at IS NULL;
    ALTER TABLE late_refusal_grace
      DROP CONSTRAINT late_refusal_grace_says_something,
      DROP COLUMN left_version,
      ALTER COLUMN stopped_at SET NOT NULL;

    COMMENT ON TABLE late_refusal_grace IS
      'The sensors a configuration stopped leaving to a probe, and when: a refusal for one inside the grace is late, not a failed scan (A-61).';
  `,
};
