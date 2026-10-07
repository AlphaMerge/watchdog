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
  MemoryCap,
  workersMemoryAllows,
  type MemoryCapReading,
} from '../src/runner/index.js';
import { WORKER_RESIDENT_MIB } from '../src/measured.js';

// `P-236`: the pool's ceiling, bounded by the memory the probe may use.
// `docs/findings/2026-09-29-probe-starvation-b.md` is why.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/pool-memory-cap.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

/** Waits for a condition, or fails the test rather than hanging the suite. */
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const request = (sensorId: number, delayMs: number, timeoutMs = 90_000) => ({
  sensorId,
  sensorType: 'test.slow',
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: { delayMs },
  timeoutMs,
});

/** A cap that says whatever the test says, as `MemoryCap.read` would. */
function fixedCap(workers: () => number | undefined): {
  read: (held: number) => MemoryCapReading | undefined;
} {
  return {
    read: () => {
      const allowed = workers();
      if (allowed === undefined) return undefined;
      return {
        workers: allowed,
        availableBytes: 512 * MIB,
        totalBytes: 4 * GIB,
        reserveBytes: memoryReserveBytes(4 * GIB),
        perWorkerBytes: WORKER_RESIDENT_MIB * MIB,
        source: 'limit',
      };
    },
  };
}

/** A logger whose warnings a test can count. */
function recording(): { logger: Logger; lines: { msg: string; level: number }[] } {
  const lines: { msg: string; level: number }[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as { msg: string; level: number });
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

  // `P-244`: where a saturated pool settles is where the cap stops, which must be under the 80%
  // `memoryLimitUsage` warns at, and leave the machine above the 20% `memoryAvailable` warns at.
  for (const totalMiB of [1_024, 2_048, 4_096, 6_144, 8_192, 12_288, 16_384, 65_536]) {
    it(`stops a saturated pool under both warnings at a ${String(totalMiB)} MiB ceiling`, () => {
      const total = totalMiB * MIB;
      // The pool grows while a worker's worth is spare above the reserve, so it stops with less
      // than that left: the most it can use is the ceiling less the reserve.
      const settledPercent = ((total - memoryReserveBytes(total)) / total) * 100;
      assert.ok(settledPercent < 80, `${String(settledPercent)}% of the ceiling`);
      assert.ok(100 - settledPercent > 20);
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
    await pool.start();
    for (let id = 1; id <= 30; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().size === 5, 'the pool to grow to what memory allows');
    // A worker that has started has not necessarily taken a check yet, and until it has, the
    // queue still holds that check: wait for the state, not for time (`P-234`). Under load the
    // queue read 26–28 after a fixed 300 ms.
    await until(() => pool.stats().busy === 5, 'every worker to take a check');
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
    await pool.start();
    for (let id = 1; id <= 10; id += 1) pool.submit(request(id, 60_000));
    await sleep(300);
    assert.equal(pool.stats().size, 3);
    assert.equal(pool.stats().ceiling, 3);
    assert.equal(pool.stats().memoryCap, 0);
    assert.equal(pool.stats().heldBack, 7);
  });

  it('gives workers back as they come free when memory falls, never one in a check', async () => {
    let allowed = 8;
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
    await pool.start();
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
    await until(() => pool.stats().size === 8, 'the pool to grow to 8');
    allowed = 3;
    const deadline = Date.now() + 10_000;
    while (pool.stats().size > 3) {
      if (Date.now() > deadline) throw new Error('the pool never gave the memory back');
      feed();
      await sleep(20);
    }
    // And stops there, rather than giving up more while the first ones are still exiting: their
    // memory is on its way back, and counting it as still taken would shed the pool to its floor.
    for (let round = 0; round < 15; round += 1) {
      feed();
      await sleep(20);
      assert.equal(pool.stats().size, 3, 'not below what memory allows');
    }
    assert.equal(pool.stats().ceiling, 3);
    assert.equal(pool.stats().heldBack, 5);
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
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => allowed),
      onResult: () => {
        done += 1;
      },
    });
    pools.push(pool);
    await pool.start();
    for (let id = 1; id <= 16; id += 1) pool.submit(request(id, 100));
    await until(() => done === 16, 'the pool to grow to 8 and go quiet');
    assert.equal(pool.stats().size, 8);
    for (let id = 101; id <= 108; id += 1) pool.submit(request(id, 400));
    await until(() => pool.stats().busy === 8, 'all eight to be running');
    allowed = 3;
    await until(() => done === 24, 'all eight to finish');
    await sleep(200);
    assert.equal(pool.stats().size, 3, 'what memory allows, not the floor');
  });

  it('grows past memory on an explicit size, and reports it rather than enforcing it', async () => {
    const { logger, lines } = recording();
    const pool = new CheckPool({
      logger,
      size: 6,
      minSize: 1,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 2),
      enforceMemoryCap: false,
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    for (let id = 1; id <= 10; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().size === 6, 'the pool to grow to the configured size');
    const stats = pool.stats();
    assert.equal(stats.ceiling, 6);
    assert.equal(stats.memoryCap, 2);
    assert.equal(stats.heldBack, 0);
    assert.equal(
      lines.filter((line) => line.msg.startsWith('workerPoolSize allows more workers')).length,
      1,
    );
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
    await pool.start();
    for (let id = 1; id <= 6; id += 1) pool.submit(request(id, 60_000));
    await until(() => pool.stats().size === 4, 'the pool to grow to its ceiling');
    const stats = pool.stats();
    assert.equal(stats.ceiling, 4);
    assert.equal('memoryCap' in stats, false, 'a gap, not a cap of nothing');
    assert.equal(stats.heldBack, 0);
  });

  it('says memory is holding it back once per episode, not once per check', async () => {
    const { logger, lines } = recording();
    const pool = new CheckPool({
      logger,
      size: 10,
      minSize: 1,
      queueMaxLength: 200,
      registryModule: FIXTURES,
      memoryCap: fixedCap(() => 2),
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    const holding = (): number =>
      lines.filter((line) => line.msg.startsWith('memory is holding the check pool back')).length;
    // Two bursts, each far past what memory allows, with the queue emptied in between.
    for (let id = 1; id <= 100; id += 1) pool.submit(request(id, 30));
    await until(() => pool.stats().queued === 0 && pool.stats().busy === 0, 'the first burst');
    for (let id = 101; id <= 200; id += 1) pool.submit(request(id, 30));
    await until(() => pool.stats().queued === 0 && pool.stats().busy === 0, 'the second burst');
    assert.equal(holding(), 2, 'one line for each episode');
    assert.ok(
      lines.some((line) => line.msg.startsWith('nothing is waiting for a worker')),
      'and one when it ends',
    );
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
        read: (held) => {
          asked.push(held);
          return inner.read(held);
        },
      },
      onResult: () => undefined,
    });
    pools.push(pool);
    try {
      await pool.start();
      pool.submit({
        sensorId: 1,
        sensorType: 'test.block',
        target: { host: '192.0.2.1', ipVersion: 'auto' as const },
        params: { delayMs: 5_000, marker: unblocked },
        timeoutMs: 100,
      });
      await until(() => pool.stats().size === 1, 'the blocked worker taken out', 20_000);

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
        'the thread unblocked and the replacement started',
        60_000,
      );
      asked.length = 0;
      pool.stats();
      assert.deepEqual([...asked], [2], 'the exited worker is no longer counted');
    } finally {
      await pool.stop();
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
    await pool.start();

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
