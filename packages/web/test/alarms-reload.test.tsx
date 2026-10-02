import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloseLike, SocketLike } from '../src/api/stream';
import type { AlarmPage } from '../src/api/types';
import { AlarmsView, SETTLE_MS } from '../src/routes/AlarmsView';

const LIST = '/api/v1/alarms?limit=200&sort=priority';

const PAGE: AlarmPage = {
  items: [
    {
      sensorId: 10,
      sensorName: 'Ping',
      state: 'down',
      cause: 'scan',
      message: '',
      since: '2026-09-29T11:50:00.000Z',
      priority: 3,
      path: [1, 2, 7, 10],
      pathNames: ['Root', 'probe-1', 'probe-box', 'Ping'],
      acknowledged: false,
      acknowledgedUntil: null,
      consecutiveFailures: 2,
      recovering: null,
    },
  ],
  total: 1,
  counts: { down: 1 },
  now: '2026-09-29T12:00:00.000Z',
};

/** A snapshot as the core sends one: the same world the list was fetched from. */
const SNAPSHOT = {
  type: 'snapshot',
  seq: 1,
  objectId: 1,
  truncated: false,
  entries: [
    {
      sensorId: 10,
      sensorName: 'Ping',
      path: [1, 2, 7, 10],
      state: 'down',
      cause: 'scan',
      message: '',
      since: '2026-09-29T11:50:00.000Z',
    },
  ],
};

/** A change the list has not seen. */
const STATE = {
  type: 'state',
  seq: 2,
  sensorId: 11,
  sensorName: 'HTTP',
  path: [1, 2, 7, 11],
  state: 'down',
  cause: 'scan',
  message: 'connection refused',
  at: '2026-09-29T12:00:05.000Z',
};

/**
 * Answers the list, and records every time anything is asked. `unreachable` is how many of the
 * first requests find the core down, as a browser reports it: a rejected `fetch`.
 */
function stubList(unreachable = 0): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    if (asked.length <= unreachable) return Promise.reject(new TypeError('Failed to fetch'));
    if (url !== LIST) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(PAGE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

/** Every socket the view opened, oldest first. */
let sockets: DrivenSocket[] = [];

/** A socket the test drives by hand, standing in for the browser's `WebSocket`. */
class DrivenSocket implements SocketLike {
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: CloseLike) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor() {
    sockets.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    act(() => {
      this.onopen?.();
    });
  }
  deliver(frame: unknown): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
  /** Closed from the far end, as a dropped network or a restarting core closes it. */
  drop(): void {
    act(() => {
      this.onclose?.({ code: 1006, reason: '' });
    });
  }
}

function only(): DrivenSocket {
  expect(sockets.length, 'the view opens one socket').toBe(1);
  const socket = sockets[0];
  if (socket === undefined) throw new Error('no socket opened');
  return socket;
}

/** Long enough for a reload the view has scheduled to have gone out. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 300));
  });
}

function mount(): void {
  render(
    <MemoryRouter>
      <AlarmsView />
    </MemoryRouter>,
  );
}

/**
 * When the alarms list asks the core again (`U-22`).
 *
 * The stream is only the prompt, so asking again belongs to a frame the core sent, never to the
 * view's own subscription. Reloading on the subscription meant every page load asked two or three
 * times: once to mount, once when `subscribe` replaced the states, and once for the snapshot.
 */
describe('the alarms list and the state stream', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    sockets = [];
    vi.stubGlobal('WebSocket', DrivenSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks once on mount, not again for the first snapshot, and once for a state change', async () => {
    const asked = stubList();
    mount();
    expect(await screen.findByText('Ping')).toBeDefined();

    // Nothing from the core yet: the subscribe the stream made at mount replaced its states,
    // and that is not news.
    await settled();
    expect(asked, 'one fetch on mount').toEqual([LIST]);

    const socket = only();
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ subscribe: {} })]);
    socket.deliver(SNAPSHOT);
    await settled();
    expect(asked, 'the first snapshot describes the world the list was fetched from').toEqual([
      LIST,
    ]);

    socket.deliver(STATE);
    await waitFor(() => {
      expect(asked.length).toBe(2);
    });
    await settled();
    expect(asked, 'a state change asks again, once').toEqual([LIST, LIST]);
  });

  it('asks again for a first snapshot that comes after a lost connection', async () => {
    // Opened while the core restarted: the list's fetch failed, and so did the socket. The
    // snapshot that ends the outage is the first frame, and it is news: nothing else would take
    // the error panel down without a click.
    const asked = stubList(1);
    mount();
    expect(await screen.findByText('The core is not reachable')).toBeDefined();

    only().drop();
    expect(screen.getByText('Offline — reconnecting')).toBeDefined();
    await waitFor(
      () => {
        expect(sockets.length).toBe(2);
      },
      { timeout: 3_000 },
    );
    const socket = sockets[1];
    if (socket === undefined) throw new Error('no second socket');
    socket.open();
    socket.deliver(SNAPSHOT);

    expect(await screen.findByText('Ping')).toBeDefined();
    expect(screen.queryByText('The core is not reachable')).toBeNull();
    await settled();
    expect(asked).toEqual([LIST, LIST]);
  });

  it('asks again after a reconnection, once for the burst', async () => {
    // The first connection's snapshot is skipped; the reconnection's is news, and so is the
    // state change that follows it inside the settle window. One request answers both.
    const asked = stubList();
    mount();
    expect(await screen.findByText('Ping')).toBeDefined();

    only().open();
    only().deliver(SNAPSHOT);
    only().drop();
    await waitFor(
      () => {
        expect(sockets.length).toBe(2);
      },
      { timeout: 3_000 },
    );
    const socket = sockets[1];
    if (socket === undefined) throw new Error('no second socket');
    socket.open();
    socket.deliver(SNAPSHOT);
    socket.deliver(STATE);

    await waitFor(() => {
      expect(asked.length).toBe(2);
    });
    await settled();
    expect(asked).toEqual([LIST, LIST]);
  });
});
