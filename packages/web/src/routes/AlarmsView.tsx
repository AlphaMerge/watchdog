import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, send, useApi } from '../api/client';
import { useStateStream, type LiveStates } from '../api/stream';
import type { Alarm, AlarmKind, AlarmPage, HeldReturn } from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { RecoveringBadge, StatusBadge } from '../components/StatusBadge';
import { formatDuration } from './detail/model';
import { kindOf, useConfirmReload, whereSteps } from './alarms-model';
import { PageTitle } from '../components/PageTitle';

/**
 * The severities, worst first — the same five `WORKFLOW.MD §7` names and the core returns — and a
 * held return last (`M-18`), which is not a severity at all: the sensor is back.
 *
 * Ordered by how much they demand, so the chips read as a scale rather than a set.
 */
const SEVERITIES: readonly { state: AlarmKind; label: string }[] = [
  { state: 'down', label: 'Down' },
  { state: 'down_partial', label: 'Partial' },
  { state: 'down_acknowledged', label: 'Acknowledged' },
  { state: 'warning', label: 'Warning' },
  { state: 'unusual', label: 'Unusual' },
  { state: 'recovering', label: 'Recovering' },
];

/** How long to wait after a state change before refetching, so a burst is one request. */
export const SETTLE_MS = 400;

const PRESETS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 1_440, label: '1 day' },
] as const;

/**
 * The alarms view (`U-06`) — the operator's home screen.
 *
 * **The list is the server's answer and the stream is only the prompt.** Sorting by priority
 * then duration, scoping to a branch, counting by severity: all of it is one query against the
 * partial index migration 008 created for this, and doing it again in the browser would be a
 * second implementation to keep in step. What `U-02` contributes is knowing *when* to ask again
 * — a state change anywhere means this list may be wrong, and nothing else does.
 *
 * **Filters live in the URL.** "Look at the Berlin alarms" is a link somebody sends, and a
 * filter held in component state is neither linkable nor survivable across a reload.
 */
export function AlarmsView(): React.JSX.Element {
  const [params, setParams] = useSearchParams();

  const scope = params.get('objectId');
  const hideAcknowledged = params.get('acknowledged') === 'no';
  const sort = params.get('sort') === 'duration' ? 'duration' : 'priority';
  // Joined first, and memoised on the join: `getAll` returns a fresh array every render, so a
  // dependency on the array itself would rebuild the path — and refetch — on every keystroke
  // anywhere on the page.
  const states = params.getAll('state').filter(isSeverity).join(',');
  const chosen = useMemo(
    () => (states === '' ? [] : states.split(',').filter(isSeverity)),
    [states],
  );

  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '200', sort });
    if (scope !== null) query.set('objectId', scope);
    for (const state of chosen) query.append('state', state);
    if (hideAcknowledged) query.set('includeAcknowledged', 'false');
    return `/alarms?${query.toString()}`;
  }, [scope, chosen, hideAcknowledged, sort]);

  const alarms = useApi<AlarmPage>(path);
  const reload = alarms.reload;

  // Subscribed to the whole tree: an alarm can appear anywhere, including in a branch this view
  // is not currently scoped to — and the counts are about the scope, not the filter.
  const live = useStateStream(null);
  useSettledReload(live, reload);
  // The one change the stream cannot announce: a held return's end (`M-18`).
  useConfirmReload(alarms.status === 'ready' ? alarms.data : null, reload);

  const set = useCallback(
    (mutate: (query: URLSearchParams) => void) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const held = useRef<AlarmPage | null>(null);
  useEffect(() => {
    if (alarms.status === 'ready') held.current = alarms.data;
  }, [alarms]);
  const showing = alarms.status === 'ready' ? alarms.data : held.current;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle title="Alarms" />
        <LiveDot status={live.status} />
        {showing !== null && (
          <span className="text-sm text-text-muted">
            {showing.total.toLocaleString()} {showing.total === 1 ? 'alarm' : 'alarms'}
          </span>
        )}
      </div>

      <Filters
        counts={showing?.counts ?? {}}
        chosen={chosen}
        hideAcknowledged={hideAcknowledged}
        sort={sort}
        scope={scope}
        onChange={set}
      />

      {alarms.status === 'error' && <ErrorPanel error={alarms.error} retry={alarms.reload} />}
      {alarms.status === 'loading' && showing === null && <Loading what="alarms" />}
      {showing !== null && alarms.status !== 'error' && (
        <div
          className={alarms.status === 'loading' ? 'opacity-60 transition-opacity' : undefined}
          aria-busy={alarms.status === 'loading'}
        >
          <AlarmList page={showing} onActed={reload} />
        </div>
      )}
    </div>
  );
}

function isSeverity(value: string): value is AlarmKind {
  return SEVERITIES.some((severity) => severity.state === value);
}

/**
 * Refetches once a burst of state changes has stopped arriving.
 *
 * A switch failing takes forty sensors down inside a second. Refetching per event would be forty
 * requests for one answer, and the first thirty-nine would be superseded before they landed.
 *
 * **Keyed on the frames the core sent, not on `states`** (`U-22`). `subscribe` replaces the map
 * as well, with an empty one, so a list that refetched whenever the map changed refetched for its
 * own subscription too. Every page load asked two or three times.
 */
function useSettledReload({ frames, status }: LiveStates, reload: () => void): void {
  // Whether the stream has lost a connection yet. Until it has, its first frame is the snapshot
  // answering the subscribe it made at mount, which describes the same world the page's own
  // fetch asked about; reloading on it would double every page load. A first snapshot that comes
  // after an outage is news, and is how a page opened while the core restarted recovers.
  const lost = useRef(false);
  useEffect(() => {
    if (status === 'offline') lost.current = true;
  }, [status]);

  useEffect(() => {
    if (frames === 0 || (frames === 1 && !lost.current)) return;
    const handle = window.setTimeout(reload, SETTLE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [frames, reload]);
}

function LiveDot({ status }: { status: 'connecting' | 'live' | 'offline' }): React.JSX.Element {
  const label =
    status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline — reconnecting';
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-text-muted"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">
        {status === 'live' ? '●' : status === 'connecting' ? '◐' : '○'}
      </span>
      {label}
    </span>
  );
}

function Filters({
  counts,
  chosen,
  hideAcknowledged,
  sort,
  scope,
  onChange,
}: {
  counts: Partial<Record<AlarmKind, number>>;
  chosen: readonly AlarmKind[];
  hideAcknowledged: boolean;
  sort: string;
  scope: string | null;
  onChange: (mutate: (query: URLSearchParams) => void) => void;
}): React.JSX.Element {
  const toggle = (state: AlarmKind): void => {
    onChange((query) => {
      const held = query.getAll('state').filter(isSeverity);
      const next = held.includes(state)
        ? held.filter((entry) => entry !== state)
        : [...held, state];
      query.delete('state');
      for (const entry of next) query.append('state', entry);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div role="group" aria-label="Severity" className="flex flex-wrap gap-1.5">
        {SEVERITIES.map((severity) => {
          const count = counts[severity.state] ?? 0;
          const on = chosen.length === 0 || chosen.includes(severity.state);
          return (
            <button
              key={severity.state}
              type="button"
              aria-pressed={on}
              onClick={() => {
                toggle(severity.state);
              }}
              className={`flex items-center gap-1.5 border px-2 py-1 text-sm ${
                on ? 'border-accent bg-surface-muted text-text' : 'border-control text-text-muted'
              }`}
            >
              {/* The badge carries the colour and the word, so the chip is never colour alone. */}
              <KindBadge kind={severity.state} />
              <span className="tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      <label className="flex min-h-6 items-center gap-1.5 text-sm text-text-muted">
        <input
          type="checkbox"
          checked={hideAcknowledged}
          onChange={(event) => {
            onChange((query) => {
              if (event.target.checked) query.set('acknowledged', 'no');
              else query.delete('acknowledged');
            });
          }}
        />
        Hide acknowledged
      </label>

      <label className="flex min-h-6 items-center gap-1.5 text-sm text-text-muted">
        Sort
        <select
          value={sort}
          onChange={(event) => {
            onChange((query) => {
              query.set('sort', event.target.value);
            });
          }}
          className="border border-control bg-surface px-1.5 py-1 text-sm text-text"
        >
          <option value="priority">priority, then duration</option>
          <option value="duration">duration</option>
        </select>
      </label>

      {scope !== null && (
        <button
          type="button"
          onClick={() => {
            onChange((query) => {
              query.delete('objectId');
            });
          }}
          className="border border-control px-2 py-1 text-sm text-text-muted hover:text-text"
        >
          Scoped to #{scope} — show everything
        </button>
      )}
    </div>
  );
}

function AlarmList({ page, onActed }: { page: AlarmPage; onActed: () => void }): React.JSX.Element {
  if (page.items.length === 0) {
    return (
      <Card>
        <Empty because="Down, Partial, Acknowledged, Warning and Unusual, and a sensor that is back while its alarm waits to see the return last. A paused sensor is deliberately silent and an unscanned one is Unknown; neither is a fault.">
          Nothing is in an alarm state.
        </Empty>
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-border">
        {page.items.map((alarm) => (
          <AlarmRow key={alarm.sensorId} alarm={alarm} onActed={onActed} />
        ))}
      </ul>
      {page.total > page.items.length && (
        <p className="mt-3 text-xs text-text-muted">
          Showing {page.items.length.toLocaleString()} of {page.total.toLocaleString()}. Narrow the
          severity or scope to a branch.
        </p>
      )}
    </Card>
  );
}

/** A chip's or a row's badge: its state, or a held return (`M-18`). */
function KindBadge({ kind }: { kind: AlarmKind }): React.JSX.Element {
  return kind === 'recovering' ? (
    <RecoveringBadge size="sm" />
  ) : (
    <StatusBadge state={kind} size="sm" />
  );
}

/**
 * When a held return began and when its alarm is over (`M-18`).
 *
 * Clock times rather than "in 3 minutes": `confirmsAt` is on the core's clock, and a countdown
 * worked out against the browser's would be as wrong as the browser is.
 */
function HeldNote({ held }: { held: HeldReturn }): React.JSX.Element {
  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="text-xs text-text-muted">
      Back since {time(held.since)}
      {held.confirmsAt !== null && `; over at ${time(held.confirmsAt)} unless it fails again`}
    </span>
  );
}

function AlarmRow({ alarm, onActed }: { alarm: Alarm; onActed: () => void }): React.JSX.Element {
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const act = useCallback(
    (run: () => Promise<unknown>) => {
      setBusy(true);
      setFailed(null);
      run()
        .then(onActed)
        .catch((error: unknown) => {
          // A refused action has to say so. Silently leaving the row unchanged would read as a
          // click that did not register, and the operator would click again.
          setFailed(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error)),
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [onActed],
  );

  return (
    <li className="space-y-1 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KindBadge kind={kindOf(alarm)} />
        <span className="tabular-nums text-xs text-text-muted" title="Priority, 5 is highest">
          P{alarm.priority}
        </span>
        <Link
          to={`/objects/${String(alarm.sensorId)}`}
          className="text-sm font-medium text-text hover:text-accent hover:underline"
        >
          {alarm.sensorName}
        </Link>
        <Where alarm={alarm} />
        <span className="ml-auto shrink-0 text-xs tabular-nums text-text-muted" title={alarm.since}>
          {formatDuration(Date.now() - new Date(alarm.since).getTime())}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1">
        {alarm.recovering !== null && <HeldNote held={alarm.recovering} />}
        <span className="text-xs text-text-muted">{alarm.cause}</span>
        {alarm.message !== '' && (
          <span className="min-w-0 truncate text-xs text-text-muted">{alarm.message}</span>
        )}
        <Actions alarm={alarm} busy={busy} act={act} />
      </div>

      {failed !== null && (
        <p className="pl-1 text-xs text-down-fg">
          {failed.message}
          {failed.correlationId !== undefined && (
            <span className="ml-2 font-mono">{failed.correlationId}</span>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * Where the alarm is, as links.
 */
function Where({ alarm }: { alarm: Alarm }): React.JSX.Element | null {
  const steps = whereSteps(alarm);
  if (steps.length === 0) return null;

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
      {steps.map((step, index) => (
        <span key={step.id} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">/</span>}
          <Link
            to={`/objects/${String(step.id)}`}
            className="truncate hover:text-accent hover:underline"
          >
            {step.name}
          </Link>
        </span>
      ))}
    </span>
  );
}

/**
 * Acknowledge, pause and resume, from the row.
 *
 * **Inline because the alternative is forty round trips.** A switch failing puts forty sensors
 * on this screen, and making an operator open each one to silence it is how the list stops being
 * used. The actions are the same endpoints the detail page calls; nothing new is authorised here.
 *
 * Acknowledging offers the presets `CAPABILITIES.MD §5.3` names rather than a free duration —
 * the point of the list is speed, and an operator who needs 45 minutes has the detail page.
 */
function Actions({
  alarm,
  busy,
  act,
}: {
  alarm: Alarm;
  busy: boolean;
  act: (run: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const id = String(alarm.sensorId);

  return (
    <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
      {/* A held return is a sensor that is back: there is nothing Down to acknowledge. */}
      {kindOf(alarm) === 'recovering' ? null : alarm.acknowledged ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            act(() => send('DELETE', `/objects/${id}/acknowledge`));
          }}
          className="border border-control px-1.5 py-0.5 text-xs text-text-muted hover:text-text disabled:opacity-50"
        >
          Un-acknowledge
        </button>
      ) : (
        <AcknowledgeMenu id={id} busy={busy} act={act} />
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          act(() =>
            send('POST', `/objects/${id}/pause`, { message: 'paused from the alarms list' }),
          );
        }}
        className="border border-control px-1.5 py-0.5 text-xs text-text-muted hover:text-text disabled:opacity-50"
        title="Stops scanning it entirely — the alarm leaves this list because nothing is watching"
      >
        Pause
      </button>
    </span>
  );
}

function AcknowledgeMenu({
  id,
  busy,
  act,
}: {
  id: string;
  busy: boolean;
  act: (run: () => Promise<unknown>) => void;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          act(() => send('POST', `/objects/${id}/acknowledge`, { message: 'acknowledged' }));
        }}
        className="border border-control px-1.5 py-0.5 text-xs text-text-muted hover:text-text disabled:opacity-50"
        title="Silences notifications until it recovers. It stays on this list."
      >
        Acknowledge
      </button>
      <label className="sr-only" htmlFor={`ack-for-${id}`}>
        Acknowledge for a while
      </label>
      <select
        id={`ack-for-${id}`}
        disabled={busy}
        value=""
        onChange={(event) => {
          const minutes = Number(event.target.value);
          event.target.value = '';
          if (!Number.isFinite(minutes) || minutes <= 0) return;
          act(() =>
            send('POST', `/objects/${id}/acknowledge`, { minutes, message: 'acknowledged' }),
          );
        }}
        className="border border-control bg-surface px-1 py-0.5 text-xs text-text-muted disabled:opacity-50"
      >
        <option value="">for…</option>
        {PRESETS.map((preset) => (
          <option key={preset.minutes} value={preset.minutes}>
            {preset.label}
          </option>
        ))}
      </select>
    </span>
  );
}
