import type { Migration } from './types.js';

/**
 * What happened to a queued notification (`N-07`).
 *
 * `N-02` queued obligations and left "and then what" open, because nothing could send anything
 * yet. This is the other half: whether a message went out, when, how many times it was tried and
 * what went wrong the last time.
 *
 * **On the request rather than in a table of attempts.** A delivery log with one row per attempt
 * is the more general shape and it answers a question nobody asks: an operator wants to know
 * whether the alarm reached them and, if not, why — not the timing of the third retry. The last
 * error is what gets read; the attempt count is what decides whether to try again (`N-13`); and
 * both belong beside the obligation they are about, where "what is still owed" is a partial index
 * rather than a `NOT EXISTS`.
 *
 * **The unit of delivery is still the request, deliberately.** `N-11` folds several requests into
 * one digest, which invites a `notification_message` table — and would make the common case, one
 * alarm going to one address, carry a second row that exists only to say "just this one". A
 * digest instead marks every request it covered delivered in the same transaction that sends it.
 */
export const migration019: Migration = {
  id: 19,
  name: 'notification-delivery',

  up: `
    ALTER TABLE notification_request
      ADD COLUMN status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed')),
      -- When it actually went out, which is not when it fell due: a relay that was down for ten
      -- minutes makes those two different, and a message saying "at 03:00" about an alarm
      -- delivered at 03:10 is the honest one.
      ADD COLUMN delivered_at timestamptz,
      ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      -- Not before this. Set by the retry policy (N-13); NULL means "as soon as possible", which
      -- is what a request that has never been tried wants.
      ADD COLUMN next_attempt_at timestamptz,
      -- The last failure, in the operator's words rather than a stack trace. "ETIMEDOUT" alone
      -- is not a diagnosis (CLAUDE.md), so what goes here is the relay, the phase and the reason.
      ADD COLUMN last_error text;

    -- What the dispatcher asks for, and the only question it asks. Partial, because a healthy
    -- installation's queue is almost entirely delivered rows: the index grows with the backlog
    -- rather than with the history.
    CREATE INDEX notification_request_pending_delivery_idx
      ON notification_request (next_attempt_at NULLS FIRST, id)
      WHERE status = 'pending';
  `,

  down: `
    DROP INDEX IF EXISTS notification_request_pending_delivery_idx;
    ALTER TABLE notification_request
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS delivered_at,
      DROP COLUMN IF EXISTS status;
  `,
};
