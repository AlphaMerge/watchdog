import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectKind, ObjectSummary } from '../src/api/types';
import { TreeView } from '../src/routes/TreeView';

/** Records every URL asked for, and answers from a scripted map. */
function stubFetch(routes: Record<string, unknown>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const body = routes[url];
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

/** A socket that never opens: these tests are about the shape of the tree, not its states. */
class QuietSocket {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  send(): void {}
  close(): void {}
}

function summary(
  id: number,
  parentId: number | null,
  kind: ObjectKind,
  name: string,
  hasChildren: boolean,
): ObjectSummary {
  return { id, parentId, kind, name, tags: [], priority: 3, version: 1, hasChildren };
}

const children = (parentId: number): string =>
  `/api/v1/objects?parentId=${String(parentId)}&sort=manual&limit=500`;

/**
 * Where the tree starts (`A-12`).
 *
 * An account granted one customer's branch may not read the root, and the containers above its
 * branch are outside what it was granted — so its tree cannot begin at the root and be expanded
 * down. It begins at `/objects/tops` instead, and for an account that can read the root, that is
 * the root and the tree is what it always was.
 */
describe('where the tree starts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', QuietSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at the branches an account was granted, and never asks for the root', async () => {
    const asked = stubFetch({
      '/api/v1/objects/tops': {
        // A branch, and a sensor re-granted inside a hole in it: two first-level rows.
        items: [
          summary(3, 2, 'group', 'Customer A', true),
          summary(9, 8, 'sensor', 'a-regranted', false),
        ],
      },
    });
    render(
      <MemoryRouter>
        <TreeView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Customer A')).toBeDefined();
    expect(screen.getByText('a-regranted')).toBeDefined();
    expect(asked.some((url) => url.includes('/objects/root'))).toBe(false);
    // The tops are the first level already; nothing is asked for above them.
    expect(asked.some((url) => url.includes('parentId=0'))).toBe(false);
    expect(asked.some((url) => url.includes('parentId=2'))).toBe(false);
  });

  it('starts at the root’s children for an account that can read the root', async () => {
    const asked = stubFetch({
      '/api/v1/objects/tops': { items: [summary(1, null, 'root', 'Root', true)] },
      [children(1)]: { items: [summary(2, 1, 'probe', 'Local probe', true)], nextCursor: null },
    });
    render(
      <MemoryRouter>
        <TreeView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Local probe')).toBeDefined();
    expect(screen.queryByText('Root')).toBeNull();
    expect(asked).toContain(children(1));
  });

  it('says so when nothing has been shared with the account', async () => {
    stubFetch({ '/api/v1/objects/tops': { items: [] } });
    render(
      <MemoryRouter>
        <TreeView />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Nothing in the tree has been shared with this account.'),
    ).toBeDefined();
  });
});
