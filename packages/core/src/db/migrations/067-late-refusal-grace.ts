import type { Migration } from './types.js';

/**
 * Which sensors a configuration stopped leaving to a probe, and when (`A-61`).
 *
 * For ten minutes after a configuration stops leaving a sensor to its probe, a refusal from that
 * probe for that sensor was made under the configuration before, and is dropped rather than read
 * as a failed scan (`A-53`). The core kept that record in memory, so one restarted inside the ten
 * minutes read a probe's honest late refusals as failed scans: two of them one Down and one
 * notification, for a change somebody made on purpose (`A-56`). One row per (probe, sensor) is
 * the record, with the time the first such configuration was built.
 *
 * **Written only by the core, when it builds a configuration that changes the record.** No
 * result a probe sends writes here. One thing a probe says does reach a configuration: the
 * protocol version it connects with, which decides whether a named device is left to it at all.
 * A probe that reconnects under a version that changes that causes one write, once per
 * reconnect, of no more rows than it has sensors. Read once at start, before the probe endpoint
 * accepts a result. A row goes when the sensor is left to the probe again, when its ten minutes
 * have run out, and with its sensor or its probe, which is what the two cascades are for.
 *
 * **`stopped_at` is this core's wall clock, not the database's**: it is compared at the next
 * start with the same clock, and the comparison is bounded there, so a time in the future or one
 * long past gives no more than the ten minutes (`CredentialVouching.restore`). It has to be a
 * moment: infinity is refused, since nothing can be counted from it.
 *
 * The rollback drops the table. What it loses is the record itself, which is what the build
 * before did not have: a core restarted inside the ten minutes reads a late refusal as a failed
 * scan again.
 */
export const migration067: Migration = {
  id: 67,
  name: 'late-refusal-grace',

  up: `
    CREATE TABLE late_refusal_grace (
      probe_id   bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      sensor_id  bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      stopped_at timestamptz NOT NULL CHECK (isfinite(stopped_at)),
      PRIMARY KEY (probe_id, sensor_id)
    );
    -- For the cascade from a deleted sensor, which the primary key does not lead with.
    CREATE INDEX late_refusal_grace_sensor_idx ON late_refusal_grace (sensor_id);

    COMMENT ON TABLE late_refusal_grace IS
      'The sensors a configuration stopped leaving to a probe, and when: a refusal for one inside the grace is late, not a failed scan (A-61).';
  `,

  down: `
    DROP TABLE late_refusal_grace;
  `,
};
