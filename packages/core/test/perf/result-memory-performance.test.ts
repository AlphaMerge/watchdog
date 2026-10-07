import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { UnfitResults } from '@ms/shared';
import type { Database } from '../../src/db/pool.js';
import type { Ingestor } from '../../src/ingestion/ingestor.js';
import { RESULTS_REMEMBERED } from '../../src/ingestion/result-memory.js';
import { IngestionService } from '../../src/ingestion/service.js';
import { silent } from '../support/tree.js';

/**
 * Counting a million refused results once each, with the memory full (`P-295` review).
 *
 * Since `P-295` every refusal a probe's batch carries (a deleted, moved or foreign sensor, an
 * unfit result, an unearned mark) is remembered by probe, sensor and time, synchronously inside
 * the batch's acceptance, on the core's event loop. A spool draining after a delete or a move
 * keeps a probe's set full, so what each new key costs to evict is what a batch costs. Deleting
 * the oldest key for every one added walked past V8's holes each time: about 43 ms a batch of
 * 5,000, 98 ms at worst, measured outside the repo. Trimmed a tenth at once it is a few.
 *
 * Driven through `IngestionService.unfitResults`, which counts through the same `#firstCount`
 * as `#refuse` and the unearned mark, and touches neither the database nor the ingestor: both
 * are stand-ins that throw if anything reaches them.
 */
const BATCH = 5_000;
const BATCHES = 200;
/**
 * The mean a batch of 5,000 may cost. The per-key eviction measured about 43 ms; the trim a few.
 * Generous for a loaded VM and still well under what it replaced.
 */
const BUDGET_MS = 15;

const unreachable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('counting refusals reached the database or the ingestor');
    },
  },
);

describe('counting refused results once, with the memory full', () => {
  it('costs a batch of 5,000 a few milliseconds, not tens', () => {
    const ingestion = new IngestionService({
      db: unreachable as Database,
      logger: silent,
      ingestor: unreachable as Ingestor,
    });
    const origin = { gid: 'draining-probe', probeObjectId: null };
    const base = Date.parse('2026-10-08T09:00:00.000Z');
    let next = 0;
    const batch = (): UnfitResults => ({
      refused: Array.from({ length: BATCH }, () => {
        const n = next;
        next += 1;
        return {
          sensorId: 1_000 + (n % 5_000),
          at: new Date(base + n * 1_000).toISOString(),
          reason: '/outcome: must be equal to one of the allowed values',
        };
      }),
      fitted: [],
    });

    // Full before anything is measured, as a drain that has been going a while is.
    const filling = Math.ceil((RESULTS_REMEMBERED * 1.1) / BATCH) + 1;
    for (let at = 0; at < filling; at += 1) ingestion.unfitResults(origin, batch());
    const full = ingestion.stats().resultsRemembered;
    assert.ok(full >= RESULTS_REMEMBERED, `filled to ${String(full)}`);

    const batches = Array.from({ length: BATCHES }, batch);
    const times: number[] = [];
    const counted = ingestion.stats().refusedUnfit;
    for (const one of batches) {
      const started = process.hrtime.bigint();
      ingestion.unfitResults(origin, one);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    assert.equal(ingestion.stats().refusedUnfit - counted, BATCH * BATCHES, 'every one counted');
    assert.ok(ingestion.stats().resultsRemembered <= RESULTS_REMEMBERED * 1.1);

    const total = times.reduce((sum, one) => sum + one, 0);
    const mean = total / BATCHES;
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(BATCHES / 2)] ?? Number.NaN;
    const worst = sorted.at(-1) ?? Number.NaN;
    process.stdout.write(
      `\n    measured, ${(BATCH * BATCHES).toLocaleString('en-GB')} refused results counted ` +
        `with ${full.toLocaleString('en-GB')} remembered:\n` +
        `      ${(total / 1_000).toFixed(2)} s in all; a batch of ${BATCH.toLocaleString('en-GB')} ` +
        `mean ${mean.toFixed(1)} ms, median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms\n`,
    );
    assert.ok(
      mean < BUDGET_MS,
      `a batch took ${mean.toFixed(1)} ms on average; the budget is ${String(BUDGET_MS)}`,
    );
  });
});
