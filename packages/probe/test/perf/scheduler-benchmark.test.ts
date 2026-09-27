import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { CheckPool, defaultPoolSize } from '../../src/runner/pool.js';
import { phaseFor, TimingWheel } from '../../src/scheduler/wheel.js';
import {
  DISPATCH_BUDGET_MS,
  ICMP_PING_CHECK_MS,
  MODEL_CHECK_MS,
  V1_TARGET_INTERVAL_SECONDS,
  V1_TARGET_SENSORS,
} from '../../src/measured.js';

/**
 * The architecture go/no-go gate (`P-15`).
 *
 * `PLAN.md` Phase 2's exit criterion, and `CLAUDE.md`'s instruction not to build Phase 3 on an
 * unmeasured scheduler: **5,000 sensors at 60 s on 8 cores, p95 dispatch jitter under 1 s,
 * sustained**. `WORKFLOW.MD §3` states the same constraint in the form that matters to an
 * operator — "a 60-second sensor must fire every 60 seconds ±1 s under full load".
 *
 * **Dispatch jitter is measured end to end**, from the instant a sensor was *due* to the instant
 * its check actually began running in a worker. Two things contribute and both are real:
 *
 *   - the wheel firing its tick late, and
 *   - the check waiting for a free worker once it was submitted.
 *
 * Measuring only the first would be measuring a `setTimeout`, which is not what the criterion is
 * about: a sensor whose check sat in a queue for four seconds fired four seconds late, whatever
 * the wheel did. The two are also reported separately, because they have completely different
 * fixes — one is a timer problem and the other is a pool-sizing problem.
 *
 * **The checks sleep rather than burn CPU**, because that is what a real check does. ICMP, SNMP
 * and HTTP checks spend nearly all of their time waiting for a packet, and a worker holding a
 * slot while it waits is the actual constraint on this system — not arithmetic. A CPU-burning
 * check would model nothing that exists and would make the pool look CPU-bound when it is not.
 *
 * Runs a short soak by default so it can live in the suite. `MS_BENCH_MINUTES=60` runs the
 * criterion's full hour; the committed measurement below was taken that way.
 */

const silent = pino({ level: 'silent' });
const FIXTURES = fileURLToPath(new URL('../support/check-fixtures.js', import.meta.url));

/**
 * The criterion, verbatim — and taken from `measured.ts` rather than retyped (`P-35`).
 *
 * This file is why that module exists. It held its own copy of what an `icmp.ping` costs, `P-07`
 * changed the measurement, and the copy went on describing a check nobody ran for a week
 * (`P-31`).
 */
const SENSORS = V1_TARGET_SENSORS;
const INTERVAL_SECONDS = V1_TARGET_INTERVAL_SECONDS;
const P95_BUDGET_MS = DISPATCH_BUDGET_MS;
const REQUIRED_CORES = 8;

/**
 * How long a modelled check takes.
 *
 * 200 ms is an ordinary SNMP round trip on a LAN and a fast HTTP check. It is also the number
 * that decides everything else: 5,000 sensors on a 60-second interval is 83 checks a second, so
 * 83 × 0.2 = **17 checks in flight at any moment**. A pool smaller than that cannot keep up, no
 * matter how precise the wheel is.
 *
 * **The model, deliberately not the shipped type.** `ICMP_PING_CHECK_MS` is what `icmp.ping`
 * actually costs; conflating the two is what `P-31` was.
 */
const CHECK_MS = MODEL_CHECK_MS;

const minutes = Number(process.env['MS_BENCH_MINUTES'] ?? '1.5');
const durationMs = minutes * 60_000;

/**
 * The pool the `icmp.ping`-shaped case asks for, and what it costs to hold (`P-30`).
 *
 * **Declared because the alternative is a signal instead of a test result.** On 2026-09-03 the
 * kernel killed this process at 84 s of a 90 s run on a machine with 2,643 MB available:
 * `NODE_EXIT=137`, no assertion, no stack, and `node:test` reporting the whole *file* as failed
 * with a bare `'test failed'` while every test inside it had passed. It took the `after` hook
 * with it too, so the runs that had already met `P-15`'s gate could not print their numbers.
 *
 * **Two measured points bracket the requirement**, and the threshold sits between them on the
 * safe side: killed with **2,643 MB** available, and ran to completion with **4,262 MB**, at a
 * peak RSS of **2,801 MB**. The headroom over that peak is not decoration — RSS climbs across
 * the run, and the kill came while 2.6 GB was still nominally free, because the killer does not
 * wait for the last page. Erring high costs a skip that prints why; erring low costs every other
 * result in the file.
 */
/**
 * What one `icmp.ping` check costs a worker, measured after `P-07`.
 *
 * `-i 0.2` turns the three-second check this file was originally written against into a
 * six-hundred-millisecond one, with identical reply counts
 * (`docs/findings/2026-08-29-icmp-throughput.md`). 83 a second at 0.6 s is 50 in flight, which
 * the shipped ceiling of 48 very nearly absorbs in one round — so this is the number that
 * decides whether the type we ship fits the pool we ship, and the old 3,000 answered a question
 * about a version of `ping` we stopped invoking.
 */
const ICMP_CHECK_MS = ICMP_PING_CHECK_MS;

const ICMP_POOL_SIZE = 256;
const ICMP_PEAK_MB = 2_801;
const ICMP_NEEDS_MB = 4_000;

/**
 * What this machine could still hand out, in MB.
 *
 * `MemAvailable` is the kernel's own estimate of what a new allocation would actually get, which
 * is the question being asked; `MemFree` excludes reclaimable page cache and understates it by
 * gigabytes on any machine that has been doing work. Read directly rather than through
 * `os.freemem()`: libuv 1.45 and later do return `MemAvailable` there (measured on Node 24, libuv
 * 1.52: 6,094 MiB against `MemAvailable`'s 6,096 and `MemFree`'s 1,485), but fall back to `MemFree`
 * without saying so on a kernel that lacks it. Falls back to `freemem()` where there is no Linux
 * `/proc` to read. Probe Health's own reading is `readMachineMemory` in `@ms/shared` (`P-208`).
 */
function availableMemoryMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    const kb = match?.[1];
    if (kb !== undefined) return Number(kb) / 1024;
  } catch {
    // No /proc, or not a Linux one. `freemem()` is the portable answer.
  }
  return freemem() / (1024 * 1024);
}

interface Sample {
  /** Due → check started, in milliseconds. The criterion's number. */
  jitterMs: number;
  /** The wheel's own contribution: due → the tick that dispatched it. */
  wheelMs: number;
  /** The pool's: submitted → a worker picked it up. */
  waitMs: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Number((sorted[index] ?? 0).toFixed(1));
}

interface Run {
  label: string;
  checkMs: number;
  poolSize: number;
  /** Workers the pool started with, which `rssMb` is the cost of. */
  startSize: number;
  /** Workers it was holding when the run ended — not the same as `poolSize` since `P-18`. */
  finalSize: number;
  grown: number;
  /**
   * Resident memory the pool cost at *start-up*, in MB.
   *
   * Worker threads share the process's RSS, so the difference across `pool.start()` is what the
   * workers it started cost — and it is the other half of the sizing decision. Jitter says how
   * many slots the workload wants; this says what they are worth paying.
   *
   * **Since `P-18` this is what the pool *started* with, and `finalSize` says whether it stayed
   * there.** A figure taken at the end of a run would be the honest one to compare — except
   * that these runs share a process, so the previous soak's 500 MB being reclaimed lands in the
   * next one's delta and produces numbers like `-275 MB`. Measured at start-up it is clean, and
   * for the case this matters in — a small installation, where the pool never grows — start-up
   * is the whole cost.
   */
  rssMb: number;
  dispatched: number;
  completed: number;
  deferred: number;
  refused: number;
  jitter: { p50: number; p95: number; p99: number; max: number };
  wheel: { p50: number; p95: number; p99: number; max: number };
  wait: { p50: number; p95: number; p99: number; max: number };
}

/**
 * One sustained run: a real wheel, a real pool, five thousand sensors.
 *
 * Nothing here is a stub. The wheel is armed on its own timer and the pool spawns real worker
 * threads that import a real registry module; the only synthetic part is what the check does
 * when it gets there, and it sleeps for the reason above.
 */
async function soak(options: {
  label: string;
  poolSize: number;
  /** Absent means a fixed pool, which is what every case but `P-18`'s measures. */
  minSize?: number;
  /** Sensors on the wheel. Defaults to the v1 target; `P-18`'s small case is the exception. */
  sensors?: number;
  queueMaxLength: number;
  checkMs: number;
  forMs: number;
}): Promise<Run> {
  const { label, poolSize, queueMaxLength, checkMs, forMs } = options;
  const sensors = options.sensors ?? SENSORS;
  const pool = new CheckPool({
    logger: silent,
    size: poolSize,
    minSize: options.minSize ?? (poolSize > 0 ? poolSize : defaultPoolSize()),
    queueMaxLength,
    registryModule: FIXTURES,
    onResult: (result, meta) => {
      const wheelMs = lateBySensor.get(result.sensorId);
      if (wheelMs === undefined) return;
      lateBySensor.delete(result.sensorId);
      // Due -> dispatched, plus dispatched -> a worker picked it up. Nothing about how long the
      // check itself took: a slow check is not a late one.
      samples.push({ jitterMs: wheelMs + meta.waitMs, wheelMs, waitMs: meta.waitMs });
    },
  });

  const samples: Sample[] = [];
  /** How late each in-flight sensor's tick was, by sensor id. */
  const lateBySensor = new Map<number, number>();

  // The wheel takes its epoch in its constructor, so this is that instant to within the
  // microseconds it takes to call the constructor — three orders of magnitude under the budget
  // being measured. Tick N is ideally due at `epoch + N seconds`; everything after that is late.
  const epochNs = process.hrtime.bigint();
  const wheel = new TimingWheel({
    logger: silent,
    onDue: (due, tick) => {
      const idealNs = epochNs + BigInt(tick) * 1_000_000_000n;
      const wheelMs = Number(process.hrtime.bigint() - idealNs) / 1e6;
      for (const sensorId of due) {
        lateBySensor.set(sensorId, wheelMs);
        pool.submit({
          sensorId,
          sensorType: 'test.slow',
          target: { host: '192.0.2.1', ipVersion: 'auto' },
          params: { delayMs: checkMs },
          timeoutMs: 30_000,
        });
      }
    },
  });

  for (let id = 1; id <= sensors; id += 1) {
    wheel.add({ id, intervalSeconds: INTERVAL_SECONDS });
  }
  // The phase spread is what stops five thousand sensors firing on the same second. Asserted
  // rather than assumed: without it this measures a stampede and nothing else.
  const perSecond = new Map<number, number>();
  for (let id = 1; id <= sensors; id += 1) {
    const phase = phaseFor(id, INTERVAL_SECONDS);
    perSecond.set(phase, (perSecond.get(phase) ?? 0) + 1);
  }
  const busiest = Math.max(...perSecond.values());
  assert.ok(
    busiest < Math.max(2, sensors / 10),
    `the phase spread put ${String(busiest)} sensors on one second; this would measure a stampede`,
  );

  const rssBefore = process.memoryUsage().rss;
  await pool.start();
  // After the workers have imported their registry and settled, not the instant they spawned.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const rssMb = Number(((process.memoryUsage().rss - rssBefore) / (1024 * 1024)).toFixed(1));
  const startSize = pool.size;
  wheel.start();
  const startedAt = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, forMs));
  wheel.stop();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // Let what is in flight finish, so the last interval's checks are not counted as missing.
  await new Promise((resolve) => setTimeout(resolve, checkMs * 4));
  const poolStats = pool.stats();
  const wheelStats = wheel.stats();
  await pool.stop();

  const at = (pick: (sample: Sample) => number) => {
    const sorted = samples.map(pick).sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: percentile(sorted, 1),
    };
  };

  process.stdout.write(
    `\n    ${label}: ${String(Math.round(elapsedMs / 1000))}s, pool ${String(poolStats.size)}, ` +
      `${String(samples.length)} checks completed of ${String(wheelStats.dispatched)} dispatched, ` +
      `${String(poolStats.refused)} refused\n`,
  );

  return {
    label,
    checkMs,
    rssMb,
    // The configured ceiling, and where the pool actually ended up. Equal for every fixed case;
    // the whole point of `P-18`'s case is that they are not.
    poolSize: poolStats.maxSize,
    startSize,
    finalSize: poolStats.size,
    grown: poolStats.grown,
    dispatched: wheelStats.dispatched,
    completed: samples.length,
    deferred: poolStats.deferred,
    refused: poolStats.refused,
    jitter: at((sample) => sample.jitterMs),
    wheel: at((sample) => sample.wheelMs),
    wait: at((sample) => sample.waitMs),
  };
}

function report(runs: Run[]): string {
  const row = (run: Run): string =>
    `      ${run.label.padEnd(26)} ${String(run.checkMs).padStart(4)} ms check  ` +
    `pool ${String(run.poolSize).padStart(3)}` +
    (run.finalSize === run.poolSize ? '     ' : `->${String(run.finalSize).padStart(3)}`) +
    '  ' +
    `jitter p50 ${run.jitter.p50.toFixed(0).padStart(5)} ms  ` +
    `p95 ${run.jitter.p95.toFixed(0).padStart(6)} ms  ` +
    `p99 ${run.jitter.p99.toFixed(0).padStart(6)} ms  ` +
    `(wheel p95 ${run.wheel.p95.toFixed(0)} ms, wait p95 ${run.wait.p95.toFixed(0)} ms)  ` +
    `rss +${run.rssMb.toFixed(0).padStart(4)} MB at ${String(run.startSize).padStart(2)} workers  ` +
    `refused ${String(run.refused)}`;
  return runs.map(row).join('\n');
}

describe('scheduler benchmark (P-15)', () => {
  const runs: Run[] = [];

  after(() => {
    process.stdout.write(
      `\n    measured: ${String(SENSORS)} sensors at ${String(INTERVAL_SECONDS)}s, ` +
        `${String(CHECK_MS)} ms checks, ${String(availableParallelism())} cores, ` +
        `${String(minutes)} minutes per run\n` +
        `    dispatch jitter is due -> check started; the budget is p95 under ` +
        `${String(P95_BUDGET_MS)} ms\n${report(runs)}\n`,
    );
  });

  it('has the cores the criterion is stated for', () => {
    // Not a skip: a number measured on four cores is not the number the gate asks for, and
    // recording it as though it were would be worse than not measuring at all.
    assert.ok(
      availableParallelism() >= REQUIRED_CORES,
      `the criterion is stated for ${String(REQUIRED_CORES)} cores; this machine has ` +
        String(availableParallelism()),
    );
  });

  it('sustains 5,000 sensors with a pool sized for the work in flight', async () => {
    // The gate, measured against the size an operator actually gets. Hardcoding a number here
    // would measure a configuration nobody runs; `defaultPoolSize()` is what `P-15` set and
    // what the sweep below chose. The queue is deliberately generous, so a refusal cannot hide
    // the delay this is measuring.
    const run = await soak({
      label: `shipped default (${String(defaultPoolSize())})`,
      poolSize: 0,
      queueMaxLength: 50_000,
      checkMs: CHECK_MS,
      forMs: durationMs,
    });
    runs.push(run);

    assert.ok(run.completed > 0, 'checks ran');
    assert.equal(run.refused, 0, 'nothing was refused, so the queue is not hiding a delay');
    assert.ok(
      run.jitter.p95 < P95_BUDGET_MS,
      `p95 dispatch jitter was ${run.jitter.p95.toFixed(0)} ms, budget ${String(P95_BUDGET_MS)} ms`,
    );
  });

  it('shows what the old core-count default did with the same load', async () => {
    // `availableParallelism() - 1`, which is what this shipped until `P-15` measured it, with
    // the shipped queue length so the refusals are the real ones. Kept as a regression guard
    // and as the evidence for the change: a number nobody can reproduce is a number nobody
    // should have acted on.
    const run = await soak({
      label: `old default (${String(Math.max(1, availableParallelism() - 1))})`,
      poolSize: Math.max(1, availableParallelism() - 1),
      queueMaxLength: 1_000,
      checkMs: CHECK_MS,
      forMs: Math.min(durationMs, 90_000),
    });
    runs.push(run);
    assert.ok(run.completed > 0, 'checks ran');
    assert.ok(
      run.jitter.p95 > P95_BUDGET_MS,
      'the old default failed the criterion; if this passes, the model no longer reflects the ' +
        'workload and the default should be reconsidered rather than trusted',
    );
  });

  it('reaches the same jitter starting from four workers as from forty-eight', async () => {
    // `P-18`'s claim, against `P-15`'s gate. The pool starts at the shipped minimum and is
    // allowed the shipped maximum, so what this measures is whether growing *while* the first
    // tranches arrive costs a sensor anything an operator would notice — the whole risk of
    // demand-driven sizing, and the reason it is measured rather than argued.
    const run = await soak({
      label: `demand-driven (4 -> ${String(defaultPoolSize())})`,
      poolSize: 0,
      minSize: 4,
      queueMaxLength: 50_000,
      checkMs: CHECK_MS,
      forMs: durationMs,
    });
    runs.push(run);

    assert.ok(run.completed > 0, 'checks ran');
    assert.equal(run.refused, 0, 'nothing was refused, so the queue is not hiding a delay');
    assert.ok(
      run.jitter.p95 < P95_BUDGET_MS,
      `p95 dispatch jitter was ${run.jitter.p95.toFixed(0)} ms, budget ${String(P95_BUDGET_MS)} ms`,
    );
    assert.ok(run.grown > 0, 'and it actually had to grow, or this measured nothing');
  });

  it('costs a small installation a fraction of what a fixed pool reserves', async () => {
    // **The claim `P-18` was written for**, and the only case in this file where the load is not
    // the v1 target: fifty sensors is what most installations actually are, and a flat 48
    // workers reserves the same memory for them as for five thousand. Both runs are short —
    // what is being compared is resident memory, not jitter, and neither pool is under any
    // pressure at this size.
    const SMALL = 50;
    const fixed = await soak({
      label: 'small, fixed 48',
      poolSize: 48,
      sensors: SMALL,
      queueMaxLength: 1_000,
      checkMs: CHECK_MS,
      forMs: 15_000,
    });
    const driven = await soak({
      label: 'small, demand-driven',
      poolSize: 48,
      minSize: 4,
      sensors: SMALL,
      queueMaxLength: 1_000,
      checkMs: CHECK_MS,
      forMs: 15_000,
    });
    runs.push(fixed, driven);

    assert.ok(driven.completed > 0, 'checks ran');
    assert.ok(
      driven.finalSize < fixed.finalSize,
      `the demand-driven pool held ${String(driven.finalSize)} workers against ` +
        `${String(fixed.finalSize)}; fifty sensors should not need the ceiling`,
    );
    assert.equal(driven.grown, 0, 'and it should never have needed to grow at this size');
    // Compared at start-up rather than at the end, because these runs share a process and the
    // previous soak's memory being reclaimed lands in a later delta — which is how a comparison
    // like this passes for the wrong reason. At this size the demand-driven pool never grows, so
    // start-up is its whole cost.
    assert.ok(
      driven.rssMb * 2 < fixed.rssMb,
      `demand-driven reserved ${driven.rssMb.toFixed(0)} MB against the fixed pool's ` +
        `${fixed.rssMb.toFixed(0)} MB, which is not the saving this exists for`,
    );
  });

  it('sweeps pool sizes, which is how the default was chosen', async (t) => {
    // Off by default: seven sizes is three and a half minutes, and the answer only changes when
    // the workload does. `MS_BENCH_SWEEP=1` runs it, and the curve is what
    // `docs/findings/2026-08-26-scheduler-benchmark.md` records.
    if (process.env['MS_BENCH_SWEEP'] !== '1') {
      t.skip('set MS_BENCH_SWEEP=1 to run the pool-size sweep');
      return;
    }
    for (const poolSize of [7, 16, 24, 32, 48, 64, 128, 256]) {
      runs.push(
        await soak({
          label: `sweep pool ${String(poolSize)}`,
          poolSize,
          queueMaxLength: 50_000,
          checkMs: CHECK_MS,
          forMs: 30_000,
        }),
      );
    }
  });

  it('shows what the sensor type we actually ship costs the pool', async () => {
    // **What `icmp.ping` costs today, which is not what this case used to model** (`P-31`).
    //
    // It was written against a three-second check, because `ping` idles a second between
    // packets and four packets is three seconds. `P-07` then passed `-i 0.2` and turned that
    // into **600 ms** (`docs/findings/2026-08-29-icmp-throughput.md`) — so the case kept the old
    // number while calling itself the type we ship, and the pool it asked for, 256 workers,
    // stopped describing anything anyone runs.
    //
    // At 600 ms the arithmetic changes completely: 83 a second at 0.6 s is **50 in flight**
    // against 250, which is the difference between needing a pool nobody would configure and
    // fitting inside the shipped ceiling. So this runs the shipped default against the real
    // check duration, which is the question an operator with 5,000 ping sensors actually has.
    const run = await soak({
      label: `icmp.ping as it ships (${String(defaultPoolSize())})`,
      poolSize: 0,
      queueMaxLength: 50_000,
      checkMs: ICMP_CHECK_MS,
      forMs: Math.min(durationMs, 90_000),
    });
    runs.push(run);

    assert.ok(run.completed > 0, 'checks ran');
    assert.equal(run.refused, 0, 'nothing was refused, so the queue is not hiding a delay');
  });

  it('shows what it cost before P-07 made the check cheaper', async (t) => {
    // The same load at the **pre-`P-07`** three seconds a check: 250 in flight, which needs a
    // pool an order of magnitude past what the sweep says is affordable. Kept rather than
    // deleted because it is the counter-example that makes the row above mean something — and
    // because it is the shape any *genuinely* slow sensor type walks into, whatever the
    // protocol. Diagnostic, and asserts only that it ran.
    //
    // **Checked before it is run** (`P-30`): holding 256 workers costs more than a developer
    // laptop running the dev stack has spare, and finding that out by being killed loses this
    // file's other results along with it.
    const availableMb = availableMemoryMb();
    if (availableMb < ICMP_NEEDS_MB) {
      t.skip(
        `needs about ${String(ICMP_NEEDS_MB)} MB free to hold ${String(ICMP_POOL_SIZE)} workers ` +
          `(measured peak ${String(ICMP_PEAK_MB)} MB) and this machine has ` +
          `${availableMb.toFixed(0)} MB — stop what is using it, or read the committed ` +
          `measurement in docs/findings/2026-08-26-scheduler-benchmark.md`,
      );
      return;
    }

    const run = await soak({
      label: 'before P-07, 3 s checks',
      poolSize: ICMP_POOL_SIZE,
      queueMaxLength: 50_000,
      checkMs: 3_000,
      forMs: Math.min(durationMs, 90_000),
    });
    runs.push(run);
    assert.ok(run.completed > 0, 'checks ran');
  });
});
