/**
 * How many of something happened in the last few minutes, for a channel that must clear itself.
 *
 * **A gauge over a window, not a counter** (`P-231`). A counter channel is stored as a rate, and
 * the rate gaps on the first reading after the counter restarts or after a gap longer than the
 * rate allows: a core restart, a probe reconnecting after an outage. Whatever happened in that
 * interval is missed, and it is exactly the interval in which a probe with a wrong clock first
 * reports. A warning on the count itself would never clear. A count over a window does both: it
 * sees the first batch, and it falls to zero once the window has passed with nothing in it.
 *
 * **A fixed ring of buckets, so the memory is the same whatever the rate.** What is counted may
 * be sent by a probe that is misbehaving or hostile (`P-228`), and one entry an event would let
 * it decide how much the core holds. Each bucket is a sum. The price is resolution: the window
 * is exact to within one bucket, so sixty buckets over five minutes forget an event somewhere
 * between 295 and 300 seconds after it.
 *
 * On the monotonic clock, because this is a duration (`CLAUDE.md`): a wall-clock step would
 * empty the window early or hold it open.
 */
export class RecentCount {
  readonly #bucketMs: number;
  readonly #monotonicMs: () => number;
  /** The sum in each slot, and which bucket, counted from the clock's zero, it is the sum of. */
  readonly #sums: number[];
  readonly #buckets: number[];

  constructor(
    windowMs: number,
    options: { readonly buckets?: number; readonly monotonicMs?: () => number } = {},
  ) {
    const buckets = options.buckets ?? 60;
    if (!Number.isInteger(buckets) || buckets < 1 || !(windowMs > 0)) {
      throw new RangeError(`a window of ${String(windowMs)} ms in ${String(buckets)} buckets`);
    }
    this.#bucketMs = windowMs / buckets;
    this.#monotonicMs = options.monotonicMs ?? hrtimeMs;
    this.#sums = new Array<number>(buckets).fill(0);
    this.#buckets = new Array<number>(buckets).fill(Number.NEGATIVE_INFINITY);
  }

  add(n: number): void {
    if (!(n > 0)) return;
    const bucket = this.#current();
    const slot = this.#slot(bucket);
    if (this.#buckets[slot] !== bucket) {
      this.#buckets[slot] = bucket;
      this.#sums[slot] = 0;
    }
    this.#sums[slot] = (this.#sums[slot] ?? 0) + n;
  }

  /** How many were added in the last window: this bucket and the ones before it that fit. */
  count(): number {
    const oldest = this.#current() - this.#sums.length + 1;
    let total = 0;
    for (let slot = 0; slot < this.#sums.length; slot += 1) {
      if ((this.#buckets[slot] ?? Number.NEGATIVE_INFINITY) >= oldest) {
        total += this.#sums[slot] ?? 0;
      }
    }
    return total;
  }

  #current(): number {
    return Math.floor(this.#monotonicMs() / this.#bucketMs);
  }

  #slot(bucket: number): number {
    const size = this.#sums.length;
    return ((bucket % size) + size) % size;
  }
}

function hrtimeMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
