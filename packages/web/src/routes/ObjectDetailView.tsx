import { Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type {
  AuditPage,
  ChannelLimits,
  ChannelRecord,
  LookupSummary,
  HistorySeries,
  ObjectDetail,
  PauseView,
  SettingView,
  SensorStateView,
  SensorTypeSummary,
} from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';

export function ObjectDetailView(): React.JSX.Element {
  const { id = '' } = useParams();
  const object = useApi<ObjectDetail>(`/objects/${id}`);
  const isSensor = object.status === 'ready' && object.data.kind === 'sensor';

  const channels = useApi<{ items: ChannelRecord[] }>(
    object.status === 'ready' ? `/objects/${id}/channels` : null,
  );
  const audit = useApi<AuditPage>(
    object.status === 'ready' ? `/objects/${id}/audit?limit=10` : null,
  );
  const history = useApi<HistorySeries>(isSensor ? `/sensors/${id}/history` : null);
  // Read separately from the object, because it is the one thing here that changes on its own:
  // the object read is conditional and a live state behind an ETag would be served stale.
  const state = useApi<SensorStateView>(isSensor ? `/sensors/${id}/state` : null);
  const pause = useApi<PauseView>(object.status === 'ready' ? `/objects/${id}/pause` : null);
  const settings = useApi<{ settings: SettingView[] }>(
    object.status === 'ready' ? `/objects/${id}/settings` : null,
  );
  const types = useApi<{ items: SensorTypeSummary[] }>(isSensor ? '/sensor-types' : null);
  const lookups = useApi<{ items: LookupSummary[] }>(isSensor ? '/lookups' : null);

  // Whether the catalogue knows this sensor's type changes what withheld parameters *mean*.
  const typeKnown =
    object.status === 'ready' &&
    object.data.sensorType !== undefined &&
    types.status === 'ready' &&
    types.data.items.some((type) => type.id === object.data.sensorType);

  if (object.status === 'loading') return <Loading what="the object" />;
  if (object.status === 'error') return <ErrorPanel error={object.error} retry={object.reload} />;

  const detail = object.data;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link to="/tree" className="text-sm text-accent hover:underline">
          ← Tree
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-text">{detail.name}</h1>
          <span className="text-xs uppercase tracking-wide text-text-muted">{detail.kind}</span>
          {detail.kind === 'sensor' && state.status === 'ready' && (
            <SensorState view={state.data} />
          )}
        </div>
        {pause.status === 'ready' && pause.data.paused && <PausedBanner view={pause.data} />}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Configuration">
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
            <Field label="Updated" value={new Date(detail.updatedAt).toLocaleString()} />
          </dl>

          {detail.kind === 'sensor' && <Params detail={detail} typeKnown={typeKnown} />}
        </Card>

        <Card title="Scanning">
          {settings.status === 'loading' && <Loading what="settings" />}
          {settings.status === 'error' && <ErrorPanel error={settings.error} />}
          {settings.status === 'ready' && <Scanning items={settings.data.settings} />}
        </Card>

        <Card title="Channels">
          {channels.status === 'loading' && <Loading what="channels" />}
          {channels.status === 'error' && <ErrorPanel error={channels.error} />}
          {channels.status === 'ready' &&
            (channels.data.items.length === 0 ? (
              <Empty because="A sensor type declares its channels, so they exist from the moment the sensor does (P-05).">
                No channels.
              </Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {channels.data.items.map((channel) => (
                  <li key={channel.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="font-mono text-text">{channel.key}</span>
                    <span className="flex items-center gap-2 text-text-muted">
                      {channel.name}
                      {channel.unit !== '' && <span className="opacity-70">({channel.unit})</span>}
                      <ProcessingNote channel={channel} />
                      {channel.isPrimary && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                          primary
                        </span>
                      )}
                    </span>
                    <ChannelJudgement
                      channel={channel}
                      loaded={lookups.status === 'ready' ? lookups.data.items : null}
                    />
                  </li>
                ))}
              </ul>
            ))}
        </Card>
      </div>

      {isSensor && (
        <Card title="History — last 2 days">
          {history.status === 'loading' && <Loading what="history" />}
          {history.status === 'error' && (
            <ErrorPanel error={history.error} retry={history.reload} />
          )}
          {history.status === 'ready' && <History series={history.data} />}
        </Card>
      )}

      <Card title="Recent changes">
        {audit.status === 'loading' && <Loading what="the audit log" />}
        {audit.status === 'error' && <ErrorPanel error={audit.error} />}
        {audit.status === 'ready' &&
          (audit.data.items.length === 0 ? (
            <Empty>Nothing has changed this object.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {audit.data.items.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="font-mono text-xs text-text-muted">
                    {new Date(entry.at).toLocaleString()}
                  </span>
                  <span className="font-medium text-text">{entry.action}</span>
                  <span className="text-text-muted">{entry.actor.kind}</span>
                </li>
              ))}
            </ul>
          ))}
      </Card>
    </div>
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

/**
 * Parameters, and the ones that are set but withheld.
 *
 * `redactedParams` is how the API says "this is configured, and you may not read it" — the value
 * is not masked, it is absent (P-05). Showing the distinction matters: an empty field and a set
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
 * A gap-aware strip, one cell per bucket.
 *
 * Not a chart — `U-05` is uPlot per the `dataviz` guidance. But it enforces the same rule the
 * charts will have to: a bucket with no reading is drawn as *absent*, never as zero. Reading
 * "no data" as a floor of zero is how a monitoring system reports an outage as perfect health.
 */
function History({ series }: { series: HistorySeries }): React.JSX.Element {
  if (series.channels.length === 0) {
    return (
      <Empty because="Channels are declared by the sensor type; readings arrive once a probe runs the check.">
        No channels to chart.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        {series.bucketCount} buckets at {series.resolutionSeconds}s, from{' '}
        {series.segments.map((segment) => segment.table).join(' + ') || 'no source'}.
      </p>

      {series.channels.map((channel) => {
        const present = channel.avg.filter((value) => value !== null).length;
        return (
          <div key={channel.id}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-text">
                {channel.name}
                {channel.unit !== '' && (
                  <span className="ml-1 text-text-muted">({channel.unit})</span>
                )}
              </span>
              <span className="text-xs text-text-muted">
                {present} of {channel.avg.length} buckets have data
              </span>
            </div>
            <div
              className="mt-1 flex h-6 gap-px overflow-hidden rounded border border-border"
              role="img"
              aria-label={`${channel.name}: ${String(present)} of ${String(channel.avg.length)} buckets have data, the rest are gaps`}
            >
              {channel.avg.map((value, index) => (
                <span
                  key={index}
                  className={`h-full flex-1 ${value === null ? 'bg-surface-muted' : 'bg-up-fg'}`}
                />
              ))}
            </div>
          </div>
        );
      })}

      <p className="text-xs text-text-muted">
        Empty cells are gaps, not zeroes — a Down sensor records no channel values at all.
      </p>
    </div>
  );
}

/**
 * The badge, plus the part of a state that is not the state: why, and since when.
 *
 * "Down" on its own is what an operator already knows from the colour. The cause is what tells
 * them where to look, and it is the reason every transition records one.
 */
function SensorState({ view }: { view: SensorStateView }): React.JSX.Element {
  const since = new Date(view.since);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge state={view.state} size="sm" />
      <span className="text-xs text-text-muted">
        {view.cause} · since{' '}
        <time dateTime={view.since} title={view.since}>
          {since.toLocaleString()}
        </time>
        {view.pausedBy.length > 1 && ` · also paused by ${view.pausedBy.slice(1).join(', ')}`}
      </span>
    </span>
  );
}

/**
 * The thresholds a channel is judged against (`M-04`), from the outside in.
 *
 * Ordered the way the number line is — lower error, lower warning, upper warning, upper error —
 * so the band an operator wants the reading to stay inside is the gap in the middle, and reads
 * as one thing rather than four independent facts.
 *
 * Read-only here. `U-08` generates the form.
 */
function LimitBand({
  limits,
  unit,
  decimals,
}: {
  limits: ChannelLimits;
  unit: string;
  /** The channel's own display precision, or null when it has none. */
  decimals: number | null;
}): React.JSX.Element | null {
  // At the channel's precision, because a limit shown as "500" on a channel that reads "499.98"
  // reads like a threshold nobody crossed.
  const show = (value: number): string => {
    const shown = decimals === null ? String(value) : value.toFixed(decimals);
    return unit === '' ? shown : `${shown} ${unit}`;
  };
  const parts: string[] = [];
  if (limits.lowerError !== null) parts.push(`error < ${show(limits.lowerError)}`);
  if (limits.lowerWarning !== null) parts.push(`warn < ${show(limits.lowerWarning)}`);
  if (limits.upperWarning !== null) parts.push(`warn > ${show(limits.upperWarning)}`);
  if (limits.upperError !== null) parts.push(`error > ${show(limits.upperError)}`);
  if (parts.length === 0) return null;

  return (
    <span className="ml-auto flex items-center gap-2 text-xs text-text-muted">
      <span className="font-mono">{parts.join(' · ')}</span>
      {/* Configured but not acting. Saying so beats showing thresholds that do nothing. */}
      {!limits.enabled && (
        <span className="rounded border border-border px-1.5 py-0.5">not enforced</span>
      )}
    </span>
  );
}

/**
 * The three settings that decide when and how a sensor is checked, and where each comes from.
 *
 * `scan.retryWarnings` is here because it is the answer to "why does this say Warning and not
 * Down" (`M-03`), and that question is asked at exactly this page. Read-only — `U-08` generates
 * the form and `U-09` the inherit/override control.
 */
function Scanning({ items }: { items: SettingView[] }): React.JSX.Element {
  const shown = items.filter((setting) => setting.key.startsWith('scan.'));
  if (shown.length === 0) return <Empty because="Nothing scannable here.">No scan settings.</Empty>;

  return (
    <dl className="grid grid-cols-[11rem_1fr] gap-x-4 gap-y-2 text-sm">
      {shown.map((setting) => (
        <Fragment key={setting.key}>
          <dt className="font-mono text-xs text-text-muted" title={setting.description}>
            {setting.key}
          </dt>
          <dd className="flex flex-wrap items-baseline gap-2 text-text">
            <span className="font-mono">{String(setting.effective.value)}</span>
            <SettingOrigin source={setting.effective.source} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Where a value came from. Text, not a colour: this is the part an operator has to act on. */
function SettingOrigin({
  source,
}: {
  source: SettingView['effective']['source'];
}): React.JSX.Element {
  if (source.kind === 'own') return <span className="text-xs text-text-muted">set here</span>;
  if (source.kind === 'default') {
    return <span className="text-xs text-text-muted">registry default</span>;
  }
  return (
    <Link
      to={`/objects/${String(source.objectId)}`}
      className="text-xs text-accent hover:underline"
    >
      inherited from #{source.objectId}
    </Link>
  );
}

/**
 * What decides this channel's state: a lookup, or its limits.
 *
 * One or the other, never both (`M-06`), so showing both would misrepresent what is actually in
 * charge. A channel naming a lookup this installation has not loaded says so — that is a real
 * situation with a real consequence (the channel reads Warning and nothing can interpret it),
 * and it is exactly the case a UI showing only the id would hide.
 */
function ChannelJudgement({
  channel,
  loaded,
}: {
  channel: ChannelRecord;
  loaded: LookupSummary[] | null;
}): React.JSX.Element | null {
  if (channel.lookupId === null) {
    return <LimitBand limits={channel.limits} unit={channel.unit} decimals={channel.decimals} />;
  }

  const known = loaded === null || loaded.some((lookup) => lookup.id === channel.lookupId);
  return (
    <span className="ml-auto flex items-center gap-2 text-xs text-text-muted">
      <span className="font-mono">{channel.lookupId}</span>
      {!known && (
        <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-warning-fg">
          not loaded
        </span>
      )}
    </span>
  );
}

/**
 * What happens to a reading before anything judges it (`M-07`).
 *
 * Beside the unit, because that is what it changes: a channel scaled by 8 is not reporting the
 * number the device sent, and an operator reading a graph has to know that before they compare
 * it with anything else.
 */
function ProcessingNote({ channel }: { channel: ChannelRecord }): React.JSX.Element | null {
  const parts: string[] = [];
  if (channel.scaleMul !== '1') parts.push(`×${channel.scaleMul}`);
  if (channel.scaleDiv !== '1') parts.push(`÷${channel.scaleDiv}`);
  if (channel.spikeMin !== null || channel.spikeMax !== null) {
    const low = channel.spikeMin === null ? '' : String(channel.spikeMin);
    const high = channel.spikeMax === null ? '' : String(channel.spikeMax);
    parts.push(`spike ${low}–${high}`);
  }
  if (parts.length === 0) return null;

  return (
    <span
      className="rounded border border-border px-1.5 py-0.5 font-mono text-xs"
      title="Applied before the reading is stored or judged"
    >
      {parts.join(' ')}
    </span>
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
      <span className="font-medium">
        Paused
        {until === null ? ' indefinitely' : ''}
      </span>
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
