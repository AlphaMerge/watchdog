/**
 * The chart palette's rules, and its light values (`E-05`, moved from the web app).
 *
 * **Two consumers, one set of rules.** The web app reads the live palette from its own CSS custom
 * properties at draw time, because the viewer's theme can change under a chart; a report has no
 * viewer and no stylesheet, and is printed, so it draws in the light palette. Both assign slots the
 * same way, and `packages/web/test/charts.test.ts` asserts the stylesheet's light tokens are the
 * values below — so this is one palette checked in two places rather than two palettes.
 */

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
 * The light palette, as the web app's stylesheet defines it (`U-01`), and printed on every report.
 *
 * Light because a report is paper-shaped: it is attached to an email, filed, and printed, and a
 * dark chart on a white page is a chart that wastes toner to be harder to read.
 *
 * **These are the stylesheet's `:root` values, and a test says so.** Before `E-05` the web app kept
 * a copy of this palette as a fallback, and its neutrals had quietly drifted — `#ffffff`, `#e8edf3`
 * and `#0f172a` against a stylesheet that had since moved to warm greys — which is exactly what
 * `palette.ts` in the web app warned two copies of a palette would do. The eight hues had not
 * moved; the neutrals had, and nothing noticed because nothing compared them.
 */
export const LIGHT_CHART_THEME: ChartTheme = {
  surface: '#fbfaf7',
  grid: '#e6e2da',
  axis: '#c7c1b5',
  ink: '#1b1a17',
  inkMuted: '#69655c',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};

/**
 * The colour for a slot.
 *
 * **Slots are assigned by identity and never cycled.** The caller passes the channel's fixed
 * position in the sensor's channel list, not its position in whatever subset is on screen — so
 * hiding a channel, or splitting channels across charts by unit, never repaints the ones that
 * remain. A reader who has learned that green is packet loss keeps that.
 *
 * Past the eighth slot the answer is the muted ink rather than a ninth hue: the palette was
 * validated as eight, and a generated colour would be one nobody checked for separation. Nine
 * channels on one axis is a chart that should have been split anyway, and `groupByUnit` usually
 * splits it first.
 */
export function seriesColour(theme: ChartTheme, slot: number): string {
  return (slot >= 0 && slot < SERIES_SLOTS ? theme.series[slot] : undefined) ?? theme.inkMuted;
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
