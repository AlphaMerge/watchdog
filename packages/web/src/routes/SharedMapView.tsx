import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type ApiError, useApi } from '../api/client';
import type { SharedMap } from '../api/types';
import { CorrelationId, ErrorPanel, Loading } from '../components/Panels';
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
 *
 * **The map stays in sight while the next minute's is read** (`U-66`). The tick is in the path,
 * and `useApi` says `loading` whenever the path is not the one its answer was read from (`U-62`),
 * so drawn straight from the hook the map gave way to *Loading the map…* once a minute for the
 * length of a request. The last map read for this link is held, in a ref filled only from
 * `ready`, as `MapBoard`'s graph tile holds its chart, and drawn until the next one comes.
 *
 * **A refresh that fails is said, and the map stays.** It is the last good picture, and a wall
 * display that blanked on one dropped request would be worse than one a minute old. A polite
 * region under the name, there and empty while the map is, says it may be out of date and that
 * the next minute asks again. The first failure is kept, id and all, until a read succeeds, so a
 * core that stays down is said once and not once a minute (as `U-64`'s poll region does). A 404
 * is not a failed refresh: the link was revoked or has expired, so the map goes and the page says
 * the link does not work, as it does when such a link is opened.
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

  const held = useRef<{ token: string; map: SharedMap } | null>(null);
  useEffect(() => {
    if (view.status === 'ready' && token !== undefined) held.current = { token, map: view.data };
  }, [view, token]);
  const last = held.current !== null && held.current.token === token ? held.current.map : null;

  const revoked = view.status === 'error' && view.error.status === 404;
  const map = view.status === 'ready' ? view.data : revoked ? null : last;
  const failed = view.status === 'error' && map !== null ? view.error : null;

  // The refresh failure on screen: the first of a run in the same words, until a read succeeds.
  // Set during render from the answer in hand, so it is never a render behind it.
  const [problem, setProblem] = useState<ApiError | null>(null);
  if (view.status === 'ready' && problem !== null) setProblem(null);
  if (failed !== null && (problem === null || !sameWords(problem, failed))) setProblem(failed);

  useEffect(() => {
    if (view.status === 'ready') document.title = `${view.data.name} — MonitoringSystem`;
  }, [view]);

  return (
    <div className="min-h-screen bg-bg p-4">
      <main id="main" className="mx-auto max-w-full space-y-3">
        {map === null && view.status === 'loading' && <Loading what="the map" />}
        {map === null && view.status === 'error' && (
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
        {map !== null && (
          <>
            {/* One plain block, so the region's margin is its own and goes while it is empty. */}
            <div>
              <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="text-xl tracking-[-0.02em] text-text">{map.name}</h1>
                {map.description !== undefined && map.description !== '' && (
                  <p className="text-sm text-text-muted">{map.description}</p>
                )}
              </div>
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="mt-2 text-sm text-text empty:mt-0"
              >
                {problem !== null && (
                  <>
                    This map could not be read again, so it may be out of date ({problem.message}).
                    It is asked for again each minute.
                    <CorrelationId id={problem.correlationId} />
                  </>
                )}
              </p>
            </div>
            <MapCanvas
              view={map}
              states={EMPTY_STATES}
              tick={tick}
              graphs="values"
              backgroundSrc={
                map.hasBackground && token !== undefined ? sharedBackgroundUrl(token) : null
              }
              geo={
                map.geo === null
                  ? null
                  : {
                      lat: map.geo.lat,
                      lon: map.geo.lon,
                      zoom: map.geo.zoom,
                    }
              }
              // Null unless this map's author opted in (`ADR-004` Decision 4). The core decides
              // it; this page only draws what it was given, so there is one place the rule lives.
              tiles={map.tiles}
            />
          </>
        )}
      </main>
    </div>
  );
}

/** The same failure, by what it says: a new correlation id is not news. */
function sameWords(a: ApiError, b: ApiError): boolean {
  return a.code === b.code && a.message === b.message;
}

/** Stable, so the canvas does not re-render for a new empty map on every tick. */
const EMPTY_STATES = new Map<number, never>();
