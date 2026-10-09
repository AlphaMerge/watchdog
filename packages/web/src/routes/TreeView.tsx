import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  NavigationType,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router-dom';
import { request, useApi, ApiError, type Loadable } from '../api/client';
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
import {
  INVALID_PARAMS,
  knownSentence,
  notChecked,
  notCheckedSentence,
} from '../tree/invalid-params';
import { filtersKey, filtersOf, withFilters, type TreeFilters } from '../tree/filters';

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
 *
 * **Every filter is held in the URL**, `?q=`, `?tag=` and `?invalidParams=true` as on
 * `GET /objects`: invalid parameters since `U-63`, so Core Health's count of those sensors links
 * to their list, and the search and the tag since `U-70`, so a filtered tree is a link somebody
 * can send and reload and *Back* bring it back. Until the core's start-up check has read every
 * sensor there is no list of invalid parameters, and the page says why in words, in a polite
 * status region that is on the page from the start.
 */
export function TreeView(): React.JSX.Element {
  const tops = useApi<{ items: ObjectSummary[] }>('/objects/tops');
  const loaded = tops.status === 'ready' ? tops.data : null;
  // Once per answer, not per render: the branches reset their tree when this changes.
  const start = useMemo(() => (loaded === null ? null : startOf(loaded.items)), [loaded]);
  const live = useStateStream(start?.streamId ?? null);

  // **The boxes show what was typed; the address follows them, and leads only when it is moved.**
  // Typed into, a box changes its own state and the address is rewritten with `replace` on every
  // change, as the alarm filters are: one history entry for the tree however much is typed, and
  // the address always says what the boxes say, so following a result and coming *Back* finds
  // them as they were. The boxes are not read from the address: the router commits a navigation
  // in a transition, so a box whose value came from it would lag the keys and lose the caret.
  // So the address is read in once when the page opens, and again only when it is changed by
  // something other than this page's own `replace` — a link (`PUSH`) or *Back* and *Forward*
  // (`POP`) while the tree is open. Set during render, so the old filters are never committed.
  const [params, setParams] = useSearchParams();
  const navigation = useNavigationType();
  const inAddress = filtersOf(params);
  const [filters, setFilters] = useState<TreeFilters>(inAddress);
  const [read, setRead] = useState(() => filtersKey(inAddress));
  if (read !== filtersKey(inAddress)) {
    setRead(filtersKey(inAddress));
    if (navigation !== NavigationType.Replace) setFilters(inAddress);
  }
  const change = (next: Partial<TreeFilters>): void => {
    const changed = { ...filters, ...next };
    setFilters(changed);
    setParams(withFilters(params, changed), { replace: true });
  };
  const { query, tag, invalidParams } = filters;

  const narrowed = query.trim() !== '' || tag.trim() !== '';
  const searching = narrowed || invalidParams;
  const listed = start !== null && start.kind !== 'nothing';

  // Asked for here rather than by the results, so the status region above them can say what the
  // answer was: the region is on the page before the answer, and the answer lands in it.
  const searchPath =
    searching && listed ? searchPathOf(query.trim(), tag.trim(), invalidParams) : null;
  const asked = useApi<ObjectPage>(searchPath);
  const answer =
    asked.status === 'ready' ? asked.data : asked.status === 'error' ? asked.error : null;
  // **An answer in hand when this request was asked for is not its answer**, for even a render.
  // `useApi` learns of a new path or a reload only in its effect, after the render that asked, so
  // until then it still holds the last answer. `answered` alone does not tell them apart: a path
  // set to null keeps it, and the same path asked for again (untick, tick) or reloaded (*Try
  // again*) matches it. So the answer held at the moment of asking is set aside, by identity:
  // every read parses a new one. Set during render, not in an effect, so the stale answer is
  // never committed. This covers a search changed to another one too, so `answered` is not
  // compared as well: what is not set aside is an answer read after this path was asked for.
  const [askedFor, setAskedFor] = useState<AskedFor>({
    path: searchPath,
    stale: null,
    retrying: false,
  });
  if (askedFor.path !== searchPath) {
    setAskedFor({ path: searchPath, stale: answer, retrying: false });
  }
  const found: Loadable<ObjectPage> =
    asked.status !== 'loading' && answer !== askedFor.stale ? asked : { status: 'loading' };
  const said = invalidParams ? filterStatus(found, narrowed) : '';

  // *Try again* stays on the page, unavailable, while it re-reads, so focus stays on it. If the
  // answer takes it away (the list, or a check that stopped), focus goes to the filter's own box,
  // which is always there, rather than falling to the page.
  const retrying = askedFor.retrying && found.status === 'loading';
  const retry = (): void => {
    setAskedFor({ path: searchPath, stale: answer, retrying: true });
    asked.reload();
  };
  const filterBox = useRef<HTMLInputElement>(null);
  const wasRetrying = useRef(false);
  const stillChecking = found.status === 'error' && notChecked(found.error) === 'checking';
  useEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (wasRetrying.current && !retrying && !stillChecking && lost) filterBox.current?.focus();
    wasRetrying.current = retrying;
  }, [retrying, stillChecking]);

  return (
    <div className="space-y-4">
      {/*
        One block, so the status region is not a child of the `space-y-4` stack: an empty last
        child there would still leave the stack's margin under it (`U-54`).
      */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <PageTitle title="Tree" />
          <StreamIndicator status={live.status} />
          {/*
            Wraps and shrinks. `w-56` + `w-32` + a gap is 376px, which does not fit the 320px
            WCAG 1.4.10 asks for reflow at — and `ml-auto` on a row that cannot wrap pushed the
            pair off the right edge rather than dropping them onto their own line.

            Below `sm` the invalid-parameters box has a line of its own (`basis-full`), and the
            search takes what the tag leaves: the page is the viewport less 32px of gutter, so
            the search is 184px at 320, 239px at 375 and 278px at 414. Left to wrap on its own,
            the ~212px label stayed beside them from about 356px to 460px and crushed the search
            to 19–58px. From `sm` up the row is 224 + 128 + ~212 + two 8px gaps, about 580px,
            within the 608px of a 640px viewport, and it drops below the title when it must.
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
                change({ query: event.target.value });
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
                change({ tag: event.target.value });
              }}
              placeholder="tag"
              className="w-24 min-w-0 border border-control sm:w-32 bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
            />
            <label className="flex basis-full items-center gap-1.5 text-sm text-text sm:basis-auto">
              <input
                ref={filterBox}
                type="checkbox"
                checked={invalidParams}
                onChange={(event) => {
                  change({ invalidParams: event.target.checked });
                }}
              />
              Invalid parameters only
            </label>
          </div>
        </div>
        {/*
        Polite, and said whole: it answers a filter, it refuses nothing the operator did, so it
        waits for the screen reader rather than cutting in (`U-48`). In the tree from the start
        and empty until the filter has an answer to give (`U-54`), with its margin taken away
        while it says nothing (`U-45`).
      */}
        <p
          id="tree-filter-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mt-3 text-sm text-text empty:mt-0"
        >
          {said}
        </p>
      </div>

      {tops.status === 'error' && <ErrorPanel error={tops.error} retry={tops.retry} />}
      {tops.status === 'loading' && <Loading what="the tree" />}
      {start?.kind === 'nothing' && (
        <Empty because="An administrator grants access to parts of the tree.">
          Nothing in the tree has been shared with this account.
        </Empty>
      )}

      {start !== null &&
        start.kind !== 'nothing' &&
        (searching ? (
          <SearchResults
            found={found}
            reload={asked.retry}
            retry={retry}
            retrying={retrying}
            invalidParams={invalidParams}
            live={live.states}
          />
        ) : (
          <Branches start={start} live={live.states} />
        ))}
    </div>
  );
}

/**
 * The search being asked for, what was in hand when it was asked (not its answer), and whether
 * *Try again* asked.
 */
interface AskedFor {
  readonly path: string | null;
  readonly stale: unknown;
  readonly retrying: boolean;
}

/** The listing a search asks for: each filter that is on, and every row's path. */
function searchPathOf(query: string, tag: string, invalidParams: boolean): string {
  const params = new URLSearchParams({ limit: '200', include: 'path' });
  if (query !== '') params.set('q', query);
  if (tag !== '') params.set('tag', tag);
  if (invalidParams) params.set(INVALID_PARAMS, 'true');
  return `/objects?${params.toString()}`;
}

/**
 * What the status region says while the invalid-parameters filter is on: how many the list holds,
 * that none fail, or why there is no list yet. Nothing while it is being read, and nothing for a
 * read that failed for another reason, which the error panel below says.
 */
function filterStatus(found: Loadable<ObjectPage>, narrowed: boolean): string {
  if (found.status === 'ready') {
    return knownSentence(found.data.items.length, found.data.nextCursor !== null, narrowed);
  }
  if (found.status === 'error') {
    const pass = notChecked(found.error);
    return pass === null ? '' : notCheckedSentence(pass);
  }
  return '';
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

  const load = useCallback(
    (parentId: number) => {
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
          // The first level read again by *Try again*: the failure it was showing is over.
          if (parentId === rootId) setFailed(null);
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
    },
    [rootId],
  );

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
          // Read again from the first level with the panel kept, so the button keeps focus and a
          // second failure is said again; the first level answering ends it (`U-68`). Tops in
          // hand are not read again, so there the panel goes at once.
          if (start.kind === 'branches') setFailed(null);
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
 *
 * **With the invalid-parameters filter, a list not known yet is not an error** (`U-63`). The
 * status region above says why in words, and for a check still running this offers to ask again.
 * An empty list is said there too, so it is not said twice.
 */
function SearchResults({
  found,
  reload,
  retry,
  retrying,
  invalidParams,
  live,
}: {
  found: Loadable<ObjectPage>;
  /** Reads again with the failure kept, for a failure the error panel says (`U-68`). */
  reload: () => void;
  /** Reads again for *Try again*, which stays on the page while it does. */
  retry: () => void;
  retrying: boolean;
  invalidParams: boolean;
  live: ReadonlyMap<number, LiveState>;
}): React.JSX.Element | null {
  if (found.status === 'loading') {
    return retrying ? <RetryCheck busy onRetry={retry} /> : <Loading what="matching objects" />;
  }
  if (found.status === 'error') {
    const pass = invalidParams ? notChecked(found.error) : null;
    if (pass === 'stopped') return null;
    if (pass === 'checking') return <RetryCheck busy={false} onRetry={retry} />;
    return <ErrorPanel error={found.error} retry={reload} />;
  }
  if (found.data.items.length === 0) {
    if (invalidParams) return null;
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
      {invalidParams && (
        <p className="mt-3 text-xs text-text-muted">
          Each of these sensors still runs with the parameters it has. An edit of one is refused
          until they are mended, and the refusal names what to change. Core Health counts every
          sensor in the installation, so its number can be higher than this list is long.
        </p>
      )}
    </Card>
  );
}

/**
 * *Try again*, for a start-up check still running.
 *
 * The same element while it re-reads and after, in the same place in `SearchResults` either way,
 * so focus stays on it. Unavailable by `aria-disabled` rather than `disabled` while it re-reads: a
 * disabled control loses focus, which is what this is here to keep.
 */
function RetryCheck({ busy, onRetry }: { busy: boolean; onRetry: () => void }): React.JSX.Element {
  return (
    <div>
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onRetry();
        }}
        className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text aria-disabled:opacity-50"
      >
        Try again
      </button>
    </div>
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
