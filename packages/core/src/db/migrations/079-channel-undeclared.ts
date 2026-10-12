import type { Migration } from './types.js';

/**
 * Which channels were created without their declared shape (`P-312`).
 *
 * Ingestion creates a channel from its sensor's type's declaration for the sensor's stored
 * parameters (`P-297`). When the type cannot answer for them, or this build does not register
 * the type at all, the row gets the type's answer to `{}` or nothing: no lookup, no counter width,
 * and nothing wrote it again. `P-306` counted those; this marks them, so a later build whose type
 * can answer — the fix that usually follows — repairs them at its first start.
 *
 * The mark means "this row holds what a fallback wrote and nobody has decided otherwise": the
 * start-up repair clears it once the type answers, and an operator pointing the channel at a
 * lookup clears it too, since that decision is theirs and the repair must not undo it. A partial
 * index, so the repair's read is free when nothing is marked, which is nearly always.
 *
 * Rows from before this are not marked: which of them a fallback wrote is not recorded anywhere.
 * The rollback drops the index and the column, and with them every mark.
 */
export const migration079: Migration = {
  id: 79,
  name: 'channel-undeclared',

  up: `
    ALTER TABLE channel ADD COLUMN undeclared boolean NOT NULL DEFAULT false;

    CREATE INDEX channel_undeclared_idx ON channel (sensor_id) WHERE undeclared;

    COMMENT ON COLUMN channel.undeclared IS
      'Created without its declared shape, and not since repaired or decided by an operator (P-312).';
  `,

  down: `
    DROP INDEX channel_undeclared_idx;
    ALTER TABLE channel DROP COLUMN undeclared;
  `,
};
