import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ChannelRecord, HistoryChannel, SensorValues } from '../src/api/types';
import { SeriesTable } from '../src/charts/SeriesTable';
import { dataFor, rowsFor } from '../src/charts/time-series-model';
import { ChannelTable } from '../src/routes/detail/ChannelTable';

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
