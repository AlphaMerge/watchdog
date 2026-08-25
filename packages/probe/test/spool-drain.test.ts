import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { SpoolDrain, type ResultSender } from '../src/spool/drain.js';
import { ResultSpool } from '../src/spool/spool.js';
import type { ResultsOutcome } from '../src/transport/core-client.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const result = (sensorId: number): CheckResult => ({
  sensorId,
  at: new Date(1_700_000_000_000 + sensorId * 1_000).toISOString(),
  outcome: 'ok',
  message: '',
  durationMs: 1,
  channels: [{ key: 'rtt', value: sensorId }],
});

/** A core that answers however the test wants, and remembers what it was offered. */
class StubCore implements ResultSender {
  connected = true;
  readonly offered: CheckResult[][] = [];
  answer: (batch: readonly CheckResult[]) => ResultsOutcome = () => ({
    kind: 'ack',
    storedSamples: 0,
    retryAfterMs: 0,
  });

  sendResults(results: readonly CheckResult[]): Promise<ResultsOutcome> {
    this.offered.push([...results]);
    return Promise.resolve(this.answer(results));
  }
}

async function harness(over: { batchMaxRows?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ms-drain-'));
  dirs.push(dir);
  const spool = await ResultSpool.open({ dir, maxBytes: 1_000_000, logger: silent });
  const core = new StubCore();
  const drain = new SpoolDrain({
    spool,
    client: core,
    logger: silent,
    batchMaxRows: over.batchMaxRows ?? 100,
    idleMs: 5,
  });
  return { spool, core, drain };
}

/** Waits for a condition rather than for a duration, or fails instead of hanging the suite. */
async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('spool drain', () => {
  it('sends what is spooled and clears it once the core has stored it', async () => {
    const { spool, core, drain } = await harness();
    await spool.append([result(1), result(2)]);

    drain.start();
    try {
      await until(() => core.offered.length > 0, 'the batch to be offered');
      await until(() => spool.stats().pending === 0, 'the spool to be cleared');
      assert.deepEqual(
        core.offered[0]?.map((r) => r.sensorId),
        [1, 2],
      );
      assert.equal(drain.stats().sent, 1);
    } finally {
      await drain.stop();
    }
  });

  it('keeps a batch the core refused, and offers it again', async () => {
    const { spool, core, drain } = await harness();
    await spool.append([result(1)]);
    core.answer = () => ({ kind: 'nack', reason: 'storage-error', retryAfterMs: 0 });

    drain.start();
    try {
      await until(() => core.offered.length >= 2, 'the batch to be retried');
      assert.equal(spool.stats().pending, 1, 'a refused batch must stay on disk');
      assert.deepEqual(
        core.offered[1]?.map((r) => r.sensorId),
        [1],
      );
      assert.ok(drain.stats().retried >= 1);
    } finally {
      await drain.stop();
    }
  });

  it('discards a batch the core calls invalid, rather than jamming behind it', async () => {
    // The one refusal retrying cannot fix. Keeping it would block every later result for ever,
    // so it goes — loudly and counted, because silently losing readings is the failure this
    // whole subsystem exists to avoid.
    const { spool, core, drain } = await harness({ batchMaxRows: 1 });
    await spool.append([result(1), result(2)]);
    core.answer = (batch) =>
      batch[0]?.sensorId === 1
        ? { kind: 'nack', reason: 'invalid', retryAfterMs: 0 }
        : { kind: 'ack', storedSamples: 1, retryAfterMs: 0 };

    drain.start();
    try {
      await until(() => spool.stats().pending === 0, 'the spool to drain past the poison batch');
      assert.equal(drain.stats().rejected, 1);
      assert.equal(drain.stats().sent, 1, 'the result behind it still got through');
    } finally {
      await drain.stop();
    }
  });

  it('offers nothing while the core is unreachable', async () => {
    const { spool, core, drain } = await harness();
    core.connected = false;
    await spool.append([result(1)]);

    drain.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(core.offered, [], 'nothing should have been offered');
      assert.equal(spool.stats().pending, 1, 'and the result is still safe on disk');

      // The link comes back: the backlog is the first thing to move.
      core.connected = true;
      drain.wake();
      await until(() => spool.stats().pending === 0, 'the backlog to drain after reconnect');
    } finally {
      await drain.stop();
    }
  });

  it('sends in batches no larger than it was configured for', async () => {
    const { spool, core, drain } = await harness({ batchMaxRows: 2 });
    await spool.append([result(1), result(2), result(3), result(4), result(5)]);

    drain.start();
    try {
      await until(() => spool.stats().pending === 0, 'everything to drain');
      assert.ok(core.offered.every((batch) => batch.length <= 2));
      assert.deepEqual(
        core.offered.flat().map((r) => r.sensorId),
        [1, 2, 3, 4, 5],
        'in order',
      );
    } finally {
      await drain.stop();
    }
  });

  it('keeps a batch whose answer never arrived', async () => {
    // What a dropped connection looks like from here: the client resolves it as a retryable
    // refusal, and the result stays on disk to be offered again.
    const { spool, core, drain } = await harness();
    await spool.append([result(1)]);
    core.answer = () => ({ kind: 'nack', reason: 'unavailable', retryAfterMs: 0 });

    drain.start();
    try {
      await until(() => core.offered.length >= 1, 'the batch to be offered');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(spool.stats().pending, 1);
    } finally {
      await drain.stop();
    }
  });

  it('survives an error from the core without dying', async () => {
    const { spool, core, drain } = await harness();
    await spool.append([result(1)]);
    let thrown = 0;
    core.answer = () => {
      thrown += 1;
      if (thrown === 1) throw new Error('socket exploded');
      return { kind: 'ack', storedSamples: 1, retryAfterMs: 0 };
    };

    drain.start();
    try {
      // The loop is the probe's only path off disk; an exception must not be what stops it.
      await until(() => spool.stats().pending === 0, 'the drain to recover and finish');
      assert.ok(thrown >= 2);
    } finally {
      await drain.stop();
    }
  });

  it('stops cleanly when there is nothing to do', async () => {
    const { drain } = await harness();
    drain.start();
    await drain.stop();
    await drain.stop();
  });
});
