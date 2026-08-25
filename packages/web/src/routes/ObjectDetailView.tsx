import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type {
  AuditPage,
  ChannelLimits,
  ChannelRecord,
  HistorySeries,
  ObjectDetail,
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
  const types = useApi<{ items: SensorTypeSummary[] }>(isSensor ? '/sensor-types' : null);

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
      <header className="space-y-1">
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
                      {channel.isPrimary && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                          primary
                        </span>
                      )}
                    </span>
                    <LimitBand limits={channel.limits} unit={channel.unit} />
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
}: {
  limits: ChannelLimits;
  unit: string;
}): React.JSX.Element | null {
  const show = (value: number): string =>
    unit === '' ? String(value) : `${String(value)} ${unit}`;
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
