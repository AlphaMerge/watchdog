import { describeError, type Logger } from '@ms/shared';

/** Just enough of `ObjectService` to run the sweep. */
export interface ExpiresPauses {
  expirePauses(limit?: number): Promise<{ expired: number[]; sensorsAffected: number }>;
}

export interface PauseExpiryOptions {
  service: ExpiresPauses;
  logger: Logger;
  /** How often to look. Coarse on purpose — see below. */
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Notices when a timed pause runs out (`M-08`).
 *
 * Every *read* of a pause already accounts for the clock, so nothing is wrong between the
 * deadline and the sweep — the object simply is not paused any more. What the sweep is for is
 * the three things that are writes: the transition to Unknown that uptime is computed from, the
 * entry in the log, and the configuration push that tells a probe to start scanning again.
 *
 * **Half a minute, not a second.** The shortest pause a UI offers is five minutes, and an
 * operator who paused something for five minutes does not care whether monitoring resumes at
 * 14:35:00 or 14:35:20 — while a query a second, for ever, on an installation where nothing is
 * ever paused, is a cost nobody agreed to. The lag is bounded, stated, and on the safe side:
 * monitoring resumes late rather than early.
 */
export class PauseExpiry {
  readonly #service: ExpiresPauses;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: PauseExpiryOptions) {
    this.#service = options.service;
    this.#logger = options.logger.child({ component: 'pause-expiry' });
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 200;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.sweep(), this.#intervalMs);
    // Never a reason to hold the process open for it: an expiry that has not happened yet will
    // still be due after a restart, because the deadline is in the database and not in a timer.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Never throws: a sweep that dies takes every future sweep with it. */
  async sweep(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const report = await this.#service.expirePauses(this.#batchSize);
      if (report.expired.length > 0) {
        this.#logger.info(
          { objects: report.expired, sensorsAffected: report.sensorsAffected },
          'timed pauses expired; monitoring resumed',
        );
      }
      return report.expired.length;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'the pause expiry sweep failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }
}
