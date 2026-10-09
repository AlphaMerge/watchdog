import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIGHT_CHART_THEME } from '@ms/shared/charts';
import type uPlot from 'uplot';
import type { ChannelRecord, HistoryChannel, HistorySeries, SensorValues } from '../src/api/types';
import { SeriesLegend } from '../src/charts/SeriesLegend';
import { tooltipPlugin } from '../src/charts/tooltip';
import { dataFor, seriesName, type ChartSeries } from '../src/charts/time-series-model';
import { HistoryPanel } from '../src/routes/detail/HistoryPanel';
import { channelListIsStale } from '../src/routes/detail/model';

/**
 * What is left of retired channels in the History tab (`U-55`): the hover tooltip says retired as
 * the legend does, the tab can hide them, and hiding one from the middle of a panel leaves every
 * other series wearing its own mark.
 */

/** Every series the chart was last handed, per panel: the canvas is uPlot's, so it is stubbed. */
const charted: (readonly ChartSeries[])[] = [];
vi.mock('../src/charts/TimeSeriesChart', () => ({
  TimeSeriesChart: ({ series }: { series: readonly ChartSeries[] }) => {
    charted.push(series);
    return null;
  },
}));

const NO_LIMITS: ChannelRecord['limits'] = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

function channel(id: number, key: string, retired = false): ChannelRecord {
  return {
    id,
    key,
    name: `Column ${key}`,
    unit: '',
    isPrimary: id === 1,
    limits: NO_LIMITS,
    scaleMul: '1',
    scaleDiv: '1',
    decimals: null,
    spikeMin: null,
    spikeMax: null,
    lookupId: null,
    retired,
  };
}

const series = (label: string, slot: number, retired = false): ChartSeries => ({
  label,
  slot,
  avg: [slot + 1, slot + 2],
  min: [slot + 1, slot + 2],
  max: [slot + 1, slot + 2],
  retired,
});

describe('the hover tooltip', () => {
  /** The plugin's hooks run against a stand-in for the plot: its overlay, cursor and data. */
  function hover(plotted: readonly ChartSeries[]): HTMLElement {
    const plugin = tooltipPlugin({
      theme: LIGHT_CHART_THEME,
      series: plotted,
      format: (value) => String(value),
      label: 'Unitless channels',
    });
    const over = document.createElement('div');
    const self = {
      over,
      cursor: { idx: 1, left: 10 },
      data: dataFor([1_000, 1_060], plotted),
    } as unknown as uPlot;
    const hooks = plugin.hooks as {
      init: (self: uPlot) => void;
      setCursor: (self: uPlot) => void;
    };
    hooks.init(self);
    hooks.setCursor(self);
    const tip = over.querySelector<HTMLElement>('.ms-chart-tooltip');
    if (tip === null) throw new Error('no tooltip');
    return tip;
  }

  it('says retired in the label’s text, as the legend does, and a live channel’s does not', () => {
    // The retired one in the middle, so a mark that slid along by one would land on Column c.
    const plotted = [series('Column a', 0), series('Column b', 1, true), series('Column c', 2)];
    const tip = hover(plotted);
    const labels = [...tip.querySelectorAll<HTMLElement>('.ms-chart-tooltip-label')];
    expect(labels.map((label) => label.textContent)).toEqual([
      'Column a',
      'Column b (retired)',
      'Column c',
    ]);
    // In the label's text ink (the stylesheet's `--ms-text-muted`), never its series colour: the
    // key wears the colour, the words wear none of it.
    for (const label of labels) expect(label.getAttribute('style')).toBeNull();
    const keys = [...tip.querySelectorAll<HTMLElement>('.ms-chart-tooltip-key')];
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key.style.background !== '')).toBe(true);

    // The same words as the legend beside the chart.
    render(<SeriesLegend series={plotted} latest={['2', '3', '4']} />);
    for (const entry of plotted) expect(screen.getByText(seriesName(entry))).toBeDefined();
  });

  it('says nothing of retirement when no series is retired', () => {
    const tip = hover([series('Column a', 0), series('Column b', 1)]);
    expect(tip.textContent).not.toContain('retired');
  });
});

describe('hiding retired channels in the History tab', () => {
  const NOW = Date.parse('2026-10-09T12:00:00.000Z');
  const buckets = [0, 1, 2].map((minute) => new Date(NOW - (2 - minute) * 60_000).toISOString());
  const history = (id: number, key: string): HistoryChannel => ({
    id,
    key,
    name: `Column ${key}`,
    unit: '',
    decimals: null,
    avg: [id, id + 1, id + 2],
    min: [id, id + 1, id + 2],
    max: [id, id + 1, id + 2],
    count: [1, 1, 1],
  });
  const answer: HistorySeries = {
    sensorId: 9,
    from: buckets[0] ?? '',
    to: new Date(NOW).toISOString(),
    resolutionSeconds: 60,
    bucketCount: buckets.length,
    source: 'sample',
    buckets,
    // One unit, so one panel: the retired channel is the middle series, not the last.
    channels: [history(1, 'a'), history(2, 'b'), history(3, 'c'), history(4, 'd')],
    segments: [],
    adjustments: [],
  };
  const CHANNELS = [channel(1, 'a'), channel(2, 'b', true), channel(3, 'c'), channel(4, 'd')];

  /** The panel with its choice held outside it, as the page holds it (in its URL). */
  function Held(): React.JSX.Element {
    const [hide, setHide] = useState(false);
    return (
      <HistoryPanel
        sensorId={9}
        channels={CHANNELS}
        hideRetired={hide}
        onHideRetiredChange={setHide}
      />
    );
  }

  beforeEach(() => {
    charted.length = 0;
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/sensors/9/history')
          ? new Response(JSON.stringify(answer), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 404 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const legend = (): string[] =>
    screen
      .getAllByRole('listitem')
      .map((entry) => entry.querySelector('.text-text-muted')?.textContent ?? '');
  const lastCharted = (): string[] => (charted.at(-1) ?? []).map(seriesName);

  it('takes a middle series out and leaves every other one its own mark and colour', async () => {
    render(<Held />);
    expect(await screen.findByText('Column b (retired)')).toBeDefined();
    expect(legend()).toEqual(['Column a', 'Column b (retired)', 'Column c', 'Column d']);
    expect(lastCharted()).toEqual(['Column a', 'Column b (retired)', 'Column c', 'Column d']);
    const box = screen.getByRole('checkbox', { name: 'Hide retired channels' });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(box.closest('label')?.nextElementSibling?.textContent).toBe('');

    fireEvent.click(box);
    // Neither the legend nor the tooltip's series (what the chart is handed) marks Column c,
    // which now stands where Column b stood.
    expect(legend()).toEqual(['Column a', 'Column c', 'Column d']);
    expect(lastCharted()).toEqual(['Column a', 'Column c', 'Column d']);
    expect(screen.queryByText(/retired\)/)).toBeNull();
    expect(box.closest('label')?.nextElementSibling?.textContent).toBe('1 retired channel hidden.');
    // Colour follows the channel: Column c keeps its third slot with Column b gone.
    expect((charted.at(-1) ?? []).map((entry) => entry.slot)).toEqual([0, 2, 3]);
    // The note on what retired means explains a mark no longer on the page.
    expect(screen.queryByText(/so its line ends there/)).toBeNull();

    // The table view leaves it out too.
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.queryByRole('columnheader', { name: /Column b/ })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Column c' })).toBeDefined();

    fireEvent.click(box);
    expect(screen.getByRole('columnheader', { name: 'Column b (retired)' })).toBeDefined();
  });

  it('offers no control when nothing charted is retired', async () => {
    render(
      <HistoryPanel
        sensorId={9}
        channels={CHANNELS.map((one) => ({ ...one, retired: false }))}
        hideRetired={false}
        onHideRetiredChange={() => undefined}
      />,
    );
    expect(await screen.findAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('when the channel list is stale', () => {
  const values = (
    retired: Record<number, boolean>,
    reading: number | null = null,
  ): SensorValues => ({
    sensorId: 9,
    readAt: '2026-10-09T12:00:00.000Z',
    notBefore: '2026-10-09T11:57:00.000Z',
    intervalSeconds: 60,
    channels: Object.entries(retired).map(([id, one]) => ({
      id: Number(id),
      key: `k${id}`,
      name: `k${id}`,
      unit: '',
      decimals: null,
      value: reading,
      at: reading === null ? null : '2026-10-09T11:59:40.000Z',
      retired: one,
    })),
  });
  const LIST = [channel(1, 'a'), channel(2, 'b', true)];

  it('is not, on an ordinary poll that agrees with it', () => {
    expect(channelListIsStale(LIST, values({ 1: false, 2: true }))).toBe(false);
  });

  it('is not for a reading taken before the edit, which leaves the channel retired', () => {
    expect(channelListIsStale(LIST, values({ 1: false, 2: true }, 42))).toBe(false);
  });

  it('is when a poll says a channel it holds as retired is read again', () => {
    expect(channelListIsStale(LIST, values({ 1: false, 2: false }, 42))).toBe(true);
  });

  it('is when a poll says a channel it holds as live has been retired since', () => {
    expect(channelListIsStale(LIST, values({ 1: true, 2: true }))).toBe(true);
  });

  // `U-61`: an edit gave the sensor a channel since the list was read, and the poll names it.
  it('is for a channel the poll names and it does not hold, retired or not', () => {
    expect(channelListIsStale(LIST, values({ 1: false, 2: true, 3: false }))).toBe(true);
    expect(channelListIsStale(LIST, values({ 1: false, 2: true, 3: true }))).toBe(true);
  });

  it('is not for a channel it holds that the poll does not name', () => {
    expect(channelListIsStale(LIST, values({ 1: false }))).toBe(false);
  });
});
