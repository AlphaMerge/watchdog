import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import type { DemandInput } from '../src/runner/demand.js';
import { poolSizer, type PoolSizerDeps, type SizerPool } from '../src/pool-sizer.js';

const silent = pino({ level: 'silent' });

/** Records every ceiling it was handed, so a test can assert on the path and not just the end. */
function fakePool(
  start: number,
  durations: Record<string, number> = {},
): SizerPool & {
  readonly set: number[];
} {
  let current = start;
  const set: number[] = [];
  return {
    get maxSize() {
      return current;
    },
    set,
    typicalDurationMs: (type) => durations[type],
    setMaxSize: (next) => {
      current = next;
      set.push(next);
    },
  };
}

const sensors = (count: number, sensorType = 'icmp.ping', intervalSeconds = 60): DemandInput[] =>
  Array.from({ length: count }, () => ({ sensorType, intervalSeconds }));

function harness(over: Partial<PoolSizerDeps> = {}, pool = fakePool(64)) {
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    ...silent,
    warn: (fields: Record<string, unknown>) => {
      warnings.push(fields);
    },
  } as unknown as PoolSizerDeps['logger'];

  const sizer = poolSizer({
    logger,
    pool,
    assignments: () => sensors(600),
    configuredSize: 0,
    // The shipped bounds, stated rather than inherited, so a change to the default does not
    // silently change what these assert.
    fallbackMs: 600,
    min: 64,
    max: 256,
    margin: 1.3,
    ...over,
  });
  return { sizer, pool, warnings };
}

describe('the derived pool ceiling (P-34, P-40, P-44)', () => {
  it('does nothing at all when the operator set a size', () => {
    // A non-zero `workerPoolSize` is a statement about memory; a derived number must not overrule
    // it. The pool must not be touched even once.
    const h = harness({ configuredSize: 32 });
    assert.equal(h.sizer.enabled, false);
    h.sizer.size();
    h.sizer.start();
    assert.deepEqual(h.pool.set, []);
  });

  it('derives Little’s floor times the margin', () => {
    // 600 sensors on a 60 s interval is a burst of 10/s; at 600 ms a check that needs 6 workers,
    // and 6 x 1.3 = 7.8 -> 8. Two calls because this is a *drop* from 64 and `P-40` wants a drop
    // to persist before it is believed; the case below pins that rule on its own.
    const h = harness({ min: 4 });
    h.sizer.size();
    h.sizer.size();
    assert.equal(h.pool.maxSize, 8);
  });

  it('prefers a measured duration over the assumed one', () => {
    // The same workload with a type measured at 3 s rather than the assumed 600 ms:
    // 10/s x 3 = 30, x 1.3 = 39. Five times the ceiling, from the measurement alone.
    //
    // **40 rather than 39, and that is arithmetic rather than a bug.** The requirement is summed
    // one assignment at a time, and adding 0.05 six hundred times lands a shade above 30, which
    // `Math.ceil` turns into one more worker. Asserted as measured rather than as intended: the
    // error is a single worker, always upward, and chasing it would mean carrying exact
    // arithmetic through a number that exists to be rounded and clamped anyway.
    const pool = fakePool(64, { 'icmp.ping': 3_000 });
    const h = harness({ min: 4 }, pool);
    h.sizer.size();
    h.sizer.size();
    assert.equal(pool.maxSize, 40);
  });

  it('raises at once', () => {
    // `P-40`: a pool that is too small is a probe falling behind, so an increase is immediate --
    // no streak, no deadband. 3,000 sensors at 3 s is a burst of 50/s needing 150, x 1.3 = 195.
    const pool = fakePool(64, { 'icmp.ping': 3_000 });
    const h = harness({ assignments: () => sensors(3_000) }, pool);
    h.sizer.size();
    assert.deepEqual(pool.set, [195], 'one step, from 64 to 195');
  });

  it('lowers only once the drop has persisted', () => {
    // Same `P-40` rule from the other side: one low reading is a twitch in a network's round-trip
    // time, and since `P-39` acting on it destroys workers that are wanted again a moment later.
    const pool = fakePool(200);
    const h = harness({ min: 4 }, pool);

    h.sizer.size();
    assert.equal(pool.maxSize, 200, 'first low reading holds');
    h.sizer.size();
    assert.equal(pool.maxSize, 8, 'the second one is believed');
  });

  it('says so when the workload wants more than a probe may derive for itself', () => {
    const pool = fakePool(64, { 'icmp.ping': 3_000 });
    const h = harness({ assignments: () => sensors(20_000) }, pool);
    h.sizer.size();

    assert.equal(pool.maxSize, 256, 'clamped');
    assert.equal(h.warnings.length, 1, 'and not silently (WORKFLOW.MD §5)');
    assert.equal(h.warnings[0]?.['cap'], 256);
    assert.ok(Number(h.warnings[0]['required']) > 256, 'the number that was refused is named');
  });

  it('says it once while the workload stays past the cap, and again after it came back (P-216)', () => {
    // `P-216c`: once per thirty-second pass was 37 lines in one run, each the same.
    let count = 20_000;
    const pool = fakePool(64, { 'icmp.ping': 3_000 });
    const h = harness({ assignments: () => sensors(count) }, pool);
    for (let pass = 0; pass < 5; pass += 1) h.sizer.size();
    assert.equal(h.warnings.length, 1, 'once per episode');
    count = 100;
    h.sizer.size();
    count = 20_000;
    h.sizer.size();
    assert.equal(h.warnings.length, 2, 'a new episode says it again');
  });

  it('recomputes on its own timer, and stops when told', async () => {
    // **Waited for, not slept through** (`P-96`). This asserted `>= 2` ticks after a fixed
    // `delay(40)` at a 5 ms interval, which is a claim about how responsive the event loop is
    // rather than about the sizer: it passed 0/60 runs alone and 0/4 for this package, and
    // failed once under the whole-monorepo run where ~2,000 database tests saturate the same
    // Docker VM. A constant chosen so the assertion holds is the smell
    // `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md` names as rule 2.
    //
    // The property is "it fires more than once on its own", and waiting until it has is the
    // same property without the race. The deadline is generous because it exists to fail a
    // *stopped* timer, not a slow one.
    const pool = fakePool(64, { 'icmp.ping': 3_000 });
    const h = harness({ intervalMs: 5, min: 4 }, pool);

    h.sizer.start();
    const deadline = Date.now() + 5_000;
    while (pool.set.length < 2 && Date.now() < deadline) await delay(5);
    assert.ok(pool.set.length >= 2, `the timer fired (${String(pool.set.length)} times)`);

    // Deterministic, and worth keeping for that reason: `stop` clears the interval and `size` is
    // synchronous, so no tick can be in flight when this returns. Anything after it is a timer
    // that was never cleared.
    h.sizer.stop();
    const ticked = pool.set.length;
    await delay(40);
    assert.equal(pool.set.length, ticked, 'and nothing after stop');
  });
});
