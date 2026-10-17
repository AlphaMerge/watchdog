import { strict as assert } from 'node:assert';
import { stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { systemResolve, type ResolvedAddress } from '@ms/sensors';
import { lookupsBesideThePool, ProbeHealthReporter } from '../../src/health/report.js';
import {
  ANSWER_MS,
  lookupLanes,
  NameResolver,
  resolverLanes,
  STALE_MS,
  type Family,
} from '../../src/resolver/name-resolver.js';
import { CheckPool, defaultPoolSize } from '../../src/runner/pool.js';
import { TimingWheel } from '../../src/scheduler/wheel.js';
import {
  MODEL_CHECK_MS,
  V1_TARGET_INTERVAL_SECONDS,
  V1_TARGET_SENSORS,
} from '../../src/measured.js';
import { pollWithin } from '../support/within.js';

/**
 * What a name lookup a scan costs once the probe's resolver keeps answers (`A-66`, `P-426`).
 *
 * **`A-57` made SNMP by name one `getaddrinfo` a scan in the probe**, and `A-66` measured what that
 * cost at the 5,000-sensor class: a resolver answering in 100 ms, or one zone in ten not
 * answering, held libuv's lookup lanes and took the probe down
 * (`docs/findings/2026-10-17-name-lookups-a-scan.md`). `P-426` put every such lookup through one
 * resolver in the probe's main thread, which keeps answers 30 s, serves an expired one for at most
 * 5 minutes past its expiry while the resolver does not answer, holds a name it does not answer,
 * and runs at most 6 lookups at once of libuv's 8. This measures the same load through it.
 *
 * **The check is the shipped resolution and nothing else** (`support/lookup-registry.ts`): a real
 * wheel, a real pool of worker threads at its shipped ceiling and queue, each worker asking the
 * real `NameResolver` in this thread over its port, a real catalogue handing each check that
 * resolver and the probe's target policy, and `checkedTarget` called with SNMP's family and
 * timeout. Then it waits `MODEL_CHECK_MS` for an answer it does not ask for, as `P-15`'s model
 * check does.
 *
 * **The arms**, each on its own pool and its own resolver, so each starts with nothing kept:
 *
 * | Arm | Devices | `getaddrinfo` | Asserted |
 * | --- | --- | --- | --- |
 * | `addresses` | 192.0.2.x | none: the baseline | nothing in flight |
 * | `system` | `sys-*` | real, for `localhost`, from the hosts file | nothing given up or refused |
 * | `slow` | `lane-slow-*` | `MS_DNS_SLOW_MS` a lookup, in the lanes, cold | nothing given up or refused |
 * | `warmzone` | `lane-warm-*` | answering for a scan interval, then one zone in ten silent | the answering zone never given up, nothing refused; past the grace, every answering name refreshed within it, and the silent zone failing at once |
 * | `hung` | `lane-hung-*` | every name silent, cold: `MS_DNS_HANG_MS` then `EAI_AGAIN` | nothing refused, and jitter as the `addresses` arm's |
 * | `zone` | both | one zone in ten silent, cold | read only: how long the answering zone takes to be kept |
 *
 * **A zone is a domain**: device `n` is `lane-<kind>-n.zone-b.test` in the zone that goes silent
 * and `….zone-a.test` in the others, as a DNS zone's names are, since the resolver gives a lane to
 * a domain answering before one with names failing (`P-426`'s review).
 *
 * **The lanes are a model, and why.** A resolver that is slow or silent on demand needs one this
 * test controls, and `getaddrinfo` asks the one in `/etc/resolv.conf`. So the slow and silent
 * resolvers are the test's: the `NameResolver`'s `getaddrinfo` is a model that serves
 * `MS_DNS_LANES` lookups at a time, first come first served, as libuv serves slow I/O on half its
 * threads. They default to 8, `UV_THREADPOOL_SIZE` 16, which `bin/ms-probe` and the unit set; the
 * resolver takes 6 of them. The model holds no libuv thread, so the thread-pool probe reads the
 * file system's share as unharmed in the lane arms whatever the lanes do; the `system` arm is the
 * real `getaddrinfo` on the real pool.
 *
 * **What is printed per arm**: checks dispatched and their results (answered, failed for want of
 * an answer, failed otherwise), refused and deferred; dispatch jitter (`P-15`'s number); check run
 * time; Probe Health's `lookupsInFlight` (highest and last) and `lookupsGivenUp`, through the real
 * reporter wired as the probe wires it; the `getaddrinfo` calls the resolver made and the names it
 * keeps; the lanes' deepest queue, p95 wait and how busy they were; a thread-pool probe, an
 * `fs.stat` every 100 ms; and how long the pool took to drain once the wheel stopped. The zone
 * arms say how each zone fared; the warm one how long an answering name went between answers, the
 * cold one how long the answering names took to be kept.
 *
 * **Asserted for every arm**: `lookupsGivenUp` is exactly the checks that failed for want of an
 * answer, so the Probe Health number is the one the checks say.
 *
 * Environment: `MS_DNS_SENSORS` (5,000), `MS_DNS_MINUTES` per arm (1), `MS_DNS_SLOW_MS` (100),
 * `MS_DNS_HANG_MS` (30,000), `MS_DNS_LANES` (8), `MS_DNS_POOL` (the shipped ceiling),
 * `MS_DNS_WARM_MINUTES` (the `warmzone` arm's time after its zone goes silent, `MS_DNS_MINUTES`
 * unless set: 7 reaches past the 5-minute grace, and only then are the answering zone's refreshes
 * within it and the silent zone's failing asserted), `MS_DNS_COLD_MINUTES` (the `zone` arm's time,
 * `MS_DNS_MINUTES` unless set: long enough for every answering name to be kept, or the row says
 * how many were not), `MS_DNS_ARMS` (a comma list of arm names, all unless set).
 */

const silent = pino({ level: 'silent' });
const REGISTRY = fileURLToPath(new URL('../support/lookup-registry.js', import.meta.url));

const SENSORS = Number(process.env['MS_DNS_SENSORS'] ?? String(V1_TARGET_SENSORS));
const MINUTES = Number(process.env['MS_DNS_MINUTES'] ?? '1');
const WARM_MINUTES = Number(process.env['MS_DNS_WARM_MINUTES'] ?? String(MINUTES));
const COLD_MINUTES = Number(process.env['MS_DNS_COLD_MINUTES'] ?? String(MINUTES));
const SLOW_MS = Number(process.env['MS_DNS_SLOW_MS'] ?? '100');
const HANG_MS = Number(process.env['MS_DNS_HANG_MS'] ?? '30000');
const LANES = Number(process.env['MS_DNS_LANES'] ?? String(lookupLanes(16)));
const RESOLVER_LANES = resolverLanes(LANES);
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
/** Checks that failed for want of an answer: at the lookup's bound, or told so by the resolver. */
const GIVEN_UP = /the probe’s resolver is not answering/u;
/**
 * A silent name's check, once nothing is kept for it, fails at once: well inside the bound. The
 * one that starts a hold's retry on a free lane waits for it, up to its bound.
 */
const AT_ONCE_MS = 1_500;

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
 * The resolver's `getaddrinfo`, served `lanes` at a time, oldest first: libuv's slow-I/O share of
 * its thread pool, as the file's comment says. A `lane-<kind>-*` name says how its resolver
 * behaves; a `lane-warm-*` name answers until `silence` is called for its zone.
 */
class LookupLanes {
  readonly #lanes: number;
  readonly #queue: {
    readonly host: string;
    readonly at: number;
    readonly settle: (reply: { addresses: readonly ResolvedAddress[] } | { code: string }) => void;
  }[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  /** How long each served lookup waited for a lane. Those still queued are added in `stats`. */
  readonly #waits: number[] = [];
  readonly #serving = new Set<{ readonly startedAt: number }>();
  /** When each name was answered, from `start`, for the zone arms. */
  readonly answeredAt = new Map<string, number[]>();
  #startedAt: number | undefined;
  #deepest = 0;
  #busyMs = 0;
  #stopped = false;
  #silent: ((host: string) => boolean) | undefined;

  constructor(lanes: number) {
    this.#lanes = Math.max(1, lanes);
  }

  start(): void {
    this.#startedAt ??= performance.now();
  }

  /** From now, the `lane-warm-*` names this says are silent never answer. */
  silence(silentName: (host: string) => boolean): void {
    this.#silent = silentName;
  }

  readonly lookup = (host: string, _family: Family): Promise<readonly ResolvedAddress[]> =>
    new Promise((resolve, reject) => {
      const at = performance.now();
      this.#startedAt ??= at;
      this.#queue.push({
        host,
        at,
        settle: (reply) => {
          if ('addresses' in reply) {
            resolve(reply.addresses);
          } else {
            reject(
              Object.assign(new Error(`getaddrinfo ${reply.code} ${host}`), { code: reply.code }),
            );
          }
        },
      });
      this.#deepest = Math.max(this.#deepest, this.#queue.length);
      this.#pump();
    });

  #pump(): void {
    while (!this.#stopped && this.#serving.size < this.#lanes) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      const serving = { startedAt: performance.now() };
      this.#serving.add(serving);
      this.#waits.push(serving.startedAt - next.at);
      void this.#serve(next.host).then((reply) => {
        this.#serving.delete(serving);
        this.#busyMs += performance.now() - serving.startedAt;
        if (this.#stopped) return;
        if ('addresses' in reply) {
          const times = this.answeredAt.get(next.host) ?? [];
          times.push(performance.now() - (this.#startedAt ?? 0));
          this.answeredAt.set(next.host, times);
        }
        next.settle(reply);
        this.#pump();
      });
    }
  }

  async #serve(
    host: string,
  ): Promise<{ addresses: readonly ResolvedAddress[] } | { code: string }> {
    const kind = /^lane-(ok|slow|hung|warm)-/u.exec(host)?.[1];
    const answer = { addresses: [{ address: '127.0.0.1', family: 4 }] };
    if (kind === 'ok') return answer;
    if (kind === 'warm' && this.#silent?.(host) !== true) return answer;
    await this.#sleep(kind === 'slow' ? SLOW_MS : HANG_MS);
    return kind === 'slow' ? answer : { code: 'EAI_AGAIN' };
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

  /** What is still waiting is never answered: the arm's resolver is discarded with it. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
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

type Kind = 'address' | 'system' | 'ok' | 'slow' | 'hung' | 'warm';

interface Arm {
  readonly name: string;
  readonly label: string;
  /** What each device is, by its index. */
  readonly kind: (device: number) => Kind;
  /** The devices whose resolver stops answering, in a zone arm. */
  readonly silentZone?: (device: number) => boolean;
  /** Answering for a scan interval first, then the silent zone silent. */
  readonly warmFirst?: boolean;
}

const oneInTen = (device: number): boolean => device % 10 === 0;

const host = (device: number, kind: Kind): string => {
  switch (kind) {
    case 'address':
      return `192.0.2.${String((device % 250) + 1)}`;
    case 'system':
      return `sys-${String(device)}.test`;
    default:
      return `lane-${kind}-${String(device)}.zone-${oneInTen(device) ? 'b' : 'a'}.test`;
  }
};

/** The device a `lane-*` name is. */
const deviceNamed = (name: string): number => Number(/^lane-\w+-(\d+)\./u.exec(name)?.[1] ?? '-1');

const ALL_ARMS: readonly Arm[] = [
  { name: 'addresses', label: 'addresses', kind: () => 'address' },
  { name: 'system', label: 'system resolver', kind: () => 'system' },
  { name: 'slow', label: `${String(SLOW_MS)} ms a lookup, cold`, kind: () => 'slow' },
  {
    name: 'warmzone',
    label: 'one zone in ten silent after a scan interval answering',
    kind: () => 'warm',
    silentZone: oneInTen,
    warmFirst: true,
  },
  { name: 'hung', label: 'every name silent, cold', kind: () => 'hung' },
  {
    name: 'zone',
    label: 'one zone in ten silent, cold',
    kind: (device) => (oneInTen(device) ? 'hung' : 'ok'),
    silentZone: oneInTen,
  },
];

interface Tally {
  results: number;
  answered: number;
  givenUp: number;
  other: number;
  /** How long each failure took, check run time. */
  failedMs: number[];
}

const tally = (): Tally => ({ results: 0, answered: 0, givenUp: 0, other: 0, failedMs: [] });

interface Run {
  readonly name: string;
  readonly label: string;
  readonly dispatched: number;
  readonly all: Tally;
  /** The answering zone, in a zone arm. */
  readonly answering: Tally | undefined;
  /** The silent zone, before and after its kept answers could last no longer, in a zone arm. */
  readonly silentBefore: Tally | undefined;
  readonly silentAfter: Tally | undefined;
  /** Whether the arm ran past the silent zone's grace. */
  readonly pastGrace: boolean;
  readonly refused: number;
  readonly deferred: number;
  readonly timedOut: number;
  readonly jitter: { p50: number; p95: number; max: number };
  readonly runP95: number;
  readonly inFlightMax: number;
  readonly inFlightLast: number;
  readonly givenUp: number;
  readonly asked: number;
  readonly kept: number;
  readonly lanes: LaneStats;
  /**
   * The longest an answering name went between answers once its zone's neighbour went silent,
   * from its last answer before then, to the end of the arm for its last.
   */
  readonly longestGapMs: number | undefined;
  /** When the answering names were first kept, cold: p50, p95, last, and how many never were. */
  readonly cached: { p50: number; p95: number; max: number; never: number; of: number } | undefined;
  readonly threadPool: { p95: number; max: number };
  readonly drainMs: number;
}

async function soak(arm: Arm): Promise<Run> {
  const devices = Math.ceil(SENSORS / SENSORS_PER_DEVICE);
  const deviceOf = (sensorId: number): number =>
    Math.floor((sensorId - 1) / SENSORS_PER_DEVICE) % devices;
  const kindOf = (sensorId: number): Kind => arm.kind(deviceOf(sensorId));
  const inSilentZone = (sensorId: number): boolean => arm.silentZone?.(deviceOf(sensorId)) === true;

  const all = tally();
  const answering = tally();
  const silentBefore = tally();
  const silentAfter = tally();
  const jitter: number[] = [];
  const run: number[] = [];
  const lateBySensor = new Map<number, number>();
  const lanes = new LookupLanes(LANES);
  // Every `getaddrinfo` the resolver makes, whichever it is: the model's, or the system's.
  let asked = 0;
  const resolver = new NameResolver({
    logger: silent,
    lanes: RESOLVER_LANES,
    lookup: (name, family) => {
      asked += 1;
      return arm.name === 'system'
        ? systemResolve('localhost', family)
        : lanes.lookup(name, family);
    },
    watch: { files: [], everyMs: 60_000 },
  });
  /** When the silent zone went silent, and when nothing kept for it can be served any more. */
  let silencedAt: number | undefined;
  const graceOver = (): boolean =>
    silencedAt !== undefined && performance.now() >= silencedAt + ANSWER_MS + STALE_MS;

  const count = (into: Tally, outcome: string, message: string, durationMs: number): void => {
    into.results += 1;
    if (outcome === 'ok') {
      into.answered += 1;
      return;
    }
    into.failedMs.push(durationMs);
    if (GIVEN_UP.test(message)) into.givenUp += 1;
    else into.other += 1;
  };

  const pool = new CheckPool({
    logger: silent,
    size: POOL_SIZE,
    minSize: POOL_SIZE,
    queueMaxLength: QUEUE_MAX,
    registryModule: REGISTRY,
    resolver,
    onResult: (result, meta) => {
      count(all, result.outcome, result.message, result.durationMs);
      if (arm.silentZone !== undefined) {
        if (!inSilentZone(result.sensorId)) {
          count(answering, result.outcome, result.message, result.durationMs);
        } else if (silencedAt !== undefined) {
          count(
            graceOver() ? silentAfter : silentBefore,
            result.outcome,
            result.message,
            result.durationMs,
          );
        }
      }
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
  let wheelStartedAt = 0;
  let stoppedAt = 0;
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
          if (
            pool.submit({
              sensorId,
              sensorType: 'test.named',
              target: { host: host(deviceOf(sensorId), kindOf(sensorId)), ipVersion: 'auto' },
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

    // Probe Health's own reporter, wired as the probe wires it: the pool's workers' lookups, and
    // beside them the resolver's running and queued.
    const health = new ProbeHealthReporter({
      scheduler: () => ticking.stats(),
      pool: () => pool.stats(),
      lookups: lookupsBesideThePool({ lookupCounters: () => undefined }, resolver),
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
    // while 64 workers import their registries is their start-up, not the lookups'.
    probe = threadPoolProbe();
    lanes.start();
    wheelStartedAt = performance.now();
    ticking.start();
    if (arm.warmFirst === true) {
      // A scan interval answering, so that every name is kept; then the zone goes silent.
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1_000));
      const zone = arm.silentZone ?? (() => false);
      lanes.silence((name) => zone(deviceNamed(name)));
      silencedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, WARM_MINUTES * 60_000));
    } else {
      if (arm.silentZone !== undefined) silencedAt = wheelStartedAt;
      const minutes = arm.silentZone === undefined ? MINUTES : COLD_MINUTES;
      await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
    }
    ticking.stop();
    stoppedAt = performance.now();

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
    threadPool = probe === undefined ? { p95: Number.NaN, max: Number.NaN } : await probe.stop();
    await pool.stop();
    lanes.stop();
  }

  // The answering names, by how they were answered.
  const answeringNames = Array.from({ length: devices }, (_, device) => device)
    .filter((device) => arm.silentZone !== undefined && !arm.silentZone(device))
    .map((device) => host(device, arm.kind(device)));
  let longestGapMs: number | undefined;
  let cached: Run['cached'];
  if (arm.silentZone !== undefined && arm.warmFirst === true && silencedAt !== undefined) {
    // How long each answering name went without a fresh answer once the zone went silent: from
    // its last answer before then, which is where its kept answer's grace runs from (`P-426`'s
    // review: from the silencing, it read up to an answer's lifetime short), and to the arm's end
    // after its last, so that a refresh never run is counted too.
    const from = silencedAt - wheelStartedAt;
    const end = stoppedAt - wheelStartedAt;
    longestGapMs = 0;
    for (const name of answeringNames) {
      const times = lanes.answeredAt.get(name) ?? [];
      let previous = times.filter((at) => at < from).at(-1) ?? from;
      for (const at of times.filter((at) => at >= from)) {
        longestGapMs = Math.max(longestGapMs, at - previous);
        previous = at;
      }
      longestGapMs = Math.max(longestGapMs, end - previous);
    }
  } else if (arm.silentZone !== undefined) {
    const firsts = answeringNames
      .map((name) => lanes.answeredAt.get(name)?.[0])
      .filter((at): at is number => at !== undefined);
    const ordered = sorted(firsts);
    cached = {
      p50: percentile(ordered, 0.5),
      p95: percentile(ordered, 0.95),
      max: ordered.at(-1) ?? 0,
      never: answeringNames.length - firsts.length,
      of: answeringNames.length,
    };
  }

  const ordered = sorted(jitter);
  return {
    name: arm.name,
    label: arm.label,
    dispatched: wheelStats.dispatched,
    all,
    answering: arm.silentZone === undefined ? undefined : answering,
    silentBefore: arm.warmFirst === true ? silentBefore : undefined,
    silentAfter: arm.warmFirst === true ? silentAfter : undefined,
    pastGrace: graceOver(),
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
    asked,
    kept: resolver.stats().entries,
    lanes: laneStats,
    longestGapMs,
    cached,
    threadPool,
    drainMs,
  };
}

const ms = (value: number): string => `${value.toFixed(0)} ms`;

const said = (label: string, t: Tally): string =>
  `${label}: ${String(t.answered)} of ${String(t.results)} answered, ${String(t.givenUp)} given up, ` +
  `${String(t.other)} failed otherwise; failures took p95 ${ms(percentile(sorted(t.failedMs), 0.95))}`;

function row(run: Run): string {
  const zone: string[] = [];
  if (run.answering !== undefined) zone.push(said('answering zone', run.answering));
  if (run.silentBefore !== undefined)
    zone.push(said('silent zone, kept answers served', run.silentBefore));
  if (run.silentAfter !== undefined) {
    zone.push(
      run.pastGrace
        ? said('silent zone, past the grace', run.silentAfter)
        : 'silent zone, past the grace: not reached (MS_DNS_WARM_MINUTES=7 reaches it)',
    );
  }
  if (run.longestGapMs !== undefined) {
    zone.push(
      `longest an answering name went between answers, from its last before the silence: ${ms(run.longestGapMs)}`,
    );
    if (!run.pastGrace) {
      zone.push(
        'answering zone refreshed within the grace: not asserted (MS_DNS_WARM_MINUTES=7 reaches it)',
      );
    }
  }
  if (run.cached !== undefined) {
    zone.push(
      run.cached.never > 0
        ? `answering names kept, from the wheel's start: ${String(run.cached.never)} of ` +
            `${String(run.cached.of)} not by the arm's end (MS_DNS_COLD_MINUTES=7 reaches them)`
        : `answering names kept, from the wheel's start: all ${String(run.cached.of)}, p50 ` +
            `${ms(run.cached.p50)}, p95 ${ms(run.cached.p95)}, last ${ms(run.cached.max)}`,
    );
  }
  return (
    `      ${run.label}\n` +
    `        ${String(run.dispatched)} dispatched, ${String(run.all.results)} results: ` +
    `${String(run.all.answered)} answered, ${String(run.all.givenUp)} given up, ` +
    `${String(run.all.other)} failed otherwise; refused ${String(run.refused)}, ` +
    `deferred ${String(run.deferred)}, timed out ${String(run.timedOut)}\n` +
    `        jitter p50 ${ms(run.jitter.p50)}, p95 ${ms(run.jitter.p95)}, max ${ms(run.jitter.max)}; ` +
    `check run p95 ${ms(run.runP95)}; drained in ${ms(run.drainMs)}\n` +
    `        Probe Health: lookupsInFlight max ${String(run.inFlightMax)}, last ${String(run.inFlightLast)}; ` +
    `lookupsGivenUp ${String(run.givenUp)}\n` +
    `        resolver: ${String(run.asked)} getaddrinfo, ${String(run.kept)} names kept; ` +
    `lanes: deepest queue ${String(run.lanes.deepest)}, ${String(run.lanes.queued)} still queued, ` +
    `wait p95 ${ms(run.lanes.waitP95)}, busy ${(run.lanes.busy * 100).toFixed(0)}%; ` +
    `thread pool fs.stat p95 ${run.threadPool.p95.toFixed(2)} ms, max ${run.threadPool.max.toFixed(2)} ms` +
    zone.map((line) => `\n        ${line}`).join('')
  );
}

describe('a name lookup a scan, through the probe’s resolver (A-66, P-426)', () => {
  const runs: Run[] = [];

  after(() => {
    process.stdout.write(
      `\n    measured: ${String(SENSORS)} sensors at ${String(INTERVAL_SECONDS)} s on ` +
        `${String(Math.ceil(SENSORS / SENSORS_PER_DEVICE))} devices, ${String(MINUTES)} min an arm ` +
        `(warmzone ${String(INTERVAL_SECONDS)} s answering, then ${String(WARM_MINUTES)} min; ` +
        `zone ${String(COLD_MINUTES)} min), ` +
        `pool ${String(POOL_SIZE)}, queue ${String(QUEUE_MAX)}, ${String(availableParallelism())} cores\n` +
        `    lookup bound ${ms(SNMP_TIMEOUT_MS / 2)} (SNMP's ${ms(SNMP_TIMEOUT_MS)}), ` +
        `check ${ms(MODEL_CHECK_MS)} after it; ${String(LANES)} lookup lanes, the resolver ` +
        `${String(RESOLVER_LANES)}; answers kept ${ms(ANSWER_MS)}, served stale ${ms(STALE_MS)} past expiry; ` +
        `slow ${ms(SLOW_MS)}, silent ${ms(HANG_MS)} then EAI_AGAIN\n` +
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
      // The Probe Health number is the checks' own: each check that failed for want of an answer
      // gave exactly one lookup up, and nothing else gives one up.
      assert.equal(
        run.givenUp,
        run.all.givenUp,
        `lookupsGivenUp read ${String(run.givenUp)}, and ${String(run.all.givenUp)} checks failed for want of an answer`,
      );
      if (arm.name === 'addresses') {
        assert.equal(run.inFlightMax, 0, 'a device given as an address is never resolved');
      }
      if (arm.name === 'system' || arm.name === 'slow') {
        assert.equal(run.givenUp, 0, 'every name answers within its bound: none given up');
        assert.equal(run.refused, 0, 'and no check refused');
      }
      if (arm.name === 'warmzone') {
        assert.equal(run.refused, 0, 'no check refused');
        const answering = run.answering;
        assert.ok(answering !== undefined);
        assert.equal(answering.givenUp, 0, 'every answering name served its kept answer');
        if (run.pastGrace) {
          // Only past the grace can a refresh that was not run in time show: until then every
          // answering name is served what it had (`P-426`'s review).
          assert.equal(answering.other, 0);
          assert.ok(
            (run.longestGapMs ?? 0) < ANSWER_MS + STALE_MS,
            `an answering name went ${ms(run.longestGapMs ?? 0)} between answers, against the ` +
              `${ms(ANSWER_MS + STALE_MS)} its kept answer lasts`,
          );
          const after = run.silentAfter;
          assert.ok(
            after !== undefined && after.results > 0,
            'the silent zone scanned past its grace',
          );
          assert.equal(after.answered, 0, 'nothing served past the grace');
          assert.equal(after.givenUp, after.results, 'every one failed naming the resolver');
          // At once, but for the one check a hold that starts a retry on a free lane: it waits for
          // that lookup, up to its bound, as a check already waiting does (`P-426`'s review).
          const failedMs = sorted(after.failedMs);
          assert.ok(
            percentile(failedMs, 0.5) < AT_ONCE_MS,
            `at once, not at the ${ms(SNMP_TIMEOUT_MS / 2)} bound: p50 ${ms(percentile(failedMs, 0.5))}`,
          );
          assert.ok(
            (failedMs.at(-1) ?? 0) < SNMP_TIMEOUT_MS / 2 + AT_ONCE_MS,
            `none past its bound: ${ms(failedMs.at(-1) ?? 0)}`,
          );
        }
      }
      if (arm.name === 'hung') {
        assert.equal(run.refused, 0, 'every check failed at once, and none was refused');
        const baseline = runs.find(({ name }) => name === 'addresses');
        if (baseline !== undefined) {
          assert.ok(
            run.jitter.p95 <= Math.max(2 * baseline.jitter.p95, baseline.jitter.p95 + 100),
            `jitter p95 ${ms(run.jitter.p95)}, against the address arm's ${ms(baseline.jitter.p95)}`,
          );
        }
      }
    });
  }
});
