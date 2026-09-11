import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_SPAN_OFFSET,
  REPORT_SPAN_KINDS,
  planReportSpan,
  resolveSpan,
  validateSpan,
  type ReportSpan,
  type ReportSpanKind,
} from '../src/reports/span.js';
import {
  FORCED_AVERAGING_FROM_DAYS,
  FORCED_AVERAGING_MIN_SECONDS,
  MAX_RANGE_DAYS,
  SHORTENED_RANGE_DAYS,
} from '../src/timeseries/query.js';

/**
 * What period a report covers (`E-02`, `CAPABILITIES.MD §6`).
 *
 * **`§6`'s three rules are barely tested here, and that is correct**: they live in
 * `timeseries/query.ts` and `query.test.ts` asserts them. What is asserted below is that a report
 * goes *through* them — and the calendar, which is the part `planSeries` cannot do and where every
 * bug in this area actually lives. "Last month" is 28 to 31 days long, starts at local midnight in
 * somebody's zone, and in that zone one of its days may have had 23 or 25 hours.
 *
 * The zone list is chosen to be hostile on purpose. `Asia/Beirut` and `America/Santiago` change
 * their clocks **at midnight**, so the first instant of a day there is sometimes 01:00 and the
 * assumption "a day starts at 00:00" is false. `Australia/Lord_Howe` shifts by 30 minutes rather
 * than an hour, and `Pacific/Chatham` sits at :45 past.
 */

const ZONES = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Beirut',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Pacific/Chatham',
];

const NAMED: ReportSpanKind[] = REPORT_SPAN_KINDS.filter((kind) => kind !== 'custom');

const DAY_MS = 86_400_000;

/**
 * A deterministic generator, so a failing case is a failing case tomorrow too.
 *
 * `Math.random` would make this suite report a different bug on every run and none of them
 * reproducibly — which is the one thing a property test must not do.
 */
function randoms(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('a report span', () => {
  describe('names a calendar period, in a zone', () => {
    const now = new Date('2026-09-11T05:30:00Z');
    const at = (span: ReportSpan) => resolveSpan(span, now);

    it('means the last complete period, not the one in progress', () => {
      // **The default that matters.** A monthly report fires on the 1st at 02:00; one covering
      // "this month" would cover two hours, and would do it every month without complaint.
      const august = at({ kind: 'month', timezone: 'Europe/Berlin' });
      assert.equal(august.label, '2026-08 (Europe/Berlin)');
      assert.equal(august.from.toISOString(), '2026-07-31T22:00:00.000Z');
      assert.equal(august.to.toISOString(), '2026-08-31T22:00:00.000Z');
    });

    it('ends a period in progress now rather than at its calendar end', () => {
      // The alternative is a monthly report whose last nineteen days are empty and which does not
      // say why — `CLAUDE.md`'s "no-data is not zero" read the wrong way round.
      const september = at({ kind: 'month', offset: 0, timezone: 'Europe/Berlin' });
      assert.equal(september.label, '2026-09 to date (Europe/Berlin)');
      assert.equal(september.from.toISOString(), '2026-08-31T22:00:00.000Z');
      assert.equal(september.to.toISOString(), now.toISOString());
    });

    it('labels each kind unambiguously, and never in a local format', () => {
      const zone = 'Europe/Berlin';
      assert.equal(at({ kind: 'day', timezone: zone }).label, '2026-09-10 (Europe/Berlin)');
      assert.equal(at({ kind: 'week', timezone: zone }).label, '2026-W36 (Europe/Berlin)');
      assert.equal(at({ kind: 'month', timezone: zone }).label, '2026-08 (Europe/Berlin)');
      assert.equal(at({ kind: 'quarter', timezone: zone }).label, '2026-Q2 (Europe/Berlin)');
      assert.equal(at({ kind: 'year', timezone: zone }).label, '2025 (Europe/Berlin)');
    });

    it('starts a week on Monday, and numbers it the way ISO 8601 does', () => {
      // 2026-12-28 is a Monday whose Thursday falls in 2026, so it is week 53 **of 2026** even
      // though most of it is 2027. Printing `2027-W01` here would misfile a report by a year.
      const week = resolveSpan(
        { kind: 'week', offset: 0, timezone: 'UTC' },
        new Date('2026-12-30T12:00:00Z'),
      );
      assert.equal(week.label, '2026-W53 to date (UTC)');
      assert.equal(week.from.toISOString(), '2026-12-28T00:00:00.000Z');
    });

    it('reads the calendar in the span’s zone, not the server’s', () => {
      // 2026-09-01T01:00Z is still August in New York and already September in Berlin. A report
      // that resolved in the core's zone would cover the wrong month for half the world.
      const instant = new Date('2026-09-01T01:00:00Z');
      assert.equal(
        resolveSpan({ kind: 'month', offset: 0, timezone: 'Europe/Berlin' }, instant).label,
        '2026-09 to date (Europe/Berlin)',
      );
      assert.equal(
        resolveSpan({ kind: 'month', offset: 0, timezone: 'America/New_York' }, instant).label,
        '2026-08 to date (America/New_York)',
      );
    });
  });

  describe('survives the clock changing underneath it', () => {
    it('gives the short day 23 hours and the long day 25', () => {
      const short = resolveSpan(
        { kind: 'day', offset: 1, timezone: 'Europe/Berlin' },
        new Date('2026-03-30T05:00:00Z'),
      );
      assert.equal(short.label, '2026-03-29 (Europe/Berlin)');
      assert.equal((short.to.getTime() - short.from.getTime()) / 3_600_000, 23);

      const long = resolveSpan(
        { kind: 'day', offset: 1, timezone: 'Europe/Berlin' },
        new Date('2026-10-26T05:00:00Z'),
      );
      assert.equal(long.label, '2026-10-25 (Europe/Berlin)');
      assert.equal((long.to.getTime() - long.from.getTime()) / 3_600_000, 25);
    });

    it('starts a day at 01:00 in a zone whose clock jumps at midnight', () => {
      // **Lebanon springs forward at 00:00**, so 2026-03-29T00:00 in Beirut never happens. The
      // first instant of that day is 01:00 local, and code that assumed midnight would place the
      // day's start an hour into the previous day — silently, and only twice a year.
      const day = resolveSpan(
        { kind: 'day', offset: 0, timezone: 'Asia/Beirut' },
        new Date('2026-03-29T10:00:00Z'),
      );
      assert.equal(day.label, '2026-03-29 to date (Asia/Beirut)');
      assert.equal(day.from.toISOString(), '2026-03-28T22:00:00.000Z');

      const wall = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Beirut',
        dateStyle: 'short',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(day.from);
      assert.match(wall, /29\/03\/2026, 01:00/, 'the first instant that exists on that date');
    });

    it('starts a month at 01:00 when its first day is the one that jumps', () => {
      // Chile changes at midnight on the first Sunday of September; when that falls on the 1st the
      // *month* begins at 01:00. Same defect, one level up, and a monthly report is the one that
      // gets filed.
      const month = resolveSpan(
        { kind: 'day', offset: 0, timezone: 'America/Santiago' },
        new Date('2026-09-06T12:00:00Z'),
      );
      assert.equal(month.from.toISOString(), '2026-09-06T04:00:00.000Z');
    });

    it('never starts a period at an instant that is not in it', () => {
      // The general form of the two cases above, over every zone and every kind: whatever instant
      // a period starts at, reading the calendar there must give that period back.
      const next = randoms(0x5eed_1);
      for (const timezone of ZONES) {
        for (const kind of NAMED) {
          for (let trial = 0; trial < 60; trial += 1) {
            // Somewhere in a four-year window, to sweep both transitions in both hemispheres.
            const now = new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 4 * 365 * DAY_MS));
            const window = resolveSpan({ kind, offset: 1, timezone }, now);
            const again = resolveSpan({ kind, offset: 0, timezone }, window.from);
            assert.equal(
              again.from.getTime(),
              window.from.getTime(),
              `${kind} in ${timezone} at ${now.toISOString()}: ` +
                `started at ${window.from.toISOString()}, which reads as ${again.from.toISOString()}`,
            );
          }
        }
      }
    });

    it('tiles: every period ends exactly where the next one starts', () => {
      // No gap and no overlap, in any zone. A gap loses an hour of data twice a year and a report
      // that double-counts one is worse — it is a number somebody acts on.
      const next = randoms(0x5eed_2);
      for (const timezone of ZONES) {
        for (const kind of NAMED) {
          for (let trial = 0; trial < 40; trial += 1) {
            const now = new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 4 * 365 * DAY_MS));
            const older = resolveSpan({ kind, offset: 2, timezone }, now);
            const newer = resolveSpan({ kind, offset: 1, timezone }, now);
            assert.equal(
              older.to.getTime(),
              newer.from.getTime(),
              `${kind} in ${timezone} at ${now.toISOString()} leaves a seam`,
            );
            assert.ok(newer.from.getTime() > older.from.getTime(), 'and runs forwards');
          }
        }
      }
    });

    it('contains the instant it was resolved at, for the period in progress', () => {
      const next = randoms(0x5eed_3);
      for (const timezone of ZONES) {
        for (const kind of NAMED) {
          for (let trial = 0; trial < 40; trial += 1) {
            const now = new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 4 * 365 * DAY_MS));
            const window = resolveSpan({ kind, offset: 0, timezone }, now);
            assert.ok(
              window.from.getTime() <= now.getTime(),
              `${kind} in ${timezone}: the period in progress started after now`,
            );
            assert.equal(window.to.getTime(), now.getTime(), 'and ends at it');
          }
        }
      }
    });
  });

  describe('goes through §6’s rules rather than restating them', () => {
    const now = new Date('2026-09-11T05:30:00Z');

    it('shortens an over-long custom span before it labels it', () => {
      // **The reason this rule is applied to the window and not left to `planSeries`.** If the
      // 731-day span reached the planner intact, the plan would quietly cover 365 days while the
      // report's own header still said two years. A graph that shortens its axis is self-evident;
      // a PDF in a compliance folder is not.
      const window = resolveSpan(
        {
          kind: 'custom',
          from: '2024-01-01T00:00:00Z',
          to: '2026-01-01T00:00:00Z',
          timezone: 'UTC',
        },
        now,
      );
      const days = (window.to.getTime() - window.from.getTime()) / DAY_MS;
      assert.equal(days, SHORTENED_RANGE_DAYS);
      assert.equal(window.label, '2025-01-01T00:00/2026-01-01T00:00 (UTC)');
      assert.equal(window.adjustments.length, 1);
      assert.equal(window.adjustments[0]?.kind, 'range-shortened');

      // And the planner then finds nothing left to shorten, which is the claim that the two
      // copies of this rule cannot disagree: there is only ever one shortening.
      const planned = planReportSpan(
        { kind: 'custom', from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
        now,
      );
      assert.equal(
        planned.window.adjustments.filter((one) => one.kind === 'range-shortened').length,
        1,
      );
    });

    it('forces at least hourly averaging on any span of 40 days or more', () => {
      const next = randoms(0x5eed_4);
      for (const timezone of ZONES) {
        for (const kind of NAMED) {
          for (let trial = 0; trial < 20; trial += 1) {
            const at = new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 4 * 365 * DAY_MS));
            // Pinned as fine as the author can ask for, which is what the rule exists to overrule.
            const { window, plan } = planReportSpan(
              { kind, offset: 1, timezone, resolutionSeconds: 15 },
              at,
            );
            const days = (window.to.getTime() - window.from.getTime()) / DAY_MS;
            if (days < FORCED_AVERAGING_FROM_DAYS) continue;
            assert.ok(
              plan.bucketSeconds >= FORCED_AVERAGING_MIN_SECONDS,
              `${kind} in ${timezone} is ${String(days)} days at ${String(plan.bucketSeconds)}s`,
            );
            assert.notEqual(plan.source, 'sample', 'and is answered by a rollup, never by raw');
            assert.ok(
              window.adjustments.some((one) => one.kind === 'resolution-coarsened'),
              'and says so',
            );
          }
        }
      }
    });

    it('leaves a short span alone, so the rule is a bound and not a floor', () => {
      // A day at fifteen seconds is a legitimate report and must stay a day at fifteen seconds;
      // a rule that coarsened everything would be indistinguishable from one that never fired.
      const { plan, window } = planReportSpan(
        { kind: 'day', offset: 1, timezone: 'UTC', resolutionSeconds: 15 },
        now,
      );
      assert.equal(plan.bucketSeconds, 15);
      assert.equal(plan.source, 'sample');
      assert.deepEqual(window.adjustments, []);
    });

    it('never resolves to a window longer than the rules allow', () => {
      const next = randoms(0x5eed_5);
      for (const timezone of ZONES) {
        for (const kind of REPORT_SPAN_KINDS) {
          for (let trial = 0; trial < 20; trial += 1) {
            const at = new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 4 * 365 * DAY_MS));
            const span: ReportSpan =
              kind === 'custom'
                ? {
                    kind,
                    timezone,
                    from: new Date(
                      at.getTime() - Math.floor(next() * 2_000 * DAY_MS),
                    ).toISOString(),
                    to: at.toISOString(),
                  }
                : { kind, offset: 1, timezone };
            const window = resolveSpan(span, at);
            const days = (window.to.getTime() - window.from.getTime()) / DAY_MS;
            assert.ok(
              days <= MAX_RANGE_DAYS,
              `${kind} in ${timezone} resolved to ${String(days)} days`,
            );
          }
        }
      }
    });

    it('refuses a stored span it cannot read, rather than letting it reach the planner', () => {
      // `validateSpan` guards the write, but this runs on whatever is in the column — a restored
      // backup, a row edited by hand. An unreadable instant reaching `planSeries` would throw a
      // `QueryError` the report routes do not handle, and one bad row would 500 a whole listing.
      for (const span of [
        { kind: 'custom' as const },
        { kind: 'custom' as const, from: 'whenever', to: '2026-01-01T00:00:00Z' },
        { kind: 'custom' as const, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      ]) {
        assert.throws(
          () => resolveSpan(span, now),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'REPORT_INVALID');
            return true;
          },
          JSON.stringify(span),
        );
      }
    });

    it('refuses a period that has not started, rather than rendering an empty document', () => {
      // A monthly report with `offset: 0` fetched at 00:00:00.000 on the 1st. Reachable, and an
      // empty PDF would look exactly like a total outage.
      const midnight = new Date('2026-09-01T00:00:00.000Z');
      assert.throws(
        () => planReportSpan({ kind: 'month', offset: 0, timezone: 'UTC' }, midnight),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_INVALID');
          assert.match((error as { message: string }).message, /covers no time yet/);
          return true;
        },
      );
      // One millisecond later it is a report about one millisecond, which is fine and not our
      // business to refuse.
      assert.ok(
        planReportSpan(
          { kind: 'month', offset: 0, timezone: 'UTC' },
          new Date(midnight.getTime() + 1),
        ).plan.bucketCount > 0,
      );
    });
  });

  describe('is checked on the write, not on the run', () => {
    it('accepts every kind it declares', () => {
      for (const kind of NAMED) {
        assert.equal(validateSpan({ kind }).kind, kind);
      }
      assert.equal(
        validateSpan({ kind: 'custom', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' })
          .kind,
        'custom',
      );
    });

    it('refuses a kind, a zone or an offset it cannot act on', () => {
      assert.throws(() => validateSpan({ kind: 'fortnight' }), /no report span called/);
      assert.throws(() => validateSpan('month'), /an object naming a period/);
      assert.throws(() => validateSpan(null), /an object naming a period/);
      assert.throws(
        () => validateSpan({ kind: 'month', timezone: 'Europe/Berlim' }),
        /not a time zone this system knows/,
      );
      assert.throws(() => validateSpan({ kind: 'month', offset: -1 }), /0 to 1000 periods back/);
      assert.throws(
        () => validateSpan({ kind: 'month', offset: MAX_SPAN_OFFSET + 1 }),
        /0 to 1000 periods back/,
      );
      assert.throws(() => validateSpan({ kind: 'month', offset: 1.5 }), /0 to 1000 periods back/);
    });

    it('will not let the two ways of naming a period be mixed', () => {
      // A span carrying both an offset and a start reads as though somebody meant one of them,
      // and silently honouring whichever the code happens to check first is how a report ends up
      // covering a period nobody asked for.
      assert.throws(
        () => validateSpan({ kind: 'custom', offset: 1, from: 'x', to: 'y' }),
        /no offset/,
      );
      assert.throws(
        () => validateSpan({ kind: 'month', from: '2026-01-01T00:00:00Z' }),
        /no start and end of its own/,
      );
    });

    it('refuses a custom span that is not two readable instants in order', () => {
      assert.throws(() => validateSpan({ kind: 'custom', to: '2026-01-01T00:00:00Z' }), /"from"/);
      assert.throws(
        () => validateSpan({ kind: 'custom', from: 'last tuesday', to: '2026-01-01T00:00:00Z' }),
        /not an instant this system can read/,
      );
      assert.throws(
        () =>
          validateSpan({
            kind: 'custom',
            from: '2026-02-01T00:00:00Z',
            to: '2026-01-01T00:00:00Z',
          }),
        /ends after it starts/,
      );
    });

    it('refuses a pinned averaging interval that is not a count of seconds', () => {
      assert.throws(
        () => validateSpan({ kind: 'month', resolutionSeconds: 0 }),
        /whole number of seconds/,
      );
      assert.throws(
        () => validateSpan({ kind: 'month', resolutionSeconds: 1.5 }),
        /whole number of seconds/,
      );
    });

    it('drops nothing it accepted', () => {
      const span = validateSpan({
        kind: 'quarter',
        offset: 3,
        timezone: 'Pacific/Chatham',
        resolutionSeconds: 3_600,
      });
      assert.deepEqual(span, {
        kind: 'quarter',
        offset: 3,
        timezone: 'Pacific/Chatham',
        resolutionSeconds: 3_600,
      });
    });
  });
});
