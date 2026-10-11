import type { Database } from '../../src/db/pool.js';

/** What `watchNotifierTimers` hands back: the count now, and the way to put `setTimeout` back. */
export interface NotifierTimers {
  live: () => number;
  stop: () => void;
}

/**
 * The timers the notification code has running, `unref`'d ones included (`P-252`).
 *
 * **Why not `process.getActiveResourcesInfo()`**, which `notification-timers.test.ts` and
 * `alarm-scheduler.test.ts` counted until `P-252`: it names only the handles keeping the process
 * alive, and the scheduler `unref`s its timer, so the count never saw the one timer the claim is
 * about. It read the database pool's idle clients instead, and failed when the pool held one more
 * of them at one sample than at another. A design with an `unref`'d timer per notification would
 * have passed it.
 *
 * So `setTimeout` is wrapped from here until `stop`, and a timer is counted when the code that
 * started it is under `src/notifications/`, from its start until it fires or is cleared.
 */
export function watchNotifierTimers(): NotifierTimers {
  const live = new Set<NodeJS.Timeout>();
  const original = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const set = (
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): NodeJS.Timeout => {
    const notifiers = new Error().stack?.includes('/src/notifications/') === true;
    const timer = original.set(
      (...given: unknown[]) => {
        live.delete(timer);
        callback(...given);
      },
      ms,
      ...args,
    );
    if (notifiers) live.add(timer);
    return timer;
  };
  const clear = (timer?: NodeJS.Timeout | string | number): void => {
    if (typeof timer === 'object') live.delete(timer);
    original.clear(timer);
  };
  globalThis.setTimeout = set as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = clear;
  return {
    live: () => live.size,
    stop: () => {
      globalThis.setTimeout = original.set;
      globalThis.clearTimeout = original.clear;
    },
  };
}

/**
 * The timers keeping this process alive, less the database pool's own (`P-252`).
 *
 * The other half of the claim: no timer per notification anywhere else either. `pg-pool` gives
 * every idle client a timer that ends it after `idleTimeoutMillis`, so the raw count moves with
 * how many clients the pool happens to hold, which is not what is under test. Both are read in
 * one turn, so no client can go idle or be taken between them. `unref`'d timers are not seen.
 */
export function otherTimers(db: Database): number {
  const timers = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  return timers - db.stats().idle;
}
