/** How many categorical slots the token set defines. A ninth series is never a generated hue. */
export const SERIES_SLOTS = 8;

export interface ChartTheme {
  readonly surface: string;
  readonly grid: string;
  readonly axis: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly series: readonly string[];
}

/**
 * Falls back to the light palette when nothing can be read.
 *
 * Only reachable in jsdom, where custom properties on `:root` resolve to empty because no
 * stylesheet is loaded. A chart drawn in a colour nobody chose would be worse than one drawn in
 * the documented default.
 */
const FALLBACK: ChartTheme = {
  surface: '#ffffff',
  grid: '#e8edf3',
  axis: '#cbd5e1',
  ink: '#0f172a',
  inkMuted: '#475569',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};

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
 * The colour for a slot.
 *
 * **Slots are assigned by identity and never cycled.** The caller passes the channel's fixed
 * position in the sensor's channel list, not its position in whatever subset is on screen — so
 * hiding a channel, or splitting channels across charts by unit, never repaints the ones that
 * remain. A reader who has learned that green is packet loss keeps that.
 *
 * Past the eighth slot the answer is the ink colour rather than a ninth hue: the palette was
 * validated as eight, and a generated colour would be one nobody checked for separation. Nine
 * channels on one axis is a chart that should have been split anyway, and `groupByUnit` usually
 * splits it first.
 */
export function seriesColour(theme: ChartTheme, slot: number): string {
  return theme.series[slot] ?? theme.inkMuted;
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

/** The series hue as a wash, for the min–max band. A wash, never a saturated block. */
export function seriesWash(colour: string, opacity = 0.14): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex?.[1] === undefined) return colour;
  const value = Number.parseInt(hex[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(opacity)})`;
}
