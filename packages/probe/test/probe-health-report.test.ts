import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProbeHealthReporter } from '../src/health/report.js';
import type { ProcessRunnerStats } from '../src/runner/process-runner.js';
import type { PoolStats } from '../src/runner/pool.js';
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
  maxSize: 48,
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
  waitMs: { p50: 30, p95: 400, p99: 900, max: 3_000 },
  runMs: { p50: 200, p95: 2_000, p99: 4_000, max: 9_000 },
};

const SPOOL: SpoolStats = { pending: 500, bytes: 2_097_152, segments: 1, dropped: 4, corrupt: 0 };

const DRAIN: DrainStats = {
  sent: 40,
  backlog: 500,
  maxRetryAfterMs: 0,
  rejected: 0,
  retried: 1,
  stalledForMs: 0,
};

function reporter(options: {
  children?: boolean;
  spool?: boolean;
  drain?: boolean;
  stalledForMs?: number;
  cpuUs?: number[];
  elapsedNs?: number[];
  rss?: number;
  uptime?: number;
}): ProbeHealthReporter {
  let cpuCall = 0;
  let clockCall = 0;
  let cpu = 0;
  let clock = 0n;
  return new ProbeHealthReporter({
    scheduler: () => WHEEL,
    pool: () => POOL,
    ...(options.children === false ? {} : { children: () => CHILDREN }),
    ...(options.spool === false ? {} : { spool: () => SPOOL }),
    ...(options.drain === false
      ? {}
      : { drain: () => ({ ...DRAIN, stalledForMs: options.stalledForMs ?? 0 }) }),
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
        overwritten: 8_000_000,
      }),
      syslogListener: () => ({
        running: true,
        received: 40_000,
        rejected: 0,
        malformed: 17,
        buffered: 20_000,
        cursors: 1,
        overwritten: 0,
      }),
    }).report();

    assert.equal(report.trapReceived, 900);
    assert.equal(report.trapRejected, 412, 'the number that turns "reads zero" into a diagnosis');
    assert.equal(report.trapMalformed, 3);
    assert.equal(report.syslogReceived, 40_000);
    assert.equal(report.syslogRejected, 0);
    assert.equal(report.syslogMalformed, 17);
  });

  it('says nothing about a listener this probe does not run', () => {
    // Absent stays absent. A probe with no syslog listener must gap rather than report a zero that
    // cannot be told from a listener nothing is sending to — and both are separate keys because a
    // probe may run either, both, or neither.
    const report = reporter({}).report();
    assert.equal(report.trapReceived, undefined);
    assert.equal(report.syslogReceived, undefined);
  });

  it('reports the spool when there is one', () => {
    const report = reporter({}).report();
    assert.equal(report.spoolPending, 500);
    assert.equal(report.spoolDropped, 4);
    assert.equal(report.spoolBytes, 2_097_152);
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
});
