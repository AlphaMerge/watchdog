import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { Lifecycle, type Logger, type ServiceNotifier } from '@ms/shared';
import { resultSink } from '../src/result-sink.js';
import { CheckPool } from '../src/runner/index.js';
import { ResultSpool } from '../src/spool/spool.js';

/**
 * A result arriving after shutdown begins (2026-09-13).
 *
 * `docker stop` on a dev probe logged "the result spool is closed and cannot accept results"
 * forty-five times in the second before "shutdown complete", exit code 0. Hooks run in reverse
 * registration order and the spool was closed inside the last-registered hook, so it went first —
 * while every worker was still delivering. Each result was refused, logged on its own, and lost.
 *
 * These wire the real `Lifecycle`, `CheckPool`, `resultSink` and `ResultSpool` the way `main.ts`
 * does, with a check still running when shutdown starts. The first is the old order and pins what
 * it cost — counted, and logged once rather than per result; the second is the order `main.ts` now
 * uses, and the result is on disk.
 */

/** At runtime this file is dist/test/shutdown-order.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const notifier: ServiceNotifier = {
  enabled: false,
  ready: () => undefined,
  watchdog: () => undefined,
  stopping: () => undefined,
  status: () => undefined,
  extendTimeout: () => undefined,
};

async function probe(order: 'spool-closed-first' | 'spool-closed-last') {
  const lines: string[] = [];
  const logger = pino(
    { level: 'warn' },
    { write: (line: string) => lines.push(line) },
  ) as unknown as Logger;
  const dir = await mkdtemp(join(tmpdir(), 'ms-shutdown-'));
  dirs.push(dir);

  const exitCodes: number[] = [];
  const lifecycle = new Lifecycle({
    logger,
    shutdownTimeoutMs: 10_000,
    notifier,
    exit: (code: number): never => {
      exitCodes.push(code);
      return undefined as never;
    },
  });
  const spool = await ResultSpool.open({ dir, logger, maxBytes: 1_000_000 });
  const sink = resultSink({
    logger,
    spool,
    drain: { wake: () => undefined },
    checkFlow: { completed: () => undefined },
  });
  let summary: ReturnType<typeof sink.close> | undefined;
  const closeSpool = {
    name: 'result-spool',
    run: async () => {
      summary = sink.close();
      await spool.close();
    },
  };

  if (order === 'spool-closed-last') lifecycle.onShutdown(closeSpool);
  const pool = new CheckPool({
    logger,
    size: 3,
    minSize: 3,
    registryModule: FIXTURES,
    onResult: sink,
  });
  await pool.start();
  lifecycle.onShutdown({ name: 'check-pool', run: () => pool.stop({ drainMs: 5_000 }) });
  if (order === 'spool-closed-first') lifecycle.onShutdown(closeSpool);

  return { lifecycle, pool, sink, spool, dir, lines, exitCodes, summary: () => summary };
}

const slow = (sensorId: number) => ({
  sensorId,
  sensorType: 'test.slow',
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: { delayMs: 300 },
  timeoutMs: 5_000,
});

describe('probe shutdown ordering', () => {
  it('closing the spool first loses what the workers deliver — counted, and logged once', async () => {
    // The order `main.ts` had. Three checks running when shutdown starts, all delivered after the
    // spool is gone.
    const { lifecycle, pool, sink, spool, lines, summary } = await probe('spool-closed-first');
    for (const id of [1, 2, 3]) assert.equal(pool.submit(slow(id)), 'accepted');

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(summary(), { abandoned: 0, unspooled: 0 }, 'nothing had arrived at close');
    assert.equal(pool.stats().completed, 3, 'the workers did finish all three');
    // The pool settles every result before `stop` returns, so all three have been through the
    // sink by now — after its close, which is what the summary above could not see.
    assert.deepEqual(sink.stats(), { abandoned: 0, unspooled: 3 }, 'every one counted');
    const late = lines.filter((line) => line.includes('arrived after the result spool closed'));
    assert.equal(late.length, 1, `one line for three results, not three: ${lines.join('')}`);
    assert.ok(
      !lines.some((line) => line.includes('could not spool a result')),
      'and never the per-result error',
    );
    assert.equal(spool.stats().pending, 0, 'and none of them reached the disk');
  });

  it('closing the spool last spools a result that arrives after shutdown begins', async () => {
    const { lifecycle, pool, dir, lines, exitCodes, summary } = await probe('spool-closed-last');
    for (const id of [1, 2, 3]) assert.equal(pool.submit(slow(id)), 'accepted');

    // Shutdown starts while all three are still running in their workers.
    assert.equal(pool.stats().busy, 3);
    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(summary(), { abandoned: 0, unspooled: 0 });
    assert.deepEqual(lines, [], 'a clean shutdown says nothing at warn');

    // Read back from disk, the way the next start would.
    const reopened = await ResultSpool.open({
      dir,
      logger: pino({ level: 'silent' }),
      maxBytes: 1_000_000,
    });
    const spooled = await reopened.peek(10);
    assert.deepEqual(spooled.map((one) => [one.sensorId, one.outcome]).sort(), [
      [1, 'ok'],
      [2, 'ok'],
      [3, 'ok'],
    ]);
    await reopened.close();
  });
});
