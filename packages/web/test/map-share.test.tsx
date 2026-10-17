import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapShare } from '../src/api/types';
import { MapSharePanel } from '../src/maps/MapSharePanel';
import { shareLinkFor, sharedBackgroundUrl, sharedMapPath } from '../src/maps/shareUrl';
import { SharedMapView } from '../src/routes/SharedMapView';
import { alertSaying, expectQuiet, speaking, statusSaying } from './support/refusal-region';

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

  /** Moves the page to another link without remounting it, as following one in the tab would. */
  let steer: ((to: string) => void) | null = null;
  function Steer(): null {
    const navigate = useNavigate();
    steer = (to) => {
      void navigate(to);
    };
    return null;
  }

  const openAt = (token: string): void => {
    render(
      <MemoryRouter initialEntries={[`/shared/${token}`]}>
        <Steer />
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

  /**
   * The minute's re-read (`U-66`). The clock is faked alone, so the page's own promises and
   * `waitFor` run as they do everywhere else; each read is held until the test answers it.
   */
  describe('each minute', () => {
    /** A held read's answer: a body, or no core at all (`fetch` itself rejects). */
    type Answer = { body: unknown; status?: number } | 'unreachable';
    type Reply = { body: unknown; status?: number } | 'hold';
    let replies: Reply[] = [];
    let waiting: ((answer: Answer) => void)[] = [];
    let reads = 0;
    let asked: string[] = [];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      replies = [];
      waiting = [];
      reads = 0;
      asked = [];
      vi.stubGlobal('fetch', (url: string) => {
        reads += 1;
        asked.push(url);
        const reply = replies.shift() ?? 'hold';
        if (reply !== 'hold') return Promise.resolve(json(reply.body, reply.status));
        return new Promise<Response>((resolve, reject) => {
          waiting.push((answer) => {
            if (answer === 'unreachable') reject(new TypeError('Failed to fetch'));
            else resolve(json(answer.body, answer.status));
          });
        });
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const failure = (id: string, status = 500): { body: unknown; status: number } => ({
      status,
      body: { error: { code: 'INTERNAL', message: 'the database went away', correlationId: id } },
    });

    /** The next minute, and its read answered with `reply` once it has been asked. */
    const minute = async (reply: { body: unknown; status?: number }): Promise<void> => {
      const before = reads;
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => {
        expect(reads).toBe(before + 1);
        expect(waiting).toHaveLength(1);
      });
      // Asked, and not answered: the map is what is on the page meanwhile.
      expect(screen.getByRole('heading', { name: 'Floor 1' })).toBeDefined();
      expect(screen.getByText('Router')).toBeDefined();
      expect(screen.queryByText('Loading the map…')).toBeNull();
      act(() => {
        waiting.shift()?.(reply);
      });
    };

    /** Everything taken off or put on the page, from the first map on. */
    const watch = (): MutationRecord[] => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => {
        records.push(...batch);
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      return records;
    };
    const dropped = (records: MutationRecord[]): string[] =>
      records.flatMap((record) =>
        [...record.removedNodes]
          .map((node) => node.textContent ?? '')
          .filter((text) => text.includes('Router') || text.includes('Floor 1')),
      );
    const loadingShown = (records: MutationRecord[]): boolean =>
      records.some((record) =>
        [...record.addedNodes].some((node) => (node.textContent ?? '').includes('Loading')),
      );
    const region = (): HTMLElement =>
      screen
        .getAllByRole('status')
        .find(
          (one) =>
            one.getAttribute('aria-live') === 'polite' && !one.textContent.startsWith('Loading'),
        ) as HTMLElement;

    it('keeps the map on the page while the next one is read', async () => {
      replies = [{ body: shared }];
      openAt('abc');
      await screen.findByRole('heading', { name: 'Floor 1' });
      const heading = screen.getByRole('heading', { name: 'Floor 1' });
      const records = watch();

      await minute({ body: shared });
      await minute({ body: { ...shared, description: 'Second floor too' } });
      await screen.findByText('Second floor too');
      await minute({ body: shared });
      await waitFor(() => {
        expect(screen.queryByText('Second floor too')).toBeNull();
      });

      expect(reads).toBe(4);
      expect(heading.isConnected).toBe(true);
      await waitFor(() => {
        expect(records.length).toBeGreaterThan(0);
      });
      expect(dropped(records)).toEqual([]);
      expect(loadingShown(records)).toBe(false);
    });

    it('says a failed refresh without taking the map away, once, until a read succeeds', async () => {
      replies = [{ body: shared }];
      openAt('abc');
      await screen.findByRole('heading', { name: 'Floor 1' });
      const said = region();
      expectQuiet(said, ['mt-2', 'empty:mt-0'], 'polite');
      const records = watch();

      await minute(failure('req-1'));
      await waitFor(() => {
        expect(said.textContent).toContain('could not be read again');
      });
      expect(said.textContent).toContain('may be out of date (the database went away)');
      expect(said.textContent).toContain(' req-1');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Router')).toBeDefined();

      // The same failure a minute later is not news: the one said stays, id and all.
      await minute(failure('req-2'));
      await waitFor(() => {
        expect(reads).toBe(3);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(said.textContent).toContain(' req-1');
      expect(said.textContent).not.toContain('req-2');

      await minute({ body: shared });
      await waitFor(() => {
        expect(said.textContent).toBe('');
      });
      expect(region()).toBe(said);
      expect(dropped(records)).toEqual([]);
      expect(loadingShown(records)).toBe(false);
    });

    it('drops the map when the link stops working, for good', async () => {
      const notFound = {
        status: 404,
        body: { error: { code: 'MAP_NOT_FOUND', message: 'this link is not valid' } },
      };
      replies = [{ body: shared }];
      openAt('abc');
      await screen.findByRole('heading', { name: 'Floor 1' });

      await minute(notFound);
      await screen.findByRole('heading', { name: 'This link does not work' });
      expect(screen.queryByText('Router')).toBeNull();
      const alert = await statusSaying('this link is not valid');
      const records = watch();

      // Later minutes (`U-66` review, `U-74`): the link is not asked for again, the map does not
      // come back, nothing is loading, and the alert is the same node, never touched.
      for (let later = 0; later < 5; later += 1) {
        act(() => {
          vi.advanceTimersByTime(60_000);
        });
        await settle();
        expect(screen.getByRole('heading', { name: 'This link does not work' })).toBeDefined();
        expect(screen.queryByText('Loading the map…')).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Floor 1' })).toBeNull();
        expect(screen.queryByText('Router')).toBeNull();
      }

      expect(reads).toBe(2);
      expect(waiting).toEqual([]);
      expect(alert.isConnected).toBe(true);
      expect(alert.textContent).toContain('this link is not valid');
      expect(records.filter((record) => alert.contains(record.target))).toEqual([]);
      expect(dropped(records)).toEqual([]);
      expect(
        records.some((record) =>
          [...record.addedNodes].some((node) =>
            /Floor 1|Router|Loading|could not be read again/u.test(node.textContent ?? ''),
          ),
        ),
      ).toBe(false);

      // Another link is asked for as any link is, and again each minute.
      replies = [
        { body: { ...shared, name: 'Floor 2' } },
        { body: { ...shared, name: 'Floor 2' } },
      ];
      act(() => {
        steer?.('/shared/def');
      });
      await screen.findByRole('heading', { name: 'Floor 2' });
      expect(asked.slice(2)).toEqual(['/api/v1/public/maps/def?t=6']);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => {
        expect(reads).toBe(4);
      });
      expect(asked[3]).toBe('/api/v1/public/maps/def?t=7');

      // And the one that 404'd is still not asked for when the page goes back to it.
      act(() => {
        steer?.('/shared/abc');
      });
      await screen.findByRole('heading', { name: 'This link does not work' });
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      await settle();
      expect(reads).toBe(4);
      expect(asked.filter((url) => url.startsWith('/api/v1/public/maps/abc?'))).toEqual([
        '/api/v1/public/maps/abc?t=0',
        '/api/v1/public/maps/abc?t=1',
      ]);
    });

    /** Today at `hours:minutes`, local time, as the page's clock will read it. */
    const todayAt = (hours: number, minutes: number): number => {
      const at = new Date();
      at.setHours(hours, minutes, 0, 0);
      return at.getTime();
    };
    const asTime = (at: number): string =>
      new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    /** The nearest node, from `node` up, whose changes a screen reader says on its own. */
    const liveAncestor = (node: Element): Element | null => {
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const live = at.getAttribute('aria-live');
        const role = at.getAttribute('role') ?? '';
        if ((live !== null && live !== 'off') || LIVE_ROLES.includes(role)) return at;
      }
      return null;
    };

    it('says when the map was last read, beside it and not aloud, until a read succeeds', async () => {
      let now = todayAt(14, 5);
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      replies = [{ body: shared }];
      openAt('abc');
      await screen.findByRole('heading', { name: 'Floor 1' });
      const line = screen.getByText(/^Last read/u);
      const time = (): HTMLTimeElement => line.querySelector('time') as HTMLTimeElement;
      const readAt = (at: number): void => {
        expect(time().dateTime).toBe(new Date(at).toISOString());
        expect(line.textContent).toBe(`Last read ${asTime(at)}`);
      };
      readAt(todayAt(14, 5));
      // It changes once a minute while reads succeed: in no live region, so it is not said.
      expect(liveAncestor(line)).toBeNull();
      const said = region();
      expect(said.contains(line)).toBe(false);

      // A good read moves it.
      now = todayAt(14, 6);
      await minute({ body: shared });
      await waitFor(() => {
        readAt(todayAt(14, 6));
      });
      expect(said.textContent).toBe('');

      // Failed ones leave it where it was, with the failure said under it.
      now = todayAt(14, 7);
      await minute(failure('req-1'));
      await waitFor(() => {
        expect(said.textContent).toContain('could not be read again');
      });
      now = todayAt(14, 8);
      await minute(failure('req-2'));
      await settle();
      expect(reads).toBe(4);
      expect(line.isConnected).toBe(true);
      readAt(todayAt(14, 6));
      expect(said.textContent).toContain(' req-1');
      expect(liveAncestor(line)).toBeNull();

      // The next good read moves it again and empties the region.
      now = todayAt(14, 9);
      await minute({ body: shared });
      await waitFor(() => {
        readAt(todayAt(14, 9));
      });
      expect(said.textContent).toBe('');
      expect(line.isConnected).toBe(true);
    });

    it('gives the day of a read that was not today', async () => {
      const yesterday = todayAt(23, 58) - 86_400_000;
      vi.spyOn(Date, 'now').mockImplementation(() => yesterday);
      replies = [{ body: shared }];
      openAt('abc');
      await screen.findByRole('heading', { name: 'Floor 1' });
      const day = new Date(yesterday).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      });
      expect(screen.getByText(/^Last read/u).textContent).toBe(
        `Last read ${day}, ${asTime(yesterday)}`,
      );
    });
  });
});

/** The roles whose changes a screen reader says without being asked. */
const LIVE_ROLES = ['status', 'alert', 'log', 'timer', 'marquee'];

/** Only the interval is faked: a real task lets anything a tick started get under way. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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
