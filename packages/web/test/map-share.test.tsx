import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapShare } from '../src/api/types';
import { MapSharePanel } from '../src/maps/MapSharePanel';
import { shareLinkFor, sharedBackgroundUrl, sharedMapPath } from '../src/maps/shareUrl';
import { SharedMapView } from '../src/routes/SharedMapView';
import { alertSaying, expectQuiet, speaking } from './support/refusal-region';

/**
 * Publishing a map, and reading one that was published (`G-06`).
 *
 * The claims here are the ones `ADR-002` makes conditions of the feature: that the warning is at
 * the point of sharing, that the URL is shown once because there is nothing to show later, and
 * that the page a stranger opens is the map and nothing else.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const LIVE: MapShare = {
  id: 3,
  label: 'NOC wall display',
  prefix: 'ab12cd34',
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
  createdBy: 'author',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the URLs', () => {
  it('keeps the API and the page apart', () => {
    // They cannot share a path: the API lives where the authentication hook can exempt one
    // namespace, and the page has to be a route the app shell serves.
    expect(sharedMapPath('abc')).toBe('/public/maps/abc');
    expect(sharedBackgroundUrl('abc')).toBe('/api/v1/public/maps/abc/background');
    expect(shareLinkFor('abc', 'https://ops.example')).toBe('https://ops.example/shared/abc');
  });

  it('escapes a token rather than pasting it into a path', () => {
    expect(sharedMapPath('a/b?c')).toBe('/public/maps/a%2Fb%3Fc');
  });
});

describe('making a link', () => {
  it('says what a link gives away, before one is made', () => {
    // `ADR-002` makes this a condition of the feature, not a nicety: the moment to say what is
    // being traded is the moment somebody decides.
    vi.stubGlobal('fetch', () => Promise.resolve(json({ items: [] })));
    render(<MapSharePanel mapId={4} />);
    expect(screen.getByText(/without signing in/)).toBeDefined();
    expect(screen.getByText(/what is failing right now/)).toBeDefined();
  });

  it('shows the URL once, and says why there is no second time', async () => {
    let made = false;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        made = true;
        return Promise.resolve(json({ share: LIVE, token: 'the-secret-token' }, 201));
      }
      return Promise.resolve(json({ items: made ? [LIVE] : [] }));
    });

    render(<MapSharePanel mapId={4} />);
    fireEvent.change(screen.getByLabelText(/What it is for/), {
      target: { value: 'NOC wall display' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make a link' }));

    await waitFor(() => {
      expect(screen.getByText(/\/shared\/the-secret-token$/)).toBeDefined();
    });
    expect(screen.getByText(/only time it can be shown/)).toBeDefined();
    // And the listing beside it never carries the token — only a prefix, because only a hash was
    // stored.
    await waitFor(() => {
      expect(screen.getByText('ab12cd34…')).toBeDefined();
    });
  });

  it('sends an expiry with every link, because one is required', async () => {
    const posts: { body: unknown }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ body: JSON.parse(init.body as string) as unknown });
        return Promise.resolve(json({ share: LIVE, token: 't' }, 201));
      }
      return Promise.resolve(json({ items: [] }));
    });

    render(<MapSharePanel mapId={4} />);
    fireEvent.change(screen.getByLabelText(/What it is for/), { target: { value: 'temporary' } });
    fireEvent.change(screen.getByLabelText(/Expires in/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make a link' }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    const body = posts[0]?.body as { label: string; expiresAt: string };
    expect(body.label).toBe('temporary');
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(0.9);
    expect(days).toBeLessThan(1.1);
  });

  it('leaves a revoked link off the list without asking again', async () => {
    // The core keeps the row — the record of what existed outlives the decision — and a list of
    // dead links is not what somebody deciding whether to revoke one needs to read.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ items: [{ ...LIVE, revokedAt: new Date().toISOString() }] })),
    );
    render(<MapSharePanel mapId={4} />);
    await waitFor(() => {
      expect(screen.getByText('No public links.')).toBeDefined();
    });
  });
});

describe('the page a stranger opens', () => {
  const shared = {
    name: 'Floor 1',
    widgets: [
      {
        id: 'w1',
        kind: 'status' as const,
        box: { x: 0, y: 0, w: 6, h: 4 },
        title: 'Router',
        state: 'ok' as const,
        data: {
          kind: 'status' as const,
          objectId: 7,
          name: 'router-1',
          sensorState: 'up',
          message: 'all fine',
          since: '2026-09-09T10:00:00.000Z',
        },
      },
    ],
    connectors: [],
    geo: null,
    tiles: null,
    problems: [],
    hasBackground: false,
  };

  const openAt = (token: string): void => {
    render(
      <MemoryRouter initialEntries={[`/shared/${token}`]}>
        <Routes>
          <Route path="/shared/:token" element={<SharedMapView />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('draws the map with no session and no chrome', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve(json(shared));
    });
    openAt('abc');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Floor 1' })).toBeDefined();
    });
    expect(screen.getByText('Router')).toBeDefined();
    // The one namespace the authentication hook exempts, and nothing else is reached.
    expect(asked.every((url) => url.startsWith('/api/v1/public/maps/'))).toBe(true);
    // No navigation: there is nothing else this viewer may open.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('shows the readings rather than a chart, because it cannot ask for history', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          ...shared,
          widgets: [
            {
              ...shared.widgets[0],
              kind: 'graph',
              title: 'Latency',
              data: {
                kind: 'graph',
                objectId: 7,
                name: 'router-1',
                sensorState: 'up',
                rangeMinutes: 60,
                channels: [{ key: 'rtt', name: 'Response time', unit: 'ms', value: 12 }],
              },
            },
          ],
        }),
      ),
    );
    openAt('abc');

    await waitFor(() => {
      expect(screen.getByText('12 ms')).toBeDefined();
    });
    expect(screen.getByText(/Latency · now/)).toBeDefined();
  });

  it('says the link does not work, without saying which way it failed', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({ error: { code: 'MAP_NOT_FOUND', message: 'this link is not valid' } }, 404),
      ),
    );
    openAt('stale');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'This link does not work' })).toBeDefined();
    });
    // Expired, revoked and never-existed are one answer on purpose: the difference is the only
    // useful thing a guesser could learn.
    expect(screen.getByText(/may have expired, or been revoked/)).toBeDefined();
  });
});

/**
 * A refused link, announced (`U-54`): said through an `ErrorPanel` in a region that is in the tree
 * and empty before anything is sent, so the refusal lands in a node that was there before it; the
 * next attempt empties it as it starts, so the same words are said again; one accepted leaves it
 * empty.
 */
describe('a refused link (U-54)', () => {
  it('is said in the region under the form, again, and emptied by one accepted', async () => {
    const refusals = [true, true, false];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(json({ items: [] }));
      return Promise.resolve(
        refusals.shift() === true
          ? json({ error: { code: 'MAP_SHARE_INVALID', message: 'expiry too far' } }, 400)
          : json({ share: LIVE, token: 'the-secret-token' }, 201),
      );
    });
    render(<MapSharePanel mapId={4} />);
    await screen.findByText('No public links.');
    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);
    // The form and the region are one block of the panel's stack.
    expect(region.parentElement?.firstElementChild?.tagName).toBe('FORM');
    const make = async (): Promise<void> => {
      fireEvent.change(screen.getByLabelText(/What it is for/), { target: { value: 'NOC' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Make a link' }));
    };

    await make();
    expect(await alertSaying('MAP_SHARE_INVALID')).toBe(region);
    await make();
    expect(region.matches(':empty')).toBe(true);
    expect(await alertSaying('MAP_SHARE_INVALID')).toBe(region);
    await make();
    expect(region.matches(':empty')).toBe(true);
    await screen.findByText(/\/shared\/the-secret-token$/);
    expect(speaking()).toEqual([]);
  });
});
