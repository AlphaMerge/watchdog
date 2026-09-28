import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import { TreeView } from '../src/routes/TreeView';

// The tree opens a socket for live states, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map() }),
}));

const ROOT = { id: 1, kind: 'root', name: 'Root' } as const;
const PROBE = { id: 2, kind: 'probe', name: 'Local probe' } as const;

const summary = (
  id: number,
  kind: string,
  name: string,
  path: readonly { id: number; kind: string; name: string }[],
) => ({
  id,
  parentId: path.at(-1)?.id ?? null,
  kind,
  name,
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: kind !== 'sensor',
  path,
});

/** Two sensors both called `Ping`, and a probe whose only ancestor is the root. */
const FOUND = {
  items: [
    summary(10, 'sensor', 'Ping', [
      ROOT,
      PROBE,
      { id: 3, kind: 'group', name: 'Berlin DC' },
      { id: 4, kind: 'device', name: 'switch-01' },
    ]),
    summary(11, 'sensor', 'Ping', [
      ROOT,
      PROBE,
      { id: 5, kind: 'group', name: 'Munich DC' },
      { id: 6, kind: 'device', name: 'switch-02' },
    ]),
    summary(2, 'probe', 'Local probe', [ROOT]),
  ],
  nextCursor: null,
};

/**
 * Records every URL asked for; answers where the tree starts — the root, for an account that can
 * read it — any search, and an empty level otherwise.
 */
function stubFetch(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const body =
      url === '/api/v1/objects/tops'
        ? { items: [summary(ROOT.id, ROOT.kind, ROOT.name, [])] }
        : url.includes('q=')
          ? FOUND
          : { items: [], nextCursor: null };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

/** The text with one of the two renderings taken out — what is seen, or what is read aloud. */
const without = (element: Element, selector: string): string => {
  const copy = element.cloneNode(true) as Element;
  for (const node of copy.querySelectorAll(selector)) node.remove();
  return copy.textContent;
};

const pathOf = (link: HTMLElement): Element | null =>
  link.closest('li')?.querySelector('p') ?? null;

/**
 * Search results say where each match is (`P-214`).
 *
 * `web-ui.md` promised the path "written out" while every row was a name, a kind and a badge —
 * so a search for `Ping` on any real installation was a column of identical lines.
 */
describe('the tree search’s results', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const search = async (text: string): Promise<string[]> => {
    const asked = stubFetch();
    render(
      <MemoryRouter>
        <TreeView />
      </MemoryRouter>,
    );
    // The box is there from the start; the results wait for where the tree starts, as it does.
    await waitFor(() => {
      expect(asked).toContain('/api/v1/objects/tops');
    });
    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: text } });
    await screen.findAllByRole('link', { name: 'Ping' });
    return asked;
  };

  it('asks the server for every match’s path in the same request', async () => {
    const asked = await search('Ping');
    const searches = asked
      .filter((url) => url.startsWith('/api/v1/objects?'))
      .map((url) => new URLSearchParams(url.slice(url.indexOf('?') + 1)))
      .filter((params) => params.has('q'));

    expect(searches).toHaveLength(1);
    expect(searches[0]?.get('q')).toBe('Ping');
    expect(searches[0]?.get('include')).toBe('path');
    // And nothing per row: a breadcrumb request for each match is what the listing replaces.
    expect(asked.some((url) => url.includes('/ancestors'))).toBe(false);
  });

  it('writes the path under each match, so two with one name read differently', async () => {
    await search('Ping');
    const [berlin, munich] = screen.getAllByRole('link', { name: 'Ping' });
    const first = pathOf(berlin as HTMLElement);
    const second = pathOf(munich as HTMLElement);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The root begins every path, so it is left off rather than repeated on every row.
    expect(without(first as Element, '.sr-only')).toBe('Local probe › Berlin DC › switch-01');
    expect(without(second as Element, '.sr-only')).toBe('Local probe › Munich DC › switch-02');
  });

  it('reads the path aloud as a list of places, not as punctuation', async () => {
    await search('Ping');
    const [berlin] = screen.getAllByRole('link', { name: 'Ping' });
    const path = pathOf(berlin as HTMLElement);

    expect(path).not.toBeNull();
    expect(without(path as Element, '[aria-hidden="true"]')).toBe(
      'in Local probe, Berlin DC, switch-01',
    );
  });

  it('writes no path under a match whose only ancestor is the root', async () => {
    await search('Ping');
    const probe = screen.getByRole('link', { name: 'Local probe' });
    expect(pathOf(probe)).toBeNull();
  });
});
