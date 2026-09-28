// Whether systemd's watchdog kills an idle ms-core or ms-probe on a loaded host, and why (`P-220`).
// Runs *inside* the box `scripts/smoke-install.sh` builds, started by
// `scripts/sizing/watchdog-under-load.sh`, which says how, as root, with MS_TOKEN set.
//
// `P-215`'s rerun saw both services killed with *Watchdog timeout (limit 30s)!* at a load of 24 on
// 8 CPUs, neither doing anything. Every service pings every 15 s by spawning `systemd-notify
// --pid=<pid> WATCHDOG=1`, so a kill means no ping reached PID 1 for 30 s, and there are three
// places that can happen: the service's event loop did not run the timer, the helper was slow to
// start or to finish, or PID 1 did not take the message. This measures all three at once:
//
// - **Sent**: the `.sh` puts a wrapper in front of `systemd-notify` that appends when each helper
//   started and finished, and its exit status, to the service's state directory. A non-zero exit is
//   a barrier that timed out (systemd 246 made the helper wait for PID 1 to process its message).
// - **Received**: `WatchdogTimestampMonotonic`, read every second, moves when PID 1 accepts a ping.
//   PID 1 logs at debug for the run, so a message it cannot attribute is in the journal too.
// - **The event loop**: the core's own `/metrics` loop-lag maximum, which resets at each scrape,
//   and the probe's scheduler lag from its health report, every five seconds.
//
// Stages hold a CPU hog of `factor × nproc` busy loops in its own unit for a while; factor 0 is
// the baseline. The machine's pressure stall figures are recorded every second, because a load
// average counts tasks waiting on disk as well as on a CPU, and the fix depends on which it was.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, createReadStream, openSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const API = 'http://127.0.0.1:8080/api/v1';
const TOKEN = process.env.MS_TOKEN;
if (!TOKEN) {
  console.error('MS_TOKEN is not set');
  process.exit(2);
}
/** `factor:seconds` pairs. The default is the baseline, then one, three and six hogs per CPU. */
const STAGES = (process.env.MS_HOG_STAGES ?? '0:180,1:240,3:300,6:300').split(',').map((pair) => {
  const [factor, seconds] = pair.split(':').map(Number);
  return { factor, seconds };
});
const UNITS = ['ms-core', 'ms-probe'];
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
    // Microseconds on CLOCK_MONOTONIC, which `process.hrtime` also reads; 0 before the first ping.
    pingUs: Number(fields.WatchdogTimestampMonotonic),
  };
}

/** How long ago PID 1 last accepted a ping, in ms. systemd kills at `WatchdogSec`, 30 s. */
function pingAgeMs(pingUs) {
  if (pingUs === 0) return null;
  return Math.round((Number(process.hrtime.bigint() / 1_000n) - pingUs) / 1_000);
}

/** `some avg10` and `full avg10` for CPU, memory and IO: the share of time tasks were stalled. */
function pressure() {
  const read = (resource) => {
    const text = readFileSync(`/proc/pressure/${resource}`, 'utf8');
    const some = Number(/^some .*?avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
    const full = Number(/^full .*?avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
    return [some, full];
  };
  return { cpu: read('cpu'), memory: read('memory'), io: read('io') };
}

const loadavg = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
const cpus = Number(sh('nproc', []));

async function coreLoopLag() {
  try {
    const response = await fetch('http://127.0.0.1:8080/metrics', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await response.text();
    const gauge = (name) => Number(new RegExp(`^${name} ([\\d.e+-]+)`, 'm').exec(text)?.[1] ?? NaN);
    return {
      maxMs: Math.round(gauge('ms_core_nodejs_eventloop_lag_max_seconds') * 1_000),
      p99Ms: Math.round(gauge('ms_core_nodejs_eventloop_lag_p99_seconds') * 1_000),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

emit({
  kind: 'conditions',
  cpus,
  loadavg: loadavg(),
  systemd: sh('systemctl', ['--version']).split('\n')[0],
});

// ---- Set up: approve the probe, so it reports its scheduler lag. ----
const root = await api('GET', '/objects/root');
const approved = (await api('GET', '/probes?status=approved')).items[0] ?? null;
let probeObjectId;
if (approved !== null && approved.objectId !== null) {
  probeObjectId = approved.objectId;
} else {
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
async function probeLag() {
  try {
    const health = await api('GET', `/probes/${probeObjectId}/health`);
    return {
      connected: health.channels.connected,
      schedulerLagMs: health.channels.schedulerLag ?? null,
      heartbeatAge: health.channels.heartbeatAge ?? null,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

// PID 1 at debug for the run: every notification it takes, and every one it cannot attribute.
tryCtl(['reset-failed', ...UNITS]);
sh('systemd-analyze', ['log-level', 'debug']);
emit({ kind: 'setup', probeObjectId, pid1LogLevel: 'debug' });

// ---- The stages. ----
const HOG = 'ms-hog';
function hog(factor) {
  tryCtl(['stop', HOG]);
  tryCtl(['reset-failed', HOG]);
  if (factor === 0) return;
  const loops = factor * cpus;
  // Its own unit, so it is outside both services' cgroups and stops with one command. Plain
  // busy loops: the question is CPU contention, and a hog that also touched memory or disk would
  // answer a different one.
  sh('systemd-run', [
    `--unit=${HOG}`,
    '--collect',
    '--quiet',
    'bash',
    '-c',
    `for i in $(seq ${String(loops)}); do (while :; do :; done) & done; wait`,
  ]);
}

const kills = [];
const previous = Object.fromEntries(UNITS.map((name) => [name, unit(name)]));
for (const { factor, seconds } of STAGES) {
  hog(factor);
  emit({ kind: 'stage', factor, loops: factor * cpus, seconds });
  const until = Date.now() + seconds * 1_000;
  let tick = 0;
  while (Date.now() < until) {
    const now = Object.fromEntries(UNITS.map((name) => [name, unit(name)]));
    for (const name of UNITS) {
      if (
        now[name].restarts !== previous[name].restarts ||
        now[name].result !== previous[name].result
      ) {
        const event = { kind: 'unit-event', factor, unit: name, ...now[name] };
        kills.push(event);
        emit(event);
      }
    }
    const line = {
      kind: 'tick',
      factor,
      load: loadavg(),
      psi: pressure(),
      core: {
        pingAgeMs: pingAgeMs(now['ms-core'].pingUs),
        state: now['ms-core'].state,
        restarts: now['ms-core'].restarts,
      },
      probe: {
        pingAgeMs: pingAgeMs(now['ms-probe'].pingUs),
        state: now['ms-probe'].state,
        restarts: now['ms-probe'].restarts,
      },
    };
    if (tick % 5 === 0) {
      const [core, probe] = await Promise.all([coreLoopLag(), probeLag()]);
      line.coreLoop = core;
      line.probeLoop = probe;
    }
    emit(line);
    Object.assign(previous, now);
    tick += 1;
    await sleep(1_000);
  }
}
hog(0);
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
    // `<started> <finished> <exit> <arguments...>`, wall-clock seconds.
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
// **To a file, then read line by line.** PID 1 at debug for a whole run writes far more than
// `execFileSync`'s 1 MiB buffer, and the first full run lost every received-side record to ENOBUFS
// at the very end, after all its stages had been measured
// (`docs/findings/2026-09-29-watchdog-under-load.md`).
const PID1_LOG = '/tmp/watchdog-under-load-pid1.log';
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
if (read.status !== 0) {
  emit({ kind: 'pid1-error', status: read.status, stderr: String(read.stderr).trim() });
}
for await (const entry of createInterface({ input: createReadStream(PID1_LOG) })) {
  const match = /^(\d+\.\d+) \S+ [^:]+: (.*)$/.exec(entry);
  if (match === null) continue;
  const message = match[2];
  if (!/ms-(core|probe)|notify|[Ww]atchdog/.test(message)) continue;
  if (
    !/[Nn]otif|[Ww]atchdog|Cannot find unit|Main process exited|Failed with result|Scheduled restart/.test(
      message,
    )
  )
    continue;
  emit({ kind: 'pid1', at: Math.round((Number(match[1]) * 1_000 - start) / 100) / 10, message });
}
emit({ kind: 'summary', stages: STAGES, kills: kills.length });
