import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { ObjectDetail, SensorTypeSummary, TreePage } from '../api/types';
import { Card, Empty, ErrorPanel, Loading, Stat } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';

interface OpenApi {
  info: { version: string };
}

const KINDS = ['probe', 'group', 'device', 'sensor'] as const;

export function Overview(): React.JSX.Element {
  const root = useApi<ObjectDetail>('/objects/root');
  const rootId = root.status === 'ready' ? root.data.id : null;

  const tree = useApi<TreePage>(
    rootId === null ? null : `/objects/${String(rootId)}/tree?maxDepth=12&limit=1000`,
  );
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');
  const api = useApi<OpenApi>('/openapi.json');

  if (root.status === 'error') {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-text">Overview</h1>
        <ErrorPanel error={root.error} retry={root.reload} />
      </div>
    );
  }

  const counts = new Map<string, number>();
  if (tree.status === 'ready') {
    for (const item of tree.data.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const sensorCount = counts.get('sensor') ?? 0;
  const typeCount = types.status === 'ready' ? types.data.items.length : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-text">Overview</h1>
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
            value={tree.status === 'ready' ? (counts.get(kind) ?? 0) : '—'}
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
        {tree.status === 'loading' && <Loading what="the tree" />}
        {tree.status === 'error' && <ErrorPanel error={tree.error} retry={tree.reload} />}
        {tree.status === 'ready' &&
          (sensorCount === 0 ? (
            <Empty because="Add a device and a sensor, or see the Tree.">
              No sensors exist yet.
            </Empty>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <StatusBadge state="unknown" />
                <span className="text-sm text-text">
                  {sensorCount} sensor{sensorCount === 1 ? '' : 's'}
                </span>
              </div>
              {/*
                Being straight about it rather than drawing a green dial. Every sensor reads
                Unknown because nothing writes `sensor_state` yet: the state machine is Phase 3,
                and there is no sensor type to run in the first place until P-08.
              */}
              <p className="text-sm text-text-muted">
                Every sensor is <strong className="font-medium text-text">Unknown</strong>, and will
                be until three things land: a sensor type to run (
                <code className="font-mono">P-08</code>
                ), the config push that tells a probe which sensors it owns (
                <code className="font-mono">R-04</code>), and the state machine that turns results
                into states (<code className="font-mono">Phase 3</code>). Nothing here is measuring
                anything yet.
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
          {tree.status === 'ready' && (
            <>
              <p className="text-sm text-text-muted">
                {tree.data.items.length} object{tree.data.items.length === 1 ? '' : 's'} within 12
                levels of the root.
              </p>
              {tree.data.truncated && (
                <p className="mt-2 text-sm text-warning-fg">
                  Truncated — the tree is larger than this page asked for.
                </p>
              )}
            </>
          )}
          {tree.status === 'loading' && <Loading what="the tree" />}
        </Card>
      </div>
    </div>
  );
}
