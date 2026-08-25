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
  /** What the probe claimed was still on disk behind each batch. */
  readonly backlogs: number[] = [];
  answer: (batch: readonly CheckResult[]) => ResultsOutcome = () => ({
    kind: 'ack',
    storedSamples: 0,
    retryAfterMs: 0,
  });

  sendResults(results: readonly CheckResult[], backlog: number): Promise<ResultsOutcome> {
    this.offered.push([...results]);
    this.backlogs.push(backlog);
    return Promise.resolve(this.answer(results));
  }
}

async function harness(over: { batchMaxRows?: number; catchUpMaxRows?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ms-drain-'));
  dirs.push(dir);
  const spool = await ResultSpool.open({ dir, maxBytes: 1_000_000, logger: silent });
  const core = new StubCore();
  const drain = new SpoolDrain({
    spool,
    client: core,
    logger: silent,
    batchMaxRows: over.batchMaxRows ?? 100,
    ...(over.catchUpMaxRows === undefined ? {} : { catchUpMaxRows: over.catchUpMaxRows }),
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

/**
 * The half of R-03 the probe owns: telling the core how far behind it is, and clearing a
 * backlog in fewer round trips so its own live results spend less time queued behind one.
 */
describe('catch-up', () => {
  it('tells the core how much is still behind each batch', async () => {
    // Without this the core cannot tell a live batch from a replay, so it has to slow both
    // alike — which is exactly how one probe's catch-up stalls everyone's live ingestion.
    const { spool, core, drain } = await harness({ batchMaxRows: 2 });
    await spool.append([result(1), result(2), result(3), result(4), result(5)]);

    drain.start();
    try {
      await until(() => spool.stats().pending === 0, 'everything to drain');
      assert.deepEqual(core.backlogs.slice(0, 2), [3, 1], 'counted down as it drained');
      assert.equal(core.backlogs.at(-1), 0, 'and reached zero when caught up');
    } finally {
      await drain.stop();
    }
  });

  it('reports no backlog at all when it is keeping up', async () => {
    const { spool, core, drain } = await harness({ batchMaxRows: 100 });
    await spool.append([result(1)]);

    drain.start();
    try {
      await until(() => core.backlogs.length > 0, 'the batch to be offered');
      assert.equal(core.backlogs[0], 0, 'a live probe must never look like one catching up');
    } finally {
      await drain.stop();
    }
  });

  it('takes bigger bites once there is a backlog', async () => {
    // The same rows in fewer round trips. The core paces catch-up by delay rather than by batch
    // size, so a larger batch clears the backlog sooner without taking more of the core.
    const { spool, core, drain } = await harness({ batchMaxRows: 2, catchUpMaxRows: 10 });
    await spool.append(Array.from({ length: 12 }, (_, index) => result(index + 1)));

    drain.start();
    try {
      await until(() => spool.stats().pending === 0, 'everything to drain');
      assert.ok(
        (core.offered[0]?.length ?? 0) > 2,
        `first batch was ${String(core.offered[0]?.length)}, expected a catch-up-sized one`,
      );
    } finally {
      await drain.stop();
    }
  });

  it('waits as long as the core asked before offering the next batch', async () => {
    const { spool, core, drain } = await harness({ batchMaxRows: 1 });
    await spool.append([result(1), result(2)]);
    core.answer = () => ({ kind: 'ack', storedSamples: 2, retryAfterMs: 300 });

    drain.start();
    try {
      await until(() => core.offered.length >= 1, 'the first batch');
      const at = Date.now();
      await until(() => core.offered.length >= 2, 'the second batch', 5_000);
      assert.ok(Date.now() - at >= 250, 'the pacing delay was ignored');
    } finally {
      await drain.stop();
    }
  });

  it('records what Probe Health will report', async () => {
    // These are the numbers P-13 surfaces: how far behind this probe is, and how hard the core
    // has been asking it to slow down. Untested stats are stats that quietly stop being written.
    const { spool, core, drain } = await harness({ batchMaxRows: 1 });
    await spool.append([result(1), result(2), result(3)]);
    core.answer = () => ({ kind: 'ack', storedSamples: 2, retryAfterMs: 40 });

    drain.start();
    try {
      await until(() => spool.stats().pending === 0, 'everything to drain');
      const stats = drain.stats();
      assert.equal(stats.backlog, 0, 'caught up');
      assert.equal(stats.maxRetryAfterMs, 40, 'the largest delay the core asked for');
      assert.equal(stats.sent, 3);
    } finally {
      await drain.stop();
    }
  });

  it('keeps global order when results arrive during a replay', async () => {
    // Ordering is the other half of this task. New checks are appended to the tail while the
    // head is still draining, and what the core sees must be one ordered stream — a replay that
    // interleaves would write samples the core then has to sort.
    const { spool, core, drain } = await harness({ batchMaxRows: 3 });
    await spool.append(Array.from({ length: 9 }, (_, index) => result(index + 1)));

    drain.start();
    try {
      await until(() => core.offered.length >= 1, 'the replay to start');
      for (let id = 10; id <= 15; id += 1) await spool.append([result(id)]);

      await until(() => spool.stats().pending === 0, 'everything to drain');
      assert.deepEqual(
        core.offered.flat().map((r) => r.sensorId),
        Array.from({ length: 15 }, (_, index) => index + 1),
        'the stream must be ordered end to end, backlog then live',
      );
    } finally {
      await drain.stop();
    }
  });
});
