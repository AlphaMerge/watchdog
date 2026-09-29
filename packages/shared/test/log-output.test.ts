import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LogOutput, PROCESS_LOG_OUTPUT, writeLineSync } from '../src/logging/output.js';
import { DeltaMeter } from '../src/process/delta-meter.js';

/** An output the test opens and closes: `EAGAIN` while stalled, `take` bytes a write otherwise. */
function fakeOutput(): {
  written: () => string;
  stall: (stalled: boolean) => void;
  take: (bytes: number) => void;
  fail: (code: string) => void;
  writes: () => number;
  write: (fd: number, data: Buffer) => number;
} {
  let out = '';
  let stalled = false;
  let take = Number.POSITIVE_INFINITY;
  let failure: string | undefined;
  let writes = 0;
  return {
    written: () => out,
    stall: (value) => {
      stalled = value;
    },
    take: (bytes) => {
      take = bytes;
    },
    fail: (code) => {
      failure = code;
    },
    writes: () => writes,
    write: (_fd, data) => {
      writes += 1;
      if (failure !== undefined) {
        throw Object.assign(new Error(failure), { code: failure });
      }
      if (stalled) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
      const n = Math.min(take, data.length);
      out += data.subarray(0, n).toString('utf8');
      return n;
    },
  };
}

/** Waits for a condition, not for a time (`P-234`). */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe('LogOutput (P-216 part 3)', () => {
  it('writes a line at once when the output takes it', () => {
    const fake = fakeOutput();
    const output = new LogOutput({ write: fake.write });
    output.write('one\n');
    output.write('two\n');
    assert.equal(fake.written(), 'one\ntwo\n');
    assert.deepEqual(output.stats(), { droppedLines: 0, droppedBytes: 0, backlogBytes: 0 });
  });

  it('holds what a stalled output will not take, and writes it in order once it will', async () => {
    const fake = fakeOutput();
    const output = new LogOutput({ write: fake.write });
    output.write('before\n');
    fake.stall(true);
    output.write('held one\n');
    output.write('held two\n');
    assert.equal(fake.written(), 'before\n');
    assert.equal(output.stats().backlogBytes, 'held one\nheld two\n'.length);
    // Behind already, so a new line waits its turn rather than jumping the ones held.
    const writesWhileHeld = fake.writes();
    output.write('held three\n');
    assert.equal(fake.writes(), writesWhileHeld, 'no write attempted ahead of the retry');
    fake.stall(false);
    await until(() => output.stats().backlogBytes === 0, 'the backlog to drain');
    assert.equal(fake.written(), 'before\nheld one\nheld two\nheld three\n');
  });

  it('keeps the rest of a line the output took part of', () => {
    const fake = fakeOutput();
    fake.take(3);
    const output = new LogOutput({ write: fake.write });
    output.write('abcdefgh\n');
    assert.equal(fake.written(), 'abcdefgh\n', 'each partial write continues where it stopped');
  });

  it('drops a line past the bound, counts it, and keeps what it already held', () => {
    const fake = fakeOutput();
    fake.stall(true);
    const output = new LogOutput({ write: fake.write, maxBacklogBytes: 20 });
    output.write('0123456789\n'); // 11 bytes held
    output.write('abcdefgh\n'); // 9 more: 20, at the bound and not past it
    output.write('dropped\n'); // 8 more would pass it
    output.write('x\n');
    assert.deepEqual(output.stats(), { droppedLines: 2, droppedBytes: 10, backlogBytes: 20 });
    fake.stall(false);
    output.flushSync(0);
    assert.equal(fake.written(), '0123456789\nabcdefgh\n', 'the start of the episode survives');
  });

  it('flushes everything held on the way out, in order', () => {
    const fake = fakeOutput();
    fake.stall(true);
    const output = new LogOutput({ write: fake.write });
    for (let line = 0; line < 100; line += 1) output.write(`line ${String(line)}\n`);
    fake.stall(false);
    output.flushSync();
    const expected = Array.from({ length: 100 }, (_, line) => `line ${String(line)}\n`).join('');
    assert.equal(fake.written(), expected);
    assert.equal(output.stats().backlogBytes, 0);
  });

  it('gives up on an output that stays stalled at exit, and counts what it could not write', () => {
    const fake = fakeOutput();
    fake.stall(true);
    const output = new LogOutput({ write: fake.write });
    output.write('never\n');
    output.write('written\n');
    const started = performance.now();
    output.flushSync(100);
    const took = performance.now() - started;
    assert.ok(took >= 100, `waited its budget (${String(took)} ms)`);
    assert.ok(took < 2_000, 'and not for ever');
    assert.deepEqual(output.stats(), { droppedLines: 2, droppedBytes: 14, backlogBytes: 0 });
  });

  it('drops and counts everything after the output closes, and says so once', () => {
    const fake = fakeOutput();
    const said: string[] = [];
    const output = new LogOutput({ write: fake.write, failed: (line) => said.push(line) });
    fake.stall(true);
    output.write('held\n');
    fake.stall(false);
    fake.fail('EPIPE');
    output.flushSync(0);
    output.write('after\n');
    output.write('after again\n');
    assert.equal(output.stats().droppedLines, 3);
    assert.equal(output.stats().backlogBytes, 0);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? '', /EPIPE/);
  });

  it('is findable by a sampler loaded into the process, when it is the process’s own', () => {
    // `probe-memory-sampler.mjs` reads the backlog through this; an installed release is a bundle
    // it cannot import. One built for a test's own output is not the process's and stays hidden.
    const registry = globalThis as Record<symbol, unknown>;
    const before = registry[PROCESS_LOG_OUTPUT];
    new LogOutput({ write: fakeOutput().write });
    assert.equal(registry[PROCESS_LOG_OUTPUT], before);
    const own = new LogOutput();
    try {
      assert.equal(registry[PROCESS_LOG_OUTPUT], own);
    } finally {
      registry[PROCESS_LOG_OUTPUT] = before;
    }
  });

  it('writes one line synchronously, waiting a bounded time for a stalled descriptor', () => {
    const fake = fakeOutput();
    fake.take(4);
    assert.equal(writeLineSync(2, 'Configuration error: no\n', 100, fake.write), true);
    assert.equal(fake.written(), 'Configuration error: no\n');
    fake.stall(true);
    const started = performance.now();
    assert.equal(writeLineSync(2, 'lost\n', 50, fake.write), false);
    assert.ok(performance.now() - started >= 50);
  });
});

describe('DeltaMeter (P-216 part 3)', () => {
  it('is the growth since the last reading, and zero when nothing grew', () => {
    const meter = new DeltaMeter();
    assert.equal(meter.take(5, 10, true), 5, 'a fresh total is all new');
    assert.equal(meter.take(12, 40, true), 7);
    assert.equal(meter.take(12, 70, true), 0, 'clears once the drops stop');
  });

  it('gaps the first reading of a total that may already have been recorded', () => {
    const meter = new DeltaMeter();
    assert.equal(meter.take(900, 5_000, false), null);
    assert.equal(meter.take(904, 5_030, false), 4);
  });

  it('counts a restarted total in full, told by the total or the uptime falling', () => {
    const fell = new DeltaMeter();
    fell.take(100, 600, true);
    assert.equal(fell.take(3, 10, false), 3);
    // More dropped since the restart than before it: only the uptime says it is a new process.
    const grew = new DeltaMeter();
    grew.take(10, 600, true);
    assert.equal(grew.take(50, 20, false), 50);
  });
});
