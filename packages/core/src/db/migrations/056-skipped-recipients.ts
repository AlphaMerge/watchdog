import type { Migration } from './types.js';

/**
 * Who a delivered message did not reach, and why (`M-19`).
 *
 * **A partial send is still a send**, and the notification log recorded one as `sent` with
 * nothing else. Once a template's users and groups resolve at send time, "sent" can mean "sent to
 * four of the six people it names": one account disabled, one with no address, one who may not
 * read the sensor. Those are the facts that answer "why did Bob never get paged?", and a log line
 * in a journal with its own retention is not where anybody looks for them.
 *
 * Text, one clause per person — `"bob" in group "NOC" (may not see this sensor)` — because it is
 * read by a person and never parsed. Empty when everybody named was sent to.
 */
export const migration056: Migration = {
  id: 56,
  name: 'skipped-recipients',

  up: `
    ALTER TABLE notification_request
      ADD COLUMN skipped_recipients text NOT NULL DEFAULT ''
        CHECK (length(skipped_recipients) <= 2000);
  `,

  down: `
    ALTER TABLE notification_request DROP COLUMN IF EXISTS skipped_recipients;
  `,
};
