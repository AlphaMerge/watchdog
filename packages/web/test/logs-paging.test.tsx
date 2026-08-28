import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaged } from '../src/routes/LogsView';

interface Row {
  id: string;
}

/** Records every URL asked for, and answers from a scripted map. */
function stubFetch(pages: Record<string, { items: Row[]; nextBefore: string | null }>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const page = pages[url];
    if (page === undefined) {
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

const cursorOf = (page: { items: Row[] }): string | null =>
  (page as { nextBefore?: string | null }).nextBefore ?? null;

describe('paging a log', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends the next page rather than replacing what is on screen', async () => {
    // A log is read downwards. A "load more" that swapped the list would lose the reader's place
    // in the rows they were part-way through.
    stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }, { id: '8' }], nextBefore: '8' },
      '/api/v1/log?limit=2&before=8': { items: [{ id: '7' }, { id: '6' }], nextBefore: null },
    });

    const { result } = renderHook(() =>
      usePaged<Row, string>('/log?limit=2', cursorOf, (cursor) => `/log?limit=2&before=${cursor}`),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.items.map((row) => row.id)).toEqual(['9', '8']);

    await act(async () => {
      result.current.more?.();
      // Lets the fetch's microtasks drain inside `act`, so React has applied the state update by
      // the time the assertion below runs.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(4);
    });
    expect(result.current.items.map((row) => row.id)).toEqual(['9', '8', '7', '6']);
  });

  it('stops offering more once the cursor runs out', async () => {
    stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }], nextBefore: null },
    });
    const { result } = renderHook(() =>
      usePaged<Row, string>('/log?limit=2', cursorOf, (cursor) => `/log?limit=2&before=${cursor}`),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.more).toBeNull();
  });

  it('stops offering more when a *later* page is the one that runs out', async () => {
    // The bug this was written against, measured live on a sensor with 77 changes: the last page
    // comes back short and carries a null cursor, and a null cursor was indistinguishable from
    // "no cursor yet" — so it fell through to the *first* page's cursor, which is never null.
    // The button stayed, and each further press re-fetched and re-appended the final page. 77
    // became 104: twenty-seven entries shown twice. In a log, a repeated entry is a second event
    // that did not happen.
    const asked = stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }, { id: '8' }], nextBefore: '8' },
      '/api/v1/log?limit=2&before=8': { items: [{ id: '7' }], nextBefore: null },
    });

    const { result } = renderHook(() =>
      usePaged<Row, string>('/log?limit=2', cursorOf, (cursor) => `/log?limit=2&before=${cursor}`),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      result.current.more?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });

    expect(result.current.more).toBeNull();
    expect(asked).toHaveLength(2);
    expect(result.current.items.map((row) => row.id)).toEqual(['9', '8', '7']);
  });

  it('pages from the second page cursor, not the first, however far it has gone', async () => {
    const asked = stubFetch({
      '/api/v1/log?limit=1': { items: [{ id: '9' }], nextBefore: '9' },
      '/api/v1/log?limit=1&before=9': { items: [{ id: '8' }], nextBefore: '8' },
      '/api/v1/log?limit=1&before=8': { items: [{ id: '7' }], nextBefore: null },
    });

    const { result } = renderHook(() =>
      usePaged<Row, string>('/log?limit=1', cursorOf, (cursor) => `/log?limit=1&before=${cursor}`),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      result.current.more?.();
      // Lets the fetch's microtasks drain inside `act`, so React has applied the state update by
      // the time the assertion below runs.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    await act(async () => {
      result.current.more?.();
      // Lets the fetch's microtasks drain inside `act`, so React has applied the state update by
      // the time the assertion below runs.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });

    // The third request uses the *second* page's cursor. Reusing the first would fetch page two
    // again for ever, which is a "load more" that appears to work and never advances.
    expect(asked).toEqual([
      '/api/v1/log?limit=1',
      '/api/v1/log?limit=1&before=9',
      '/api/v1/log?limit=1&before=8',
    ]);
  });

  it('drops what it accumulated when the filter changes', async () => {
    // Rows fetched against the old query answer a different question; showing them under the new
    // heading would put entries in a filtered list that the filter excludes.
    stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }, { id: '8' }], nextBefore: '8' },
      '/api/v1/log?limit=2&before=8': { items: [{ id: '7' }, { id: '6' }], nextBefore: null },
      '/api/v1/log?limit=2&kind=x': { items: [{ id: '5' }], nextBefore: null },
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) =>
        usePaged<Row, string>(path, cursorOf, (cursor) => `${path}&before=${cursor}`),
      { initialProps: { path: '/log?limit=2' } },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(async () => {
      result.current.more?.();
      // Lets the fetch's microtasks drain inside `act`, so React has applied the state update by
      // the time the assertion below runs.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(4);
    });

    rerender({ path: '/log?limit=2&kind=x' });
    await waitFor(() => {
      expect(result.current.items.map((row) => row.id)).toEqual(['5']);
    });
  });

  it('offers more again after a filter change, even having reached the end of the last one', async () => {
    // The paging state belongs to the query that produced it. Carried across a filter change, an
    // exhausted cursor makes the new list look complete at its first page — "that is the whole
    // log" about a log the reader has seen a fiftieth of.
    const asked = stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }, { id: '8' }], nextBefore: '8' },
      '/api/v1/log?limit=2&before=8': { items: [{ id: '7' }], nextBefore: null },
      '/api/v1/log?limit=2&kind=x': { items: [{ id: '5' }, { id: '4' }], nextBefore: '4' },
      '/api/v1/log?limit=2&kind=x&before=4': { items: [{ id: '3' }], nextBefore: null },
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) =>
        usePaged<Row, string>(path, cursorOf, (cursor) => `${path}&before=${cursor}`),
      { initialProps: { path: '/log?limit=2' } },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(async () => {
      result.current.more?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.more).toBeNull();
    });

    rerender({ path: '/log?limit=2&kind=x' });
    await waitFor(() => {
      expect(result.current.items.map((row) => row.id)).toEqual(['5', '4']);
    });
    expect(result.current.more).not.toBeNull();

    await act(async () => {
      result.current.more?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items.map((row) => row.id)).toEqual(['5', '4', '3']);
    });
    // Paged with the *new* query's cursor, not the old one's.
    expect(asked).toContain('/api/v1/log?limit=2&kind=x&before=4');
  });

  it('keeps the button after a failed load rather than hiding the retry', async () => {
    stubFetch({
      '/api/v1/log?limit=2': { items: [{ id: '9' }], nextBefore: '9' },
      // No entry for the next page: the stub answers 404.
    });
    const { result } = renderHook(() =>
      usePaged<Row, string>('/log?limit=2', cursorOf, (cursor) => `/log?limit=2&before=${cursor}`),
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      result.current.more?.();
      // Lets the fetch's microtasks drain inside `act`, so React has applied the state update by
      // the time the assertion below runs.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.loadingMore).toBe(false);
    });
    expect(result.current.more).not.toBeNull();
    expect(result.current.items).toHaveLength(1);
  });
});
