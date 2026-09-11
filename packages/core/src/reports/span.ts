import {
  MAX_RANGE_DAYS,
  SHORTENED_RANGE_DAYS,
  planSeries,
  type QueryAdjustment,
  type SeriesPlan,
} from '../timeseries/query.js';
import { isKnownTimeZone } from '../schedules/definition.js';
import { ReportError } from './errors.js';

/**
 * What period a report covers, and how that turns into an interval (`E-02`, `CAPABILITIES.MD §6`).
 *
 * **The three rules `§6` states are not implemented here, and that is the point.** "Over 500 days
 * is shortened to 365" and "40 to 500 days forces at least 60-minute averaging" are already in
 * `timeseries/query.ts`, where the history API and the sensor detail page get them; a second copy
 * beside a renderer is exactly the duplication `CLAUDE.md` forbids for inheritance, and the failure
 * mode is worse here — two copies that disagree mean a report and the graph a user checks it
 * against are drawn from different data and neither says so.
 *
 * So this module does the half `query.ts` cannot: **the calendar**. "Last month" is not a number of
 * milliseconds. It is 28, 29, 30 or 31 days long, it starts at local midnight in a zone somebody
 * chose, and in that zone one of its days may have had 23 or 25 hours. `planSeries` takes two
 * instants and knows nothing about any of that.
 *
 * ## Why the shortening rule is applied here rather than left to `planSeries`
 *
 * It is applied here **as well**, on the resolved window, using `query.ts`'s own constants — and
 * that is not a second implementation, it is moving one rule one step earlier. If a 600-day custom
 * span reached `planSeries` intact, the plan would quietly cover 365 days while the report's own
 * header still said 600. A graph that shortens its x-axis is self-evident; a PDF filed in a
 * compliance folder is not, and it is read by somebody who cannot check. **The window a report
 * names and the window it reads have to be the same window**, so the span is shortened before it
 * is labelled, and `planSeries` then finds nothing left to shorten.
 *
 * ## What "offset" means, and why it defaults to 1
 *
 * `offset` counts periods backwards: `1` is the last complete one, `2` the one before it, `0` the
 * one in progress. **The default is 1**, because a monthly report fires on the 1st at 02:00 and a
 * report of "this month" run then would cover two hours. `0` is offered because "month to date" is
 * a real thing somebody asks for by hand, and it is the only kind whose end is clamped to now —
 * for every other span the window is entirely in the past and already closed.
 */

export const REPORT_SPAN_KINDS = ['day', 'week', 'month', 'quarter', 'year', 'custom'] as const;

export type ReportSpanKind = (typeof REPORT_SPAN_KINDS)[number];

/**
 * How far back a named span reaches, at most.
 *
 * A thousand periods is past any retention this system keeps — `sample_1d` is governed by
 * `housekeeping.retention.dailyDays` — so beyond this the answer is certainly empty. The bound is
 * here to stop a typo resolving to the year 943 and spending a query proving it, not because 999
 * is meaningful.
 */
export const MAX_SPAN_OFFSET = 1_000;

export interface ReportSpan {
  readonly kind: ReportSpanKind;
  /** The zone the calendar is read in. Absent means the zone the core process runs in. */
  readonly timezone?: string;
  /** Periods back from now: 1 is the last complete one, 0 the one in progress. Named kinds only. */
  readonly offset?: number;
  /** `custom` only: ISO 8601 instants, `to` exclusive. */
  readonly from?: string;
  readonly to?: string;
  /**
   * A bucket width the author pinned, in seconds. Omitted means "whatever suits the range", which
   * is what nearly every report wants. Either way `planSeries` has the final say and says so.
   */
  readonly resolutionSeconds?: number;
}

export interface ReportWindow {
  readonly from: Date;
  /** Exclusive, so consecutive periods tile without overlapping by an instant. */
  readonly to: Date;
  readonly timezone: string;
  /**
   * What to print at the top of the output. ISO-shaped and **not localised**, deliberately: a
   * report is filed and read later, possibly by somebody in another country, and `2026-09` cannot
   * be misread the way `09/2026` and `2026/09` can. The zone is named because a window without one
   * is not a window.
   */
  readonly label: string;
  /** What the rules changed about the requested span. Never silent. */
  readonly adjustments: readonly QueryAdjustment[];
}

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ validation */

function invalid(message: string, details: Record<string, unknown> = {}): ReportError {
  return new ReportError('REPORT_INVALID', message, {
    context: { phase: 'span' },
    details,
  });
}

function isSpanKind(value: unknown): value is ReportSpanKind {
  return typeof value === 'string' && (REPORT_SPAN_KINDS as readonly string[]).includes(value);
}

/**
 * Checks a span document and returns it narrowed, or throws.
 *
 * Called on the write, like the security context and for the same reason: a span that resolves to
 * nothing is a report that fails on a schedule at 03:00, and the person who typed it is asleep.
 */
export function validateSpan(raw: unknown): ReportSpan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('a report span is an object naming a period');
  }
  const span = raw as Record<string, unknown>;

  if (!isSpanKind(span['kind'])) {
    throw invalid(`there is no report span called ${JSON.stringify(span['kind'])}`, {
      kind: span['kind'],
    });
  }
  const kind = span['kind'];

  const timezone = span['timezone'];
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !isKnownTimeZone(timezone)) {
      throw invalid(`${JSON.stringify(timezone)} is not a time zone this system knows`, {
        timezone,
      });
    }
  }

  const resolutionSeconds = span['resolutionSeconds'];
  if (resolutionSeconds !== undefined) {
    if (
      typeof resolutionSeconds !== 'number' ||
      !Number.isSafeInteger(resolutionSeconds) ||
      resolutionSeconds <= 0
    ) {
      throw invalid('a pinned averaging interval is a whole number of seconds', {
        resolutionSeconds,
      });
    }
  }

  const offset = span['offset'];
  if (kind === 'custom') {
    if (offset !== undefined) {
      throw invalid('a custom span names its own start and end, so it has no offset');
    }
    const from = readInstant(span['from'], 'from');
    const to = readInstant(span['to'], 'to');
    if (to.getTime() <= from.getTime()) {
      throw invalid('a custom span ends after it starts', {
        from: from.toISOString(),
        to: to.toISOString(),
      });
    }
    return {
      kind,
      from: span['from'] as string,
      to: span['to'] as string,
      ...(typeof timezone === 'string' ? { timezone } : {}),
      ...(typeof resolutionSeconds === 'number' ? { resolutionSeconds } : {}),
    };
  }

  if (span['from'] !== undefined || span['to'] !== undefined) {
    throw invalid(`a "${kind}" span is a calendar period, so it has no start and end of its own`);
  }
  if (offset !== undefined) {
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      (offset as number) > MAX_SPAN_OFFSET
    ) {
      throw invalid(
        `a span offset is 0 to ${String(MAX_SPAN_OFFSET)} periods back, where 1 is the last complete one`,
        { offset },
      );
    }
  }
  return {
    kind,
    ...(typeof offset === 'number' ? { offset } : {}),
    ...(typeof timezone === 'string' ? { timezone } : {}),
    ...(typeof resolutionSeconds === 'number' ? { resolutionSeconds } : {}),
  };
}

function readInstant(raw: unknown, field: string): Date {
  if (typeof raw !== 'string') {
    throw invalid(`a custom span needs "${field}" as an ISO 8601 instant`);
  }
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) {
    throw invalid(`"${raw}" is not an instant this system can read`, { [field]: raw });
  }
  return at;
}

/* ------------------------------------------------------------------ resolution */

/** The zone a span is read in: its own, or the one this process runs in. */
export function zoneOf(span: ReportSpan): string {
  return span.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Turns a span into the interval it names, as of `now`.
 *
 * `now` is a parameter rather than a call to the clock so this stays pure — the same span and the
 * same instant give the same window on any machine, which is what makes the table of cases below
 * a test rather than a description.
 */
export function resolveSpan(span: ReportSpan, now: Date): ReportWindow {
  const timezone = zoneOf(span);
  const adjustments: QueryAdjustment[] = [];

  let from: Date;
  let to: Date;
  let label: string;

  if (span.kind === 'custom') {
    // Re-read rather than trusted, even though `validateSpan` ran on the write. This function is
    // also called on whatever is in the `jsonb` column — a restored backup, a row somebody edited
    // by hand — and an unreadable instant reaching `planSeries` would throw a `QueryError` that
    // the report routes do not expect, turning one bad row into a 500 for the whole listing.
    from = readInstant(span.from, 'from');
    to = readInstant(span.to, 'to');
    if (to.getTime() <= from.getTime()) {
      throw invalid('a custom span ends after it starts', {
        from: from.toISOString(),
        to: to.toISOString(),
      });
    }
    label = `${wallClock(from, timezone)}/${wallClock(to, timezone)}`;
  } else {
    const offset = span.offset ?? 1;
    from = startOfPeriod(span.kind, now, timezone, offset);
    // The start of the following period, which makes `to` exclusive by construction: consecutive
    // months tile exactly, with no leap-second or 23-hour-day arithmetic to get wrong.
    to = startOfPeriod(span.kind, now, timezone, offset - 1);
    label = periodLabel(span.kind, from, timezone);
    if (offset === 0) {
      // The only clamp in this module. A period in progress ends now, not at its calendar end —
      // the alternative is a report whose last two weeks are empty and which does not say why.
      to = now < to ? now : to;
      label += ' to date';
    }
  }

  // `§6`'s first rule, applied to the resolved window rather than left to `planSeries`. See the
  // block comment at the top of this file. The label was written from the old `from`, so it has to
  // be written again here — a header naming a period the report does not contain is the whole
  // defect this placement exists to avoid.
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days > MAX_RANGE_DAYS) {
    from = new Date(to.getTime() - SHORTENED_RANGE_DAYS * DAY_MS);
    adjustments.push({
      kind: 'range-shortened',
      reason: `spans longer than ${String(MAX_RANGE_DAYS)} days are shortened to ${String(SHORTENED_RANGE_DAYS)}`,
      requestedDays: Math.round(days * 100) / 100,
      effectiveDays: SHORTENED_RANGE_DAYS,
    });
    label = `${wallClock(from, timezone)}/${wallClock(to, timezone)}`;
  }

  return { from, to, timezone, label: `${label} (${timezone})`, adjustments };
}

/**
 * The window and the query plan for it, with every adjustment either made along the way.
 *
 * The two lists are concatenated rather than merged: shortening the window and coarsening the
 * buckets are different things that happened to the same request, and a reader who is told only
 * the net effect cannot tell which rule they hit.
 */
export function planReportSpan(
  span: ReportSpan,
  now: Date,
): { window: ReportWindow; plan: SeriesPlan } {
  const window = resolveSpan(span, now);
  if (window.to.getTime() <= window.from.getTime()) {
    // Reachable, and not hypothetically: a monthly report with `offset: 0` run at 00:00:00 on the
    // 1st. Refusing is the honest answer — there is no month-to-date yet — and it beats rendering
    // an empty document that looks like an outage.
    throw invalid(`the span "${window.label}" covers no time yet`, { label: window.label });
  }
  const plan = planSeries({
    from: window.from,
    to: window.to,
    ...(span.resolutionSeconds === undefined ? {} : { resolutionSeconds: span.resolutionSeconds }),
  });
  return {
    window: { ...window, adjustments: [...window.adjustments, ...plan.adjustments] },
    plan,
  };
}

/* ------------------------------------------------------------------ the calendar */

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // `h23` rather than `hour12: false`, for the reason `schedules/definition.ts` records: the
      // latter renders midnight as 24 under some ICU builds, which would put the first instant of
      // a month at the end of the previous day.
      hourCycle: 'h23',
      era: 'short',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** Where an instant falls on the wall clock of a zone. */
function wallOf(at: Date, timezone: string): Wall {
  const parts = formatterFor(timezone).formatToParts(at);
  const wall: Wall = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const part of parts) {
    if (part.type === 'year') wall.year = Number(part.value);
    else if (part.type === 'month') wall.month = Number(part.value);
    else if (part.type === 'day') wall.day = Number(part.value);
    else if (part.type === 'hour') wall.hour = Number(part.value) % 24;
    else if (part.type === 'minute') wall.minute = Number(part.value);
    else if (part.type === 'second') wall.second = Number(part.value);
    else if (part.type === 'era') bc = part.value.startsWith('B');
  }
  // Proleptic years before 1 come back as "1 BC" with a positive year. Nothing in a monitoring
  // system reaches them, and silently reading them as AD would be worse than a wrong answer.
  if (bc) throw invalid('a report span cannot reach before the common era');
  return wall;
}

function asUtcMs(wall: Wall): number {
  const at = new Date(0);
  at.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  at.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return at.getTime();
}

/**
 * The instant at which a wall-clock time occurs in a zone.
 *
 * **Two candidates, because a wall-clock time is not always one instant — and sometimes it is
 * none.** The offset has to be sampled at the answer, not at the question, so the first guess is
 * taken at the nominal instant and the second at where that guess lands.
 *
 * - Both round-trip: the clock went back and this time happened twice. The **earlier** is taken —
 *   a day starts at its first midnight, and its second midnight belongs to the same day.
 * - One round-trips: the ordinary case, and the only one most zones ever produce.
 * - Neither: the clock jumped forward over this time and it never existed. The **later** is taken,
 *   which is the first instant that does exist. Zones really do this at midnight — `Asia/Beirut`
 *   still springs forward at 00:00, and a month there can begin at 01:00 — so "start of day" must
 *   not be assumed to be midnight anywhere in this file.
 */
function instantOf(timezone: string, wall: Wall): Date {
  const nominal = asUtcMs(wall);
  const firstOffset = asUtcMs(wallOf(new Date(nominal), timezone)) - nominal;
  const first = nominal - firstOffset;
  const secondOffset = asUtcMs(wallOf(new Date(first), timezone)) - first;
  const second = nominal - secondOffset;

  const firstFits = asUtcMs(wallOf(new Date(first), timezone)) === nominal;
  const secondFits = asUtcMs(wallOf(new Date(second), timezone)) === nominal;

  if (firstFits && secondFits) return new Date(Math.min(first, second));
  if (firstFits) return new Date(first);
  if (secondFits) return new Date(second);
  return new Date(Math.max(first, second));
}

/**
 * Civil-date arithmetic, done in UTC because UTC has no zones.
 *
 * `Date.UTC` is used purely as a Gregorian calculator here — it is what knows that 31 January plus
 * one month is not 31 February, and that 2028 has a 29th. No instant in this function means
 * anything until `instantOf` gives it a zone.
 */
function civil(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(0, 0, 0, 0);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** The first instant of the period of this kind that is `offset` periods before `now`. */
function startOfPeriod(
  kind: Exclude<ReportSpanKind, 'custom'>,
  now: Date,
  timezone: string,
  offset: number,
): Date {
  const today = wallOf(now, timezone);
  let date: { year: number; month: number; day: number };

  switch (kind) {
    case 'day':
      date = civil(today.year, today.month, today.day - offset);
      break;
    case 'week': {
      // ISO 8601: weeks start on Monday. Not configurable, and that is a decision rather than an
      // omission — a week boundary that differs between the report and the graph beside it would
      // make the two disagree by a day for no visible reason.
      const weekday = isoWeekday(today.year, today.month, today.day);
      date = civil(today.year, today.month, today.day - (weekday - 1) - offset * 7);
      break;
    }
    case 'month': {
      const index = today.year * 12 + (today.month - 1) - offset;
      date = civil(Math.floor(index / 12), (index % 12) + 1, 1);
      break;
    }
    case 'quarter': {
      const index = today.year * 4 + Math.floor((today.month - 1) / 3) - offset;
      date = civil(Math.floor(index / 4), (index % 4) * 3 + 1, 1);
      break;
    }
    case 'year':
      date = civil(today.year - offset, 1, 1);
      break;
  }

  return instantOf(timezone, { ...date, hour: 0, minute: 0, second: 0 });
}

/** 1 for Monday through 7 for Sunday, from a civil date. */
function isoWeekday(year: number, month: number, day: number): number {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(0, 0, 0, 0);
  return at.getUTCDay() === 0 ? 7 : at.getUTCDay();
}

function periodLabel(
  kind: Exclude<ReportSpanKind, 'custom'>,
  from: Date,
  timezone: string,
): string {
  const wall = wallOf(from, timezone);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  switch (kind) {
    case 'day':
      return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
    case 'week': {
      const { weekYear, week } = isoWeek(wall.year, wall.month, wall.day);
      return `${pad(weekYear, 4)}-W${pad(week)}`;
    }
    case 'month':
      return `${pad(wall.year, 4)}-${pad(wall.month)}`;
    case 'quarter':
      return `${pad(wall.year, 4)}-Q${String(Math.floor((wall.month - 1) / 3) + 1)}`;
    case 'year':
      return pad(wall.year, 4);
  }
}

/**
 * The ISO 8601 week-year and week number of a civil date.
 *
 * Via the Thursday of the same week, which is the definition rather than a trick: ISO week 1 is
 * the one containing the first Thursday of January, so the year of that Thursday *is* the week
 * year. This is why 2026-12-28 falls in week 1 of 2027 and printing `2026-W01` for it would be
 * wrong by a year.
 */
function isoWeek(year: number, month: number, day: number): { weekYear: number; week: number } {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(0, 0, 0, 0);
  const thursday = new Date(at.getTime() + (4 - isoWeekday(year, month, day)) * DAY_MS);
  const weekYear = thursday.getUTCFullYear();
  const january1 = new Date(0);
  january1.setUTCFullYear(weekYear, 0, 1);
  january1.setUTCHours(0, 0, 0, 0);
  return {
    weekYear,
    week: Math.floor((thursday.getTime() - january1.getTime()) / (7 * DAY_MS)) + 1,
  };
}

/** `2026-09-01T00:00` on the wall clock of a zone. Minutes, because no span is finer. */
function wallClock(at: Date, timezone: string): string {
  const wall = wallOf(at, timezone);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}`
  );
}
