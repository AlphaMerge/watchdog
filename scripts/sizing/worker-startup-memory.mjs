#!/usr/bin/env node
// A probe's start-up memory, for `P-206`.
//
//     node scripts/sizing/worker-startup-memory.mjs <variant> [seconds]
//
// Starts 64 real check workers -- `check-worker.js` with the real catalogue registry, from the
// probe's own build -- then hands them `port.tcp` checks against a local listener in bursts of 84
// a second, which is 5,000 sensors on a one-minute interval, and writes the process's resident
// memory and every worker's V8 heap once a second to `worker-startup-<variant>.ndjson` in
// `$MS_STARTUP_OUT` (default: the working directory).
//
// Variants, combinable where it makes sense (`stagger8-young4`):
//
//     at-once      every worker loads at the same time -- the growth burst before `P-206`
//     stagger<N>   at most N loading at once; the next starts when one says ready
//     young<N>     `resourceLimits.maxYoungGenerationSizeMb` of N on every worker
//     gc           a full collection in each worker once its registry has loaded (needs
//                  `v8.setFlagsFromString('--expose-gc')` at runtime, which is why it did not ship)
//
// **It drives workers directly rather than through `CheckPool`**, so each variant changes one thing
// and the pool's own growth policy is not a second variable. What it keeps from the pool is what
// matters to memory: the worker file, the registry, and a check type with a real network path.
//
// **Run it on a quiet machine, and expect the at-once variant to be killed on a small one.** On the
// 8 GB dev VM it was, twice, which is the defect it was written to measure. Stop `ms-server` first.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const [variant = 'at-once', secondsArg = '150'] = process.argv.slice(2);
const seconds = Number(secondsArg);
const WORKERS = 64;
const PER_TICK = 84;

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, '..', '..', 'packages', 'probe', 'dist', 'src', 'runner');
const registryModule = pathToFileURL(join(runner, 'catalogue-registry.js')).href;
const gc = variant.split('-').includes('gc');
const stagger = Number(variant.match(/stagger(\d+)/)?.[1] ?? 0);
const young = Number(variant.match(/young(\d+)/)?.[1] ?? 0);
const file = gc ? join(here, 'gc-after-load-worker.mjs') : join(runner, 'check-worker.js');
const out = join(process.env.MS_STARTUP_OUT ?? '.', `worker-startup-${variant}.ndjson`);
writeFileSync(out, '');

const server = createServer((socket) => socket.end());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const workers = [];
const idle = [];
const queue = [];
let nextJob = 0;
let completed = 0;
let failed = 0;
const dispatch = () => {
  while (idle.length > 0 && queue.length > 0) idle.pop().postMessage(queue.shift());
};

const spawnOne = () =>
  new Promise((resolve) => {
    const worker = new Worker(file, {
      workerData: { registryModule },
      ...(young > 0 ? { resourceLimits: { maxYoungGenerationSizeMb: young } } : {}),
    });
    worker.on('message', (message) => {
      if (message.type === 'ready') {
        idle.push(worker);
        resolve();
      } else if (message.type === 'result') {
        if (message.ok) completed += 1;
        else failed += 1;
        idle.push(worker);
      }
      dispatch();
    });
    worker.on('error', (error) => {
      console.error(error);
      process.exit(1);
    });
    workers.push(worker);
  });

const started = Date.now();
if (stagger > 0) {
  let left = WORKERS;
  await Promise.all(
    Array.from({ length: stagger }, async () => {
      while (left > 0) {
        left -= 1;
        await spawnOne();
      }
    }),
  );
} else {
  await Promise.all(Array.from({ length: WORKERS }, spawnOne));
}
const readyMs = Date.now() - started;

const tick = setInterval(() => {
  for (let i = 0; i < PER_TICK; i += 1) {
    nextJob += 1;
    queue.push({
      type: 'run',
      jobId: String(nextJob),
      sensorId: nextJob % 5000,
      sensorType: 'port.tcp',
      target: { host: '127.0.0.1', ipVersion: 'auto' },
      params: { port, banner: '', timeoutMs: 5000, bannerTimeoutMs: 3000 },
    });
  }
  dispatch();
}, 1000);

const kb = (text, key) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0);
const MiB = (bytes) => Math.round(bytes / 1048576);
for (let s = 1; s <= seconds; s += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const status = readFileSync('/proc/self/status', 'utf8');
  const heaps = await Promise.all(workers.map((worker) => worker.getHeapStatistics()));
  const sum = (key) => heaps.reduce((total, heap) => total + heap[key], 0);
  const sample = {
    s,
    variant,
    cpus: availableParallelism(),
    readyMs,
    completed,
    failed,
    queued: queue.length,
    anonMiB: Math.round(kb(status, 'RssAnon') / 1024),
    hwmMiB: Math.round(kb(status, 'VmHWM') / 1024),
    swapMiB: Math.round(kb(status, 'VmSwap') / 1024),
    heapTotalMiB: MiB(sum('total_heap_size')),
    heapUsedMiB: MiB(sum('used_heap_size')),
    heapMaxOneMiB: MiB(Math.max(...heaps.map((heap) => heap.total_heap_size))),
  };
  appendFileSync(out, `${JSON.stringify(sample)}\n`);
}
clearInterval(tick);
await Promise.all(workers.map((worker) => worker.terminate()));
server.close();
