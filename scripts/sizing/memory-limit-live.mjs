// Probe Health's `memoryLimitUsage` on a real systemd install, and what the installed unit does to
// a probe past its ceiling (`P-210`, `P-213`). Runs *inside* the box `scripts/smoke-install.sh`
// builds — started by `scripts/sizing/memory-limit-live.sh`, which says how — as root, with
// MS_TOKEN set.
//
// It approves the probe, gives it a Probe Health and a Core Health sensor, and then moves the
// probe's ceiling under it with `systemctl set-property --runtime` — the installed ceiling is far
// above what an idle probe uses, so the ceiling is brought to the probe rather than the probe to
// the ceiling. The ceiling it moves is the one that binds first in the installed unit file:
// `MemoryHigh` where it sets one, `MemoryMax` where it does not; each restore puts back the unit
// file's own figures. Four stages, each held for a minute: at the installed unit; with the ceiling
// set so the working set is 85% of it (the warning); with the ceiling below the working set and
// swap available, which is the installed unit on a host with swap; and the same with
// `MemorySwapMax=0`, held for two, followed by the installed ceiling again to see whether the
// probe comes back. Under a start limit (`P-215`) a probe killed at every start ends in `failed`
// instead, and each restore then starts it again by hand, as an operator would. Last, with the
// probe's stages done, two of the core's (`P-215`): started ahead of a stopped PostgreSQL, held
// past `TimeoutStartSec`, which shows whether it waits or is killed; and started with a
// configuration it refuses, which shows whether it stops at once or restarts into the refusal.
// Every five seconds it records what systemd and the kernel say about the service, what the core's
// live route says, and the sensor's state; at the end, what the sweep stored in `sample`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'http://127.0.0.1:8080/api/v1';
const TOKEN = process.env.MS_TOKEN;
if (!TOKEN) {
  console.error('MS_TOKEN is not set');
  process.exit(2);
}
const HOLD_MS = Number(process.env.MS_STAGE_SECONDS ?? 65) * 1_000;
const MIB = 1024 * 1024;
const start = Date.now();
const elapsed = () => Math.round((Date.now() - start) / 100) / 10;
const emit = (line) => console.log(JSON.stringify({ t: elapsed(), ...line }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

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

// ---- What systemd and the kernel say about the probe's service. ----
/**
 * A unit's main process, how often it has been restarted, why it last stopped, and what it last
 * told systemd — `STATUS=`, which is where the core says what it is waiting for (`P-215`).
 */
function unit(name = 'ms-probe') {
  const fields = Object.fromEntries(
    sh('systemctl', [
      'show',
      '-p',
      'MainPID,NRestarts,ActiveState,SubState,Result,StatusText,ExecMainStatus',
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
    exitStatus: Number(fields.ExecMainStatus),
    status: fields.StatusText,
  };
}
/** A `systemctl` that may fail, recorded rather than thrown: failing is often the finding. */
function tryCtl(args) {
  try {
    sh('systemctl', args);
    return null;
  } catch (error) {
    // systemctl prefixes its own warnings (a drop-in changed on disk) to the error it is reporting.
    return String(error.stderr ?? error)
      .split('\n')
      .filter((line) => !line.startsWith('Warning:'))
      .join('\n')
      .trim();
  }
}
/**
 * Clears both units' start limit before a case that starts one of them. Every start counts toward
 * `StartLimitBurst`, an operator's own included (measured here, 2026-09-28), and the smoke test and
 * the cases before each one start both services several times inside the ten-minute window: on
 * that run the refused-configuration case was refused by the start limit instead, before the core
 * read its file. Each case measures its own starts, and nothing it inherited.
 */
function freshLimit() {
  tryCtl(['reset-failed', 'ms-core', 'ms-probe']);
}
/**
 * Starts a unit systemd has given up on, the way an operator must after `P-215`'s start limit:
 * `reset-failed`, then `start`. A unit still going round needs neither, and gets neither.
 */
function revive(name) {
  const before = unit(name);
  if (!before.state.startsWith('failed')) return;
  tryCtl(['reset-failed', name]);
  const error = tryCtl(['start', '--no-block', name]);
  emit({ kind: 'revive', unit: name, was: before.state, result: before.result, error });
}
/**
 * The service's cgroup directory, from its main process. Read from `/proc` rather than from
 * systemd's `ControlGroup`, which is relative to systemd's root and this box's is not the kernel's.
 * Null between a kill and the restart, when there is no main process to ask.
 */
function serviceCgroup(pid) {
  if (pid === 0) return null;
  try {
    const line = readFileSync(`/proc/${String(pid)}/cgroup`, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    return line === undefined ? null : `/sys/fs/cgroup${line.slice(3)}`;
  } catch {
    return null;
  }
}
// A restart makes the service's cgroup again at the same path, so the last one seen is kept for
// the reads between a kill and the restart — which find it missing, and say so.
let lastCgroup = null;
function kernel() {
  const service = unit();
  lastCgroup = serviceCgroup(service.pid) ?? lastCgroup;
  // Recorded rather than thrown, so a restart is a line in the record and not the end of it.
  try {
    return { ...service, ...cgroupFiles(lastCgroup) };
  } catch (error) {
    return { ...service, unreadable: String(error) };
  }
}
function cgroupFiles(directory) {
  const read = (file) => readFileSync(`${directory}/${file}`, 'utf8').trim();
  const number = (text) => (text === 'max' ? null : Number(text));
  const stat = Object.fromEntries(
    read('memory.stat')
      .split('\n')
      .map((entry) => entry.split(' '))
      .map(([key, value]) => [key, Number(value)]),
  );
  const events = Object.fromEntries(
    read('memory.events')
      .split('\n')
      .map((entry) => entry.split(' '))
      .map(([key, value]) => [key, Number(value)]),
  );
  const current = Number(read('memory.current'));
  const high = number(read('memory.high'));
  const max = number(read('memory.max'));
  const ceiling = [high, max]
    .filter((value) => value !== null)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const workingSet = Math.max(0, current - (stat.inactive_file ?? 0));
  let swap = null;
  try {
    swap = Math.round(Number(read('memory.swap.current')) / MIB);
  } catch {
    // No swap accounting on this kernel.
  }
  return {
    highMiB: high === null ? null : Math.round(high / MIB),
    maxMiB: max === null ? null : Math.round(max / MIB),
    currentMiB: Math.round(current / MIB),
    workingSetMiB: Math.round(workingSet / MIB),
    swapMiB: swap,
    usagePercent: ceiling === Infinity ? null : Math.round((workingSet / ceiling) * 1_000) / 10,
    highEvents: events.high,
    oomKills: events.oom_kill,
    stalledPercent: Number(/some avg10=([\d.]+)/.exec(read('memory.pressure'))?.[1] ?? NaN),
    workingSetBytes: workingSet,
  };
}
function setProperty(property) {
  sh('systemctl', ['set-property', '--runtime', 'ms-probe.service', property]);
  emit({ kind: 'set', property });
}

// The VM's load as the run begins: kills and stalls do not depend on it, but every time here does.
emit({
  kind: 'conditions',
  cpus: Number(sh('nproc', [])),
  loadavg: readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '),
});

// ---- The installed unit's memory settings, which every restore puts back. ----
const unitFile = sh('systemctl', ['show', '-p', 'FragmentPath', '--value', 'ms-probe']);
const unitText = readFileSync(unitFile, 'utf8');
const configured = (name) => new RegExp(`^${name}=(\\S+)`, 'm').exec(unitText)?.[1] ?? 'infinity';
const INSTALLED = { MemoryHigh: configured('MemoryHigh'), MemoryMax: configured('MemoryMax') };
/** The property that binds first, and so the one the stages move. */
const CEILING = INSTALLED.MemoryHigh === 'infinity' ? 'MemoryMax' : 'MemoryHigh';
const restore = () => setProperty(`${CEILING}=${INSTALLED[CEILING]}`);

// ---- Set up: approve the probe, and give it the two health sensors. ----
// From the installed unit, whatever a previous run left behind.
setProperty(`MemoryHigh=${INSTALLED.MemoryHigh}`);
setProperty(`MemoryMax=${INSTALLED.MemoryMax}`);
setProperty('MemorySwapMax=infinity');
const root = await api('GET', '/objects/root');
// A rerun in the same box finds the probe already approved and reuses it.
const approved = (await api('GET', '/probes?status=approved')).items[0] ?? null;
let probeObject;
if (approved !== null && approved.objectId !== null) {
  probeObject = { id: approved.objectId };
} else {
  probeObject = await api('POST', '/objects', {
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
}
const device = await api('POST', '/objects', {
  kind: 'device',
  parentId: probeObject.id,
  name: 'This box',
  host: '127.0.0.1',
});
const probeHealth = await api('POST', '/objects', {
  kind: 'sensor',
  parentId: device.id,
  name: 'Probe Health',
  sensorType: 'ms.probe.health',
  params: {},
});
const coreHealth = await api('POST', '/objects', {
  kind: 'sensor',
  parentId: device.id,
  name: 'Core Health',
  sensorType: 'ms.core.health',
  params: {},
});
const { pid } = unit();
lastCgroup = serviceCgroup(pid);
if (lastCgroup === null) throw new Error(`the probe is not running (main process ${String(pid)})`);
emit({
  kind: 'setup',
  unitFile,
  installed: INSTALLED,
  ceiling: CEILING,
  probeObjectId: probeObject.id,
  probeHealthSensorId: probeHealth.id,
  coreHealthSensorId: coreHealth.id,
  probeCgroup: lastCgroup,
  probeSelfCgroup: readFileSync(`/proc/${String(pid)}/cgroup`, 'utf8').trim(),
});

// Wait for the approved probe to come back and report a limit.
for (let attempt = 0; attempt < 60; attempt += 1) {
  const health = await api('GET', `/probes/${probeObject.id}/health`);
  if (health.channels.connected === 1 && health.channels.memoryLimit !== null) break;
  await sleep(1_000);
}

async function stage(name, hold) {
  emit({ kind: 'stage', stage: name });
  const until = Date.now() + hold;
  while (Date.now() < until) {
    const [probe, core, state] = await Promise.all([
      api('GET', `/probes/${probeObject.id}/health`).catch((error) => ({ error: String(error) })),
      api('GET', '/core-health').catch((error) => ({ error: String(error) })),
      api('GET', `/sensors/${probeHealth.id}/state`).catch((error) => ({ error: String(error) })),
    ]);
    const { workingSetBytes: _bytes, ...cgroupNow } = kernel();
    emit({
      kind: 'poll',
      stage: name,
      kernel: cgroupNow,
      probe: probe.channels
        ? {
            connected: probe.channels.connected,
            heartbeatAge: probe.channels.heartbeatAge,
            memoryLimitUsage: probe.channels.memoryLimitUsage,
            memoryLimit: probe.channels.memoryLimit,
            memoryAvailable: probe.channels.memoryAvailable,
            memory: probe.channels.memory,
          }
        : probe,
      core: core.channels
        ? {
            memoryLimitUsage: core.channels.memoryLimitUsage,
            memoryLimit: core.channels.memoryLimit,
          }
        : core,
      state: state.state ? { state: state.state, message: state.message } : state,
    });
    await sleep(5_000);
  }
}

await stage('stock unit', HOLD_MS);
const workingSet = () => {
  const now = kernel();
  if (now.workingSetBytes === undefined)
    throw new Error(`cannot read the probe's cgroup: ${now.unreadable}`);
  return now.workingSetBytes;
};
setProperty(`${CEILING}=${String(Math.ceil(workingSet() / 0.85))}`);
await stage('ceiling at 85%', HOLD_MS);
freshLimit();
setProperty(`${CEILING}=${String(Math.floor(workingSet() * 0.9))}`);
await stage('ceiling below the working set, swap available', HOLD_MS);
restore();
revive('ms-probe');
await stage('restored', 30_000);
freshLimit();
setProperty('MemorySwapMax=0');
setProperty(`${CEILING}=${String(Math.floor(workingSet() * 0.9))}`);
// Twice as long: a probe with nowhere to put its pages is throttled or killed — which, is the
// installed unit's choice — and the question is what the restart does under the same ceiling.
await stage('ceiling below the working set, no swap', 2 * HOLD_MS);
restore();
setProperty('MemorySwapMax=infinity');
revive('ms-probe');
await stage('restored', HOLD_MS);

// ---- What the sweep stored. ----
const stored = sh('runuser', [
  '-u',
  'postgres',
  '--',
  'psql',
  '-d',
  'monitoring',
  '-Atc',
  `SELECT c.sensor_id, c.key, to_char(s.time, 'HH24:MI:SS'), s.value
     FROM sample s JOIN channel c ON c.id = s.channel_id
    WHERE c.sensor_id IN (${String(probeHealth.id)}, ${String(coreHealth.id)})
      AND c.key IN ('memoryLimitUsage', 'memoryLimit', 'memoryAvailable')
    ORDER BY s.time, c.sensor_id, c.key`,
]);
for (const row of stored.split('\n').filter(Boolean)) {
  const [sensorId, key, time, value] = row.split('|');
  emit({
    kind: 'stored',
    sensor: Number(sensorId) === probeHealth.id ? 'probe' : 'core',
    key,
    time,
    value: Number(value),
  });
}

// ---- What systemd said about the probe: every kill, restart and readiness, in its own words. ----
const journal = sh('journalctl', [
  '-u',
  'ms-probe',
  '--no-pager',
  '--output=short-unix',
  '--since',
  `@${String(Math.floor(start / 1_000))}`,
]);
for (const entry of journal.split('\n')) {
  const match = /^(\d+\.\d+) \S+ ([^:]+): (.*)$/.exec(entry);
  if (
    match === null ||
    !/oom|OOM|watchdog|Watchdog|result|restart|killed|Started|Main process|too quickly|start-limit/.test(
      match[3],
    )
  )
    continue;
  emit({
    kind: 'journal',
    at: Math.round((Number(match[1]) * 1_000 - start) / 100) / 10,
    from: match[2],
    message: match[3],
  });
}

// ---- P-215: the core's two start-up cases. Last, because both stop things the stages above need. ----
/** Polls a unit every two seconds for `hold`, or until `done` says so. */
async function watch(name, stageName, hold, done = () => false) {
  emit({ kind: 'stage', stage: stageName });
  const until = Date.now() + hold;
  for (;;) {
    const now = unit(name);
    emit({ kind: 'unit', stage: stageName, unit: name, ...now });
    if (done(now) || Date.now() >= until) return now;
    await sleep(2_000);
  }
}

// A core started ahead of its database. Held for ninety seconds — past `TimeoutStartSec=60` — so
// that a wait without `EXTEND_TIMEOUT_USEC` would be killed here and show as a restart.
tryCtl(['stop', 'ms-core']);
freshLimit();
tryCtl(['stop', 'postgresql']);
const coreBefore = unit('ms-core').restarts;
tryCtl(['start', '--no-block', 'ms-core']);
const waited = await watch('ms-core', 'core started, database stopped', 90_000);
tryCtl(['start', 'postgresql']);
const cameUp = await watch(
  'ms-core',
  'database started',
  90_000,
  (now) => now.state === 'active/running',
);
emit({
  kind: 'verdict',
  case: 'core waits for its database',
  stateAt90s: waited.state,
  statusAt90s: waited.status,
  restartsWhileWaiting: waited.restarts - coreBefore,
  finalState: cameUp.state,
});

// A configuration the core refuses. Twenty seconds is four `RestartSec`s: a unit that restarted
// into the refusal would show it here.
const configFile = '/etc/ms/core.json';
const original = readFileSync(configFile, 'utf8');
const refusedBefore = unit('ms-core').restarts;
try {
  writeFileSync(configFile, '{ "this is": not json');
  emit({ kind: 'set', property: `${configFile} made unreadable` });
  freshLimit();
  tryCtl(['restart', 'ms-core']);
  const refused = await watch('ms-core', 'configuration refused', 20_000);
  emit({
    kind: 'verdict',
    case: 'a refused configuration stops at once',
    state: refused.state,
    // `exit-code` with 78 is the refusal; `start-limit-hit` means the case never ran.
    result: refused.result,
    exitStatus: refused.exitStatus,
    restarts: refused.restarts - refusedBefore,
  });
} finally {
  writeFileSync(configFile, original);
  emit({ kind: 'set', property: `${configFile} restored` });
}
revive('ms-core');
await watch('ms-core', 'configuration restored', 60_000, (now) => now.state === 'active/running');

// Whether an operator's own restarts count against the limit. Six in quick succession, the way
// somebody debugging does them: if the sixth is refused, `administration.md` has to say so.
freshLimit();
const manual = [];
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const error = tryCtl(['restart', 'ms-probe']);
  manual.push({ attempt, refused: error !== null, error: error?.slice(0, 200) ?? null });
  await sleep(1_000);
}
emit({
  kind: 'verdict',
  case: 'manual restarts count toward the limit',
  attempts: manual,
  after: unit('ms-probe').state,
});
tryCtl(['reset-failed', 'ms-probe']);
tryCtl(['start', '--no-block', 'ms-probe']);

const coreJournal = sh('journalctl', [
  '-u',
  'ms-core',
  '--no-pager',
  '--output=short-unix',
  '--since',
  `@${String(Math.floor(start / 1_000))}`,
]);
for (const entry of coreJournal.split('\n')) {
  const match = /^(\d+\.\d+) \S+ ([^:]+): (.*)$/.exec(entry);
  if (
    match === null ||
    !/waiting for PostgreSQL|database is reachable|gave up waiting|result|restart|too quickly|Configuration error|Started|status=78/.test(
      match[3],
    )
  )
    continue;
  emit({
    kind: 'journal',
    unit: 'ms-core',
    at: Math.round((Number(match[1]) * 1_000 - start) / 100) / 10,
    from: match[2],
    message: match[3].slice(0, 400),
  });
}
