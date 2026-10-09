import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, send, useApi } from '../api/client';
import type { MapSummary } from '../api/types';
import { Card, Empty, ErrorPanel, Loading, RefusalPanel } from '../components/Panels';
import { PageTitle } from '../components/PageTitle';
import { listedName, sharedNames } from './names';

/**
 * The maps this account may see, and the button that makes another (`G-01`, `G-03`).
 *
 * **Everything here comes back from `GET /maps`, which is already filtered.** An administrator
 * sees every map and everybody else sees the ones a group they belong to was granted, so this
 * page never has to decide who may look at what — the one place that decides is `MapService`,
 * and a second copy of the rule here would eventually disagree with it.
 */
export function MapsView(): React.JSX.Element {
  const maps = useApi<{ items: MapSummary[] }>('/maps');
  const shared = sharedNames(maps.status === 'ready' ? maps.data.items : []);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const navigate = useNavigate();

  const create = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (name.trim() === '' || creating) return;
    setCreating(true);
    setFailure(null);
    send<MapSummary>('POST', '/maps', { name: name.trim() })
      .then((made) => {
        // Straight into the designer: a map with no widgets is not a thing anybody wanted to
        // look at a list entry for.
        void navigate(`/maps/${String(made.id)}`);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
        setCreating(false);
      });
  };

  return (
    <div className="space-y-4">
      <PageTitle title="Maps" />

      <Card title="New map">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={100}
              className="mt-1 w-64 max-w-full border border-control bg-surface px-2 py-1 text-sm text-text"
            />
          </label>
          <button
            type="submit"
            disabled={name.trim() === '' || creating}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
        {/* A refused create, in a region always there and empty until one (`U-54`). */}
        <RefusalPanel error={failure} className="mt-3 empty:mt-0" />
      </Card>

      <Card title="Maps">
        {maps.status === 'loading' && <Loading what="maps" />}
        {maps.status === 'error' && <ErrorPanel error={maps.error} retry={maps.retry} />}
        {maps.status === 'ready' && maps.data.items.length === 0 && (
          <Empty because="A map is a canvas of widgets — make one above.">No maps yet.</Empty>
        )}
        {maps.status === 'ready' && maps.data.items.length > 0 && (
          <ul className="divide-y divide-border">
            {maps.data.items.map((map) => (
              <li key={map.id} className="py-2">
                <Link to={`/maps/${String(map.id)}`} className="text-sm text-text underline">
                  {listedName(map, shared)}
                </Link>
                {map.description !== '' && (
                  <p className="text-xs text-text-muted">{map.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
