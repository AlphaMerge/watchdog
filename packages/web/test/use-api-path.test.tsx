import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi } from '../src/api/client';
import type { Alarm, AlarmPage } from '../src/api/types';
import { AlarmsView } from '../src/routes/AlarmsView';

/**
 * `useApi` never answers one path with another's answer (`U-62`).
 *
 * On the render after its path changes the hook still held the previous path's answer, its effect
 * not having run, so every page that stays mounted across a change of id drew the previous object
 * for one frame. And a caller that keeps its last answer in sight while the next is read holds it
 * itself, which the change must leave as it was.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Answers held by path, each released by hand. */
let pending: Map<string, () => void> = new Map();
function release(path: string): void {
  const one = pending.get(path);
  if (one === undefined) throw new Error(`nothing asked for ${path}`);
  pending.delete(path);
  act(() => {
    one();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useApi across a change of path', () => {
  beforeEach(() => {
    pending = new Map();
    vi.stubGlobal(
      'fetch',
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.set(url, () => {
            resolve(json({ from: url }));
          });
        }),
    );
  });

  it('says loading from the render the path changes on, and keeps an answer when asked nothing', async () => {
    const seen: { path: string | null; status: string; from?: string; answered: string | null }[] =
      [];
    const start: { path: string | null } = { path: '/a' };
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) => {
        const answer = useApi<{ from: string }>(path);
        seen.push({
          path,
          status: answer.status,
          ...(answer.status === 'ready' ? { from: answer.data.from } : {}),
          answered: answer.answered,
        });
        return answer;
      },
      { initialProps: start },
    );
    await waitFor(() => {
      expect(pending.has('/api/v1/a')).toBe(true);
    });
    release('/api/v1/a');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.answered).toBe('/a');

    seen.length = 0;
    rerender({ path: '/b' });
    // The very render that asks for `/b`, before any effect: not `/a`'s answer.
    expect(seen[0]).toEqual({ path: '/b', status: 'loading', answered: null });
    await waitFor(() => {
      expect(pending.has('/api/v1/b')).toBe(true);
    });
    release('/api/v1/b');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    // Presence first: an empty list would pass the check below.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((one) => one.status === 'ready').map((one) => one.from)).toEqual(
      seen.filter((one) => one.status === 'ready').map(() => '/api/v1/b'),
    );
    expect(result.current.answered).toBe('/b');

    // A path set to null asks nothing and keeps the answer, with the path it was read from.
    rerender({ path: null });
    expect(result.current.status).toBe('ready');
    expect(result.current.answered).toBe('/b');
  });

  it('says loading, not the answer in hand, while the same path is read again', async () => {
    const { result } = renderHook(() => useApi<{ from: string }>('/a'));
    await waitFor(() => {
      expect(pending.has('/api/v1/a')).toBe(true);
    });
    release('/api/v1/a');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    act(() => {
      result.current.reload();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.answered).toBeNull();
  });
});

function row(sensorId: number, name: string): Alarm {
  return {
    sensorId,
    sensorName: name,
    state: 'down',
    cause: 'scan',
    message: '',
    since: '2026-10-09T11:50:00.000Z',
    priority: 3,
    path: [1, 2, 7, sensorId],
    pathNames: ['Root', 'probe-1', 'probe-box', name],
    acknowledged: false,
    acknowledgedUntil: null,
    consecutiveFailures: 2,
    recovering: null,
  };
}

const page = (alarm: Alarm): AlarmPage => ({
  items: [alarm],
  total: 1,
  counts: { down: 1 },
  now: '2026-10-09T12:00:00.000Z',
});

/** A socket that never opens: no state frame arrives, so any reload is the list's own. */
class QuietSocket {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  send(): void {}
  close(): void {}
}

const BY_PRIORITY = '/api/v1/alarms?limit=200&sort=priority';
const BY_DURATION = '/api/v1/alarms?limit=200&sort=duration';

describe('a caller that keeps its last answer in sight', () => {
  beforeEach(() => {
    pending = new Map();
    vi.stubGlobal('WebSocket', QuietSocket);
    vi.stubGlobal('fetch', (url: string) => {
      if (url === BY_PRIORITY) return Promise.resolve(json(page(row(10, 'Ping'))));
      if (url === BY_DURATION) {
        return new Promise<Response>((resolve) => {
          pending.set(url, () => {
            resolve(json(page(row(11, 'HTTP'))));
          });
        });
      }
      return Promise.resolve(json({}, 404));
    });
  });

  it('still shows the alarm list it had, dimmed, while a changed filter is read', async () => {
    render(
      <MemoryRouter>
        <AlarmsView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Ping')).toBeDefined();

    const removed: string[] = [];
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) removed.push(node.textContent ?? '');
      }
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.change(screen.getByDisplayValue('priority, then duration'), {
        target: { value: 'duration' },
      });
      await waitFor(() => {
        expect(pending.has(BY_DURATION)).toBe(true);
      });
      // The old list stands while the new one is read, said to be busy, and was never taken
      // away, not for one render.
      expect(screen.getByText('Ping')).toBeDefined();
      expect(screen.getByText('Ping').closest('[aria-busy="true"]')).not.toBeNull();
      expect(screen.queryByText('Loading alarms…')).toBeNull();
      expect(removed.filter((text) => text.includes('Ping'))).toEqual([]);

      release(BY_DURATION);
      expect(await screen.findByText('HTTP')).toBeDefined();
      expect(screen.queryByText('Ping')).toBeNull();
    } finally {
      watcher.disconnect();
    }
  });
});
