/**
 * What happens to a reading between arriving and being judged (`M-07`).
 *
 * `WORKFLOW.MD §3` draws it as one box — "apply scaling, spike filter, lookups" — feeding the
 * next, "evaluate channel error/warning limits". This is the first half of that box. The order
 * inside it is load-bearing and stated here because nothing else states it:
 *
 *   1. **Scale.** `value × mul ÷ div`. A device reports bytes and the operator wants bits; a
 *      thermometer reports centidegrees and the operator wants degrees.
 *   2. **Spike filter.** Discard the reading if it falls outside `[min, max]`.
 *   3. Only then §2.2 — limits and lookups — sees it.
 *
 * **Scaling before the spike filter**, because both bounds and thresholds are numbers an
 * operator types in the channel's own unit. A spike bound that meant one thing and a limit that
 * meant another would be two units in one form, and the resulting bug reads as "the filter is
 * ignoring my setting". *Decided by `M-07`.*
 *
 * **The scaled value is what is stored.** One number: what was written is what was judged is
 * what is drawn. Storing raw and scaling on read is defensible — the rollup aggregates are all
 * linear, so it would work — but it puts two representations of one measurement in the system,
 * and that is how a chart says 40 while the alarm that fired says 320. The cost is that
 * changing a factor does not rewrite history, so the graph steps at the moment of the change;
 * that is true of every monitoring system, and it is visible rather than subtle.
 */

/** The per-channel configuration this applies. Parsed once, when the channel is resolved. */
export interface ReadingTransform {
  /** `numeric` in the column; a float here, because the reading it multiplies is one too. */
  readonly scaleMul: number;
  readonly scaleDiv: number;
  /** Readings outside this range are discarded. `null` is that side unbounded. */
  readonly spikeMin: number | null;
  readonly spikeMax: number | null;
}

export const NO_TRANSFORM: ReadingTransform = {
  scaleMul: 1,
  scaleDiv: 1,
  spikeMin: null,
  spikeMax: null,
};

/** True when the transform would leave every reading exactly as it found it. */
export function isIdentity(transform: ReadingTransform): boolean {
  return (
    transform.scaleMul === 1 &&
    transform.scaleDiv === 1 &&
    transform.spikeMin === null &&
    transform.spikeMax === null
  );
}

/**
 * Reads what is in the `numeric` columns.
 *
 * `numeric` arrives as a string so nothing rounds it in transit. It becomes a float here
 * because the reading it is about to multiply is a float, and pretending otherwise would be
 * precision theatre: the arithmetic is float64 either way.
 */
export function parseTransform(row: {
  scale_mul: string | number | null;
  scale_div: string | number | null;
  spike_min: number | null;
  spike_max: number | null;
}): ReadingTransform {
  return {
    scaleMul: factor(row.scale_mul),
    scaleDiv: factor(row.scale_div),
    spikeMin: row.spike_min,
    spikeMax: row.spike_max,
  };
}

/** A factor that is missing, unparseable or zero is no factor. Never a division by zero. */
function factor(value: string | number | null): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : 1;
}

export type TransformResult =
  | { readonly kind: 'kept'; readonly value: number }
  /** Outside the spike range, or not a number at all. Stored nowhere, counted always. */
  | { readonly kind: 'discarded'; readonly reason: 'spike' | 'not-a-number' };

/**
 * Scales a reading and decides whether to keep it.
 *
 * A discarded reading leaves a **gap**, not a zero — the same rule a failed check follows
 * (CLAUDE.md: "no-data is not zero"). A spike filter exists because a wrapped counter reporting
 * four billion would otherwise flatten a graph for a day; writing a zero in its place would
 * simply move the lie.
 */
export function transformReading(value: number, transform: ReadingTransform): TransformResult {
  if (!Number.isFinite(value)) return { kind: 'discarded', reason: 'not-a-number' };

  const scaled = (value * transform.scaleMul) / transform.scaleDiv;
  // Scaling by a factor large enough to overflow is a configuration error, not a reading, and
  // storing Infinity would poison every average it ever lands in.
  if (!Number.isFinite(scaled)) return { kind: 'discarded', reason: 'not-a-number' };

  if (transform.spikeMin !== null && scaled < transform.spikeMin) {
    return { kind: 'discarded', reason: 'spike' };
  }
  if (transform.spikeMax !== null && scaled > transform.spikeMax) {
    return { kind: 'discarded', reason: 'spike' };
  }
  return { kind: 'kept', value: scaled };
}

/**
 * What is wrong with a channel's processing settings, in words, or an empty list.
 *
 * The schema checks each field; these are the rules that need two of them. The database has
 * `CHECK` constraints for the same things — a factor of zero and an inverted spike range — and
 * both exist on purpose: the constraint is the guarantee, and this is the message that tells an
 * operator what they did instead of surfacing a 500 from the driver.
 */
export function validateTransform(transform: ReadingTransform, decimals: number | null): string[] {
  const problems: string[] = [];

  if (!Number.isFinite(transform.scaleMul) || transform.scaleMul === 0) {
    problems.push('the multiplication factor must be a non-zero number');
  }
  if (!Number.isFinite(transform.scaleDiv) || transform.scaleDiv === 0) {
    problems.push('the division factor must be a non-zero number');
  }
  if (
    transform.spikeMin !== null &&
    transform.spikeMax !== null &&
    transform.spikeMin > transform.spikeMax
  ) {
    problems.push(
      `the spike range is inverted: ${String(transform.spikeMin)} is above ` +
        `${String(transform.spikeMax)}, so every reading would be discarded`,
    );
  }
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 10)) {
    problems.push('decimal places must be a whole number between 0 and 10, or null for automatic');
  }
  return problems;
}
