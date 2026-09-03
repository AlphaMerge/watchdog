#!/usr/bin/env node
// Sample the installation under soak, one JSON object per line (TASKS.md H-01).
//
//     node scripts/soak/sample.mjs --out docs/findings/soak-<date>.jsonl [--hours 24]
//
// **The instrument is the system's own health sensors.** Core Health and Probe Health already
// publish resident memory, heap, scheduler lag, pool usage, queue depths and rollup lag, because
// CLAUDE.md requires every subsystem with a queue or a pool to report into one of them. Bolting a
// second, private instrument onto the side would measure something nobody watches in production;
// this measures exactly what an operator would be looking at, and a soak that finds the *sensor*
// wrong is as useful a result as one that finds the service wrong.
//
// Written a line at a time and flushed, so a run that dies at hour 19 still has 19 hours of data.
import { appendFileSync, writeFileSync } from 'node:fs';
import { argv, env, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const args = new Map();
for (let at = 2; at < argv.length; at += 1) {
  const flag = argv[at];
  if (!flag.startsWith('--')) continue;
  const next = argv[at + 1];
  if (next === undefined || next.startsWith('--')) args.set(flag.slice(2), 'true');
  else {
    args.set(flag.slice(2), next);
    at += 1;
  }
}

const API = args.get('api') ?? env.MS_API ?? 'http://127.0.0.1:8080/api/v1';
const OUT = args.get('out') ?? 'soak.jsonl';
const HOURS = Number(args.get('hours') ?? 24);
const EVERY_MS = Number(args.get('every') ?? 60_000);

const headers = {};
if (env.MS_TOKEN !== undefined) headers.authorization = `Bearer ${env.MS_TOKEN}`;

async function get(path) {
  const response = await fetch(`${API}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} → ${String(response.status)}`);
  return await response.json();
}

/** Values of one health sensor, as `{channelKey: value}`. */
async function healthOf(sensorId) {
  const values = await get(`/sensors/${String(sensorId)}/values`);
  const out = {};
  for (const channel of values.channels ?? []) out[channel.key] = channel.value;
  return out;
}

/**
 * The two health sensors, found by type rather than by id.
 *
 * A soak pinned to ids from a previous run would silently sample the wrong thing on a rebuilt
 * database, and "no memory growth" measured on a sensor that stopped reporting is the most
 * comfortable wrong answer available.
 */
async function findHealthSensors() {
  const found = { core: undefined, probe: undefined };
  let cursor;
  do {
    const page = await get(
      `/objects?kind=sensor&limit=200${cursor === undefined ? '' : `&cursor=${cursor}`}`,
    );
    for (const sensor of page.items ?? []) {
      if (sensor.sensorType === 'ms.core.health') found.core = sensor.id;
      if (sensor.sensorType === 'ms.probe.health') found.probe ??= sensor.id;
    }
    cursor = page.nextCursor;
  } while (
    cursor !== undefined &&
    cursor !== null &&
    (found.core === undefined || found.probe === undefined)
  );
  return found;
}

const health = await findHealthSensors();
if (health.core === undefined) throw new Error('no ms.core.health sensor — is the core running?');
if (health.probe === undefined)
  throw new Error('no ms.probe.health sensor — is a probe connected?');

const started = Date.now();
const until = started + HOURS * 3_600_000;
writeFileSync(
  OUT,
  `${JSON.stringify({
    kind: 'meta',
    startedAt: new Date(started).toISOString(),
    hours: HOURS,
    everyMs: EVERY_MS,
    coreHealthSensor: health.core,
    probeHealthSensor: health.probe,
    api: API,
  })}\n`,
);
stdout.write(`sampling every ${String(EVERY_MS / 1000)}s for ${String(HOURS)}h into ${OUT}\n`);

let taken = 0;
while (Date.now() < until) {
  const at = new Date().toISOString();
  try {
    const [core, probe] = await Promise.all([healthOf(health.core), healthOf(health.probe)]);
    appendFileSync(
      OUT,
      `${JSON.stringify({
        kind: 'sample',
        at,
        elapsedS: Math.round((Date.now() - started) / 1000),
        core,
        probe,
      })}\n`,
    );
    taken += 1;
    if (taken % 10 === 0) {
      stdout.write(
        `  ${String(taken)} samples · core ${String(core.memory)}MB · lag ${String(probe.schedulerLag)}ms\n`,
      );
    }
  } catch (cause) {
    // **Recorded, not fatal.** A soak that stopped at the first hiccup would never reach hour 24,
    // and an unreachable core for one minute is itself a finding — the gap is in the file.
    appendFileSync(OUT, `${JSON.stringify({ kind: 'error', at, error: String(cause) })}\n`);
  }
  await sleep(EVERY_MS);
}

appendFileSync(
  OUT,
  `${JSON.stringify({ kind: 'end', at: new Date().toISOString(), samples: taken })}\n`,
);
stdout.write(`done: ${String(taken)} samples in ${OUT}\n`);
