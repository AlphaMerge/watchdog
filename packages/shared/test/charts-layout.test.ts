import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  groupByUnit,
  layoutChart,
  type ChartChannel,
  type ChartInput,
  type ChartLayout,
  type TimeTick,
} from '../src/charts/index.js';

/**
 * A chart's geometry, as numbers a test can read (`E-05`, `ADR-006` Decision 3).
 *
 * Every rule a reader could notice on a printed graph is asserted here rather than looked at: that
 * a gap breaks the line, that a lone reading is not lost, that nothing is drawn outside the plot,
 * and that no two axis labels sit on top of each other.
 */

const HOUR = 3_600_000;
const measure = (text: string, size: number): number => text.length * size * 0.55;

function channel(name: string, unit: string, avg: (number | null)[], spread = 1): ChartChannel {
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

/** Hourly ticks, three-hourly and daily, as the core's calendar would hand them over. */
function ticksFor(count: number): TimeTick[][] {
  const every = (step: number): TimeTick[] =>
    Array.from({ length: Math.floor(count / step) + 1 }, (_, index) => ({
      at: index * step * HOUR,
      label: `${String(index * step).padStart(2, '0')}:00`,
    }));
  return [every(1), every(3), every(24)];
}

function input(channels: ChartChannel[], overrides: Partial<ChartInput> = {}): ChartInput {
  const length = channels[0]?.avg.length ?? 0;
  const [group] = groupByUnit(channels);
  assert.ok(group !== undefined);
  return {
    group,
    times: Array.from({ length }, (_, index) => index * HOUR),
    from: 0,
    to: length * HOUR,
    timeTicks: ticksFor(length),
    width: 500,
    plotHeight: 140,
    measure,
    fontSize: 8,
    ...overrides,
  };
}

const drawn = (layout: ChartLayout): number =>
  layout.series.reduce(
    (total, series) =>
      total + series.dots.length + series.lines.reduce((sum, line) => sum + line.length, 0),
    0,
  );

describe('a chart’s geometry', () => {
  describe('keeps a gap a gap', () => {
    it('breaks the line where a bucket has no reading', () => {
      // `CLAUDE.md`: graphs break the line; they never draw to zero. A line joined across a gap
      // is a claim that the value moved smoothly through an outage.
      const [series] = layoutChart(input([channel('Ping', 'ms', [1, 2, null, 4, 5])])).series;
      assert.ok(series !== undefined);
      assert.equal(series.lines.length, 2);
      assert.deepEqual(
        series.lines.map((line) => line.length),
        [2, 2],
      );
      assert.equal(series.dots.length, 0);
    });

    it('draws a reading with a gap on both sides as a dot, rather than losing it', () => {
      // **The easiest way there is to lose a measurement without anything failing.** A polyline
      // of one point has no length and draws nothing.
      const [series] = layoutChart(input([channel('Ping', 'ms', [1, null, 3, null, 5, 6])])).series;
      assert.ok(series !== undefined);
      assert.equal(series.dots.length, 2);
      assert.equal(series.lines.length, 1);
    });

    it('draws every reading exactly once, whatever the gaps', () => {
      fc.assert(
        fc.property(
          fc.array(fc.option(fc.double({ min: 0, max: 1_000, noNaN: true }), { nil: null }), {
            minLength: 1,
            maxLength: 60,
          }),
          (avg) => {
            const layout = layoutChart(input([channel('Ping', 'ms', avg)]));
            assert.equal(drawn(layout), avg.filter((value) => value !== null).length);
          },
        ),
      );
    });

    it('bands only where both edges are known, and puts the maximum above the minimum', () => {
      const layout = layoutChart(input([channel('Ping', 'ms', [10, 12, null, 8, 9], 3)]));
      const [series] = layout.series;
      assert.ok(series !== undefined);
      assert.equal(series.bands.length, 2);
      for (const band of series.bands) {
        const half = band.length / 2;
        for (let index = 0; index < half; index += 1) {
          const upper = band[index];
          const lower = band[band.length - 1 - index];
          assert.ok(upper !== undefined && lower !== undefined);
          assert.equal(upper.x, lower.x, 'the polygon comes back the way it went');
          assert.ok(upper.y < lower.y, 'and the maximum is higher on the page');
        }
      }
    });

    it('says a group with nothing in it is empty, instead of drawing a blank rectangle', () => {
      const layout = layoutChart(input([channel('Ping', 'ms', [null, null, null])]));
      assert.equal(layout.empty, true);
      assert.equal(drawn(layout), 0);
      const zero = layoutChart(input([channel('Ping', 'ms', [null, 0, null])]));
      assert.equal(zero.empty, false, 'a reading of zero is a reading');
    });
  });

  describe('stays inside its own frame', () => {
    it('draws every point inside the plot, for any data', () => {
      fc.assert(
        fc.property(
          fc.array(fc.option(fc.double({ min: -1e5, max: 1e5, noNaN: true }), { nil: null }), {
            minLength: 2,
            maxLength: 48,
          }),
          fc.integer({ min: 160, max: 900 }),
          (avg, width) => {
            const layout = layoutChart(input([channel('Temp', '°C', avg, 2)], { width }));
            const { left, right, top, bottom } = layout.plot;
            for (const series of layout.series) {
              const points = [...series.dots, ...series.lines.flat(), ...series.bands.flat()];
              for (const point of points) {
                assert.ok(point.x >= left - 0.1 && point.x <= right + 0.1, `x ${String(point.x)}`);
                assert.ok(point.y >= top - 0.1 && point.y <= bottom + 0.1, `y ${String(point.y)}`);
              }
            }
          },
        ),
      );
    });

    it('starts the axis at zero for a magnitude, with the zero tick on the floor of the plot', () => {
      const layout = layoutChart(input([channel('Ping', 'ms', [243, 244, 245], 0)]));
      const [floor] = layout.yTicks;
      assert.ok(floor !== undefined);
      assert.equal(floor.label, '0');
      assert.equal(floor.y, layout.plot.bottom);
    });

    it('moves forward in time from left to right', () => {
      const [series] = layoutChart(input([channel('Ping', 'ms', [5, 6, 7, 8])])).series;
      const xs = series?.lines[0]?.map((point) => point.x) ?? [];
      assert.deepEqual(
        xs,
        [...xs].sort((a, b) => a - b),
      );
      assert.equal(new Set(xs).size, xs.length);
    });
  });

  describe('labels its axes without writing one label over another', () => {
    it('takes the finest tick set whose labels fit', () => {
      const wide = layoutChart(
        input(
          [
            channel(
              'Ping',
              'ms',
              Array.from({ length: 24 }, () => 1),
            ),
          ],
          { width: 900 },
        ),
      );
      const narrow = layoutChart(
        input(
          [
            channel(
              'Ping',
              'ms',
              Array.from({ length: 24 }, () => 1),
            ),
          ],
          { width: 200 },
        ),
      );
      assert.ok(
        wide.xTicks.length > narrow.xTicks.length,
        `${String(wide.xTicks.length)} vs ${String(narrow.xTicks.length)}`,
      );
      assert.ok(narrow.xTicks.length >= 1, 'and a narrow chart still says when it is');
    });

    it('never overlaps two time labels, at any width', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 120, max: 1_200 }),
          fc.integer({ min: 2, max: 200 }),
          (width, hours) => {
            const layout = layoutChart(
              input(
                [
                  channel(
                    'Ping',
                    'ms',
                    Array.from({ length: hours }, () => 1),
                  ),
                ],
                { width },
              ),
            );
            for (let index = 1; index < layout.xTicks.length; index += 1) {
              const before = layout.xTicks[index - 1];
              const after = layout.xTicks[index];
              assert.ok(before !== undefined && after !== undefined);
              const needed = (measure(before.label, 8) + measure(after.label, 8)) / 2;
              assert.ok(after.x - before.x >= needed, `${before.label} and ${after.label} collide`);
            }
          },
        ),
      );
    });

    it('keeps every time label inside the chart, the first and last included', () => {
      // A label is centred on its tick and the period's ends are ticks. Before this was a test, the
      // last date of every chart was drawn half outside it and clipped to `09-0`.
      fc.assert(
        fc.property(
          fc.integer({ min: 160, max: 1_200 }),
          fc.integer({ min: 2, max: 200 }),
          (width, hours) => {
            const layout = layoutChart(
              input(
                [
                  channel(
                    'Ping',
                    'ms',
                    Array.from({ length: hours }, () => 1),
                  ),
                ],
                { width },
              ),
            );
            for (const tick of layout.xTicks) {
              const half = measure(tick.label, 8) / 2;
              assert.ok(tick.x - half >= -0.1, `${tick.label} starts left of the chart`);
              assert.ok(
                tick.x + half <= layout.width + 0.1,
                `${tick.label} ends right of the chart`,
              );
            }
          },
        ),
      );
    });

    it('gives the value axis no more ticks than its height has room for', () => {
      const short = layoutChart(input([channel('Ping', 'ms', [0, 100])], { plotHeight: 40 }));
      const tall = layoutChart(input([channel('Ping', 'ms', [0, 100])], { plotHeight: 300 }));
      assert.ok(short.yTicks.length <= tall.yTicks.length);
      for (const layout of [short, tall]) {
        for (let index = 1; index < layout.yTicks.length; index += 1) {
          const gap = (layout.yTicks[index - 1]?.y ?? 0) - (layout.yTicks[index]?.y ?? 0);
          assert.ok(gap >= 8 * 1.4 - 0.1, `ticks ${String(gap)} apart`);
        }
      }
    });
  });

  describe('says what it shows', () => {
    it('names a single series in the title, with its unit, and draws no legend', () => {
      const layout = layoutChart(input([channel('Response time', 'ms', [1, 2])]));
      assert.equal(layout.title, 'Response time (ms)');
      assert.equal(layout.legend.length, 0);
    });

    it('gives several series a legend, in their own colour slots, inside the chart', () => {
      const layout = layoutChart(
        input(
          [
            channel('Traffic in', 'kbit/s', [1, 2]),
            channel('Traffic out', 'kbit/s', [2, 3]),
            channel('Traffic total', 'kbit/s', [3, 5]),
          ],
          { width: 180 },
        ),
      );
      assert.equal(layout.title, 'kbit/s');
      assert.deepEqual(
        layout.legend.map((entry) => [entry.label, entry.slot]),
        [
          ['Traffic in', 0],
          ['Traffic out', 1],
          ['Traffic total', 2],
        ],
      );
      for (const entry of layout.legend) {
        assert.ok(entry.y < layout.height, 'the legend is inside the height the chart reports');
        // The swatch's top sits 0.8 em above the legend's baseline, and a time label's descenders
        // reach a quarter of an em below its own: the swatch must clear those, with room to spare.
        // The first version of this assertion forgot the descenders and passed for the layout that
        // drew its swatches over the dates — a mutation run is what showed it.
        assert.ok(
          entry.y - 8 * 0.8 >= layout.xLabelY + 8 * 0.25 + 3,
          `a legend entry at ${String(entry.y)} runs into the time labels at ${String(layout.xLabelY)}`,
        );
      }
      assert.ok(
        new Set(layout.legend.map((entry) => entry.y)).size > 1,
        'and wraps to another row when the width runs out',
      );
    });
  });
});
