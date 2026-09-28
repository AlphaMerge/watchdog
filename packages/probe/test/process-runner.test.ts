import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { ProcessRunner } from '../src/runner/process-runner.js';
import type { ResultMeta } from '../src/runner/types.js';

/**
 * The child-process runner (`P-03`), against checks that misbehave on purpose.
 *
 * The case that justifies the whole thing is `test.abort`: a `SIGABRT` is what a native module
 * segfaulting looks like from outside, a worker thread cannot survive one, and it would take the
 * probe and every sensor on it down. Here it is one dead process and one Down sensor.
 */

const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/process-runner.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const runners: ProcessRunner[] = [];

function runnerOf(options: { maxConcurrent?: number; queueMaxLength?: number } = {}): {
  runner: ProcessRunner;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const runner = new ProcessRunner({
    logger: silent,
    registryModule: FIXTURES,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.queueMaxLength === undefined ? {} : { queueMaxLength: options.queueMaxLength }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  runners.push(runner);
  return { runner, seen };
}

async function until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const request = (sensorId: number, sensorType: string, extra: Record<string, unknown> = {}) => ({
  sensorId,
  sensorType,
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: extra,
  timeoutMs: Number(extra['timeoutMs'] ?? 10_000),
});

after(async () => {
  await Promise.all(runners.map((runner) => runner.stop()));
});

describe('process runner', () => {
  it('runs a check in a process of its own and reports it like any other', async () => {
    const { runner, seen } = runnerOf();
    assert.equal(runner.submit(request(1, 'test.ok')), 'accepted');
    await until(() => seen.length === 1, 'the check to finish');

    const { result, meta } = seen[0] ?? {};
    assert.equal(result?.outcome, 'ok');
    assert.equal(result.message, 'all well');
    assert.deepEqual(result.channels, [{ key: 'value', value: 42, name: 'Value', unit: 'ms' }]);
    assert.equal(meta?.phase, 'execute');
    // -1 rather than absent: Probe Health reads one shape for both runners, and a check that ran
    // in a process genuinely has no worker.
    assert.equal(meta.workerId, -1);
  });

  it('survives a hard crash that would take a worker thread down with the probe', async () => {
    // The reason P-03 exists. SIGABRT is what a segfaulting native module looks like from the
    // outside; a worker cannot survive one and neither can the process hosting it.
    const { runner, seen } = runnerOf();
    runner.submit(request(2, 'test.abort'));
    await until(() => seen.length === 1, 'the crash to be reported');

    assert.equal(seen[0]?.result.outcome, 'error');
    assert.match(seen[0].result.message, /ended without answering.*native crash/s);
    assert.equal(seen[0].meta.phase, 'worker-crash');
    assert.equal(runner.stats().crashed, 1);

    // And the runner is still working, which is the whole point.
    runner.submit(request(3, 'test.ok'));
    await until(() => seen.length === 2, 'the next check');
    assert.equal(seen[1]?.result.outcome, 'ok');
  });

  it('reports a process that exited without answering, with its code', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(4, 'test.crash'));
    await until(() => seen.length === 1, 'the exit to be reported');
    assert.match(seen[0]?.result.message ?? '', /exited with code 7/);
  });

  it('records no channel values for a failed check', async () => {
    // A Down sensor records no channel values: the gap is the data (CLAUDE.md).
    const { runner, seen } = runnerOf();
    runner.submit(request(5, 'test.throw'));
    await until(() => seen.length === 1, 'the failure');
    assert.equal(seen[0]?.result.outcome, 'error');
    assert.equal(seen[0].result.message, 'the check failed on purpose');
    assert.deepEqual(seen[0].result.channels, []);
  });

  it('lets a check that honours its signal report its own diagnosis', async () => {
    // The child is given the deadline too, so a well-behaved check says where it got to rather
    // than being killed with nothing to say.
    const { runner, seen } = runnerOf();
    runner.submit(request(6, 'test.slow', { delayMs: 30_000, timeoutMs: 800 }));
    await until(() => seen.length === 1, 'the timeout', 20_000);
    assert.equal(seen[0]?.result.outcome, 'error');
    assert.equal(seen[0].meta.phase, 'aborted');
    assert.match(seen[0].result.message, /exceeded its timeout/);
    assert.equal(runner.stats().timedOut, 1);
  });

  it('kills a check that ignores its signal, and says so', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(7, 'test.stuck', { timeoutMs: 500 }));
    await until(() => seen.length === 1, 'the kill', 20_000);
    assert.equal(seen[0]?.meta.phase, 'timeout');
    assert.match(seen[0].result.message, /did not finish within 500 ms and its process was/);
  });

  it('reports a check whose event loop simply emptied, which a worker never does', async () => {
    // A Node process with nothing left to do exits, so an unsettled promise holding no handle is
    // not a hang here at all — it is an exit with no answer. Worth its own test because the same
    // check in a worker thread hangs instead, and the two produce different results on purpose.
    const { runner, seen } = runnerOf();
    runner.submit(request(70, 'test.hang', { timeoutMs: 5_000 }));
    await until(() => seen.length === 1, 'the early exit', 20_000);
    assert.equal(seen[0]?.meta.phase, 'worker-crash');
    assert.match(seen[0].result.message, /ended without answering.*exited with code/s);
  });

  it('reports an unregistered type as a configuration error, not a failing check', async () => {
    // A missing type fails identically for ever, and counting it with genuine failures buries a
    // configuration error in a rate that looks like flapping.
    const { runner, seen } = runnerOf();
    runner.submit(request(8, 'test.nonexistent'));
    await until(() => seen.length === 1, 'the unknown type');
    assert.equal(seen[0]?.meta.phase, 'unknown-type');
  });

  it('finds its result past whatever a library printed', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(9, 'test.print'));
    await until(() => seen.length === 1, 'the check');
    assert.equal(seen[0]?.result.outcome, 'ok');
    assert.equal(seen[0].result.message, 'printed anyway');
  });

  it('takes the last marked line, not the first', async () => {
    // A check that runs somebody's script can end up echoing text it does not control. Reading
    // the marker from the front would let that text be the result.
    const { runner, seen } = runnerOf();
    runner.submit(request(90, 'test.spoof'));
    await until(() => seen.length === 1, 'the check');
    assert.equal(seen[0]?.result.message, 'the real answer');
    assert.deepEqual(seen[0].result.channels, [{ key: 'value', value: 2 }]);
  });

  it('hands the check its credentials without putting them in the command line', async () => {
    // argv is world-readable through `ps`. A credential this system encrypts at rest and then
    // publishes to every local user would be a credential it did not protect at all.
    const { runner, seen } = runnerOf();
    runner.submit({
      ...request(10, 'test.echo', { a: 1, b: 2 }),
      credentials: { test: { username: 'ops', password: 'sekrit-in-a-process' } },
    });
    await until(() => seen.length === 1, 'the echo');

    const echoed = JSON.parse(seen[0]?.result.message ?? '{}') as {
      host: string;
      kinds: string[];
      secret: string;
    };
    assert.equal(echoed.host, '192.0.2.1');
    assert.deepEqual(echoed.kinds, ['test']);
    assert.equal(echoed.secret, 'sekrit-in-a-process');
  });

  it('never stacks a sensor on itself', async () => {
    // WORKFLOW.MD §3, the same rule the worker pool follows.
    const { runner, seen } = runnerOf();
    assert.equal(runner.submit(request(11, 'test.slow', { delayMs: 400 })), 'accepted');
    assert.equal(runner.submit(request(11, 'test.slow', { delayMs: 400 })), 'already-running');
    assert.equal(runner.stats().deferred, 1);
    await until(() => seen.length === 1, 'the first check');
    assert.equal(seen.length, 1);
  });

  it('refuses rather than queueing without bound, and counts what it refused', async () => {
    // Backpressure is visible, never silent (CLAUDE.md).
    const { runner, seen } = runnerOf({ maxConcurrent: 1, queueMaxLength: 1 });
    assert.equal(runner.submit(request(20, 'test.slow', { delayMs: 600 })), 'accepted');
    assert.equal(runner.submit(request(21, 'test.slow', { delayMs: 600 })), 'accepted');
    assert.equal(runner.submit(request(22, 'test.ok')), 'queue-full');
    assert.equal(runner.stats().refused, 1);
    await until(() => seen.length === 2, 'the accepted checks');
  });

  it('runs no more processes at once than it was told to', async () => {
    const { runner, seen } = runnerOf({ maxConcurrent: 2 });
    for (let at = 0; at < 6; at += 1)
      runner.submit(request(30 + at, 'test.slow', { delayMs: 250 }));

    let peak = 0;
    while (seen.length < 6) {
      peak = Math.max(peak, runner.stats().running);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(peak <= 2, `it ran ${String(peak)} processes at once with a cap of 2`);
    assert.equal(seen.filter((one) => one.result.outcome === 'ok').length, 6);
  });

  it('measures the wait separately from the run', async () => {
    const { runner, seen } = runnerOf({ maxConcurrent: 1 });
    runner.submit(request(40, 'test.slow', { delayMs: 400 }));
    runner.submit(request(41, 'test.ok'));
    await until(() => seen.length === 2, 'both checks');

    const queued = seen.find((one) => one.result.sensorId === 41);
    assert.ok((queued?.meta.waitMs ?? 0) >= 300, 'the second check waited for the first');
    const stats = runner.stats();
    assert.ok(stats.waitMs.max >= 300);
    assert.equal(stats.completed, 2);
  });

  it('answers every queued check when it stops, rather than emptying the queue', async () => {
    const { runner, seen } = runnerOf({ maxConcurrent: 1 });
    runner.submit(request(51, 'test.slow', { delayMs: 300 }));
    runner.submit(request(52, 'test.ok'));
    assert.equal(runner.stats().queued, 1);

    await runner.stop();
    const phases = Object.fromEntries(seen.map((one) => [one.result.sensorId, one.meta.phase]));
    assert.deepEqual(phases, { 51: 'execute', 52: 'pool-stopped' });
    assert.equal(runner.stats().queued, 0);
  });

  it('stops waiting for a running check at the drain window, and counts it', async () => {
    // **`P-227`.** `stop` waited for the slowest check's own timeout, 30 s by default, inside a
    // 20 s service budget. A stop that arrived while a script hung ran the budget out here, the
    // pool's drain and the spool's close never ran, and the probe exited 1.
    const { runner, seen } = runnerOf();
    runner.submit(request(60, 'test.slow', { delayMs: 60_000, timeoutMs: 90_000 }));
    await until(() => runner.stats().running === 1, 'the check to start');

    const startedAt = performance.now();
    await runner.stop({ drainMs: 200 });
    const tookMs = performance.now() - startedAt;
    // Under half the check's minute, so no load makes waiting it out look like the window.
    assert.ok(tookMs < 30_000, `stop took ${String(Math.round(tookMs))} ms with a 200 ms window`);

    assert.deepEqual(
      seen.map((one) => [one.result.sensorId, one.meta.phase]),
      [[60, 'pool-stopped']],
      'answered as abandoned, which the result sink counts',
    );
    await until(() => runner.stats().running === 0, 'its process to be ended', 5_000);
    assert.equal(seen.length, 1, 'and the ended process reports nothing more');
  });

  it('lets a check that finishes inside the drain window report what it found', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(61, 'test.slow', { delayMs: 300 }));
    await until(() => runner.stats().running === 1, 'the check to start');
    await runner.stop({ drainMs: 5_000 });
    assert.deepEqual(
      seen.map((one) => [one.result.sensorId, one.meta.phase]),
      [[61, 'execute']],
    );
  });

  it('stops accepting work once stopped', async () => {
    const { runner } = runnerOf();
    await runner.stop();
    assert.equal(runner.submit(request(50, 'test.ok')), 'stopped');
  });
});
