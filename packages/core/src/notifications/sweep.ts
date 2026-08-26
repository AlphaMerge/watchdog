import { describeError, type Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { AlarmEngine } from './engine.js';

export interface AlarmSweepOptions {
  db: Database;
  engine: AlarmEngine;
  logger: Logger;
  /** Override for tests. Production ticks on the wall-clock second. */
  intervalMs?: number;
}

/** One second: the finest resolution a latency is expressed in. */
const SECOND = 1_000;

/**
 * Fires notification chains as they fall due (`N-02`).
 *
 * **A placeholder for `N-04`, and deliberately a dull one.** A tick a second is enough to be
 * correct — every due time is absolute and in the table, so a sweep that runs late sends late
 * rather than not at all, and one that never runs sends everything the moment it comes back.
 * What it is not is efficient: an installation with no alarms waiting pays one indexed query a
 * second forever. `N-04` replaces the tick with a wait on `nextDueAt`, at which point an idle
 * installation pays nothing and a due alarm fires on the second rather than within one. The
 * correctness lives in the table and the engine; this is only what wakes them up.
 *
 * Never throws. A sweep that died would take every future notification with it, and the failure
 * that killed it would be the one nobody heard about.
 */
export class AlarmSweep {
  readonly #db: Database;
  readonly #engine: AlarmEngine;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  constructor(options: AlarmSweepOptions) {
    this.#db = options.db;
    this.#engine = options.engine;
    this.#logger = options.logger.child({ component: 'alarm-sweep' });
    this.#intervalMs = options.intervalMs ?? SECOND;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass.
   *
   * Repeats while the sweep comes back full: a core that was down through an outage has a
   * backlog, and dribbling it out at one bounded batch a second would take longer than the
   * outage did. Bounded by `rounds` so a bug that keeps returning full batches cannot spin.
   */
  async sweep(now = new Date(), rounds = 10): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      let fired = 0;
      for (let round = 0; round < rounds; round += 1) {
        const result = await this.#db.tx((q) => this.#engine.sweep(q, now));
        fired += result.fired;
        if (result.fired === 0) break;
      }
      return fired;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'the alarm sweep failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.sweep().finally(() => {
        this.#arm();
      });
    }, this.#intervalMs);
    // Never a reason to hold the process open: an alarm that has not fired yet is still due
    // after a restart, because the due time is in the database and not in this timer.
    this.#timer.unref();
  }
}
