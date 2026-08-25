import type { Logger } from '@ms/shared';

export interface ReplayPacerConfig {
  /** Probes allowed to catch up at full speed at once. */
  maxConcurrentProbes: number;
  /** Extra delay added to each catch-up acknowledgement per probe beyond the limit. */
  stepMs: number;
  /** Longest delay this will ask for. Beyond it, the queue's own refusals take over. */
  maxDelayMs: number;
  /** A probe that has not offered a batch for this long is no longer catching up. */
  idleAfterMs: number;
}

export interface ReplayPacerOptions {
  config: ReplayPacerConfig;
  logger: Logger;
  now?: () => number;
}

export interface ReplayPacerStats {
  /** Probes that reported a backlog on their most recent batch. */
  replaying: number;
  /** Acknowledgements this pacer has added delay to. */
  paced: number;
  /** The largest delay it has asked any probe for. */
  maxDelayMs: number;
}

/**
 * Paces probes that are catching up, so one reconnecting fleet cannot stall everyone's live
 * ingestion (R-03).
 *
 * The ingestion queue's own `retryAfterMs` is a single global signal: it rises with queue depth
 * and asks *every* probe to slow down, live and replaying alike. That is the right control for
 * absolute capacity and the wrong one for fairness — a probe reporting a check that just ran
 * gets throttled exactly as hard as one dumping an hour of spool, and by the time the signal
 * rises the backlog it is complaining about has already been built.
 *
 * So this adds delay to *catch-up* acknowledgements only, in proportion to how many probes are
 * catching up at once. A batch with no backlog behind it is never paced here, which is what
 * "cannot stall live ingestion" means in practice: a probe that has caught up rejoins the fast
 * path on its very next batch.
 *
 * It converges without any coordination. Each probe reports its own remaining backlog, the
 * count of those falls as they finish, and the delay each is asked for falls with it.
 */
export class ReplayPacer {
  readonly #config: ReplayPacerConfig;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** Probe gid → when it last reported a backlog. */
  readonly #replaying = new Map<string, number>();
  #paced = 0;
  #maxDelayMs = 0;

  constructor(options: ReplayPacerOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'replay-pacer' });
    this.#now = options.now ?? Date.now;
  }

  stats(): ReplayPacerStats {
    this.#prune();
    return { replaying: this.#replaying.size, paced: this.#paced, maxDelayMs: this.#maxDelayMs };
  }

  /**
   * Extra delay for this probe's acknowledgement, in milliseconds.
   *
   * `backlog` is what the probe says is still on disk after the batch it just sent. Absent means
   * a probe that does not report one — treated as live, which is how it behaved before R-03.
   */
  pace(source: string, backlog: number | undefined): number {
    this.#prune();

    if (backlog === undefined || backlog === 0) {
      // Caught up, or never behind. Off the list immediately: a probe should not keep paying for
      // a backlog it has finished clearing.
      this.#replaying.delete(source);
      return 0;
    }

    this.#replaying.set(source, this.#now());

    const over = this.#replaying.size - this.#config.maxConcurrentProbes;
    if (over <= 0) return 0;

    // Capped, because beyond some point asking politely is not the tool any more: the queue's
    // own refusals are, and they do not depend on a probe choosing to honour a hint.
    const delay = Math.min(over * this.#config.stepMs, this.#config.maxDelayMs);
    this.#paced += 1;
    if (delay > this.#maxDelayMs) {
      this.#maxDelayMs = delay;
      this.#logger.info(
        { replaying: this.#replaying.size, delayMs: delay, source },
        'pacing catch-up so live results are not queued behind it',
      );
    }
    return delay;
  }

  /** A probe that stopped sending — disconnected, or finished — is no longer catching up. */
  #prune(): void {
    const cutoff = this.#now() - this.#config.idleAfterMs;
    for (const [source, seen] of this.#replaying) {
      if (seen < cutoff) this.#replaying.delete(source);
    }
  }
}
