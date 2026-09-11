import { isKnownTimeZone, weekMinuteOf } from './definition.js';

/**
 * When a recurring job next runs (`D-07`, `E-08`).
 *
 * **Beside `M-09`'s schedule rather than inside `discovery/`, because it is not about discovery.**
 * It moved here when `E-08` needed the same answer for reports: a cadence is the *event* twin of
 * the window in `definition.ts`, the two are read together on every booking, and two copies of
 * "what is 02:30 on the morning the clocks go forward" is exactly the duplication that produces a
 * job which runs twice a year and nobody can explain.
 *
 * **Not `M-09`'s schedule, and the difference is the question each answers.** A schedule is a
 * weekly calendar of *windows* — "is monitoring active right now" — which is exactly right for
 * pausing sensors and exactly wrong for this: a rediscovery is an *event*, and "every Sunday at
 * 03:00" is not a window at all. So the cadence is its own small thing, and `M-09`'s schedule is
 * available alongside it as a *permission window*, which is what it is good at: "weekly, but not
 * during the change freeze" is a real sentence and the mechanism already exists.
 *
 * **Pure, because the interesting failures are all about the calendar.** A daily rediscovery at
 * 02:30 has to happen at 02:30 in both halves of the year — on the day the clocks go forward it
 * must not be skipped, and on the day they go back it must not run twice.
 */

export type Cadence = 'hourly' | 'daily' | 'weekly';

export interface CadenceSpec {
  readonly cadence: Cadence;
  /**
   * Minutes past the hour for `hourly`, past midnight for `daily` and `weekly`.
   *
   * One field for all three, because they are the same statement at three scales and three
   * fields would let somebody set a weekday on an hourly cadence and wonder why it was ignored.
   */
  readonly minute: number;
  /** 0 = Monday. Read only for `weekly`. */
  readonly weekday: number;
  /** IANA zone, or null for the core's own. `M-09`'s rule, for `M-09`'s reason. */
  readonly timezone: string | null;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export function cadenceProblems(spec: CadenceSpec): string[] {
  const problems: string[] = [];
  const limit =
    spec.cadence === 'hourly'
      ? MINUTES_PER_HOUR
      : spec.cadence === 'daily'
        ? MINUTES_PER_DAY
        : MINUTES_PER_DAY;
  if (!Number.isInteger(spec.minute) || spec.minute < 0 || spec.minute >= limit) {
    problems.push(
      `the minute must be between 0 and ${String(limit - 1)} for an ${spec.cadence} cadence`,
    );
  }
  if (
    spec.cadence === 'weekly' &&
    (!Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6)
  ) {
    problems.push('the weekday must be 0 (Monday) to 6 (Sunday)');
  }
  if (spec.timezone !== null && !isKnownTimeZone(spec.timezone)) {
    problems.push(`"${spec.timezone}" is not a time zone this system knows`);
  }
  return problems;
}

export function zoneOf(spec: CadenceSpec): string {
  return spec.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The first instant at or after `from` that this cadence fires.
 *
 * **Searched forward a minute at a time rather than computed**, and that is deliberate. The
 * arithmetic looks easy — add a day, set the time — and it is wrong twice a year: adding 24
 * hours to 02:30 the night the clocks go forward lands on 03:30, and the run either happens an
 * hour late for ever or, worse, the *next* computation rounds it back and it happens twice.
 * Asking the zone database "what is the local time at this instant" is the only thing that
 * stays right, and a bounded scan over the answers is cheap: at most a week of minutes, and only
 * when a schedule fires or is edited.
 *
 * A `window` — `M-09`'s schedule, when one is attached — is consulted at each candidate, so
 * "weekly on Sunday at 03:00, but only while the maintenance window is open" is one expression
 * of two mechanisms rather than a third mechanism that means both.
 */
export function nextRun(
  spec: CadenceSpec,
  from: Date,
  window?: (at: Date) => boolean,
): Date | null {
  const zone = zoneOf(spec);
  // Start on the next whole minute: a cadence fires on a minute, and `from` is usually now.
  //
  // **At or after, deliberately** — an instant already on a firing minute is answered unchanged,
  // so a sweep that ran a moment early does not skip the occurrence it was woken for. A caller
  // that needs the *next* one, such as a scheduler re-booking from the instant it just fired,
  // has to say so; `reports/cadence.ts` does, and explains why.
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);

  // A week of minutes covers every cadence: hourly repeats within an hour, daily within a day,
  // weekly within a week. The extra day is slack for a zone shift moving a boundary.
  const limit = MINUTES_PER_WEEK + MINUTES_PER_DAY;
  for (let step = 0; step <= limit; step += 1) {
    const at = new Date(start.getTime() + step * 60_000);
    if (!firesAt(spec, at, zone)) continue;
    if (alreadyFired(spec, at, start, zone)) continue;
    if (window !== undefined && !window(at)) continue;
    return at;
  }
  // Only reachable with a window that is never open, which is a configuration an operator can
  // make and which should read as "never" rather than as a crash.
  return null;
}

/**
 * Whether this candidate is the *second* half of a repeated local hour whose first half is past.
 *
 * **The morning the clocks go back, and it is a real bug rather than a hypothetical.** On
 * 2026-10-25 in London, 01:30 happens twice — once in BST and once in GMT — so a daily cadence
 * set to 01:30 finds two instants with the right local time and fires on both. Two rediscoveries
 * an hour apart are idempotent, so nothing is corrupted; but an operator seeing the same run
 * twice in the log rightly asks why, and a nightly job that sometimes runs twice is the kind of
 * thing that gets blamed for whatever else went wrong that night.
 *
 * Found by the test that asks for the run after the first one.
 *
 * **Hourly is exempt, and that is not an oversight.** "Every hour" on a day with twenty-five
 * hours in it means twenty-five runs, which is what it says. Only daily and weekly name a
 * wall-clock time that is supposed to happen once.
 *
 * Bounded at two hours because a repeated hour is one hour: the nearest earlier instant with the
 * same local time can only be a daylight-saving duplicate, since the real previous occurrence is
 * a day or a week away.
 */
function alreadyFired(spec: CadenceSpec, candidate: Date, start: Date, zone: string): boolean {
  if (spec.cadence === 'hourly') return false;
  for (let back = 1; back <= 120; back += 1) {
    const earlier = new Date(candidate.getTime() - back * 60_000);
    if (!firesAt(spec, earlier, zone)) continue;
    return earlier.getTime() < start.getTime();
  }
  return false;
}

/** Whether this instant is one the cadence fires on, in its own zone. */
function firesAt(spec: CadenceSpec, at: Date, zone: string): boolean {
  const weekMinute = weekMinuteOf(at, zone);
  switch (spec.cadence) {
    case 'hourly':
      return weekMinute % MINUTES_PER_HOUR === spec.minute;
    case 'daily':
      return weekMinute % MINUTES_PER_DAY === spec.minute;
    case 'weekly':
      return weekMinute === spec.weekday * MINUTES_PER_DAY + spec.minute;
  }
}

/** `every Sunday at 03:00`, for a summary an operator reads. */
export function describeCadence(spec: CadenceSpec): string {
  const time = `${String(Math.floor((spec.minute % MINUTES_PER_DAY) / 60)).padStart(2, '0')}:${String(
    spec.minute % 60,
  ).padStart(2, '0')}`;
  switch (spec.cadence) {
    case 'hourly':
      return `every hour at :${String(spec.minute).padStart(2, '0')}`;
    case 'daily':
      return `every day at ${time}`;
    case 'weekly':
      return `every ${WEEKDAYS[spec.weekday] ?? 'Monday'} at ${time}`;
  }
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
