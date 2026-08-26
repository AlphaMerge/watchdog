import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import { useStateStream, type LiveState } from '../api/stream';
import type {
  AncestorsView,
  AuditPage,
  ChannelRecord,
  LookupSummary,
  ObjectDetail,
  PauseView,
  SensorTypeSummary,
  SensorValues,
  SettingView,
} from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TabPanel, Tabs, type TabDefinition } from '../components/Tabs';
import { rollup, stateFor } from '../tree/model';
import { ChannelTable } from './detail/ChannelTable';
import { HistoryPanel } from './detail/HistoryPanel';
import { SettingsPanel } from './detail/SettingsPanel';
import { StateLogPanel } from './detail/StateLogPanel';
import { TriggersPanel } from './detail/TriggersPanel';

/** How often the channel table re-reads its values. */
const VALUES_POLL_MS = 15_000;

const KIND_GLYPH: Record<string, string> = {
  root: '⌂',
  probe: '◈',
  group: '▤',
  device: '▥',
  sensor: '◉',
};

/**
 * The object detail page (`U-04`), which for a sensor is *the* page.
 *
 * **Six tabs rather than one long column**, and the tab lives in the URL. "Look at the triggers
 * on this sensor" is the kind of thing one person sends another, and a tab held in component
 * state cannot be linked to and does not survive a reload.
 *
 * **The state is streamed and the readings are polled, and the split is deliberate.** `U-02`'s
 * stream carries state changes, which is what the badge and the tree need and what has to be
 * immediate. Channel *values* change on every scan whether or not the state does, and putting a
 * frame on the wire for every reading of every sensor would be a stream nobody could keep up
 * with. So the badge is live and the numbers refresh on an interval — the one place in this app
 * that polls, for the one thing a stream is the wrong shape for.
 */
export function ObjectDetailView(): React.JSX.Element {
  const { id = '' } = useParams();
  const object = useApi<ObjectDetail>(`/objects/${id}`);
  const numericId = Number(id);
  const isSensor = object.status === 'ready' && object.data.kind === 'sensor';

  const [params, setParams] = useSearchParams();

  const ancestors = useApi<AncestorsView>(
    object.status === 'ready' ? `/objects/${id}/ancestors` : null,
  );
  const channels = useApi<{ items: ChannelRecord[] }>(isSensor ? `/objects/${id}/channels` : null);
  const settings = useApi<{ settings: SettingView[] }>(
    object.status === 'ready' ? `/objects/${id}/settings` : null,
  );
  const pause = useApi<PauseView>(object.status === 'ready' ? `/objects/${id}/pause` : null);
  const types = useApi<{ items: SensorTypeSummary[] }>(isSensor ? '/sensor-types' : null);
  const lookups = useApi<{ items: LookupSummary[] }>(isSensor ? '/lookups' : null);

  // Live, over the stream. For a container this is every sensor beneath it, which is what the
  // header badge rolls up — the same computation the tree does, from the same source.
  const live = useStateStream(Number.isFinite(numericId) ? numericId : null);

  if (object.status === 'loading') return <Loading what="the object" />;
  if (object.status === 'error') return <ErrorPanel error={object.error} retry={object.reload} />;

  const detail = object.data;
  const tabs = tabsFor(detail);
  const requested = params.get('tab');
  const active = tabs.some((tab) => tab.id === requested) ? (requested ?? 'overview') : 'overview';

  const select = (tab: string): void => {
    // Replace rather than push: six tabs would otherwise leave the back button walking through
    // every one somebody glanced at before it left the page.
    setParams(tab === 'overview' ? {} : { tab }, { replace: true });
  };

  return (
    <div className="space-y-5">
      <Header
        detail={detail}
        ancestors={ancestors.status === 'ready' ? ancestors.data.items : null}
        live={live.states}
        pause={pause.status === 'ready' ? pause.data : null}
      />

      <Tabs tabs={tabs} active={active} onSelect={select} label={`${detail.name} sections`} />

      {active === 'overview' && (
        <TabPanel id="overview">
          <div className="space-y-4">
            {detail.kind === 'sensor' && (
              <Card title="Channels">
                <LiveChannels
                  sensorId={detail.id}
                  channels={channels.status === 'ready' ? channels.data.items : null}
                  lookups={lookups.status === 'ready' ? lookups.data.items : null}
                />
              </Card>
            )}
            <Card title="Configuration">
              <Configuration
                detail={detail}
                typeKnown={
                  detail.sensorType !== undefined &&
                  types.status === 'ready' &&
                  types.data.items.some((type) => type.id === detail.sensorType)
                }
              />
            </Card>
          </div>
        </TabPanel>
      )}

      {active === 'history' && (
        <TabPanel id="history">
          <HistoryPanel sensorId={detail.id} />
        </TabPanel>
      )}

      {active === 'log' && (
        <TabPanel id="log">
          <Card title="State changes">
            <StateLogPanel objectId={detail.id} isSensor={detail.kind === 'sensor'} />
          </Card>
        </TabPanel>
      )}

      {active === 'settings' && (
        <TabPanel id="settings">
          <Card title="Settings">
            {settings.status === 'loading' && <Loading what="settings" />}
            {settings.status === 'error' && (
              <ErrorPanel error={settings.error} retry={settings.reload} />
            )}
            {settings.status === 'ready' && (
              <SettingsPanel
                items={settings.data.settings}
                ancestors={ancestors.status === 'ready' ? ancestors.data.items : null}
              />
            )}
          </Card>
        </TabPanel>
      )}

      {active === 'triggers' && (
        <TabPanel id="triggers">
          <Card title="Notification triggers">
            <TriggersPanel objectId={detail.id} inheritsTriggers={detail.inheritsTriggers} />
          </Card>
        </TabPanel>
      )}

      {active === 'changes' && (
        <TabPanel id="changes">
          <Card title="Configuration history">
            <AuditPanel objectId={detail.id} />
          </Card>
        </TabPanel>
      )}
    </div>
  );
}

/** Which sections this kind actually has. A device has no channels and no history. */
function tabsFor(detail: ObjectDetail): TabDefinition[] {
  const tabs: TabDefinition[] = [{ id: 'overview', label: 'Overview' }];
  if (detail.kind === 'sensor') tabs.push({ id: 'history', label: 'History' });
  tabs.push(
    { id: 'log', label: 'Log' },
    { id: 'settings', label: 'Settings' },
    { id: 'triggers', label: 'Triggers' },
    { id: 'changes', label: 'Changes' },
  );
  return tabs;
}

function Header({
  detail,
  ancestors,
  live,
  pause,
}: {
  detail: ObjectDetail;
  ancestors: AncestorsView['items'] | null;
  live: ReadonlyMap<number, LiveState>;
  pause: PauseView | null;
}): React.JSX.Element {
  const worst = useMemo(() => rollup(live.values()), [live]);
  const state = stateFor(detail, live, worst);
  const own = live.get(detail.id);

  return (
    <header className="space-y-2">
      <Breadcrumb ancestors={ancestors} />
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden="true" className="text-text-muted">
          {KIND_GLYPH[detail.kind] ?? '·'}
        </span>
        <h1 className="text-xl font-semibold text-text">{detail.name}</h1>
        <span className="text-xs uppercase tracking-wide text-text-muted">{detail.kind}</span>
        {state !== undefined && (
          <StatusBadge
            state={state}
            size="sm"
            {...(detail.kind === 'sensor'
              ? {}
              : { describedAs: `worst state below ${detail.name}: ${state}` })}
          />
        )}
        {own !== undefined && <SinceAndCause live={own} />}
      </div>
      {pause?.paused === true && <PausedBanner view={pause} />}
    </header>
  );
}

/**
 * The part of a state that is not the state: why, and since when.
 *
 * "Down" on its own is what an operator already knows from the colour. The cause is what tells
 * them where to look — a sensor down because its dependency went down, because its parent is
 * paused, or because somebody forced it are three different situations wearing one badge.
 */
function SinceAndCause({ live }: { live: LiveState }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-baseline gap-2 text-xs text-text-muted">
      <span>{live.cause}</span>
      {live.at !== '' && (
        <span>
          · since{' '}
          <time dateTime={live.at} title={live.at}>
            {new Date(live.at).toLocaleString()}
          </time>
        </span>
      )}
      {live.message !== '' && <span className="opacity-90">— {live.message}</span>}
    </span>
  );
}

/** Where this object sits. Root first, so the path reads the way the tree does. */
function Breadcrumb({
  ancestors,
}: {
  ancestors: AncestorsView['items'] | null;
}): React.JSX.Element {
  if (ancestors === null || ancestors.length === 0) {
    return (
      <Link to="/tree" className="text-sm text-accent hover:underline">
        ← Tree
      </Link>
    );
  }
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-text-muted">
        {ancestors.map((ancestor) => (
          <li key={ancestor.id} className="flex items-center gap-1">
            <Link to={`/objects/${String(ancestor.id)}`} className="text-accent hover:underline">
              {ancestor.name}
            </Link>
            <span aria-hidden="true">/</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The channel table, kept current.
 *
 * Polled rather than streamed — see the note on the page above. The interval is cleared while
 * the tab is hidden, so a page left open on a second monitor is not asking every fifteen
 * seconds for a table nobody is looking at.
 */
function LiveChannels({
  sensorId,
  channels,
  lookups,
}: {
  sensorId: number;
  channels: readonly ChannelRecord[] | null;
  lookups: readonly LookupSummary[] | null;
}): React.JSX.Element {
  const values = useApi<SensorValues>(`/sensors/${String(sensorId)}/values`);
  // Only to force a re-render on the interval. The ages themselves come from `Date.now()` at
  // render time — holding "now" in state means a component that re-renders for any other reason
  // redraws with a stale clock, and "58s ago" that has stopped counting is worse than no age.
  const [, tick] = useState(0);
  const reload = values.reload;

  useEffect(() => {
    const refresh = (): void => {
      // Nothing is asked for while nobody is looking. `visibilitychange` fires on the way back,
      // so a tab returned to is current within a frame rather than fifteen seconds later.
      if (document.visibilityState !== 'visible') return;
      tick((count) => count + 1);
      reload();
    };
    const handle = window.setInterval(refresh, VALUES_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  if (channels === null) return <Loading what="channels" />;
  if (values.status === 'error') return <ErrorPanel error={values.error} retry={values.reload} />;

  return (
    <ChannelTable
      channels={channels}
      values={values.status === 'ready' ? values.data : null}
      lookups={lookups}
      now={Date.now()}
    />
  );
}

function AuditPanel({ objectId }: { objectId: number }): React.JSX.Element {
  const audit = useApi<AuditPage>(`/objects/${String(objectId)}/audit?limit=50`);
  if (audit.status === 'loading') return <Loading what="the audit log" />;
  if (audit.status === 'error') return <ErrorPanel error={audit.error} retry={audit.reload} />;
  if (audit.data.items.length === 0) {
    return <Empty>Nothing has changed this object.</Empty>;
  }

  return (
    <ul className="divide-y divide-border text-sm">
      {audit.data.items.map((entry) => (
        <li key={entry.id} className="space-y-1 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <time
              dateTime={entry.at}
              title={entry.at}
              className="font-mono text-xs text-text-muted"
            >
              {new Date(entry.at).toLocaleString()}
            </time>
            <span className="font-medium text-text">{entry.action}</span>
            <span className="text-xs text-text-muted">{entry.actor.label ?? entry.actor.kind}</span>
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
      ))}
    </ul>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text">{value}</dd>
    </>
  );
}

function Configuration({
  detail,
  typeKnown,
}: {
  detail: ObjectDetail;
  typeKnown: boolean;
}): React.JSX.Element {
  return (
    <>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Field label="Id" value={<span className="font-mono">{detail.id}</span>} />
        <Field label="Version" value={<span className="tabular-nums">{detail.version}</span>} />
        <Field label="Priority" value={detail.priority} />
        {detail.host !== undefined && detail.host !== '' && (
          <Field label="Host" value={<span className="font-mono">{detail.host}</span>} />
        )}
        {detail.sensorType !== undefined && (
          <Field
            label="Sensor type"
            value={<span className="font-mono">{detail.sensorType}</span>}
          />
        )}
        <Field label="Tags" value={detail.tags.length === 0 ? '—' : detail.tags.join(', ')} />
        {detail.comments !== '' && <Field label="Comments" value={detail.comments} />}
        <Field
          label="Updated"
          value={
            <time dateTime={detail.updatedAt} title={detail.updatedAt}>
              {new Date(detail.updatedAt).toLocaleString()}
            </time>
          }
        />
      </dl>
      {detail.kind === 'sensor' && <Params detail={detail} typeKnown={typeKnown} />}
    </>
  );
}

/**
 * Parameters, and the ones that are set but withheld.
 *
 * `redactedParams` is how the API says "this is configured, and you may not read it" — the value
 * is not masked, it is absent (`P-05`). Showing the distinction matters: an empty field and a set
 * credential look identical otherwise, and an operator would retype a secret that was fine.
 *
 * There are two reasons a parameter can be withheld and they are not interchangeable. Either the
 * sensor type marked it `writeOnly` — a genuine secret — or the type is not registered at all, in
 * which case the core cannot classify *any* of its parameters and conservatively withholds the
 * lot. Calling the second case "write-only" would tell an operator their timeout is a credential.
 */
function Params({
  detail,
  typeKnown,
}: {
  detail: ObjectDetail;
  typeKnown: boolean;
}): React.JSX.Element {
  const params = detail.params ?? {};
  const redacted = detail.redactedParams ?? [];
  const names = Object.keys(params);

  if (names.length === 0 && redacted.length === 0) {
    return <p className="mt-4 text-sm text-text-muted">No parameters.</p>;
  }

  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Parameters</h3>
      <dl className="mt-2 grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
        {names.map((name) => (
          <Field
            key={name}
            label={name}
            value={<span className="font-mono">{JSON.stringify(params[name])}</span>}
          />
        ))}
        {redacted.map((name) => (
          <Field
            key={name}
            label={name}
            value={
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="font-mono tracking-widest text-text-muted">
                  ••••••
                </span>
                {typeKnown ? (
                  <span className="rounded border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg">
                    set, write-only
                  </span>
                ) : (
                  <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning-fg">
                    withheld
                  </span>
                )}
              </span>
            }
          />
        ))}
      </dl>

      {!typeKnown && redacted.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          <code className="font-mono">{detail.sensorType}</code> is not a registered sensor type, so
          the core cannot tell which of its parameters are secrets and withholds all of them. The
          stored values are intact — registering the type shows them again.
        </p>
      )}
    </div>
  );
}

/**
 * Why this object is not being monitored (`M-08`).
 *
 * The three things an operator needs and a colour cannot say: until when, why, and — when the
 * pause came from somewhere else — which object to go and resume. A sensor under a paused device
 * has nothing of its own to clear, so telling it to "resume this sensor" would be telling it to
 * do something that does not work.
 */
function PausedBanner({ view }: { view: PauseView }): React.JSX.Element {
  const until = view.pausedUntil === null ? null : new Date(view.pausedUntil);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-paused-border bg-paused-bg px-3 py-2 text-sm text-paused-fg">
      <span className="font-medium">Paused{until === null ? ' indefinitely' : ''}</span>
      {until !== null && (
        <span>
          until{' '}
          <time dateTime={view.pausedUntil ?? ''} title={view.pausedUntil ?? ''}>
            {until.toLocaleString()}
          </time>
        </span>
      )}
      {view.message !== '' && <span className="opacity-90">— {view.message}</span>}
      {view.inheritedFrom !== null && (
        <span>
          by{' '}
          <Link
            to={`/objects/${String(view.inheritedFrom.objectId)}`}
            className="underline underline-offset-2"
          >
            {view.inheritedFrom.name}
          </Link>
          , which is where it can be resumed
        </span>
      )}
      {view.actor?.label !== null && view.actor !== null && (
        <span className="opacity-75">({view.actor.label})</span>
      )}
    </div>
  );
}
