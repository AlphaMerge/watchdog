import type { Migration } from './types.js';

/**
 * When a probe's recorded protocol version was refused (`U-35`).
 *
 * A hello refused over its version (`R-06`) records that version and clears
 * `protocol_accepted_at` (`U-32`). That left a refusal at 0 reading exactly as the `R-01`
 * upgrade's "nothing recorded": a stored 0 with no time. `GET /probes` called its skew `unknown`,
 * the probe's health answer served no version at all, and the add-sensor form said "This updates
 * when it connects" about a probe that will be refused every time it tries. This is the time
 * beside `protocol_version` that says the version was refused, written by `ProbeRegistry.#speaks`
 * in the statement that writes the version:
 *
 * - **a hello refused over the version** writes the version and this time, and clears the
 *   accepted time;
 * - **an accepted handshake** writes the version and the accepted time, and clears this one;
 * - **every other refusal** writes none of the three.
 *
 * So the version is accepted at a time, refused at a time, or neither, which is a row recorded
 * before the core kept the times, or the upgrade's 0. Never both: the check says so. The time is
 * the last refusal's, not the first: a probe that retries is refused at each hello, and the
 * newest one is what says it is still trying.
 *
 * **NULL for every existing row.** A stored 0 with no accepted time and a `last_seen_at` is
 * either an upgrade's row touched by a hello refused for its key, its address or a revocation,
 * or a refusal at 0, and nothing in the row tells which. A version above 0 has never been
 * refused, because the floor has been 1 throughout. The next refused hello writes it.
 *
 * **The core's wall clock** (the registry's `now`), as `protocol_accepted_at` is. Infinity is
 * refused.
 *
 * The rollback drops the column. What it loses is the refusal's time, which the build before did
 * not have: that build reads a refusal at 0 as nothing recorded, as it did.
 */
export const migration074: Migration = {
  id: 74,
  name: 'probe-protocol-refused-at',

  up: `
    ALTER TABLE probe_registration
      ADD COLUMN protocol_refused_at timestamptz
        CONSTRAINT probe_registration_protocol_refused_at_check
          CHECK (
            protocol_refused_at IS NULL
            OR (isfinite(protocol_refused_at) AND protocol_accepted_at IS NULL)
          );

    COMMENT ON COLUMN probe_registration.protocol_refused_at IS
      'When a hello was last refused over protocol_version; NULL when the recorded version was accepted (protocol_accepted_at) or was recorded before this column (U-35).';
  `,

  down: `
    ALTER TABLE probe_registration DROP COLUMN protocol_refused_at;
  `,
};
