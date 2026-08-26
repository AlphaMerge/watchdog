import { describe, expect, it } from 'vitest';
import { StateStream, type SocketLike } from '../src/api/stream';

/** A socket a test drives by hand: nothing opens until it is told to. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(): void {
    this.onclose?.();
  }
}

/** A stream whose sockets and timers the test owns. */
function harness(retryMs: readonly number[] = [10, 20]) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const stream = new StateStream({
    url: 'ws://test/stream',
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    retryMs,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    cancel: () => undefined,
  });
  const latest = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('nothing connected');
    return socket;
  };
  const fire = (): void => {
    const timer = timers.shift();
    if (timer === undefined) throw new Error('nothing scheduled');
    timer.fn();
  };
  return { stream, sockets, timers, latest, fire };
}

const SNAPSHOT = {
  type: 'snapshot',
  seq: 7,
  objectId: 1,
  truncated: false,
  entries: [
    { sensorId: 10, sensorName: 'Ping', path: [1, 2, 10], state: 'up', cause: 'scan', message: '', at: 'x' },
    { sensorId: 11, sensorName: 'HTTP', path: [1, 2, 11], state: 'down', cause: 'scan', message: '', at: 'x' },
  ],
};

describe('the live state stream', () => {
  it('subscribes as soon as the socket opens, and not before', () => {
    const { stream, latest } = harness();
    stream.subscribe(42);
    expect(latest().sent).toEqual([]);
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { objectId: 42 } })]);
    expect(stream.status).toBe('live');
  });

  it('asks for everything when no subtree is named', () => {
    const { stream, latest } = harness();
    stream.subscribe(null);
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: {} })]);
  });

  it('takes a snapshot wholesale rather than merging it', () => {
    // A merge would leave a sensor that has since been deleted sitting in the map for ever.
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver({ ...SNAPSHOT, entries: [SNAPSHOT.entries[0]] });
    expect([...stream.states.keys()]).toEqual([10]);
    latest().deliver({ ...SNAPSHOT, entries: [SNAPSHOT.entries[1]] });
    expect([...stream.states.keys()]).toEqual([11]);
  });

  it('applies a state change over the snapshot', () => {
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    latest().deliver({
      type: 'state',
      seq: 8,
      sensorId: 10,
      sensorName: 'Ping',
      path: [1, 2, 10],
      state: 'down',
      cause: 'scan',
      message: 'no ICMP reply',
      at: 'y',
    });
    expect(stream.states.get(10)?.state).toBe('down');
    expect(stream.states.get(11)?.state, 'the other sensor is untouched').toBe('down');
  });

  it('keeps showing the last states when the connection drops', () => {
    // Blanking the tree would be the honest-looking mistake: it says "nothing is wrong" about a
    // subtree nobody is hearing from. `status` is how the UI says the states may be stale.
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    latest().drop();
    expect(stream.status).toBe('offline');
    expect(stream.states.size).toBe(2);
  });

  it('reconnects with a growing wait, and resubscribes when it lands', () => {
    const { stream, latest, timers, fire, sockets } = harness([10, 20]);
    stream.subscribe(42);
    latest().open();

    latest().drop();
    expect(timers[0]?.ms).toBe(10);
    fire();
    latest().drop();
    expect(timers[0]?.ms).toBe(20);
    fire();
    latest().drop();
    expect(timers[0]?.ms, 'the last wait is repeated rather than growing for ever').toBe(20);
    fire();

    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { objectId: 42 } })]);
    expect(sockets.length).toBe(4);
    expect(stream.reconnects).toBe(3);
  });

  it('starts the wait again after a connection that worked', () => {
    const { stream, latest, timers, fire } = harness([10, 20]);
    stream.subscribe(1);
    latest().open();
    latest().drop();
    fire();
    latest().open();
    latest().drop();
    expect(timers[0]?.ms, 'a connection that opened resets the backoff').toBe(10);
  });

  it('resyncs by subscribing again when the server says it fell behind', () => {
    // There is no cursor and no replay: everything held is suspect, so it is replaced wholesale.
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    latest().deliver({ type: 'overflow', reason: 'too far behind' });

    expect(stream.states.size, 'what it held was thrown away').toBe(0);
    expect(latest().sent).toEqual([
      JSON.stringify({ subscribe: { objectId: 1 } }),
      JSON.stringify({ subscribe: { objectId: 1 } }),
    ]);
  });

  it('drops what it holds when the subtree changes', () => {
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    stream.subscribe(99);
    expect(stream.states.size).toBe(0);
    expect(latest().sent.at(-1)).toBe(JSON.stringify({ subscribe: { objectId: 99 } }));
  });

  it('tells its listeners, and stops when they leave', () => {
    const { stream, latest } = harness();
    let calls = 0;
    const stop = stream.listen(() => {
      calls += 1;
    });
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    expect(calls).toBeGreaterThan(0);
    const seen = calls;
    stop();
    latest().deliver({ ...SNAPSHOT, entries: [] });
    expect(calls).toBe(seen);
  });

  it('ignores a frame it cannot read rather than falling over', () => {
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().onmessage?.({ data: 'not json' });
    latest().deliver({ type: 'something-new' });
    latest().deliver({ type: 'state', sensorId: 10 });
    expect(stream.states.size).toBe(0);
  });

  it('schedules nothing more once it is closed', () => {
    const { stream, latest, timers } = harness();
    stream.subscribe(1);
    latest().open();
    stream.close();
    latest().drop();
    expect(timers.length).toBe(0);
    expect(latest().closed).toBe(true);
  });
});
