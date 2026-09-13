import {
  LIGHT_CHART_THEME,
  seriesColour,
  seriesWash,
  type ChartLayout,
  type ChartTheme,
  type Point,
} from '@ms/shared/charts';
import { escapeHtml } from './escape.js';

/**
 * A chart as inline SVG, for the HTML report (`E-05`, `ADR-006` Decision 3).
 *
 * **Drawing only.** Every position here was decided by `layoutChart`; this file turns numbers into
 * elements and nothing else, so the PDF — which draws the same layout with `pdfkit` — cannot tell
 * a different story about the same hour.
 *
 * **Why SVG and not a picture of one**, from the ADR: it is text, so it sits inside the emailed
 * document with nothing fetched — and a remote image in an emailed report is a read receipt the
 * recipient did not agree to. It prints at the reader's resolution. And it can be read back by a
 * test, which is how `report-graph.test.ts` knows a gap broke the line rather than believing it.
 *
 * **No `xmlns`.** SVG inside an HTML5 document does not need one, and the report asserts it
 * contains no URL at all — a namespace URI is not fetched, but a test that has to know that is a
 * worse test than one that does not.
 */

/** A width that is roughly right for a sans-serif at a size, since no font is measured here. */
export function approximateWidth(text: string, size: number): number {
  // 0.6 em per character over-estimates proportional digits a little, which errs towards fewer
  // labels rather than labels that touch — the failure the layout exists to prevent.
  return text.length * size * 0.6;
}

const path = (points: readonly Point[]): string =>
  points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`)
    .join('');

export interface SvgOptions {
  /** Unique within the document, so two charts' `<title>` ids never collide. */
  readonly id: string;
  /** What the chart is of, for the accessible name: the sensor it belongs to. */
  readonly subject: string;
  /** The period, for the accessible description. */
  readonly period: string;
  readonly fontSize: number;
  readonly theme?: ChartTheme;
}

export function renderChartSvg(layout: ChartLayout, options: SvgOptions): string {
  const theme = options.theme ?? LIGHT_CHART_THEME;
  const e = escapeHtml;
  const size = options.fontSize;
  const { plot } = layout;
  const out: string[] = [];

  const titleId = `${options.id}-title`;
  const descId = `${options.id}-desc`;
  out.push(
    `<svg class="chart" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}" ` +
      `width="${String(layout.width)}" height="${String(layout.height)}" role="img" ` +
      `aria-labelledby="${titleId} ${descId}" font-size="${String(size)}">`,
  );
  out.push(`<title id="${titleId}">${e(options.subject)}: ${e(layout.title)}</title>`);
  // Said for a reader who cannot see the lines, and it names the rule a sighted reader has to
  // infer from a break in one.
  out.push(
    `<desc id="${descId}">${e(layout.title)} over ${e(options.period)}. ` +
      'A break in a line is an interval with no reading, not a reading of zero.</desc>',
  );
  out.push(
    `<text x="0" y="${String(size)}" fill="${theme.ink}" font-weight="600">${e(layout.title)}</text>`,
  );

  // The grid and the value axis. Recessive: the data is the figure, the grid is the ground.
  for (const tick of layout.yTicks) {
    out.push(
      `<line x1="${String(plot.left)}" x2="${String(plot.right)}" y1="${String(tick.y)}" ` +
        `y2="${String(tick.y)}" stroke="${theme.grid}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${String(plot.left - 6)}" y="${String(tick.y)}" dy="0.35em" text-anchor="end" ` +
        `fill="${theme.inkMuted}">${e(tick.label)}</text>`,
    );
  }
  out.push(
    `<line x1="${String(plot.left)}" x2="${String(plot.right)}" y1="${String(plot.bottom)}" ` +
      `y2="${String(plot.bottom)}" stroke="${theme.axis}" stroke-width="1"/>`,
  );
  for (const tick of layout.xTicks) {
    out.push(
      `<text x="${String(tick.x)}" y="${String(layout.xLabelY)}" text-anchor="middle" ` +
        `fill="${theme.inkMuted}">${e(tick.label)}</text>`,
    );
  }

  // Bands under lines, so a line is never hidden by its own spread.
  for (const series of layout.series) {
    const colour = seriesColour(theme, series.slot);
    for (const band of series.bands) {
      out.push(
        `<path class="band" d="${path(band)}Z" fill="${seriesWash(colour)}" stroke="none"/>`,
      );
    }
  }
  for (const series of layout.series) {
    const colour = seriesColour(theme, series.slot);
    if (series.lines.length > 0) {
      // **One path, one subpath per run.** An `M` starts a new subpath without drawing to it, which
      // is exactly a gap — so the break in the line is in the geometry, not in a style.
      out.push(
        `<path class="line" data-series="${e(series.key)}" d="${series.lines.map(path).join('')}" ` +
          `fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    }
    for (const dot of series.dots) {
      out.push(
        `<circle class="dot" data-series="${e(series.key)}" cx="${String(dot.x)}" cy="${String(dot.y)}" ` +
          `r="2.5" fill="${colour}"/>`,
      );
    }
  }

  for (const entry of layout.legend) {
    out.push(
      `<rect x="${String(entry.x)}" y="${String(entry.y - size * 0.8)}" width="10" height="10" rx="2" ` +
        `fill="${seriesColour(theme, entry.slot)}"/>`,
    );
    out.push(
      `<text x="${String(entry.x + 14)}" y="${String(entry.y)}" fill="${theme.ink}">${e(entry.label)}</text>`,
    );
  }

  out.push('</svg>');
  return out.join('');
}
