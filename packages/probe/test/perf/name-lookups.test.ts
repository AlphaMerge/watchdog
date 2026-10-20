import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { DnsSimulator, replies, type DnsBehaviour } from '@ms/simulators';
import { systemResolve, type ResolvedAddress } from '@ms/sensors';
import { lookupsBesideThePool, ProbeHealthReporter } from '../../src/health/report.js';
import { AnswerFile, answerFilePath } from '../../src/resolver/answer-file.js';
import { caresAsker, KEY_SETTLE_MS, type DnsAsker } from '../../src/resolver/dns-check.js';
import { FORWARD_HOLD_MS, questionsOf } from '../../src/resolver/forward-budget.js';
import type {
  ForkHelper,
  HelperProcess,
  LookupHelperStats,
} from '../../src/resolver/lookup-helper.js';
import { buildNameResolution, type NameResolution } from '../../src/resolver/name-resolution.js';
import {
  ANSWER_MS,
  lookupLanes,
  NameResolver,
  resolverLanes,
  STALE_MS,
  type Family,
} from '../../src/resolver/name-resolver.js';
import type { SystemFiles } from '../../src/resolver/system-names.js';
import type { MemoryCapReading } from '../../src/runner/memory-cap.js';
import { CheckPool, defaultPoolSize } from '../../src/runner/pool.js';
import { TimingWheel } from '../../src/scheduler/wheel.js';
import {
  MODEL_CHECK_MS,
  V1_TARGET_INTERVAL_SECONDS,
  V1_TARGET_SENSORS,
} from '../../src/measured.js';
import {
  GLIBC_QUESTIONS,
  glibcDisagreements,
  glibcLookup,
  glibcSchedule,
  WORLD_ENV,
  type ChildWorld,
  type GlibcTable,
  type ModelAddress,
  type RecordedRows,
  type Recording,
} from '../support/glibc-model.js';
import {
  busiestSecond,
  gapBound,
  heldBound,
  JUDGED_ARMS,
  judgeWorld,
  overBucket,
  type GateMode,
  type Group,
  type WorldFacts,
} from '../support/name-gate-judge.js';
import { pollWithin, within } from '../support/within.js';

/**
 * What a name lookup a scan costs once the probe's resolver keeps answers (`A-66`, `P-426`), and
 * keeps them across a restart (`P-438`).
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
 * | `zonefile` | both | as `zone`, on a probe restarted from the answer file another wrote at stop | every name loaded, the silent zone served what the file kept through its grace, the answering zone never given up, nothing refused; past the grace, the silent zone failing |
 *
 * **The restart** (`zonefile`, `P-438`): the probe before it ran warm, every device's name answered,
 * and wrote its answer file at stop as the zone went silent; the arm's resolver loads that file
 * before the wheel starts, as `main.ts` does before the first scan. Every name is then kept as
 * expired: served while it is asked again, for at most the 5-minute grace. Read it against the
 * `zone` arm, the same restart with no file.
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
 * cold one how long the answering names took to be kept. The silent zone's checks are counted
 * before or past the grace of their own name's kept answer (`P-438`): from its last answer before
 * the silence, or from the answer file's load, as the resolver serves it, and those asked within
 * `EDGE_MS` of it apart, since a check's ask is read back from its result.
 *
 * **Asserted for every arm**: `lookupsGivenUp` is exactly the checks that failed for want of an
 * answer, so the Probe Health number is the one the checks say.
 *
 * Environment: `MS_DNS_SENSORS` (5,000), `MS_DNS_MINUTES` per arm (1), `MS_DNS_SLOW_MS` (100),
 * `MS_DNS_HANG_MS` (30,000), `MS_DNS_LANES` (8), `MS_DNS_POOL` (the shipped ceiling),
 * `MS_DNS_WARM_MINUTES` (the `warmzone` arm's time after its zone goes silent, `MS_DNS_MINUTES`
 * unless set: 7 reaches past the 5-minute grace, and only then are the answering zone's refreshes
 * within it and the silent zone's failing asserted), `MS_DNS_COLD_MINUTES` (the `zone` and
 * `zonefile` arms' time, `MS_DNS_MINUTES` unless set: long enough for every answering name to be
 * kept, or the row says how many were not; 7 takes `zonefile` past the grace), `MS_DNS_ARMS` (a
 * comma list of arm names, all unless set).
 *
 * **The name gate's arms** (`P-432` S7, the design's §7.6), in the second block, run each arm in
 * each mode `MS_DNS_RESOLVER` names (`system`, `gate`, or `system,gate`), and are skipped while it
 * is unset, so a default run is as long as before. They run on a world, not on the lane model:
 * - **the site's DNS server** is the DNS simulator (`@ms/simulators`, in its own worker) as
 *   dnsmasq: `dns-forward-max` 150 with 120 slots held by other clients, a 10 s hold, identical
 *   questions merged (P1 and P2: only a client's own resend, dnsmasq before 2.83, the transient's
 *   worst case). Zone a answers, zone b goes silent or is silent, zone s answers after
 *   `MS_DNS_SLOW_MS`;
 * - **`getaddrinfo`** is a model of glibc's wire (`support/glibc-model.ts`) over real UDP, held to
 *   every recording of glibc's own wire it can play (D30's recording A): A for SNMP's family, a try
 *   every 15 s, two tries, so a silent name gives up at 30 s as the lane model's does;
 * - **the walk** is the shipped check, c-ares asking the simulator; **the helper** the real
 *   `LookupHelper`, forking the real child over the same model (`support/dns-world-child.ts`);
 *   **the policy** the real `GlibcNamePolicy` on files the arm writes; the pool, the wheel and
 *   Probe Health as above.
 *
 * Every assertion is `support/name-gate-judge.ts`'s, a pure function of what the arm measured, and
 * each is shown failing on a run made to break it in the third block, which runs in every
 * `test:perf` with the model's table held to the recordings. The arms: `slow`, `warmzone`, `zone`,
 * `partial`, `steady` and `forwarder` in both modes; `P1` to `P3`, `P5`, `P5b` and `P6`, the
 * helper's, in gate mode.
 * `MS_DNS_ARMS` takes `world/<name>` and `lanes/<name>` where the blocks' names overlap.
 * `MS_DNS_STEADY_MINUTES` (`MS_DNS_MINUTES` unless set, 10 at full size) is `steady`'s time after
 * its scan interval; `MS_DNS_CHECK=off` runs the gate with its name check off for the
 * environment. `docs/findings/2026-10-20-name-lookups-gated.md` has the method and the command.
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
/**
 * The modes the name gate's arms run in (`P-432` S7): `system`, `gate`, or both. Unset, they are
 * skipped and say how to run them, and the lane model's arms run as before.
 */
const RESOLVER_SETTING = process.env['MS_DNS_RESOLVER'];
const MODES: readonly GateMode[] = (RESOLVER_SETTING ?? '')
  .split(',')
  .map((mode) => mode.trim())
  .filter((mode) => mode !== '')
  .map((mode) => {
    if (mode !== 'system' && mode !== 'gate') {
      throw new Error(`MS_DNS_RESOLVER names system and gate, not "${mode}"`);
    }
    return mode;
  });
/** `off` runs the gate's arms with its name check off for the environment (`RES_OPTIONS`). */
const CHECK_OFF = process.env['MS_DNS_CHECK'] === 'off';
/** The `steady` arm's time after its scan interval answering: 10 at full size. */
const STEADY_MINUTES = Number(process.env['MS_DNS_STEADY_MINUTES'] ?? String(MINUTES));
/**
 * Whether `MS_DNS_ARMS` picks an arm: by its name, in either block, or by `lanes/<name>` for the
 * lane model's and `world/<name>` for the gate's, whose names overlap.
 */
const picked = (block: 'lanes' | 'world', name: string): boolean =>
  ARMS.length === 0 || ARMS.includes(name) || ARMS.includes(`${block}/${name}`);
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
/**
 * How near its own name's grace end a silent-zone check is read as on its edge, and counted in
 * neither bucket: a check's ask is read back from its result, its run time before it arrived.
 */
const EDGE_MS = 2_000;

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

  /** When `answeredAt`'s times are from. */
  get startedAt(): number | undefined {
    return this.#startedAt;
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
  /** Started from the answer file a probe that ran warm wrote at stop (`P-438`). */
  readonly fromFile?: boolean;
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
  {
    name: 'zonefile',
    label: 'one zone in ten silent, restarted from the answer file',
    kind: (device) => (oneInTen(device) ? 'hung' : 'ok'),
    silentZone: oneInTen,
    fromFile: true,
  },
];

/**
 * The answer file a probe that ran warm wrote at stop, loaded into `resolver` as the probe loads
 * it before its first scan (`P-438`): how many answers it loaded. The probe before is a resolver
 * of its own that answered every device's name at once, for SNMP's family as
 * `support/lookup-registry.ts` asks it.
 */
async function restartedFrom(arm: Arm, devices: number, resolver: NameResolver): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-perf-answers-'));
  try {
    const path = answerFilePath(dir);
    const before = new NameResolver({
      logger: silent,
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      watch: { files: [], everyMs: 60_000 },
    });
    for (let device = 0; device < devices; device += 1) {
      await before.resolve(host(device, arm.kind(device)), 4, {});
    }
    const saved = await new AnswerFile({ path, resolver: before, logger: silent }).save('stop');
    assert.equal(saved?.saved, devices, 'the probe before wrote every name');
    return await new AnswerFile({ path, resolver, logger: silent }).load();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  /**
   * The silent zone, asked before and after each name's own kept answer could last no longer,
   * and within `EDGE_MS` of it, in the `warmzone` and `zonefile` arms.
   */
  readonly silentBefore: Tally | undefined;
  readonly silentAfter: Tally | undefined;
  readonly silentEdge: Tally | undefined;
  /** Whether the arm ran past every silent name's grace. */
  readonly pastGrace: boolean;
  /** Answers loaded from the answer file before the wheel started, in the `zonefile` arm. */
  readonly answersLoaded: number | undefined;
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
  const silentEdge = tally();
  /** The silent zone's results, each with when its check asked: put in a bucket at the end. */
  const silentResults: {
    readonly device: number;
    readonly askedAt: number;
    readonly outcome: string;
    readonly message: string;
    readonly durationMs: number;
  }[] = [];
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
  /** When the silent zone went silent. */
  let silencedAt: number | undefined;
  /** When the answer file was loaded, in the `zonefile` arm. */
  let loadedAt: number | undefined;

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
          silentResults.push({
            device: deviceOf(result.sensorId),
            askedAt: performance.now() - result.durationMs,
            outcome: result.outcome,
            message: result.message,
            durationMs: result.durationMs,
          });
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
  let answersLoaded: number | undefined;
  try {
    await pool.start();
    // Before the wheel, as the probe loads the file before its first scan.
    if (arm.fromFile === true) {
      answersLoaded = await restartedFrom(arm, devices, resolver);
      loadedAt = performance.now();
    }
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

  // Each silent name's own grace (`P-438`): read from the silencing, a name whose last answer was
  // older ended its grace sooner, and its failures were counted as served.
  const lanesFrom = lanes.startedAt ?? wheelStartedAt;
  const graceEndsAt = (device: number): number => {
    // Loaded as expired, each answer the file kept is served for the grace from the load.
    if (loadedAt !== undefined) return loadedAt + STALE_MS;
    const name = host(device, arm.kind(device));
    const last = (lanes.answeredAt.get(name) ?? [])
      .map((at) => lanesFrom + at)
      .filter((at) => at < (silencedAt ?? 0))
      .at(-1);
    return last === undefined ? (silencedAt ?? 0) : last + ANSWER_MS + STALE_MS;
  };
  for (const result of silentResults) {
    const ends = graceEndsAt(result.device);
    const into =
      result.askedAt < ends - EDGE_MS
        ? silentBefore
        : result.askedAt > ends + EDGE_MS
          ? silentAfter
          : silentEdge;
    count(into, result.outcome, result.message, result.durationMs);
  }
  const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
    (device) => arm.silentZone?.(device) === true,
  );
  const pastGrace =
    silencedAt !== undefined &&
    silentDevices.length > 0 &&
    silentDevices.every((device) => stoppedAt > graceEndsAt(device) + EDGE_MS);

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
    silentBefore: arm.warmFirst === true || arm.fromFile === true ? silentBefore : undefined,
    silentAfter: arm.warmFirst === true || arm.fromFile === true ? silentAfter : undefined,
    silentEdge: arm.warmFirst === true || arm.fromFile === true ? silentEdge : undefined,
    pastGrace,
    answersLoaded,
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
  if (run.answersLoaded !== undefined) {
    zone.push(
      `answers loaded before the wheel started, from the file the probe before wrote at stop: ${String(run.answersLoaded)}`,
    );
  }
  if (run.answering !== undefined) zone.push(said('answering zone', run.answering));
  if (run.silentBefore !== undefined)
    zone.push(said('silent zone, kept answers served', run.silentBefore));
  if (run.silentEdge !== undefined && run.silentEdge.results > 0) {
    zone.push(
      said(
        `silent zone, within ${ms(EDGE_MS)} of a name's grace end, not asserted`,
        run.silentEdge,
      ),
    );
  }
  if (run.silentAfter !== undefined) {
    zone.push(
      run.pastGrace
        ? said('silent zone, past the grace', run.silentAfter)
        : `silent zone, past the grace: not reached (${run.answersLoaded === undefined ? 'MS_DNS_WARM_MINUTES' : 'MS_DNS_COLD_MINUTES'}=7 reaches it)`,
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
    // From the file, each was kept from the start, and what is read is its first fresh answer.
    const kept =
      run.answersLoaded === undefined
        ? 'answering names kept'
        : 'answering names answered afresh, each served from the file until then';
    zone.push(
      run.cached.never > 0
        ? `${kept}, from the wheel's start: ${String(run.cached.never)} of ` +
            `${String(run.cached.of)} not by the arm's end (MS_DNS_COLD_MINUTES=7 reaches them)`
        : `${kept}, from the wheel's start: all ${String(run.cached.of)}, p50 ` +
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

describe('a name lookup a scan, through the probe’s resolver (A-66, P-426, P-438)', () => {
  const runs: Run[] = [];

  after(() => {
    process.stdout.write(
      `\n    measured: ${String(SENSORS)} sensors at ${String(INTERVAL_SECONDS)} s on ` +
        `${String(Math.ceil(SENSORS / SENSORS_PER_DEVICE))} devices, ${String(MINUTES)} min an arm ` +
        `(warmzone ${String(INTERVAL_SECONDS)} s answering, then ${String(WARM_MINUTES)} min; ` +
        `zone and zonefile ${String(COLD_MINUTES)} min), ` +
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
      if (!picked('lanes', arm.name)) {
        t.skip(`MS_DNS_ARMS leaves out "${arm.name}"`);
        return;
      }
      if (RESOLVER_SETTING !== undefined && !MODES.includes('system')) {
        t.skip('MS_DNS_RESOLVER leaves out system, the only mode the lane model runs');
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
      if (arm.name === 'zonefile') {
        // `P-438`: the cold `zone` arm's answering zone gave up 2,251 of 31,500 in the third quiet
        // window, behind the silent zone's first lookups. With the cap the cold arm may reach none
        // too, so the answering zone's none here is read against `zone`'s row, not credited to the
        // file. What only the file does is serve the silent zone what it had, through its grace.
        assert.equal(
          run.answersLoaded,
          Math.ceil(SENSORS / SENSORS_PER_DEVICE),
          'every name the probe before kept, loaded',
        );
        const before = run.silentBefore;
        assert.ok(
          before !== undefined && before.results > 0,
          'the silent zone scanned within its grace',
        );
        assert.equal(
          before.answered,
          before.results,
          'every silent-zone check within its grace served the answer the file kept',
        );
        assert.equal(run.refused, 0, 'no check refused');
        const answering = run.answering;
        assert.ok(answering !== undefined && answering.results > 0, 'the answering zone scanned');
        assert.equal(
          answering.givenUp,
          0,
          'every answering-zone check answered, from the first scan',
        );
        assert.equal(answering.other, 0);
        if (run.pastGrace) {
          const after = run.silentAfter;
          assert.ok(
            after !== undefined && after.results > 0,
            'the silent zone scanned past its grace',
          );
          assert.equal(after.answered, 0, 'nothing served past the grace');
          assert.equal(after.givenUp, after.results, 'every one failed naming the resolver');
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

// ---------------------------------------------------------------------------------------------
// The name gate's arms (`P-432` S7, the design's §7.6)
// ---------------------------------------------------------------------------------------------

const WORLD_CHILD = fileURLToPath(new URL('../support/dns-world-child.js', import.meta.url));
const FIXTURES = (name: string): string =>
  fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url));
/** The site's DNS server, the simulator, on loopback. */
const WORLD_ADDRESS = '127.0.0.1';
/** Where the probe's lanes' `getaddrinfo` asks from, and the helper's: the log tells them apart. */
const PROBE_SOURCE = '127.0.0.2';
const HELPER_SOURCE = '127.0.0.3';
/**
 * The world's resolv.conf: a silent lookup tries twice, 15 s apart, and gives up at 30 s, as the
 * lane model's silent zone does (`MS_DNS_HANG_MS`), in a shape glibc has (RES_MAXRETRY 5). A try
 * every 15 s outlasts the forwarder's 10 s hold of each, so a lookup that gives up holds no slot
 * past its end, and the six lanes are the six slots P-426's bound counts.
 */
const WORLD_TIMEOUT_S = 15;
const WORLD_ATTEMPTS = 2;
const WORLD_SCHEDULE = glibcSchedule(WORLD_TIMEOUT_S, WORLD_ATTEMPTS);
/** dnsmasq's `dns-forward-max`, with other clients holding 120: 30 slots left for the probe. */
const FORWARD_MAX = 150;
const BACKGROUND_SLOTS = 120;
/** SNMP's family: one question a lookup (`questionsOf`). */
const Q = questionsOf(4);
const INTERVAL_MS = INTERVAL_SECONDS * 1_000;
/** The steady window must be this long for its walk rate to be read. */
const STEADY_WINDOW_MIN_MS = 10_000;
/** P3: how long the main thread is held. */
const STALL_MS = 15_000;
/** P5 and P5b: the kills; P5b, the pool's ceiling for memory, a half of its size. */
const RESPAWN_EVERY_MS = 30_000;
const RESPAWN_KILLS = 4;
const RESPAWN_RSS_AT_MS = 55_000;
const MIB = 1024 * 1024;
const WORKER_ESTIMATE_BYTES = 40 * MIB;
/** How long the gate's start may take: the policy, the helper's child, the check's canary. */
const START_BOUND_MS = 60_000;

interface WorldArm {
  readonly name: string;
  readonly label: string;
  readonly modes: readonly GateMode[];
  /** Each device's group: how its zone behaves. */
  readonly group: (device: number) => Group;
  /** Answering for a scan interval first, then the silent group's zone silent. */
  readonly warmFirst?: boolean;
  /** Every answering name slow by `MS_DNS_SLOW_MS`. */
  readonly slow?: boolean;
  /** The silent zone's upstream silent from the start, its cached names answered from cache. */
  readonly cached?: boolean;
  /** The forwarder merges a question only with its own client's resend: dnsmasq before 2.83. */
  readonly perClient?: boolean;
  /** The transient past the bound this arm allows (D16): at a helper loss. */
  readonly transient?: boolean;
  /** The helper's child SIGKILLed `RESPAWN_KILLS` times, `RESPAWN_EVERY_MS` apart (P5, P5b). */
  readonly respawn?: boolean;
  /** The pool's ceiling held to half its size by memory (P5b). */
  readonly memoryGate?: boolean;
  /** The silent names three a key under zone b: a hundred keys at full size (`forwarder`). */
  readonly spreadKeys?: boolean;
  /** How long the wheel runs. */
  readonly runMs: () => number;
  /** What happens to the world while it runs. */
  readonly events?: (world: WorldEvents) => Promise<void>;
}

interface WorldEvents {
  readonly at: (ms: number) => Promise<void>;
  readonly names: NameResolution;
  readonly sim: DnsSimulator;
  readonly pool: CheckPool;
  readonly probe: ProbeSide;
  readonly tap: HelperTap;
  readonly record: WorldRecord;
}

/** What the events found, for the facts. */
interface WorldRecord {
  silencedAt?: number;
  stopped?: { downAt?: number; hungAt?: number; upAt?: number; at: number };
  stall?: { ms: number; lookupInFlight: boolean };
  kills: { at: number; heldBack: boolean; probeRss: number }[];
  helperRssAt60s?: number | undefined;
}

const oneInTenSilent = (device: number): Group => (device % 10 === 0 ? 'silent' : 'answering');
const allAnswering = (): Group => 'answering';

/** P5 and P5b's events: the kills, and the helper's resident set read between the first two. */
async function respawnEvents({ at, names, pool, record }: WorldEvents): Promise<void> {
  for (let kill = 1; kill <= RESPAWN_KILLS; kill += 1) {
    if (kill === 2) {
      await at(RESPAWN_RSS_AT_MS);
      record.helperRssAt60s = names.gate?.helper.stats().rss;
    }
    await at(RESPAWN_EVERY_MS * kill);
    const stats = pool.stats();
    record.kills.push({
      at: performance.now(),
      heldBack: stats.ceiling < stats.maxSize,
      probeRss: process.memoryUsage().rss,
    });
    killChild(names, 'SIGKILL');
  }
}

const WORLD_ARMS: readonly WorldArm[] = [
  {
    name: 'slow',
    label: `${String(SLOW_MS)} ms a lookup, cold`,
    modes: ['system', 'gate'],
    group: allAnswering,
    slow: true,
    runMs: () => MINUTES * 60_000,
  },
  {
    name: 'warmzone',
    label: 'one zone in ten silent after a scan interval answering',
    modes: ['system', 'gate'],
    group: oneInTenSilent,
    warmFirst: true,
    runMs: () => INTERVAL_MS + WARM_MINUTES * 60_000,
  },
  {
    name: 'zone',
    label: 'one zone in ten silent, cold',
    modes: ['system', 'gate'],
    group: oneInTenSilent,
    runMs: () => COLD_MINUTES * 60_000,
  },
  {
    name: 'partial',
    label: 'one zone in ten silent upstream, half its names in the forwarder’s cache, cold',
    modes: ['system', 'gate'],
    group: (device) => (device % 10 !== 0 ? 'answering' : device % 20 === 0 ? 'cached' : 'silent'),
    cached: true,
    runMs: () => COLD_MINUTES * 60_000,
  },
  {
    name: 'steady',
    label: 'every name answering, warm',
    modes: ['system', 'gate'],
    group: allAnswering,
    runMs: () => INTERVAL_MS + STEADY_MINUTES * 60_000,
  },
  {
    name: 'P1',
    label: 'P1: the helper’s child SIGKILLed at 5 s and 95 s, one zone in ten silent',
    modes: ['gate'],
    group: oneInTenSilent,
    perClient: true,
    transient: true,
    runMs: () => 130_000,
    events: async ({ at, names }) => {
      for (const ms of [5_000, 95_000]) {
        await at(ms);
        killChild(names, 'SIGKILL');
      }
    },
  },
  {
    name: 'P2',
    label: 'P2: the helper’s child SIGSTOPped at 10 s, one zone in ten silent',
    modes: ['gate'],
    group: oneInTenSilent,
    perClient: true,
    transient: true,
    runMs: () => 60_000,
    events: async ({ at, names, record }) => {
      await at(10_000);
      const helper = names.gate?.helper;
      if (helper === undefined) return;
      const stopped: NonNullable<WorldRecord['stopped']> = { at: performance.now() };
      record.stopped = stopped;
      killChild(names, 'SIGSTOP');
      // The judge says which of the three never came: a bound passed here is not a failure.
      await pollWithin(
        40_000,
        'the stopped child replaced and the next up',
        () => {
          const now = performance.now();
          const stats = helper.stats();
          if (stopped.downAt === undefined && stats.route !== 'up') stopped.downAt = now;
          if (stopped.hungAt === undefined && stats.lossesByReason.hung > 0) stopped.hungAt = now;
          if (stopped.hungAt !== undefined && stopped.upAt === undefined && stats.state === 'up') {
            stopped.upAt = now;
          }
          return stopped.upAt !== undefined;
        },
        50,
      ).catch(() => undefined);
    },
  },
  {
    name: 'P3',
    label: `P3: the probe’s main thread held ${String(STALL_MS / 1_000)} s at 40 s, one zone in ten silent`,
    modes: ['gate'],
    group: oneInTenSilent,
    runMs: () => 70_000,
    events: async ({ at, probe, record }) => {
      await at(40_000);
      // Held from the moment a probe-lane lookup of an answering name has sent its question, so
      // that its reply is in the socket, and its stuck timer due, all through the stall. None in
      // the next 10 s is a run the judge fails.
      const triggered = new Promise<void>((resolve) => {
        probe.onSent = (group) => {
          if (group !== 'answering' || record.stall !== undefined) return;
          probe.onSent = undefined;
          const lookupInFlight = probe.inFlight() > 0;
          const from = performance.now();
          while (performance.now() - from < STALL_MS) {
            // The probe's main thread, busy: nothing else in this process runs.
          }
          record.stall = { ms: performance.now() - from, lookupInFlight };
          resolve();
        };
      });
      await Promise.race([triggered, at(50_000)]);
      probe.onSent = undefined;
    },
  },
  {
    name: 'P5',
    label: `P5: the helper’s child SIGKILLed ${String(RESPAWN_KILLS)} times ${String(RESPAWN_EVERY_MS / 1_000)} s apart, the pool at its full size`,
    modes: ['gate'],
    group: allAnswering,
    respawn: true,
    runMs: () => RESPAWN_EVERY_MS * (RESPAWN_KILLS + 1),
    events: respawnEvents,
  },
  {
    name: 'P5b',
    label: `P5b: the helper’s child SIGKILLed ${String(RESPAWN_KILLS)} times ${String(RESPAWN_EVERY_MS / 1_000)} s apart, the pool at its memory gate`,
    modes: ['gate'],
    group: allAnswering,
    respawn: true,
    memoryGate: true,
    runMs: () => RESPAWN_EVERY_MS * (RESPAWN_KILLS + 1),
    events: respawnEvents,
  },
  {
    name: 'forwarder',
    label:
      'three names in five silent, a hundred keys of three, at a forwarder that merges per client',
    modes: ['system', 'gate'],
    group: (device) => (device % 5 < 3 ? 'silent' : 'answering'),
    perClient: true,
    spreadKeys: true,
    runMs: () => COLD_MINUTES * 60_000,
  },
  {
    name: 'P6',
    label: 'P6: one name whose getaddrinfo crashes the helper’s child, its zone silent',
    modes: ['gate'],
    group: (device) => (device === 0 ? 'crash' : 'answering'),
    runMs: () => Math.max(1, MINUTES) * 60_000,
  },
];

function killChild(names: NameResolution, signal: NodeJS.Signals): void {
  const pid = names.gate?.helper.pid();
  if (pid === undefined) throw new Error(`no helper child to send ${signal}`);
  process.kill(pid, signal);
}

/** A device's name in the world: its zone by its group, and the slow arm's own. */
function worldHost(arm: WorldArm, device: number): string {
  const group = arm.group(device);
  if (group === 'crash') return `crash-${String(device)}.zone-c.test`;
  if (arm.spreadKeys === true) {
    // Devices 5k to 5k + 2 share the key `d:k<k>.zone-b.test`: 300 silent names over 100 keys.
    return group === 'silent'
      ? `dev-${String(device)}.k${String(Math.floor(device / 5))}.zone-b.test`
      : `dev-${String(device)}.zone-a.test`;
  }
  const zone = group === 'answering' ? (arm.slow === true ? 's' : 'a') : 'b';
  // In the warm and every-name-answering arms, one name in ten is in zone b too, so that there
  // are two keys to refresh, and the warm arm's silence is a zone's.
  const inB = group !== 'answering' || (arm.slow !== true && device % 10 === 0);
  return `dev-${String(device)}.zone-${inB ? 'b' : zone}.test`;
}

/** What each zone does at the start. */
function worldZones(arm: WorldArm): Record<string, DnsBehaviour> {
  const answer = (address: string): DnsBehaviour => ({ reply: replies.addresses(address) });
  const coldSilent = arm.warmFirst !== true && WORLD_ARMS_SILENT.has(arm.name);
  return {
    'zone-a.test': answer('192.0.2.10'),
    'zone-s.test': { reply: replies.addresses('192.0.2.20'), delayMs: SLOW_MS },
    'zone-b.test': coldSilent ? { reply: replies.silent } : answer('192.0.2.11'),
    'zone-c.test': { reply: replies.silent },
  };
}

/** The arms whose zone b is silent from the start. */
const WORLD_ARMS_SILENT = new Set(['zone', 'partial', 'forwarder', 'P1', 'P2', 'P3']);

/** The probe's own lanes' `getaddrinfo`: the model, counted by group, and never the crash name. */
class ProbeSide {
  readonly calls: Partial<Record<Group, number>> = {};
  readonly peak: Partial<Record<Group, number>> = {};
  readonly #running: Partial<Record<Group, number>> = {};
  /** When each name was answered with addresses. */
  readonly answeredAt = new Map<string, number[]>();
  crashes = 0;
  onSent: ((group: Group) => void) | undefined;
  readonly #model: (host: string, family: Family) => Promise<readonly ModelAddress[]>;
  readonly #groupOf: (host: string) => Group;

  constructor(port: number, groupOf: (host: string) => Group) {
    this.#groupOf = groupOf;
    this.#model = glibcLookup({
      server: { address: WORLD_ADDRESS, port },
      localAddress: PROBE_SOURCE,
      schedule: WORLD_SCHEDULE,
      onSent: (host) => this.onSent?.(this.#groupOf(host)),
    });
  }

  inFlight(): number {
    return Object.values(this.#running).reduce((sum, n) => sum + n, 0);
  }

  readonly lookup = async (host: string, family: Family): Promise<readonly ResolvedAddress[]> => {
    const group = this.#groupOf(host);
    this.calls[group] = (this.calls[group] ?? 0) + 1;
    if (group === 'crash') {
      // The probe's own getaddrinfo would have crashed it (D27): counted, never asked.
      this.crashes += 1;
      throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' });
    }
    this.#running[group] = (this.#running[group] ?? 0) + 1;
    this.peak[group] = Math.max(this.peak[group] ?? 0, this.#running[group]);
    try {
      const found = await this.#model(host, family);
      const times = this.answeredAt.get(host) ?? [];
      times.push(performance.now());
      this.answeredAt.set(host, times);
      return found.map(({ address, family: f }) => ({ address, family: f === 6 ? 6 : 4 }));
    } finally {
      this.#running[group] = (this.#running[group] ?? 1) - 1;
    }
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The real helper's child, forked as the helper forks it, with what it is asked and what it says
 * read off the channel on the way: its lookups in flight by group, its answers, and each child's
 * fork and `ready` (P5b). Nothing the helper sends or reads is changed.
 */
class HelperTap {
  readonly peak: Partial<Record<Group, number>> = {};
  readonly answeredAt = new Map<string, number[]>();
  readonly children: { readonly forkedAt: number; readyAt?: number }[] = [];
  stuck = 0;
  readonly #groupOf: (host: string) => Group;
  readonly #flights = new Map<number, { readonly host: string; readonly child: number }>();
  readonly #running: Partial<Record<Group, number>> = {};

  constructor(groupOf: (host: string) => Group) {
    this.#groupOf = groupOf;
  }

  #end(id: number): void {
    const flight = this.#flights.get(id);
    if (flight === undefined) return;
    this.#flights.delete(id);
    const group = this.#groupOf(flight.host);
    this.#running[group] = (this.#running[group] ?? 1) - 1;
  }

  readonly fork: ForkHelper = (module, args, options) => {
    const child = fork(module, [...args], options);
    const index = this.children.length;
    const record: { readonly forkedAt: number; readyAt?: number } = {
      forkedAt: performance.now(),
    };
    this.children.push(record);
    child.on('message', (raw: unknown) => {
      if (!isRecord(raw)) return;
      if (raw['t'] === 'ready') record.readyAt ??= performance.now();
      if (raw['t'] === 'stuck') this.stuck += 1;
      if (raw['t'] !== 'answer' || typeof raw['id'] !== 'number') return;
      const flight = this.#flights.get(raw['id']);
      if (flight !== undefined && raw['ok'] === true) {
        const times = this.answeredAt.get(flight.host) ?? [];
        times.push(performance.now());
        this.answeredAt.set(flight.host, times);
      }
      this.#end(raw['id']);
    });
    child.on('exit', () => {
      for (const [id, flight] of this.#flights) if (flight.child === index) this.#end(id);
    });
    const tapped: HelperProcess = {
      get pid() {
        return child.pid;
      },
      stderr: child.stderr,
      channel: child.channel,
      send: (message, callback) => {
        const group = this.#groupOf(message.host);
        this.#flights.set(message.id, { host: message.host, child: index });
        this.#running[group] = (this.#running[group] ?? 0) + 1;
        this.peak[group] = Math.max(this.peak[group] ?? 0, this.#running[group]);
        return child.send(message, callback);
      },
      kill: (signal) => child.kill(signal),
      unref: () => {
        child.unref();
      },
      on(event: string, listener: (...args: never[]) => void): unknown {
        child.on(event, listener as (...args: unknown[]) => void);
        return tapped;
      },
    };
    return tapped;
  };
}

/** Every question the name check sends, by server, with when it was sent. */
class WalkCounter {
  readonly sends = new Map<string, number[]>();

  wrap(inner: DnsAsker): DnsAsker {
    return {
      channel: (server) => {
        const channel = inner.channel(server);
        return {
          ask: (name, type) => {
            const times = this.sends.get(server) ?? [];
            times.push(performance.now());
            this.sends.set(server, times);
            return channel.ask(name, type);
          },
          close: () => {
            channel.close();
          },
        };
      },
    };
  }

  all(): number[] {
    return [...this.sends.values()].flat();
  }
}

interface Routed {
  readonly at: number;
  readonly host: string;
  readonly route: string;
  readonly pool: string;
  readonly why: string | undefined;
  readonly key: string;
}

/** The gate's log, at debug: each lookup's route (§1.3), and the warnings the arms count. */
class GateLog {
  readonly routed: Routed[] = [];
  readonly passedStuck: string[] = [];
  unsafe = 0;
  readonly errors: string[] = [];
  readonly stream = {
    write: (line: string): void => {
      if (line.includes('"msg":"routed a lookup"')) {
        const said = JSON.parse(line) as Record<string, unknown>;
        this.routed.push({
          at: performance.now(),
          host: String(said['host']),
          route: String(said['route']),
          pool: String(said['pool']),
          why: typeof said['why'] === 'string' ? said['why'] : undefined,
          key: String(said['key']),
        });
        return;
      }
      if (line.includes('ran past the bound for stuck on the probe’s lanes')) {
        const said = JSON.parse(line) as Record<string, unknown>;
        this.passedStuck.push(String(said['host']));
      }
      if (line.includes('walked by none for 5 minutes')) this.unsafe += 1;
      if (/"level":(50|60)/u.test(line)) {
        const said = JSON.parse(line) as Record<string, unknown>;
        this.errors.push(String(said['msg']));
      }
    },
  };
}

interface WorldTally {
  results: number;
  answered: number;
  givenUp: number;
  other: number;
}

interface WorldRun {
  readonly arm: WorldArm;
  readonly mode: GateMode;
  /** Check results, every group. */
  readonly results: number;
  readonly facts: WorldFacts;
  readonly lines: readonly string[];
}

/** `monitorEventLoopDelay`'s resolution: what it records is each timer's delta, this included. */
const DELAY_RESOLUTION_MS = 10;
/** A recorded delta as the loop's delay past the resolution. */
const lagMs = (nanoseconds: number): string =>
  `${Math.max(0, nanoseconds / 1e6 - DELAY_RESOLUTION_MS).toFixed(1)} ms`;

async function worldSoak(arm: WorldArm, mode: GateMode): Promise<WorldRun> {
  const devices = Math.ceil(SENSORS / SENSORS_PER_DEVICE);
  const deviceOf = (sensorId: number): number =>
    Math.floor((sensorId - 1) / SENSORS_PER_DEVICE) % devices;
  const groupByHost = new Map<string, Group>();
  const deviceByHost = new Map<string, number>();
  for (let device = 0; device < devices; device += 1) {
    groupByHost.set(worldHost(arm, device), arm.group(device));
    deviceByHost.set(worldHost(arm, device), device);
  }
  const groupOf = (host: string): Group => groupByHost.get(host.toLowerCase()) ?? 'answering';

  const sim = await DnsSimulator.start({
    servers: [
      {
        name: 'ns1',
        address: WORLD_ADDRESS,
        forwarder: {
          forwardMax: FORWARD_MAX,
          holdMs: FORWARD_HOLD_MS,
          merge: arm.perClient === true ? 'client' : 'question',
          ...(arm.perClient === true ? { whenFull: 'silent' as const } : {}),
        },
        cache: arm.cached === true,
      },
    ],
    zones: worldZones(arm),
    ipv6: false,
    logLimit: 2_000_000,
  });
  const dir = await mkdtemp(join(tmpdir(), 'ms-perf-gate-'));
  const tallies: Record<Group | 'all', WorldTally> = {
    all: { results: 0, answered: 0, givenUp: 0, other: 0 },
    answering: { results: 0, answered: 0, givenUp: 0, other: 0 },
    silent: { results: 0, answered: 0, givenUp: 0, other: 0 },
    cached: { results: 0, answered: 0, givenUp: 0, other: 0 },
    crash: { results: 0, answered: 0, givenUp: 0, other: 0 },
  };
  const asks = new Map<number, number[]>();
  const jitter: number[] = [];
  const run: number[] = [];
  const lateBySensor = new Map<number, number>();
  const record: WorldRecord = { kills: [] };
  const walks = new WalkCounter();
  const log = new GateLog();
  const tap = new HelperTap(groupOf);
  const delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  const lags: { readonly at: number; readonly ms: number }[] = [];
  let names: NameResolution | undefined;
  let pool: CheckPool | undefined;
  let wheel: TimingWheel | undefined;
  let sampler: NodeJS.Timeout | undefined;
  let lagSampler: NodeJS.Timeout | undefined;
  let inFlightMax = 0;
  try {
    await sim.occupy(BACKGROUND_SLOTS, 'ns1');
    const { port } = sim.server('ns1');
    if (arm.cached === true) {
      const cached = [...groupByHost].filter(([, group]) => group === 'cached');
      await sim.prime(
        cached.map(([name]) => ({ name, addresses: ['192.0.2.12'], ttl: 7_200 })),
        'ns1',
      );
    }
    const files: SystemFiles = {
      hosts: join(dir, 'hosts'),
      resolvConf: join(dir, 'resolv.conf'),
      nsswitchConf: join(dir, 'nsswitch.conf'),
      gaiConf: join(dir, 'gai.conf'),
      ldSoPreload: join(dir, 'ld.so.preload'),
      nscdSocket: join(dir, 'nscd.socket'),
    };
    await writeFile(files.hosts, '127.0.0.1 localhost\n');
    await writeFile(
      files.resolvConf,
      `nameserver ${WORLD_ADDRESS}\noptions timeout:${String(WORLD_TIMEOUT_S)} attempts:${String(WORLD_ATTEMPTS)}\n`,
    );
    await writeFile(files.nsswitchConf, 'hosts: files dns\n');
    const probe = new ProbeSide(port, groupOf);
    const world: ChildWorld = {
      server: { address: WORLD_ADDRESS, port },
      localAddress: HELPER_SOURCE,
      schedule: WORLD_SCHEDULE,
      ...(arm.name === 'P6' ? { crash: '^crash-' } : {}),
    };
    const built = buildNameResolution({
      mode,
      logger: pino({ level: 'debug' }, log.stream),
      lanes: RESOLVER_LANES,
      spoolDir: dir,
      helper: {
        childModule: WORLD_CHILD,
        env: { ...process.env, [WORLD_ENV]: JSON.stringify(world) },
        fork: tap.fork,
      },
      policy: { files, platform: 'linux', env: CHECK_OFF ? { RES_OPTIONS: 'ndots:1' } : {} },
      check: { asker: walks.wrap(caresAsker({ port })) },
      resolver: {
        lookup: probe.lookup,
        watch: {
          files: [
            files.hosts,
            files.resolvConf,
            files.nsswitchConf,
            files.gaiConf,
            files.ldSoPreload,
          ],
          everyMs: 60_000,
        },
      },
    });
    names = built;
    await within(START_BOUND_MS, 'the names’ start', built.start());
    if (mode === 'gate') {
      // On and proven by its canary, or off for the environment as `MS_DNS_CHECK` says.
      const wanted = CHECK_OFF ? 2 : 1;
      await pollWithin(
        START_BOUND_MS,
        () =>
          `the check in state ${String(wanted)}: ${String(built.resolver.gateHealth()?.checkState)}`,
        () => built.resolver.gateHealth()?.checkState === wanted,
        10,
      );
    }

    const count = (into: WorldTally, outcome: string, message: string): void => {
      into.results += 1;
      if (outcome === 'ok') into.answered += 1;
      else if (GIVEN_UP.test(message)) into.givenUp += 1;
      else into.other += 1;
    };
    const ceiling = Math.max(2, Math.ceil(POOL_SIZE / 2));
    const checks = new CheckPool({
      logger: silent,
      size: POOL_SIZE,
      minSize: arm.memoryGate === true ? Math.min(4, POOL_SIZE) : POOL_SIZE,
      queueMaxLength: QUEUE_MAX,
      registryModule: REGISTRY,
      resolver: built.resolver,
      ...(arm.memoryGate === true
        ? {
            // The probe at its memory gate (L-N5): memory has room for half the pool's workers.
            memoryCap: {
              read: (): MemoryCapReading => ({
                workers: ceiling,
                availableBytes: ceiling * WORKER_ESTIMATE_BYTES,
                totalBytes: 4 * POOL_SIZE * WORKER_ESTIMATE_BYTES,
                reserveBytes: 0,
                perWorkerBytes: WORKER_ESTIMATE_BYTES,
                source: 'limit',
              }),
            },
          }
        : {}),
      onResult: (result, meta) => {
        const device = deviceOf(result.sensorId);
        const group = arm.group(device);
        count(tallies.all, result.outcome, result.message);
        count(tallies[group], result.outcome, result.message);
        const times = asks.get(device) ?? [];
        times.push(performance.now() - result.durationMs);
        asks.set(device, times);
        run.push(result.durationMs);
        const wheelMs = lateBySensor.get(result.sensorId);
        if (wheelMs === undefined) return;
        lateBySensor.delete(result.sensorId);
        jitter.push(wheelMs + meta.waitMs);
      },
    });
    pool = checks;
    await checks.start();
    const epochNs = process.hrtime.bigint();
    const ticking = new TimingWheel({
      logger: silent,
      onDue: (due, tick) => {
        const idealNs = epochNs + BigInt(tick) * 1_000_000_000n;
        const wheelMs = Number(process.hrtime.bigint() - idealNs) / 1e6;
        for (const sensorId of due) {
          if (
            checks.submit({
              sensorId,
              sensorType: 'test.named',
              target: { host: worldHost(arm, deviceOf(sensorId)), ipVersion: 'auto' },
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
    const health = new ProbeHealthReporter({
      scheduler: () => ticking.stats(),
      pool: () => checks.stats(),
      lookups: lookupsBesideThePool({ lookupCounters: () => undefined }, built.resolver),
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
    if (arm.respawn === true) {
      // How late a 10 ms timer is, every 10 ms: the main thread's block at each fork (P5, P5b).
      let expected = performance.now() + 10;
      lagSampler = setInterval(() => {
        const now = performance.now();
        lags.push({ at: now, ms: Math.max(0, now - expected) });
        expected = now + 10;
      }, 10);
    }

    const startedAt = performance.now();
    const at = async (ms: number): Promise<void> => {
      const left = startedAt + ms - performance.now();
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    };
    delay.enable();
    ticking.start();
    if (arm.warmFirst === true) {
      await at(INTERVAL_MS);
      await sim.silence('zone-b.test');
      record.silencedAt = performance.now();
    }
    await arm.events?.({ at, names: built, sim, pool: checks, probe, tap, record });
    await at(arm.runMs());
    ticking.stop();
    delay.disable();
    const stoppedAt = performance.now();
    const drainStarted = performance.now();
    await pollWithin(
      DRAIN_BOUND_MS,
      () =>
        `the pool to drain: ${JSON.stringify({ queued: checks.stats().queued, busy: checks.stats().busy })}`,
      () => checks.stats().queued === 0 && checks.stats().busy === 0,
      50,
    );
    const drainMs = performance.now() - drainStarted;
    const report = health.report();
    const stats = checks.stats();
    const wheelStats = ticking.stats();
    const gauge = (await sim.gauge('ns1'))[0];
    const queries = await sim.log();
    const gateHealth = built.resolver.gateHealth();
    const helperStats: LookupHelperStats | undefined = built.gate?.helper.stats();
    const trouble = built.gate?.latch.value() ?? 0;
    const budgetPeak = built.questionsPeak?.peek();

    // --- The facts ---------------------------------------------------------------------------
    const answers = (host: string): number[] =>
      [...(probe.answeredAt.get(host) ?? []), ...(tap.answeredAt.get(host) ?? [])].sort(
        (a, b) => a - b,
      );
    const longestAskGap = (device: number): number => {
      const times = [...(asks.get(device) ?? [])].sort((a, b) => a - b);
      let longest = 0;
      for (let i = 1; i < times.length; i += 1) {
        longest = Math.max(longest, (times[i] ?? 0) - (times[i - 1] ?? 0));
      }
      return longest;
    };
    const answeringHosts = [...groupByHost]
      .filter(([, group]) => group === 'answering')
      .map(([host]) => host);
    let afterSilence: WorldFacts['afterSilence'];
    let gapsOver: string[] | undefined;
    let longestGap = 0;
    const silencedAt = record.silencedAt;
    if (silencedAt !== undefined) {
      const after = log.routed.filter(
        (routed) =>
          routed.at >= silencedAt && routed.pool === 'probe' && groupOf(routed.host) === 'silent',
      );
      afterSilence = {
        sampled: after.filter(({ route }) => route === 'sampled').length,
        other: after.filter(({ route }) => route !== 'sampled').length,
      };
      gapsOver = [];
      for (const host of answeringHosts) {
        const times = answers(host);
        let previous = times.filter((time) => time < silencedAt).at(-1) ?? silencedAt;
        let longest = 0;
        for (const time of times.filter((t) => t >= silencedAt)) {
          longest = Math.max(longest, time - previous);
          previous = time;
        }
        longest = Math.max(longest, stoppedAt - previous);
        longestGap = Math.max(longestGap, longest);
        const bound = gapBound(longestAskGap(deviceByHost.get(host) ?? -1));
        if (longest > bound) gapsOver.push(`${host}, ${ms(longest)} against ${ms(bound)}`);
      }
    }
    let steady: WorldFacts['steady'];
    const steadyFrom =
      arm.name === 'warmzone' && silencedAt !== undefined
        ? silencedAt + KEY_SETTLE_MS
        : arm.name === 'steady'
          ? startedAt + INTERVAL_MS + ANSWER_MS
          : undefined;
    if (steadyFrom !== undefined) {
      const windowMs = stoppedAt - steadyFrom;
      if (windowMs < STEADY_WINDOW_MIN_MS) {
        steady = {
          notReached:
            arm.name === 'steady'
              ? 'MS_DNS_STEADY_MINUTES=10 reaches it'
              : 'MS_DNS_WARM_MINUTES=7 reaches it',
        };
      } else {
        const sends = walks.all().filter((time) => time >= steadyFrom && time <= stoppedAt);
        steady = { perSecond: sends.length / (windowMs / 1_000), keys: 2 };
      }
    }
    let keptLate: string[] | undefined;
    let keptLast = 0;
    if (arm.name === 'zone') {
      keptLate = [];
      for (const host of answeringHosts) {
        const first = [...(asks.get(deviceByHost.get(host) ?? -1) ?? [])].sort((a, b) => a - b)[0];
        if (first === undefined) continue;
        const kept = answers(host)[0];
        if (kept === undefined) keptLate.push(`${host}, never`);
        else {
          keptLast = Math.max(keptLast, kept - first);
          if (kept - first > 1_000)
            keptLate.push(`${host}, ${ms(kept - first)} after its first ask`);
        }
      }
    }
    const forks = tap.children.slice(1);
    const respawn: WorldFacts['respawn'] =
      arm.respawn === true
        ? {
            kills: record.kills.length,
            heldAtEveryKill: record.kills.length > 0 && record.kills.every((kill) => kill.heldBack),
            forkToReadyMs: forks
              .filter((child) => child.readyAt !== undefined)
              .map((child) => (child.readyAt ?? 0) - child.forkedAt),
            lagAroundForkMs: forks.map((child) =>
              Math.max(
                0,
                ...lags
                  .filter(({ at: when }) => Math.abs(when - child.forkedAt) <= 1_000)
                  .map(({ ms: late }) => late),
              ),
            ),
            lagBaselineMs: Math.max(
              0,
              ...lags
                .filter(
                  ({ at: when }) =>
                    when >= startedAt + 10_000 && when < startedAt + RESPAWN_EVERY_MS,
                )
                .map(({ ms: late }) => late),
            ),
            helperRssAt60s: record.helperRssAt60s,
          }
        : undefined;
    const stopped = record.stopped;
    const facts: WorldFacts = {
      arm: arm.name,
      mode,
      checkOn: !CHECK_OFF,
      q: Q,
      peakHeld: gauge?.peakHeldByClass['other'] ?? 0,
      transient: arm.transient === true ? 8 * Q : 0,
      dropped: gauge?.dropped ?? 0,
      walkSends: walks.sends,
      givenUp: {
        answering: tallies.answering.givenUp,
        silent: tallies.silent.givenUp,
        cached: tallies.cached.givenUp,
        crash: tallies.crash.givenUp,
      },
      refused: stats.refused,
      probeLanes: probe.calls,
      helperPeak: tap.peak,
      ...(afterSilence === undefined ? {} : { afterSilence }),
      ...(gapsOver === undefined ? {} : { gapsOver }),
      ...(steady === undefined ? {} : { steady }),
      ...(keptLate === undefined ? {} : { keptLate }),
      ...(helperStats === undefined
        ? {}
        : {
            helper: {
              losses: helperStats.lossesByReason,
              poisoned: helperStats.poisoned,
              trouble,
              unresponsiveMs: Math.round(helperStats.msInState.unresponsive),
            },
          }),
      ...(stopped === undefined
        ? {}
        : {
            stopped: {
              downAfterMs: stopped.downAt === undefined ? undefined : stopped.downAt - stopped.at,
              hungAfterMs: stopped.hungAt === undefined ? undefined : stopped.hungAt - stopped.at,
              upAfterMs: stopped.upAt === undefined ? undefined : stopped.upAt - stopped.at,
            },
          }),
      ...(record.stall === undefined
        ? {}
        : {
            stall: {
              ...record.stall,
              unsafeMarks: log.unsafe,
              passedStuck: log.passedStuck.filter((host) => groupOf(host) === 'answering').length,
            },
          }),
      ...(respawn === undefined ? {} : { respawn }),
      ...(arm.name === 'P6' ? { probeCrashes: probe.crashes } : {}),
    };

    // --- What is printed ---------------------------------------------------------------------
    const ordered = sorted(jitter);
    const sources = new Map<string, number>();
    for (const query of queries) {
      sources.set(query.client.address, (sources.get(query.client.address) ?? 0) + 1);
    }
    const routes = new Map<string, number>();
    const heardKeys = new Set<string>();
    const silentKeys = new Set<string>();
    for (const routed of log.routed) {
      const kind = `${routed.route}${routed.why === undefined ? '' : `(${routed.why})`}/${routed.pool}`;
      routes.set(kind, (routes.get(kind) ?? 0) + 1);
      if (routed.route === 'heard' || routed.route === 'sampled') heardKeys.add(routed.key);
      if (routed.route === 'silent') silentKeys.add(routed.key);
    }
    const mixed = [...heardKeys].filter((key) => silentKeys.has(key)).length;
    const groups = (of: Partial<Record<Group, number>>): string =>
      (['answering', 'silent', 'cached', 'crash'] as const)
        .filter((group) => (of[group] ?? 0) > 0)
        .map((group) => `${group} ${String(of[group])}`)
        .join(', ') || 'none';
    const walkSends = walks.all();
    const tally = (label: string, t: WorldTally): string =>
      `${label} ${String(t.answered)} of ${String(t.results)} answered, ${String(t.givenUp)} given up, ${String(t.other)} failed otherwise`;
    const lines = [
      `${arm.label}: ${mode}${mode === 'gate' && CHECK_OFF ? ' (check off)' : ''}`,
      `${String(wheelStats.dispatched)} dispatched; ${tally('all', tallies.all)}; refused ${String(stats.refused)}, deferred ${String(stats.deferred)}, timed out ${String(stats.timedOut)}`,
      (['answering', 'silent', 'cached', 'crash'] as const)
        .filter((group) => tallies[group].results > 0)
        .map((group) => tally(group, tallies[group]))
        .join('; '),
      `jitter p50 ${ms(percentile(ordered, 0.5))}, p95 ${ms(percentile(ordered, 0.95))}, max ${ms(ordered.at(-1) ?? 0)}; check run p95 ${ms(percentile(sorted(run), 0.95))}; drained in ${ms(drainMs)}`,
      `event loop: p50 ${lagMs(delay.percentile(50))}, p99 ${lagMs(delay.percentile(99))}, max ${lagMs(delay.max)}`,
      `Probe Health: lookupsInFlight max ${String(Math.max(inFlightMax, report.lookupsInFlight ?? 0))}, last ${String(report.lookupsInFlight)}; lookupsGivenUp ${String(report.lookupsGivenUp)}`,
      `forwarder: the probe's most slots held at once ${String(facts.peakHeld)}, bound ${String(heldBound(facts))}; dropped ${String(facts.dropped)}; questions by source: walk ${String(sources.get(WORLD_ADDRESS) ?? 0)}, probe lanes ${String(sources.get(PROBE_SOURCE) ?? 0)}, helper ${String(sources.get(HELPER_SOURCE) ?? 0)}${budgetPeak === undefined ? '' : `; the budget's questionsOpen peak ${String(budgetPeak)}`}`,
      `walk: ${String(walkSends.length)} questions, busiest second ${String(busiestSecond(walkSends))}, past D19's bucket ${String(overBucket(walkSends))}${facts.steady === undefined ? '' : 'notReached' in facts.steady ? `; steady state not reached (${facts.steady.notReached})` : `; steady state ${facts.steady.perSecond.toFixed(2)} a second`}`,
      mode === 'gate'
        ? `routes: ${[...routes].map(([kind, n]) => `${kind} ${String(n)}`).join(', ') || 'none'}; sampled ${String(routes.get('sampled/probe') ?? 0)}; keys routed both heard and silent ${String(mixed)}`
        : 'routes: every lookup on the probe’s lanes (system)',
      `getaddrinfo on the probe's lanes: ${groups(probe.calls)} (most at once ${groups(probe.peak)}); in the helper's child, most at once: ${groups(tap.peak)}`,
      ...(gateHealth === undefined
        ? []
        : [
            `gate: lookupsHeard ${String(gateHealth.lookupsHeard)}, lookupsToHelper ${String(gateHealth.lookupsToHelper)}, passedStuck ${String(gateHealth.passedStuck)}, helperStuck ${String(gateHealth.helperStuck)}, misses ${String(gateHealth.misses)}, walksDeferred ${String(gateHealth.walksDeferred)}, checkState ${String(gateHealth.checkState)}`,
          ]),
      ...(helperStats === undefined
        ? []
        : [
            `helper: ${helperStats.state}, losses ${JSON.stringify(helperStats.lossesByReason)}, poisoned ${String(helperStats.poisoned)}, children ${String(tap.children.length)}, stuck said ${String(tap.stuck)}, rss peak ${(helperStats.rssPeak / MIB).toFixed(0)} MiB; lookupHelperTrouble ${String(trouble)}`,
          ]),
      ...(afterSilence === undefined
        ? []
        : [
            `after the silence, the silent zone on the probe's lanes: ${String(afterSilence.sampled)} sampled, ${String(afterSilence.other)} otherwise; the longest an answering name went between answers ${ms(longestGap)}`,
          ]),
      ...(keptLate === undefined
        ? []
        : [
            `answering names kept within 1 s of their first ask: the latest ${ms(keptLast)}, ${String(keptLate.length)} late`,
          ]),
      ...(stopped === undefined
        ? []
        : [
            `from the SIGSTOP: route down ${facts.stopped?.downAfterMs === undefined ? 'never' : ms(facts.stopped.downAfterMs)}, hung ${facts.stopped?.hungAfterMs === undefined ? 'never' : ms(facts.stopped.hungAfterMs)}, up ${facts.stopped?.upAfterMs === undefined ? 'never' : ms(facts.stopped.upAfterMs)}`,
          ]),
      ...(facts.stall === undefined
        ? []
        : [
            `the stall: ${ms(facts.stall.ms)}, a probe-lane lookup in flight ${String(facts.stall.lookupInFlight)}; unsafe marks ${String(facts.stall.unsafeMarks)}, answering names said passed-stuck ${String(facts.stall.passedStuck)}`,
          ]),
      ...(respawn === undefined
        ? []
        : [
            `respawns: ${String(respawn.kills)} kills, held at the memory gate at each ${String(respawn.heldAtEveryKill)} (ceiling ${String(stats.ceiling)} of ${String(stats.maxSize)}, size ${String(stats.size)}); fork to ready ${respawn.forkToReadyMs.map((n) => ms(n)).join(', ')}; the event loop's most around each fork ${respawn.lagAroundForkMs.map((n) => ms(n)).join(', ')} against ${ms(respawn.lagBaselineMs)} before; the helper's resident set at ${String(RESPAWN_RSS_AT_MS / 1_000)} s ${respawn.helperRssAt60s === undefined ? 'unread' : `${(respawn.helperRssAt60s / MIB).toFixed(0)} MiB`}; the probe's at each kill ${record.kills.map((kill) => `${(kill.probeRss / MIB).toFixed(0)} MiB`).join(', ')}`,
          ]),
      ...(facts.probeCrashes === undefined
        ? []
        : [`the crash name asked on the probe's own lanes: ${String(facts.probeCrashes)}`]),
      ...(log.errors.length === 0
        ? []
        : [
            `errors logged: ${String(log.errors.length)}, the first: ${log.errors.slice(0, 3).join(' | ')}`,
          ]),
    ];
    return { arm, mode, results: tallies.all.results, facts, lines };
  } finally {
    wheel?.stop();
    delay.disable();
    clearInterval(sampler);
    clearInterval(lagSampler);
    await pool?.stop();
    await names?.stop();
    await sim.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the name gate’s arms, on a DNS simulator and a getaddrinfo model (P-432 S7)', () => {
  const runs: WorldRun[] = [];

  after(() => {
    if (runs.length === 0) return;
    process.stdout.write(
      `\n    the gate's arms: ${String(SENSORS)} sensors at ${String(INTERVAL_SECONDS)} s on ` +
        `${String(Math.ceil(SENSORS / SENSORS_PER_DEVICE))} devices, pool ${String(POOL_SIZE)}, ` +
        `${String(availableParallelism())} cores; slow ${String(MINUTES)} min, warmzone ` +
        `${String(INTERVAL_SECONDS)} s answering then ${String(WARM_MINUTES)} min, zone and partial ` +
        `${String(COLD_MINUTES)} min, steady ${String(INTERVAL_SECONDS)} s then ${String(STEADY_MINUTES)} min\n` +
        `    the world: one DNS server (the simulator) as dnsmasq, dns-forward-max ${String(FORWARD_MAX)} ` +
        `with ${String(BACKGROUND_SLOTS)} held by other clients, a ${ms(FORWARD_HOLD_MS)} hold; ` +
        `getaddrinfo the model, ${String(WORLD_SCHEDULE.tries)} tries ${ms(WORLD_SCHEDULE.waitMs)} apart; ` +
        `the walk c-ares; the helper's child the real one over the model\n` +
        `${runs.map((one) => one.lines.map((line, i) => `${i === 0 ? '      ' : '        '}${line}`).join('\n')).join('\n')}\n`,
    );
  });

  for (const arm of WORLD_ARMS) {
    for (const mode of arm.modes) {
      it(`${arm.label}, ${mode}`, async (t) => {
        if (RESOLVER_SETTING === undefined) {
          t.skip(
            'MS_DNS_RESOLVER is unset: the gate’s arms run with MS_DNS_RESOLVER=system,gate ' +
              '(the full size: MS_DNS_WARM_MINUTES=7 MS_DNS_COLD_MINUTES=7 MS_DNS_STEADY_MINUTES=10)',
          );
          return;
        }
        if (!MODES.includes(mode)) {
          t.skip(`MS_DNS_RESOLVER leaves out ${mode}`);
          return;
        }
        if (!picked('world', arm.name)) {
          t.skip(`MS_DNS_ARMS leaves out "${arm.name}"`);
          return;
        }
        const one = await worldSoak(arm, mode);
        runs.push(one);
        assert.ok(one.results > 0, 'checks ran');
        assert.deepEqual(judgeWorld(one.facts), [], one.lines.join('\n'));
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// What the gate's arms rest on, shown to fail where it should: the model against glibc, and the
// judge against runs made to break each assertion. Run in every `test:perf`, in no time.
// ---------------------------------------------------------------------------------------------

describe('the gate arms’ model is glibc’s, and their judge fails what it should (P-432 S7)', () => {
  const rows = JSON.parse(readFileSync(FIXTURES('system-names-rows.json'), 'utf8')) as RecordedRows;
  const recordings = (
    JSON.parse(readFileSync(FIXTURES('system-names-recordings.json'), 'utf8')) as {
      readonly recordings: readonly Recording[];
    }
  ).recordings;

  it('GLIBC_QUESTIONS is the wire glibc sent, in every image a row was recorded in (D30’s recording A)', () => {
    const held = glibcDisagreements(rows, recordings);
    assert.deepEqual(held.disagreements, []);
    // Never vacuous: every family, in every one of the seven images, and the silent plans' tries.
    for (const family of [0, 4, 6] as const) {
      assert.ok(
        held.byFamily[family] >= 7,
        `family ${String(family)}: ${String(held.byFamily[family])}`,
      );
    }
    assert.ok(held.silent >= 14, `silent plans: ${String(held.silent)}`);
  });

  it('a table glibc does not follow is told apart: a type too many, a try too many, no floor on the wait', () => {
    const wrong: readonly GlibcTable[] = [
      { ...GLIBC_QUESTIONS, types: { ...GLIBC_QUESTIONS.types, 4: ['A', 'AAAA'] } },
      { ...GLIBC_QUESTIONS, types: { ...GLIBC_QUESTIONS.types, 0: ['AAAA', 'A'] } },
      { ...GLIBC_QUESTIONS, maxTries: 6 },
      { ...GLIBC_QUESTIONS, minWaitS: 0 },
    ];
    for (const table of wrong) {
      assert.ok(
        glibcDisagreements(rows, recordings, table).disagreements.length > 0,
        JSON.stringify(table),
      );
    }
  });

  /** What a clean run's helper and respawns say. */
  const cleanHelper = (arm: string): NonNullable<WorldFacts['helper']> => ({
    losses: {
      start: 0,
      skew: 0,
      exit: arm === 'P1' ? 2 : arm === 'P6' ? 3 : 0,
      hung: arm === 'P2' ? 1 : 0,
      memory: 0,
    },
    poisoned: arm === 'P6' ? 1 : 0,
    trouble: 0,
    unresponsiveMs: 0,
  });
  const cleanRespawn: NonNullable<WorldFacts['respawn']> = {
    kills: 4,
    heldAtEveryKill: true,
    forkToReadyMs: [200, 200, 200, 200],
    lagAroundForkMs: [20, 20, 20, 20],
    lagBaselineMs: 15,
    helperRssAt60s: 50 * MIB,
  };

  /** A run of `arm` in `mode` that holds every assertion. */
  const clean = (arm: string, mode: GateMode): WorldFacts => ({
    arm,
    mode,
    checkOn: true,
    q: 1,
    peakHeld: mode === 'system' ? 6 : 18,
    transient: 0,
    dropped: 0,
    walkSends: new Map([['127.0.0.1', mode === 'system' ? [] : [0, 100, 200]]]),
    givenUp: { answering: 0, silent: 40, cached: 0 },
    refused: 0,
    probeLanes: { answering: 100, silent: mode === 'system' ? 50 : 0 },
    helperPeak: { silent: 3 },
    afterSilence: { sampled: 2, other: 0 },
    gapsOver: [],
    steady: { perSecond: 2.5, keys: 2 },
    keptLate: [],
    helper: cleanHelper(arm),
    stopped: { downAfterMs: 3_500, hungAfterMs: 21_000, upAfterMs: 21_500 },
    stall: { ms: 15_000, lookupInFlight: true, unsafeMarks: 0, passedStuck: 0 },
    // P5's pool is at its full size, so its kills are never at the memory gate.
    respawn: arm === 'P5' ? { ...cleanRespawn, heldAtEveryKill: false } : cleanRespawn,
    probeCrashes: 0,
  });

  const cases: readonly {
    readonly arm: string;
    readonly mode: GateMode;
    readonly breaks: string;
    readonly patch: Partial<WorldFacts>;
    readonly says: RegExp;
  }[] = [
    {
      arm: 'zone',
      mode: 'system',
      breaks: 'past six slots',
      patch: { peakHeld: 7 },
      says: /held 7 slots/u,
    },
    {
      arm: 'zone',
      mode: 'gate',
      breaks: 'past six and twelve',
      patch: { peakHeld: 19 },
      says: /held 19 slots/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'past the transient',
      patch: { peakHeld: 27, transient: 8 },
      says: /held 27 slots for the probe, past 26/u,
    },
    {
      arm: 'steady',
      mode: 'gate',
      breaks: 'a question dropped',
      patch: { dropped: 1 },
      says: /dropped 1/u,
    },
    {
      arm: 'steady',
      mode: 'gate',
      breaks: 'the walk past its bucket',
      patch: { walkSends: new Map([['127.0.0.1', Array.from({ length: 23 }, () => 0)]]) },
      says: /walk questions to 127\.0\.0\.1 past/u,
    },
    {
      arm: 'steady',
      mode: 'system',
      breaks: 'system mode walking',
      patch: { walkSends: new Map([['127.0.0.1', [0]]]) },
      says: /system mode walked/u,
    },
    {
      arm: 'slow',
      mode: 'gate',
      breaks: 'a check refused',
      patch: { refused: 1 },
      says: /refused/u,
    },
    {
      arm: 'slow',
      mode: 'system',
      breaks: 'an answering check given up',
      patch: { givenUp: { answering: 1 } },
      says: /1 answering checks given up/u,
    },
    {
      arm: 'zone',
      mode: 'gate',
      breaks: 'a silent name on the probe’s lanes',
      patch: { probeLanes: { answering: 100, silent: 1 } },
      says: /silent zone on the probe’s lanes/u,
    },
    {
      arm: 'zone',
      mode: 'gate',
      breaks: 'the silent zone past 3 helper lanes',
      patch: { helperPeak: { silent: 4 } },
      says: /held 4 of the helper’s lanes/u,
    },
    {
      arm: 'zone',
      mode: 'gate',
      breaks: 'an answering name kept late',
      patch: { keptLate: ['dev-1.zone-a.test, 1500 ms'] },
      says: /kept late/u,
    },
    {
      arm: 'warmzone',
      mode: 'gate',
      breaks: 'a first lookup on the probe’s lanes after the silence',
      patch: { afterSilence: { sampled: 0, other: 1 } },
      says: /were not sampled refreshes/u,
    },
    {
      arm: 'warmzone',
      mode: 'gate',
      breaks: 'three samples after the silence',
      patch: { afterSilence: { sampled: 3, other: 0 } },
      says: /3 of the silent zone’s refreshes sampled/u,
    },
    {
      arm: 'warmzone',
      mode: 'gate',
      breaks: 'an answering name’s gap',
      patch: { gapsOver: ['dev-1.zone-a.test'] },
      says: /went too long/u,
    },
    {
      arm: 'warmzone',
      mode: 'gate',
      breaks: 'the steady walk rate',
      patch: { steady: { perSecond: 3.5, keys: 2 } },
      says: /at steady state/u,
    },
    {
      arm: 'steady',
      mode: 'gate',
      breaks: 'the steady walk rate',
      patch: { steady: { perSecond: 17, keys: 2 } },
      says: /17\.00 questions a second/u,
    },
    {
      arm: 'partial',
      mode: 'gate',
      breaks: 'a cached name given up',
      patch: { givenUp: { cached: 1 } },
      says: /1 cached checks given up/u,
    },
    {
      arm: 'partial',
      mode: 'gate',
      breaks: 'an uncached name on the probe’s lanes',
      patch: { probeLanes: { silent: 2 } },
      says: /2 getaddrinfo for the silent zone/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'one loss where two were made',
      patch: {
        helper: {
          ...cleanHelper('P1'),
          losses: { start: 0, skew: 0, exit: 1, hung: 0, memory: 0 },
        },
      },
      says: /1 exit losses, where 2/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'the trouble latch set',
      patch: { helper: { ...cleanHelper('P1'), trouble: 1 } },
      says: /lookupHelperTrouble read 1/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the next child late',
      patch: { stopped: { downAfterMs: 3_000, hungAfterMs: 21_000, upAfterMs: 30_000 } },
      says: /next child was up 30000 ms/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'never not answering',
      patch: { stopped: { downAfterMs: undefined, hungAfterMs: 21_000, upAfterMs: 21_500 } },
      says: /route left up never/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'a zone marked unsafe by the stall',
      patch: { stall: { ms: 15_000, lookupInFlight: true, unsafeMarks: 1, passedStuck: 0 } },
      says: /1 zones marked unsafe/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'no lookup in flight at the stall',
      patch: { stall: { ms: 15_000, lookupInFlight: false, unsafeMarks: 0, passedStuck: 0 } },
      says: /no probe-lane lookup was in flight/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'the helper judged not answering',
      patch: { helper: { ...cleanHelper('P3'), unresponsiveMs: 3_000 } },
      says: /judged not answering/u,
    },
    {
      arm: 'forwarder',
      mode: 'gate',
      breaks: 'an answering check given up',
      patch: { givenUp: { answering: 1, silent: 40, cached: 0 } },
      says: /1 answering checks given up/u,
    },
    {
      arm: 'forwarder',
      mode: 'system',
      breaks: 'a question dropped',
      patch: { dropped: 3 },
      says: /dropped 3 questions/u,
    },
    {
      arm: 'P5',
      mode: 'gate',
      breaks: 'a slow fork',
      patch: { respawn: { ...cleanRespawn, heldAtEveryKill: false, forkToReadyMs: [200, 1_500] } },
      says: /1500 ms from fork to ready/u,
    },
    {
      arm: 'P5',
      mode: 'gate',
      breaks: 'an answering check given up',
      patch: { givenUp: { answering: 2, silent: 0, cached: 0 } },
      says: /2 answering checks given up/u,
    },
    {
      arm: 'P5b',
      mode: 'gate',
      breaks: 'not at the memory gate',
      patch: { respawn: { ...cleanRespawn, heldAtEveryKill: false } },
      says: /not held at its memory gate/u,
    },
    {
      arm: 'P5b',
      mode: 'gate',
      breaks: 'a slow fork',
      patch: { respawn: { ...cleanRespawn, forkToReadyMs: [200, 1_500, 200, 200] } },
      says: /1500 ms from fork to ready/u,
    },
    {
      arm: 'P5b',
      mode: 'gate',
      breaks: 'a fork holding the event loop',
      patch: { respawn: { ...cleanRespawn, lagAroundForkMs: [20, 200, 20, 20] } },
      says: /held 200 ms around a fork/u,
    },
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'the crash name on the probe’s lanes',
      patch: { probeCrashes: 1 },
      says: /asked on the probe’s own lanes 1 times/u,
    },
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'the crash name not poisoned',
      patch: { helper: { ...cleanHelper('P6'), poisoned: 0 } },
      says: /0 names poisoned/u,
    },
  ];

  it('a run that holds every assertion is judged clean, in every arm and the modes it runs in', () => {
    for (const arm of WORLD_ARMS) {
      for (const mode of arm.modes) {
        assert.deepEqual(judgeWorld(clean(arm.name, mode)), [], `${arm.name} ${mode}`);
      }
    }
    assert.deepEqual(
      [...JUDGED_ARMS].sort(),
      WORLD_ARMS.map((arm) => arm.name).sort(),
      'the judge knows every arm',
    );
  });

  for (const one of cases) {
    it(`${one.arm}, ${one.mode}: a run with ${one.breaks} fails`, () => {
      const said = judgeWorld({ ...clean(one.arm, one.mode), ...one.patch });
      assert.ok(
        said.some((violation) => one.says.test(violation)),
        `judged ${JSON.stringify(said)}`,
      );
    });
  }

  it('the bucket admits D19’s burst and rate, and no more', () => {
    assert.equal(
      overBucket(Array.from({ length: 21 }, () => 0)),
      0,
      'the burst, and one for the send',
    );
    assert.equal(overBucket(Array.from({ length: 22 }, () => 0)), 1);
    // Ten a second for a minute after the burst: all admitted; eleven a second: not.
    const tenASecond = Array.from({ length: 600 }, (_, i) => i * 100);
    assert.equal(overBucket(tenASecond), 0);
    const elevenASecond = Array.from({ length: 660 }, (_, i) => (i * 1_000) / 11);
    assert.ok(overBucket(elevenASecond) > 0);
    assert.equal(busiestSecond(tenASecond), 10);
  });
});
