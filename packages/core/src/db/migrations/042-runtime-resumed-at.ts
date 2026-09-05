import type { Migration } from './types.js';

/**
 * The resume watermark, so a resume stops erasing the idempotence guard (`P-97`).
 *
 * `last_result_at` was doing two jobs. It is the high-water mark that makes the at-least-once
 * probe protocol safe — `isStaleResult` discards anything no newer, and `writeRuntimes` refuses
 * it a second time — and it was *also* how "nothing has been measured since the resume" was
 * reconstructed, by being set to NULL. §3 requires the second; the first is what pays for the
 * spool's guarantee that "a dropped connection costs a duplicate write rather than a lost
 * reading". One column could not do both, and the way it failed was to stop doing the first.
 *
 * After any resume, duplicates stopped being duplicates. A batch the core had already stored but
 * never acknowledged — the probe keeps it spooled until it hears back — was re-offered and
 * applied in full: `sensor_state` rows timestamped *before* the resume row, the two-step failure
 * policy advanced a second time, `sensor_runtime` saying Down since 09:59 while the newest
 * history row says Unknown at 10:05, and the alarms view raising an outage inside a window the
 * operator had paused and already ended.
 *
 * The same NULL admitted results measured *during* the pause. A probe that lost its link keeps
 * scanning and spooling — it cannot be told about a pause it never received — so its spool holds
 * readings from inside the window. `docs/state-machine.md` §3 assumes this away ("a paused sensor
 * is not in its probe's configuration at all"), which is only true of a probe currently connected
 * to receive that configuration. Those readings wrote Up and Down transitions into a planned
 * maintenance window, which uptime and SLA are then computed from.
 *
 * So: `last_result_at` keeps its one job and is never nulled, and `resumed_at` carries the other.
 * A sensor reads as never-scanned while `resumed_at` is at or after `last_result_at`, and a
 * result is stale unless it is newer than **both**. Existing rows get NULL, which is exactly
 * right: nothing has been resumed since this column existed.
 */
export const migration042: Migration = {
  id: 42,
  name: 'runtime-resumed-at',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN resumed_at timestamptz;

    COMMENT ON COLUMN sensor_runtime.resumed_at IS
      'When this sensor last came back from a pause. A result at or before it is discarded as '
      'stale, and the sensor reads as never-scanned while this is at or after last_result_at. '
      'Separate from last_result_at so that a resume cannot disable the idempotence guard the '
      'at-least-once probe protocol depends on (P-97).';
  `,

  down: `
    ALTER TABLE sensor_runtime DROP COLUMN IF EXISTS resumed_at;
  `,
};
