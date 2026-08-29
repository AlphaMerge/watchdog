import type { Migration } from './types.js';

/**
 * Who set a channel's limits (`S-18`).
 *
 * **The column exists because `{}` had two meanings and the difference matters.** A channel
 * starts with `limits = '{}'` and an operator who deliberately clears a threshold writes `'{}'`
 * back — so "never configured" and "configured to nothing" were the same value. Sensor types can
 * now declare default thresholds, and applying them needs exactly that distinction: a default
 * that reappeared after somebody removed it on purpose is worse than no default at all.
 *
 * Three values, and the middle one is the whole point. `unset` is a channel nothing has ever
 * decided about, and it is the only state a declared default may be written into. `declared` is a
 * default this build put there, which a later build may replace when the declaration changes.
 * `operator` is a person's decision, and nothing overwrites it — including a person setting the
 * limits back to empty.
 *
 * **Existing rows are read before they are labelled.** A row already carrying limits was set by
 * somebody — there has been no other way to fill that column — so it becomes `operator` rather
 * than being left eligible for a default that would silently replace a threshold an operator
 * chose. Everything still empty becomes `unset` and picks up whatever its type declares.
 */
export const migration038: Migration = {
  id: 38,
  name: 'channel-limit-source',

  up: `
    ALTER TABLE channel
      ADD COLUMN limits_source text NOT NULL DEFAULT 'unset'
        CHECK (limits_source IN ('unset', 'declared', 'operator'));

    -- Before this migration the only way into that column was an operator setting a limit, so a
    -- non-empty one is a decision somebody made. Marking it protects it from the backfill that
    -- runs on the next start.
    UPDATE channel SET limits_source = 'operator' WHERE limits <> '{}'::jsonb;

    COMMENT ON COLUMN channel.limits_source IS
      'Who decided this channel''s limits: unset (nobody yet), declared (a default from the '
      'sensor type), operator (a person). A declared default is only ever written over unset or '
      'declared, never over operator (S-18).';
  `,

  down: `
    ALTER TABLE channel DROP COLUMN IF EXISTS limits_source;
  `,
};
