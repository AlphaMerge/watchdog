import { useCallback, useMemo, useState } from 'react';
import { request, useApi, type ApiError } from '../api/client';

/**
 * How the log pages walk a cursored list, and how the audit filters become a query.
 *
 * Separate from the views because both are decisions that can be wrong without anything
 * failing — an append-only list that quietly re-appends its last page, and a half-applied actor
 * filter that attributes one person's changes to another. `test/logs-paging.test.tsx` and
 * `test/audit-actor.test.tsx` assert them without rendering a log. A module that exports both a
 * component and a function cannot Fast Refresh either.
 */

/** Rows per request. The audit query's default, and the page size every log asks for. */
export const PAGE = 100;

/**
 * Pages a keyset-cursored list, accumulating what has been loaded.
 *
 * The first page comes from `useApi` so a filter change refetches and resets; later pages are
 * appended by hand. Deliberately append-only: this is a log, and a "load more" that silently
 * replaced what was above it would lose the reader's place.
 */
export function usePaged<T, C>(
  path: string,
  cursorOf: (page: { items: T[] }) => C | null,
  nextPath: (cursor: C) => string,
): {
  items: T[];
  status: 'loading' | 'ready' | 'error';
  error: ApiError | null;
  reload: () => void;
  more: (() => void) | null;
  loadingMore: boolean;
} {
  const first = useApi<{ items: T[] }>(path);
  /**
   * `paged` separates "no cursor yet" from "the cursor ran out", which are the same value and
   * opposite meanings.
   *
   * Without it, the last page — the one that comes back short and carries a null cursor — fell
   * through to the *first* page's cursor, which is never null. So the button never went away and
   * every further press re-fetched and re-appended the final page: measured live on a sensor with
   * 77 changes, one press past the end took the list to 104, showing 27 entries twice. In a log,
   * a repeated entry is a second event that did not happen.
   */
  const [extra, setExtra] = useState<{
    path: string;
    items: T[];
    cursor: C | null;
    paged: boolean;
  }>({
    path,
    items: [],
    cursor: null,
    paged: false,
  });
  const [loadingMore, setLoadingMore] = useState(false);

  const cursor =
    extra.path === path && extra.paged
      ? extra.cursor
      : first.status === 'ready'
        ? cursorOf(first.data)
        : null;

  const items = useMemo(() => {
    if (first.status !== 'ready') return [];
    // A filter changed: everything appended against the old query answers a different question,
    // so it is dropped rather than shown under the new heading.
    const appended = extra.path === path ? extra.items : [];
    return [...first.data.items, ...appended];
  }, [first, extra, path]);

  const more = useCallback(() => {
    if (cursor === null) return;
    setLoadingMore(true);
    request<{ items: T[] }>(nextPath(cursor))
      .then((page) => {
        setExtra((held) => ({
          path,
          items: [...(held.path === path ? held.items : []), ...page.items],
          cursor: cursorOf(page),
          paged: true,
        }));
      })
      .catch(() => {
        // The button stays; a failed "load more" is a retry, not a state to model.
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor, nextPath, path, cursorOf]);

  return {
    items,
    status: first.status,
    error: first.status === 'error' ? first.error : null,
    reload: first.reload,
    more: cursor === null ? null : more,
    loadingMore,
  };
}

/**
 * The URL's filters, turned into the audit query (`A-08`).
 *
 * A pure function of the search string, exported so the rules below can be asserted without
 * rendering anything — the interesting one is not obvious from the call site.
 *
 * **Both actor parameters, or neither.** `actor_ref` is unique only within a kind: user 4 and
 * token 4 are different actors, so a ref sent without its kind would answer with both, attributing
 * one person's changes to another. Half a filter is worse than none here, so half is dropped.
 */
export function auditQueryFor(params: URLSearchParams, pageSize = PAGE): URLSearchParams {
  const search = new URLSearchParams({ limit: String(pageSize) });
  const objectId = params.get('objectId');
  if (objectId !== null) search.set('objectId', objectId);

  const ref = params.get('actorRef');
  const kind = params.get('actorKind');
  if (ref !== null && ref !== '' && kind !== null && kind !== '') {
    search.set('actorRef', ref);
    search.set('actorKind', kind);
  }

  for (const category of params.getAll('category')) search.append('category', category);
  return search;
}
