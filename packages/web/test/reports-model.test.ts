import { describe, expect, it } from 'vitest';
import {
  REPORT_KINDS,
  badRecipients,
  clockOf,
  deliveryText,
  downloadPath,
  durationText,
  labelOfKind,
  minuteOf,
  nextRunText,
  rendersToday,
  runSummary,
  scheduleFields,
  scheduleFrom,
  sizeText,
  splitRecipients,
  whyItCannotRun,
} from '../src/routes/reports-model';
import type { ReportRun, ReportSummary } from '../src/api/types';

/**
 * The wording and the arithmetic behind the reports pages (`E-11`).
 *
 * Every case here is a judgement that can be wrong without anything failing: a form offering a
 * setting the core refuses, a null that reads as "we do not know" when it means "nothing will run
 * this", and a report that has been silently refusing since August looking no different from one
 * that works.
 */

const REPORT: ReportSummary = {
  id: 7,
  name: 'Monthly uptime',
  description: '',
  kind: 'table_only',
  subjects: { objectIds: [41, 42] },
  span: { kind: 'month', offset: 1 },
  resolved: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
    label: '2026-08 (UTC)',
    timezone: 'UTC',
    bucketSeconds: 3_600,
    source: 'sample_1h',
    adjustments: [],
  },
  outputs: { formats: ['html'], delivery: 'store', recipients: [], zip: false },
  schedule: { kind: 'monthly', minute: 120, dayOfMonth: 1 },
  scheduleSummary: 'on the 1st of every month at 02:00',
  nextRunAt: '2026-10-01T02:00:00.000Z',
  lastRunAt: null,
  runAs: { login: 'alice', available: true },
  version: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const RUN: ReportRun = {
  id: 11,
  reportId: 7,
  trigger: 'scheduled',
  requestedBy: '',
  state: 'succeeded',
  queuedAt: '2026-10-01T02:00:00.000Z',
  startedAt: '2026-10-01T02:00:00.000Z',
  finishedAt: '2026-10-01T02:00:04.000Z',
  durationMs: 4_200,
  spanLabel: '2026-09 (UTC)',
  sections: 3,
  unavailable: 0,
  cells: 900,
  errorCode: '',
  errorMessage: '',
  delivery: {
    state: 'none',
    attempts: 0,
    error: '',
    nextAttemptAt: null,
    deliveredAt: null,
  },
  outputs: [],
};

describe('the schedule form', () => {
  it('offers only the fields the frequency actually uses', () => {
    // **The one piece of logic on these pages that has to be right.** The core refuses a weekday
    // on a monthly report outright, so a form that showed the control would produce a 400 nobody
    // can explain.
    expect(scheduleFields('manual')).toEqual({
      minute: false,
      weekday: false,
      dayOfMonth: false,
      month: false,
    });
    expect(scheduleFields('hourly').minute).toBe(true);
    expect(scheduleFields('weekly')).toMatchObject({ weekday: true, dayOfMonth: false });
    expect(scheduleFields('monthly')).toMatchObject({ weekday: false, dayOfMonth: true });
    expect(scheduleFields('quarterly')).toMatchObject({ dayOfMonth: true, month: false });
    expect(scheduleFields('annual')).toMatchObject({ dayOfMonth: true, month: true });
  });

  it('drops a field left over from the frequency before it', () => {
    // The way a form produces a request the core refuses for a control nobody can see any more:
    // pick weekly, choose a Friday, change to monthly, save.
    const draft = {
      kind: 'monthly' as const,
      minute: 120,
      weekday: 4,
      dayOfMonth: 1,
      month: 3,
      timezone: '',
    };
    expect(scheduleFrom(draft)).toEqual({ kind: 'monthly', minute: 120, dayOfMonth: 1 });
    expect(scheduleFrom({ ...draft, kind: 'manual' })).toEqual({ kind: 'manual' });
    expect(scheduleFrom({ ...draft, kind: 'weekly' })).toEqual({
      kind: 'weekly',
      minute: 120,
      weekday: 4,
    });
    expect(scheduleFrom({ ...draft, kind: 'annual' })).toEqual({
      kind: 'annual',
      minute: 120,
      dayOfMonth: 1,
      month: 3,
    });
  });

  it('sends a time zone only when one was typed', () => {
    // An empty string is not a zone, and the core would refuse it; absent means the core's own.
    expect(
      scheduleFrom({
        kind: 'daily',
        minute: 0,
        weekday: 0,
        dayOfMonth: 1,
        month: 1,
        timezone: '  ',
      }),
    ).toEqual({ kind: 'daily', minute: 0 });
    expect(
      scheduleFrom({
        kind: 'daily',
        minute: 0,
        weekday: 0,
        dayOfMonth: 1,
        month: 1,
        timezone: ' Europe/Berlin ',
      }).timezone,
    ).toBe('Europe/Berlin');
  });

  it('round-trips a clock through minutes past midnight', () => {
    expect(clockOf(0)).toBe('00:00');
    expect(clockOf(150)).toBe('02:30');
    expect(clockOf(1_439)).toBe('23:59');
    expect(minuteOf('02:30')).toBe(150);
    expect(minuteOf(clockOf(725))).toBe(725);
    // A cleared field must not become a minute the core refuses.
    expect(minuteOf('')).toBe(0);
    expect(minuteOf('99:99')).toBe(1_439);
  });
});

describe('what the page says about a report', () => {
  it('says a manual report has no next run rather than leaving it blank', () => {
    // An empty cell reads as "we do not know". The honest answer is that nothing will run it.
    expect(nextRunText({ ...REPORT, nextRunAt: null, schedule: { kind: 'manual' } })).toMatch(
      /only when somebody runs it/u,
    );
  });

  it('names the other silence: a schedule whose window never opens', () => {
    // Identical from here to a manual report, and a configuration somebody should be told about
    // rather than left to notice.
    expect(nextRunText({ ...REPORT, nextRunAt: null })).toMatch(/never/u);
  });

  it('puts a lost security context ahead of every other reason', () => {
    // It stops the report outright, where an unrenderable template or an unresolvable span each
    // stop one run.
    const broken = {
      ...REPORT,
      kind: 'graph_only' as const,
      runAs: { login: 'departed', available: false },
    };
    expect(whyItCannotRun(broken)).toMatch(/deleted or disabled/u);
    expect(whyItCannotRun(broken)).toMatch(/departed/u);
  });

  it('says when a template does not render yet', () => {
    // Only two of the seven do. A form offering all of them as equals would let somebody schedule
    // a monthly report that produces nothing, discovered by a colleague asking where it is.
    expect(rendersToday('table_only')).toBe(true);
    expect(rendersToday('sensor_list')).toBe(true);
    expect(rendersToday('graph_and_table')).toBe(false);
    expect(whyItCannotRun({ ...REPORT, kind: 'top_uptime' })).toMatch(/does not render yet/u);
  });

  it('reports an unresolvable span, and nothing at all when it is fine', () => {
    expect(whyItCannotRun(REPORT)).toBeNull();
    // Built by omission rather than by setting `resolved: undefined` — `exactOptionalPropertyTypes`
    // makes those two different things, and the core sends one field or the other, never both.
    const { resolved: _resolved, ...rest } = REPORT;
    expect(
      whyItCannotRun({
        ...rest,
        unresolvable: { code: 'REPORT_INVALID', message: 'covers no time yet' },
      }),
    ).toBe('covers no time yet');
  });

  it('labels every template it offers', () => {
    for (const one of REPORT_KINDS) expect(labelOfKind(one.id)).toBe(one.label);
  });
});

describe('what the page says about a run', () => {
  it('leads with the period, because that is the question a history is asked', () => {
    expect(runSummary(RUN)).toMatch(/^2026-09 \(UTC\)/u);
    expect(runSummary(RUN)).toMatch(/3 sensors/u);
    expect(runSummary({ ...RUN, sections: 1 })).toMatch(/1 sensor\b/u);
  });

  it('counts what a run did not render rather than leaving it out', () => {
    // A report that silently covers seven of the ten sensors it names is the failure the whole
    // reporting surface is careful about; the history says so too.
    expect(runSummary({ ...RUN, unavailable: 2 })).toMatch(/2 not rendered/u);
    expect(runSummary(RUN)).not.toMatch(/not rendered/u);
  });

  it('says why a run failed, in the code the API would have answered with', () => {
    expect(
      runSummary({
        ...RUN,
        state: 'failed',
        errorCode: 'REPORT_NO_CONTEXT',
        errorMessage: 'that account is disabled',
      }),
    ).toMatch(/failed: that account is disabled/u);
    // A failure with no message still names something actionable.
    expect(
      runSummary({ ...RUN, state: 'failed', errorCode: 'REPORT_TOO_LARGE', errorMessage: '' }),
    ).toMatch(/REPORT_TOO_LARGE/u);
  });

  it('says nothing about delivery for a run nobody asked to have delivered', () => {
    expect(deliveryText(RUN)).toBeNull();
  });

  it('says a failed delivery will not be retried, because nothing re-arms it', () => {
    // Terminal is the fact an operator has to act on, rather than a status that might change on
    // its own.
    const text = deliveryText({
      ...RUN,
      delivery: { ...RUN.delivery, state: 'failed', attempts: 5, error: '550 no such mailbox' },
    });
    expect(text).toMatch(/will not be retried/u);
    expect(text).toMatch(/5 attempts/u);
    expect(text).toMatch(/550/u);
  });

  it('tells a delivery that has not been tried from one that has failed once', () => {
    expect(deliveryText({ ...RUN, delivery: { ...RUN.delivery, state: 'pending' } })).toBe(
      'waiting to be sent',
    );
    expect(
      deliveryText({
        ...RUN,
        delivery: { ...RUN.delivery, state: 'pending', attempts: 2, error: '451 later' },
      }),
    ).toMatch(/attempt 2 failed: 451 later/u);
  });

  it('builds a download path the browser can follow on its own', () => {
    // A plain link rather than a fetch: the session cookie travels, and a large report never
    // passes through this app's memory.
    expect(downloadPath(RUN, 'csv')).toBe('/api/v1/reports/7/runs/11/csv');
  });
});

describe('formatting', () => {
  it('reads a size in the units somebody thinks in', () => {
    expect(sizeText(0)).toBe('0 B');
    expect(sizeText(999)).toBe('999 B');
    expect(sizeText(4_200)).toBe('4.2 kB');
    expect(sizeText(5_400_000)).toBe('5.4 MB');
  });

  it('shows a duration, and a gap where there is none', () => {
    expect(durationText(null)).toBe('—');
    expect(durationText(420)).toBe('420 ms');
    expect(durationText(4_200)).toBe('4.2 s');
  });
});

describe('the recipient list', () => {
  it('names the addresses the core will refuse, individually', () => {
    // So twelve addresses with one typo do not come back as a single error about the field.
    expect(badRecipients('ops@example.test\nno-at-sign\nfine@example.test')).toEqual([
      'no-at-sign',
    ]);
    expect(badRecipients('a b@example.test')).toEqual(['a b@example.test']);
    expect(badRecipients('ops@example.test, second@example.test')).toEqual([]);
  });

  it('accepts a list written either way, and drops the empties', () => {
    expect(splitRecipients(' a@x.test ,\n\n b@x.test \n')).toEqual(['a@x.test', 'b@x.test']);
    expect(splitRecipients('')).toEqual([]);
  });
});
