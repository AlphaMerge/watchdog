import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/client';
import type { HistoryChannel, HistorySeries } from '../../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../../components/Panels';
import { groupByUnit, groupExtent, hasReadings, type ChartGroup } from '../../charts/groups';
import { SeriesLegend } from '../../charts/SeriesLegend';
import { SeriesTable } from '../../charts/SeriesTable';
import { TimeSeriesChart, type ChartSeries } from '../../charts/TimeSeriesChart';
import { formatValue } from './ChannelTable';

/**
 * The three ranges PRTG's sensor page offers, and this one does too (`CAPABILITIES.MD §8`).
 *
 * They are not arbitrary: two days is "what happened on my shift", thirty is "is this getting
 * worse", a year is "what do I tell the auditor". The resolution is left to the server, which
 * has rules about it (`S-08`) and reports what it changed.
 */
export const RANGES = [
  { id: '2d', label: '2 days', days: 2 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '365d', label: '365 days', days: 365 },
] as const;

export type RangeId = (typeof RANGES)[number]['id'];

/**
 * Historic data, as charts (`U-05`).
 *
 * **One filter row above everything it scopes**, and the range and the view toggle both sit in
 * it: every panel re-renders against the same slice, so two panels can never disagree about what
 * period they are showing. A per-panel range control would guarantee that they eventually do.
 */
export function HistoryPanel({ sensorId }: { sensorId: number }): React.JSX.Element {
  const [range, setRange] = useState<RangeId>('2d');
  const [asTable, setAsTable] = useState(false);
  const days = RANGES.find((entry) => entry.id === range)?.days ?? 2;

  // Anchored on the range rather than on every render, so the request path is stable and
  // `useApi` does not refetch itself into a loop.
  const path = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return `/sensors/${String(sensorId)}/history?from=${from.toISOString()}&to=${to.toISOString()}`;
  }, [sensorId, days]);
  const history = useApi<HistorySeries>(path);

  // The last answer, kept so a range change holds the frame instead of flashing a skeleton. A
  // chart that vanishes and comes back moves everything below it twice, and the reader loses
  // their place in a page they were reading. Dimming says "this is the old slice" without
  // taking it away.
  const held = useRef<HistorySeries | null>(null);
  useEffect(() => {
    if (history.status === 'ready') held.current = history.data;
  }, [history]);
  const showing = history.status === 'ready' ? history.data : held.current;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span id="range-label" className="text-sm text-text-muted">
            Range
          </span>
          <div role="group" aria-labelledby="range-label" className="flex gap-1">
            {RANGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === range}
                onClick={() => {
                  setRange(entry.id);
                }}
                className={`border px-2 py-1 text-sm ${
                  entry.id === range
                    ? 'border-accent bg-surface-muted font-medium text-text'
                    : 'border-control text-text-muted hover:text-text'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => {
            setAsTable((held) => !held);
          }}
          className="border border-control px-2 py-1 text-sm text-text-muted hover:text-text"
        >
          {asTable ? 'Show charts' : 'Show table'}
        </button>
      </div>

      {history.status === 'error' && <ErrorPanel error={history.error} retry={history.reload} />}
      {history.status === 'loading' && showing === null && <Loading what="history" />}
      {showing !== null && history.status !== 'error' && (
        <div
          className={history.status === 'loading' ? 'opacity-50 transition-opacity' : undefined}
          aria-busy={history.status === 'loading'}
        >
          <Series series={showing} asTable={asTable} />
        </div>
      )}
    </div>
  );
}

function Series({
  series,
  asTable,
}: {
  series: HistorySeries;
  asTable: boolean;
}): React.JSX.Element {
  const groups = useMemo(() => groupByUnit(series.channels), [series.channels]);
  // uPlot's time scale wants epoch seconds.
  const times = useMemo(
    () => series.buckets.map((bucket) => Math.round(Date.parse(bucket) / 1_000)),
    [series.buckets],
  );

  if (series.channels.length === 0) {
    return (
      <Empty because="Channels are declared by the sensor type; readings arrive once a probe runs the check.">
        No channels to chart.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <Provenance series={series} />
      {asTable ? (
        <Card title="Readings">
          <SeriesTable
            channels={series.channels}
            buckets={series.buckets}
            format={(channel, value) => formatValue(value, channel.unit, null)}
            caption={`Every bucket from ${new Date(series.from).toLocaleString()} to ${new Date(series.to).toLocaleString()}, one column per channel. A dash is a bucket with no reading.`}
          />
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.unit === '' ? '(none)' : group.unit}>
            <Panel group={group} times={times} buckets={series.buckets} />
          </Card>
        ))
      )}
    </div>
  );
}

/**
 * One chart: the channels that share a unit.
 *
 * Never two units on one pair of axes. A second y-scale makes the crossing point of two lines an
 * artefact of where the axes were placed, and a reader takes it for a relationship — which is
 * why `groupByUnit` exists and why this component cannot be handed a mixed group.
 */
function Panel({
  group,
  times,
  buckets,
}: {
  group: ChartGroup;
  times: readonly number[];
  buckets: readonly string[];
}): React.JSX.Element {
  const chartSeries = useMemo<ChartSeries[]>(
    () =>
      group.series.map(({ channel, slot }) => ({
        label: channel.name,
        slot,
        avg: channel.avg,
        min: channel.min,
        max: channel.max,
      })),
    [group],
  );

  const decimals = group.series[0]?.channel.decimals ?? null;
  const format = useCallback((value: number) => formatValue(value, '', decimals), [decimals]);

  const extent = groupExtent(group);
  const drawable = group.series.filter(({ channel }) => hasReadings(channel));
  const heading =
    group.series.length === 1
      ? (group.series[0]?.channel.name ?? '')
      : `${group.unit === '' ? 'Unitless' : group.unit} channels`;

  const latest = group.series.map(({ channel }) => {
    const value = lastReading(channel);
    return value === null ? null : formatValue(value, channel.unit, channel.decimals);
  });

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm text-text">
          {heading}
          {group.series.length === 1 && group.unit !== '' && (
            <span className="ml-1 text-text-muted">({group.unit})</span>
          )}
        </h3>
        <p className="text-xs text-text-muted">{summarise(group, extent)}</p>
      </div>

      {drawable.length === 0 ? (
        <p className="mt-2 border border-dashed border-border px-3 py-8 text-center text-xs text-text-muted">
          Nothing was recorded in this range.
        </p>
      ) : (
        // The canvas carries no text an assistive technology can reach, so it is hidden from one
        // and the figure's caption plus the table view carry the data. Announcing an empty
        // graphic would be worse than announcing nothing.
        <figure className="mt-2">
          <div aria-hidden="true">
            <TimeSeriesChart times={times} series={chartSeries} format={format} label={heading} />
          </div>
          <figcaption className="sr-only">{describe(group, buckets, extent)}</figcaption>
        </figure>
      )}

      <SeriesLegend series={chartSeries} latest={latest} />

      <p className="mt-2 text-xs text-text-muted">
        Breaks in a line are gaps, not zeroes — a Down sensor records no channel values at all.
      </p>
    </div>
  );
}

/** The newest reading a channel has in this range, or null when it ends in a gap. */
export function lastReading(channel: HistoryChannel): number | null {
  for (let index = channel.avg.length - 1; index >= 0; index -= 1) {
    const value = channel.avg[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** The one-line range summary beside a panel heading. */
export function summarise(group: ChartGroup, extent: { low: number; high: number } | null): string {
  const buckets = group.series[0]?.channel.avg.length ?? 0;
  const gaps = group.series.reduce(
    (worst, { channel }) => Math.max(worst, channel.avg.filter((value) => value === null).length),
    0,
  );
  const unit = group.unit;
  const range =
    extent === null
      ? 'no readings in this range'
      : extent.low === extent.high
        ? // "0 % to 0 %" is a worse sentence than the one fact it contains — and quoting a
          // padded drawing scale here would invent a reading nobody took.
          `steady at ${formatValue(extent.low, unit, null)}`
        : `${formatValue(extent.low, unit, null)} to ${formatValue(extent.high, unit, null)}`;
  if (gaps === 0 || buckets === 0) return range;
  return `${range} · ${gaps.toLocaleString()} of ${buckets.toLocaleString()} buckets are gaps`;
}

/** What a screen reader is told instead of the canvas. */
export function describe(
  group: ChartGroup,
  buckets: readonly string[],
  extent: { low: number; high: number } | null,
): string {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const period =
    first === undefined || last === undefined
      ? ''
      : ` from ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}`;
  const names = group.series.map(({ channel }) => channel.name).join(', ');
  return `Line chart of ${names}${period}. ${summarise(group, extent)}. The same readings are in the table view.`;
}

/**
 * Where the numbers came from, and what the query rules changed about the request.
 *
 * "Where did this come from" is a question an operator eventually asks, and a range assembled
 * from a rollup tier plus the unmaterialised tail below it is exactly when they ask it (`S-08`).
 * Adjustments are shown because a 365-day range silently averaged over an hour would otherwise
 * look like a sensor that stopped fluctuating.
 */
function Provenance({ series }: { series: HistorySeries }): React.JSX.Element {
  return (
    <div className="space-y-1 text-xs text-text-muted">
      <p>
        {series.bucketCount.toLocaleString()} buckets of {formatSeconds(series.resolutionSeconds)},
        from {series.segments.map((segment) => segment.table).join(' + ') || 'no source'}.
      </p>
      {series.adjustments.map((adjustment, index) => (
        <p key={index} className="text-warning-fg">
          {adjustment.reason}
        </p>
      ))}
    </div>
  );
}

export function formatSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}
