import { seriesVar } from './palette';
import type { ChartSeries } from './TimeSeriesChart';

/**
 * The legend — always present for two or more series, absent for one.
 *
 * A single-series panel needs no legend box because the panel's own heading names it; adding one
 * would be a row of chrome restating the title. From two series up it is the dependable identity
 * channel, and the marks supplement it rather than the other way round.
 *
 * **The text wears text tokens; the colour lives in the line key.** A label painted in its
 * series colour is a label competing with the data for contrast — and three of the eight light
 * slots sit below 3:1 on white, so a coloured label would be genuinely hard to read. The key
 * carries identity, the ink carries the words.
 *
 * The key's colour is a `var()` rather than a resolved value, so a theme change repaints it
 * without React having to notice. Only the canvas needs a resolved colour.
 *
 * Each entry also carries its latest value, which is the "direct label, selectively" rule: one
 * number per series, at the end, rather than a number on every point.
 */
export function SeriesLegend({
  series,
  latest,
}: {
  series: readonly ChartSeries[];
  /** The last reading of each series, already formatted, or null for a series that ends in a gap. */
  latest: readonly (string | null)[];
}): React.JSX.Element | null {
  if (series.length < 2) return null;

  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((entry, index) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="h-0.5 w-3 shrink-0"
            style={{ background: seriesVar(entry.slot) }}
          />
          <span className="text-text-muted">{entry.label}</span>
          <span className="font-medium tabular-nums text-text">{latest[index] ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
}
