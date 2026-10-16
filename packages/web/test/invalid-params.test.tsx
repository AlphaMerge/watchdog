import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
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

const ONE: Answer = {
  status: 200,
  body: { items: [summary(12, 'sensor', 'Fan tray')], nextCursor: null },
};

/**
 * Records every URL asked for. The tree starts at the root; a listing with the filter answers
 * from `listing` in turn (the last one repeating), and from the `holdFrom`th such request on
 * (counting from 0) is held until `release`; any other listing is an empty level.
 */
function stubFetch(
  listing: Answer[],
  holdFrom = Number.POSITIVE_INFINITY,
): { asked: string[]; release: () => void } {
  const asked: string[] = [];
  let released: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let next = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    if (url === '/api/v1/objects/tops') {
      return json({ status: 200, body: { items: [summary(ROOT.id, 'root', 'Root')] } });
    }
    if (url.includes('invalidParams=true')) {
      const answer = listing[Math.min(next, listing.length - 1)] ?? NONE;
      next += 1;
      if (next > holdFrom) await gate;
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

/**
 * Every text `node` held while `act` ran, read from the mutation records: by the time an observer
 * runs, React may have committed again, so the node as it is then can be empty either way.
 */
async function textsDuring(node: HTMLElement, during: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      if (record.oldValue !== null) said.push(record.oldValue);
      for (const added of [...record.addedNodes, ...record.removedNodes]) {
        said.push(added.textContent ?? '');
      }
      if (record.type === 'characterData') said.push(record.target.textContent ?? '');
    }
  });
  watch.observe(node, {
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    subtree: true,
  });
  await during();
  // Records queued by the last commit are delivered as a microtask, before this task.
  await new Promise((resolve) => setTimeout(resolve, 0));
  watch.disconnect();
  return said;
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

/** The browser's *Back*, and the navigation bar's link to the plain tree. */
function Chrome(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <nav>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        Back
      </button>
      <Link to="/tree">Tree</Link>
    </nav>
  );
}

const renderTreeWithChrome = (at: string): void => {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Chrome />
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
    declaredLookup: null,
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
    // Its own line below `sm`, so on a phone it does not crush the search beside it.
    const label = box.closest('label');
    expect(label?.classList.contains('basis-full')).toBe(true);
    expect(label?.classList.contains('sm:basis-auto')).toBe(true);
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
    // The search is held beside it (`U-70`).
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&invalidParams=true');
    });
  });

  it('lists the sensors by what the listing shows, and says how many', async () => {
    stubFetch([LISTED]);
    renderTree('/tree?invalidParams=true');
    await screen.findByRole('link', { name: 'Disk C' });
    expect(region().textContent).toBe(
      '2 sensors have parameters their type now refuses, among those you can edit.',
    );
    expect(screen.getByRole('link', { name: 'Disk C' }).getAttribute('href')).toBe('/objects/10');
  });

  it('has its region on the page and empty before the answer, which lands in it', async () => {
    const { release } = stubFetch([notChecked('checking')], 0);
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
    const { asked, release } = stubFetch([notChecked('checking'), LISTED], 1);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(CHECKING);
    });
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(screen.queryByText(/OBJECT_PARAMS_NOT_CHECKED/u)).toBeNull();

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Try again' });
    button.focus();
    fireEvent.click(button);
    // While it asks again: the same button, still focused, unavailable, and the region empty.
    await waitFor(() => {
      expect(filterAsks(asked)).toHaveLength(2);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(region().textContent).toBe('');
    // A second press while it asks is nothing.
    fireEvent.click(button);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('link', { name: 'Uplink' });
    expect(filterAsks(asked)).toHaveLength(2);
    expect(region().textContent).toBe(
      '2 sensors have parameters their type now refuses, among those you can edit.',
    );
    // The list took the button away, and focus went to the filter's own box, not the page.
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole('checkbox', { name: 'Invalid parameters only' }),
    );
  });

  it('empties the region on Try again, and says a check still running again', async () => {
    const { release } = stubFetch([notChecked('checking'), notChecked('checking')], 1);
    renderTree('/tree?invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(CHECKING);
    });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Try again' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => {
      expect(region().textContent).toBe('');
    });

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(region().textContent).toBe(CHECKING);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('false');
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
        'No sensor you can edit has parameters its type now refuses.',
      );
    });
    expect(screen.queryByText('Nothing matches.')).toBeNull();
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });

  it('never says what an earlier search answered, even for a render', async () => {
    const { release } = stubFetch([LISTED], 0);
    renderTree('/tree');
    fireEvent.change(await screen.findByLabelText('Search objects'), {
      target: { value: 'Disk' },
    });
    // The search alone answers an empty list, which is not the filter's answer.
    await screen.findByText('Nothing matches.');

    const box = screen.getByRole('checkbox', { name: 'Invalid parameters only' });
    const said = await textsDuring(region(), async () => {
      fireEvent.click(box);
      await screen.findByText('Loading matching objects…');
    });
    expect(said.filter((text) => text !== '')).toEqual([]);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('link', { name: 'Disk C' });
    expect(region().textContent).toBe(
      '2 sensors have parameters their type now refuses, among those you can edit.',
    );
  });

  it('never says what a search the address held answered, once it is typed over', async () => {
    // `U-70`: the search now comes from the address too, so the first answer is to a search
    // nobody typed on this page, and typing must set it aside as ticking the box does. Emptying
    // the search is the edit that would show it: the empty answer to `Disk`, read as if it were
    // the answer for every sensor, says a sentence of its own.
    const MATCHING_NONE = 'No sensor matching the search has parameters its type now refuses.';
    const { asked, release } = stubFetch([NONE, ONE], 1);
    renderTree('/tree?q=Disk&invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(MATCHING_NONE);
    });

    const said = await textsDuring(region(), async () => {
      fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: '' } });
      await screen.findByText('Loading matching objects…');
    });
    // The sentence it held, taken away, and nothing else: not `No sensor you can edit…`.
    expect(said.filter((text) => text !== '' && text !== MATCHING_NONE)).toEqual([]);
    expect(region().textContent).toBe('');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('link', { name: 'Fan tray' });
    expect(region().textContent).toBe(
      '1 sensor has parameters its type now refuses, among those you can edit.',
    );
    expect(filterAsks(asked).map((params) => params.get('q'))).toEqual(['Disk', null]);
    await waitFor(() => {
      expect(location).toBe('/tree?invalidParams=true');
    });
  });

  it('never says what the address’s search answered when Back brings that search again', async () => {
    // `U-70`: leaving a filtered tree for the plain one and coming *Back* asks the same path
    // again, as unticking and ticking the box does, and `useApi` still holds its answer.
    const MATCHING_NONE = 'No sensor matching the search has parameters its type now refuses.';
    const { release } = stubFetch([NONE, ONE], 1);
    renderTreeWithChrome('/tree?q=Disk&invalidParams=true');
    await waitFor(() => {
      expect(region().textContent).toBe(MATCHING_NONE);
    });
    fireEvent.click(screen.getByRole('link', { name: 'Tree' }));
    await waitFor(() => {
      expect(region().textContent).toBe('');
    });
    expect(screen.getByLabelText<HTMLInputElement>('Search objects').value).toBe('');

    const said = await textsDuring(region(), async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByText('Loading matching objects…');
    });
    expect(said.filter((text) => text !== '')).toEqual([]);
    expect(screen.getByLabelText<HTMLInputElement>('Search objects').value).toBe('Disk');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('link', { name: 'Fan tray' });
    expect(region().textContent).toBe(
      '1 sensor has parameters its type now refuses, among those you can edit.',
    );
  });

  it.each([
    [
      'a list',
      LISTED,
      '2 sensors have parameters their type now refuses, among those you can edit.',
    ],
    ['a check still running', notChecked('checking'), CHECKING],
  ])(
    'never says the last answer again when the box is unticked and ticked: %s',
    async (_, first, firstSaid) => {
      const { release } = stubFetch([first, ONE], 1);
      renderTree('/tree?invalidParams=true');
      await waitFor(() => {
        expect(region().textContent).toBe(firstSaid);
      });
      const box = screen.getByRole('checkbox', { name: 'Invalid parameters only' });
      fireEvent.click(box);
      await waitFor(() => {
        expect(region().textContent).toBe('');
      });

      const said = await textsDuring(region(), async () => {
        fireEvent.click(box);
        await screen.findByText('Loading matching objects…');
      });
      expect(said.filter((text) => text !== '')).toEqual([]);
      expect(screen.queryByRole('link', { name: 'Disk C' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

      await act(async () => {
        release();
        await Promise.resolve();
      });
      await screen.findByRole('link', { name: 'Fan tray' });
      expect(region().textContent).toBe(
        '1 sensor has parameters its type now refuses, among those you can edit.',
      );
    },
  );

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
