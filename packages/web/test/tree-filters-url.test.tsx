import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import { TreeView } from '../src/routes/TreeView';

// The tree opens a socket for live states, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * The tree's search and tag, held in the address (`U-70`).
 *
 * Only *Invalid parameters only* was (`U-63`): a search somebody had narrowed could not be sent,
 * and reload or following a result and coming *Back* threw it away. The boxes now write
 * `?q=` and `?tag=` as they change, with `replace`, and read them when the page opens or the
 * address is moved by a link or *Back* while the tree is open.
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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Records every URL asked for. The tree starts at the root; any filtered listing answers one
 * sensor, `Disk C`; a level of the tree is empty.
 */
function stubFetch(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    if (url === '/api/v1/objects/tops') {
      return Promise.resolve(json({ items: [summary(ROOT.id, 'root', 'Root')] }));
    }
    const filtered = /[?&](q|tag|invalidParams)=/u.test(url);
    return Promise.resolve(
      json({ items: filtered ? [summary(10, 'sensor', 'Disk C')] : [], nextCursor: null }),
    );
  });
  return asked;
}

/** What each filtered listing asked for, as `q|tag|invalidParams`. */
const searches = (asked: readonly string[]): string[] =>
  asked
    .filter((url) => url.startsWith('/api/v1/objects?') && !url.includes('parentId='))
    .map((url) => new URLSearchParams(url.slice(url.indexOf('?') + 1)))
    .map((p) => `${p.get('q') ?? ''}|${p.get('tag') ?? ''}|${p.get('invalidParams') ?? ''}`);

let location = '';
function Where(): null {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

/** The browser's own controls, and a link to the plain tree as the navigation bar has. */
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

const renderAt = (entries: string[]): void => {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Where />
      <Chrome />
      <Routes>
        <Route path="/start" element={<p>Start page</p>} />
        <Route path="/tree" element={<TreeView />} />
        <Route path="/objects/:id" element={<p>Object page</p>} />
      </Routes>
    </MemoryRouter>,
  );
};

const searchBox = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search objects' });
const tagBox = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('searchbox', { name: 'Filter by tag' });
const invalidBox = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: 'Invalid parameters only' });

const back = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  location = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tree’s search and tag in the address', () => {
  it('opens with the search and tag the address holds, and asks for them', async () => {
    const asked = stubFetch();
    renderAt(['/tree?q=Disk&tag=core']);
    expect(searchBox().value).toBe('Disk');
    expect(tagBox().value).toBe('core');
    expect(invalidBox().checked).toBe(false);
    await screen.findByRole('link', { name: 'Disk C' });
    expect(searches(asked)).toEqual(['Disk|core|']);
  });

  it('writes what is typed in place, and Back after following a result finds it', async () => {
    const asked = stubFetch();
    renderAt(['/start', '/tree?q=Di']);
    expect(searchBox().value).toBe('Di');

    fireEvent.change(searchBox(), { target: { value: 'Disk' } });
    expect(searchBox().value).toBe('Disk');
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk');
    });
    fireEvent.change(tagBox(), { target: { value: 'core' } });
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&tag=core');
    });

    fireEvent.click(await screen.findByRole('link', { name: 'Disk C' }));
    await screen.findByText('Object page');
    expect(location).toBe('/objects/10');

    const before = searches(asked).length;
    back();
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&tag=core');
    });
    // A new page, read from the address: the boxes as they were left, and that search asked.
    expect(searchBox().value).toBe('Disk');
    expect(tagBox().value).toBe('core');
    await screen.findByRole('link', { name: 'Disk C' });
    expect(searches(asked).slice(before)).toEqual(['Disk|core|']);

    // Typing replaced the entry it opened on rather than adding one per change: one more Back
    // leaves the tree.
    back();
    await screen.findByText('Start page');
    expect(location).toBe('/start');
  });

  it('follows the address when a link or Back moves it while the tree is open', async () => {
    const asked = stubFetch();
    renderAt(['/tree?q=Disk&tag=core']);
    await screen.findByRole('link', { name: 'Disk C' });

    // The navigation bar's plain tree: the same page, unfiltered.
    fireEvent.click(screen.getByRole('link', { name: 'Tree' }));
    await waitFor(() => {
      expect(location).toBe('/tree');
    });
    expect(searchBox().value).toBe('');
    expect(tagBox().value).toBe('');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Disk C' })).toBeNull();
    });

    back();
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&tag=core');
    });
    expect(searchBox().value).toBe('Disk');
    expect(tagBox().value).toBe('core');
    await screen.findByRole('link', { name: 'Disk C' });
    expect(searches(asked).at(-1)).toBe('Disk|core|');
  });

  it('leaves a blank box out of the address, and keeps what was typed in the box', async () => {
    stubFetch();
    renderAt(['/tree?q=Disk']);
    fireEvent.change(searchBox(), { target: { value: '  ' } });
    await waitFor(() => {
      expect(location).toBe('/tree');
    });
    expect(searchBox().value).toBe('  ');
  });
});

describe('the three filters together', () => {
  it('asks with all three, and each box changes only its own', async () => {
    const asked = stubFetch();
    renderAt(['/tree?q=Disk&tag=core&invalidParams=true']);
    expect(invalidBox().checked).toBe(true);
    await screen.findByRole('link', { name: 'Disk C' });
    expect(searches(asked)).toEqual(['Disk|core|true']);

    fireEvent.click(invalidBox());
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&tag=core');
    });
    expect(searchBox().value).toBe('Disk');
    await waitFor(() => {
      expect(searches(asked).at(-1)).toBe('Disk|core|');
    });

    fireEvent.click(invalidBox());
    await waitFor(() => {
      expect(location).toBe('/tree?q=Disk&tag=core&invalidParams=true');
    });

    fireEvent.change(searchBox(), { target: { value: '' } });
    await waitFor(() => {
      expect(location).toBe('/tree?tag=core&invalidParams=true');
    });
    expect(invalidBox().checked).toBe(true);
    await waitFor(() => {
      expect(searches(asked).at(-1)).toBe('|core|true');
    });

    fireEvent.change(tagBox(), { target: { value: 'edge' } });
    await waitFor(() => {
      expect(location).toBe('/tree?tag=edge&invalidParams=true');
    });
    await waitFor(() => {
      expect(searches(asked).at(-1)).toBe('|edge|true');
    });
  });

  it('keeps an address parameter that is not a filter', async () => {
    stubFetch();
    renderAt(['/tree?other=1']);
    fireEvent.change(searchBox(), { target: { value: 'Disk' } });
    await waitFor(() => {
      expect(location).toBe('/tree?other=1&q=Disk');
    });
  });
});
