import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import { offerOf, useSubsystems } from '../build/subsystems';
import type { MapSummary, SensorState, SensorTypeSummary, SubtreeCounts } from '../api/types';
import { Card, Empty, ErrorPanel, Loading, Stat } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { PageTitle } from '../components/PageTitle';
import { HOME_PRIORITY, starredMaps } from './home-maps';
import { listedName, sharedNames } from './names';

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
  /**
   * Totals, not rows.
   *
   * This page used to read a page of the tree — `?maxDepth=12&limit=1000` — and count what came
   * back, which made every number on it a lower bound the moment an installation outgrew the
   * limit: 930 sensors reported for a system running 5,051, with the only hint a truncation
   * note in a card further down. `/counts` aggregates in the database, so the numbers are exact
   * at any size and the page costs one small response rather than a megabyte of summaries it
   * throws away.
   *
   * **Over what this account can see, not under the root** (`A-12`). An account granted one
   * customer's branch may not read the root, and its overview counts that branch.
   */
  const counts = useApi<SubtreeCounts>('/objects/counts');
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');
  /**
   * Every map this account may see, filtered to the starred ones in the browser (`G-09`).
   *
   * One request rather than a `?priority=` this page would be the only caller of: the list is
   * already ordered priority-first, an installation has tens of maps rather than thousands, and
   * the card needs to know whether *any* map exists to say the right thing when none are starred.
   */
  // Asked only of a core that built maps (`H-12`): a v1 build has no such route, and a request
  // that can only answer 404 is noise in its log and a failed request in the browser's.
  const offersMaps = offerOf(useSubsystems(), 'maps') === 'offered';
  const maps = useApi<{ items: MapSummary[] }>(offersMaps ? '/maps' : null);
  const api = useApi<OpenApi>('/openapi.json');

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
          value={api.status === 'ready' || counts.status === 'ready' ? 'Reachable' : '—'}
          hint={api.status === 'ready' ? `version ${api.data.info.version}` : undefined}
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

      {maps.status === 'ready' && maps.data.items.length > 0 && (
        <Card
          title="Maps"
          actions={
            <Link to="/maps" className="text-sm text-accent hover:underline">
              All maps
            </Link>
          }
        >
          <HomeMapList items={maps.data.items} />
        </Card>
      )}

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

/**
 * The starred maps, or why none are here.
 *
 * **Only rendered when the installation has maps at all**, so a system that has never made one
 * does not carry an empty card explaining a feature nobody has reached for. Once there are maps,
 * saying "none are starred" is a status report rather than a blank space.
 */
function HomeMapList({ items }: { readonly items: readonly MapSummary[] }): React.JSX.Element {
  const { shown, hidden } = starredMaps(items);
  const shared = sharedNames(shown);

  if (shown.length === 0) {
    return (
      <Empty because={`A map set to ${String(HOME_PRIORITY)} stars appears here.`}>
        None of the {items.length} map{items.length === 1 ? '' : 's'} is starred.
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border text-sm">
        {shown.map((map) => (
          <li key={map.id} className="py-1.5">
            <Link to={`/maps/${String(map.id)}`} className="text-text underline">
              {listedName(map, shared)}
            </Link>
            {map.description !== '' && <p className="text-xs text-text-muted">{map.description}</p>}
          </li>
        ))}
      </ul>
      {/* Never silently truncated: a list that stops without saying so is one somebody trusts. */}
      {hidden > 0 && (
        <p className="text-xs text-text-muted">
          and {hidden} more starred map{hidden === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}
