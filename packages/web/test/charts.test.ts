import { describe, expect, it } from 'vitest';
import { groupByUnit, groupExtent, hasReadings } from '../src/charts/groups';
import {
  readChartTheme,
  seriesColour,
  seriesVar,
  seriesWash,
  SERIES_SLOTS,
} from '../src/charts/palette';
import { dataFor, rowsFor } from '../src/charts/TimeSeriesChart';
import type { HistoryChannel } from '../src/api/types';

function channel(
  id: number,
  name: string,
  unit: string,
  avg: (number | null)[],
  spread = 0,
): HistoryChannel {
  return {
    id,
    key: name.toLowerCase(),
    name,
    unit,
    decimals: null,
    avg,
    min: avg.map((value) => (value === null ? null : value - spread)),
    max: avg.map((value) => (value === null ? null : value + spread)),
    count: avg.map((value) => (value === null ? null : 1)),
  };
}

describe('grouping channels into charts', () => {
  it('puts channels with different units on different charts', () => {
    // The dual-axis trap. A 250 ms response time and a 0–100 % loss on one y-axis means either
    // loss is invisible or the scale is meaningless; on two axes the crossing point of the lines
    // is an artefact of where the axes were put, and a reader takes it for a relationship.
    const groups = groupByUnit([
      channel(1, 'Response time', 'ms', [1]),
      channel(2, 'Packet loss', '%', [0]),
    ]);
    expect(groups.map((group) => group.unit)).toEqual(['ms', '%']);
    expect(groups.every((group) => group.series.length === 1)).toBe(true);
  });

  it('keeps channels that share a unit together', () => {
    // Where comparison is real: a Traffic sensor's in, out and sum belong on one axis.
    const groups = groupByUnit([
      channel(1, 'In', 'kbit/s', [1]),
      channel(2, 'Out', 'kbit/s', [2]),
      channel(3, 'Sum', 'kbit/s', [3]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.series.map((entry) => entry.channel.name)).toEqual(['In', 'Out', 'Sum']);
  });

  it('assigns a colour slot by the channel position, not the position in its group', () => {
    // Colour follows the entity, never its rank. Splitting by unit must not repaint anything.
    const groups = groupByUnit([
      channel(1, 'Response time', 'ms', [1]),
      channel(2, 'Packet loss', '%', [0]),
      channel(3, 'Jitter', 'ms', [1]),
    ]);
    const ms = groups.find((group) => group.unit === 'ms');
    const pct = groups.find((group) => group.unit === '%');
    expect(ms?.series.map((entry) => entry.slot)).toEqual([0, 2]);
    // Packet loss keeps slot 1 even though it is the only series on its own chart.
    expect(pct?.series.map((entry) => entry.slot)).toEqual([1]);
  });

  it('keeps unitless channels together rather than one chart each', () => {
    const groups = groupByUnit([channel(1, 'Replies', '', [4]), channel(2, 'Sent', '', [4])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.unit).toBe('');
  });

  it('preserves the order the API returned, which is primary first', () => {
    const groups = groupByUnit([
      channel(1, 'Packet loss', '%', [0]),
      channel(2, 'Response time', 'ms', [1]),
    ]);
    expect(groups[0]?.unit).toBe('%');
  });
});

describe('a chart extent', () => {
  it('spans min and max across every series, not only the averages', () => {
    // An average over an hour hides the spike somebody opened the page to see; a scale built
    // from averages would clip it.
    const extent = groupExtent({
      unit: 'ms',
      series: [
        { channel: channel(1, 'a', 'ms', [10], 4), slot: 0 },
        { channel: channel(2, 'b', 'ms', [20], 2), slot: 1 },
      ],
    });
    expect(extent).toEqual({ low: 6, high: 22 });
  });

  it('ignores gaps rather than treating them as zero', () => {
    const extent = groupExtent({
      unit: 'ms',
      series: [{ channel: channel(1, 'a', 'ms', [null, 5, null]), slot: 0 }],
    });
    expect(extent).toEqual({ low: 5, high: 5 });
  });

  it('is null when nothing was recorded', () => {
    const extent = groupExtent({
      unit: 'ms',
      series: [{ channel: channel(1, 'a', 'ms', [null, null]), slot: 0 }],
    });
    expect(extent).toBeNull();
  });

  it('knows a channel with no readings from one that read zero', () => {
    expect(hasReadings(channel(1, 'a', '%', [null, null]))).toBe(false);
    expect(hasReadings(channel(1, 'a', '%', [null, 0]))).toBe(true);
  });
});

describe('the aligned data uPlot is handed', () => {
  it('lays out three rows per series after the times', () => {
    const data = dataFor(
      [1, 2],
      [
        { label: 'a', slot: 0, avg: [1, 2], min: [0, 1], max: [2, 3] },
        { label: 'b', slot: 1, avg: [4, 5], min: [3, 4], max: [5, 6] },
      ],
    );
    expect(data).toHaveLength(7);
    expect(rowsFor(0)).toEqual({ min: 1, max: 2, avg: 3 });
    expect(rowsFor(1)).toEqual({ min: 4, max: 5, avg: 6 });
    expect(data[rowsFor(1).avg]).toEqual([4, 5]);
  });

  it('passes a gap through as null and never as a number', () => {
    // The whole rule. uPlot breaks the line on a null and joins across a number, and a joined
    // line is a claim that the value moved smoothly through an outage.
    const data = dataFor(
      [1, 2, 3],
      [{ label: 'a', slot: 0, avg: [1, null, 3], min: [1, null, 3], max: [1, null, 3] }],
    );
    expect(data[rowsFor(0).avg]).toEqual([1, null, 3]);
    expect(data[rowsFor(0).min]).toEqual([1, null, 3]);
  });
});

describe('the chart palette', () => {
  it('gives every slot a distinct colour', () => {
    const theme = readChartTheme();
    const used = new Set(
      Array.from({ length: SERIES_SLOTS }, (_, slot) => seriesColour(theme, slot)),
    );
    expect(used.size).toBe(SERIES_SLOTS);
  });

  it('never invents a ninth hue', () => {
    // The palette was validated as eight. A generated colour is one nobody checked for
    // separation, so past the eighth slot the answer is ink, and groupByUnit has usually split
    // the chart before it gets there anyway.
    const theme = readChartTheme();
    expect(seriesColour(theme, SERIES_SLOTS)).toBe(theme.inkMuted);
  });

  it('washes a hue for the min-max band rather than saturating it', () => {
    expect(seriesWash('#2a78d6', 0.14)).toBe('rgba(42, 120, 214, 0.14)');
  });

  it('leaves a colour it cannot parse alone', () => {
    expect(seriesWash('currentColor')).toBe('currentColor');
  });

  it('names the custom property for anything drawn in the DOM', () => {
    // Only the canvas needs a resolved colour. A DOM mark painted with `var()` re-resolves when
    // the theme attribute changes, with no re-render to forget.
    expect(seriesVar(0)).toBe('var(--ms-series-1)');
    expect(seriesVar(7)).toBe('var(--ms-series-8)');
  });

  it('falls back to ink past the eighth slot, matching seriesColour', () => {
    expect(seriesVar(SERIES_SLOTS)).toBe('var(--ms-text-muted)');
    expect(seriesVar(-1)).toBe('var(--ms-text-muted)');
  });
});
