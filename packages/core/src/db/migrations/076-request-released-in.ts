import type { Migration } from './types.js';

/**
 * The window whose immediate slot a notification took (`N-26`).
 *
 * A summarisation mode such as `first-down-and-up` sends the first Down and the first Up of a
 * window at once and holds the rest, and the window records which kinds it has released. A
 * recovery decided immediate and then dropped at send because a newer alarm of its trigger went
 * first (`N-22`) had spent the window's Up, so another sensor's first Up in that window waited for
 * the digest. To give the slot back the request has to say which window it was taken from:
 * `summary_id` cannot, since every reader of it takes it for membership of that window's digest.
 *
 * Null for a request decided before this, held, or sent at once without taking a slot. Set null
 * when its window is deleted, as `summary_id` is. The rollback drops the column; what it recorded
 * is only needed while the window is open.
 */
export const migration076: Migration = {
  id: 76,
  name: 'request-released-in',

  up: `
    ALTER TABLE notification_request
      ADD COLUMN released_in bigint REFERENCES notification_summary(id) ON DELETE SET NULL;

    COMMENT ON COLUMN notification_request.released_in IS
      'The open window whose immediate slot this request took, so a drop at send can give it back (N-26).';
  `,

  down: `
    ALTER TABLE notification_request DROP COLUMN released_in;
  `,
};
