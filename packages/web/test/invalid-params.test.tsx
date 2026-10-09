import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ChannelRecord } from '../src/api/types';
import { ChannelTable } from '../src/routes/detail/ChannelTable';
import { TreeView } from '../src/routes/TreeView';
import { expectQuiet, speaking } from './support/refusal-region';

// The tree opens a socket for live states, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * The way in to the sensors whose stored parameters their type now refuses (`U-63`).
 *
 * `GET /objects?invalidParams=true` listed them (`P-375`) and nothing in the web asked for it:
 * Core Health counted them and the count led nowhere. The list is the tree filtered, the filter
 * is in the URL, and until the core's start-up check has read every sensor the page says why
 * there is no list, in a polite region that was there before it had anything to say.
 */

const ROOT = { id: 1, kind: 'root', name: 'Root' } as const;

const summary = (id: number, kind: string, name: string) => ({
  id,
  parentId: kind === 'root' ? null : ROOT.id,
  kind,
  name,
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: kind !== 'sensor',
  path: kind === 'root' ? [] : [ROOT],
});

type Answer = { status: number; body: unknown };

const json = ({ status, body }: Answer): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notChecked = (pass: 'checking' | 'stopped'): Answer => ({
  status: 503,
  body: {
    error: {
      code: 'OBJECT_PARAMS_NOT_CHECKED',
      message:
        pass === 'checking'
          ? 'the start-up check of stored sensor parameters has not read every sensor yet; ask again in a few seconds'
          : 'the start-up check of stored sensor parameters stopped before it had read every sensor (the core log says why); the next start checks again',
      correlationId: 'req-7',
      context: { phase: 'stored-params-check' },
      details: { pass },
    },
  },
});

const LISTED: Answer = {
  status: 200,
  body: {
    items: [summary(10, 'sensor', 'Disk C'), summary(11, 'sensor', 'Uplink')],
    nextCursor: null,
  },
};
const NONE: Answer = { status: 200, body: { items: [], nextCursor: null } };

/**
 * Records every URL asked for. The tree starts at the root; a listing with the filter answers
 * from `listing` in turn (the last one repeating), and is held until `release` while `hold` is
 * set; any other listing is an empty level.
 */
function stubFetch(listing: Answer[], hold = false): { asked: string[]; release: () => void } {
  const asked: string[] = [];
  let released: () => void = () => undefined;
  const gate = hold
    ? new Promise<void>((resolve) => {
        released = resolve;
      })
    : Promise.resolve();
  let next = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    if (url === '/api/v1/objects/tops') {
      return json({ status: 200, body: { items: [summary(ROOT.id, 'root', 'Root')] } });
    }
    if (url.includes('invalidParams=true')) {
      const answer = listing[Math.min(next, listing.length - 1)] ?? NONE;
      next += 1;
      await gate;
      return json(answer);
    }
    return json(NONE);
  });
  return {
    asked,
    release: () => {
      released();
    },
  };
}

let location = '';
function Where(): null {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

const renderTree = (at: string): void => {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Routes>
        <Route path="/tree" element={<TreeView />} />
      </Routes>
    </MemoryRouter>,
  );
};

const region = (): HTMLElement => {
  const found = document.getElementById('tree-filter-status');
  if (found === null) throw new Error('no filter status region');
  return found;
};

const filterAsks = (asked: readonly string[]): URLSearchParams[] =>
  asked
    .filter((url) => url.startsWith('/api/v1/objects?') && url.includes('invalidParams'))
    .map((url) => new URLSearchParams(url.slice(url.indexOf('?') + 1)));

const CHECKING =
  'Stored sensor parameters are still being checked after the core’s start, so which sensors ' +
  'fail is not known yet. Try again shortly.';
const STOPPED =
  'Stored sensor parameters have not been checked since the core last started, so which ' +
  'sensors fail is not known. They are checked again at the next start.';

beforeEach(() => {
  vi.unstubAllGlobals();
  location = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Core Health’s count of sensors with invalid parameters', () => {
  const channel = (id: number, key: string, name: string): ChannelRecord => ({
    id,
    key,
    name,
    unit: '',
    isPrimary: id === 1,
    limits: {
      enabled: true,
      upperError: null,
      upperWarning: null,
      lowerWarning: null,
      lowerError: null,
      errorMessage: '',
      warningMessage: '',
    },
    scaleMul: '1',
    scaleDiv: '1',
    decimals: null,
    spikeMin: null,
    spikeMax: null,
    lookupId: null,
    retired: false,
  });

  const renderHealth = (sensorType: string): void => {
    render(
      <MemoryRouter initialEntries={['/objects/5']}>
        <Where />
        <Routes>
          <Route
            path="/objects/5"
            element={
              <ChannelTable
                channels={[
                  channel(1, 'eventLoopLagMs', 'Event loop lag'),
                  channel(2, 'sensorsWithInvalidParams', 'Sensors with invalid parameters'),
                ]}
                sensorType={sensorType}
                values={null}
                lookups={[]}
                now={Date.now()}
                hideRetired={false}
                onHideRetiredChange={() => undefined}
              />
            }
          />
          <Route path="/tree" element={<TreeView />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('links to the tree filtered to those sensors, which asks the core for them', async () => {
    const { asked } = stubFetch([LISTED]);
    renderHealth('ms.core.health');

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    const link = screen.getByRole('link', { name: 'Which sensors →' });
    expect(link.closest('tr')?.textContent).toContain('Sensors with invalid parameters');
    expect(link.getAttribute('href')).toBe('/tree?invalidParams=true');

    fireEvent.click(link);
    expect(location).toBe('/tree?invalidParams=true');
    await screen.findByRole('link', { name: 'Disk C' });
    expect(filterAsks(asked).map((params) => params.get('invalidParams'))).toEqual(['true']);
  });

  it('is not a link on a type that only shares the key', () => {
    stubFetch([LISTED]);
    renderHealth('script.custom');
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});

describe('the tree’s invalid-parameters filter', () => {
  it('is held in the URL: ticked from it, and ticking and unticking change it', async () => {
    const { asked } = stubFetch([LISTED]);
    renderTree('/tree');
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Invalid parameters only' });
    expect(box.checked).toBe(false);
    await waitFor(() => {
      expect(asked).toContain('/api/v1/objects/tops');
    });
    expect(filterAsks(asked)).toEqual([]);

    fireEvent.click(box);
    expect(location).toBe('/tree?invalidParams=true');
    expect(box.checked).toBe(true);
    await screen.findByRole('link', { name: 'Uplink' });
    const [params] = filterAsks(asked);
    expect(params?.get('invalidParams')).toBe('true');
    // The search's own expansions come with it, so each row says where it is.
    expect(params?.get('include')).toBe('path');

    fireEvent.click(box);
    expect(location).toBe('/tree');
    expect(box.checked).toBe(false);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Uplink' })).toBeNull();
    });
    expect(region().textContent).toBe('');
  });

  it('opens ticked from a link, and is combined with a search', async () => {
    const { asked } = stubFetch([LISTED]);
    renderTree('/tree?invalidParams=true');
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Invalid parameters only' });
    expect(box.checked).toBe(true);
    await screen.findByRole('link', { name: 'Disk C' });

    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: 'Disk' } });
    await waitFor(() => {
      expect(filterAsks(asked).some((params) => params.get('q') === 'Disk')).toBe(true);
    });
    expect(location).toBe('/tree?invalidParams=true');
  });

  it('lists the sensors by what the listing shows, and says how many', async () => {
    stubFetch([LISTED]);
    renderTree('/tree?invalidParams=true');
    await screen.findByRole('link', { name: 'Disk C' });
    expect(region().textContent).toBe(
      '2 sensors have parameters their type now refuses, among those you can see.',
    );
    expect(screen.getByRole('link', { name: 'Disk C' }).getAttribute('href')).toBe('/objects/10');
  });

  it('has its region on the page and empty before the answer, which lands in it', async () => {
    const { release } = stubFetch([notChecked('checking')], true);
    renderTree('/tree?invalidParams=true');
    const before = region();
    expectQuiet(before, ['mt-3', 'empty:mt-0'], 'polite');
    await screen.findByText('Loading matching objects…');
    expectQuiet(region(), ['mt-3', 'empty:mt-0'], 'polite');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(region().textContent).toBe(CHECKING);
    });
    expect(region()).toBe(before);
  });

  it('says a check still running in words, not as an error, and offers to ask again', async () => {
    const { asked } = stubFetch([notChecked('checking'), LISTED]);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(CHECKING);
    });
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(screen.queryByText(/OBJECT_PARAMS_NOT_CHECKED/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: 'Uplink' });
    expect(filterAsks(asked)).toHaveLength(2);
    expect(region().textContent).toBe(
      '2 sensors have parameters their type now refuses, among those you can see.',
    );
  });

  it('says a stopped check in words, not as an error, and offers nothing to retry', async () => {
    stubFetch([notChecked('stopped')]);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(STOPPED);
    });
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says none fail when the known set is empty, and says it once', async () => {
    stubFetch([NONE]);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(
        'No sensor you can see has parameters its type now refuses.',
      );
    });
    expect(screen.queryByText('Nothing matches.')).toBeNull();
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });

  it('never says what an earlier search answered, even for a render', async () => {
    const { release } = stubFetch([LISTED], true);
    renderTree('/tree');
    fireEvent.change(await screen.findByLabelText('Search objects'), {
      target: { value: 'Disk' },
    });
    // The search alone answers an empty list, which is not the filter's answer.
    await screen.findByText('Nothing matches.');

    // Every text the region held, read from the records: by the time an observer runs, React
    // may have committed again, so the region as it is then can be empty either way.
    const said: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue !== null) said.push(record.oldValue);
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          said.push(node.textContent ?? '');
        }
        if (record.type === 'characterData') said.push(record.target.textContent ?? '');
      }
    });
    watch.observe(region(), {
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      subtree: true,
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Invalid parameters only' }));
    await screen.findByText('Loading matching objects…');
    expect(said.filter((text) => text !== '')).toEqual([]);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('link', { name: 'Disk C' });
    watch.disconnect();
    expect(new Set(said.filter((text) => text !== ''))).toEqual(
      new Set(['2 sensors have parameters their type now refuses, among those you can see.']),
    );
  });

  it('leaves any other failure to the error panel, and says nothing in the region', async () => {
    stubFetch([
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom', correlationId: 'r-1' } } },
    ]);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(speaking()).toHaveLength(1);
    });
    expect(speaking()[0]?.textContent).toContain('INTERNAL');
    expect(region().textContent).toBe('');
  });
});
