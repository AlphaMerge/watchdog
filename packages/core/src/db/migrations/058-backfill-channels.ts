import type { Migration } from './types.js';

/**
 * Which channels a backfill is for, and what happens to one that keeps failing (`P-226`).
 *
 * **The channels.** A backfill used to be a window and nothing else, so re-rolling it recomputed
 * every channel in the window. That was safe only while the source still held every channel's
 * readings for it. A probe replaying twenty days of spool into a core that keeps seven days of raw
 * data wrote its own readings into days whose raw chunks had already been dropped, and the re-roll
 * then rebuilt those days' five-minute buckets from the one channel that was there: every other
 * channel's history for those days went. Recording the channels whose readings actually arrived
 * late confines the re-roll to them. NULL is an entry that does not know, which is every entry
 * queued before this migration: the housekeeper treats it as every channel, as it always did.
 *
 * **The failures.** An entry whose re-roll failed stayed at the head of the queue and failed again
 * every five minutes, and because retention will not drop anything a pending backfill still has
 * to read, it also stopped retention for good. After three failures an entry is parked: it keeps
 * its place in the table, stops holding retention back, and is tried again after an hour and then
 * daily. Core Health counts the parked entries, and `last_error` is what it tells the operator.
 *
 * **The rollback** drops the columns. A parked entry then becomes an ordinary one again, and an
 * entry that named its channels re-rolls all of them, which is how the previous build handled
 * every entry.
 */
export const migration058: Migration = {
  id: 58,
  name: 'backfill-channels',

  up: `
    ALTER TABLE rollup_backfill
      ADD COLUMN channel_ids integer[],
      ADD COLUMN attempts    integer     NOT NULL DEFAULT 0,
      ADD COLUMN last_error  text,
      ADD COLUMN failed_at   timestamptz,
      ADD COLUMN retry_at    timestamptz,
      -- An empty list would be an entry for nothing. NULL is the one that means every channel.
      ADD CONSTRAINT rollup_backfill_channels
        CHECK (channel_ids IS NULL OR cardinality(channel_ids) > 0),
      ADD CONSTRAINT rollup_backfill_attempts CHECK (attempts >= 0),
      -- One line for Core Health, never a stack or a statement.
      ADD CONSTRAINT rollup_backfill_last_error CHECK (length(last_error) <= 500),
      -- A failure is counted, said and dated together, or not at all.
      ADD CONSTRAINT rollup_backfill_failure CHECK (
        (attempts = 0) = (last_error IS NULL) AND (last_error IS NULL) = (failed_at IS NULL)
      ),
      -- Parked means failed: an entry cannot wait for a retry without saying what went wrong.
      ADD CONSTRAINT rollup_backfill_parked CHECK (retry_at IS NULL OR last_error IS NOT NULL);

    COMMENT ON COLUMN rollup_backfill.channel_ids IS
      'The channels whose readings arrived late (P-226). NULL re-rolls every channel.';
    COMMENT ON COLUMN rollup_backfill.retry_at IS
      'Set when the entry is parked after repeated failures; it is claimed again from then on.';
  `,

  down: `
    ALTER TABLE rollup_backfill
      DROP CONSTRAINT IF EXISTS rollup_backfill_parked,
      DROP CONSTRAINT IF EXISTS rollup_backfill_failure,
      DROP CONSTRAINT IF EXISTS rollup_backfill_last_error,
      DROP CONSTRAINT IF EXISTS rollup_backfill_attempts,
      DROP CONSTRAINT IF EXISTS rollup_backfill_channels,
      DROP COLUMN IF EXISTS retry_at,
      DROP COLUMN IF EXISTS failed_at,
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS channel_ids;
  `,
};
