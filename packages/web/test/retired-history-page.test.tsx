import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type {
  ChannelRecord,
  HistoryChannel,
  HistorySeries,
  ObjectDetail,
  SensorValues,
} from '../src/api/types';
import { RELIST_MIN_MS } from '../src/routes/detail/model';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));
// The canvas is uPlot's, and jsdom has none; the legend, which this is about, is ours.
vi.mock('../src/charts/TimeSeriesChart', () => ({ TimeSeriesChart: () => null }));

/**
 * Retired channels on the sensor page, kept current (`U-55`).
 *
 * The History tab hides them with the channel table's own `?retired=hide`, one choice for the
 * page; and the channel list both read is read again when the values poll says it is stale about
 * a retired channel, and only then, at most once a minute.
 */

const NO_LIMITS: ChannelRecord['limits'] = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

const channel = (id: number, key: string, retired: boolean): ChannelRecord => ({
  id,
  key,
  name: `Column ${key}`,
  unit: '',
  isPrimary: id === 1,
  limits: NO_LIMITS,
  scaleMul: '1',
  scaleDiv: '1',
  decimals: null,
  spikeMin: null,
  spikeMax: null,
  lookupId: null,
  counterBits: null,
  declaredLookup: null,
  retired,
});

const SENSOR: ObjectDetail = {
  id: 9,
  parentId: 4,
  kind: 'sensor',
  name: 'Storage table',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
  sensorType: 'snmp.table',
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
  params: {},
  redactedParams: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const unavailable = (): Response =>
  json({ error: { code: 'UNAVAILABLE', message: 'restarting', context: {}, details: {} } }, 503);

/** Whether the core holds Column b retired: what the list answers, and `/values` with it. */
let listSaysRetired = true;
let valuesSayRetired = true;
let valuesUp = true;
let historyUp = true;
let listReads = 0;
let polls = 0;

function listAnswer(): { items: ChannelRecord[] } {
  return {
    items: [channel(1, 'a', false), channel(2, 'b', listSaysRetired), channel(3, 'c', false)],
  };
}

/** Each answer reads Column a anew, so a test can see which poll's answer is on the page. */
function valuesAnswer(): SensorValues {
  const now = new Date().toISOString();
  return {
    sensorId: 9,
    readAt: now,
    notBefore: now,
    intervalSeconds: 60,
    channels: listAnswer().items.map((one) => ({
      id: one.id,
      key: one.key,
      name: one.name,
      unit: '',
      decimals: null,
      value: one.id === 1 ? 100 + polls : one.id === 2 && !valuesSayRetired ? 7 : null,
      at: one.id === 1 || (one.id === 2 && !valuesSayRetired) ? now : null,
      retired: one.id === 2 ? valuesSayRetired : false,
    })),
  };
}

function historyAnswer(): HistorySeries {
  const buckets = ['2026-10-09T07:58:00.000Z', '2026-10-09T07:59:00.000Z'];
  const series = (id: number, key: string): HistoryChannel => ({
    id,
    key,
    name: `Column ${key}`,
    unit: '',
    decimals: null,
    avg: [id, id],
    min: [id, id],
    max: [id, id],
    count: [1, 1],
  });
  return {
    sensorId: 9,
    from: buckets[0] ?? '',
    to: '2026-10-09T08:00:00.000Z',
    resolutionSeconds: 60,
    bucketCount: buckets.length,
    source: 'sample',
    buckets,
    // One unit, one panel; the retired channel in the middle of it.
    channels: [series(1, 'a'), series(2, 'b'), series(3, 'c')],
    segments: [],
    adjustments: [],
  };
}

let where = '';
function Where(): null {
  const location = useLocation();
  where = `${location.pathname}${location.search}`;
  return null;
}

function mount(at: string): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="/objects/:id"
          element={
            <>
              <ObjectDetailView />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** What the page does every fifteen seconds, and on coming back to a hidden tab. */
function poll(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Polls, and waits until that poll's answer is the one on the page. */
async function pollAndSettle(): Promise<void> {
  const before = polls;
  poll();
  await waitFor(() => {
    expect(polls).toBe(before + 1);
  });
  expect(await screen.findByText(String(100 + polls))).toBeDefined();
}

const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Hide retired channels' });
const legend = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((entry) => entry.querySelector('.text-text-muted')?.textContent ?? '');
const rowOf = (name: string): HTMLElement => {
  const row = screen.getByText(name).closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
};

/** A monotonic clock this file can move on, so a minute passes without waiting one. */
let skipped = 0;

beforeEach(() => {
  listSaysRetired = true;
  valuesSayRetired = true;
  valuesUp = true;
  historyUp = true;
  listReads = 0;
  polls = 0;
  skipped = 0;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => real() + skipped);
  // The poll asks nothing of a hidden page; jsdom's may not say it is visible.
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.split('?')[0];
    if (path === '/api/v1/objects/9') return Promise.resolve(json(SENSOR));
    if (path === '/api/v1/objects/9/channels') {
      listReads += 1;
      return Promise.resolve(json(listAnswer()));
    }
    if (path === '/api/v1/sensors/9/values') {
      if (!valuesUp) return Promise.resolve(unavailable());
      polls += 1;
      return Promise.resolve(json(valuesAnswer()));
    }
    if (path === '/api/v1/sensors/9/history') {
      return Promise.resolve(historyUp ? json(historyAnswer()) : unavailable());
    }
    return Promise.resolve(json({}, 404));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hiding retired channels on the History tab', () => {
  it('is the page’s one choice, in the URL, through a failed read of either tab', async () => {
    mount('/objects/9?tab=history');
    expect(await screen.findByText('Column b (retired)')).toBeDefined();
    expect(box().checked).toBe(false);

    fireEvent.click(box());
    expect(where).toBe('/objects/9?tab=history&retired=hide');
    expect(legend()).toEqual(['Column a', 'Column c']);
    // The box's own region: the page has another, for a re-read of the list that fails (`U-67`).
    expect(box().closest('label')?.nextElementSibling?.textContent).toBe(
      '1 retired channel hidden.',
    );

    // The history read fails (another range, the core restarting): the charts go for an error
    // panel. The next read that answers brings them back still hidden.
    historyUp = false;
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    // Said in the History tab's polite region (`U-58`), not an alert.
    expect(
      await waitFor(() => {
        const said = screen
          .getAllByRole('status')
          .find((one) => within(one).queryByRole('button', { name: 'Try again' }) !== null);
        if (said === undefined) throw new Error('no region holds the failure');
        return said;
      }),
    ).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    historyUp = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Column a')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(legend()).toEqual(['Column a', 'Column c']);

    // The channel table says the same: one choice for the page.
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(where).toBe('/objects/9?retired=hide');
    expect(await screen.findByText('Column a')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(screen.queryByText('Column b')).toBeNull();

    // A values poll fails, which keeps the table and says so (`U-71`), and the next one answers.
    valuesUp = false;
    poll();
    expect(await screen.findByText(/^The readings could not be read again/u)).toBeDefined();
    expect(box().checked).toBe(true);
    valuesUp = true;
    poll();
    await waitFor(() => {
      expect(screen.queryByText(/^The readings could not be read again/u)).toBeNull();
    });
    expect(screen.getByText('Column a')).toBeDefined();

    // And back to History, still hidden.
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(where).toBe('/objects/9?retired=hide&tab=history');
    expect(await screen.findByText('Column c')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(legend()).toEqual(['Column a', 'Column c']);

    // The view mounted again from that address.
    const address = where;
    cleanup();
    mount(address);
    expect(await screen.findByText('Column c')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(screen.queryByText(/Column b/)).toBeNull();

    // Unticked there, the parameter goes and Column b comes back, marked.
    fireEvent.click(box());
    expect(where).toBe('/objects/9?tab=history');
    expect(screen.getByText('Column b (retired)')).toBeDefined();
    expect(legend()).toEqual(['Column a', 'Column b (retired)', 'Column c']);
  });
});

describe('the channel list, kept current about retirement', () => {
  it('is not read again on an ordinary poll, and is when a retired channel gets a reading', async () => {
    mount('/objects/9');
    expect(await screen.findByText(String(100 + 1))).toBeDefined();
    expect(within(rowOf('Column b')).getByText('retired')).toBeDefined();
    expect(listReads).toBe(1);

    // Ordinary polls: the list and `/values` agree, so the list is not asked for.
    await pollAndSettle();
    await pollAndSettle();
    expect(listReads).toBe(1);

    // A reading arrives for Column b, which makes it live: `/values` says so, and the list is
    // read again and says so too.
    listSaysRetired = false;
    valuesSayRetired = false;
    await pollAndSettle();
    await waitFor(() => {
      expect(within(rowOf('Column b')).queryByText('retired')).toBeNull();
    });
    expect(listReads).toBe(2);
    expect(screen.queryByRole('checkbox', { name: 'Hide retired channels' })).toBeNull();

    // Agreeing again, the polls ask for nothing more.
    await pollAndSettle();
    expect(listReads).toBe(2);
  });

  it('is read again at most once a minute while the two keep disagreeing', async () => {
    // A list that keeps answering retired while every poll says read: a flapping channel, or
    // two answers that do not settle. Without a bound, every poll would ask for the list.
    valuesSayRetired = false;
    mount('/objects/9');
    expect(await screen.findByText(String(100 + 1))).toBeDefined();
    await waitFor(() => {
      expect(listReads).toBe(2);
    });

    for (let index = 0; index < 4; index += 1) await pollAndSettle();
    expect(listReads).toBe(2);

    skipped += RELIST_MIN_MS;
    await pollAndSettle();
    await waitFor(() => {
      expect(listReads).toBe(3);
    });
    await pollAndSettle();
    expect(listReads).toBe(3);
  });

  it('keeps the table, and the hide box, while the list is read again', async () => {
    mount('/objects/9?retired=hide');
    expect(await screen.findByText(String(100 + 1))).toBeDefined();
    expect(box().checked).toBe(true);

    // The list's answer held back, so the re-read is in flight while the page is looked at.
    let release: () => void = () => undefined;
    const stub = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.split('?')[0] === '/api/v1/objects/9/channels') {
        listReads += 1;
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(listAnswer()));
          };
        });
      }
      return stub(url);
    });
    listSaysRetired = false;
    valuesSayRetired = false;
    await pollAndSettle();
    await waitFor(() => {
      expect(listReads).toBe(2);
    });
    expect(box().checked).toBe(true);
    expect(screen.getByText('Column a')).toBeDefined();
    expect(screen.queryByText('Loading channels…')).toBeNull();

    act(() => {
      release();
    });
    // Column b is live now: nothing to hide, so it is shown and the box has gone.
    expect(await screen.findByText('Column b')).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'Hide retired channels' })).toBeNull();
  });
});
