import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import type { CheckResult, ProbeQuery, QueryFailure, SensorAssignment } from '@ms/shared';
import { QueryRunner } from '../src/queries/runner.js';
import { pollWithin } from './support/within.js';

const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/query-runner.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

/**
 * The probe's half of an on-demand query (`R-09`).
 *
 * **Every path answers, and that is what this file is about.** The core is holding a deadline
 * with an operator behind it; a query that produced no message would spend that whole deadline
 * and then be reported as a device that would not reply, which is the one diagnosis this
 * mechanism exists to get right.
 */

interface Answer {
  queryId: string;
  result?: CheckResult;
  failure?: QueryFailure;
  message?: string;
}

const runners: QueryRunner[] = [];

function assignment(
  sensorId: number,
  sensorType: string,
  timeoutMs = 5_000,
  params: Record<string, unknown> = {},
): SensorAssignment {
  return {
    sensorId,
    sensorType,
    params,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    intervalSeconds: 60,
    timeoutMs,
  };
}

const check = (a: SensorAssignment): ProbeQuery => ({ kind: 'check', assignment: a });

async function runnerOf(options: { size?: number; queueMaxLength?: number } = {}): Promise<{
  runner: QueryRunner;
  answers: Answer[];
}> {
  const answers: Answer[] = [];
  const runner = new QueryRunner({
    logger: silent,
    answer: (message) => answers.push(message),
    registryModule: FIXTURES,
    size: options.size ?? 1,
    queueMaxLength: options.queueMaxLength ?? 8,
  });
  runners.push(runner);
  await runner.start();
  return { runner, answers };
}

function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  return pollWithin(timeoutMs, what, predicate, 5);
}

after(async () => {
  for (const runner of runners) await runner.stop();
});

describe('the probe’s query runner', () => {
  it('runs the check it was handed and answers on the same id', async () => {
    const { runner, answers } = await runnerOf();
    runner.run('q1', check(assignment(1, 'test.ok')), 5_000);
    await until(() => answers.length === 1, 'an answer');

    const answer = answers[0];
    assert.ok(answer !== undefined);
    assert.equal(answer.queryId, 'q1');
    assert.equal(answer.failure, undefined);
    const result = answer.result;
    assert.ok(result !== undefined);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.message, 'all well');
  });

  it('reports a failing check as an answer, not as a failed query', async () => {
    // The distinction is the whole point of asking: "the check ran and the target refused" is
    // what somebody pressed the button to find out, where a `failure` would be this mechanism
    // claiming a fault of its own and hiding the real one.
    const { runner, answers } = await runnerOf();
    runner.run('q2', check(assignment(2, 'test.throw')), 5_000);
    await until(() => answers.length === 1, 'an answer');

    const answer = answers[0];
    assert.ok(answer !== undefined);
    assert.equal(answer.failure, undefined, 'a failing check is a successful query');
    assert.equal(answer.result?.outcome, 'error');
  });

  it('answers busy rather than silently dropping a second check of the same sensor', async () => {
    // Two operators on one sensor. The pool refuses the second, and a refusal that produced no
    // message would leave that operator's request to die of its deadline.
    const { runner, answers } = await runnerOf();
    runner.run('slow', check(assignment(3, 'test.slow', 5_000)), 5_000);
    runner.run('second', check(assignment(3, 'test.ok')), 5_000);

    await until(() => answers.some((a) => a.queryId === 'second'), 'the refusal');
    const refused = answers.find((a) => a.queryId === 'second');
    assert.ok(refused !== undefined);
    assert.equal(refused.failure, 'busy');
    assert.match(refused.message ?? '', /already being checked/);

    await until(() => answers.some((a) => a.queryId === 'slow'), 'the first to finish');
  });

  it('answers busy when its queue is full rather than growing one', async () => {
    const { runner, answers } = await runnerOf({ size: 1, queueMaxLength: 1 });
    // One running, one queued, and the third has nowhere to go.
    runner.run('a', check(assignment(10, 'test.slow', 5_000)), 5_000);
    runner.run('b', check(assignment(11, 'test.slow', 5_000)), 5_000);
    runner.run('c', check(assignment(12, 'test.ok')), 5_000);

    await until(() => answers.some((a) => a.queryId === 'c'), 'the refusal');
    assert.equal(answers.find((a) => a.queryId === 'c')?.failure, 'busy');

    await until(() => answers.length === 3, 'the other two to finish');
  });

  it('bounds the check by the core’s deadline, not only by the sensor’s', async () => {
    // The core is waiting for two seconds; the sensor's own allowance is a minute. Honouring the
    // longer one would hold a worker for fifty-eight seconds after the answer stopped mattering.
    const { runner, answers } = await runnerOf();
    runner.run('q', check(assignment(20, 'test.slow', 60_000, { delayMs: 60_000 })), 1_000);
    await until(() => answers.length === 1, 'the timed-out check', 8_000);

    const result = answers[0]?.result;
    assert.ok(result !== undefined);
    assert.equal(result.outcome, 'error');
    assert.ok(
      // Under half the sensor's own minute, not an absolute budget (`P-234`).
      result.durationMs < 30_000,
      `waited ${String(result.durationMs)} ms for a 1,000 ms deadline`,
    );
  });

  it('sends nothing for a query the core has stopped waiting for', async () => {
    const { runner, answers } = await runnerOf();
    runner.run('gone', check(assignment(30, 'test.slow', 3_000, { delayMs: 100 })), 5_000);
    runner.cancel('gone');

    // Long enough for the check to finish and try to report. Nothing should arrive.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(answers, [], 'a cancelled query must not answer');
  });

  it('cancelling an id it has never heard of does nothing at all', async () => {
    const { runner, answers } = await runnerOf();
    runner.cancel('never-existed');
    runner.run('q', check(assignment(40, 'test.ok')), 5_000);
    await until(() => answers.length === 1, 'an answer');
    assert.equal(answers[0]?.queryId, 'q');
  });

  it('calls a shutdown the probe’s fault rather than the device’s', async () => {
    // The pool settles an abandoned job with an ordinary `error` result, which is right for the
    // spool and wrong here: an operator reading "probe is stopping" under a device's name would
    // conclude the device is at fault. It is named as a query failure instead.
    const answers: Answer[] = [];
    const runner = new QueryRunner({
      logger: silent,
      answer: (message) => answers.push(message),
      registryModule: FIXTURES,
    });
    await runner.start();
    runner.run('waiting', check(assignment(50, 'test.slow', 5_000, { delayMs: 5_000 })), 5_000);

    await runner.stop();
    assert.equal(answers.length, 1, 'nobody is left waiting on a probe that has stopped');
    const answer = answers[0];
    assert.ok(answer !== undefined);
    assert.equal(answer.failure, 'offline');
    assert.equal(answer.result, undefined, 'and it is not dressed as a reading');
  });

  it('says a type it does not have is a probe problem, not a device one', async () => {
    // A probe older than the core has sensor types it has never heard of. Reported as a check
    // error, that reads as a fault at the target — and an operator would go and look at a
    // device that is working perfectly.
    const { runner, answers } = await runnerOf();
    runner.run('q', check(assignment(60, 'test.does-not-exist')), 5_000);
    await until(() => answers.length === 1, 'an answer');

    const answer = answers[0];
    assert.ok(answer !== undefined);
    assert.equal(answer.failure, 'unsupported');
    // In the registry's own words, which name the type and, from a real one, why it is missing.
    assert.equal(answer.message, 'no such check type: test.does-not-exist');
  });

  it('holds a worker whose check ignores its abort for the grace it was given', async () => {
    // The operator's `checkAbortGraceMs`, as the scheduled pool has it (`P-242`). The hung check
    // is answered at its deadline either way; the grace is how long its worker is held before it
    // is terminated, and the next check waits for the one worker there is.
    //
    // **Longer than the pool's own two seconds, and asserted as a wait that has not ended yet**,
    // so load can only make it pass for the right reason: a slow machine delays the answer, and
    // nothing makes it early. Asserting the shorter way — a grace of 100 ms, the next check
    // answered within a second — failed on a loaded machine, where replacing a worker alone
    // took most of that second.
    const answers: Answer[] = [];
    const runner = new QueryRunner({
      logger: silent,
      answer: (message) => answers.push(message),
      registryModule: FIXTURES,
      abortGraceMs: 5_000,
    });
    runners.push(runner);
    await runner.start();
    runner.run('hung', check(assignment(61, 'test.hang', 100)), 100);
    await until(() => answers.length === 1, 'the hung check to be answered', 5_000);
    assert.equal(answers[0]?.result?.outcome, 'error');

    runner.run('next', check(assignment(62, 'test.ok')), 30_000);
    await delay(3_500);
    assert.equal(answers.length, 1, 'the next check ran before the grace was over');
    // And then it does run, so the line above is a wait and not a queue that never moves.
    await until(() => answers.length === 2, 'the next check, once the grace is over', 30_000);
    assert.equal(answers[1]?.result?.outcome, 'ok');
  });
});

/**
 * A type that runs in a process of its own runs in one on demand too (`P-242`).
 *
 * The script directory reaches only a child's environment, so `exe.script` in a worker answered
 * "no script directory configured" on every probe that had one — the diagnostic endpoint giving
 * a wrong diagnosis. Nothing here sets `MS_SCRIPT_DIR` in this process, so a reading proves the
 * check ran where the process runner put it.
 */
describe('the probe’s query runner, for a type that runs in a process of its own', () => {
  let dir = '';

  before(() => {
    assert.equal(process.env['MS_SCRIPT_DIR'], undefined, 'the test must not lend its own');
    dir = mkdtempSync(join(tmpdir(), 'ms-query-scripts-'));
    for (const [name, body] of [
      ['reading.sh', 'echo "0:42:all good"'],
      ['slow.sh', 'sleep 2; echo "0:1:done"'],
      ['hang.sh', 'sleep 60; echo "0:1:done"'],
    ] as const) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, 'utf8');
      chmodSync(join(dir, name), 0o755);
    }
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function isolatedRunner(queueMaxLength = 8): Promise<{
    runner: QueryRunner;
    answers: Answer[];
  }> {
    const answers: Answer[] = [];
    const runner = new QueryRunner({
      logger: silent,
      answer: (message) => answers.push(message),
      // The pool's registry has no `exe.script` at all, so a script that reached it would be
      // answered `unsupported` rather than with a reading.
      registryModule: FIXTURES,
      queueMaxLength,
      isolation: {
        types: new Set(['exe.script']),
        runner: { childEnv: { MS_SCRIPT_DIR: dir } },
      },
    });
    runners.push(runner);
    await runner.start();
    return { runner, answers };
  }

  // Thirty seconds each: a child process and a shell are quick on a quiet machine and not on a
  // shared one, and a budget is not what these tests are about.
  const script = (sensorId: number, program: string): SensorAssignment =>
    assignment(sensorId, 'exe.script', 30_000, { program });

  it('answers with the script’s reading, run with the probe’s script directory', async () => {
    const { runner, answers } = await isolatedRunner();
    runner.run('script', check(script(70, 'reading.sh')), 30_000);
    await until(() => answers.length === 1, 'the script’s answer', 30_000);

    const answer = answers[0];
    assert.ok(answer !== undefined);
    assert.equal(answer.failure, undefined, answer.message);
    assert.equal(answer.result?.outcome, 'ok', answer.result?.message);
    // The script's own reading; the type adds how long it took beside it.
    assert.equal(answer.result.channels.find((channel) => channel.key === 'value')?.value, 42);
  });

  it('runs one at a time and answers busy when its queue is full', async () => {
    // One running and one waiting; the third has nowhere to go. With more than one at a time, all
    // three would have started.
    const { runner, answers } = await isolatedRunner(1);
    runner.run('a', check(script(71, 'slow.sh')), 30_000);
    runner.run('b', check(script(72, 'slow.sh')), 30_000);
    runner.run('c', check(script(73, 'reading.sh')), 30_000);

    await until(() => answers.some((a) => a.queryId === 'c'), 'the refusal');
    const refused = answers.find((a) => a.queryId === 'c');
    assert.equal(refused?.failure, 'busy');
    assert.match(refused.message ?? '', /too many on-demand checks/);

    await until(() => answers.length === 3, 'the other two to finish', 40_000);
    assert.deepEqual(
      ['a', 'b'].map((id) => answers.find((a) => a.queryId === id)?.result?.outcome),
      ['ok', 'ok'],
    );
  });

  it('answers a script still running at a stop at once, rather than waiting it out', async () => {
    // The process runner waits for everything unless told otherwise, and a script's timeout
    // inside a ten-second shutdown hook is the `P-227` failure over again.
    const { runner, answers } = await isolatedRunner();
    runner.run('hung', check(script(74, 'hang.sh')), 30_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const started = performance.now();
    await runner.stop();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5_000, `stopping took ${elapsed.toFixed(0)} ms`);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.failure, 'offline');
  });
});
