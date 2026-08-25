import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';

const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/check-pool.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];

async function poolOf(
  options: { size?: number; abortGraceMs?: number; queueMaxLength?: number } = {},
) {
  const seen: Seen[] = [];
  const pool = new CheckPool({
    logger: silent,
    size: options.size ?? 2,
    registryModule: FIXTURES,
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.queueMaxLength === undefined ? {} : { queueMaxLength: options.queueMaxLength }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  await pool.start();
  return { pool, seen };
}

/** Waits for a condition, or fails the test rather than hanging the suite. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const request = (sensorId: number, sensorType: string, extra: Record<string, unknown> = {}) => ({
  sensorId,
  sensorType,
  params: extra,
  timeoutMs: Number(extra['timeoutMs'] ?? 1_000),
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

describe('check pool', () => {
  it('runs a check and reports its channels', async () => {
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.ok')), 'accepted');

    await until(() => seen.length === 1, 'the check to finish');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'ok');
    assert.equal(entry.result.sensorId, 1);
    assert.deepEqual(entry.result.channels, [
      { key: 'value', value: 42, name: 'Value', unit: 'ms' },
    ]);
    assert.equal(entry.meta.phase, 'execute');
    assert.ok(entry.result.durationMs >= 0);
  });

  it('records no channel values for a failed check', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(2, 'test.throw'));

    await until(() => seen.length === 1, 'the failure');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /on purpose/);
    // A Down sensor records no channel values (CLAUDE.md): the gap is the data.
    assert.deepEqual(entry.result.channels, []);
  });

  it('reports an unknown sensor type rather than hanging on it', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(3, 'nope.missing'));

    await until(() => seen.length === 1, 'the refusal');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /no such check type/);
  });

  // -----------------------------------------------------------------------------------------
  // The Phase 2 exit criteria.
  // -----------------------------------------------------------------------------------------

  it('lets other checks through while one is hung', async () => {
    // "A deliberately hung check does not delay any other check" (PLAN.md, Phase 2).
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    pool.submit({ ...request(10, 'test.hang'), timeoutMs: 60_000 });

    for (let id = 11; id <= 15; id += 1) pool.submit(request(id, 'test.ok'));

    await until(() => seen.length === 5, 'the healthy checks to finish');
    assert.ok(
      seen.every((entry) => entry.result.outcome === 'ok'),
      'all five ran while the hang was outstanding',
    );
    assert.ok(!seen.some((entry) => entry.result.sensorId === 10), 'and the hang is still hung');
  });

  it('reports a timeout when it happens, not when the check gives up', async () => {
    // A sensor stuck on a dead connection has to report Down on schedule, or the state machine
    // learns about the outage a minute late.
    const { pool, seen } = await poolOf({ abortGraceMs: 10_000 });
    const startedAt = Date.now();
    pool.submit({ ...request(20, 'test.hang'), timeoutMs: 150 });

    await until(() => seen.length === 1, 'the timeout');
    const elapsed = Date.now() - startedAt;
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.equal(entry.meta.phase, 'timeout');
    assert.ok(elapsed < 1_000, `the result arrived after ${String(elapsed)} ms`);
    assert.equal(pool.stats().timedOut, 1);
  });

  it('reuses the worker when a check honours its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 5_000 });
    pool.submit({ ...request(30, 'test.slow', { delayMs: 5_000 }), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The cheap path: the check returned when asked, so the worker is available immediately and
    // nothing had to be terminated.
    pool.submit(request(31, 'test.ok'));
    await until(() => seen.length === 2, 'the next check on the same worker');
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().workerCrashes, 0, 'no worker was harmed');
  });

  it('terminates and replaces a worker whose check ignores its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 100 });
    pool.submit({ ...request(40, 'test.hang'), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The worker cannot be reclaimed cooperatively, so it is terminated — and the pool comes
    // back to full strength on its own.
    pool.submit(request(41, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recover', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().size, 1, 'and it is still one worker, not two');
  });

  it('loses exactly one result when a worker dies mid-check', async () => {
    // "Killing a worker mid-check loses exactly one result and recycles cleanly" (PLAN.md).
    const { pool, seen } = await poolOf({ size: 1 });
    pool.submit(request(50, 'test.crash'));

    await until(() => seen.length === 1, 'the crash to be reported');
    const crashed = seen[0];
    assert.ok(crashed);
    assert.equal(crashed.result.sensorId, 50);
    assert.equal(crashed.result.outcome, 'error');
    assert.equal(crashed.meta.phase, 'worker-crash');

    pool.submit(request(51, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recycle', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.ok(pool.stats().workerCrashes >= 1, 'and the crash is counted');
  });

  // -----------------------------------------------------------------------------------------
  // Backpressure.
  // -----------------------------------------------------------------------------------------

  it('skips a sensor whose previous scan has not finished', async () => {
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    assert.equal(pool.submit({ ...request(60, 'test.hang'), timeoutMs: 60_000 }), 'accepted');

    // The rule from WORKFLOW.MD §3: skipped, not stacked. It costs nothing to decide because
    // the wheel has already scheduled the next scan.
    assert.equal(pool.submit(request(60, 'test.ok')), 'already-running');
    assert.equal(pool.stats().deferred, 1);
    assert.equal(seen.length, 0);
  });

  it('accepts a sensor again once its check has finished', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(70, 'test.ok'));
    await until(() => seen.length === 1, 'the first check');
    assert.equal(pool.submit(request(70, 'test.ok')), 'accepted');
    await until(() => seen.length === 2, 'the second check');
  });

  it('refuses work past the queue bound, and counts what it refused', async () => {
    const { pool } = await poolOf({ size: 1, queueMaxLength: 2, abortGraceMs: 10_000 });
    // One worker, busy for a minute; the queue takes two and no more.
    pool.submit({ ...request(80, 'test.hang'), timeoutMs: 60_000 });
    assert.equal(pool.submit(request(81, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(82, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(83, 'test.ok')), 'queue-full');
    assert.equal(pool.stats().refused, 1, 'never dropped without counting');
  });

  it('answers every queued check when it stops, rather than dropping them', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: FIXTURES,
      abortGraceMs: 10_000,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    await pool.start();
    pool.submit({ ...request(90, 'test.hang'), timeoutMs: 60_000 });
    pool.submit(request(91, 'test.ok'));

    await pool.stop();
    assert.equal(seen.length, 2, 'the running one and the queued one');
    assert.ok(seen.every((entry) => entry.meta.phase === 'pool-stopped'));
    assert.equal(pool.submit(request(92, 'test.ok')), 'stopped');
  });

  it('gives up rather than respawning for ever when workers cannot start', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: join(import.meta.dirname, 'support', 'no-such-registry.js'),
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();

    // A registry that cannot be imported kills every worker the moment it starts. Retrying at
    // the speed of the event loop would fill the log and bury the one line that mattered.
    await until(
      () => pool.submit(request(100, 'test.ok')) === 'stopped',
      'the pool to disable itself',
    );
    assert.ok(pool.stats().workerCrashes >= 1);
  });

  it('reports an unregistered sensor type as its own phase, not as a failed check', async () => {
    // A missing sensor type fails identically for ever. Counting it with genuine check failures
    // buries a configuration error inside a rate that looks like a flapping target, and no
    // amount of retrying will change the outcome.
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.nonexistent')), 'accepted');

    await until(() => seen.length === 1, 'the check to be refused');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.meta.phase, 'unknown-type');
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /test\.nonexistent/, 'names the type it could not find');
    assert.deepEqual(entry.result.channels, [], 'a failed check records no channel values');
  });
});
