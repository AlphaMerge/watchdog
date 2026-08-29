#!/usr/bin/env node
// Provision the soak tree (TASKS.md H-01).
//
//     node scripts/soak/provision.mjs [--sensors 5000] [--api http://127.0.0.1:8080/api/v1]
//     node scripts/soak/provision.mjs --remove
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
import { argv, env, exit, stdout } from 'node:process';

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
  const tree = await call('GET', `/objects/${String(existing.id)}/tree`);
  const descendants = (tree.items ?? []).length - 1;
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
