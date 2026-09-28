import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { actorLabel, actorRef } from '../api/actors';
import type {
  AuditActor,
  AuditEntry,
  AuditPage,
  NotificationRequestPage,
  NotificationRequestView,
  SensorState,
  StateLogEntry,
  StateLogPage,
} from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TabPanel, Tabs } from '../components/Tabs';
import type { TabDefinition } from '../components/tabs-model';
import { formatDuration } from './detail/model';
import { PageTitle } from '../components/PageTitle';
import { PAGE, usePaged, auditQueryFor } from './logs-model';

/**
 * `CAPABILITIES.MD §6`'s three categories, spelled the way it spells them.
 *
 * They are three different tables with three different questions, not one stream with a type
 * column: "when did this sensor break", "who changed this", and "did anybody get told". Merging
 * them into one list would need a lowest-common-denominator row that describes none of them
 * well, and a filter to get back to the one you wanted.
 */
const TABS: readonly TabDefinition[] = [
  { id: 'status', label: 'Status changes' },
  { id: 'objects', label: 'Object history' },
  { id: 'system', label: 'System events' },
];

/**
 * The action prefixes the core filters on, in the order it lists them.
 *
 * Held to the core's `AUDIT_CATEGORIES` by `audit-categories.test.ts`: this list fell three behind
 * the server before anything compared them, and an entry with no chip is one nobody filters to.
 */
const CATEGORIES = [
  'object',
  'setting',
  'credential',
  'channel',
  'trigger',
  'template',
  'schedule',
  'sensor',
  'report',
  'library',
  'map',
  'grant',
  'probe',
  'discovery',
  'account',
  'group',
  'token',
] as const;

const STATES: readonly SensorState[] = [
  'down',
  'down_partial',
  'down_acknowledged',
  'warning',
  'unusual',
  'up',
  'paused',
  'unknown',
];

/**
 * The Logs view (`U-07`).
 *
 * **Every list here pages by keyset, never by offset.** Rows arrive while somebody is reading —
 * a sensor changes state, somebody saves a setting — and an offset page recomputed against a
 * shifted table shows a row twice or skips one entirely. The cursor names the last row seen, so
 * the next page starts exactly after it whatever has landed in between.
 *
 * The tab and every filter live in the URL, so a log somebody is looking at is a link they can
 * send.
 */
export function LogsView(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const active = TABS.some((tab) => tab.id === requested) ? (requested ?? 'status') : 'status';

  const set = useCallback(
    (mutate: (query: URLSearchParams) => void) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  return (
    <div className="space-y-4">
      <PageTitle title="Logs" />

      <Tabs
        tabs={TABS}
        active={active}
        onSelect={(tab) => {
          // Each tab has its own filters, and carrying one tab's over to another would apply a
          // state filter to a list with no states in it.
          setParams(tab === 'status' ? {} : { tab }, { replace: true });
        }}
        label="Log categories"
      />

      {active === 'status' && (
        <TabPanel id="status">
          <StatusChanges params={params} set={set} />
        </TabPanel>
      )}
      {active === 'objects' && (
        <TabPanel id="objects">
          <ObjectHistory params={params} set={set} />
        </TabPanel>
      )}
      {active === 'system' && (
        <TabPanel id="system">
          <SystemEvents params={params} set={set} />
        </TabPanel>
      )}
    </div>
  );
}

type Setter = (mutate: (query: URLSearchParams) => void) => void;

/**
 * Paging, and — the part that is easy to leave out — saying when there is no more.
 *
 * A list that simply stops looks the same whether it ended or was truncated, and the reader has
 * no way to tell which. Shared with the object detail view's history panel so both answer that
 * the same way.
 */
export function MoreButton({
  more,
  loading,
  count,
  what = 'log',
}: {
  more: (() => void) | null;
  loading: boolean;
  count: number;
  what?: string;
}): React.JSX.Element | null {
  if (more === null) {
    return count === 0 ? null : (
      <p className="mt-3 text-xs text-text-muted">That is the whole {what}.</p>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-3">
      <button
        type="button"
        disabled={loading}
        onClick={more}
        className="border border-control px-2 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load more'}
      </button>
      <span className="text-xs text-text-muted">{count.toLocaleString()} so far</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Status changes (M-15).
// ---------------------------------------------------------------------------------------------

function StatusChanges({
  params,
  set,
}: {
  params: URLSearchParams;
  set: Setter;
}): React.JSX.Element {
  const states = params.getAll('state').join(',');
  const objectId = params.get('objectId');

  const query = useMemo(() => {
    const search = new URLSearchParams({ limit: String(PAGE) });
    if (objectId !== null) search.set('objectId', objectId);
    for (const state of states === '' ? [] : states.split(',')) search.append('state', state);
    return search;
  }, [states, objectId]);

  const path = `/state-log?${query.toString()}`;
  const cursorOf = useCallback(
    (page: { items: StateLogEntry[] }) => (page as StateLogPage).nextBefore,
    [],
  );
  const nextPath = useCallback(
    (cursor: string) => `/state-log?${query.toString()}&before=${encodeURIComponent(cursor)}`,
    [query],
  );
  const log = usePaged<StateLogEntry, string>(path, cursorOf, nextPath);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="State" className="flex flex-wrap gap-1.5">
          {STATES.map((state) => {
            const chosen = states === '' ? [] : states.split(',');
            const on = chosen.includes(state);
            return (
              <button
                key={state}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  set((search) => {
                    const next = on
                      ? chosen.filter((entry) => entry !== state)
                      : [...chosen, state];
                    search.delete('state');
                    for (const entry of next) search.append('state', entry);
                  });
                }}
                /*
                  The same on/off treatment as the severity chips on Alarms — a border and a
                  fill, and no opacity.
                  `opacity-60` on the off state dimmed the badge inside it along with the chip,
                  which took every state below 4.5:1 against its own fill (Unknown worst, at
                  2.97:1) for a control that is not disabled and therefore has no 1.4.3
                  exemption. Contrast was measured on the composited colour, not the token.
                */
                className={`border px-1 py-0.5 ${
                  on ? 'border-accent bg-surface-muted' : 'border-control'
                }`}
              >
                <StatusBadge state={state} size="sm" />
              </button>
            );
          })}
        </div>
        <ScopeChip params={params} set={set} />
      </div>

      {log.status === 'loading' && <Loading what="the status log" />}
      {log.error !== null && <ErrorPanel error={log.error} retry={log.reload} />}
      {log.status === 'ready' && (
        <Card>
          {log.items.length === 0 ? (
            <Empty because="A row is written when a state changes, so a sensor that has never changed state has none.">
              No status changes match.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <caption className="sr-only">Status changes, newest first</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      When
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Sensor
                    </th>
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
                  {log.items.map((entry) => (
                    <tr key={`${entry.at}:${String(entry.sensorId)}`}>
                      <td className="whitespace-nowrap py-2 pr-3 align-top text-xs text-text-muted">
                        <time dateTime={entry.at} title={entry.at}>
                          {new Date(entry.at).toLocaleString()}
                        </time>
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <Link
                          to={`/objects/${String(entry.sensorId)}`}
                          className="text-xs text-accent hover:underline"
                        >
                          {entry.sensorName}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge state={entry.state} size="sm" />
                          {entry.previousState !== null && (
                            <span className="text-xs text-text-muted">
                              from {entry.previousState}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-3 align-top text-xs text-text-muted">{entry.cause}</td>
                      <td className="py-2 pr-3 align-top text-xs tabular-nums text-text-muted">
                        {entry.durationMs === null ? (
                          <span title="Still in this state">
                            {formatDuration(Date.now() - new Date(entry.at).getTime())} so far
                          </span>
                        ) : (
                          formatDuration(entry.durationMs)
                        )}
                      </td>
                      <td className="py-2 align-top text-xs text-text-muted">{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <MoreButton more={log.more} loading={log.loadingMore} count={log.items.length} />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Object history (S-10).
// ---------------------------------------------------------------------------------------------

function ObjectHistory({
  params,
  set,
}: {
  params: URLSearchParams;
  set: Setter;
}): React.JSX.Element {
  // Depended on by value rather than by the URLSearchParams object, which is a fresh instance on
  // every render and would rebuild the query — and re-fetch the log — on each one.
  const categories = params.getAll('category').join(',');
  const objectId = params.get('objectId');
  const refFilter = params.get('actorRef');
  const kindFilter = params.get('actorKind');

  const query = useMemo(() => {
    const search = new URLSearchParams();
    if (objectId !== null) search.set('objectId', objectId);
    if (refFilter !== null) search.set('actorRef', refFilter);
    if (kindFilter !== null) search.set('actorKind', kindFilter);
    for (const category of categories === '' ? [] : categories.split(','))
      search.append('category', category);
    return auditQueryFor(search);
  }, [categories, objectId, refFilter, kindFilter]);

  const path = `/audit?${query.toString()}`;
  const cursorOf = useCallback(
    (page: { items: AuditEntry[] }) => (page as AuditPage).nextBefore,
    [],
  );
  const nextPath = useCallback(
    (cursor: string) => `/audit?${query.toString()}&before=${encodeURIComponent(cursor)}`,
    [query],
  );
  const log = usePaged<AuditEntry, string>(path, cursorOf, nextPath);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((category) => {
            const chosen = categories === '' ? [] : categories.split(',');
            const on = chosen.includes(category);
            return (
              <button
                key={category}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  set((search) => {
                    const next = on
                      ? chosen.filter((entry) => entry !== category)
                      : [...chosen, category];
                    search.delete('category');
                    for (const entry of next) search.append('category', entry);
                  });
                }}
                className={`border px-2 py-1 text-xs ${
                  on
                    ? 'border-accent bg-surface-muted text-text'
                    : 'border-control text-text-muted hover:text-text'
                }`}
              >
                {category}
              </button>
            );
          })}
        </div>
        <ScopeChip params={params} set={set} />
        <ActorChip params={params} set={set} />
      </div>

      {log.status === 'loading' && <Loading what="the object history" />}
      {log.error !== null && <ErrorPanel error={log.error} retry={log.reload} />}
      {log.status === 'ready' && (
        <Card>
          {log.items.length === 0 ? (
            <Empty>No configuration changes match.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {log.items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
          <MoreButton more={log.more} loading={log.loadingMore} count={log.items.length} />
        </Card>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }): React.JSX.Element {
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time dateTime={entry.at} title={entry.at} className="font-mono text-xs text-text-muted">
          {new Date(entry.at).toLocaleString()}
        </time>
        <span className="font-medium text-text">{entry.action}</span>
        {entry.objectId !== null && (
          // The subject may have been deleted — that is the entry most worth reading — so this
          // is a link that may 404, which is better than no way to look.
          <Link
            to={`/objects/${String(entry.objectId)}`}
            className="text-xs text-accent hover:underline"
          >
            #{entry.objectId}
            {entry.objectKind !== null && ` (${entry.objectKind})`}
          </Link>
        )}
        <ActorLink actor={entry.actor} />
      </div>
      {entry.diff.length > 0 && (
        <ul className="ml-1 space-y-0.5 text-xs text-text-muted">
          {entry.diff.map((change) => (
            <li key={change.field} className="font-mono">
              {change.field}: {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The actor on an entry, as a link that filters the feed to them (`A-08`).
 *
 * **"Everything this person did" is the question an audit log gets opened for**, and it is not
 * answerable from a list unless the list gives you a way to ask it. `actorKind` alone narrows to
 * *all* users, which during an incident is everybody.
 *
 * **Every kind links, not only the human ones.** `actor_ref` names one component, not all of
 * them, so "everything housekeeping did" is as answerable as "everything Ada did" — and one
 * address's unauthenticated requests is the query an incident actually starts from.
 */
export function ActorLink({ actor }: { actor: AuditActor }): React.JSX.Element {
  const label = actorLabel(actor);
  const search = new URLSearchParams({
    tab: 'objects',
    actorKind: actor.kind,
    actorRef: actorRef(actor),
  });
  return (
    <Link
      to={`/logs?${search.toString()}`}
      className="text-xs text-accent hover:underline"
      title={`Everything ${label} did`}
    >
      {label}
    </Link>
  );
}

/**
 * Shows an actor filter is on, and takes it off.
 *
 * **Says so in a sentence rather than as a chip with a cross**, matching `ScopeChip`: a filtered
 * log that looks like an unfiltered one is how somebody concludes a change was never made. The
 * accessible name has to carry that too, so there is no bare ✕ to announce.
 *
 * Named by kind and ref, which is what was filtered on — the URL is shareable, and a label
 * carried alongside it would go stale the moment somebody was renamed.
 */
function ActorChip({
  params,
  set,
}: {
  params: URLSearchParams;
  set: Setter;
}): React.JSX.Element | null {
  const ref = params.get('actorRef');
  const kind = params.get('actorKind');
  if (ref === null || ref === '' || kind === null || kind === '') return null;
  return (
    <button
      type="button"
      onClick={() => {
        set((search) => {
          search.delete('actorRef');
          search.delete('actorKind');
        });
      }}
      className="border border-accent bg-surface-muted px-2 py-1 text-xs text-text"
    >
      Only {kind} {ref} — show every actor
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// System events (N-13). Notifications are the only kind v1 produces.
// ---------------------------------------------------------------------------------------------

function SystemEvents({
  params,
  set,
}: {
  params: URLSearchParams;
  set: Setter;
}): React.JSX.Element {
  const statuses = params.getAll('status').join(',');

  const query = useMemo(() => {
    const search = new URLSearchParams({ limit: '50' });
    for (const status of statuses === '' ? [] : statuses.split(','))
      search.append('status', status);
    return search;
  }, [statuses]);

  const path = `/notification-requests?${query.toString()}`;
  const cursorOf = useCallback(
    (page: { items: NotificationRequestView[] }) => (page as NotificationRequestPage).nextBefore,
    [],
  );
  const nextPath = useCallback(
    (cursor: number) => `/notification-requests?${query.toString()}&before=${String(cursor)}`,
    [query],
  );
  const log = usePaged<NotificationRequestView, number>(path, cursorOf, nextPath);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {['sent', 'pending', 'failed', 'discarded'].map((status) => {
          const chosen = statuses === '' ? [] : statuses.split(',');
          const on = chosen.includes(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              onClick={() => {
                set((search) => {
                  const next = on
                    ? chosen.filter((entry) => entry !== status)
                    : [...chosen, status];
                  search.delete('status');
                  for (const entry of next) search.append('status', entry);
                });
              }}
              className={`border px-2 py-1 text-xs ${
                on
                  ? 'border-accent bg-surface-muted text-text'
                  : 'border-control text-text-muted hover:text-text'
              }`}
            >
              {status}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-text-muted">
        Notifications are the only system event v1 produces. Auto-discovery, reports and clustering
        are later phases, and each will land here rather than in a view of its own.
      </p>

      {log.status === 'loading' && <Loading what="system events" />}
      {log.error !== null && <ErrorPanel error={log.error} retry={log.reload} />}
      {log.status === 'ready' && (
        <Card>
          {log.items.length === 0 ? (
            <Empty because="A row is written when a trigger fires, so an installation with no triggers has none.">
              No notifications match.
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {log.items.map((entry) => (
                <NotificationRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
          <MoreButton more={log.more} loading={log.loadingMore} count={log.items.length} />
        </Card>
      )}
    </div>
  );
}

/** `failed` is an alarm nobody received; `discarded` is one thrown away on purpose (`N-12`). */
const STATUS_TONE: Record<string, string> = {
  sent: 'border-up-border bg-up-bg text-up-fg',
  pending: 'border-border text-text-muted',
  failed: 'border-down-border bg-down-bg text-down-fg',
  discarded: 'border-paused-border bg-paused-bg text-paused-fg',
};

function NotificationRow({ entry }: { entry: NotificationRequestView }): React.JSX.Element {
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time dateTime={entry.at} title={entry.at} className="font-mono text-xs text-text-muted">
          {new Date(entry.at).toLocaleString()}
        </time>
        <span
          className={`border px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[entry.status] ?? 'border-border text-text-muted'}`}
        >
          {entry.status}
        </span>
        {entry.sensorName !== null && (
          <Link
            to={`/objects/${String(entry.sensorId)}`}
            className="text-sm text-accent hover:underline"
          >
            {entry.sensorName}
          </Link>
        )}
        {entry.state !== null && <StatusBadge state={entry.state} size="sm" />}
        <span className="text-xs text-text-muted">
          {entry.templateName ?? entry.method ?? 'template removed'}
        </span>
        {entry.attempts > 1 && (
          <span className="text-xs text-text-muted">{entry.attempts} attempts</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-1 text-xs text-text-muted">
        {entry.reason !== null && <span>{entry.reason}</span>}
        {entry.disposition !== null && <span>{entry.disposition}</span>}
        {entry.message !== '' && <span className="truncate">{entry.message}</span>}
        {entry.lastError !== null && <span className="text-down-fg">{entry.lastError}</span>}
      </div>
    </li>
  );
}

/** The shared "scoped to one object" chip, on the two lists that take an objectId. */
function ScopeChip({
  params,
  set,
}: {
  params: URLSearchParams;
  set: Setter;
}): React.JSX.Element | null {
  const objectId = params.get('objectId');
  if (objectId === null) return null;
  return (
    <button
      type="button"
      onClick={() => {
        set((search) => {
          search.delete('objectId');
        });
      }}
      className="border border-control px-2 py-1 text-xs text-text-muted hover:text-text"
    >
      Scoped to #{objectId} — show everything
    </button>
  );
}
