import type { Migration } from './types.js';

/**
 * Which lookup judges a channel (`M-06`).
 *
 * A column rather than a key inside the `limits` jsonb, because it is not a limit — it is the
 * *other* way a channel's state is decided, and a channel uses one or the other. Keeping them
 * apart is what lets a read say which, and what stops a future limits patch from clearing a
 * lookup by accident.
 *
 * No foreign key, and there is nothing to point at: lookups are files and modules, not rows.
 * A channel naming a lookup that is not loaded is an ordinary, recoverable situation — an
 * operator moved a file, or a sensor type shipped ahead of its lookup — and it is reported
 * rather than prevented. Reported matters: without a lookup the channel is judged by nothing,
 * and a sensor that reads Up for that reason is worse than one that reads Unknown.
 */
export const migration009: Migration = {
  id: 9,
  name: 'channel-lookup',

  up: `
    -- NULL means "no lookup", which is every channel judged by limits or by nothing at all.
    ALTER TABLE channel ADD COLUMN lookup_id text
      CHECK (lookup_id IS NULL OR length(lookup_id) BETWEEN 1 AND 100);

    -- The alarms and settings views ask "which channels use this lookup" when one is edited or
    -- goes missing. Partial, because in a typical installation almost no channel has one.
    CREATE INDEX channel_lookup_idx ON channel (lookup_id) WHERE lookup_id IS NOT NULL;
  `,

  down: `
    DROP INDEX IF EXISTS channel_lookup_idx;
    ALTER TABLE channel DROP COLUMN IF EXISTS lookup_id;
  `,
};
