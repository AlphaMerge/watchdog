import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { CheckPool } from '../../src/runner/pool.js';
import { poolDemand, type DemandInput } from '../../src/runner/demand.js';
import { V1_TARGET_SENSORS, V1_TARGET_INTERVAL_SECONDS } from '../../src/measured.js';
import { pollWithin } from '../support/within.js';

/**
 * What one pass of the auto-sizing loop costs (`P-48`).
 *
 * **This budget exists because its absence hid a real defect.** No `test:perf` suite exercised
 * `poolSizer`, `poolDemand` or `typicalDurationMs` — the probe's perf tests all pin `CheckPool` to
 * a fixed size — so nothing measured the loop that runs on the probe's own thread every thirty
 * seconds. It was calling `typicalDurationMs` once per *assignment* rather than once per type,
 * each call slicing, mapping and sorting a window of up to 1,024 samples: **426.8 ms** for one
 * pass at the v1 target, against 0.146 ms for the same arithmetic with a constant duration.
 *
 * The wheel fires once a second, so that pass swallowed a whole tick's dispatch, and CLAUDE.md's
 * rule is that nothing blocks the scheduler. `schedulerLag` would not have caught it either: it is
 * reported as a p95, and a stall on one tick in thirty lands in the p99.
 *
 * **The budget is a ceiling, not the measurement.** 50 ms is about 44x the 1.13 ms this measures
 * after the fix and about 8.5x under the 427 ms defect it would have caught — loose enough to
 * survive a loaded machine, tight enough that the regression it exists for cannot hide. The
 * numbers themselves belong in `docs/findings/2026-09-04-autosize-loop.md`.
 */

const silent = pino({ level: 'silent' });
const FIXTURES = join(import.meta.dirname, '..', 'support', 'check-fixtures.js');

/** A pass must stay far below the one-second tick it shares a thread with. */
const BUDGET_MS = 50;
const PASSES = 20;
/** Completed checks to measure: about the 1,024 samples the duration window holds. */
const WINDOW = 1_000;

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

describe('one sizing pass at the v1 target (P-48)', () => {
  it(`sums ${String(V1_TARGET_SENSORS)} assignments in well under a tick`, async () => {
    const pool = new CheckPool({
      logger: silent,
      size: 16,
      minSize: 16,
      registryModule: FIXTURES,
      onResult: () => {},
    });
    pools.push(pool);
    await pool.start();

    // Real measured durations rather than an empty window, because an empty one is the cheap case:
    // `typicalDurationMs` returns immediately when it has nothing, so a pass over a fresh probe
    // would measure the arithmetic and miss the sort entirely.
    //
    // **Submitted until enough are accepted, topped up as the queue drains** (`P-378`). Fifteen
    // hundred submitted at once left the pool's bounded queue to refuse all but 1,016, sixteen to
    // spare: a smaller queue or pool would have left the poll waiting 30 s for a count no check
    // still in flight could reach. A refusal is `queue-full`, and anything else is the pool
    // giving up, which is said at once rather than waited out.
    let submitted = 0;
    let accepted = 0;
    const topUp = (): void => {
      while (accepted < WINDOW) {
        submitted += 1;
        const outcome = pool.submit({
          sensorId: submitted,
          sensorType: 'test.slow',
          target: { host: '192.0.2.1', ipVersion: 'auto' },
          params: { delayMs: 1 },
          timeoutMs: 5_000,
        });
        if (outcome === 'queue-full') return;
        assert.equal(outcome, 'accepted', `check ${String(submitted)} was not run: ${outcome}`);
        accepted += 1;
      }
    };
    await pollWithin(
      30_000,
      () =>
        `enough completed checks to fill the window, ${String(WINDOW)}; ` +
        `${String(accepted)} accepted, ${String(pool.stats().completed)} completed`,
      () => {
        topUp();
        return pool.stats().completed >= WINDOW;
      },
      100,
    );

    const assignments: DemandInput[] = Array.from({ length: V1_TARGET_SENSORS }, () => ({
      sensorType: 'test.slow',
      intervalSeconds: V1_TARGET_INTERVAL_SECONDS,
    }));
    const options = { fallbackMs: 600, min: 64, max: 256, margin: 1.3 };
    const typical = (type: string): number | undefined => pool.typicalDurationMs(type);

    for (let i = 0; i < 3; i += 1) poolDemand(assignments, typical, options);

    const runs: number[] = [];
    for (let i = 0; i < PASSES; i += 1) {
      const started = process.hrtime.bigint();
      poolDemand(assignments, typical, options);
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)] ?? 0;
    const worst = runs[runs.length - 1] ?? 0;

    process.stdout.write(
      `  sizing pass over ${String(V1_TARGET_SENSORS)} assignments: ` +
        `median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms ` +
        `(budget ${String(BUDGET_MS)} ms)\n`,
    );

    assert.ok(
      median < BUDGET_MS,
      `a sizing pass took ${median.toFixed(1)} ms against a ${String(BUDGET_MS)} ms budget; ` +
        'it runs on the probe thread against a one-second tick',
    );
  });
});
