import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  AvailableMemoryWatch,
  MemorySampler,
  PROTOCOL_VERSION,
  type AvailableMemoryLow,
} from '@ms/shared';
import {
  PROCESS_INSTANCE,
  ProbeHealthReporter,
  type NameResolutionHealth,
} from '../src/health/report.js';
import type { ProcessRunnerStats } from '../src/runner/process-runner.js';
import type { PoolStats } from '../src/runner/pool.js';
import type { LookupCounters } from '../src/runner/types.js';
import type { DrainStats } from '../src/spool/drain.js';
import type { SpoolStats } from '../src/spool/spool.js';
import type { WheelStats } from '../src/scheduler/wheel.js';

/**
 * The probe's half of Probe Health (`P-13`, `P-04`).
 *
 * Only the probe can measure any of this — the wheel is the only thing that knows the instant a
 * tick *should* have run at, the pool is the only place a deferred check exists, and the spool
 * is a directory on the probe's own disk. What matters here is that absent stays absent: a build
 * with no spool must not report a confident zero that cannot be told from an empty one.
 */

const WHEEL: WheelStats = {
  tasks: 120,
  tick: 900,
  dispatched: 5_000,
  skippedTicks: 2,
  clockJumps: 1,
  lagMs: { p50: 2, p95: 11, p99: 30, max: 90 },
};

const POOL: PoolStats = {
  size: 48,
  maxSize: 64,
  ceiling: 50,
  memoryCap: 50,
  heldBack: 14,
  grown: 0,
  shrunk: 0,
  busy: 12,
  queued: 3,
  submitted: 900,
  completed: 880,
  failed: 5,
  timedOut: 1,
  deferred: 7,
  refused: 2,
  discarded: 0,
  disabled: false,
  workerCrashes: 0,
  startupFailed: 6,
  channelsDropped: 100,
  waitMs: { p50: 1, p95: 40, p99: 90, max: 500 },
  runMs: { p50: 30, p95: 200, p99: 900, max: 3_000 },
};

const CHILDREN: ProcessRunnerStats = {
  maxConcurrent: 4,
  running: 3,
  queued: 9,
  submitted: 200,
  completed: 180,
  failed: 6,
  timedOut: 2,
  deferred: 11,
  refused: 5,
  crashed: 1,
  startupFailed: 4,
  scriptGroupsEnded: 8,
  scriptGroupsRefused: 1,
  scriptGroupsRecycled: 3,
  channelsDropped: 20,
  waitMs: { p50: 30, p95: 400, p99: 900, max: 3_000 },
  runMs: { p50: 200, p95: 2_000, p99: 4_000, max: 9_000 },
  startupMs: { p50: 25, p95: 9_400, p99: 14_800, max: 30_000 },
};

const SPOOL: SpoolStats = {
  pending: 500,
  bytes: 2_097_152,
  segments: 1,
  dropped: 4,
  corrupt: 0,
  unwritten: 2,
};

const DRAIN: DrainStats = {
  sent: 40,
  backlog: 500,
  maxRetryAfterMs: 0,
  rejected: 0,
  retried: 1,
  oversized: 0,
  channelsDropped: 3,
  stalledForMs: 0,
};

/** Gate mode's own (`NameResolutionHealth.gate`): the latch and three counts, protocol 38's. */
const GATE = {
  trouble: 0,
  checkOnSeconds: 0,
  passedStuck: 0,
  helperStuck: 0,
} as const;

/**
 * The eight S6 built and the user's decision of 2026-10-18 left out (OPEN-5, `P-467`): never in a
 * report, in either mode. What they would carry is the probe log's, and its hourly summary's.
 */
const NOT_SENT = [
  'lookupHelperState',
  'lookupHelperLosses',
  'lookupHelperMemory',
  'nameCheckState',
  'nameLookupsHeard',
  'nameLookupsToHelper',
  'nameCheckMisses',
  'nameWalksDeferred',
] as const;

function reporter(options: {
  children?: boolean;
  /** The child runner's numbers, when a test needs other than `CHILDREN`. */
  childStats?: ProcessRunnerStats;
  spool?: boolean;
  drain?: boolean;
  stalledForMs?: number;
  cpuUs?: number[];
  elapsedNs?: number[];
  rss?: number;
  uptime?: number;
  /** What the machine has left; `null` is a platform that cannot say. Defaults to that. */
  machine?: AvailableMemoryLow | null;
  /** Headroom to the probe's own ceiling; `null` is no ceiling. Defaults to that. */
  limit?: AvailableMemoryLow | null;
  /** A real sampler, for the tests about when memory is read. Replaces `machine` and `limit`. */
  memory?: MemorySampler;
  /** What the pool's workers' lookups add up to (`A-66`). Absent, the pool reports none. */
  poolLookups?: LookupCounters;
  /** The main thread's own lookups (`A-66`). Absent, no such source. */
  mainLookups?: LookupCounters;
  /** The answers loaded at start (`P-438`). Absent, no such source. */
  answersLoaded?: number;
  /** How the probe resolves names (`P-432`, `P-441`). Absent, no such source. */
  names?: () => NameResolutionHealth;
  /** The questions open at their most, taken per heartbeat (`P-432`). Absent, no such source. */
  questionsPeak?: { take: () => number; peek: () => number };
}): ProbeHealthReporter {
  let cpuCall = 0;
  let clockCall = 0;
  let cpu = 0;
  let clock = 0n;
  return new ProbeHealthReporter({
    scheduler: () => WHEEL,
    pool: () =>
      options.poolLookups === undefined ? POOL : { ...POOL, lookups: options.poolLookups },
    ...(options.mainLookups === undefined
      ? {}
      : {
          lookups: (): LookupCounters => options.mainLookups ?? { inFlight: 0, givenUp: 0 },
        }),
    ...(options.answersLoaded === undefined
      ? {}
      : { answersLoaded: (): number => options.answersLoaded ?? 0 }),
    ...(options.names === undefined ? {} : { names: options.names }),
    ...(options.questionsPeak === undefined ? {} : { questionsPeak: options.questionsPeak }),
    ...(options.children === false ? {} : { children: () => options.childStats ?? CHILDREN }),
    ...(options.spool === false ? {} : { spool: () => SPOOL }),
    ...(options.drain === false
      ? {}
      : { drain: () => ({ ...DRAIN, stalledForMs: options.stalledForMs ?? 0 }) }),
    memory: options.memory ?? {
      machine: { lowest: () => options.machine ?? null, takeLow: () => options.machine ?? null },
      limit: { lowest: () => options.limit ?? null, takeLow: () => options.limit ?? null },
      start: () => undefined,
      stop: () => undefined,
    },
    process: {
      cpuUsage: () => {
        cpu += options.cpuUs?.[cpuCall] ?? 0;
        cpuCall += 1;
        return { user: Math.floor(cpu / 2), system: cpu - Math.floor(cpu / 2) };
      },
      memoryUsage: () => ({ rss: options.rss ?? 0 }),
      uptime: () => options.uptime ?? 0,
      hrtime: () => {
        clock += BigInt(options.elapsedNs?.[clockCall] ?? 0);
        clockCall += 1;
        return clock;
      },
    },
  });
}

describe('the probe’s own health report', () => {
  it('carries the numbers only the probe can measure', () => {
    const report = reporter({}).report();
    assert.equal(report.scheduled, 120);
    assert.deepEqual(report.schedulerLagMs, { p50: 2, p95: 11, p99: 30, max: 90 });
    assert.equal(report.poolSize, 48);
    assert.equal(report.poolBusy, 12);
    assert.equal(report.queued, 3);
    assert.deepEqual(report.queueWaitMs, { p50: 1, p95: 40, p99: 90, max: 500 });
    assert.equal(report.deferred, 7);
    assert.equal(report.refused, 2);
    assert.equal(report.workerCrashes, 0);
    assert.equal(report.clockJumps, 1);
  });

  it('reports the workers the pool could not start, apart from its crashes (`P-263`)', () => {
    // A worker still loading at its start-up bound is terminated and replaced; nothing crashed.
    const report = reporter({}).report();
    assert.equal(report.workerStartupFailed, 6);
    assert.equal(report.workerCrashes, 0);
  });

  it('reports the name lookups of the pool’s workers and of the main thread together (`A-66`)', () => {
    // One libuv thread pool under both, so the probe's count is their sum. Distinct values, so a
    // field reading its neighbour, or one side dropped, is seen.
    const both = reporter({
      poolLookups: { inFlight: 30, givenUp: 1_200 },
      mainLookups: { inFlight: 7, givenUp: 50 },
    }).report();
    assert.equal(both.lookupsInFlight, 37);
    assert.equal(both.lookupsGivenUp, 1_250);
    const pool = reporter({ poolLookups: { inFlight: 30, givenUp: 1_200 } }).report();
    assert.equal(pool.lookupsInFlight, 30);
    assert.equal(pool.lookupsGivenUp, 1_200);
    const main = reporter({ mainLookups: { inFlight: 7, givenUp: 50 } }).report();
    assert.equal(main.lookupsInFlight, 7);
    assert.equal(main.lookupsGivenUp, 50);
  });

  it('leaves the name lookups out when nothing counts them, so both gap (`A-66`)', () => {
    // A registry that does not count them reports none, and no zero may stand in for that.
    const report = reporter({}).report();
    assert.equal('lookupsInFlight' in report, false);
    assert.equal('lookupsGivenUp' in report, false);
  });

  it('reports the answers its resolver loaded at start, a zero included, and none with no file (`P-438`)', () => {
    assert.equal(reporter({ answersLoaded: 450 }).report().answersLoaded, 450);
    // No file, or one it could not use: a real zero, which says the probe started cold.
    assert.equal(reporter({ answersLoaded: 0 }).report().answersLoaded, 0);
    // A build without the answer file says nothing, and the channel gaps.
    assert.equal('answersLoaded' in reporter({}).report(), false);
  });

  it('reports system mode as its mode and the domains not answering, and none of the gate’s fields (P-432, P-441)', () => {
    const report = reporter({
      names: () => ({ mode: 1, notAnswering: ['zone-b.test', ''] }),
    }).report();
    assert.equal(report.nameResolverMode, 1);
    assert.deepEqual(report.lookupsNotAnswering, ['zone-b.test', '']);
    // Every gate field but the mode: the documents say the five gap under `system` (`H-50`).
    for (const field of [
      'lookupHelperTrouble',
      'nameCheckOnSeconds',
      'namePassedStuck',
      'nameHelperStuck',
      'nameQuestionsOpen',
      ...NOT_SENT,
    ]) {
      assert.equal(field in report, false, `${field} sent in system mode`);
    }
    // None not answering is said, as an empty list: a gap would say nothing is known.
    assert.deepEqual(
      reporter({ names: () => ({ mode: 1, notAnswering: [] }) }).report().lookupsNotAnswering,
      [],
    );
    // A build without it says nothing at all.
    const none = reporter({}).report();
    assert.equal('nameResolverMode' in none, false);
    assert.equal('lookupsNotAnswering' in none, false);
  });

  it('reports gate mode’s fields, each from its own source (P-432, D29)', () => {
    const report = reporter({
      names: () => ({
        mode: 3,
        notAnswering: ['zone-b.test'],
        gate: { ...GATE, trouble: 1, checkOnSeconds: 3_599.7, passedStuck: 4, helperStuck: 9 },
      }),
      questionsPeak: { take: () => 12, peek: () => 11 },
    }).report({ seq: 1, peerVersion: PROTOCOL_VERSION });
    assert.equal(report.nameResolverMode, 3);
    assert.equal(report.lookupHelperTrouble, 1);
    assert.equal(report.nameCheckOnSeconds, 3_599, 'whole seconds, as the schema takes');
    assert.equal(report.namePassedStuck, 4);
    assert.equal(report.nameHelperStuck, 9);
    assert.equal(report.nameQuestionsOpen, 12);
    // Six name fields, and none of the eight S6 built (OPEN-5, `P-467`).
    assert.deepEqual(
      Object.keys(report)
        .filter((key) => /^(name|lookupHelper)/u.test(key))
        .sort(),
      [
        'lookupHelperTrouble',
        'nameCheckOnSeconds',
        'nameHelperStuck',
        'namePassedStuck',
        'nameQuestionsOpen',
        'nameResolverMode',
      ],
    );
    for (const field of NOT_SENT) assert.equal(field in report, false, field);
  });

  it('reports the questions open at their most since the last heartbeat the core acknowledged (P-432)', () => {
    const peaks = [5, 9, 2, 3, 1];
    let taken = 0;
    const health = reporter({
      names: () => ({
        mode: 2,
        notAnswering: [],
        gate: { ...GATE, trouble: 0, checkOnSeconds: 0, passedStuck: 0, helperStuck: 0 },
      }),
      questionsPeak: { take: () => peaks[taken++] ?? 0, peek: () => 4 },
    });
    const beat = (seq: number) =>
      health.report({ seq, peerVersion: PROTOCOL_VERSION }).nameQuestionsOpen;
    assert.equal(beat(1), 5);
    assert.equal(beat(2), 9, 'the second take was higher');
    // Neither acknowledged yet: the 9 is carried, as a report the core never got must be.
    assert.equal(beat(3), 9);
    health.acknowledged(3);
    assert.equal(beat(4), 3, 'from the acknowledged one on, only what came after');
    health.acknowledged(4);
    assert.equal(beat(5), 1);
    assert.equal(taken, 5, 'one take a heartbeat');
    // A report outside a heartbeat takes nothing, and reads the peak beside what is held.
    assert.equal(health.report().nameQuestionsOpen, 4);
    assert.equal(taken, 5);
  });

  it('reports the child-process runner, which is a second runner and a second set of counters', () => {
    // `P-61`: EXE and Script checks never touch the worker pool, so none of the pool numbers
    // above say anything about them. A probe saturated by slow shell-outs deferred and refused
    // checks while `poolBusy` looked calm and Probe Health said nothing at all.
    const report = reporter({}).report();
    assert.equal(report.childSlots, 4);
    assert.equal(report.childBusy, 3);
    assert.equal(report.childQueued, 9);
    assert.equal(report.childDeferred, 11);
    assert.equal(report.childRefused, 5);
    assert.equal(report.childTimedOut, 2);
    assert.equal(report.childCrashes, 1);
  });

  it('reports the child checks that never started, and how long a start takes (`P-260`)', () => {
    const report = reporter({}).report();
    assert.equal(report.childStartupFailed, 4);
    assert.deepEqual(report.childStartupMs, { p50: 25, p95: 9_400, p99: 14_800, max: 30_000 });
  });

  it('reports the script groups a dead check process left open, each its own count (`P-275`)', () => {
    // Distinct values, so two swapped is a failure. The refused one is the one with a warning.
    const report = reporter({}).report();
    assert.equal(report.scriptGroupsEnded, 8);
    assert.equal(report.scriptGroupsRefused, 1);
    assert.equal(report.scriptGroupsRecycled, 3);
    // A reported zero is a reading: a runner that refused nothing says so.
    const none = reporter({
      childStats: { ...CHILDREN, scriptGroupsEnded: 0, scriptGroupsRefused: 0 },
    }).report();
    assert.equal(none.scriptGroupsEnded, 0);
    assert.equal(none.scriptGroupsRefused, 0);
    // A build with no child runner has none of the three, rather than three zeros.
    const without = reporter({ children: false }).report();
    for (const field of ['scriptGroupsEnded', 'scriptGroupsRefused', 'scriptGroupsRecycled']) {
      assert.equal(field in without, false, `${field} reported with no child runner`);
    }
  });

  it('reports the readings it could not send, from every place one is taken out (`P-283`)', () => {
    // Distinct values in each source, so one left out of the sum, or counted twice, is seen.
    const report = reporter({}).report();
    assert.equal(
      report.resultChannelsDropped,
      123,
      'the pool’s, the child runner’s and the drain’s',
    );
    assert.equal(reporter({ children: false }).report().resultChannelsDropped, 103);
    assert.equal(reporter({ drain: false }).report().resultChannelsDropped, 120);
    // The pool is always there, so the count always is: none dropped is a reading.
    assert.equal(
      new ProbeHealthReporter({
        scheduler: () => WHEEL,
        pool: () => ({ ...POOL, channelsDropped: 0 }),
      }).report().resultChannelsDropped,
      0,
    );
  });

  it('names this process on every report, the same in every reporter it makes (`P-284` review)', () => {
    // The core reads each running total's growth against it: another one is a restart, however
    // long the link was down and whatever the totals and the uptime say.
    assert.match(
      PROCESS_INSTANCE,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'what the core’s schema takes',
    );
    assert.equal(reporter({}).report().instanceId, PROCESS_INSTANCE);
    assert.equal(reporter({ children: false, drain: false }).report().instanceId, PROCESS_INSTANCE);
    const told = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      instanceId: 'another',
    });
    assert.equal(told.report().instanceId, 'another');
  });

  it('reports what the drain discarded, each its own count, and nothing with no drain (`P-283`)', () => {
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      drain: () => ({ ...DRAIN, rejected: 40, oversized: 2 }),
    }).report();
    assert.equal(report.spoolRejected, 40);
    assert.equal(report.spoolOversized, 2);
    const healthy = reporter({}).report();
    assert.equal(healthy.spoolRejected, 0, 'none discarded is a reading');
    assert.equal(healthy.spoolOversized, 0);
    const without = reporter({ drain: false }).report();
    assert.equal('spoolRejected' in without, false);
    assert.equal('spoolOversized' in without, false);
  });

  it('says nothing of a start-up time before any child has started, rather than zero', () => {
    // No start measured is not a start that took no time. The count is a count, and is zero.
    const report = reporter({
      childStats: { ...CHILDREN, startupFailed: 0, startupMs: null },
    }).report();
    assert.equal(report.childStartupFailed, 0);
    assert.equal('childStartupMs' in report, false);
  });

  it('says nothing about a child runner it does not have, rather than zero', () => {
    // The same rule the spool block follows: absent is absent. A build with no isolated sensor
    // types has nothing to report, and a confident 0 cannot be told from a runner sitting idle.
    const report = reporter({ children: false }).report();
    assert.equal(report.childSlots, undefined);
    assert.equal(report.childBusy, undefined);
    assert.equal(report.childRefused, undefined);
  });

  it('names everything that keeps its own counters in ProbeHealthSources', async () => {
    // **The test that would have caught `P-61`, and the only shape that could.** Every number
    // `ProcessRunner` kept was correct; they simply reached nothing, because the interface that
    // decides what Probe Health reads had no key for it. Nothing behavioural can see that — the
    // subsystem works, and the silence is the defect. So the rule is structural instead: a runner
    // that measures itself is a runner Probe Health reports on.
    const root = join(import.meta.dirname, '..', '..');
    const sources = await readFile(join(root, 'src', 'health', 'report.ts'), 'utf8');
    const declaration = sources.slice(
      sources.indexOf('export interface ProbeHealthSources'),
      sources.indexOf('const MB ='),
    );
    assert.ok(declaration.includes('scheduler'), 'found the ProbeHealthSources declaration');

    // **Every directory that keeps counters, because reading one is how `P-64` stayed hidden.**
    // This test was written for `P-61` and pointed at `src/runner/` alone, so the two listeners —
    // which keep counters of exactly the same kind, and reached exactly as far — were outside its
    // reach. `P-64` added `listeners/`; `P-76` added `health/`, where the check-flow watchdog
    // lives. A rule that only looks where the last defect was found is a rule that finds the last
    // defect, so the list grows whenever a subsystem starts measuring itself.
    const checked: string[] = [];
    for (const where of ['runner', 'listeners', 'health']) {
      const dir = join(root, 'src', where);
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.ts')) continue;
        const text = await readFile(join(dir, file), 'utf8');
        const stats = /^ {2}stats\(\): (\w+)/m.exec(text);
        if (stats === null) continue;
        const type = stats[1] ?? '';
        checked.push(`${where}/${file} -> ${type}`);
        assert.ok(
          declaration.includes(type),
          `${where}/${file} keeps a ${type} that no ProbeHealthSources key reads, so nothing it ` +
            `counts reaches a health sensor — the defect P-61 and P-64 both were`,
        );
      }
    }
    assert.ok(
      checked.length >= 5,
      `expected both runners, both listeners and the check-flow watchdog, saw ${checked.join(', ')}`,
    );
  });

  it('carries what the log output dropped as a running total, and what it holds (P-216)', () => {
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      log: () => ({ droppedLines: 1_204, droppedBytes: 180_000, backlogBytes: 8_388_000 }),
    }).report();
    assert.equal(report.logDropped, 1_204);
    assert.equal(report.logBacklogBytes, 8_388_000);
  });

  it('says nothing about a log it cannot read, rather than zero dropped', () => {
    const report = reporter({}).report();
    assert.equal('logDropped' in report, false);
    assert.equal('logBacklogBytes' in report, false);
  });

  it('says how far memory lets the pool grow, and how much it holds back (P-236)', () => {
    const report = reporter({}).report();
    assert.equal(report.poolCeiling, 50);
    assert.equal(report.poolMemoryCap, 50);
    assert.equal(report.poolHeldBack, 14);
  });

  it('leaves the memory cap out where memory cannot be read, rather than a cap of nothing', () => {
    const { memoryCap: _cap, ...unread } = POOL;
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => ({ ...unread, ceiling: 64, heldBack: 0 }),
      memory: {
        machine: { lowest: () => null, takeLow: () => null },
        limit: { lowest: () => null, takeLow: () => null },
        start: () => undefined,
        stop: () => undefined,
      },
    }).report();
    assert.equal('poolMemoryCap' in report, false);
    assert.equal(report.poolCeiling, 64);
    assert.equal(report.poolHeldBack, 0);
  });

  it('says whether the pool is alive, and what it threw away', () => {
    // `P-62`. A latched pool reports `busy: 0` like an idle one, so the state has to travel
    // separately from the counters — and the counter says what the failure cost.
    const alive = reporter({}).report();
    assert.equal(alive.poolState, 0);
    assert.equal(alive.discarded, 0);

    const dead = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => ({ ...POOL, disabled: true, discarded: 412, size: 0, busy: 0 }),
    }).report();
    assert.equal(dead.poolState, 1, 'a state an operator can alarm on');
    assert.equal(dead.discarded, 412, 'and the volume behind it');
  });

  it('says whether dispatched checks are coming back, and how many sensors are behind', () => {
    // `P-76`. The probe is delivering — `P-74`'s predicate is false — and part of what it carries
    // is not being checked. Only the probe can see that, and only as a Warning: the sensors that
    // *are* completing are fine, and saying otherwise would wreck their SLA.
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      checkFlow: () => ({
        completing: 0,
        outstanding: 7,
        oldestOutstandingMs: 420_000,
        behind: 12,
      }),
    }).report();
    assert.equal(report.checksCompleting, 0);
    assert.equal(report.checksBehind, 12);
    assert.equal(report.checksOutstanding, 7);
    assert.equal(report.checkStalledMs, 420_000);
  });

  it('says nothing about check flow on a build that does not watch it', () => {
    const report = reporter({}).report();
    assert.equal(report.checksCompleting, undefined);
    assert.equal(report.checksBehind, undefined);
  });

  it('carries what each listener heard, accepted and turned away', () => {
    // **`rejected` is the channel this exists for** (`P-64`). A device sending the wrong community
    // has every message dropped before the ring, so the sensor drains nothing, throws nothing, and
    // renders "no traps since …" — a green sensor reporting a quiet network at a receiver that is
    // refusing everything. Nothing else on the probe knows that number.
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      trapListener: () => ({
        running: true,
        received: 900,
        rejected: 412,
        malformed: 3,
        buffered: 20_000,
        cursors: 2,
        // Different, and the larger is the one that is not sent: everything the buffer gave up,
        // against what it gave up unread (`B-14`).
        overwritten: 8_000_000,
        overwrittenUnread: 1_300,
        earlier: 357,
      }),
      syslogListener: () => ({
        running: true,
        received: 40_000,
        rejected: 0,
        malformed: 17,
        buffered: 20_000,
        cursors: 1,
        overwritten: 20_000,
        overwrittenUnread: 75,
        earlier: 1_200,
      }),
    }).report();

    assert.equal(
      report.trapOverwritten,
      1_300,
      'what was lost unread, not all that was overwritten',
    );
    assert.equal(report.syslogOverwritten, 75, 'and each listener’s own');
    // `P-270`: what a resuming first scan named as before its window, each listener's own.
    assert.equal(report.trapEarlier, 357);
    assert.equal(report.syslogEarlier, 1_200);
    assert.equal(report.trapReceived, 900);
    assert.equal(report.trapRejected, 412, 'the number that turns "reads zero" into a diagnosis');
    assert.equal(report.trapMalformed, 3);
    assert.equal(report.syslogReceived, 40_000);
    assert.equal(report.syslogRejected, 0);
    assert.equal(report.syslogMalformed, 17);
  });

  it('carries what the flow collector received, turned away, could not read and never got', () => {
    // `B-07`. The mapping existed since `B-02` and nothing ran it: no probe constructed the
    // collector, so no test had a reason to. Five different numbers, so that two of them swapped
    // is a failure rather than a coincidence.
    const report = new ProbeHealthReporter({
      scheduler: () => WHEEL,
      pool: () => POOL,
      flowListener: () => ({
        running: true,
        received: 4_812,
        rejected: 3,
        malformed: 2,
        missed: 61,
        undecodable: 7,
        buffered: 900,
        cursors: 1,
        // Different, and the larger is the one that is not sent: everything the buffer gave up,
        // against what it gave up unread (`B-11`).
        overwritten: 3_912,
        overwrittenUnread: 250,
        earlier: 9_000,
      }),
    }).report();

    assert.equal(report.flowReceived, 4_812);
    assert.equal(report.flowRejected, 3);
    assert.equal(report.flowMalformed, 2);
    assert.equal(report.flowMissed, 61, 'what did not arrive, which nothing else counts');
    assert.equal(report.flowUndecodable, 7);
    assert.equal(report.flowOverwritten, 250, 'what was lost unread, not all that was overwritten');
    assert.equal(report.flowEarlier, 9_000, 'and what a first scan kept out, apart from it');
  });

  it('says nothing about a flow collector this probe does not run', () => {
    const report = reporter({}).report();
    for (const field of [
      'flowReceived',
      'flowRejected',
      'flowMalformed',
      'flowMissed',
      'flowUndecodable',
      'flowOverwritten',
      'flowEarlier',
    ]) {
      assert.equal(field in report, false, `${field} reported by a probe with no collector`);
    }
  });

  it('says nothing about a listener this probe does not run', () => {
    // Absent stays absent. A probe with no syslog listener must gap rather than report a zero that
    // cannot be told from a listener nothing is sending to — and both are separate keys because a
    // probe may run either, both, or neither.
    const report = reporter({}).report();
    assert.equal(report.trapReceived, undefined);
    assert.equal(report.syslogReceived, undefined);
    assert.equal('trapEarlier' in report, false);
    assert.equal('syslogEarlier' in report, false);
  });

  it('reports the spool when there is one', () => {
    const report = reporter({}).report();
    assert.equal(report.spoolPending, 500);
    assert.equal(report.spoolDropped, 4);
    assert.equal(report.spoolBytes, 2_097_152);
    // The two ways a reading stops existing are separate numbers (`P-78`): evicted at the cap,
    // and never written at all. An operator fixes a full disk differently from a broken one.
    assert.equal(report.spoolUnwritten, 2);
  });

  /**
   * The stall, on the wire (`H-01`).
   *
   * The detector itself is `spool-drain.test.ts`; what these pin is the half that was missing —
   * that the number reaches the heartbeat at all. `615c9f3` was a spool that would not move with
   * the link up, and the reason it ran for hours unnoticed is that nothing carried this: depth
   * said "plenty waiting", which is also what a healthy catch-up says.
   */
  it('carries the spool stall, so a drain that is not draining is visible', () => {
    assert.equal(reporter({ stalledForMs: 420_000 }).report().spoolStalledMs, 420_000);
  });

  it('reports a stall of zero rather than omitting it while the drain is healthy', () => {
    // Zero here is a measurement, not an absence: the drain looked and found it *is* moving.
    // Omitting it would gap the channel and lose the difference between "not stalled" and "this
    // probe cannot tell you".
    const report = reporter({ stalledForMs: 0 }).report();
    assert.equal('spoolStalledMs' in report, true);
    assert.equal(report.spoolStalledMs, 0);
  });

  it('omits the stall when this build runs no drain', () => {
    assert.equal('spoolStalledMs' in reporter({ drain: false }).report(), false);
  });

  it('reports the stall independently of the spool', () => {
    // Separate sources on purpose: how much is waiting is the spool's answer, whether any of it
    // is moving is only the drain's. A build with one and not the other reports what it has.
    const report = reporter({ spool: false, stalledForMs: 1_000 }).report();
    assert.equal('spoolPending' in report, false);
    assert.equal(report.spoolStalledMs, 1_000);
  });

  it('omits every spool field when this build runs no spool', () => {
    // Absent, not zero. "There is no spool" and "the spool is empty" are different facts, and a
    // dropped-results channel reading a confident 0 for the first is the worse of the two.
    const report = reporter({ spool: false }).report();
    assert.equal('spoolPending' in report, false);
    assert.equal('spoolDropped' in report, false);
    assert.equal('spoolUnwritten' in report, false);
  });

  it('omits CPU on the first report and carries it after', () => {
    // A rate needs two samples. 0% would say the probe is idle rather than that nothing has been
    // measured yet — `CLAUDE.md`'s no-data rule, applied to a number that is not a device
    // reading.
    const one = reporter({ cpuUs: [0, 250_000], elapsedNs: [0, 1_000_000_000] });
    assert.equal('cpuPercent' in one.report(), false);
    assert.equal(one.report().cpuPercent, 25);
  });

  it('reports memory in megabytes and uptime in whole seconds', () => {
    const report = reporter({ rss: 220_200_960, uptime: 3_600.7 }).report();
    assert.equal(report.memoryMb, 210);
    assert.equal(report.uptimeSeconds, 3_601);
  });

  it('reports what the machine has left beside what the probe holds, in megabytes', () => {
    // `P-208`. `memoryMb` is the probe's share; this is everybody else's too.
    const report = reporter({
      rss: 220_200_960,
      machine: { availablePercent: 23.4, availableBytes: 1_950_351_360, totalBytes: 8_321_499_136 },
    }).report();
    assert.equal(report.memoryMb, 210);
    assert.equal(report.memoryAvailablePercent, 23.4);
    assert.equal(report.memoryAvailableMb, 1_860);
  });

  describe('when memory is read (`P-218`)', () => {
    /**
     * The heartbeat an installation actually runs, from the shipped example — not the development
     * configuration's two seconds, which is what `P-208` happened to be measured at.
     */
    async function shippedHeartbeatMs(): Promise<number> {
      const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
      const config = JSON.parse(
        await readFile(join(repoRoot, 'deploy', 'examples', 'core.json'), 'utf8'),
      ) as { probeEndpoint: { heartbeatIntervalMs: number } };
      return config.probeEndpoint.heartbeatIntervalMs;
    }

    /**
     * A machine of 100 bytes with 60 available, squeezed to 15 from `from` until `to`, and a
     * sampler over it on a clock the test moves. The clock is milliseconds since the sampler
     * started, which is what `AvailableMemoryWatch` treats as monotonic.
     */
    function squeezed(from: number, to: number): { memory: MemorySampler; at: { ms: number } } {
      const at = { ms: 0 };
      const now = (): number => at.ms;
      const machine = new AvailableMemoryWatch({
        read: () => ({ availableBytes: at.ms >= from && at.ms < to ? 15 : 60, totalBytes: 100 }),
        now,
      });
      const limit = new AvailableMemoryWatch({ read: () => null, now });
      return { memory: new MemorySampler({ machine, limit }), at };
    }

    /** Moves the clock and the timers together, a second at a time, to `ms`. */
    function until(t: TestContext, at: { ms: number }, ms: number): void {
      while (at.ms < ms) {
        at.ms += 1_000;
        t.mock.timers.tick(1_000);
      }
    }

    it('records a squeeze shorter than one heartbeat, at the heartbeat the probe ships with', async (t) => {
      const heartbeatMs = await shippedHeartbeatMs();
      // Four seconds, in the middle of the gap between two heartbeats. The measurement this
      // pins is `P-206`'s: a machine went from 8.5% available to a kernel kill in six.
      const from = heartbeatMs / 2 - 2_000;
      const to = heartbeatMs / 2 + 2_000;
      assert.ok(
        from > 0 && to < heartbeatMs,
        `a ${String(heartbeatMs)} ms heartbeat is too short to test`,
      );

      t.mock.timers.enable({ apis: ['setInterval'] });
      const { memory, at } = squeezed(from, to);
      const health = reporter({ memory });
      health.start();
      t.after(() => {
        health.stop();
      });

      assert.equal(health.report().memoryAvailablePercent, 60, 'the heartbeat before the squeeze');
      until(t, at, heartbeatMs);
      // Read at the report alone, the window held a 60 from each heartbeat and nothing between.
      assert.equal(health.report().memoryAvailablePercent, 15);
    });

    it('keeps reading while no heartbeat is sent, so the first after a reconnect has a full window', (t) => {
      // A disconnected probe sends no heartbeat, so nothing calls `report()`. Down for a minute,
      // squeezed for four seconds near the end, and reconnected: the squeeze is in the window.
      t.mock.timers.enable({ apis: ['setInterval'] });
      const { memory, at } = squeezed(44_000, 48_000);
      const health = reporter({ memory });
      health.start();
      t.after(() => {
        health.stop();
      });

      until(t, at, 60_000);
      assert.equal(health.report().memoryAvailablePercent, 15);
    });

    describe('at protocol 20, each low in one report (P-219)', () => {
      /**
       * A machine squeezed from `from` to `to`, read every two seconds on a clock the test moves
       * itself, and the reporter over it. No timers: `step` reads when a two-second read is due.
       */
      function tiled(from: number, to: number) {
        const at = { ms: 0 };
        const now = (): number => at.ms;
        const machine = new AvailableMemoryWatch({
          read: () => ({ availableBytes: at.ms >= from && at.ms < to ? 15 : 60, totalBytes: 100 }),
          now,
        });
        const limit = new AvailableMemoryWatch({ read: () => null, now });
        const memory = new MemorySampler({ machine, limit });
        const health = reporter({ memory });
        let seq = 0;
        return {
          health,
          /** Moves the clock to `ms`, reading every two seconds on the way. */
          to(ms: number): void {
            while (at.ms < ms) {
              at.ms += 1_000;
              if (at.ms % 2_000 === 0) memory.sample();
            }
          },
          beat(peerVersion = PROTOCOL_VERSION): { seq: number; percent: number | undefined } {
            seq += 1;
            return {
              seq,
              percent: health.report({ seq, peerVersion }).memoryAvailablePercent,
            };
          },
        };
      }

      it('reports a squeeze in the heartbeat after it, and in no other', () => {
        const probe = tiled(12_000, 16_000);
        const sent: (number | undefined)[] = [];
        for (const ms of [10_000, 20_000, 30_000, 40_000]) {
          probe.to(ms);
          const beat = probe.beat();
          sent.push(beat.percent);
          probe.health.acknowledged(beat.seq);
        }
        assert.deepEqual(sent, [60, 15, 60, 60]);
      });

      it('carries a heartbeat the core never acknowledged into the next one', () => {
        // Sent as the link dropped: the core may never have had it, so its low goes again.
        const probe = tiled(12_000, 16_000);
        probe.to(10_000);
        probe.health.acknowledged(probe.beat().seq);
        probe.to(20_000);
        assert.equal(probe.beat().percent, 15, 'sent, and never acknowledged');
        probe.to(30_000);
        const again = probe.beat();
        assert.equal(again.percent, 15, 'so it is carried');
        probe.health.acknowledged(again.seq);
        probe.to(40_000);
        assert.equal(probe.beat().percent, 60, 'and once acknowledged, not again');
      });

      it('carries an outage into the first heartbeat after it', () => {
        // No heartbeat while disconnected, and reading goes on (`P-218`), so the first report
        // after the reconnect covers the whole outage — however much longer than thirty seconds.
        const probe = tiled(44_000, 48_000);
        probe.to(10_000);
        probe.health.acknowledged(probe.beat().seq);
        probe.to(130_000);
        assert.equal(probe.beat().percent, 15);
      });

      it('sends a core below 20 the last thirty seconds, which is what it records', () => {
        // A 20 probe against a 19 core negotiates down: that core records the latest report, and
        // a report of one heartbeat's worth would lose every low between its records.
        const probe = tiled(12_000, 16_000);
        const sent: (number | undefined)[] = [];
        for (const ms of [10_000, 20_000, 30_000, 50_000]) {
          probe.to(ms);
          const beat = probe.beat(19);
          sent.push(beat.percent);
          probe.health.acknowledged(beat.seq);
        }
        assert.deepEqual(sent, [60, 15, 15, 60], 'the thirty-second window, as before');
      });

      it('keeps a low however many heartbeats go unacknowledged', () => {
        // Past the bound, the oldest are merged, which keeps their low.
        const probe = tiled(0, 4_000);
        let last = { seq: 0, percent: undefined as number | undefined };
        for (let ms = 2_000; ms <= 200_000; ms += 2_000) {
          probe.to(ms);
          last = probe.beat();
        }
        assert.equal(last.percent, 15, 'from a hundred heartbeats ago');
        probe.health.acknowledged(last.seq);
        probe.to(202_000);
        assert.equal(probe.beat().percent, 60);
      });

      /**
       * The whole path, with the core modelled: it records every thirty seconds, a second off
       * each heartbeat so nothing ties, and folds every report since its last record (from 20)
       * or takes the latest one (below). The squeeze is one reading, at `squeeze`; a longer one
       * that spans the last heartbeat before a record is rightly in two, because it was low in
       * both. Returns how many records held it.
       */
      function recordsHolding(options: {
        heartbeatMs: number;
        peerVersion: number;
        squeeze: number;
      }): number {
        const probe = tiled(options.squeeze, options.squeeze + 2_000);
        const folds = options.peerVersion >= 20;
        let held: number | undefined;
        let holding = 0;
        for (let ms = 1_000; ms <= 181_000; ms += 1_000) {
          probe.to(ms);
          if (ms % options.heartbeatMs === 0) {
            const beat = probe.beat(options.peerVersion);
            probe.health.acknowledged(beat.seq);
            held =
              folds && held !== undefined && beat.percent !== undefined
                ? Math.min(held, beat.percent)
                : (beat.percent ?? (folds ? held : undefined));
          }
          if (ms > 1_000 && ms % 30_000 === 1_000) {
            if (held === 15) holding += 1;
            if (folds) held = undefined;
          }
        }
        return holding;
      }

      it('puts every reading in exactly one record, at a heartbeat that divides thirty or not', () => {
        for (const heartbeatMs of [10_000, 20_000]) {
          for (let squeeze = 2_000; squeeze <= 120_000; squeeze += 2_000) {
            assert.equal(
              recordsHolding({ heartbeatMs, peerVersion: PROTOCOL_VERSION, squeeze }),
              1,
              `a low read at ${String(squeeze / 1_000)} s, heartbeat ${String(heartbeatMs / 1_000)} s`,
            );
          }
        }
      });

      it('the control: below 20, at 20 s, a low fell between two records and was in none', () => {
        const missed = [];
        for (let squeeze = 2_000; squeeze <= 120_000; squeeze += 2_000) {
          if (recordsHolding({ heartbeatMs: 20_000, peerVersion: 19, squeeze }) === 0) {
            missed.push(squeeze / 1_000);
          }
        }
        assert.ok(missed.length > 0, 'the gap P-219 closes');
        assert.ok(missed.includes(22), `the finding's own case, 22 s; missed ${missed.join(', ')}`);
      });
    });

    it('gaps both memory channels until it is started, rather than reading once at the report', () => {
      const health = reporter({ memory: squeezed(0, 0).memory });
      const report = health.report();
      assert.equal(report.memoryAvailablePercent, undefined);
      assert.equal(report.memoryLimitUsagePercent, undefined);
    });
  });

  it('reports its working set against its own ceiling, and the ceiling', () => {
    // `P-210`: 1.5 GiB of headroom left under the stock unit's 6 GiB MemoryMax is 75% used.
    const report = reporter({
      limit: { availablePercent: 25, availableBytes: 1_610_612_736, totalBytes: 6_442_450_944 },
    }).report();
    assert.equal(report.memoryLimitUsagePercent, 75);
    assert.equal(report.memoryLimitMb, 6_144);
  });

  it('reports usage past 100% when the probe stands above its ceiling', () => {
    // Throttled past an operator's MemoryHigh, not stopped: what the error limit exists for.
    const report = reporter({
      limit: { availablePercent: -17, availableBytes: -35_651_584, totalBytes: 209_715_200 },
    }).report();
    assert.equal(report.memoryLimitUsagePercent, 117);
  });

  it('leaves the limit out where there is no ceiling, rather than reporting none of it used', () => {
    const report = reporter({ limit: null }).report();
    assert.equal('memoryLimitUsagePercent' in report, false);
    assert.equal('memoryLimitMb' in report, false);
  });

  it('leaves the machine’s memory out where the platform cannot say, rather than sending zero', () => {
    const report = reporter({ machine: null }).report();
    assert.equal('memoryAvailablePercent' in report, false);
    assert.equal('memoryAvailableMb' in report, false);
  });
});
