import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  cadenceProblems,
  describeCadence,
  nextRun,
  type CadenceSpec,
} from '../src/discovery/cadence.js';

/**
 * When a rediscovery next runs (`D-07`).
 *
 * **Pure, because the interesting failures are all about the calendar.** A daily rediscovery at
 * 02:30 has to happen at 02:30 in both halves of the year — on the day the clocks go forward it
 * must not be skipped, and on the day they go back it must not run twice. Arithmetic on
 * timestamps gets both wrong, which is why the implementation asks the zone database instead.
 */

const spec = (over: Partial<CadenceSpec> = {}): CadenceSpec => ({
  cadence: 'daily',
  minute: 150, // 02:30
  weekday: 0,
  timezone: 'Europe/London',
  ...over,
});

/** The local wall-clock time of an instant, for assertions that are about the calendar. */
const local = (at: Date, zone = 'Europe/London'): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hourCycle: 'h23',
  }).format(at);

describe('finding the next run', () => {
  it('fires at the named minute past the hour, hourly', () => {
    const at = nextRun(spec({ cadence: 'hourly', minute: 20 }), new Date('2026-06-01T10:05:00Z'));
    assert.ok(at !== null);
    assert.match(local(at), /11:20/);
  });

  it('fires at the named time, daily', () => {
    const at = nextRun(spec(), new Date('2026-06-01T10:00:00Z'));
    assert.ok(at !== null);
    assert.match(local(at), /Tue.*02:30/);
  });

  it('fires on the named weekday, weekly', () => {
    // 0 is Monday, 6 is Sunday.
    const at = nextRun(
      spec({ cadence: 'weekly', weekday: 6, minute: 180 }),
      new Date('2026-06-01T10:00:00Z'),
    );
    assert.ok(at !== null);
    assert.match(local(at), /Sun.*03:00/);
  });

  it('takes the very next occurrence, not the one after', () => {
    const at = nextRun(spec({ cadence: 'hourly', minute: 0 }), new Date('2026-06-01T10:00:30Z'));
    assert.ok(at !== null);
    assert.equal(at.toISOString(), '2026-06-01T11:00:00.000Z');
  });

  it('fires on this minute when it is exactly due', () => {
    // A sweep that ran a moment early must not skip the occurrence it was woken for.
    const at = nextRun(spec({ cadence: 'hourly', minute: 30 }), new Date('2026-06-01T10:30:00Z'));
    assert.ok(at !== null);
    assert.equal(at.toISOString(), '2026-06-01T10:30:00.000Z');
  });
});

describe('the two mornings a year that break timestamp arithmetic', () => {
  // Europe/London: clocks go forward 2026-03-29 (01:00 → 02:00) and back 2026-10-25.
  it('does not skip a run when the clocks go forward past its time', () => {
    // 01:30 does not exist on 2026-03-29 in London: the clocks go 01:00 → 02:00 and that hour is
    // gone. Adding 24 hours to the previous run would land inside the missing hour, and a naive
    // implementation either fires at a time nobody asked for or loses the day. The next real
    // 01:30 is the 30th, and the run happens then rather than never.
    const at = nextRun(spec({ minute: 90 }), new Date('2026-03-28T12:00:00Z'));
    assert.ok(at !== null);
    assert.match(local(at), /30\/03.*01:30/);
  });

  it('still fires at a time the forward shift does not touch', () => {
    // Only 01:00–01:59 disappears, so 02:30 on the 29th is a perfectly real instant.
    const at = nextRun(spec({ minute: 150 }), new Date('2026-03-28T12:00:00Z'));
    assert.ok(at !== null);
    assert.match(local(at), /29\/03.*02:30/);
  });

  it('runs once, not twice, on the morning the clocks go back', () => {
    // 01:30 happens twice on 2026-10-25 in London. Two runs would mean two discoveries, two
    // sweeps of the network and two sets of provisioning — idempotent, but an operator seeing
    // the same rediscovery twice in the log rightly asks why.
    const first = nextRun(spec({ minute: 90 }), new Date('2026-10-24T12:00:00Z'));
    assert.ok(first !== null);
    assert.match(local(first), /25\/10.*01:30/);

    // Asked again from a minute after that run, the answer is the *next day*, not the second
    // 01:30 an hour later.
    const second = nextRun(spec({ minute: 90 }), new Date(first.getTime() + 60_000));
    assert.ok(second !== null);
    assert.match(local(second), /26\/10.*01:30/);
  });

  it('keeps an hourly cadence hourly across a shift', () => {
    // The hour that repeats means an hourly cadence genuinely fires 25 times that day, which is
    // correct: it is "every hour", and there are twenty-five of them.
    const at = nextRun(spec({ cadence: 'hourly', minute: 15 }), new Date('2026-10-25T00:20:00Z'));
    assert.ok(at !== null);
    assert.equal(at.getTime() - new Date('2026-10-25T00:20:00Z').getTime(), 55 * 60_000);
  });
});

describe('a permission window', () => {
  it('waits for the window rather than firing outside it', () => {
    // `M-09`'s schedule is available alongside the cadence as a window, which is what it is good
    // at: "weekly, but not during the change freeze" is a real sentence.
    const onlyAfternoons = (at: Date): boolean => {
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/London',
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(at),
      );
      return hour >= 14 && hour < 18;
    };
    const at = nextRun(
      spec({ cadence: 'hourly', minute: 0 }),
      new Date('2026-06-01T09:05:00Z'),
      onlyAfternoons,
    );
    assert.ok(at !== null);
    assert.match(local(at), /14:00/);
  });

  it('answers never rather than crashing when the window is never open', () => {
    // A configuration an operator can make, and it should read as "never" rather than as a
    // stack trace on a background sweep.
    assert.equal(
      nextRun(spec(), new Date('2026-06-01T10:00:00Z'), () => false),
      null,
    );
  });
});

describe('what it refuses', () => {
  it('bounds the minute to the cadence it belongs to', () => {
    assert.deepEqual(cadenceProblems(spec({ cadence: 'hourly', minute: 90 })).length, 1);
    assert.deepEqual(cadenceProblems(spec({ cadence: 'daily', minute: 1_500 })).length, 1);
    assert.deepEqual(cadenceProblems(spec({ cadence: 'daily', minute: 150 })), []);
  });

  it('bounds the weekday, and only for a weekly cadence', () => {
    assert.equal(cadenceProblems(spec({ cadence: 'weekly', weekday: 7 })).length, 1);
    // An hourly cadence never reads the weekday, so a stale value is not an error to report.
    assert.deepEqual(cadenceProblems(spec({ cadence: 'hourly', minute: 0, weekday: 7 })), []);
  });

  it('refuses a time zone it does not know', () => {
    assert.match(cadenceProblems(spec({ timezone: 'Mars/Olympus' })).join(' '), /not a time zone/);
    assert.deepEqual(cadenceProblems(spec({ timezone: null })), []);
  });
});

describe('describing it', () => {
  it('says what an operator would say', () => {
    assert.equal(describeCadence(spec({ cadence: 'hourly', minute: 5 })), 'every hour at :05');
    assert.equal(describeCadence(spec({ cadence: 'daily', minute: 150 })), 'every day at 02:30');
    assert.equal(
      describeCadence(spec({ cadence: 'weekly', weekday: 6, minute: 180 })),
      'every Sunday at 03:00',
    );
  });
});
