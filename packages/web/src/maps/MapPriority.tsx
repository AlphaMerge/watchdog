import { useState } from 'react';
import { ApiError, send } from '../api/client';
import type { MapSummary } from '../api/types';
import { ErrorPanel } from '../components/Panels';
import { HOME_PRIORITY } from '../routes/home-maps';

/**
 * How important a map is, which is also what puts it on the home screen (`G-09`).
 *
 * **Here rather than on the view page**, because deciding a map is important enough for everybody
 * else's home screen is an editing decision, and the view page is where people who are not
 * editing land.
 *
 * **It carries `If-Match` like every other change to a map.** A priority is a small field and the
 * concurrency rule is not about the field's size: two people with the designer open are the
 * ordinary case, and a save that silently won last is the thing `G-01` refused.
 */
export function MapPriority({
  map,
  version,
  onSaved,
}: {
  readonly map: MapSummary;
  /** The version this change is made against; the parent owns it because the canvas shares it. */
  readonly version: () => number;
  readonly onSaved: (updated: MapSummary) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [priority, setPriority] = useState(map.priority);

  const change = (next: number): void => {
    setPriority(next);
    setBusy(true);
    setFailure(null);
    send<MapSummary>(
      'PATCH',
      `/maps/${String(map.id)}`,
      { priority: next },
      { 'if-match': String(version()) },
    )
      .then(onSaved)
      .catch((error: unknown) => {
        // Put back, because the number on screen must not claim a change the core refused.
        setPriority(map.priority);
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="space-y-2">
      <label className="text-xs text-text-muted">
        <span className="ms-label block">Priority</span>
        <select
          value={priority}
          disabled={busy}
          onChange={(event) => {
            change(Number(event.target.value));
          }}
          className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
        >
          {[1, 2, 3, 4, 5].map((stars) => (
            <option key={stars} value={stars}>
              {'★'.repeat(stars)}
              {'☆'.repeat(5 - stars)} ({stars})
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-text-muted">
        {priority >= HOME_PRIORITY
          ? 'On the Overview page, because it is starred.'
          : `A map at ${String(HOME_PRIORITY)} stars appears on the Overview page.`}
      </p>
      {failure !== null && <ErrorPanel error={failure} />}
    </div>
  );
}
