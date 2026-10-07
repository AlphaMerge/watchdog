import type { Logger } from '@ms/shared';
import { legible } from '../../notifications/legible.js';
import type { Queryable } from '../pool.js';
import type { Migration } from './types.js';

/** How many ids one read covers: one short statement each, and one short update. */
export const LEGIBLE_WINDOW = 10_000;

/**
 * What can hold something `legible()` changes: a character outside printable ASCII. Every one it
 * escapes or turns into a newline (a control, a carriage return, a format character, a separator,
 * a selector, a default-ignorable) is outside it, so a row inside it is already what `legible()`
 * would write, and is neither sent here nor written. PostgreSQL compares a bracket range by code
 * point; `migrator.test.ts` checks that against every code point.
 */
export const LEGIBLE_CANDIDATE = '[^ -~]';

/**
 * Rewrites every stored delivery error as `legible()` would write it today (`N-28`), and returns
 * how many it rewrote.
 *
 * **In windows of ids**, from the lowest to the highest there was when it began: each window is
 * one read and at most one update, each its own statement on the pool, so no lock is held across
 * windows and a row is locked only while its own window's update runs. Rows written after it
 * began were written by `#record`, which already applies `legible()`.
 *
 * **Only a row that still says what was read is rewritten.** The dispatcher may write a newer
 * error between the read and the update; that one is already legible, and is kept.
 */
export async function rewriteDeliveryErrors(
  db: Queryable,
  window: number = LEGIBLE_WINDOW,
): Promise<number> {
  const [bounds] = await db.query<{ low: string | null; high: string | null }>(
    'SELECT min(id)::text AS low, max(id)::text AS high FROM notification_request',
  );
  if (bounds === undefined || bounds.low === null || bounds.high === null) return 0;
  const high = BigInt(bounds.high);
  const step = BigInt(window);
  let rewritten = 0;
  for (let from = BigInt(bounds.low) - 1n; from < high; from += step) {
    const rows = await db.query<{ id: string; last_error: string }>(
      `SELECT id::text AS id, last_error FROM notification_request
        WHERE id > $1 AND id <= $2 AND last_error ~ $3`,
      [from.toString(), (from + step).toString(), LEGIBLE_CANDIDATE],
    );
    const changed = rows.flatMap((row) => {
      const after = legible(row.last_error);
      return after === row.last_error ? [] : [{ id: row.id, before: row.last_error, after }];
    });
    if (changed.length === 0) continue;
    const updated = await db.query<{ id: string }>(
      `UPDATE notification_request r SET last_error = v.new_text
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS v (id, old_text, new_text)
        WHERE r.id = v.id AND r.last_error = v.old_text
        RETURNING r.id::text AS id`,
      [
        changed.map((one) => one.id),
        changed.map((one) => one.before),
        changed.map((one) => one.after),
      ],
    );
    rewritten += updated.length;
  }
  return rewritten;
}

async function rewrite(context: {
  readonly db: Queryable;
  readonly logger: Logger;
}): Promise<void> {
  const rewritten = await rewriteDeliveryErrors(context.db);
  context.logger.info({ rewritten }, 'delivery errors stored before N-24 made legible');
}

/**
 * Delivery errors stored before `N-24`, made legible (`N-28`).
 *
 * `N-24` escapes what the far end says before it becomes `last_error`, and `N-27` and `N-29`
 * widened what that covers; a row written before each kept what it had. They do not age out:
 * nothing deletes a `notification_request` but its sensor's deletion. So the C0 and C1 controls,
 * the overrides and the zero-width characters of an old row would reach the API, the logs view
 * and Core Health's message for as long as the installation runs.
 *
 * **In JavaScript, calling `legible()`, not restating it in SQL.** PostgreSQL's regular
 * expressions have no Unicode properties, and the rule is made of them: `\p{Cf}`,
 * `\p{Default_Ignorable_Code_Point}`, the joiners' seventeen scripts by `Script_Extensions`,
 * `\p{Extended_Pictographic}`, `\p{Emoji}`. Spelled out, that is several hundred code-point ranges
 * frozen at one Unicode version — a second copy of a rule this same change alters (`N-29`), which
 * would stop agreeing with the first the day Node's Unicode moves. Calling it makes the rewrite
 * exactly what `#record` writes, by construction. So this migration's `data` step is not in its
 * checksum, and what it writes follows `legible()`: a database migrated later is rewritten by the
 * rule of its day, as its new rows are.
 *
 * **Not in one transaction**: in windows, each its own statement (`rewriteDeliveryErrors`). It
 * can be stopped and run again: what it has rewritten is legible, and `legible()` leaves legible
 * text as it is.
 *
 * `up` only says so on the column. **The rollback** removes that comment and leaves every row as
 * it is: what it replaced cannot be put back, and needs no putting back. The build before writes
 * escaped errors itself and reads them as text, so an escaped row is one it could have written.
 */
export const migration071: Migration = {
  id: 71,
  name: 'legible-delivery-errors',
  transactional: false,

  up: `
    COMMENT ON COLUMN notification_request.last_error IS
      'The last failure, as legible() writes it: controls, format characters, separators and stray selectors escaped (N-24, N-27, N-29); rows from before rewritten by migration 071 (N-28).';
  `,

  data: rewrite,

  down: `
    COMMENT ON COLUMN notification_request.last_error IS NULL;
  `,
};
