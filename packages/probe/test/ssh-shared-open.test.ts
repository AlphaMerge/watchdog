import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { BUILT_IN_SENSOR_TYPES } from '@ms/sensors';
import { TestSshServer } from '@ms/simulators';
import { CheckPool } from '../src/runner/pool.js';
import { pollWithin } from './support/within.js';

/**
 * Whether two SSH checks in a running probe can share one connection being opened (`A-65`).
 *
 * They cannot, and this is the test that settled it. The SSH pool lets callers that arrive
 * while a connection is being opened wait for that one, and they then share the first caller's
 * target-policy lookup and its `AbortSignal`: the first being cancelled during the lookup would
 * fail the rest. One review traced that; another found nothing in a probe that could reach it.
 *
 * What decides it is how SSH checks are run. The pool is a module singleton, so there is one a
 * worker thread; a worker is given one check at a time, and its slot is held until it answers;
 * and no SSH type asks for a process of its own, where it would be one check a process anyway.
 * So the second sensor on a device always finds the connection the first one left, and never a
 * connection half open. The shipped registry, pool and sensors run here against the SSH
 * simulator, wrapped only to count (`support/ssh-overlap-registry.ts`).
 *
 * **If this fails, the join is reachable** and `SshSessionPool.acquire` has to stop running a
 * shared open under one caller's signal; its comment says what to do.
 */

const silent = pino({ level: 'silent' });
const REGISTRY = join(import.meta.dirname, 'support', 'ssh-overlap-registry.js');
/** What `ssh.load` runs, as `ssh-sensors.test.ts` in `@ms/sensors` has it. */
const LOAD_COMMAND =
  '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)';
const LOAD = '2.00 1.50 1.00 1/234 5678\n8\n';

let server: TestSshServer;
const pools: CheckPool[] = [];

before(async () => {
  server = await TestSshServer.start();
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
  await server.stop();
});

function until(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  return pollWithin(timeoutMs, what, predicate, 10);
}

const sshLoad = (sensorId: number) => ({
  sensorId,
  sensorType: 'ssh.load',
  target: { host: server.host, ipVersion: 'v4' as const },
  params: { port: server.port, connectTimeoutMs: 10_000, commandTimeoutMs: 10_000 },
  credentials: {
    ssh: { username: 'monitor', password: 'monitor', hostKeyPolicy: 'accept-any' },
  },
  timeoutMs: 30_000,
});

const valueOf = (result: CheckResult | undefined, key: string): number | undefined =>
  result?.channels.find((channel) => channel.key === key)?.value;

describe('SSH checks in one worker', () => {
  it('never join a connection being opened: a worker has one check in hand at a time', async () => {
    server.reset();
    server.answer(LOAD_COMMAND, { stdout: LOAD });
    const seen: CheckResult[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      minSize: 1,
      registryModule: REGISTRY,
      onResult: (result) => seen.push(result),
    });
    pools.push(pool);
    await pool.start();

    // Six sensors on one device, all due on the same tick: the case the join was written for.
    const before = server.connections;
    for (let id = 1; id <= 6; id += 1) assert.equal(pool.submit(sshLoad(id)), 'accepted');
    await until(() => seen.length === 6, 'six SSH checks');
    for (const result of seen) assert.equal(result.outcome, 'ok', result.message);

    pool.submit({
      sensorId: 99,
      sensorType: 'test.ssh-pool',
      target: { host: server.host, ipVersion: 'v4' as const },
      params: {},
      timeoutMs: 30_000,
    });
    await until(() => seen.length === 7, 'the worker’s pool counters');
    const counters = seen[6];

    assert.equal(valueOf(counters, 'peak'), 1, 'the worker never had two checks in hand');
    assert.equal(valueOf(counters, 'acquired'), 6);
    assert.equal(valueOf(counters, 'joined'), 0, 'so nothing waited on another check’s open');
    assert.equal(valueOf(counters, 'opened'), 1);
    assert.equal(valueOf(counters, 'reused'), 5, 'each later sensor found the connection held');
    assert.equal(server.connections - before, 1);
  });

  it('no SSH sensor type asks for a process of its own', () => {
    // One check a process would make a join impossible there too, and would also mean a
    // handshake a scan. Either way it would change what the comment on the pool says.
    const ssh = BUILT_IN_SENSOR_TYPES.filter((type) => type.id.startsWith('ssh.'));
    assert.deepEqual(ssh.map((type) => type.id).sort(), [
      'ssh.diskfree',
      'ssh.load',
      'ssh.meminfo',
      'ssh.script',
    ]);
    for (const type of ssh) assert.equal(type.isolation, undefined, type.id);
  });
});
