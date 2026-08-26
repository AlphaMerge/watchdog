import { Link } from 'react-router-dom';
import { useApi } from '../../api/client';
import type { StateLogEntry, StateLogPage } from '../../api/types';
import { Empty, ErrorPanel, Loading } from '../../components/Panels';
import { StatusBadge } from '../../components/StatusBadge';

const LIMIT = 50;

/** A duration in the largest unit that still says something useful. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 90) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/**
 * Every state this object has been in, newest first (`M-15`).
 *
 * **This table is the source of uptime, not a rendering of the samples.** Downtime and SLA are
 * computed from `sensor_state` precisely so they survive rollups and gaps (CLAUDE.md), and this
 * is that history — which is why it shows how long each state *lasted* rather than only when it
 * started. "Down for 4 minutes" and "Down for 4 hours" are the same row otherwise.
 *
 * The cause is shown beside the state because it is what tells an operator where to look. A
 * sensor that went Down because its parent was paused, its dependency went down, or somebody
 * forced it are three different situations wearing the same colour.
 */
export function StateLogPanel({
  objectId,
  isSensor,
}: {
  objectId: number;
  /** A container's log covers everything beneath it, so each row has to say which sensor. */
  isSensor: boolean;
}): React.JSX.Element {
  const log = useApi<StateLogPage>(
    `/state-log?objectId=${String(objectId)}&limit=${String(LIMIT)}`,
  );

  if (log.status === 'loading') return <Loading what="the state log" />;
  if (log.status === 'error') return <ErrorPanel error={log.error} retry={log.reload} />;
  if (log.data.items.length === 0) {
    return (
      <Empty because="A row is written when a state changes, so a sensor that has never changed state has none.">
        No state changes recorded.
      </Empty>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">State changes, newest first</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">
                When
              </th>
              {!isSensor && (
                <th scope="col" className="py-2 pr-3 font-medium">
                  Sensor
                </th>
              )}
              <th scope="col" className="py-2 pr-3 font-medium">
                State
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Cause
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Lasted
              </th>
              <th scope="col" className="py-2 font-medium">
                Message
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {log.data.items.map((entry) => (
              <Row
                key={`${entry.at}:${String(entry.sensorId)}`}
                entry={entry}
                isSensor={isSensor}
              />
            ))}
          </tbody>
        </table>
      </div>
      {log.data.nextBefore !== null && (
        <p className="text-xs text-text-muted">
          The most recent {String(LIMIT)} changes.{' '}
          <Link to={`/logs?objectId=${String(objectId)}`} className="text-accent hover:underline">
            The whole log, filterable
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function Row({ entry, isSensor }: { entry: StateLogEntry; isSensor: boolean }): React.JSX.Element {
  return (
    <tr>
      <td className="py-2 pr-3 align-top whitespace-nowrap">
        <time dateTime={entry.at} title={entry.at} className="text-xs text-text-muted">
          {new Date(entry.at).toLocaleString()}
        </time>
      </td>
      {!isSensor && (
        <td className="py-2 pr-3 align-top">
          <Link
            to={`/objects/${String(entry.sensorId)}`}
            className="text-xs text-accent hover:underline"
          >
            {entry.sensorName}
          </Link>
        </td>
      )}
      <td className="py-2 pr-3 align-top">
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge state={entry.state} size="sm" />
          {entry.previousState !== null && (
            <span className="text-xs text-text-muted">from {entry.previousState}</span>
          )}
        </span>
      </td>
      <td className="py-2 pr-3 align-top text-xs text-text-muted">{entry.cause}</td>
      <td className="py-2 pr-3 align-top text-xs tabular-nums text-text-muted">
        {entry.durationMs === null ? (
          // The state it is still in. The core deliberately does not put a number here — it
          // would change on every read — so the elapsed time is computed from `at` instead, and
          // labelled as ongoing rather than as a duration that has finished.
          <span title="Still in this state">
            {formatDuration(Date.now() - new Date(entry.at).getTime())} so far
          </span>
        ) : (
          formatDuration(entry.durationMs)
        )}
      </td>
      <td className="py-2 align-top text-xs text-text-muted">{entry.message}</td>
    </tr>
  );
}
