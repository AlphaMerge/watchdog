import type { Migration } from './types.js';

/**
 * Summarisation (`N-11`, `CAPABILITIES.MD §5.2`, `WORKFLOW.MD §6`).
 *
 * What stops a switch failure from sending two hundred emails. A template collects the
 * notifications that arrive close together and sends one digest instead — except for the first
 * one, which goes out at once, because an operator who has to wait fifteen minutes to hear that
 * a datacentre is down has not been notified.
 *
 * **A window is a row, not a timer.** The same reasoning as `N-02`'s alarms: a timer holding a
 * storm's worth of notifications is a restart away from losing all of them, and "what is owed"
 * has to be answerable by anything that reads the database. So an open window is a row with a
 * due time, closing it is an `UPDATE`, and a core that restarts mid-storm sends the digest late
 * rather than never.
 *
 * **One open window per template.** Recipients, method and wording all live on the template, so
 * the template is what a digest is *of*. The partial unique index is what makes that a rule
 * rather than a convention — two dispatchers cannot open a second window for the same template.
 *
 * **`disposition` is on the request because the decision must be made once.** "Send the first
 * Down immediately, then summarise" is not a function of the request alone: it depends on what
 * has already gone out inside the window. Re-deciding a request that failed to send would move
 * it into a digest on its second attempt, quietly changing what an operator was promised, so the
 * answer is recorded the first time and read thereafter.
 */
export const migration020: Migration = {
  id: 20,
  name: 'notification-summaries',

  up: `
    ALTER TABLE notification_template
      -- The six modes of CAPABILITIES.MD §5.2, in the order that table lists them. The default
      -- is the third, which is also PRTG's: the first Down and the first Up go out at once and
      -- everything behind them is collected.
      ADD COLUMN summarisation text NOT NULL DEFAULT 'first-down-and-up'
        CHECK (summarisation IN (
          'always-immediate',
          'first-down',
          'first-down-and-up',
          'downs-immediate',
          'downs-and-ups-immediate',
          'always-summarise'
        )),
      -- How long a window stays open. Minutes in the UI, seconds here, because everything else
      -- in this schema that is a duration is seconds and one unit is worth more than one
      -- convenience.
      ADD COLUMN summary_window_seconds integer NOT NULL DEFAULT 900
        CHECK (summary_window_seconds BETWEEN 60 AND 86400);

    CREATE TABLE notification_summary (
      id bigserial PRIMARY KEY,
      template_id bigint NOT NULL REFERENCES notification_template(id) ON DELETE CASCADE,
      opened_at timestamptz NOT NULL,
      due_at timestamptz NOT NULL,
      -- The message kinds already released immediately inside this window, for the two "first
      -- ... then summarise" modes. An array rather than two booleans because the kinds are the
      -- vocabulary of the whole feature and a seventh mode should not need a migration.
      released text[] NOT NULL DEFAULT '{}',
      closed_at timestamptz
    );

    -- One open window per template, enforced rather than assumed.
    CREATE UNIQUE INDEX notification_summary_open_idx
      ON notification_summary (template_id)
      WHERE closed_at IS NULL;

    -- What the dispatcher asks for on every pass: is any window due to close.
    CREATE INDEX notification_summary_due_idx
      ON notification_summary (due_at)
      WHERE closed_at IS NULL;

    ALTER TABLE notification_request
      ADD COLUMN disposition text NOT NULL DEFAULT 'undecided'
        CHECK (disposition IN ('undecided', 'immediate', 'held')),
      -- The window this request is waiting in. ON DELETE SET NULL rather than CASCADE: deleting
      -- a window must never delete the obligations it was holding.
      ADD COLUMN summary_id bigint REFERENCES notification_summary(id) ON DELETE SET NULL;

    -- Requests still waiting for a decision. Partial and tiny: a request is undecided for one
    -- pass of the dispatcher and delivered for the rest of its life.
    CREATE INDEX notification_request_undecided_idx
      ON notification_request (id)
      WHERE disposition = 'undecided' AND status = 'pending';

    -- The members of a digest, read once when its window closes.
    CREATE INDEX notification_request_summary_idx
      ON notification_request (summary_id, id)
      WHERE status = 'pending';
  `,

  down: `
    DROP INDEX IF EXISTS notification_request_summary_idx;
    DROP INDEX IF EXISTS notification_request_undecided_idx;
    ALTER TABLE notification_request
      DROP COLUMN IF EXISTS summary_id,
      DROP COLUMN IF EXISTS disposition;
    DROP TABLE IF EXISTS notification_summary;
    ALTER TABLE notification_template
      DROP COLUMN IF EXISTS summary_window_seconds,
      DROP COLUMN IF EXISTS summarisation;
  `,
};
