import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { availableParallelism } from 'node:os';
import type { CheckResult } from '@ms/shared';
import { CheckPool, defaultPoolSize, type ResultMeta } from '../src/runner/index.js';
import { ICMP_PING_CHECK_MS, littleFloor, V1_TARGET_BURST } from '../src/measured.js';
import { poolDemand } from '../src/runner/demand.js';

const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/check-pool.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];

async function poolOf(
  options: {
    size?: number;
    minSize?: number;
    idleShrinkMs?: number;
    durationWindowMs?: number;
    abortGraceMs?: number;
    queueMaxLength?: number;
  } = {},
) {
  const seen: Seen[] = [];
  const pool = new CheckPool({
    logger: silent,
    size: options.size ?? 2,
    // Fixed unless a test says otherwise, so the sizing loop (`P-18`) is exercised where it is
    // the subject and cannot quietly change the answer everywhere else.
    minSize: options.minSize ?? options.size ?? 2,
    registryModule: FIXTURES,
    ...(options.idleShrinkMs === undefined ? {} : { idleShrinkMs: options.idleShrinkMs }),
    ...(options.durationWindowMs === undefined
      ? {}
      : { durationWindowMs: options.durationWindowMs }),
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.queueMaxLength === undefined ? {} : { queueMaxLength: options.queueMaxLength }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  await pool.start();
  return { pool, seen };
}

/** Waits for a condition, or fails the test rather than hanging the suite. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const request = (sensorId: number, sensorType: string, extra: Record<string, unknown> = {}) => ({
  sensorId,
  sensorType,
  // Every check points somewhere; the fixtures ignore it, but the shape is the real one.
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: extra,
  timeoutMs: Number(extra['timeoutMs'] ?? 1_000),
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

describe('check pool', () => {
  it('runs a check and reports its channels', async () => {
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.ok')), 'accepted');

    await until(() => seen.length === 1, 'the check to finish');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'ok');
    assert.equal(entry.result.sensorId, 1);
    assert.deepEqual(entry.result.channels, [
      { key: 'value', value: 42, name: 'Value', unit: 'ms' },
    ]);
    assert.equal(entry.meta.phase, 'execute');
    assert.ok(entry.result.durationMs >= 0);
  });

  it('records no channel values for a failed check', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(2, 'test.throw'));

    await until(() => seen.length === 1, 'the failure');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /on purpose/);
    // A Down sensor records no channel values (CLAUDE.md): the gap is the data.
    assert.deepEqual(entry.result.channels, []);
  });

  it('reports an unknown sensor type rather than hanging on it', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(3, 'nope.missing'));

    await until(() => seen.length === 1, 'the refusal');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /no such check type/);
  });

  // -----------------------------------------------------------------------------------------
  // The Phase 2 exit criteria.
  // -----------------------------------------------------------------------------------------

  it('lets other checks through while one is hung', async () => {
    // "A deliberately hung check does not delay any other check" (PLAN.md, Phase 2).
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    pool.submit({ ...request(10, 'test.hang'), timeoutMs: 60_000 });

    for (let id = 11; id <= 15; id += 1) pool.submit(request(id, 'test.ok'));

    await until(() => seen.length === 5, 'the healthy checks to finish');
    assert.ok(
      seen.every((entry) => entry.result.outcome === 'ok'),
      'all five ran while the hang was outstanding',
    );
    assert.ok(!seen.some((entry) => entry.result.sensorId === 10), 'and the hang is still hung');
  });

  it('reports a timeout when it happens, not when the check gives up', async () => {
    // A sensor stuck on a dead connection has to report Down on schedule, or the state machine
    // learns about the outage a minute late.
    const { pool, seen } = await poolOf({ abortGraceMs: 10_000 });
    const startedAt = Date.now();
    pool.submit({ ...request(20, 'test.hang'), timeoutMs: 150 });

    await until(() => seen.length === 1, 'the timeout');
    const elapsed = Date.now() - startedAt;
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.equal(entry.meta.phase, 'timeout');
    assert.ok(elapsed < 1_000, `the result arrived after ${String(elapsed)} ms`);
    assert.equal(pool.stats().timedOut, 1);
  });

  it('reuses the worker when a check honours its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 5_000 });
    pool.submit({ ...request(30, 'test.slow', { delayMs: 5_000 }), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The cheap path: the check returned when asked, so the worker is available immediately and
    // nothing had to be terminated.
    pool.submit(request(31, 'test.ok'));
    await until(() => seen.length === 2, 'the next check on the same worker');
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().workerCrashes, 0, 'no worker was harmed');
  });

  it('terminates and replaces a worker whose check ignores its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 100 });
    pool.submit({ ...request(40, 'test.hang'), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The worker cannot be reclaimed cooperatively, so it is terminated — and the pool comes
    // back to full strength on its own.
    pool.submit(request(41, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recover', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().size, 1, 'and it is still one worker, not two');
  });

  it('loses exactly one result when a worker dies mid-check', async () => {
    // "Killing a worker mid-check loses exactly one result and recycles cleanly" (PLAN.md).
    const { pool, seen } = await poolOf({ size: 1 });
    pool.submit(request(50, 'test.crash'));

    await until(() => seen.length === 1, 'the crash to be reported');
    const crashed = seen[0];
    assert.ok(crashed);
    assert.equal(crashed.result.sensorId, 50);
    assert.equal(crashed.result.outcome, 'error');
    assert.equal(crashed.meta.phase, 'worker-crash');

    pool.submit(request(51, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recycle', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.ok(pool.stats().workerCrashes >= 1, 'and the crash is counted');
  });

  // -----------------------------------------------------------------------------------------
  // Backpressure.
  // -----------------------------------------------------------------------------------------

  it('skips a sensor whose previous scan has not finished', async () => {
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    assert.equal(pool.submit({ ...request(60, 'test.hang'), timeoutMs: 60_000 }), 'accepted');

    // The rule from WORKFLOW.MD §3: skipped, not stacked. It costs nothing to decide because
    // the wheel has already scheduled the next scan.
    assert.equal(pool.submit(request(60, 'test.ok')), 'already-running');
    assert.equal(pool.stats().deferred, 1);
    assert.equal(seen.length, 0);
  });

  it('accepts a sensor again once its check has finished', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(70, 'test.ok'));
    await until(() => seen.length === 1, 'the first check');
    assert.equal(pool.submit(request(70, 'test.ok')), 'accepted');
    await until(() => seen.length === 2, 'the second check');
  });

  it('refuses work past the queue bound, and counts what it refused', async () => {
    const { pool } = await poolOf({ size: 1, queueMaxLength: 2, abortGraceMs: 10_000 });
    // One worker, busy for a minute; the queue takes two and no more.
    pool.submit({ ...request(80, 'test.hang'), timeoutMs: 60_000 });
    assert.equal(pool.submit(request(81, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(82, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(83, 'test.ok')), 'queue-full');
    assert.equal(pool.stats().refused, 1, 'never dropped without counting');
  });

  it('answers every queued check when it stops, rather than dropping them', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: FIXTURES,
      abortGraceMs: 10_000,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    await pool.start();
    pool.submit({ ...request(90, 'test.hang'), timeoutMs: 60_000 });
    pool.submit(request(91, 'test.ok'));

    await pool.stop();
    assert.equal(seen.length, 2, 'the running one and the queued one');
    assert.ok(seen.every((entry) => entry.meta.phase === 'pool-stopped'));
    assert.equal(pool.submit(request(92, 'test.ok')), 'stopped');
  });

  it('gives up rather than respawning for ever when workers cannot start', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: join(import.meta.dirname, 'support', 'no-such-registry.js'),
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();

    // A registry that cannot be imported kills every worker the moment it starts. Retrying at
    // the speed of the event loop would fill the log and bury the one line that mattered.
    await until(
      () => pool.submit(request(100, 'test.ok')) === 'stopped',
      'the pool to disable itself',
    );
    assert.ok(pool.stats().workerCrashes >= 1);
  });

  it('reports an unregistered sensor type as its own phase, not as a failed check', async () => {
    // A missing sensor type fails identically for ever. Counting it with genuine check failures
    // buries a configuration error inside a rate that looks like a flapping target, and no
    // amount of retrying will change the outcome.
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.nonexistent')), 'accepted');

    await until(() => seen.length === 1, 'the check to be refused');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.meta.phase, 'unknown-type');
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /test\.nonexistent/, 'names the type it could not find');
    assert.deepEqual(entry.result.channels, [], 'a failed check records no channel values');
  });
});

/**
 * Sizing the pool to the work (`P-18`).
 *
 * **The asymmetry is the whole design and is what these pin.** `P-15` measured what an
 * undersized pool costs — 21% of checks refused and the rest delayed by a p95 of 15.8 seconds —
 * and what an oversized one costs is memory, about six megabytes a worker. So growth is
 * immediate and shrinking waits out a whole quiet interval: the first mistake loses
 * measurements, the second loses nothing but bytes.
 */
describe('growing and shrinking with the load', () => {
  it('starts at the minimum rather than at the ceiling', async () => {
    const { pool } = await poolOf({ size: 8, minSize: 2 });
    assert.equal(pool.size, 2);
    assert.equal(pool.maxSize, 8, 'and knows what it is allowed to reach');
  });

  it('grows the moment a check has nowhere to go', async () => {
    // The trigger is not a long queue: it is a queued check with every worker busy, which is the
    // only state in which another worker would have started something that is instead waiting.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1 });
    for (let i = 0; i < 6; i += 1) {
      pool.submit(request(100 + i, 'test.slow', { delayMs: 300 }));
    }

    await until(() => pool.size > 1, 'the pool to grow');
    await until(() => seen.length === 6, 'every check to finish', 10_000);
    assert.ok(pool.size > 1, `pool stayed at ${String(pool.size)}`);
    assert.ok(pool.size <= 8, 'and never past its ceiling');
    assert.ok(pool.stats().grown > 0, 'and says that it grew');
  });

  it('never grows past the ceiling, however much is queued', async () => {
    const { pool, seen } = await poolOf({ size: 3, minSize: 1, queueMaxLength: 100 });
    for (let i = 0; i < 40; i += 1) {
      pool.submit(request(200 + i, 'test.slow', { delayMs: 100 }));
    }
    await until(() => seen.length === 40, 'every check to finish', 20_000);
    assert.equal(pool.size, 3);
  });

  it('does not grow for work an idle worker is about to pick up', async () => {
    // A queue behind an idle worker is not a shortage. Growing here would buy a worker for a
    // check that was never going to wait, which over a day is a pool that only ever climbs —
    // and `#pump` runs first, so three checks against four workers leaves nothing queued.
    const { pool, seen } = await poolOf({ size: 8, minSize: 4 });
    for (const id of [300, 301, 302]) pool.submit(request(id, 'test.slow', { delayMs: 120 }));
    await until(() => seen.length === 3, 'the checks to finish', 8_000);
    assert.equal(pool.size, 4, 'the pool should not have grown');
    assert.equal(pool.stats().grown, 0);
  });

  /**
   * **This replaced a test that asserted the opposite, and the replacement is the point of
   * `P-26`.** The old one said a pool must not give a worker back "while work is still arriving",
   * because a shrink between a check queueing and a worker picking it up would take the worker
   * that was about to run it. The hazard is real; the measure was not. Timing "has anything been
   * submitted" makes a probe watching five thousand sensors — eighty-three checks a second —
   * permanently ineligible to shrink, so the pool that had grown large was the one that could
   * never give anything back. Measured: 48 workers held for twenty-four hours at 0–3% use.
   *
   * The hazard is answered by looking at the worker instead. A slot that is ready, holding no
   * job, and untouched for the whole interval is one that checks have been flowing *past*, and
   * `#pump` dispatches to a free worker before a check can queue behind it.
   */
  it('gives back the workers a lighter load stopped needing', async () => {
    // Six at once grows the pool; then one every 40 ms with 60 ms of work is 1.5 workers' worth,
    // so most of what the burst bought is spare from then on.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 200 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(700 + i, 'test.slow', { delayMs: 60 }));
    await until(() => pool.size > 1, 'the pool to grow');

    // **The peak is the highest size actually seen, not a single early sample.** Growth is
    // asynchronous — workers are still spawning when `pool.size > 1` first becomes true — so
    // reading it once races the thing being measured.
    let peak = pool.size;
    const rounds = 30;
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      pool.submit(request(800 + round, 'test.slow', { delayMs: 60 }));
      peak = Math.max(peak, pool.size);
    }

    // Asserted while the load is *still arriving*, which is the whole correction: the old policy
    // treated any submission as proof every worker was needed.
    assert.ok(
      pool.stats().shrunk > 0,
      `the pool gave nothing back in ${String(rounds * 40)} ms of a load needing ~2 workers`,
    );
    assert.ok(pool.size < peak, `the pool held ${String(pool.size)} of its peak ${String(peak)}`);

    // And it took only genuinely spare workers: every check still ran to completion.
    await until(() => seen.length === 6 + rounds, 'every check to finish', 15_000);
  });

  it('never takes a worker that is in the middle of a check', async () => {
    // The hazard the old test was written against, asserted directly rather than by proxy. The
    // interval is far shorter than the work, so a shrink policy that could not tell busy from
    // spare would have every opportunity to take one.
    const { pool, seen } = await poolOf({ size: 6, minSize: 1, idleShrinkMs: 30 });
    for (let i = 0; i < 5; i += 1) pool.submit(request(900 + i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size > 1, 'the pool to grow');

    await until(() => seen.length === 5, 'every check to finish', 15_000);
    assert.equal(
      seen.filter((one) => one.result.outcome === 'ok').length,
      5,
      'a check was lost, which means a working worker was retired underneath it',
    );
  });

  it('never shrinks below the minimum, however long it is quiet', async () => {
    const { pool } = await poolOf({ size: 8, minSize: 3, idleShrinkMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pool.size, 3);
    assert.equal(pool.stats().shrunk, 0, 'and it should not even have tried');
  });

  it('holds its size when the minimum is the maximum, which is the old behaviour', async () => {
    // What a probe with a known steady workload should configure: the sizing loop buys nothing
    // there, and a re-spawn during a spike costs something.
    const { pool, seen } = await poolOf({ size: 2, minSize: 2, idleShrinkMs: 50 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(500 + i, 'test.slow', { delayMs: 60 }));
    await until(() => seen.length === 6, 'every check to finish', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(pool.size, 2);
    assert.equal(pool.stats().grown, 0);
    assert.equal(pool.stats().shrunk, 0);
  });

  it('refuses a minimum above its own ceiling rather than starting more than it allows', async () => {
    // A configuration file saying two contradictory things. Starting six workers in a pool
    // bounded at two would make every later sizing decision arithmetic on a number already wrong
    // — so what is asserted is the workers it actually starts, not the number it stored.
    const pool = new CheckPool({
      logger: silent,
      size: 2,
      minSize: 6,
      registryModule: FIXTURES,
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    assert.equal(pool.maxSize, 2);
    assert.equal(pool.size, 2, 'it started more workers than its own ceiling allows');
  });
});

/**
 * The number `P-15` changed, and why.
 *
 * A value test alone would pass just as happily on the old default; what these pin is the
 * *reasoning* — that the pool is sized by checks in flight rather than by cores, which is the
 * thing the benchmark disproved and the thing a later refactor could quietly undo.
 */
describe('sizing the ceiling from the work (P-34)', () => {
  it('learns what a type costs, separately per type', async () => {
    const { pool, seen } = await poolOf({ size: 4, minSize: 4 });

    assert.equal(pool.typicalDurationMs('test.slow'), undefined, 'nothing measured yet');

    for (let i = 0; i < 5; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 120 }));
    for (let i = 10; i < 15; i += 1) pool.submit(request(i, 'test.ok'));
    await until(() => seen.length === 10, 'both types to finish');

    const slow = pool.typicalDurationMs('test.slow');
    const fast = pool.typicalDurationMs('test.ok');
    assert.ok(slow !== undefined && fast !== undefined, 'both types measured');

    // The numbers that matter are the *separation*, not the absolutes — a worker's own overhead
    // is in both. A pooled median would describe neither type, which is why this is per type.
    assert.ok(slow >= 100, `a 120 ms check measured ${String(slow)} ms`);
    assert.ok(fast < 100, `an immediate check measured ${String(fast)} ms`);
    assert.ok(slow > fast * 2, 'and the two are not confusable');
  });

  it('takes the median, so one timeout does not resize the pool', async () => {
    // The reason this is a median and not a mean. A single check that ran to its timeout is in
    // the window too, and a mean would let it claim the workload is thirty times heavier than
    // it is — sizing the pool for a workload that does not exist.
    const { pool, seen } = await poolOf({ size: 4, minSize: 4 });

    for (let i = 0; i < 9; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 20 }));
    await until(() => seen.length === 9, 'the ordinary checks');
    const ordinary = pool.typicalDurationMs('test.slow');
    assert.ok(ordinary !== undefined);

    pool.submit(request(99, 'test.slow', { delayMs: 400 }));
    await until(() => seen.length === 10, 'the outlier');

    const after = pool.typicalDurationMs('test.slow');
    assert.ok(after !== undefined);
    assert.ok(
      after < ordinary + 60,
      `one 400 ms outlier moved the estimate from ${String(ordinary)} to ${String(after)}`,
    );
  });

  it('raises the ceiling without allocating, and lets the pump use it', async () => {
    // Raising a ceiling must not spawn anything by itself — a probe that never needs the
    // headroom never pays for it. What it does is stop `#grow` being the constraint.
    const { pool, seen } = await poolOf({ size: 2, minSize: 1, idleShrinkMs: 0 });
    assert.equal(pool.maxSize, 2);

    pool.setMaxSize(6);
    assert.equal(pool.maxSize, 6, 'the ceiling moved');
    assert.ok(pool.size <= 2, `nothing was spawned by the raise alone, held ${String(pool.size)}`);

    for (let i = 0; i < 6; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 80 }));
    await until(() => pool.size > 2, 'the pool to use the new room');
    await until(() => seen.length === 6, 'the checks');
    assert.ok(pool.size <= 6, 'and never past the new ceiling');
  });

  it('comes down to a lowered ceiling now, not one worker a minute', async () => {
    // **An interaction between two changes, neither wrong alone.** `P-26` set the decay at one
    // worker per idle window, which is right while the ceiling never moves. `P-34` made it move,
    // and a pool above its ceiling is holding memory it has been told it may not have — 256 down
    // to 64 is 192 workers, over three hours at one a minute, about 6.6 GB in a real probe.
    //
    // A long idle window is what makes this test meaningful: at 60 s, the ordinary decay cannot
    // account for any of the shedding below, so what it measures is the ceiling pass alone.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 60_000 });

    // Slow enough that the queue outlives the spawning. With quick checks the burst drains
    // before `#grow` catches up and the pool never reaches its ceiling, so there is nothing
    // above it to shed and the test would pass without exercising anything.
    for (let i = 0; i < 8; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size === 8, 'a full pool');
    await until(() => seen.length === 8, 'every worker idle again');

    pool.setMaxSize(2);
    // No waiting: lowering the ceiling acts immediately, so this is the state right after.
    await until(() => pool.size <= 2, 'the pool to obey its new ceiling');
    assert.ok(pool.size <= 2, `held ${String(pool.size)} against a ceiling of 2`);
  });

  it('reaches its ceiling even when the drop lands mid-check (P-45)', async () => {
    // The case above lowers the ceiling on an idle pool, which always worked. `P-44` measured the
    // one that did not: a wheel firing every second means a ceiling change usually lands while
    // slots hold jobs, the pass sheds whatever happens to be spare and stops, and before this the
    // next chance was the 60-second idle window. Measured there: 31 workers against a ceiling of
    // 9 for two full minutes, twice observed completely idle while it sat.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 60_000 });

    for (let i = 0; i < 8; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size === 8, 'a full pool');
    await until(() => seen.length === 8, 'the first round to finish');

    // A second round, so the drop below lands on workers that are holding jobs.
    for (let i = 0; i < 8; i += 1) pool.submit(request(100 + i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.stats().busy >= 6, 'workers holding jobs');

    pool.setMaxSize(2);
    assert.ok(
      pool.size > 2,
      `the opportunistic pass alone cannot finish the job; held ${String(pool.size)}`,
    );

    // At a 60-second idle window the ordinary decay cannot account for any of this, so whatever
    // converges the pool within five seconds is the retry and nothing else.
    await until(() => pool.size <= 2, 'the pool to reach its ceiling anyway');
  });

  it('still refuses to go under the configured floor, however low the ceiling goes', async () => {
    // The floor is somebody's deliberate setting and the ceiling pass must not step through it.
    // `setMaxSize` clamps, but the shedding loop is a second place that could get it wrong.
    const { pool, seen } = await poolOf({ size: 6, minSize: 4, idleShrinkMs: 60_000 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 40 }));
    await until(() => seen.length === 6, 'the checks');

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 4, 'clamped to the floor');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(pool.size >= 4, `held ${String(pool.size)}, which is under the floor of 4`);
  });

  it('never takes a worker out of a check when the ceiling drops', async () => {
    // Lowering the ceiling is a policy change, not a kill signal. The slots above the new line
    // are left to the shrink policy, which since `P-26` only retires a worker that is ready,
    // jobless and idle for the whole window.
    const { pool, seen } = await poolOf({ size: 4, minSize: 1, idleShrinkMs: 60_000 });
    for (let i = 0; i < 4; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 150 }));
    await until(() => pool.size === 4, 'a full pool');

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 1);

    await until(() => seen.length === 4, 'every check in flight to finish');
    assert.equal(
      seen.filter((entry) => entry.result.outcome === 'ok').length,
      4,
      'all four completed rather than being cut off',
    );
  });

  it('will not set a ceiling under the floor the operator configured', () => {
    // Two settings that contradict each other, and the floor is the one somebody chose
    // deliberately. Starting more workers than the ceiling allows would make every later
    // decision arithmetic on a number already known to be wrong.
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 4,
      registryModule: FIXTURES,
      onResult: () => undefined,
    });
    pools.push(pool);

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 4, 'clamped up to the configured minimum');
  });
});

describe('session-pool counters (P-36)', () => {
  const SESSION_FIXTURES = join(import.meta.dirname, 'support', 'session-fixtures.js');

  async function sessionPool(size: number, minSize = size, idleShrinkMs = 0) {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size,
      minSize,
      idleShrinkMs,
      registryModule: SESSION_FIXTURES,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();
    return { pool, seen };
  }

  it('reports nothing at all when the registry keeps no pools', async () => {
    // The case that must not become zeros. A build with no session pools has nothing to say
    // about them, and a channel reading 0 open sessions is a claim, not an absence.
    const { pool, seen } = await poolOf({ size: 2, minSize: 2 });
    pool.submit(request(1, 'test.ok'));
    await until(() => seen.length === 1, 'a check');

    assert.equal(pool.sessionCounters(), undefined);
    assert.equal(pool.stats().sessions, undefined, 'and it is absent from the stats too');
  });

  it('sums what every worker reports, because each thread holds its own pools', async () => {
    const { pool, seen } = await sessionPool(3);
    for (let i = 0; i < 3; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 60 }));
    await until(() => seen.length === 3, 'one check on each worker');

    const counters = pool.sessionCounters();
    assert.ok(counters !== undefined, 'the registry reported');
    // Every worker says `open: 2`, and three workers ran a check, so a sum is 6 and any single
    // worker's answer is 2. This is the assertion that would fail if the pool published one
    // worker's numbers as though they were the probe's.
    assert.equal(counters.open, 6, `summed across workers, got ${String(counters.open)}`);
    assert.ok(counters.opened > 0, 'and the cumulative counters came through');
  });

  it('never lets a cumulative counter fall when a worker goes away', async () => {
    // **The reason the retired baseline exists.** The published figure is a sum over live
    // workers, so shrinking the pool would otherwise lower a counter — and a counter that falls
    // is one an operator cannot put a trigger on.
    // A pool that *can* shrink: a floor of 1 and a short idle window, since `idleShrinkMs: 0`
    // means "never give a worker back" and would make this test assert nothing.
    const { pool, seen } = await sessionPool(3, 1, 50);

    // **Every worker must have reported before one is retired, or this proves nothing.** The
    // pool starts at its floor and grows, so a burst can finish on two workers while the third
    // is still spawning — retiring a worker that never ran a check loses no counters, and the
    // test would pass with the banking removed. An earlier version of it did exactly that.
    let submitted = 0;
    await until(() => {
      if (seen.length === submitted && submitted < 24) {
        for (let i = 0; i < 3; i += 1)
          pool.submit(request(submitted + i, 'test.slow', { delayMs: 40 }));
        submitted += 3;
      }
      return pool.sessionCounters()?.open === 6;
    }, 'all three workers to report');

    const before = pool.sessionCounters();
    assert.ok(before !== undefined);
    assert.equal(before.open, 6, 'three workers, two sessions each');

    // Take the ceiling down and let the shrink policy retire the spare workers.
    pool.setMaxSize(1);
    await until(() => pool.size < 3, 'the pool to give workers back');

    const after = pool.sessionCounters();
    assert.ok(after !== undefined, 'still reporting after the shrink');
    assert.ok(after.open < before.open, 'the gauge fell, so a reporting worker really did go');
    assert.ok(
      after.overflowed >= before.overflowed,
      `overflowed fell from ${String(before.overflowed)} to ${String(after.overflowed)}`,
    );
    assert.ok(
      after.opened >= before.opened,
      `opened fell from ${String(before.opened)} to ${String(after.opened)}`,
    );
    assert.ok(
      after.evicted >= before.evicted,
      `evicted fell from ${String(before.evicted)} to ${String(after.evicted)}`,
    );
  });
});

/**
 * The estimate the sizing loop reads, and why its window is counted in seconds (`P-46`).
 *
 * It used to be the last 1,024 samples. A median over N samples only moves once more than half of
 * them are new, so the time to notice a change was `512 ÷ completions per second` — and the
 * completion rate is set by the pool size. `P-44` measured it: about 12 s to notice at 66 workers,
 * 25 s at 31, 85 s at 9. A pool that was too small measured too slowly and stayed too small.
 *
 * These drive the estimate directly rather than through a running pool, because the property under
 * test is *how many old samples it takes to bury a change* — which a timing test would measure
 * badly and slowly.
 */
describe('the duration the sizing loop reads (P-46)', () => {
  /** Feeds durations straight into the pool's per-type window. */
  async function measured(old: number, oldCount: number, fresh: number, freshCount: number) {
    // A 150 ms window rather than the shipped 30 s, so the stale readings age out inside a test
    // instead of half a minute later. What is under test is the shape, not the constant.
    const { pool, seen } = await poolOf({
      size: 4,
      minSize: 4,
      idleShrinkMs: 0,
      durationWindowMs: 150,
    });
    for (let i = 0; i < oldCount; i += 1) pool.submit(request(i, 'test.slow', { delayMs: old }));
    await until(() => seen.length === oldCount, `${String(oldCount)} slow checks`, 20_000);
    // Long enough that every one of the old readings is outside the window.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let i = 0; i < freshCount; i += 1) {
      pool.submit(request(1_000 + i, 'test.slow', { delayMs: fresh }));
    }
    await until(() => seen.length === oldCount + freshCount, 'the fresh ones', 20_000);
    return pool;
  }

  it('is not outvoted by a long history of a duration that no longer applies', async () => {
    // Forty old samples against twelve new ones. On a count-counted window the old ones win and
    // the probe keeps sizing for a workload it no longer has; on a time-counted one they have
    // aged out and only the twelve are left.
    const pool = await measured(5, 40, 120, 12);
    const typical = pool.typicalDurationMs('test.slow');

    assert.ok(typical !== undefined);
    assert.ok(
      typical >= 100,
      `sized from the recent 120ms checks, not the stale 5ms ones; got ${String(typical)}`,
    );
  });

  it('still answers when a quiet probe has nothing recent at all', async () => {
    // A probe with three sensors on a five-minute interval measures nothing inside the window.
    // Stale but real beats fresh and absent: an undefined answer sends the sizer to its
    // assumption, which is the guess the measurement exists to replace.
    const { pool, seen } = await poolOf({
      size: 4,
      minSize: 4,
      idleShrinkMs: 0,
      durationWindowMs: 150,
    });
    for (let i = 0; i < 3; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 80 }));
    await until(() => seen.length === 3, 'three checks');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const typical = pool.typicalDurationMs('test.slow');
    assert.ok(typical !== undefined, 'a stale answer rather than none');
    assert.ok(typical >= 60, `and it is the one that was measured; got ${String(typical)}`);
  });

  it('says nothing about a type it has never run', async () => {
    const { pool } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });
    assert.equal(pool.typicalDurationMs('never.seen'), undefined);
  });
});

describe('a probe whose checks get slower (P-34)', () => {
  it('raises its ceiling from what it measured, before the backlog grows', async () => {
    // **The loop, rather than its parts.** The tests above prove that the pool learns a
    // duration, that the arithmetic is Little's law and that a ceiling can move. None of them
    // proves the three compose — that a probe whose network got slower notices and grows *in
    // time*, which is the whole promise and the only part an operator experiences.
    //
    // The same sensor type throughout, because that is the real case: `http.get` against an
    // endpoint that degrades is not a new type, it is the same one costing more.
    const { pool, seen } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });

    const SENSORS = 3_000;
    const assignments = Array.from({ length: SENSORS }, () => ({
      sensorType: 'test.slow',
      intervalSeconds: 60,
    }));

    // What `main.ts` does on a config push and every thirty seconds, in miniature.
    const sizePool = (): number => {
      const demand = poolDemand(assignments, (type) => pool.typicalDurationMs(type), {
        fallbackMs: 20,
        min: 4,
        max: 64,
        margin: 1.3,
      });
      pool.setMaxSize(demand.ceiling);
      return demand.ceiling;
    };

    // A quiet network: 3,000 sensors a minute apart is 50 checks a second, and at 20 ms each
    // that is one worker's worth of work. The floor is under the minimum, so the minimum wins.
    for (let i = 0; i < 12; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 20 }));
    await until(() => seen.length === 12, 'the fast checks');
    const quiet = sizePool();
    assert.equal(quiet, 4, `a light workload derives the floor, got ${String(quiet)}`);

    // The same sensors, now answering ten times slower. 50 a second at 400 ms is 20 in flight.
    for (let i = 100; i < 112; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => seen.length === 24, 'the slow checks');

    const busy = sizePool();
    assert.ok(
      busy > quiet,
      `the ceiling did not move when the work got slower: ${String(quiet)} -> ${String(busy)}`,
    );
    assert.ok(
      busy >= 20,
      `50 checks a second at 400 ms needs 20 in flight; derived ${String(busy)}`,
    );
    assert.equal(pool.maxSize, busy, 'and the pool took it');

    // **"Before the backlog grows" is the clause that matters**, and this is what makes it true:
    // the estimate comes from checks that have already *finished*, so a dozen of them is enough
    // to move the ceiling. Nothing had to queue up for the probe to find out.
    const stats = pool.stats();
    assert.equal(stats.deferred, 0, 'nothing was deferred while it learned');
    assert.equal(stats.refused, 0, 'and nothing refused');
    assert.ok(stats.queued <= 1, `the queue was still empty, held ${String(stats.queued)}`);
  });

  it('gives the room back when the network recovers', async () => {
    // The other direction, and the reason the ceiling is derived rather than latched: a probe
    // that grew for one bad afternoon should not hold the memory for ever. Lowering the ceiling
    // is safe by the test above — the shrink policy retires only idle, jobless workers.
    const { pool, seen } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });
    const assignments = Array.from({ length: 3_000 }, () => ({
      sensorType: 'test.slow',
      intervalSeconds: 60,
    }));
    const sizePool = (): number => {
      const demand = poolDemand(assignments, (type) => pool.typicalDurationMs(type), {
        fallbackMs: 20,
        min: 4,
        max: 64,
        margin: 1.3,
      });
      pool.setMaxSize(demand.ceiling);
      return demand.ceiling;
    };

    for (let i = 0; i < 12; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => seen.length === 12, 'the slow spell');
    const degraded = sizePool();
    assert.ok(degraded >= 20, `expected a raised ceiling, got ${String(degraded)}`);

    // Enough fast checks to carry the median back down — the window is bounded, so recovery is
    // a matter of running checks rather than of waiting.
    for (let i = 100; i < 130; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 20 }));
    await until(() => seen.length === 42, 'the recovery');

    const recovered = sizePool();
    assert.ok(
      recovered < degraded,
      `the ceiling stayed high after the work got cheap: ${String(degraded)} -> ${String(recovered)}`,
    );
  });
});

describe('the default pool size', () => {
  it('is not derived from the core count', () => {
    // The thing `P-15` disproved. The old default was `cores - 1`, which is what a CPU-bound
    // pool wants; a check holds a slot while awaiting a packet and uses almost no CPU, so the
    // machine's width has nothing to do with how many packets are in the air.
    assert.notEqual(defaultPoolSize(), Math.max(1, availableParallelism() - 1));
    // Against `maxSize` since `P-18`, because `size` is now what the pool is holding rather than
    // what it is allowed to hold — and before it starts, that is nothing.
    assert.equal(
      defaultPoolSize(),
      new CheckPool({ logger: silent, onResult: () => undefined }).maxSize,
      'and the pool actually uses it',
    );
  });

  it('drains the v1 target’s dispatch batch in at most two tranches', () => {
    // The arithmetic the default exists to satisfy, and the shape the sweep measured. The wheel
    // hands over a whole second at once — 5,000 sensors on a 60-second interval is 83 — and the
    // wait a sensor sees is (tranches - 1) x check duration. Two tranches keeps a one-second
    // budget intact up to a check of about a second; three breaches it at about 500 ms, which
    // an ordinary HTTP check exceeds.
    const batch = Math.ceil(V1_TARGET_BURST);
    const tranches = Math.ceil(batch / defaultPoolSize());
    assert.ok(
      tranches <= 2,
      `${String(defaultPoolSize())} slots leaves ${String(tranches)} tranches for a batch of ` +
        String(batch),
    );
  });

  it('keeps up with the v1 target in the sensor type we ship', () => {
    // **The check that was missing, and its absence is `P-32`.** The tranche test above bounds
    // the wait for one batch and never asks whether that batch clears before the next arrives a
    // second later. A pool completes `slots / checkDuration` checks a second; below the arrival
    // rate the backlog grows for as long as the probe runs, and nothing is refused while the
    // queue still has room, so no counter says anything is wrong.
    //
    // `icmp.ping` is the case that bites, because it is the type this project ships and it is
    // not fast: four packets at `-i 0.2` is 600 ms (`P-07`). The old default of 48 was one
    // worker under this line and measured a p95 of 5,082 ms against a 1,000 ms budget.
    const floor = littleFloor(V1_TARGET_BURST, ICMP_PING_CHECK_MS);
    const served = defaultPoolSize() / (ICMP_PING_CHECK_MS / 1_000);

    assert.ok(
      defaultPoolSize() > floor,
      `${String(defaultPoolSize())} slots complete ${served.toFixed(1)} checks a second ` +
        `against ${V1_TARGET_BURST.toFixed(1)} arriving — the backlog would grow without bound`,
    );

    // And clear it by enough that the tranche model above actually holds. Measured at 600 ms:
    // 1.12x the floor predicted 600 ms and delivered 822; 1.28x delivered 614. The margin is
    // not decoration, it is the queueing the tranche model leaves out.
    assert.ok(
      defaultPoolSize() >= floor * 1.25,
      `${String(defaultPoolSize())} is only ${(defaultPoolSize() / floor).toFixed(2)}x the floor`,
    );
  });

  it('does not pay for slots the measurement showed were not worth it', () => {
    // At 600 ms checks, 96 slots take the v1 batch in one tranche and measure a p95 of 7 ms
    // against 64's 614 — but both are inside the 1,000 ms budget, and the 32 extra workers cost
    // about 1.1 GB in a real probe, where each carries the sensor catalogue. A default that
    // drifts upward without a measurement behind it is how a probe quietly starts needing a
    // gigabyte, so this is deliberately tight: raising it again means measuring again.
    assert.ok(defaultPoolSize() <= 64);
  });
});
