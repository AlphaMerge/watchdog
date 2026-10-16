import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { SCRIPT_DIR_ENV, SCRIPT_GRACE_MS } from '@ms/sensors/script';
import {
  KILL_MARGIN_MS,
  leftOf,
  ProcessRunner,
  ReadyLine,
  STARTUP_TIMEOUT_MS,
} from '../src/runner/process-runner.js';
import {
  linuxProcessView,
  readGroup,
  readProc,
  type ProcessView,
} from '../src/runner/script-groups.js';
import { READY_MARKER, type ResultMeta } from '../src/runner/types.js';
import { pollWithin } from './support/within.js';
import { assertFits } from './support/fits.js';

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
/** The probe's own registry, as a probe loads it: the real `exe.script`, not a fixture (`P-262`). */
const CATALOGUE = join(import.meta.dirname, '..', 'src', 'runner', 'catalogue-registry.js');

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
    processView?: ProcessView | null;
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
    ...(options.processView === undefined ? {} : { processView: options.processView }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  runners.push(runner);
  return { runner, seen };
}

function until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  return pollWithin(timeoutMs, what, predicate, 10);
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
    // A crash after the ready line is the check's own failure, and decides its sensor (`P-265`).
    assert.equal(seen[0].result.notStarted, undefined);
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
    assert.deepEqual(seen[0]?.result.failure, { phase: 'worker-crash' });
  });

  it('records no channel values for a failed check', async () => {
    // A Down sensor records no channel values: the gap is the data (CLAUDE.md).
    const { runner, seen } = runnerOf();
    runner.submit(request(5, 'test.throw'));
    await until(() => seen.length === 1, 'the failure');
    assert.equal(seen[0]?.result.outcome, 'error');
    assert.equal(seen[0].result.message, 'the check failed on purpose');
    assert.deepEqual(seen[0].result.channels, []);
    assert.equal(seen[0].result.notStarted, undefined, 'it started, and failed');
    // A plain `Error` names no phase, and `execute` is never sent (`P-285`).
    assert.equal('failure' in seen[0].result, false);
  });

  it('says where a check failed when its error named a phase, from a process of its own (P-285)', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(9, 'test.phase'));
    runner.submit(request(10, 'test.phase', { phase: 'connect', host: 'admin:secret@192.0.2.7' }));
    await until(() => seen.length === 2, 'both failures');
    const of = (id: number) => seen.find((one) => one.result.sensorId === id);
    // Copied out of the error before JSON, which would have kept only its message.
    assert.deepEqual(of(9)?.result.failure, { phase: 'walk', target: '192.0.2.7:161' });
    assert.equal(of(9)?.meta.phase, 'execute');
    assert.deepEqual(of(10)?.result.failure, { phase: 'connect' });
    assert.doesNotMatch(JSON.stringify(seen.map((one) => one.result)), /secret|snmpwalk/);
  });

  it('says the check’s own phase when it ran out of time in one, not the runner’s (P-285)', async () => {
    // The child aborts the check at its timeout, and a transport that honours the abort throws
    // from where it was. That is what tells a walk that stalled from a device that is gone; the
    // message says the time ran out.
    const { runner, seen } = runnerOf();
    runner.submit(request(11, 'test.phase-at-timeout', { timeoutMs: 800 }));
    await until(() => seen.length === 1, 'the timeout', 20_000);
    assert.equal(seen[0]?.meta.phase, 'aborted');
    assert.deepEqual(seen[0].result.failure, { phase: 'walk', target: '192.0.2.7:161' });
    assert.match(seen[0].result.message, /stopped at its timeout/);
  });

  it('lets a check that honours its signal report its own diagnosis', async () => {
    // The child is given the deadline too, so a well-behaved check says where it got to rather
    // than being killed with nothing to say.
    const { runner, seen } = runnerOf();
    runner.submit(request(6, 'test.slow', { delayMs: 30_000, timeoutMs: 800 }));
    await until(() => seen.length === 1, 'the timeout', 20_000);
    assert.equal(seen[0]?.result.outcome, 'error');
    assert.equal(seen[0].meta.phase, 'aborted');
    // Its error named no phase, so the runner's (`P-285`).
    assert.deepEqual(seen[0].result.failure, { phase: 'aborted' });
    assert.match(seen[0].result.message, /exceeded its timeout/);
    assert.equal(runner.stats().timedOut, 1);
  });

  it('kills a check that ignores its signal, and says so', async () => {
    const { runner, seen } = runnerOf();
    runner.submit(request(7, 'test.stuck', { timeoutMs: 500 }));
    await until(() => seen.length === 1, 'the kill', 20_000);
    assert.equal(seen[0]?.meta.phase, 'timeout');
    assert.deepEqual(seen[0].result.failure, { phase: 'timeout' });
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
    assert.deepEqual(seen[0].result.failure, { phase: 'unknown-type' });
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
    assert.deepEqual(result.failure, { phase: 'resolve', target: 'switch.invalid' });
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
        assert.equal(result.notStarted, true, 'the core holds the sensor rather than failing it');
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
      assert.equal(exits.seen[0].result.notStarted, true);
      assert.equal(killed.seen[0].result.notStarted, true);
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
      assert.equal(result.notStarted, true);
      assert.deepEqual(result.failure, { phase: 'startup' });
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

  describe('an answer read as a claim (`P-277`)', () => {
    // What a script running as `processUid` can write on its check process's stdout, by `ptrace`
    // or `pidfd_getfd`. Each used to be cast and believed; a `durationMs` that was not a number
    // threw while the result was built, and the rejection ended the probe.
    const forged: readonly [string, string][] = [
      ['{"ok":true}', '"durationMs" is not a number of milliseconds'],
      ['{"ok":true,"durationMs":"1"}', '"durationMs" is not a number of milliseconds'],
      ['{"ok":true,"durationMs":-1}', '"durationMs" is not a number of milliseconds'],
      ['[1,2]', 'it is not an object'],
      ['null', 'it is not an object'],
      ['{"ok":"yes","durationMs":1}', '"ok" is not true or false'],
      ['{"ok":true,"durationMs":1,"message":5}', '"message" is not text'],
      ['{"ok":true,"durationMs":1,"channels":"x"}', '"channels" is not a list'],
      ['{"ok":false,"durationMs":1,"withheld":"yes"}', '"withheld" is not true or false'],
      [
        '{"ok":false,"durationMs":1,"startup":true}',
        'it said its start-up failed after it had said it was ready',
      ],
    ];

    it('takes a marked line that is not an answer for no answer, and goes on running', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const { runner, seen } = runnerOf({ maxConcurrent: 4 });
        for (const [at, [line]] of forged.entries()) {
          assert.equal(runner.submit(request(300 + at, 'test.forge-answer', { line })), 'accepted');
        }
        await until(() => seen.length === forged.length, 'every forged answer');
        for (const [at, [line, why]] of forged.entries()) {
          const entry = seen.find((one) => one.result.sensorId === 300 + at);
          assert.ok(entry !== undefined, line);
          assert.equal(entry.result.outcome, 'error', line);
          assert.equal(entry.meta.phase, 'worker-crash', line);
          assert.equal(
            entry.result.message,
            `the check process's answer is not a result this probe can read: ${why}`,
            line,
          );
          assert.deepEqual(entry.result.channels, [], line);
        }
        const stats = runner.stats();
        assert.equal(stats.crashed, forged.length);
        assert.equal(stats.startupFailed, 0, 'a claim after the ready line is not a start-up');

        runner.submit(request(399, 'test.ok'));
        await until(() => seen.length === forged.length + 1, 'the next check');
        assert.equal(seen.at(-1)?.result.outcome, 'ok');
        assert.deepEqual(rejections, []);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('takes where a check failed as a claim too, bounded, and never refuses the answer for it (P-285)', async () => {
      // A script that has the check process's stdout can say any phase and any host. What it
      // says is bounded as the core bounds it; the answer is not refused, which would make a
      // failed check a crash.
      const lines: readonly [string, unknown][] = [
        ['{"phase":"exec","target":"192.0.2.9"}', { phase: 'exec', target: '192.0.2.9' }],
        ['{"phase":"exec","target":"root:pw@192.0.2.9"}', { phase: 'exec' }],
        ['{"phase":"rm -rf /","target":"192.0.2.9"}', undefined],
        ['"exec"', undefined],
        ['[1]', undefined],
      ];
      const { runner, seen } = runnerOf({ maxConcurrent: 4 });
      for (const [at, [failure]] of lines.entries()) {
        const line = `{"ok":false,"durationMs":1,"message":"m","failure":${failure}}`;
        assert.equal(runner.submit(request(330 + at, 'test.forge-answer', { line })), 'accepted');
      }
      // On a success it is dropped with everything else a success cannot say.
      runner.submit(
        request(339, 'test.forge-answer', {
          line: '{"ok":true,"durationMs":1,"message":"m","failure":{"phase":"exec"}}',
        }),
      );
      await until(() => seen.length === lines.length + 1, 'every claimed failure');
      for (const [at, [failure, kept]] of lines.entries()) {
        const entry = seen.find((one) => one.result.sensorId === 330 + at);
        assert.ok(entry !== undefined, failure);
        assert.equal(entry.meta.phase, 'execute', failure);
        assert.deepEqual(entry.result.failure, kept, failure);
      }
      const success = seen.find((one) => one.result.sensorId === 339)?.result;
      assert.equal(success?.outcome, 'ok');
      assert.equal('failure' in success, false);
      assert.equal(runner.stats().crashed, 0, 'no answer refused');
    });

    it('answers a check whose result could not be handed on, rather than ending the probe', async () => {
      // Nothing in the runner is meant to throw once the run is over. If something does, the
      // check is answered and the runner goes on, where it used to be an unhandled rejection.
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const errors: string[] = [];
        const logger = pino(
          { level: 'error' },
          { write: (line: string) => void errors.push(line) },
        );
        const seen: CheckResult[] = [];
        const runner = new ProcessRunner({
          logger,
          registryModule: FIXTURES,
          onResult: (result) => {
            seen.push(result);
            if (result.sensorId === 310) throw new Error('the sink refused it');
          },
        });
        runners.push(runner);
        runner.submit(request(310, 'test.ok'));
        await until(() => errors.some((line) => line.includes('while settling')), 'the log');
        runner.submit(request(311, 'test.ok'));
        await until(() => seen.some((one) => one.sensorId === 311), 'the next check');
        assert.deepEqual(rejections, []);
        assert.match(errors.join(''), /the sink refused it/);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('sends what can be sent of readings no core would take', async () => {
      const { runner, seen } = runnerOf();
      assert.equal(runner.stats().channelsDropped, 0, 'nothing dropped before');
      runner.submit(request(320, 'test.unfit'));
      await until(() => seen.length === 1, 'the check');
      assertFits(seen[0]?.result);
      // `P-283`: the four channels that could not be sent are counted for Probe Health.
      assert.equal(runner.stats().channelsDropped, 4);
    });
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

describe('a script check in a process of its own (`P-262`)', () => {
  // The real `exe.script`, through the probe's real catalogue, in a check process the runner
  // started: the path a script sensor takes in service. The check's process aborts the check at
  // its timeout; the runner kills that process 2 s later if it has not answered. A script that
  // heard nothing of the abort ran to its own timeout and was cut off by the runner's kill, and
  // the sensor read *did not finish within* where the script had something to say.
  let dir = '';
  let serial = 0;

  async function script(name: string, body: string): Promise<void> {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(file, 0o755);
  }

  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };

  /** A script check, its own timeout a minute unless said, writing to a file of its own. */
  function scriptCheck(
    sensorId: number,
    program: string,
    timeoutMs: number,
    ownTimeoutMs = 60_000,
  ): { request: Parameters<ProcessRunner['submit']>[0]; file: string } {
    const file = join(dir, `witness-${String((serial += 1))}`);
    return {
      file,
      request: {
        sensorId,
        sensorType: 'exe.script',
        target: { host: '192.0.2.1', ipVersion: 'auto' as const },
        params: {
          program,
          timeoutMs: ownTimeoutMs,
          env: [{ name: 'MS_VAR_PIDS', value: file }],
        },
        timeoutMs,
      },
    };
  }

  async function pidsIn(file: string): Promise<number[]> {
    const pids = (await readFile(file, 'utf8')).trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2, `the script wrote two pids: ${pids.join(' ')}`);
    for (const pid of pids) assert.ok(Number.isInteger(pid) && pid > 1, `a pid: ${String(pid)}`);
    return pids;
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ms-p262-'));
    // Each prints first and then leaves its witness, so a test that finds the witness knows the
    // script got as far as its output (and, for the second, its trap). The pids go by rename, so
    // the file is never read half-written.
    await script('halfway.sh', 'echo "fetched 3 of 5 pages"\ntouch "$MS_VAR_PIDS"\nsleep 60');
    // Ignores SIGTERM, as its helper then does too, and waits for the helper.
    await script(
      'stubborn.sh',
      "trap '' TERM\nsleep 60 &\necho 'holding on' >&2\n" +
        'echo "$$ $!" > "$MS_VAR_PIDS.tmp" && mv "$MS_VAR_PIDS.tmp" "$MS_VAR_PIDS"\nwait',
    );
  });

  /**
   * The check's timeout, from its ready line, for a script that must have started and printed
   * before it: **10 s**. In that time the check runs the catalogue's preamble, resolves the
   * program and spawns `sh`, which prints at once. `P-258` measured a whole Node process's start
   * — heavier than all of that — at 0.03–0.27 s at load 4.6–18 and above 6 s once at load 18–50;
   * ten seconds is past the worst of those. Each test then asserts the witness the script left
   * after printing, so a start slower still fails saying so rather than matching by luck.
   */
  const STARTED_WITHIN_MS = 10_000;

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const scripts = (): { runner: ProcessRunner; seen: Seen[] } =>
    runnerOf({ registryModule: CATALOGUE, childEnv: { [SCRIPT_DIR_ENV]: dir } });

  it('reports the script’s own diagnosis at the check’s timeout, not the runner’s kill', async () => {
    const { runner, seen } = scripts();
    const { request: check, file } = scriptCheck(120, 'halfway.sh', STARTED_WITHIN_MS);
    runner.submit(check);
    await until(() => seen.length === 1, 'the check to answer', 60_000);
    assert.ok(existsSync(file), 'the script printed and left its witness before the abort');

    const { result, meta } = seen[0] ?? {};
    assert.equal(result?.outcome, 'error');
    assert.equal(meta?.phase, 'aborted');
    assert.match(
      result.message,
      /^halfway\.sh was still running after \d+ ms when the check was ended \(the check exceeded its timeout\), and was stopped with SIGTERM: fetched 3 of 5 pages$/,
    );
    assert.doesNotMatch(result.message, /did not finish within/);
    assert.deepEqual(result.channels, []);
    assert.equal(runner.stats().timedOut, 1);
    assert.equal(runner.stats().crashed, 0);
  });

  it('kills a script that ignores SIGTERM, and its helper, before the runner’s kill', async () => {
    // The script's grace inside the runner's margin, so the answer comes first.
    const { runner, seen } = scripts();
    const { request: check, file } = scriptCheck(121, 'stubborn.sh', STARTED_WITHIN_MS);
    runner.submit(check);
    await until(() => seen.length === 1, 'the check to answer', 60_000);
    assert.ok(existsSync(file), 'the script trapped, printed and wrote its pids before the abort');

    const { result, meta } = seen[0] ?? {};
    assert.equal(meta?.phase, 'aborted');
    assert.match(
      result?.message ?? '',
      new RegExp(
        '^stubborn\\.sh was still running after \\d+ ms when the check was ended \\(the check ' +
          'exceeded its timeout\\), and was killed with SIGKILL, having ignored SIGTERM for ' +
          `${String(SCRIPT_GRACE_MS)} ms: holding on$`,
      ),
    );
    // **Before the runner's kill, measured.** The check's own time, from its ready line to its
    // answer, is under the timeout and the margin the runner counts from its later reading of
    // the same line — so the answer was written before the runner would have killed it. And it
    // waited out the grace: the SIGKILL, not the SIGTERM, ended the script.
    const tookMs = result?.durationMs ?? Infinity;
    assert.ok(
      tookMs < STARTED_WITHIN_MS + KILL_MARGIN_MS,
      `answered ${String(Math.round(tookMs))} ms after it started, past the runner's kill`,
    );
    assert.ok(
      tookMs >= STARTED_WITHIN_MS + SCRIPT_GRACE_MS - 5,
      `answered ${String(Math.round(tookMs))} ms after it started, inside the grace`,
    );
    assert.equal(runner.stats().timedOut, 1);
    const pids = await pidsIn(file);
    await until(() => pids.every(gone), `${pids.join(' and ')} to be gone`, 5_000);
  });

  it('says its own timeout when that comes first', async () => {
    const { runner, seen } = scripts();
    runner.submit(scriptCheck(122, 'halfway.sh', 20_000, 1_000).request);
    await until(() => seen.length === 1, 'the check to answer', 40_000);
    assert.equal(seen[0]?.meta.phase, 'execute');
    assert.match(
      seen[0].result.message,
      /^halfway\.sh was still running after 1000 ms, its own timeout, and was stopped with SIGTERM: fetched 3 of 5 pages$/,
    );
  });

  it('ends the script and its helper when the probe stops and abandons the check', async () => {
    // The runner ends an abandoned check's process group, and the script's is another: the check
    // process hears the runner's SIGTERM as a cancel and ends its script before it goes.
    const { runner, seen } = scripts();
    const { request: check, file } = scriptCheck(123, 'stubborn.sh', 60_000);
    runner.submit(check);
    await until(() => existsSync(file), 'the script to start its helper', 40_000);
    const pids = await pidsIn(file);
    for (const pid of pids)
      assert.equal(gone(pid), false, `${String(pid)} is running to begin with`);

    await runner.stop({ drainMs: 100 });
    assert.deepEqual(
      seen.map((one) => [one.result.sensorId, one.meta.phase]),
      [[123, 'pool-stopped']],
    );
    await until(() => pids.every(gone), `${pids.join(' and ')} to be gone`, 10_000);
    await until(() => runner.stats().running === 0, 'its process to be ended', 10_000);
    assert.equal(seen.length, 1, 'and the ended process reports nothing more');
    // The check process ended its own script, so the runner had nothing left to end (`P-266`).
    assert.equal(runner.stats().scriptGroupsEnded, 0);
  });

  // Linux only: the runner verifies a group in `/proc` before it kills it, and kills nothing where
  // there is none (macOS, a development machine).
  const procfs = process.platform === 'linux' ? false : 'the runner needs /proc (Linux)';

  describe('a check process that dies outright (`P-266`)', { skip: procfs }, () => {
    // The script's group is its own, so the runner's kill of the check process's group never
    // reached it, and a check process that died without hearing its cancel left it running.

    before(async () => {
      // Its helper, then its witness: its own pid, the helper's, and its parent's, which is the
      // check process. Waits for the helper, so it runs until something ends it.
      await script(
        'orphaned.sh',
        'sleep 60 &\necho "started a helper"\n' +
          'echo "$$ $! $PPID" > "$MS_VAR_PIDS.tmp" && mv "$MS_VAR_PIDS.tmp" "$MS_VAR_PIDS"\nwait',
      );
      // Starts a helper that keeps its stdout, and goes: the group outlives its leader, and the
      // pipes keep its check waiting. It stays two seconds first, so that its line is read while
      // `/proc` can still show its leader is the check process's child.
      await script(
        'leaves.sh',
        'sleep 60 &\n' +
          'echo "$$ $! $PPID" > "$MS_VAR_PIDS.tmp" && mv "$MS_VAR_PIDS.tmp" "$MS_VAR_PIDS"\n' +
          'sleep 2\nexit 0',
      );
      // The same, gone at once, so the check process can reap it before the runner reads its line
      // (`P-278`).
      await script(
        'leaves-at-once.sh',
        'sleep 60 &\n' +
          'echo "$$ $! $PPID" > "$MS_VAR_PIDS.tmp" && mv "$MS_VAR_PIDS.tmp" "$MS_VAR_PIDS"\nexit 0',
      );
      // Starts a helper that is no longer its business and answers: it ends on its own.
      await script(
        'answers.sh',
        'sleep 60 >/dev/null 2>&1 </dev/null &\n' +
          'echo "$$ $!" > "$MS_VAR_PIDS.tmp" && mv "$MS_VAR_PIDS.tmp" "$MS_VAR_PIDS"\necho "0:7:fine"',
      );
    });

    async function numbersIn(file: string, count: number): Promise<number[]> {
      const pids = (await readFile(file, 'utf8')).trim().split(/\s+/).map(Number);
      assert.equal(pids.length, count, `the script wrote ${String(count)} pids: ${pids.join(' ')}`);
      for (const pid of pids) assert.ok(Number.isInteger(pid) && pid > 1, `a pid: ${String(pid)}`);
      return pids;
    }

    function goneWithin(ms: number, pids: readonly number[], what: string): Promise<void> {
      return pollWithin(ms, what, () => pids.every(gone), 10);
    }

    it('ends the script and its helper when its check process is killed mid-script', async () => {
      const { runner, seen } = scripts();
      const { request: check, file } = scriptCheck(124, 'orphaned.sh', 60_000);
      runner.submit(check);
      await until(() => existsSync(file), 'the script to start its helper', 40_000);
      const [scriptPid = 0, helperPid = 0, checkPid = 0] = await numbersIn(file, 3);
      for (const pid of [scriptPid, helperPid, checkPid])
        assert.equal(gone(pid), false, `${String(pid)} is running to begin with`);

      // What the runner's own SIGKILL does after its grace, or a heap exhausted: no cancel heard.
      process.kill(checkPid, 'SIGKILL');
      await until(() => seen.length === 1, 'the killed check to be reported', 20_000);
      assert.equal(seen[0]?.meta.phase, 'worker-crash');
      assert.match(seen[0].result.message, /killed by SIGKILL/);

      // Ended once the check process had gone: the script and the helper it started.
      await goneWithin(
        5_000,
        [scriptPid, helperPid],
        `${String(scriptPid)} and ${String(helperPid)} to be gone`,
      );
      assert.equal(runner.stats().scriptGroupsEnded, 1, 'and counted');
      assert.equal(runner.stats().scriptGroupsRefused, 0);
      assert.equal(runner.stats().crashed, 1);
    });

    it('ends a group whose script has gone, its helper the script’s own, when its check process dies', async () => {
      // The branch that reads the group's members from /proc: the leader reaped, the helper still
      // in its session, of its uid.
      const { runner, seen } = scripts();
      const { request: check, file } = scriptCheck(128, 'leaves.sh', 60_000);
      runner.submit(check);
      await until(() => existsSync(file), 'the script to start its helper', 40_000);
      const [scriptPid = 0, helperPid = 0, checkPid = 0] = await numbersIn(file, 3);
      await goneWithin(10_000, [scriptPid], `the script ${String(scriptPid)} to be reaped`);
      assert.equal(gone(helperPid), false, 'its helper is running');

      process.kill(checkPid, 'SIGKILL');
      await until(() => seen.length === 1, 'the killed check to be reported', 20_000);
      await goneWithin(5_000, [helperPid], `the helper ${String(helperPid)} to be gone`);
      assert.equal(runner.stats().scriptGroupsEnded, 1, 'and counted');
      assert.equal(runner.stats().scriptGroupsRecycled, 0);
    });

    /**
     * The real `/proc`, behind a runner that reads a script's line only once the check process has
     * reaped the script: a runner whose loop was busy elsewhere while the script ran (`P-278`).
     * The check process is the runner's own child; any other process it reads is a script leader.
     */
    function lateReader(): { view: ProcessView; late: () => number } {
      const real = linuxProcessView();
      assert.ok(real !== null);
      let late = 0;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      return {
        late: () => late,
        view: {
          read: (pid) => {
            const entry = real.read(pid);
            if (entry === null || entry.ppid === process.pid) return entry;
            // Synchronous, as the runner's own read is, so its loop stands still meanwhile.
            const deadline = Date.now() + 10_000;
            while (real.read(pid) !== null && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
            const after = real.read(pid);
            if (after === null) late += 1;
            return after;
          },
          members: (pgid) => real.members(pgid),
          signalGroup: (pgid, signal) => real.signalGroup(pgid, signal),
        },
      };
    }

    it('ends what a script left when its leader was reaped before its line was read (`P-278`)', async () => {
      const { view, late } = lateReader();
      const { runner, seen } = runnerOf({
        registryModule: CATALOGUE,
        childEnv: { [SCRIPT_DIR_ENV]: dir },
        processView: view,
      });
      const { request: check, file } = scriptCheck(129, 'leaves-at-once.sh', 60_000);
      runner.submit(check);
      await until(() => existsSync(file), 'the script to start its helper', 40_000);
      const [scriptPid = 0, helperPid = 0, checkPid = 0] = await numbersIn(file, 3);
      try {
        await until(() => late() === 1, 'the runner to read the line once the script was reaped');
        assert.equal(gone(scriptPid), true, 'the script was reaped');
        assert.equal(gone(helperPid), false, 'its helper is running');

        process.kill(checkPid, 'SIGKILL');
        await until(() => seen.length === 1, 'the killed check to be reported', 20_000);
        assert.equal(seen[0]?.meta.phase, 'worker-crash');
        await goneWithin(5_000, [helperPid], `the helper ${String(helperPid)} to be gone`);
        assert.equal(runner.stats().scriptGroupsEnded, 1, 'and counted');
        assert.equal(runner.stats().scriptGroupsRefused, 0);
        assert.equal(runner.stats().scriptGroupsRecycled, 0);
      } finally {
        try {
          process.kill(-scriptPid, 'SIGKILL');
        } catch {
          // Gone already, which the assertions above have said.
        }
      }
    });

    it('kills nothing a check process names whose leader has gone, begun before the check', async () => {
      // A group whose leader exited, as a daemon's `setsid` child does once it has forked the
      // daemon: the shape `P-278` records by its members. This one began before the check did.
      const victim = spawn('sh', ['-c', 'sleep 60 &'], { detached: true, stdio: 'ignore' });
      const pgid = victim.pid ?? 0;
      assert.ok(pgid > 1, 'the victim started');
      try {
        await until(
          () => readProc(pgid) === null && readGroup(pgid).length === 1,
          'the victim’s leader to be reaped and its sleep left',
        );
        const [member] = readGroup(pgid);
        // `/proc` counts starts in clock ticks of 10 ms: the check process must begin a tick
        // later than the victim did, as a service started any time before it would.
        await sleep(50);
        const { runner, seen } = runnerOf();
        runner.submit(request(130, 'test.forge-group', { target: pgid }));
        await until(() => seen.length === 1, 'the check to answer', 40_000);
        assert.equal(seen[0]?.result.message, 'forged');
        await until(() => runner.stats().running === 0, 'its process to be ended', 10_000);

        assert.equal(gone(member?.pid ?? 0), false, 'the group it named is still running');
        assert.equal(runner.stats().scriptGroupsRefused, 1, 'and the forgery is counted');
        assert.equal(runner.stats().scriptGroupsEnded, 0);
      } finally {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
      await until(() => readGroup(pgid).length === 0, 'the test’s own group to be cleaned up');
    });

    it('kills nothing a check process names that it did not start, and counts it', async () => {
      // The privilege a forged line would borrow: the runner may be root, running checks as
      // another user. The victim is a process of the test's own, its own session and group leader
      // as a service's main process is, but no child of the check process. The line comes from
      // the check process itself, standing for whatever controls its stdout: Node's pipes are
      // socket pairs, which a script cannot reopen through `/proc/$PPID/fd/1`, but one that may
      // `ptrace` its parent (Yama's scope 0) or take the descriptor with `pidfd_getfd` can write.
      const victim = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      const pid = victim.pid ?? 0;
      try {
        assert.ok(pid > 1, 'the victim started');
        const { runner, seen } = runnerOf();
        runner.submit(request(126, 'test.forge-group', { target: pid }));
        await until(() => seen.length === 1, 'the check to answer', 40_000);
        assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
        assert.equal(seen[0].result.message, 'forged');
        await until(() => runner.stats().running === 0, 'its process to be ended', 10_000);

        assert.equal(gone(pid), false, 'the process it named is still running');
        assert.equal(runner.stats().scriptGroupsRefused, 1, 'and the forgery is counted');
        assert.equal(runner.stats().scriptGroupsEnded, 0);
      } finally {
        victim.kill('SIGKILL');
      }
      await goneWithin(5_000, [pid], `the test's own ${String(pid)} to be cleaned up`);
    });

    it('leaves alone a group whose leader’s pid names another process by then', async () => {
      // A recycled pid, as an injected `/proc` tells it: the leader's start time is not the one
      // recorded. The real one is still the script, so it survives to show it was not killed.
      const real = linuxProcessView();
      assert.ok(real !== null);
      let recycled = false;
      const view: ProcessView = {
        read: (pid) => {
          const entry = real.read(pid);
          return entry === null || !recycled ? entry : { ...entry, starttime: 'someone else' };
        },
        members: (pgid) => real.members(pgid),
        signalGroup: (pgid, signal) => real.signalGroup(pgid, signal),
      };
      const { runner, seen } = runnerOf({
        registryModule: CATALOGUE,
        childEnv: { [SCRIPT_DIR_ENV]: dir },
        processView: view,
      });
      const { request: check, file } = scriptCheck(127, 'orphaned.sh', 60_000);
      runner.submit(check);
      await until(() => existsSync(file), 'the script to start its helper', 40_000);
      const [scriptPid = 0, helperPid = 0, checkPid = 0] = await numbersIn(file, 3);
      try {
        recycled = true;
        process.kill(checkPid, 'SIGKILL');
        await until(() => seen.length === 1, 'the killed check to be reported', 20_000);
        assert.equal(runner.stats().scriptGroupsRecycled, 1, 'counted');
        assert.equal(runner.stats().scriptGroupsEnded, 0);
        assert.equal(gone(scriptPid), false, 'the script was not killed');
        assert.equal(gone(helperPid), false, 'nor its helper');
      } finally {
        try {
          process.kill(-scriptPid, 'SIGKILL');
        } catch {
          // Gone already, which the assertions above have said.
        }
      }
      await goneWithin(5_000, [scriptPid, helperPid], 'the test’s cleanup');
    });

    it('leaves alone what a script that answered started and left', async () => {
      // The script ended on its own and its check answered, so its group was the check's to end
      // and nobody's to end now: the runner ends groups only a dead check process left open.
      const { runner, seen } = scripts();
      const { request: check, file } = scriptCheck(125, 'answers.sh', 20_000);
      runner.submit(check);
      await until(() => seen.length === 1, 'the check to answer', 40_000);
      assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
      const [scriptPid = 0, helperPid = 0] = await numbersIn(file, 2);
      try {
        await until(() => runner.stats().running === 0, 'its process to be ended', 10_000);
        assert.equal(runner.stats().scriptGroupsEnded, 0);
        assert.equal(runner.stats().scriptGroupsRefused, 0, 'its own group was its own');
        assert.equal(gone(helperPid), false, 'the helper it left is still running');
      } finally {
        try {
          process.kill(-scriptPid, 'SIGKILL');
        } catch {
          // Already gone, which the assertion above has said.
        }
      }
      await goneWithin(5_000, [helperPid], `the helper ${String(helperPid)} to be cleaned up`);
    });
  });
});
