import { groupExtent, hasReadings, type ChartChannel, type ChartGroup } from './groups.js';
import { baselineExtent, formatTick, niceScale } from './scale.js';

/**
 * A chart's geometry, computed once and drawn twice (`E-05`, `ADR-006` Decision 3).
 *
 * A report's graph is drawn as SVG for the HTML document and as `pdfkit` primitives for the PDF.
 * **Both draw this**, so every decision a reader could notice — where an axis starts, which ticks
 * it has, where a line breaks, which labels fit — is made here, once, and a test can read it as
 * numbers. The drawing routines are left with nothing to decide, which is the same split `E-06`
 * made for pagination and for the same reason: a picture can only be checked by looking at it,
 * and geometry can be checked by a test.
 *
 * ## The rules this file keeps
 *
 * - **A gap breaks the line.** `CLAUDE.md`: no-data is not zero, and graphs break the line rather
 *   than draw it to the floor. A run of readings is a polyline; a missing bucket ends it.
 * - **A single reading between two gaps is a dot**, because a one-point polyline has no length and
 *   draws nothing — the easiest way there is to lose a measurement without anything failing.
 * - **Axis labels never overlap.** The time axis takes the finest set of candidate ticks whose
 *   labels fit side by side; the value axis takes as many ticks as the plot's height has room for.
 * - **A group with nothing in it is reported as empty**, and the caller says so in words.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A candidate on the time axis: an instant and what to call it. */
export interface TimeTick {
  readonly at: number;
  readonly label: string;
}

export interface ChartInput<C extends ChartChannel = ChartChannel> {
  readonly group: ChartGroup<C>;
  /** Bucket starts, epoch milliseconds, aligned to every channel's arrays. */
  readonly times: readonly number[];
  /** The period the chart covers; the x-axis spans exactly this. */
  readonly from: number;
  readonly to: number;
  /**
   * Candidate tick sets for the time axis, **finest first**.
   *
   * Supplied rather than computed here, because which instants are round — local midnight, the
   * first of the month — is calendar knowledge, and the calendar lives in one place already. This
   * file decides which of the sets fits.
   */
  readonly timeTicks: readonly (readonly TimeTick[])[];
  readonly width: number;
  /** The plotting area's height. Titles, labels and legend are added around it. */
  readonly plotHeight: number;
  /** Measures text at a size, in the same units as `width`. */
  readonly measure: (text: string, size: number) => number;
  readonly fontSize: number;
}

export interface ChartSeriesLayout {
  readonly key: string;
  readonly name: string;
  /** The fixed palette slot — see `seriesColour`. */
  readonly slot: number;
  /** Runs of two or more consecutive readings. A gap ends one. */
  readonly lines: readonly (readonly Point[])[];
  /** Readings with a gap on both sides, which a line cannot show. */
  readonly dots: readonly Point[];
  /** Closed min–max polygons, one per run where both edges are known. */
  readonly bands: readonly (readonly Point[])[];
  /** Nothing was recorded for this channel in the period. */
  readonly empty: boolean;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly plot: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly yTicks: readonly { readonly y: number; readonly label: string }[];
  readonly xTicks: readonly { readonly x: number; readonly label: string }[];
  /** The time labels' baseline. Decided here, so that neither drawing can put them somewhere else. */
  readonly xLabelY: number;
  readonly series: readonly ChartSeriesLayout[];
  /** Legend entries, for a chart of more than one series. One series is named by the title. */
  readonly legend: readonly {
    readonly x: number;
    readonly y: number;
    readonly slot: number;
    readonly label: string;
  }[];
  /** Every series in the group is empty: say so in words rather than draw a blank rectangle. */
  readonly empty: boolean;
}

/** Coordinates are rounded to a tenth: a report of a year of hourly data is otherwise mostly digits. */
const round = (value: number): number => Math.round(value * 10) / 10;

const GAP = 6;
const SWATCH = 10;

/** The title a chart is drawn under. One series names itself; several are named by their unit. */
function titleOf(group: ChartGroup): string {
  const [only] = group.series;
  if (group.series.length === 1 && only !== undefined) {
    return group.unit === '' ? only.channel.name : `${only.channel.name} (${group.unit})`;
  }
  return group.unit === '' ? 'Values' : group.unit;
}

/**
 * The finest tick set whose labels fit side by side, with a gap between them.
 *
 * If none fits — a very narrow chart — the coarsest set is thinned to every *n*th tick instead:
 * fewer labels are a lesser failure than labels drawn over each other.
 */
function pickTimeTicks(
  sets: readonly (readonly TimeTick[])[],
  place: (at: number) => number,
  measure: (text: string, size: number) => number,
  size: number,
  left: number,
  right: number,
): { x: number; label: string }[] {
  const inside = (set: readonly TimeTick[]): TimeTick[] =>
    set.filter((tick) => {
      const x = place(tick.at);
      return x >= left - 0.5 && x <= right + 0.5;
    });
  const fits = (set: readonly TimeTick[]): boolean => {
    for (let index = 1; index < set.length; index += 1) {
      const before = set[index - 1];
      const after = set[index];
      if (before === undefined || after === undefined) continue;
      const room = place(after.at) - place(before.at);
      const needed = (measure(before.label, size) + measure(after.label, size)) / 2 + GAP;
      if (room < needed) return false;
    }
    return true;
  };
  const shaped = (set: readonly TimeTick[]) =>
    set.map((tick) => ({ x: round(place(tick.at)), label: tick.label }));

  const candidates = sets.map(inside).filter((set) => set.length > 0);
  for (const set of candidates) if (fits(set)) return shaped(set);
  const coarsest = candidates.at(-1) ?? [];
  for (let stride = 2; stride <= coarsest.length; stride += 1) {
    const thinned = coarsest.filter((_, index) => index % stride === 0);
    if (fits(thinned)) return shaped(thinned);
  }
  return shaped(coarsest.slice(0, 1));
}

/** Splits aligned values into runs of consecutive readings. */
function runsOf(
  times: readonly number[],
  values: (index: number) => number | null,
): { index: number; time: number; value: number }[][] {
  const runs: { index: number; time: number; value: number }[][] = [];
  let current: { index: number; time: number; value: number }[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const value = values(index);
    const time = times[index];
    if (value === null || time === undefined || !Number.isFinite(value)) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push({ index, time, value });
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

export function layoutChart<C extends ChartChannel>(input: ChartInput<C>): ChartLayout {
  const { group, measure, fontSize: size } = input;
  const title = titleOf(group);
  const lineHeight = size * 1.4;
  const empty = !group.series.some(({ channel }) => hasReadings(channel));

  // The value axis. Its tick count comes from the plot's height: about one label per two and a
  // half lines, and never fewer than three — two ticks are an interval, not an axis.
  const extent = groupExtent(group) ?? { low: 0, high: 1 };
  const target = Math.min(8, Math.max(3, Math.floor(input.plotHeight / (lineHeight * 2.5))));
  const scale = niceScale(baselineExtent(extent).low, baselineExtent(extent).high, target);
  const yLabels = scale.ticks.map((value) => formatTick(value, scale.decimals));
  let yLabelWidth = 0;
  for (const label of yLabels) yLabelWidth = Math.max(yLabelWidth, measure(label, size));

  // The legend, for more than one series, wrapped across as many rows as the width needs.
  const legendItems =
    group.series.length > 1
      ? group.series.map(({ channel, slot }) => ({
          slot,
          label: channel.name,
          width: SWATCH + 4 + measure(channel.name, size),
        }))
      : [];

  // **Room for half a time label on either side of the plot.** A label is centred on its tick, and
  // the period's first and last instants are ticks — so a plot that ran to the edge of the chart
  // put half of its last date outside the drawing, where it was clipped to `09-0`. The widest
  // candidate is used rather than the set that will be picked, because which set fits depends on
  // the plot's width, and the plot's width is what is being decided.
  let halfLabel = 0;
  for (const set of input.timeTicks) {
    for (const tick of set) halfLabel = Math.max(halfLabel, measure(tick.label, size) / 2);
  }
  const top = lineHeight + GAP;
  const left = Math.max(yLabelWidth + GAP * 1.5, halfLabel);
  const right = input.width - Math.max(GAP, halfLabel);
  const bottom = top + input.plotHeight;

  const legend: { x: number; y: number; slot: number; label: string }[] = [];
  let legendX = left;
  let legendRow = 0;
  // A full line clear of the time labels, whose baseline is a line below the plot: a legend that
  // started half a line lower than that drew its swatches over the dates.
  const legendTop = bottom + lineHeight * 2 + GAP;
  for (const item of legendItems) {
    if (legendX > left && legendX + item.width > input.width) {
      legendRow += 1;
      legendX = left;
    }
    legend.push({
      x: round(legendX),
      y: round(legendTop + legendRow * lineHeight),
      slot: item.slot,
      label: item.label,
    });
    legendX += item.width + GAP * 2;
  }
  const height =
    legendItems.length > 0
      ? legendTop + legendRow * lineHeight + size * 0.4 + GAP
      : bottom + lineHeight + GAP;

  const span = Math.max(1, input.to - input.from);
  const placeX = (at: number): number => left + ((at - input.from) / span) * (right - left);
  const range = scale.max - scale.min || 1;
  const placeY = (value: number): number => bottom - ((value - scale.min) / range) * (bottom - top);

  const series: ChartSeriesLayout[] = group.series.map(({ channel, slot }) => {
    const lines: Point[][] = [];
    const dots: Point[] = [];
    for (const run of runsOf(input.times, (index) => channel.avg[index] ?? null)) {
      const points = run.map(({ time, value }) => ({
        x: round(placeX(time)),
        y: round(placeY(value)),
      }));
      const [first] = points;
      if (points.length === 1 && first !== undefined) dots.push(first);
      else lines.push(points);
    }
    const bands: Point[][] = [];
    const bothEdges = (index: number): number | null => {
      const low = channel.min[index] ?? null;
      const high = channel.max[index] ?? null;
      return low === null || high === null ? null : 1;
    };
    for (const run of runsOf(input.times, bothEdges)) {
      if (run.length < 2) continue;
      const upper = run.map(({ time, index }) => ({
        x: round(placeX(time)),
        y: round(placeY(channel.max[index] ?? 0)),
      }));
      const lower = run
        .map(({ time, index }) => ({
          x: round(placeX(time)),
          y: round(placeY(channel.min[index] ?? 0)),
        }))
        .reverse();
      bands.push([...upper, ...lower]);
    }
    return {
      key: channel.key,
      name: channel.name,
      slot,
      lines,
      dots,
      bands,
      empty: !hasReadings(channel),
    };
  });

  return {
    width: input.width,
    height: round(height),
    title,
    plot: { left: round(left), top: round(top), right: round(right), bottom: round(bottom) },
    yTicks: scale.ticks.map((value, index) => ({
      y: round(placeY(value)),
      label: yLabels[index] ?? '',
    })),
    xTicks: pickTimeTicks(input.timeTicks, placeX, measure, size, left, right),
    xLabelY: round(bottom + lineHeight),
    series,
    legend,
    empty,
  };
}
