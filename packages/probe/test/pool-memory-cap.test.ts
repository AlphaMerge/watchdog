import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { memoryReserveBytes, type Logger } from '@ms/shared';
import {
  CheckPool,
  MEMORY_CAP_READ_INTERVAL_MS,
  MEMORY_RELEASE_MARGIN_WORKERS,
  MEMORY_SHED_MARGIN_WORKERS,
  MemoryCap,
  workersMemoryAllows,
  type MemoryCapReading,
} from '../src/runner/index.js';
import { WORKER_RESIDENT_MIB } from '../src/measured.js';
import { pollWithin, within, type Waited } from './support/within.js';

// `P-236`: the pool's ceiling, bounded by the memory the probe may use.
// `docs/findings/2026-09-29-probe-starvation-b.md` is why.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/pool-memory-cap.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');
/** The fixtures, taking 400 ms to import, so a test can see a worker while it loads (`P-206`). */
const SLOW = join(import.meta.dirname, 'support', 'slow-registry.js');

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

/** Waits for a condition, or fails the test rather than hanging the suite. */
function until(predicate: () => boolean, what: Waited, timeoutMs = 10_000): Promise<void> {
  return pollWithin(timeoutMs, what, predicate, 5);
}

/**
 * What a wait was for, and what the pool reported once its bound had passed, so that a failure
 * names its cause and not only its wait: queued, held, busy, grown and shrunk, and whatever else
 * the test counts.
 */
function reporting(
  what: string,
  pool: CheckPool,
  more: () => Record<string, unknown> = () => ({}),
): () => string {
  return () => {
    const { queued, size, busy, grown, shrunk } = pool.stats();
    const counted = Object.entries({ queued, held: size, busy, grown, shrunk, ...more() })
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(', ');
    return `${what}; the pool reported ${counted}`;
  };
}

/** Starts a pool within a bound: its workers load in threads, and the test waits on them. */
function started(pool: CheckPool): Promise<void> {
  return within(
    60_000,
    () => `the pool to start; ${String(pool.size)} workers had started`,
    pool.start(),
  );
}

/** Stops a pool within a bound: its workers' threads have to exit. */
function stopped(pool: CheckPool): Promise<void> {
  return within(30_000, () => `the pool to stop; ${String(pool.size)} workers left`, pool.stop());
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const request = (sensorId: number, delayMs: number, timeoutMs = 90_000) => ({
  sensorId,
  sensorType: 'test.slow',
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: { delayMs },
  timeoutMs,
});

/**
 * A cap that says whatever the test says, as `MemoryCap.read` would, with the workers the pool
 * says are still loading, as a fresh `MemoryCap` reading has them. `loading` is what the pool said
 * at its last reading, for `loaded`.
 */
function fixedCap(
  workers: () => number | undefined,
  saysLoading: (loading: number) => number | undefined = (loading) => loading,
): {
  read: (held: number, loading: number) => MemoryCapReading | undefined;
  readonly loading: number;
} {
  let last = -1;
  return {
    get loading() {
      return last;
    },
    read: (_held, loading) => {
      last = loading;
      const allowed = workers();
      if (allowed === undefined) return undefined;
      const said = saysLoading(loading);
      return {
        workers: allowed,
        availableBytes: 512 * MIB,
        totalBytes: 4 * GIB,
        reserveBytes: memoryReserveBytes(4 * GIB),
        perWorkerBytes: WORKER_RESIDENT_MIB * MIB,
        source: 'limit',
        ...(said === undefined ? {} : { loading: said }),
      };
    },
  };
}

/**
 * Until none of the pool's workers is loading, by what it tells its cap, polling `stats()`, which
 * reads memory (`P-437`'s third review). A hold does not end while a worker loads, so a test that
 * gives memory room and then looks once must not look while a worker its burst grew still loads:
 * at a load of 20 the first worker answered a whole burst while the second loaded. Call it while
 * memory is still short, since each `stats()` can end a hold.
 */
async function loaded(pool: CheckPool, cap: { readonly loading: number }): Promise<void> {
  await until(
    () => {
      pool.stats();
      return cap.loading === 0;
    },
    reporting('the workers the pool grew to load', pool, () => ({ loading: cap.loading })),
    // A load, which at a load of 20 measured 13.5 s at the p95 (`test/perf/pool-stragglers.test.ts`).
    60_000,
  );
}

interface Line {
  msg: string;
  level: number;
  [field: string]: unknown;
}

/** A logger whose warnings a test can count. */
function recording(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Line);
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

describe('what memory allows (P-236)', () => {
  it('keeps back the larger of 256 MiB and a quarter of the ceiling (P-244)', () => {
    assert.equal(memoryReserveBytes(768 * MIB), 256 * MIB);
    assert.equal(memoryReserveBytes(1 * GIB), 256 * MIB);
    assert.equal(memoryReserveBytes(4 * GIB), 1 * GIB);
    assert.equal(memoryReserveBytes(6 * GIB), 1.5 * GIB);
  });

  // `P-244`: where a saturated pool settles must be under the 80% `memoryLimitUsage` warns at, and
  // leave the machine above the 20% `memoryAvailable` warns at.
  for (const totalMiB of [1_024, 2_048, 4_096, 6_144, 8_192, 12_288, 16_384, 65_536]) {
    it(`stops a saturated pool under both warnings at a ${String(totalMiB)} MiB ceiling`, () => {
      const total = totalMiB * MIB;
      // The pool grows while a worker's worth is spare above the reserve, and gives one back only
      // once memory is the shed margin's worth under it (`P-437`): so the most it can hold is the
      // ceiling less the reserve, and that margin of workers into the reserve.
      const settled =
        total - memoryReserveBytes(total) + MEMORY_SHED_MARGIN_WORKERS * WORKER_RESIDENT_MIB * MIB;
      const settledPercent = (settled / total) * 100;
      assert.ok(settledPercent < 80, `${String(settledPercent)}% of the ceiling`);
      assert.ok(100 - settledPercent > 20, `${String(100 - settledPercent)}% left`);
    });
  }

  const perWorkerBytes = 40 * MIB;
  const table: {
    readonly name: string;
    readonly held: number;
    readonly availableMiB: number;
    readonly totalMiB: number;
    readonly workers: number;
  }[] = [
    // 4 GiB: 1,024 MiB kept back, so 1,600 MiB free is 576 spare, 14 workers more.
    { name: 'room for more', held: 10, availableMiB: 1_600, totalMiB: 4_096, workers: 24 },
    // Exactly the reserve free: not one more.
    { name: 'at the reserve', held: 66, availableMiB: 1_024, totalMiB: 4_096, workers: 66 },
    // P-216b's first kill, as Probe Health read it: 21.5% of 4 GiB left with 75 workers held.
    // Under a quarter now, so four go back rather than eleven more coming.
    { name: 'the incident', held: 75, availableMiB: 880, totalMiB: 4_096, workers: 71 },
    // Below the reserve, what memory allows is fewer than are held: the pool gives some back.
    { name: 'under the reserve', held: 50, availableMiB: 250, totalMiB: 4_096, workers: 30 },
    // Past the ceiling — a working set above `memory.high` — reads as negative available.
    { name: 'past the ceiling', held: 40, availableMiB: -100, totalMiB: 4_096, workers: 11 },
    // A 16 GiB ceiling with the pool's 256 workers of 40 MiB and 300 MiB besides: 5,844 MiB
    // left, 4 GiB of it kept back, still room for 43 more. The pool's ceiling binds first, so the
    // quarter costs a large ceiling nothing, and capping it would buy nothing (`P-244`).
    { name: 'a large ceiling', held: 256, availableMiB: 5_844, totalMiB: 16_384, workers: 299 },
    // Never negative, however far under.
    { name: 'far under', held: 3, availableMiB: -2_000, totalMiB: 4_096, workers: 0 },
    // A spare fraction of a worker does not buy one.
    { name: 'a fraction short', held: 0, availableMiB: 256 + 39, totalMiB: 1_024, workers: 0 },
    { name: 'exactly one', held: 0, availableMiB: 256 + 40, totalMiB: 1_024, workers: 1 },
  ];
  for (const row of table) {
    it(`works out ${row.name}`, () => {
      const { workers } = workersMemoryAllows({
        held: row.held,
        memory: { availableBytes: row.availableMiB * MIB, totalBytes: row.totalMiB * MIB },
        perWorkerBytes,
      });
      assert.equal(workers, row.workers);
    });
  }
});

describe('reading memory for the cap (P-236)', () => {
  it('uses the cgroup ceiling when there is one, and not the machine', () => {
    let machineReads = 0;
    const cap = new MemoryCap({
      sources: {
        limit: () => ({ availableBytes: 1 * GIB, totalBytes: 4 * GIB }),
        machine: () => {
          machineReads += 1;
          return { availableBytes: 60 * GIB, totalBytes: 64 * GIB };
        },
        now: () => 0,
      },
    });
    const reading = cap.read(10);
    assert.equal(reading?.source, 'limit');
    assert.equal(reading.totalBytes, 4 * GIB);
    assert.equal(machineReads, 0);
  });

  it('falls back to the machine where there is no ceiling', () => {
    const cap = new MemoryCap({
      sources: {
        limit: () => null,
        machine: () => ({ availableBytes: 3 * GIB, totalBytes: 8 * GIB }),
        now: () => 0,
      },
    });
    const reading = cap.read(0);
    assert.equal(reading?.source, 'machine');
    // 8 GiB keeps back 2,048 MiB; 3,072 − 2,048 = 1,024 MiB spare is 25 workers of 40.
    assert.equal(reading.workers, 25);
  });

  it('has no cap where neither can be read, rather than a cap of nothing', () => {
    const cap = new MemoryCap({
      sources: { limit: () => null, machine: () => null, now: () => 0 },
    });
    assert.equal(cap.read(5), undefined);
  });

  it('reads at most once a second, and counts workers added since against that reading', () => {
    let now = 0;
    let reads = 0;
    const cap = new MemoryCap({
      sources: {
        limit: () => {
          reads += 1;
          return { availableBytes: 1_424 * MIB, totalBytes: 4 * GIB };
        },
        machine: () => null,
        now: () => now,
      },
    });
    // 1,424 − 1,024 = 400 MiB spare: ten more than the 20 held.
    assert.equal(cap.read(20)?.workers, 30);
    // Ten started since: the reading does not have them in it, so the cap is still 30, not 40.
    now = MEMORY_CAP_READ_INTERVAL_MS - 1;
    assert.equal(cap.read(30)?.workers, 30);
    assert.equal(reads, 1);
    now = MEMORY_CAP_READ_INTERVAL_MS;
    cap.read(30);
    assert.equal(reads, 2);
  });

  it('says how many workers it counted, and how many were loading, when its reading was taken', () => {
    // `P-437`'s third review: a loading worker is counted as resident before most of its memory is
    // in use, so a reading taken while some load reads high, and a reading taken below a size has
    // more of its room there from the estimate. The pool must know both of the reading it is
    // handed, which can be a second old.
    let now = 0;
    const cap = new MemoryCap({
      sources: {
        limit: () => ({ availableBytes: 1_424 * MIB, totalBytes: 4 * GIB }),
        machine: () => null,
        now: () => now,
      },
    });
    assert.equal(cap.read(20, 4)?.loading, 4);
    now = MEMORY_CAP_READ_INTERVAL_MS - 1;
    const kept = cap.read(24, 0);
    assert.equal(kept?.loading, 4, 'the kept reading, taken while four loaded');
    assert.equal(kept.held, 20, 'and with twenty held, not the 24 asked about');
    now = MEMORY_CAP_READ_INTERVAL_MS;
    const fresh = cap.read(24, 0);
    assert.equal(fresh?.loading, 0, 'a fresh one, taken once they had');
    assert.equal(fresh.held, 24);
    assert.equal(cap.read(20)?.loading, 0, 'none, where the pool does not say');
  });
});

describe('a pool bounded by memory (P-236)', () => {
  it('stops growing at what memory allows, however much is queued', async () => {
    const pool = new CheckPool({
      logger: silent,
      size: 20,
      minSize: 2,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 5),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 30; id += 1) pool.submit(request(id, 60_000));
    await until(
      () => pool.stats().size === 5,
      reporting('the pool to grow to what memory allows', pool),
    );
    // A worker that has started has not necessarily taken a check yet, and until it has, the
    // queue still holds that check: wait for the state, not for time (`P-234`). Under load the
    // queue read 26–28 after a fixed 300 ms.
    await until(() => pool.stats().busy === 5, reporting('every worker to take a check', pool));
    // A lower bound, so it can only make the test harder to pass: long enough for a growth step
    // that ignored the cap to have landed.
    await sleep(300);
    const stats = pool.stats();
    assert.equal(stats.size, 5);
    assert.equal(stats.busy, 5);
    assert.equal(stats.queued, 25, 'the rest wait for a worker rather than getting one');
    assert.equal(stats.ceiling, 5);
    assert.equal(stats.memoryCap, 5);
    assert.equal(stats.heldBack, 15);
    assert.equal(stats.maxSize, 20, 'the derived ceiling is unchanged; memory is what binds');
  });

  it('never drops below its minimum for memory, which an operator set', async () => {
    const pool = new CheckPool({
      logger: silent,
      size: 10,
      minSize: 3,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 0),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 10; id += 1) pool.submit(request(id, 60_000));
    await sleep(300);
    assert.equal(pool.stats().size, 3);
    assert.equal(pool.stats().ceiling, 3);
    assert.equal(pool.stats().memoryCap, 0);
    assert.equal(pool.stats().heldBack, 7);
  });

  it('gives workers back as they come free when memory falls, never one in a check', async () => {
    let allowed = 8;
    // Memory falls to three workers' worth: the pool keeps one past it, the shed margin (`P-437`),
    // and gives back the rest.
    const kept = 3 + MEMORY_SHED_MARGIN_WORKERS;
    const results: { sensorId: number; outcome: string }[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: (result) => results.push({ sensorId: result.sensorId, outcome: result.outcome }),
    });
    pools.push(pool);
    await started(pool);
    // A saturated pool: every worker busy and a queue behind them, so none is ever spare for the
    // over-ceiling sweep — the case the retire in `#pump` exists for.
    let next = 1;
    const accepted = new Set<number>();
    const feed = (): void => {
      while (pool.stats().queued < 8) {
        if (pool.submit(request(next, 150)) === 'accepted') accepted.add(next);
        next += 1;
      }
    };
    feed();
    await until(() => pool.stats().size === 8, reporting('the pool to grow to 8', pool));
    allowed = 3;
    await pollWithin(
      10_000,
      () =>
        `the pool to give the memory back, down to ${String(kept)}; it has ${String(pool.stats().size)}`,
      () => {
        if (pool.stats().size <= kept) return true;
        // **A side effect, on purpose:** each poll tops the queue up again, so the pool stays
        // saturated while it sheds and no worker is ever spare for the over-ceiling sweep.
        feed();
        return false;
      },
      20,
    );
    // And stops there, rather than giving up more while the first ones are still exiting: their
    // memory is on its way back, and counting it as still taken would shed the pool to its floor.
    for (let round = 0; round < 15; round += 1) {
      feed();
      await sleep(20);
      assert.equal(pool.stats().size, kept, 'not below what memory lets it keep');
    }
    assert.equal(pool.stats().ceiling, kept);
    assert.equal(pool.stats().heldBack, 8 - kept);
    // Every check it accepted is answered once, and none of them by a worker taken mid-check.
    await pool.stop({ drainMs: 5_000 });
    const answered = results.filter((one) => accepted.has(one.sensorId));
    assert.equal(answered.length, accepted.size);
    assert.equal(new Set(answered.map((one) => one.sensorId)).size, accepted.size);
    assert.equal(pool.stats().workerCrashes, 0);
    const lost = answered.filter((one) => one.outcome !== 'ok');
    // Those still queued when it stopped are answered as stopped; everything that ran finished.
    assert.equal(pool.stats().timedOut, 0);
    assert.ok(
      lost.length <= 8 + 8,
      `at most a queue and a pool unfinished, not ${String(lost.length)}`,
    );
  });

  it('gives back exactly the excess when many workers come free at once', async () => {
    // Eight checks finishing together, just after memory fell to three: each completion is a
    // chance to give a worker back, and the first five are still exiting when the last three
    // finish. Their memory is on its way back, so counting it as still taken would give up the
    // last three as well, down to the floor.
    let allowed = 8;
    let done = 0;
    const cap = fixedCap(() => allowed);
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 16; id += 1) pool.submit(request(id, 100));
    await until(() => done === 16, reporting('the pool to grow to 8 and go quiet', pool));
    assert.equal(pool.stats().size, 8);
    // All eight loaded, or the ready ones answer the next eight before the rest can take one: at a
    // load of 40 the first sixteen were answered with workers still loading.
    await loaded(pool, cap);
    for (let id = 101; id <= 108; id += 1) pool.submit(request(id, 400));
    await until(() => pool.stats().busy === 8, reporting('all eight to be running', pool));
    allowed = 3;
    await until(() => done === 24, reporting('all eight to finish', pool));
    await sleep(200);
    assert.equal(
      pool.stats().size,
      3 + MEMORY_SHED_MARGIN_WORKERS,
      'what memory lets it keep, not the floor',
    );
  });

  it('grows past memory on an explicit size, and reports it rather than enforcing it', async () => {
    const { logger, lines } = recording();
    let allowed = 2;
    const pool = new CheckPool({
      logger,
      size: 6,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      enforceMemoryCap: false,
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const past = (): number =>
      lines.filter((line) => line.msg.startsWith('workerPoolSize allows more workers')).length;
    // Three first: past memory, so the episode starts, and the pool grows past it all the same.
    for (let id = 1; id <= 3; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().size === 3, reporting('the pool to grow past memory', pool));
    // And again inside the same episode (`P-437`): the operator's setting is obeyed while it lasts.
    for (let id = 4; id <= 10; id += 1) pool.submit(request(id, 60_000));
    // Every worker running a check, so the growth has landed and nothing is on its way.
    await until(
      () => pool.stats().busy === 6,
      reporting('the pool to grow to the configured size', pool),
    );
    const stats = pool.stats();
    assert.equal(stats.ceiling, 6);
    assert.equal(stats.memoryCap, 2);
    assert.equal(stats.heldBack, 0);
    assert.equal(past(), 1, 'said once for the episode');
    // A size the operator set never gives a worker back for memory, so the line where it would is
    // not on its warning.
    const warning = lines.find((line) => line.msg.startsWith('workerPoolSize allows more workers'));
    assert.ok(warning !== undefined);
    assert.equal('givesBackBelowMb' in warning, false);
    assert.equal('growsAgainAboveMb' in warning, false);
    // Memory for all six and a worker past the release margin: said once that it has room for
    // them, which is what was measured, and not that it holds what `workerPoolSize` allows.
    allowed = 6 + 1 + MEMORY_RELEASE_MARGIN_WORKERS;
    pool.submit(request(11, 60_000));
    pool.submit(request(12, 60_000));
    const again = lines.filter((line) =>
      line.msg.startsWith('memory has room for the workers the check pool holds again'),
    );
    assert.equal(again.length, 1);
    assert.deepEqual(
      { cap: again[0]?.['cap'], maxSize: again[0]?.['maxSize'] },
      { cap: allowed, maxSize: 6 },
    );
    assert.equal(past(), 1);
  });

  it('ends an explicit size’s episode once the pool idles under memory, and warns at the next', async () => {
    // **An explicit size's hold never ended on its own** (`P-437`'s second review). It was measured
    // against the size the pool grew to, which is past memory by definition: the pool could idle
    // to its floor and the hold went on, and the next burst past memory said nothing. Measured
    // against the pool now, idling to two under memory for four ends it, and the next burst past
    // memory is a new episode, with its own warning.
    const { logger, lines } = recording();
    let done = 0;
    const pool = new CheckPool({
      logger,
      size: 6,
      minSize: 1,
      idleShrinkMs: 200,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 4),
      enforceMemoryCap: false,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const lined = (prefix: string): Line[] => lines.filter((line) => line.msg.startsWith(prefix));
    const past = (): number => lined('workerPoolSize allows more workers').length;
    const released = (): Line[] =>
      lined('memory has room for the workers the check pool holds again');
    for (let id = 1; id <= 6; id += 1) pool.submit(request(id, 100));
    assert.equal(past(), 1, 'six wanted, past memory for four');
    await until(() => done === 6, reporting('the burst', pool));
    await until(
      () => released().length === 1,
      reporting('the pool to idle under memory', pool),
      15_000,
    );
    // Room for four, less the release margin, past the pool: two at most.
    const size = released()[0]?.['size'];
    assert.ok(
      typeof size === 'number' && size <= 4 - 1 - MEMORY_RELEASE_MARGIN_WORKERS,
      `ended at ${String(size)} workers`,
    );
    for (let id = 7; id <= 12; id += 1) pool.submit(request(id, 100));
    assert.equal(past(), 2, 'the next burst past memory is said again');
    await until(() => done === 12, reporting('the next burst', pool));
    assert.equal(past(), 2, 'once');
  });

  it('says a fixed explicit size is past memory once it has started, and once', async () => {
    // **A floor the operator set past memory** (`P-437`'s third review). `start` spawns the floor
    // without asking memory, and a fixed pool never grows, so the warning, which was only where
    // growth asks, never came: `poolMemoryCap` alone said so.
    const { logger, lines } = recording();
    let allowed = 2;
    const pool = new CheckPool({
      logger,
      size: 4,
      minSize: 4,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      enforceMemoryCap: false,
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const lined = (prefix: string): Line[] => lines.filter((line) => line.msg.startsWith(prefix));
    const past = lined('workerPoolSize allows more workers');
    assert.equal(past.length, 1, 'four started against memory for two');
    assert.deepEqual(
      { held: past[0]?.['held'], cap: past[0]?.['cap'], maxSize: past[0]?.['maxSize'] },
      { held: 4, cap: 2, maxSize: 4 },
    );
    assert.equal(pool.size, 4, 'and all four kept: the setting is obeyed');
    // Its episode ends as a growing one does: memory with room for the four and the margin.
    allowed = 4 + 1 + MEMORY_RELEASE_MARGIN_WORKERS;
    pool.stats();
    assert.equal(lined('memory has room for the workers the check pool holds again').length, 1);
    assert.equal(lined('workerPoolSize allows more workers').length, 1, 'said once');
  });

  it('says a fixed explicit size is past memory on a reading taken while its workers loaded', async () => {
    // **Less the workers the reading counted as loading** (`P-437`'s fourth review), as every other
    // look at memory takes it: `MemoryCap` keeps a reading for a second, and the one `start` looks
    // at can be from while its own workers loaded, room high by them. Four started against room
    // for five with three of them loading: room for two, once they have.
    const { logger, lines } = recording();
    const pool = new CheckPool({
      logger,
      size: 4,
      minSize: 4,
      registryModule: FIXTURES,
      memoryCap: fixedCap(
        () => 5,
        () => 3,
      ),
      enforceMemoryCap: false,
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const past = lines.filter((line) => line.msg.startsWith('workerPoolSize allows more workers'));
    assert.equal(past.length, 1, 'short by two, fewer than the three loading');
    assert.deepEqual(
      { held: past[0]?.['held'], cap: past[0]?.['cap'], level: past[0]?.level },
      { held: 4, cap: 5, level: 40 },
      'the reading as it was taken',
    );
    await stopped(pool);
  });

  it('is unbounded by memory where memory cannot be read', async () => {
    const pool = new CheckPool({
      logger: silent,
      size: 4,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => undefined),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 6; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().size === 4, reporting('the pool to grow to its ceiling', pool));
    const stats = pool.stats();
    assert.equal(stats.ceiling, 4);
    assert.equal('memoryCap' in stats, false, 'a gap, not a cap of nothing');
    assert.equal(stats.heldBack, 0);
  });

  it('says memory is holding it back once per hold, not once per check or per emptied queue', async () => {
    // **The toggle case** (`P-437`). A hold used to end whenever the queue emptied, which on a probe
    // whose wheel hands over a second's checks at once is every second: `ms-server` logged 311
    // holds and 311 releases in ten minutes, a warning each. Now it ends when memory has room.
    const { logger, lines } = recording();
    let allowed = 2;
    const cap = fixedCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      queueMaxLength: 200,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const holding = (): number =>
      lines.filter((line) => line.msg.startsWith('memory is holding the check pool back')).length;
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    // Three bursts, each far past what memory allows, with the queue emptied in between.
    let id = 0;
    for (let burst = 1; burst <= 3; burst += 1) {
      for (let i = 0; i < 100; i += 1) pool.submit(request((id += 1), 30));
      await until(
        () => pool.stats().queued === 0 && pool.stats().busy === 0,
        reporting(`burst ${String(burst)}`, pool),
      );
    }
    assert.equal(holding(), 1, 'one line for the hold, however often the queue emptied');
    assert.equal(released(), 0, 'and none for a release, since memory never had room');
    assert.equal(pool.stats().size, 2);
    await loaded(pool, cap);
    // Memory with room past the release margin: one release, the pool grows to what memory
    // allows, and the burst behind it, still past that, is the next hold.
    allowed = 2 + 1 + MEMORY_RELEASE_MARGIN_WORKERS;
    for (let i = 0; i < 100; i += 1) pool.submit(request((id += 1), 30));
    await until(
      () => pool.stats().queued === 0 && pool.stats().busy === 0,
      reporting('the last burst', pool),
    );
    assert.equal(released(), 1, 'one release when memory had room');
    assert.equal(holding(), 2, 'and one more hold, at what memory allows now');
    assert.equal(pool.stats().size, allowed);
  });
});

describe('the memory gate’s margins (P-437)', () => {
  it('holds rather than growing for room of one worker, and grows again past the release margin', async () => {
    const { logger, lines } = recording();
    let allowed = 3;
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      queueMaxLength: 200,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    let id = 0;
    // Checks that hold their workers, so every submit is a pump with checks waiting.
    const burst = (): void => {
      for (let i = 0; i < 8; i += 1) pool.submit(request((id += 1), 60_000));
    };
    burst();
    // Every worker running a check, so the growth has landed and nothing is on its way.
    await until(
      () => pool.stats().busy === 3,
      reporting('the pool to grow to what memory allows', pool),
    );
    // Room for one more worker, as noise of a few MiB gives: inside the margin, so it holds.
    allowed = 4;
    burst();
    // A lower bound, so it can only make the test harder to pass: time for a spawn to land.
    await sleep(300);
    assert.equal(pool.stats().size, 3, 'room for one worker is not a release');
    assert.equal(pool.stats().grown, 2, 'and grows nothing');
    assert.equal(released(), 0);
    // Room for one more past the margin: the hold ends, once, and the pool grows to what memory
    // allows.
    allowed = 3 + 1 + MEMORY_RELEASE_MARGIN_WORKERS;
    burst();
    await until(
      () => pool.stats().size === allowed,
      reporting('the pool to grow once memory had room', pool),
    );
    assert.equal(released(), 1);
  });

  it('keeps a worker past what memory allows, and gives one back only past the shed margin', async () => {
    let allowed = 8;
    let done = 0;
    const pool = new CheckPool({
      logger: silent,
      size: 4,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 200));
    await until(() => done === 8, reporting('the pool to grow to four and go quiet', pool));
    assert.equal(pool.stats().size, 4);
    let id = 100;
    /** A check to a free worker: a pump, and a reading, with nothing waiting. */
    const poke = async (): Promise<void> => {
      const before = done;
      pool.submit(request((id += 1), 1));
      await until(() => done > before, reporting('the poke', pool));
    };
    // Memory for three: a worker's worth under the line growth stops at, which noise gives.
    allowed = 3;
    for (let round = 0; round < 5; round += 1) await poke();
    assert.equal(pool.stats().size, 4, 'inside the shed margin, so it keeps the four');
    assert.equal(pool.stats().shrunk, 0);
    // Memory for two: past the margin, so one goes back, and only one.
    allowed = 2;
    await poke();
    await until(() => pool.stats().size === 3, reporting('one worker given back', pool));
    for (let round = 0; round < 5; round += 1) await poke();
    assert.equal(pool.stats().size, 2 + MEMORY_SHED_MARGIN_WORKERS);
    assert.equal(pool.stats().shrunk, 1);
  });

  it('reports the pool it holds as its ceiling, however the reading moves inside the margins', async () => {
    let allowed = 3;
    const pool = new CheckPool({
      logger: silent,
      size: 10,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 60_000));
    // Every worker running a check, so the growth has landed and nothing is on its way.
    await until(
      () => pool.stats().busy === 3,
      reporting('the pool to grow to what memory allows', pool),
    );
    // Readings a worker either side, as noise gives at the reserve: Probe Health's ceiling and
    // held-back count stay where the pool is, rather than moving with each reading.
    for (const reading of [3, 4, 2, 4, 3, 2]) {
      allowed = reading;
      const stats = pool.stats();
      assert.equal(stats.memoryCap, reading, 'the reading itself is still reported');
      assert.equal(stats.ceiling, 3, `the ceiling at a reading of ${String(reading)}`);
      assert.equal(stats.heldBack, 7);
    }
  });

  it('ends a hold when memory has room, with nothing waiting, and says so once', async () => {
    const { logger, lines } = recording();
    let allowed = 2;
    let done = 0;
    const cap = fixedCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    for (let id = 1; id <= 6; id += 1) pool.submit(request(id, 100));
    await until(() => done === 6, reporting('the burst, held at two', pool));
    await loaded(pool, cap);
    assert.equal(pool.stats().ceiling, 2);
    // One check, which a free worker takes at once, and memory with room while it runs. Its
    // result's pump is the first to read that, with nothing queued: no `stats()` before the
    // assertion, which looks too.
    pool.submit(request(7, 200));
    assert.equal(pool.stats().queued, 0, 'nothing waiting');
    allowed = 10;
    await until(() => done === 7, reporting('the check to finish', pool));
    assert.equal(released(), 1, 'the hold ended on a pump with nothing waiting');
    // What memory allows, which here is all of `maxSize`. Probe Health's sentence is about this
    // ceiling, not the gate: with memory allowing fewer than `maxSize` it would stay after a release.
    assert.equal(pool.stats().ceiling, 10, 'the ceiling is what memory allows now');
    assert.equal(pool.stats().heldBack, 0);
    pool.submit(request(8, 1));
    assert.equal(released(), 1, 'once');
    assert.equal(pool.stats().grown, 1, 'and nothing grown for checks that did not wait');
  });

  it('ends a hold on a pool that never pumps, where Probe Health reads it', async () => {
    // **No submit and no result after memory frees** (`P-437`): a probe whose sensors are all
    // paused, or moved. Only the heartbeat's `stats()` reads the gate, so that is where it ends.
    const { logger, lines } = recording();
    let allowed = 2;
    let done = 0;
    const cap = fixedCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    for (let id = 1; id <= 6; id += 1) pool.submit(request(id, 100));
    await until(() => done === 6, reporting('the burst, held at two', pool));
    await loaded(pool, cap);
    allowed = 10;
    assert.equal(released(), 0, 'nothing has looked yet');
    const stats = pool.stats();
    assert.equal(stats.ceiling, 10, 'the ceiling follows memory with nothing submitted');
    assert.equal(stats.heldBack, 0);
    assert.equal(released(), 1, 'and the hold ended where it was read');
  });

  it('ends a hold when an idle worker’s exit is all that happens', async () => {
    // The pool gives idle workers back with nothing submitted and no `stats()`: each exit looks,
    // so the release line comes when memory has room rather than at the next burst.
    const { logger, lines } = recording();
    let allowed = 3;
    let done = 0;
    const cap = fixedCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      idleShrinkMs: 300,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const count = (prefix: string): number =>
      lines.filter((line) => line.msg.startsWith(prefix)).length;
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 50));
    await until(() => done === 8, reporting('the burst, held at three', pool));
    assert.equal(count('memory is holding the check pool back'), 1);
    // Every worker the burst grew to loaded first, or one coming ready is what looks: at a load of
    // 17 the first worker answered the whole burst while the other two loaded, and the second to
    // say ready ended the hold, with no exit at all.
    await loaded(pool, cap);
    allowed = 10;
    await until(
      () => count('memory has room for more workers again') === 1,
      reporting('the hold to end on an idle worker’s exit', pool),
    );
    assert.ok(count('shrinking the check pool') >= 1, 'it was an exit that looked');
  });

  it('does not end a hold for the memory an idle worker gave back, and grows back to it', async () => {
    // **One give-back is not a release** (`P-437`). Memory with room for one more than the pool
    // held at, inside the release margin: the pool holds. An idle worker given back leaves that
    // room for two more than the pool now, which measured against the smaller pool was a release,
    // and a hold at the next burst. Measured against the size the hold started at it is neither,
    // and the next burst buys the worker back without a line.
    const { logger, lines } = recording();
    let allowed = 3;
    let done = 0;
    const inner = fixedCap(() => allowed);
    /** The workers resident at the last reading: those held, and those whose threads are exiting. */
    let resident = -1;
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      // A second, so the test has one give-back to look at before the next.
      idleShrinkMs: 1_000,
      queueMaxLength: 200,
      registryModule: FIXTURES,
      memoryCap: {
        read: (held, loading) => {
          resident = held;
          return inner.read(held, loading);
        },
      },
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const count = (prefix: string): number =>
      lines.filter((line) => line.msg.startsWith(prefix)).length;
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 50));
    await until(() => done === 8, reporting('the burst, held at three', pool));
    allowed = 4;
    await until(() => pool.size === 2, reporting('one idle worker given back', pool));
    // **Its thread exited**, so its exit has looked at the gate: the room it freed is only room once
    // it has, and a release measured against the pool now would come here, not at the retire.
    await until(
      () => {
        pool.stats();
        return resident === pool.size;
      },
      reporting('the given-back worker’s thread to exit', pool, () => ({ resident })),
    );
    // Every way the gate is read: its exit has looked, and `stats()` and a pump look now.
    assert.equal(pool.stats().ceiling, 3, 'the size it held at, which memory still has room for');
    assert.equal(count('memory has room for more workers again'), 0, 'no release for it');
    for (let id = 9; id <= 16; id += 1) pool.submit(request(id, 2_000));
    await until(
      () => pool.stats().busy === 3,
      reporting('the next burst to buy the worker back', pool),
    );
    assert.equal(count('memory has room for more workers again'), 0);
    assert.equal(count('memory is holding the check pool back'), 1, 'and no second hold');
    // A lower bound, so it can only make the test harder to pass: time for a spawn to land.
    await sleep(300);
    assert.equal(pool.size, 3, 'back to the size it held at, and no further');
  });

  it('does not end a hold while its own workers load, nor on a reading kept from then', async () => {
    // **A loading worker is in the reading before its memory is** (`P-437`'s third review): its
    // slot is pushed when its thread starts, and a reading taken then counts it as resident, so
    // room reads high by about the workers loading, and one such reading ended a hold that the
    // next would have started again. The registry here takes 400 ms to import. Two guards, one
    // phase each: the pool's own count while any loads, for a reading that says nothing of it,
    // and the reading's count, for one `MemoryCap` kept from while they loaded.
    const { logger, lines } = recording();
    let allowed = 5;
    let says: 'nothing' | 'kept' | 'now' = 'nothing';
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      registryModule: SLOW,
      memoryCap: fixedCap(
        () => allowed,
        (loading) => (says === 'nothing' ? undefined : says === 'kept' ? 4 : loading),
      ),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    for (let id = 1; id <= 5; id += 1) pool.submit(request(id, 60_000));
    await until(
      () => pool.size === 5,
      reporting('the four the burst grew to start their threads', pool),
    );
    for (let id = 6; id <= 10; id += 1) pool.submit(request(id, 60_000));
    // From here to the release's assertion is one synchronous stretch: no worker can say ready
    // inside it, so the loading counted here is the loading the reading below is taken with.
    const loading = 5 - pool.stats().busy;
    assert.ok(loading >= 1, 'the hold started with workers still loading');
    // Room past the size it held at and the margin, and three more, read while they load.
    allowed = 5 + 1 + MEMORY_RELEASE_MARGIN_WORKERS + 3;
    pool.stats();
    assert.equal(released(), 0, `not while ${String(loading)} load`);
    // Readings kept from while they loaded, as `MemoryCap` keeps one for a second, say so.
    says = 'kept';
    await until(
      () => pool.stats().busy === 5,
      reporting('every worker to load and take a check', pool, () => ({ released: released() })),
    );
    pool.stats();
    assert.equal(released(), 0, 'nor on a reading kept from while they loaded');
    // Loaded: the next reading, taken with none loading, is the release.
    says = 'now';
    pool.stats();
    assert.equal(released(), 1, 'once they had loaded');
  });

  it('holds at the size it reached during a ramp, each loading worker counted once (P-439)', async () => {
    // **A worker loading its registry was counted twice** (`P-439`): in `#slots` from when its
    // thread started, and on its way until its spawn settled. A hold started mid-ramp recorded
    // that sum as the size it held at, and needed room for as many more again before it ended.
    // The registry here takes 400 ms to import, so the workers the first burst grows are loading
    // when the second starts the hold.
    const { logger, lines } = recording();
    let allowed = 5;
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      registryModule: SLOW,
      memoryCap: fixedCap(() => allowed),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const lined = (prefix: string): Line[] => lines.filter((line) => line.msg.startsWith(prefix));
    const released = (): number => lined('memory has room for more workers again').length;
    for (let id = 1; id <= 5; id += 1) pool.submit(request(id, 60_000));
    await until(
      () => pool.size === 5,
      reporting('the four the burst grew to start their threads', pool),
    );
    const loading = 5 - pool.stats().busy;
    assert.ok(loading >= 1, 'at least one of them still loading');
    for (let id = 6; id <= 10; id += 1) pool.submit(request(id, 60_000));
    const holds = lined('memory is holding the check pool back');
    assert.equal(holds.length, 1, 'the second burst wanted more than memory has room for');
    assert.equal(
      holds[0]?.['held'],
      5,
      `five workers, ${String(loading)} of them loading, each counted once`,
    );
    await until(
      () => pool.stats().busy === 5,
      reporting('every worker to load and take a check', pool),
    );
    // The release margin's worth of room past the five it held at: not a release.
    allowed = 5 + MEMORY_RELEASE_MARGIN_WORKERS;
    pool.stats();
    assert.equal(released(), 0, 'inside the margin');
    // One worker past it: the release, where five with the loading counted twice needed more.
    allowed = 5 + 1 + MEMORY_RELEASE_MARGIN_WORKERS;
    pool.stats();
    assert.equal(released(), 1, 'past the true size it held at and the margin');
  });

  it('starts a hold at the room its loaded workers leave, not counting those still loading', async () => {
    // **The size a hold starts at leaves the loading workers out of the room it reads** (`P-437`'s
    // third review): a reading counts each as resident before most of its memory is in use. Reached
    // where growth comes more than a worker at once, past a pool of ten: a straggler under a tenth
    // waits, and the check that makes it a burst grows the pool for both. Here eleven, the eleventh
    // loading, and two checks behind them, against memory that reads room for twelve: the hold
    // starts at eleven, not twelve. The registry takes 400 ms to import.
    const { logger, lines } = recording();
    const pool = new CheckPool({
      logger,
      size: 20,
      minSize: 10,
      // A minute, so the straggler waits for the check that makes it a burst, not for its time.
      growAfterMs: 60_000,
      registryModule: SLOW,
      memoryCap: fixedCap(() => 12),
      onResult: () => undefined,
    });
    pools.push(pool);
    await started(pool);
    const holds = (): Line[] =>
      lines.filter((line) => line.msg.startsWith('memory is holding the check pool back'));
    for (let id = 1; id <= 10; id += 1) pool.submit(request(id, 60_000));
    // One check behind ten busy workers is a burst at ten: it grows one, inside what memory allows.
    pool.submit(request(11, 60_000));
    await until(() => pool.size === 11, reporting('the eleventh worker to start its thread', pool));
    // From here to the hold's assertions is one synchronous stretch: no worker can say ready inside
    // it, so the loading counted here is the loading the reading below is taken with.
    const loading = 11 - pool.stats().busy;
    assert.equal(loading, 1, 'the eleventh still loading');
    pool.submit(request(12, 60_000));
    assert.equal(holds().length, 0, 'one behind eleven is a straggler, and asks memory nothing');
    pool.submit(request(13, 60_000));
    const held = holds();
    assert.equal(held.length, 1, 'two behind them are a burst, past what memory reads room for');
    assert.deepEqual(
      { held: held[0]?.['held'], wanted: held[0]?.['wanted'], heldAt: held[0]?.['heldAt'] },
      { held: 11, wanted: 13, heldAt: 11 },
      'held at eleven: room for twelve, less the one loading',
    );
    assert.equal(pool.stats().grown, 1, 'and nothing grown for the burst');
    await until(
      () => pool.stats().busy === 11,
      reporting('every worker to load and take a check', pool),
    );
    // A lower bound, so it can only make the test harder to pass: time for a spawn to land.
    await sleep(300);
    assert.equal(pool.size, 11, 'and no further once it had loaded');
    assert.equal(pool.stats().queued, 2);
    assert.equal(holds().length, 1);
    // Its eleven workers would otherwise hold their memory to the file's end.
    await stopped(pool);
  });

  /**
   * A pool held at three by memory for three, whose idle workers have then gone back to its floor
   * of one, every given-back thread exited: what `P-437`'s third review left as the cost of F2.
   */
  const heldAtThreeThenQuiet = async (): Promise<{
    pool: CheckPool;
    setAllowed: (workers: number) => void;
    count: (prefix: string) => number;
    lines: Line[];
  }> => {
    const { logger, lines } = recording();
    let allowed = 3;
    let done = 0;
    const inner = fixedCap(() => allowed);
    /** The workers resident at the last reading: those held, and those whose threads are exiting. */
    let resident = -1;
    const cap = {
      get loading() {
        return inner.loading;
      },
      read: (held: number, loading: number) => {
        resident = held;
        return inner.read(held, loading);
      },
    };
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      idleShrinkMs: 300,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const count = (prefix: string): number =>
      lines.filter((line) => line.msg.startsWith(prefix)).length;
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 50));
    await until(() => done === 8, reporting('the burst, held at three', pool));
    assert.equal(count('memory is holding the check pool back'), 1, 'held');
    assert.equal(lines.find((line) => 'heldAt' in line)?.['heldAt'], 3, 'at three');
    await loaded(pool, cap);
    await until(
      () => {
        pool.stats();
        return pool.size === 1 && resident === 1;
      },
      reporting('the idle workers to go back to the floor and exit', pool, () => ({ resident })),
    );
    assert.equal(count('memory has room for more workers again'), 0, 'still held');
    return {
      pool,
      setAllowed: (workers) => {
        allowed = workers;
      },
      count,
      lines,
    };
  };

  it('ends a quiet hold once demand brings the pool back to the size it held at, with room past it', async () => {
    // **A quiet pool stays held, and demand ends it** (`P-437`'s third review, F2; decided
    // 2026-10-19: stability over responsiveness, provided no check waits on a hold for ever). Read
    // two workers below the size it held at, memory with room for the margin past that size is no
    // release, since each worker given back may have freed more than the estimate. The next burst
    // grows the pool back to that size inside the hold, with no line, and a reading there, once
    // the workers it grew have loaded, is the release: every check of the burst gets a worker.
    const { pool, setAllowed, count, lines } = await heldAtThreeThenQuiet();
    setAllowed(3 + 1 + MEMORY_RELEASE_MARGIN_WORKERS);
    for (let look = 0; look < 5; look += 1) {
      assert.equal(pool.stats().ceiling, 3, 'memory still holds it, as Probe Health says');
      await sleep(50);
    }
    assert.equal(count('memory has room for more workers again'), 0, 'quiet, it stays held');
    for (let id = 101; id <= 105; id += 1) pool.submit(request(id, 60_000));
    await until(
      () => pool.stats().busy === 5,
      reporting('every check of the burst to get a worker', pool, () => ({
        released: count('memory has room for more workers again'),
      })),
    );
    const release = lines.find((line) => line.msg.startsWith('memory has room for more workers'));
    assert.equal(release?.['size'], 3, 'released with the pool back at the size it held at');
    assert.equal(count('memory has room for more workers again'), 1, 'once');
    assert.equal(count('memory is holding the check pool back'), 1, 'and no second hold');
    assert.equal(pool.size, 5, 'grown past it to what memory has room for');
    await stopped(pool);
  });

  it('ends a quiet hold on memory alone, below the size it held at, with room past it for a worker more for each it is short', async () => {
    // **Memory alone ends it too** (`P-437`'s third review, F2; decided 2026-10-19). Read below the
    // size it held at, a reading needs room past that size for the margin and a worker more for
    // each worker the pool is short of it, two here: room for seven at a pool of one. One worker
    // less is no release; seven is, with nothing submitted, where Probe Health reads the pool.
    const { pool, setAllowed, count } = await heldAtThreeThenQuiet();
    const shortOf = 3 - 1;
    setAllowed(3 + 1 + MEMORY_RELEASE_MARGIN_WORKERS + shortOf - 1);
    pool.stats();
    assert.equal(count('memory has room for more workers again'), 0, 'a worker short of it');
    setAllowed(3 + 1 + MEMORY_RELEASE_MARGIN_WORKERS + shortOf);
    assert.equal(pool.stats().queued, 0, 'nothing waiting');
    assert.equal(count('memory has room for more workers again'), 1, 'released on memory alone');
    assert.equal(pool.size, 1, 'at its floor');
    for (let id = 101; id <= 107; id += 1) pool.submit(request(id, 60_000));
    await until(
      () => pool.stats().busy === 7,
      reporting('every check of the next burst to get a worker', pool),
    );
    assert.equal(count('memory is holding the check pool back'), 1, 'with no second hold');
    await stopped(pool);
  });

  it('lets a worker memory fell under while it loaded run the check it was grown for, then gives it back', async () => {
    // **Not given back in the pump its ready runs** (`P-437`'s third review, A): its spawn has yet
    // to settle, and out of `#slots` then it would be counted on its way with nothing to take it off
    // `#held`. So a worker grown for a check, whose memory fell past the shed margin while it
    // loaded, runs that check, and goes back for memory once it is free, as any other (`P-236`).
    let allowed = 5;
    let done = 0;
    const pool = new CheckPool({
      logger: silent,
      size: 10,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    pool.submit(request(1, 60_000));
    // One behind the busy first: it grows one, inside what memory allows.
    pool.submit(request(2, 300));
    assert.equal(pool.stats().grown, 1);
    // Memory for none from here, before the worker loads: past the shed margin at two. Nothing
    // reads it until the worker says ready, since the first is busy for a minute.
    allowed = 0;
    await until(
      () => pool.stats().busy === 2,
      reporting('the second worker to take the check it was grown for', pool),
    );
    assert.equal(pool.stats().shrunk, 0, 'not given back as it said ready');
    await until(
      () => done === 1 && pool.size === 1,
      reporting('the second worker to go back once free', pool, () => ({ done })),
    );
    assert.equal(pool.stats().shrunk, 1, 'given back for memory once its check was done');
    await stopped(pool);
  });

  /** A cap whose last reading's resident workers a test can wait on: those held and exiting. */
  const residentCap = (
    workers: () => number,
  ): {
    read: (held: number, loading: number) => MemoryCapReading | undefined;
    readonly loading: number;
    readonly resident: number;
  } => {
    const inner = fixedCap(workers);
    let resident = -1;
    return {
      get loading() {
        return inner.loading;
      },
      get resident() {
        return resident;
      },
      read: (held, loading) => {
        resident = held;
        return inner.read(held, loading);
      },
    };
  };

  it('grows back past the size a shed for memory left it at only with a shed margin’s more room', async () => {
    // **A shed and the grow-back after it had less than a worker between them** (`P-437`'s fourth
    // review). A worker went back once a reading was a shed margin under room for the pool, and
    // grew back with room for one, so a reading that wobbled by a few MiB moved the pool both
    // ways: held at twelve, a fall of 125 MiB and ±20 MiB of noise grew it 21 times and shrank it
    // 23 in five minutes. Past where a shed left it, growing back now needs room for the worker
    // and the shed margin. Held at six; memory for three sheds two, to four; room for five then
    // grows nothing, six grows one, and seven takes it back to six, all inside the hold.
    const { logger, lines } = recording();
    let allowed = 6;
    let done = 0;
    const cap = residentCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const count = (prefix: string): number =>
      lines.filter((line) => line.msg.startsWith(prefix)).length;
    for (let id = 1; id <= 8; id += 1) pool.submit(request(id, 50));
    await until(() => done === 8, reporting('the burst, held at six', pool));
    assert.equal(lines.find((line) => 'heldAt' in line)?.['heldAt'], 6, 'held at six');
    await loaded(pool, cap);
    // Memory for three: past the shed margin at six, so two go back at the next pump, to four.
    allowed = 3;
    pool.submit(request(9, 1));
    await until(
      () => {
        pool.stats();
        return done === 9 && pool.size === 4 && cap.resident === 4;
      },
      reporting('two shed for memory, their threads exited', pool, () => ({
        resident: cap.resident,
      })),
    );
    assert.equal(pool.stats().shrunk, 2);
    const grownAtTheShed = pool.stats().grown;
    let id = 100;
    /** Checks that hold their workers, each submit a pump with checks waiting. */
    const busy = (checks: number): void => {
      for (let i = 0; i < checks; i += 1) pool.submit(request((id += 1), 60_000));
    };
    // Room for five, one past where the shed left it: what grew it back before, and not now.
    allowed = 5;
    busy(8);
    await until(() => pool.stats().busy === 4, reporting('the four to take checks', pool));
    // A lower bound, so it can only make the test harder to pass: time for a spawn to land.
    await sleep(300);
    assert.equal(pool.size, 4, 'room for one past it is not room for it');
    assert.equal(pool.stats().ceiling, 4, 'and Probe Health says so');
    assert.equal(pool.stats().grown, grownAtTheShed);
    // Room for six: the worker and the margin. One more, and no further.
    allowed = 6;
    busy(1);
    await until(() => pool.stats().busy === 5, reporting('a fifth worker', pool));
    await sleep(300);
    assert.equal(pool.size, 5);
    assert.equal(pool.stats().ceiling, 5);
    // Room for seven: back to the size it held at, and no release.
    allowed = 7;
    busy(1);
    await until(() => pool.stats().busy === 6, reporting('a sixth worker', pool));
    await sleep(300);
    assert.equal(pool.size, 6, 'back at the size it held at, and no further');
    assert.equal(pool.stats().grown, grownAtTheShed + 2);
    assert.equal(count('memory has room for more workers again'), 0, 'all inside the hold');
    assert.equal(count('memory is holding the check pool back'), 1);
    await stopped(pool);
  });

  it('grows back after idle give-backs to the size it held at with room for that size alone', async () => {
    // **What went back for want of work is not a shed for memory** (`P-437`'s fourth review): the
    // pool buys it back with room for each worker, to the size it held at, as it did. Held at three
    // by memory for three and quiet to its floor of one, the next burst takes it back to three with
    // memory still at three.
    const { pool, count } = await heldAtThreeThenQuiet();
    for (let id = 101; id <= 105; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().busy === 3, reporting('the burst to buy two back', pool));
    // A lower bound, so it can only make the test harder to pass: time for a spawn to land.
    await sleep(300);
    assert.equal(pool.size, 3, 'back at three, and no further');
    assert.equal(pool.stats().ceiling, 3);
    assert.equal(count('memory has room for more workers again'), 0, 'inside the hold');
    assert.equal(count('memory is holding the check pool back'), 1);
    await stopped(pool);
  });

  it('ends a hold whose ceiling was lowered under it on room past the new ceiling, and holds again at the next shortage', async () => {
    // **A hold's size is never past the ceiling** (`P-437`'s fourth review). Held at ten, with the
    // ceiling then lowered to six: the four it took back read as a pool four short of ten, so a
    // release needed room for fourteen, and memory with room for thirteen ended nothing. Then,
    // with the ceiling back at twenty and memory for three, the new shortage was the old hold, and
    // said nothing.
    const { logger, lines } = recording();
    let allowed = 10;
    let done = 0;
    const cap = residentCap(() => allowed);
    const pool = new CheckPool({
      logger,
      size: 20,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const holds = (): Line[] =>
      lines.filter((line) => line.msg.startsWith('memory is holding the check pool back'));
    const released = (): number =>
      lines.filter((line) => line.msg.startsWith('memory has room for more workers again')).length;
    for (let id = 1; id <= 15; id += 1) pool.submit(request(id, 100));
    await until(() => done === 15, reporting('the burst, held at ten', pool));
    assert.equal(holds()[0]?.['heldAt'], 10, 'held at ten');
    await loaded(pool, cap);
    pool.setMaxSize(6);
    await until(
      () => {
        pool.stats();
        return pool.size === 6 && cap.resident === 6;
      },
      reporting('the lowered ceiling to take four back', pool, () => ({
        resident: cap.resident,
      })),
    );
    allowed = 13;
    pool.stats();
    assert.equal(released(), 1, 'ended by memory with room past the ceiling');
    allowed = 3;
    pool.setMaxSize(20);
    for (let id = 16; id <= 25; id += 1) pool.submit(request(id, 60_000));
    assert.equal(holds().length, 2, 'the next shortage is a hold of its own');
    assert.equal(holds()[1]?.level, 40, 'with its warning');
    assert.equal(holds()[1]?.['cap'], 3);
    await stopped(pool);
  });
});

describe('stragglers at the memory line (P-437)', () => {
  // `ms-server`'s pattern: *from N to N + 1, queued 1* at 61–63 workers, a straggler at the line.
  // A pool of twenty held at what memory allows, the gate open, since nothing has been refused.
  const atTheLine = async (growAfterMs: number) => {
    const { logger, lines } = recording();
    let done = 0;
    const pool = new CheckPool({
      logger,
      size: 40,
      minSize: 20,
      growAfterMs,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 20),
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await started(pool);
    const holds = (): number =>
      lines.filter((line) => line.msg.startsWith('memory is holding the check pool back')).length;
    return { pool, holds, done: () => done };
  };

  it('neither holds nor grows for a straggler a worker takes before it has waited', async () => {
    // Two seconds against 100 ms checks: the first of twenty to finish takes the twenty-first.
    const { pool, holds, done } = await atTheLine(2_000);
    for (let id = 1; id <= 21; id += 1) pool.submit(request(id, 100));
    assert.equal(pool.stats().queued, 1, 'one check behind twenty busy workers');
    await until(
      () => done() === 21,
      reporting('every check, the last on a worker that came free', pool, () => ({
        holds: holds(),
        done: done(),
      })),
    );
    assert.equal(holds(), 0, 'memory refused nothing, because nothing was asked of it');
    assert.equal(pool.stats().grown, 0);
  });

  it('holds once for a straggler that lasts, through pumps that find growth still refused', async () => {
    const { pool, holds, done } = await atTheLine(300);
    for (let id = 1; id <= 20; id += 1) pool.submit(request(id, 3_000));
    pool.submit(request(21, 50));
    assert.equal(holds(), 0, 'not on sight');
    await until(
      () => holds() === 1,
      reporting('the straggler to last, and memory to refuse it', pool, () => ({
        holds: holds(),
        done: done(),
      })),
    );
    // Five more while every worker is busy, each submit a pump that asks to grow for the queue and
    // is refused again: the hold is still the one, rather than a hold per refusal.
    for (let id = 22; id <= 26; id += 1) {
      pool.submit(request(id, 50));
      await sleep(100);
    }
    assert.equal(pool.stats().queued, 6, 'every one of them waiting, nothing having grown');
    assert.equal(holds(), 1, 'one hold, through five refusals');
    await until(
      () => done() === 26,
      reporting('every check, the last on workers that came free', pool, () => ({
        holds: holds(),
        done: done(),
      })),
    );
    assert.equal(holds(), 1, 'and through twenty results and their pumps');
    assert.equal(pool.stats().grown, 0, 'and no worker memory did not have');
  });
});

describe('a worker recycled for ignoring its abort (P-286)', () => {
  it('is in the memory reading until its thread has exited, as a retired one is', async () => {
    // A check that ignores its abort while its thread is in native code (`test.block`): the
    // worker leaves `#slots` at the end of the abort grace, and its terminate lasts until the
    // native call returns. Its memory is resident all that time, so a reading taken then has to
    // be asked with it counted, or the pool reads that memory as someone else's.
    const scratch = await mkdtemp(join(tmpdir(), 'ms-recycle-memory-'));
    const unblocked = join(scratch, 'unblocked');
    const asked: number[] = [];
    const inner = fixedCap(() => 8);
    const pool = new CheckPool({
      logger: silent,
      size: 2,
      minSize: 2,
      abortGraceMs: 100,
      registryModule: FIXTURES,
      memoryCap: {
        read: (held, loading) => {
          asked.push(held);
          return inner.read(held, loading);
        },
      },
      onResult: () => undefined,
    });
    pools.push(pool);
    try {
      await started(pool);
      pool.submit({
        sensorId: 1,
        sensorType: 'test.block',
        target: { host: '192.0.2.1', ipVersion: 'auto' as const },
        params: { delayMs: 5_000, marker: unblocked },
        timeoutMs: 100,
      });
      await until(
        () => pool.stats().size === 1,
        reporting('the blocked worker taken out', pool),
        20_000,
      );

      asked.length = 0;
      pool.stats();
      // Only a reading taken while the thread was still blocked says anything, so presence of
      // the window is checked after the reading, not assumed.
      assert.equal(existsSync(unblocked), false, 'the reading was taken inside the terminate');
      assert.deepEqual([...asked], [2], 'one worker held and one still exiting, both resident');

      // The replacement starts only after the terminate has finished, so by the time it is in
      // the pool the exited worker is out of the reading: two, not three.
      await until(
        () => existsSync(unblocked) && pool.stats().size === 2,
        reporting('the thread unblocked and the replacement started', pool),
        60_000,
      );
      asked.length = 0;
      pool.stats();
      assert.deepEqual([...asked], [2], 'the exited worker is no longer counted');
    } finally {
      await stopped(pool);
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('scenario: a probe whose checks hang to their timeout (P-236, P-216b)', () => {
  it('stops at what memory holds, refuses and counts the rest, and answers every check', async () => {
    // The shape of `P-216b`, scaled down: every check waits out its timeout, the workload wants
    // far more workers than memory holds, and memory is a closed loop — each worker the pool
    // holds takes 40 MiB of a 1 GiB ceiling on top of 200 MiB the probe needs anyway.
    //
    //   1,024 − 200 − 256 reserve = 568 MiB for workers, which is 14 of them.
    const limitBytes = 1 * GIB;
    let largest = 0;
    const results: { sensorId: number; outcome: string }[] = [];
    let now = 0;
    // The workers whose memory is in the reading, as the pool counts them when it asks.
    let held = 0;
    const inner = new MemoryCap({
      sources: {
        limit: () => {
          return {
            availableBytes: limitBytes - 200 * MIB - held * WORKER_RESIDENT_MIB * MIB,
            totalBytes: limitBytes,
          };
        },
        machine: () => null,
        // Every read fresh, so the loop closes at once rather than at the interval.
        now: () => (now += MEMORY_CAP_READ_INTERVAL_MS),
      },
    });
    const cap = {
      read: (workers: number): MemoryCapReading | undefined => {
        held = workers;
        return inner.read(workers);
      },
    };
    const pool = new CheckPool({
      logger: silent,
      // The derived ceiling: what Little's law asks for when every check takes its whole timeout.
      size: 64,
      minSize: 2,
      queueMaxLength: 50,
      registryModule: FIXTURES,
      memoryCap: cap,
      onResult: (result) => results.push({ sensorId: result.sensorId, outcome: result.outcome }),
    });
    pools.push(pool);
    await started(pool);

    // 500 sensors, each a check that only ends when its 300 ms timeout aborts it, arriving in
    // tranches the way the wheel hands them over.
    const accepted = new Set<number>();
    let refused = 0;
    for (let tranche = 0; tranche < 10; tranche += 1) {
      for (let i = 0; i < 50; i += 1) {
        const id = tranche * 50 + i + 1;
        const outcome = pool.submit(request(id, 60_000, 300));
        if (outcome === 'accepted') accepted.add(id);
        else if (outcome === 'queue-full') refused += 1;
      }
      for (let tick = 0; tick < 10; tick += 1) {
        largest = Math.max(largest, pool.stats().size);
        await sleep(20);
      }
    }
    const stats = pool.stats();
    assert.ok(largest <= 14, `never past what memory holds; reached ${String(largest)}`);
    assert.equal(stats.memoryCap, 14);
    assert.equal(stats.ceiling, 14);
    assert.equal(stats.heldBack, 64 - 14);
    assert.ok(refused > 0, 'the rest are refused rather than given workers memory does not have');
    assert.equal(stats.refused, refused, 'and every one is counted');

    await pool.stop({ drainMs: 5_000 });
    const answered = results.filter((one) => accepted.has(one.sensorId));
    assert.equal(answered.length, accepted.size, 'every accepted check is answered');
    assert.equal(new Set(answered.map((one) => one.sensorId)).size, accepted.size, 'once each');
    assert.equal(pool.stats().workerCrashes, 0, 'and no worker was taken in the middle of one');
  });
});
