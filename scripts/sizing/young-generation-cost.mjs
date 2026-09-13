#!/usr/bin/env node
// What a capped young generation costs a check worker, for `P-207`.
//
//     node scripts/sizing/young-generation-cost.mjs default,young4 [seconds]   # inside scripts/dev.sh
//     node scripts/sizing/young-generation-cost.mjs check                      # one of each, then exit
//
// **Every arm runs at the same time, in one process, on the same load.** The first version ran one
// variant per process, in turn, and the development Mac's host load went from quiet to 15 on eight
// cores in the middle of a batch -- a starvation the VM's own load average cannot see, which made
// one run's minor collections take twelve seconds in ten. Run side by side, whatever the host does
// to one arm it does to the other in the same second, so the comparison survives a noisy machine
// even when the absolute numbers do not.
//
// An arm is `default`, or `young<N>` for `resourceLimits.maxYoungGenerationSizeMb` of N. Each gets
// MS_P207_WORKERS (default 8) workers, started eight at a time as `CheckPool` starts them, and
// MS_P207_RATE (default 10) checks a second of each type:
//
//     snmp.table    a walk of hrStorageEntry on `target`'s net-snmp
//     rest.custom   a JSON document of about MS_P207_JSON_KB (default 512) KB, JSONPath over it
//     db.mysql      MS_P207_DB_ROWS (default 5,000) rows of 100 bytes from MariaDB, all in memory
//
// Every check is offered to every arm in the same tick. The JSON document is served from this
// process; the other two are real servers on the compose network.
//
// **Delivered CPU is measured in every window**: a thread of its own runs `perf-conditions.mjs`'s
// fixed loop, a tenth the size, and the window records what it took. The summary reports each arm
// twice -- over every steady window, and over only the windows where that loop ran within 25% of
// the run's fastest -- because a comparison is only as good as the CPU it was given.
//
// Written to `young-generation-<arms>.ndjson` in $MS_P207_OUT (default: the working directory).
// **The check duration is the worker's own measurement** of `execute`, so a collection that lands
// during a check is in it, and nothing the dispatcher in this thread does is.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { standardCatalogue } = await import(
  pathToFileURL(join(root, 'packages', 'sensors', 'dist', 'src', 'index.js')).href
);
const registryModule = pathToFileURL(
  join(root, 'packages', 'probe', 'dist', 'src', 'runner', 'catalogue-registry.js'),
).href;

const [armsArg = 'default,young4', secondsArg = '1500'] = process.argv.slice(2);
const checkOnly = armsArg === 'check';
const ARMS = checkOnly ? ['default'] : armsArg.split(',');
const seconds = Number(secondsArg);
const WORKERS = Number(process.env.MS_P207_WORKERS ?? 8);
const RATE = Number(process.env.MS_P207_RATE ?? 10);
const JSON_KB = Number(process.env.MS_P207_JSON_KB ?? 512);
const DB_ROWS = Number(process.env.MS_P207_DB_ROWS ?? 5_000);
const WARMUP_S = Number(process.env.MS_P207_WARMUP_S ?? 120);
const WINDOW_S = 10;
const QUEUE_MAX = 1_000;
const CLEAN_WITHIN = 1.25;
const out = join(process.env.MS_P207_OUT ?? '.', `young-generation-${armsArg}.ndjson`);

// -- the JSON document --------------------------------------------------------------------------
const nodes = [];
for (let i = 0; nodes.length * 105 < JSON_KB * 1024; i += 1) {
  nodes.push({
    name: `node-${String(i)}`,
    state: i % 7 === 0 ? 'down' : 'up',
    load: (i % 100) / 100,
    labels: { rack: `r${String(i % 40)}`, zone: `z${String(i % 3)}`, role: 'worker' },
  });
}
const document = JSON.stringify({ status: 'healthy', queue: { depth: nodes.length }, nodes });
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(document);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const httpPort = server.address().port;

// -- the three checks, with their parameters completed the way the core completes them ----------
const catalogue = standardCatalogue();
const complete = (type, params) => {
  const result = catalogue.validate(type, params);
  if (!result.valid) throw new Error(`${type}: ${JSON.stringify(result.problems)}`);
  return result.params;
};
const CHECKS = {
  'snmp.table': {
    target: { host: 'target', ipVersion: 'v4' },
    credentials: { snmp: { version: 'v2c', community: 'public' } },
    params: complete('snmp.table', {
      port: 161,
      timeoutMs: 5_000,
      tableOid: '1.3.6.1.2.1.25.2.3.1',
      indexColumn: '3',
      rowMatch: 'Physical memory',
      columns: [
        { column: '5', name: 'Size', unit: 'blocks' },
        { column: '6', name: 'Used', unit: 'blocks' },
      ],
    }),
  },
  'rest.custom': {
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    credentials: {},
    params: complete('rest.custom', {
      scheme: 'http',
      port: httpPort,
      path: '/nodes.json',
      timeoutMs: 10_000,
      maxBodyBytes: 4 * 1024 * 1024,
      extract: [
        { key: 'depth', path: '$.queue.depth' },
        { key: 'down', path: "$.nodes[?(@.state=='down')]", aggregate: 'count' },
        { key: 'load', path: '$.nodes[*].load', aggregate: 'avg' },
      ],
    }),
  },
  'db.mysql': {
    target: { host: 'mariadb', ipVersion: 'auto' },
    credentials: { database: { username: 'monitoring', password: 'monitoring' } },
    params: complete('db.mysql', {
      port: 3306,
      database: 'monitoring',
      encrypt: 'disable',
      statementTimeoutMs: 10_000,
      query: `select seq, repeat('x', 100) as pad from seq_1_to_${String(DB_ROWS)}`,
    }),
  },
};
const TYPES = Object.keys(CHECKS);

// -- arms ---------------------------------------------------------------------------------------
const perType = (make) => Object.fromEntries(TYPES.map((type) => [type, make()]));
const makeArm = (name) => ({
  name,
  young: Number(name.match(/^young(\d+)$/)?.[1] ?? 0),
  workers: [],
  idle: [],
  queue: [],
  jobs: new Map(),
  gc: new Map(),
  window: perType(() => []),
  steady: [],
  failures: perType(() => ({ count: 0, first: '' })),
  refused: 0,
});
const arms = ARMS.map(makeArm);
for (const arm of arms) {
  if (arm.name !== 'default' && arm.young === 0) throw new Error(`unknown arm "${arm.name}"`);
}

const dispatch = (arm) => {
  while (arm.idle.length > 0 && arm.queue.length > 0) arm.idle.pop().postMessage(arm.queue.shift());
};
const spawnOne = (arm) =>
  new Promise((resolve) => {
    const worker = new Worker(join(here, 'gc-observing-worker.mjs'), {
      workerData: { registryModule },
      ...(arm.young > 0 ? { resourceLimits: { maxYoungGenerationSizeMb: arm.young } } : {}),
    });
    worker.on('message', (message) => {
      if (message.type === 'gc-stats') {
        arm.gc.set(worker, message);
        return;
      }
      if (message.type === 'ready') {
        arm.idle.push(worker);
        resolve();
      } else if (message.type === 'result') {
        const type = arm.jobs.get(message.jobId);
        arm.jobs.delete(message.jobId);
        if (message.ok) {
          arm.window[type].push(message.durationMs);
        } else {
          arm.failures[type].count += 1;
          if (arm.failures[type].first === '') arm.failures[type].first = message.message;
        }
        arm.idle.push(worker);
      }
      dispatch(arm);
    });
    worker.on('error', (error) => {
      console.error(error);
      process.exit(1);
    });
    arm.workers.push(worker);
  });

// Eight loading at once across the whole process, as the pool loads them (`P-206`).
const pending = arms.flatMap((arm) => Array.from({ length: WORKERS }, () => arm));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let arm = pending.shift(); arm !== undefined; arm = pending.shift()) await spawnOne(arm);
  }),
);

let nextJob = 0;
const offer = (type) => {
  nextJob += 1;
  const check = CHECKS[type];
  for (const arm of arms) {
    if (arm.queue.length >= QUEUE_MAX) {
      arm.refused += 1;
      continue;
    }
    const jobId = `${arm.name}-${String(nextJob)}`;
    arm.jobs.set(jobId, type);
    arm.queue.push({
      type: 'run',
      jobId,
      sensorId: nextJob,
      sensorType: type,
      target: check.target,
      params: check.params,
      credentials: check.credentials,
    });
    dispatch(arm);
  }
};

if (checkOnly) {
  for (const type of TYPES) offer(type);
  const deadline = Date.now() + 15_000;
  while (arms[0].jobs.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const type of TYPES) {
    console.log(type, { ms: arms[0].window[type], failed: arms[0].failures[type] });
  }
  console.log({ documentKB: Math.round(document.length / 1024), nodes: nodes.length });
  process.exit(0);
}

// -- delivered CPU ------------------------------------------------------------------------------
const calibrator = new Worker(
  `const { parentPort } = require('node:worker_threads');
   const spin = () => { const t = process.hrtime.bigint(); let x = 0;
     for (let i = 0; i < 3e7; i += 1) x += i % 7;
     return { ms: Number(process.hrtime.bigint() - t) / 1e6, x }; };
   parentPort.on('message', () => { spin(); parentPort.postMessage(Math.min(spin().ms, spin().ms)); });`,
  { eval: true },
);
const calibrate = () =>
  new Promise((resolve) => {
    calibrator.once('message', resolve);
    calibrator.postMessage('spin');
  });

// -- the run ------------------------------------------------------------------------------------
const percentile = (sorted, fraction) =>
  sorted.length === 0
    ? null
    : Number(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))].toFixed(2));
const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: percentile(sorted, 1),
  };
};
const gcTotals = (arm) => {
  const sum = {
    minorCount: 0,
    minorMs: 0,
    majorCount: 0,
    majorMs: 0,
    oldUsedMiB: 0,
    oldSizeMiB: 0,
    newSizeMiB: 0,
    heapSizeMiB: 0,
    cpuMs: 0,
  };
  for (const stats of arm.gc.values()) {
    sum.minorCount += stats.gc.minor.count;
    sum.minorMs += stats.gc.minor.ms;
    sum.majorCount += stats.gc.major.count;
    sum.majorMs += stats.gc.major.ms;
    sum.oldUsedMiB += (stats.spaces.old_space?.used ?? 0) / 1048576;
    sum.oldSizeMiB += (stats.spaces.old_space?.size ?? 0) / 1048576;
    sum.newSizeMiB += (stats.spaces.new_space?.size ?? 0) / 1048576;
    sum.heapSizeMiB +=
      Object.values(stats.spaces).reduce((total, space) => total + space.size, 0) / 1048576;
    sum.cpuMs += stats.cpuMicros / 1000;
  }
  return sum;
};
const procKb = (file, key) =>
  Number(readFileSync(file, 'utf8').match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0);

writeFileSync(out, '');
appendFileSync(
  out,
  `${JSON.stringify({
    kind: 'conditions',
    arms: ARMS,
    cpus: availableParallelism(),
    loadavg: loadavg(),
    workersPerArm: WORKERS,
    ratePerTypePerArm: RATE,
    jsonKB: Math.round(document.length / 1024),
    dbRows: DB_ROWS,
    seconds,
    warmupS: WARMUP_S,
  })}\n`,
);

const tick = setInterval(() => {
  for (let i = 0; i < RATE; i += 1) for (const type of TYPES) offer(type);
}, 1_000);

const previous = new Map(arms.map((arm) => [arm, gcTotals(arm)]));
const atSteady = new Map();
const calibrations = [];

for (let elapsedS = 0; elapsedS < seconds;) {
  await new Promise((resolve) => setTimeout(resolve, WINDOW_S * 1_000));
  elapsedS += WINDOW_S;
  const calibrationMs = Number((await calibrate()).toFixed(1));
  const line = {
    kind: 'window',
    s: elapsedS,
    calibrationMs,
    loadavg1: loadavg()[0],
    anonMiB: Math.round(procKb('/proc/self/status', 'RssAnon') / 1024),
    vmAvailableMiB: Math.round(procKb('/proc/meminfo', 'MemAvailable') / 1024),
    vmSwapFreeMiB: Math.round(procKb('/proc/meminfo', 'SwapFree') / 1024),
    arms: {},
  };
  for (const arm of arms) {
    const now = gcTotals(arm);
    const was = previous.get(arm);
    const done = TYPES.reduce((total, type) => total + arm.window[type].length, 0);
    line.arms[arm.name] = {
      checks: Object.fromEntries(TYPES.map((type) => [type, summarise(arm.window[type])])),
      failed: TYPES.reduce((total, type) => total + arm.failures[type].count, 0),
      queued: arm.queue.length,
      refused: arm.refused,
      cpuMsPerCheck: done === 0 ? null : Number(((now.cpuMs - was.cpuMs) / done).toFixed(3)),
      minorGcs: now.minorCount - was.minorCount,
      minorGcMs: Math.round(now.minorMs - was.minorMs),
      majorGcs: now.majorCount - was.majorCount,
      majorGcMs: Math.round(now.majorMs - was.majorMs),
      oldUsedMiB: Math.round(now.oldUsedMiB),
      oldSizeMiB: Math.round(now.oldSizeMiB),
      newSizeMiB: Math.round(now.newSizeMiB),
      heapSizeMiB: Math.round(now.heapSizeMiB),
    };
    if (elapsedS > WARMUP_S) {
      arm.steady.push({
        calibrationMs,
        durations: arm.window,
        cpuMs: now.cpuMs - was.cpuMs,
        done,
        oldUsedMiB: now.oldUsedMiB,
        newSizeMiB: now.newSizeMiB,
        heapSizeMiB: now.heapSizeMiB,
      });
    }
    if (elapsedS === WARMUP_S) atSteady.set(arm, now);
    arm.window = perType(() => []);
    previous.set(arm, now);
  }
  if (elapsedS > WARMUP_S) calibrations.push(calibrationMs);
  appendFileSync(out, `${JSON.stringify(line)}\n`);
}
clearInterval(tick);

// -- summary ------------------------------------------------------------------------------------
const fastest = Math.min(...calibrations);
const steadyS = seconds - WARMUP_S;
const mean = (values) => Math.round(values.reduce((total, v) => total + v, 0) / values.length);
const over = (windows) => {
  const done = windows.reduce((total, one) => total + one.done, 0);
  const cpuMs = windows.reduce((total, one) => total + one.cpuMs, 0);
  return {
    windows: windows.length,
    checks: Object.fromEntries(
      TYPES.map((type) => [type, summarise(windows.flatMap((one) => one.durations[type]))]),
    ),
    cpuMsPerCheck: done === 0 ? null : Number((cpuMs / done).toFixed(3)),
  };
};
const summary = {
  kind: 'summary',
  fastestCalibrationMs: fastest,
  cleanWithin: CLEAN_WITHIN,
  arms: {},
};
for (const arm of arms) {
  const end = gcTotals(arm);
  const start = atSteady.get(arm);
  const thirds = Math.max(1, Math.floor(arm.steady.length / 3));
  summary.arms[arm.name] = {
    all: over(arm.steady),
    clean: over(arm.steady.filter((one) => one.calibrationMs <= fastest * CLEAN_WITHIN)),
    failed: arm.failures,
    refused: arm.refused,
    minorGcsPerMin: Math.round(((end.minorCount - start.minorCount) / steadyS) * 60),
    minorGcMsPerMin: Math.round(((end.minorMs - start.minorMs) / steadyS) * 60),
    majorGcsPerMin: Number((((end.majorCount - start.majorCount) / steadyS) * 60).toFixed(1)),
    majorGcMsPerMin: Math.round(((end.majorMs - start.majorMs) / steadyS) * 60),
    oldUsedMiB: {
      firstThird: mean(arm.steady.slice(0, thirds).map((one) => one.oldUsedMiB)),
      lastThird: mean(arm.steady.slice(-thirds).map((one) => one.oldUsedMiB)),
    },
    newSizeMiB: mean(arm.steady.map((one) => one.newSizeMiB)),
    heapSizeMiB: mean(arm.steady.map((one) => one.heapSizeMiB)),
  };
}
appendFileSync(out, `${JSON.stringify(summary)}\n`);
await Promise.all([...arms.flatMap((arm) => arm.workers), calibrator].map((w) => w.terminate()));
server.close();
