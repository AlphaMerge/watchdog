import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { CheckPool, GROW_AFTER_MS } from '../../src/runner/index.js';
import { DISPATCH_BUDGET_MS } from '../../src/measured.js';
import { within } from '../support/within.js';

/**
 * What waiting for a straggler costs (`P-437`), measured rather than argued.
 *
 * The pool grows for a shortfall under a tenth of its workers only once the oldest waiting check
 * has waited `GROW_AFTER_MS`. A straggler that a busy worker takes costs nothing. One that lasts
 * waits that long and then a new worker's load on top, so the two together are what has to fit
 * inside the dispatch budget. That is the first measurement here: one worker loading the real
 * catalogue, from spawn to ready, twenty times, printed with `GROW_AFTER_MS` on top against the
 * budget. It asserts nothing: `GROW_AFTER_MS` is a fixed 200 ms, a judgement the measured load
 * does not set, and on a loaded host the load alone is the budget or past it (`P-437`).
 *
 * The second is the alarm the rule could multiply, `poolUsage` at its 80% warning: a pool that
 * waits out the straggler is a worker smaller, and its workers stay busy a little longer into
 * each burst. Two arms in turn, so the host's load lands on both, and each a property of the
 * machine it ran on: printed, with ceilings loose enough not to be flaky.
 */

const silent = pino({ level: 'silent' });
const FIXTURES = join(import.meta.dirname, '..', 'support', 'check-fixtures.js');

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;

describe('waiting for stragglers (P-437)', () => {
  it('measures a worker’s load, which a straggler that lasts waits on top of GROW_AFTER_MS', async (t) => {
    const SPAWNS = 20;
    const tookMs: number[] = [];
    for (let spawn = 0; spawn < SPAWNS; spawn += 1) {
      // The shipped registry, `catalogue-registry.js`: what a worker grown for a straggler loads.
      const pool = new CheckPool({
        logger: silent,
        size: 1,
        minSize: 1,
        onResult: () => undefined,
      });
      pools.push(pool);
      const startedAt = process.hrtime.bigint();
      await within(60_000, 'one worker to load the catalogue', pool.start());
      tookMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      await within(30_000, 'the pool to stop', pool.stop());
    }
    const sorted = [...tookMs].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const lateMs = GROW_AFTER_MS + p95;
    // A measurement, so printed and not asserted (`P-437`'s second review): the bound it once had
    // was the wait against the budget less the load, floored at the wait itself, which nothing it
    // measured could fail.
    t.diagnostic(
      `one worker, spawn to ready, ${String(SPAWNS)} spawns: p50 ${p50.toFixed(0)} ms, p95 ` +
        `${p95.toFixed(0)} ms, max ${(sorted.at(-1) ?? Number.NaN).toFixed(0)} ms; GROW_AFTER_MS ` +
        `${String(GROW_AFTER_MS)} + p95 = ${lateMs.toFixed(0)} ms against the dispatch budget of ` +
        `${String(DISPATCH_BUDGET_MS)} ms: a straggler that lasts starts ` +
        (lateMs <= DISPATCH_BUDGET_MS
          ? 'inside it'
          : `${(lateMs - DISPATCH_BUDGET_MS).toFixed(0)} ms past it`) +
        ' at the p95',
    );
  });

  it('keeps the pool in use about as often at its warning as a pool that grew for them', async (t) => {
    // Thirteen checks a burst behind twelve workers, finishing 20–80 ms in, as a burst's checks
    // spread: the same load for a pool that grows for the thirteenth on sight, as before, and for
    // the shipped one, which waits and lets the first worker to finish take it. The share of
    // samples at or past 80% is what a heartbeat landing at a random moment would read.
    const BURSTS = 40;
    const PERIOD_MS = 150;
    const arm = async (growAfterMs: number | undefined) => {
      const pool = new CheckPool({
        logger: silent,
        size: 20,
        minSize: 12,
        ...(growAfterMs === undefined ? {} : { growAfterMs }),
        registryModule: FIXTURES,
        onResult: () => undefined,
      });
      pools.push(pool);
      await within(60_000, 'the pool to start', pool.start());
      let samples = 0;
      let high = 0;
      const sampler = setInterval(() => {
        const { busy, size } = pool.stats();
        samples += 1;
        if (size > 0 && busy / size >= 0.8) high += 1;
      }, 7);
      let sensor = 0;
      try {
        for (let burst = 0; burst < BURSTS; burst += 1) {
          for (let i = 0; i < 13; i += 1) {
            sensor += 1;
            pool.submit({
              sensorId: sensor,
              sensorType: 'test.slow',
              target: { host: '192.0.2.1', ipVersion: 'auto' as const },
              params: { delayMs: 20 + 5 * i },
              timeoutMs: 10_000,
            });
          }
          await sleep(PERIOD_MS);
        }
      } finally {
        clearInterval(sampler);
      }
      const stats = pool.stats();
      await within(30_000, 'the pool to stop', pool.stop());
      return { share: high / Math.max(1, samples), samples, size: stats.size };
    };
    const grew = await arm(0);
    const waited = await arm(undefined);
    t.diagnostic(
      `grown on sight: ${(grew.share * 100).toFixed(1)}% of ${String(grew.samples)} samples at ` +
        `80% or more, ${String(grew.size)} workers; waited: ${(waited.share * 100).toFixed(1)}% of ` +
        `${String(waited.samples)}, ${String(waited.size)} workers`,
    );
    // A worker fewer keeps the pool at 80% or more until four of twelve have finished, the first
    // refilled by the straggler, rather than three of thirteen: about 35 ms of each burst rather
    // than 30. Bounded well under a doubling.
    assert.ok(
      waited.share <= grew.share * 1.5 + 0.05,
      `${(waited.share * 100).toFixed(1)}% against ${(grew.share * 100).toFixed(1)}%`,
    );
  });
});
