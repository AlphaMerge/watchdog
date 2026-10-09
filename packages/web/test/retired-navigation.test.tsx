import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ChannelRecord, ObjectDetail, SensorValues } from '../src/api/types';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';

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

/** How each sensor's list read answers: at once, held until released, or refused. */
let listMode: Record<number, 'answer' | 'hold' | 'fail'> = {};
/** Channels `/values` says are retired, by sensor; where it disagrees, the page re-reads. */
let valuesRetired: Record<number, number[]> = {};
let listReads: Record<number, number> = {};
let release: () => void = () => undefined;

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
      if (mode === 'fail') {
        return Promise.resolve(
          json(
            { error: { code: 'UNAVAILABLE', message: 'restarting', context: {}, details: {} } },
            503,
          ),
        );
      }
      if (mode === 'hold') {
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(json({ items: LISTS[id] }));
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
  // Asked for (the first ask may be aborted while sensor 12's detail is read: the path goes
  // null in between), and whatever it sets off allowed to settle before anything is looked at.
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
    // One read when the page arrives (asked twice: the first is aborted while sensor 12's detail
    // is read, as the path goes null in between), then the re-read the poll asks for.
    await waitFor(() => {
      expect(listReads[12]).toBe(3);
    });
  });
});
