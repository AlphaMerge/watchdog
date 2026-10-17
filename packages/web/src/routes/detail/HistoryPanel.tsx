import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/client';
import type { ChannelRecord, HistoryChannel, HistorySeries } from '../../api/types';
import { HeldListFailure } from '../../components/HeldListFailure';
import { Card, Empty } from '../../components/Panels';
import { groupByUnit, groupExtent, hasReadings, type ChartGroup } from '@ms/shared/charts';
import { SeriesLegend } from '../../charts/SeriesLegend';
import { SeriesTable } from '../../charts/SeriesTable';
import { TimeSeriesChart } from '../../charts/TimeSeriesChart';
import { seriesName, type ChartSeries } from '../../charts/time-series-model';
import { HideRetired } from './HideRetired';
import {
  RANGES,
  describe,
  formatSeconds,
  formatValue,
  lastReading,
  summarise,
  type RangeId,
} from './model';
import { ReadRegion } from '../../components/ReadRegion';

/**
 * Historic data, as charts (`U-05`).
 *
 * **One filter row above everything it scopes**, and the range and the view toggle both sit in
 * it: every panel re-renders against the same slice, so two panels can never disagree about what
 * period they are showing. A per-panel range control would guarantee that they eventually do.
 */
export function HistoryPanel({
  sensorId,
  channels = null,
  refreshed = 0,
  hideRetired,
  onHideRetiredChange,
}: {
  sensorId: number;
  /**
   * The channel list, for which channels are retired (`U-37`). The history answer does not say,
   * and asking the list rather than a second derivation keeps the two from disagreeing.
   */
  channels?: readonly ChannelRecord[] | null;
  /**
   * How many times the page has read the channel list again (`U-61`). Each change reads the
   * series again, up to now: what made the list stale (a reading for a retired channel, a channel
   * an edit added) is a line this chart did not have. Bounded by the page's once-a-minute re-read.
   */
  refreshed?: number;
  /**
   * Whether retired channels are left out (`U-55`): the page's `?retired=hide`, the same choice
   * the channel table makes, held by the page so it survives what unmounts this panel.
   */
  hideRetired: boolean;
  onHideRetiredChange: (hide: boolean) => void;
}): React.JSX.Element {
  const [range, setRange] = useState<RangeId>('2d');
  const [asTable, setAsTable] = useState(false);
  const days = RANGES.find((entry) => entry.id === range)?.days ?? 2;
  // Where the range ends: set when a range is chosen, and again when the page reads its channel
  // list again (`U-61`), never on every render.
  const [end, setEnd] = useState(() => Date.now());

  // Anchored on the range's end rather than on every render, so the request path is stable and
  // `useApi` does not refetch itself into a loop. A new end is a new path, so the answer in hand
  // is held, dimmed, while the next is read, as it is for a range change.
  const path = useMemo(() => {
    const to = new Date(end);
    const from = new Date(to.getTime() - days * 86_400_000);
    return `/sensors/${String(sensorId)}/history?from=${from.toISOString()}&to=${to.toISOString()}`;
  }, [sensorId, days, end]);
  const history = useApi<HistorySeries>(path);

  // Read again when the page has read its list again. `reload` as well as a new end: within the
  // same millisecond the end, and so the path, would be the one already read, and nothing would
  // be asked. Both land in one render, so it is one request either way.
  const refreshedSeen = useRef(refreshed);
  const reloadHistory = history.reload;
  useEffect(() => {
    if (refreshedSeen.current === refreshed) return;
    refreshedSeen.current = refreshed;
    setEnd(Date.now());
    reloadHistory();
  }, [refreshed, reloadHistory]);

  // The last answer, kept so a range change holds the frame instead of flashing a skeleton. A
  // chart that vanishes and comes back moves everything below it twice, and the reader loses
  // their place in a page they were reading. Dimming says "this is the old slice" without
  // taking it away.
  //
  // **Held against what it is a series of** — this sensor, this range — **and kept when a read of
  // the same one fails** (`U-61` review, as `U-67` keeps a held list). The page reads the series
  // again on its own when it re-reads its channel list, and that read can fail with nobody having
  // done anything: an error panel in its place took away a correct chart somebody was reading. So
  // the chart stays and the failure is said beside it, with *Try again*. A read for another range
  // that fails is still the error panel: the series in hand is not the one the pressed range
  // button names, and showing it as if it were would be wrong.
  const slice = `${String(sensorId)}:${String(days)}`;
  const held = useRef<{ slice: string; series: HistorySeries } | null>(null);
  useEffect(() => {
    if (history.status === 'ready') held.current = { slice, series: history.data };
  }, [history, slice]);
  const showing = history.status === 'ready' ? history.data : (held.current?.series ?? null);
  const kept = history.status === 'error' && held.current?.slice === slice;
  const rangeButtons = useRef<HTMLDivElement>(null);
  const focusRange = useCallback(() => {
    rangeButtons.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, []);
  const retired = useMemo(
    () =>
      new Set((channels ?? []).filter((channel) => channel.retired).map((channel) => channel.id)),
    [channels],
  );
  // The retired channels this answer charts, which is what the box would hide.
  const retiredCount = showing?.channels.filter((channel) => retired.has(channel.id)).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span id="range-label" className="text-sm text-text-muted">
            Range
          </span>
          <div ref={rangeButtons} role="group" aria-labelledby="range-label" className="flex gap-1">
            {RANGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === range}
                onClick={() => {
                  if (entry.id === range) return;
                  setRange(entry.id);
                  setEnd(Date.now());
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

        {/* In the filter row, with everything else that scopes what is below it. */}
        {retiredCount > 0 && (
          <HideRetired count={retiredCount} hidden={hideRetired} onChange={onHideRetiredChange} />
        )}
      </div>

      {/* The loading line and the failure that takes its place, one region (`U-58`). A failure
          with a series held for another range gives way to it as before, mounted with its
          failure and said a moment after. */}
      {((history.status === 'error' && !kept) ||
        (history.status === 'loading' && showing === null)) && (
        <ReadRegion
          error={history.status === 'error' ? history.error : null}
          retry={history.retry}
          loading="history"
        />
      )}
      {showing !== null && (history.status !== 'error' || kept) && (
        <div
          className={history.status === 'loading' ? 'opacity-50 transition-opacity' : undefined}
          aria-busy={history.status === 'loading'}
        >
          {/* There, empty, whenever a series is shown, so a failure lands in a node that was. When
              a good read takes *Try again* from under focus, focus goes to the pressed range. */}
          <HeldListFailure
            what="The history"
            error={kept ? history.error : null}
            reading={history.status === 'loading'}
            onRetry={history.reload}
            focusAfter={focusRange}
          />
          <Series series={showing} asTable={asTable} retired={retired} hideRetired={hideRetired} />
        </div>
      )}
    </div>
  );
}

function Series({
  series,
  asTable,
  retired,
  hideRetired,
}: {
  series: HistorySeries;
  asTable: boolean;
  retired: ReadonlySet<number>;
  hideRetired: boolean;
}): React.JSX.Element {
  // Hidden after grouping, never before: a channel's colour slot is its place in the whole list
  // (`groupByUnit`), and filtering first would repaint every channel after a hidden one. A panel
  // left with nothing goes with it.
  const groups = useMemo(
    () =>
      groupByUnit(series.channels)
        .map((group) =>
          hideRetired
            ? { ...group, series: group.series.filter(({ channel }) => !retired.has(channel.id)) }
            : group,
        )
        .filter((group) => group.series.length > 0),
    [series.channels, retired, hideRetired],
  );
  const tabled = useMemo(
    () =>
      hideRetired ? series.channels.filter((channel) => !retired.has(channel.id)) : series.channels,
    [series.channels, retired, hideRetired],
  );
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
  if (tabled.length === 0) {
    return (
      <Empty because="Untick “Hide retired channels” to see their history.">
        Every channel of this sensor is retired, and retired channels are hidden.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <Provenance series={series} />
      {asTable ? (
        <Card title="Readings">
          <SeriesTable
            channels={tabled}
            buckets={series.buckets}
            format={(channel, value) => formatValue(value, channel.unit, null)}
            caption={`Every bucket from ${new Date(series.from).toLocaleString()} to ${new Date(series.to).toLocaleString()}, one column per channel. A dash is a bucket with no reading.`}
            retired={retired}
          />
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.unit === '' ? '(none)' : group.unit}>
            <Panel group={group} times={times} buckets={series.buckets} retired={retired} />
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
  retired,
}: {
  group: ChartGroup<HistoryChannel>;
  times: readonly number[];
  buckets: readonly string[];
  retired: ReadonlySet<number>;
}): React.JSX.Element {
  // Each series carries its own retired mark (`U-55`), which the legend and the tooltip both
  // read, so no array beside the series can fall out of step when one is hidden.
  const chartSeries = useMemo<ChartSeries[]>(
    () =>
      group.series.map(({ channel, slot }) => ({
        label: channel.name,
        slot,
        avg: channel.avg,
        min: channel.min,
        max: channel.max,
        retired: retired.has(channel.id),
      })),
    [group, retired],
  );

  const decimals = group.series[0]?.channel.decimals ?? null;
  const format = useCallback((value: number) => formatValue(value, '', decimals), [decimals]);

  const extent = groupExtent(group);
  const drawable = group.series.filter(({ channel }) => hasReadings(channel));
  // Which series are retired channels (`U-37`): the legend says so in words, and a panel of one
  // series, which has no legend, says so in its heading.
  const anyRetired = chartSeries.some((entry) => entry.retired === true);
  const only = chartSeries.length === 1 ? chartSeries[0] : undefined;
  const heading =
    only !== undefined
      ? seriesName(only)
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
      {anyRetired && (
        <p className="mt-2 text-xs text-text-muted">
          A retired channel was taken out of the sensor’s parameters by an edit; nothing reads it
          any more, so its line ends there.
        </p>
      )}

      <p className="mt-2 text-xs text-text-muted">
        Breaks in a line are gaps, not zeroes — a Down sensor records no channel values at all.
      </p>
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
