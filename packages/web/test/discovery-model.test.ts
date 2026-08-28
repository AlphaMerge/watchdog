import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  LONG_RUN_SECONDS,
  SWEEP_SHARE,
  estimateText,
  isActive,
  isLong,
  orderedLevels,
  phaseOf,
  pollIntervalMs,
  progressOf,
  whyNotStartable,
} from '../src/routes/discovery-model';
import { descendantsOf } from '../src/routes/DiscoveryView';
import type { DiscoveryLevelEstimate, DiscoveryRun, ObjectSummary } from '../src/api/types';

/**
 * The discovery page's arithmetic and wording (`D-10`).
 *
 * Every case here is a judgement that can be wrong without anything failing: what one bar means
 * for a run with two phases of unrelated size, how a bracket of seconds reads, and why a
 * disabled button is disabled. Rendering assertions would prove a `<div>` exists; these prove
 * the thing the operator reads.
 */

const RUN: DiscoveryRun = {
  id: 1,
  groupId: 10,
  probeId: 2,
  range: '10.0.0.0/24',
  total: 254,
  cursor: 0,
  found: 0,
  failed: 0,
  status: 'running',
  level: 'standard',
  templates: [],
  identified: 0,
  identifyCursor: 0,
  scheduleId: null,
  snmpCommunity: '',
  devicesCreated: 0,
  devicesMatched: 0,
  sensorsCreated: 0,
  provisionedAt: null,
  message: '',
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  createdAt: '2026-08-27T12:00:00.000Z',
  startedAt: '2026-08-27T12:00:01.000Z',
  finishedAt: null,
};

const run = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({ ...RUN, ...over });

function level(over: Partial<DiscoveryLevelEstimate> = {}): DiscoveryLevelEstimate {
  return {
    id: 'standard',
    name: 'Standard',
    description: 'ports, reverse DNS and SNMP',
    minSeconds: 8,
    maxSeconds: 32,
    ports: 12,
    ...over,
  };
}

describe('progress', () => {
  it('gives the sweep a fixed share rather than its own count', () => {
    // The two phases have nothing to do with each other's size — a /24 with three live hosts is
    // 254 sweeps and 3 identifications — so weighting by count would make the bar leap from 5%
    // to 100% the moment the sweep ended.
    expect(progressOf(run({ cursor: 254, found: 3, status: 'identifying' }))).toBeCloseTo(
      SWEEP_SHARE,
    );
    expect(
      progressOf(run({ cursor: 254, found: 3, identifyCursor: 3, status: 'identifying' })),
    ).toBeCloseTo(1);
  });

  it('moves smoothly through the sweep', () => {
    expect(progressOf(run({ cursor: 127 }))).toBeCloseTo(0.5 * SWEEP_SHARE, 2);
  });

  it('gives a ping-only run the whole bar for its sweep', () => {
    // It never identifies, so stopping at 70% would leave it looking stuck at the end.
    expect(progressOf(run({ level: 'ping', cursor: 254 }))).toBe(1);
  });

  it('is complete when a sweep that found nothing moves to identification', () => {
    // There is nothing to identify. Dividing by zero found hosts would be NaN, and a bar that
    // sat at 70% for ever would say a finished run was still working.
    expect(progressOf(run({ cursor: 254, found: 0, status: 'identifying' }))).toBe(1);
  });

  it('is complete when the run is done, whatever the counters say', () => {
    // A cancelled-then-finished run, or one whose last progress message was lost: the status is
    // the authority, and a bar reading 96% under the word "finished" is a bug report.
    expect(progressOf(run({ status: 'done', cursor: 100 }))).toBe(1);
  });

  it('never exceeds one when a resumed sweep replays addresses', () => {
    // `D-01`'s cursor is a floor rather than a promise, so a replay can report more swept than
    // the range holds.
    expect(progressOf(run({ level: 'ping', cursor: 300 }))).toBe(1);
  });

  it('is zero for an empty range rather than NaN', () => {
    expect(progressOf(run({ total: 0 }))).toBe(0);
  });
});

describe('what it is doing', () => {
  it('says each status in words an operator would use', () => {
    expect(phaseOf(run({ status: 'queued' }))).toBe('waiting for its probe');
    expect(phaseOf(run({ status: 'running' }))).toBe('sweeping');
    expect(phaseOf(run({ status: 'identifying' }))).toBe('identifying');
    expect(phaseOf(run({ status: 'done' }))).toBe('finished');
  });

  it('knows which statuses are still worth asking about', () => {
    expect(isActive('queued')).toBe(true);
    expect(isActive('identifying')).toBe(true);
    expect(isActive('done')).toBe(false);
    expect(isActive('cancelled')).toBe(false);
    expect(isActive('failed')).toBe(false);
  });

  it('stops polling the moment a run stops', () => {
    expect(pollIntervalMs(run({ status: 'done' }))).toBeNull();
    expect(pollIntervalMs(null)).toBeNull();
  });

  it('asks less often about a run that is waiting for a probe', () => {
    // What it is waiting for is a probe to connect, which does not happen in two seconds.
    const queued = pollIntervalMs(run({ status: 'queued' }));
    const going = pollIntervalMs(run({ status: 'running' }));
    expect(queued).not.toBeNull();
    expect(going).not.toBeNull();
    expect(queued ?? 0).toBeGreaterThan(going ?? 0);
  });
});

describe('the estimate', () => {
  it('shows both ends in the unit the larger one needs', () => {
    // "8 s – 4 minutes" reads as a mistake. The bracket is the answer `D-06` computed, so it is
    // shown as one thing.
    expect(estimateText(8, 32)).toBe('8–32 seconds');
    expect(estimateText(60, 240)).toBe('1–4 minutes');
    expect(estimateText(1_020, 8_160)).toBe('17–136 minutes');
    expect(estimateText(3_600, 14_400)).toBe('1–4 hours');
  });

  it('collapses to one number when both ends round the same way', () => {
    expect(estimateText(30, 30)).toBe('30 seconds');
  });

  it('says one second rather than 1 seconds', () => {
    // Found live: a /29 previews at a second, and the page read "1 seconds".
    expect(estimateText(1, 1)).toBe('1 second');
    expect(estimateText(60, 60)).toBe('1 minute');
    // Only when the whole bracket collapses to one. A range that reaches two is plural, and so
    // is a fractional single unit.
    expect(estimateText(1, 2)).toBe('1–2 seconds');
    expect(estimateText(5_400, 5_400)).toBe('1.5 hours');
  });

  it('keeps a decimal only where it changes the answer', () => {
    expect(estimateText(5_400, 5_400)).toBe('1.5 hours');
    expect(estimateText(1_020, 1_020)).toBe('17 minutes');
  });

  it('picks the unit from the low end, not the high one', () => {
    // Picking by the high end reported a /16 standard sweep as "0.3–2.3 hours", where `D-06`
    // measured it as 17–136 minutes. The same number, said worse — a bracket that opens with a
    // leading zero reads as "no time at all" for something that takes a quarter of an hour.
    expect(estimateText(1_020, 8_160)).not.toMatch(/^0/);
  });

  it('lets the high end choose when the low end is under a second', () => {
    // A level that costs nothing when everything answers. Only once the high end is well into
    // the larger unit, or "0–64 seconds" would become "0–1.1 minutes".
    expect(estimateText(0, 64)).toBe('0–64 seconds');
    expect(estimateText(0, 14_400)).toBe('0–4 hours');
  });

  it('reads a reversed pair as the same bracket', () => {
    // Defensive rather than expected: a level table that ever reported them the other way round
    // should still read as an estimate rather than as "32–8 seconds".
    expect(estimateText(32, 8)).toBe('8–32 seconds');
  });
});

describe('the level list', () => {
  it('offers them cheapest first, so the expensive one is never the default thumb target', () => {
    const levels = [
      level({ id: 'detailed', maxSeconds: 64, ports: 32 }),
      level({ id: 'ping', maxSeconds: 8, ports: 0 }),
      level({ id: 'standard', maxSeconds: 32, ports: 12 }),
    ];
    expect(orderedLevels(levels).map((one) => one.id)).toEqual(['ping', 'standard', 'detailed']);
  });

  it('does not reorder the caller’s array', () => {
    const levels = [
      level({ id: 'detailed', maxSeconds: 64 }),
      level({ id: 'ping', maxSeconds: 8 }),
    ];
    orderedLevels(levels);
    expect(levels[0]?.id).toBe('detailed');
  });

  it('warns about a run somebody would walk away from', () => {
    expect(isLong(level({ maxSeconds: LONG_RUN_SECONDS - 1 }))).toBe(false);
    expect(isLong(level({ maxSeconds: LONG_RUN_SECONDS }))).toBe(true);
  });
});

describe('what is stopping the start', () => {
  it('names the missing thing rather than leaving a disabled button unexplained', () => {
    expect(whyNotStartable(EMPTY_DRAFT, false)).toMatch(/probe/);
    expect(whyNotStartable({ ...EMPTY_DRAFT, probeId: 2 }, false)).toMatch(/group/);
    expect(whyNotStartable({ ...EMPTY_DRAFT, probeId: 2, groupId: 10 }, false)).toMatch(/range/);
  });

  it('waits for the core’s opinion of the range rather than forming its own', () => {
    // A second range parser in the browser would eventually disagree with the one that runs.
    const filled = { ...EMPTY_DRAFT, probeId: 2, groupId: 10, range: '10.0.0.0/24' };
    expect(whyNotStartable(filled, false)).toMatch(/core accepts/);
    expect(whyNotStartable(filled, true)).toBeNull();
  });

  it('treats a range of only spaces as empty', () => {
    const spaces = { ...EMPTY_DRAFT, probeId: 2, groupId: 10, range: '   ' };
    expect(whyNotStartable(spaces, true)).toMatch(/enter a range/);
  });
});

describe('the groups under a probe', () => {
  const object = (id: number, parentId: number | null, kind: ObjectSummary['kind']) =>
    ({
      id,
      parentId,
      kind,
      name: `o${String(id)}`,
      tags: [],
      priority: 3,
      version: 1,
      hasChildren: false,
    }) satisfies ObjectSummary;

  it('finds a group nested several levels down', () => {
    const groups = [object(10, 2, 'group'), object(11, 10, 'group'), object(12, 3, 'group')];
    expect(descendantsOf(groups, 2).map((one) => one.id)).toEqual([10, 11]);
  });

  it('returns nothing for a probe with no groups', () => {
    expect(descendantsOf([object(12, 3, 'group')], 2)).toEqual([]);
  });

  it('terminates on a parent chain that loops', () => {
    // The core refuses a cycle, so this is belt and braces — but a browser that hung would be a
    // frozen tab with no error, which is the worst way to find out.
    const looped = [object(10, 11, 'group'), object(11, 10, 'group')];
    expect(descendantsOf(looped, 2)).toEqual([]);
  });
});
