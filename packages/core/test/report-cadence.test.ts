import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  REPORT_FREQUENCIES,
  describeSchedule,
  nextReportRun,
  validateSchedule,
  type ReportSchedule,
} from '../src/reports/cadence.js';
import type { ScheduleDefinition } from '../src/schedules/definition.js';

/**
 * When a report next runs (`E-08`).
 *
 * Pure, so every case is a schedule and an instant in, an instant out. The interesting failures
 * are all calendar failures: a monthly report that skips February, a run that happens twice the
 * morning the clocks go back, a day that has no midnight.
 */

const HOUR = 3_600_000;

/** A `M-09` schedule that is open only on Mondays, for the window cases. */
const MONDAYS_ONLY: ScheduleDefinition = {
  periods: [{ start: 0, end: 1_440 }],
  polarity: 'active',
  timezone: 'UTC',
};

describe('a report’s cadence', () => {
  describe('answers the six frequencies §6 asks for', () => {
    const from = new Date('2026-09-11T05:00:00Z');
    const at = (schedule: ReportSchedule): string | null =>
      nextReportRun(schedule, from)?.toISOString() ?? null;

    it('runs hourly, daily and weekly through the module that already knew how', () => {
      // Not a second implementation: `schedules/cadence.ts` already knows that 02:30 on the
      // morning the clocks go forward must not be skipped, and re-deriving that here would mean
      // learning it again — badly, and only after a nightly job ran twice.
      assert.equal(at({ kind: 'hourly', minute: 15, timezone: 'UTC' }), '2026-09-11T05:15:00.000Z');
      assert.equal(
        at({ kind: 'daily', minute: 150, timezone: 'Europe/Berlin' }),
        '2026-09-12T00:30:00.000Z',
      );
      assert.equal(
        at({ kind: 'weekly', weekday: 6, minute: 180, timezone: 'UTC' }),
        '2026-09-13T03:00:00.000Z',
      );
    });

    it('runs monthly, quarterly and annually, which that module cannot', () => {
      // It scans forward a minute at a time, bounded at a week. A year is half a million minutes
      // and half a million calls into the zone database, so these are computed instead.
      assert.equal(
        at({ kind: 'monthly', dayOfMonth: 1, minute: 120, timezone: 'Europe/Berlin' }),
        '2026-10-01T00:00:00.000Z',
      );
      assert.equal(
        at({ kind: 'quarterly', dayOfMonth: 1, minute: 120, timezone: 'UTC' }),
        '2026-10-01T02:00:00.000Z',
      );
      assert.equal(
        at({ kind: 'annual', month: 1, dayOfMonth: 1, minute: 0, timezone: 'UTC' }),
        '2027-01-01T00:00:00.000Z',
      );
    });

    it('has no next run at all when it is manual', () => {
      // Not an error and not "now": a manual report is one somebody runs, and a client has to be
      // able to show that rather than a missing date.
      assert.equal(at({ kind: 'manual' }), null);
    });

    it('fires a quarterly report in a month a quarter starts in', () => {
      // February would be reporting on a quarter that has not ended.
      for (const month of [1, 4, 7, 10]) {
        const start = new Date(Date.UTC(2026, month - 2, 15));
        const next = nextReportRun({ kind: 'quarterly', dayOfMonth: 1, timezone: 'UTC' }, start);
        assert.ok(next);
        assert.equal(next.getUTCMonth() + 1, month, `from ${start.toISOString()}`);
      }
    });
  });

  describe('clamps a day that a month does not have, rather than skipping the month', () => {
    it('runs on the 28th of February when it was asked for the 31st', () => {
      // **A monthly report that silently has no February** is the alternative, and February is
      // the month somebody eventually asks about.
      const next = nextReportRun(
        { kind: 'monthly', dayOfMonth: 31, minute: 120, timezone: 'UTC' },
        new Date('2026-01-31T05:00:00Z'),
      );
      assert.equal(next?.toISOString(), '2026-02-28T02:00:00.000Z');
    });

    it('runs on the 29th in a leap year', () => {
      const next = nextReportRun(
        { kind: 'monthly', dayOfMonth: 30, minute: 0, timezone: 'UTC' },
        new Date('2028-02-01T00:00:00Z'),
      );
      assert.equal(next?.toISOString(), '2028-02-29T00:00:00.000Z');
    });

    it('never skips a month, whatever day it was asked for', () => {
      // The general form: twelve consecutive bookings from any day-of-month land in twelve
      // consecutive months.
      for (const day of [1, 15, 28, 29, 30, 31]) {
        let at = new Date('2025-12-15T00:00:00Z');
        const months: number[] = [];
        for (let step = 0; step < 14; step += 1) {
          const next = nextReportRun({ kind: 'monthly', dayOfMonth: day, timezone: 'UTC' }, at);
          assert.ok(next, `day ${String(day)} stopped booking`);
          months.push(next.getUTCFullYear() * 12 + next.getUTCMonth());
          at = next;
        }
        for (let index = 1; index < months.length; index += 1) {
          assert.equal(
            (months[index] ?? 0) - (months[index - 1] ?? 0),
            1,
            `day ${String(day)} skipped a month at step ${String(index)}`,
          );
        }
      }
    });
  });

  describe('gets the clock changes right, because that is where these break', () => {
    it('starts a monthly report at 01:00 in a zone whose clock jumps at midnight', () => {
      // Lebanon springs forward at 00:00, so 2026-03-29T00:00 never happens there. A report set
      // to run at midnight on the 29th runs at the first instant that does exist.
      const next = nextReportRun(
        { kind: 'monthly', dayOfMonth: 29, minute: 0, timezone: 'Asia/Beirut' },
        new Date('2026-03-01T00:00:00Z'),
      );
      assert.equal(next?.toISOString(), '2026-03-28T22:00:00.000Z');
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Beirut',
        dateStyle: 'short',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(next);
      assert.match(local, /29\/03\/2026, 01:00/u);
    });

    it('books strictly forward, so a booking is never the instant it was made at', () => {
      // The bug this prevents is a sweep that finds a report due, books the same instant again,
      // and runs it every minute for ever.
      for (const kind of REPORT_FREQUENCIES) {
        if (kind === 'manual') continue;
        const schedule = { kind, minute: 0, dayOfMonth: 1, month: 1, timezone: 'UTC' };
        const exact = new Date('2026-01-01T00:00:00Z');
        const next = nextReportRun(schedule, exact);
        assert.ok(next, kind);
        assert.ok(next.getTime() > exact.getTime(), `${kind} booked itself at the same instant`);
      }
    });
  });

  describe('treats a M-09 schedule as a permission window, not as the cadence', () => {
    it('moves a booking that lands outside an active period', () => {
      // `§4`: a schedule's inactive periods pause reports as well as monitoring. A daily report
      // at 03:00 with a Mondays-only window runs on Monday.
      const next = nextReportRun(
        { kind: 'daily', minute: 180, timezone: 'UTC' },
        new Date('2026-09-11T00:00:00Z'),
        MONDAYS_ONLY,
      );
      assert.ok(next);
      assert.equal(next.getUTCDay(), 1, 'a Monday');
      assert.equal(next.toISOString(), '2026-09-14T03:00:00.000Z');
    });

    it('pushes a monthly booking into the window rather than losing the month', () => {
      // **The bug a one-day grace had.** 1 December 2026 is a Tuesday, so a monthly report on the
      // 1st with a weekday-shaped window would have been skipped that month — and most months.
      // A monthly report is worth being a few days late for; having no December is not the same
      // thing at all. The grace is a week because a window *is* a week.
      const next = nextReportRun(
        { kind: 'monthly', dayOfMonth: 1, minute: 180, timezone: 'UTC' },
        new Date('2026-11-15T00:00:00Z'),
        MONDAYS_ONLY,
      );
      assert.ok(next);
      assert.equal(next.getUTCDay(), 1, 'moved onto a Monday');
      // Midnight, not 03:00 — "as soon as the window allows" is the rule, and the window opens
      // at Monday 00:00. A run held back by a freeze runs when the freeze lifts.
      assert.equal(next.toISOString(), '2026-12-07T00:00:00.000Z');
      assert.ok(
        next.getTime() - Date.UTC(2026, 11, 1, 3) <= 7 * 24 * HOUR,
        'and never further than the week that covers every minute the window has',
      );
    });

    it('runs every month even with a window that is open one day in seven', () => {
      // The general form: twelve consecutive bookings are twelve consecutive months, window or
      // no window. This is the assertion that would have caught the one-day grace.
      let at = new Date('2026-01-05T00:00:00Z');
      const months: number[] = [];
      for (let step = 0; step < 12; step += 1) {
        const next = nextReportRun(
          { kind: 'monthly', dayOfMonth: 1, minute: 180, timezone: 'UTC' },
          at,
          MONDAYS_ONLY,
        );
        assert.ok(next, `stopped booking at step ${String(step)}`);
        assert.equal(next.getUTCDay(), 1);
        months.push(next.getUTCFullYear() * 12 + next.getUTCMonth());
        at = next;
      }
      // **Consecutive, not merely distinct.** Twelve distinct months is what a one-day grace
      // produces too — it books January, February, then skips to June — so counting unique months
      // would have let the bug through. The gaps are the defect.
      for (let index = 1; index < months.length; index += 1) {
        assert.equal(
          (months[index] ?? 0) - (months[index - 1] ?? 0),
          1,
          `a month was skipped at step ${String(index)}`,
        );
      }
    });

    it('answers never when the window is never open', () => {
      // A configuration an operator can make, and one that should read as "this does not run"
      // rather than as a crash or a booking that quietly ignores the window.
      const shut: ScheduleDefinition = { ...MONDAYS_ONLY, periods: [], polarity: 'active' };
      assert.equal(
        nextReportRun({ kind: 'daily', minute: 180, timezone: 'UTC' }, new Date(), shut),
        null,
      );
    });
  });

  describe('is checked on the write', () => {
    it('accepts each frequency with the fields it actually uses', () => {
      assert.deepEqual(validateSchedule({ kind: 'manual' }), { kind: 'manual' });
      assert.deepEqual(validateSchedule({ kind: 'hourly', minute: 15 }), {
        kind: 'hourly',
        minute: 15,
      });
      assert.deepEqual(validateSchedule({ kind: 'annual', month: 3, dayOfMonth: 2, minute: 60 }), {
        kind: 'annual',
        minute: 60,
        dayOfMonth: 2,
        month: 3,
      });
    });

    it('refuses a field the frequency will not honour', () => {
      // A weekday on a monthly report is a setting somebody made that nothing reads, which is
      // worse than a refusal: it looks saved.
      assert.throws(
        () => validateSchedule({ kind: 'monthly', weekday: 2 }),
        /does not run on a weekday/u,
      );
      assert.throws(() => validateSchedule({ kind: 'daily', dayOfMonth: 3 }), /day of the month/u);
      assert.throws(() => validateSchedule({ kind: 'weekly', month: 3 }), /does not name a month/u);
      assert.throws(
        () => validateSchedule({ kind: 'manual', minute: 5 }),
        /does not run on its own/u,
      );
    });

    it('refuses a frequency, a minute, a weekday or a zone it cannot act on', () => {
      assert.throws(() => validateSchedule({ kind: 'fortnightly' }), /no report frequency called/u);
      assert.throws(() => validateSchedule({ kind: 'hourly', minute: 60 }), /0 to 59/u);
      assert.throws(() => validateSchedule({ kind: 'daily', minute: 1_440 }), /0 to 1439/u);
      assert.throws(() => validateSchedule({ kind: 'weekly', weekday: 7 }), /0 \(Monday\) to 6/u);
      assert.throws(() => validateSchedule({ kind: 'monthly', dayOfMonth: 32 }), /1 to 31/u);
      assert.throws(() => validateSchedule({ kind: 'annual', month: 13 }), /1 \(January\) to 12/u);
      assert.throws(
        () => validateSchedule({ kind: 'daily', timezone: 'Mars/Olympus_Mons' }),
        /not a time zone this system knows/u,
      );
      assert.throws(() => validateSchedule('daily'), /an object naming how often/u);
    });

    it('describes itself in words an operator reads, for every frequency', () => {
      assert.equal(describeSchedule({ kind: 'manual' }), 'only when somebody runs it');
      assert.equal(describeSchedule({ kind: 'hourly', minute: 5 }), 'every hour at :05');
      assert.equal(describeSchedule({ kind: 'daily', minute: 150 }), 'every day at 02:30');
      assert.equal(
        describeSchedule({ kind: 'weekly', weekday: 6, minute: 180 }),
        'every Sunday at 03:00',
      );
      assert.equal(
        describeSchedule({ kind: 'monthly', dayOfMonth: 1, minute: 120 }),
        'on the 1st of every month at 02:00',
      );
      assert.equal(
        describeSchedule({ kind: 'quarterly', dayOfMonth: 2, minute: 0 }),
        'on the 2nd of January, April, July and October at 00:00',
      );
      assert.equal(
        describeSchedule({ kind: 'annual', month: 12, dayOfMonth: 23, minute: 540 }),
        'every December 23rd at 09:00',
      );
      // The ordinals a naive implementation gets wrong.
      assert.match(describeSchedule({ kind: 'monthly', dayOfMonth: 11 }), /11th/u);
      assert.match(describeSchedule({ kind: 'monthly', dayOfMonth: 21 }), /21st/u);
      assert.match(describeSchedule({ kind: 'monthly', dayOfMonth: 13 }), /13th/u);
    });
  });
});
