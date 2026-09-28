import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RecentCount } from '../src/health/recent-count.js';

/**
 * A count over a window, on a ring of buckets (`P-231`).
 *
 * Five minutes in sixty buckets of five seconds, as ingestion uses it, on a clock the test moves.
 */
describe('a count over the last few minutes', () => {
  const WINDOW = 300_000;

  function counting(start = 0): { count: RecentCount; at: (ms: number) => void } {
    let now = start;
    return {
      count: new RecentCount(WINDOW, { monotonicMs: () => now }),
      at: (ms) => {
        now = start + ms;
      },
    };
  }

  it('counts what was added inside the window, and forgets it after', () => {
    const { count, at } = counting();
    count.add(3);
    at(60_000);
    count.add(2);
    assert.equal(count.count(), 5);

    at(299_999);
    assert.equal(count.count(), 5, 'the first is still inside the window');
    at(300_000);
    assert.equal(count.count(), 2, 'and then it is not');
    at(360_000);
    assert.equal(count.count(), 0, 'nothing left, so a warning on it clears');
  });

  it('is exact to within one bucket, and no worse', () => {
    const { count, at } = counting();
    at(4_999);
    count.add(1);
    // The bucket it went into began at 0, so it goes when that bucket leaves the window, at
    // 300,000: 295,001 ms after it was added rather than 300,000. Early by less than one bucket,
    // never late.
    at(299_999);
    assert.equal(count.count(), 1);
    at(300_000);
    assert.equal(count.count(), 0);
  });

  it('does not carry a sum round the ring into the bucket that reuses its slot', () => {
    const { count, at } = counting();
    count.add(100);
    at(WINDOW); // the same slot, sixty buckets on
    count.add(1);
    assert.equal(count.count(), 1);
  });

  it('holds the same whatever the rate, because every bucket is a sum', () => {
    // What is counted can come from a probe that is misbehaving or hostile (`P-228`), so it must
    // not decide how much is held: a hundred thousand additions are sixty numbers.
    const { count, at } = counting();
    for (let i = 0; i < 100_000; i += 1) {
      at(i * 10);
      count.add(1);
    }
    // The last 300 s of a 1,000 s run: 30,000 additions, give or take the bucket at the edge.
    const counted = count.count();
    assert.ok(counted >= 29_500 && counted <= 30_000, `counted ${String(counted)}`);
  });

  it('works on a clock that reads negative, which a test or a platform may give it', () => {
    const { count, at } = counting(-1_000_000);
    count.add(4);
    at(10_000);
    count.add(1);
    assert.equal(count.count(), 5);
  });

  it('ignores what is not a positive number, rather than subtracting it', () => {
    const { count } = counting();
    count.add(2);
    count.add(0);
    count.add(-5);
    count.add(Number.NaN);
    assert.equal(count.count(), 2);
  });

  it('refuses a window it cannot divide', () => {
    assert.throws(() => new RecentCount(0), RangeError);
    assert.throws(() => new RecentCount(WINDOW, { buckets: 0 }), RangeError);
    assert.throws(() => new RecentCount(WINDOW, { buckets: 2.5 }), RangeError);
  });
});
