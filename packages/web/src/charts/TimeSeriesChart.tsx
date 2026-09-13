import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { seriesColour, seriesWash, type ChartTheme } from '@ms/shared/charts';
import { readChartTheme } from './palette';
import { dataFor, rowsFor, type ChartSeries } from './time-series-model';

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
    // min and max are invisible in themselves; they exist so the band has two edges to fill
    // between. Drawing them as lines as well would be three lines per channel and unreadable.
    plotted.push(
      { label: `${entry.label} min`, stroke: 'transparent', points: { show: false } },
      { label: `${entry.label} max`, stroke: 'transparent', points: { show: false } },
      {
        label: entry.label,
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

/**
 * The hover layer.
 *
 * **One tooltip, every series.** The pointer never has to land on a line: it names the bucket
 * and lists every channel's value at that bucket, so a reader comparing two channels reads both
 * numbers at once rather than hunting for the second line.
 *
 * A gap is reported as "no reading" rather than omitted. Leaving the row out would let a reader
 * conclude the channel does not exist here, when what happened is that nothing was measured —
 * and telling them apart is the whole point of the null.
 *
 * Labels go in with `textContent`. A channel name comes from a sensor type, an SNMP walk or a
 * device's own reply; it is data, and data does not get to write markup.
 */
function tooltipPlugin(options: {
  theme: ChartTheme;
  series: readonly ChartSeries[];
  format: (value: number) => string;
  label: string;
}): uPlot.Plugin {
  const { theme, series, format } = options;
  let box: HTMLDivElement | null = null;

  return {
    hooks: {
      init: (self) => {
        box = document.createElement('div');
        box.className = 'ms-chart-tooltip';
        box.setAttribute('role', 'status');
        box.style.display = 'none';
        self.over.appendChild(box);
      },
      setCursor: (self) => {
        const tip = box;
        if (tip === null) return;
        const index = self.cursor.idx;
        const left = self.cursor.left ?? -1;
        if (index === null || index === undefined || left < 0) {
          tip.style.display = 'none';
          return;
        }

        const times = self.data[0];
        const at = times[index];
        tip.replaceChildren();

        const when = document.createElement('div');
        when.className = 'ms-chart-tooltip-when';
        when.textContent = at === undefined ? '' : new Date(at * 1_000).toLocaleString();
        tip.appendChild(when);

        series.forEach((entry, order) => {
          const rows = rowsFor(order);
          const value = self.data[rows.avg]?.[index] ?? null;
          const low = self.data[rows.min]?.[index] ?? null;
          const high = self.data[rows.max]?.[index] ?? null;

          const row = document.createElement('div');
          row.className = 'ms-chart-tooltip-row';

          const key = document.createElement('span');
          key.className = 'ms-chart-tooltip-key';
          key.style.background = seriesColour(theme, entry.slot);
          row.appendChild(key);

          // Value leads, label follows: the reader already has the series and wants the number.
          const readout = document.createElement('span');
          readout.className = 'ms-chart-tooltip-value';
          readout.textContent =
            value === null
              ? 'no reading'
              : low !== null && high !== null && low !== high
                ? `${format(value)} (${format(low)}–${format(high)})`
                : format(value);
          row.appendChild(readout);

          const name = document.createElement('span');
          name.className = 'ms-chart-tooltip-label';
          name.textContent = entry.label;
          row.appendChild(name);

          tip.appendChild(row);
        });

        tip.style.display = 'block';
        // Flips to the left of the crosshair near the right edge, so it never leaves the plot.
        const flip = left > self.over.clientWidth / 2;
        tip.style.left = `${String(left)}px`;
        tip.style.transform = flip ? 'translate(calc(-100% - 12px), 8px)' : 'translate(12px, 8px)';
      },
      destroy: () => {
        box?.remove();
        box = null;
      },
    },
  };
}
