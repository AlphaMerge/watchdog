// A check worker that also reports its own garbage collection, for `young-generation-cost.mjs`.
//
// Loads the shipped `check-worker.js` unchanged and, beside it, counts every collection this
// thread runs by kind and total pause, reads its heap spaces and its own CPU time, and posts the
// running totals to the parent every second as `{ type: 'gc-stats' }` -- a message type the pool's
// protocol does not use, so the check worker's own traffic is untouched.
import { constants, PerformanceObserver } from 'node:perf_hooks';
import { getHeapSpaceStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';

const totals = {
  minor: { count: 0, ms: 0 },
  major: { count: 0, ms: 0 },
  other: { count: 0, ms: 0 },
};

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = entry.detail?.kind;
    const bucket =
      kind === constants.NODE_PERFORMANCE_GC_MINOR
        ? totals.minor
        : kind === constants.NODE_PERFORMANCE_GC_MAJOR
          ? totals.major
          : totals.other;
    bucket.count += 1;
    bucket.ms += entry.duration;
  }
}).observe({ entryTypes: ['gc'] });

const report = () => {
  const spaces = {};
  for (const space of getHeapSpaceStatistics()) {
    spaces[space.space_name] = { size: space.space_size, used: space.space_used_size };
  }
  const cpu = process.threadCpuUsage();
  parentPort?.postMessage({
    type: 'gc-stats',
    gc: totals,
    spaces,
    cpuMicros: cpu.user + cpu.system,
  });
};
setInterval(report, 1_000).unref();

await import(new URL('../../packages/probe/dist/src/runner/check-worker.js', import.meta.url).href);
