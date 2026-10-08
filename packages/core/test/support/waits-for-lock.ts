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
  return pollWithin(
    ms,
    what,
    async () => {
      const waiting = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return (waiting[0]?.n ?? 0) > 0;
    },
    intervalMs,
  );
}
