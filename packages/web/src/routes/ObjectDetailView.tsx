import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type {
  AuditPage,
  ChannelRecord,
  HistorySeries,
  ObjectDetail,
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
          {detail.kind === 'sensor' && <StatusBadge state="unknown" size="sm" />}
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
                  <li key={channel.id} className="flex items-center justify-between gap-3 py-2">
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
