import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '../src/api/stream';
import type { ResolvedMap, ResolvedWidget } from '../src/api/types';
import { MapBoard } from '../src/maps/MapBoard';
import { historyPathFor } from '../src/maps/graph';

/**
 * A map being looked at (`G-04`).
 *
 * **The claims are the ones a designer test cannot make**: that a tile shows the state the stream
 * last reported rather than the one the page loaded with, that a widget naming something gone
 * leaves a visible hole and says only as much as the caller is entitled to, and that a graph asks
 * for the range its author chose.
 */

const CHANNELS = [{ key: 'rtt', name: 'Response time', unit: 'ms', value: 12 }];

function widget(over: Partial<ResolvedWidget> = {}): ResolvedWidget {
  return {
    id: 'w1',
    kind: 'status',
    box: { x: 0, y: 0, w: 6, h: 4 },
    title: 'Router',
    state: 'ok',
    data: {
      kind: 'status',
      objectId: 7,
      name: 'router-1',
      sensorState: 'up',
      message: 'all fine',
      since: '2026-09-09T10:00:00.000Z',
    },
    ...over,
  } as ResolvedWidget;
}

function resolved(...widgets: ResolvedWidget[]): ResolvedMap {
  return {
    map: {
      id: 4,
      name: 'Floor 1',
      description: '',
      priority: 3,
      layout: { widgets: [] },
      version: 2,
      createdAt: '2026-09-09T09:00:00.000Z',
      updatedAt: '2026-09-09T09:00:00.000Z',
    },
    widgets,
    problems: [],
  };
}

/** A socket the test drives by hand — the seam `StateStream` was built with. */
function fakeSocket(): { socket: SocketLike; sent: string[] } {
  const sent: string[] = [];
  const socket: SocketLike = {
    send: (data: string) => sent.push(data),
    close: () => undefined,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return { socket, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the range a graph asks for', () => {
  it('ends now and starts a range ago', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    expect(historyPathFor(7, 60, now)).toBe(
      '/sensors/7/history?from=2026-09-09T11:00:00.000Z&to=2026-09-09T12:00:00.000Z',
    );
    expect(historyPathFor(7, 7 * 24 * 60, now)).toContain('from=2026-09-02T12:00:00.000Z');
  });
});

describe('a map on screen', () => {
  it('draws each widget where the document put it', () => {
    render(<MapBoard view={resolved(widget())} />);
    expect(screen.getByText('Router')).toBeDefined();
    expect(screen.getByText('all fine')).toBeDefined();
  });

  it('shows the state the stream last reported, not the one the page loaded with', async () => {
    // **The point of the ticket's "from the same WebSocket stream".** The resolved map is a
    // snapshot taken when the request was made; a wall display left open for a day would show
    // that snapshot for ever if the tile did not prefer the stream.
    const { socket } = fakeSocket();
    render(
      <MapBoard view={resolved(widget())} stream={{ url: 'ws://test', open: () => socket }} />,
    );
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'state',
        sensorId: 7,
        sensorName: 'router-1',
        path: [1, 7],
        state: 'down',
        cause: 'check-failed',
        message: 'no reply',
        at: '2026-09-09T12:00:00.000Z',
      }),
    });

    await waitFor(() => {
      expect(screen.getByText('no reply')).toBeDefined();
    });
    // The badge reads the new state, not the one the map was serialised with.
    expect(screen.getByText('Down')).toBeDefined();
    expect(screen.queryByText('Up')).toBeNull();
  });

  it('leaves a hole where a deleted object was, and says so', () => {
    render(
      <MapBoard
        view={resolved(
          widget({ state: 'unavailable', reason: 'object-deleted', data: undefined } as never),
        )}
      />,
    );
    expect(screen.getByText('Router')).toBeDefined();
    expect(screen.getByText(/has been deleted/)).toBeDefined();
  });

  it('says only that it cannot be drawn when it is not told why', () => {
    // A reader is not told "deleted" rather than "not visible": that difference is an oracle for
    // which ids are alive, which is why the core withholds it from anybody without full access.
    render(
      <MapBoard view={resolved(widget({ state: 'unavailable', data: undefined } as never))} />,
    );
    expect(screen.getByText('This widget cannot be drawn.')).toBeDefined();
    expect(screen.queryByText(/deleted/)).toBeNull();
    expect(screen.queryByText(/may not see/)).toBeNull();
  });

  it('draws a channel table with a dash where there is no reading', () => {
    render(
      <MapBoard
        view={resolved(
          widget({
            kind: 'table',
            data: {
              kind: 'table',
              objectId: 7,
              name: 'router-1',
              channels: [...CHANNELS, { key: 'loss', name: 'Packet loss', unit: '%', value: null }],
            },
          }),
        )}
      />,
    );
    expect(screen.getByText('12 ms')).toBeDefined();
    // Not "0 %". A Down sensor recorded no value, and a zero would say it measured one.
    expect(screen.getByText('—')).toBeDefined();
  });

  it('asks for the graph range the author chose', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sensorId: 7,
            from: '',
            to: '',
            resolutionSeconds: 60,
            bucketCount: 0,
            source: 'sample',
            buckets: [],
            channels: [],
            segments: [],
            adjustments: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    render(
      <MapBoard
        view={resolved(
          widget({
            kind: 'graph',
            title: 'Latency',
            data: {
              kind: 'graph',
              objectId: 7,
              name: 'router-1',
              sensorState: 'up',
              rangeMinutes: 6 * 60,
              channels: CHANNELS,
            },
          }),
        )}
      />,
    );

    await waitFor(() => {
      expect(asked.length).toBe(1);
    });
    expect(asked[0]).toContain('/sensors/7/history?from=');
    // The tile says which period it is showing, because a canvas of graphs with different ranges
    // is only readable if each one is labelled.
    expect(screen.getByText(/Latency · 6 hours/)).toBeDefined();
  });
});
