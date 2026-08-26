import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import { useStateStream, type LiveState, type StreamStatus } from '../api/stream';
import type { ObjectDetail, ObjectSummary, TreePage } from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';

const KIND_GLYPH: Record<string, string> = {
  root: '⌂',
  probe: '◈',
  group: '▤',
  device: '▥',
  sensor: '◉',
};

/**
 * The object tree, in the operator's own arrangement.
 *
 * Flat-with-indent rather than a collapsible widget: the API already returns the subtree in
 * order with a `depth` on every row, and `U-03` is where this becomes virtualised and
 * searchable.
 *
 * **Live, and never polled** (`U-02`). The shape of the tree is read once; the *states* arrive
 * over a WebSocket. Polling a five-thousand-sensor tree is a full re-read per client per second,
 * and polling it less often is the same thing arriving late.
 */
export function TreeView(): React.JSX.Element {
  const root = useApi<ObjectDetail>('/objects/root');
  const rootId = root.status === 'ready' ? root.data.id : null;
  const tree = useApi<TreePage>(
    rootId === null ? null : `/objects/${String(rootId)}/tree?maxDepth=12&limit=1000`,
  );
  const live = useStateStream(rootId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Tree</h1>
        <StreamIndicator status={live.status} />
      </div>

      {root.status === 'error' && <ErrorPanel error={root.error} retry={root.reload} />}
      {(root.status === 'loading' || tree.status === 'loading') && <Loading what="the tree" />}
      {tree.status === 'error' && <ErrorPanel error={tree.error} retry={tree.reload} />}

      {tree.status === 'ready' && (
        <Card>
          {tree.data.items.length === 0 ? (
            <Empty>The tree is empty.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {tree.data.items.map((item) => (
                <TreeRow key={item.id} item={item} live={live.states.get(item.id)} />
              ))}
            </ul>
          )}
          {tree.data.truncated && (
            <p className="mt-3 text-sm text-warning-fg">
              Truncated at 1,000 objects. Virtualised paging is{' '}
              <code className="font-mono">U-03</code>.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * Whether what the rows show is current.
 *
 * Shown rather than hidden, because a tree that has quietly stopped updating looks exactly like
 * a tree where nothing is happening — which is the failure this whole subsystem exists to
 * prevent. Offline keeps the last states on screen and says they may be stale.
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
      <span aria-hidden="true">{status === 'live' ? '●' : status === 'connecting' ? '◐' : '○'}</span>
      {label}
    </span>
  );
}

function TreeRow({
  item,
  live,
}: {
  item: ObjectSummary;
  live: LiveState | undefined;
}): React.JSX.Element {
  const depth = item.depth ?? 0;
  return (
    <li className="flex items-center gap-3 py-2" style={{ paddingLeft: `${String(depth * 20)}px` }}>
      <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-muted">
        {KIND_GLYPH[item.kind] ?? '·'}
      </span>

      <Link
        to={`/objects/${String(item.id)}`}
        className="truncate text-sm font-medium text-text hover:text-accent hover:underline"
      >
        {item.name}
      </Link>

      <span className="shrink-0 text-xs uppercase tracking-wide text-text-muted">{item.kind}</span>

      {item.host !== undefined && item.host !== '' && (
        <span className="truncate font-mono text-xs text-text-muted">{item.host}</span>
      )}

      {item.sensorType !== undefined && (
        <span className="truncate font-mono text-xs text-text-muted">{item.sensorType}</span>
      )}

      {item.paused === true && item.kind !== 'sensor' && (
        <span className="rounded border border-paused-border bg-paused-bg px-1.5 py-0.5 text-xs text-paused-fg">
          paused
        </span>
      )}

      {item.kind === 'sensor' && (
        // The stream's state when it has one, and the page load's otherwise: a sensor that has
        // not changed since the tree was read has nothing on the stream, and its loaded state is
        // still the truth.
        <span className="ml-auto shrink-0">
          <StatusBadge state={live?.state ?? item.state ?? 'unknown'} size="sm" />
        </span>
      )}
    </li>
  );
}
