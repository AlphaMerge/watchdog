import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { FOREIGN_WINDOW_MS, ProbeRefusals } from '../src/probes/refusals.js';

/** A monotonic clock the test moves. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let ms = 1_000_000;
  return {
    now: () => ms,
    advance: (by) => {
      ms += by;
    },
  };
}

describe('what the core refused from each probe (`P-228`)', () => {
  it('counts every refusal, and only the foreign ones in the window', () => {
    const time = clock();
    const refusals = new ProbeRefusals(time.now);
    refusals.refused(7, 3);
    refusals.foreign(7, 2);

    assert.deepEqual(refusals.countsFor(7), { refused: 5, foreignRecently: 2 });
    assert.deepEqual(refusals.stats(), { refused: 5, foreign: 2 });
  });

  it('keeps probes apart, because a warning names the probe that sent it', () => {
    const refusals = new ProbeRefusals(clock().now);
    refusals.foreign(7);
    refusals.refused(8, 4);

    assert.deepEqual(refusals.countsFor(7), { refused: 1, foreignRecently: 1 });
    assert.deepEqual(refusals.countsFor(8), { refused: 4, foreignRecently: 0 });
  });

  it('reads zero for a probe nothing was refused from — a count, not a gap', () => {
    assert.deepEqual(new ProbeRefusals(clock().now).countsFor(42), {
      refused: 0,
      foreignRecently: 0,
    });
  });

  it('lets the foreign count fall back to zero once the window passes, which clears the warning', () => {
    const time = clock();
    const refusals = new ProbeRefusals(time.now);
    refusals.foreign(7, 3);

    time.advance(FOREIGN_WINDOW_MS - 10_000);
    assert.equal(refusals.countsFor(7).foreignRecently, 3, 'still inside the window');

    time.advance(10_000);
    assert.equal(refusals.countsFor(7).foreignRecently, 0, 'five minutes after the last one');
    assert.equal(refusals.countsFor(7).refused, 3, 'the counter is not a window, and stays');
  });

  it('starts a fresh window for a probe whose last one emptied', () => {
    const time = clock();
    const refusals = new ProbeRefusals(time.now);
    refusals.foreign(7);
    time.advance(FOREIGN_WINDOW_MS);
    assert.equal(refusals.countsFor(7).foreignRecently, 0);

    refusals.foreign(7);
    assert.equal(refusals.countsFor(7).foreignRecently, 1);
  });

  it('counts a GID that owns no probe object in the totals, where nothing else can show it', () => {
    const refusals = new ProbeRefusals(clock().now);
    refusals.foreign(null, 2);
    refusals.refused(null);

    assert.deepEqual(refusals.stats(), { refused: 3, foreign: 2 });
  });

  it('ignores nothing-to-count rather than moving either number', () => {
    const refusals = new ProbeRefusals(clock().now);
    refusals.refused(7, 0);
    refusals.foreign(7, 0);

    assert.deepEqual(refusals.countsFor(7), { refused: 0, foreignRecently: 0 });
    assert.deepEqual(refusals.stats(), { refused: 0, foreign: 0 });
  });
});
