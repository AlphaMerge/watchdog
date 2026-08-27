/**
 * Turning a counter into a rate (`T-02`).
 *
 * An interface reports octets *since it was last reset*, not octets per second. What an operator
 * wants graphed, limited and alarmed on is the rate, so somewhere the difference between two
 * readings has to be divided by the time between them — and that means remembering the last one.
 *
 * **It is remembered here, in the core, rather than on the probe.** Three reasons, and the third
 * is the one that settles it:
 *
 * 1. A check runs in whichever worker is free, so per-worker state would give a sensor its own
 *    previous reading only when it happened to land on the same thread twice.
 * 2. Probe restarts are routine — every upgrade — and probe-side state would lose the baseline
 *    for every interface on the box each time, costing a sample per interface per restart.
 * 3. This is exactly what `M-07` already describes: what happens to a reading between arriving
 *    and being judged. A counter is a reading that needs one more thing known about it.
 *
 * **The rate is what is stored, and the counter is not.** `scaling.ts` states the rule this
 * follows: one number, so a chart can never disagree with the alarm that fired. The raw counter
 * lives in `channel_counter` as a baseline for the next reading and nowhere else.
 */

/** How many bits the device's counter wraps at. SNMP has both, and they behave differently. */
export type CounterBits = 32 | 64;

const MODULUS: Readonly<Record<CounterBits, bigint>> = {
  32: 1n << 32n,
  64: 1n << 64n,
};

/**
 * How long a gap may be before the baseline is thrown away rather than divided across.
 *
 * A backstop, not the real defence. After an outage a 32-bit counter may have wrapped many
 * times, and nothing in the reading says how many — so a delta measured across an hour is a
 * number with no meaning rather than an average. Re-baselining loses one sample and reports a
 * gap, which is true, where dividing would report a figure that is confidently wrong.
 */
export const MAX_GAP_MS = 3_600_000;

export interface CounterSample {
  readonly value: bigint;
  readonly at: Date;
}

/**
 * What one counter reading amounted to.
 *
 * Only `rate` produces a sample. Everything else is a *gap*: CLAUDE.md's rule is that no-data is
 * not zero, and every one of these is a case where the honest answer is "no reading", not a
 * number somebody would then set a limit against.
 */
export type CounterOutcome =
  | {
      readonly kind: 'rate';
      readonly perSecond: number;
      readonly delta: bigint;
      /** True when the counter went round. Worth surfacing: on 32 bits it is routine. */
      readonly wrapped: boolean;
    }
  /** No previous reading. The first scan of a counter establishes the baseline and reports it. */
  | { readonly kind: 'first' }
  /** The counter went backwards in a way a wrap does not explain — a reboot, or a re-index. */
  | { readonly kind: 'reset' }
  /** Too long since the last reading to divide across. */
  | { readonly kind: 'stale'; readonly elapsedMs: number }
  /** Two readings at the same instant, or a clock that went backwards. */
  | { readonly kind: 'no-elapsed'; readonly elapsedMs: number };

export interface CounterOptions {
  /**
   * The most this counter could plausibly advance per second — an interface's capacity, in the
   * counter's own unit.
   *
   * What it is for: a **32-bit** counter that has gone backwards is ambiguous. It may have
   * wrapped, which at these widths is routine, or the device may have restarted. Correcting for
   * a wrap when it was really a reset invents a delta of up to 4.29 billion, which draws a spike
   * an operator will chase. If the corrected rate is above what the link can carry, it was a
   * reset. Without a bound the wrap is assumed, which is the right guess in the ordinary case.
   */
  readonly maxPerSecond?: number;
  readonly maxGapMs?: number;
}

/**
 * The rate implied by two readings, or the reason there is not one.
 *
 * **A 64-bit counter that goes backwards is a reset, never a wrap**, and this is the asymmetry
 * worth knowing. `ifHCInOctets` at 100 Gbit/s takes about forty-six years to go round; at a
 * terabit, four and a half. So the wrap is not a thing that happens, while a device rebooting
 * overnight is, and "correct for the wrap" would turn a reboot into a single sample reporting
 * roughly 1.8×10^19 octets — a spike that dwarfs the axis and hides the real traffic for the
 * whole retention window.
 *
 * A **32-bit** counter is the opposite: 2^32 octets is 4.29 GB, which a gigabit link passes in
 * thirty-four seconds. Wrapping is the normal case and correcting for it is the whole job. It is
 * also why RFC 2863 says these are unusable above about 20 Mbit/s and why the HC counters exist:
 * across a 60-second interval a gigabit link wraps *twice*, and a single wrap correction then
 * under-reports by exactly 2^32 with nothing in the reading to say so. The sensor prefers the
 * 64-bit counters for this reason and says which it used.
 */
export function rateFrom(
  previous: CounterSample | null,
  current: CounterSample,
  bits: CounterBits,
  options: CounterOptions = {},
): CounterOutcome {
  if (previous === null) return { kind: 'first' };

  const elapsedMs = current.at.getTime() - previous.at.getTime();
  if (elapsedMs <= 0) return { kind: 'no-elapsed', elapsedMs };
  if (elapsedMs > (options.maxGapMs ?? MAX_GAP_MS)) return { kind: 'stale', elapsedMs };

  const seconds = elapsedMs / 1_000;

  if (current.value >= previous.value) {
    const delta = current.value - previous.value;
    return { kind: 'rate', perSecond: Number(delta) / seconds, delta, wrapped: false };
  }

  // Backwards from here on.
  if (bits === 64) return { kind: 'reset' };

  const delta = MODULUS[32] - previous.value + current.value;
  const perSecond = Number(delta) / seconds;
  if (options.maxPerSecond !== undefined && perSecond > options.maxPerSecond) {
    // Faster than the link can go, so the wrap correction is wrong and the device restarted.
    return { kind: 'reset' };
  }
  return { kind: 'rate', perSecond, delta, wrapped: true };
}

/**
 * A counter as it arrived on the wire.
 *
 * Decimal text rather than a number, because `ifHCInOctets` is the counter that exists to go
 * past 2^53 — a 100 Gbit/s link passes it in about nine days — and that is exactly where a
 * double starts dropping low bits. Parsing here is the last place the exact value is available.
 */
export function parseCounter(text: string): bigint | null {
  if (!/^\d{1,20}$/.test(text)) return null;
  try {
    const value = BigInt(text);
    return value < 0n || value >= MODULUS[64] ? null : value;
  } catch {
    /* c8 ignore next -- the regex already guarantees BigInt accepts it */
    return null;
  }
}
