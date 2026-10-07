import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { TestSshServer } from '@ms/simulators';
import { resultSink } from '../src/result-sink.js';
import { CheckPool } from '../src/runner/pool.js';
import type { ResultMeta } from '../src/runner/types.js';
import { ResultSpool } from '../src/spool/spool.js';
import { within } from './support/probe-process.js';

/**
 * A device that resets the connection while a check's command runs, seen from the probe
 * (`P-279`, following `P-259`).
 *
 * `P-259` made `SshSession.exec` fail such a command in the `exec` phase instead of resolving it
 * with half its output, and tested that in `@ms/sensors`. What it left was the path a real probe
 * takes: the check in a pool worker, the worker posting the failure across the thread, the pool
 * making a `CheckResult` of it, and the result sink handing that to the spool the core is fed
 * from. Here those are the shipped ones — the pool with its default registry, as `main.ts` builds
 * it, the real sink and a real spool on disk — and only the SSH device is the simulator.
 *
 * **What is stored is what an operator reads**, so that is what is asserted: the exec phase's own
 * sentence (the connection lost *while running* the command, which no connect, authentication or
 * host-key failure says), the host, the command and the socket error. The `SshError`'s `phase`
 * field does not cross the worker — no error's does, since a `CheckResult` carries a message — so
 * the sentence is where the phase is.
 */

const silent = pino({ level: 'silent' });
/** What `ssh.load` runs, as `ssh-sensors.test.ts` in `@ms/sensors` has it. */
const LOAD_COMMAND =
  '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)';

let server: TestSshServer;
let dir: string;
const pools: CheckPool[] = [];
const spools: ResultSpool[] = [];

before(async () => {
  server = await TestSshServer.start();
  dir = await mkdtemp(join(tmpdir(), 'ms-ssh-reset-'));
});

after(async () => {
  await Promise.all(pools.map((pool) => within(30_000, 'the pool to stop', pool.stop())));
  await Promise.all(spools.map((spool) => spool.close()));
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Until `predicate` holds, polled, bounded; the polling stops when the wait gives up. */
async function until(ms: number, what: string, predicate: () => boolean): Promise<void> {
  const poll = { stopped: false };
  try {
    await within(
      ms,
      what,
      (async () => {
        while (!poll.stopped && !predicate()) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
    );
  } finally {
    poll.stopped = true;
  }
}

const check = (sensorId: number, sensorType: string, params: Record<string, unknown> = {}) => ({
  sensorId,
  sensorType,
  target: { host: server.host, ipVersion: 'v4' as const },
  params: { port: server.port, connectTimeoutMs: 10_000, commandTimeoutMs: 10_000, ...params },
  credentials: {
    ssh: { username: 'monitor', password: 'monitor', hostKeyPolicy: 'accept-any' },
  },
  timeoutMs: 30_000,
});

describe('an SSH device that resets the connection mid-command, through a probe', () => {
  it('stores a failure in the exec phase, and the probe goes on checking', async () => {
    server.reset();
    const spool = await ResultSpool.open({ dir, maxBytes: 1_000_000, logger: silent });
    spools.push(spool);
    const completed: number[] = [];
    let woken = 0;
    const sink = resultSink({
      logger: silent,
      spool,
      drain: {
        wake: () => {
          woken += 1;
        },
      },
      checkFlow: { completed: (sensorId) => completed.push(sensorId) },
    });
    const seen: { result: CheckResult; meta: ResultMeta }[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      minSize: 1,
      onResult: (result, meta) => {
        seen.push({ result, meta });
        sink(result, meta);
      },
    });
    pools.push(pool);
    await within(60_000, 'the pool to start', pool.start());

    const settle = async (count: number, what: string): Promise<void> => {
      await until(30_000, what, () => seen.length >= count);
    };

    // 1. The load line, then a reset before the processor count and before any exit status:
    // `ssh.load` used to report this as a reading with no processor count (`P-259`).
    server.answer(LOAD_COMMAND, {
      stdout: '0.50 0.40 0.30 1/123 4567\n',
      reset: 'before-exit-status',
    });
    assert.equal(pool.submit(check(1, 'ssh.load')), 'accepted');
    await settle(1, 'the reset ssh.load check to settle');

    // 2. Exit status 0 first, then half the output, then a reset: `ssh.script` used to read the
    // first of two lines as a success with a channel missing.
    server.answer('./check.sh', { code: 0, stdout: 'queue:12\n', reset: 'after-exit-status' });
    assert.equal(
      pool.submit(
        check(2, 'ssh.script', {
          command: './check.sh',
          channels: [{ key: 'queue' }, { key: 'temperature' }],
        }),
      ),
      'accepted',
    );
    await settle(2, 'the reset ssh.script check to settle');

    // 3. The same device answering whole: the probe is still checking, on the same worker.
    server.answer(LOAD_COMMAND, { stdout: '0.50 0.40 0.30 1/123 4567\n4\n' });
    assert.equal(pool.submit(check(3, 'ssh.load')), 'accepted');
    await settle(3, 'the next ssh.load check to settle');

    // What the core will be sent: everything the sink handed the spool, read back off disk.
    await until(10_000, 'three results on the spool', () => spool.stats().pending === 3);
    const stored = await within(10_000, 'the spool to be read', spool.peek(10));
    assert.deepEqual(
      stored.map((one) => [one.sensorId, one.outcome]),
      [
        [1, 'error'],
        [2, 'error'],
        [3, 'ok'],
      ],
    );

    const [load, script, next] = stored;
    assert.ok(load !== undefined && script !== undefined && next !== undefined);
    assert.ok(
      load.message.startsWith(
        `the connection to 127.0.0.1 was lost while running ${LOAD_COMMAND}, before the ` +
          'command reported an exit status',
      ),
      load.message,
    );
    assert.match(load.message, /ECONNRESET/, 'the underlying error, named');
    assert.deepEqual(load.channels, [], 'a failed check records no values, not half of them');
    assert.ok(
      script.message.startsWith(
        'the connection to 127.0.0.1 was lost while running ./check.sh, after the command ' +
          'reported an exit status but before the server finished its output',
      ),
      script.message,
    );
    assert.deepEqual(script.channels, []);
    assert.equal(
      next.channels.find((channel) => channel.key === 'processors')?.value,
      4,
      next.message,
    );

    // The pool's view of the two failures: the check's own, in its own worker — not a crash,
    // not a timeout, not a worker started again.
    assert.deepEqual(
      seen.map(({ meta }) => meta.phase),
      ['execute', 'execute', 'execute'],
    );
    const workers = new Set(seen.map(({ meta }) => meta.workerId));
    assert.equal(workers.size, 1, 'one worker ran all three: the reset took none down');

    // The probe is healthy: nothing here would move Probe Health, and checks keep completing.
    const stats = pool.stats();
    assert.equal(stats.workerCrashes, 0);
    assert.equal(stats.startupFailed, 0);
    assert.equal(stats.timedOut, 0);
    assert.equal(stats.disabled, false);
    assert.equal(stats.failed, 2);
    assert.equal(stats.completed, 1);
    assert.equal(stats.busy, 0, 'no check left in hand');
    assert.deepEqual(completed, [1, 2, 3], 'each failure counted as a completion (`P-83`)');
    assert.deepEqual(sink.stats(), { abandoned: 0, unspooled: 0 });
    assert.equal(spool.stats().unwritten, 0);
    assert.equal(woken, 3, 'the drain was woken for every result, the failures included');
    // Each reset cost its connection, and the next check opened another rather than using the
    // dead one: three connections, three sessions opened, and none held open but the last.
    assert.equal(server.connections, 3);
    const sessions = stats.sessions;
    assert.ok(sessions !== undefined, 'the worker reported its session pools');
    assert.equal(sessions.opened, 3);
    assert.equal(sessions.open, 1);
  });
});
