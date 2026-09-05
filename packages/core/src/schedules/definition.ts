/**
 * What a schedule *is*, without a database (`M-09`).
 *
 * A schedule answers one question — "should this be monitored right now?" — and everything
 * else here exists to author, store or explain that answer. Pure, so the cases that are
 * genuinely hard (a period that wraps past Sunday midnight, a boundary that falls in the hour
 * a country skips every spring) are table-driven tests rather than a tree and a clock.
 *
 * **The canonical form is a list of half-open intervals in week-minutes**, counted from Monday
 * 00:00 local, sorted, disjoint and merged. Both authoring modes normalise into it, so the
 * evaluator has no wraparound to handle and two schedules that mean the same thing store the
 * same rows.
 */

/** Monday first, matching ISO 8601 and the grid every UI draws. */
export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const MINUTES_PER_DAY = 24 * 60;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/**
 * How far either side of a predicted edge the real one can be (`R21`, `R22`).
 *
 * **Two and a half hours, not ninety minutes.** `P-128` justified ninety with "which covers
 * every transition the zone database contains (the largest is an hour)", and that is not true:
 * `Antarctica/Troll` is a current IANA zone whose seasonal shift is *two* hours (UTC+00 in
 * winter, UTC+02 in summer). At ninety the scan missed its edge by half an hour in both
 * directions, and the backward walk had no fallback at all — it returned its floor, a minute at
 * which nothing happens. The margin above two hours is for a zone that grows a larger shift
 * without this constant being revisited.
 */
const SKEW_MINUTES = 150;

/** `[start, end)` in minutes from Monday 00:00. Half-open, so periods can abut without overlap. */
export interface WeekInterval {
  readonly start: number;
  readonly end: number;
}

/**
 * What the periods mean.
 *
 * The two source documents disagree, and rather than pick one and make the other wrong, the
 * polarity is stored: `CAPABILITIES.MD §5` describes a grid whose marked cells are when
 * monitoring runs, and `WORKFLOW.MD §8` gives its period-list example as *inactive* periods
 * (`fr:19:30-mo:06:05`, which is a weekend maintenance window and would be a strange thing to
 * be the only time a sensor is watched). Both are things operators want to write, one is the
 * complement of the other, and an editor that silently inverted what somebody typed would be
 * the worst of the three options.
 */
export type SchedulePolarity = 'active' | 'inactive';

/** Which editor last wrote this schedule. A UI hint; the evaluator never reads it. */
export type ScheduleAuthoring = 'grid' | 'periods';

export interface ScheduleDefinition {
  readonly periods: readonly WeekInterval[];
  readonly polarity: SchedulePolarity;
  /**
   * IANA zone, or `null` for the one the core process runs in.
   *
   * A schedule is a statement about local time — "office hours" moves with daylight saving or
   * it is not office hours — so it cannot be stored as UTC offsets. `null` is the default and
   * the right answer for a single-site installation; a name is what an installation watching
   * an office in another country needs, and nothing else gives it to them.
   */
  readonly timezone: string | null;
}

// -------------------------------------------------------------------------------------------
// Normalisation
// -------------------------------------------------------------------------------------------

/**
 * Sorts, clips and merges. The only way a `ScheduleDefinition` should ever be built.
 *
 * Intervals that touch are merged, so `mo:09:00-mo:12:00 mo:12:00-mo:17:00` stores as one
 * period and formats back as one. Intervals outside the week are clipped rather than rejected;
 * the parsers reject them, and this is the last line for a value that arrived some other way.
 */
export function normaliseIntervals(intervals: readonly WeekInterval[]): WeekInterval[] {
  const clipped = intervals
    .map((interval) => ({
      start: Math.max(0, Math.min(MINUTES_PER_WEEK, Math.trunc(interval.start))),
      end: Math.max(0, Math.min(MINUTES_PER_WEEK, Math.trunc(interval.end))),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: WeekInterval[] = [];
  for (const interval of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      if (interval.end > last.end)
        merged[merged.length - 1] = { start: last.start, end: interval.end };
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

/** How much of the week the periods cover. Used to refuse a schedule that never monitors. */
export function coveredMinutes(periods: readonly WeekInterval[]): number {
  return periods.reduce((total, period) => total + (period.end - period.start), 0);
}

// -------------------------------------------------------------------------------------------
// The period-list form: `ww:hh:mm-ww:hh:mm`
// -------------------------------------------------------------------------------------------

const PERIOD_PATTERN =
  /^(?<fromDay>[a-z]{2}):(?<fromHour>\d{2}):(?<fromMinute>\d{2})-(?<toDay>[a-z]{2}):(?<toHour>\d{2}):(?<toMinute>\d{2})$/;

function weekdayIndex(token: string): number {
  return WEEKDAYS.indexOf(token as Weekday);
}

function weekMinute(day: number, hour: number, minute: number): number {
  return day * MINUTES_PER_DAY + hour * 60 + minute;
}

/**
 * Parses `fr:19:30-mo:06:05 we:18:45-we:23:00` into canonical intervals.
 *
 * A period whose end is at or before its start wraps the week — Friday evening to Monday
 * morning is the example the specification gives, and it is the shape every maintenance window
 * has. It becomes two intervals here so that nothing downstream has to know about wrapping.
 *
 * Separators are spaces, commas or newlines, because this string is typed by a person and
 * insisting on exactly one of the three is a validation error that teaches nobody anything.
 */
export function parsePeriods(text: string): { periods: WeekInterval[] } | { problems: string[] } {
  const tokens = text
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return { problems: ['no periods given'] };

  const problems: string[] = [];
  const intervals: WeekInterval[] = [];

  for (const token of tokens) {
    const groups = PERIOD_PATTERN.exec(token)?.groups;
    if (groups === undefined) {
      problems.push(
        `"${token}" is not a period; the form is ww:hh:mm-ww:hh:mm, e.g. mo:09:00-fr:17:30`,
      );
      continue;
    }
    const from = weekdayIndex(groups['fromDay'] ?? '');
    const to = weekdayIndex(groups['toDay'] ?? '');
    if (from < 0) {
      problems.push(`"${groups['fromDay'] ?? ''}" is not a weekday; use ${WEEKDAYS.join(', ')}`);
      continue;
    }
    if (to < 0) {
      problems.push(`"${groups['toDay'] ?? ''}" is not a weekday; use ${WEEKDAYS.join(', ')}`);
      continue;
    }
    const fh = Number(groups['fromHour']);
    const fm = Number(groups['fromMinute']);
    const th = Number(groups['toHour']);
    const tm = Number(groups['toMinute']);
    // 24:00 is accepted as an end-of-day marker and nowhere else: `su:00:00-su:24:00` is how a
    // whole day is written, and the alternative is making people write mo:00:00 for it.
    if (fh > 23 || fm > 59) {
      problems.push(`"${token}" starts at an impossible time of day`);
      continue;
    }
    if (th > 24 || tm > 59 || (th === 24 && tm !== 0)) {
      problems.push(`"${token}" ends at an impossible time of day`);
      continue;
    }

    const start = weekMinute(from, fh, fm);
    const end = weekMinute(to, th, tm);
    if (end > start) {
      intervals.push({ start, end });
    } else {
      // Wraps past Sunday midnight. Two intervals, and the evaluator never learns it happened.
      intervals.push({ start, end: MINUTES_PER_WEEK });
      if (end > 0) intervals.push({ start: 0, end });
    }
  }

  if (problems.length > 0) return { problems };
  return { periods: normaliseIntervals(intervals) };
}

/** The canonical text form. Round-trips through `parsePeriods` — asserted in a test. */
export function formatPeriods(periods: readonly WeekInterval[]): string {
  return periods.map(formatInterval).join(' ');
}

function formatInterval(interval: WeekInterval): string {
  return `${formatPoint(interval.start, false)}-${formatPoint(interval.end, true)}`;
}

function formatPoint(minute: number, isEnd: boolean): string {
  // An end exactly on midnight belongs to the day it closes, not the one it opens: a period
  // running to Sunday midnight reads `su:24:00`, not `mo:00:00` of a week it never reaches.
  const atWeekEnd = isEnd && minute === MINUTES_PER_WEEK;
  const effective = atWeekEnd ? minute - 1 : minute;
  const day = Math.floor(effective / MINUTES_PER_DAY);
  const withinDay = atWeekEnd ? MINUTES_PER_DAY : minute - day * MINUTES_PER_DAY;
  const hour = Math.floor(withinDay / 60);
  const rest = withinDay % 60;
  return `${WEEKDAYS[day] ?? 'mo'}:${pad(hour)}:${pad(rest)}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

// -------------------------------------------------------------------------------------------
// The grid form: seven days of twenty-four hours
// -------------------------------------------------------------------------------------------

/** `grid[day][hour]`, Monday first. What the weekday × hour editor hands back. */
export type ScheduleGrid = readonly (readonly boolean[])[];

export function gridToIntervals(grid: ScheduleGrid): WeekInterval[] {
  const intervals: WeekInterval[] = [];
  for (let day = 0; day < 7; day += 1) {
    const row = grid[day] ?? [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (row[hour] === true) {
        intervals.push({ start: weekMinute(day, hour, 0), end: weekMinute(day, hour + 1, 0) });
      }
    }
  }
  return normaliseIntervals(intervals);
}

/**
 * The grid a schedule renders as, and whether that rendering is the whole truth.
 *
 * A cell is on only when the *entire* hour is monitored. A period list authored with minutes —
 * `fr:19:30-mo:06:05` — cannot be drawn on an hourly grid without rounding, so `exact` says so
 * and the UI can warn that switching to the grid editor will round rather than discovering it
 * after somebody saves.
 */
export function toGrid(definition: ScheduleDefinition): { grid: boolean[][]; exact: boolean } {
  const grid: boolean[][] = [];
  let exact = true;
  for (let day = 0; day < 7; day += 1) {
    const row: boolean[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const from = weekMinute(day, hour, 0);
      const covered = minutesActive(definition, from, from + 60);
      row.push(covered === 60);
      if (covered !== 0 && covered !== 60) exact = false;
    }
    grid.push(row);
  }
  return { grid, exact };
}

/** How many minutes of `[from, to)` this schedule monitors. */
function minutesActive(definition: ScheduleDefinition, from: number, to: number): number {
  let inside = 0;
  for (const period of definition.periods) {
    inside += Math.max(0, Math.min(to, period.end) - Math.max(from, period.start));
  }
  return definition.polarity === 'active' ? inside : to - from - inside;
}

// -------------------------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------------------------

/**
 * Whether a schedule can be saved, and why not.
 *
 * The rule worth having is the last one: a schedule that resolves to no monitored minutes at
 * all is not a schedule, it is a permanent outage with a name. Somebody would author it by
 * inverting a polarity, assign it to a group, and discover months later that nothing under it
 * had been watched — which is the failure this whole subsystem exists to make impossible.
 */
export function validateDefinition(definition: ScheduleDefinition): string[] {
  const problems: string[] = [];

  if (definition.periods.length === 0) {
    problems.push('a schedule with no periods says nothing; give it at least one');
  }
  for (const period of definition.periods) {
    if (period.start < 0 || period.end > MINUTES_PER_WEEK || period.end <= period.start) {
      problems.push(`the period ${formatInterval(period)} is not inside a week`);
    }
  }
  for (let i = 1; i < definition.periods.length; i += 1) {
    const previous = definition.periods[i - 1];
    const current = definition.periods[i];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      problems.push('periods overlap; normalise them before storing');
    }
  }
  if (definition.timezone !== null && !isKnownTimeZone(definition.timezone)) {
    problems.push(`"${definition.timezone}" is not a time zone this system knows`);
  }

  const covered = coveredMinutes(definition.periods);
  const monitored = definition.polarity === 'active' ? covered : MINUTES_PER_WEEK - covered;
  if (problems.length === 0 && monitored === 0) {
    problems.push(
      'this schedule would never monitor anything; that is a permanent pause, not a schedule',
    );
  }
  return problems;
}

export function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------
// Evaluation
// -------------------------------------------------------------------------------------------

const WEEKDAY_BY_LABEL: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // h23 rather than hour12:false: the latter renders midnight as 24 under some ICU builds,
      // which would put Monday 00:00 at week-minute 1440 and shift every schedule by a day.
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** The zone a definition is read in: its own, or the one the process runs in. */
export function zoneOf(definition: ScheduleDefinition): string {
  return definition.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Where an instant falls in the local week, in minutes from Monday 00:00.
 *
 * Via `Intl` rather than offset arithmetic, because the offset is the thing that changes: a
 * schedule that starts at 09:00 has to start at 09:00 in both halves of the year, and only the
 * zone database knows when that stopped meaning the same UTC hour.
 */
export function weekMinuteOf(at: Date, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(at);
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') day = WEEKDAY_BY_LABEL[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  // h23 should never produce 24, but a clamp costs nothing and a wrong week-minute is a sensor
  // paused on the wrong day.
  return weekMinute(day, hour % 24, minute);
}

export function isActiveAtWeekMinute(definition: ScheduleDefinition, minute: number): boolean {
  const inside = definition.periods.some((period) => minute >= period.start && minute < period.end);
  return definition.polarity === 'active' ? inside : !inside;
}

/** Whether this schedule monitors at this instant. The whole point of the module. */
export function isActiveAt(definition: ScheduleDefinition, at: Date): boolean {
  return isActiveAtWeekMinute(definition, weekMinuteOf(at, zoneOf(definition)));
}

/** Every minute at which the answer can change, sorted. */
export function boundaries(definition: ScheduleDefinition): number[] {
  const edges = new Set<number>();
  for (const period of definition.periods) {
    edges.add(period.start % MINUTES_PER_WEEK);
    edges.add(period.end % MINUTES_PER_WEEK);
  }
  return [...edges].sort((a, b) => a - b);
}

/**
 * The next instant this schedule's answer changes, or `null` if it never does.
 *
 * Wanted by the UI ("monitoring resumes at 09:00") and by `N-12`, which has to decide whether a
 * suppressed notification is worth holding. Not used by the sweep: sweeping on the wall-clock
 * minute is both simpler and immune to everything below.
 *
 * The arithmetic is week-minutes converted back to elapsed minutes, which is exact except
 * across a daylight-saving transition, where the local clock skips or repeats an hour. Rather
 * than reason about that, the candidate is *verified* — and verified in both directions
 * (`P-128`), because a transition moves the edge either way: an autumn repeat puts it later than
 * predicted, and a spring skip puts it earlier.
 *
 * **One forward scan for both directions** (`R21`). `P-128` branched on whether the candidate
 * already read as changed and, in that branch, walked backwards to the start of the *contiguous*
 * changed run — which is the first change only when the schedule does not flip again inside the
 * shifted window. `su:09:00-su:09:10 su:09:50-su:17:00` on a spring-forward Sunday landed the
 * candidate inside the second period, walked back to 09:50, and answered fifty minutes after
 * the 09:00 the schedule actually opens. Scanning forward from the floor for the first minute
 * that differs from now is the same answer in the ordinary case and the right one here.
 */
export function nextChangeAfter(definition: ScheduleDefinition, at: Date): Date | null {
  const zone = zoneOf(definition);
  const edges = boundaries(definition);
  if (edges.length === 0) return null;

  const current = weekMinuteOf(at, zone);
  const activeNow = isActiveAtWeekMinute(definition, current);
  // Every edge produces the same answer on both sides only when the schedule is constant —
  // `su:00:00-su:24:00` under polarity `inactive`, say, which pauses one day a week and does
  // change. A schedule with no edge that flips is one `validateDefinition` already refuses.
  const flips = edges.filter(
    (edge) =>
      isActiveAtWeekMinute(definition, edge) !==
      isActiveAtWeekMinute(definition, (edge + MINUTES_PER_WEEK - 1) % MINUTES_PER_WEEK),
  );
  if (flips.length === 0) return null;

  const ahead = flips.find((edge) => edge > current);
  const delta =
    ahead === undefined ? MINUTES_PER_WEEK - current + (flips[0] ?? 0) : ahead - current;

  const atMinute = Math.floor(at.getTime() / 60_000);
  const candidate = new Date((atMinute + delta) * 60_000);

  // **The prediction can be late as well as early** (`P-128`). Week-minutes are local time and
  // the delta is elapsed time, so a spring-forward between here and the edge means the edge
  // arrives sooner than predicted — the local clock skips 02:00 to 03:00, so thirteen local
  // hours are twelve real ones — and an autumn repeat means it arrives later. Either way the
  // true edge lies within one transition's worth of minutes of the candidate, so the first
  // minute at or after that floor which no longer reads as *now* is the answer, whichever side
  // of the candidate it falls.
  const from = Math.max(atMinute + 1, atMinute + delta - SKEW_MINUTES);
  for (let minute = from; minute <= atMinute + delta + SKEW_MINUTES; minute += 1) {
    const instant = new Date(minute * 60_000);
    if (isActiveAt(definition, instant) !== activeNow) return instant;
  }
  // Unreachable for any zone in the database. Returning the prediction is better than null,
  // which a caller would read as "never".
  return candidate;
}
