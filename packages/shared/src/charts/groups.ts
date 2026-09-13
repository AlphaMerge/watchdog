/**
 * One chart per unit, colour by entity, and what an all-gap channel means (`E-05`).
 *
 * **Moved here from `packages/web/src/charts/groups.ts`**, which is `ADR-006` Decision 3's whole
 * point: these are charting *decisions*, and a report's graph and the sensor page's graph must not
 * make them differently. uPlot draws pixels and a report draws SVG and PDF primitives; neither of
 * those decides anything, and this file is where the deciding happens — once, for both.
 *
 * **Browser-safe by construction.** This directory is published as `@ms/shared/charts`, which the
 * web app imports, so nothing in it may reach for `node:*`, `pino`, or anything outside this
 * directory. `test/charts-boundary.test.ts` holds that line.
 */

/**
 * The part of a channel a chart needs.
 *
 * Structural rather than borrowed from either side: the core's `HistoryChannel` and the web app's
 * are both assignable to it, and naming one of them here would make this package depend on the
 * other one's idea of a channel.
 */
export interface ChartChannel {
  readonly key: string;
  readonly name: string;
  /** The unit every value is measured in. Empty for unitless channels. */
  readonly unit: string;
  /** Display precision, or `null` for automatic. */
  readonly decimals: number | null;
  /** Aligned to the buckets. **`null` is a gap, never a zero.** */
  readonly avg: readonly (number | null)[];
  readonly min: readonly (number | null)[];
  readonly max: readonly (number | null)[];
}

/** One chart's worth of series: the channels that share a unit, and their fixed colour slots. */
export interface ChartGroup<C extends ChartChannel = ChartChannel> {
  /** The unit every series in this chart is measured in. Empty for unitless channels. */
  readonly unit: string;
  readonly series: readonly { readonly channel: C; readonly slot: number }[];
}

/**
 * Splits a sensor's channels into one chart per unit.
 *
 * **This is the answer to the dual-axis problem, and it is not a stylistic preference.** A Ping
 * sensor reports response time in milliseconds and packet loss as a percentage. Drawn on one
 * y-axis, either loss is invisible against a 250 ms scale or the scale is meaningless; drawn on
 * two y-axes, the crossing point of the two lines is an artefact of where the axes were put, and
 * a reader takes it for a relationship. The `dataviz` guidance is blunt about it — two measures
 * of different scale become two charts — and it is the single most common charting mistake.
 *
 * Channels that *do* share a unit stay together, because that is where comparison is real: a
 * Traffic sensor's in, out and sum belong on one axis, and separating them would be its own
 * failure.
 *
 * **Colour slots come from the channel's position in the whole list, not its position in a
 * group.** Colour follows the entity, never its rank: a channel keeps its hue whether it lands
 * in the first chart or the third, and adding a channel does not repaint the others.
 *
 * Order follows the channel list, which the API already returns primary-first — so the channel
 * that decides the sensor's state is the first chart on the page.
 */
export function groupByUnit<C extends ChartChannel>(channels: readonly C[]): ChartGroup<C>[] {
  const groups: ChartGroup<C>[] = [];
  const byUnit = new Map<string, { channel: C; slot: number }[]>();

  channels.forEach((channel, slot) => {
    const held = byUnit.get(channel.unit);
    if (held === undefined) {
      const series = [{ channel, slot }];
      byUnit.set(channel.unit, series);
      groups.push({ unit: channel.unit, series });
    } else {
      held.push({ channel, slot });
    }
  });

  return groups;
}

/**
 * Whether a channel has anything to draw.
 *
 * A channel whose every bucket is a gap is not an empty chart — it is a channel that reported
 * nothing over this range, which is a fact worth stating in words rather than drawing as a blank
 * rectangle the reader has to interpret.
 */
export function hasReadings(channel: ChartChannel): boolean {
  return channel.avg.some((value) => value !== null);
}

/**
 * A chart's y-extent, across every series in it, ignoring gaps.
 *
 * The band's edges count, not only the averages: a y-axis fitted to the averages clips the very
 * spike the band exists to show. Where a bucket has an average and no spread — a source that
 * does not keep one — the average stands in for both.
 */
export function groupExtent(group: ChartGroup): { low: number; high: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const { channel } of group.series) {
    for (let index = 0; index < channel.avg.length; index += 1) {
      const avg = channel.avg[index] ?? null;
      const min = channel.min[index] ?? avg;
      const max = channel.max[index] ?? avg;
      if (min === null || max === null) continue;
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      seen = true;
      if (min < low) low = min;
      if (max > high) high = max;
    }
  }
  return seen ? { low, high } : null;
}
