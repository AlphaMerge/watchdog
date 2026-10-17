import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { sameWords, useApi, type ApiError } from '../api/client';
import { useStateStream, type LiveState } from '../api/stream';
import type {
  AncestorsView,
  AuditEntry,
  AuditPage,
  ChannelRecord,
  EffectiveAccess,
  LookupSummary,
  ObjectDetail,
  PauseView,
  SensorTypeSummary,
  SensorValues,
  SettingView,
} from '../api/types';
import { SessionContext } from '../auth/session';
import { FailurePhase } from '../components/FailurePhase';
import { HeldListFailure } from '../components/HeldListFailure';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TabPanel, Tabs } from '../components/Tabs';
import { rollup, stateFor } from '../tree/model';
import { ChannelTable } from './detail/ChannelTable';
import { asksForRight, mayWrite } from './detail/credentials-model';
import type { LookupEditing } from './detail/LookupControl';
import { CredentialsPanel } from './detail/CredentialsPanel';
import { HistoryPanel } from './detail/HistoryPanel';
import { SettingsPanel } from './detail/SettingsPanel';
import { StateLogPanel } from './detail/StateLogPanel';
import { ActorLink, MoreButton } from './LogsView';
import { usePaged } from './logs-model';
import { RELIST_MIN_MS, channelListIsStale, heldReadings, tabsFor } from './detail/model';
import { ParamsForm } from './detail/ParamsForm';
import { TargetPolicyException } from './detail/TargetPolicyException';
import { TriggersPanel } from './detail/TriggersPanel';
import { PageTitle } from '../components/PageTitle';

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
 * **Tabs rather than one long column**, and the tab lives in the URL. "Look at the triggers
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
  const objectPath = `/objects/${id}`;
  const object = useApi<ObjectDetail>(objectPath);
  // The object last read, **kept while it is read again** (`U-36`), as the channel list is
  // (`U-55`): a saved edit re-reads it, and the page used to give way to a loading line for the
  // length of that request, which took the parameters form with it — and with the form, focus,
  // the *Saved* line and what the core said about the save. Held against the path it was read
  // from, so a sensor's detail is never shown at another's address. Only through a `loading`; a
  // re-read that fails says so as it always has.
  const heldObject = useRef<{ path: string; data: ObjectDetail } | null>(null);
  useEffect(() => {
    if (object.status === 'ready' && object.answered !== null) {
      heldObject.current = { path: object.answered, data: object.data };
    }
  }, [object]);
  const shownObject =
    object.status === 'ready'
      ? object.data
      : object.status === 'loading' && heldObject.current?.path === objectPath
        ? heldObject.current.data
        : null;
  const numericId = Number(id);
  const isSensor = shownObject?.kind === 'sensor';

  const [params, setParams] = useSearchParams();
  const tabs = shownObject === null ? [] : tabsFor(shownObject);
  const requested = params.get('tab');
  const active = tabs.some((tab) => tab.id === requested) ? (requested ?? 'overview') : 'overview';

  const ancestors = useApi<AncestorsView>(shownObject === null ? null : `/objects/${id}/ancestors`);
  const channelsPath = isSensor ? `/objects/${id}/channels` : null;
  const channels = useApi<{ items: ChannelRecord[] }>(channelsPath);
  // The list last read, kept while it is read again (`U-55`), so a re-read does not take the
  // table away, and the hide box with it, for the length of a request. **Held against the path
  // it was read from, never against the page's id** (`U-55` review): this view stays mounted
  // from one sensor to the next, and on the first render after the id changes `useApi` still
  // holds the previous sensor's answer, so an id taken from the page then would file sensor 9's
  // channels under sensor 12, and keep them there if sensor 12's list could not be read.
  const heldChannels = useRef<{ path: string; items: readonly ChannelRecord[] } | null>(null);
  useEffect(() => {
    if (channels.status === 'ready' && channels.answered !== null) {
      heldChannels.current = { path: channels.answered, items: channels.data.items };
    }
  }, [channels]);
  const channelList =
    channelsPath === null
      ? null
      : channels.status === 'ready' && channels.answered === channelsPath
        ? channels.data.items
        : heldChannels.current?.path === channelsPath
          ? heldChannels.current.items
          : null;
  // Re-read when the values poll says the list is stale (`U-55`, `U-61`), at most once a minute:
  // a channel flapping, or a list and a poll that keep disagreeing, cannot turn every poll into a
  // second request. Monotonic, as anything measuring an interval is. Per sensor: the last re-read
  // is the previous sensor's, and holds nothing back here. **Each re-read also re-reads the
  // History tab's series** (`U-61`), through `relisted`: what made the list stale — a reading for
  // a retired channel, a channel an edit added — is a line its chart did not have, and a series
  // read once per range would not show it until the range changed. So it is bounded by the same
  // minute.
  const lastRelist = useRef<{ id: string; at: number } | null>(null);
  const [relisted, setRelisted] = useState(0);
  const reloadChannels = channels.reload;
  const relist = useCallback(() => {
    const now = performance.now();
    const last = lastRelist.current;
    if (last !== null && last.id === id && now - last.at < RELIST_MIN_MS) return;
    lastRelist.current = { id, at: now };
    reloadChannels();
    setRelisted((count) => count + 1);
  }, [reloadChannels, id]);

  // The readings, polled (see above), **by the page and not by the channel table** (`U-61`), so
  // that the History tab, which shows the list's retired marks and a chart per channel, learns
  // of a revived or a new channel while it is the tab open, as the Overview does. Only while one
  // of the two is open: no other tab shows a channel, and a tab returned to asks at once, since
  // its path coming back from null is a new read. The interval is cleared while the browser tab
  // is hidden, so a page left open on a second monitor is not asking every fifteen seconds for a
  // table nobody is looking at.
  const showsChannels = isSensor && (active === 'overview' || active === 'history');
  const valuesPath = showsChannels ? `/sensors/${id}/values` : null;
  const values = useApi<SensorValues>(valuesPath);
  const valuesAnswer = values.status === 'ready' ? values.data : null;
  // The readings last read, **kept while the next are read** (`U-71`): every poll reloads, and
  // `useApi` says `loading` for the length of each request, so the table used to be handed no
  // readings at all, every fifteen seconds, for as long as the core took to answer. Filled only
  // from `ready`, with the path it was read from (the sensor's own, so sensor 9's readings are
  // never shown under sensor 12's address, `U-55` review) and the moment it arrived, monotonic:
  // **a held reading is aged by the time it has been held** (`heldReadings`), so one that has
  // gone past the core's window says *no recent reading*, as a fresh answer would, rather than a
  // number that has stopped being current. No-data is not zero, and not an old number either.
  const heldValues = useRef<{ path: string; data: SensorValues; at: number } | null>(null);
  const valuesAnswered = values.answered;
  useEffect(() => {
    if (valuesAnswer !== null && valuesAnswered !== null) {
      heldValues.current = { path: valuesAnswered, data: valuesAnswer, at: performance.now() };
    }
  }, [valuesAnswer, valuesAnswered]);
  const held = heldValues.current;
  const shownValues =
    valuesPath === null
      ? null
      : valuesAnswer !== null
        ? { data: valuesAnswer, at: held !== null && held.data === valuesAnswer ? held.at : null }
        : held !== null && held.path === valuesPath
          ? held
          : null;
  const readings =
    shownValues === null
      ? null
      : heldReadings(
          shownValues.data,
          shownValues.at === null ? 0 : performance.now() - shownValues.at,
        );
  // The poll's failure said beside the held readings, **the first of a run in the same words,
  // until a read succeeds** (`U-71` review; `U-59`'s rule for `RunPanel`'s polls, and the shared
  // map's). Each poll fails with a new error and a new id, and handing `HeldListFailure` the
  // hook's own error would empty its region as every poll starts and fill it as it fails: the
  // same failure said four times a minute, to nobody who asked. So it is kept through the poll's
  // read and through a repeat in the same words, first id and all; a failure in other words
  // replaces it, and is said; a good read empties it. Filed with the path, so it is never another
  // sensor's. Set during render from the answer in hand, so never a render behind it. *Try
  // again*, pressed by the operator, sets it aside as its read starts, so the same failure after
  // it is said again: they asked.
  const [pollFailure, setPollFailure] = useState<{ path: string; error: ApiError } | null>(null);
  // The failure *Try again* set aside: the hook still holds it on the render the press makes,
  // before its read starts, and filed again then it would never leave the region.
  const [setAside, setSetAside] = useState<ApiError | null>(null);
  const failedNow =
    values.status === 'error' &&
    readings !== null &&
    valuesPath !== null &&
    values.error !== setAside
      ? values.error
      : null;
  if (values.status === 'ready' && pollFailure !== null) setPollFailure(null);
  if (
    failedNow !== null &&
    valuesPath !== null &&
    (pollFailure === null ||
      pollFailure.path !== valuesPath ||
      !sameWords(pollFailure.error, failedNow))
  ) {
    setPollFailure({ path: valuesPath, error: failedNow });
  }
  const heldFailure =
    pollFailure !== null && pollFailure.path === valuesPath ? pollFailure.error : null;
  const readAgain = (): void => {
    setPollFailure(null);
    if (values.status === 'error') setSetAside(values.error);
    values.reload();
  };
  // *Try again* on the values' error panel (no readings held), pressed for the error it shows:
  // out until that read answers, as `ErrorPanel` counts busy, since every failed read parses a
  // new error.
  const valuesRetriedFor = useRef<ApiError | null>(null);
  const retryValues = (): void => {
    if (values.status === 'error') valuesRetriedFor.current = values.error;
    values.retry();
  };
  // What a poll does, from the latest render. **It waits while that *Try again* is out** (`U-68`
  // review): a reload then took the panel, and the focus its button held, to the heading, from
  // under the read the operator had just asked for. With the panel up and no *Try again* out it
  // re-reads with the failure kept (`retry`), so the panel stays until a read answers. With
  // readings held a failure is said beside them (`HeldListFailure`), which keeps its own *Try
  // again* through a read the page starts on its own, so the poll reloads as it always has.
  const poll = useRef<() => void>(() => undefined);
  useEffect(() => {
    poll.current = () => {
      if (values.status !== 'error' || readings !== null) values.reload();
      else if (valuesRetriedFor.current !== values.error) values.retry();
    };
  });
  // Only to force a re-render on the interval. The ages themselves come from `Date.now()` at
  // render time — holding "now" in state means a component that re-renders for any other reason
  // redraws with a stale clock, and "58s ago" that has stopped counting is worse than no age.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!showsChannels) return;
    const refresh = (): void => {
      // Nothing is asked for while nobody is looking. `visibilitychange` fires on the way back,
      // so a tab returned to is current within a frame rather than fifteen seconds later.
      if (document.visibilityState !== 'visible') return;
      tick((count) => count + 1);
      poll.current();
    };
    const handle = window.setInterval(refresh, VALUES_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [showsChannels]);
  // Once per answer: keyed on the answer itself, not on every render. `useApi` never returns an
  // answer read for another sensor's path as this one's (`U-62`), and the list is this sensor's
  // or null.
  useEffect(() => {
    if (
      valuesAnswer !== null &&
      channelList !== null &&
      channelListIsStale(channelList, valuesAnswer)
    ) {
      relist();
    }
  }, [valuesAnswer, channelList, relist]);
  const settings = useApi<{ settings: SettingView[] }>(
    shownObject === null ? null : `/objects/${id}/settings`,
  );
  const pause = useApi<PauseView>(shownObject === null ? null : `/objects/${id}/pause`);
  const types = useApi<{ items: SensorTypeSummary[] }>(isSensor ? '/sensor-types' : null);
  const lookups = useApi<{ items: LookupSummary[] }>(isSensor ? '/lookups' : null);
  // Whether the channel table offers to set a channel's lookup (`U-82`): write on the sensor, as
  // the credentials tab asks it. From the session's context, not `useSession`, which throws
  // without one: the page is drawn in tests with no session, and there it offers nothing.
  const session = useContext(SessionContext)?.session;
  const access = useApi<EffectiveAccess>(
    isSensor && session !== undefined && asksForRight(session)
      ? `/objects/${id}/access/effective`
      : null,
  );
  const setsLookups = session !== undefined && mayWrite(session, access);

  // Live, over the stream. For a container this is every sensor beneath it, which is what the
  // header badge rolls up — the same computation the tree does, from the same source.
  const live = useStateStream(Number.isFinite(numericId) ? numericId : null);

  if (object.status === 'error') return <ErrorPanel error={object.error} retry={object.retry} />;
  if (shownObject === null) return <Loading what="the object" />;

  const detail = shownObject;
  // In the URL, as the alarm list's filters are (`U-38` review): the channel table was swapped for
  // an error panel whenever a poll of its values failed (now only when no readings are held,
  // `U-71`), so a choice held inside it was dropped by one failed poll and every retired row came
  // back unannounced. Absent, they are shown, as the
  // alarm list shows acknowledged alarms until asked not to: a channel an edit has just taken out
  // stays in sight, marked, with its limits still settable for the day it is put back.
  const hideRetired = params.get('retired') === 'hide';

  // Each writes its own parameter and keeps the others, so changing tab keeps the filter.
  // Replace rather than push: six tabs would otherwise leave the back button walking through
  // every one somebody glanced at before it left the page.
  const setParam = (name: string, value: string | null): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };
  const select = (tab: string): void => {
    setParam('tab', tab === 'overview' ? null : tab);
  };
  const setHideRetired = (hide: boolean): void => {
    setParam('retired', hide ? 'hide' : null);
  };

  // A re-read of the held list that failed (`U-67`), said beside it on either tab that shows it.
  // The retry is the hook's own `reload`, not `relist`, whose minute would hold it back (`U-60`).
  // When a good read takes *Try again* away, focus goes to the tab's panel, which is focusable,
  // named by its tab, and holds the list.
  const listFailure =
    channelList !== null ? (
      <HeldListFailure
        what="The channel list"
        error={channels.status === 'error' ? channels.error : null}
        reading={channels.status === 'loading'}
        onRetry={channels.reload}
        focusAfter={() => {
          document.getElementById(`panel-${active}`)?.focus();
        }}
      />
    ) : null;

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
        <TabPanel id="overview" keepsFocus>
          <div className="space-y-4">
            {detail.kind === 'sensor' && (
              <Card title="Channels">
                {listFailure}
                <LiveChannels
                  sensorType={detail.sensorType}
                  channels={channelList}
                  listError={
                    channelList === null && channels.status === 'error' ? channels.error : null
                  }
                  onRetryList={channels.reload}
                  readings={readings}
                  readingsError={values.status === 'error' ? values.error : null}
                  reading={
                    values.status === 'loading' ||
                    // Pressed, and the hook not yet `loading`: its read is starting.
                    (values.status === 'error' && values.error === setAside)
                  }
                  onRetryReadings={retryValues}
                  heldFailure={heldFailure}
                  onReadAgain={readAgain}
                  lookups={lookups.status === 'ready' ? lookups.data.items : null}
                  hideRetired={hideRetired}
                  onHideRetiredChange={setHideRetired}
                  editing={
                    setsLookups
                      ? {
                          sensorId: detail.id,
                          version: detail.version,
                          pending: object.status === 'loading' || channels.status === 'loading',
                          // The write moved the sensor's version: both, or the next save of
                          // the parameters below would be refused as somebody else's change.
                          onSaved: () => {
                            channels.reload();
                            object.reload();
                          },
                        }
                      : undefined
                  }
                />
              </Card>
            )}
            <Card title="Configuration">
              <Configuration detail={detail} />
            </Card>
            {detail.kind === 'device' && (
              <Card title="Target policy exception">
                <TargetPolicyException detail={detail} onSaved={object.reload} />
              </Card>
            )}
            {detail.kind === 'sensor' && (
              <Card title="Parameters">
                {types.status === 'loading' && <Loading what="the sensor type" />}
                {types.status === 'error' && <ErrorPanel error={types.error} retry={types.retry} />}
                {types.status === 'ready' && (
                  <ParamsForm
                    detail={detail}
                    type={types.data.items.find((type) => type.id === detail.sensorType)}
                    channels={channelList}
                    onSaved={object.reload}
                  />
                )}
              </Card>
            )}
          </div>
        </TabPanel>
      )}

      {active === 'history' && (
        <TabPanel id="history" keepsFocus>
          {listFailure}
          {/* The same `?retired=hide` as the channel table (`U-55`): one choice for the page. */}
          <HistoryPanel
            sensorId={detail.id}
            channels={channelList}
            refreshed={relisted}
            hideRetired={hideRetired}
            onHideRetiredChange={setHideRetired}
          />
        </TabPanel>
      )}

      {active === 'log' && (
        <TabPanel id="log" keepsFocus>
          <Card title="State changes">
            <StateLogPanel objectId={detail.id} isSensor={detail.kind === 'sensor'} />
          </Card>
        </TabPanel>
      )}

      {active === 'settings' && (
        <TabPanel id="settings" keepsFocus>
          <Card title="Settings">
            {settings.status === 'loading' && <Loading what="settings" />}
            {settings.status === 'error' && (
              <ErrorPanel error={settings.error} retry={settings.retry} />
            )}
            {settings.status === 'ready' && (
              <SettingsPanel
                objectId={detail.id}
                items={settings.data.settings}
                ancestors={ancestors.status === 'ready' ? ancestors.data.items : null}
                onChanged={settings.reload}
              />
            )}
          </Card>
        </TabPanel>
      )}

      {active === 'credentials' && (
        <TabPanel id="credentials" keepsFocus>
          {/* Keyed by the object: a link from an inherited set goes to its owner's tab, which is
              this same component, and a form left open must not follow it there. */}
          <CredentialsPanel
            key={detail.id}
            object={detail}
            ancestors={ancestors.status === 'ready' ? ancestors.data.items : null}
          />
        </TabPanel>
      )}

      {active === 'triggers' && (
        <TabPanel id="triggers" keepsFocus>
          <Card title="Notification triggers">
            <TriggersPanel objectId={detail.id} inheritsTriggers={detail.inheritsTriggers} />
          </Card>
        </TabPanel>
      )}

      {active === 'changes' && (
        <TabPanel id="changes" keepsFocus>
          <Card title="Configuration history">
            <AuditPanel objectId={detail.id} />
          </Card>
        </TabPanel>
      )}
    </div>
  );
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
        <PageTitle title={detail.name} />
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
        {/* The alarms view scopes to a subtree; this is how somebody gets there from an object
            rather than by editing a query string. */}
        <span className="ml-auto flex shrink-0 gap-3 text-xs">
          {detail.kind === 'device' && (
            <Link
              to={`/objects/${String(detail.id)}/add-sensor`}
              className="text-accent hover:underline"
            >
              + Add a sensor
            </Link>
          )}
          <Link
            to={`/alarms?objectId=${String(detail.id)}`}
            className="text-accent hover:underline"
          >
            Alarms here →
          </Link>
          <Link to={`/logs?objectId=${String(detail.id)}`} className="text-accent hover:underline">
            Logs →
          </Link>
        </span>
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
      {/* Where its check failed (`P-285`), between why and what the check said: the part an
          operator acts on. Not live: this line changes with every frame. */}
      {live.failure !== null && (
        <span>
          · <FailurePhase failure={live.failure} />
        </span>
      )}
      {live.message !== '' && <span className="text-text-muted">— {live.message}</span>}
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
 * Polled rather than streamed — see the note on the page above. The page polls (`U-61`), since
 * the poll is also how it learns its channel list is stale (`U-55`) whichever tab is open: the
 * list is read once, and `/values` carries the list's own `retired`, so an answer that disagrees
 * with it (a reading has made a retired channel live, an edit has added one) asks the page to
 * read the list again. An answer that agrees asks for nothing.
 */
function LiveChannels({
  sensorType,
  channels,
  listError,
  onRetryList,
  readings,
  readingsError,
  heldFailure,
  reading,
  onRetryReadings,
  onReadAgain,
  lookups,
  hideRetired,
  onHideRetiredChange,
  editing,
}: {
  sensorType: string | undefined;
  channels: readonly ChannelRecord[] | null;
  /** Why there is no list, when its read failed and none is held for this sensor (`U-60`). */
  listError: ApiError | null;
  /** Reads the list again: not the page's `relist`, whose once-a-minute cap would hold it back. */
  onRetryList: () => void;
  /**
   * The page's poll of the readings: the last answer read for this sensor, held through the next
   * read and aged by how long it has been held (`U-71`), or null while none has been read.
   */
  readings: SensorValues | null;
  /** The last poll's failure, for the error panel when no readings are held. */
  readingsError: ApiError | null;
  /** The poll's failure said beside held readings: the first of a run in the same words. */
  heldFailure: ApiError | null;
  /** A poll is out. */
  reading: boolean;
  /** The error panel's *Try again*, which keeps the failure in hand while it re-reads (`U-68`). */
  onRetryReadings: () => void;
  /** The held readings' *Try again*, which sets the failure shown aside and reads again. */
  onReadAgain: () => void;
  lookups: readonly LookupSummary[] | null;
  hideRetired: boolean;
  onHideRetiredChange: (hide: boolean) => void;
  /** Given to a caller who may write the sensor: the table then sets lookups (`U-82`). */
  editing: LookupEditing | undefined;
}): React.JSX.Element {
  if (channels === null) {
    return (
      <>
        {listError === null && <Loading what="channels" />}
        {/* The list's read failing (`U-60`), which used to leave *Loading channels…* up for good.
            **Always there while there is no list, empty until the read fails**: a region added
            with its text already in it is not reliably announced (`U-41`), so this is the node the
            failure lands in, on opening the page and after moving from another sensor alike, and
            a retry empties it as it starts, so the same failure is said again. **Polite, as
            `RunPanel`'s first read is** (`U-56`): nothing the operator asked for was refused; it
            is the same kind of news as the loading line it takes the place of. No margin: one or
            the other is shown, never both. */}
        <div role="status">
          {listError !== null && <ErrorPanel error={listError} retry={onRetryList} inRegion />}
        </div>
      </>
    );
  }
  // No readings held for this sensor: its first read failed, and that is all there is to say.
  if (readings === null && readingsError !== null) {
    return <ErrorPanel error={readingsError} retry={onRetryReadings} />;
  }

  return (
    <>
      {/* A poll that failed with readings held (`U-71`): said beside them, which stay, rather than
          an error panel in the table's place. There, empty, from the moment readings are held, so
          a failure lands in a node that was (`U-67`). When a good read takes *Try again* from
          under focus, focus goes to the Overview's panel, as the channel list's does. */}
      {readings !== null && (
        <HeldListFailure
          what="The readings"
          held="these are the ones read before, each as old as it says"
          error={heldFailure}
          reading={reading}
          onRetry={onReadAgain}
          focusAfter={() => {
            document.getElementById('panel-overview')?.focus();
          }}
        />
      )}
      <ChannelTable
        channels={channels}
        sensorType={sensorType}
        values={readings}
        lookups={lookups}
        now={Date.now()}
        hideRetired={hideRetired}
        onHideRetiredChange={onHideRetiredChange}
        editing={editing}
      />
    </>
  );
}

/**
 * This object's configuration history (`A-08`).
 *
 * **Paged, and it has to be.** A device that has been in service two years has more than fifty
 * changes against it, and a panel that silently stops at the newest fifty is one that answers
 * "when was this last touched?" correctly and "who changed the interval last spring?" not at
 * all — while looking identical either way.
 */
function AuditPanel({ objectId }: { objectId: number }): React.JSX.Element {
  const base = `/objects/${String(objectId)}/audit?limit=50`;
  const audit = usePaged<AuditEntry, string>(
    base,
    (page) => (page as AuditPage).nextBefore,
    (cursor) => `${base}&before=${encodeURIComponent(cursor)}`,
  );

  if (audit.status === 'loading') return <Loading what="the audit log" />;
  if (audit.status === 'error' && audit.error !== null) {
    return <ErrorPanel error={audit.error} retry={audit.retry} />;
  }
  if (audit.items.length === 0) {
    return <Empty>Nothing has changed this object.</Empty>;
  }

  return (
    <>
      <ul className="divide-y divide-border text-sm">
        {audit.items.map((entry) => (
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
        ))}
      </ul>
      <MoreButton
        more={audit.more}
        loading={audit.loadingMore}
        count={audit.items.length}
        what="history of this object"
      />
    </>
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

function Configuration({ detail }: { detail: ObjectDetail }): React.JSX.Element {
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
    </>
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-paused-border bg-paused-bg px-3 py-2 text-sm text-paused-fg">
      <span className="font-medium">Paused{until === null ? ' indefinitely' : ''}</span>
      {until !== null && (
        <span>
          until{' '}
          <time dateTime={view.pausedUntil ?? ''} title={view.pausedUntil ?? ''}>
            {until.toLocaleString()}
          </time>
        </span>
      )}
      {view.message !== '' && <span className="text-text-muted">— {view.message}</span>}
      {view.inheritedFrom !== null &&
        (view.inheritedFrom.name === null ? (
          // Paused from above the branch this account was granted: it can say so, and not by
          // what — the container is outside what it may see (`A-12`).
          <span>by an object outside your view</span>
        ) : (
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
        ))}
      {view.actor?.label !== null && view.actor !== null && (
        <span className="text-text-muted">({view.actor.label})</span>
      )}
    </div>
  );
}
