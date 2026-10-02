import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { confirmSession, sessionEnded } from './client';
import type { SensorState } from './types';

/** One sensor's state, as the stream last reported it. */
export interface LiveState {
  readonly sensorId: number;
  readonly sensorName: string;
  /** Root first, sensor last — what a tree rolls a colour up. */
  readonly path: readonly number[];
  readonly state: SensorState;
  readonly cause: string;
  readonly message: string;
  /**
   * When this state began.
   *
   * One field, from two differently-named ones on the wire: a `state` frame calls it `at`
   * — the moment the change happened — and a snapshot entry calls it `since` — the moment the
   * state it is still in began. Same instant, read from two directions, and the conversion
   * happens once, below.
   */
  readonly at: string;
}

export type StreamStatus = 'connecting' | 'live' | 'offline';

/**
 * The close code the core sends when this socket's session, token or account stopped
 * authenticating (`A-34`). Mirrors `STREAM_SIGNED_OUT` in the core's stream route.
 */
export const STREAM_SIGNED_OUT = 4401;

/** What a close says: the half of `CloseEvent` this reads. */
export interface CloseLike {
  readonly code: number;
  readonly reason: string;
}

/** The half of `WebSocket` this uses, so a test can drive one without a server. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((event: CloseLike) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

export interface StateStreamOptions {
  url: string;
  /** Swapped in tests. */
  open?: (url: string) => SocketLike;
  /** How long to wait before each reconnection attempt; the last is repeated. */
  retryMs?: readonly number[];
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  /**
   * Called once the failures have gone on long enough that this is not a blip (`U-19`).
   *
   * The stream cannot tell a refused upgrade from a pulled cable — the browser hides the status
   * of a failed handshake, so a 401 and a dead network arrive identically as a 1006 close. This
   * is the hook that lets somebody who *can* ask, ask: the default binding checks whether the
   * session is still there. Kept as a callback rather than a fetch of its own so this class stays
   * framework-free and drivable without a server.
   */
  onStuck?: () => void;
  /**
   * Called when the core closed the socket because the session behind it ended (`A-34`), with the
   * reason it gave. **The stream does not reconnect after it**: the upgrade would be refused, and a
   * browser reports a refused upgrade as the same 1006 a dropped network gives, so retrying would
   * spin at the ceiling of the backoff with the header still saying somebody is signed in.
   */
  onSignedOut?: (reason: string) => void;
}

const DEFAULT_RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

/**
 * A snapshot entry, which is **not** a `LiveState`.
 *
 * Declaring it as one is how "since Invalid Date" got onto the sensor page: the frames differ by
 * exactly one field name, nothing on the wire is checked at compile time, and a tree that shows
 * no timestamps never noticed. The shape is written out so the conversion below has to exist.
 */
interface SnapshotEntry {
  sensorId?: number;
  sensorName?: string;
  path?: number[];
  state?: SensorState;
  cause?: string;
  message?: string;
  since?: string;
}

interface ServerFrame {
  type?: string;
  seq?: number;
  entries?: SnapshotEntry[];
  reason?: string;
  sensorId?: number;
  sensorName?: string;
  path?: number[];
  state?: SensorState;
  cause?: string;
  message?: string;
  at?: string;
}

/**
 * The live state of a subtree, over a WebSocket (`U-02`).
 *
 * **Resync is "subscribe again", and that is the whole reconnection story.** There is no cursor
 * and no replay log: on connect — first or fiftieth — the client subscribes and the server
 * answers with a snapshot, then streams. A cursor would mean the server keeping a buffer whose
 * length is a guess about how long a laptop stays shut, and getting that guess wrong shows
 * somebody a stale tree with no way to tell.
 *
 * **`overflow` is handled the same way**, because it means the same thing: the server decided
 * this client is too far behind to patch, so everything it holds is suspect. Subscribing again
 * replaces it wholesale.
 *
 * Framework-free on purpose. `useStateStream` below is a thin binding, and the reconnection
 * logic — the part with the timers and the edge cases — is testable without rendering anything.
 */
export class StateStream {
  readonly #url: string;
  readonly #open: (url: string) => SocketLike;
  readonly #retryMs: readonly number[];
  readonly #schedule: (fn: () => void, ms: number) => number;
  readonly #cancel: (handle: number) => void;
  readonly #onStuck: (() => void) | undefined;
  readonly #onSignedOut: ((reason: string) => void) | undefined;

  readonly #listeners = new Set<() => void>();
  #states: ReadonlyMap<number, LiveState> = new Map();
  #status: StreamStatus = 'connecting';
  #socket: SocketLike | undefined;
  /**
   * Whether `#socket` has finished its handshake.
   *
   * The browser throws `InvalidStateError` on `send` before that rather than queueing, so this
   * is what a subscription made while connecting waits on. Nothing else needs queueing: the
   * subscription *is* `#objectId`, and `onopen` sends whatever it says by the time it fires.
   */
  #opened = false;
  #timer: number | undefined;
  #attempt = 0;
  #objectId: number | null = null;
  #closed = false;
  /** Counted so a test — and later Probe Health's browser-side cousin — can see churn. */
  #reconnects = 0;
  /** See `frames`. */
  #frames = 0;

  constructor(options: StateStreamOptions) {
    this.#url = options.url;
    this.#open = options.open ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.#cancel =
      options.cancel ??
      ((handle) => {
        clearTimeout(handle);
      });
    this.#onStuck = options.onStuck;
    this.#onSignedOut = options.onSignedOut;
  }

  get status(): StreamStatus {
    return this.#status;
  }

  get states(): ReadonlyMap<number, LiveState> {
    return this.#states;
  }

  get reconnects(): number {
    return this.#reconnects;
  }

  /**
   * How many frames from the core have changed `states`: snapshots, state changes and overflows.
   *
   * `states` cannot say this by itself, because `subscribe` replaces it too, with an empty map. A
   * view that refetches on news (`U-06`'s list) would otherwise refetch for its own subscription
   * (`U-22`).
   */
  get frames(): number {
    return this.#frames;
  }

  /**
   * Scopes the stream to a subtree, or to everything. Safe to call before the socket opens —
   * the subscription is held in `#objectId` and goes out from `onopen`.
   *
   * **Reopens a closed stream**, which is what makes `close()` mean "I am not watching" rather
   * than "this object is spent". React's StrictMode mounts, unmounts and remounts every effect
   * in development, so the cleanup runs before the second subscribe — and a stream that stayed
   * closed would leave the tree saying "Connecting…" for ever, in development only, which is the
   * worst way for a bug to behave.
   */
  subscribe(objectId: number | null): void {
    this.#closed = false;
    this.#objectId = objectId;
    // The states held are about the old subtree. Keeping them would leave a tree showing rows
    // from a branch nobody is looking at any more.
    this.#replace(new Map());
    if (this.#socket === undefined) this.#connect();
    else this.#send();
  }

  /** React's `subscribe`: returns the unsubscribe. */
  listen = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#opened = false;
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setStatus('connecting');
    const socket = this.#open(this.#url);
    this.#socket = socket;
    this.#opened = false;

    // Every handler below first checks that its own socket is still the one in use. A socket
    // told to close while it was connecting reports that close *afterwards*, by which time the
    // stream has opened another — and a stream that cannot tell the two apart throws away the
    // new socket's registration on the strength of the old one's death. Not hypothetical:
    // StrictMode's second mount does exactly this on every page load in development.
    socket.onopen = () => {
      if (socket !== this.#socket) {
        // Told to close while connecting, and it opened anyway. Nothing reads it now, and an
        // open socket the stream has forgotten holds a subscription for the life of the tab.
        socket.close();
        return;
      }
      this.#opened = true;
      this.#attempt = 0;
      this.#setStatus('live');
      this.#send();
    };
    socket.onmessage = (event) => {
      if (socket !== this.#socket) return;
      this.#apply(event.data);
    };
    socket.onclose = (event) => {
      if (event.code === STREAM_SIGNED_OUT) this.#signedOut(socket, event.reason);
      else this.#dropped(socket);
    };
    socket.onerror = () => {
      this.#dropped(socket);
    };
  }

  #dropped(socket: SocketLike): void {
    if (this.#closed || socket !== this.#socket) return;
    this.#socket = undefined;
    this.#opened = false;
    this.#setStatus('offline');
    // The states are what the stream last said; a disconnected client keeps showing them rather
    // than blanking the tree. `status` is how the UI says they may be stale.
    const wait = this.#retryMs[Math.min(this.#attempt, this.#retryMs.length - 1)] ?? 10_000;
    this.#attempt += 1;
    this.#reconnects += 1;
    // **From the ceiling onwards, not on the first failure.** The early rungs of the ladder are
    // what a blip looks like — a laptop lid, a wifi roam, a core restarting — and asking after
    // one of those would spend a request on every one of them. By the ceiling the stream has
    // been failing for the whole ladder, which is long enough that "is my session still there"
    // is a question worth a public GET. It repeats while stuck, because a session can expire
    // during an outage that started as a network problem.
    if (this.#attempt >= this.#retryMs.length) this.#onStuck?.();
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.#connect();
    }, wait);
  }

  /**
   * Signed out by the core (`A-34`): stop, and say so. No reconnection is scheduled — see
   * `onSignedOut` — and the states are left as they were, for the moment before the login form
   * replaces them.
   */
  #signedOut(socket: SocketLike, reason: string): void {
    if (this.#closed || socket !== this.#socket) return;
    this.#closed = true;
    this.#socket = undefined;
    this.#opened = false;
    this.#setStatus('offline');
    this.#onSignedOut?.(reason);
  }

  #send(): void {
    // `send` before the handshake finishes throws `InvalidStateError` — the browser does not
    // queue on our behalf. So a subscription made while connecting waits here and goes out from
    // `onopen`, which is the same path that replays it after every reconnect.
    if (!this.#opened) return;
    this.#socket?.send(
      JSON.stringify({
        subscribe: this.#objectId === null ? {} : { objectId: this.#objectId },
      }),
    );
  }

  #apply(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'snapshot': {
        // Wholesale, never merged: a snapshot is the truth about the subtree, and merging would
        // leave a sensor that has since been deleted sitting in the map for ever.
        const next = new Map<number, LiveState>();
        for (const entry of frame.entries ?? []) {
          if (entry.sensorId === undefined || entry.state === undefined) continue;
          next.set(entry.sensorId, {
            sensorId: entry.sensorId,
            sensorName: entry.sensorName ?? '',
            path: entry.path ?? [],
            state: entry.state,
            cause: entry.cause ?? '',
            message: entry.message ?? '',
            at: entry.since ?? '',
          });
        }
        this.#heard(next);
        return;
      }
      case 'state': {
        if (frame.sensorId === undefined || frame.state === undefined) return;
        const next = new Map(this.#states);
        next.set(frame.sensorId, {
          sensorId: frame.sensorId,
          sensorName: frame.sensorName ?? '',
          path: frame.path ?? [],
          state: frame.state,
          cause: frame.cause ?? '',
          message: frame.message ?? '',
          at: frame.at ?? '',
        });
        this.#heard(next);
        return;
      }
      case 'overflow':
        // Everything held is suspect. Subscribing again is the resync.
        this.#send();
        this.#heard(new Map());
        return;
      default:
        return;
    }
  }

  /** `#replace`, for a frame from the core: counted, where `subscribe`'s reset is not. */
  #heard(states: ReadonlyMap<number, LiveState>): void {
    this.#frames += 1;
    this.#replace(states);
  }

  #replace(states: ReadonlyMap<number, LiveState>): void {
    this.#states = states;
    this.#announce();
  }

  #setStatus(status: StreamStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#announce();
  }

  #announce(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** Where the stream lives, derived from wherever the UI is served from. */
export function streamUrl(): string {
  const base = new URL('/api/v1/stream', window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.toString();
}

export interface LiveStates {
  readonly status: StreamStatus;
  readonly states: ReadonlyMap<number, LiveState>;
  /** `StateStream.frames`: how many frames from the core have changed `states` so far. */
  readonly frames: number;
}

/**
 * The live state of one subtree, for a component.
 *
 * One socket per hook instance, which is one per view. A shared connection would be fewer
 * sockets and a subscription model in the client to go with it; with one live view at a time it
 * would be machinery earning nothing.
 */
export function useStateStream(objectId: number | null, options?: StateStreamOptions): LiveStates {
  const url = options?.url;
  const open = options?.open;
  const stream = useMemo(
    () =>
      new StateStream({
        url: url ?? streamUrl(),
        ...(open === undefined ? {} : { open }),
        // The binding the class deliberately does not make for itself. `confirmSession` reports
        // a lost session through the same listener a 401 on any other request goes through, so
        // the gate that puts the login form up needs to know nothing about sockets.
        onStuck: () => {
          void confirmSession();
        },
        // Told outright, so nothing needs asking: straight to the login form, saying why.
        onSignedOut: (reason) => {
          sessionEnded(reason === '' ? 'this session has ended; sign in again' : reason);
        },
      }),
    [url, open],
  );

  useEffect(() => {
    stream.subscribe(objectId);
    return () => {
      stream.close();
    };
  }, [stream, objectId]);

  const listen = useCallback((listener: () => void) => stream.listen(listener), [stream]);
  const snapshot = useRef<LiveStates>({ status: 'connecting', states: new Map(), frames: 0 });
  const read = useCallback((): LiveStates => {
    const held = snapshot.current;
    if (
      held.status === stream.status &&
      held.states === stream.states &&
      held.frames === stream.frames
    ) {
      return held;
    }
    snapshot.current = { status: stream.status, states: stream.states, frames: stream.frames };
    return snapshot.current;
  }, [stream]);

  return useSyncExternalStore(listen, read, read);
}
