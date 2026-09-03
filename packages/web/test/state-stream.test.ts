import { describe, expect, it } from 'vitest';
import { StateStream, type SocketLike } from '../src/api/stream';

/**
 * A socket a test drives by hand: nothing opens until it is told to.
 *
 * **`send` before `open` throws, because that is what a browser does** — `InvalidStateError`,
 * not a queue. A fake that accepted it silently is how a client that sent its subscription into
 * a still-connecting socket passed every test here while every page load in development logged
 * the error.
 */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  opened = false;
  /** Counted, not a flag: closing a socket twice is how one that opened late is reclaimed. */
  closes = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send(data: string): void {
    if (!this.opened) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        'InvalidStateError',
      );
    }
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.closes += 1;
  }
  open(): void {
    this.opened = true;
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

/**
 * A snapshot exactly as the core sends one.
 *
 * The timestamp field is `since`, not `at` — a snapshot entry describes the state a sensor is
 * *in*, while a `state` frame describes a change. This fixture said `at` once, which is how a
 * mistake in the client survived: a fixture written from the same wrong assumption as the code
 * agrees with it perfectly.
 */
const SNAPSHOT = {
  type: 'snapshot',
  seq: 7,
  objectId: 1,
  truncated: false,
  entries: [
    {
      sensorId: 10,
      sensorName: 'Ping',
      path: [1, 2, 10],
      state: 'up',
      cause: 'scan',
      message: '',
      since: '2026-08-26T10:00:00.000Z',
    },
    {
      sensorId: 11,
      sensorName: 'HTTP',
      path: [1, 2, 11],
      state: 'down',
      cause: 'scan',
      message: '',
      since: '2026-08-26T09:00:00.000Z',
    },
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

  it("reads a snapshot entry's `since` as the instant the state began", () => {
    // The two frames name the same instant differently, and a page that shows "since ..." gets
    // "Invalid Date" if the client assumes one shape for both.
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver(SNAPSHOT);
    expect(stream.states.get(10)?.at).toBe('2026-08-26T10:00:00.000Z');
    expect(stream.states.get(11)?.at).toBe('2026-08-26T09:00:00.000Z');
  });

  it('drops a snapshot entry that carries no state rather than inventing one', () => {
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    latest().deliver({ ...SNAPSHOT, entries: [{ sensorId: 10, sensorName: 'Ping' }] });
    expect(stream.states.size).toBe(0);
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

  it('reopens when it is subscribed to again after closing', () => {
    // React StrictMode mounts, unmounts and remounts every effect in development, so the
    // cleanup runs before the second subscribe. A stream that stayed closed would say
    // "Connecting…" for ever, in development only.
    //
    // This opens the socket before closing it, which is the easy half. The socket a real
    // StrictMode mount closes has not opened yet — the four tests below are that half.
    const { stream, latest, sockets } = harness();
    stream.subscribe(1);
    latest().open();
    stream.close();

    stream.subscribe(1);
    expect(sockets.length).toBe(2);
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { objectId: 1 } })]);
    expect(stream.status).toBe('live');
  });

  it('does not send into a socket that has not opened yet', () => {
    // The browser throws `InvalidStateError` rather than queueing, and the subtree changes while
    // the socket is still connecting on every page load: TreeView's root id comes from a fetch,
    // so it subscribes to `null` first and to the real id a few milliseconds later.
    const { stream, latest, sockets } = harness();
    stream.subscribe(null);
    stream.subscribe(7);
    expect(sockets.length, 'the second subscribe reuses the socket already in flight').toBe(1);
    expect(latest().sent).toEqual([]);

    latest().open();
    expect(latest().sent, 'and what goes out is the subtree asked for last').toEqual([
      JSON.stringify({ subscribe: { objectId: 7 } }),
    ]);
  });

  it('keeps the new socket when one closed while connecting reports it late', () => {
    // A real StrictMode mount, in order: socket 1 is closed before it ever opened, socket 2 is
    // opened, and *then* socket 1's close arrives. Attributing that close to socket 2 threw
    // socket 2's registration away — the subscribe went nowhere, and the tree stayed empty
    // until the reconnect backoff expired half a second later. The live view worked, in
    // development, only because reconnection did.
    const { stream, sockets, latest, timers } = harness();
    stream.subscribe(1);
    stream.close();
    stream.subscribe(1);
    expect(sockets.length).toBe(2);

    sockets[0]?.drop();
    expect(stream.status, 'a socket nobody is on cannot take the stream offline').toBe(
      'connecting',
    );
    expect(timers.length, 'nor schedule a reconnect').toBe(0);
    expect(stream.reconnects).toBe(0);

    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { objectId: 1 } })]);
    expect(stream.status).toBe('live');
  });

  it('closes the socket it is on, not the one it last heard from', () => {
    // The leak the same confusion caused. With the live socket forgotten, `close()` had nothing
    // left to close, and an open, unsubscribed socket sat there for the life of the tab.
    const { stream, sockets } = harness();
    stream.subscribe(null);
    stream.close();
    stream.subscribe(null);
    sockets[0]?.drop();

    stream.close();
    expect(sockets[1]?.closed).toBe(true);
  });

  it('reclaims a socket that opens after it was told to close', () => {
    const { stream, sockets } = harness();
    stream.subscribe(1);
    stream.close();
    stream.subscribe(1);

    sockets[0]?.open();
    expect(sockets[0]?.closes, 'closed again rather than left open and unread').toBe(2);
    expect(sockets[0]?.sent, 'and it subscribes for nobody').toEqual([]);
    expect(stream.status, 'nor does it report a stream nobody is on live').toBe('connecting');
  });

  it('ignores frames from a socket it has moved on from', () => {
    const { stream, sockets, latest } = harness();
    stream.subscribe(1);
    stream.close();
    stream.subscribe(1);

    sockets[0]?.open();
    sockets[0]?.deliver(SNAPSHOT);
    expect(stream.states.size, 'a socket nobody is on cannot write into the tree').toBe(0);

    latest().open();
    latest().deliver(SNAPSHOT);
    expect(stream.states.size).toBe(2);
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
