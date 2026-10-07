import type { Migration } from './types.js';

/**
 * When the protocol version a probe's row records was spoken on a handshake that was accepted
 * (`U-32`).
 *
 * The add-sensor form tells a reader that a probe which is down was too old for a listener when
 * it last connected (`U-31`), and could not say when. `last_seen_at` is no answer: `#touch` writes
 * it on every hello, before the decision, so a refused one moves it too. This is the time beside
 * `protocol_version`, written in the same statement as it and only by `ProbeRegistry.#speaks` and
 * `#enrol`:
 *
 * - **an accepted handshake** (welcomed approved or pending) writes the version and this time;
 * - **a hello refused over the version itself** (`R-06`) still writes the version, so the queue
 *   shows what the probe runs, and clears this time, because no accepted handshake spoke that
 *   version. A time kept from an earlier one would put a date that is not its own beside it;
 * - **every other refusal** writes neither.
 *
 * So the pair always reads as one fact: this version, accepted at this time, or this version and
 * no time to say. A version with a time is never 0, the `R-01` upgrade's "nothing recorded".
 *
 * **NULL for every existing row.** Nothing recorded when their version was accepted, and
 * `last_seen_at` is the one guess that is known to be wrong. A probe's next accepted handshake
 * writes it.
 *
 * **The core's wall clock** (the registry's `now`), as `first_seen_at` is for a new row, and the
 * same clock that dates the health answer the form reads it beside. Infinity is refused.
 *
 * The rollback drops the column. What it loses is the time, which the build before did not have:
 * that build's form says "when it last connected" without a date.
 */
export const migration072: Migration = {
  id: 72,
  name: 'probe-protocol-accepted-at',

  up: `
    ALTER TABLE probe_registration
      ADD COLUMN protocol_accepted_at timestamptz
        CONSTRAINT probe_registration_protocol_accepted_at_check
          CHECK (
            protocol_accepted_at IS NULL
            OR (isfinite(protocol_accepted_at) AND protocol_version > 0)
          );

    COMMENT ON COLUMN probe_registration.protocol_accepted_at IS
      'When protocol_version was spoken on a handshake this core accepted; NULL when the recorded version was never accepted (a refusal over the version) or was recorded before this column (U-32).';
  `,

  down: `
    ALTER TABLE probe_registration DROP COLUMN protocol_accepted_at;
  `,
};
