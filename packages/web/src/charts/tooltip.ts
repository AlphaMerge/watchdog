import { seriesColour, type ChartTheme } from '@ms/shared/charts';
import type uPlot from 'uplot';
import { rowsFor, seriesName, type ChartSeries } from './time-series-model';

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
export function tooltipPlugin(options: {
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

          // The legend's words (`U-55`): a retired channel says so here too, in the label's text
          // ink, never in its series colour, which only the key wears.
          const name = document.createElement('span');
          name.className = 'ms-chart-tooltip-label';
          name.textContent = seriesName(entry);
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
