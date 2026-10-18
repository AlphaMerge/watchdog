import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import {
  CheckPool,
  MEMORY_SHED_MARGIN_WORKERS,
  MemoryCap,
  type MemoryCapReading,
} from '../src/runner/index.js';
import { pollWithin, within } from './support/within.js';

/**
 * A probe whose machine's available memory sits at the pool's reserve (`P-437`), as `ms-server`'s
 * did: 1,992 MiB available against a reserve of 1,984, 40 MiB a worker by the estimate and about
 * 50 by the measure. There, in ten minutes, the pool grew 244 times and shrank 256, and memory held
 * it and let it go 311 times each, a warning at every hold.
 *
 * **The real pool and the real memory source**: `CheckPool` reading `MemoryCap`, whose cgroup
 * reading is the test's. Memory is a closed loop: what is available is what the machine has less
 * 50 MiB for every worker resident, so the pool's own growth is what takes it to the reserve, and
 * a worker it gives back gives back 50 MiB. On top of that, ±10 MiB of noise, new each second.
 *
 * **Ten simulated minutes, and six and a half more.** Each simulated second is a tick of 30 ms:
 * the memory source's clock moves a second, so the cap takes one reading a tick as it takes one a
 * second in a probe, and the wheel's batch arrives, sixteen checks of 8 ms at once, more than
 * memory holds workers for. So the pool always wants more than memory allows, which is the state
 * `ms-server` was in.
 *
 * The phases: settling from the floor; three stretches with memory a few MiB above the reserve,
 * at it and below it; a real fall of four workers' worth, which must still shrink the pool; a
 * recovery, which must still grow it; and, past the ten minutes, a fall that leaves memory between
 * the line a shed comes at and the one growing back does, with noise of ±20 MiB, which must move
 * the pool no more than a few times (`P-437`'s fourth review); then memory with room for more
 * workers than the hold started at, which must end it. Written so that the first ten minutes run
 * against the pool before `P-437` as well, which is where the "before" counts in `TASKS.md` come
 * from.
 *
 * **It measures the gate, at twelve workers, and nothing else.** Sixteen checks on twelve workers
 * is a third of the pool short every second, a burst. Only the memory source's clock is
 * simulated: `GROW_AFTER_MS`, the idle window and a worker's load run on the real one, where
 * 200 ms is about seven simulated seconds and the 60 s idle window half an hour. So the straggler
 * rule is kept out, with a wait of a minute (`check-pool.test.ts` and `pool-memory-cap.test.ts`
 * have it), and idle shrinking is off, which could not have fired inside the run if it were on.
 *
 * **The second arm is idle give-backs** (`P-437`'s second and third reviews), with a real idle
 * window of a second: a hold formed near the line, with the ceiling two workers past it, then
 * quiet and busy in turn. The estimate's error adds up over give-backs. Measured against the size
 * the hold started at alone, enough of them ended the hold, and the next burst grew past it, gave
 * back what it overshot and held at the same size again: a release and a warning every quiet
 * stretch. The arm shows that none ends it now.
 *
 * Both arms charge a worker's whole memory from the moment its thread starts, so neither sees a
 * reading taken while workers load read high; `pool-memory-cap.test.ts` has that.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

/** A 4 GiB ceiling, so the reserve is a quarter of it (`memoryReserveBytes`). */
const TOTAL_BYTES = 4 * GIB;
const RESERVE_MIB = 1_024;
/** What the cap assumes a worker costs, and what one costs here. */
const ESTIMATE_MIB = 40;
const ACTUAL_MIB = 50;
/** The most workers whose memory leaves the reserve free, give or take the phase's offset. */
const SETTLED = 12;
/** Available with nothing resident. */
const BASE_MIB = RESERVE_MIB + SETTLED * ACTUAL_MIB;
const NOISE_MIB = 10;

const TICK_MS = 30;
const BURST = 16;
const CHECK_MS = 8;

interface Phase {
  readonly name: string;
  readonly seconds: number;
  /** Memory taken (negative) or given back by something else on the machine, in MiB. */
  readonly offsetMiB: number;
  /** The noise's amplitude, ± MiB a second: `NOISE_MIB` where it is not given. */
  readonly noiseMiB?: number;
}

const PHASES: readonly Phase[] = [
  { name: 'settling', seconds: 60, offsetMiB: 4 },
  { name: '4 MiB above the reserve', seconds: 150, offsetMiB: 4 },
  { name: 'at the reserve', seconds: 150, offsetMiB: 0 },
  { name: '4 MiB below the reserve', seconds: 90, offsetMiB: -4 },
  { name: 'a real fall, 200 MiB', seconds: 60, offsetMiB: -200 },
  { name: 'recovered', seconds: 90, offsetMiB: 0 },
  // Past the ten minutes, so that their counts compare with the pool before `P-437`. Five minutes
  // in the band between a shed and growing back, as `P-437`'s fourth review measured them: noise
  // twice the rest's.
  { name: 'a fall of 125 MiB, ±20 MiB', seconds: 300, offsetMiB: -125, noiseMiB: 20 },
  // Room for
  // about 28 workers at a burst of 16: a loaded host keeps checks past a tick, and the pool grows
  // for them, which at 400 MiB more reached the memory line at 20 and held there (`P-437`'s
  // second round). That was the host's load, not the gate's, and the ceiling of 24 now keeps the
  // pool under the line whatever the load.
  { name: 'ample, 800 MiB more', seconds: 90, offsetMiB: 800 },
];
/** The phases that make the ten minutes. */
const TEN_MINUTES = 6;

interface Counts {
  grown: number;
  shrunk: number;
  holds: number;
  releases: number;
  warnings: number;
  size: number;
  refused: number;
  /** How long checks waited for a worker, over the last 1,024: the phase's own, at its end. */
  waitP95: number;
  waitMax: number;
}

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

interface Line {
  msg: string;
  level: number;
  [field: string]: unknown;
}

/** The pool's log, kept so a test can count the gate's lines. */
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

/** What the pool reported, for a wait's failure to name its cause: queued, held, busy, grown. */
function stateOf(pool: CheckPool): string {
  const { queued, size, busy, grown, shrunk } = pool.stats();
  return (
    `the pool reported queued ${String(queued)}, held ${String(size)}, busy ${String(busy)}, ` +
    `grown ${String(grown)}, shrunk ${String(shrunk)}`
  );
}

/** Starts a pool within a bound: its workers load in threads, and the test waits on them. */
function started(pool: CheckPool): Promise<void> {
  return within(
    60_000,
    () => `the pool to start; ${String(pool.size)} workers had started`,
    pool.start(),
  );
}

/** The same ±`amplitude` every run: a linear congruential generator, not `Math.random`. */
function noiseOf(amplitude: number): () => number {
  let seed = 0x5eed_1437;
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return (seed / 2 ** 32) * 2 * amplitude - amplitude;
  };
}

describe('scenario: a pool whose memory sits at the reserve (P-437)', () => {
  it(
    'holds there through ten minutes of noise, sheds for a fall, regrows, and lets go with room',
    {
      timeout: 300_000,
    },
    async (t) => {
      const { logger, lines } = recording();
      const noise = noiseOf(NOISE_MIB);
      let simulatedMs = 0;
      let offsetMiB = 0;
      let noiseMiB = 0;
      /** The workers whose memory is in the reading, as the pool counts them when it asks. */
      let resident = 0;
      let lowestAvailableMiB = Infinity;
      const inner = new MemoryCap({
        perWorkerMiB: ESTIMATE_MIB,
        sources: {
          limit: () => {
            const availableMiB = BASE_MIB + offsetMiB + noiseMiB - resident * ACTUAL_MIB;
            lowestAvailableMiB = Math.min(lowestAvailableMiB, availableMiB);
            return { availableBytes: availableMiB * MIB, totalBytes: TOTAL_BYTES };
          },
          machine: () => null,
          now: () => simulatedMs,
        },
      });
      const memoryCap = {
        read: (held: number, loading: number): MemoryCapReading | undefined => {
          resident = held;
          return inner.read(held, loading);
        },
      };
      let answered = 0;
      const pool = new CheckPool({
        logger,
        // Past the burst, and under the line memory sets in the ample phase, so that phase cannot
        // hold. At 64 a loaded host's checks kept past a tick grew the pool to that line, 28, and it
        // held there, twice at a load of 30–40 (`P-437`'s third review): the host's load, not the
        // gate's. Memory binds at twelve everywhere else, so nothing before it sees the ceiling.
        size: 24,
        minSize: 2,
        // Off, so that every grow and shrink counted below is the gate's or a burst's.
        idleShrinkMs: 0,
        // A minute, so that no straggler grows the pool: with sixteen workers in the last phase,
        // a check a loaded host keeps past the next 30 ms tick leaves one behind it, and growing
        // for it after a real 200 ms, seven simulated seconds, would be the host's load and not
        // the gate's (`check-pool.test.ts` has the rule).
        growAfterMs: 60_000,
        queueMaxLength: 1_000,
        registryModule: FIXTURES,
        memoryCap,
        onResult: () => {
          answered += 1;
        },
      });
      pools.push(pool);
      await started(pool);

      const counted = (prefixes: readonly string[]): number =>
        lines.filter((line) => prefixes.some((prefix) => line.msg.startsWith(prefix))).length;
      const counts = (): Counts => {
        const stats = pool.stats();
        return {
          grown: stats.grown,
          shrunk: stats.shrunk,
          holds: counted(['memory is holding the check pool back']),
          // The release's words before `P-437`, when it came with an emptied queue, and since.
          releases: counted([
            'nothing is waiting for a worker; memory is no longer holding',
            'memory has room for more workers again',
          ]),
          warnings: lines.filter((line) => line.level === 40).length,
          size: stats.size,
          refused: stats.refused,
          waitP95: stats.waitMs.p95,
          waitMax: stats.waitMs.max,
        };
      };

      let accepted = 0;
      let sensor = 0;
      const byPhase = new Map<string, Counts>();
      let before = counts();
      let tenMinutes: Counts | undefined;
      for (const [index, phase] of PHASES.entries()) {
        offsetMiB = phase.offsetMiB;
        for (let second = 0; second < phase.seconds; second += 1) {
          simulatedMs += 1_000;
          // The same sequence at every amplitude, scaled: ±10 MiB is the generator's own.
          noiseMiB = (noise() * (phase.noiseMiB ?? NOISE_MIB)) / NOISE_MIB;
          for (let i = 0; i < BURST; i += 1) {
            sensor += 1;
            const outcome = pool.submit({
              sensorId: sensor,
              sensorType: 'test.slow',
              target: { host: '192.0.2.1', ipVersion: 'auto' as const },
              params: { delayMs: CHECK_MS },
              timeoutMs: 10_000,
            });
            if (outcome === 'accepted') accepted += 1;
          }
          await sleep(TICK_MS);
        }
        const now = counts();
        const delta: Counts = {
          grown: now.grown - before.grown,
          shrunk: now.shrunk - before.shrunk,
          holds: now.holds - before.holds,
          releases: now.releases - before.releases,
          warnings: now.warnings - before.warnings,
          size: now.size,
          refused: now.refused - before.refused,
          waitP95: now.waitP95,
          waitMax: now.waitMax,
        };
        byPhase.set(phase.name, delta);
        t.diagnostic(
          `${phase.name.padEnd(26)} grown ${String(delta.grown).padStart(3)}  shrunk ` +
            `${String(delta.shrunk).padStart(3)}  holds ${String(delta.holds).padStart(3)}  ` +
            `releases ${String(delta.releases).padStart(3)}  warnings ` +
            `${String(delta.warnings).padStart(3)}  refused ${String(delta.refused).padStart(4)}  ` +
            `size at the end ${String(delta.size).padStart(2)}  wait p95 ` +
            `${delta.waitP95.toFixed(1)} ms, max ${delta.waitMax.toFixed(1)} ms`,
        );
        before = now;
        if (index === TEN_MINUTES - 1) tenMinutes = now;
      }
      const total = counts();
      assert.ok(tenMinutes !== undefined);
      t.diagnostic(
        `ten simulated minutes: grown ${String(tenMinutes.grown)}, shrunk ` +
          `${String(tenMinutes.shrunk)}, holds ${String(tenMinutes.holds)}, releases ` +
          `${String(tenMinutes.releases)}, warnings ${String(tenMinutes.warnings)}, refused ` +
          String(tenMinutes.refused),
      );
      t.diagnostic(
        `and the six and a half minutes past them: grown ${String(total.grown)}, shrunk ` +
          `${String(total.shrunk)}, holds ${String(total.holds)}, releases ` +
          `${String(total.releases)}, warnings ${String(total.warnings)}; lowest available ` +
          `${lowestAvailableMiB.toFixed(0)} MiB against a reserve of ${String(RESERVE_MIB)}`,
      );

      // **At the reserve, a few MiB either side, nothing moves**: 390 simulated seconds of noise
      // that before `P-437` took the pool under the line about every other reading.
      for (const name of ['4 MiB above the reserve', 'at the reserve', '4 MiB below the reserve']) {
        const phase = byPhase.get(name);
        assert.ok(phase !== undefined);
        assert.deepEqual(
          {
            grown: phase.grown,
            shrunk: phase.shrunk,
            holds: phase.holds,
            releases: phase.releases,
          },
          { grown: 0, shrunk: 0, holds: 0, releases: 0 },
          `${name}: the pool held its size, and said nothing`,
        );
        assert.equal(phase.size, SETTLED, `${name}: at the size memory holds`);
      }

      // **A real fall still sheds**: four workers' worth taken by something else, and the pool
      // gives back at least four, without a hold or a release of its own, since it was holding.
      const fall = byPhase.get('a real fall, 200 MiB');
      assert.ok(fall !== undefined);
      assert.ok(fall.shrunk >= 4, `the fall shed ${String(fall.shrunk)} workers`);
      assert.ok(fall.size <= SETTLED - 4, `and left ${String(fall.size)} of ${String(SETTLED)}`);
      // At most the one its own overshoot gave up: the shed counts a worker at the estimate's
      // 40 MiB and each frees 50, so it can give back one more than memory needs, and memory can
      // then have room for that one and the shed margin past it, inside the hold.
      assert.ok(fall.grown <= 1, `and grew ${String(fall.grown)} back while memory was short`);
      assert.deepEqual({ holds: fall.holds, releases: fall.releases }, { holds: 0, releases: 0 });

      // **A real recovery still grows**, back towards the size the hold started at as far as
      // memory has room, and that is no release: the hold never ended, so neither a release nor a
      // hold. Past where the fall's shed left it, growing needs room for each worker and the shed
      // margin (`P-437`'s fourth review). Memory reads more room the fewer workers it counts, a
      // quarter of a worker each, so from seven, where the fall left it, there was room for twelve
      // and the margin; from a worker or two more it can stop a margin short of twelve, where
      // memory has room for twelve and no more.
      const recovered = byPhase.get('recovered');
      assert.ok(recovered !== undefined);
      assert.ok(
        recovered.size >= SETTLED - MEMORY_SHED_MARGIN_WORKERS && recovered.size <= SETTLED,
        `back at ${String(recovered.size)}, to within a shed margin of ${String(SETTLED)}`,
      );
      assert.ok(
        recovered.grown >= recovered.size - fall.size,
        `the recovery grew ${String(recovered.grown)} workers, from ${String(fall.size)}`,
      );
      assert.deepEqual(
        { holds: recovered.holds, releases: recovered.releases },
        { holds: 0, releases: 0 },
        'the recovery grew inside the hold',
      );

      // **A fall inside the band between a shed and growing back moves the pool a few times, not
      // every few seconds** (`P-437`'s fourth review). A worker went back once a reading was a shed
      // margin under room for the pool, and grew back with room for one: 30 MiB apart, at 40 MiB a
      // worker by the estimate and 50 by the measure, and noise of ±20 moved it both ways, 21 grows
      // and 23 shrinks in these five minutes. Past where a shed left it, growing back needs room for
      // the worker and the shed margin, 70 MiB apart: it sheds to where memory holds, and stays.
      const band = byPhase.get('a fall of 125 MiB, ±20 MiB');
      assert.ok(band !== undefined);
      assert.ok(band.shrunk >= 1, `the fall shed ${String(band.shrunk)} workers`);
      assert.ok(
        band.grown + band.shrunk <= 4,
        `and the pool moved ${String(band.grown + band.shrunk)} times in five minutes, ` +
          `${String(band.grown)} of them grows`,
      );
      assert.deepEqual({ holds: band.holds, releases: band.releases }, { holds: 0, releases: 0 });

      // **Room past the size the hold started at ends it**: one release, the pool grows to the
      // burst with no hold, since memory has room for it, and checks stop waiting for a worker.
      const ample = byPhase.get('ample, 800 MiB more');
      const atTheReserve = byPhase.get('at the reserve');
      assert.ok(ample !== undefined && atTheReserve !== undefined);
      assert.deepEqual(
        { holds: ample.holds, releases: ample.releases },
        { holds: 0, releases: 1 },
        'one release, and no hold after it',
      );
      // At least the burst, less the one check a straggler rule leaves to a worker coming free:
      // past a pool of ten a straggler under a tenth of it waits for its minute here, and only the
      // check that makes it a burst grows for it, so from nine, where the fall in the band left it,
      // the pool grew to fifteen and the sixteenth check waits for one of them; from twelve it grew
      // to sixteen. More where a loaded host keeps two checks past the next tick, which is a burst
      // at sixteen workers, and memory now has room for it.
      assert.ok(
        ample.size >= BURST - 1,
        `${String(ample.size)} workers for a burst of ${String(BURST)}`,
      );
      // What a hold costs, and it is visible: the pool's `waitMs`, Probe Health's `queueWaitMs`.
      // Held a third short of the burst, a quarter of every second's checks wait for a busy worker
      // to finish one, so the phase's p95 is at least most of a check. A floor in the same phase,
      // not a comparison with ample's, which ran later under whatever load it met (`P-437`'s
      // second review): that one is printed above.
      assert.ok(
        atTheReserve.waitP95 >= CHECK_MS / 2,
        `wait p95 ${String(atTheReserve.waitP95)} ms held, against checks of ${String(CHECK_MS)}`,
      );

      // **One hold and one release in sixteen and a half minutes**: the first hold, at settling,
      // and the release once memory had room past it.
      assert.equal(tenMinutes.holds, 1, 'a hold when the pool first reached the reserve');
      assert.equal(tenMinutes.releases, 0);
      assert.equal(total.holds, 1);
      assert.equal(total.releases, 1);
      assert.equal(total.warnings, total.holds, 'and a warning only for each hold');
      // A bounded number of grows: the ramp from the floor and the recovery's, with the estimate's
      // overshoot given back once each. Before `P-437` this run grew and shrank in the hundreds.
      assert.ok(tenMinutes.grown <= 30, `grown ${String(tenMinutes.grown)} in ten minutes`);
      assert.ok(tenMinutes.shrunk <= 15, `shrunk ${String(tenMinutes.shrunk)} in ten minutes`);

      // And every accepted check is answered.
      await pollWithin(
        30_000,
        () =>
          `every accepted check answered; ${String(answered)} of ${String(accepted)}; ` +
          stateOf(pool),
        () => answered === accepted,
      );
    },
  );
});

/**
 * The idle arm's memory: a hold near the line, at eight workers with 15 MiB spare above the
 * reserve, and ±5 MiB of noise, so that every reading's whole number of workers is the same.
 */
const IDLE_BASE_MIB = RESERVE_MIB + 8 * ACTUAL_MIB + 15;
const IDLE_NOISE_MIB = 5;
const IDLE_MIN_SIZE = 1;
/** Two past the size the hold starts at: `P-437`'s third review's case, `ms-server`'s 62 and 64. */
const IDLE_MAX_SIZE = 10;

describe('scenario: a hold near the line, and the idle give-backs after it (P-437)', () => {
  it(
    'holds through idle give-backs, and grows back to the size it held at with nothing said',
    {
      timeout: 180_000,
    },
    async (t) => {
      // **The estimate's error adds up over give-backs** (`P-437`'s second and third reviews). A
      // worker given back frees 50 MiB and the cap counts 40, so after k of them a reading has room
      // for `(s + 10k) / 40` workers past the size the hold started at, where s is the spare at the
      // hold. Measured against that size alone, the hold ended once s + 10k ≥ 80: here, with s at
      // 15, at the seventh. The next burst then wanted ten, which memory read as room for, so it
      // grew there with no hold, gave two back for memory once they loaded, and held at eight
      // again with a second warning, and so on every quiet stretch. Now each worker the pool is
      // short of eight counts against the room, so no number of give-backs ends the hold, and the
      // pool grows back to eight inside it.
      const { logger, lines } = recording();
      const noise = noiseOf(IDLE_NOISE_MIB);
      let simulatedMs = 0;
      let noiseMiB = 0;
      let resident = 0;
      const inner = new MemoryCap({
        perWorkerMiB: ESTIMATE_MIB,
        sources: {
          limit: () => ({
            availableBytes: (IDLE_BASE_MIB + noiseMiB - resident * ACTUAL_MIB) * MIB,
            totalBytes: TOTAL_BYTES,
          }),
          machine: () => null,
          now: () => simulatedMs,
        },
      });
      let answered = 0;
      let accepted = 0;
      const pool = new CheckPool({
        logger,
        size: IDLE_MAX_SIZE,
        minSize: IDLE_MIN_SIZE,
        // A real second: every busy tick uses every worker, so only a quiet stretch gives any back.
        idleShrinkMs: 1_000,
        // A minute, as in the first arm: every growth here is a burst's.
        growAfterMs: 60_000,
        queueMaxLength: 1_000,
        registryModule: FIXTURES,
        memoryCap: {
          read: (held: number, loading: number): MemoryCapReading | undefined => {
            resident = held;
            return inner.read(held, loading);
          },
        },
        onResult: () => {
          answered += 1;
        },
      });
      pools.push(pool);
      await started(pool);

      let sensor = 0;
      /** A simulated second's burst, answered in full before the next, so nothing races a tick. */
      const tick = async (burst: number): Promise<void> => {
        simulatedMs += 1_000;
        noiseMiB = noise();
        for (let i = 0; i < burst; i += 1) {
          sensor += 1;
          const outcome = pool.submit({
            sensorId: sensor,
            sensorType: 'test.slow',
            target: { host: '192.0.2.1', ipVersion: 'auto' as const },
            params: { delayMs: CHECK_MS },
            timeoutMs: 10_000,
          });
          if (outcome === 'accepted') accepted += 1;
        }
        await pollWithin(
          10_000,
          () =>
            `the tick's checks answered; ${String(answered)} of ${String(accepted)}; ` +
            stateOf(pool),
          () => answered === accepted,
          2,
        );
        await sleep(TICK_MS);
      };
      /**
       * Simulated seconds with nothing submitted, until the pool is at its floor and an idle window
       * more, so that the last worker given back has exited. Nothing here calls `stats()`, so a
       * release can come only where a given-back worker's exit looks.
       */
      const quiet = async (): Promise<void> => {
        const bound = Date.now() + 30_000;
        let floorAt: number | undefined;
        while (Date.now() < bound) {
          if (floorAt === undefined && pool.size <= IDLE_MIN_SIZE) floorAt = Date.now();
          if (floorAt !== undefined && Date.now() - floorAt >= 1_500) break;
          simulatedMs += 1_000;
          noiseMiB = noise();
          await sleep(TICK_MS);
        }
        // `stateOf` reads the gate, so only where the stretch failed.
        if (pool.size !== IDLE_MIN_SIZE) {
          assert.fail(
            `the quiet stretch left ${String(pool.size)} workers, not its floor of ` +
              `${String(IDLE_MIN_SIZE)}; ${stateOf(pool)}`,
          );
        }
      };

      interface Stretch {
        grown: number;
        idle: number;
        overMemory: number;
        holds: number;
        releases: number;
        size: number;
        /** The idle give-backs logged before the release, where there was one. */
        givenBackFirst: number | undefined;
      }
      const shrinking = (line: Line, field: string): boolean =>
        line.msg.startsWith('shrinking the check pool') && field in line;
      const stretch = async (name: string, run: () => Promise<void>): Promise<Stretch> => {
        const from = lines.length;
        const grownBefore = pool.stats().grown;
        await run();
        // Read before the lines are, since `stats()` looks at the gate: a release it makes is this
        // stretch's.
        const grownAfter = pool.stats().grown;
        const own = lines.slice(from);
        const release = own.findIndex((line) =>
          line.msg.startsWith('memory has room for more workers again'),
        );
        const result: Stretch = {
          grown: grownAfter - grownBefore,
          idle: own.filter((line) => shrinking(line, 'idleForMs')).length,
          overMemory: own.filter((line) => shrinking(line, 'overMemory')).length,
          holds: own.filter((line) => line.msg.startsWith('memory is holding the check pool back'))
            .length,
          releases: own.filter((line) => line.msg.startsWith('memory has room for more workers'))
            .length,
          size: pool.size,
          givenBackFirst:
            release < 0
              ? undefined
              : own.slice(0, release).filter((line) => shrinking(line, 'idleForMs')).length,
        };
        t.diagnostic(
          `${name.padEnd(22)} grown ${String(result.grown).padStart(2)}  given back idle ` +
            `${String(result.idle)}  shed for memory ${String(result.overMemory)}  holds ` +
            `${String(result.holds)}  releases ${String(result.releases)}` +
            (result.givenBackFirst === undefined
              ? ''
              : `, after ${String(result.givenBackFirst)} give-backs`) +
            `  size at the end ${String(result.size)}`,
        );
        return result;
      };

      const holdsSoFar = (): number =>
        lines.filter((line) => line.msg.startsWith('memory is holding the check pool back')).length;

      // Bursts one larger each second, so the pool grows a worker at a time to where memory
      // stops it: room for nine at eight workers is eight, so the burst of nine holds there.
      const ramp = await stretch('ramp', async () => {
        for (let burst = IDLE_MIN_SIZE; burst <= 9; burst += 1) await tick(burst);
      });
      const held = await stretch('held, bursts of ten', async () => {
        for (let second = 0; second < 30; second += 1) await tick(10);
      });
      const firstQuiet = await stretch('quiet', quiet);
      const busyAgain = await stretch('busy again', async () => {
        for (let second = 0; second < 30; second += 1) await tick(10);
      });
      const secondQuiet = await stretch('quiet again', quiet);
      const busyThird = await stretch('busy a third time', async () => {
        for (let second = 0; second < 30; second += 1) await tick(10);
      });

      assert.equal(ramp.holds, 1, 'the ramp held where memory stopped it');
      assert.equal(ramp.size, 8);
      assert.deepEqual(
        { grown: held.grown, idle: held.idle, overMemory: held.overMemory, holds: held.holds },
        { grown: 0, idle: 0, overMemory: 0, holds: 0 },
        'held, nothing moves',
      );
      assert.equal(held.size, 8, 'at the size the hold started at');

      // **No number of give-backs ends the hold**: seven each time, to the floor, past the seven
      // that ended it measured against the size it held at alone.
      for (const [name, stretched] of [
        ['quiet', firstQuiet],
        ['quiet again', secondQuiet],
      ] as const) {
        assert.equal(stretched.idle, 7, `${name}: given back to the floor`);
        assert.equal(stretched.releases, 0, `${name}: and the hold went on`);
      }

      // **And each burst after grows back to the size it held at, inside the hold**: no release,
      // no hold, nothing given back for memory. Seven grown, and one more for each worker given
      // back as idle on the way: at a load of 36 a worker sat a second idle while a tick's checks
      // were slow to finish, and was bought back at the next.
      for (const [name, stretched] of [
        ['busy again', busyAgain],
        ['busy a third time', busyThird],
      ] as const) {
        assert.deepEqual(
          {
            grownBack: stretched.grown - stretched.idle,
            holds: stretched.holds,
            releases: stretched.releases,
            overMemory: stretched.overMemory,
            size: stretched.size,
          },
          { grownBack: 7, holds: 0, releases: 0, overMemory: 0, size: 8 },
          `${name}: back to eight inside the hold, and nothing said`,
        );
      }
      assert.equal(holdsSoFar(), 1, 'one hold in all');
      assert.equal(lines.filter((line) => line.level === 40).length, 1, 'and one warning, for it');
    },
  );
});

describe('scenario: stragglers the pool no longer grows for (P-437)', () => {
  it(
    'runs each burst’s straggler on a worker that came free, where the old rule grew one',
    {
      timeout: 120_000,
    },
    async (t) => {
      // **The alarm this could multiply is `poolUsage`**, busy over held at the heartbeat, which
      // warns at 80%. Its share is measured in `test/perf/pool-stragglers.test.ts`, where the
      // host's load is a condition of the run and not a failure. What it rests on is asserted
      // here: thirteen checks a burst behind twelve workers, finishing 20–80 ms in, and each burst
      // answered in full before the next, so nothing races a period. A pool that grows for the
      // thirteenth on sight, as before, buys a worker on the first burst; the shipped rule, with a
      // wait far past the slowest check, buys none.
      const BURSTS = 10;
      const arm = async (growAfterMs: number) => {
        let answered = 0;
        const pool = new CheckPool({
          logger: pino({ level: 'silent' }),
          size: 20,
          minSize: 12,
          growAfterMs,
          registryModule: FIXTURES,
          onResult: () => {
            answered += 1;
          },
        });
        pools.push(pool);
        await started(pool);
        const grownBy: number[] = [];
        let sensor = 0;
        for (let burst = 1; burst <= BURSTS; burst += 1) {
          const before = pool.stats().grown;
          for (let i = 0; i < 13; i += 1) {
            sensor += 1;
            pool.submit({
              sensorId: sensor,
              sensorType: 'test.slow',
              target: { host: '192.0.2.1', ipVersion: 'auto' as const },
              params: { delayMs: 20 + 5 * i },
              timeoutMs: 10_000,
            });
          }
          await pollWithin(
            10_000,
            () =>
              `burst ${String(burst)} answered; ${String(answered)} of ` +
              `${String(13 * burst)}; ${stateOf(pool)}`,
            () => answered === 13 * burst,
            5,
          );
          grownBy.push(pool.stats().grown - before);
        }
        const { size } = pool.stats();
        await within(30_000, 'the pool to stop', pool.stop());
        return { grownBy, size };
      };
      const grew = await arm(0);
      // Two seconds against checks of 20–80 ms: only a worker coming free takes the straggler.
      const waited = await arm(2_000);
      t.diagnostic(
        `grown on sight: ${grew.grownBy.join(' ')} by burst, ${String(grew.size)} workers; ` +
          `waited: ${waited.grownBy.join(' ')}, ${String(waited.size)} workers`,
      );
      assert.deepEqual(
        grew.grownBy,
        [1, ...Array<number>(BURSTS - 1).fill(0)],
        'the old rule grew a worker for the first burst’s thirteenth check, and had it after',
      );
      assert.equal(grew.size, 13);
      assert.deepEqual(waited.grownBy, Array<number>(BURSTS).fill(0), 'the shipped one grew none');
      assert.equal(waited.size, 12);
    },
  );
});
