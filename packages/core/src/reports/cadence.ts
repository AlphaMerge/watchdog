import { isActiveAt, isKnownTimeZone, type ScheduleDefinition } from '../schedules/definition.js';
import { nextRun as nextShortRun, type CadenceSpec } from '../schedules/cadence.js';
import { ReportError } from './errors.js';
import { civil, instantOf, wallOf } from './span.js';

/**
 * When a report next runs (`E-08`, `CAPABILITIES.MD §6`).
 *
 * `§6` asks for six frequencies, and they are not one mechanism:
 *
 * - **Hourly, daily and weekly** are `schedules/cadence.ts`'s, unchanged. That module already
 *   knows that 02:30 on the morning the clocks go forward must not be skipped and that 01:30 on
 *   the morning they go back must not fire twice, and a second implementation would have to learn
 *   both again — badly, and only after somebody noticed a nightly job running twice.
 * - **Monthly, quarterly and annual** cannot use it, and the reason is mechanical rather than a
 *   preference: that module finds the next firing by scanning forward a minute at a time, bounded
 *   at a week. A year is half a million minutes and half a million calls into the zone database.
 *   These are computed instead — the civil date first, then one resolution to an instant through
 *   the same `instantOf` that `E-02` uses for the start of a month, so "the 1st at 02:00 in
 *   Beirut" lands correctly on the morning that has no midnight.
 *
 * **The day is clamped, never skipped.** A monthly report on the 31st runs on the 28th of February
 * — or the 29th — rather than not running that month. The alternative is a monthly report that
 * silently has no February, which is the month somebody eventually asks about.
 *
 * **A `M-09` schedule is a permission window, not the cadence.** `§4` says a schedule's inactive
 * periods pause reports as well as monitoring, and that is exactly what a window is good at:
 * "monthly on the 1st at 02:00, but not during the change freeze" is one sentence made of two
 * mechanisms rather than a third mechanism that means both.
 */

export const REPORT_FREQUENCIES = [
  'manual',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annual',
] as const;

export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** The frequencies `schedules/cadence.ts` already answers. */
const SHORT = new Set<ReportFrequency>(['hourly', 'daily', 'weekly']);

export interface ReportSchedule {
  readonly kind: ReportFrequency;
  /** Minutes past the hour for `hourly`, past midnight for everything coarser. */
  readonly minute?: number;
  /** 0 = Monday. `weekly` only. */
  readonly weekday?: number;
  /** 1 to 31, clamped to the last day of a short month. `monthly`, `quarterly`, `annual`. */
  readonly dayOfMonth?: number;
  /** 1 = January. `annual` only; `quarterly` always fires in January, April, July and October. */
  readonly month?: number;
  /** IANA zone, or absent for the core's own. */
  readonly timezone?: string;
  /**
   * A `M-09` schedule id whose active periods gate this (`§4`).
   *
   * Absent means always allowed. Present means a booking that lands outside an active period is
   * moved, never dropped — see `nextReportRun`.
   */
  readonly scheduleId?: number;
}

const MINUTES_PER_DAY = 1_440;

/**
 * How long past its hour a coarse booking may be pushed by a closed window.
 *
 * **A week, because a window *is* a week.** `M-09`'s schedule is a weekly calendar, so seven days
 * from any instant covers every minute it has: if none of them is active, the schedule is never
 * active and the answer is "never" rather than "later". Any shorter bound is arbitrary, and the
 * obvious one — a day — is wrong in a way that only shows up in production: a monthly report on
 * the 1st with an "office hours" window would run only in the months whose 1st happens to be a
 * weekday, and silently skip the rest. Found by the test that asks for the booking after a
 * blocked one.
 *
 * Seven days also cannot reach the next firing of a monthly, quarterly or annual report, so a
 * delayed run can never collide with the one after it.
 */
const WINDOW_GRACE_MINUTES = 7 * MINUTES_PER_DAY;

/** How many periods forward to look before calling it never. */
const MAX_PERIODS = 64;

/* -------------------------------------------------------------------- validation */

function invalid(message: string, details: Record<string, unknown> = {}): ReportError {
  return new ReportError('REPORT_INVALID', message, { context: { phase: 'schedule' }, details });
}

function isFrequency(value: unknown): value is ReportFrequency {
  return typeof value === 'string' && (REPORT_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Checks a schedule document and returns it narrowed, or throws.
 *
 * On the write, like the span and the security context, and for the reason those two give: a
 * schedule that cannot be read is a report that fails at 03:00 while the person who typed it is
 * asleep.
 */
export function validateSchedule(raw: unknown): ReportSchedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('a report schedule is an object naming how often it runs');
  }
  const input = raw as Record<string, unknown>;
  if (!isFrequency(input['kind'])) {
    throw invalid(`there is no report frequency called ${JSON.stringify(input['kind'])}`, {
      kind: input['kind'],
    });
  }
  const kind = input['kind'];

  const timezone = readTimezone(input['timezone']);
  const scheduleId = input['scheduleId'];
  if (
    scheduleId !== undefined &&
    (!Number.isSafeInteger(scheduleId) || (scheduleId as number) < 1)
  ) {
    throw invalid('a schedule window is named by its id');
  }

  if (kind === 'manual') {
    // Nothing else is read for a manual report, and carrying a minute nobody will honour would
    // be a setting that looks saved and does nothing.
    for (const field of ['minute', 'weekday', 'dayOfMonth', 'month']) {
      if (input[field] !== undefined) {
        throw invalid(`a manual report does not run on its own, so it has no "${field}"`);
      }
    }
    return {
      kind,
      ...(timezone === undefined ? {} : { timezone }),
      ...(typeof scheduleId === 'number' ? { scheduleId } : {}),
    };
  }

  const minuteLimit = kind === 'hourly' ? 60 : MINUTES_PER_DAY;
  const minute = input['minute'] ?? 0;
  if (
    !Number.isSafeInteger(minute) ||
    (minute as number) < 0 ||
    (minute as number) >= minuteLimit
  ) {
    throw invalid(`the minute is 0 to ${String(minuteLimit - 1)} for a ${kind} report`, { minute });
  }

  const schedule: {
    kind: ReportFrequency;
    minute: number;
    weekday?: number;
    dayOfMonth?: number;
    month?: number;
    timezone?: string;
    scheduleId?: number;
  } = { kind, minute: minute as number };

  if (kind === 'weekly') {
    const weekday = input['weekday'] ?? 0;
    if (!Number.isSafeInteger(weekday) || (weekday as number) < 0 || (weekday as number) > 6) {
      throw invalid('the weekday is 0 (Monday) to 6 (Sunday)', { weekday: input['weekday'] });
    }
    schedule.weekday = weekday as number;
  } else if (input['weekday'] !== undefined) {
    throw invalid(`a ${kind} report does not run on a weekday`);
  }

  if (kind === 'monthly' || kind === 'quarterly' || kind === 'annual') {
    const day = input['dayOfMonth'] ?? 1;
    if (!Number.isSafeInteger(day) || (day as number) < 1 || (day as number) > 31) {
      throw invalid('the day of the month is 1 to 31, and is clamped in a shorter month', {
        dayOfMonth: input['dayOfMonth'],
      });
    }
    schedule.dayOfMonth = day as number;
  } else if (input['dayOfMonth'] !== undefined) {
    throw invalid(`a ${kind} report does not run on a day of the month`);
  }

  if (kind === 'annual') {
    const month = input['month'] ?? 1;
    if (!Number.isSafeInteger(month) || (month as number) < 1 || (month as number) > 12) {
      throw invalid('the month is 1 (January) to 12 (December)', { month: input['month'] });
    }
    schedule.month = month as number;
  } else if (input['month'] !== undefined) {
    throw invalid(`a ${kind} report does not name a month`);
  }

  if (timezone !== undefined) schedule.timezone = timezone;
  if (typeof scheduleId === 'number') schedule.scheduleId = scheduleId;
  return schedule;
}

function readTimezone(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw invalid('a time zone is named by a string');
  // `isKnownTimeZone` and nothing else: there is one answer in this system to "is this a zone",
  // and `M-09`'s schedules and `D-07`'s cadences both ask it here.
  if (!isKnownTimeZone(raw)) {
    throw invalid(`${JSON.stringify(raw)} is not a time zone this system knows`, { timezone: raw });
  }
  return raw;
}

/* -------------------------------------------------------------------- resolution */

export function zoneOf(schedule: ReportSchedule): string {
  return schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The first instant strictly after `from` at which this report runs, or `null`.
 *
 * `null` means "never on its own": a manual report, or one whose window is never open. Both are
 * configurations an operator can make, and both should read as a report with no next run rather
 * than as a failure.
 */
export function nextReportRun(
  schedule: ReportSchedule,
  from: Date,
  window?: ScheduleDefinition,
): Date | null {
  if (schedule.kind === 'manual') return null;
  const allowed = (at: Date): boolean => window === undefined || isActiveAt(window, at);

  if (SHORT.has(schedule.kind)) {
    const spec: CadenceSpec = {
      cadence: schedule.kind as 'hourly' | 'daily' | 'weekly',
      minute: schedule.minute ?? 0,
      weekday: schedule.weekday ?? 0,
      timezone: schedule.timezone ?? null,
    };
    /*
     * **Strictly after, which `schedules/cadence.ts` is deliberately not.**
     *
     * That module answers "at or after" on purpose, so a rediscovery sweep waking a moment early
     * does not skip the occurrence it was woken for. A report scheduler books the *next* run at
     * the moment it starts one, and "at or after" there means booking the instant it just fired:
     * the sweep finds it due again a minute later and the report runs every minute for ever.
     *
     * One retry from a millisecond later rather than a flag on the shared module, because the
     * two callers want genuinely different things and neither should have to guess which it got.
     * Found by the test that asks every frequency for the run after an exact minute boundary.
     */
    const first = nextShortRun(spec, from, allowed);
    if (first === null || first.getTime() > from.getTime()) return first;
    return nextShortRun(spec, new Date(from.getTime() + 1), allowed);
  }
  return nextCalendarRun(schedule, from, allowed);
}

/**
 * Monthly, quarterly and annual, computed rather than scanned.
 *
 * Each candidate is one civil date turned into one instant. A closed window pushes the booking
 * forward minute by minute for at most `WINDOW_GRACE_MINUTES`; past that the period is given up
 * and the next one tried, which is visible in the next-run time rather than silent.
 */
function nextCalendarRun(
  schedule: ReportSchedule,
  from: Date,
  allowed: (at: Date) => boolean,
): Date | null {
  const zone = zoneOf(schedule);
  const here = wallOf(from, zone);
  const minute = schedule.minute ?? 0;
  const day = schedule.dayOfMonth ?? 1;

  for (let period = 0; period < MAX_PERIODS; period += 1) {
    const target = periodStart(schedule, here.year, here.month, period);
    if (target === null) continue;
    const clamped = clampDay(target.year, target.month, day);
    const at = instantOf(zone, {
      year: clamped.year,
      month: clamped.month,
      day: clamped.day,
      hour: Math.floor(minute / 60),
      minute: minute % 60,
      second: 0,
    });
    if (at.getTime() <= from.getTime()) continue;

    if (allowed(at)) return at;
    for (let push = 1; push <= WINDOW_GRACE_MINUTES; push += 1) {
      const pushed = new Date(at.getTime() + push * 60_000);
      if (allowed(pushed)) return pushed;
    }
  }
  return null;
}

/** The year and month of the `offset`-th firing period at or after this one. */
function periodStart(
  schedule: ReportSchedule,
  year: number,
  month: number,
  offset: number,
): { year: number; month: number } | null {
  switch (schedule.kind) {
    case 'monthly': {
      const index = year * 12 + (month - 1) + offset;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    }
    case 'quarterly': {
      // January, April, July, October — the months a quarter starts in. A quarterly report that
      // fired in February would be reporting on a quarter that had not ended.
      const quarter = Math.floor((month - 1) / 3);
      const index = year * 4 + quarter + offset;
      return { year: Math.floor(index / 4), month: (index % 4) * 3 + 1 };
    }
    case 'annual':
      return { year: year + offset, month: schedule.month ?? 1 };
    default:
      return null;
  }
}

/**
 * The 31st of a month that has thirty days.
 *
 * Clamped rather than skipped: a monthly report set to the 31st runs on the 28th of February, not
 * never. `civil` is `E-02`'s Gregorian calculator, which already knows how long every month is.
 */
function clampDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  // Day 0 of the next month is the last day of this one.
  const lastDay = civil(year, month + 1, 0).day;
  return { year, month, day: Math.min(day, lastDay) };
}

/** `monthly on the 1st at 02:00`, for a summary an operator reads. */
export function describeSchedule(schedule: ReportSchedule): string {
  const minute = schedule.minute ?? 0;
  const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const day = ordinal(schedule.dayOfMonth ?? 1);
  switch (schedule.kind) {
    case 'manual':
      return 'only when somebody runs it';
    case 'hourly':
      return `every hour at :${String(minute).padStart(2, '0')}`;
    case 'daily':
      return `every day at ${clock}`;
    case 'weekly':
      return `every ${WEEKDAYS[schedule.weekday ?? 0] ?? 'Monday'} at ${clock}`;
    case 'monthly':
      return `on the ${day} of every month at ${clock}`;
    case 'quarterly':
      return `on the ${day} of January, April, July and October at ${clock}`;
    case 'annual':
      return `every ${MONTHS[(schedule.month ?? 1) - 1] ?? 'January'} ${day} at ${clock}`;
  }
}

function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${String(day)}${suffix}`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
