import type { Migration } from './types.js';

/**
 * Who acknowledged an alarm (`M-13`).
 *
 * `M-02` left the two columns that decide the *state* — `acknowledged_at` and
 * `acknowledged_until` — and the §2.4 layer that reads them. What it could not leave was the
 * question an operator asks second: the first is "why is this still down", which the
 * acknowledgement message answers, and the second is "who said it was being dealt with".
 *
 * **Two columns, and not on the hot path.** `sensor_runtime` is read on every ingestion batch,
 * so these are deliberately absent from `loadRuntimes` — only the single-sensor read serves
 * them. The audit log records the same fact in more detail; this is here for the same reason
 * `object_pause` carries an actor, which is that an operator should not have to search the
 * audit log to find out who silenced an alarm.
 */
export const migration014: Migration = {
  id: 14,
  name: 'acknowledgement',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN acknowledged_by_kind  text,
      ADD COLUMN acknowledged_by_label text;

    COMMENT ON COLUMN sensor_runtime.acknowledged_by_kind IS
      'Actor kind, flattened exactly as object_pause records it (M-13). NULL when there is no '
      'acknowledgement, and cleared with the acknowledgement itself.';
  `,

  down: `
    ALTER TABLE sensor_runtime
      DROP COLUMN acknowledged_by_label,
      DROP COLUMN acknowledged_by_kind;
  `,
};
