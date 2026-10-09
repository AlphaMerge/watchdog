import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { seriesColour, seriesWash, type ChartTheme } from '@ms/shared/charts';
import { readChartTheme } from './palette';
import { dataFor, rowsFor, seriesName, type ChartSeries } from './time-series-model';
import { tooltipPlugin } from './tooltip';

export interface TimeSeriesChartProps {
  /** Bucket starts, epoch seconds — what uPlot's time scale expects. */
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  readonly height?: number;
  /** Formats a value for the axis and the tooltip, at the channel's own precision. */
  readonly format: (value: number) => string;
  readonly label: string;
}

const DEFAULT_HEIGHT = 220;
/** Room under the plot for the x-axis band, so the card never grows an inner scrollbar. */
const X_AXIS_BAND = 34;

/**
 * A time-series panel (`U-05`).
 *
 * **The gap rule is the reason this is not a default uPlot chart.** `spanGaps` stays false and
 * every null is passed through untouched, so a period the sensor produced no readings is a break
 * in the line. uPlot's own default would be to join across it, and the joined line is a claim
 * that the value moved smoothly through an outage — the same lie as drawing it to zero, drawn
 * more convincingly. Nothing here converts a null to a number.
 *
 * **One y-axis. Always.** A panel holds only channels that share a unit — see `groupByUnit` —
 * so there is never a second scale to add, and the crossing of two lines always means what it
 * looks like it means.
 *
 * **The palette is read from the document, not held here.** `readChartTheme` resolves the same
 * custom properties the DOM uses, at draw time, and the chart is rebuilt when the theme changes.
 * A canvas cannot inherit a class, and the alternative — a second copy of the palette in
 * JavaScript — is two palettes the moment one is edited.
 */
export function TimeSeriesChart({
  times,
  series,
  height = DEFAULT_HEIGHT,
  format,
  label,
}: TimeSeriesChartProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;

    let disposed = false;
    const build = (): void => {
      if (disposed) return;
      plot.current?.destroy();
      plot.current = null;
      const width = element.clientWidth;
      if (width === 0) return;
      plot.current = new uPlot(
        optionsFor({ theme: readChartTheme(element), series, width, height, format, label }),
        dataFor(times, series),
        element,
      );
    };

    build();

    // The theme is an attribute on <html>; the chart has to be rebuilt when it changes, because
    // every colour was resolved at construction. Cheap: it happens when somebody clicks a toggle.
    const themed = new MutationObserver(build);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const resized = new ResizeObserver(() => {
      const current = plot.current;
      if (current === null) {
        // Built at zero width — a tab that was display:none when it mounted. Now it has a size.
        build();
        return;
      }
      current.setSize({ width: element.clientWidth, height });
    });
    resized.observe(element);

    return () => {
      disposed = true;
      themed.disconnect();
      resized.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [times, series, height, format, label]);

  return <div ref={host} className="w-full" style={{ minHeight: `${String(height)}px` }} />;
}

function optionsFor(options: {
  theme: ChartTheme;
  series: readonly ChartSeries[];
  width: number;
  height: number;
  format: (value: number) => string;
  label: string;
}): uPlot.Options {
  const { theme, series, width, height, format, label } = options;

  const plotted: uPlot.Series[] = [{ label: 'time' }];
  const bands: uPlot.Band[] = [];

  series.forEach((entry, index) => {
    const colour = seriesColour(theme, entry.slot);
    const rows = rowsFor(index);
    // uPlot's own name for it, which its hidden legend would use, is the legend's (`U-55`).
    const name = seriesName(entry);
    // min and max are invisible in themselves; they exist so the band has two edges to fill
    // between. Drawing them as lines as well would be three lines per channel and unreadable.
    plotted.push(
      { label: `${name} min`, stroke: 'transparent', points: { show: false } },
      { label: `${name} max`, stroke: 'transparent', points: { show: false } },
      {
        label: name,
        stroke: colour,
        width: 2,
        // Round join and cap, per the mark spec. `points` stay off: a point per bucket at 961
        // buckets is a solid band of ink, and the crosshair already answers "what is here".
        points: { show: false },
      },
    );
    bands.push({ series: [rows.max, rows.min], fill: seriesWash(colour) });
  });

  return {
    width,
    height: height - X_AXIS_BAND,
    // uPlot's own legend is replaced: it cannot carry the value formatting, the line keys or the
    // text tokens the guidance asks for, and two legends would be worse than one.
    legend: { show: false },
    cursor: {
      // The crosshair finds the X. A reader aims at a time, never at a 2px line.
      x: true,
      y: false,
      points: { show: false },
      // Nothing is draggable: a monitoring chart's range is the filter above it, and a
      // drag-zoom that changes only this panel would put the panels out of step with each other.
      drag: { x: false, y: false },
    },
    scales: { x: { time: true } },
    axes: [
      {
        stroke: theme.inkMuted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.axis, width: 1 },
        font: '11px ui-sans-serif, system-ui, sans-serif',
      },
      {
        stroke: theme.inkMuted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.axis, width: 1 },
        font: '11px ui-sans-serif, system-ui, sans-serif',
        size: 56,
        values: (_self, splits) => splits.map((value) => format(value)),
        // No rotated axis label. The panel heading already names the unit — "Response time (ms)",
        // or "kbit/s channels" when several share one — and a sideways repeat of it is chrome
        // competing with the data for the reader's attention.
      },
    ],
    series: plotted,
    bands,
    // The canvas is decoration around data that is also in the table view; the figure around it
    // carries the accessible name and the description.
    class: 'ms-chart',
    plugins: [tooltipPlugin({ theme, series, format, label })],
  };
}
