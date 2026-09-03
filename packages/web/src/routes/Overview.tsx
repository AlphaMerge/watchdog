import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { ObjectDetail, SensorState, SensorTypeSummary, SubtreeCounts } from '../api/types';
import { Card, Empty, ErrorPanel, Loading, Stat } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { PageTitle } from '../components/PageTitle';

interface OpenApi {
  info: { version: string };
}

const KINDS = ['probe', 'group', 'device', 'sensor'] as const;

/**
 * Worst first. An operator opening this page is looking for what is broken, and a list that
 * leads with the healthy majority makes them read past it every time.
 */
const STATE_ORDER = [
  'down',
  'down_partial',
  'down_acknowledged',
  'warning',
  'unusual',
  'unknown',
  'paused',
  'up',
] as const satisfies readonly SensorState[];

export function Overview(): React.JSX.Element {
  const root = useApi<ObjectDetail>('/objects/root');
  const rootId = root.status === 'ready' ? root.data.id : null;

  /**
   * Totals, not rows.
   *
   * This page used to read a page of the tree — `?maxDepth=12&limit=1000` — and count what came
   * back, which made every number on it a lower bound the moment an installation outgrew the
   * limit: 930 sensors reported for a system running 5,051, with the only hint a truncation
   * note in a card further down. `/counts` aggregates in the database, so the numbers are exact
   * at any size and the page costs one small response rather than a megabyte of summaries it
   * throws away.
   */
  const counts = useApi<SubtreeCounts>(
    rootId === null ? null : `/objects/${String(rootId)}/counts`,
  );
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');
  const api = useApi<OpenApi>('/openapi.json');

  if (root.status === 'error') {
    return (
      <div className="space-y-4">
        <PageTitle title="Overview" />
        <ErrorPanel error={root.error} retry={root.reload} />
      </div>
    );
  }

  const objects = counts.status === 'ready' ? counts.data.objects : null;
  const states = counts.status === 'ready' ? counts.data.sensorStates : null;
  const sensorCount = objects?.sensor ?? 0;
  const typeCount = types.status === 'ready' ? types.data.items.length : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <PageTitle title="Overview" />
        {api.status === 'ready' && (
          <p className="font-mono text-xs text-text-muted">core {api.data.info.version}</p>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Core"
          value="Reachable"
          hint={`root object #${String(root.status === 'ready' ? root.data.id : 0)}`}
        />
        {KINDS.map((kind) => (
          <Stat
            key={kind}
            value={objects === null ? '—' : objects[kind].toLocaleString()}
            label={`${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}s`}
          />
        ))}
        <Stat
          label="Sensor types"
          value={types.status === 'ready' ? typeCount : '—'}
          hint={typeCount === 0 ? 'none registered — P-08 adds the first' : 'registered'}
        />
      </div>

      <Card title="Sensor health">
        {counts.status === 'loading' && <Loading what="the totals" />}
        {counts.status === 'error' && <ErrorPanel error={counts.error} retry={counts.reload} />}
        {states !== null &&
          (sensorCount === 0 ? (
            <Empty because="Add a device and a sensor, or see the Tree.">
              No sensors exist yet.
            </Empty>
          ) : (
            <div className="space-y-3">
              <ul className="flex flex-wrap gap-x-6 gap-y-2">
                {STATE_ORDER.filter((state) => states[state] > 0).map((state) => (
                  <li key={state} className="flex items-center gap-2">
                    <StatusBadge state={state} size="sm" />
                    <span className="text-sm tabular-nums text-text">
                      {states[state].toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-text-muted">
                {sensorCount.toLocaleString()} sensor{sensorCount === 1 ? '' : 's'}, from{' '}
                <code className="font-mono">sensor_state</code>. A sensor reads{' '}
                <strong className="font-medium text-text">Unknown</strong> until its first result —
                and again after a resume, because a state measured before a pause is not something
                the system has checked since.
              </p>
            </div>
          ))}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Registered sensor types"
          actions={
            <Link to="/sensor-types" className="text-sm text-accent hover:underline">
              All types
            </Link>
          }
        >
          {types.status === 'loading' && <Loading what="sensor types" />}
          {types.status === 'error' && <ErrorPanel error={types.error} retry={types.reload} />}
          {types.status === 'ready' &&
            (typeCount === 0 ? (
              <Empty because="P-05 shipped the contract and the registry; P-08 through P-11 are the first four types.">
                The catalogue is empty, so no sensor can be created.
              </Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {types.data.items.slice(0, 8).map((type) => (
                  <li key={type.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-mono text-text">{type.id}</span>
                    <span className="text-text-muted">{type.category}</span>
                  </li>
                ))}
              </ul>
            ))}
        </Card>

        <Card
          title="Tree"
          actions={
            <Link to="/tree" className="text-sm text-accent hover:underline">
              Open
            </Link>
          }
        >
          {objects !== null && (
            <p className="text-sm text-text-muted">
              {objects.total.toLocaleString()} object{objects.total === 1 ? '' : 's'} in the tree,
              at any depth. The tree itself loads a level at a time, so how big this number is does
              not change how fast it opens.
            </p>
          )}
          {counts.status === 'loading' && <Loading what="the totals" />}
        </Card>
      </div>
    </div>
  );
}
