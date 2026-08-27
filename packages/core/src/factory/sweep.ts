import { describeError, type Logger } from '@ms/shared';
import type { FactoryService } from './service.js';

export interface FactorySweepOptions {
  service: FactoryService;
  logger: Logger;
  /** How often factory sensors are recomputed. Their own scan interval is not consulted. */
  intervalMs?: number;
}

/**
 * The timer that recomputes Sensor Factory sensors (`T-21`).
 *
 * **One sweep for the whole installation rather than a scan interval per sensor**, and that is a
 * deliberate simplification with a reason behind it. A factory has no device to be polite to and
 * no packet to send: it is arithmetic over rows this process already has, costing two queries per
 * sweep however many factories there are. Honouring each sensor's own interval would mean a
 * second scheduler in the core — a timing wheel's worth of machinery — to stagger work that is
 * cheaper than the staggering.
 *
 * **The interval is the floor, not the ceiling.** A factory reading a sensor scanned every five
 * minutes still only changes every five minutes; recomputing it every thirty seconds writes the
 * same value nine times, which the sample table stores and the rollups then average to exactly
 * the same answer. Thirty seconds is chosen so a factory over a one-minute sensor is never more
 * than half an interval stale, which is what an operator watching a graph would notice.
 *
 * **A sweep that overruns is skipped, not queued.** The same rule the probe's pool follows for a
 * sensor (`WORKFLOW.MD §3`): the next sweep is already scheduled, and two overlapping sweeps
 * would write two results for the same second and race each other's state transitions.
 */
const DEFAULT_INTERVAL_MS = 30_000;

export class FactorySweep {
  readonly #service: FactoryService;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #skipped = 0;

  constructor(options: FactorySweepOptions) {
    this.#service = options.service;
    this.#logger = options.logger.child({ component: 'factory-sweep' });
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
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
      // Counted, never silent: a sweep that cannot keep up is backpressure (CLAUDE.md), and the
      // number is what says so.
      this.#skipped += 1;
      return;
    }
    this.#running = true;
    try {
      await this.#service.sweep();
    } catch (error: unknown) {
      // A failed sweep must not take the core down or stop the next one: the most likely cause
      // is the database being briefly unavailable, which the next sweep will find resolved.
      this.#logger.error({ ...describeError(error) }, 'a sensor factory sweep failed');
    } finally {
      this.#running = false;
    }
  }
}
