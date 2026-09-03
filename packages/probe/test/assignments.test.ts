import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { SensorAssignment } from '@ms/shared';
import { AssignmentStore, type ConfigUpdate } from '../src/scheduler/assignments.js';
import { poolDemand } from '../src/runner/demand.js';
import { NotificationRing } from '../src/listeners/ring.js';
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

/**
 * What the store holds *during* a chunked push, and why anything reading it must wait (`P-41`).
 *
 * `P-28` sends a full configuration as a `config-set` followed by deltas carrying the same
 * version, because one message for five thousand sensors exceeded the frame bound and left the
 * probe unable to reconnect at all. The consequence is that a set is authoritative over a
 * *fraction*: between the first chunk and the last, this store legitimately holds far fewer
 * sensors than the probe has been assigned.
 *
 * That is correct, and it is a trap for anything that derives a decision from the store on every
 * message rather than once the push has settled — which the pool sizer did.
 */
describe('a chunked configuration push (P-41)', () => {
  it('holds only the first chunk until the deltas arrive', () => {
    const { store } = harness();
    const all = Array.from({ length: 500 }, (_, i) => assignment(i + 1));

    // Chunk one, as a set: authoritative, and therefore a claim that these are all of them.
    assert.equal(store.apply(set(all.slice(0, 100))), 100);

    // The rest, as deltas.
    for (let offset = 100; offset < all.length; offset += 100) {
      store.apply({
        kind: 'delta',
        version: 'v',
        upserted: all.slice(offset, offset + 100),
        removed: [],
      });
    }
    assert.equal(store.size, 500, 'complete once the push has finished');
  });

  it('makes the pool sizer read a workload that does not exist, mid-push', () => {
    // **The measured shape of the trap.** A probe whose checks take two seconds needs a large
    // pool; after the first chunk the same arithmetic asks for the floor. Two such readings are
    // a drop under `P-40`, and a drop sheds at once under `P-39` — workers destroyed and then
    // asked for again three chunks later.
    const { store } = harness();
    const all = Array.from({ length: 3_000 }, (_, i) => assignment(i + 1));
    const options = { fallbackMs: 2_000, min: 64, max: 256, margin: 1.3 };
    const ceilingNow = (): number => poolDemand(store.values(), () => 2_000, options).ceiling;

    store.apply(set(all.slice(0, 500)));
    const partial = ceilingNow();

    for (let offset = 500; offset < all.length; offset += 500) {
      store.apply({
        kind: 'delta',
        version: 'v',
        upserted: all.slice(offset, offset + 500),
        removed: [],
      });
    }
    const complete = ceilingNow();

    assert.ok(
      complete > partial * 2,
      `mid-push derived ${String(partial)} against ${String(complete)} once complete`,
    );
  });

  /**
   * The same trap, and the expensive one: sweeping listener cursors mid-push *loses traps*
   * (`P-42`).
   *
   * `retain` is memory hygiene — a sensor this probe no longer holds should stop costing a cursor.
   * Handed a fraction of the assignment set it becomes data loss instead, and silent data loss at
   * that, because a deleted cursor is indistinguishable from a sensor that has never drained.
   */
  it('makes the listener cursor sweep discard buffered notifications, mid-push', () => {
    const { store } = harness();
    const ring = new NotificationRing(1_000);
    const all = Array.from({ length: 200 }, (_, i) => assignment(i + 1));

    // Every sensor has drained once, so every one of them holds a cursor.
    store.apply(set(all));
    for (const id of store.ids()) ring.drain(id, 'snmp-trap');
    assert.equal(ring.cursors, 200);

    // Three traps arrive for sensor 150 while the core happens to be pushing a new config.
    for (let i = 0; i < 3; i++) {
      ring.push({
        at: new Date().toISOString(),
        source: '192.0.2.150',
        text: 'link down',
        detail: {},
      });
    }

    // Chunk one of that push, as a set — authoritative over a fraction.
    store.apply(set(all.slice(0, 100)));
    ring.retain(store.ids());
    assert.equal(ring.cursors, 100, 'sensor 150 has lost its cursor to a chunk boundary');

    // The rest of the push arrives and sensor 150 is assigned again, as it always was.
    store.apply({ kind: 'delta', version: 'v', upserted: all.slice(100), removed: [] });
    assert.equal(store.size, 200);

    const batch = ring.drain(150, 'snmp-trap');
    assert.deepEqual(batch.items, [], 'the three traps are gone');
    assert.equal(
      batch.dropped,
      0,
      'and reported as none dropped — the sensor cannot tell this from a quiet network',
    );
  });

  /** The other side of it: the same sweep, given the set the push settled on, keeps them. */
  it('keeps them when the sweep waits for the push to settle', () => {
    const { store } = harness();
    const ring = new NotificationRing(1_000);
    const all = Array.from({ length: 200 }, (_, i) => assignment(i + 1));

    store.apply(set(all));
    for (const id of store.ids()) ring.drain(id, 'snmp-trap');

    for (let i = 0; i < 3; i++) {
      ring.push({
        at: new Date().toISOString(),
        source: '192.0.2.150',
        text: 'link down',
        detail: {},
      });
    }

    // The whole push, with no sweep in the middle of it.
    store.apply(set(all.slice(0, 100)));
    store.apply({ kind: 'delta', version: 'v', upserted: all.slice(100), removed: [] });
    ring.retain(store.ids());

    assert.equal(ring.cursors, 200);
    assert.equal(ring.drain(150, 'snmp-trap').items.length, 3, 'the three traps survive');
  });

  /** And it still does the job it exists for: a sensor genuinely gone stops costing a cursor. */
  it('still drops the cursor of a sensor the settled push removed', () => {
    const { store } = harness();
    const ring = new NotificationRing(1_000);
    const all = Array.from({ length: 200 }, (_, i) => assignment(i + 1));

    store.apply(set(all));
    for (const id of store.ids()) ring.drain(id, 'snmp-trap');

    // A device moved to another probe: sensor 150 is absent from the settled set, not from a chunk.
    store.apply(set(all.filter((a) => a.sensorId !== 150)));
    ring.retain(store.ids());

    assert.equal(ring.cursors, 199);
  });
});
