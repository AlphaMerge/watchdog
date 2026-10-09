import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
import { expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));
// The canvas is uPlot's, and jsdom has none; the legend is ours.
vi.mock('../src/charts/TimeSeriesChart', () => ({ TimeSeriesChart: () => null }));

/**
 * The sensor page's channel list, kept current whichever tab is open (`U-61`), and a re-read of it
 * that fails, said (`U-67`).
 *
 * The page polls `/values` itself, on the Overview and the History tab alike, so a reading that
 * makes a retired channel live, or a channel an edit added, is noticed on either within a poll;
 * the list is then read again, and so are the History tab's series, at most once a minute. Under
 * fake timers: the fifteen-second poll is `setInterval`, and the minute is `performance.now()`,
 * moved on with it.
 */

const POLL_MS = 15_000;

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
  json(
    {
      error: {
        code: 'UNAVAILABLE',
        message: 'restarting',
        correlationId: 'req-67',
        context: {},
        details: {},
      },
    },
    503,
  );

/** What the core holds: Column b retired or not, and whether an edit has added Column d. */
let listSaysRetired = true;
let valuesSayRetired = true;
let added = false;
/** How the nth read of the list is answered: at once, refused, or held until `release`. */
let listReply: (read: number) => 'answer' | 'fail' | 'hold' = () => 'answer';
let release: (answer: 'list' | 'fail') => void = () => undefined;
let listReads = 0;
let polls = 0;
let historyEnds: string[] = [];

function listAnswer(): { items: ChannelRecord[] } {
  const items = [channel(1, 'a', false), channel(2, 'b', listSaysRetired), channel(3, 'c', false)];
  return { items: added ? [...items, channel(4, 'd', false)] : items };
}

function valuesAnswer(): SensorValues {
  const now = new Date().toISOString();
  const ids = added ? [1, 2, 3, 4] : [1, 2, 3];
  return {
    sensorId: 9,
    readAt: now,
    notBefore: now,
    intervalSeconds: 60,
    channels: ids.map((id) => ({
      id,
      key: 'abcd'.charAt(id - 1),
      name: `Column ${'abcd'.charAt(id - 1)}`,
      unit: '',
      decimals: null,
      value: id,
      at: now,
      retired: id === 2 ? valuesSayRetired : false,
    })),
  };
}

function historyAnswer(to: string): HistorySeries {
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
  const channels = [series(1, 'a'), series(2, 'b'), series(3, 'c')];
  return {
    sensorId: 9,
    from: buckets[0] ?? '',
    to,
    resolutionSeconds: 60,
    bucketCount: buckets.length,
    source: 'sample',
    buckets,
    // Column d has readings from the moment it exists; a series read before then has no line.
    channels: added ? [...channels, series(4, 'd')] : channels,
    segments: [],
    adjustments: [],
  };
}

function mount(at: string): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/objects/:id" element={<ObjectDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A monotonic clock this file moves on with the fake one, so a minute passes in no time. */
let skipped = 0;

/** Time passes: `ms` of the poll's interval, and of the minute that bounds a re-read. */
function pass(ms: number): void {
  skipped += ms;
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** One poll's worth of time, and its answer on the page. */
async function onePoll(): Promise<void> {
  const before = polls;
  pass(POLL_MS);
  await waitFor(() => {
    expect(polls).toBe(before + 1);
  });
}

const legend = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((entry) => entry.querySelector('.text-text-muted')?.textContent ?? '');

beforeEach(() => {
  listSaysRetired = true;
  valuesSayRetired = true;
  added = false;
  listReply = () => 'answer';
  release = () => undefined;
  listReads = 0;
  polls = 0;
  historyEnds = [];
  skipped = 0;
  // The poll's interval and the wall clock its readings and the history's range end are taken
  // from. `setTimeout` stays real: `waitFor` runs on it.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const real = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => real() + skipped);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', (url: string) => {
    const [path = '', query = ''] = url.split('?');
    if (path === '/api/v1/objects/9') return Promise.resolve(json(SENSOR));
    if (path === '/api/v1/objects/9/channels') {
      listReads += 1;
      const reply = listReply(listReads);
      if (reply === 'fail') return Promise.resolve(unavailable());
      if (reply === 'hold') {
        return new Promise<Response>((resolve) => {
          release = (answer) => {
            resolve(answer === 'fail' ? unavailable() : json(listAnswer()));
          };
        });
      }
      return Promise.resolve(json(listAnswer()));
    }
    if (path === '/api/v1/sensors/9/values') {
      polls += 1;
      return Promise.resolve(json(valuesAnswer()));
    }
    if (path === '/api/v1/sensors/9/history') {
      const to = new URLSearchParams(query).get('to') ?? '';
      historyEnds.push(to);
      return Promise.resolve(json(historyAnswer(to)));
    }
    // Answered, so that no other card's error panel is an alert speaking on the page.
    if (path === '/api/v1/sensor-types' || path === '/api/v1/lookups') {
      return Promise.resolve(json({ items: [] }));
    }
    return Promise.resolve(json({}, 404));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the History tab, kept current (U-61)', () => {
  it('notices a retired channel made live within a poll, and reads its chart again', async () => {
    mount('/objects/9?tab=history');
    expect(await screen.findByText('Column b (retired)')).toBeDefined();
    // The History tab polls as the Overview does: once on arriving.
    await waitFor(() => {
      expect(polls).toBe(1);
    });
    expect(listReads).toBe(1);
    expect(historyEnds).toHaveLength(1);

    // A reading for Column b makes it live: the next poll says so, the list is read again and
    // the mark goes, and the series is read again, up to now.
    listSaysRetired = false;
    valuesSayRetired = false;
    await onePoll();
    await waitFor(() => {
      expect(legend()).toEqual(['Column a', 'Column b', 'Column c']);
    });
    expect(listReads).toBe(2);
    expect(historyEnds).toHaveLength(2);
    expect(Date.parse(historyEnds[1] ?? '') - Date.parse(historyEnds[0] ?? '')).toBe(POLL_MS);

    // Agreeing again, the next poll reads neither.
    await onePoll();
    expect(listReads).toBe(2);
    expect(historyEnds).toHaveLength(2);
  });

  it('charts a channel an edit added, from the poll that first names it', async () => {
    mount('/objects/9?tab=history');
    expect(await screen.findByText('Column c')).toBeDefined();
    await waitFor(() => {
      expect(polls).toBe(1);
    });

    added = true;
    await onePoll();
    await waitFor(() => {
      expect(legend()).toEqual(['Column a', 'Column b (retired)', 'Column c', 'Column d']);
    });
    expect(listReads).toBe(2);
    expect(historyEnds).toHaveLength(2);
  });

  it('reads the list and the series again at most once a minute while the two disagree', async () => {
    // A list that keeps saying retired while every poll says live: a flapping channel, or two
    // answers that do not settle.
    valuesSayRetired = false;
    mount('/objects/9?tab=history');
    expect(await screen.findByText('Column a')).toBeDefined();
    await waitFor(() => {
      expect(listReads).toBe(2);
    });
    await waitFor(() => {
      expect(historyEnds).toHaveLength(2);
    });

    for (let index = 0; index < RELIST_MIN_MS / POLL_MS - 1; index += 1) await onePoll();
    expect(listReads).toBe(2);
    expect(historyEnds).toHaveLength(2);

    // The poll a minute after the re-read (the fourth) reads both again.
    await onePoll();
    await waitFor(() => {
      expect(listReads).toBe(3);
    });
    await waitFor(() => {
      expect(historyEnds).toHaveLength(3);
    });
    await onePoll();
    expect(listReads).toBe(3);
    expect(historyEnds).toHaveLength(3);
  });

  it('polls on no other tab, and at once on coming back to one that shows channels', async () => {
    mount('/objects/9?tab=log');
    expect(await screen.findByRole('tab', { name: 'Log' })).toBeDefined();
    pass(POLL_MS);
    pass(POLL_MS);
    expect(polls).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() => {
      expect(polls).toBe(1);
    });
  });
});

describe('the channel table, kept current (U-61)', () => {
  it('reads the list again for a channel the poll names and it does not hold', async () => {
    mount('/objects/9');
    expect(await screen.findByText('Column c')).toBeDefined();
    expect(screen.queryByText('Column d')).toBeNull();

    added = true;
    await onePoll();
    expect(await screen.findByText('Column d')).toBeDefined();
    expect(listReads).toBe(2);

    // The two agree now.
    await onePoll();
    expect(listReads).toBe(2);
  });
});

/** The region beside the held list: the first thing in `container`, before the list. */
function failureRegion(container: HTMLElement): HTMLElement {
  const region = container.firstElementChild?.firstElementChild;
  if (!(region instanceof HTMLElement)) throw new Error('no region before the list');
  return region;
}

/** The Channels card's body. */
function channelsCard(): HTMLElement {
  const body = screen
    .getByRole('heading', { name: 'Channels' })
    .closest('section')?.lastElementChild;
  if (!(body instanceof HTMLElement)) throw new Error('no Channels card');
  return body;
}

const SAID =
  'The channel list could not be read again, so this is the one read before and may be out of ' +
  'date: restarting req-67';

describe('a failed re-read of the channel list (U-67)', () => {
  it('is said beside the held table, again in the same words, and Try again keeps focus', async () => {
    // Read once; the re-read the next poll asks for is refused.
    listReply = (read) =>
      read === 1 ? 'answer' : read === 3 ? 'hold' : read === 4 ? 'hold' : 'fail';
    mount('/objects/9');
    expect(await screen.findByText('Column c')).toBeDefined();
    const region = failureRegion(channelsCard());
    expectQuiet(region, ['mb-2', 'empty:mb-0'], 'polite');
    expect(within(channelsCard()).queryByRole('button', { name: 'Try again' })).toBeNull();

    listSaysRetired = false;
    valuesSayRetired = false;
    await onePoll();
    await waitFor(() => {
      expect(region.textContent).toBe(SAID);
    });
    expectCorrelation(region, 'req-67');
    // The list it was showing is still there, Column b still marked, and nothing is an alert.
    expect(within(channelsCard()).getByText('Column a')).toBeDefined();
    expect(within(channelsCard()).getByText('retired')).toBeDefined();
    expect(speaking()).toEqual([]);
    expect(failureRegion(channelsCard())).toBe(region);

    // Every state the region is in, in order.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(region.textContent);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    try {
      const retry = within(channelsCard()).getByRole('button', { name: 'Try again' });
      retry.focus();
      fireEvent.click(retry);
      // Emptied as the read starts, and the same element stays, unavailable, with focus.
      expect(region.matches(':empty')).toBe(true);
      expect(within(channelsCard()).getByRole('button', { name: 'Try again' })).toBe(retry);
      expect(retry.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(retry);
      await waitFor(() => {
        expect(listReads).toBe(3);
      });
      fireEvent.click(retry);
      expect(listReads).toBe(3);

      // Refused in the same words: said again.
      act(() => {
        release('fail');
      });
      await waitFor(() => {
        expect(region.textContent).toBe(SAID);
      });
      expect(seen).toEqual(['', SAID]);
      expect(retry.getAttribute('aria-disabled')).toBe('false');
      expect(document.activeElement).toBe(retry);

      // Read: the region empties, Try again goes, and focus goes to the tab's panel.
      fireEvent.click(retry);
      await waitFor(() => {
        expect(listReads).toBe(4);
      });
      expect(document.activeElement).toBe(retry);
      act(() => {
        release('list');
      });
      await waitFor(() => {
        expect(within(channelsCard()).queryByRole('button', { name: 'Try again' })).toBeNull();
      });
      expect(region.matches(':empty')).toBe(true);
      expect(within(channelsCard()).queryByText('retired')).toBeNull();
      expect(document.activeElement).toBe(document.getElementById('panel-overview'));
    } finally {
      observer.disconnect();
    }
  });

  it('is said on the History tab too, with the marks it holds', async () => {
    listReply = (read) => (read === 1 ? 'answer' : 'fail');
    valuesSayRetired = false;
    mount('/objects/9?tab=history');
    expect(await screen.findByText('Column b (retired)')).toBeDefined();
    const panel = document.getElementById('panel-history');
    if (panel === null) throw new Error('no History panel');
    const region = failureRegion(panel);
    await waitFor(() => {
      expect(region.textContent).toBe(SAID);
    });
    expect(legend()).toEqual(['Column a', 'Column b (retired)', 'Column c']);
    expect(speaking()).toEqual([]);
  });
});
