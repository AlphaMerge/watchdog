// Does Probe Health's `memoryAvailable` track the machine under load? For `P-208`, and `P-218`.
//
//     scripts/dev.sh 'node --expose-gc scripts/sizing/machine-memory-track.mjs > /tmp/out.ndjson'
//
// Runs the real `ProbeHealthReporter` from `packages/probe/dist`, with the real machine-memory
// watch, reported at the heartbeat and recorded at Probe Health's thirty seconds — and beside it an
// independent sampler reading `/proc/meminfo` every 250 ms, which is the truth the channel is
// judged against. It squeezes the machine itself and holds each squeeze for 1, 5, 20 and 70
// seconds: one shorter than a sample, one about as long as the fall `P-206` recorded, one near a
// record interval and one longer than two.
//
// **Two reporters, side by side, against the same squeezes** (`P-218`). One reads memory as the
// probe does since `P-218`, on the `MemorySampler`'s own two-second timer. The other reads it as the
// probe did before, once per report, which is once per heartbeat — the `MemorySampler` is never
// started and is sampled just before each report instead. `P-208` ran this at the development
// configuration's two-second heartbeat, where the two are the same thing; the shipped heartbeat is
// ten seconds, and that is this script's default now.
//
// **The squeeze runs in a worker thread.** The first version allocated on the sampler's own thread,
// and filling 2.3 GiB under memory pressure blocked it — and the heartbeat — for six seconds, so
// the heartbeat caught the low by being queued behind the allocation, not by sampling it. A worker
// has its own event loop; the sampler and the heartbeat keep their cadence while it allocates. Each
// hold is timed from the moment the worker reaches its target, so the ramp is not counted in it.
//
// **It will not take the machine below a floor** — 12% available by default, above the channel's
// 10% error limit and well above anything the kernel acts on. The worker checks that itself every
// 250 ms and frees at once, because `P-206`'s lesson is that a guard which starts a process to look
// is slowest exactly when memory is shortest. Anything else on the machine is part of the load,
// and the squeeze adjusts to it rather than assuming it away.
//
// One NDJSON line per sample, per squeeze and per record, then a summary line. Environment:
//   MS_SQUEEZE_TARGET  percent available to squeeze the machine down to (default 15)
//   MS_SQUEEZE_FLOOR   percent never to go below (default 12)
//   MS_SQUEEZE_CAP_MIB most the worker will hold (default 4096)
//   MS_HEARTBEAT_MS    how often the probe reports (default 10000, `deploy/examples/core.json`)
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MIB = 1024 * 1024;

function meminfo() {
  const text = readFileSync('/proc/meminfo', 'utf8');
  const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1] ?? NaN);
  return { available: kb('MemAvailable') * 1024, total: kb('MemTotal') * 1024 };
}

const percent = (bytes, total) => Math.round((bytes / total) * 1_000) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A squeeze that cannot give memory back on demand cannot be stopped at the floor.
if (typeof globalThis.gc !== 'function') {
  console.error('run with --expose-gc (it is process-wide, so the squeeze worker gets it too)');
  process.exit(2);
}

if (!isMainThread) {
  // ---- The squeeze. Holds memory on command, and never lets the machine below the floor. ----
  const { floor, cap } = workerData;
  const CHUNK = 64 * MIB;
  const held = [];
  const release = (all) => {
    if (all) held.length = 0;
    else held.pop();
    globalThis.gc();
  };
  // The floor, on this thread's own timer, whatever the main thread is doing.
  let floorHits = 0;
  setInterval(() => {
    while (held.length > 0) {
      const { available, total } = meminfo();
      if (percent(available, total) >= floor) break;
      floorHits += 1;
      release(false);
    }
  }, 250);
  parentPort.on('message', async ({ target, holdMs }) => {
    // Ramp in small steps, yielding between them so the floor timer runs during the ramp too.
    for (;;) {
      const { available, total } = meminfo();
      if (available <= (target / 100) * total + CHUNK) break;
      if (held.length * CHUNK + CHUNK > cap || percent(available, total) < floor + 1) break;
      const chunk = Buffer.allocUnsafeSlow(CHUNK);
      chunk.fill(1); // touched, so it is resident rather than merely reserved
      held.push(chunk);
      await sleep(0);
    }
    parentPort.postMessage({ event: 'reached', heldMiB: held.length * 64 });
    await sleep(holdMs);
    release(true);
    parentPort.postMessage({ event: 'released', floorHits });
  });
} else {
  // ---- The measurement. ----
  const { ProbeHealthReporter } = await import('../../packages/probe/dist/src/health/report.js');
  const { MemorySampler } = await import('../../packages/shared/dist/src/index.js');
  const HEARTBEAT_MS = Number(process.env.MS_HEARTBEAT_MS ?? 10_000);
  const TARGET = Number(process.env.MS_SQUEEZE_TARGET ?? 15);
  const FLOOR = Number(process.env.MS_SQUEEZE_FLOOR ?? 12);
  const CAP = Number(process.env.MS_SQUEEZE_CAP_MIB ?? 4096) * MIB;
  const HOLDS = [1, 5, 20, 70];

  const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start) / 1_000;

  // The reporter needs a scheduler and a pool; this measures neither, so both are idle stubs.
  const idle = {
    scheduler: () => ({
      tasks: 0,
      lagMs: { p50: 0, p95: 0, p99: 0, max: 0 },
      skippedTicks: 0,
      clockJumps: 0,
    }),
    pool: () => ({
      size: 1,
      busy: 0,
      queued: 0,
      waitMs: { p50: 0, p95: 0, p99: 0, max: 0 },
      deferred: 0,
      refused: 0,
      discarded: 0,
      disabled: false,
      timedOut: 0,
      workerCrashes: 0,
    }),
  };
  // Since `P-218`: its own timer, every two seconds.
  const reporter = new ProbeHealthReporter({ ...idle, memory: new MemorySampler() });
  reporter.start();
  // Before `P-218`: read at the report and nowhere else.
  const atReport = new MemorySampler();
  const before = new ProbeHealthReporter({ ...idle, memory: atReport });
  emit({ kind: 'conditions', heartbeatMs: HEARTBEAT_MS, node: process.version });

  const squeezer = new Worker(new URL(import.meta.url), { workerData: { floor: FLOOR, cap: CAP } });
  const next = () => new Promise((resolve) => squeezer.once('message', resolve));

  let phase = 'baseline';
  let lastReport = null;
  let lastBefore = null;
  let intervalLow = Infinity;
  let intervalLowAt = 0;
  const records = [];

  const sampler = setInterval(() => {
    const { available, total } = meminfo();
    if (available < intervalLow) {
      intervalLow = available;
      intervalLowAt = elapsed();
    }
    emit({
      kind: 'sample',
      t: elapsed(),
      phase,
      availableMiB: Math.round(available / MIB),
      availablePercent: percent(available, total),
    });
  }, 250);

  const heartbeat = setInterval(() => {
    lastReport = reporter.report();
    atReport.sample();
    lastBefore = before.report();
    emit({
      kind: 'heartbeat',
      t: elapsed(),
      reportedLowPercent: lastReport.memoryAvailablePercent,
      beforeP218Percent: lastBefore.memoryAvailablePercent,
    });
  }, HEARTBEAT_MS);

  const record = setInterval(() => {
    const { available, total } = meminfo();
    const entry = {
      kind: 'record',
      t: Math.round(elapsed()),
      // What Probe Health records: the latest heartbeat's lowest-of-thirty-seconds.
      channelPercent: lastReport?.memoryAvailablePercent ?? null,
      channelMiB: lastReport?.memoryAvailableMb ?? null,
      // The same, read once per heartbeat as before `P-218`.
      beforeP218Percent: lastBefore?.memoryAvailablePercent ?? null,
      // What a latest-value channel would have recorded at the same instant.
      pointPercent: percent(available, total),
      // The truth: the lowest the 250 ms sampler saw since the last record.
      trueLowPercent: intervalLow === Infinity ? null : percent(intervalLow, total),
      trueLowAt: Math.round(intervalLowAt),
    };
    records.push(entry);
    emit(entry);
    intervalLow = Infinity;
  }, 30_000);

  const squeezes = [];
  await sleep(45_000);
  for (const hold of HOLDS) {
    phase = `ramp-${hold}s`;
    const rampFrom = elapsed();
    squeezer.postMessage({ target: TARGET, holdMs: hold * 1_000 });
    const reached = await next();
    phase = `hold-${hold}s`;
    const heldFrom = elapsed();
    const released = await next();
    const heldTo = elapsed();
    phase = 'recover';
    const squeeze = {
      kind: 'squeeze',
      holdSeconds: hold,
      rampSeconds: Math.round((heldFrom - rampFrom) * 10) / 10,
      heldFrom,
      heldTo,
      heldMiB: reached.heldMiB,
      floorHits: released.floorHits,
    };
    squeezes.push(squeeze);
    emit(squeeze);
    await sleep(40_000);
  }
  await sleep(5_000);

  clearInterval(sampler);
  clearInterval(heartbeat);
  clearInterval(record);
  reporter.stop();
  await squeezer.terminate();

  // For each squeeze: the first record after it began, which is the one whose interval holds it.
  const caught = squeezes.map((squeeze) => {
    const covering = records.filter((r) => r.t > squeeze.heldFrom && r.t - 30 < squeeze.heldTo);
    const worst = covering.reduce(
      (a, r) => (a === null || (r.trueLowPercent ?? Infinity) < a.trueLowPercent ? r : a),
      null,
    );
    return {
      holdSeconds: squeeze.holdSeconds,
      trueLowPercent: worst?.trueLowPercent ?? null,
      channelPercent: worst?.channelPercent ?? null,
      beforeP218Percent: worst?.beforeP218Percent ?? null,
      pointPercentAtRecords: covering.map((r) => r.pointPercent),
    };
  });
  const judged = records.filter((r) => r.channelPercent !== null && r.trueLowPercent !== null);
  const error = judged.map((r) => Math.abs(r.channelPercent - r.trueLowPercent));
  const judgedBefore = records.filter(
    (r) => r.beforeP218Percent !== null && r.trueLowPercent !== null,
  );
  const errorBefore = judgedBefore.map((r) => Math.abs(r.beforeP218Percent - r.trueLowPercent));
  const worst = (errors) => Math.round(Math.max(...errors) * 10) / 10;
  const mean = (errors) =>
    Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 100) / 100;
  emit({
    kind: 'summary',
    heartbeatMs: HEARTBEAT_MS,
    records: records.length,
    worstChannelErrorPoints: worst(error),
    meanChannelErrorPoints: mean(error),
    worstBeforeP218ErrorPoints: worst(errorBefore),
    meanBeforeP218ErrorPoints: mean(errorBefore),
    squeezes: caught,
    floorHits: squeezes.at(-1)?.floorHits ?? 0,
    target: TARGET,
    floor: FLOOR,
  });
}
