import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ReportSummary } from '../src/api/types';
import type * as Stream from '../src/api/stream';
import { SessionContext, type SessionContextValue } from '../src/auth/session';
import { PLACED_MS } from '../src/components/HeldListFailure';
import { ReadRegion, ReadState } from '../src/components/ReadRegion';
import { MapSharePanel } from '../src/maps/MapSharePanel';
import { AlarmsView } from '../src/routes/AlarmsView';
import { ChannelsWithoutLookupView } from '../src/routes/ChannelsWithoutLookupView';
import { CredentialsPanel } from '../src/routes/detail/CredentialsPanel';
import { StateLogPanel } from '../src/routes/detail/StateLogPanel';
import { TriggersPanel } from '../src/routes/detail/TriggersPanel';
import { DiscoveryView } from '../src/routes/DiscoveryView';
import { MapDesignView } from '../src/routes/MapDesignView';
import { MapsView } from '../src/routes/MapsView';
import { MapView } from '../src/routes/MapView';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';
import { Overview } from '../src/routes/Overview';
import { RediscoveryPanel } from '../src/routes/RediscoveryPanel';
import { ReportsView } from '../src/routes/ReportsView';
import { ReportView } from '../src/routes/ReportView';
import { SharedMapView } from '../src/routes/SharedMapView';
import { UnboundedCredentialsView } from '../src/routes/UnboundedCredentialsView';
import { FAILED } from './support/try-again';

/**
 * A read that fails is said in a region that was there before it (`U-58`).
 *
 * About thirty `ErrorPanel`s used to be mounted with their text already in them when a read
 * failed: the loading line went and an alert holding the failure took its place, which is not
 * reliably announced (`U-41`). Decided 2026-10-11: announce them, through an always-present region.
 * Every page that reads now shows its loading line in a polite region (`ReadState`,
 * `ReadRegion`), and the failure comes into that same node.
 *
 * Each page here is opened with the read under test held, so the region can be taken while the
 * loading line is in it; then the read fails, and the failure has to be in that node, with *Try
 * again*, and no alert anywhere for it. The pages the round trip of `U-68` already drives — the
 * object page, Templates, the History tab, an Overview card, the sensor types page, adding a
 * sensor, the Logs page's three tabs, the tree — are held to the same region there
 * (`support/try-again.ts`).
 */

vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

const SESSION: SessionContextValue = {
  session: { kind: 'anonymous', requireAuthentication: false },
  signedIn: () => undefined,
  signOut: () => Promise.resolve(),
  refresh: () => undefined,
  askingToSignIn: false,
  askToSignIn: () => undefined,
};

/** The read under test, held until released, then refused; `answers` answered; anything else a 404. */
function core(
  held: string,
  answers: Readonly<Record<string, unknown>> = {},
): { release: () => void } {
  const waiting: (() => void)[] = [];
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    if (path === held || path.startsWith(`${held}?`)) {
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          resolve(
            reply(500, {
              error: { code: 'INTERNAL', message: FAILED, correlationId: 'req-58' },
            }),
          );
        });
      });
    }
    if (path in answers) return Promise.resolve(reply(200, answers[path]));
    return Promise.resolve(reply(404, { error: { code: 'NOT_FOUND', message: 'no' } }));
  });
  return {
    release: () => {
      for (const one of waiting.splice(0)) one();
    },
  };
}

/** A report that can run, for the card its runs are read into. */
const REPORT: ReportSummary = {
  id: 7,
  name: 'Monthly uptime',
  description: '',
  kind: 'table_only',
  subjects: { objectIds: [41] },
  span: { kind: 'month', offset: 1 },
  resolved: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
    label: '2026-08 (UTC)',
    timezone: 'UTC',
    bucketSeconds: 3_600,
    source: 'sample_1h',
    adjustments: [],
  },
  outputs: { formats: ['html'], delivery: 'store', recipients: [], zip: false },
  schedule: { kind: 'monthly', minute: 120, dayOfMonth: 1 },
  scheduleSummary: 'on the 1st of every month at 02:00',
  nextRunAt: '2026-10-01T02:00:00.000Z',
  lastRunAt: null,
  runAs: { login: 'alice', available: true },
  version: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `element` at `at`, inside a router that gives it its `:id` or `:token`, and a session. */
function open(element: React.JSX.Element, at = '/', pattern = '*'): void {
  render(
    <SessionContext.Provider value={SESSION}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

/** The polite region a loading line is in: never the line itself, never an alert. */
async function regionOf(line: string): Promise<{ region: HTMLElement; said: HTMLElement }> {
  const said = await waitFor(() => {
    const found = screen
      .getAllByText(line)
      .find((one) => one.getAttribute('role') === null && one.closest('[role="status"]') !== null);
    if (found === undefined) throw new Error(`no region holds “${line}”`);
    return found;
  });
  const region = said.closest<HTMLElement>('[role="status"]');
  if (region === null) throw new Error('no region');
  return { region, said };
}

/**
 * Released and refused: the failure lands in `region`, which never left, and is said politely —
 * with *Try again*, unless the page reads again by itself (a shared map, every minute).
 */
async function failsIn(
  region: HTMLElement,
  said: HTMLElement,
  release: () => void,
  retry = true,
): Promise<void> {
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(region.textContent).toContain(FAILED);
  });
  expect(region.isConnected).toBe(true);
  expect(said.isConnected).toBe(false);
  expect(region.getAttribute('role')).toBe('status');
  expect(region.closest('[role="alert"]')).toBeNull();
  expect(region.querySelector('[role="alert"]')).toBeNull();
  expect(region.textContent).toContain('req-58');
  expect(within(region).queryAllByRole('button', { name: 'Try again' })).toHaveLength(
    retry ? 1 : 0,
  );
  expect(screen.queryAllByRole('alert').filter((one) => one.textContent.includes(FAILED))).toEqual(
    [],
  );
}

const PAGES: readonly {
  name: string;
  held: string;
  line: string;
  /** What `open` is given: the page, and where it is opened. */
  page: readonly [React.JSX.Element, string?, string?];
  answers?: Readonly<Record<string, unknown>>;
  retry?: false;
}[] = [
  {
    name: 'Reports',
    held: '/reports',
    line: 'Loading reports…',
    page: [<ReportsView />],
  },
  {
    name: 'a report',
    held: '/reports/7',
    line: 'Loading the report…',
    page: [<ReportView />, '/reports/7', '/reports/:id'],
  },
  {
    name: 'a report’s runs',
    held: '/reports/7/runs',
    answers: { '/reports/7': REPORT },
    line: 'Loading runs…',
    page: [<ReportView />, '/reports/7', '/reports/:id'],
  },
  { name: 'Maps', held: '/maps', line: 'Loading maps…', page: [<MapsView />] },
  {
    name: 'a map',
    held: '/maps/3/view',
    line: 'Loading the map…',
    page: [<MapView />, '/maps/3', '/maps/:id'],
  },
  {
    name: 'a map’s designer',
    held: '/maps/3',
    line: 'Loading the map…',
    page: [<MapDesignView />, '/maps/3/design', '/maps/:id/design'],
  },
  {
    name: 'a map’s public links',
    held: '/maps/3/shares',
    line: 'Loading links…',
    page: [<MapSharePanel mapId={3} />],
  },
  {
    name: 'a shared map',
    held: '/public/maps/abc',
    retry: false,
    line: 'Loading the map…',
    page: [<SharedMapView />, '/shared/abc', '/shared/:token'],
  },
  { name: 'Alarms', held: '/alarms', line: 'Loading alarms…', page: [<AlarmsView />] },
  {
    name: 'the Overview’s totals',
    held: '/objects/counts',
    line: 'Loading the totals…',
    page: [<Overview />],
  },
  {
    name: 'the Overview’s sensor types',
    held: '/sensor-types',
    line: 'Loading sensor types…',
    page: [<Overview />],
  },
  {
    name: 'Discovery',
    held: '/objects',
    line: 'Loading discovery…',
    page: [<DiscoveryView />],
  },
  {
    name: 'the rediscovery rules',
    held: '/discovery/schedules',
    line: 'Loading rediscovery rules…',
    page: [<RediscoveryPanel probes={[]} groups={[]} templates={[]} />],
  },
  {
    name: 'the channels without their lookup',
    held: '/channels/without-lookup',
    line: 'Loading the channels without their lookup…',
    page: [<ChannelsWithoutLookupView />],
  },
  {
    name: 'the sets without bounds',
    held: '/credentials/unbounded',
    line: 'Loading the sets without bounds…',
    page: [<UnboundedCredentialsView />],
  },
  {
    name: 'an object’s triggers',
    held: '/objects/5/triggers',
    line: 'Loading triggers…',
    page: [<TriggersPanel objectId={5} inheritsTriggers />],
  },
  {
    name: 'an object’s state log',
    held: '/state-log',
    line: 'Loading the state log…',
    page: [<StateLogPanel objectId={5} isSensor />],
  },
  {
    name: 'an object’s credentials',
    held: '/objects/5/credentials',
    line: 'Loading credentials…',
    page: [<CredentialsPanel object={{ id: 5, name: 'Rack A', kind: 'group' }} ancestors={[]} />],
  },
];

describe('a failed read lands in the region its loading line was in (U-58)', () => {
  it.each(PAGES)('$name', async ({ held, answers, line, page, retry }) => {
    const { release } = core(held, answers);
    open(...page);
    const { region, said } = await regionOf(line);
    await failsIn(region, said, release, retry);
  });
});

describe('the object page’s own reads (U-58)', () => {
  const GROUP = {
    id: 5,
    parentId: 1,
    kind: 'group',
    name: 'Core switches',
    tags: [],
    priority: 3,
    version: 1,
    hasChildren: false,
    comments: '',
    inheritsTriggers: true,
    childCount: 0,
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
  };

  /** The page, with its object answered and `held` held then refused. */
  function page(held: string, tab: string): { release: () => void } {
    const waiting: (() => void)[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const path = url.replace(/^.*\/api\/v1/u, '');
      const reply = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (path === held || path.startsWith(`${held}?`)) {
        return new Promise<Response>((resolve) => {
          waiting.push(() => {
            resolve(
              reply(500, { error: { code: 'INTERNAL', message: FAILED, correlationId: 'req-58' } }),
            );
          });
        });
      }
      if (path === '/objects/5') return Promise.resolve(reply(200, GROUP));
      if (path === '/objects/5/ancestors') return Promise.resolve(reply(200, { items: [] }));
      return Promise.resolve(reply(404, { error: { code: 'NOT_FOUND', message: 'no' } }));
    });
    open(<ObjectDetailView />, `/objects/5?tab=${tab}`, '/objects/:id');
    return {
      release: () => {
        for (const one of waiting.splice(0)) one();
      },
    };
  }

  it('the Settings tab', async () => {
    const { release } = page('/objects/5/settings', 'settings');
    const { region, said } = await regionOf('Loading settings…');
    await failsIn(region, said, release);
  });

  it('the Changes tab', async () => {
    const { release } = page('/objects/5/audit', 'changes');
    const { region, said } = await regionOf('Loading the audit log…');
    await failsIn(region, said, release);
  });
});

describe('a region that comes onto the page with its failure (U-58)', () => {
  it('is empty as it mounts and says the failure a moment after', () => {
    vi.useFakeTimers();
    const error = new ApiError(500, 'INTERNAL', FAILED, 'req-1');
    render(<ReadRegion error={error} retry={() => undefined} />);
    const region = screen.getByRole('status');
    expect(region.matches(':empty')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PLACED_MS - 1);
    });
    expect(region.matches(':empty')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region.textContent).toContain(FAILED);
    expect(screen.getByRole('status')).toBe(region);
  });

  it('says one that comes later at once, in the node that was there', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ReadRegion error={null} loading="the thing" />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('Loading the thing…');
    act(() => {
      vi.advanceTimersByTime(PLACED_MS);
    });
    rerender(<ReadRegion error={new ApiError(500, 'INTERNAL', FAILED)} loading="the thing" />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toContain(FAILED);
    expect(region.textContent).not.toContain('Loading');
  });

  it('waits on several reads together, and says the first that failed', () => {
    const loading = { status: 'loading' as const, retry: () => undefined };
    const ready = { status: 'ready' as const, retry: () => undefined };
    const failed = (message: string) => ({
      status: 'error' as const,
      error: new ApiError(500, 'INTERNAL', message),
      retry: () => undefined,
    });
    vi.useFakeTimers();
    const { rerender, container } = render(
      <ReadState read={[failed('first'), loading]} what="both" />,
    );
    act(() => {
      vi.advanceTimersByTime(PLACED_MS);
    });
    // One still out: the loading line, as the pages' early returns had it.
    expect(container.textContent).toBe('Loading both…');
    rerender(<ReadState read={[failed('first'), failed('second')]} what="both" />);
    expect(container.textContent).toContain('first');
    expect(container.textContent).not.toContain('second');
    rerender(<ReadState read={[ready, ready]} what="both" />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
