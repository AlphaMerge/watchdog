import { useMemo, useState } from 'react';
import { useApi } from '../../api/client';
import type { HistoryChannel, HistorySeries } from '../../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../../components/Panels';
import { formatValue } from './ChannelTable';

/**
 * The three ranges PRTG's sensor page offers, and this one does too
 * (`CAPABILITIES.MD §8`).
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

export function HistoryPanel({ sensorId }: { sensorId: number }): React.JSX.Element {
  const [range, setRange] = useState<RangeId>('2d');
  const days = RANGES.find((entry) => entry.id === range)?.days ?? 2;

  // Anchored on mount and on each range change rather than on every render, so the request path
  // is stable and `useApi` does not refetch itself into a loop.
  const path = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return `/sensors/${String(sensorId)}/history?from=${from.toISOString()}&to=${to.toISOString()}`;
  }, [sensorId, days]);
  const history = useApi<HistorySeries>(path);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
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
              className={`rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                entry.id === range
                  ? 'border-accent bg-surface-muted font-medium text-text'
                  : 'border-border text-text-muted hover:text-text'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {history.status === 'loading' && <Loading what="history" />}
      {history.status === 'error' && <ErrorPanel error={history.error} retry={history.reload} />}
      {history.status === 'ready' && <Series series={history.data} />}
    </div>
  );
}

function Series({ series }: { series: HistorySeries }): React.JSX.Element {
  if (series.channels.length === 0) {
    return (
      <Empty because="Channels are declared by the sensor type; readings arrive once a probe runs the check.">
        No channels to chart.
      </Empty>
    );
  }

  return (
    <div className="space-y-5">
      <Provenance series={series} />
      {series.channels.map((channel) => (
        <Card key={channel.id}>
          <ChannelPlot channel={channel} buckets={series.buckets} />
        </Card>
      ))}
    </div>
  );
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

function formatSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}

export interface Extent {
  /** What the data actually spans. This is what a label may quote. */
  readonly low: number;
  readonly high: number;
  /** What the plot is scaled against, which is not always the same thing. */
  readonly floor: number;
  readonly ceiling: number;
  readonly present: number;
}

/**
 * The vertical extent a channel's plot needs, ignoring the gaps.
 *
 * **The measured range and the drawing scale are two different numbers, and conflating them
 * invents data.** A packet-loss channel that read 0 for two days has a range of 0 to 0; a plot
 * cannot divide by that, so the *scale* is padded to give the flat line somewhere to sit. Quoting
 * the padded scale in the label is how "-1 % to 1 %" appeared beside a channel that has never
 * been anything but zero — a negative packet loss, reported by the UI, about readings that do
 * not exist.
 */
export function extentOf(channel: HistoryChannel): Extent | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let present = 0;
  for (let index = 0; index < channel.avg.length; index += 1) {
    const min = channel.min[index];
    const max = channel.max[index];
    if (min === null || min === undefined || max === null || max === undefined) continue;
    present += 1;
    if (min < low) low = min;
    if (max > high) high = max;
  }
  if (present === 0) return null;
  if (low === high) {
    // A flat series. Pad by a tenth of its own magnitude so the line sits mid-height, and by 1
    // when the value is 0 and a tenth of it is nothing.
    const pad = Math.abs(low) === 0 ? 1 : Math.abs(low) / 10;
    return { low, high, floor: low - pad, ceiling: high + pad, present };
  }
  return { low, high, floor: low, ceiling: high, present };
}

/**
 * One channel's series, drawn as a column per bucket.
 *
 * **A gap is drawn as nothing, and this is the rule the whole storage layer exists to protect.**
 * `null` in `avg` means the sensor produced no reading — it was Down, or paused, or the probe
 * could not be reached — and a column drawn to the floor would report an outage as a perfect
 * score. There is no code path here that turns a null into a zero: the column is simply not
 * rendered, so the row has a hole in it exactly where the data has one.
 *
 * Not uPlot. `U-05` brings the real charts, with axes, cursors and the `dataviz` guidance; this
 * is the shape of the data at a glance and the gap rule enforced from the first day the page
 * exists, so the chart that replaces it has something to be checked against.
 */
function ChannelPlot({
  channel,
  buckets,
}: {
  channel: HistoryChannel;
  buckets: readonly string[];
}): React.JSX.Element {
  const extent = extentOf(channel);
  const gaps = channel.avg.length - (extent?.present ?? 0);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-text">
          {channel.name}
          {channel.unit !== '' && <span className="ml-1 text-text-muted">({channel.unit})</span>}
        </h3>
        <p className="text-xs text-text-muted">
          {extent === null
            ? 'no readings in this range'
            : extent.low === extent.high
              ? // Flat. "0 % to 0 %" is a worse sentence than the one fact it contains.
                `steady at ${formatValue(extent.low, channel.unit, null)}`
              : `${formatValue(extent.low, channel.unit, null)} to ${formatValue(extent.high, channel.unit, null)}`}
          {gaps > 0 &&
            ` · ${gaps.toLocaleString()} of ${channel.avg.length.toLocaleString()} buckets are gaps`}
        </p>
      </div>

      {extent === null ? (
        <p className="mt-2 rounded border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
          Nothing was recorded in this range.
        </p>
      ) : (
        <div
          className="mt-2 flex h-28 items-end gap-px rounded border border-border bg-surface-muted px-1 pb-1 pt-2"
          role="img"
          aria-label={plotDescription(channel, extent, gaps, buckets)}
        >
          {channel.avg.map((value, index) => {
            const min = channel.min[index] ?? null;
            const max = channel.max[index] ?? null;
            if (value === null || min === null || max === null) {
              // The gap. Nothing is drawn — not a zero-height bar, which would still be a mark
              // on the baseline and would read as "we measured, and it was nothing".
              return <span key={index} className="h-full flex-1" />;
            }
            const span = extent.ceiling - extent.floor;
            const bottom = ((min - extent.floor) / span) * 100;
            const top = ((max - extent.floor) / span) * 100;
            const mid = ((value - extent.floor) / span) * 100;
            return (
              <span
                key={index}
                className="relative h-full flex-1"
                title={tooltip(channel, index, buckets, value, min, max)}
              >
                {/* The bucket's range, then its average on top of it. Both, because an average
                    over an hour hides the spike that made somebody open this page. */}
                <span
                  className="absolute inset-x-0 rounded-[1px] bg-accent/25"
                  style={{
                    bottom: `${String(bottom)}%`,
                    height: `${String(Math.max(top - bottom, 1))}%`,
                  }}
                />
                <span
                  className="absolute inset-x-0 h-0.5 rounded-[1px] bg-accent"
                  style={{ bottom: `${String(mid)}%` }}
                />
              </span>
            );
          })}
        </div>
      )}

      <p className="mt-1 text-xs text-text-muted">
        Empty columns are gaps, not zeroes — a Down sensor records no channel values at all.
      </p>
    </div>
  );
}

function tooltip(
  channel: HistoryChannel,
  index: number,
  buckets: readonly string[],
  avg: number,
  min: number,
  max: number,
): string {
  const at = buckets[index];
  const when = at === undefined ? '' : `${new Date(at).toLocaleString()}: `;
  const unit = channel.unit;
  if (min === max) return `${when}${formatValue(avg, unit, null)}`;
  return `${when}${formatValue(avg, unit, null)} (${formatValue(min, unit, null)}–${formatValue(max, unit, null)})`;
}

/** What a screen reader is told instead of the columns. */
export function plotDescription(
  channel: HistoryChannel,
  extent: Extent,
  gaps: number,
  buckets: readonly string[],
): string {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const period =
    first === undefined || last === undefined
      ? ''
      : ` from ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}`;
  const holes =
    gaps === 0
      ? 'no gaps'
      : `${String(gaps)} of ${String(channel.avg.length)} buckets have no reading`;
  return `${channel.name}${period}: ${formatValue(extent.low, channel.unit, null)} to ${formatValue(extent.high, channel.unit, null)}, ${holes}.`;
}
