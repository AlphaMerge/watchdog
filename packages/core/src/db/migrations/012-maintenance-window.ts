import type { Migration } from './types.js';

/**
 * Maintenance windows (`M-10`).
 *
 * A maintenance window is a pause that has not started yet. `WORKFLOW.MD §8` calls it "the
 * one-off equivalent" of a schedule, and `M-08` wrote `object_pause` expecting it — its upsert
 * comment already says "replacing is extending a maintenance window". What was missing was a
 * *start*: every pause so far began the moment it was written.
 *
 * **One column, not a second table.** A window and a manual pause are the same fact with
 * different times attached: both are set on one object, both cascade to everything beneath it,
 * both are lifted by the same resume, and both cost the same recompute. A separate table would
 * duplicate the cascade, the expiry, the refusal rules and the audit actions, and would put a
 * fifth source into a model that `WORKFLOW.MD §5` says has four.
 *
 * `paused_at` keeps its meaning — when the row was written, which is who-did-what-when — and
 * `starts_at` is when it takes effect. For a pause with no window they are the same instant.
 */
export const migration012: Migration = {
  id: 12,
  name: 'maintenance-window',

  up: `
    ALTER TABLE object_pause
      ADD COLUMN starts_at timestamptz NOT NULL DEFAULT now();

    -- Existing rows are pauses that began when they were written, which is what the default
    -- would have given them anyway; setting it explicitly means the column never depends on
    -- when the migration happened to run.
    UPDATE object_pause SET starts_at = paused_at;

    -- The old constraint compared the deadline to when the row was written, which for a window
    -- scheduled a week ahead is the wrong end. What must hold is that the window has some
    -- length: an end at or before its start is not a maintenance window, it is a typo.
    ALTER TABLE object_pause DROP CONSTRAINT object_pause_not_already_over;
    ALTER TABLE object_pause ADD CONSTRAINT object_pause_has_length CHECK (
      paused_until IS NULL OR paused_until > starts_at
    );

    -- What the sweep reads to find a window that has just opened. Partial on the same principle
    -- as the deadline index: a pause that starts when it is written crosses no boundary the
    -- sweep has to notice, so it does not belong in the index.
    CREATE INDEX object_pause_starts_idx ON object_pause (starts_at)
      WHERE starts_at > paused_at;
  `,

  down: `
    DROP INDEX IF EXISTS object_pause_starts_idx;
    -- A window that has not started yet becomes a pause that is already in force. There is no
    -- honest alternative going backwards: the column that said "not yet" is the one being
    -- dropped, and leaving the rows would silently pause everything they name.
    DELETE FROM object_pause WHERE starts_at > now();
    ALTER TABLE object_pause DROP CONSTRAINT object_pause_has_length;
    ALTER TABLE object_pause ADD CONSTRAINT object_pause_not_already_over CHECK (
      paused_until IS NULL OR paused_until > paused_at
    );
    ALTER TABLE object_pause DROP COLUMN starts_at;
  `,
};
