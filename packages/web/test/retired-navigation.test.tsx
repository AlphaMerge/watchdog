import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ChannelRecord, ObjectDetail, SensorValues } from '../src/api/types';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';
import { expectQuiet } from './support/refusal-region';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * From one sensor to the next without leaving the page (`U-55` review).
 *
 * The `objects/:id` route has no key, so going from sensor 9 to sensor 12 keeps the view mounted,
 * and on the first render after the id changes the channel list in hand is still sensor 9's. The
 * list kept while one is read again must be the one read for the sensor on the page, or sensor
 * 9's channels stand under sensor 12's name until sensor 12's list arrives, and for good if it
 * never does. The once-a-minute cap on re-reads is per sensor too.
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

const channel = (id: number, name: string, retired: boolean): ChannelRecord => ({
  id,
  key: name.toLowerCase().replace(/ /g, '-'),
  name,
  unit: '',
  isPrimary: false,
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

const sensor = (id: number, name: string): ObjectDetail => ({
  id,
  parentId: 4,
  kind: 'sensor',
  name,
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
});

const LISTS: Record<number, ChannelRecord[]> = {
  9: [channel(1, 'Column a', false), channel(2, 'Column b', true)],
  12: [channel(21, 'Port x', false), channel(22, 'Port y', false)],
};
const NAMES: Record<number, string> = { 9: 'Storage table', 12: 'Uplink ports' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refused = (): Response =>
  json({ error: { code: 'UNAVAILABLE', message: 'restarting', context: {}, details: {} } }, 503);

/** How each sensor's list read answers: at once, held until released, or refused. */
let listMode: Record<number, 'answer' | 'hold' | 'fail'> = {};
/** Channels `/values` says are retired, by sensor; where it disagrees, the page re-reads. */
let valuesRetired: Record<number, number[]> = {};
let listReads: Record<number, number> = {};
/** Answers the read held last: with the list, or refused as a restarting core refuses it. */
let release: (answer?: 'list' | 'fail') => void = () => undefined;

function valuesFor(id: number): SensorValues {
  const now = new Date().toISOString();
  return {
    sensorId: id,
    readAt: now,
    notBefore: now,
    intervalSeconds: 60,
    channels: (LISTS[id] ?? []).map((one) => ({
      id: one.id,
      key: one.key,
      name: one.name,
      unit: '',
      decimals: null,
      value: null,
      at: null,
      retired: (valuesRetired[id] ?? []).includes(one.id),
    })),
  };
}

let go: (to: string) => void = () => undefined;
function Navigator(): null {
  const navigate = useNavigate();
  go = (to) => {
    void navigate(to);
  };
  return null;
}

function mount(at: string): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Navigator />
      <Routes>
        <Route path="/objects/:id" element={<ObjectDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SENSOR_9_NAMES = /Column a|Column b/;
const hideBox = (): HTMLElement | null =>
  screen.queryByRole('checkbox', { name: 'Hide retired channels' });

beforeEach(() => {
  listMode = { 9: 'answer', 12: 'answer' };
  valuesRetired = { 9: [2], 12: [] };
  listReads = { 9: 0, 12: 0 };
  release = () => undefined;
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.split('?')[0] ?? '';
    const match = /^\/api\/v1\/(objects|sensors)\/(\d+)(\/[a-z]+)?$/.exec(path);
    const id = Number(match?.[2]);
    if (match === null || NAMES[id] === undefined) return Promise.resolve(json({}, 404));
    if (match[1] === 'objects' && match[3] === undefined) {
      return Promise.resolve(json(sensor(id, NAMES[id])));
    }
    if (match[1] === 'objects' && match[3] === '/channels') {
      listReads[id] = (listReads[id] ?? 0) + 1;
      const mode = listMode[id];
      if (mode === 'fail') return Promise.resolve(refused());
      if (mode === 'hold') {
        return new Promise<Response>((resolve) => {
          release = (answer = 'list') => {
            resolve(answer === 'fail' ? refused() : json({ items: LISTS[id] }));
          };
        });
      }
      return Promise.resolve(json({ items: LISTS[id] }));
    }
    if (match[1] === 'sensors' && match[3] === '/values') {
      return Promise.resolve(json(valuesFor(id)));
    }
    return Promise.resolve(json({}, 404));
  });
});
afterEach(() => {
  watcher?.disconnect();
  watcher = null;
  vi.unstubAllGlobals();
});

/** Nothing of sensor 9's channels was put on the page after it left, not for one render. */
function neverShown(): void {
  collect(watcher?.takeRecords() ?? []);
  expect(added.filter((text) => SENSOR_9_NAMES.test(text))).toEqual([]);
}

/**
 * Everything put on the page after navigating, even for one render: a list shown under the wrong
 * sensor for a single commit is gone again before any assert after an `await` can see it.
 */
let added: string[] = [];
let watcher: MutationObserver | null = null;
const collect = (records: MutationRecord[]): void => {
  for (const record of records) {
    for (const node of record.addedNodes) added.push(node.textContent ?? '');
  }
};

/** Sensor 9's page, its channels on it, then on to sensor 12's header. */
async function fromNineToTwelve(): Promise<void> {
  mount('/objects/9');
  expect(await screen.findByText('Column b')).toBeDefined();
  expect(hideBox()).not.toBeNull();
  added = [];
  watcher = new MutationObserver(collect);
  watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
  act(() => {
    go('/objects/12');
  });
  expect(await screen.findByRole('heading', { name: 'Uplink ports' })).toBeDefined();
  // Asked for, and whatever it sets off allowed to settle before anything is looked at.
  await waitFor(() => {
    expect(listReads[12]).toBeGreaterThanOrEqual(1);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('going from one sensor to another', () => {
  it('shows none of the first sensor’s channels while the second’s list is read', async () => {
    listMode[12] = 'hold';
    await fromNineToTwelve();
    expect(screen.queryByText(SENSOR_9_NAMES)).toBeNull();
    expect(hideBox()).toBeNull();
    expect(screen.getByText('Loading channels…')).toBeDefined();

    act(() => {
      release();
    });
    expect(await screen.findByText('Port x')).toBeDefined();
    expect(screen.queryByText(SENSOR_9_NAMES)).toBeNull();
    neverShown();
  });

  it('shows none of them when the second’s list cannot be read', async () => {
    listMode[12] = 'fail';
    await fromNineToTwelve();
    expect(screen.queryByText(SENSOR_9_NAMES)).toBeNull();
    expect(hideBox()).toBeNull();
    neverShown();
  });

  it('does not hold the second sensor’s re-read back by the first’s minute', async () => {
    // Sensor 9's poll disagrees with its list at once, so it is read again.
    valuesRetired[9] = [];
    mount('/objects/9');
    expect(await screen.findByText('Column a')).toBeDefined();
    await waitFor(() => {
      expect(listReads[9]).toBe(2);
    });

    // Within the same minute, sensor 12's poll disagrees with its list: read again, too.
    valuesRetired[12] = [22];
    act(() => {
      go('/objects/12');
    });
    expect(await screen.findByText('Port x')).toBeDefined();
    // One read when the page arrives, then the re-read the poll asks for. (Two reads when the
    // page arrived, before `U-62`: the first went out under sensor 9's detail, still in hand on
    // the render the id changed on, and was aborted as that detail went.)
    await waitFor(() => {
      expect(listReads[12]).toBe(2);
    });
  });

  it('draws nothing of the first sensor after leaving it, not for one frame (U-62)', async () => {
    listMode[12] = 'hold';
    mount('/objects/9');
    expect(await screen.findByText('Column b')).toBeDefined();
    const heading = screen.getByRole('heading', { name: 'Storage table' });

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      act(() => {
        go('/objects/12');
      });
      records.push(...observer.takeRecords());
      // Every change made to the page while sensor 9's header was still on it is a frame of
      // sensor 9 drawn after leaving it: the header has to go in the first change, before
      // anything is added or rewritten. Presence first: a header never removed would leave
      // nothing before it to find.
      const gone = records.findIndex((record) =>
        [...record.removedNodes].some((node) => node.contains(heading)),
      );
      expect(gone).toBeGreaterThanOrEqual(0);
      const drawnUnderNine = records
        .slice(0, gone)
        .filter((record) => record.addedNodes.length > 0 || record.type === 'characterData');
      expect(drawnUnderNine).toEqual([]);
    } finally {
      observer.disconnect();
    }
    expect(await screen.findByRole('heading', { name: 'Uplink ports' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Storage table' })).toBeNull();
  });
});

/** The empty region beside *Loading channels…* that a failed read lands in. */
function listRegion(): HTMLElement {
  const loading = screen.getByText('Loading channels…');
  const region = loading.nextElementSibling;
  if (!(region instanceof HTMLElement)) throw new Error('no region beside the loading line');
  return region;
}

describe('a channel list that cannot be read (U-60)', () => {
  it('says so, with a retry, in the region present before, on opening the page', async () => {
    listMode[9] = 'hold';
    mount('/objects/9');
    expect(await screen.findByText('Loading channels…')).toBeDefined();
    const region = listRegion();
    expectQuiet(region, [], 'polite');

    act(() => {
      release('fail');
    });
    await waitFor(() => {
      expect(region.textContent).toContain('restarting');
    });
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toContain('Request failed — UNAVAILABLE');
    expect(screen.queryByText('Loading channels…')).toBeNull();
    // Inside the region, so not an alert of its own.
    expect(within(region).queryByRole('alert')).toBeNull();

    // A retry empties the same node as it starts, so the same failure would be said again.
    fireEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Loading channels…')).toBeDefined();
    expect(listRegion()).toBe(region);
    expect(region.textContent).toBe('');
    await waitFor(() => {
      expect(listReads[9]).toBe(2);
    });

    act(() => {
      release('list');
    });
    expect(await screen.findByText('Column a')).toBeDefined();
    expect(region.isConnected).toBe(false);
  });

  it('says so after moving from another sensor, with none of that sensor on the page', async () => {
    listMode[12] = 'hold';
    await fromNineToTwelve();
    expect(screen.getByText('Loading channels…')).toBeDefined();
    const region = listRegion();
    expectQuiet(region, [], 'polite');

    act(() => {
      release('fail');
    });
    await waitFor(() => {
      expect(region.textContent).toContain('restarting');
    });
    expect(region.isConnected).toBe(true);
    expect(screen.queryByText('Loading channels…')).toBeNull();
    expect(screen.queryByText(SENSOR_9_NAMES)).toBeNull();
    expect(hideBox()).toBeNull();

    listMode[12] = 'answer';
    fireEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Port x')).toBeDefined();
    expect(screen.queryByText(SENSOR_9_NAMES)).toBeNull();
    neverShown();
  });
});
