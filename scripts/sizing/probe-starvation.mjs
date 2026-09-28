// What a starved probe does with its memory and its log, and whether systemd kills it (`P-216`,
// with `P-220`'s memory stage). Runs *inside* the box `scripts/sizing/probe-starvation.sh` builds,
// as root, with MS_TOKEN and MS_BOX_LIMIT_MIB set.
//
// `P-216`: the dev probe, at ~5,000 sensors on a starved VM, grew to 4.76 GiB and then logged
// nothing for thirteen minutes with its CPU still pinned. `P-220`: CPU starvation alone killed
// nothing (`docs/findings/2026-09-29-watchdog-under-load.md`), and memory is the prime suspect.
// This holds the probe under load through stages that add, one at a time:
//
// - **CPU**, `cpu × nproc` busy loops in a unit of their own, as `P-220` did;
// - **memory**, a balloon filling all but `leaveMiB` of the *box's* limit (never the VM's), marked
//   to be the OOM killer's first choice;
// - **a stalled log**: the unit that drains the probe's stdout FIFO is stopped with SIGSTOP, as a
//   starved journald would be, and the probe keeps writing into a pipe nobody reads.
//
// Every second it records, from outside the probe: its RSS, anonymous memory, swap and threads
// from `/proc`, its CPU, the box's memory and pressure from its cgroup, what systemd holds about
// both units (restarts, and when PID 1 last took a watchdog ping), and how many bytes of the
// probe's output reached the reader. Every five seconds, the probe's own Probe Health. Inside the
// probe, `probe-memory-sampler.mjs` records its heaps, the log's backlog, loop delay and GC time.
// At the end, what each service sent to `systemd-notify` and what PID 1 logged about it.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const API = 'http://127.0.0.1:8080/api/v1';
const TOKEN = process.env.MS_TOKEN;
if (!TOKEN) {
  console.error('MS_TOKEN is not set');
  process.exit(2);
}
/** `cpu:seconds[:leaveMiB[:stall]]`. Baseline, CPU, CPU and memory, all three, then recovery. */
const STAGES = (process.env.MS_STAGES ?? '0:120,6:240,6:300:300,6:300:300:1,0:180')
  .split(',')
  .map((spec) => {
    const [cpu, seconds, leaveMiB, stall] = spec.split(':');
    return {
      cpu: Number(cpu),
      seconds: Number(seconds),
      leaveMiB: leaveMiB === undefined || leaveMiB === '' ? null : Number(leaveMiB),
      stall: stall === '1',
    };
  });
const SENSORS = Number(process.env.MS_SENSORS ?? '5000');
const HEAP_SNAPSHOT = process.env.MS_HEAP_SNAPSHOT === '1';
const UNITS = ['ms-core', 'ms-probe'];
const READER = 'ms-stdout-reader';
const OUTPUT_LOG = '/var/lib/ms-starvation/probe-output.log';

const start = Date.now();
const elapsed = () => Math.round((Date.now() - start) / 100) / 10;
const emit = (line) => console.log(JSON.stringify({ t: elapsed(), ...line }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryCtl = (args) => {
  try {
    sh('systemctl', args);
    return null;
  } catch (error) {
    return String(error.stderr ?? error).trim();
  }
};

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return text === '' ? null : JSON.parse(text);
}

/** What systemd holds about a unit, including when it last accepted a watchdog ping. */
function unit(name) {
  const fields = Object.fromEntries(
    sh('systemctl', [
      'show',
      '-p',
      'MainPID,NRestarts,ActiveState,SubState,Result,WatchdogTimestampMonotonic',
      name,
    ])
      .split('\n')
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
  );
  return {
    pid: Number(fields.MainPID),
    restarts: Number(fields.NRestarts),
    state: `${fields.ActiveState}/${fields.SubState}`,
    result: fields.Result,
    pingUs: Number(fields.WatchdogTimestampMonotonic),
  };
}

function pingAgeMs(pingUs) {
  if (pingUs === 0) return null;
  return Math.round((Number(process.hrtime.bigint() / 1_000n) - pingUs) / 1_000);
}

/** `some` and `full` `avg10` from a pressure file. */
function psi(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const some = Number(/^some .*?avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
    const full = Number(/^full .*?avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
    return [some, full];
  } catch {
    return null;
  }
}

/**
 * The box's own cgroup: the nearest ancestor of PID 1's with a memory limit, which is where
 * `docker update --memory` put it. The box runs with the host's cgroup namespace, so the path in
 * `/proc/1/cgroup` is the path under `/sys/fs/cgroup`.
 */
function boxCgroup() {
  const path = /^0::(.*)$/m.exec(readFileSync('/proc/1/cgroup', 'utf8'))?.[1] ?? '/';
  const parts = path.split('/').filter((part) => part !== '');
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = `/sys/fs/cgroup/${parts.slice(0, depth).join('/')}`;
    try {
      if (readFileSync(`${dir}/memory.max`, 'utf8').trim() !== 'max') return dir;
    } catch {
      // No memory controller here; keep walking up.
    }
  }
  return null;
}
const BOX = boxCgroup();
const mib = (bytes) => Math.round(bytes / 1024 / 1024);
const readNumber = (path) => {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === 'max' ? null : Number(text);
  } catch {
    return null;
  }
};

function boxMemory() {
  if (BOX === null) return null;
  return {
    currentMiB: mib(readNumber(`${BOX}/memory.current`) ?? NaN),
    maxMiB: mib(readNumber(`${BOX}/memory.max`) ?? NaN),
    swapMiB: mib(readNumber(`${BOX}/memory.swap.current`) ?? NaN),
    psi: psi(`${BOX}/memory.pressure`),
  };
}

let lastCpu = null;
/** The probe's memory and CPU as the kernel sees them, which a blocked event loop cannot stop. */
function probeProcess(pid) {
  if (!(pid > 0)) return null;
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? NaN);
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    const now = Date.now();
    const cpuPercent =
      lastCpu !== null && lastCpu.pid === pid
        ? Math.round(((ticks - lastCpu.ticks) / 100 / ((now - lastCpu.at) / 1000)) * 100)
        : null;
    lastCpu = { pid, ticks, at: now };
    return {
      rssMiB: Math.round(kb('VmRSS') / 1024),
      anonMiB: Math.round(kb('RssAnon') / 1024),
      swapMiB: Math.round(kb('VmSwap') / 1024),
      threads: kb('Threads'),
      cpuPercent,
    };
  } catch {
    return null;
  }
}

const outputBytes = () => {
  try {
    return statSync(OUTPUT_LOG).size;
  } catch {
    return null;
  }
};
const loadavg = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
const cpus = Number(sh('nproc', []));

emit({
  kind: 'conditions',
  cpus,
  loadavg: loadavg(),
  systemd: sh('systemctl', ['--version']).split('\n')[0],
  boxCgroup: BOX,
  boxLimitMiB: Number(process.env.MS_BOX_LIMIT_MIB ?? NaN),
  boxMemory: boxMemory(),
  sensors: SENSORS,
  stages: STAGES,
});
if (BOX === null)
  throw new Error('the box has no memory limit, so a memory stage would starve the VM');

if (process.env.MS_PREFLIGHT === '1') {
  const problems = [];
  const reader = unit(READER);
  if (reader.state !== 'active/running') problems.push(`${READER} is ${reader.state}`);
  const fifo = '/var/lib/ms-starvation/probe.fifo';
  if (!existsSync(fifo) || !statSync(fifo).isFIFO()) problems.push(`${fifo} is not a FIFO`);
  if (!((outputBytes() ?? 0) > 0)) problems.push('no probe output has reached the reader');
  const probeUnit = unit('ms-probe');
  if (probeUnit.state !== 'active/running') problems.push(`ms-probe is ${probeUnit.state}`);
  let samples = [];
  try {
    samples = readFileSync('/var/lib/ms-probe/memory.ndjson', 'utf8').trim().split('\n');
  } catch {
    problems.push('the sampler has written nothing inside the probe');
  }
  const lastSample = samples.length > 0 ? JSON.parse(samples.at(-1)) : null;
  if (lastSample !== null && lastSample.logBacklogBytes === null) {
    problems.push("the sampler did not find the probe's SonicBoom");
  }
  if (probeProcess(probeUnit.pid) === null) problems.push("the probe's /proc is unreadable");
  // The limits as the kernel holds them, and `free` as an operator would read it inside the box,
  // for the findings: the balloon is sized to these, and nothing else stands between it and the VM.
  const limits = {
    memoryMax: readFileSync(`${BOX}/memory.max`, 'utf8').trim(),
    swapMax: readFileSync(`${BOX}/memory.swap.max`, 'utf8').trim(),
    free: sh('free', ['-m']),
  };
  if (limits.memoryMax === 'max') problems.push('the box has no memory.max');
  if (limits.swapMax === 'max') problems.push('the box has no memory.swap.max');
  emit({ kind: 'preflight', problems, limits, lastSample, box: boxMemory(), reader: reader.state });
  if (problems.length > 0) {
    console.error(`preflight failed: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.error('preflight passed');
  process.exit(0);
}

// ---- Set up: approve the probe, then give it its sensors. ----
const root = await api('GET', '/objects/root');
let probeObjectId = (await api('GET', '/probes?status=approved')).items[0]?.objectId ?? null;
if (probeObjectId === null) {
  const probeObject = await api('POST', '/objects', {
    kind: 'probe',
    parentId: root.id,
    name: 'Local probe',
  });
  let pending = null;
  for (let attempt = 0; attempt < 60 && pending === null; attempt += 1) {
    const { items } = await api('GET', '/probes?status=pending');
    pending = items[0] ?? null;
    if (pending === null) await sleep(1_000);
  }
  if (pending === null) throw new Error('no probe is waiting for approval');
  await api('POST', `/probes/${encodeURIComponent(pending.gid)}/approve`, {
    objectId: probeObject.id,
    local: true,
  });
  probeObjectId = probeObject.id;
}
const provisioned = spawnSync(
  process.execPath,
  ['/tmp/provision.mjs', '--sensors', String(SENSORS), '--api', API],
  { encoding: 'utf8', env: { ...process.env, MS_TOKEN: TOKEN } },
);
if (provisioned.status !== 0) {
  throw new Error(`provisioning failed: ${provisioned.stderr || provisioned.stdout}`);
}
emit({ kind: 'setup', probeObjectId, sensors: SENSORS, pid1LogLevel: 'debug' });

async function probeHealth() {
  try {
    return (await api('GET', `/probes/${probeObjectId}/health`)).channels;
  } catch (error) {
    return { error: String(error) };
  }
}

tryCtl(['reset-failed', ...UNITS]);
sh('systemd-analyze', ['log-level', 'debug']);

// ---- Stage controls. ----
const HOG = 'ms-hog';
function hog(factor) {
  tryCtl(['stop', HOG]);
  tryCtl(['reset-failed', HOG]);
  if (factor === 0) return;
  sh('systemd-run', [
    `--unit=${HOG}`,
    '--collect',
    '--quiet',
    'bash',
    '-c',
    `for i in $(seq ${String(factor * cpus)}); do (while :; do :; done) & done; wait`,
  ]);
}

const BALLOON = 'ms-balloon';
/** Fills all but `leaveMiB` of the box's limit, or releases it. Touched, so it is resident. */
function balloon(leaveMiB) {
  tryCtl(['stop', BALLOON]);
  tryCtl(['reset-failed', BALLOON]);
  if (leaveMiB === null) return 0;
  const memory = boxMemory();
  const sizeMiB = memory.maxMiB - memory.currentMiB - leaveMiB;
  if (sizeMiB <= 0) return 0;
  sh('systemd-run', [
    `--unit=${BALLOON}`,
    '--collect',
    '--quiet',
    '-p',
    'OOMScoreAdjust=1000',
    process.execPath,
    '-e',
    `const held = []; for (let i = 0; i < ${String(sizeMiB)}; i += 1) held.push(Buffer.alloc(1 << 20, 1)); setInterval(() => held.length, 1 << 30);`,
  ]);
  return sizeMiB;
}

let stalled = false;
function stall(on) {
  if (on === stalled) return;
  tryCtl(['kill', '-s', on ? 'SIGSTOP' : 'SIGCONT', READER]);
  stalled = on;
}

async function heapSnapshot(pid) {
  const before = new Set(sh('bash', ['-c', 'ls /var/lib/ms-probe/ 2>/dev/null']).split('\n'));
  process.kill(pid, 'SIGUSR2');
  for (let waited = 0; waited < 180; waited += 1) {
    await sleep(1_000);
    const now = sh('bash', ['-c', 'ls /var/lib/ms-probe/ 2>/dev/null']).split('\n');
    const made = now.find((name) => name.endsWith('.heapsnapshot') && !before.has(name));
    if (made !== undefined) {
      // Written in one go once it appears; wait for the size to settle.
      let size = -1;
      for (;;) {
        await sleep(2_000);
        const next = statSync(`/var/lib/ms-probe/${made}`).size;
        if (next === size) break;
        size = next;
      }
      return { file: made, bytes: size, tookS: waited };
    }
  }
  return { file: null };
}

// ---- The stages. ----
const kills = [];
const previous = Object.fromEntries(UNITS.map((name) => [name, unit(name)]));
let lastOutput = outputBytes();
for (const [index, stage] of STAGES.entries()) {
  hog(stage.cpu);
  const balloonMiB = balloon(stage.leaveMiB);
  stall(stage.stall);
  emit({ kind: 'stage', index, ...stage, loops: stage.cpu * cpus, balloonMiB });
  const until = Date.now() + stage.seconds * 1_000;
  let tick = 0;
  while (Date.now() < until) {
    const now = Object.fromEntries(UNITS.map((name) => [name, unit(name)]));
    for (const name of UNITS) {
      if (
        now[name].restarts !== previous[name].restarts ||
        now[name].result !== previous[name].result
      ) {
        const event = { kind: 'unit-event', index, unit: name, ...now[name] };
        kills.push(event);
        emit(event);
      }
    }
    const output = outputBytes();
    const line = {
      kind: 'tick',
      index,
      load: loadavg(),
      psi: {
        cpu: psi('/proc/pressure/cpu'),
        memory: psi('/proc/pressure/memory'),
        io: psi('/proc/pressure/io'),
      },
      box: boxMemory(),
      probe: probeProcess(now['ms-probe'].pid),
      outputBytesPerS: output !== null && lastOutput !== null ? output - lastOutput : null,
      balloon: unit(BALLOON).state,
      core: {
        pingAgeMs: pingAgeMs(now['ms-core'].pingUs),
        state: now['ms-core'].state,
        restarts: now['ms-core'].restarts,
      },
      probeUnit: {
        pingAgeMs: pingAgeMs(now['ms-probe'].pingUs),
        state: now['ms-probe'].state,
        restarts: now['ms-probe'].restarts,
      },
    };
    lastOutput = output;
    if (tick % 5 === 0) line.health = await probeHealth();
    emit(line);
    Object.assign(previous, now);
    tick += 1;
    await sleep(1_000);
  }
  // The peak is the end of the last stalled stage: snapshot there, before the log drains.
  const last = STAGES.findLastIndex((one) => one.stall);
  if (HEAP_SNAPSHOT && index === last) {
    emit({ kind: 'heap-snapshot', ...(await heapSnapshot(unit('ms-probe').pid)) });
  }
}
hog(0);
balloon(null);
stall(false);
sh('systemd-analyze', ['log-level', 'info']);

// ---- What was sent, from the wrappers, and what PID 1 said about it. ----
for (const name of UNITS) {
  let sent = '';
  try {
    sent = readFileSync(`/var/lib/${name}/notify-wrapper.log`, 'utf8');
  } catch {
    // No ping was sent at all, which the ticks show as well.
  }
  for (const entry of sent.split('\n').filter((line) => line !== '')) {
    const [startedAt, finishedAt, exit, ...args] = entry.split(' ');
    const at = Math.round((Number(startedAt) * 1_000 - start) / 100) / 10;
    if (at < 0) continue;
    emit({
      kind: 'sent',
      unit: name,
      at,
      tookMs: Math.round((Number(finishedAt) - Number(startedAt)) * 1_000),
      exit: Number(exit),
      args: args.join(' '),
    });
  }
}
// To a file, then line by line: PID 1 at debug outgrows any in-memory buffer (`P-220`).
const PID1_LOG = '/tmp/probe-starvation-pid1.log';
const pid1Out = openSync(PID1_LOG, 'w');
const read = spawnSync(
  'journalctl',
  [
    '_PID=1',
    '--no-pager',
    '--output=short-unix',
    '--since',
    `@${String(Math.floor(start / 1_000))}`,
  ],
  { stdio: ['ignore', pid1Out, 'pipe'] },
);
closeSync(pid1Out);
if (read.status !== 0)
  emit({ kind: 'pid1-error', status: read.status, stderr: String(read.stderr) });
if (existsSync(PID1_LOG)) {
  for await (const entry of createInterface({ input: createReadStream(PID1_LOG) })) {
    const match = /^(\d+\.\d+) \S+ [^:]+: (.*)$/.exec(entry);
    if (match === null) continue;
    const message = match[2];
    if (!/ms-(core|probe)|notify|[Ww]atchdog|ms-balloon|oom/i.test(message)) continue;
    if (
      !/[Nn]otif|[Ww]atchdog|Cannot find unit|Main process exited|Failed with result|Scheduled restart|oom/i.test(
        message,
      )
    )
      continue;
    emit({ kind: 'pid1', at: Math.round((Number(match[1]) * 1_000 - start) / 100) / 10, message });
  }
}
emit({ kind: 'summary', stages: STAGES.length, kills: kills.length });
