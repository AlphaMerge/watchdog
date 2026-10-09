import type uPlot from 'uplot';

/**
 * The shape of a plotted channel, and where its rows land in uPlot's aligned data.
 *
 * Separate from the chart because it is pure index arithmetic that `test/charts.test.ts`
 * exercises on its own, and because a module exporting both a component and a function cannot
 * Fast Refresh.
 */

export interface ChartSeries {
  readonly label: string;
  /** Fixed slot in the categorical palette. Follows the channel, never its rank on screen. */
  readonly slot: number;
  /** Aligned to `times`. `null` is a gap and must stay one. */
  readonly avg: readonly (number | null)[];
  readonly min: readonly (number | null)[];
  readonly max: readonly (number | null)[];
  /**
   * A channel an edit took out of the sensor's parameters (`P-310`). On the series rather than in
   * an array beside it (`U-55`), so a series hidden from the middle of a panel cannot leave
   * another series wearing its mark.
   */
  readonly retired?: boolean;
}

/**
 * What a series is called wherever its name is written — the legend and the hover tooltip
 * (`U-55`) — so the two cannot disagree about whether it is retired. In words, because the
 * line's colour or where it ends cannot say it to anyone who does not already know.
 */
export function seriesName(entry: Pick<ChartSeries, 'label' | 'retired'>): string {
  return entry.retired === true ? `${entry.label} (retired)` : entry.label;
}

/**
 * `[times, ...values]` in uPlot's aligned layout.
 *
 * Each series contributes three rows — min, max and avg, in that order — because the band is
 * drawn *between* two series and uPlot needs both as real data. The nulls go in as nulls.
 */
export function dataFor(
  times: readonly number[],
  series: readonly ChartSeries[],
): uPlot.AlignedData {
  const rows: (number | null)[][] = [[...times]];
  for (const entry of series) {
    rows.push([...entry.min], [...entry.max], [...entry.avg]);
  }
  return rows as unknown as uPlot.AlignedData;
}

/** Where each series' three rows land in the aligned data. */
export function rowsFor(index: number): { min: number; max: number; avg: number } {
  const base = index * 3 + 1;
  return { min: base, max: base + 1, avg: base + 2 };
}
