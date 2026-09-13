import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  LIGHT_CHART_THEME,
  SERIES_SLOTS,
  groupByUnit,
  groupExtent,
  hasReadings,
  seriesColour,
  seriesWash,
  type ChartChannel,
} from '../src/charts/index.js';

/**
 * The charting decisions, where both the web app and the report renderer read them (`E-05`).
 *
 * These cases moved here from `packages/web/test/charts.test.ts` with the code they test — a rule
 * that lives in one place should be proved in that place, not in whichever consumer happened to
 * be written first.
 */

function channel(name: string, unit: string, avg: (number | null)[], spread = 0): ChartChannel {
  return {
    key: name.toLowerCase(),
    name,
    unit,
    decimals: null,
    avg,
    min: avg.map((value) => (value === null ? null : value - spread)),
    max: avg.map((value) => (value === null ? null : value + spread)),
  };
}

describe('grouping channels into charts', () => {
  it('puts channels with different units on different charts', () => {
    // The dual-axis trap. A 250 ms response time and a 0–100 % loss on one y-axis means either
    // loss is invisible or the scale is meaningless; on two axes the crossing point of the lines
    // is an artefact of where the axes were put, and a reader takes it for a relationship.
    const groups = groupByUnit([
      channel('Response time', 'ms', [1]),
      channel('Packet loss', '%', [0]),
    ]);
    assert.deepEqual(
      groups.map((group) => group.unit),
      ['ms', '%'],
    );
    assert.ok(groups.every((group) => group.series.length === 1));
  });

  it('keeps channels that share a unit together', () => {
    // Where comparison is real: a Traffic sensor's in, out and sum belong on one axis.
    const groups = groupByUnit([
      channel('In', 'kbit/s', [1]),
      channel('Out', 'kbit/s', [2]),
      channel('Sum', 'kbit/s', [3]),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0]?.series.map((entry) => entry.channel.name),
      ['In', 'Out', 'Sum'],
    );
  });

  it('assigns a colour slot by the channel position, not the position in its group', () => {
    // Colour follows the entity, never its rank. Splitting by unit must not repaint anything.
    const groups = groupByUnit([
      channel('Response time', 'ms', [1]),
      channel('Packet loss', '%', [0]),
      channel('Jitter', 'ms', [1]),
    ]);
    assert.deepEqual(
      groups.find((group) => group.unit === 'ms')?.series.map((entry) => entry.slot),
      [0, 2],
    );
    // Packet loss keeps slot 1 even though it is the only series on its own chart.
    assert.deepEqual(
      groups.find((group) => group.unit === '%')?.series.map((entry) => entry.slot),
      [1],
    );
  });

  it('keeps unitless channels together rather than one chart each', () => {
    const groups = groupByUnit([channel('Replies', '', [4]), channel('Sent', '', [4])]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.unit, '');
  });

  it('preserves the order the channels came in, which is primary first', () => {
    const groups = groupByUnit([
      channel('Packet loss', '%', [0]),
      channel('Response time', 'ms', [1]),
    ]);
    assert.equal(groups[0]?.unit, '%');
  });

  it('keeps the caller’s own channel type, so nothing downstream has to cast', () => {
    const rich = [{ ...channel('a', 'ms', [1]), id: 7 }];
    const [group] = groupByUnit(rich);
    assert.equal(group?.series[0]?.channel.id, 7);
  });
});

describe('a chart extent', () => {
  it('spans min and max across every series, not only the averages', () => {
    // An average over an hour hides the spike somebody opened the page to see; a scale built
    // from averages would clip it.
    const extent = groupExtent({
      unit: 'ms',
      series: [
        { channel: channel('a', 'ms', [10], 4), slot: 0 },
        { channel: channel('b', 'ms', [20], 2), slot: 1 },
      ],
    });
    assert.deepEqual(extent, { low: 6, high: 22 });
  });

  it('ignores gaps rather than treating them as zero', () => {
    const extent = groupExtent({
      unit: 'ms',
      series: [{ channel: channel('a', 'ms', [null, 5, null]), slot: 0 }],
    });
    assert.deepEqual(extent, { low: 5, high: 5 });
  });

  it('uses the average where a bucket carries no spread', () => {
    // A report section may hold averages alone. Treating a missing edge as "nothing recorded"
    // would size the axis to nothing and draw every reading off the chart.
    const extent = groupExtent({
      unit: 'ms',
      series: [
        {
          channel: { ...channel('a', 'ms', [3, 9]), min: [null, null], max: [null, null] },
          slot: 0,
        },
      ],
    });
    assert.deepEqual(extent, { low: 3, high: 9 });
  });

  it('is null when nothing was recorded', () => {
    const extent = groupExtent({
      unit: 'ms',
      series: [{ channel: channel('a', 'ms', [null, null]), slot: 0 }],
    });
    assert.equal(extent, null);
  });

  it('knows a channel with no readings from one that read zero', () => {
    assert.equal(hasReadings(channel('a', '%', [null, null])), false);
    assert.equal(hasReadings(channel('a', '%', [null, 0])), true);
  });
});

describe('the chart palette', () => {
  it('gives every slot a distinct colour', () => {
    const used = new Set(
      Array.from({ length: SERIES_SLOTS }, (_, slot) => seriesColour(LIGHT_CHART_THEME, slot)),
    );
    assert.equal(used.size, SERIES_SLOTS);
  });

  it('never invents a ninth hue', () => {
    // The palette was validated as eight. A generated colour is one nobody checked for
    // separation, so past the eighth slot the answer is ink.
    assert.equal(seriesColour(LIGHT_CHART_THEME, SERIES_SLOTS), LIGHT_CHART_THEME.inkMuted);
    assert.equal(seriesColour(LIGHT_CHART_THEME, -1), LIGHT_CHART_THEME.inkMuted);
  });

  it('washes a hue for the min-max band rather than saturating it', () => {
    assert.equal(seriesWash('#2a78d6', 0.14), 'rgba(42, 120, 214, 0.14)');
    assert.equal(seriesWash('currentColor'), 'currentColor');
  });
});
