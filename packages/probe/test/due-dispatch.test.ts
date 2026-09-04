import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SensorAssignment } from '@ms/shared';
import { NotificationRing } from '../src/listeners/ring.js';
import { dueDispatcher, type DueRunner } from '../src/due-dispatch.js';
import type { CheckRequest } from '../src/runner/types.js';
import type { SubmitOutcome } from '../src/runner/pool.js';

const TRAP = 'snmp-trap';

const assignment = (id: number, sensorType: string): SensorAssignment => ({
  sensorId: id,
  sensorType,
  params: {},
  target: { host: '192.0.2.1', ipVersion: 'auto' },
  intervalSeconds: 60,
  timeoutMs: 30_000,
});

/** A runner that answers whatever the test tells it to, and records what it was handed. */
function runner(verdict: SubmitOutcome): DueRunner & { seen: CheckRequest[] } {
  const seen: CheckRequest[] = [];
  return {
    seen,
    accepts: () => verdict === 'accepted',
    submit: (request) => {
      seen.push(request);
      return verdict;
    },
  };
}

function harness(verdict: SubmitOutcome, sensorType = 'snmp.trap') {
  const ring = new NotificationRing(100);
  const pool = runner(verdict);
  const processRunner = runner(verdict);
  const dispatched: { sensorId: number; timeoutMs: number; runner: string }[] = [];
  const dispatch = dueDispatcher({
    assignments: { get: (id) => (id === 1 ? assignment(1, sensorType) : undefined) },
    listenerFor: new Map([['snmp.trap', TRAP]]),
    listeners: new Map([[TRAP, { drain: (id: number) => ring.drain(id, TRAP) }]]),
    isolated: new Set(['exe.script']),
    pool,
    processRunner,
    onDispatch: (sensorId, timeoutMs, runnerName) => {
      dispatched.push({ sensorId, timeoutMs, runner: runnerName });
    },
  });
  const push = (n: number): void => {
    for (let i = 0; i < n; i += 1) {
      ring.push({
        at: new Date().toISOString(),
        source: '192.0.2.9',
        text: 'link down',
        detail: {},
      });
    }
  };
  return { dispatch, ring, pool, processRunner, push, dispatched };
}

/**
 * `P-57`: draining is destructive, so it must not happen for a check that is then refused.
 *
 * `NotificationRing.drain` advances the cursor whether or not the caller uses what it returns.
 * Draining before submitting therefore threw the batch away every time the runner answered
 * `already-running` — the ordinary answer when the previous scan is still going (`WORKFLOW.MD §3`),
 * which for a syslog or trap sensor is exactly what happens under the flood the sensor exists to
 * report.
 */
describe('handing a due listener sensor its notifications (P-57)', () => {
  it('drains into the check when the runner takes it', () => {
    const h = harness('accepted');
    h.ring.drain(1, TRAP); // register the cursor, as a first scan does
    h.push(3);

    h.dispatch([1]);

    assert.equal(h.pool.seen.length, 1);
    assert.equal(h.pool.seen[0]?.received?.items.length, 3, 'the batch travels with the check');
  });

  it('leaves them in the ring when the check is deferred', () => {
    const h = harness('already-running');
    h.ring.drain(1, TRAP);
    h.push(3);

    h.dispatch([1]);

    // Still submitted, so the deferral is counted and reaches Probe Health...
    assert.equal(h.pool.seen.length, 1, 'the deferral is still offered, so it is still counted');
    assert.equal(h.pool.seen[0]?.received, undefined, 'and carries nothing');

    // ...and the messages are still there for the scan that does get through.
    const next = h.ring.drain(1, TRAP);
    assert.equal(next.items.length, 3, 'the three messages survived the deferral');
    assert.equal(next.dropped, 0);
  });

  it('leaves them in the ring when the queue is full', () => {
    const h = harness('queue-full');
    h.ring.drain(1, TRAP);
    h.push(2);

    h.dispatch([1]);

    assert.equal(h.ring.drain(1, TRAP).items.length, 2, 'a refusal is not a reason to lose them');
  });

  it('sends an isolated sensor type to the process runner', () => {
    const h = harness('accepted', 'exe.script');
    h.dispatch([1]);

    assert.equal(h.processRunner.seen.length, 1);
    assert.equal(h.pool.seen.length, 0);
  });

  it('tells the watchdog which runner took the check, not merely that one did', () => {
    // **`P-82`'s wiring, which the rule's own tests cannot reach.** `CheckFlowWatchdog` judges each
    // runner against its own completions now, and this is the only place that knows which runner
    // a check went to — both settle into one sink that cannot say. A label that was always 'pool'
    // would restore the exact defect `P-82` fixed, silently, with every check-flow test still
    // green because they pass the label themselves.
    const worker = harness('accepted');
    worker.dispatch([1]);
    assert.deepEqual(
      worker.dispatched.map((one) => one.runner),
      ['pool'],
    );

    const isolated = harness('accepted', 'exe.script');
    isolated.dispatch([1]);
    assert.deepEqual(
      isolated.dispatched.map((one) => one.runner),
      ['process'],
    );
  });

  it('tells it nothing at all about a check that was not accepted', () => {
    // A deferral was never dispatched, so counting it would make backpressure look like a stall —
    // the reason `onDispatch` fires only on `accepted`.
    const h = harness('already-running');
    h.dispatch([1]);
    assert.deepEqual(h.dispatched, []);
  });

  it('skips a due sensor the store no longer holds', () => {
    const h = harness('accepted');
    h.dispatch([2]);

    assert.equal(h.pool.seen.length, 0, 'a tick can outlive a removal');
  });
});
