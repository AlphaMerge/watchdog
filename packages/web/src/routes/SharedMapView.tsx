import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type { SharedMap } from '../api/types';
import { ErrorPanel, Loading } from '../components/Panels';
import { MapCanvas } from '../maps/MapBoard';
import { useClock } from '../maps/clock';
import { sharedBackgroundUrl, sharedMapPath } from '../maps/shareUrl';

/**
 * A map somebody was given a link to (`G-06`, `ADR-002` Decision 1).
 *
 * **Rendered before the session gate, and outside the application's chrome.** There is no nav, no
 * theme toggle and no way to reach anything else, because there is nothing else this viewer may
 * reach — the token opens one map's already-chosen widgets and nothing beyond them. A page that
 * showed the usual header would be offering links that all answer 401.
 *
 * **The same canvas the signed-in board draws.** A second renderer would drift from the first the
 * next time a widget kind was added, and the person who made the link is the one person who
 * cannot check what a stranger sees.
 *
 * **No socket, and no history.** A shared page holds no session, so the state stream is not
 * available to it and neither is the per-sensor history route; it re-reads the whole map on one
 * clock instead, and a graph tile shows its channels' current readings. `ADR-002`'s fourth
 * consequence is the reason: a range query per graph tile is precisely the work an unauthenticated
 * caller should not be able to ask for.
 */

/** The same minute the signed-in board uses. A wall display does not need faster. */
const REFRESH_MS = 60_000;

export function SharedMapView(): React.JSX.Element {
  const { token } = useParams();
  const tick = useClock(REFRESH_MS);
  // The tick is in the path so the poll is a refetch of a new URL rather than a cache decision;
  // `useApi` aborts the one in flight when it changes.
  const view = useApi<SharedMap>(
    token === undefined ? null : `${sharedMapPath(token)}?t=${String(tick)}`,
  );

  useEffect(() => {
    if (view.status === 'ready') document.title = `${view.data.name} — MonitoringSystem`;
  }, [view]);

  return (
    <div className="min-h-screen bg-bg p-4">
      <main id="main" className="mx-auto max-w-full space-y-3">
        {view.status === 'loading' && <Loading what="the map" />}
        {view.status === 'error' && (
          <div className="mx-auto max-w-xl space-y-3">
            <h1 className="text-xl tracking-[-0.02em] text-text">This link does not work</h1>
            {/*
              The core answers the same 404 for expired, revoked and never-existed, so this page
              cannot say which — and should not: the difference is the only useful thing a
              guesser could learn here.
            */}
            <p className="text-sm text-text-muted">
              It may have expired, or been revoked by whoever made it. Ask them for a new one.
            </p>
            <ErrorPanel error={view.error} />
          </div>
        )}
        {view.status === 'ready' && (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-xl tracking-[-0.02em] text-text">{view.data.name}</h1>
              {view.data.description !== undefined && view.data.description !== '' && (
                <p className="text-sm text-text-muted">{view.data.description}</p>
              )}
            </div>
            <MapCanvas
              view={view.data}
              states={EMPTY_STATES}
              tick={tick}
              graphs="values"
              backgroundSrc={
                view.data.hasBackground && token !== undefined ? sharedBackgroundUrl(token) : null
              }
              geo={
                view.data.geo === null
                  ? null
                  : {
                      lat: view.data.geo.lat,
                      lon: view.data.geo.lon,
                      zoom: view.data.geo.zoom,
                    }
              }
              // Null unless this map's author opted in (`ADR-004` Decision 4). The core decides
              // it; this page only draws what it was given, so there is one place the rule lives.
              tiles={view.data.tiles}
            />
          </>
        )}
      </main>
    </div>
  );
}

/** Stable, so the canvas does not re-render for a new empty map on every tick. */
const EMPTY_STATES = new Map<number, never>();
