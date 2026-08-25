import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isIdentity,
  parseTransform,
  transformReading,
  validateTransform,
  NO_TRANSFORM,
  type ReadingTransform,
} from '../src/ingestion/scaling.js';

function transform(over: Partial<ReadingTransform> = {}): ReadingTransform {
  return { ...NO_TRANSFORM, ...over };
}

/** The value that survived, or the reason it did not. */
function apply(value: number, over: Partial<ReadingTransform> = {}): number | string {
  const result = transformReading(value, transform(over));
  return result.kind === 'kept' ? result.value : result.reason;
}

// -------------------------------------------------------------------------------------------
// Scaling.
// -------------------------------------------------------------------------------------------

describe('scaling a reading', () => {
  it('leaves a reading alone when nothing is configured', () => {
    assert.equal(apply(1234.5), 1234.5);
    assert.equal(isIdentity(NO_TRANSFORM), true);
  });

  it('multiplies and divides, which is bytes to bits and centidegrees to degrees', () => {
    assert.equal(apply(1_000, { scaleMul: 8 }), 8_000);
    assert.equal(apply(2_350, { scaleDiv: 100 }), 23.5);
    assert.equal(apply(1_000, { scaleMul: 8, scaleDiv: 1_000 }), 8);
  });

  it('handles a fractional factor without turning it into rounding noise', () => {
    assert.equal(apply(1, { scaleMul: 0.001 }), 0.001);
  });

  it('discards a reading that is not a number, rather than storing one', () => {
    assert.equal(apply(Number.NaN), 'not-a-number');
    assert.equal(apply(Number.POSITIVE_INFINITY), 'not-a-number');
  });

  it('discards a reading a factor blew up, because Infinity poisons every average it lands in', () => {
    assert.equal(apply(1e308, { scaleMul: 1e10 }), 'not-a-number');
  });
});

// -------------------------------------------------------------------------------------------
// The spike filter.
// -------------------------------------------------------------------------------------------

describe('the spike filter', () => {
  it('discards a reading above the maximum and below the minimum', () => {
    assert.equal(apply(4e9, { spikeMax: 1_000 }), 'spike');
    assert.equal(apply(-1, { spikeMin: 0 }), 'spike');
    assert.equal(apply(500, { spikeMin: 0, spikeMax: 1_000 }), 500);
  });

  it('keeps a reading exactly on a bound, which is inside the range', () => {
    assert.equal(apply(1_000, { spikeMax: 1_000 }), 1_000);
    assert.equal(apply(0, { spikeMin: 0 }), 0);
  });

  it('bounds one side when only one is set', () => {
    assert.equal(apply(-1e9, { spikeMax: 100 }), -1e9);
    assert.equal(apply(1e9, { spikeMin: 0 }), 1e9);
  });

  it('filters the scaled value, not the raw one', () => {
    // Both bounds and limits are numbers an operator types in the channel's own unit. A spike
    // bound that meant one thing and a limit that meant another would be two units in one form.
    assert.equal(apply(1_000, { scaleMul: 8, spikeMax: 5_000 }), 'spike', '8,000 is over 5,000');
    assert.equal(apply(1_000, { scaleMul: 8, spikeMax: 10_000 }), 8_000);
  });

  it('treats zero as a bound, not as an absence', () => {
    assert.equal(apply(-0.5, { spikeMin: 0 }), 'spike');
    assert.equal(apply(-0.5, {}), -0.5);
  });
});

// -------------------------------------------------------------------------------------------
// Reading the columns.
// -------------------------------------------------------------------------------------------

describe('parsing a channel row', () => {
  it('reads the numeric columns, which arrive as strings', () => {
    const parsed = parseTransform({
      scale_mul: '8',
      scale_div: '1000',
      spike_min: 0,
      spike_max: 100,
    });
    assert.deepEqual(parsed, { scaleMul: 8, scaleDiv: 1_000, spikeMin: 0, spikeMax: 100 });
  });

  it('refuses to divide by zero or by nonsense, falling back to no scaling', () => {
    // The column has a CHECK against zero, so this can only come from a hand-edited row — and
    // the alternative is every reading on that channel becoming Infinity.
    assert.equal(
      parseTransform({ scale_div: '0', scale_mul: '1', spike_min: null, spike_max: null }).scaleDiv,
      1,
    );
    assert.equal(
      parseTransform({ scale_mul: 'eight', scale_div: '1', spike_min: null, spike_max: null })
        .scaleMul,
      1,
    );
    assert.equal(
      parseTransform({ scale_mul: null, scale_div: null, spike_min: null, spike_max: null })
        .scaleMul,
      1,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Settings that cannot be applied.
// -------------------------------------------------------------------------------------------

describe('validating processing settings', () => {
  it('accepts the ordinary cases', () => {
    assert.deepEqual(validateTransform(NO_TRANSFORM, null), []);
    assert.deepEqual(validateTransform(transform({ scaleMul: 8, spikeMax: 100 }), 2), []);
  });

  it('refuses a zero factor, which would be a division by zero or a constant zero', () => {
    assert.equal(validateTransform(transform({ scaleDiv: 0 }), null).length, 1);
    assert.equal(validateTransform(transform({ scaleMul: 0 }), null).length, 1);
  });

  it('refuses an inverted spike range, which would discard every reading', () => {
    const problems = validateTransform(transform({ spikeMin: 100, spikeMax: 10 }), null);
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('every reading'));
  });

  it('refuses decimal places outside what the column can hold', () => {
    assert.equal(validateTransform(NO_TRANSFORM, 11).length, 1);
    assert.equal(validateTransform(NO_TRANSFORM, -1).length, 1);
    assert.deepEqual(validateTransform(NO_TRANSFORM, 0), [], 'zero decimals is a real setting');
  });
});
