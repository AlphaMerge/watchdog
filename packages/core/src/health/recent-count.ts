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

/**
 * The smallest value seen in the last few minutes, on the same fixed ring (`P-232`).
 *
 * For a measurement whose error only ever goes one way. A probe's clock offset is read as the
 * time a message arrived less the time the probe says it sent it, and whatever delayed the
 * message — the network, a congested send buffer, a core busy writing — adds to that and never
 * subtracts. The smallest reading in the window is the one with the least delay on it, so a
 * single late message cannot make a probe look behind. The price is that a real change upwards
 * shows once the smaller readings before it have left the window, and a change downwards shows
 * at once.
 */
export class RecentMinimum {
  readonly #bucketMs: number;
  readonly #monotonicMs: () => number;
  readonly #minima: number[];
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
    this.#minima = new Array<number>(buckets).fill(Number.POSITIVE_INFINITY);
    this.#buckets = new Array<number>(buckets).fill(Number.NEGATIVE_INFINITY);
  }

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    const bucket = Math.floor(this.#monotonicMs() / this.#bucketMs);
    const size = this.#minima.length;
    const slot = ((bucket % size) + size) % size;
    if (this.#buckets[slot] !== bucket) {
      this.#buckets[slot] = bucket;
      this.#minima[slot] = value;
      return;
    }
    this.#minima[slot] = Math.min(this.#minima[slot] ?? value, value);
  }

  /** The smallest value added in the last window, or null when nothing was. */
  minimum(): number | null {
    const oldest = Math.floor(this.#monotonicMs() / this.#bucketMs) - this.#minima.length + 1;
    let smallest = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < this.#minima.length; slot += 1) {
      if ((this.#buckets[slot] ?? Number.NEGATIVE_INFINITY) >= oldest) {
        smallest = Math.min(smallest, this.#minima[slot] ?? Number.POSITIVE_INFINITY);
      }
    }
    return Number.isFinite(smallest) ? smallest : null;
  }
}

function hrtimeMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
