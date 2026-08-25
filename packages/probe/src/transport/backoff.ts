/**
 * Exponential backoff with full jitter for reconnects.
 *
 * Jitter is not decoration: a core restart disconnects every probe at the same instant, and
 * without it they would all return in lockstep and keep colliding. Full jitter (AWS's term:
 * `random(0, exponential)`) spreads them across the whole window.
 */
export interface BackoffOptions {
  minDelayMs: number;
  maxDelayMs: number;
  /** Injected in tests to make the sequence deterministic. */
  random?: () => number;
}

export class Backoff {
  readonly #minDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions) {
    this.#minDelayMs = options.minDelayMs;
    this.#maxDelayMs = options.maxDelayMs;
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** Call after a successful connection so the next outage starts from the bottom again. */
  reset(): void {
    this.#attempt = 0;
  }

  nextDelayMs(): number {
    const ceiling = Math.min(this.#maxDelayMs, this.#minDelayMs * 2 ** this.#attempt);
    this.#attempt += 1;
    // Never below minDelayMs: a tight loop against a refusing core is its own kind of outage.
    return Math.round(this.#minDelayMs + this.#random() * (ceiling - this.#minDelayMs));
  }
}
