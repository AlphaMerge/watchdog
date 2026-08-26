import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { request, useApi, ApiError } from '../api/client';
import { useStateStream, type LiveState, type StreamStatus } from '../api/stream';
import type { ObjectDetail, ObjectPage, ObjectSummary, SensorState } from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { VirtualList } from '../components/VirtualList';
import {
  EMPTY_TREE,
  flatten,
  rollup,
  stateFor,
  type TreeRowModel,
  type TreeState,
} from '../tree/model';

const KIND_GLYPH: Record<string, string> = {
  root: '⌂',
  probe: '◈',
  group: '▤',
  device: '▥',
  sensor: '◉',
};

const ROW_HEIGHT = 36;
const VIEWPORT_HEIGHT = 560;
/** One level at a time, and the server's own ceiling for a page of children. */
const PAGE = 500;

/**
 * The object tree (`U-03`).
 *
 * **Three separate concerns, deliberately kept apart.** The *shape* is loaded a level at a time
 * and cached; the *states* arrive over `U-02`'s stream and are never fetched here; and the
 * *rollup* is computed from the stream alone. That is why a collapsed group can show the colour
 * of an outage inside it without its children ever having been loaded — the stream's snapshot
 * carries every sensor beneath the root with its absolute path, and a rollup is one pass over
 * that.
 *
 * **Search goes to the server and comes back flat.** A filtered *tree* needs every match's
 * ancestors, which is a second round trip per match; a flat result list with the path written
 * out is what somebody searching actually wants, and it is one request.
 */
export function TreeView(): React.JSX.Element {
  const root = useApi<ObjectDetail>('/objects/root');
  const rootId = root.status === 'ready' ? root.data.id : null;
  const live = useStateStream(rootId);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');

  const searching = query.trim() !== '' || tag.trim() !== '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Tree</h1>
        <StreamIndicator status={live.status} />
        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="tree-search">
            Search objects
          </label>
          <input
            id="tree-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Search names and hosts"
            className="w-56 rounded border border-border bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
          />
          <label className="sr-only" htmlFor="tree-tag">
            Filter by tag
          </label>
          <input
            id="tree-tag"
            type="search"
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
            }}
            placeholder="tag"
            className="w-32 rounded border border-border bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
          />
        </div>
      </div>

      {root.status === 'error' && <ErrorPanel error={root.error} retry={root.reload} />}
      {root.status === 'loading' && <Loading what="the tree" />}

      {rootId !== null &&
        (searching ? (
          <SearchResults query={query.trim()} tag={tag.trim()} live={live.states} />
        ) : (
          <Branches rootId={rootId} live={live.states} />
        ))}
    </div>
  );
}

/**
 * Whether what the rows show is current.
 *
 * Shown rather than hidden, because a tree that has quietly stopped updating looks exactly like
 * a tree where nothing is happening — the failure this whole system exists to prevent. Offline
 * keeps the last states on screen and says they may be stale.
 */
function StreamIndicator({ status }: { status: StreamStatus }): React.JSX.Element {
  const label =
    status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline — reconnecting';
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-text-muted"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">
        {status === 'live' ? '●' : status === 'connecting' ? '◐' : '○'}
      </span>
      {label}
    </span>
  );
}

function Branches({
  rootId,
  live,
}: {
  rootId: number;
  live: ReadonlyMap<number, LiveState>;
}): React.JSX.Element {
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [failed, setFailed] = useState<ApiError | null>(null);

  const load = useCallback((parentId: number) => {
    setTree((held) => {
      if (held.children.has(parentId) || held.loading.has(parentId)) return held;
      return { ...held, loading: new Set(held.loading).add(parentId) };
    });
    request<ObjectPage>(`/objects?parentId=${String(parentId)}&sort=manual&limit=${String(PAGE)}`)
      .then((page) => {
        setTree((held) => {
          const children = new Map(held.children);
          children.set(parentId, page.items);
          const loading = new Set(held.loading);
          loading.delete(parentId);
          return { ...held, children, loading };
        });
      })
      .catch((error: unknown) => {
        setTree((held) => {
          const loading = new Set(held.loading);
          loading.delete(parentId);
          return { ...held, loading };
        });
        setFailed(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error)),
        );
      });
  }, []);

  useEffect(() => {
    setTree(EMPTY_TREE);
    load(rootId);
  }, [rootId, load]);

  const toggle = useCallback(
    (object: ObjectSummary) => {
      setTree((held) => {
        const expanded = new Set(held.expanded);
        if (expanded.has(object.id)) expanded.delete(object.id);
        else expanded.add(object.id);
        return { ...held, expanded };
      });
      if (!tree.children.has(object.id)) load(object.id);
    },
    [load, tree.children],
  );

  // One pass over the live states, and only when they change. A burst of events replaces the
  // map, so this recomputes per burst rather than per event.
  const worst = useMemo(() => rollup(live.values()), [live]);
  const rows = useMemo(() => flatten(tree, rootId), [tree, rootId]);

  if (failed !== null) {
    return (
      <ErrorPanel
        error={failed}
        retry={() => {
          setFailed(null);
          setTree(EMPTY_TREE);
          load(rootId);
        }}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        {tree.children.has(rootId) ? (
          <Empty>The tree is empty.</Empty>
        ) : (
          <Loading what="the tree" />
        )}
      </Card>
    );
  }

  return (
    <Card>
      <VirtualList
        items={rows}
        rowHeight={ROW_HEIGHT}
        height={VIEWPORT_HEIGHT}
        keyOf={(row) => row.object.id}
        label="Object tree"
        role="tree"
        itemRole="treeitem"
        // Depth and expansion belong on the `treeitem`, and they are the two things a flattened
        // tree loses: every row is a sibling in the DOM, so without `aria-level` a screen reader
        // reads a tree of groups and devices as one flat list of names.
        itemProps={(row) => ({
          'aria-level': row.depth + 1,
          ...(row.expandable ? { 'aria-expanded': row.expanded } : {}),
        })}
        render={(row) => (
          <TreeRow
            row={row}
            live={live}
            state={stateFor(row.object, live, worst)}
            onToggle={toggle}
          />
        )}
      />
      <p className="mt-3 text-xs text-text-muted">
        {rows.length.toLocaleString()} rows shown. Children load when a branch is opened.
      </p>
    </Card>
  );
}

function TreeRow({
  row,
  live,
  state,
  onToggle,
}: {
  row: TreeRowModel;
  live: ReadonlyMap<number, LiveState>;
  state: SensorState | undefined;
  onToggle: (object: ObjectSummary) => void;
}): React.JSX.Element {
  const { object } = row;
  const message = live.get(object.id)?.message;
  return (
    <div
      className="flex h-full items-center gap-3 border-b border-border px-1"
      style={{ paddingLeft: `${String(row.depth * 20 + 4)}px` }}
    >
      {row.expandable ? (
        <button
          type="button"
          onClick={() => {
            onToggle(object);
          }}
          // No `aria-expanded` here: it is on the row's `treeitem`, and a control claiming to be
          // the expandable thing inside a row that already says so is announced twice.
          aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${object.name}`}
          className="w-5 shrink-0 rounded text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {row.loading ? '⋯' : row.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="w-5 shrink-0" aria-hidden="true" />
      )}

      <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-muted">
        {KIND_GLYPH[object.kind] ?? '·'}
      </span>

      <Link
        to={`/objects/${String(object.id)}`}
        className="truncate text-sm font-medium text-text hover:text-accent hover:underline"
      >
        {object.name}
      </Link>

      {object.host !== undefined && object.host !== '' && (
        <span className="truncate font-mono text-xs text-text-muted">{object.host}</span>
      )}

      {message !== undefined && message !== '' && object.kind === 'sensor' && (
        <span className="hidden truncate text-xs text-text-muted lg:inline">{message}</span>
      )}

      {object.paused === true && object.kind !== 'sensor' && (
        <span className="shrink-0 rounded border border-paused-border bg-paused-bg px-1.5 py-0.5 text-xs text-paused-fg">
          paused
        </span>
      )}

      {state !== undefined && (
        <span className="ml-auto shrink-0">
          {/* A container's badge is the worst thing beneath it, which is why it is labelled. */}
          <StatusBadge
            state={state}
            size="sm"
            {...(object.kind === 'sensor'
              ? {}
              : { describedAs: `worst state below ${object.name}: ${state}` })}
          />
        </span>
      )}
    </div>
  );
}

/**
 * Search, answered by the server.
 *
 * `q` matches names and hosts and `tag` filters, both already on `GET /objects` — and both have
 * to run there rather than here, because the tree is loaded a level at a time and a client-side
 * filter would only ever search the branches somebody had already opened.
 */
function SearchResults({
  query,
  tag,
  live,
}: {
  query: string;
  tag: string;
  live: ReadonlyMap<number, LiveState>;
}): React.JSX.Element {
  const params = new URLSearchParams({ limit: '200' });
  if (query !== '') params.set('q', query);
  if (tag !== '') params.set('tag', tag);
  const found = useApi<ObjectPage>(`/objects?${params.toString()}`);

  if (found.status === 'loading') return <Loading what="matching objects" />;
  if (found.status === 'error') return <ErrorPanel error={found.error} retry={found.reload} />;
  if (found.data.items.length === 0) {
    return (
      <Card>
        <Empty>Nothing matches.</Empty>
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-border">
        {found.data.items.map((object) => (
          <li key={object.id} className="flex items-center gap-3 py-2">
            <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-muted">
              {KIND_GLYPH[object.kind] ?? '·'}
            </span>
            <Link
              to={`/objects/${String(object.id)}`}
              className="truncate text-sm font-medium text-text hover:text-accent hover:underline"
            >
              {object.name}
            </Link>
            <span className="shrink-0 text-xs uppercase tracking-wide text-text-muted">
              {object.kind}
            </span>
            {object.tags.length > 0 && (
              <span className="truncate font-mono text-xs text-text-muted">
                {object.tags.join(', ')}
              </span>
            )}
            {object.kind === 'sensor' && (
              <span className="ml-auto shrink-0">
                <StatusBadge
                  state={live.get(object.id)?.state ?? object.state ?? 'unknown'}
                  size="sm"
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {found.data.nextCursor !== null && (
        <p className="mt-3 text-xs text-text-muted">
          Showing the first 200 matches. Narrow the search to see fewer.
        </p>
      )}
    </Card>
  );
}
