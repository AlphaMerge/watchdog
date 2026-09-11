import type { Migration } from './types.js';

/**
 * When a report ran, and what happened (`E-08`, `CAPABILITIES.MD §6`).
 *
 * **A run is a row, not a log line.** `§6` schedules reports hourly to annually, and the thing an
 * operator asks at 09:00 is "did last night's run happen, and was it any good" — a question a
 * table answers and `grep` does not. It is also the only way `E-09` can know what to deliver and
 * `E-10` what to expire.
 *
 * ## What is deliberately *not* here
 *
 * The rendered document. `E-08` is when a report runs; `E-09` is what happens to the output, and
 * `ADR-005` has not yet decided whether that is a `bytea` column, a file, or neither. Storing it
 * here to "save it for later" would be deciding that question by accident, in a migration, which
 * is exactly how `ADR-003` says the map background got its 2 MiB bound. So a run records that it
 * rendered and how big the result was, and the bytes are discarded until there is somewhere
 * agreed to put them.
 *
 * **That is not a wasted render.** A scheduled run that finds a deleted security context, a span
 * that resolves to nothing, or a document over the cell limit records the failure at 03:00 — which
 * is the whole point of scheduling something, and is the half of `E-09` that does not depend on
 * the ADR.
 *
 * ## One run at a time, enforced by the database
 *
 * `report_run_active_idx` is a partial unique index over the unfinished states, so a second run of
 * the same report cannot start while one is in flight. In code this would be a check-then-insert
 * with a window between them; here it is a constraint. A report over five hundred sensors takes
 * minutes, and a "run now" button pressed six times must not produce six renders competing for the
 * same pool — `CLAUDE.md`'s rule that nothing blocks the scheduler applies to the database too.
 */
export const migration048: Migration = {
  id: 48,
  name: 'report-runs',

  up: `
    -- **No 'queued'.** A render starts the moment its slot is claimed, so a queued row is a state
    -- nothing in this system can produce — and a state the API schema would promise and never
    -- answer. E-09 may add one when delivery is the thing that waits; it can bring its own
    -- migration and mean it.
    CREATE TYPE report_run_state AS ENUM ('running', 'succeeded', 'failed');

    -- Manual is somebody pressing a button; scheduled is the sweep. Kept apart because they are
    -- asked about separately: "did the schedule fire" is a different question from "did Anna's
    -- run work", and a boolean called is_manual would have made both harder to read.
    CREATE TYPE report_run_trigger AS ENUM ('manual', 'scheduled');

    CREATE TABLE report_run (
      id           bigserial PRIMARY KEY,
      report_id    bigint NOT NULL REFERENCES report(id) ON DELETE CASCADE,

      trigger      report_run_trigger NOT NULL,
      -- The login that asked, or '' for the scheduler. Not a foreign key, for the reason
      -- object_access.granted_by is not: the record of who must outlive the account.
      requested_by text NOT NULL DEFAULT '' CHECK (length(requested_by) <= 64),

      state        report_run_state NOT NULL DEFAULT 'running',

      queued_at    timestamptz NOT NULL DEFAULT now(),
      -- Set with the insert, not left for an update that might not come: a run whose duration is
      -- null because nothing ever stamped its start is a history that cannot answer "is this
      -- report getting slower", which is the question a growing installation asks.
      started_at   timestamptz NOT NULL DEFAULT now(),
      finished_at  timestamptz,
      duration_ms  integer,

      -- **The period it covered, as the report itself labelled it.** A run row that says only
      -- "succeeded at 03:00 on the 1st" cannot answer "do we have August", which is the question.
      -- Resolved at run time because "last month" is a different month every month (E-02).
      span_label   text NOT NULL DEFAULT '',

      -- What it produced, which is what makes progress visible rather than a spinner. Null until
      -- it finishes; zero is a real answer and means a report that rendered nothing.
      sections     integer,
      unavailable  integer,
      cells        integer,

      -- Why it failed, in the same code the API answers with, so an operator reading this row and
      -- an operator reading a 422 are told the same thing.
      error_code   text NOT NULL DEFAULT '' CHECK (length(error_code) <= 64),
      error_message text NOT NULL DEFAULT '' CHECK (length(error_message) <= 1000)
    );

    -- The history view: newest first, per report.
    CREATE INDEX report_run_report_idx ON report_run (report_id, queued_at DESC);

    -- **One unfinished run per report.** See the block comment: a constraint rather than a
    -- check-then-insert, because the window between those two is exactly a double-click.
    CREATE UNIQUE INDEX report_run_active_idx ON report_run (report_id)
      WHERE state = 'running';

    ALTER TABLE report
      -- Null means "not on a schedule" — a manual report, or one whose window is never open.
      -- Both are configurations an operator can make and neither is a failure.
      ADD COLUMN next_run_at timestamptz,
      ADD COLUMN last_run_at timestamptz,
      ADD COLUMN last_run_id bigint REFERENCES report_run(id) ON DELETE SET NULL;

    -- The sweep's query, and the reason it is cheap on an installation with no schedules at all:
    -- a partial index over the rows that can possibly be due.
    CREATE INDEX report_due_idx ON report (next_run_at) WHERE next_run_at IS NOT NULL;

    COMMENT ON COLUMN report.next_run_at IS
      'When the scheduler will next run this (E-08). Null is not an error: a manual report has no '
      'next run, and neither has one whose M-09 window never opens.';
  `,

  down: `
    -- The column that points at report_run first, or dropping the table needs a CASCADE that
    -- could take something else with it.
    ALTER TABLE report
      DROP COLUMN IF EXISTS last_run_id,
      DROP COLUMN IF EXISTS last_run_at,
      DROP COLUMN IF EXISTS next_run_at;
    DROP TABLE IF EXISTS report_run;
    DROP TYPE IF EXISTS report_run_trigger;
    DROP TYPE IF EXISTS report_run_state;
  `,
};
