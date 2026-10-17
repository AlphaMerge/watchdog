import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRecord, HistoryChannel, HistorySeries, SensorValues } from '../src/api/types';
import { SeriesTable } from '../src/charts/SeriesTable';
import { dataFor, rowsFor } from '../src/charts/time-series-model';
import { ChannelTable } from '../src/routes/detail/ChannelTable';
import { HistoryPanel } from '../src/routes/detail/HistoryPanel';

// The canvas is uPlot's and carries no text (it is `aria-hidden`); what is read is the legend,
// the heading and the table view, which is what these tests are about.
vi.mock('../src/charts/TimeSeriesChart', () => ({ TimeSeriesChart: () => null }));

/**
 * A channel an edit took out of a sensor's parameters (`P-310`), as the sensor page shows it.
 *
 * The core says `retired` on the channel; the table says so beside the name, as it says
 * `primary`, and does not call its silence "no recent reading", which reads as an outage. Its
 * history is the other half: the line stops at the edit, as a gap, and never falls to zero.
 */

const NO_LIMITS: ChannelRecord['limits'] = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

function channel(id: number, key: string, over: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id,
    key,
    name: `Column ${key}`,
    unit: '',
    isPrimary: false,
    limits: NO_LIMITS,
    scaleMul: '1',
    scaleDiv: '1',
    decimals: null,
    spikeMin: null,
    spikeMax: null,
    lookupId: null,
    counterBits: null,
    declaredLookup: null,
    retired: false,
    ...over,
  };
}

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

function values(readings: Record<number, { value: number; at: string } | null>): SensorValues {
  return {
    sensorId: 9,
    readAt: new Date(NOW).toISOString(),
    notBefore: new Date(NOW - 180_000).toISOString(),
    intervalSeconds: 60,
    channels: Object.entries(readings).map(([id, reading]) => ({
      id: Number(id),
      key: `k${id}`,
      name: `k${id}`,
      unit: '',
      decimals: null,
      value: reading?.value ?? null,
      at: reading?.at ?? null,
      retired: false,
    })),
  };
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

describe('a retired channel in the channel table', () => {
  const CHANNELS = [
    channel(1, 'a', { isPrimary: true }),
    channel(2, 'b', { retired: true, limits: { ...NO_LIMITS, upperError: 10 } }),
  ];

  it('is marked retired beside its name, and a live one is not', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="snmp.table"
          values={values({ 1: { value: 4, at: new Date(NOW - 30_000).toISOString() }, 2: null })}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(within(rowOf('Column b')).getByText('retired')).toBeDefined();
    expect(within(rowOf('Column a')).queryByText('retired')).toBeNull();
  });

  it('explains it to someone who cannot hover: on the page, and as the row’s description', () => {
    // A title reaches a mouse and nothing else (`add-sensor-model.ts` says the same of a time).
    // What a keyboard, touch or screen-reader user gets is the text on the page and the
    // accessible description of the row's header and its reading.
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="snmp.table"
          values={values({ 1: null, 2: null })}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    const note = screen.getByText(/history is kept; put it back to read it again/i);
    expect(note.textContent).toMatch(/^Retired: .*nothing reads it/);

    const explained = /nothing reads it any more.*history is kept; put it back to read it again/i;
    const header = screen.getByRole('rowheader', { description: explained });
    expect(header.textContent).toContain('Column b');
    const reading = screen.getByRole('cell', { description: explained });
    expect(reading.textContent).toBe('not read');
    // Described once each, and the live row not at all.
    expect(screen.getAllByRole('rowheader', { description: explained })).toHaveLength(1);
    expect(
      screen.getByRole('rowheader', { name: /Column a/ }).getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('carries no note when nothing is retired', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={[channel(1, 'a', { isPrimary: true })]}
          sensorType="snmp.table"
          values={null}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/history is kept/i)).toBeNull();
  });

  it('says it is not read, not that a reading is missing', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={[...CHANNELS, channel(3, 'c')]}
          sensorType="snmp.table"
          values={values({ 1: null, 2: null, 3: null })}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    const retired = rowOf('Column b');
    expect(within(retired).getByText('not read')).toBeDefined();
    expect(within(retired).queryByText('no recent reading')).toBeNull();
    // A live channel with nothing recent is an outage, and says so as before.
    expect(within(rowOf('Column c')).getByText('no recent reading')).toBeDefined();
    expect(within(rowOf('Column c')).queryByText('not read')).toBeNull();
  });

  it('says it is not read when the values have not arrived either', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="snmp.table"
          values={null}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(within(rowOf('Column b')).getByText('not read')).toBeDefined();
    expect(within(rowOf('Column a')).getByText('—')).toBeDefined();
  });

  it('still shows a reading taken before the edit while it is recent', () => {
    // A probe that had not yet heard of the edit read it; that is a reading, and it is true.
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="snmp.table"
          values={values({ 1: null, 2: { value: 42, at: new Date(NOW - 20_000).toISOString() } })}
          lookups={null}
          now={NOW}
          hideRetired={false}
          onHideRetiredChange={() => undefined}
        />
      </MemoryRouter>,
    );
    const retired = rowOf('Column b');
    expect(within(retired).getByText('42')).toBeDefined();
    expect(within(retired).queryByText('not read')).toBeNull();
    expect(within(retired).getByText('retired')).toBeDefined();
  });
});

describe('a retired channel’s history', () => {
  // Read for three buckets, retired at the fourth: what `GET /sensors/:id/history` answers, a
  // null wherever a bucket has no reading (`S-08`).
  const buckets = [0, 1, 2, 3, 4, 5].map((minute) =>
    new Date(NOW - (5 - minute) * 60_000).toISOString(),
  );
  const live: HistoryChannel = {
    id: 1,
    key: 'a',
    name: 'Column a',
    unit: '',
    decimals: null,
    avg: [3, 4, 5, 6, 7, 8],
    min: [3, 4, 5, 6, 7, 8],
    max: [3, 4, 5, 6, 7, 8],
    count: [1, 1, 1, 1, 1, 1],
  };
  const retired: HistoryChannel = {
    id: 2,
    key: 'b',
    name: 'Column b',
    unit: '',
    decimals: null,
    avg: [40, 41, 42, null, null, null],
    min: [40, 41, 42, null, null, null],
    max: [40, 41, 42, null, null, null],
    count: [1, 1, 1, null, null, null],
  };

  it('hands the chart a gap after the edit, never a zero', () => {
    const data = dataFor(
      buckets.map((bucket) => Date.parse(bucket) / 1_000),
      [live, retired].map((series, slot) => ({
        label: series.name,
        slot,
        avg: series.avg,
        min: series.min,
        max: series.max,
      })),
    );
    expect(data[rowsFor(1).avg]).toEqual([40, 41, 42, null, null, null]);
    expect(data[rowsFor(1).min]).toEqual([40, 41, 42, null, null, null]);
    expect(data[rowsFor(1).max]).toEqual([40, 41, 42, null, null, null]);
    expect(data[rowsFor(0).avg]).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('shows a dash in the table for every bucket after the edit, and no zero', () => {
    render(
      <SeriesTable
        channels={[live, retired]}
        buckets={buckets}
        format={(_channel, value) => String(value)}
        caption="history"
      />,
    );
    // Newest first, so the first three rows are the buckets after the edit.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows.slice(0, 3)) {
      const cells = within(row).getAllByRole('cell');
      expect(cells[1]?.textContent).toBe('—');
      expect(cells[0]?.textContent).not.toBe('—');
    }
    for (const row of rows.slice(3)) {
      expect(within(row).getAllByRole('cell')[1]?.textContent).toMatch(/^4[0-2]$/);
    }
    expect(screen.queryByText('0')).toBeNull();
  });
});

describe('a retired channel in the History tab’s legend (`U-37`)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const buckets = [0, 1, 2].map((minute) => new Date(NOW - (2 - minute) * 60_000).toISOString());
  const series = (id: number, key: string, unit = ''): HistoryChannel => ({
    id,
    key,
    name: `Column ${key}`,
    unit,
    decimals: null,
    avg: [1, 2, id === 2 ? null : 3],
    min: [1, 2, id === 2 ? null : 3],
    max: [1, 2, id === 2 ? null : 3],
    count: [1, 1, id === 2 ? null : 1],
  });

  /** The History tab, its history answered with these channels. */
  const mount = (history: HistoryChannel[], channels: ChannelRecord[]): void => {
    const answer: HistorySeries = {
      sensorId: 9,
      from: buckets[0] ?? '',
      to: new Date(NOW).toISOString(),
      resolutionSeconds: 60,
      bucketCount: buckets.length,
      source: 'sample',
      buckets,
      channels: history,
      segments: [],
      adjustments: [],
    };
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
    render(
      <HistoryPanel
        sensorId={9}
        channels={channels}
        hideRetired={false}
        onHideRetiredChange={() => undefined}
      />,
    );
  };

  it('says retired in the entry’s text, and a live channel’s entry does not', async () => {
    mount(
      [series(1, 'a'), series(2, 'b')],
      [channel(1, 'a', { isPrimary: true }), channel(2, 'b', { retired: true })],
    );
    const entries = await screen.findAllByRole('listitem');
    const retired = entries.find((entry) => entry.textContent.includes('Column b'));
    const live = entries.find((entry) => entry.textContent.includes('Column a'));
    expect(retired?.textContent).toContain('Column b (retired)');
    expect(live?.textContent).not.toContain('retired');
    // In text ink, never the series colour: the words carry it, the key carries identity.
    const label = screen.getByText('Column b (retired)');
    expect(label.getAttribute('style')).toBeNull();
    expect(label.className).toContain('text-text-muted');
    // And what it means, in words on the page.
    expect(screen.getByText(/nothing reads it any more, so its line ends there/)).toBeDefined();
  });

  it('says nothing of retirement when no channel is retired', async () => {
    mount([series(1, 'a'), series(2, 'b')], [channel(1, 'a'), channel(2, 'b')]);
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/retired/)).toBeNull();
  });

  it('says it in the heading of a panel of one, which has no legend', async () => {
    // Its own unit, so it is charted alone and the heading is what names it.
    mount(
      [series(1, 'a'), series(3, 'c', 'ms')],
      [channel(1, 'a'), channel(3, 'c', { unit: 'ms', retired: true })],
    );
    expect(await screen.findByRole('heading', { name: /Column c \(retired\)/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Column a' })).toBeDefined();
  });

  it('says it in the table view’s column heading too', async () => {
    mount([series(1, 'a'), series(2, 'b')], [channel(1, 'a'), channel(2, 'b', { retired: true })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('columnheader', { name: 'Column b (retired)' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Column a' })).toBeDefined();
  });
});

describe('hiding retired channels in the channel table (`U-38`)', () => {
  const CHANNELS = [
    channel(1, 'a', { isPrimary: true }),
    channel(2, 'b', { retired: true }),
    channel(3, 'c', { retired: true }),
  ];
  /** The table with its choice held outside it, as the page holds it (in its URL). */
  function Held({ channels }: { channels: ChannelRecord[] }): React.JSX.Element {
    const [hide, setHide] = useState(false);
    return (
      <ChannelTable
        channels={channels}
        sensorType="snmp.table"
        values={null}
        lookups={null}
        now={NOW}
        hideRetired={hide}
        onHideRetiredChange={setHide}
      />
    );
  }
  const mount = (channels: ChannelRecord[]): void => {
    render(
      <MemoryRouter>
        <Held channels={channels} />
      </MemoryRouter>,
    );
  };

  it('shows them by default, marked, and hides them when asked, saying how many', () => {
    mount(CHANNELS);
    const hide = screen.getByRole('checkbox', { name: 'Hide retired channels' });
    expect((hide as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Column b')).toBeDefined();
    expect(screen.getByText('Column c')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(hide);
    expect(screen.queryByText('Column b')).toBeNull();
    expect(screen.queryByText('Column c')).toBeNull();
    expect(screen.getByText('Column a')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('2 retired channels hidden.');
    // The note explains a mark no longer on the page, so it goes with them.
    expect(screen.queryByText(/history is kept/i)).toBeNull();

    fireEvent.click(hide);
    expect(screen.getByText('Column b')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('counts one in the singular', () => {
    mount([channel(1, 'a'), channel(2, 'b', { retired: true })]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide retired channels' }));
    expect(screen.getByRole('status').textContent).toBe('1 retired channel hidden.');
  });

  it('offers no control when nothing is retired', () => {
    mount([channel(1, 'a'), channel(2, 'b')]);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
