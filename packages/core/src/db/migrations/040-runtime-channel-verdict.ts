import type { Migration } from './types.js';

/**
 * The channel verdict, persisted, because it is state (`P-85`).
 *
 * `sensor_runtime` held every input the state machine reads except one: §2.2's answer, what the
 * *readings* were worth. The comment where it was rebuilt said leaving it out was deliberate —
 * "a limit breach remembered across a restart would be a verdict on a measurement nobody took" —
 * and that reasoning does not survive contact with what the table already stores. The row two
 * columns to the left says `state = 'down', cause = 'limit'`. The conclusion was always
 * persisted; only the premise was thrown away, so anything that re-ran the machine without a
 * reading reached a different conclusion from the same row.
 *
 * A limit breach carries `consecutive_failures = 0` — the check succeeded, the reading did not —
 * so rebuilding with no verdict says "last scan fine, nothing judged", and layer 5 answers Up.
 * `SensorStateService.reevaluate` then wrote that Up: a `down -> up : scan` row into the table
 * uptime and SLA are computed from, an alarm cleared, and — through `clearedByRecovery` — the
 * acknowledgement columns wiped. Acknowledging a sensor that was Down on a limit destroyed the
 * acknowledgement it had just written, three lines earlier, in the same transaction. The same
 * reset fired on a lifted simulated error and on every probe reconnect.
 *
 * **Nullable, and null is not a state to migrate into.** `NULL` means "nothing judged", which is
 * exactly right for every existing row: this build has never stored a verdict, so inventing one
 * from the current state would be reconstructing a measurement rather than remembering it. A row
 * that is Down on a limit today reads as Up on its first re-decide and then goes Down again on
 * its next reading — one wrong answer on the upgrade, against inventing history.
 *
 * Cleared, never carried, when a scan fails: layer 5 already discards the verdict on a failed
 * check, and a stored one would keep a stale breach alive across an outage and blame a threshold
 * for it.
 */
export const migration040: Migration = {
  id: 40,
  name: 'runtime-channel-verdict',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN channel_state sensor_state_kind,
      ADD COLUMN channel_cause sensor_state_cause,
      -- Both or neither. A state with no cause is not a verdict the machine can read, and the
      -- pair is written from one object in one place, so a half-filled row is a bug rather than
      -- a case to handle at every read site.
      ADD CONSTRAINT sensor_runtime_channel_verdict_ck
        CHECK ((channel_state IS NULL) = (channel_cause IS NULL));

    COMMENT ON COLUMN sensor_runtime.channel_state IS
      'What the last readings were worth (state-machine.md 2.2), or NULL when nothing was '
      'judged. Persisted so that re-deciding without a reading reaches the same answer as the '
      'reading did (P-85).';
  `,

  down: `
    ALTER TABLE sensor_runtime
      DROP CONSTRAINT IF EXISTS sensor_runtime_channel_verdict_ck,
      DROP COLUMN IF EXISTS channel_state,
      DROP COLUMN IF EXISTS channel_cause;
  `,
};
