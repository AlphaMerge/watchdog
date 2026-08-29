import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ProbeHealthReporter } from '../src/health/report.js';
import type { PoolStats } from '../src/runner/pool.js';
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
  workerCrashes: 0,
  waitMs: { p50: 1, p95: 40, p99: 90, max: 500 },
  runMs: { p50: 30, p95: 200, p99: 900, max: 3_000 },
};

const SPOOL: SpoolStats = { pending: 500, bytes: 2_097_152, segments: 1, dropped: 4, corrupt: 0 };

function reporter(options: {
  spool?: boolean;
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
    ...(options.spool === false ? {} : { spool: () => SPOOL }),
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

  it('reports the spool when there is one', () => {
    const report = reporter({}).report();
    assert.equal(report.spoolPending, 500);
    assert.equal(report.spoolDropped, 4);
    assert.equal(report.spoolBytes, 2_097_152);
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
