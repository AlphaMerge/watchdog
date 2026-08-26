import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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

/** The half of `WebSocket` this uses, so a test can drive one without a server. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
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

  readonly #listeners = new Set<() => void>();
  #states: ReadonlyMap<number, LiveState> = new Map();
  #status: StreamStatus = 'connecting';
  #socket: SocketLike | undefined;
  #timer: number | undefined;
  #attempt = 0;
  #objectId: number | null = null;
  #closed = false;
  /** Counted so a test — and later Probe Health's browser-side cousin — can see churn. */
  #reconnects = 0;

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
   * Scopes the stream to a subtree, or to everything. Safe to call before the socket opens.
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
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setStatus('connecting');
    const socket = this.#open(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setStatus('live');
      this.#send();
    };
    socket.onmessage = (event) => {
      this.#apply(event.data);
    };
    socket.onclose = () => {
      this.#dropped();
    };
    socket.onerror = () => {
      this.#dropped();
    };
  }

  #dropped(): void {
    if (this.#closed || this.#socket === undefined) return;
    this.#socket = undefined;
    this.#setStatus('offline');
    // The states are what the stream last said; a disconnected client keeps showing them rather
    // than blanking the tree. `status` is how the UI says they may be stale.
    const wait = this.#retryMs[Math.min(this.#attempt, this.#retryMs.length - 1)] ?? 10_000;
    this.#attempt += 1;
    this.#reconnects += 1;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.#connect();
    }, wait);
  }

  #send(): void {
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
        this.#replace(next);
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
        this.#replace(next);
        return;
      }
      case 'overflow':
        // Everything held is suspect. Subscribing again is the resync.
        this.#send();
        this.#replace(new Map());
        return;
      default:
        return;
    }
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
    () => new StateStream({ url: url ?? streamUrl(), ...(open === undefined ? {} : { open }) }),
    [url, open],
  );

  useEffect(() => {
    stream.subscribe(objectId);
    return () => {
      stream.close();
    };
  }, [stream, objectId]);

  const listen = useCallback((listener: () => void) => stream.listen(listener), [stream]);
  const snapshot = useRef<LiveStates>({ status: 'connecting', states: new Map() });
  const read = useCallback((): LiveStates => {
    const held = snapshot.current;
    if (held.status === stream.status && held.states === stream.states) return held;
    snapshot.current = { status: stream.status, states: stream.states };
    return snapshot.current;
  }, [stream]);

  return useSyncExternalStore(listen, read, read);
}
