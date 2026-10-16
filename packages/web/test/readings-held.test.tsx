import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setReadTimeout } from '../src/api/client';
import type * as Stream from '../src/api/stream';
import type { ChannelRecord, ObjectDetail, SensorValues } from '../src/api/types';
import { formatValue } from '../src/routes/detail/model';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';
import { alertSaying, expectCorrelation, expectQuiet, speaking } from './support/refusal-region';
import { watchFocus } from './support/try-again';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * The channel table's readings, kept in sight while the next are read (`U-71`).
 *
 * Every fifteen seconds the page reads `/values` again, and `useApi` says `loading` for the length
 * of that request: the table used to be handed no readings for it, so every reading on the page
 * blinked to *—* four times a minute. The last answer is now held, per sensor, aged by how long it
 * has been held, and a poll that fails is said beside it. Under fake timers: the poll is
 * `setInterval`, and the time a reading has been held is `performance.now()`, moved on with it.
 */

const POLL_MS = 15_000;
/** Three scan intervals of 60 s: the core withholds anything older. */
const WINDOW_MS = 180_000;
/** How long before the answer Column a's reading was taken. */
const READ_AGO_MS = 5_000;

const NO_LIMITS: ChannelRecord['limits'] = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

// Both sensors hold channels with the same ids, so that a reading filed under the wrong sensor
// would land in a row of the other's table, where a test can see it.
const channel = (id: number, name: string): ChannelRecord => ({
  id,
  key: name.toLowerCase().replace(/ /gu, '-'),
  name,
  unit: '',
  isPrimary: id === 1,
  limits: NO_LIMITS,
  scaleMul: '1',
  scaleDiv: '1',
  decimals: null,
  spikeMin: null,
  spikeMax: null,
  lookupId: null,
  declaredLookup: null,
  retired: false,
});
const CHANNELS: Record<number, ChannelRecord[]> = {
  9: [channel(1, 'Column a'), channel(2, 'Column b')],
  12: [channel(1, 'Port x'), channel(2, 'Port y')],
};
const NAMES: Record<number, string> = { 9: 'Storage table', 12: 'Uplink ports' };

const sensor = (id: number): ObjectDetail => ({
  id,
  parentId: 4,
  kind: 'sensor',
  name: NAMES[id] ?? '',
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

/** The number the nth read of a sensor's values gives its first channel. */
const numberOf = (id: number, read: number): number => id * 1000 + read;
const shown = (id: number, read: number): string => formatValue(numberOf(id, read), '', null);

/** One answer, as the core gives it: the first channel read 5 s ago, the second not lately. */
function valuesFor(id: number, read: number): SensorValues {
  const now = Date.now();
  const [first, second] = CHANNELS[id] ?? [];
  return {
    sensorId: id,
    readAt: new Date(now).toISOString(),
    notBefore: new Date(now - WINDOW_MS).toISOString(),
    intervalSeconds: WINDOW_MS / 3 / 1000,
    channels: [first, second].flatMap((one, index) =>
      one === undefined
        ? []
        : [
            {
              id: one.id,
              key: one.key,
              name: one.name,
              unit: '',
              decimals: null,
              value: index === 0 ? numberOf(id, read) : null,
              at: index === 0 ? new Date(now - READ_AGO_MS).toISOString() : null,
              retired: false,
            },
          ],
    ),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** The refusal the nth read of the values is given: its words, and its id. */
let failure: (read: number) => { message: string; id: string } = () => ({
  message: 'restarting',
  id: 'req-71',
});
let lastRead = 0;
const refused = (): Response => {
  const { message, id } = failure(lastRead);
  return json(
    {
      error: { code: 'UNAVAILABLE', message, correlationId: id, context: {}, details: {} },
    },
    503,
  );
};

/** How the nth read of a sensor's values is answered: at once, refused, or held until released. */
let valuesReply: (id: number, read: number) => 'answer' | 'fail' | 'hold' = () => 'answer';
/** Answers the read held last. */
let release: (answer: 'answer' | 'fail') => void = () => undefined;
let reads: Record<number, number> = {};

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

/** A monotonic clock this file moves on with the fake one. */
let skipped = 0;

/** Time passes: `ms` of the poll's interval, and of the time a reading has been held. */
function pass(ms: number): void {
  skipped += ms;
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** One poll's worth of time, and the read it asks for. */
async function onePoll(id = 9): Promise<void> {
  const before = reads[id] ?? 0;
  pass(POLL_MS);
  await waitFor(() => {
    expect(reads[id]).toBe(before + 1);
  });
}

/** What the reading cell of the first channel in the table says: its number, or its words. */
function reading(): string {
  const cell = document.querySelector('tbody tr td');
  if (cell === null) return '(no table)';
  return cell.querySelector('.font-mono')?.textContent ?? cell.textContent;
}

/** The Channels card's body. */
function channelsCard(): HTMLElement {
  const body = screen
    .getByRole('heading', { name: 'Channels' })
    .closest('section')?.lastElementChild;
  if (!(body instanceof HTMLElement)) throw new Error('no Channels card');
  return body;
}

/** The region beside the readings: after the channel list's own, before the table. */
function readingsRegion(): HTMLElement {
  const region = channelsCard().children[1]?.firstElementChild;
  if (!(region instanceof HTMLElement) || region.getAttribute('role') !== 'status') {
    throw new Error('no region beside the readings');
  }
  return region;
}

const SAID =
  'The readings could not be read again, so these are the ones read before, each as old as it ' +
  'says: restarting req-71';

beforeEach(() => {
  valuesReply = () => 'answer';
  failure = () => ({ message: 'restarting', id: 'req-71' });
  lastRead = 0;
  release = () => undefined;
  reads = { 9: 0, 12: 0 };
  skipped = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const real = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => real() + skipped);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', (url: string) => {
    const [path = ''] = url.split('?');
    const object = /^\/api\/v1\/objects\/(\d+)$/u.exec(path);
    if (object !== null) return Promise.resolve(json(sensor(Number(object[1]))));
    const list = /^\/api\/v1\/objects\/(\d+)\/channels$/u.exec(path);
    if (list !== null) {
      return Promise.resolve(json({ items: CHANNELS[Number(list[1])] ?? [] }));
    }
    const values = /^\/api\/v1\/sensors\/(\d+)\/values$/u.exec(path);
    if (values !== null) {
      const id = Number(values[1]);
      const read = (reads[id] ?? 0) + 1;
      reads[id] = read;
      lastRead = read;
      const reply = valuesReply(id, read);
      if (reply === 'fail') return Promise.resolve(refused());
      if (reply === 'hold') {
        return new Promise<Response>((resolve) => {
          release = (answer) => {
            resolve(answer === 'fail' ? refused() : json(valuesFor(id, read)));
          };
        });
      }
      return Promise.resolve(json(valuesFor(id, read)));
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

/** Every state the reading cell is in, and every node taken off the page, while it runs. */
function watch(): { states: string[]; removed: Node[]; stop: () => void } {
  const states: string[] = [];
  const removed: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) removed.push(...record.removedNodes);
    states.push(reading());
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    states,
    removed,
    stop: () => {
      for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
      observer.disconnect();
    },
  };
}

describe('the readings, kept while the next are read (U-71)', () => {
  it('are on the page in every frame of a poll, and the next answer replaces them', async () => {
    valuesReply = (_id, read) => (read === 2 ? 'hold' : 'answer');
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });
    const table = document.querySelector('table');
    if (table === null) throw new Error('no table');

    const watching = watch();
    try {
      // A poll whose answer is slow: the reading stays for as long as the read is out.
      await onePoll();
      expect(reading()).toBe(shown(9, 1));
      act(() => {
        release('answer');
      });
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 2));
      });
      // And one that answers at once.
      await onePoll();
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 3));
      });
    } finally {
      watching.stop();
    }
    expect(watching.states.length).toBeGreaterThan(0);
    // Not one frame without a number: no *—*, no table missing.
    for (const state of watching.states) {
      expect([shown(9, 1), shown(9, 2), shown(9, 3)]).toContain(state);
    }
    expect(table.isConnected).toBe(true);
    expect(watching.removed.some((node) => node.contains(table))).toBe(false);
    expect(speaking()).toEqual([]);
  });

  it('say a failed poll beside them, keep them, and a good read empties it', async () => {
    valuesReply = (_id, read) => (read === 2 ? 'fail' : 'answer');
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });
    const region = readingsRegion();
    expectQuiet(region, ['mb-2', 'empty:mb-0'], 'polite');
    const table = document.querySelector('table');
    if (table === null) throw new Error('no table');

    const watching = watch();
    try {
      await onePoll();
      await waitFor(() => {
        expect(region.textContent).toBe(SAID);
      });
      expectCorrelation(region, 'req-71');
      // The readings it was showing are still there, and nothing is an alert.
      expect(reading()).toBe(shown(9, 1));
      expect(speaking()).toEqual([]);
      expect(readingsRegion()).toBe(region);
      expect(within(channelsCard()).getByRole('button', { name: 'Try again' }).isConnected).toBe(
        true,
      );

      // The next poll answers: the region empties and the new reading is shown.
      await onePoll();
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 3));
      });
      expect(region.matches(':empty')).toBe(true);
      expect(within(channelsCard()).queryByRole('button', { name: 'Try again' })).toBeNull();
    } finally {
      watching.stop();
    }
    for (const state of watching.states) {
      expect([shown(9, 1), shown(9, 3)]).toContain(state);
    }
    expect(watching.removed.some((node) => node.contains(table))).toBe(false);
  });

  it('say a failure held while History was open into a region already there, back on Overview (U-78)', async () => {
    valuesReply = (_id, read) => (read >= 2 ? 'fail' : 'answer');
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });

    // The History tab keeps the poll going (its series are the same channels), and it fails there,
    // where nothing on the tab says so.
    act(() => {
      go('/objects/9?tab=history');
    });
    await onePoll();
    expect(document.getElementById('panel-overview')).toBeNull();

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      act(() => {
        go('/objects/9');
      });
      // Back on Overview: the readings and their region, empty as they come onto the page...
      const region = readingsRegion();
      expect(reading()).toBe(shown(9, 1));
      expect(region.textContent).toBe('');
      // ...and the failure put in it after, so it is said, not arriving with it.
      await waitFor(() => {
        expect(region.textContent).toBe(SAID);
      });
      expect(readingsRegion()).toBe(region);
      for (const record of observer.takeRecords()) records.push(record);
    } finally {
      observer.disconnect();
    }
    const region = readingsRegion();
    expect(
      records.some(
        (record) =>
          region.contains(record.target) &&
          [...record.addedNodes].some((node) => (node.textContent ?? '').includes('restarting')),
      ),
    ).toBe(true);
    expect(speaking()).toEqual([]);
  });

  it('are never shown as current past the core’s window', async () => {
    // Every poll after the first fails, so the first answer is held for as long as the test runs.
    valuesReply = (_id, read) => (read === 1 ? 'answer' : 'fail');
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });

    // Read 5 s before an answer whose window is 180 s: current for 175 s more. Eleven polls on
    // (165 s) it is still a number, with its age; the twelfth (180 s) takes it out.
    const current = (WINDOW_MS - READ_AGO_MS) / POLL_MS;
    for (let index = 1; index < current; index += 1) await onePoll();
    await waitFor(() => {
      expect(readingsRegion().textContent).toBe(SAID);
    });
    expect(reading()).toBe(shown(9, 1));
    expect(document.querySelector('tbody tr td time')?.textContent).toBe('3m ago');

    await onePoll();
    await waitFor(() => {
      expect(reading()).toBe('no recent reading');
    });
    expect(document.querySelector('tbody')?.textContent).not.toContain(shown(9, 1));
    // Still said: what is shown is the held answer, with no number left in it.
    await waitFor(() => {
      expect(readingsRegion().textContent).toBe(SAID);
    });
  });

  it('are never shown under another sensor', async () => {
    // Sensor 12's first read is slow, and then refused.
    valuesReply = (id) => (id === 12 ? 'hold' : 'answer');
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });

    const texts: string[] = [];
    const observer = new MutationObserver(() => {
      texts.push(document.body.textContent);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    try {
      act(() => {
        go('/objects/12');
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'Uplink ports' })).toBeDefined();
      await waitFor(() => {
        expect(reads[12]).toBe(1);
      });
      // Sensor 12's table, its read out: nothing in the row sensor 9's reading would land in.
      await waitFor(() => {
        expect(screen.getByText('Port x')).toBeDefined();
      });
      expect(reading()).toBe('—');
      act(() => {
        release('fail');
      });
      // Refused with nothing held for sensor 12: its error panel, not sensor 9's readings.
      expect(await alertSaying('restarting')).toBeDefined();
    } finally {
      for (const _ of observer.takeRecords()) texts.push(document.body.textContent);
      observer.disconnect();
    }
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toContain(shown(9, 1));
  });
});

describe('the poll and the values’ error panel (U-71)', () => {
  it('waits while Try again is out, and focus stays on it', async () => {
    // The first read is refused; Try again's read is slow, and then answers.
    valuesReply = (_id, read) => (read === 1 ? 'fail' : read === 2 ? 'hold' : 'answer');
    mount('/objects/9');
    const alert = await alertSaying('restarting');
    const button = within(alert).getByRole('button', { name: 'Try again' });
    act(() => {
      button.focus();
    });
    const focus = watchFocus();
    fireEvent.click(button);
    await waitFor(() => {
      expect(reads[9]).toBe(2);
    });

    // Two polls' worth of time while it is out: nothing more is asked, and the panel stays.
    pass(POLL_MS);
    pass(POLL_MS);
    expect(reads[9]).toBe(2);
    expect(alert.isConnected).toBe(true);
    expect(within(alert).getByRole('button', { name: 'Trying again…' })).toBe(button);
    expect(document.activeElement).toBe(button);

    // Answered: the panel goes, the readings come, and focus goes to the Overview's panel.
    act(() => {
      release('answer');
    });
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 2));
    });
    expect(alert.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('panel-overview'));
    expect(focus.lost()).toBe(0);
    focus.stop();
  });

  // `U-77`: Try again's read never answers. It used to hold the poll, which waits for it, for
  // good; it is given up after the read bound, said, and the poll goes on.
  it('is not stalled by a Try again whose read never answers', async () => {
    const restoreBound = setReadTimeout(80);
    try {
      valuesReply = (_id, read) => (read === 1 ? 'fail' : read === 2 ? 'hold' : 'answer');
      mount('/objects/9');
      const alert = await alertSaying('restarting');
      const button = within(alert).getByRole('button', { name: 'Try again' });
      act(() => {
        button.focus();
      });
      fireEvent.click(button);
      await waitFor(() => {
        expect(reads[9]).toBe(2);
      });

      // Never released: given up after the bound, said in the same panel, the button free again.
      await waitFor(() => {
        expect(alert.textContent).toContain('The core did not answer');
      });
      expect(alert.textContent).toContain('GET /sensors/9/values');
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBe(button);
      expect(document.activeElement).toBe(button);

      // And the poll goes on: the next interval asks, and its answer is shown.
      await onePoll();
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 3));
      });
    } finally {
      restoreBound();
    }
  });

  it('keeps the panel through a poll that fails again, until a read answers', async () => {
    valuesReply = (_id, read) => (read <= 2 ? 'fail' : 'answer');
    mount('/objects/9');
    const alert = await alertSaying('restarting');
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      // The poll reads again with the panel up: refused, the panel never left the page.
      await onePoll();
      await waitFor(() => {
        expect(alert.textContent).toContain('restarting');
      });
      for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
      expect(removed.some((node) => node.contains(alert))).toBe(false);
      expect(alert.isConnected).toBe(true);

      // The next poll answers: the panel goes for the table.
      await onePoll();
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 3));
      });
      expect(alert.isConnected).toBe(false);
    } finally {
      observer.disconnect();
    }
  });
});

/** What the region says for a failure in `message` with `id`. */
const saying = (message: string, id: string): string =>
  'The readings could not be read again, so these are the ones read before, each as old as it ' +
  `says: ${message} ${id}`;

describe('a poll failing again (U-71 review, U-59’s rule)', () => {
  it('keeps the one shown in the same words, says other words, and says it again after Try again', async () => {
    // Read once; every poll after that is refused, each with its own id.
    valuesReply = (_id, read) => (read === 1 ? 'answer' : 'fail');
    failure = (read) => ({
      message: read <= 4 ? 'restarting' : 'disk full',
      id: `req-${String(read)}`,
    });
    mount('/objects/9');
    await waitFor(() => {
      expect(reading()).toBe(shown(9, 1));
    });
    const region = readingsRegion();

    // Every state the region is in, in order.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(region.textContent);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    try {
      // Three polls refused in the same words: said once, the first id kept, never emptied.
      await onePoll();
      await waitFor(() => {
        expect(region.textContent).toBe(saying('restarting', 'req-2'));
      });
      await onePoll();
      await onePoll();
      // Its answer, already resolved, given real time to land (`setTimeout` is not faked).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(reads[9]).toBe(4);
      expect(region.textContent).toBe(saying('restarting', 'req-2'));
      expect(seen).toEqual([saying('restarting', 'req-2')]);
      expect(reading()).toBe(shown(9, 1));

      // A failure in other words replaces it, and is said.
      await onePoll();
      await waitFor(() => {
        expect(region.textContent).toBe(saying('disk full', 'req-5'));
      });
      expect(seen).toEqual([saying('restarting', 'req-2'), saying('disk full', 'req-5')]);

      // Try again, pressed: emptied as its read starts, and the same failure is said again.
      const retry = within(channelsCard()).getByRole('button', { name: 'Try again' });
      act(() => {
        retry.focus();
      });
      fireEvent.click(retry);
      expect(region.matches(':empty')).toBe(true);
      await waitFor(() => {
        expect(region.textContent).toBe(saying('disk full', 'req-6'));
      });
      expect(reads[9]).toBe(6);
      expect(seen).toEqual([
        saying('restarting', 'req-2'),
        saying('disk full', 'req-5'),
        '',
        saying('disk full', 'req-6'),
      ]);
      expect(document.activeElement).toBe(retry);
      expect(speaking()).toEqual([]);

      // A good poll empties it.
      valuesReply = () => 'answer';
      await onePoll();
      await waitFor(() => {
        expect(reading()).toBe(shown(9, 7));
      });
      expect(region.matches(':empty')).toBe(true);
    } finally {
      observer.disconnect();
    }
  });
});
