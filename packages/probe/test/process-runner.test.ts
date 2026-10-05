import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import {
  leftOf,
  ProcessRunner,
  ReadyLine,
  STARTUP_TIMEOUT_MS,
} from '../src/runner/process-runner.js';
import { READY_MARKER, type ResultMeta } from '../src/runner/types.js';

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
/** The same checks, behind an import that is slow, hangs or fails as `childEnv` says (`P-260`). */
const STALLED = join(import.meta.dirname, 'support', 'stalled-registry.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const runners: ProcessRunner[] = [];

function runnerOf(
  options: {
    maxConcurrent?: number;
    queueMaxLength?: number;
    registryModule?: string;
    startupTimeoutMs?: number;
    childEnv?: Record<string, string>;
  } = {},
): {
  runner: ProcessRunner;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const runner = new ProcessRunner({
    logger: silent,
    registryModule: options.registryModule ?? FIXTURES,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.queueMaxLength === undefined ? {} : { queueMaxLength: options.queueMaxLength }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.childEnv === undefined ? {} : { childEnv: options.childEnv }),
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

  it('marks a check refused over its credentials’ targets, and no other failure', async () => {
    // `A-41c`: the same mark the worker pool sets, from a process of its own.
    const { runner, seen } = runnerOf();
    runner.submit(request(21, 'test.withheld'));
    runner.submit(request(22, 'test.throw'));
    await until(() => seen.length === 2, 'both failures');
    const refused = seen.find((one) => one.result.sensorId === 21)?.result;
    const failed = seen.find((one) => one.result.sensorId === 22)?.result;
    assert.ok(refused !== undefined && failed !== undefined);
    assert.equal(refused.outcome, 'error');
    assert.equal(refused.withheld, true);
    assert.equal(refused.message, 'Not scanned: outside the allowed targets');
    assert.equal('withheld' in failed, false);
  });

  it('reports a resolver that hangs as a refusal, from a process of its own', async () => {
    // `A-41c`: the child is told its timeout and gives the resolution part of it: ten seconds, the
    // most it gets, where a child not told would give it five.
    //
    // **A minute, so that no load can put the check's own clocks ahead of the resolution's**
    // (`P-258`). Three clocks race here. Since `P-260` the runner's kill (the timeout plus 2 s)
    // and the child's abort (the timeout) both start when the child has loaded its registry and
    // says it is ready, so the child's start no longer counts against either. The resolution's
    // bound starts later still, when the check reaches `pinTarget`, after the fixture has
    // imported it inside the check: 4.7 s at load 6, which at 8 s lost the resolution its 4 s.
    // That import is the check's own time and still counts, so a minute still leaves 50 s for it
    // and late timers, where the most seen was 6.4 s. Before `P-260` the 50 s had to cover the
    // child's start as well, which once took more than 6 s at load 18 to 50.
    const { runner, seen } = runnerOf();
    runner.submit(request(23, 'test.resolve-hangs', { timeoutMs: 60_000 }));
    // Past the runner's kill at 62 s, so that a check that loses says how it lost.
    await until(() => seen.length === 1, 'the refusal', 70_000);
    const result = seen[0]?.result;
    assert.ok(result !== undefined);
    assert.equal(result.withheld, true, result.message);
    assert.match(result.message, /^Not scanned: switch\.invalid did not resolve within 10000 ms/);
    assert.doesNotMatch(result.message, /did not finish within/);
  });

  describe('a check process that is slow to start (`P-260`)', () => {
    it('gives the check its whole timeout however long its process took to load', async () => {
      // Two loads, each of which cost the check its result before `P-260`, and each through a
      // different clock. A check of 1.5 s with a timeout of 5 s:
      // - **after a 4 s load**, the child's own abort, armed before the load, fired 1 s into the
      //   check, which reported that it exceeded its timeout;
      // - **after a 6.5 s load**, the runner's kill, counted from the spawn at 5 s + 2 s, fired
      //   0.5 s into the check, which was killed and reported as not finishing within 5 s.
      // Now both clocks start at the ready line, and the check has its 5 s.
      //
      // **A check of 0.3 × its timeout, not 0.8**, so that load cannot fail it. With 1.6 s of 2 s
      // the runner's kill came 2.4 s after the check's end, and once, beside a probe suite at
      // load 10–27, a child that had said ready did not answer within it. Here it has 5.5 s.
      const loads = [4_000, 6_500];
      const runs = loads.map((delayMs) =>
        runnerOf({
          registryModule: STALLED,
          childEnv: { MS_TEST_REGISTRY_DELAY_MS: String(delayMs) },
        }),
      );
      runs.forEach(({ runner }, at) => {
        runner.submit(request(100 + at, 'test.slow', { delayMs: 1_500, timeoutMs: 5_000 }));
      });
      await until(() => runs.every(({ seen }) => seen.length === 1), 'both checks', 40_000);

      runs.forEach(({ runner, seen }, at) => {
        const loadMs = loads[at] ?? 0;
        const { result, meta } = seen[0] ?? {};
        assert.equal(
          result?.outcome,
          'ok',
          `after a ${String(loadMs)} ms load: ${result?.message ?? ''}`,
        );
        assert.equal(result.message, 'eventually');
        assert.equal(meta?.phase, 'execute');
        // The check's own time, not the load's: measured from the spawn, it would be at least the
        // load plus 1.5 s. (A timer may fire a millisecond early against the monotonic clock.)
        assert.ok(
          result.durationMs >= 1_400 && result.durationMs < loadMs + 1_500,
          `a ${String(result.durationMs)} ms check after a ${String(loadMs)} ms load`,
        );
        const stats = runner.stats();
        assert.ok(
          (stats.startupMs?.max ?? 0) >= loadMs,
          `a start of ${String(stats.startupMs?.max)} ms with a ${String(loadMs)} ms load`,
        );
        assert.equal(stats.timedOut, 0);
        assert.equal(stats.startupFailed, 0);
      });
    });

    it('gives up on a process still loading at the start-up bound, ends it, and counts it', async () => {
      // A load that never finishes, with a check timeout of a minute: before `P-260` this waited
      // for the runner's kill at 62 s, and then reported a check that did not finish in time.
      //
      // **Ten seconds, so that the child has written its pid before it is given up.** The bound
      // runs from the spawn, and the pid is written once Node has booted, the child has read its
      // request and begun importing the registry (`pid-first.ts`, before anything else it loads).
      // That start was 0.03–0.27 s at load 4.6–18 and more than 6 s once at load 18–50 (`P-258`);
      // at 1.5 s a loaded machine could end the child before it wrote anything.
      const boundMs = 10_000;
      const dir = await mkdtemp(join(tmpdir(), 'ms-p260-'));
      try {
        const pidFile = join(dir, 'child.pid');
        const { runner, seen } = runnerOf({
          registryModule: STALLED,
          startupTimeoutMs: boundMs,
          childEnv: { MS_TEST_REGISTRY_DELAY_MS: 'forever', MS_TEST_REGISTRY_PID_FILE: pidFile },
        });
        const submittedAt = performance.now();
        runner.submit(request(110, 'test.ok', { timeoutMs: 60_000 }));
        await until(() => seen.length === 1, 'the start-up to be given up', 40_000);
        const tookMs = performance.now() - submittedAt;

        const { result, meta } = seen[0] ?? {};
        assert.equal(result?.outcome, 'error');
        assert.equal(meta?.phase, 'startup');
        assert.match(result.message, /^the probe took \d+ ms to start the check and gave up/);
        assert.match(result.message, /within the 10000 ms it is allowed, so the check never ran/);
        assert.doesNotMatch(result.message, /exceeded its timeout|did not finish within/);
        assert.deepEqual(result.channels, []);
        // Within the bound and the time it takes to end a process, and not before the bound.
        assert.ok(tookMs >= boundMs, `given up after ${String(Math.round(tookMs))} ms`);
        assert.ok(tookMs < boundMs + 10_000, `given up after ${String(Math.round(tookMs))} ms`);

        const stats = runner.stats();
        assert.equal(stats.startupFailed, 1);
        assert.equal(stats.failed, 1);
        assert.equal(stats.timedOut, 0, 'no check ran, so none timed out');
        assert.equal(stats.crashed, 0);
        assert.ok(
          (stats.startupMs?.max ?? 0) >= boundMs,
          `the given-up start is a start time too: ${String(stats.startupMs?.max)} ms`,
        );
        assert.equal(stats.running, 0);

        // And the process is gone, not left loading for ever. A missing file is a failure, not
        // a pass: without a pid there is nothing to say the process ended.
        assert.ok(existsSync(pidFile), 'the child wrote its id before it was given up');
        const pid = Number(await readFile(pidFile, 'utf8'));
        assert.ok(Number.isInteger(pid) && pid > 0, `the child wrote its id: ${String(pid)}`);
        assert.throws(
          () => process.kill(pid, 0),
          (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
          `process ${String(pid)} is still there`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('lets a started check run past the start-up bound, which ends at the ready line', async () => {
      // The bound is on starting, not on the check: one that has started is on its own clock.
      // Ten seconds, so that a loaded machine starts the fixture inside it (0.03–0.27 s at load
      // 4.6–18, more than 6 s once at load 18–50, `P-258`), and a check that runs past it by two.
      const { runner, seen } = runnerOf({ startupTimeoutMs: 10_000 });
      runner.submit(request(114, 'test.slow', { delayMs: 12_000, timeoutMs: 30_000 }));
      await until(() => seen.length === 1, 'the check', 45_000);
      assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
      assert.equal(runner.stats().startupFailed, 0);
    });

    it('reports a process that ended while loading as a start-up failure, not a crash', async () => {
      // Its check never ran, so whatever ended it was the probe's start-up. An exit and a signal,
      // each named; a crash after the ready line stays a crash (`test.abort` and `test.crash`).
      const exits = runnerOf({
        registryModule: STALLED,
        childEnv: { MS_TEST_REGISTRY_EXIT: '9' },
      });
      const killed = runnerOf({
        registryModule: STALLED,
        childEnv: { MS_TEST_REGISTRY_SIGNAL: 'SIGKILL' },
      });
      exits.runner.submit(request(115, 'test.ok'));
      killed.runner.submit(request(116, 'test.ok'));
      await until(() => exits.seen.length === 1 && killed.seen.length === 1, 'both ends');

      const prefix =
        "the check process ended while it was loading the probe's sensor types, so the check " +
        'never ran — ';
      assert.equal(exits.seen[0]?.meta.phase, 'startup');
      assert.equal(exits.seen[0].result.message, `${prefix}it exited with code 9`);
      assert.equal(killed.seen[0]?.meta.phase, 'startup');
      assert.equal(killed.seen[0].result.message, `${prefix}it was killed by SIGKILL`);
      for (const { runner } of [exits, killed]) {
        const stats = runner.stats();
        assert.equal(stats.startupFailed, 1);
        assert.equal(stats.failed, 1);
        assert.equal(stats.crashed, 0);
      }
    });

    it('reports a registry that will not load as a start-up failure, not a failing check', async () => {
      const { runner, seen } = runnerOf({
        registryModule: STALLED,
        childEnv: { MS_TEST_REGISTRY_THROW: 'the catalogue is half-copied' },
      });
      runner.submit(request(111, 'test.ok'));
      await until(() => seen.length === 1, 'the load to fail');
      const { result, meta } = seen[0] ?? {};
      assert.equal(result?.outcome, 'error');
      assert.equal(meta?.phase, 'startup');
      assert.equal(
        result.message,
        'this probe could not load its sensor types to run the check: the catalogue is half-copied',
      );
      const stats = runner.stats();
      assert.equal(stats.startupFailed, 1);
      assert.equal(stats.failed, 1);
      assert.equal(stats.crashed, 0);
    });

    it('still says a check exceeded its timeout when, after a slow start, it did', async () => {
      // Both ways a check runs out of time, each after a 1.5 s load: one that honours its signal
      // and says so, and one that ignores it and is killed.
      const env = { MS_TEST_REGISTRY_DELAY_MS: '1500' };
      const honours = runnerOf({ registryModule: STALLED, childEnv: env });
      const ignores = runnerOf({ registryModule: STALLED, childEnv: env });
      honours.runner.submit(request(112, 'test.slow', { delayMs: 30_000, timeoutMs: 800 }));
      ignores.runner.submit(request(113, 'test.stuck', { timeoutMs: 500 }));
      await until(
        () => honours.seen.length === 1 && ignores.seen.length === 1,
        'both timeouts',
        30_000,
      );

      assert.equal(honours.seen[0]?.meta.phase, 'aborted');
      assert.match(honours.seen[0].result.message, /exceeded its timeout/);
      assert.equal(ignores.seen[0]?.meta.phase, 'timeout');
      assert.match(ignores.seen[0].result.message, /did not finish within 500 ms/);
      for (const { runner } of [honours, ignores]) {
        assert.equal(runner.stats().timedOut, 1);
        assert.equal(runner.stats().startupFailed, 0);
      }
    });

    it('gives up only once the bound has passed on the clock it reports', () => {
      // A timer may fire up to a millisecond early against `process.hrtime`; the runner waits
      // out what is left rather than report a start shorter than its bound.
      assert.equal(leftOf(1_500, 1_499.4), 1);
      assert.equal(leftOf(1_500, 0.2), 1_500);
      assert.equal(leftOf(1_500, 1_500), null);
      assert.equal(leftOf(1_500, 1_620), null);
    });

    it('gives a start thirty seconds, twice the slowest load measured under contention', () => {
      // `P-258`: 0.45–14.8 s to import the catalogue at load 6.5–29. See `STARTUP_TIMEOUT_MS`.
      assert.equal(STARTUP_TIMEOUT_MS, 30_000);
      assert.equal(runnerOf().runner.stats().startupMs, null, 'no start measured is not zero');
    });
  });

  describe('the ready line (`P-260`)', () => {
    it('is a whole line reading the marker, however the chunks fall', () => {
      assert.equal(new ReadyLine().push(`${READY_MARKER}\n`), true);
      const split = new ReadyLine();
      assert.equal(split.push('ms-check-'), false);
      assert.equal(split.push('rea'), false);
      assert.equal(split.push('dy'), false, 'not before its line ends');
      assert.equal(split.push('\n'), true);
    });

    it('is found after whatever a library printed before it', () => {
      const line = new ReadyLine();
      assert.equal(line.push('a banner\nanother line, longer than the marker by far\n'), false);
      assert.equal(line.push(`${READY_MARKER}\n`), true);
      assert.equal(new ReadyLine().push(`banner\n${READY_MARKER}\nmore`), true);
    });

    it('is not the marker inside a line, or the marker with more after it', () => {
      assert.equal(new ReadyLine().push(`said ${READY_MARKER}\n`), false);
      assert.equal(new ReadyLine().push(`${READY_MARKER}!\n`), false);
      assert.equal(new ReadyLine().push(`${READY_MARKER.slice(0, -1)}\n`), false);
      // A long line that ends in the marker is still the end of a long line.
      const long = new ReadyLine();
      assert.equal(long.push('x'.repeat(40)), false);
      assert.equal(long.push(`${READY_MARKER}\n`), false);
      assert.equal(long.push(`${READY_MARKER}\n`), true, 'the next line starts afresh');
    });
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
