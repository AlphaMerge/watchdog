import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { SensorAssignment } from '@ms/shared';
import { AssignmentStore, type ConfigUpdate } from '../src/scheduler/assignments.js';
import { TimingWheel } from '../src/scheduler/wheel.js';

const silent = pino({ level: 'silent' });
const SECOND = 1_000_000_000n;

const assignment = (id: number, over: Partial<SensorAssignment> = {}): SensorAssignment => ({
  sensorId: id,
  sensorType: 'icmp.ping',
  params: { count: 4 },
  target: { host: `192.0.2.${String(id)}`, ipVersion: 'auto' },
  intervalSeconds: 60,
  timeoutMs: 30_000,
  ...over,
});

function harness() {
  let ns = 0n;
  const fired: number[][] = [];
  const wheel = new TimingWheel({
    logger: silent,
    onDue: (ids) => fired.push([...ids]),
    now: () => ns,
    wallNow: () => 1_700_000_000_000,
  });
  const store = new AssignmentStore(wheel);

  return {
    store,
    wheel,
    /** Every id that came due over the next `seconds`, in order. */
    run: (seconds: number): number[] => {
      const from = fired.length;
      for (let i = 0; i < seconds; i += 1) {
        ns += SECOND;
        wheel.advance();
      }
      return fired.slice(from).flat();
    },
  };
}

const set = (sensors: SensorAssignment[]): ConfigUpdate => ({ kind: 'set', version: 'v', sensors });

describe('assignment store', () => {
  it('schedules everything in a snapshot and says how many', () => {
    const { store, wheel } = harness();
    assert.equal(store.apply(set([assignment(1), assignment(2)])), 2);
    assert.deepEqual(store.ids(), [1, 2]);
    assert.equal(wheel.stats().tasks, 2);
  });

  it('treats a snapshot as authoritative and drops what is missing from it', () => {
    // The case a device moved to another probe: the sensor is not "removed", it is simply not
    // in this probe's world any more, and only a snapshot says so.
    const { store, wheel } = harness();
    store.apply(set([assignment(1), assignment(2), assignment(3)]));
    store.apply(set([assignment(2)]));

    assert.deepEqual(store.ids(), [2]);
    assert.equal(wheel.stats().tasks, 1, 'the wheel must not keep firing a sensor we dropped');
  });

  it('applies a delta without touching what it did not mention', () => {
    const { store } = harness();
    store.apply(set([assignment(1), assignment(2), assignment(3)]));

    const count = store.apply({
      kind: 'delta',
      version: 'v2',
      upserted: [assignment(2, { params: { count: 9 } }), assignment(4)],
      removed: [3],
    });

    assert.equal(count, 3);
    assert.deepEqual(store.ids(), [1, 2, 4]);
    assert.deepEqual(store.get(2)?.params, { count: 9 }, 'the update was applied');
    assert.deepEqual(store.get(1)?.params, { count: 4 }, 'and sensor 1 was left alone');
  });

  it('does not re-phase a sensor whose interval did not change', () => {
    // Re-arming resets the phase. A push that re-sent every assignment unchanged would bunch
    // them all onto the tick it happened to arrive on — the stampede the phase offset exists to
    // prevent (ADR-001 Decision 2).
    const { store, run } = harness();
    store.apply(set([assignment(1, { intervalSeconds: 5 })]));
    const before = run(20);

    store.apply(set([assignment(1, { intervalSeconds: 5, params: { count: 9 } })]));
    const afterwards = run(20);

    assert.deepEqual(
      afterwards.length,
      before.length,
      'the same number of firings in the same window',
    );
  });

  it('re-arms a sensor whose interval did change', () => {
    const { store, run } = harness();
    store.apply(set([assignment(1, { intervalSeconds: 20 })]));
    assert.equal(run(10).length, 0, 'nothing due yet at a 20-second interval');

    store.apply(set([assignment(1, { intervalSeconds: 2 })]));
    assert.ok(run(10).length >= 4, 'the new interval took effect');
  });

  it('removing a sensor stops it firing', () => {
    const { store, run } = harness();
    store.apply(set([assignment(1, { intervalSeconds: 2 })]));
    assert.ok(run(6).length > 0);

    store.apply({ kind: 'delta', version: 'v2', upserted: [], removed: [1] });
    assert.deepEqual(run(10), [], 'a removed sensor must never come due again');
  });

  it('an empty snapshot clears everything', () => {
    const { store, wheel } = harness();
    store.apply(set([assignment(1), assignment(2)]));
    assert.equal(store.apply(set([])), 0);
    assert.equal(wheel.stats().tasks, 0);
  });

  it('ignores a removal for something it never had', () => {
    const { store } = harness();
    store.apply(set([assignment(1)]));
    assert.equal(store.apply({ kind: 'delta', version: 'v2', upserted: [], removed: [99] }), 1);
  });
});
