import { LIGHT_CHART_THEME, SERIES_SLOTS, type ChartTheme } from '@ms/shared/charts';

/**
 * The palette's rules — eight slots, colour by identity, never a ninth hue, the band's wash — live
 * in `@ms/shared/charts` with the report renderer's copy of them, which is to say with the only
 * copy (`E-05`). What stays here is the half only a browser has: reading the live theme off the
 * document, and naming a slot as a custom property for anything drawn in the DOM.
 */

/**
 * Falls back to the light palette when nothing can be read.
 *
 * Only reachable in jsdom, where custom properties on `:root` resolve to empty because no
 * stylesheet is loaded. A chart drawn in a colour nobody chose would be worse than one drawn in
 * the documented default — and the default is the shared one, which `charts.test.ts` checks
 * against this app's stylesheet.
 */
const FALLBACK: ChartTheme = LIGHT_CHART_THEME;

/**
 * The chart palette, read from the document's own custom properties.
 *
 * **Read, never duplicated.** uPlot draws to a canvas, which cannot carry a class — so the
 * alternative is a second copy of the palette in JavaScript, and two copies of a palette are two
 * palettes as soon as one is edited. `U-01` chose custom properties over Tailwind theme keys for
 * exactly this, and this function is where that decision pays.
 *
 * Called at draw time rather than cached, because the theme can change under a live chart and
 * the values are whatever `:root` currently resolves to.
 */
export function readChartTheme(element: Element | null = null): ChartTheme {
  const target = element ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (target === null) return FALLBACK;
  const style = getComputedStyle(target);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };

  return {
    surface: read('--ms-surface', FALLBACK.surface),
    grid: read('--ms-grid', FALLBACK.grid),
    axis: read('--ms-axis', FALLBACK.axis),
    ink: read('--ms-text', FALLBACK.ink),
    inkMuted: read('--ms-text-muted', FALLBACK.inkMuted),
    series: Array.from({ length: SERIES_SLOTS }, (_, index) =>
      read(`--ms-series-${String(index + 1)}`, FALLBACK.series[index] ?? FALLBACK.series[0] ?? ''),
    ),
  };
}

/**
 * The slot as a custom-property reference, for anything drawn in the DOM.
 *
 * **The DOM never resolves a colour in JavaScript; only the canvas has to.** A legend key painted
 * with a value read at render time keeps that value until React happens to re-render it — so
 * toggling the theme rebuilt the charts and left the legend in the old palette. `var(--ms-series-N)`
 * re-resolves itself, for free, at exactly the moment the attribute on `<html>` changes.
 *
 * Past the eighth slot this falls back to muted ink, matching `seriesColour`.
 */
export function seriesVar(slot: number): string {
  return slot >= 0 && slot < SERIES_SLOTS
    ? `var(--ms-series-${String(slot + 1)})`
    : 'var(--ms-text-muted)';
}
