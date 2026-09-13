import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { baselineExtent, formatTick, niceScale } from '../src/charts/index.js';

/**
 * A y-axis a reader trusts (`E-05`). `ADR-006` Decision 3: "a y-axis labelled 0, 33, 67, 100 is a
 * chart nobody trusts."
 */

describe('a value axis', () => {
  it('ticks at one, two or five times a power of ten', () => {
    // The target is a ceiling, not a promise: 0–100 in five ticks would need a step of 25, and 25
    // is not 1, 2 or 5 × 10ⁿ, so it takes three ticks at 50 rather than a step nobody reads easily.
    assert.deepEqual(niceScale(0, 100, 5).ticks, [0, 50, 100]);
    assert.deepEqual(niceScale(0, 100, 6).ticks, [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(niceScale(0, 1.4, 4).ticks, [0, 0.5, 1, 1.5]);
    assert.equal(niceScale(0, 1.4, 4).decimals, 1);
  });

  it('never lands on a value nobody chose, for any extent', () => {
    // The property the whole file is for, over arbitrary ranges: every step is 1, 2 or 5 × 10ⁿ,
    // every tick is a whole multiple of it, and the ticks cover the data.
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-3, max: 1e6, noNaN: true }),
        fc.integer({ min: 3, max: 8 }),
        (low, width, target) => {
          const high = low + width;
          const scale = niceScale(low, high, target);
          const mantissa = scale.step / 10 ** Math.floor(Math.log10(scale.step) + 1e-9);
          assert.ok(
            [1, 2, 5].some((nice) => Math.abs(mantissa - nice) < 1e-6),
            `step ${String(scale.step)}`,
          );
          // Covered to within a billionth of a step — which is to say exactly, at any resolution
          // a chart has. fast-check found why the tolerance is relative to the step and not to
          // the value: a denormal like -5e-324 divided by the step underflows to -0, the axis
          // starts at 0, and "0 is not below -5e-324" is true and means nothing.
          const slack = scale.step * 1e-9;
          assert.ok(scale.min <= low + slack && scale.max >= high - slack, JSON.stringify(scale));
          for (const tick of scale.ticks) {
            const multiple = tick / scale.step;
            assert.ok(Math.abs(multiple - Math.round(multiple)) < 1e-6, `tick ${String(tick)}`);
          }
          const labels = scale.ticks.map((tick) => formatTick(tick, scale.decimals));
          assert.equal(new Set(labels).size, labels.length, 'no two labels read the same');
        },
      ),
    );
  });

  it('draws an axis for a flat series rather than dividing by zero', () => {
    // A sensor that read 42 all month is the most common chart there is.
    const flat = niceScale(42, 42, 5);
    assert.ok(flat.min < 42 && flat.max > 42, JSON.stringify(flat));
    const zero = niceScale(0, 0, 5);
    assert.ok(zero.min === 0 && zero.max > 0, JSON.stringify(zero));
  });

  it('labels 0.3 as 0.3, not as a rounding error', () => {
    const scale = niceScale(0, 0.3, 4);
    assert.deepEqual(
      scale.ticks.map((tick) => formatTick(tick, scale.decimals)),
      ['0.0', '0.1', '0.2', '0.3'],
    );
    assert.equal(formatTick(-0, 1), '0.0', 'and never a negative zero');
  });
});

describe('where the axis starts', () => {
  it('starts at zero for a magnitude, so a 2 ms wobble does not look like an outage', () => {
    assert.deepEqual(baselineExtent({ low: 243, high: 245 }), { low: 0, high: 245 });
  });

  it('fits data that crosses zero, or sits below it, as it is', () => {
    assert.deepEqual(baselineExtent({ low: -5, high: 12 }), { low: -5, high: 12 });
    assert.deepEqual(baselineExtent({ low: -30, high: -2 }), { low: -30, high: 0 });
  });
});
