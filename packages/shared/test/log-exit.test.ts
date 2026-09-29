import { strict as assert } from 'node:assert';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOG_BACKLOG_MAX_BYTES } from '../src/logging/output.js';

/**
 * The last line reaches the output on every way a service ends, with the output stalled when it
 * does (`P-216` part 3, WatchDog's second condition).
 *
 * **Stalled, not merely slow.** Each child fills the descriptor it is about to end on until the
 * kernel will take no more, says so on the other one, and only then ends; the test starts reading
 * a moment later. So the lines have to wait in the process, and the exit has to wait for them.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures', 'log-exit.js');

/** A child that never ends is a failure of its own, named, rather than a suite that hangs. */
const CHILD_TIMEOUT_MS = 20_000;

type Child = ChildProcessByStdio<null, Readable, Readable>;

const children = new Set<Child>();

function start(mode: string, env: NodeJS.ProcessEnv = {}): Child {
  const child = spawn(process.execPath, [FIXTURE, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'], ...env },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

// A test that timed out leaves its child running, and a running child holds the suite open.
after(() => {
  for (const child of children) child.kill('SIGKILL');
});

/** Every wait on the child is bounded on its own: a test's timeout fails it and does not stop it. */
const WAIT_MS = 10_000;

async function within<T>(what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(WAIT_MS)} ms waiting for ${what}`));
    }, WAIT_MS);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with the first line on `stream` that starts with `prefix`, reading only until then. */
function lineStarting(stream: Readable, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      // Whole lines only: a marker split across two chunks would match on its first half.
      for (const line of buffered.split('\n').slice(0, -1)) {
        if (line.startsWith(prefix)) {
          stream.off('data', onData);
          stream.pause();
          resolve(line);
          return;
        }
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

/** Everything left on `stream` until it ends. */
function rest(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let all = '';
    // Closed before anyone read it: whatever it held is what there was.
    if (stream.destroyed) {
      resolve(String(stream.read() ?? ''));
      return;
    }
    stream.on('data', (chunk: Buffer) => {
      all += chunk.toString('utf8');
    });
    stream.once('end', () => {
      resolve(all);
    });
    stream.once('error', reject);
    stream.resume();
  });
}

function exited(child: Child): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function records(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every filler line the child wrote, once each and in order, and then what `tail` says. */
function assertWholeLog(text: string, written: number, tail: readonly string[]): void {
  const lines = records(text);
  const fillers = lines.filter((line) => line['msg'] === 'filler').map((line) => line['line']);
  // The filler lines are the child's whole output before its end, and none may be missing,
  // doubled or reordered: that is what losing the write in flight looked like.
  assert.equal(fillers.length, written, 'every line the child logged is in the output');
  assert.ok(
    fillers.every((line, index) => line === index),
    'in the order they were logged',
  );
  const last = lines.slice(-tail.length).map((line) => line['msg']);
  assert.deepEqual(last, tail);
}

describe('the log on the way out (P-216 part 3)', () => {
  it(
    'writes everything held, and the last line, when SIGTERM arrives with the journal stalled',
    { timeout: CHILD_TIMEOUT_MS },
    async () => {
      const child = start('sigterm');
      const done = exited(child);
      const stalled = await within(
        'the child to stall its output',
        lineStarting(child.stderr, 'stalled '),
      );
      const written = Number(stalled.split(' ')[1]);
      child.kill('SIGTERM');
      // A lower bound on the stall, and well inside the exit's two seconds: the exit is waiting.
      await sleep(300);
      // Still here: the exit is waiting on the output, which is the claim. Without the flush it had
      // gone within milliseconds, and what it held with it.
      assert.equal(child.exitCode, null, 'the exit waits for the stalled output');
      const [out, status] = await within(
        'the child to end',
        Promise.all([rest(child.stdout), done]),
      );
      assert.deepEqual(status, { code: 0, signal: null });
      assertWholeLog(out, written, ['shutting down', 'shutdown complete']);
    },
  );

  // Two things flush on this path, and the test holds the pair to the claim rather than either
  // alone: pino flushes on a `fatal` line, which is what waits here, and the exit hook writes the
  // shutdown's lines after it. The SIGTERM test above is the one that fails without the hook.
  it(
    'writes everything held, and why, when an exception nobody caught ends the process',
    { timeout: CHILD_TIMEOUT_MS },
    async () => {
      const child = start('uncaught');
      const done = exited(child);
      const stalled = await within(
        'the child to stall its output',
        lineStarting(child.stderr, 'stalled '),
      );
      const written = Number(stalled.split(' ')[1]);
      await sleep(300);
      // Still here: the exit is waiting on the output, which is the claim. Without the flush it had
      // gone within milliseconds, and what it held with it.
      assert.equal(child.exitCode, null, 'the exit waits for the stalled output');
      const [out, status] = await within(
        'the child to end',
        Promise.all([rest(child.stdout), done]),
      );
      assert.deepEqual(status, { code: 1, signal: null });
      assertWholeLog(out, written, ['uncaught exception', 'shutting down', 'shutdown complete']);
      const fatal = records(out).find((line) => line['msg'] === 'uncaught exception');
      assert.match(JSON.stringify(fatal), /the check that nobody caught/);
    },
  );

  it(
    'writes the configuration refusal before exit 78, with standard error stalled',
    { timeout: CHILD_TIMEOUT_MS },
    async () => {
      const child = start('config', { MS_CONFIG_FILE: '/nonexistent/ms-probe.json' });
      const done = exited(child);
      await within('the child to stall its output', lineStarting(child.stdout, 'stalled'));
      await sleep(300);
      assert.equal(child.exitCode, null, 'the exit waits for the stalled output');
      const [err, status] = await within(
        'the child to end',
        Promise.all([rest(child.stderr), done]),
      );
      assert.deepEqual(status, { code: 78, signal: null });
      const lines = err.split('\n').filter((line) => line !== '');
      assert.match(lines.at(-1) ?? '', /^Configuration error: /);
    },
  );
});

describe('the log with nobody reading (P-216 part 3)', () => {
  it(
    'holds at most the bound, drops and counts past it, and never waits',
    { timeout: CHILD_TIMEOUT_MS },
    async () => {
      const child = start('flood');
      const done = exited(child);
      try {
        const report = JSON.parse(await within('the report', lineStarting(child.stderr, '{'))) as {
          lines: number;
          slowestMs: number;
          droppedLines: number;
          droppedBytes: number;
          backlogBytes: number;
        };
        assert.ok(report.droppedLines >= 1_000, 'past the bound, lines are dropped');
        assert.ok(report.droppedBytes > 0);
        assert.ok(report.backlogBytes <= LOG_BACKLOG_MAX_BYTES, 'and what is held stays under it');
        // Within a line of the bound: it fills to it rather than dropping early.
        assert.ok(report.backlogBytes > LOG_BACKLOG_MAX_BYTES - 1_024);
        // No line waited on the journal. A second is generous for a line that does not; one that
        // waits on a pipe nobody reads waits for ever.
        assert.ok(report.slowestMs < 1_000, `the slowest line took ${String(report.slowestMs)} ms`);
      } finally {
        child.kill('SIGKILL');
        await within('the child to be killed', done);
      }
    },
  );
});
