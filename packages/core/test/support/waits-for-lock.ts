import type { Queryable } from '../../src/db/pool.js';
import { pollWithin } from './within.js';

/**
 * Until some session in this database waits on a lock — the other side is blocked — or a failure
 * naming `what` once `ms` have passed, after which `pg_stat_activity` is asked no more (`P-325`).
 *
 * For a test that holds a lock in one session and needs to know the other has reached it before
 * letting go: let go earlier and the test passes without the two ever having met.
 */
export function somebodyWaits(
  db: Pick<Queryable, 'query'>,
  what: string,
  ms = 10_000,
  intervalMs = 20,
): Promise<void> {
  return sessionsWait(db, 1, what, { ms, intervalMs });
}

/**
 * Until `count` sessions in this database wait on a lock at once, or a failure naming `what`, and
 * how many were seen last, once `ms` have passed (`P-395`).
 *
 * For a test that races more than one session against a lock it holds: every one of them has to
 * be waiting before it lets go, or the last to arrive is not in the race at all. The database
 * should be the test's own scratch one, so no other file's sessions are counted.
 *
 * `event` narrows it to one kind of lock, as `pg_stat_activity.wait_event` names it: `advisory`
 * for the tree lock (`P-396`). A session blocked on a row it would have waited on anyway is then
 * not taken for one blocked on the lock the test is about.
 */
export function sessionsWait(
  db: Pick<Queryable, 'query'>,
  count: number,
  what: string,
  options: { ms?: number; intervalMs?: number; event?: string } = {},
): Promise<void> {
  const { ms = 10_000, intervalMs = 20, event } = options;
  const on = event === undefined ? 'a lock' : `a lock (${event})`;
  let seen = 0;
  return pollWithin(
    ms,
    () => `${what} (${String(count)} waiting on ${on}; ${String(seen)} seen last)`,
    async () => {
      const waiting = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND ($1::text IS NULL OR wait_event = $1)`,
        [event ?? null],
      );
      seen = waiting[0]?.n ?? 0;
      return seen >= count;
    },
    intervalMs,
  );
}
