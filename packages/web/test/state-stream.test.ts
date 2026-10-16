import { describe, expect, it } from 'vitest';
import { STREAM_SIGNED_OUT, StateStream, type CloseLike, type SocketLike } from '../src/api/stream';

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
  onclose: ((event: CloseLike) => void) | null = null;
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
  /** Closed from the far end: by default the 1006 of a dropped network or a refused upgrade. */
  drop(code = 1006, reason = ''): void {
    this.onclose?.({ code, reason });
  }
}

/** A stream whose sockets and timers the test owns. */
function harness(
  retryMs: readonly number[] = [10, 20],
  onStuck?: () => void,
  onSignedOut?: (reason: string) => void,
) {
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
    ...(onStuck === undefined ? {} : { onStuck }),
    ...(onSignedOut === undefined ? {} : { onSignedOut }),
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

  it('reads where a check failed from both frames, and nothing it cannot read as one (P-285)', () => {
    const { stream, latest } = harness();
    stream.subscribe(1);
    latest().open();
    const failure = { phase: 'connect', target: '192.0.2.7:22' };
    latest().deliver({
      ...SNAPSHOT,
      entries: [{ ...SNAPSHOT.entries[1], failure }, SNAPSHOT.entries[0]],
    });
    expect(stream.states.get(11)?.failure).toEqual(failure);
    // A core below `P-285` sends none: `null`, never `undefined` and never a guess.
    expect(stream.states.get(10)?.failure).toBeNull();
    latest().deliver({
      type: 'state',
      seq: 8,
      sensorId: 10,
      sensorName: 'Ping',
      path: [1, 2, 10],
      state: 'down',
      cause: 'scan',
      message: 'timed out',
      failure: { phase: 'timeout' },
      at: 'y',
    });
    expect(stream.states.get(10)?.failure).toEqual({ phase: 'timeout' });
    for (const [sent, read] of [
      ['connect', null],
      [{ target: '192.0.2.7' }, null],
      [{ phase: '' }, null],
      [{ phase: 7 }, null],
      [['connect'], null],
      [{ phase: 'exec', target: 5 }, { phase: 'exec' }],
      [{ phase: 'exec', target: '' }, { phase: 'exec' }],
    ] as const) {
      latest().deliver({
        type: 'state',
        seq: 9,
        sensorId: 10,
        sensorName: 'Ping',
        path: [1, 2, 10],
        state: 'down',
        cause: 'scan',
        message: '',
        failure: sent,
        at: 'z',
      });
      expect(stream.states.get(10)?.failure, JSON.stringify(sent)).toEqual(read);
    }
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
    latest().deliver(SNAPSHOT);
    latest().drop();
    expect(timers[0]?.ms, 'a connection that was answered resets the backoff').toBe(10);
  });

  it('keeps climbing while the core closes each socket before it answers it (U-26)', () => {
    // The core says `hello` to anything, and closes with 1013 when it cannot check who is
    // asking. A client that took the socket opening for a connection that worked came back at
    // the first rung every time: every open tab, every half second, each one an upgrade and a
    // credential query against a database that was already refusing them.
    let asked = 0;
    const { stream, latest, timers, fire } = harness([10, 20, 30], () => {
      asked += 1;
    });
    stream.subscribe(1);
    const waits: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      latest().open();
      latest().deliver({ type: 'hello', seq: 0, protocol: 1 });
      latest().drop(1013, 'could not confirm this session; reconnect');
      waits.push(timers[0]?.ms ?? -1);
      fire();
    }
    expect(waits, 'the ladder started again at every socket that opened').toEqual([
      10, 20, 30, 30, 30,
    ]);
    // And at the ceiling it asks whether the session is still there, as for any other outage.
    expect(asked).toBe(3);

    // The first answer is what resets it: a refusal of the subscription does not.
    latest().open();
    latest().deliver({ type: 'problem', reason: 'this account may not read that object' });
    latest().drop();
    expect(timers[0]?.ms).toBe(30);
    fire();
    latest().open();
    latest().deliver(SNAPSHOT);
    latest().drop();
    expect(timers[0]?.ms).toBe(10);
  });

  it('starts the wait again when a watch on a probe is answered (U-26)', () => {
    const { stream, latest, timers, fire } = harness([10, 20]);
    stream.watchProbe(7);
    latest().open();
    latest().drop();
    fire();
    latest().open();
    latest().drop();
    expect(timers[0]?.ms).toBe(20);
    fire();
    latest().open();
    latest().deliver({ type: 'watching', probeId: 7 });
    latest().drop();
    expect(timers[0]?.ms).toBe(10);
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

  it("counts the core's frames, and not its own subscribe clearing the states", () => {
    // `subscribe` replaces `states` too, so a view that refetched whenever the map changed
    // refetched for its own subscription (`U-22`). `frames` is what tells the two apart.
    const { stream, latest } = harness();
    stream.subscribe(1);
    stream.subscribe(2);
    expect(stream.frames, 'a subscribe is the page talking, not the core').toBe(0);

    latest().open();
    latest().deliver(SNAPSHOT);
    expect(stream.frames).toBe(1);
    latest().deliver({
      type: 'state',
      seq: 8,
      sensorId: 10,
      sensorName: 'Ping',
      path: [1, 2, 10],
      state: 'down',
      cause: 'scan',
      message: '',
      at: 'y',
    });
    expect(stream.frames).toBe(2);
    latest().deliver({ type: 'overflow', reason: 'too far behind' });
    expect(stream.frames, 'an overflow throws the states away, so it is one').toBe(3);

    latest().onmessage?.({ data: 'not json' });
    latest().deliver({ type: 'something-new' });
    latest().deliver({ type: 'state', sensorId: 10 });
    expect(stream.frames, 'a frame that changed nothing is not counted').toBe(3);

    stream.subscribe(3);
    expect(stream.frames).toBe(3);
  });

  it('watches a probe itself: asks for it by id, and counts what the core says of it (U-24)', () => {
    const { stream, latest, fire } = harness();
    stream.watchProbe(7);
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { probeId: 7 } })]);

    latest().deliver({ type: 'watching', probeId: 7 });
    expect(stream.frames, 'the watch standing is the first word, as a snapshot is').toBe(1);
    latest().deliver({ type: 'probe', probeId: 7 });
    latest().deliver({ type: 'probe', probeId: 7 });
    expect(stream.frames).toBe(3);
    expect(stream.states.size, 'a probe frame carries no state').toBe(0);

    // About another probe, or with no probe named: nobody here asked.
    latest().deliver({ type: 'probe', probeId: 8 });
    latest().deliver({ type: 'watching', probeId: 8 });
    latest().deliver({ type: 'probe' });
    expect(stream.frames).toBe(3);

    // An overflow — a grant moved — is answered by watching again, not by a tree subscription.
    latest().deliver({ type: 'overflow', reason: 'what this account may see has changed' });
    expect(latest().sent).toEqual([
      JSON.stringify({ subscribe: { probeId: 7 } }),
      JSON.stringify({ subscribe: { probeId: 7 } }),
    ]);

    // And a reconnect watches the same probe.
    latest().drop();
    fire();
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ subscribe: { probeId: 7 } })]);
  });

  it('takes no probe frame as news while it is subscribed to a subtree (U-24)', () => {
    const { stream, latest } = harness();
    stream.watchProbe(7);
    latest().open();
    stream.subscribe(7);
    expect(latest().sent.at(-1)).toBe(JSON.stringify({ subscribe: { objectId: 7 } }));
    // One the core sent for the watch this stream has since replaced.
    latest().deliver({ type: 'probe', probeId: 7 });
    expect(stream.frames).toBe(0);
  });
});

/**
 * Telling a refused upgrade from a pulled cable (`U-19`).
 *
 * The stream cannot: with authentication on, an upgrade with no session is refused with a
 * perfectly good `401 AUTH_REQUIRED`, and the browser `WebSocket` API hides it — the page gets a
 * 1006 close and nothing else, exactly what a dead network produces. So it reconnects for ever
 * while the header still says the operator is signed in. `onStuck` is the hook that lets somebody
 * who *can* ask, ask; what is asserted here is only when it fires.
 */
describe('a stream that stays down', () => {
  /** Drops the current socket and lets the reconnect timer run, leaving a fresh socket down. */
  function failAgain(h: ReturnType<typeof harness>): void {
    h.latest().drop();
    h.fire();
  }

  it('says nothing about the early failures, because that is what a blip looks like', () => {
    // A lid closing, a wifi roam, a core restarting. Asking after one of those spends a request
    // on every one of them, for a question whose answer is almost always "yes, still signed in".
    let asked = 0;
    const h = harness([10, 20, 30], () => {
      asked += 1;
    });
    h.stream.subscribe(null);
    h.latest().open();

    failAgain(h);
    expect(asked).toBe(0);
    failAgain(h);
    expect(asked).toBe(0);
  });

  it('asks once the backoff has reached its ceiling', () => {
    let asked = 0;
    const h = harness([10, 20, 30], () => {
      asked += 1;
    });
    h.stream.subscribe(null);
    h.latest().open();

    failAgain(h);
    failAgain(h);
    h.latest().drop();
    expect(asked).toBe(1);
  });

  it('keeps asking while it stays down, because a session can expire mid-outage', () => {
    // The outage that started as a network problem is exactly the one long enough for a session
    // to lapse during it. Asking once at the ceiling and never again would leave that tab
    // reconnecting for ever after the answer had changed.
    let asked = 0;
    const h = harness([10, 20, 30], () => {
      asked += 1;
    });
    h.stream.subscribe(null);
    h.latest().open();

    failAgain(h);
    failAgain(h);
    failAgain(h);
    failAgain(h);
    expect(asked).toBe(2);
  });

  it('stops asking once it reconnects, because the streak is the thing it counts', () => {
    let asked = 0;
    const h = harness([10, 20, 30], () => {
      asked += 1;
    });
    h.stream.subscribe(null);
    h.latest().open();

    failAgain(h);
    failAgain(h);
    failAgain(h);
    expect(asked).toBe(1);

    // A socket that is answered resets the ladder, so the next failure is an early rung again.
    h.latest().open();
    h.latest().deliver(SNAPSHOT);
    h.latest().drop();
    expect(asked).toBe(1);
  });
});

/**
 * Signed out by the core (`A-34`).
 *
 * The core closes a stream with 4401 when the session behind it has ended, and says why. A client
 * that treated it like any other close would reconnect, be refused at the upgrade — which the
 * browser reports as a 1006, the same as a pulled cable — and retry for ever at the ceiling of its
 * backoff, with the header still saying somebody is signed in. So it stops, and says so.
 */
describe('a stream the core signed out', () => {
  it('stops, schedules nothing, and says why', () => {
    const reasons: string[] = [];
    let asked = 0;
    const h = harness(
      [10, 20],
      () => {
        asked += 1;
      },
      (reason) => reasons.push(reason),
    );
    h.stream.subscribe(null);
    h.latest().open();
    h.latest().deliver(SNAPSHOT);

    h.latest().drop(STREAM_SIGNED_OUT, 'this session has expired; sign in again');

    expect(reasons).toEqual(['this session has expired; sign in again']);
    expect(h.timers).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.stream.status).toBe('offline');
    // Told outright, so there is nothing to ask.
    expect(asked).toBe(0);
    // And what it last showed stays until the login form replaces it.
    expect(h.stream.states.size).toBe(2);
  });

  it('reconnects as before on any other close', () => {
    const reasons: string[] = [];
    const h = harness([10, 20], undefined, (reason) => reasons.push(reason));
    h.stream.subscribe(null);
    h.latest().open();

    h.latest().drop(1011, 'internal error');

    expect(reasons).toEqual([]);
    expect(h.timers).toHaveLength(1);
    h.fire();
    expect(h.sockets).toHaveLength(2);
  });

  it('ignores a sign-out from a socket it has already moved on from', () => {
    const reasons: string[] = [];
    const h = harness([10, 20], undefined, (reason) => reasons.push(reason));
    h.stream.subscribe(null);
    const first = h.latest();
    first.open();
    first.drop();
    h.fire();
    h.latest().open();

    // The old socket's close arriving late says nothing about the session the new one is on.
    first.drop(STREAM_SIGNED_OUT, 'this session has ended; sign in again');

    expect(reasons).toEqual([]);
    expect(h.stream.status).toBe('live');
  });
});
