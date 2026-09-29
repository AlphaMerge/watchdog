// A running probe's memory, for `P-206`: load it into ms-probe and nothing else --
//
//     NODE_OPTIONS=--import=/workspace/scripts/sizing/probe-memory-sampler.mjs \
//     MS_PROBE_MEMORY_OUT=/tmp/probe-memory.ndjson node packages/probe/dist/src/main.js ...
//
// It stays inert in any other process, so it can be set on a container that runs the core too.
// Writes one NDJSON line a second to $MS_PROBE_MEMORY_OUT: the process's own memory, the VM's,
// and every live worker's V8 heap as the worker itself reports it.
//
// For `P-216` it also records what a starved probe's main thread is doing: the log's backlog (the
// bytes its `LogOutput` holds because stdout would not take them, and the lines it dropped past its
// bound), the event loop's delay, and
// the time spent in garbage collection. A line that stops arriving is evidence too: this runs on
// the main thread, so a blocked loop stops it, and the harness samples `/proc` from outside.
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const out = process.env.MS_PROBE_MEMORY_OUT;
// The repository's layout and an installed release's (`/opt/ms/app/probe/dist/src/main.js`).
const isProbe = process.argv.some((arg) => /(^|\/)probe\/dist\/src\/main\.js$/.test(arg));

if (out && isProbe) {
  const require = createRequire(import.meta.url);
  const wt = require('node:worker_threads');
  const Original = wt.Worker;
  const live = new Set();
  let spawned = 0;
  class Tracked extends Original {
    constructor(...args) {
      super(...args);
      spawned += 1;
      live.add(this);
      this.once('exit', () => live.delete(this));
    }
  }
  wt.Worker = Tracked;
  syncBuiltinESMExports();

  // The probe's log output (`P-216` part 3), which registers itself on `globalThis` because an
  // installed release is a bundle and this file cannot import it. Read at each sample, since it
  // is built after this file loads.
  const logOutput = () => globalThis[Symbol.for('ms.logOutput')]?.stats?.() ?? null;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let gcMs = 0;
  let gcCount = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount += 1;
    }
  }).observe({ entryTypes: ['gc'] });

  const kb = (text, key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const MB = 1024 * 1024;

  const sample = async () => {
    const status = readFileSync('/proc/self/status', 'utf8');
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const main = process.memoryUsage();
    const heaps = await Promise.all(
      [...live].map((worker) => worker.getHeapStatistics().catch(() => null)),
    );
    const got = heaps.filter((one) => one !== null);
    const sum = (key) => got.reduce((total, one) => total + one[key], 0);
    const line = {
      t: new Date().toISOString(),
      workers: live.size,
      spawned,
      rssMiB: Math.round(kb(status, 'VmRSS') / 1024),
      anonMiB: Math.round(kb(status, 'RssAnon') / 1024),
      swapMiB: Math.round(kb(status, 'VmSwap') / 1024),
      hwmMiB: Math.round(kb(status, 'VmHWM') / 1024),
      mainHeapMiB: Math.round(main.heapTotal / MB),
      mainUsedMiB: Math.round(main.heapUsed / MB),
      externalMiB: Math.round(main.external / MB),
      arrayBuffersMiB: Math.round(main.arrayBuffers / MB),
      workerHeapTotalMiB: Math.round(sum('total_heap_size') / MB),
      workerHeapUsedMiB: Math.round(sum('used_heap_size') / MB),
      workerMallocedMiB: Math.round(sum('malloced_memory') / MB),
      workerExternalMiB: Math.round(sum('external_memory') / MB),
      workerHeapMaxMiB: got.length
        ? Math.round(Math.max(...got.map((h) => h.total_heap_size)) / MB)
        : 0,
      vmAvailableMiB: Math.round(kb(meminfo, 'MemAvailable') / 1024),
      vmSwapFreeMiB: Math.round(kb(meminfo, 'SwapFree') / 1024),
      logBacklogBytes: logOutput()?.backlogBytes ?? null,
      logDroppedLines: logOutput()?.droppedLines ?? null,
      loopDelayMaxMs: Math.round(loop.max / 1e6),
      loopDelayP99Ms: Math.round(loop.percentile(99) / 1e6),
      gcMs: Math.round(gcMs),
      gcCount,
    };
    loop.reset();
    gcMs = 0;
    gcCount = 0;
    appendFileSync(out, `${JSON.stringify(line)}\n`);
  };
  const timer = setInterval(() => {
    sample().catch((error) => appendFileSync(out, `${JSON.stringify({ error: String(error) })}\n`));
  }, 1000);
  timer.unref();
}
