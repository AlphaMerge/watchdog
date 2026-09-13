import {
  groupByUnit,
  layoutChart,
  type ChartChannel,
  type ChartLayout,
  type TimeTick,
} from '@ms/shared/charts';
import type { ReportKind } from './repository.js';
import { civil, instantOf, wallOf, type Wall } from './span.js';
import type { ReportSection } from './table.js';

/**
 * A report's graphs, from its document (`E-05`, `ADR-006` Decision 3).
 *
 * **Three things live here, and none of them is drawing.** Which templates draw a graph at all;
 * which instants on the time axis are round, in the report's own zone; and turning a section of
 * the document into the charts `@ms/shared/charts` lays out. The SVG in the HTML report and the
 * `pdfkit` calls in the PDF both start from what this file hands them.
 *
 * ## Why the time axis is decided here and not in the shared layout
 *
 * A tick at local midnight is calendar knowledge, and the calendar already lives in one place —
 * `span.ts`, whose `instantOf` knows that `Asia/Beirut` springs forward *at* midnight and that a
 * day in October has twenty-five hours. Teaching the chart layout a second calendar would be the
 * two-copies failure `ADR-006` exists to avoid, so this file offers the candidates and the layout
 * decides which of them fit.
 */

/** Whether a template draws graphs. `graph_and_table` and `graph_only` do; the rest do not. */
export function showsGraph(kind: ReportKind): boolean {
  return kind === 'graph_and_table' || kind === 'graph_only';
}

/**
 * Whether a template draws the data table in a document meant for reading.
 *
 * **Only HTML and PDF honour this.** CSV and XML are the data, for a spreadsheet and a script, and
 * a `graph_only` report exported as CSV would otherwise be an empty file — which is a report that
 * worked and told nobody anything.
 */
export function showsTable(kind: ReportKind): boolean {
  return kind !== 'graph_only';
}

/* ------------------------------------------------------------------ the time axis */

interface Step {
  readonly kind: 'hour' | 'day' | 'week' | 'month' | 'year';
  readonly every: number;
  /** Roughly how far apart its ticks are, to skip a step that would produce thousands. */
  readonly nominalMs: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Finest first, which is the order the layout tries them in. */
const STEPS: readonly Step[] = [
  { kind: 'hour', every: 1, nominalMs: HOUR_MS },
  { kind: 'hour', every: 3, nominalMs: 3 * HOUR_MS },
  { kind: 'hour', every: 6, nominalMs: 6 * HOUR_MS },
  { kind: 'hour', every: 12, nominalMs: 12 * HOUR_MS },
  { kind: 'day', every: 1, nominalMs: DAY_MS },
  { kind: 'day', every: 2, nominalMs: 2 * DAY_MS },
  { kind: 'week', every: 1, nominalMs: 7 * DAY_MS },
  { kind: 'month', every: 1, nominalMs: 30 * DAY_MS },
  { kind: 'month', every: 3, nominalMs: 91 * DAY_MS },
  { kind: 'year', every: 1, nominalMs: 365 * DAY_MS },
];

/**
 * A step with more candidates than this over the window is not offered. No chart can label four
 * hundred ticks legibly, and generating them costs calendar arithmetic for nothing.
 */
const MAX_CANDIDATES = 400;

const pad = (value: number): string => String(value).padStart(2, '0');

function ticksOf(step: Step, from: Date, to: Date, timezone: string): TimeTick[] {
  const first = wallOf(from, timezone);
  const last = wallOf(to, timezone);
  const start = from.getTime();
  const end = to.getTime();
  const ticks = new Map<number, TimeTick>();

  const offer = (wall: Wall, label: string): void => {
    const at = instantOf(timezone, wall).getTime();
    if (at < start || at > end || ticks.has(at)) return;
    // **An hour that did not happen is not ticked.** On the night the clocks go forward, 02:00
    // resolves to 03:00 — and labelling that instant "02:00" would put a wrong time on the axis of
    // a document whose whole purpose is to say when things happened. Midnight is the exception,
    // because it stands for the day, and `instantOf` already gives the day's first real instant.
    if (wall.hour !== 0 && wallOf(new Date(at), timezone).hour !== wall.hour) return;
    ticks.set(at, { at, label });
  };

  if (step.kind === 'month' || step.kind === 'year') {
    let year = first.year;
    let month = first.month;
    while (year < last.year || (year === last.year && month <= last.month)) {
      const wanted = step.kind === 'year' ? month === 1 : (month - 1) % step.every === 0;
      if (wanted) {
        offer(
          { year, month, day: 1, hour: 0, minute: 0, second: 0 },
          step.kind === 'year' ? String(year) : `${String(year)}-${pad(month)}`,
        );
      }
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return [...ticks.values()].sort((a, b) => a.at - b.at);
  }

  const lastKey = last.year * 10_000 + last.month * 100 + last.day;
  let day = civil(first.year, first.month, first.day);
  for (let index = 0; day.year * 10_000 + day.month * 100 + day.day <= lastKey; index += 1) {
    const dateLabel = `${pad(day.month)}-${pad(day.day)}`;
    if (step.kind === 'hour') {
      for (let hour = 0; hour < 24; hour += step.every) {
        // Midnight is labelled with the date, so an axis of hours still says which day it is.
        offer({ ...day, hour, minute: 0, second: 0 }, hour === 0 ? dateLabel : `${pad(hour)}:00`);
      }
    } else if (step.kind === 'day') {
      if (index % step.every === 0) offer({ ...day, hour: 0, minute: 0, second: 0 }, dateLabel);
    } else if (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() === 1) {
      // ISO weeks start on Monday, as `E-02`'s week spans do.
      offer({ ...day, hour: 0, minute: 0, second: 0 }, dateLabel);
    }
    day = civil(day.year, day.month, day.day + 1);
  }
  return [...ticks.values()].sort((a, b) => a.at - b.at);
}

/**
 * Candidate tick sets for a window, finest first, in its own zone.
 *
 * Computed once per document rather than per chart: every chart in a report covers the same
 * window, and a report over five hundred sensors would otherwise do the same calendar arithmetic
 * five hundred times.
 */
export function timeTicksFor(from: Date, to: Date, timezone: string): TimeTick[][] {
  const span = to.getTime() - from.getTime();
  const sets: TimeTick[][] = [];
  for (const step of STEPS) {
    if (span / step.nominalMs > MAX_CANDIDATES) continue;
    const ticks = ticksOf(step, from, to, timezone);
    if (ticks.length > 0) sets.push(ticks);
  }
  if (sets.length > 0) return sets;
  // A window too short to contain a round hour still says when it is.
  const wall = wallOf(from, timezone);
  return [[{ at: from.getTime(), label: `${pad(wall.hour)}:${pad(wall.minute)}` }]];
}

/* ---------------------------------------------------------------------- charts */

export interface ChartOptions {
  readonly width: number;
  readonly plotHeight: number;
  readonly fontSize: number;
  readonly measure: (text: string, size: number) => number;
  /**
   * Applied to every string the chart draws that an operator typed — a channel's name and unit.
   *
   * The PDF passes `drawable`, so a name the font cannot draw is written as `U+6771` in the legend
   * exactly as it is in the table. The SVG passes nothing: a browser falls back to a font that has
   * the glyph, which is the one thing a browser does better than a PDF.
   */
  readonly text?: (raw: string) => string;
}

/**
 * The charts for one section: one per unit, laid out for the width given.
 *
 * Empty for a section with no channels, which the document already explains in words.
 */
export function chartsFor(
  section: ReportSection,
  window: { readonly from: Date; readonly to: Date },
  ticks: readonly (readonly TimeTick[])[],
  options: ChartOptions,
): ChartLayout[] {
  if (section.columns.length === 0) return [];
  const text = options.text ?? ((raw: string): string => raw);
  const channels: ChartChannel[] = section.columns.map((column, index) => ({
    key: column.key,
    name: text(column.name),
    unit: text(column.unit),
    decimals: column.decimals,
    avg: section.rows.map((row) => row.values[index] ?? null),
    // Without a spread there is no band — the layout reads a missing edge as "not known", and the
    // extent falls back to the averages so the axis still fits what is drawn.
    min: section.spread?.[index]?.min ?? [],
    max: section.spread?.[index]?.max ?? [],
  }));
  const times = section.rows.map((row) => row.at.getTime());
  return groupByUnit(channels).map((group) =>
    layoutChart({
      group,
      times,
      from: window.from.getTime(),
      to: window.to.getTime(),
      timeTicks: ticks,
      width: options.width,
      plotHeight: options.plotHeight,
      measure: options.measure,
      fontSize: options.fontSize,
    }),
  );
}
