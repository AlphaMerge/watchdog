import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
 * "Hide retired channels" survives what the page does on its own (`U-38` review).
 *
 * The channel table is swapped for an error panel whenever a poll of its values fails, and the
 * poll is unattended, every fifteen seconds. A choice held inside the table went with it: one
 * failed poll (a core restarting, a network blip) and the next good one brought every retired
 * row back with the box unticked, unannounced. It lives in the page's URL instead, as the alarm
 * list's filters do.
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

const CHANNELS = [channel(1, 'a', false), channel(2, 'b', true)];

const VALUES: SensorValues = {
  sensorId: 9,
  readAt: '2026-10-09T08:00:00.000Z',
  notBefore: '2026-10-09T07:57:00.000Z',
  intervalSeconds: 60,
  channels: CHANNELS.map((one) => ({
    id: one.id,
    key: one.key,
    name: one.name,
    unit: '',
    decimals: null,
    value: null,
    at: null,
    retired: one.retired,
  })),
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Whether `/values` answers; flipped to drive the poll into an error and back. */
let valuesUp = true;

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

const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Hide retired channels' });

describe('hiding retired channels on the sensor page', () => {
  beforeEach(() => {
    valuesUp = true;
    // The poll asks nothing of a hidden page; jsdom's may not say it is visible.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.stubGlobal('fetch', (url: string) => {
      const path = url.split('?')[0];
      if (path === '/api/v1/objects/9') return Promise.resolve(json(SENSOR));
      if (path === '/api/v1/objects/9/channels') return Promise.resolve(json({ items: CHANNELS }));
      if (path === '/api/v1/sensors/9/values') {
        return Promise.resolve(
          valuesUp
            ? json(VALUES)
            : json(
                { error: { code: 'UNAVAILABLE', message: 'restarting', context: {}, details: {} } },
                503,
              ),
        );
      }
      return Promise.resolve(json({}, 404));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the choice through a failed poll, in the URL, and through a reload of the view', async () => {
    mount('/objects/9');
    expect(await screen.findByText('Column b')).toBeDefined();
    expect(box().checked).toBe(false);

    fireEvent.click(box());
    expect(screen.queryByText('Column b')).toBeNull();
    expect(where).toBe('/objects/9?retired=hide');

    // A poll fails: the table stays, with the choice, and the failure is said beside it (`U-71`).
    valuesUp = false;
    poll();
    expect(await screen.findByText(/^The readings could not be read again/u)).toBeDefined();
    expect(screen.getByText('Column a')).toBeDefined();
    expect(box().checked).toBe(true);

    // The next one answers: the table and the choice as they were, and nothing said.
    valuesUp = true;
    poll();
    await waitFor(() => {
      expect(screen.queryByText(/^The readings could not be read again/u)).toBeNull();
    });
    expect(screen.getByText('Column a')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(screen.queryByText('Column b')).toBeNull();
    // The box's own region: the page has another, for a re-read of the list that fails (`U-67`).
    expect(box().closest('label')?.nextElementSibling?.textContent).toBe(
      '1 retired channel hidden.',
    );

    // Another tab and back keeps it: changing tab writes its own parameter and no other.
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(where).toBe('/objects/9?retired=hide&tab=history');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(where).toBe('/objects/9?retired=hide');
    expect(box().checked).toBe(true);

    // The view loaded again from that address keeps it too.
    const address = where;
    cleanup();
    mount(address);
    expect(await screen.findByText('Column a')).toBeDefined();
    expect(box().checked).toBe(true);
    expect(screen.queryByText('Column b')).toBeNull();

    // Unticked, the parameter goes and the row comes back.
    fireEvent.click(box());
    expect(where).toBe('/objects/9');
    expect(screen.getByText('Column b')).toBeDefined();
  });
});
