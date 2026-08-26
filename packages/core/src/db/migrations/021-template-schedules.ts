import type { Migration } from './types.js';

/**
 * Template activation schedules (`N-12`, `CAPABILITIES.MD §5.2`, `WORKFLOW.MD §6`).
 *
 * A template that is only active during business hours, and a choice about what happens to the
 * notifications that fall due outside them.
 *
 * **The choice is the whole ticket.** "Discard" and "collect and send when reactivated" are both
 * things operators genuinely want and they are opposites: an on-call rota that pages at 03:00
 * wants the out-of-hours message *gone*, and a daytime team's ticket queue wants every one of
 * them waiting on Monday morning. A system that picked one would be wrong for half its users, so
 * it is a column.
 *
 * **`discarded` is its own status, not `failed`.** A notification nobody was meant to receive did
 * not fail — treating it as a failure would put it on `N-13`'s Core Health failure count and have
 * an operator investigating a relay that is working perfectly. It is also not `sent`, because
 * nobody got it. The third answer is the honest one, and it keeps "what happened to my alarm"
 * answerable from one column.
 *
 * **The schedule is the same `schedule` row an object uses** (`M-09`), not a second kind of
 * calendar. One editor, one time zone story, one set of daylight-saving tests. `RESTRICT` rather
 * than `SET NULL`: a schedule quietly detaching itself from a template would turn an out-of-hours
 * template into an always-on one, which is the loudest possible failure mode for this feature.
 */
export const migration021: Migration = {
  id: 21,
  name: 'template-schedules',

  up: `
    ALTER TABLE notification_template
      ADD COLUMN schedule_id bigint REFERENCES schedule(id) ON DELETE RESTRICT,
      -- What happens to a notification that falls due while the template is inactive. Only
      -- meaningful when a schedule is assigned; harmless and ignored when one is not.
      ADD COLUMN when_inactive text NOT NULL DEFAULT 'queue'
        CHECK (when_inactive IN ('queue', 'discard'));

    -- Partial, because almost no template has a schedule and the dispatcher's question is
    -- "which ones do".
    CREATE INDEX notification_template_schedule_idx
      ON notification_template (schedule_id)
      WHERE schedule_id IS NOT NULL;

    ALTER TABLE notification_request
      DROP CONSTRAINT IF EXISTS notification_request_status_check;
    ALTER TABLE notification_request
      ADD CONSTRAINT notification_request_status_check
        CHECK (status IN ('pending', 'sent', 'failed', 'discarded'));
  `,

  down: `
    -- Anything discarded becomes failed on the way back, because the older schema has no third
    -- answer and 'pending' would send messages an operator had already decided nobody wanted.
    UPDATE notification_request SET status = 'failed' WHERE status = 'discarded';
    ALTER TABLE notification_request
      DROP CONSTRAINT IF EXISTS notification_request_status_check;
    ALTER TABLE notification_request
      ADD CONSTRAINT notification_request_status_check
        CHECK (status IN ('pending', 'sent', 'failed'));

    DROP INDEX IF EXISTS notification_template_schedule_idx;
    ALTER TABLE notification_template
      DROP COLUMN IF EXISTS when_inactive,
      DROP COLUMN IF EXISTS schedule_id;
  `,
};
