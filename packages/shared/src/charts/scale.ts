/**
 * A y-axis a reader trusts (`E-05`).
 *
 * `ADR-006` Decision 3 named this as the part that is easy to get almost right: "a y-axis labelled
 * 0, 33, 67, 100 is a chart nobody trusts." Ticks here are always one, two or five times a power of
 * ten, and they are whole multiples of that step — so the labels are 0, 25, 50, 75, 100 or
 * 0, 0.5, 1.0, 1.5, and never a value somebody has to take on faith.
 */

export interface NiceScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly number[];
  /** How many decimals the step needs, so that neighbouring labels never read the same. */
  readonly decimals: number;
}

/** 1, 2 or 5 × 10ⁿ at or above `value`. */
function niceStep(value: number): { step: number; exponent: number } {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice === 10
    ? { step: 10 ** (exponent + 1), exponent: exponent + 1 }
    : { step: nice * 10 ** exponent, exponent };
}

/**
 * The scale for an extent, with about `target` ticks.
 *
 * **A flat series still gets an axis.** `low === high` — a sensor that read 42 all month — would
 * divide by zero, and a chart that cannot draw a flat line cannot draw the most boring and most
 * common thing a monitoring system shows. The range is opened around the value instead.
 */
export function niceScale(low: number, high: number, target: number): NiceScale {
  let from = low;
  let to = high;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    from = 0;
    to = 1;
  }
  if (from > to) [from, to] = [to, from];
  if (from === to) {
    const pad = from === 0 ? 1 : Math.abs(from) * 0.1;
    from -= from === 0 ? 0 : pad;
    to += pad;
  }
  const count = Math.max(2, Math.floor(target));
  const { step, exponent } = niceStep((to - from) / (count - 1));
  const decimals = Math.max(0, -exponent);
  // Rounded through the step's own precision, so that 0.1 + 0.2 is drawn as 0.3 and a tick at
  // 3 × 0.1 does not become 0.30000000000000004 in a label.
  const fix = (value: number): number => Number(value.toFixed(decimals));
  const min = fix(Math.floor(from / step) * step);
  const max = fix(Math.ceil(to / step) * step);
  const ticks: number[] = [];
  for (let index = 0; min + index * step <= max + step / 2; index += 1) {
    ticks.push(fix(min + index * step));
  }
  return { min, max, step, ticks, decimals };
}

/**
 * Where the axis starts.
 *
 * **At zero, for data that never goes below it.** Nearly everything a monitoring system measures
 * is a non-negative magnitude — latency, traffic, loss, load — and an axis fitted to the data turns
 * a response time that wandered between 243 and 245 ms into a chart that looks like an outage. A
 * report is read later, by somebody who cannot zoom out, and that is the misreading it invites
 * most. The cost is real and accepted: a temperature holding between 20 and 25 °C sits in the top
 * fifth of its chart. Data that crosses zero, or sits wholly below it, is fitted as it is.
 */
export function baselineExtent(extent: { low: number; high: number }): {
  low: number;
  high: number;
} {
  if (extent.low >= 0) return { low: 0, high: extent.high };
  if (extent.high <= 0) return { low: extent.low, high: 0 };
  return extent;
}

/** A tick's label, at the precision its step needs — not the channel's, which may be coarser. */
export function formatTick(value: number, decimals: number): string {
  // `-0` is a real IEEE value and reads as a sign error on an axis.
  const rendered = (Object.is(value, -0) ? 0 : value).toFixed(decimals);
  return rendered === '-0' || /^-0\.0+$/u.test(rendered) ? rendered.slice(1) : rendered;
}
