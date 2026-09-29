import type { Logger } from '@ms/shared';

/** How often a refusal episode is summarised, and how long without one ends it. */
export const REFUSAL_SUMMARY_MS = 30_000;

/** The check that opened an episode, and the bound it met. */
export interface RefusedCheck {
  readonly sensorId: number;
  readonly sensorType: string;
  readonly queued: number;
  readonly queueMax: number;
}

/**
 * The log of checks refused at a full queue, one episode at a time (`P-216` part 3).
 *
 * **A line per refusal was the flood.** `P-216c`'s probe wrote 61,957 of its 62,309 lines as *check
 * queue is full, refusing a check*, about 11 KB a second while the pool was saturated, and each
 * said only what the `refused` channel already counts. Here an episode is three kinds of line:
 *
 * - **the first refusal, in full**: which sensor, of which type, and the bound — what an operator
 *   diagnosing it needs, and the one line in the episode that can say it;
 * - **every thirty seconds, a count** of what was refused since the last line and since the start;
 * - **one line when it ends**: thirty seconds with no refusal.
 *
 * **Ended by a quiet interval, not by the queue having room.** A saturated queue has room for one
 * check each time one finishes and is full again at the next submit, so "room" would open and
 * close an episode per check — the flood again, in pairs.
 */
export class RefusalLog {
  readonly #logger: Logger;
  readonly #message: string;
  readonly #summaryMs: number;
  #timer: NodeJS.Timeout | undefined;
  #total = 0;
  #sinceLine = 0;
  #startedAt = 0;

  constructor(logger: Logger, message: string, options: { summaryMs?: number } = {}) {
    this.#logger = logger;
    this.#message = message;
    this.#summaryMs = options.summaryMs ?? REFUSAL_SUMMARY_MS;
  }

  /** True while an episode is open. */
  get refusing(): boolean {
    return this.#timer !== undefined;
  }

  refused(check: RefusedCheck): void {
    if (this.#timer !== undefined) {
      this.#total += 1;
      this.#sinceLine += 1;
      return;
    }
    this.#total = 1;
    this.#sinceLine = 0;
    this.#startedAt = performance.now();
    this.#logger.warn(
      {
        sensorId: check.sensorId,
        sensorType: check.sensorType,
        queued: check.queued,
        queueMax: check.queueMax,
      },
      `${this.#message}; further refusals are counted, and summarised every ${String(
        Math.round(this.#summaryMs / 1000),
      )} s`,
    );
    this.#timer = setInterval(() => {
      this.#tick();
    }, this.#summaryMs);
    this.#timer.unref();
  }

  /** Ends an open episode with its line. For `stop`, and for a pool latched off. */
  stop(): void {
    if (this.#timer === undefined) return;
    this.#end();
  }

  #tick(): void {
    if (this.#sinceLine === 0) {
      this.#end();
      return;
    }
    this.#logger.warn(
      { refused: this.#sinceLine, refusedInEpisode: this.#total, seconds: this.#seconds() },
      'still refusing checks at a full queue',
    );
    this.#sinceLine = 0;
  }

  #end(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#logger.info(
      { refusedInEpisode: this.#total, seconds: this.#seconds() },
      'no longer refusing checks',
    );
    this.#total = 0;
    this.#sinceLine = 0;
  }

  #seconds(): number {
    return Math.round((performance.now() - this.#startedAt) / 1000);
  }
}
