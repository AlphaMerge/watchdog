import { useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { send, useApi } from '../api/client';
import type { MapSummary } from '../api/types';
import { Card, ErrorPanel, Loading } from '../components/Panels';
import { PageTitle } from '../components/PageTitle';
import { MapDesigner } from '../maps/MapDesigner';
import { MapSharePanel } from '../maps/MapSharePanel';
import { readCanvas, writeLayout, type Canvas } from '../maps/canvas';

/**
 * One map, open in its designer (`G-03`).
 *
 * **The version is a ref, not state.** It is not rendered and nothing derives from it; making it
 * state would re-render the whole canvas on every save for a number nobody looks at. What it has
 * to be is *current* — the save after this one carries it as `If-Match`, and a stale copy would
 * turn the second save of a session into a conflict against the operator's own first one.
 */
export function MapDesignView(): React.JSX.Element {
  const { id } = useParams();
  const map = useApi<MapSummary>(id === undefined ? null : `/maps/${id}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <PageTitle title={map.status === 'ready' ? map.data.name : 'Map'} />
        {map.status === 'ready' && (
          <Link
            to={`/maps/${String(map.data.id)}`}
            className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text"
          >
            View this map
          </Link>
        )}
      </div>
      {map.status === 'loading' && <Loading what="the map" />}
      {map.status === 'error' && <ErrorPanel error={map.error} retry={map.reload} />}
      {map.status === 'ready' && <Designer key={map.data.id} map={map.data} />}
    </div>
  );
}

/**
 * Mounted once per map and never remounted on a save.
 *
 * A `key` off the version would throw the undo history and the selection away every time
 * somebody pressed Save, which is the moment they are least expecting to lose anything.
 */
function Designer({ map }: { readonly map: MapSummary }): React.JSX.Element {
  const version = useRef(map.version);

  const save = async (canvas: Canvas): Promise<void> => {
    const updated = await send<MapSummary>(
      'PATCH',
      `/maps/${String(map.id)}`,
      { layout: writeLayout(canvas) },
      { 'if-match': String(version.current) },
    );
    version.current = updated.version;
  };

  return (
    <>
      <Card title={map.description === '' ? 'Canvas' : map.description}>
        <MapDesigner mapId={map.id} initial={readCanvas(map.layout)} save={save} />
      </Card>
      {/*
        Below the canvas, not in the toolbar: publishing a map to people with no account is a
        decision somebody takes once, not a control they reach for while arranging widgets.
      */}
      <Card title="Sharing">
        <MapSharePanel mapId={map.id} />
      </Card>
    </>
  );
}
