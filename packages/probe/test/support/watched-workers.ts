import { Worker, type WorkerOptions } from 'node:worker_threads';
import { pollWithin } from './within.js';

/**
 * How long a test gives a pool's workers to load before it starts timing what it is about
 * (`P-446`, `P-448`).
 *
 * **A bound of its own, and a long one.** A pool's start-up bound is thirty seconds
 * (`STARTUP_TIMEOUT_MS`); a worker that misses it is replaced after a delay and loads again, and
 * `P-258` measured the catalogue's import at up to 14.8 s on a loaded host. So this covers one
 * missed start and its replacement. A test that waits here says the workers were slow; one that
 * fails after here says the behaviour was.
 */
export const LOAD_BOUND_MS = 90_000;

/**
 * The workers a pool made, watched through their own events: handed to a `CheckPool` as its
 * `createWorker`, it lets a test wait for the pool's workers to load, and count starts and loads
 * as they happen rather than sample them in a window of wall-clock time (`P-446`, `P-448`).
 *
 * **It hears a worker before the pool does.** Its listeners are attached as the worker is made,
 * before the pool attaches its own, and an emitter calls listeners in the order they were added.
 * So when the pool acts on a `ready` or an `exit`, here has already counted it: a worker the pool
 * makes on a loading turn another worker's `ready` freed is made with that one already counted
 * as loaded.
 */
export interface WatchedWorkers {
  /** For `CheckPoolOptions.createWorker`: `new Worker`, watched. */
  readonly createWorker: (filename: string, options: WorkerOptions) => Worker;
  /** Workers made so far: each one a start. */
  readonly made: () => number;
  /** Workers that have said ready and have not exited. */
  readonly ready: () => number;
  /** Workers made that have neither said ready nor exited. */
  readonly loading: () => number;
  /** The most workers loading at once, counted as each was made. */
  readonly mostLoading: () => number;
  /** The counts, for a failure's words. */
  readonly said: () => string;
}

export function watchedWorkers(): WatchedWorkers {
  let made = 0;
  let ready = 0;
  let loading = 0;
  let mostLoading = 0;
  let exited = 0;
  return {
    createWorker: (filename, options) => {
      const worker = new Worker(filename, options);
      made += 1;
      loading += 1;
      mostLoading = Math.max(mostLoading, loading);
      let loaded = false;
      let gone = false;
      worker.on('message', (message: { readonly type?: unknown } | null) => {
        if (loaded || gone || message?.type !== 'ready') return;
        loaded = true;
        loading -= 1;
        ready += 1;
      });
      worker.once('exit', () => {
        gone = true;
        exited += 1;
        if (loaded) ready -= 1;
        else loading -= 1;
      });
      return worker;
    },
    made: () => made,
    ready: () => ready,
    loading: () => loading,
    mostLoading: () => mostLoading,
    said: () =>
      `${String(made)} made, ${String(ready)} ready, ${String(loading)} loading, ` +
      `${String(exited)} exited`,
  };
}

/**
 * Until `count` of the watched workers are ready and none is loading, under `LOAD_BOUND_MS`, or a
 * failure saying how far they had got and what the pool said of its starts.
 */
export function loaded(
  workers: WatchedWorkers,
  count: number,
  pool?: { stats(): { readonly startupFailed: number; readonly workerCrashes: number } },
): Promise<void> {
  return pollWithin(
    LOAD_BOUND_MS,
    () => {
      const stats = pool?.stats();
      const starts =
        stats === undefined
          ? ''
          : `; the pool counted ${String(stats.startupFailed)} failed starts and ` +
            `${String(stats.workerCrashes)} crashes`;
      return `${String(count)} workers to load: ${workers.said()}${starts}`;
    },
    () => workers.ready() >= count && workers.loading() === 0,
    5,
  );
}
