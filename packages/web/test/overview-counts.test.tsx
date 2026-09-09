import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '../src/routes/Overview';

/** An installation far larger than any one page of the tree — 5,051 sensors, as `P-15` runs. */
const COUNTS = {
  objects: { probe: 2, group: 6, device: 269, sensor: 5051, total: 5329 },
  sensorStates: {
    unknown: 0,
    up: 5048,
    warning: 0,
    down: 3,
    down_acknowledged: 0,
    down_partial: 0,
    unusual: 0,
    paused: 0,
  },
};

/** Records every URL asked for, and answers from a scripted map. */
function stubFetch(routes: Record<string, unknown>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const body = routes[url];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

const ROUTES = {
  '/api/v1/objects/root': { id: 1, kind: 'root', name: 'Root', version: 1 },
  '/api/v1/objects/1/counts': COUNTS,
  '/api/v1/sensor-types': { items: [{ id: 'icmp.ping', category: 'availability' }] },
  '/api/v1/openapi.json': { info: { version: '0.1.0' } },
};

/** Waits for the tile with this label to show this value — the label renders before it does. */
const expectTile = async (label: string, value: string): Promise<void> => {
  await waitFor(() => {
    const card = screen.getByText(label).parentElement;
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText(value)).toBeDefined();
  });
};

/**
 * The overview reports totals, not what fitted in one response (`U-14`).
 *
 * It used to read `/objects/{root}/tree?maxDepth=12&limit=1000` and count the rows, which meant
 * every headline number was silently a lower bound on any installation past the limit — 930
 * sensors shown for the 5,051 below, with the only hint a truncation note in a card further
 * down the page. The numbers are what an operator reads first, so they are the last thing that
 * may be quietly partial.
 */
describe('the overview’s totals', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the whole tree’s counts, not one page of it', async () => {
    const asked = stubFetch(ROUTES);
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    await expectTile('Sensors', '5,051');
    await expectTile('Devices', '269');
    await expectTile('Groups', '6');
    await expectTile('Probes', '2');

    // The regression, stated as the request that is no longer made: a page of the tree cannot
    // answer this question, so it is not asked for.
    expect(asked.some((url) => url.includes('/tree'))).toBe(false);
    expect(asked).toContain('/api/v1/objects/1/counts');
  });

  it('breaks the sensors down by state, and says nothing about the states with none', async () => {
    stubFetch(ROUTES);
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('5,048')).toBeDefined();
    });
    expect(screen.getByText('3')).toBeDefined();
    // A zero is a row that says "none of these", which on a health summary reads as a category
    // to worry about. Every state comes back, and the ones at zero are not drawn.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('says how big the tree is without pretending to have read all of it', async () => {
    stubFetch(ROUTES);
    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/5,329 objects in the tree/)).toBeDefined();
    expect(screen.queryByText(/Truncated/)).toBeNull();
  });

  describe('the starred maps (`G-09`)', () => {
    const mapOf = (id: number, priority: number, name: string) => ({
      id,
      name,
      description: '',
      priority,
      layout: { widgets: [] },
      version: 1,
      createdAt: '2026-09-09T09:00:00.000Z',
      updatedAt: '2026-09-09T09:00:00.000Z',
    });

    const overview = (): void => {
      render(
        <MemoryRouter>
          <Overview />
        </MemoryRouter>,
      );
    };

    it('lists the five-star ones and leaves the rest to the Maps page', async () => {
      stubFetch({
        ...ROUTES,
        '/api/v1/maps': {
          items: [mapOf(1, 5, 'Ground floor'), mapOf(2, 3, 'Spare rack'), mapOf(3, 5, 'DC2')],
        },
      });
      overview();

      expect(await screen.findByRole('link', { name: 'Ground floor' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'DC2' })).toBeDefined();
      expect(screen.queryByRole('link', { name: 'Spare rack' })).toBeNull();
    });

    it('says none are starred rather than showing a blank card', async () => {
      // An installation with maps and no stars is a status report, not an empty space.
      stubFetch({ ...ROUTES, '/api/v1/maps': { items: [mapOf(1, 3, 'Ground floor')] } });
      overview();

      expect(await screen.findByText(/None of the 1 map is starred/)).toBeDefined();
    });

    it('carries no maps card at all on an installation with no maps', async () => {
      // A card explaining a feature nobody has reached for is a card everybody reads past.
      stubFetch({ ...ROUTES, '/api/v1/maps': { items: [] } });
      overview();

      // Something else on the page has to have rendered before this means anything.
      await waitFor(() => {
        expect(screen.getByText('5,329 objects in the tree', { exact: false })).toBeDefined();
      });
      expect(screen.queryByText('Maps')).toBeNull();
    });
  });
});
