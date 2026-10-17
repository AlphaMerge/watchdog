import { strict as assert } from 'node:assert';
import { lookup } from 'node:dns/promises';
import { stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BroadcastChannel } from 'node:worker_threads';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { ProbeHealthReporter } from '../../src/health/report.js';
import { CheckPool, defaultPoolSize } from '../../src/runner/pool.js';
import { TimingWheel } from '../../src/scheduler/wheel.js';
import {
  MODEL_CHECK_MS,
  V1_TARGET_INTERVAL_SECONDS,
  V1_TARGET_SENSORS,
} from '../../src/measured.js';
import {
  LOOKUP_LANES_CHANNEL,
  type LaneReply,
  type LaneRequest,
} from '../support/lookup-registry.js';
import { pollWithin } from '../support/within.js';

/**
 * What one lookup a scan costs (`A-66`).
 *
 * **`A-57` made SNMP by name one `getaddrinfo` a scan in the probe**, where the socket had made one
 * a datagram, and the same lookup is what every transport that connects by name waits in. It is
 * bounded for the check (`resolveBoundMs`: half SNMP's five seconds) and cannot be cancelled for
 * the resolver: a check that gives up leaves its lookup on libuv's thread pool, which every check
 * worker and the probe's main thread share. This measures the 5,000-sensor class with every device
 * addressed by name: what the checks cost, what the thread pool does, and what Probe Health's two
 * new numbers read, with a resolver that answers and with ones that do not.
 *
 * **The check is the shipped resolution and nothing else** (`support/lookup-registry.ts`): a real
 * wheel, a real pool of worker threads at its shipped ceiling and queue, a real catalogue handing
 * each check its resolver and the probe's target policy, and `checkedTarget` called with SNMP's
 * family and timeout, so the lookup is bounded and counted where every transport's is. Then it
 * waits `MODEL_CHECK_MS` for an answer it does not ask for, as `P-15`'s model check does.
 *
 * **The arms**, each on its own pool:
 *
 * | Arm | Devices | Resolved by |
 * | --- | --- | --- |
 * | addresses | 192.0.2.x | nothing: the baseline, `P-15`'s load with the guard in front |
 * | system resolver | `sys-*` | `getaddrinfo` for `localhost` in the worker: real, from the hosts file |
 * | lanes, answering | `lane-ok-*` | the same `getaddrinfo`, inside the lanes below |
 * | lanes, slow | `lane-slow-*` | `MS_DNS_SLOW_MS` a lookup inside the bound, in the lanes |
 * | lanes, not answering | `lane-hung-*` | `MS_DNS_HANG_MS` a lookup past the bound, then `EAI_AGAIN` |
 * | lanes, one zone in ten not answering | both | a tenth of the devices hang, the rest answer |
 *
 * **The lanes are a model, and why.** A resolver that is slow or silent on demand needs one this
 * test controls, and `getaddrinfo` asks the one in `/etc/resolv.conf`. So the slow and silent
 * resolvers are the test's, and every worker's lookups are sent to this thread, where they are
 * answered `MS_DNS_LANES` at a time, first come first served. That is how libuv runs them:
 * `getaddrinfo` is submitted as slow I/O, and libuv lets slow I/O hold at most half its threads,
 * `(UV_THREADPOOL_SIZE + 1) / 2`, two of the default four, so the rest stay free for the file
 * system and crypto and every lookup in the process queues behind the two running. The lanes
 * default to that. They do not hold libuv's threads themselves, so the thread-pool probe below
 * reads the file system's share as unharmed in the lane arms whatever the lanes do; with real
 * lookups it reads what the system-resolver arm reads. The `lanes, answering` arm is the model's
 * control: real `getaddrinfo`, through the lanes.
 *
 * **What is printed per arm**: checks dispatched and their results (answered, failed because the
 * lookup was given up, failed otherwise), refused and deferred; dispatch jitter (due to started,
 * `P-15`'s number); check run time; Probe Health's `lookupsInFlight` (highest and last) and
 * `lookupsGivenUp`, read through the real `ProbeHealthReporter`; the lanes' deepest queue, what
 * is still queued once the pool has drained, the p95 wait (of the lookups served and of those
 * still queued, so far) and how busy they were (a lookup still held counted so far, from the
 * wheel's start); a thread-pool probe, an `fs.stat` every 100 ms from the wheel's start, p95 and
 * worst; and how long the pool took to drain once the wheel stopped. The zone arm also says how
 * the answering zone fared.
 *
 * **Asserted**, beside each arm having run: `lookupsGivenUp` is exactly the checks that failed at
 * the lookup's bound, so the Probe Health number is the one the checks say, and no lookup is
 * given up, and nothing refused, where every name answers from the hosts file.
 *
 * Environment: `MS_DNS_SENSORS` (5,000), `MS_DNS_MINUTES` per arm (1), `MS_DNS_SLOW_MS` (100),
 * `MS_DNS_HANG_MS` (30,000), `MS_DNS_LANES` (from `UV_THREADPOOL_SIZE`, 4 unless set),
 * `MS_DNS_POOL` (the shipped ceiling), `MS_DNS_ARMS` (a comma list of arm names, all unless set).
 */

const silent = pino({ level: 'silent' });
const REGISTRY = fileURLToPath(new URL('../support/lookup-registry.js', import.meta.url));

const SENSORS = Number(process.env['MS_DNS_SENSORS'] ?? String(V1_TARGET_SENSORS));
const MINUTES = Number(process.env['MS_DNS_MINUTES'] ?? '1');
const SLOW_MS = Number(process.env['MS_DNS_SLOW_MS'] ?? '100');
const HANG_MS = Number(process.env['MS_DNS_HANG_MS'] ?? '30000');
const THREADPOOL = Number(process.env['UV_THREADPOOL_SIZE'] ?? '4');
const LANES = Number(process.env['MS_DNS_LANES'] ?? String(Math.floor((THREADPOOL + 1) / 2)));
const POOL_SIZE = Number(process.env['MS_DNS_POOL'] ?? String(defaultPoolSize()));
const ARMS = (process.env['MS_DNS_ARMS'] ?? '')
  .split(',')
  .map((arm) => arm.trim())
  .filter((arm) => arm !== '');
const INTERVAL_SECONDS = V1_TARGET_INTERVAL_SECONDS;
/** A switch's worth: ten sensors a device, so 500 names at the v1 target. */
const SENSORS_PER_DEVICE = 10;
/** SNMP's own default timeout, of which the lookup has half (`resolveBoundMs`). */
const SNMP_TIMEOUT_MS = 5_000;
/** `scan.timeoutMs`'s default, which the pool holds a check to. */
const SCAN_TIMEOUT_MS = 30_000;
/** `probe.checkQueueMaxLength`'s default. */
const QUEUE_MAX = 1_000;
/** How long a pool may take to work off what the wheel left it, before the arm fails. */
const DRAIN_BOUND_MS = 180_000;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** What the lanes say: queued counts what is waiting when it is read. */
interface LaneStats {
  readonly deepest: number;
  readonly queued: number;
  readonly waitP95: number;
  readonly busy: number;
}

/**
 * Every worker's lookups, answered from this thread `lanes` at a time, oldest first: libuv's
 * slow-I/O share of its thread pool, as the file's comment says. A `lane-<kind>-*` name says
 * how its resolver behaves.
 */
class LookupLanes {
  readonly #lanes: number;
  readonly #requests = new BroadcastChannel(LOOKUP_LANES_CHANNEL);
  readonly #replies = new Map<number, BroadcastChannel>();
  readonly #queue: { readonly request: LaneRequest; readonly at: number }[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  /** How long each served lookup waited for a lane. Those still queued are added in `stats`. */
  readonly #waits: number[] = [];
  /**
   * When each lookup a lane holds now began: a lane is busy from then, not only once its lookup
   * has been answered, or the lanes read idle exactly while lookups that never end hold them.
   */
  readonly #serving = new Set<{ readonly startedAt: number }>();
  /** What `busy` divides by starts here: `start`, or the first lookup asked if that is sooner. */
  #startedAt: number | undefined;
  #deepest = 0;
  #busyMs = 0;
  #stopped = false;

  constructor(lanes: number) {
    this.#lanes = Math.max(1, lanes);
    this.#requests.onmessage = (event: unknown) => {
      const at = performance.now();
      this.#startedAt ??= at;
      this.#queue.push({ request: (event as { data: LaneRequest }).data, at });
      this.#deepest = Math.max(this.#deepest, this.#queue.length);
      this.#pump();
    };
  }

  /** Starts the clock `busy` is a share of: just before the wheel starts ticking. */
  start(): void {
    this.#startedAt ??= performance.now();
  }

  #pump(): void {
    while (!this.#stopped && this.#serving.size < this.#lanes) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      const serving = { startedAt: performance.now() };
      this.#serving.add(serving);
      this.#waits.push(serving.startedAt - next.at);
      void this.#serve(next.request)
        .then(
          (answer) => answer,
          (error: unknown): LaneReply => ({
            code: (error as NodeJS.ErrnoException | null)?.code ?? 'EAI_FAIL',
          }),
        )
        .then((answer) => {
          this.#serving.delete(serving);
          this.#busyMs += performance.now() - serving.startedAt;
          if (this.#stopped) return;
          this.#reply(next.request, answer);
          this.#pump();
        });
    }
  }

  async #serve(request: LaneRequest): Promise<LaneReply> {
    const kind = /^lane-(ok|slow|hung)-/.exec(request.host)?.[1];
    if (kind === 'ok') {
      const answers = await lookup('localhost', { all: true, family: request.family });
      return { addresses: answers.map(({ address, family }) => ({ address, family })) };
    }
    await this.#sleep(kind === 'slow' ? SLOW_MS : HANG_MS);
    return kind === 'slow'
      ? { addresses: [{ address: '127.0.0.1', family: 4 }] }
      : { code: 'EAI_AGAIN' };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        resolve();
      }, ms);
      this.#timers.add(timer);
    });
  }

  #reply(request: LaneRequest, answer: LaneReply): void {
    let channel = this.#replies.get(request.thread);
    if (channel === undefined) {
      channel = new BroadcastChannel(`${LOOKUP_LANES_CHANNEL}:${String(request.thread)}`);
      this.#replies.set(request.thread, channel);
    }
    channel.postMessage({ id: request.id, ...answer });
  }

  /**
   * As of now: a lookup still being served counts the time it has held its lane so far, and one
   * still queued the time it has waited so far, so a saturated arm reads saturated.
   */
  stats(): LaneStats {
    const now = performance.now();
    let busyMs = this.#busyMs;
    for (const { startedAt } of this.#serving) busyMs += now - startedAt;
    const waits = [...this.#waits, ...this.#queue.map(({ at }) => now - at)];
    const elapsed = this.#startedAt === undefined ? 0 : now - this.#startedAt;
    return {
      deepest: this.#deepest,
      queued: this.#queue.length,
      waitP95: percentile(sorted(waits), 0.95),
      busy: elapsed > 0 ? busyMs / (elapsed * this.#lanes) : 0,
    };
  }

  /** What is still waiting is never answered: the pool's workers are gone by now. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#requests.close();
    for (const channel of this.#replies.values()) channel.close();
    this.#replies.clear();
  }
}

/** How long the thread pool takes to serve a file-system call, every 100 ms. */
function threadPoolProbe(): { stop: () => Promise<{ p95: number; max: number }> } {
  const samples: number[] = [];
  const probing = { running: true };
  const loop = (async () => {
    const directory = tmpdir();
    while (probing.running) {
      const startedAt = performance.now();
      await stat(directory);
      samples.push(performance.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    stop: async () => {
      probing.running = false;
      await loop;
      const ordered = sorted(samples);
      return { p95: percentile(ordered, 0.95), max: ordered.at(-1) ?? 0 };
    },
  };
}

type Kind = 'address' | 'system' | 'ok' | 'slow' | 'hung';

interface Arm {
  readonly name: string;
  readonly label: string;
  /** What each device is, by its index. */
  readonly kind: (device: number) => Kind;
}

const host = (device: number, kind: Kind): string => {
  switch (kind) {
    case 'address':
      return `192.0.2.${String((device % 250) + 1)}`;
    case 'system':
      return `sys-${String(device)}.test`;
    default:
      return `lane-${kind}-${String(device)}.test`;
  }
};

const ALL_ARMS: readonly Arm[] = [
  { name: 'addresses', label: 'addresses', kind: () => 'address' },
  { name: 'system', label: 'system resolver', kind: () => 'system' },
  { name: 'lanes', label: 'lanes, answering', kind: () => 'ok' },
  { name: 'slow', label: `lanes, ${String(SLOW_MS)} ms a lookup`, kind: () => 'slow' },
  { name: 'hung', label: 'lanes, not answering', kind: () => 'hung' },
  {
    name: 'zone',
    label: 'lanes, one zone in ten silent',
    kind: (device) => (device % 10 === 0 ? 'hung' : 'ok'),
  },
];

interface Tally {
  results: number;
  answered: number;
  givenUp: number;
  other: number;
}

const tally = (): Tally => ({ results: 0, answered: 0, givenUp: 0, other: 0 });

interface Run {
  readonly label: string;
  readonly dispatched: number;
  readonly all: Tally;
  /** The devices whose resolver answers, in an arm where some do not. */
  readonly answering: Tally | undefined;
  readonly refused: number;
  readonly deferred: number;
  readonly timedOut: number;
  readonly jitter: { p50: number; p95: number; max: number };
  readonly runP95: number;
  readonly inFlightMax: number;
  readonly inFlightLast: number;
  readonly givenUp: number;
  readonly lanes: LaneStats;
  readonly threadPool: { p95: number; max: number };
  readonly drainMs: number;
}

const GIVEN_UP = /did not resolve within \d+ ms/;

async function soak(arm: Arm): Promise<Run> {
  const devices = Math.ceil(SENSORS / SENSORS_PER_DEVICE);
  const kindOf = (sensorId: number): Kind =>
    arm.kind(Math.floor((sensorId - 1) / SENSORS_PER_DEVICE) % devices);
  const mixed = new Set(Array.from({ length: devices }, (_, device) => arm.kind(device))).size > 1;

  const all = tally();
  const answering = tally();
  const jitter: number[] = [];
  const run: number[] = [];
  const lateBySensor = new Map<number, number>();
  const lanes = new LookupLanes(LANES);

  const pool = new CheckPool({
    logger: silent,
    size: POOL_SIZE,
    minSize: POOL_SIZE,
    queueMaxLength: QUEUE_MAX,
    registryModule: REGISTRY,
    onResult: (result, meta) => {
      const count = (into: Tally): void => {
        into.results += 1;
        if (result.outcome === 'ok') into.answered += 1;
        else if (GIVEN_UP.test(result.message)) into.givenUp += 1;
        else into.other += 1;
      };
      count(all);
      if (mixed && kindOf(result.sensorId) !== 'hung') count(answering);
      run.push(result.durationMs);
      const wheelMs = lateBySensor.get(result.sensorId);
      if (wheelMs === undefined) return;
      lateBySensor.delete(result.sensorId);
      jitter.push(wheelMs + meta.waitMs);
    },
  });

  let probe: ReturnType<typeof threadPoolProbe> | undefined;
  let wheel: TimingWheel | undefined;
  let sampler: NodeJS.Timeout | undefined;
  let inFlightMax = 0;
  let drainMs: number;
  let report: ReturnType<ProbeHealthReporter['report']>;
  let stats: ReturnType<CheckPool['stats']>;
  let wheelStats: ReturnType<TimingWheel['stats']>;
  let threadPool: { p95: number; max: number };
  let laneStats: LaneStats;
  try {
    await pool.start();
    // **Made once the workers have loaded**, because the wheel takes its epoch when it is made:
    // made before, its first ticks were late by the pool's start-up and read as jitter.
    const epochNs = process.hrtime.bigint();
    const ticking = new TimingWheel({
      logger: silent,
      onDue: (due, tick) => {
        const idealNs = epochNs + BigInt(tick) * 1_000_000_000n;
        const wheelMs = Number(process.hrtime.bigint() - idealNs) / 1e6;
        for (const sensorId of due) {
          const device = Math.floor((sensorId - 1) / SENSORS_PER_DEVICE) % devices;
          if (
            pool.submit({
              sensorId,
              sensorType: 'test.named',
              target: { host: host(device, kindOf(sensorId)), ipVersion: 'auto' },
              params: { timeoutMs: SNMP_TIMEOUT_MS, delayMs: MODEL_CHECK_MS },
              timeoutMs: SCAN_TIMEOUT_MS,
            }) === 'accepted'
          ) {
            lateBySensor.set(sensorId, wheelMs);
          }
        }
      },
    });
    wheel = ticking;
    for (let id = 1; id <= SENSORS; id += 1) {
      ticking.add({ id, intervalSeconds: INTERVAL_SECONDS });
    }

    // Probe Health's own reporter over the real pool, so the numbers are the ones it would send.
    const health = new ProbeHealthReporter({
      scheduler: () => ticking.stats(),
      pool: () => pool.stats(),
      memory: {
        machine: { lowest: () => null, takeLow: () => null },
        limit: { lowest: () => null, takeLow: () => null },
        start: () => undefined,
        stop: () => undefined,
      },
    });
    sampler = setInterval(() => {
      inFlightMax = Math.max(inFlightMax, health.report().lookupsInFlight ?? 0);
    }, 1_000);

    // **Started with the wheel, after the workers have loaded**: the file system's share read
    // while 64 workers import their registries is their start-up, not the lookups'. The lanes'
    // clock starts here for the same reason.
    probe = threadPoolProbe();
    lanes.start();
    ticking.start();
    await new Promise((resolve) => setTimeout(resolve, MINUTES * 60_000));
    ticking.stop();

    // Whatever the wheel left the pool is worked off, so that every check's result, and the
    // counters each carried, are in before the numbers are read.
    const drainStarted = performance.now();
    await pollWithin(
      DRAIN_BOUND_MS,
      () =>
        `the pool to drain: ${JSON.stringify({ queued: pool.stats().queued, busy: pool.stats().busy })}`,
      () => pool.stats().queued === 0 && pool.stats().busy === 0,
      50,
    );
    drainMs = performance.now() - drainStarted;
    report = health.report();
    stats = pool.stats();
    wheelStats = ticking.stats();
    laneStats = lanes.stats();
  } finally {
    // Also when the drain failed, or the file's process would be held by the pool and the lanes.
    wheel?.stop();
    clearInterval(sampler);
    // Never started if the pool did not: the arm is failing, and these are not read.
    threadPool = probe === undefined ? { p95: Number.NaN, max: Number.NaN } : await probe.stop();
    await pool.stop();
    lanes.stop();
  }

  const ordered = sorted(jitter);
  return {
    label: arm.label,
    dispatched: wheelStats.dispatched,
    all,
    answering: mixed ? answering : undefined,
    refused: stats.refused,
    deferred: stats.deferred,
    timedOut: stats.timedOut,
    jitter: {
      p50: percentile(ordered, 0.5),
      p95: percentile(ordered, 0.95),
      max: ordered.at(-1) ?? 0,
    },
    runP95: percentile(sorted(run), 0.95),
    inFlightMax: Math.max(inFlightMax, report.lookupsInFlight ?? 0),
    inFlightLast: report.lookupsInFlight ?? -1,
    givenUp: report.lookupsGivenUp ?? -1,
    lanes: laneStats,
    threadPool,
    drainMs,
  };
}

const ms = (value: number): string => `${value.toFixed(0)} ms`;

function row(run: Run): string {
  const answering =
    run.answering === undefined
      ? ''
      : `\n        answering zone: ${String(run.answering.answered)} of ${String(run.answering.results)} answered, ` +
        `${String(run.answering.givenUp)} given up, ${String(run.answering.other)} failed otherwise`;
  return (
    `      ${run.label}\n` +
    `        ${String(run.dispatched)} dispatched, ${String(run.all.results)} results: ` +
    `${String(run.all.answered)} answered, ${String(run.all.givenUp)} lookup given up, ` +
    `${String(run.all.other)} failed otherwise; refused ${String(run.refused)}, ` +
    `deferred ${String(run.deferred)}, timed out ${String(run.timedOut)}\n` +
    `        jitter p50 ${ms(run.jitter.p50)}, p95 ${ms(run.jitter.p95)}, max ${ms(run.jitter.max)}; ` +
    `check run p95 ${ms(run.runP95)}; drained in ${ms(run.drainMs)}\n` +
    `        Probe Health: lookupsInFlight max ${String(run.inFlightMax)}, last ${String(run.inFlightLast)}; ` +
    `lookupsGivenUp ${String(run.givenUp)}\n` +
    `        lanes: deepest queue ${String(run.lanes.deepest)}, ${String(run.lanes.queued)} still queued; ` +
    `wait p95 ${ms(run.lanes.waitP95)} (served and still queued); busy ${(run.lanes.busy * 100).toFixed(0)}%; ` +
    `thread pool fs.stat p95 ${run.threadPool.p95.toFixed(2)} ms, ` +
    `max ${run.threadPool.max.toFixed(2)} ms` +
    answering
  );
}

describe('a name lookup a scan (A-66)', () => {
  const runs: Run[] = [];

  after(() => {
    process.stdout.write(
      `\n    measured: ${String(SENSORS)} sensors at ${String(INTERVAL_SECONDS)} s on ` +
        `${String(Math.ceil(SENSORS / SENSORS_PER_DEVICE))} devices, ${String(MINUTES)} min an arm, ` +
        `pool ${String(POOL_SIZE)}, queue ${String(QUEUE_MAX)}, ${String(availableParallelism())} cores\n` +
        `    lookup bound ${ms(SNMP_TIMEOUT_MS / 2)} (SNMP's ${ms(SNMP_TIMEOUT_MS)}), ` +
        `check ${ms(MODEL_CHECK_MS)} after it; UV_THREADPOOL_SIZE ${String(THREADPOOL)}, ` +
        `${String(LANES)} lookup lanes; slow ${ms(SLOW_MS)}, silent ${ms(HANG_MS)} then EAI_AGAIN\n` +
        `${runs.map(row).join('\n')}\n`,
    );
  });

  for (const arm of ALL_ARMS) {
    it(arm.label, async (t) => {
      if (ARMS.length > 0 && !ARMS.includes(arm.name)) {
        t.skip(`MS_DNS_ARMS leaves out "${arm.name}"`);
        return;
      }
      const run = await soak(arm);
      runs.push(run);

      assert.ok(run.all.results > 0, 'checks ran');
      // The Probe Health number is the checks' own: each check that failed at the lookup's bound
      // gave exactly one lookup up, and nothing else gives one up while the pool is running.
      assert.equal(
        run.givenUp,
        run.all.givenUp,
        `lookupsGivenUp read ${String(run.givenUp)}, and ${String(run.all.givenUp)} checks failed at the lookup's bound`,
      );
      if (arm.name === 'addresses') {
        assert.equal(run.inFlightMax, 0, 'a device given as an address is never resolved');
      }
      if (arm.name === 'addresses' || arm.name === 'system') {
        assert.equal(run.givenUp, 0, 'a name answered from the hosts file is never given up');
        assert.equal(run.refused, 0, 'and a lookup a scan from it refuses no check');
      }
    });
  }
});
