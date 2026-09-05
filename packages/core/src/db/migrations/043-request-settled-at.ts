import type { Migration } from './types.js';

/**
 * When a notification request stopped being owed (`P-124`).
 *
 * **`at` is when the obligation fell due, not when anything happened to it** — migration 016 says
 * so, and it is the right meaning for a digest that has to name when the outage started. Delivery
 * Health counted its failures with `WHERE r.at >= now() - window`, which asks a different
 * question and gets a wrong answer whenever the two differ by more than the window.
 *
 * They differ by more than the window in the default configuration. `DEFAULT_RETRY` is nine
 * backoffs from 60 s doubling to a 900 s cap with 0.5 jitter: 45 to 90 minutes, expected about
 * 67, against a health window of 60. So a notification that exhausted its retries — the one
 * failure the whole subsystem exists to prevent — usually fell due outside the window and was
 * counted zero. Worse, it also stopped being `pending`, so it dropped out of `oldest_retrying`
 * at the same moment: Delivery Health flipped from Down back to `ok` at the exact instant the
 * alarm was abandoned, and the operator watching it saw the problem resolve itself.
 *
 * `delivered_at` could not stand in for this. It is only written on success, which is the half
 * that was never the problem.
 */
export const migration043: Migration = {
  id: 43,
  name: 'request-settled-at',

  up: `
    ALTER TABLE notification_request
      ADD COLUMN settled_at timestamptz;

    -- Backfilled from what each row already knows. A delivered row settled when it was delivered;
    -- anything else terminal has no better answer than when it fell due, which is the same
    -- approximation the old query was making and no worse than leaving it null.
    UPDATE notification_request
      SET settled_at = coalesce(delivered_at, at)
      WHERE status <> 'pending';

    -- What Delivery Health asks: terminal rows in a window. Partial, because a healthy
    -- installation's table is almost entirely settled rows and the index should grow with the
    -- window, not with the history.
    CREATE INDEX notification_request_settled_idx
      ON notification_request (settled_at)
      WHERE settled_at IS NOT NULL;
  `,

  down: `
    DROP INDEX IF EXISTS notification_request_settled_idx;
    ALTER TABLE notification_request DROP COLUMN IF EXISTS settled_at;
  `,
};
