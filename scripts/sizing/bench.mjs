#!/usr/bin/env node
// One sizing point: N sensors on this machine, for H-08.
//
//     MS_SIZING_SENSORS=5000 MS_SIZING_SECONDS=90 node scripts/sizing/bench.mjs
//
// **The same wheel and the same pool as `scheduler-benchmark.test.ts`, deliberately.** That test
// is `P-15`'s go/no-go gate and is pinned to the criterion's exact numbers — 5,000 sensors, 60 s,
// 8 cores — so it is the wrong place to sweep. This asks the neighbouring question that `H-08`
// needs: at a given machine size, how many sensors still hold the budget? Nothing is stubbed; the
// wheel runs on its own timer and the pool spawns real worker threads.
//
// **The checks sleep rather than burn CPU**, for the reason the gate gives: ICMP, SNMP and HTTP
// checks spend nearly all their time waiting for a packet, and a worker holding a slot while it
// waits is the real constraint. A CPU-burning check would make the pool look CPU-bound when it is
// not, and would size every tier wrongly in the same direction.
//
// Constrain the machine from outside — `docker run --cpus=2 --memory=4g` — rather than in here.
// What a probe can do with two cores is a property of the box, and simulating it in-process would
// measure the simulation.
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const probe = join(root, 'packages', 'probe', 'dist');
const { CheckPool } = await import(join(probe, 'src/runner/pool.js'));
const { TimingWheel, phaseFor } = await import(join(probe, 'src/scheduler/wheel.js'));
const FIXTURES = join(probe, 'test/support/check-fixtures.js');

const SENSORS = Number(process.env['MS_SIZING_SENSORS'] ?? '5000');
const SECONDS = Number(process.env['MS_SIZING_SECONDS'] ?? '90');
const INTERVAL_SECONDS = Number(process.env['MS_SIZING_INTERVAL'] ?? '60');
// 200 ms is an ordinary SNMP round trip on a LAN and a fast HTTP check — the gate's number, kept
// so a sizing point and the gate are comparable.
const CHECK_MS = Number(process.env['MS_SIZING_CHECK_MS'] ?? '200');
const POOL_MAX = Number(process.env['MS_SIZING_POOL_MAX'] ?? '256');

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

const percentile = (sorted, fraction) =>
  sorted.length === 0
    ? 0
    : Number(
        (sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0).toFixed(1),
      );

const samples = [];
const lateBySensor = new Map();

const pool = new CheckPool({
  logger: silent,
  size: POOL_MAX,
  // Start small and let it find its own size, which is what a real probe does since `P-18` —
  // and the size it settles on is half of what this measurement is for.
  minSize: 4,
  queueMaxLength: 100_000,
  registryModule: FIXTURES,
  onResult: (result, meta) => {
    const wheelMs = lateBySensor.get(result.sensorId);
    if (wheelMs === undefined) return;
    lateBySensor.delete(result.sensorId);
    // Due → dispatched, plus dispatched → a worker picked it up. Not how long the check took: a
    // slow check is not a late one.
    samples.push(wheelMs + meta.waitMs);
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
        params: { delayMs: CHECK_MS },
        timeoutMs: 30_000,
      });
    }
  },
});

for (let id = 1; id <= SENSORS; id += 1) wheel.add({ id, intervalSeconds: INTERVAL_SECONDS });

// Without the phase spread this measures a stampede and nothing else. Asserted, not assumed.
const perSecond = new Map();
for (let id = 1; id <= SENSORS; id += 1) {
  const phase = phaseFor(id, INTERVAL_SECONDS);
  perSecond.set(phase, (perSecond.get(phase) ?? 0) + 1);
}
const busiest = Math.max(...perSecond.values());
if (busiest >= Math.max(2, SENSORS / 10)) {
  process.stderr.write(`phase spread put ${String(busiest)} sensors on one second\n`);
  process.exit(2);
}

const rssBefore = process.memoryUsage().rss;
await pool.start();
wheel.start();
await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
wheel.stop();
// Taken before `stop()`, which terminates every worker and empties the slot list — reading the
// size afterwards reports zero and would make every tier look like it needed no workers at all.
const stats = pool.stats();
const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1));
const poolRssMb = Number(((process.memoryUsage().rss - rssBefore) / (1024 * 1024)).toFixed(1));
await pool.stop();

const sorted = [...samples].sort((a, b) => a - b);
process.stdout.write(
  `${JSON.stringify({
    cores: availableParallelism(),
    sensors: SENSORS,
    intervalSeconds: INTERVAL_SECONDS,
    checkMs: CHECK_MS,
    seconds: SECONDS,
    completed: samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: percentile(sorted, 1),
    poolFinal: stats.size,
    poolGrown: stats.grown,
    deferred: stats.deferred,
    refused: stats.refused,
    rssMb,
    poolRssMb,
  })}\n`,
);
