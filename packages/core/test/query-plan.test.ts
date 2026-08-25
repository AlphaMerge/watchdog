import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_BUCKETS,
  planSeries,
  QueryError,
  segmentsFor,
  snapUp,
  sourceFor,
  type SeriesPlan,
} from '../src/timeseries/query.js';
import type { RollupTierId } from '../src/timeseries/tiers.js';

const DAY = 86_400_000;
const END = new Date('2026-08-20T00:00:00.000Z');

function ago(days: number): Date {
  return new Date(END.getTime() - days * DAY);
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/**
 * The query rules are PRTG's (CAPABILITIES.MD §9, WORKFLOW.MD §9) and they are pure functions of
 * the request, so they are tested as such — no database, no clock. Every rule here exists
 * because a monitoring UI that lets someone ask for a year of raw data will be asked for one.
 */
describe('series query planning', () => {
  it('refuses a range that does not go forwards', () => {
    const error = captureError(() => planSeries({ from: END, to: ago(1) }));
    assert.ok(error instanceof QueryError);
    assert.match(error.message, /to must be after from/);
  });

  it('refuses timestamps it cannot read', () => {
    const error = captureError(() => planSeries({ from: new Date('not a date'), to: END }));
    assert.ok(error instanceof QueryError);
  });

  it('shortens a range over 500 days to 365, keeping the recent end', () => {
    const plan = planSeries({ from: ago(600), to: END, resolutionSeconds: 86_400 });

    assert.equal(plan.to.getTime(), END.getTime(), 'the end is what someone actually wanted');
    assert.equal((plan.to.getTime() - plan.from.getTime()) / DAY, 365);
    const adjustment = plan.adjustments.find((a) => a.kind === 'range-shortened');
    assert.ok(adjustment);
    assert.equal(adjustment.requestedDays, 600);
    assert.equal(adjustment.effectiveDays, 365);
  });

  it('forces at least hourly averaging beyond 40 days, and says so', () => {
    const plan = planSeries({ from: ago(60), to: END, resolutionSeconds: 60 });

    assert.equal(plan.bucketSeconds, 3_600);
    assert.equal(plan.source, 'sample_1h');
    const adjustment = plan.adjustments.find((a) => a.kind === 'resolution-coarsened');
    assert.ok(adjustment);
    assert.equal(adjustment.requestedSeconds, 60);
    assert.equal(adjustment.effectiveSeconds, 3_600);
    assert.match(adjustment.reason, /40 days or more/);
  });

  it('leaves a short range at the fine resolution it asked for', () => {
    const plan = planSeries({ from: ago(2), to: END, resolutionSeconds: 15 });

    assert.equal(plan.bucketSeconds, 15);
    assert.equal(plan.source, 'sample');
    assert.deepEqual(plan.adjustments, [], 'nothing was changed, so nothing is reported');
    assert.equal(plan.bucketCount, (2 * DAY) / 15_000);
  });

  it('rounds an unsupported resolution up to one the product offers', () => {
    const plan = planSeries({ from: ago(1), to: END, resolutionSeconds: 45 });

    assert.equal(plan.bucketSeconds, 60);
    const adjustment = plan.adjustments.find((a) => a.kind === 'resolution-coarsened');
    assert.ok(adjustment);
    assert.equal(adjustment.requestedSeconds, 45);
    assert.match(adjustment.reason, /supported averaging interval/);
  });

  it('picks the coarsest tier whose buckets divide the requested ones', () => {
    // The condition is exact division, not "close enough": five-minute rows build a ten-minute
    // bucket but not a seven-minute one, and splitting them across a boundary that does not
    // exist would invent numbers.
    assert.equal(sourceFor(15), 'sample');
    assert.equal(sourceFor(60), 'sample');
    assert.equal(sourceFor(300), 'sample_5m');
    assert.equal(sourceFor(600), 'sample_5m');
    assert.equal(sourceFor(420), 'sample', 'seven minutes does not divide by five');
    assert.equal(sourceFor(3_600), 'sample_1h');
    assert.equal(sourceFor(21_600), 'sample_1h');
    assert.equal(sourceFor(86_400), 'sample_1d');
  });

  it('steers a query with no stated resolution onto a width a tier can serve', () => {
    // A month at "about a thousand buckets" lands on 43.2 minutes, and 44 minutes does not
    // divide by five — so the honest snap would read a month of raw. 45 minutes answers the
    // same question from a thirtieth of the rows.
    const plan = planSeries({ from: ago(30), to: END });

    assert.equal(plan.bucketSeconds, 2_700);
    assert.equal(plan.source, 'sample_5m');
    assert.equal(plan.bucketCount, 960);
    assert.deepEqual(plan.adjustments, [], 'nobody asked for anything, so nothing was overruled');
  });

  it('honours an awkward explicit resolution even though it costs a raw scan', () => {
    // The opposite side of the same trade. Someone who asked for 44-minute buckets gets them;
    // `source` says where they came from rather than the resolution quietly changing.
    const plan = planSeries({ from: ago(30), to: END, resolutionSeconds: 2_640 });

    assert.equal(plan.bucketSeconds, 2_640);
    assert.equal(plan.source, 'sample');
    assert.deepEqual(plan.adjustments, []);
  });

  it('defaults a two-day view to about a graph width of buckets', () => {
    const plan = planSeries({ from: ago(2), to: END });
    assert.equal(plan.bucketSeconds, 180);
    assert.equal(plan.bucketCount, 960);
    assert.equal(plan.source, 'sample');
  });

  it('defaults a year to hourly-composable buckets', () => {
    const plan = planSeries({ from: ago(365), to: END });
    assert.equal(plan.source, 'sample_1h');
    assert.ok(plan.bucketCount <= 1_000, `got ${String(plan.bucketCount)} buckets`);
  });

  it('coarsens rather than truncating when an answer would be too long', () => {
    // 39 days at fifteen seconds is 224,640 buckets — inside the forced-averaging threshold, so
    // no other rule catches it. Clipping the range would answer a different question.
    const plan = planSeries({ from: ago(39), to: END, resolutionSeconds: 15 });

    assert.ok(plan.bucketCount <= MAX_BUCKETS, `got ${String(plan.bucketCount)} buckets`);
    assert.equal(plan.bucketSeconds, snapUp(Math.ceil((39 * 86_400) / MAX_BUCKETS)));
    assert.equal((plan.to.getTime() - plan.from.getTime()) / DAY, 39, 'the range is untouched');
    assert.ok(plan.adjustments.some((a) => a.kind === 'resolution-coarsened'));
  });

  it('aligns both ends to whole buckets', () => {
    const plan = planSeries({
      from: new Date('2026-08-19T10:07:23.456Z'),
      to: new Date('2026-08-19T11:02:11.000Z'),
      resolutionSeconds: 300,
    });

    assert.equal(plan.from.toISOString(), '2026-08-19T10:05:00.000Z');
    assert.equal(plan.to.toISOString(), '2026-08-19T11:05:00.000Z');
    assert.equal(plan.bucketCount, 12);
  });
});

describe('series read segments', () => {
  function plan(source: SeriesPlan['source'], fromDays: number, toDays = 0): SeriesPlan {
    return {
      from: ago(fromDays),
      to: ago(toDays),
      bucketSeconds: 300,
      bucketCount: 1,
      source,
      adjustments: [],
    };
  }

  const watermarks = (entries: Partial<Record<RollupTierId, Date>>): Map<RollupTierId, Date> =>
    new Map(Object.entries(entries) as [RollupTierId, Date][]);

  it('reads only the tier when it has caught up with the range', () => {
    const segments = segmentsFor(plan('sample_5m', 3, 1), watermarks({ sample_5m: ago(0) }));
    assert.deepEqual(
      segments.map((s) => s.table),
      ['sample_5m'],
    );
    assert.equal(segments[0]?.to.getTime(), ago(1).getTime());
  });

  it('adds the unmaterialised tail from raw', () => {
    // There is no real-time aggregation here, so a tier stops at its watermark. Reading it alone
    // would silently drop the newest few minutes — the part of a graph anyone is looking at.
    const segments = segmentsFor(plan('sample_5m', 3), watermarks({ sample_5m: ago(0.5) }));

    assert.deepEqual(
      segments.map((s) => s.table),
      ['sample_5m', 'sample'],
    );
    const [tier, tail] = segments;
    assert.ok(tier && tail);
    assert.equal(tier.from.getTime(), ago(3).getTime());
    assert.equal(tier.to.getTime(), ago(0.5).getTime());
    assert.equal(tail.from.getTime(), ago(0.5).getTime(), 'contiguous, never overlapping');
    assert.equal(tail.to.getTime(), ago(0).getTime());
  });

  it('walks the whole chain when several tiers are behind', () => {
    const segments = segmentsFor(
      plan('sample_1d', 400),
      watermarks({ sample_1d: ago(3), sample_1h: ago(1), sample_5m: ago(0.1) }),
    );

    assert.deepEqual(
      segments.map((s) => s.table),
      ['sample_1d', 'sample_1h', 'sample_5m', 'sample'],
    );
    // Contiguous and disjoint, which is what lets the union be summed without double counting.
    for (let index = 1; index < segments.length; index += 1) {
      assert.equal(segments[index]?.from.getTime(), segments[index - 1]?.to.getTime());
    }
    assert.equal(segments.at(-1)?.to.getTime(), ago(0).getTime());
  });

  it('skips a tier that has never run', () => {
    const segments = segmentsFor(plan('sample_1d', 10), watermarks({ sample_5m: ago(0.1) }));
    assert.deepEqual(
      segments.map((s) => s.table),
      ['sample_5m', 'sample'],
      'nothing daily or hourly has been materialised, so there is nothing to read there',
    );
  });

  it('reads raw alone when the resolution needs it', () => {
    const segments = segmentsFor(
      plan('sample', 2),
      watermarks({ sample_1d: ago(1), sample_1h: ago(1), sample_5m: ago(1) }),
    );
    assert.deepEqual(
      segments.map((s) => s.table),
      ['sample'],
    );
  });
});
