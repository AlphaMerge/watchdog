#!/usr/bin/env node
// Provision the soak tree (TASKS.md H-01).
//
//     node scripts/soak/provision.mjs [--sensors 5000] [--api http://127.0.0.1:8080/api/v1]
//     node scripts/soak/provision.mjs --remove [--yes]
//
// Builds `Soak/` under the local probe: devices carrying `port.tcp` sensors pointed at a port
// that is already listening on the probe's own host.
//
// **`port.tcp` rather than a sleeping stub, and rather than ICMP.** The thing under test is the
// whole pipeline — wheel, worker pool, result, ingestion, storage, rollup — so a check that
// short-circuits any of it measures nothing. ICMP would exercise all of it too, and would also
// fork the system `ping` eighty-three times a second, which measures process creation rather than
// this system. A TCP connect to a local listener is the cheapest check that is still a real one.
//
// Created through `POST /objects/tree` (`P-19`), which is all-or-nothing: a half-provisioned soak
// tree would quietly change what the numbers mean.
import { createInterface } from 'node:readline/promises';
import { argv, env, exit, stdin, stdout } from 'node:process';

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
const SENSORS = Number(args.get('sensors') ?? 5000);
const PER_DEVICE = Number(args.get('per-device') ?? 20);
const TARGET_PORT = Number(args.get('port') ?? 8080);
const ROOT_NAME = 'Soak';

const auth = env.MS_TOKEN === undefined ? {} : { authorization: `Bearer ${env.MS_TOKEN}` };

async function call(method, path, body) {
  // Content-type only when there is content: Fastify rejects a bodyless request that claims to
  // carry JSON, which is right of it and is how the DELETE below first failed.
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${String(response.status)} ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}

/** The soak group, if a previous run left one. */
async function findRoot() {
  const listing = await call('GET', `/objects?kind=group&limit=200`);
  return (listing.items ?? []).find((one) => one.name === ROOT_NAME);
}

/**
 * Whether to go ahead with a delete this script cannot undo.
 *
 * `--yes` for a script or a CI job, a typed `y` for a person, and a **refusal** when neither is
 * available: a non-interactive run with no flag is somebody who has not been asked, and deleting
 * on their behalf is the failure mode this exists to prevent.
 */
async function confirmed() {
  if (args.has('yes') || env.MS_ASSUME_YES === '1') return true;
  if (!stdin.isTTY) {
    stdout.write('refusing: nothing to ask on, and no --yes. Pass --yes if you mean it.\n');
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('remove it? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } catch {
    // Ctrl+D rejects the question rather than returning an empty answer, and an unhandled
    // rejection here is a stack trace where the operator expected a decision. **EOF is a no**,
    // which is the same reading every other answer that is not `y` gets.
    stdout.write('\n');
    return false;
  } finally {
    rl.close();
  }
}

if (args.has('remove')) {
  const existing = await findRoot();
  if (existing === undefined) {
    stdout.write('no soak tree to remove\n');
    exit(0);
  }
  // **The API makes you say how big the subtree is before it will delete one**, and defaults to
  // refusing anything that is not a leaf. Counting first is the point of that: a soak tree that
  // had grown or shrunk since this script last looked is a tree somebody should look at, not one
  // to delete on a wildcard.
  //
  // **`/counts`, not a page of `/tree`.** `/tree` is paginated and answers `{ items, truncated }`;
  // counting its items gave 999 for a 5,250-object soak tree, so `--teardown` asked to delete a
  // number the core knew was wrong and was refused — every time, for any tree past the page cap,
  // which is every tree this harness makes. The route's own documentation names the mistake:
  // counting a page of `/tree` "gives the right answer for a small installation and a quietly
  // wrong one for a large installation". Here the guard turned quietly-wrong into loudly-refused,
  // which is the guard working; the count was still wrong (`U-20`).
  const counts = await call('GET', `/objects/${String(existing.id)}/counts`);
  const descendants = Number(counts.objects?.total ?? 1) - 1;

  // **Shown and confirmed, because on a development box this tree is not scratch** (`P-188`).
  // The 5,000-sensor load a `dev/` stack has been carrying for weeks *is* a soak tree: this
  // script names its root `Soak`, finds an existing one and leaves it alone, so the fixture
  // somebody works against every day and the tree a harness made are the same object.
  //
  // Until `U-20` this could not delete it — the count came from a capped page of `/tree`, so the
  // core refused every time. That refusal was the only thing between an idle `--teardown` and an
  // afternoon rebuilding the fixture, and it was refusing for the wrong reason, so correcting the
  // count removed the protection as a side effect. Nobody chose that; this is choosing.
  const shape = counts.objects ?? {};
  const breakdown = ['probe', 'group', 'device', 'sensor']
    .map((kind) => ({ kind, n: Number(shape[kind] ?? 0) }))
    // Kinds it does not hold are not information: a list ending "0 probes" reads as a thing to
    // check rather than as nothing to worry about.
    .filter((one) => one.n > 0)
    .map((one) => `${String(one.n)} ${one.kind}${one.n === 1 ? '' : 's'}`)
    .join(', ');
  stdout.write(
    `about to remove object ${String(existing.id)} (${String(existing.name)}) ` +
      `and everything under it:\n` +
      `  ${String(descendants)} descendants — ${breakdown}\n`,
  );

  if (!(await confirmed())) {
    stdout.write('left alone\n');
    exit(1);
  }

  await call(
    'DELETE',
    `/objects/${String(existing.id)}?expectedDescendants=${String(descendants)}`,
  );
  stdout.write(
    `removed the soak tree (object ${String(existing.id)}, ${String(descendants)} descendants)\n`,
  );
  exit(0);
}

const already = await findRoot();
if (already !== undefined) {
  stdout.write(`the soak tree already exists as object ${String(already.id)}; leaving it alone\n`);
  stdout.write(`${String(already.id)}\n`);
  exit(0);
}

// The probe object the local probe owns. Sensors must hang beneath it or nothing scans them.
const probes = await call('GET', '/probes?status=approved');
const local = (probes.items ?? []).find(
  (one) => one.objectId !== null && one.objectId !== undefined,
);
if (local === undefined) throw new Error('no approved probe; approve one before soaking');

const group = await call('POST', '/objects', {
  kind: 'group',
  parentId: local.objectId,
  name: ROOT_NAME,
  comments: 'H-01 soak load. Safe to delete.',
});

const deviceCount = Math.ceil(SENSORS / PER_DEVICE);
stdout.write(
  `provisioning ${String(SENSORS)} sensors across ${String(deviceCount)} devices under object ${String(group.id)}\n`,
);

// **In batches, because the endpoint is bounded at 5,000 nodes and the tree lock is held for the
// whole request.** A soak that provisioned in one 5,250-node call would be measuring the
// provisioning path, which `P-19` already measured.
const BATCH_DEVICES = 50;
let made = 0;
for (let first = 0; first < deviceCount; first += BATCH_DEVICES) {
  const nodes = [];
  const last = Math.min(first + BATCH_DEVICES, deviceCount);
  for (let device = first; device < last; device += 1) {
    const ref = `d${String(device)}`;
    nodes.push({ ref, kind: 'device', name: `soak-${String(device)}`, host: '127.0.0.1' });
    const here = Math.min(PER_DEVICE, SENSORS - device * PER_DEVICE);
    for (let sensor = 0; sensor < here; sensor += 1) {
      nodes.push({
        parentRef: ref,
        kind: 'sensor',
        name: `tcp-${String(sensor)}`,
        sensorType: 'port.tcp',
        params: { port: TARGET_PORT, timeoutMs: 5000 },
      });
      made += 1;
    }
  }
  await call('POST', '/objects/tree', { parentId: group.id, nodes });
  stdout.write(`  ${String(made)}/${String(SENSORS)}\n`);
}

stdout.write(`done: ${String(made)} sensors under object ${String(group.id)}\n`);
stdout.write(`${String(group.id)}\n`);
