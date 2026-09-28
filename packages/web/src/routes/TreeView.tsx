import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { request, useApi, ApiError } from '../api/client';
import { useStateStream, type LiveState, type StreamStatus } from '../api/stream';
import type { ObjectPage, ObjectRef, ObjectSummary, SensorState } from '../api/types';
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
import { PageTitle } from '../components/PageTitle';
import { keepActive, treeCommand } from '../tree/keyboard';

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
 * **Search goes to the server and comes back flat, with the path written out** — the matches
 * side by side, rather than scattered across branches somebody would have to expand. The path
 * comes with the page: `include=path` walks every row's ancestors in one statement (`P-214`),
 * where a breadcrumb request per row would be two hundred of them. Before it did, two sensors
 * both called `Ping` read alike until one was opened.
 */
export function TreeView(): React.JSX.Element {
  const tops = useApi<{ items: ObjectSummary[] }>('/objects/tops');
  const loaded = tops.status === 'ready' ? tops.data : null;
  // Once per answer, not per render: the branches reset their tree when this changes.
  const start = useMemo(() => (loaded === null ? null : startOf(loaded.items)), [loaded]);
  const live = useStateStream(start?.streamId ?? null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');

  const searching = query.trim() !== '' || tag.trim() !== '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle title="Tree" />
        <StreamIndicator status={live.status} />
        {/*
          Wraps and shrinks. `w-56` + `w-32` + a gap is 376px, which does not fit the 320px
          WCAG 1.4.10 asks for reflow at — and `ml-auto` on a row that cannot wrap pushed the
          pair off the right edge rather than dropping them onto their own line.
        */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
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
            className="min-w-0 flex-1 border border-control sm:w-56 sm:flex-none bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
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
            className="w-24 min-w-0 border border-control sm:w-32 bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
          />
        </div>
      </div>

      {tops.status === 'error' && <ErrorPanel error={tops.error} retry={tops.reload} />}
      {tops.status === 'loading' && <Loading what="the tree" />}
      {start?.kind === 'nothing' && (
        <Empty because="An administrator grants access to parts of the tree.">
          Nothing in the tree has been shared with this account.
        </Empty>
      )}

      {start !== null &&
        start.kind !== 'nothing' &&
        (searching ? (
          <SearchResults query={query.trim()} tag={tag.trim()} live={live.states} />
        ) : (
          <Branches start={start} live={live.states} />
        ))}
    </div>
  );
}

/**
 * Where the tree starts (`A-12`).
 *
 * The root's children, for an account that can read the root — the tree as it always was. For
 * one granted a few branches, the tops of those branches: the containers above them are outside
 * what it was granted, so they are never shown, and the branches are the first level instead.
 * They sit under a key no object has, so the rest of the tree loads and expands exactly as it
 * does beneath the root. The stream follows: the root's subtree, or everything the account can
 * see, which for that account is the same thing.
 */
type TreeStart =
  | { readonly kind: 'root'; readonly parentId: number; readonly streamId: number }
  | {
      readonly kind: 'branches';
      readonly parentId: typeof ABOVE_THE_TOPS;
      readonly tops: readonly ObjectSummary[];
      readonly streamId: null;
    }
  | { readonly kind: 'nothing'; readonly streamId: null };

/** The parent key the tops are held under. Object ids start at 1. */
const ABOVE_THE_TOPS = 0;

function startOf(tops: readonly ObjectSummary[]): TreeStart {
  const [first] = tops;
  if (first === undefined) return { kind: 'nothing', streamId: null };
  if (tops.length === 1 && first.kind === 'root') {
    return { kind: 'root', parentId: first.id, streamId: first.id };
  }
  return { kind: 'branches', parentId: ABOVE_THE_TOPS, tops, streamId: null };
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
  start,
  live,
}: {
  start: Exclude<TreeStart, { kind: 'nothing' }>;
  live: ReadonlyMap<number, LiveState>;
}): React.JSX.Element {
  const rootId = start.parentId;
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

  const reset = useCallback(() => {
    if (start.kind === 'branches') {
      // Already in hand: `/objects/tops` is the first level, and there is no parent to ask.
      setTree({ ...EMPTY_TREE, children: new Map([[ABOVE_THE_TOPS, start.tops]]) });
      return;
    }
    setTree(EMPTY_TREE);
    load(start.parentId);
  }, [start, load]);

  useEffect(reset, [reset]);

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

  const navigate = useNavigate();
  const [active, setActive] = useState(0);

  // Follow the row rather than the index. Collapsing a branch takes rows away underneath the
  // active one, and an index left pointing past the end would leave the tree with no tab stop
  // at all — a roving one is the only way back in with a keyboard.
  const activeId = rows[active]?.object.id;
  useEffect(() => {
    setActive((held) => keepActive(rows, activeId, held));
    // Deliberately keyed on the rows alone: recomputing when `activeId` changes would fight the
    // arrow keys, which change it on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const command = treeCommand(event.key, rows, active);
      if (command.kind === 'none') return;
      // Only once something is actually going to happen: an unhandled key still belongs to the
      // browser, and swallowing Home/End on a tree that has not been entered would be a trap.
      event.preventDefault();

      switch (command.kind) {
        case 'move':
          setActive(command.index);
          break;
        case 'expand':
        case 'collapse':
          toggle(command.row.object);
          break;
        case 'activate':
          void navigate(`/objects/${String(command.row.object.id)}`);
          break;
      }
    },
    [rows, active, toggle, navigate],
  );

  if (failed !== null) {
    return (
      <ErrorPanel
        error={failed}
        retry={() => {
          setFailed(null);
          reset();
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
        activeIndex={active}
        onKeyDown={onKeyDown}
        onItemFocus={setActive}
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
        {rows.length.toLocaleString()} rows shown. Children load when a branch is opened. Arrow keys
        walk the tree; Enter opens the selected object.
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
          // Out of the tab order, with the row: a tree is one tab stop and the arrow keys walk
          // it. Left in the DOM as a button because it is still the mouse target, and because
          // `aria-label` on a `span` would be a control that announces itself and does nothing.
          tabIndex={-1}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-text-muted hover:text-text"
        >
          {row.loading ? '⋯' : row.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}

      <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-muted">
        {KIND_GLYPH[object.kind] ?? '·'}
      </span>

      <Link
        to={`/objects/${String(object.id)}`}
        tabIndex={-1}
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
        <span className="shrink-0 border border-paused-border bg-paused-bg px-1.5 py-0.5 text-xs text-paused-fg">
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
 * `q` matches names and device hosts as a substring (`P-212`; it matched names alone before,
 * whatever the placeholder said) and `tag` filters, both already on `GET /objects` — and both have
 * to run there rather than here, because the tree is loaded a level at a time and a client-side
 * filter would only ever search the branches somebody had already opened. `include=path` is what
 * lets a row say where its match is.
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
  const params = new URLSearchParams({ limit: '200', include: 'path' });
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
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  to={`/objects/${String(object.id)}`}
                  className="truncate text-sm font-medium text-text hover:text-accent hover:underline"
                >
                  {object.name}
                </Link>
                <span className="shrink-0 text-xs uppercase tracking-wide text-text-muted">
                  {object.kind}
                </span>
                {/* A device found by an address shows it, or the row does not say why it matched. */}
                {object.host !== undefined && (
                  <span className="truncate font-mono text-xs text-text-muted">{object.host}</span>
                )}
                {object.tags.length > 0 && (
                  <span className="truncate font-mono text-xs text-text-muted">
                    {object.tags.join(', ')}
                  </span>
                )}
              </div>
              {object.path !== undefined && <MatchPath path={object.path} />}
            </div>
            {object.kind === 'sensor' && (
              <span className="shrink-0">
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

/**
 * Where a search match is, as `Probe › Group › Device`.
 *
 * The root is left off: it begins every path, so it tells nobody anything. Wrapped rather than
 * truncated, because the end of a path — the device — is the part that tells two `Ping`s apart,
 * and an ellipsis would cut exactly that off first. Plain text rather than a link per step: two
 * hundred rows of four links each is a lot of `Tab` to get past, and the match's own page has
 * the linked breadcrumb.
 */
function MatchPath({ path }: { path: readonly ObjectRef[] }): React.JSX.Element | null {
  const shown = path.filter((ancestor) => ancestor.kind !== 'root');
  if (shown.length === 0) return null;
  return (
    <p className="break-words text-xs text-text-muted">
      <span className="sr-only">in </span>
      {shown.map((ancestor, index) => (
        <Fragment key={ancestor.id}>
          {/* A chevron is read aloud as punctuation, if at all; a comma is a pause. */}
          {index > 0 && (
            <>
              <span aria-hidden="true"> › </span>
              <span className="sr-only">, </span>
            </>
          )}
          {ancestor.name}
        </Fragment>
      ))}
    </p>
  );
}
