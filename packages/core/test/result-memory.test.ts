import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PROBES_REMEMBERED,
  RESULTS_REMEMBERED,
  RESULTS_REMEMBERED_SLACK,
  ResultMemory,
} from '../src/ingestion/result-memory.js';

/**
 * What counts a refused result once (`P-288`, `P-295`), with its eviction amortised (`P-295`
 * review): a probe's set grows past its bound by the slack and is trimmed back to the bound in one
 * pass, oldest first, rather than walking past V8's holes to delete one key for every key added.
 */
describe('the memory that counts a result once', () => {
  const key = (n: number): string => `r${String(n)} 2026-10-08T09:00:00.000Z`;
  const firsts = (memory: ResultMemory, gid: string, ns: readonly number[]): number =>
    ns.filter((n) => memory.first(gid, key(n))).length;

  it('grows past the bound by the slack, then trims back to the bound, oldest first', () => {
    // A bound of 100 has a slack of 10.
    const memory = new ResultMemory(100, 4);
    const all = Array.from({ length: 110 }, (_, n) => n);
    assert.equal(firsts(memory, 'a', all), 110);
    assert.equal(memory.size, 110, 'nothing forgotten inside the slack');
    assert.equal(firsts(memory, 'a', all), 0, 'and every one still remembered');

    assert.equal(firsts(memory, 'a', [110]), 1);
    assert.equal(memory.size, 100, 'past it, trimmed to the bound in one pass');
    // The eleven oldest went, the newest hundred stayed.
    assert.equal(
      firsts(
        memory,
        'a',
        Array.from({ length: 100 }, (_, n) => n + 11),
      ),
      0,
    );
    assert.equal(firsts(memory, 'a', [10]), 1, 'the eleventh oldest forgotten');
    assert.equal(memory.size, 101);
  });

  it('holds the bound and its slack however many keys pass through', () => {
    const memory = new ResultMemory(100, 4);
    for (let n = 0; n < 10_000; n += 1) {
      assert.ok(memory.first('a', key(n)));
      assert.ok(memory.size <= 110, `at ${String(n)}: ${String(memory.size)}`);
      if (n >= 100) assert.ok(memory.size >= 100, 'never below the bound once filled');
    }
    // The last hundred are always there, whatever the trim's phase.
    assert.equal(
      firsts(
        memory,
        'a',
        Array.from({ length: 100 }, (_, n) => 9_900 + n),
      ),
      0,
    );
  });

  it('keeps a key seen again past a trim, as the newest', () => {
    const memory = new ResultMemory(10, 4); // a slack of one
    assert.equal(firsts(memory, 'a', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 11);
    // 0 seen again: now the newest, so the trim the next key starts takes 1 and 2.
    assert.equal(firsts(memory, 'a', [0]), 0);
    assert.equal(firsts(memory, 'a', [11]), 1);
    assert.equal(memory.size, 10);
    assert.equal(firsts(memory, 'a', [0]), 0, 'refreshed, so kept');
    assert.equal(firsts(memory, 'a', [3]), 0, 'the next oldest kept');
    assert.equal(firsts(memory, 'a', [1]), 1, 'the oldest forgotten');
  });

  it('forgets the probe heard from least recently, and keeps each probe’s own', () => {
    const memory = new ResultMemory(10, 2);
    memory.first('a', key(1));
    memory.first('b', key(1));
    assert.equal(memory.first('a', key(1)), false, 'A heard from again, B now the least recent');
    memory.first('c', key(1));
    assert.equal(memory.probes, 2);
    assert.equal(memory.first('a', key(1)), false, 'A kept');
    assert.equal(memory.first('b', key(1)), true, 'B forgotten');
  });

  it('defaults to the bounds the core runs with, and a slack of a tenth', () => {
    assert.equal(RESULTS_REMEMBERED, 10_000);
    assert.equal(PROBES_REMEMBERED, 32);
    assert.equal(RESULTS_REMEMBERED_SLACK, 0.1);
    const memory = new ResultMemory();
    for (let n = 0; n <= 11_000; n += 1) memory.first('a', key(n));
    assert.equal(memory.size, 10_000, 'trimmed once at 11,001');
  });
});
