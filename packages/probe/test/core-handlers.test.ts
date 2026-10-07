import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import type { SensorAssignment } from '@ms/shared';
import { AssignmentStore, type ConfigUpdate } from '../src/scheduler/assignments.js';
import { TimingWheel } from '../src/scheduler/wheel.js';
import { coreHandlers, type CoreHandlerDeps, type CursorSweeper } from '../src/core-handlers.js';
import { NotificationRing } from '../src/listeners/ring.js';

const silent = pino({ level: 'silent' });
const SETTLE_MS = 5;
/** Comfortably past the settle without making the suite wait on it. */
const settled = (): Promise<void> => delay(SETTLE_MS * 8);

const assignment = (id: number): SensorAssignment => ({
  sensorId: id,
  sensorType: 'icmp.ping',
  params: { count: 4 },
  target: { host: `192.0.2.${String(id)}`, ipVersion: 'auto' },
  intervalSeconds: 60,
  timeoutMs: 30_000,
});

const set = (sensors: SensorAssignment[]): ConfigUpdate => ({ kind: 'set', version: 'v', sensors });
const delta = (sensors: SensorAssignment[]): ConfigUpdate => ({
  kind: 'delta',
  version: 'v',
  upserted: sensors,
  removed: [],
});

/** Records what it was told to keep, so a test can assert on *when* as well as on what. */
function sweeper(): CursorSweeper & { sweeps: number[][]; complete: boolean[] } {
  const sweeps: number[][] = [];
  const complete: boolean[] = [];
  return {
    sweeps,
    complete,
    retain: (ids, whole) => {
      sweeps.push([...ids]);
      complete.push(whole);
    },
  };
}

function harness(over: Partial<CoreHandlerDeps> = {}) {
  const wheel = new TimingWheel({
    logger: silent,
    onDue: () => {},
    now: () => 0n,
    wallNow: () => 1_700_000_000_000,
  });
  const store = new AssignmentStore(wheel, { onAdd: () => undefined, onDrop: () => undefined });
  const traps = sweeper();
  const syslog = sweeper();
  const calls: string[] = [];
  const runner = (name: string) => ({
    start: (job: { runId: number }) => calls.push(`${name}.start:${String(job.runId)}`),
    cancel: (runId: number) => calls.push(`${name}.cancel:${String(runId)}`),
  });

  let sized = 0;
  let woken = 0;
  const handlers = coreHandlers({
    logger: silent,
    assignments: store,
    listeners: [traps, syslog],
    sizePool: () => {
      sized += 1;
    },
    wakeDrain: () => {
      woken += 1;
    },
    // The runners take their own job shapes; only `runId` is read here.
    sweeps: runner('sweep'),
    identifications: runner('identify'),
    queries: {
      run: (queryId, _query, timeoutMs) => calls.push(`query.run:${queryId}:${String(timeoutMs)}`),
      cancel: (queryId) => calls.push(`query.cancel:${queryId}`),
    },
    settleMs: SETTLE_MS,
    ...over,
  });

  return {
    handlers,
    store,
    traps,
    syslog,
    calls,
    sized: () => sized,
    woken: () => woken,
  };
}

/**
 * The regression suite for `P-41` and `P-42`, and the reason `P-43` moved this out of `main()`.
 *
 * Both bugs were decisions derived from `AssignmentStore` on every config message instead of once
 * the push had settled, they were four lines apart, and neither was pinnable while the policy was
 * written inline in a five-hundred-line bootstrap that nothing imports. These are the assertions
 * that were not previously possible to write.
 */
describe('config push handling (P-41, P-42, P-43)', () => {
  it('sweeps no cursors and sizes nothing while a chunked push is still arriving', async () => {
    const h = harness();
    const all = Array.from({ length: 300 }, (_, i) => assignment(i + 1));

    // `P-28` chunking: an authoritative set, then deltas carrying the rest.
    assert.equal(h.handlers.onConfig(set(all.slice(0, 100))), 100);
    assert.equal(h.traps.sweeps.length, 0, 'nothing swept on the authoritative fraction');
    assert.equal(h.sized(), 0);

    h.handlers.onConfig(delta(all.slice(100, 200)));
    h.handlers.onConfig(delta(all.slice(200)));
    assert.equal(h.traps.sweeps.length, 0, 'still nothing, mid-push');

    await settled();
    assert.equal(h.traps.sweeps.length, 1, 'one sweep, after the push');
    assert.equal(h.traps.sweeps[0]?.length, 300, 'and it saw all three hundred');
  });

  it('sweeps every listener, not just the first', async () => {
    // `P-42`'s other half: `T-20` gave the trap and syslog listeners the same `retain` and wired
    // one of them. Nothing in the code said so, and nothing could have.
    const h = harness();
    h.handlers.onConfig(set([assignment(1), assignment(2)]));
    await settled();

    assert.deepEqual(h.traps.sweeps, [[1, 2]]);
    assert.deepEqual(h.syslog.sweeps, [[1, 2]], 'the syslog listener too');
  });

  it('coalesces a burst of messages into one settle', async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) h.handlers.onConfig(delta([assignment(i + 1)]));
    await settled();

    assert.equal(h.traps.sweeps.length, 1, 'twenty messages, one sweep');
    assert.equal(h.sized(), 1, 'and one sizing');
  });

  it('still drops the cursor of a sensor the settled push removed', async () => {
    // The sweep exists to stop a deleted sensor costing a cursor for ever. Deferring it must not
    // quietly turn it off.
    const h = harness();
    h.handlers.onConfig(set([assignment(1), assignment(2), assignment(3)]));
    await settled();
    h.handlers.onConfig(set([assignment(1), assignment(3)]));
    await settled();

    assert.deepEqual(h.traps.sweeps[1], [1, 3], 'sensor 2 is gone from the settled set');
  });

  it('does not sweep after stop', async () => {
    const h = harness();
    h.handlers.onConfig(set([assignment(1)]));
    h.handlers.stop();
    await settled();

    assert.equal(h.traps.sweeps.length, 0);
    assert.equal(h.sized(), 0);
  });

  it('reports the size the core acknowledges against, per message', () => {
    // The return value is per-message and must stay that way: it is what the core acks against,
    // not a statement about the settled workload.
    const h = harness();
    assert.equal(h.handlers.onConfig(set([assignment(1), assignment(2)])), 2);
    assert.equal(h.handlers.onConfig(delta([assignment(3)])), 3);
  });
});

/**
 * `P-254`: a push that stopped arriving is not one that finished.
 *
 * A link that drops between chunks leaves the store holding chunk one, and two seconds of quiet
 * follow it as they follow a complete push. The listeners take the first set they are swept with
 * as what the probe held across a restart, so sweeping chunk one made every sensor in the chunks
 * never delivered come back on the reconnect's push as new, reading nothing of what arrived
 * before its first scan — `H-15`'s loss again — and deleted their cursors besides (`P-42`).
 */
describe('a config push cut short (P-254)', () => {
  const all = [assignment(1), assignment(2), assignment(3)];

  it('tells the listeners a cut push is incomplete, and still sizes the pool', async () => {
    const h = harness();
    h.handlers.onConfig(set(all.slice(0, 1)), false);
    await settled();
    assert.deepEqual(h.traps.sweeps, [[1]]);
    assert.deepEqual(h.traps.complete, [false], 'chunk one is not what the probe holds');
    assert.deepEqual(h.syslog.complete, [false]);
    assert.equal(h.sized(), 1, 'the pool is sized for what is running');

    // The reconnect's push, whole, because the cut one was never stamped (`R18`).
    h.handlers.onConfig(set(all), true);
    await settled();
    assert.deepEqual(h.traps.sweeps[1], [1, 2, 3]);
    assert.deepEqual(h.traps.complete, [false, true]);
  });

  it('sweeps a complete push that came as chunks, once its last arrives', async () => {
    const h = harness();
    h.handlers.onConfig(set(all.slice(0, 1)), false);
    h.handlers.onConfig(delta(all.slice(1)), true);
    await settled();
    assert.deepEqual(h.traps.sweeps, [[1, 2, 3]]);
    assert.deepEqual(h.traps.complete, [true]);
  });

  it('takes an older core’s push, which has no flag, as complete', async () => {
    const h = harness();
    h.handlers.onConfig(set(all));
    await settled();
    assert.deepEqual(h.traps.sweeps, [[1, 2, 3]]);
    assert.deepEqual(h.traps.complete, [true]);
  });

  it('leaves a sensor in a chunk never delivered reading what came before its first scan', async () => {
    let now = 1_800_000_000_000;
    const ring = new NotificationRing(
      100,
      () => new Date(now),
      () => now,
    );
    const h = harness({
      listeners: [
        {
          retain: (ids, complete) => {
            ring.retain(ids, complete);
          },
        },
      ],
    });

    h.handlers.onConfig(set(all.slice(0, 2)), false);
    await settled();
    for (let i = 0; i < 3; i += 1) {
      ring.push({ at: new Date(now).toISOString(), source: '192.0.2.3', text: 'trap', detail: {} });
    }
    h.handlers.onConfig(set(all), true);
    await settled();
    now += 30_000;

    assert.equal(ring.drain(3, 'snmp-trap', 60_000).items.length, 3, 'sensor 3 read nothing');
  });

  it('parks the sensors a later cut push left off, and resumes them one interval back', async () => {
    // The link stays down an hour after chunk one. Kept cursors would hand sensors 2 and 3 the
    // hour as one reading; dropped ones would make them new and lose their place.
    let now = 0;
    const ring = new NotificationRing(
      1_000,
      () => new Date(1_800_000_000_000 + now),
      () => now,
    );
    const h = harness({
      listeners: [
        {
          retain: (ids, complete) => {
            ring.retain(ids, complete);
          },
        },
      ],
    });
    h.handlers.onConfig(set(all));
    await settled();
    for (const one of all) ring.drain(one.sensorId, 'snmp-trap', 60_000);

    h.handlers.onConfig(set(all.slice(0, 1)), false);
    await settled();
    assert.equal(ring.cursors, 1, 'sensors 2 and 3 are off the wheel and not followed');
    for (let minute = 0; minute < 60; minute += 1) {
      ring.push({ at: new Date().toISOString(), source: '192.0.2.3', text: 'trap', detail: {} });
      now += 60_000;
    }

    h.handlers.onConfig(set(all), true);
    await settled();
    now += 1_000;
    const back = ring.drain(2, 'snmp-trap', 60_000);
    assert.equal(back.items.length, 0, 'one interval, and nothing arrived in it');
    assert.equal(back.earlier, 60, 'the hour is named, not read');
    assert.equal(back.dropped, 0);
  });
});

describe('the other core handlers (P-43)', () => {
  it('wakes the drain when the link comes back, and only then', () => {
    const h = harness();
    h.handlers.onStateChange('connecting');
    h.handlers.onStateChange('handshaking');
    assert.equal(h.woken(), 0);

    h.handlers.onStateChange('connected');
    assert.equal(h.woken(), 1);

    h.handlers.onStateChange('disconnected');
    assert.equal(h.woken(), 1);
  });

  it('routes every sweep and query command to its runner', () => {
    const h = harness();
    h.handlers.onSweep({ kind: 'start', job: { runId: 1 } as never });
    h.handlers.onSweep({ kind: 'cancel', runId: 2 });
    h.handlers.onSweep({ kind: 'identify', job: { runId: 3 } as never });
    h.handlers.onSweep({ kind: 'identify-cancel', runId: 4 });
    h.handlers.onQuery({ kind: 'run', queryId: 'q1', query: {} as never, timeoutMs: 500 });
    h.handlers.onQuery({ kind: 'cancel', queryId: 'q2' });

    assert.deepEqual(h.calls, [
      'sweep.start:1',
      'sweep.cancel:2',
      'identify.start:3',
      'identify.cancel:4',
      'query.run:q1:500',
      'query.cancel:q2',
    ]);
  });
});
