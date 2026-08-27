import { describeError, type Logger } from '@ms/shared';
import type { RediscoveryService } from './rediscovery.js';

export interface RediscoverySweepOptions {
  service: RediscoveryService;
  logger: Logger;
  intervalMs?: number;
}

/**
 * The timer that fires rediscovery schedules (`D-07`).
 *
 * **A minute, because that is the resolution a cadence has.** The finest thing anybody can ask
 * for is "at :15 past the hour", so checking more often would find nothing and checking less
 * often would make a schedule fire late by however much less. `M-09`'s schedule sweep runs on
 * the same reasoning and the same period.
 *
 * **A tick that overruns is skipped, not queued** — the same rule the probe's pool follows for a
 * sensor and `T-21`'s factory sweep follows for itself. Two overlapping ticks would find the
 * same schedule due twice, because the first has not written its booking yet, and start the same
 * rediscovery twice.
 *
 * **Cheap when nothing is due, which is almost always.** The query is one index-only scan of a
 * partial index over enabled schedules, of which most installations have none at all.
 */
const DEFAULT_INTERVAL_MS = 60_000;

export class RediscoverySweep {
  readonly #service: RediscoveryService;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #ticks = 0;
  #skipped = 0;

  constructor(options: RediscoverySweepOptions) {
    this.#service = options.service;
    this.#logger = options.logger.child({ component: 'rediscovery-sweep' });
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  stats(): { ticks: number; skipped: number } {
    return { ticks: this.#ticks, skipped: this.#skipped };
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Unref'd: a timer nobody is waiting on must not be the reason a core will not shut down.
    this.#timer.unref();
    this.#logger.info({ intervalMs: this.#intervalMs }, 'rediscovery sweep started');
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    return Promise.resolve();
  }

  /** One pass. Never throws: a background timer that can reject takes the process with it. */
  async tick(): Promise<number> {
    if (this.#running) {
      this.#skipped += 1;
      return 0;
    }
    this.#running = true;
    this.#ticks += 1;
    try {
      return await this.#service.tick();
    } catch (error) {
      this.#logger.error(describeError(error), 'a rediscovery sweep failed');
      return 0;
    } finally {
      this.#running = false;
    }
  }
}
