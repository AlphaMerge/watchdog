import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_GAP_MS,
  parseCounter,
  rateFrom,
  type CounterSample,
} from '../src/ingestion/counters.js';

const T0 = new Date('2026-08-27T10:00:00.000Z');
const at = (secondsLater: number): Date => new Date(T0.getTime() + secondsLater * 1_000);

function sample(value: bigint | number, secondsLater = 0): CounterSample {
  return { value: BigInt(value), at: at(secondsLater) };
}

const TWO_32 = 1n << 32n;
const TWO_64 = 1n << 64n;

describe('a counter that went forwards', () => {
  it('divides the difference by the time between the readings', () => {
    // 6,000 octets over 60 seconds is 100 octets a second.
    const outcome = rateFrom(sample(1_000), sample(7_000, 60), 64);
    assert.ok(outcome.kind === 'rate');
    assert.equal(outcome.perSecond, 100);
    assert.equal(outcome.wrapped, false);
  });

  it('reports zero for a counter that did not move', () => {
    // A real measurement, not a gap: an idle interface is genuinely carrying nothing, which is
    // the one case where zero is the truth rather than an absence.
    const outcome = rateFrom(sample(5_000), sample(5_000, 60), 64);
    assert.equal(outcome.kind === 'rate' && outcome.perSecond, 0);
  });

  it('is exact past 2^53, which is the whole reason the counter is a bigint', () => {
    // ifHCInOctets passes 2^53 in about nine days on a 100 Gbit/s link, and above 2^54 a double
    // cannot even represent consecutive integers — these two counters are one octet apart and
    // are the same number once rounded.
    const base = 1n << 54n;
    assert.equal(Number(base + 1n), Number(base + 2n), 'as doubles these are the same number');

    const outcome = rateFrom({ value: base, at: at(0) }, { value: base + 1_000n, at: at(10) }, 64);
    assert.equal(outcome.kind === 'rate' && outcome.delta, 1_000n);
    assert.equal(outcome.kind === 'rate' && outcome.perSecond, 100);
  });
});

describe('a 32-bit counter that went backwards', () => {
  it('assumes it wrapped, because at that width it does', () => {
    // 2^32 octets is 4.29 GB — thirty-four seconds of gigabit. Wrapping is the normal case.
    const previous = TWO_32 - 1_000n;
    const outcome = rateFrom(sample(previous), sample(2_000, 30), 32);
    assert.ok(outcome.kind === 'rate');
    assert.equal(outcome.wrapped, true);
    assert.equal(outcome.delta, 3_000n);
    assert.equal(outcome.perSecond, 100);
  });

  it('calls it a reset when the wrap would imply more than the link can carry', () => {
    // The ambiguity a 32-bit counter has and a 64-bit one does not: backwards is either a wrap
    // or a reboot. A device at a million octets that reboots to 500 would be "corrected" by
    // 4.29 billion — 71 Mbit/s of invented traffic on a link that cannot do 10.
    const outcome = rateFrom(sample(1_000_000), sample(500, 60), 32, {
      maxPerSecond: 1_250_000, // a 10 Mbit/s link, in octets
    });
    assert.equal(outcome.kind, 'reset');
  });

  it('cannot tell a reset from a wrap when the counter was near the top, and does not pretend to', () => {
    // The honest limit of the heuristic, written down because it is not a bug to be fixed later:
    // the corrected delta is large exactly when the *previous* value was small. A device that
    // reboots from near 2^32 produces a corrected delta that is small and entirely plausible,
    // and nothing in the two readings distinguishes it from an ordinary wrap. It is reported as
    // a rate, which is the better guess — wraps at this width are routine and reboots are not.
    const outcome = rateFrom(sample(TWO_32 - 1_000n), sample(5_000, 60), 32, {
      maxPerSecond: 1_250_000,
    });
    assert.ok(outcome.kind === 'rate');
    assert.equal(outcome.wrapped, true);
  });

  it('still assumes a wrap when the corrected rate is plausible', () => {
    const outcome = rateFrom(sample(TWO_32 - 6_000n), sample(0, 60), 32, {
      maxPerSecond: 125_000_000,
    });
    assert.ok(outcome.kind === 'rate');
    assert.equal(outcome.perSecond, 100);
  });

  it('assumes a wrap when nothing said what the link can carry', () => {
    // Without a bound the wrap is the right guess: it is the ordinary case at this width.
    const outcome = rateFrom(sample(TWO_32 - 100n), sample(100, 10), 32);
    assert.equal(outcome.kind === 'rate' && outcome.wrapped, true);
  });
});

describe('a 64-bit counter that went backwards', () => {
  it('is a reset and never a wrap', () => {
    // The asymmetry that matters. ifHCInOctets at 100 Gbit/s takes about forty-six years to go
    // round, so backwards is a device that rebooted. "Correcting for the wrap" would report a
    // single sample of roughly 1.8e19 octets, dwarfing the axis for the whole retention window.
    const outcome = rateFrom(sample(TWO_64 - 1_000n), sample(500, 60), 64);
    assert.equal(outcome.kind, 'reset');
  });

  it('is a reset even for a tiny step backwards', () => {
    const outcome = rateFrom(sample(1_000_000), sample(999_999, 60), 64);
    assert.equal(outcome.kind, 'reset');
  });

  it('ignores a link-speed bound, which cannot make a 64-bit wrap plausible', () => {
    const outcome = rateFrom(sample(1_000_000), sample(1, 60), 64, { maxPerSecond: 1e18 });
    assert.equal(outcome.kind, 'reset');
  });
});

describe('when there is nothing to divide against', () => {
  it('reports the first reading as a baseline, not as a rate', () => {
    // A gap, deliberately. The first scan of a counter has nothing to subtract, and reporting
    // the counter itself would draw one enormous point at the start of every new sensor.
    assert.equal(rateFrom(null, sample(1_000), 64).kind, 'first');
  });

  it('refuses two readings at the same instant', () => {
    const outcome = rateFrom(sample(1_000), sample(2_000, 0), 64);
    assert.equal(outcome.kind, 'no-elapsed');
  });

  it('refuses a reading older than the baseline', () => {
    // Out-of-order arrival is real: a probe drains its spool after an outage. Dividing by a
    // negative interval would produce a negative rate.
    const outcome = rateFrom(sample(2_000, 60), sample(1_000, 0), 64);
    assert.equal(outcome.kind, 'no-elapsed');
  });

  it('throws the baseline away across a long gap rather than averaging over it', () => {
    // After an outage a 32-bit counter may have gone round many times and nothing in the reading
    // says how many, so the average across it is a number with no meaning. One lost sample and
    // an honest gap beats a figure that is confidently wrong.
    const outcome = rateFrom(sample(1_000), sample(2_000, MAX_GAP_MS / 1_000 + 1), 64);
    assert.equal(outcome.kind, 'stale');
  });

  it('takes a gap right up to the bound', () => {
    const outcome = rateFrom(sample(1_000), sample(2_000, MAX_GAP_MS / 1_000), 64);
    assert.equal(outcome.kind, 'rate');
  });
});

describe('reading a counter off the wire', () => {
  it('takes the full unsigned 64-bit range exactly', () => {
    assert.equal(parseCounter('18446744073709551615'), TWO_64 - 1n);
    assert.equal(parseCounter('0'), 0n);
  });

  it('refuses what is not an unsigned integer', () => {
    for (const text of ['', '-1', '1.5', '1e9', 'ffff', ' 12', '12 ', '0x10']) {
      assert.equal(parseCounter(text), null, `"${text}" should not parse`);
    }
  });

  it('refuses a value past what a 64-bit counter can hold', () => {
    assert.equal(parseCounter('18446744073709551616'), null);
    assert.equal(parseCounter('99999999999999999999'), null);
  });
});
