import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CheckFlowWatchdog } from '../src/health/check-flow.js';

/**
 * Whether the probe is getting back the checks it dispatches (`P-76`).
 *
 * The clock is injected and monotonic, so none of this waits five minutes — the same way
 * `TimingWheel`'s tests drive the wheel. What these pin is the pair of clauses: something stuck
 * far past its timeout is necessary, and nothing having completed since it was dispatched is what
 * makes it a stopped runner rather than one slow check among many that are working.
 */

function harness(options: { stallAfterMs?: number; intervals?: Record<number, number> } = {}) {
  let ns = 1_000_000_000n;
  const watchdog = new CheckFlowWatchdog({
    stallAfterMs: options.stallAfterMs ?? 300_000,
    nowNs: () => ns,
    intervalFor: (sensorId) => options.intervals?.[sensorId],
    assigned: () => assigned,
  });
  let assigned = Object.keys(options.intervals ?? {}).map(Number);
  return {
    watchdog,
    unassign: (sensorId: number): void => {
      assigned = assigned.filter((one) => one !== sensorId);
    },
    // A property rather than a shorthand method: these are destructured, and a bare method that
    // is would trip `unbound-method`.
    advance: (ms: number): void => {
      ns += BigInt(ms) * 1_000_000n;
    },
  };
}

describe('whether checks are coming back', () => {
  it('says so on a probe that has done nothing yet', () => {
    // A probe that has just started has dispatched nothing and returned nothing. Reading that as
    // a stall would alarm on every start, which is the shape of mistake `P-74`'s grace exists for.
    const { watchdog, advance } = harness();
    advance(10_000_000);
    const seen = watchdog.stats();
    assert.equal(seen.completing, 1);
    assert.equal(seen.outstanding, 0);
    assert.equal(seen.oldestOutstandingMs, 0);
  });

  it('is untroubled by a check that is merely slow', () => {
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000);
    advance(60_000);
    assert.equal(watchdog.stats().completing, 1, 'a minute is not a stall');
    assert.equal(watchdog.stats().outstanding, 1);
    watchdog.completed(1);
    assert.equal(watchdog.stats().outstanding, 0);
  });

  it('says the runners have stopped when nothing comes back at all', () => {
    // The provable fault: a check accepted by a runner *must* settle — both runners emit a result
    // on timeout, on a worker dying and on stop — so one outstanding far past any timeout, with
    // nothing else completing, is a runner that has stopped rather than a slow network.
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000);
    advance(300_001);
    const seen = watchdog.stats();
    assert.equal(seen.completing, 0);
    assert.ok(seen.oldestOutstandingMs >= 300_000);
  });

  it('is not a stall while other checks keep completing', () => {
    // **The second clause, and the reason it exists.** One check wedged in flight while the rest
    // of the probe works is that check's problem, and its own timeout will settle it. Calling the
    // whole probe stalled for it would raise an alarm about a probe that is working.
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000);
    advance(200_000);
    watchdog.dispatched(2, 30_000);
    watchdog.completed(2);
    advance(200_000);

    const seen = watchdog.stats();
    assert.ok(seen.oldestOutstandingMs > 300_000, 'sensor 1 is long overdue');
    assert.equal(seen.completing, 1, 'but the runners are plainly returning things');
  });

  it('recovers the moment anything completes', () => {
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000);
    advance(300_001);
    assert.equal(watchdog.stats().completing, 0);

    watchdog.completed(1);
    assert.equal(watchdog.stats().completing, 1);
    assert.equal(watchdog.stats().outstanding, 0);
  });

  it('counts an error as a completion, because the runner came back', () => {
    // `completed` is called for every settled check whatever its outcome. A probe returning
    // nothing but failures is not stalled — it is monitoring, and reporting bad news.
    const { watchdog, advance } = harness();
    for (let i = 0; i < 5; i += 1) {
      watchdog.dispatched(i, 30_000);
      advance(70_000);
      watchdog.completed(i);
    }
    assert.equal(watchdog.stats().completing, 1);
  });

  it('counts the sensors that are behind their own interval, not the probe’s', () => {
    // The number that says *how much* of a probe is affected while the probe itself works — which
    // is the case `P-74` is structurally unable to see.
    const { watchdog, advance } = harness({ intervals: { 1: 60, 2: 60, 3: 3_600 } });
    watchdog.dispatched(1, 30_000);
    watchdog.completed(1);
    watchdog.dispatched(2, 30_000);
    watchdog.completed(2);
    watchdog.dispatched(3, 30_000);
    watchdog.completed(3);

    advance(120_000);
    assert.equal(watchdog.stats().behind, 0, 'two minutes is within four minutes');

    advance(180_000);
    const seen = watchdog.stats();
    assert.equal(seen.behind, 2, 'the two 60 s sensors are behind; the hourly one is not');
  });

  it('stops counting a sensor that is no longer assigned', () => {
    // `behind` is driven by the assignments rather than by what has completed (`P-77`), so a
    // sensor stops counting by *leaving* them. `forget` releases its memory and is not what
    // decides this — which is the right way round: the assignment list is the truth about what
    // this probe is supposed to be checking.
    const { watchdog, advance, unassign } = harness({ intervals: { 1: 60, 2: 60 } });
    watchdog.dispatched(1, 30_000);
    watchdog.completed(1);
    advance(300_000);
    assert.equal(watchdog.stats().behind, 2);

    unassign(1);
    assert.equal(watchdog.stats().behind, 1, 'an unassigned sensor is not behind, it is gone');
    watchdog.forget(1);
    assert.equal(watchdog.stats().behind, 1, 'and forgetting it changes nothing but memory');
  });

  it('is not disabled for ever by one check that never settles', () => {
    // **`P-77`.** The predicate used to compare the last completion against the *oldest*
    // outstanding, so a check that never comes back pinned that comparison: every later
    // completion made it false, permanently, and no subsequent stall could ever be seen. One
    // leaked entry silently switched the detector off for the life of the process.
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000); // leaks: never completes
    advance(600_000);
    assert.equal(watchdog.stats().completing, 0, 'stalled while nothing else is happening');

    // Traffic resumes and runs normally for a while. The leaked check is still outstanding.
    for (let i = 2; i < 8; i += 1) {
      watchdog.dispatched(i, 30_000);
      advance(10_000);
      watchdog.completed(i);
    }
    assert.equal(watchdog.stats().completing, 1, 'plainly working again');

    // Now everything stops. The leaked check must not stop this being seen.
    watchdog.dispatched(9, 30_000);
    advance(600_000);
    assert.equal(watchdog.stats().completing, 0, 'a later stall is still visible');
  });

  it('does not call a check late for taking the time it was given', () => {
    // A check may legally be configured to run longer than the stall window. Reporting it as a
    // stall for doing exactly what it was told would alarm on correct configuration.
    const { watchdog, advance } = harness({ stallAfterMs: 60_000 });
    watchdog.dispatched(1, 300_000);
    advance(120_000);
    assert.equal(watchdog.stats().completing, 1, 'twice the window, well inside its own timeout');

    advance(500_000);
    assert.equal(watchdog.stats().completing, 0, 'past twice its own timeout, it is overdue');
  });

  it('counts a sensor that has never completed at all as behind', () => {
    // **The worst case used to read best.** `behind` iterated completions, so a probe where
    // nothing has *ever* come back had nothing to iterate and reported 0 — for a probe that was
    // 100% behind. It counts the assigned set now.
    const { watchdog, advance } = harness({ intervals: { 1: 60, 2: 60, 3: 60 } });
    advance(300_000);
    assert.equal(watchdog.stats().behind, 3, 'none of the three has ever reported');

    watchdog.dispatched(1, 30_000);
    watchdog.completed(1);
    assert.equal(watchdog.stats().behind, 2);
  });

  it('keeps the older timestamp if a sensor is somehow dispatched twice', () => {
    // Both runners refuse a re-dispatch with `already-running`, so this cannot happen — and if it
    // ever did, the older stamp is the safe way round, because it is the one that reveals a stall.
    const { watchdog, advance } = harness();
    watchdog.dispatched(1, 30_000);
    advance(300_001);
    watchdog.dispatched(1, 30_000);
    assert.equal(watchdog.stats().completing, 0, 'the second dispatch must not reset the clock');
  });
});
