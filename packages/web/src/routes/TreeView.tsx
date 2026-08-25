import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
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
 * order with a `depth` on every row, and `U-03` is where this becomes virtualised, searchable
 * and live. Building the interactive version now, against a shape `U-02` will change, would be
 * building it twice.
 */
export function TreeView(): React.JSX.Element {
  const root = useApi<ObjectDetail>('/objects/root');
  const rootId = root.status === 'ready' ? root.data.id : null;
  const tree = useApi<TreePage>(
    rootId === null ? null : `/objects/${String(rootId)}/tree?maxDepth=12&limit=1000`,
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-text">Tree</h1>

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
                <TreeRow key={item.id} item={item} />
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

function TreeRow({ item }: { item: ObjectSummary }): React.JSX.Element {
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

      {item.kind === 'sensor' && (
        <span className="ml-auto shrink-0">
          <StatusBadge state={item.state ?? 'unknown'} size="sm" />
        </span>
      )}
    </li>
  );
}
