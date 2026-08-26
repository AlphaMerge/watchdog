import { describe, expect, it } from 'vitest';
import { extentOf } from '../src/routes/detail/HistoryPanel';
import { formatValue, howLongAgo } from '../src/routes/detail/ChannelTable';
import { formatDuration } from '../src/routes/detail/StateLogPanel';
import { nextTab } from '../src/components/Tabs';
import type { HistoryChannel } from '../src/api/types';

function channel(avg: (number | null)[], spread = 0): HistoryChannel {
  return {
    id: 1,
    key: 'rtt',
    name: 'Response time',
    unit: 'ms',
    avg,
    min: avg.map((value) => (value === null ? null : value - spread)),
    max: avg.map((value) => (value === null ? null : value + spread)),
    count: avg.map((value) => (value === null ? null : 1)),
  };
}

describe('the extent of a series', () => {
  it('spans the readings and ignores the gaps', () => {
    const extent = extentOf(channel([1, null, 5, null, 3]));
    expect(extent).not.toBeNull();
    expect(extent?.low).toBe(1);
    expect(extent?.high).toBe(5);
    expect(extent?.present).toBe(3);
  });

  it('spans the min and max, not only the averages', () => {
    // An average over an hour hides the spike that made somebody open the page. A plot scaled to
    // the averages would clip the very thing they came to see.
    const extent = extentOf(channel([10, 10], 4));
    expect(extent?.low).toBe(6);
    expect(extent?.high).toBe(14);
  });

  it('is null when every bucket is a gap', () => {
    // Not a zero-height plot: there is nothing to draw, and drawing a flat line at zero would
    // say the sensor measured nothing rather than that it measured nothing.
    expect(extentOf(channel([null, null, null]))).toBeNull();
  });

  it('keeps the measured range apart from the padded drawing scale', () => {
    // The bug this exists to prevent: a packet-loss channel that has only ever read 0 was
    // labelled "-1 % to 1 %", inventing a negative reading out of the plot's own geometry.
    const extent = extentOf(channel([0, 0, 0]));
    expect(extent?.low).toBe(0);
    expect(extent?.high).toBe(0);
    expect(extent?.floor).toBe(-1);
    expect(extent?.ceiling).toBe(1);
  });

  it('pads a flat non-zero series relative to its own magnitude', () => {
    const extent = extentOf(channel([200, 200]));
    expect(extent?.floor).toBe(180);
    expect(extent?.ceiling).toBe(220);
  });

  it('does not pad a series that already has a range', () => {
    const extent = extentOf(channel([1, 9]));
    expect(extent?.floor).toBe(1);
    expect(extent?.ceiling).toBe(9);
  });
});

describe('formatting a reading', () => {
  it('appends the unit, and omits it when there is none', () => {
    expect(formatValue(1.5, 'ms', null)).toBe('1.5 ms');
    expect(formatValue(1.5, '', null)).toBe('1.5');
  });

  it('honours the channel precision, and keeps a zero a zero', () => {
    expect(formatValue(0, '%', 2)).toBe('0.00 %');
    expect(formatValue(0, '%', null)).toBe('0 %');
  });

  it('does not round a small reading away to nothing', () => {
    // 0.223 ms displayed as "0 ms" would make a healthy LAN look like a broken clock.
    expect(formatValue(0.223, 'ms', null)).toBe('0.223 ms');
  });
});

describe('saying how long ago', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  const ago = (ms: number): string => howLongAgo(new Date(now - ms).toISOString(), now);

  it('counts up through the units', () => {
    expect(ago(5_000)).toBe('5s ago');
    expect(ago(5 * 60_000)).toBe('5m ago');
    expect(ago(5 * 3_600_000)).toBe('5h ago');
    expect(ago(5 * 86_400_000)).toBe('5d ago');
  });

  it('never reports a reading as being from the future', () => {
    // Clock skew between the core and the browser is ordinary, and "-3s ago" reads as a bug in
    // the monitoring system rather than as a bug in the clocks.
    expect(howLongAgo(new Date(now + 3_000).toISOString(), now)).toBe('0s ago');
  });
});

describe('formatting a duration', () => {
  it('picks the largest unit that still says something', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(10 * 60_000)).toBe('10m');
    expect(formatDuration(3 * 3_600_000)).toBe('3.0h');
    expect(formatDuration(5 * 86_400_000)).toBe('5.0d');
  });
});

describe('moving between tabs with the keyboard', () => {
  const TABS = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];

  it('steps left and right', () => {
    expect(nextTab('ArrowRight', TABS, 'a')).toBe('b');
    expect(nextTab('ArrowLeft', TABS, 'b')).toBe('a');
  });

  it('wraps in both directions', () => {
    // A tab strip is a ring. Stopping at the end makes the last tab feel broken.
    expect(nextTab('ArrowRight', TABS, 'c')).toBe('a');
    expect(nextTab('ArrowLeft', TABS, 'a')).toBe('c');
  });

  it('jumps to the ends', () => {
    expect(nextTab('Home', TABS, 'b')).toBe('a');
    expect(nextTab('End', TABS, 'b')).toBe('c');
  });

  it('ignores keys that are not its own, so typing still works', () => {
    expect(nextTab('a', TABS, 'a')).toBeNull();
    expect(nextTab('Enter', TABS, 'a')).toBeNull();
  });

  it('copes with an active id that is not in the list', () => {
    expect(nextTab('ArrowRight', TABS, 'gone')).toBe('b');
  });
});
