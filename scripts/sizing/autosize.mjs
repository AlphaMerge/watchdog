#!/usr/bin/env node
// The auto-sizing loop under sustained load, for `P-44`.
//
//     node scripts/sizing/autosize.mjs
//     MS_AUTOSIZE_SECONDS=60 MS_AUTOSIZE_INTERVAL_MS=5000 node scripts/sizing/autosize.mjs
//
// **What this measures that `bench.mjs` does not.** That one pins the ceiling and measures the
// pool underneath it, so the *loop* -- measure durations, derive a demand, apply hysteresis, move
// the ceiling, watch the pool shed or grow, measure again -- has never run under load. Every
// claim in `docs/sizing.md` about how the ceiling behaves ("raises at once and lowers slowly",
// "comes down in steps a minute apart") was read off the code rather than observed.
//
// **It runs the shipped loop, not a copy of it.** `poolSizer` is imported from the probe's own
// build, which is why `P-44` extracted it. Re-implementing the policy here would be the mistake
// `P-31` cost a week to: a benchmark that models the code is right until the code changes and
// silent on the day it stops being.
//
// The check duration is changed underneath a running probe, which is the thing the loop exists to
// react to -- a network that slows down and recovers. Nothing else changes: same sensors, same
// interval, same wheel.
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const probe = join(root, 'packages', 'probe', 'dist');
const { CheckPool } = await import(join(probe, 'src/runner/pool.js'));
const { TimingWheel } = await import(join(probe, 'src/scheduler/wheel.js'));
const { poolSizer } = await import(join(probe, 'src/pool-sizer.js'));
const FIXTURES = join(probe, 'test/support/check-fixtures.js');

const SENSORS = Number(process.env['MS_AUTOSIZE_SENSORS'] ?? '2000');
const INTERVAL_SECONDS = Number(process.env['MS_AUTOSIZE_INTERVAL'] ?? '60');
// The shipped cadence. Overridable, but the default is deliberately the real one: a claim about
// how quickly the ceiling comes down is a claim about this number.
const SIZE_INTERVAL_MS = Number(process.env['MS_AUTOSIZE_INTERVAL_MS'] ?? '30000');
// Below the shipped floor of 64 on purpose. The floor is right for a probe and wrong for a
// measurement: at 64 the whole slow/fast range clamps to one value and the loop does nothing
// visible. What is being measured is the loop, not the floor.
const MIN = Number(process.env['MS_AUTOSIZE_MIN'] ?? '8');
const MAX = Number(process.env['MS_AUTOSIZE_MAX'] ?? '256');
const PHASE_SECONDS = Number(process.env['MS_AUTOSIZE_SECONDS'] ?? '150');

// slow -> fast -> slow. The first phase establishes a ceiling well above the floor, the second
// asks how it comes down, the third asks how fast it goes back up.
const PHASES = [
  { name: 'slow', checkMs: Number(process.env['MS_AUTOSIZE_SLOW_MS'] ?? '1500') },
  { name: 'fast', checkMs: Number(process.env['MS_AUTOSIZE_FAST_MS'] ?? '200') },
  { name: 'slow-again', checkMs: Number(process.env['MS_AUTOSIZE_SLOW_MS'] ?? '1500') },
];

const silent = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return silent;
  },
};

let checkMs = PHASES[0].checkMs;
const lateBySensor = new Map();
let lateThisSecond = [];

const pool = new CheckPool({
  logger: silent,
  // The ceiling the sizer starts from, and the one a fresh probe holds.
  size: MIN,
  minSize: 4,
  queueMaxLength: 100_000,
  registryModule: FIXTURES,
  onResult: (result, meta) => {
    const wheelMs = lateBySensor.get(result.sensorId);
    if (wheelMs === undefined) return;
    lateBySensor.delete(result.sensorId);
    lateThisSecond.push(wheelMs + meta.waitMs);
  },
});

const epochNs = process.hrtime.bigint();
const wheel = new TimingWheel({
  logger: silent,
  onDue: (due, tick) => {
    const idealNs = epochNs + BigInt(tick) * 1_000_000_000n;
    const wheelMs = Number(process.hrtime.bigint() - idealNs) / 1e6;
    for (const sensorId of due) {
      lateBySensor.set(sensorId, wheelMs);
      pool.submit({
        sensorId,
        sensorType: 'test.slow',
        target: { host: '192.0.2.1', ipVersion: 'auto' },
        params: { delayMs: checkMs },
        timeoutMs: 30_000,
      });
    }
  },
});

for (let id = 1; id <= SENSORS; id += 1) wheel.add({ id, intervalSeconds: INTERVAL_SECONDS });

const assignments = Array.from({ length: SENSORS }, () => ({
  sensorType: 'test.slow',
  intervalSeconds: INTERVAL_SECONDS,
}));

const sizer = poolSizer({
  logger: silent,
  pool,
  assignments: () => assignments,
  // 0 means derive, which is the case being measured.
  configuredSize: 0,
  intervalMs: SIZE_INTERVAL_MS,
  // `fallbackMs` never applies after the first completed check; stated so the first sample is not
  // a mystery.
  fallbackMs: 600,
  min: MIN,
  max: MAX,
  margin: 1.3,
});

const p95 = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))].toFixed(1));
};

const timeline = [];
await pool.start();
wheel.start();
sizer.start();

const startedAt = Date.now();
for (const [index, phase] of PHASES.entries()) {
  checkMs = phase.checkMs;
  for (let second = 0; second < PHASE_SECONDS; second += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stats = pool.stats();
    timeline.push({
      t: Math.round((Date.now() - startedAt) / 1000),
      phase: phase.name,
      phaseIndex: index,
      checkMs,
      ceiling: pool.maxSize,
      workers: stats.size,
      // Without these a stall is unexplainable: a pool that will not shed is either holding
      // workers that are mid-check or draining a backlog, and the two want different answers.
      busy: stats.busy,
      queued: stats.queued,
      measuredMs: pool.typicalDurationMs('test.slow') ?? null,
      deferred: stats.deferred,
      refused: stats.refused,
      lateP95: p95(lateThisSecond),
      rssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    });
    lateThisSecond = [];
  }
}

sizer.stop();
wheel.stop();
await pool.stop();

process.stdout.write(
  `${JSON.stringify({
    cores: availableParallelism(),
    sensors: SENSORS,
    intervalSeconds: INTERVAL_SECONDS,
    burstPerSecond: Number((SENSORS / INTERVAL_SECONDS).toFixed(1)),
    sizeIntervalMs: SIZE_INTERVAL_MS,
    min: MIN,
    max: MAX,
    phaseSeconds: PHASE_SECONDS,
    phases: PHASES,
    timeline,
  })}\n`,
);
