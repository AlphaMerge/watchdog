import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIGHT_CHART_THEME, SERIES_SLOTS } from '@ms/shared/charts';
import { readChartTheme, seriesVar } from '../src/charts/palette';
import { dataFor, rowsFor } from '../src/charts/time-series-model';

/**
 * The web app's half of charting (`E-05`).
 *
 * Grouping by unit, extents, colour slots and the band's wash moved to `@ms/shared/charts` with
 * their tests, because the report renderer reads the same rules. What is tested here is what only
 * the browser has — uPlot's aligned data, reading the live theme, naming a slot as a custom
 * property — and the one check that keeps the two halves one palette.
 */

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
  it('is the stylesheet’s palette, not a second copy of it', () => {
    // **The check that makes a shared palette honest.** A report has no stylesheet, so it draws
    // with `LIGHT_CHART_THEME`; this app draws with `index.css`. Before `E-05` the fallback copy's
    // neutrals had drifted from the stylesheet with nothing noticing, because nothing compared
    // them. Now something does.
    //
    // Read off disk from the package root: Vitest hands a CSS import back as an empty string, even
    // with `?raw`, and in jsdom `import.meta.url` is not a file — so an empty read is asserted
    // against, rather than left to compare nothing with nothing.
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(stylesheet.length).toBeGreaterThan(1_000);
    const root = /:root\s*\{([\s\S]*?)\n\}/u.exec(stylesheet)?.[1] ?? '';
    const token = (name: string): string =>
      new RegExp(`--ms-${name}:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(root)?.[1]?.toLowerCase() ??
      `(no --ms-${name})`;
    expect({
      surface: token('surface'),
      grid: token('grid'),
      axis: token('axis'),
      ink: token('text'),
      inkMuted: token('text-muted'),
      series: Array.from({ length: SERIES_SLOTS }, (_, index) =>
        token(`series-${String(index + 1)}`),
      ),
    }).toEqual(LIGHT_CHART_THEME);
  });

  it('falls back to the shared light palette where no stylesheet is loaded', () => {
    expect(readChartTheme()).toEqual(LIGHT_CHART_THEME);
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
