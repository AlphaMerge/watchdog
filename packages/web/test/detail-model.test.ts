import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatSeconds,
  formatValue,
  howLongAgo,
  lastReading,
  summarise,
} from '../src/routes/detail/model';
import { nextTab } from '../src/components/tabs-model';
import type { HistoryChannel } from '../src/api/types';

export function channel(
  avg: (number | null)[],
  options: { spread?: number; unit?: string; name?: string; id?: number } = {},
): HistoryChannel {
  const spread = options.spread ?? 0;
  return {
    id: options.id ?? 1,
    key: 'rtt',
    name: options.name ?? 'Response time',
    unit: options.unit ?? 'ms',
    decimals: null,
    avg,
    min: avg.map((value) => (value === null ? null : value - spread)),
    max: avg.map((value) => (value === null ? null : value + spread)),
    count: avg.map((value) => (value === null ? null : 1)),
  };
}

describe('the newest reading in a range', () => {
  it('skips trailing gaps to find it', () => {
    expect(lastReading(channel([1, 5, null, null]))).toBe(5);
  });

  it('is null when the whole range is a gap', () => {
    expect(lastReading(channel([null, null]))).toBeNull();
  });

  it('finds a genuine zero rather than reading it as absent', () => {
    // The recurring trap: `value || null` would turn a healthy 0% packet loss into "no data".
    expect(lastReading(channel([5, 0]))).toBe(0);
  });
});

describe('summarising a panel', () => {
  const group = (avg: (number | null)[], spread = 0) => ({
    unit: 'ms',
    series: [{ channel: channel(avg, { spread }), slot: 0 }],
  });

  it('quotes the measured range, not a padded drawing scale', () => {
    // A packet-loss channel that has only ever read 0 was once labelled "-1 % to 1 %", inventing
    // a negative reading out of the plot's own geometry. uPlot pads its own scale now; the
    // words beside the heading report what was actually measured.
    expect(summarise(group([0, 0, 0]), { low: 0, high: 0 })).toBe('steady at 0 ms');
  });

  it('reports the span when there is one, and counts the gaps', () => {
    expect(summarise(group([1, null, 5]), { low: 1, high: 5 })).toBe(
      '1 ms to 5 ms · 1 of 3 buckets are gaps',
    );
  });

  it('says so when nothing was recorded', () => {
    expect(summarise(group([null, null]), null)).toBe(
      'no readings in this range · 2 of 2 buckets are gaps',
    );
  });
});

describe('formatting a resolution', () => {
  it('uses the largest whole unit', () => {
    expect(formatSeconds(30)).toBe('30s');
    expect(formatSeconds(180)).toBe('3m');
    expect(formatSeconds(7_200)).toBe('2h');
    expect(formatSeconds(86_400)).toBe('1d');
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
    expect(formatValue(0.000412, 'ms', null)).toBe('0.000412 ms');
  });

  it('does not claim the precision an average manufactured', () => {
    // A 45-minute average of a sub-millisecond RTT comes back as 0.20335648…; six decimal places
    // of it are an artefact of dividing, and printing them says the device is that precise.
    expect(formatValue(0.20335648, 'ms', null)).toBe('0.203 ms');
    expect(formatValue(246.10004, 'ms', null)).toBe('246 ms');
    expect(formatValue(12.3456, 'ms', null)).toBe('12.3 ms');
  });

  it('honours a configured precision exactly, padding included', () => {
    // A channel set to two places wants "0.20", not "0.2" — the trailing zero is the claim.
    expect(formatValue(0.2, '%', 2)).toBe('0.20 %');
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
