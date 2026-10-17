import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type { ResolvedMap } from '../api/types';
import { Card } from '../components/Panels';
import { PageTitle } from '../components/PageTitle';
import { MapBoard } from '../maps/MapBoard';
import { ReadState } from '../components/ReadRegion';

/**
 * A map, as it is meant to be looked at (`G-04`).
 *
 * **`/maps/:id` is the map and `/maps/:id/design` is the designer**, rather than the other way
 * round as `G-03` first shipped it. Opening a map to find an editing surface is the same mistake
 * as a document that opens in a form: most people who follow a link to a map want to see it, and
 * the ones who want to change it can say so.
 *
 * Everything on the canvas comes from one request — `GET /maps/:id/view` resolves every widget
 * server-side, so the browser never walks the object tree deciding what it may see.
 */
export function MapView(): React.JSX.Element {
  const { id } = useParams();
  const view = useApi<ResolvedMap>(id === undefined ? null : `/maps/${id}/view`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <PageTitle title={view.status === 'ready' ? view.data.map.name : 'Map'} />
        {view.status === 'ready' && (
          <Link
            to={`/maps/${String(view.data.map.id)}/design`}
            className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text"
          >
            Edit this map
          </Link>
        )}
      </div>

      <ReadState read={view} what="the map" />
      {view.status === 'ready' && (
        <>
          {/*
            Problems above the canvas rather than swallowed. A widget the document could not
            describe has no tile to be drawn as, so the only place it can be reported is here —
            and reporting nothing would make a broken map look like a smaller one.
          */}
          {view.data.problems.length > 0 && (
            <Card title="Widgets that could not be read">
              <ul className="space-y-1 text-sm text-text-muted">
                {view.data.problems.map((problem) => (
                  <li key={problem.id}>
                    <span className="font-mono text-xs">{problem.id}</span> — {problem.problem}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <MapBoard view={view.data} />
        </>
      )}
    </div>
  );
}
