import { describeError, type Logger } from '@ms/shared';

/**
 * A timer that runs one job on an interval, skipping rather than queueing an overrun.
 *
 * **Extracted at the second caller** (`P-12`), from `T-21`'s factory sweep. The two jobs are
 * unrelated — recomputing factory sensors, reading the core's own counters — and what they share
 * is entirely mechanical: an unref'd interval, a re-entrancy guard, a skip counter and a failure
 * that must not stop the next pass. That is the shape `P-19` calls "byte-for-byte identical with
 * everything that varies outside it".
 *
 * **A sweep that overruns is skipped, not queued**, which is the rule the probe's pool follows
 * for a sensor (`WORKFLOW.MD §3`): the next sweep is already scheduled, and two overlapping ones
 * would write two results for the same second and race each other's state transitions. Skips are
 * counted, never silent — backpressure is visible (`CLAUDE.md`), and this number is what says so.
 */
export interface PeriodicSweepOptions {
  logger: Logger;
  /** The `component` on this sweep's log lines. */
  component: string;
  /** What the failure line calls this, in words: "a sensor factory sweep failed". */
  what: string;
  run: () => Promise<unknown>;
  intervalMs: number;
}

export class PeriodicSweep {
  readonly #logger: Logger;
  readonly #what: string;
  readonly #run: () => Promise<unknown>;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #skipped = 0;

  constructor(options: PeriodicSweepOptions) {
    this.#logger = options.logger.child({ component: options.component });
    this.#what = options.what;
    this.#run = options.run;
    this.#intervalMs = options.intervalMs;
  }

  get skipped(): number {
    return this.#skipped;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Unref'd so a core with nothing else to do can still exit; the lifecycle stops it properly.
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sweep. Public so a test drives it directly rather than waiting on a timer. */
  async tick(): Promise<void> {
    if (this.#running) {
      this.#skipped += 1;
      return;
    }
    this.#running = true;
    try {
      await this.#run();
    } catch (error: unknown) {
      // A failed sweep must not take the core down or stop the next one: the most likely cause
      // is the database being briefly unavailable, which the next sweep will find resolved.
      this.#logger.error({ ...describeError(error) }, this.#what);
    } finally {
      this.#running = false;
    }
  }
}
