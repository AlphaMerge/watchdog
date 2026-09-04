import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import type { ResultMeta } from '../src/runner/types.js';
import { resultSink } from '../src/result-sink.js';

const silent = pino({ level: 'silent' });

/**
 * The one sink every settled check goes through (`P-83`).
 *
 * `check-flow.test.ts` has a test named "counts an error as a completion, because the runner came
 * back". It could not be true: `CheckFlowWatchdog.completed(sensorId)` takes no outcome, so that
 * test calls it five times and watches a counter — it would pass identically against a `completed`
 * that ignored outcomes, which is what it has. The property lives here, in the unconditional call
 * this sink makes, and it lived inside `main()` where nothing could assert it.
 */

const meta = (phase: ResultMeta['phase']): ResultMeta => ({ phase, waitMs: 0, workerId: 1 });

const result = (sensorId: number, outcome: CheckResult['outcome']): CheckResult => ({
  sensorId,
  at: new Date('2026-09-04T10:00:00.000Z').toISOString(),
  outcome,
  message: outcome === 'ok' ? 'fine' : 'connection refused',
  durationMs: 3,
  channels: outcome === 'ok' ? [{ key: 'rtt', value: 12 }] : [],
});

function sinkOver(options: { appendFails?: boolean } = {}) {
  const completed: number[] = [];
  const appended: number[] = [];
  let woken = 0;
  const sink = resultSink({
    logger: silent,
    spool: {
      append: (results) => {
        if (options.appendFails === true) return Promise.reject(new Error('disk full'));
        appended.push(...results.map((one) => one.sensorId));
        return Promise.resolve();
      },
    },
    drain: {
      wake: () => {
        woken += 1;
      },
    },
    checkFlow: {
      completed: (sensorId) => completed.push(sensorId),
    },
  });
  return { sink, completed, appended, woken: () => woken };
}

describe('the result sink', () => {
  it('counts an error as a completion, because the runner came back', () => {
    // **The property, asserted where it can be.** A probe watching a network segment that has gone
    // down returns nothing but errors. Those are completions: the runner ran, timed out or failed,
    // and came back. Treating them as silence freezes the stall clock and raises a Warning on
    // `ms.probe.checks` for a probe that is monitoring correctly and reporting bad news — on top
    // of the sensors' own Down alarms, which is a second alarm for one outage.
    const { sink, completed } = sinkOver();
    sink(result(1, 'ok'), meta('execute'));
    sink(result(1, 'error'), meta('execute'));
    sink(result(1, 'error'), meta('timeout'));
    sink(result(1, 'error'), meta('worker-crash'));
    assert.deepEqual(
      completed,
      [1, 1, 1, 1],
      'every outcome and every phase, not just the good one',
    );
  });

  it('tells the watchdog before it tries the disk, not after', () => {
    // Ordering, and it is load-bearing: a spool that cannot be written must not also cost the
    // watchdog its evidence that checks are settling. The two failures are unrelated and
    // `spoolUnwritten` (`P-78`) is what reports the second one.
    const { sink, completed } = sinkOver({ appendFails: true });
    sink(result(7, 'error'), meta('timeout'));
    assert.deepEqual(completed, [7], 'counted even though the write is going to fail');
  });

  it('spools the result and wakes the drain', async () => {
    const { sink, appended, woken } = sinkOver();
    sink(result(3, 'ok'), meta('execute'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(appended, [3]);
    assert.equal(woken(), 1, 'so a reachable core gets it immediately rather than on a timer');
  });

  it('survives a spool that cannot be written, rather than taking the probe down', async () => {
    // The callback runs on the scheduler's own thread. An unhandled rejection here would be a
    // check failure turning into a process failure.
    const { sink, completed } = sinkOver({ appendFails: true });
    sink(result(9, 'ok'), meta('execute'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(completed, [9]);
  });
});
