import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { DnsSimulator, replies, type DnsBehaviour, type DnsQueryRecord } from '@ms/simulators';
import {
  checkedTarget,
  RESOLVER_FAULT,
  RESOLVER_FULL,
  RESOLVER_HELD,
  RESOLVER_STUCK,
  systemResolve,
  type ResolvedAddress,
  type ResolveHost,
} from '@ms/sensors';
import { lookupsBesideThePool, ProbeHealthReporter } from '../../src/health/report.js';
import { AnswerFile, answerFilePath } from '../../src/resolver/answer-file.js';
import {
  CANARY_NAME,
  caresAsker,
  KEY_SETTLE_MS,
  type DnsAsker,
} from '../../src/resolver/dns-check.js';
import { FORWARD_HOLD_MS, questionsOf } from '../../src/resolver/forward-budget.js';
import type {
  ForkHelper,
  HelperProcess,
  LookupHelperStats,
  RouteState,
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
import type { ResolveAck, ResolveReply } from '../../src/resolver/protocol.js';
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
  glibcCoverageGaps,
  glibcDisagreements,
  glibcLookup,
  glibcSchedule,
  glibcWire,
  PARTIAL_CODE,
  WORLD_ENV,
  type ChildWorld,
  type GlibcModel,
  type GlibcTable,
  type ModelAddress,
  type ModelFamily,
  type RecordedRows,
  type Recording,
} from '../support/glibc-model.js';
import {
  baselineOf,
  busiestSecond,
  cachedAllowance,
  CHANNELS_A_SECOND,
  gapBound,
  hangAllowance,
  heldBound,
  HELPER_FIRST_AND_RETRY_LANES,
  JUDGED_ARMS,
  judgeWorld,
  LOSS_WINDOW_MS,
  overBucket,
  spread10Bound,
  stretches,
  WALKRATE_P99_OVER_MS,
  wordsOf,
  type Baseline,
  type GateMode,
  type Group,
  type HangFacts,
  type LossAt,
  type NotAnswered,
  type NotAnsweredEnd,
  type PeakWindow,
  type WorldFacts,
} from '../support/name-gate-judge.js';
import { pollWithin, within } from '../support/within.js';
import {
  byGroup,
  openFds,
  readsLines,
  teardownLine,
  type WorldReads,
} from '../support/world-reads.js';

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
 * `test:perf` with the model's table held to the recordings and the model's code to its table.
 * Each arm also asserts that nothing is left asking on the probe's lanes once it is torn down. The
 * arms: `slow`, `warmzone`, `zone`, `partial`, `steady` and `forwarder` in both modes; `P1` to
 * `P3`, `P5`, `P5b` and `P6`, the helper's, in gate mode; and the pick's cost (`P-465`, the
 * design's open risk 19): `spread10` in both modes, twenty silent keys of ten names with the check
 * off, the gate's answering checks held to `system`'s; and `walkrate` in gate mode, 10,000 names of
 * one sensor at 120 s, its event loop held to `addresses`', the same load with every device an
 * address, which runs first in its mode where it has not.
 * `MS_DNS_ARMS` takes `world/<name>` and `lanes/<name>` where the blocks' names overlap, and a
 * name no arm has stops the file rather than skip what it meant to pick.
 * `MS_DNS_STEADY_MINUTES` (`MS_DNS_MINUTES` unless set, 10 at full size) is `steady`'s time after
 * its scan interval; `MS_DNS_CHECK=off` runs the gate with its name check off for the
 * environment, but for the arms with a check of their own: `spread10` off, and `walkrate` and
 * `addresses` on, whatever it says. `docs/findings/2026-10-20-name-lookups-gated.md` has the
 * method and the command.
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
/** Of those, the ones given up at the check's own bound (`checkedTarget`'s `timedOut`). */
const AT_ITS_BOUND = /did not resolve within \d+ ms, .*the probe’s resolver is not answering$/u;
/**
 * Gate mode: D27's refusal of a name the probe's own `getaddrinfo` must not be asked for, while
 * the helper rests or its route is `down` (`#gateRefusal`), in the words the check carries.
 */
const AVOIDED = /the lookup helper failed while asking for it lately/u;
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
/**
 * P6: how long the crash name may take to be poisoned, from the wheel's start (its first check
 * within a scan interval, then three crashes), and how long it is checked once its zone answers.
 */
const CRASH_POISONED_BY_MS = 90_000;
const CRASH_ASKED_AFTER_MS = 30_000;
/** `spread10`'s silent keys. */
const SPREAD_KEYS = 20;
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
  /**
   * The helper's child stopped (P2): each answering check's ask is read as the resolver is handed
   * it, with how it ended, for its allowance (`P-472`).
   */
  readonly hang?: boolean;
  /**
   * The silent names spread over keys under zone b, `k<n>.zone-b.test`, by this device's key:
   * `forwarder`'s hundred keys of three, `spread10`'s twenty of ten, at full size.
   */
  readonly silentKey?: (device: number) => number;
  /**
   * The gate's name check, whatever `MS_DNS_CHECK` says: off for `spread10`, whose row is the
   * check off; on for `walkrate` and its baseline, which measure the walk.
   */
  readonly check?: 'on' | 'off';
  /** Every device given as an address: nothing resolved (`addresses`, `walkrate`'s baseline). */
  readonly addresses?: boolean;
  /**
   * Twice the names, one sensor a device at twice the interval, so the checks a second are the v1
   * target's: 10,000 names at full size (`walkrate`, and its baseline).
   */
  readonly twiceTheNames?: boolean;
  /**
   * The run this arm is held against, of the same process, run first where it has not been
   * (`P-465`): `walkrate`'s `addresses` in its mode; `spread10`'s own in `system`, in gate mode.
   */
  readonly baseline?: (
    mode: GateMode,
  ) => { readonly arm: string; readonly mode: GateMode } | undefined;
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
  /** The arms with a helper loss: the forwarder's peak, cut at each loss (D16's transient). */
  readonly peaks: PeakWindows | undefined;
}

/** What the events found, for the facts. */
interface WorldRecord {
  silencedAt?: number;
  /** P2: the SIGSTOP, the child it stopped, and what its look saw after it. */
  stopped?: { downAt?: number; hungAt?: number; upAt?: number; at: number; pid?: number };
  /**
   * P3: the stall, the name whose question began it, when it began and ended (this thread's
   * `performance.now()`), that name's lookups open on the probe's lanes as it began, and the
   * replies the simulator sent meanwhile, to every client.
   */
  stall?: {
    ms: number;
    host: string;
    from: number;
    to: number;
    flights: readonly LaneFlight[];
    repliesDuring: number;
  };
  kills: { at: number; heldBack: boolean; probeRss: number }[];
  /**
   * P1: when the arm killed the helper's child (this thread's `performance.now()`), each a loss the
   * judge places the transient by. P2's are its look's stamps in `stopped`.
   */
  killedAt: number[];
  helperRssAt60s?: number | undefined;
  /** P6: when the crash name's zone began to answer, once the name was poisoned. */
  crashZoneAnsweredAt?: number;
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
    events: async ({ at, names, record, peaks }) => {
      for (const ms of [5_000, 95_000]) {
        await at(ms);
        killChild(names, 'SIGKILL');
        // The loss: its lookups are asked again by the next child, from another port. Stamped
        // before its cut, which the transient may then start at and no earlier.
        record.killedAt.push(performance.now());
        await peaks?.loss();
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
    hang: true,
    runMs: () => 60_000,
    events: async ({ at, names, record, peaks }) => {
      await at(10_000);
      const helper = names.gate?.helper;
      if (helper === undefined) return;
      const pid = helper.pid();
      const stopped: NonNullable<WorldRecord['stopped']> = {
        at: performance.now(),
        ...(pid === undefined ? {} : { pid }),
      };
      record.stopped = stopped;
      killChild(names, 'SIGSTOP');
      // Its losses: the lookups detached as it goes quiet, then the child replaced (D26). The
      // SIGSTOP itself asks nothing again. The judge says which of the three never came: a bound
      // passed here is not a failure.
      await pollWithin(
        40_000,
        'the stopped child replaced and the next up',
        stoppedLook(() => helper.stats(), stopped, peaks),
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
    events: async ({ at, probe, record, sim }) => {
      await at(40_000);
      // Held from the moment a probe-lane lookup of an answering name has sent its question, so
      // that its reply is in the socket, and its stuck timer due, all through the stall. The judge
      // fails a run with none in the next 10 s, and one whose lookup's reply was not sent before
      // the stall ended (the simulator answers in its own thread, so its log says when), had been
      // read before the stall began (the send's callback can come after the reply's read), or was
      // not read after it.
      const triggered = new Promise<void>((resolve) => {
        probe.onSent = (group, host) => {
          if (group !== 'answering' || record.stall !== undefined) return;
          probe.onSent = undefined;
          // Its name's lookups open as the stall begins, read again for how each settled.
          const flights = probe.openFor(host);
          const repliesBefore = sim.repliesSent;
          const from = performance.now();
          while (performance.now() - from < STALL_MS) {
            // The probe's main thread, busy: nothing else in this process runs.
          }
          const to = performance.now();
          record.stall = {
            ms: to - from,
            host,
            from,
            to,
            flights,
            repliesDuring: sim.repliesSent - repliesBefore,
          };
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
    // Devices 5k to 5k + 2 share the key `d:k<k>.zone-b.test`: 300 silent names over 100 keys.
    silentKey: (device) => Math.floor(device / 5),
    runMs: () => COLD_MINUTES * 60_000,
  },
  {
    name: 'P6',
    label:
      'P6: one name whose getaddrinfo crashes the helper’s child, its zone silent until it is poisoned',
    modes: ['gate'],
    group: (device) => (device === 0 ? 'crash' : 'answering'),
    runMs: () => Math.max(1, MINUTES) * 60_000,
    events: async ({ names, sim, record }) => {
      const helper = names.gate?.helper;
      if (helper === undefined) return;
      // Poisoned, its zone then answers: from here its walk would be heard and run on the probe's
      // own lanes, so only D27 keeps it off them (`P-471`). While its zone was silent nothing could
      // send it there, and the judge fails a run with no check of it since.
      await pollWithin(
        CRASH_POISONED_BY_MS,
        'the crash name poisoned',
        () => helper.stats().poisoned > 0,
        50,
      ).catch(() => undefined);
      if (helper.stats().poisoned === 0) return;
      await sim.set({ zone: 'zone-c.test' }, { reply: replies.addresses('192.0.2.30') });
      record.crashZoneAnsweredAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, CRASH_ASKED_AFTER_MS));
    },
  },
  {
    // Two names in five silent, in twenty keys: 200 names over 20 keys at full size, each key the
    // devices whose silent index is the same mod 20. The check off, so every name is unvouched.
    name: 'spread10',
    label: 'two names in five silent, twenty keys of ten, cold, the check off',
    modes: ['system', 'gate'],
    group: (device) => (device % 5 < 2 ? 'silent' : 'answering'),
    silentKey: (device) => (Math.floor(device / 5) * 2 + (device % 5)) % SPREAD_KEYS,
    check: 'off',
    baseline: (mode) => (mode === 'gate' ? { arm: 'spread10', mode: 'system' } : undefined),
    runMs: () => COLD_MINUTES * 60_000,
  },
  {
    name: 'addresses',
    label: 'every device given as an address, at walkrate’s load: walkrate’s baseline',
    modes: ['gate'],
    group: allAnswering,
    addresses: true,
    twiceTheNames: true,
    check: 'on',
    runMs: () => MINUTES * 60_000,
  },
  {
    name: 'walkrate',
    label: 'twice the names, one in ten silent, one sensor a device at twice the interval, cold',
    modes: ['gate'],
    group: oneInTenSilent,
    twiceTheNames: true,
    check: 'on',
    baseline: (mode) => ({ arm: 'addresses', mode }),
    runMs: () => COLD_MINUTES * 60_000,
  },
];

/**
 * The names in `MS_DNS_ARMS` that no arm has, bare or as `lanes/<name>` and `world/<name>`: `picked`
 * matches names and skips every arm none matches, so a name for an arm this build lacks would end
 * the run green with that arm never run (the rc.3 cut's step 0.7, `P-465`'s first review).
 */
function unknownArms(
  asked: readonly string[],
  lanes: readonly string[],
  world: readonly string[],
): string[] {
  const known = new Set([
    ...lanes,
    ...world,
    ...lanes.map((name) => `lanes/${name}`),
    ...world.map((name) => `world/${name}`),
  ]);
  return asked.filter((name) => !known.has(name));
}

const UNKNOWN_ARMS = unknownArms(
  ARMS,
  ALL_ARMS.map(({ name }) => name),
  WORLD_ARMS.map(({ name }) => name),
);
if (UNKNOWN_ARMS.length > 0) {
  throw new Error(
    `MS_DNS_ARMS names no arm of this file: ${UNKNOWN_ARMS.join(', ')}. The lane model's: ` +
      `${ALL_ARMS.map(({ name }) => name).join(', ')}; the world's: ` +
      WORLD_ARMS.map(({ name }) => name).join(', '),
  );
}

function killChild(names: NameResolution, signal: NodeJS.Signals): void {
  const pid = names.gate?.helper.pid();
  if (pid === undefined) throw new Error(`no helper child to send ${signal}`);
  process.kill(pid, signal);
}

/** A device's name in the world: its zone by its group, and the slow arm's own. */
function worldHost(arm: WorldArm, device: number): string {
  if (arm.addresses === true) return `192.0.2.${String((device % 250) + 1)}`;
  const group = arm.group(device);
  if (group === 'crash') return `crash-${String(device)}.zone-c.test`;
  if (arm.silentKey !== undefined) {
    return group === 'silent'
      ? `dev-${String(device)}.k${String(arm.silentKey(device))}.zone-b.test`
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
const WORLD_ARMS_SILENT = new Set([
  'zone',
  'partial',
  'forwarder',
  'P1',
  'P2',
  'P3',
  'spread10',
  'walkrate',
]);

/** One lookup on the probe's lanes: when it began, and when and how it settled. */
interface LaneFlight {
  readonly startedAt: number;
  settledAt?: number;
  /** With addresses; false for a failure. */
  answered?: boolean;
}

/** The probe's own lanes' `getaddrinfo`: the model, counted by group, and never the crash name. */
class ProbeSide {
  readonly calls: Partial<Record<Group, number>> = {};
  readonly peak: Partial<Record<Group, number>> = {};
  readonly #running: Partial<Record<Group, number>> = {};
  /** Each name's lookups begun and not yet settled. */
  readonly #open = new Map<string, Set<LaneFlight>>();
  /** When each name was answered with addresses. */
  readonly answeredAt = new Map<string, number[]>();
  /** When each name's lookups began here: P2's kept-off names must have none since the quiet. */
  readonly startedAt = new Map<string, number[]>();
  crashes = 0;
  /** Told as a lookup's try is with the kernel, with its name's group and the name. */
  onSent: ((group: Group, host: string) => void) | undefined;
  readonly #model: GlibcModel;
  readonly #groupOf: (host: string) => Group;

  constructor(port: number, groupOf: (host: string) => Group) {
    this.#groupOf = groupOf;
    this.#model = glibcLookup({
      server: { address: WORLD_ADDRESS, port },
      localAddress: PROBE_SOURCE,
      schedule: WORLD_SCHEDULE,
      onSent: (host) => this.onSent?.(this.#groupOf(host), host),
    });
  }

  inFlight(): number {
    return Object.values(this.#running).reduce((sum, n) => sum + n, 0);
  }

  /**
   * `host`'s lookups open on the probe's lanes now: begun, and not settled. A lookup settles in
   * the turn its reply is read (the model's promise and this side's continuation run before the
   * next I/O callback), so one read before a later callback is no longer here.
   */
  openFor(host: string): readonly LaneFlight[] {
    return [...(this.#open.get(host) ?? [])];
  }

  /**
   * Ends every lookup on the probe's lanes now, and every one asked from here on at once: the
   * resolver's `stop` lets its lane lookups run, and starts the next it has queued as each ends.
   */
  stop(): void {
    this.#model.close();
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
    const flight: LaneFlight = { startedAt: performance.now() };
    const starts = this.startedAt.get(host) ?? [];
    starts.push(flight.startedAt);
    this.startedAt.set(host, starts);
    const open = this.#open.get(host) ?? new Set<LaneFlight>();
    open.add(flight);
    this.#open.set(host, open);
    try {
      const found = await this.#model.lookup(host, family);
      const now = performance.now();
      flight.settledAt = now;
      flight.answered = true;
      const times = this.answeredAt.get(host) ?? [];
      times.push(now);
      this.answeredAt.set(host, times);
      return found.map(({ address, family: f }) => ({ address, family: f === 6 ? 6 : 4 }));
    } catch (error) {
      flight.settledAt = performance.now();
      flight.answered = false;
      throw error;
    } finally {
      open.delete(flight);
      if (open.size === 0 && this.#open.get(host) === open) this.#open.delete(host);
      this.#running[group] = (this.#running[group] ?? 1) - 1;
    }
  };
}

/** Between this thread's wall clock and the simulator worker's: each reads its own `timeOrigin`. */
const THREAD_CLOCK_SLACK_MS = 50;

/**
 * P3's setup, as measured (the judge's `stall`): the reply to its name's question sent by the
 * simulator before the stall ended, by its log on the wall's clock; its lookup still open on the
 * probe's lanes as the stall began; and that lookup answered, and when, from the stall's end.
 */
function stallSetUp(
  stall: NonNullable<WorldRecord['stall']>,
  queries: readonly DnsQueryRecord[],
): Pick<
  NonNullable<WorldFacts['stall']>,
  'ms' | 'replySent' | 'unsettledAtStart' | 'answeredAfterMs'
> {
  const wall = (at: number): number => performance.timeOrigin + at;
  const { flights } = stall;
  // Asked since its lookup began; with none open, which the judge fails, in the second before.
  const since =
    flights.length > 0
      ? wall(Math.min(...flights.map(({ startedAt }) => startedAt))) - THREAD_CLOCK_SLACK_MS
      : wall(stall.from) - 1_000;
  const answeredAt = flights.flatMap(({ answered, settledAt }) =>
    answered === true && settledAt !== undefined ? [settledAt] : [],
  );
  return {
    ms: stall.ms,
    replySent: queries.some(
      (query) =>
        query.client.address === PROBE_SOURCE &&
        query.qname.toLowerCase() === stall.host.toLowerCase() &&
        query.at >= since &&
        query.reply !== undefined &&
        query.reply.at <= wall(stall.to),
    ),
    unsettledAtStart: flights.length > 0,
    answeredAfterMs:
      flights.length > 0 && answeredAt.length === flights.length
        ? Math.min(...answeredAt) - stall.to
        : undefined,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** One lookup a child was sent, as the tap read it: when, and when it ended there (`P-472`). */
interface TapFlight {
  readonly host: string;
  /** The child's index, in fork order. */
  readonly child: number;
  readonly sentAt: number;
  /** Its answer read, or its child gone: undefined while it is in flight. */
  endedAt?: number;
}

/** A child as the tap forked it. */
interface TapChild {
  readonly forkedAt: number;
  readonly pid: number | undefined;
  readyAt?: number;
  /** When its last answer was read, to any lookup: what a stopped child last said (`P-472`). */
  lastAnswerAt?: number;
}

/**
 * The real helper's child, forked as the helper forks it, with what it is asked and what it says
 * read off the channel on the way: its lookups in flight by group, its answers, each lookup sent
 * and when it ended, and each child's fork, `ready` (P5b) and last answer (P2). Nothing the helper
 * sends or reads is changed. The tap reads each message before the helper does, since its listener
 * is the first on the child.
 */
class HelperTap {
  readonly peak: Partial<Record<Group, number>> = {};
  /** The lookups each child was asked, by group, in fork order. */
  readonly byChild: Partial<Record<Group, number>>[] = [];
  readonly answeredAt = new Map<string, number[]>();
  readonly children: TapChild[] = [];
  /** Every lookup sent to a child, in the order sent. */
  readonly sent: TapFlight[] = [];
  stuck = 0;
  readonly #groupOf: (host: string) => Group;
  readonly #flights = new Map<number, TapFlight>();
  readonly #running: Partial<Record<Group, number>> = {};

  constructor(groupOf: (host: string) => Group) {
    this.#groupOf = groupOf;
  }

  #end(id: number): void {
    const flight = this.#flights.get(id);
    if (flight === undefined) return;
    this.#flights.delete(id);
    flight.endedAt = performance.now();
    const group = this.#groupOf(flight.host);
    this.#running[group] = (this.#running[group] ?? 1) - 1;
  }

  readonly fork: ForkHelper = (module, args, options) => {
    const child = fork(module, [...args], options);
    const index = this.children.length;
    const record: TapChild = { forkedAt: performance.now(), pid: child.pid };
    this.children.push(record);
    const asked: Partial<Record<Group, number>> = {};
    this.byChild.push(asked);
    child.on('message', (raw: unknown) => {
      if (!isRecord(raw)) return;
      if (raw['t'] === 'ready') record.readyAt ??= performance.now();
      if (raw['t'] === 'stuck') this.stuck += 1;
      if (raw['t'] !== 'answer' || typeof raw['id'] !== 'number') return;
      record.lastAnswerAt = performance.now();
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
        asked[group] = (asked[group] ?? 0) + 1;
        const flight: TapFlight = { host: message.host, child: index, sentAt: performance.now() };
        this.sent.push(flight);
        this.#flights.set(message.id, flight);
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

/** Every question the name check sends, by server, with when it was sent; and its channels. */
class WalkCounter {
  readonly sends = new Map<string, number[]>();
  /** When each channel was opened. */
  readonly channels: number[] = [];
  /** Questions for a name, the canary's (`localhost.`, sent to prove the check) aside. */
  names = 0;

  wrap(inner: DnsAsker): DnsAsker {
    return {
      channel: (server) => {
        this.channels.push(performance.now());
        const channel = inner.channel(server);
        return {
          ask: (name, type) => {
            const times = this.sends.get(server) ?? [];
            times.push(performance.now());
            this.sends.set(server, times);
            if (name !== CANARY_NAME) this.names += 1;
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

/** What `PeakWindows` runs on: a clock in ms, and a timer it can cancel. */
interface PeakClock {
  now(): number;
  after(ms: number, run: () => void): { cancel(): void };
}

const realClock: PeakClock = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

/**
 * The forwarder's most slots held for the probe, in windows (D16): cut at each helper loss and
 * `LOSS_WINDOW_MS` after it, each read with the peak started again (`gauge` with `resetPeak`), so
 * that the stretches a loss's transient may fill are judged apart from the rest. The arms with a
 * helper loss (P1, P2). A loss's window is its own until its end, wherever the timer that ends it
 * fires: the next window takes the transient only from another loss whose window ends later.
 *
 * A loss the arm makes itself (P1's kill) is cut at once (`loss`): the read is asked before
 * anything the loss sets off can be seen. A loss a poll sees (P2's detach) may have set off its
 * transient before the poll looked, and before the read the cut asks for, so the poll reads first
 * (`cut`) and looks after, and a loss it sees takes the window that read closed (`lossSeen`).
 */
class PeakWindows {
  readonly windows: PeakWindow[] = [];
  /** Why a read failed, if one did: the judge fails the arm on it. */
  failed: string | undefined;
  /** Where `finish` cut the last window: the arm's end, which the windows must reach. */
  endMs: number | undefined;
  readonly #read: () => Promise<number>;
  readonly #clock: PeakClock;
  readonly #windowMs: number;
  readonly #origin: number;
  #from = 0;
  #transient = false;
  /** Where the latest-ending loss's window ends. */
  #transientUntil = Number.NEGATIVE_INFINITY;
  #reads: Promise<void> = Promise.resolve();
  readonly #timers = new Set<{ cancel(): void }>();

  /**
   * From now: the forwarder has been started, and nothing has asked it yet. `read` gives the peak
   * since the last read and starts it again.
   */
  constructor(
    read: () => Promise<number>,
    options: { readonly clock?: PeakClock; readonly windowMs?: number } = {},
  ) {
    this.#read = read;
    this.#clock = options.clock ?? realClock;
    this.#windowMs = options.windowMs ?? LOSS_WINDOW_MS;
    this.#origin = this.#clock.now();
  }

  /** The simulator's `ns1`, the probe's slots (untagged ports, `other`). */
  static of(sim: DnsSimulator): PeakWindows {
    return new PeakWindows(
      async () => (await sim.gauge('ns1', { resetPeak: true }))[0]?.peakHeldByClass['other'] ?? 0,
    );
  }

  #now(): number {
    return this.#clock.now() - this.#origin;
  }

  /**
   * A time on its clock as ms from the windows' start: P1's kills and P2's looks stamp theirs with
   * `performance.now()`, the real clock's own.
   */
  since(at: number): number {
    return at - this.#origin;
  }

  /** A loss's window, to `windowMs` from `at`: its timer cuts it there. */
  #lossUntil(at: number): void {
    const until = at + this.#windowMs;
    this.#transientUntil = Math.max(this.#transientUntil, until);
    const timer = this.#clock.after(this.#windowMs, () => {
      this.#timers.delete(timer);
      // A timer may fire a little early on the clock: this window was this loss's to its end. The
      // next is a loss's only if one made by now ends later: one made after opens its own.
      const later = this.#transientUntil > until;
      void this.#cut(this.#now(), () => later);
    });
    this.#timers.add(timer);
  }

  /** A loss now: the window before it ends, and one with the transient runs `windowMs`. */
  loss(): Promise<void> {
    const at = this.#now();
    this.#lossUntil(at);
    return this.#cut(at, () => true);
  }

  /**
   * A read now and no loss: the next window keeps the transient only while it is inside a loss's
   * window. For a poll that reads before each look (`lossSeen`).
   */
  cut(): Promise<void> {
    const at = this.#now();
    const until = this.#transientUntil;
    return this.#cut(at, (closing) => closing && at < until);
  }

  /**
   * A loss a poll saw, the poll reading (`cut`) before each look. The loss came after the look
   * before, which came after the read before this one: so of the windows read, only the last can
   * hold any of its transient, and that one is the loss's too. The window open now runs with the
   * transient for `windowMs` from now. A last read that failed left a gap, which the judge names.
   */
  lossSeen(): Promise<void> {
    this.#lossUntil(this.#now());
    this.#reads = this.#reads.then(() => {
      const last = this.windows.at(-1);
      if (last !== undefined && last.toMs === this.#from) {
        this.windows[this.windows.length - 1] = { ...last, transient: true };
      }
      this.#transient = true;
    });
    return this.#reads;
  }

  /** The last window, to now, once the arm is over; the windows, in order. */
  async finish(): Promise<readonly PeakWindow[]> {
    for (const timer of this.#timers) timer.cancel();
    this.#timers.clear();
    const at = this.#now();
    this.endMs = at;
    await this.#cut(at, () => false);
    return this.windows;
  }

  /**
   * Ends the open window at `at`, read as the gauge has it, and opens the next, with the transient
   * as `next` says given the window it closes, once the reads before it are in.
   */
  #cut(at: number, next: (closing: boolean) => boolean): Promise<void> {
    this.#reads = this.#reads.then(async () => {
      const closing = this.#transient;
      try {
        const peak = await this.#read();
        this.windows.push({ fromMs: this.#from, toMs: at, peak, transient: closing });
      } catch (error) {
        this.failed ??= String(error);
      }
      this.#from = at;
      this.#transient = next(closing);
    });
    return this.#reads;
  }
}

/** A helper loss as the arm stamped it, on this thread's clock. */
interface LossStamp {
  readonly at: number;
  readonly seen: boolean;
}

/**
 * The helper losses the judge places the transient by: P1's kills, made by the arm, and P2's
 * detach and `hung` loss, as its look stamped them. The arm's stamps, not `PeakWindows`', so that
 * a fault in what cuts the windows is judged against something they did not say.
 */
function lossTimes(record: Pick<WorldRecord, 'killedAt' | 'stopped'>): LossStamp[] {
  const seen = [record.stopped?.downAt, record.stopped?.hungAt].filter(
    (at): at is number => at !== undefined,
  );
  return [
    ...record.killedAt.map((at) => ({ at, seen: false })),
    ...seen.map((at) => ({ at, seen: true })),
  ];
}

/**
 * The forwarder's peak for the judge: the gauge's for the run, or, with windows once `finish` has
 * cut the last, each window's, where they must reach, why a read failed if one did, and the
 * losses on the windows' clock.
 */
function peakFacts(
  gaugePeak: number,
  peaks: PeakWindows | undefined,
  losses: readonly LossStamp[],
): Pick<
  WorldFacts,
  'peakHeld' | 'peakWindows' | 'peakWindowsEndMs' | 'peakReadFailed' | 'lossesAt'
> {
  if (peaks === undefined) return { peakHeld: gaugePeak };
  return {
    // With windows, the gauge's own peak is the last window's: the run's is theirs.
    peakHeld: Math.max(0, ...peaks.windows.map(({ peak }) => peak)),
    peakWindows: peaks.windows,
    ...(peaks.endMs === undefined ? {} : { peakWindowsEndMs: peaks.endMs }),
    ...(peaks.failed === undefined ? {} : { peakReadFailed: peaks.failed }),
    lossesAt: losses.map(({ at, seen }): LossAt => ({ atMs: peaks.since(at), seen })),
  };
}

/** What P2's poll reads of the helper. */
type StoppedStats = Pick<LookupHelperStats, 'route' | 'state' | 'lossesByReason'>;

/**
 * P2's look at the stopped child, once a poll: the route leaving `up` (the detach), the `hung`
 * loss and the next child up, each stamped when seen. A loss is seen after the resolver has acted
 * on it: at the detach the helper's queued lookups fall back to the probe's lanes at once (D24),
 * while the stopped child's questions are still held at a forwarder that merges per client, so
 * the transient can form before the poll looks. So until the `hung` loss each look reads the
 * forwarder's peak first, and a loss it sees takes the window that read closed
 * (`PeakWindows.lossSeen`): the transient is allowed from at most a poll and a read's round trip
 * before the loss was seen, and no earlier.
 */
function stoppedLook(
  stats: () => StoppedStats,
  stopped: NonNullable<WorldRecord['stopped']>,
  peaks: PeakWindows | undefined,
  now: () => number = () => performance.now(),
): () => Promise<boolean> {
  return async () => {
    if (stopped.hungAt === undefined) await peaks?.cut();
    const at = now();
    const seen = stats();
    if (stopped.downAt === undefined && seen.route !== 'up') {
      stopped.downAt = at;
      await peaks?.lossSeen();
    }
    if (stopped.hungAt === undefined && seen.lossesByReason.hung > 0) {
      stopped.hungAt = at;
      await peaks?.lossSeen();
    }
    if (stopped.hungAt !== undefined && stopped.upAt === undefined && seen.state === 'up') {
      stopped.upAt = at;
    }
    return stopped.upAt !== undefined;
  };
}

/**
 * How long the helper's route read `down` after each kill, to the next kill or `endAt`, from the
 * changes the resolver was handed in order (P5, P5b). The route before the first is `up`.
 */
function routeDownAfter(
  kills: readonly number[],
  changes: readonly { readonly at: number; readonly route: RouteState }[],
  endAt: number,
): number[] {
  return kills.map((from, i) => {
    const to = kills[i + 1] ?? endAt;
    let route: RouteState = 'up';
    let since = from;
    let down = 0;
    for (const change of changes) {
      if (change.at <= from) {
        route = change.route;
        continue;
      }
      if (change.at >= to) break;
      if (route === 'down') down += change.at - since;
      route = change.route;
      since = change.at;
    }
    if (route === 'down') down += to - since;
    return down;
  });
}

/**
 * The pool's workers as P2 makes them (`P-472`, through the pool's `createWorker`): the sensor each
 * is running, read off the pool's `run` message on its way, and the sensor whose worker's message is
 * being read, for the ask the pool hands the resolver from its own listener next. This listener is
 * the first on each worker, so it reads each message before the pool does. Nothing is changed.
 */
class WorkerRuns {
  readonly #running = new WeakMap<Worker, number>();
  #asking: number | undefined;

  readonly create = (filename: string, options: WorkerOptions): Worker => {
    const worker = new Worker(filename, options);
    worker.on('message', (message: unknown) => {
      this.#asking =
        isRecord(message) && message['type'] === 'resolve' ? this.#running.get(worker) : undefined;
    });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: unknown, transfer?: Parameters<Worker['postMessage']>[1]) => {
      if (
        isRecord(message) &&
        message['type'] === 'run' &&
        typeof message['sensorId'] === 'number'
      ) {
        this.#running.set(worker, message['sensorId']);
      }
      post(message, transfer);
    };
    return worker;
  };

  /** The sensor whose worker's ask is being handed on, once. */
  asker(): number | undefined {
    const sensor = this.#asking;
    this.#asking = undefined;
    return sensor;
  }
}

/**
 * An answering name's ask as the pool handed it to the resolver (P2, `P-472`), on the main thread,
 * where the resolver reads the helper's route: the sensor whose check the asking worker was running,
 * and how the resolver replied, in that call (`now`: an answer it had, or a refusal) or later, or
 * not at all.
 */
interface ResolverAsk {
  readonly host: string;
  readonly at: number;
  /** Undefined where the worker's run was not seen. */
  readonly sensorId: number | undefined;
  readonly waitMs: number | undefined;
  reply?: {
    readonly at: number;
    readonly now: boolean;
    readonly ok: boolean;
    readonly message: string | undefined;
  };
}

/** An answering check that did not answer, as the pool's result said (P2, `P-472`). */
interface CheckEnd {
  readonly host: string;
  readonly sensorId: number;
  readonly ended: NotAnsweredEnd;
  /** When its result was read, on the main thread, and how long it ran in its worker. */
  readonly endedAt: number;
  readonly durationMs: number;
}

/** What P2 saw of its stopped child, on the main thread's clock, for `hangFacts`. */
interface HangSeen {
  readonly stoppedAt: number;
  /** The stopped child's index in the tap's fork order: undefined if the tap had none of its pid. */
  readonly child: number | undefined;
  /** The stopped child's last answer, to any lookup. */
  readonly lastAnswerAt: number | undefined;
  /** The route's changes, as the resolver was handed them. */
  readonly changes: readonly { readonly at: number; readonly route: RouteState }[];
  readonly sent: readonly TapFlight[];
  readonly routed: readonly Pick<Routed, 'at' | 'host' | 'pool'>[];
  /** When each name was answered, on either lane set. */
  readonly answeredAt: (host: string) => readonly number[];
  /** When each name's lookups began on the probe's lanes. */
  readonly probeStarts: ReadonlyMap<string, readonly number[]>;
  readonly asks: readonly ResolverAsk[];
  readonly checks: readonly CheckEnd[];
  /** Each answering check the pool accepted, by name, and when. */
  readonly accepted: readonly { readonly host: string; readonly at: number }[];
  /** How late the main thread can have been to read anything (`HangFacts.lagMs`). */
  readonly lagMs: number | undefined;
  readonly groupOf: (host: string) => Group;
}

/**
 * How an answering check that did not answer ended, by its words (P2, `P-472`), as `count` tallies
 * it: the given-up words first, at the check's own bound or in the resolver's, which it says at
 * once; then D27's refusal among the rest; then any other words.
 */
function endedBy(message: string): NotAnsweredEnd {
  if (GIVEN_UP.test(message)) return AT_ITS_BOUND.test(message) ? 'givenUp' : 'givenUpAtOnce';
  return AVOIDED.test(message) ? 'refused' : 'failed';
}

/**
 * Whether an ask can be a check's that ended so: a refusal's reply was D27's words; a check given
 * up, or failed in other words, was not served an answer in the call, nor refused.
 */
function askFits(ended: NotAnsweredEnd, ask: ResolverAsk): boolean {
  const reply = ask.reply;
  const refused = reply !== undefined && !reply.ok && AVOIDED.test(reply.message ?? '');
  if (ended === 'refused') return refused;
  return !refused && !(reply?.now === true && reply.ok);
}

/**
 * Each answering check not answered, put to its own ask at the resolver (`hangFacts`): its own
 * sensor's last ask of its name between when it began, less the main thread's lag, and when its
 * result was read, since a sensor runs one check at a time and its worker asks before it answers;
 * and that ask must fit how it ended. Failing an ask of its sensor, an ask of its name whose
 * worker's run was not seen, that fits, not taken by another, and the nearest to when it began (its
 * result's time less its run), within the main thread's lag of it: one farther may be another
 * check's, so the check's ask is not measured.
 */
function placeChecks(seen: HangSeen): NotAnswered[] {
  const since = (at: number): number => at - seen.stoppedAt;
  const asksOf = new Map<string, ResolverAsk[]>();
  for (const ask of seen.asks) {
    const name = ask.host.toLowerCase();
    const list = asksOf.get(name);
    if (list === undefined) asksOf.set(name, [ask]);
    else list.push(ask);
  }
  const taken = new Set<ResolverAsk>();
  const ms = (at: number): string => `${String(Math.round(at))} ms`;
  return [...seen.checks]
    .sort((a, b) => a.endedAt - b.endedAt)
    .map((check): NotAnswered => {
      const name = check.host.toLowerCase();
      const ofName = (asksOf.get(name) ?? []).filter(
        (ask) => !taken.has(ask) && ask.at <= check.endedAt,
      );
      const end = {
        host: name,
        ended: check.ended,
        endedAtMs: since(check.endedAt),
      };
      const placed = (ask: ResolverAsk): NotAnswered => {
        taken.add(ask);
        return { ...end, askedAtMs: since(ask.at), waitMs: ask.waitMs };
      };
      const notPlaced = (why: string, ask?: ResolverAsk): NotAnswered => {
        if (ask !== undefined) taken.add(ask);
        return { ...end, askedAtMs: undefined, notPlaced: why, waitMs: undefined };
      };
      // Its worker asked once it began, and the start its result gives is late by at most the
      // lag: an ask of its sensor before that is an earlier check's.
      const began = check.endedAt - check.durationMs;
      const from = began - (seen.lagMs ?? Number.POSITIVE_INFINITY);
      const own = ofName.filter((ask) => ask.sensorId === check.sensorId && ask.at >= from).at(-1);
      if (own !== undefined) {
        return askFits(check.ended, own)
          ? placed(own)
          : notPlaced(`its own sensor’s ask at ${ms(since(own.at))} did not end so`, own);
      }
      let nearest: ResolverAsk | undefined;
      for (const ask of ofName) {
        if (ask.sensorId !== undefined || !askFits(check.ended, ask)) continue;
        if (nearest === undefined || Math.abs(ask.at - began) < Math.abs(nearest.at - began)) {
          nearest = ask;
        }
      }
      if (nearest === undefined) return notPlaced('no ask of its sensor or its name was seen');
      const off = Math.abs(nearest.at - began);
      if (seen.lagMs === undefined) {
        return notPlaced(
          'no ask of its sensor was seen, and the lag to place one of its name by was not measured',
        );
      }
      if (off > seen.lagMs) {
        return notPlaced(
          `no ask of its sensor was seen, and its name’s nearest was ${ms(off)} from its start, past the ${ms(seen.lagMs)} lag measured`,
        );
      }
      return placed(nearest);
    });
}

/**
 * P2's facts for its allowance (`P-472`), from what the arm saw, in ms from the SIGSTOP:
 * - **the route's window**, from the changes the resolver was handed: `down` from the first after
 *   the SIGSTOP, to the next that is not `down`;
 * - **kept off**: the names of the stopped child's lookups sent before the route left `up` and not
 *   ended by then, which are its table at the quiet (the tap reads each answer before the helper),
 *   and not measured where the tap had no child of the stopped pid;
 * - **held back**: the names routed to the helper before then whose lookup had been neither sent to a
 *   child nor answered by the stopped child's last answer, so queued behind its lanes;
 * - **each answering check not answered**, put to its own ask (`placeChecks`), with when its result
 *   was read;
 * - **the kept-off names' lookups begun on the probe's own lanes** since the route left `up`, and
 *   each kept-off answering name's checks the pool accepted and asks the resolver was handed since:
 *   what that judged.
 */
function hangFacts(seen: HangSeen): HangFacts {
  const since = (at: number): number => at - seen.stoppedAt;
  const down = seen.changes.find(({ at, route }) => at >= seen.stoppedAt && route === 'down')?.at;
  const downUntil =
    down === undefined
      ? undefined
      : seen.changes.find(({ at, route }) => at > down && route !== 'down')?.at;
  const namesByGroup = (hosts: Iterable<string>): Partial<Record<Group, string[]>> => {
    const grouped: Partial<Record<Group, string[]>> = {};
    for (const host of [...new Set(hosts)].sort()) {
      const group = seen.groupOf(host);
      (grouped[group] ??= []).push(host);
    }
    return grouped;
  };
  const keptOff =
    seen.child === undefined
      ? undefined
      : down === undefined
        ? []
        : seen.sent
            .filter(
              ({ child, sentAt, endedAt }) =>
                child === seen.child && sentAt < down && (endedAt === undefined || endedAt > down),
            )
            .map(({ host }) => host.toLowerCase());
  const lastSaid = seen.lastAnswerAt ?? seen.stoppedAt;
  const heldBack =
    down === undefined
      ? []
      : seen.routed
          .filter(({ at, host, pool }) => {
            if (pool !== 'helper' || at >= down) return false;
            const name = host.toLowerCase();
            const inside = (t: number): boolean => t >= at && t <= lastSaid;
            return (
              !seen.sent.some(
                (flight) => flight.host.toLowerCase() === name && inside(flight.sentAt),
              ) && !seen.answeredAt(name).some(inside)
            );
          })
          .map(({ host }) => host.toLowerCase());
  const keptOffNames = new Set(keptOff);
  const keptOffOnProbe =
    down === undefined
      ? []
      : [...seen.probeStarts]
          .filter(([host]) => keptOffNames.has(host.toLowerCase()))
          .flatMap(([host, starts]) =>
            starts.filter((at) => at >= down).map((at) => ({ host, atMs: since(at) })),
          )
          .sort((a, b) => a.atMs - b.atMs);
  const kept = namesByGroup(keptOff ?? []);
  const until = downUntil ?? Number.POSITIVE_INFINITY;
  const keptOffChecked =
    down === undefined
      ? []
      : (kept.answering ?? []).map((host) => {
          const asks = seen.asks.filter((ask) => ask.host.toLowerCase() === host && ask.at >= down);
          return {
            host,
            accepted: seen.accepted.filter(
              (check) => check.host.toLowerCase() === host && check.at >= down,
            ).length,
            asked: asks.length,
            askedWhileDown: asks.filter((ask) => ask.at < until).length,
          };
        });
  return {
    downAtMs: down === undefined ? undefined : since(down),
    downUntilMs: downUntil === undefined ? undefined : since(downUntil),
    lagMs: seen.lagMs,
    keptOff: keptOff === undefined ? undefined : kept,
    heldBack: namesByGroup(heldBack),
    notAnswered: placeChecks(seen),
    keptOffOnProbe,
    keptOffChecked,
  };
}

/**
 * What P2's allowance used, for its row: the route's window and the lag its times are given, what
 * the stopped child held and held back, how many answering checks it allowed of each kind and when
 * they were asked, how many fell outside it and why, the kept-off names on the probe's lanes since
 * and how many kept-off answering names were checked while the route read `down` (rule 4 judges
 * only those), and `avoidedRefused`; and, given them, how many answering asks the resolver was
 * handed and how many carried their sensor, which is what places a check by its own ask.
 */
function hangLine(
  hang: HangFacts,
  avoidedRefused: number,
  asks?: { readonly handed: number; readonly ofSensor: number },
): string {
  const s = (at: number | undefined): string =>
    at === undefined ? 'never' : `${(at / 1_000).toFixed(1)} s`;
  const span = (checks: readonly NotAnswered[]): string => {
    const times = checks.flatMap(({ askedAtMs }) => (askedAtMs === undefined ? [] : [askedAtMs]));
    return times.length === 0 ? 'none' : `${s(Math.min(...times))}–${s(Math.max(...times))}`;
  };
  const counts = (of: HangFacts['heldBack']): Partial<Record<Group, number>> => {
    const counted: Partial<Record<Group, number>> = {};
    for (const group of ['answering', 'silent', 'cached', 'crash'] as const) {
      const names = of[group];
      if (names !== undefined) counted[group] = names.length;
    }
    return counted;
  };
  const verdict = hangAllowance(hang);
  const givenUp = hang.notAnswered.filter(({ ended }) => ended === 'givenUp').length;
  const atOnce = hang.notAnswered.filter(({ ended }) => ended === 'givenUpAtOnce').length;
  const otherwise = hang.notAnswered.length - givenUp - atOnce;
  const whys = [...new Set(verdict.outside.map(({ why }) => why))];
  const checked = hang.keptOffChecked;
  return (
    `the hang's allowance (P-472), from the SIGSTOP: the route down ${s(hang.downAtMs)} to ${s(hang.downUntilMs)}, the main thread's lag ${hang.lagMs === undefined ? 'unread' : `${String(Math.round(hang.lagMs))} ms`}; ` +
    `in flight in the stopped child as it left up ${hang.keptOff === undefined ? 'not measured' : byGroup(counts(hang.keptOff))}; held back behind it ${byGroup(counts(hang.heldBack))}; ` +
    `answering given up at their bound ${String(givenUp)}, ${String(verdict.givenUpAllowed.length)} allowed (asked ${span(verdict.givenUpAllowed)}, before the route left up, for those names), and in the resolver's words ${String(atOnce)}; ` +
    `failed otherwise ${String(otherwise)}, ${String(verdict.refusedAllowed.length)} allowed as D27's refusals of names in flight at the quiet (asked ${span(verdict.refusedAllowed)}, while it read down); ` +
    `outside it ${String(verdict.outside.length)}${whys.length === 0 ? '' : ` (${whys.join('; ')})`}; ` +
    `kept-off names on the probe's lanes since ${String(hang.keptOffOnProbe.length)}, kept-off answering names checked while it read down ${String(checked.filter(({ askedWhileDown }) => askedWhileDown > 0).length)} of ${String(checked.length)}; ` +
    `answering checks refused as avoided names ${String(avoidedRefused)}` +
    (asks === undefined
      ? ''
      : `; answering asks handed the resolver ${String(asks.handed)}, ${String(asks.ofSensor)} with their sensor read`)
  );
}

interface Routed {
  readonly at: number;
  readonly host: string;
  readonly route: string;
  readonly pool: string;
  readonly why: string | undefined;
  readonly key: string;
}

/**
 * The gate's log, at debug: each lookup's route (§1.3), and the lines the arms count. What Probe
 * Health no longer carries (the user's OPEN-5: six name fields, not fourteen) is read here, from
 * the lines the resolver and its check log: the check proven, its misses and its stand-downs.
 */
class GateLog {
  readonly routed: Routed[] = [];
  readonly passedStuck: string[] = [];
  unsafe = 0;
  proven = false;
  misses = 0;
  standDowns = 0;
  readonly errors: string[] = [];
  readonly stream = {
    write: (line: string): void => {
      if (line.includes('the DNS check is proven')) this.proven = true;
      if (line.includes('the DNS check missed a name the lookup helper answered')) this.misses += 1;
      if (line.includes('it stands down, and every name is asked in the lookup helper')) {
        this.standDowns += 1;
      }
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
  /** What is printed: the teardown's line is added once the world is torn down. */
  readonly lines: string[];
  /** Filled in once the world is torn down. */
  readonly teardown: WorldTeardown;
}

interface WorldTeardown {
  /** Lookups still open on the probe's lanes once everything had stopped: none, or a leak. */
  laneLookupsLeft: number | undefined;
}

/** How long the probe's lanes may take to let go of their lookups once the world stops. */
const TEARDOWN_BOUND_MS = 2_000;

/** `monitorEventLoopDelay`'s resolution: what it records is each timer's delta, this included. */
const DELAY_RESOLUTION_MS = 10;
/** A recorded delta as the loop's delay past the resolution. */
const lagMs = (nanoseconds: number): string =>
  `${Math.max(0, nanoseconds / 1e6 - DELAY_RESOLUTION_MS).toFixed(1)} ms`;

/** An arm's sensors, how many a device, and their interval. */
interface WorldShape {
  readonly sensors: number;
  readonly perDevice: number;
  readonly intervalSeconds: number;
}

/** Whether an arm's name check is on: its own, or off for the environment by `MS_DNS_CHECK`. */
function armCheckOn(arm: Pick<WorldArm, 'check'>, checkOff: boolean): boolean {
  return arm.check === undefined ? !checkOff : arm.check === 'on';
}

/**
 * The v1 target's 5,000 sensors on 500 devices at 60 s, or for `walkrate` and its baseline twice
 * the names at the same checks a second: 10,000 devices of one sensor at 120 s.
 */
function worldShape(arm: WorldArm): WorldShape {
  return arm.twiceTheNames === true
    ? { sensors: 2 * SENSORS, perDevice: 1, intervalSeconds: 2 * INTERVAL_SECONDS }
    : { sensors: SENSORS, perDevice: SENSORS_PER_DEVICE, intervalSeconds: INTERVAL_SECONDS };
}

/**
 * `partial`'s row for its cached checks given up (`P-478`'s fix round 2): the names and checks the
 * judge allows, the rest, the longest a cached name waited from its first ask to its first answer,
 * and the words they gave up with.
 */
function cachedRow(
  facts: WorldFacts,
  intervalSeconds: number,
  firstAsked: ReadonlyMap<string, number>,
): string {
  const given = facts.cachedGivenUp;
  if (given === undefined) return 'cached given up: not recorded';
  const allowance = cachedAllowance(facts);
  const waits = Object.entries(given.firstAnswerMs).flatMap(([name, answered]) => {
    const asked = firstAsked.get(name);
    return asked === undefined ? [] : [answered - asked];
  });
  const words = new Map<string, number>();
  for (const { message } of given.checks) {
    const said = wordsOf(message);
    words.set(said, (words.get(said) ?? 0) + 1);
  }
  return (
    `cached given up: ${String(allowance.checks)} checks of ${String(allowance.names)} names allowed (asked within the arm’s first scan interval of ${String(intervalSeconds)} s, before the name’s first answer and the ${given.lagMs === undefined ? 'unmeasured' : `${String(Math.round(given.lagMs))} ms`} lag, in a held name’s words), ${String(allowance.refused.length)} not; ` +
    `the longest a cached name waited for its first answer ${waits.length === 0 ? 'none answered' : `${String(Math.round(Math.max(...waits)))} ms`}, ${String(Object.keys(given.firstAnswerMs).length)} answered; ` +
    `words: ${[...words].map(([said, n]) => `${String(n)} × ${said}`).join(' | ') || 'none'}`
  );
}

async function worldSoak(arm: WorldArm, mode: GateMode): Promise<WorldRun> {
  const fdsBefore = openFds();
  const shape = worldShape(arm);
  const devices = Math.ceil(shape.sensors / shape.perDevice);
  const deviceOf = (sensorId: number): number =>
    Math.floor((sensorId - 1) / shape.perDevice) % devices;
  const checkOn = armCheckOn(arm, CHECK_OFF);
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
  const peaks = arm.transient === true ? PeakWindows.of(sim) : undefined;
  const dir = await mkdtemp(join(tmpdir(), 'ms-perf-gate-'));
  const tallies: Record<Group | 'all', WorldTally> = {
    all: { results: 0, answered: 0, givenUp: 0, other: 0 },
    answering: { results: 0, answered: 0, givenUp: 0, other: 0 },
    silent: { results: 0, answered: 0, givenUp: 0, other: 0 },
    cached: { results: 0, answered: 0, givenUp: 0, other: 0 },
    crash: { results: 0, answered: 0, givenUp: 0, other: 0 },
  };
  /** The checks the wheel made due that the pool did not run, by group: refused or deferred. */
  const notRun: Record<Group, number> = { answering: 0, silent: 0, cached: 0, crash: 0 };
  /** Answering checks failed by D27's refusal of a name in flight at an earlier loss (`P-453`). */
  let avoidedRefused = 0;
  /** `partial`: each cached check given up, by its name and when it was asked (`P-478`). */
  const cachedGivenUp: { readonly name: string; readonly at: number; readonly message: string }[] =
    [];
  /** The helper's route as each change of it was handed to the resolver, and when (gate mode). */
  const routeChanges: { readonly at: number; readonly route: RouteState }[] = [];
  /** P2: each answering name's ask at the resolver, and each answering check not answered. */
  const resolverAsks: ResolverAsk[] = [];
  const checkEnds: CheckEnd[] = [];
  const acceptedChecks: { readonly host: string; readonly at: number }[] = [];
  const runs = new WorkerRuns();
  const asks = new Map<number, number[]>();
  const jitter: number[] = [];
  const run: number[] = [];
  const lateBySensor = new Map<number, number>();
  const record: WorldRecord = { kills: [], killedAt: [] };
  const walks = new WalkCounter();
  const log = new GateLog();
  const tap = new HelperTap(groupOf);
  const delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  const lags: { readonly at: number; readonly ms: number }[] = [];
  let names: NameResolution | undefined;
  let pool: CheckPool | undefined;
  let wheel: TimingWheel | undefined;
  let probe: ProbeSide | undefined;
  let sampler: NodeJS.Timeout | undefined;
  let lagSampler: NodeJS.Timeout | undefined;
  let inFlightMax = 0;
  let rssPeak = 0;
  const resolverPeak = { running: 0, queued: 0 };
  let lines: string[] | undefined;
  const teardown: WorldTeardown = { laneLookupsLeft: undefined };
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
    const lanes = new ProbeSide(port, groupOf);
    probe = lanes;
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
      policy: { files, platform: 'linux', env: checkOn ? {} : { RES_OPTIONS: 'ndots:1' } },
      check: { asker: walks.wrap(caresAsker({ port })) },
      resolver: {
        lookup: lanes.lookup,
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
    // Every change of the helper's route, as the resolver is handed it: where the route read
    // `down`, D27 refuses a name in flight at an earlier loss, and nothing else says when.
    const resolver = built.resolver;
    const handOn = resolver.onHelperChange.bind(resolver);
    resolver.onHelperChange = (change) => {
      routeChanges.push({ at: performance.now(), route: change.route });
      handOn(change);
    };
    if (arm.hang === true) {
      // Each answering name's ask as the pool hands it over, where the resolver reads the route,
      // and its reply: the change above is handed a microtask after the route moves, in the turn
      // it moves in, so no ask comes between them. The check's own result says when it ended, but
      // reads its start only as late as the main thread is busy, so each ask carries its sensor.
      const handle = resolver.handle.bind(resolver);
      resolver.handle = (request, post) => {
        const { host, waitMs } = (isRecord(request) ? request : {}) as {
          host?: unknown;
          waitMs?: unknown;
        };
        if (typeof host !== 'string' || groupOf(host) !== 'answering') {
          runs.asker();
          handle(request, post);
          return;
        }
        const ask: ResolverAsk = {
          host: host.toLowerCase(),
          at: performance.now(),
          sensorId: runs.asker(),
          waitMs: typeof waitMs === 'number' ? waitMs : undefined,
        };
        resolverAsks.push(ask);
        let inCall = true;
        handle(request, (message: ResolveAck | ResolveReply) => {
          if (message.type === 'resolved' && ask.reply === undefined) {
            ask.reply = {
              at: performance.now(),
              now: inCall,
              ok: message.ok,
              message: message.ok ? undefined : message.message,
            };
          }
          post(message);
        });
        inCall = false;
      };
    }
    await within(START_BOUND_MS, 'the names’ start', built.start());
    const policy = built.gate?.policy;
    if (policy !== undefined) {
      // On and proven by its canary, or off for the environment as the arm or `MS_DNS_CHECK` says:
      // the policy's word and the check's own log, since Probe Health carries no check state.
      await pollWithin(
        START_BOUND_MS,
        () =>
          `the check ${checkOn ? 'on and proven' : 'off'}: the policy says ${policy.checkOn() ? 'on' : 'off'}, proven ${String(log.proven)}`,
        () => (checkOn ? policy.checkOn() && log.proven : !policy.checkOn()),
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
      ...(arm.hang === true ? { createWorker: runs.create } : {}),
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
        if (group === 'answering' && result.outcome !== 'ok' && AVOIDED.test(result.message)) {
          avoidedRefused += 1;
        }
        if (arm.hang === true && group === 'answering' && result.outcome !== 'ok') {
          checkEnds.push({
            host: worldHost(arm, device),
            sensorId: result.sensorId,
            ended: endedBy(result.message),
            endedAt: performance.now(),
            durationMs: result.durationMs,
          });
        }
        if (group === 'cached' && result.outcome !== 'ok' && GIVEN_UP.test(result.message)) {
          cachedGivenUp.push({
            name: worldHost(arm, device),
            at: performance.now() - result.durationMs,
            message: result.message,
          });
        }
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
          const device = deviceOf(sensorId);
          const outcome = checks.submit({
            sensorId,
            sensorType: 'test.named',
            target: { host: worldHost(arm, device), ipVersion: 'auto' },
            params: { timeoutMs: SNMP_TIMEOUT_MS, delayMs: MODEL_CHECK_MS },
            timeoutMs: SCAN_TIMEOUT_MS,
          });
          // Refused for a full queue, or deferred behind its own check: due, and not answered.
          if (outcome === 'accepted') lateBySensor.set(sensorId, wheelMs);
          else notRun[arm.group(device)] += 1;
          if (arm.hang === true && outcome === 'accepted' && arm.group(device) === 'answering') {
            acceptedChecks.push({ host: worldHost(arm, device), at: performance.now() });
          }
        }
      },
    });
    wheel = ticking;
    for (let id = 1; id <= shape.sensors; id += 1) {
      ticking.add({ id, intervalSeconds: shape.intervalSeconds });
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
    const rssStart = process.memoryUsage().rss;
    rssPeak = rssStart;
    sampler = setInterval(() => {
      inFlightMax = Math.max(inFlightMax, health.report().lookupsInFlight ?? 0);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      const resolverStats = built.resolver.stats();
      resolverPeak.running = Math.max(resolverPeak.running, resolverStats.running);
      resolverPeak.queued = Math.max(resolverPeak.queued, resolverStats.queued);
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
    await arm.events?.({ at, names: built, sim, pool: checks, probe: lanes, tap, record, peaks });
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
    const rssEnd = process.memoryUsage().rss;
    rssPeak = Math.max(rssPeak, rssEnd);
    const peakWindows = await peaks?.finish();
    const report = health.report();
    const stats = checks.stats();
    const wheelStats = ticking.stats();
    // Every check the pool did not run is counted by its group, as the pool itself counts them: a
    // count that missed one would let `spread10`'s gate shed checks unseen.
    const notRunCounted = Object.values(notRun).reduce((sum, n) => sum + n, 0);
    assert.equal(
      notRunCounted,
      stats.refused + stats.deferred,
      `the checks not run by group, ${JSON.stringify(notRun)}, against the pool's refused ${String(stats.refused)} and deferred ${String(stats.deferred)}`,
    );
    const gauge = (await sim.gauge('ns1'))[0];
    const queries = await sim.log();
    // Of gate mode's own counters, only the two Probe Health still carries (OPEN-5): the rest are
    // read from the log and the helper's channel below.
    const gateHealth = built.resolver.gateHealth();
    const risk = built.resolver.riskSeen();
    const helperStats: LookupHelperStats | undefined = built.gate?.helper.stats();
    const trouble = built.gate?.latch.value() ?? 0;
    const budgetPeak = built.questionsPeak?.peek();

    // --- The facts ---------------------------------------------------------------------------
    const answers = (host: string): number[] =>
      [...(lanes.answeredAt.get(host) ?? []), ...(tap.answeredAt.get(host) ?? [])].sort(
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
            routeDownMs: routeDownAfter(
              record.kills.map(({ at: when }) => when),
              routeChanges,
              stoppedAt,
            ),
            avoidedRefused,
          }
        : undefined;
    const stopped = record.stopped;
    const stoppedChild =
      stopped?.pid === undefined
        ? undefined
        : tap.children.findIndex(({ pid }) => pid === stopped.pid);
    const hang: HangFacts | undefined =
      arm.hang === true && stopped !== undefined
        ? hangFacts({
            stoppedAt: stopped.at,
            child: stoppedChild === undefined || stoppedChild < 0 ? undefined : stoppedChild,
            lastAnswerAt:
              stoppedChild === undefined ? undefined : tap.children[stoppedChild]?.lastAnswerAt,
            changes: routeChanges,
            sent: tap.sent,
            routed: log.routed,
            answeredAt: answers,
            probeStarts: lanes.startedAt,
            asks: resolverAsks,
            checks: checkEnds,
            accepted: acceptedChecks,
            // The histogram's longest turn, its resolution in it: no task waited longer than that.
            lagMs: delay.max > 0 ? delay.max / 1e6 : undefined,
            groupOf,
          })
        : undefined;
    const stall = record.stall;
    const facts: WorldFacts = {
      arm: arm.name,
      mode,
      checkOn,
      q: Q,
      ...peakFacts(gauge?.peakHeldByClass['other'] ?? 0, peaks, lossTimes(record)),
      transient: arm.transient === true ? 8 * Q : 0,
      dropped: gauge?.dropped ?? 0,
      walkSends: walks.sends,
      givenUp: {
        answering: tallies.answering.givenUp,
        silent: tallies.silent.givenUp,
        cached: tallies.cached.givenUp,
        crash: tallies.crash.givenUp,
      },
      failedOtherwise: {
        answering: tallies.answering.other,
        silent: tallies.silent.other,
        cached: tallies.cached.other,
        crash: tallies.crash.other,
      },
      refused: stats.refused,
      probeLanes: lanes.calls,
      helperPeak: tap.peak,
      ...(afterSilence === undefined ? {} : { afterSilence }),
      ...(gapsOver === undefined ? {} : { gapsOver }),
      ...(steady === undefined ? {} : { steady }),
      ...(keptLate === undefined ? {} : { keptLate }),
      ...(arm.cached === true
        ? {
            cachedGivenUp: {
              intervalMs: shape.intervalSeconds * 1_000,
              lagMs: delay.max > 0 ? delay.max / 1e6 : undefined,
              firstAnswerMs: Object.fromEntries(
                [...groupByHost]
                  .filter(([, group]) => group === 'cached')
                  .flatMap(([name]) => {
                    const answered = answers(name)[0];
                    return answered === undefined ? [] : [[name, answered - startedAt] as const];
                  }),
              ),
              checks: cachedGivenUp.map(({ name, at: when, message }) => ({
                name,
                askedMs: when - startedAt,
                message,
              })),
            },
          }
        : {}),
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
      ...(hang === undefined ? {} : { hang }),
      ...(stall === undefined
        ? {}
        : {
            stall: {
              ...stallSetUp(stall, queries),
              unsafeMarks: log.unsafe,
              passedStuck: log.passedStuck.filter((host) => groupOf(host) === 'answering').length,
            },
          }),
      ...(respawn === undefined ? {} : { respawn }),
      ...(arm.name === 'P6'
        ? {
            probeCrashes: lanes.crashes,
            crashAskedOnceAnswering: (asks.get(0) ?? []).filter(
              (at) => record.crashZoneAnsweredAt !== undefined && at >= record.crashZoneAnsweredAt,
            ).length,
          }
        : {}),
      eventLoopP99Ms: Math.max(0, delay.percentile(99) / 1e6 - DELAY_RESOLUTION_MS),
      channelsBusiestSecond: busiestSecond(walks.channels),
      namesWalked: walks.names,
      answeringResults: tallies.answering.results,
      answeringNotRun: notRun.answering,
      inFlightMax: Math.max(inFlightMax, report.lookupsInFlight ?? 0),
      ...(risk === undefined ? {} : { risk }),
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
    const walkSends = walks.all();
    const reads: WorldReads = {
      rss: { start: rssStart, peak: rssPeak, end: rssEnd },
      resolverPeak,
      channels: { opened: walks.channels.length, busiestSecond: busiestSecond(walks.channels) },
      ...(mode === 'gate' ? { children: tap.byChild } : {}),
    };
    const windowsRead =
      peakWindows === undefined
        ? ''
        : `; by window (${String(peakWindows.length)} read), ${stretches(peakWindows)
            .map(
              (w) =>
                `${(w.fromMs / 1_000).toFixed(1)}–${(w.toMs / 1_000).toFixed(1)} s ${String(w.peak)}${w.transient ? ' (after a loss)' : ''}`,
            )
            .join(
              ', ',
            )}, to the arm's end at ${peaks?.endMs === undefined ? 'unread' : `${(peaks.endMs / 1_000).toFixed(1)} s`}; the losses at ${(facts.lossesAt ?? []).map(({ atMs, seen }) => `${(atMs / 1_000).toFixed(1)} s${seen ? ' (seen)' : ''}`).join(', ') || 'none'}${peaks?.failed === undefined ? '' : `; a read failed: ${peaks.failed}`}`;
    const tally = (label: string, t: WorldTally): string =>
      `${label} ${String(t.answered)} of ${String(t.results)} answered, ${String(t.givenUp)} given up, ${String(t.other)} failed otherwise`;
    lines = [
      `${arm.label}: ${mode}${mode === 'gate' && !checkOn ? ' (check off)' : ''}`,
      `${String(wheelStats.dispatched)} dispatched; ${tally('all', tallies.all)}; refused ${String(stats.refused)}, deferred ${String(stats.deferred)}, timed out ${String(stats.timedOut)}`,
      (['answering', 'silent', 'cached', 'crash'] as const)
        .filter((group) => tallies[group].results > 0 || notRun[group] > 0)
        .map(
          (group) =>
            `${tally(group, tallies[group])}${notRun[group] > 0 ? `, and ${String(notRun[group])} more due not run (refused or deferred)` : ''}`,
        )
        .join('; '),
      ...(arm.cached === true && mode === 'gate'
        ? [
            cachedRow(
              facts,
              shape.intervalSeconds,
              new Map(
                [...groupByHost]
                  .filter(([, group]) => group === 'cached')
                  .flatMap(([name]) => {
                    const times = asks.get(deviceByHost.get(name) ?? -1) ?? [];
                    return times.length === 0
                      ? []
                      : [[name, Math.min(...times) - startedAt] as const];
                  }),
              ),
            ),
          ]
        : []),
      `jitter p50 ${ms(percentile(ordered, 0.5))}, p95 ${ms(percentile(ordered, 0.95))}, max ${ms(ordered.at(-1) ?? 0)}; check run p95 ${ms(percentile(sorted(run), 0.95))}; drained in ${ms(drainMs)}`,
      `event loop: p50 ${lagMs(delay.percentile(50))}, p99 ${lagMs(delay.percentile(99))}, max ${lagMs(delay.max)}`,
      `Probe Health: lookupsInFlight max ${String(Math.max(inFlightMax, report.lookupsInFlight ?? 0))}, last ${String(report.lookupsInFlight)}; lookupsGivenUp ${String(report.lookupsGivenUp)}`,
      `forwarder: the probe's most slots held at once ${String(facts.peakHeld)}, bound ${String(heldBound(facts))}${windowsRead}; dropped ${String(facts.dropped)}; questions by source: walk ${String(sources.get(WORLD_ADDRESS) ?? 0)}, probe lanes ${String(sources.get(PROBE_SOURCE) ?? 0)}, helper ${String(sources.get(HELPER_SOURCE) ?? 0)}${budgetPeak === undefined ? '' : `; the budget's questionsOpen peak ${String(budgetPeak)}`}`,
      `walk: ${String(walkSends.length)} questions, busiest second ${String(busiestSecond(walkSends))}, past D19's bucket ${String(overBucket(walkSends))}${facts.steady === undefined ? '' : 'notReached' in facts.steady ? `; steady state not reached (${facts.steady.notReached})` : `; steady state ${facts.steady.perSecond.toFixed(2)} a second`}`,
      mode === 'gate'
        ? `routes: ${[...routes].map(([kind, n]) => `${kind} ${String(n)}`).join(', ') || 'none'}; sampled ${String(routes.get('sampled/probe') ?? 0)}; keys routed both heard and silent ${String(mixed)}`
        : 'routes: every lookup on the probe’s lanes (system)',
      `getaddrinfo on the probe's lanes: ${byGroup(lanes.calls)} (most at once ${byGroup(lanes.peak)}); in the helper's child, most at once: ${byGroup(tap.peak)}`,
      ...readsLines(reads),
      ...(gateHealth === undefined
        ? []
        : [
            `gate: routed heard or sampled ${String(log.routed.filter(({ route }) => route === 'heard' || route === 'sampled').length)}, sent to the helper's children ${String(tap.byChild.reduce((sum, asked) => sum + Object.values(asked).reduce((n, v) => n + v, 0), 0))}, passedStuck ${String(gateHealth.passedStuck)}, helperStuck ${String(gateHealth.helperStuck)}; the check ${checkOn ? 'on' : 'off'}, proven ${String(log.proven)}, misses ${String(log.misses)}, stood down ${String(log.standDowns)}, walks deferred ${String(log.routed.filter(({ why }) => why === 'budget' || why === 'rate' || why === 'stall' || why === 'scoutWait').length)}; at risk at a pick at most ${risk === undefined ? 'unread' : `${String(risk.atRisk)} (overshoot ${String(risk.overshoot)}), the gate admitted at most ${String(risk.admitted)}`}`,
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
      ...(hang === undefined
        ? []
        : [
            hangLine(hang, avoidedRefused, {
              handed: resolverAsks.length,
              ofSensor: resolverAsks.filter(({ sensorId }) => sensorId !== undefined).length,
            }),
          ]),
      ...(facts.stall === undefined
        ? []
        : [
            `the stall: ${ms(facts.stall.ms)}; its lookup open as it began ${String(facts.stall.unsettledAtStart)}, its reply sent before it ended ${String(facts.stall.replySent)}, answered ${facts.stall.answeredAfterMs === undefined ? 'never' : `${ms(facts.stall.answeredAfterMs)} after it`}; ${String(record.stall?.repliesDuring)} replies sent meanwhile to every client; unsafe marks ${String(facts.stall.unsafeMarks)}, answering names said passed-stuck ${String(facts.stall.passedStuck)}`,
          ]),
      ...(respawn === undefined
        ? []
        : [
            `respawns: ${String(respawn.kills)} kills, held at the memory gate at each ${String(respawn.heldAtEveryKill)} (ceiling ${String(stats.ceiling)} of ${String(stats.maxSize)}, size ${String(stats.size)}); fork to ready ${respawn.forkToReadyMs.map((n) => ms(n)).join(', ')}; the event loop's most around each fork ${respawn.lagAroundForkMs.map((n) => ms(n)).join(', ')} against ${ms(respawn.lagBaselineMs)} before; the helper's resident set at ${String(RESPAWN_RSS_AT_MS / 1_000)} s ${respawn.helperRssAt60s === undefined ? 'unread' : `${(respawn.helperRssAt60s / MIB).toFixed(0)} MiB`}; the probe's at each kill ${record.kills.map((kill) => `${(kill.probeRss / MIB).toFixed(0)} MiB`).join(', ')}`,
            `the route down after each kill (D27 refuses a name avoided at an earlier one only then): ${respawn.routeDownMs.map((n) => ms(n)).join(', ')}; answering checks so refused ${String(respawn.avoidedRefused)}`,
          ]),
      ...(facts.probeCrashes === undefined
        ? []
        : [
            `the crash name asked on the probe's own lanes: ${String(facts.probeCrashes)}; its zone answering from ${record.crashZoneAnsweredAt === undefined ? 'never' : `${ms(record.crashZoneAnsweredAt - startedAt)} into the arm`}, and the name checked ${String(facts.crashAskedOnceAnswering ?? 0)} times since`,
          ]),
      ...(log.errors.length === 0
        ? []
        : [
            `errors logged: ${String(log.errors.length)}, the first: ${log.errors.slice(0, 3).join(' | ')}`,
          ]),
    ];
    return { arm, mode, results: tallies.all.results, facts, lines, teardown };
  } finally {
    wheel?.stop();
    delay.disable();
    clearInterval(sampler);
    clearInterval(lagSampler);
    await pool?.stop();
    // Before the resolver: its lane lookups run on past its stop, and so do those it has queued.
    probe?.stop();
    await names?.stop();
    await sim.stop();
    await rm(dir, { recursive: true, force: true });
    const left = probe;
    if (left !== undefined) {
      await pollWithin(
        TEARDOWN_BOUND_MS,
        'the probe’s lanes let go',
        () => left.inFlight() === 0,
        10,
      ).catch(() => undefined);
      teardown.laneLookupsLeft = left.inFlight();
    }
    // Sockets and pipes close a turn or two after they are told to.
    await new Promise((resolve) => setImmediate(resolve));
    lines?.push(
      teardownLine({ before: fdsBefore, after: openFds() }, teardown.laneLookupsLeft ?? 0),
    );
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
        `${String(COLD_MINUTES)} min, steady ${String(INTERVAL_SECONDS)} s then ${String(STEADY_MINUTES)} min; ` +
        `walkrate and its baseline ${String(2 * SENSORS)} names of one sensor at ${String(2 * INTERVAL_SECONDS)} s, ` +
        `${String(COLD_MINUTES)} min and ${String(MINUTES)} min; spread10 ${String(COLD_MINUTES)} min\n` +
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
        // Held against another run of this process (`P-465`), run first where it has not been,
        // whatever MS_DNS_ARMS and MS_DNS_RESOLVER pick: without it the arm is held to nothing.
        const wanted = arm.baseline?.(mode);
        let base: WorldRun | undefined;
        if (wanted !== undefined) {
          base = runs.find((run) => run.arm.name === wanted.arm && run.mode === wanted.mode);
          const baseArm = WORLD_ARMS.find(({ name }) => name === wanted.arm);
          if (base === undefined && baseArm !== undefined) {
            base = await worldSoak(baseArm, wanted.mode);
            base.lines[0] = `${base.lines[0] ?? ''} (run first, as ${arm.name}'s baseline)`;
            runs.push(base);
            assert.deepEqual(judgeWorld(base.facts), [], base.lines.join('\n'));
            assert.equal(base.teardown.laneLookupsLeft, 0, base.lines.join('\n'));
          }
        }
        const one = await worldSoak(arm, mode);
        runs.push(one);
        const facts: WorldFacts =
          base === undefined ? one.facts : { ...one.facts, baseline: baselineOf(base.facts) };
        if (base !== undefined) {
          const held = baselineOf(base.facts);
          // `spread10`'s headroom: what the gate must answer to pass, against what system did.
          const bound = arm.name === 'spread10' ? spread10Bound(facts, held) : undefined;
          one.lines.push(
            `held against ${base.arm.name}, ${base.mode}: event loop p99 ${held.eventLoopP99Ms === undefined ? 'unread' : `${held.eventLoopP99Ms.toFixed(1)} ms`}, answering checks not answered ${String(held.answeringNotAnswered)} of ${String(held.answeringChecks)}` +
              (bound === undefined
                ? ''
                : `; the gate's bound ${String(bound.bound)} not answered of its ${String(bound.checks)} (system's and ${String(bound.noise)} of noise), so it must answer ${String(bound.mustAnswer)} where system answered ${String(bound.systemAnswered)}, and it answered ${String(bound.checks - bound.notAnswered)}`),
          );
        }
        assert.ok(one.results > 0, 'checks ran');
        assert.deepEqual(judgeWorld(facts), [], one.lines.join('\n'));
        // Torn down: nothing left asking on the probe's lanes, to run on into the next arm.
        assert.equal(one.teardown.laneLookupsLeft, 0, one.lines.join('\n'));
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// What the gate's arms rest on, shown to fail where it should: the model's table against glibc's
// recordings, the model's own code against its table at the simulator, and the judge against runs
// made to break each assertion. Run in every `test:perf`, in about three seconds.
// ---------------------------------------------------------------------------------------------

describe('the gate arms’ model is glibc’s, and their judge fails what it should (P-432 S7)', () => {
  const rows = JSON.parse(readFileSync(FIXTURES('system-names-rows.json'), 'utf8')) as RecordedRows;
  const fixture = JSON.parse(readFileSync(FIXTURES('system-names-recordings.json'), 'utf8')) as {
    readonly images: Readonly<Record<string, unknown>>;
    readonly recordings: readonly Recording[];
  };
  const recordings = fixture.recordings;
  /** Every image the fixture was recorded in: seven at S8's recording. */
  const images = Object.keys(fixture.images).sort();

  it('GLIBC_QUESTIONS is the wire glibc sent, in every image a row was recorded in (D30’s recording A)', () => {
    const held = glibcDisagreements(rows, recordings);
    assert.deepEqual(held.disagreements, []);
    // Never vacuous: every family, and the silent plans' tries, compared in every one of the
    // images, by name; one image's recordings alone would clear any count.
    assert.ok(images.length >= 7, `the fixture's images: ${images.join(', ')}`);
    assert.deepEqual(glibcCoverageGaps(held, images), []);
  });

  it('a fixture with an image’s rows left unplayed is told apart, though its counts clear any floor', () => {
    const [first, last] = [images[0] ?? '', images.at(-1) ?? ''];
    const without = recordings.filter((recording) => recording.image !== first);
    const held = glibcDisagreements(rows, without);
    assert.deepEqual(held.disagreements, []);
    // What the old floor (7 a family, 14 silent) read as enough.
    assert.ok(held.byFamily[0] >= 7 && held.byFamily[4] >= 7 && held.byFamily[6] >= 7);
    assert.ok(held.silent >= 14);
    assert.deepEqual(glibcCoverageGaps(held, images), [
      `family 0 compared in no recording of ${first}`,
      `family 4 compared in no recording of ${first}`,
      `family 6 compared in no recording of ${first}`,
      `no silent plan compared in ${first}`,
    ]);
    // An image's silent plans recorded under a name the model does not play.
    const renamed = recordings.map((recording) =>
      recording.image === last && recording.plan === 'all-silent'
        ? { ...recording, plan: 'all-silent-again' }
        : recording,
    );
    assert.deepEqual(glibcCoverageGaps(glibcDisagreements(rows, renamed), images), [
      `no silent plan compared in ${last}`,
    ]);
  });

  it('glibcLookup, the code the arms ask with, puts on the wire what glibcWire says try by try, and gives up when glibcSchedule says', async () => {
    const sim = await DnsSimulator.start({
      servers: [{ name: 'ns1', address: WORLD_ADDRESS }],
      zones: {
        'answer.test': { reply: replies.addresses('192.0.2.1', '2001:db8::1') },
        'nxdomain.test': { reply: replies.nxdomain },
        'silent.test': { reply: replies.silent },
        // One type answered and the other not: glibc's single-request switch, not played.
        'partial.test': { a: replies.addresses('192.0.2.1'), aaaa: replies.silent },
      },
      ipv6: false,
    });
    // `options timeout:1 attempts:2`: a silent lookup in two seconds.
    const schedule = glibcSchedule(1, 2);
    const model = glibcLookup({
      server: { address: WORLD_ADDRESS, port: sim.server('ns1').port },
      localAddress: WORLD_ADDRESS,
      schedule,
    });
    type Ended = { readonly ms: number } & (
      { readonly addresses: readonly ModelAddress[] } | { readonly code: string }
    );
    const ask = async (host: string, family: ModelFamily): Promise<Ended> => {
      const from = performance.now();
      try {
        const addresses = await model.lookup(host, family);
        return { ms: performance.now() - from, addresses };
      } catch (error) {
        const { code } = error as { readonly code?: unknown };
        return { ms: performance.now() - from, code: String(code) };
      }
    };
    const answers: Readonly<Record<ModelFamily, readonly ModelAddress[]>> = {
      0: [
        { address: '192.0.2.1', family: 4 },
        { address: '2001:db8:0:0:0:0:0:1', family: 6 },
      ],
      4: [{ address: '192.0.2.1', family: 4 }],
      6: [{ address: '2001:db8:0:0:0:0:0:1', family: 6 }],
    };
    try {
      const plans = ['answer', 'nxdomain', 'silent'] as const;
      const asked = ([0, 4, 6] as const).flatMap((family) =>
        plans.map((plan) => ({ family, plan, host: `f${String(family)}.${plan}.test` })),
      );
      const ended = await within(
        10_000,
        'the model’s lookups',
        Promise.all([
          ...asked.map(({ host, family }) => ask(host, family)),
          ask('f0.partial.test', 0),
        ]),
      );
      const log = await sim.log();
      /** What reached the simulator for `host`, try by try: a try is the wait it was sent in. */
      const wire = (host: string): (readonly [string, string, string, number])[] => {
        const entries = log.filter((entry) => entry.qname === host).sort((a, b) => a.seq - b.seq);
        const from = entries[0]?.at ?? 0;
        return entries.map((entry) => [
          entry.server,
          entry.qname,
          entry.qtype,
          1 + Math.round((entry.at - from) / schedule.waitMs),
        ]);
      };
      asked.forEach(({ family, plan, host }, index) => {
        const said = `family ${String(family)}, ${plan}`;
        const one = ended[index];
        assert.ok(one !== undefined);
        assert.deepEqual(
          wire(host),
          glibcWire('ns1', host, family, plan === 'silent' ? 'silent' : 'replied', schedule),
          said,
        );
        if (plan === 'answer') {
          const byFamily = (list: readonly ModelAddress[]): ModelAddress[] =>
            [...list].sort((a, b) => a.family - b.family);
          assert.deepEqual(
            'addresses' in one ? byFamily(one.addresses) : one.code,
            answers[family],
            said,
          );
        } else if (plan === 'nxdomain') {
          assert.deepEqual('code' in one ? one.code : one.addresses, 'ENOTFOUND', said);
        } else {
          // As the recordings hold glibc to it: every try's wait, and less than a second more.
          assert.deepEqual('code' in one ? one.code : one.addresses, 'EAI_AGAIN', said);
          const waited = schedule.tries * schedule.waitMs;
          assert.ok(one.ms >= waited - 5 && one.ms < waited + 1_000, `${said}: ${ms(one.ms)}`);
        }
      });
      // The partial reply: its one try, then the model's own code at that try's end.
      const partial = ended.at(-1);
      assert.ok(partial !== undefined && 'code' in partial, JSON.stringify(partial));
      assert.equal(partial.code, PARTIAL_CODE);
      assert.ok(
        partial.ms >= schedule.waitMs - 5 && partial.ms < schedule.waitMs + 1_000,
        ms(partial.ms),
      );
      assert.deepEqual(wire('f0.partial.test'), [
        ['ns1', 'f0.partial.test', 'A', 1],
        ['ns1', 'f0.partial.test', 'AAAA', 1],
      ]);
      assert.equal(model.inFlight(), 0);
    } finally {
      model.close();
      await sim.stop();
    }
  });

  it('the model’s close ends its lookups at once, socket and timer with them, and fails every later one before it asks', async () => {
    const sim = await DnsSimulator.start({
      servers: [{ name: 'ns1', address: WORLD_ADDRESS }],
      zones: { 'silent.test': { reply: replies.silent } },
      ipv6: false,
    });
    const server = { address: WORLD_ADDRESS, port: sim.server('ns1').port };
    let sent = 0;
    const model = glibcLookup({
      server,
      localAddress: WORLD_ADDRESS,
      schedule: WORLD_SCHEDULE,
      onSent: () => {
        sent += 1;
      },
    });
    const binding = glibcLookup({ server, localAddress: WORLD_ADDRESS, schedule: WORLD_SCHEDULE });
    const code = async (lookup: Promise<unknown>): Promise<string> => {
      try {
        await lookup;
        return 'answered';
      } catch (error) {
        return String((error as { readonly code?: unknown }).code);
      }
    };
    try {
      // Asked, its question with the kernel, its next try 15 s off: then closed.
      const asked = code(model.lookup('asked.silent.test', 4));
      await pollWithin(5_000, 'the question sent', () => sent === 1, 5);
      assert.equal(model.inFlight(), 1);
      model.close();
      assert.equal(model.inFlight(), 0);
      assert.equal(await within(500, 'the closed lookup', asked), 'EAI_AGAIN');
      // After the close: failed at once, and never asked.
      assert.equal(
        await within(500, 'a lookup after the close', code(model.lookup('after.silent.test', 4))),
        'EAI_AGAIN',
      );
      // Closed while its socket binds: nothing is sent on the closed socket.
      const early = code(binding.lookup('binding.silent.test', 4));
      binding.close();
      assert.equal(await within(500, 'a lookup closed as it binds', early), 'EAI_AGAIN');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const names = (await sim.log()).map((entry) => entry.qname);
      assert.deepEqual(names, ['asked.silent.test']);
    } finally {
      model.close();
      binding.close();
      await sim.stop();
    }
  });

  it('an arm prints what it read: its resident set, the resolver’s peaks, the walk’s channels, each child’s lookups, and its file descriptors', async () => {
    const reads: WorldReads = {
      rss: { start: 100 * MIB, peak: 150 * MIB, end: 120 * MIB },
      resolverPeak: { running: 6, queued: 40 },
      channels: { opened: 30, busiestSecond: 5 },
      children: [{ silent: 10, answering: 1 }, { silent: 6 }],
    };
    const printed = readsLines(reads).join('\n');
    assert.match(printed, /100 MiB at the start, 150 MiB at most, 120 MiB at the drain/u);
    assert.match(printed, /the resolver's most running 6 and queued 40/u);
    assert.match(printed, /the walk's channels 30, busiest second 5/u);
    assert.match(printed, /children's lookups: #1 answering 1, silent 10; #2 silent 6/u);
    const system = { rss: reads.rss, resolverPeak: reads.resolverPeak, channels: reads.channels };
    assert.equal(readsLines(system).length, 1, 'no helper in system mode');
    assert.match(
      teardownLine({ before: 40, after: 43 }, 0),
      /40 before, 43 after \(\+3\); lookups left on the probe's lanes 0/u,
    );
    assert.match(
      teardownLine({ before: undefined, after: 12 }, 2),
      /unread \(no \/proc\); lookups left on the probe's lanes 2/u,
    );
    // On Linux, where the arms run, /proc says; a socket open is one more.
    const before = openFds();
    if (process.platform === 'linux') assert.notEqual(before, undefined, '/proc/self/fd read');
    if (before !== undefined) {
      const socket = createSocket('udp4');
      await new Promise<void>((resolve) => {
        socket.bind({ address: WORLD_ADDRESS, port: 0 }, resolve);
      });
      assert.equal(openFds(), before + 1);
      await new Promise<void>((resolve) => {
        socket.close(resolve);
      });
    }
  });

  /** A clock a test moves, and its timers, each fired `early` ms before it is due, as Node's may. */
  const manualClock = (): {
    readonly clock: PeakClock;
    set(ms: number): void;
    fire(early?: number): void;
  } => {
    let now = 0;
    const due: { readonly at: number; readonly run: () => void; cancelled: boolean }[] = [];
    return {
      clock: {
        now: () => now,
        after: (ms, run) => {
          const timer = { at: now + ms, run, cancelled: false };
          due.push(timer);
          return {
            cancel: () => {
              timer.cancelled = true;
            },
          };
        },
      },
      set: (ms) => {
        now = ms;
      },
      fire: (early = 0.5) => {
        const next = due.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at)[0];
        assert.ok(next !== undefined, 'a timer due');
        next.cancelled = true;
        now = next.at - early;
        next.run();
      },
    };
  };
  const windowRows = (
    windows: readonly PeakWindow[],
  ): (readonly [number, number, number, boolean])[] =>
    windows.map(({ fromMs, toMs, peak, transient }) => [fromMs, toMs, peak, transient] as const);

  it('the forwarder’s peak windows: a loss’s window ends at its own end though its timer fires early, and an overlapping loss keeps the transient to the later end', async () => {
    const time = manualClock();
    let read = 0;
    const peaks = new PeakWindows(
      () => {
        read += 1;
        return Promise.resolve(read);
      },
      { clock: time.clock, windowMs: 10_000 },
    );
    time.set(2_000);
    await peaks.loss();
    time.fire();
    time.set(20_000);
    await peaks.loss();
    time.set(25_000);
    await peaks.loss();
    time.fire();
    time.fire();
    time.set(50_000);
    const windows = await peaks.finish();
    assert.deepEqual(
      windows.map(({ fromMs, toMs, transient }) => [fromMs, toMs, transient]),
      [
        [0, 2_000, false],
        [2_000, 11_999.5, true],
        [11_999.5, 20_000, false],
        [20_000, 25_000, true],
        [25_000, 29_999.5, true],
        [29_999.5, 34_999.5, true],
        [34_999.5, 50_000, false],
      ],
    );
    assert.equal(peaks.failed, undefined);
    assert.equal(peaks.endMs, 50_000);
    // The judge places them by the losses: the one at 25 s carries the 20 s loss's transient on,
    // 15 s in one run, and without it that run is past a loss's window.
    const kills = [2_000, 20_000, 25_000].map((atMs): LossAt => ({ atMs, seen: false }));
    const facts: WorldFacts = {
      ...clean('P1', 'gate'),
      peakHeld: 7,
      peakWindows: windows,
      peakWindowsEndMs: 50_000,
      lossesAt: kills,
    };
    assert.deepEqual(judgeWorld(facts), []);
    assert.ok(
      judgeWorld({ ...facts, lossesAt: kills.slice(0, 2) }).some((said) =>
        /transient was allowed at 20\.0–35\.0 s, past the 10500 ms after a loss/u.test(said),
      ),
    );
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
    routeDownMs: [0, 0, 0, 0],
    avoidedRefused: 0,
  };

  /**
   * A clean P2's hang (`P-472`), shaped as S7's first full-size run had it, in ms from the SIGSTOP:
   * the route down from 3.3 s to the `hung` loss at 20.3 s; one answering name and three silent in
   * flight in the stopped child at the quiet, and fourteen answering names held back behind it; eight
   * checks given up, asked in the first 0.8 s on that name or behind it; and four of that name's
   * refused by D27 while the route read down.
   */
  const KEPT = 'dev-1.zone-a.test';
  const HELD = Array.from({ length: 14 }, (_, i) => `dev-${String(10 * i + 3)}.zone-a.test`);
  const HELD_ONE = 'dev-3.zone-a.test';
  const SILENT_KEPT = ['dev-0.zone-b.test', 'dev-10.zone-b.test', 'dev-20.zone-b.test'];
  /** Given up at its bound, its result read 5 ms after its wait ran out unless said. */
  const gave = (
    host: string,
    askedAtMs: number | undefined,
    waitMs = 2_500,
    endedAtMs = (askedAtMs ?? 0) + waitMs + 5,
  ): NotAnswered => ({ host, ended: 'givenUp', askedAtMs, waitMs, endedAtMs });
  const refused = (host: string, askedAtMs: number | undefined): NotAnswered => ({
    host,
    ended: 'refused',
    askedAtMs,
    waitMs: 2_500,
    endedAtMs: (askedAtMs ?? 0) + 1,
  });
  const cleanHang: HangFacts = {
    downAtMs: 3_300,
    downUntilMs: 20_300,
    lagMs: 40,
    keptOff: { answering: [KEPT], silent: SILENT_KEPT },
    heldBack: { answering: HELD },
    // The kept-off name's checks given up, then refused while down; the held-back names' bounds
    // run out before the route left up.
    notAnswered: [
      ...[KEPT, ...HELD.slice(0, 7)].map((host, i) => gave(host, 10 + 100 * i)),
      ...[4_100, 8_000, 12_500, 18_900].map((at) => refused(KEPT, at)),
    ],
    keptOffOnProbe: [],
    keptOffChecked: [{ host: KEPT, accepted: 4, asked: 4, askedWhileDown: 4 }],
  };
  /** A clean P2's facts with its hang's checks, and the checks counted to match. */
  const withHang = (
    notAnswered: readonly NotAnswered[],
    patch: Partial<HangFacts> = {},
  ): Partial<WorldFacts> => ({
    givenUp: {
      answering: notAnswered.filter(({ ended }) => ended === 'givenUp' || ended === 'givenUpAtOnce')
        .length,
      silent: 40,
      cached: 0,
    },
    failedOtherwise: {
      answering: notAnswered.filter(({ ended }) => ended === 'refused' || ended === 'failed')
        .length,
      silent: 9,
      cached: 0,
    },
    hang: { ...cleanHang, notAnswered, ...patch },
  });

  const cleanStall: NonNullable<WorldFacts['stall']> = {
    ms: 15_000,
    replySent: true,
    unsettledAtStart: true,
    answeredAfterMs: 3,
    unsafeMarks: 0,
    passedStuck: 0,
  };

  /**
   * The forwarder's peak in a clean P1 and P2, by window from its start: a loss's window holds the
   * transient, every other one the bound. P1's kills at about 8 s and 98 s from the forwarder's
   * start, P2's detach and `hung` loss at about 17 s and 34 s.
   */
  const lossWindows = (arm: string): PeakWindow[] => {
    const [first, second] = arm === 'P1' ? [8_000, 98_000] : [17_000, 34_000];
    return [
      { fromMs: 0, toMs: first, peak: 18, transient: false },
      { fromMs: first, toMs: first + LOSS_WINDOW_MS, peak: 26, transient: true },
      { fromMs: first + LOSS_WINDOW_MS, toMs: second, peak: 18, transient: false },
      { fromMs: second, toMs: second + LOSS_WINDOW_MS, peak: 26, transient: true },
      { fromMs: second + LOSS_WINDOW_MS, toMs: 140_000, peak: 18, transient: false },
    ];
  };
  /** The same runs' losses: P1's kills, made by the arm; P2's detach and `hung` loss, seen. */
  const lossesOf = (arm: string): LossAt[] =>
    arm === 'P1'
      ? [
          { atMs: 8_000, seen: false },
          { atMs: 98_000, seen: false },
        ]
      : [
          { atMs: 17_000, seen: true },
          { atMs: 34_000, seen: true },
        ];
  /** Windows `stepMs` long from `fromMs` to `toMs`, as P2's look cuts one at every look. */
  const polled = (
    fromMs: number,
    toMs: number,
    transient: boolean,
    peak: number,
    stepMs = 50,
  ): PeakWindow[] =>
    Array.from({ length: Math.round((toMs - fromMs) / stepMs) }, (_, i) => ({
      fromMs: fromMs + i * stepMs,
      toMs: fromMs + (i + 1) * stepMs,
      peak,
      transient,
    }));
  /**
   * P2's windows as its look cuts them: one every 50 ms from the SIGSTOP at 13 s to the `hung`
   * loss, the detach seen at 17 s and the `hung` loss at 34 s, each taking the window the read
   * before its look closed. Kept on, the transient runs from the detach through the `hung` loss's
   * window: 26 allowed across 27.5–34 s, where 18 is the bound, in windows each 50 ms long.
   */
  const polledP2 = (keptOn: boolean): PeakWindow[] => [
    { fromMs: 0, toMs: 13_000, peak: 18, transient: false },
    ...polled(13_000, 16_950, false, 18),
    ...polled(16_950, 27_500, true, 26),
    ...polled(27_500, 33_950, keptOn, keptOn ? 26 : 18),
    { fromMs: 33_950, toMs: 34_000, peak: 26, transient: true },
    { fromMs: 34_000, toMs: 44_500, peak: 26, transient: true },
    { fromMs: 44_500, toMs: 140_000, peak: 18, transient: false },
  ];
  const withLosses = (arm: string): boolean =>
    WORLD_ARMS.find(({ name }) => name === arm)?.transient === true;

  /** A run of `arm` in `mode` that holds every assertion. */
  const clean = (arm: string, mode: GateMode): WorldFacts => ({
    arm,
    mode,
    checkOn: arm !== 'spread10',
    q: 1,
    peakHeld: mode === 'system' ? 6 : withLosses(arm) ? 26 : 18,
    transient: withLosses(arm) ? 8 : 0,
    ...(withLosses(arm)
      ? { peakWindows: lossWindows(arm), peakWindowsEndMs: 140_000, lossesAt: lossesOf(arm) }
      : {}),
    dropped: 0,
    walkSends: new Map([['127.0.0.1', mode === 'system' ? [] : [0, 100, 200]]]),
    givenUp: { answering: 0, silent: 40, cached: 0 },
    // The silent zone failing otherwise is not judged: P2's while its child is stopped.
    failedOtherwise: { answering: 0, silent: 9, cached: 0 },
    refused: 0,
    probeLanes: { answering: 100, silent: mode === 'system' ? 50 : 0 },
    helperPeak: { silent: 3 },
    afterSilence: { sampled: 2, other: 0 },
    gapsOver: [],
    steady: { perSecond: 2.5, keys: 2 },
    keptLate: [],
    helper: cleanHelper(arm),
    stopped: { downAfterMs: 3_500, hungAfterMs: 21_000, upAfterMs: 21_500 },
    stall: cleanStall,
    // P5's pool is at its full size, so its kills are never at the memory gate.
    respawn: arm === 'P5' ? { ...cleanRespawn, heldAtEveryKill: false } : cleanRespawn,
    probeCrashes: 0,
    crashAskedOnceAnswering: 5,
    eventLoopP99Ms: arm === 'addresses' ? 4 : 9,
    channelsBusiestSecond: 25,
    namesWalked: arm === 'addresses' || mode === 'system' ? 0 : 3,
    answeringResults: 3_000,
    answeringNotRun: 0,
    inFlightMax: arm === 'addresses' ? 0 : 40,
    // The gate admitted T + F at a pick, and one more at risk was a stuck lookup started ungated.
    ...(mode === 'gate' ? { risk: { atRisk: 6, overshoot: 1, admitted: 5 } } : {}),
    // The addresses arm resolves nothing: no walk, no getaddrinfo anywhere.
    ...(arm === 'addresses' ? { walkSends: new Map(), probeLanes: {}, helperPeak: {} } : {}),
    ...(arm === 'walkrate'
      ? {
          baseline: {
            arm: 'addresses',
            mode,
            eventLoopP99Ms: 4,
            answeringChecks: 3_000,
            answeringNotAnswered: 0,
          },
        }
      : {}),
    // P2's stopped child left 12 answering checks nowhere to be answered, all in its allowance.
    ...(arm === 'P2' ? withHang(cleanHang.notAnswered) : {}),
    // System gave 40 answering checks up behind its twenty silent domains; the gate 90 more, the
    // 3% of 3,000 two runs of one rule may differ by.
    ...(arm === 'spread10' && mode === 'gate'
      ? {
          givenUp: { answering: 120, silent: 40, cached: 0 },
          failedOtherwise: { answering: 10, silent: 9, cached: 0 },
          baseline: {
            arm: 'spread10',
            mode: 'system',
            eventLoopP99Ms: 9,
            answeringChecks: 3_000,
            answeringNotAnswered: 40,
          },
        }
      : {}),
  });

  const cases: readonly {
    readonly arm: string;
    readonly mode: GateMode;
    readonly breaks: string;
    readonly patch: Partial<WorldFacts>;
    /** Facts the run did not measure at all. */
    readonly omit?: readonly (keyof WorldFacts)[];
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
      breaks: 'past the transient after a loss',
      patch: {
        peakWindows: lossWindows('P1').map((w) => (w.fromMs === 8_000 ? { ...w, peak: 27 } : w)),
      },
      says: /held 27 slots for the probe at 8\.0–18\.5 s, past 26 with the transient after a loss/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'past six and twelve outside a loss',
      patch: {
        peakWindows: lossWindows('P1').map((w) => (w.fromMs === 18_500 ? { ...w, peak: 19 } : w)),
      },
      says: /held 19 slots for the probe at 18\.5–98\.0 s, past 18 outside a loss/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'twenty slots before its first loss',
      patch: {
        peakWindows: lossWindows('P2').map((w) => (w.fromMs === 0 ? { ...w, peak: 20 } : w)),
      },
      says: /held 20 slots for the probe at 0\.0–17\.0 s, past 18 outside a loss/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'its peak read once for the run',
      patch: {},
      omit: ['peakWindows'],
      says: /peak was not read across each loss/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'a stretch of its peak not read',
      patch: { peakWindows: lossWindows('P1').filter((w) => w.fromMs !== 18_500) },
      says: /peak was not read from 18500 to 98000 ms/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the transient allowed to its end',
      patch: {
        peakWindows: [
          { fromMs: 0, toMs: 17_000, peak: 18, transient: false },
          { fromMs: 17_000, toMs: 70_000, peak: 26, transient: true },
        ],
        peakWindowsEndMs: 70_000,
      },
      says: /transient was allowed at 17\.0–70\.0 s, past the 10500 ms/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks:
        'the transient kept on from its detach through its hung loss’s window, cut every 50 ms',
      patch: { peakWindows: polledP2(true) },
      says: /transient was allowed at 1[67]\.\d–44\.5 s, past the 10500 ms after a loss it lasts/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'the transient where no loss was',
      patch: {
        peakWindows: [
          ...lossWindows('P1').filter(({ fromMs }) => fromMs !== 18_500),
          { fromMs: 18_500, toMs: 50_000, peak: 18, transient: false },
          { fromMs: 50_000, toMs: 55_000, peak: 26, transient: true },
          { fromMs: 55_000, toMs: 98_000, peak: 18, transient: false },
        ].sort((a, b) => a.fromMs - b.fromMs),
      },
      says: /transient was allowed at 50\.0–55\.0 s with no loss to open it/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'the transient from before the kill it is the loss of',
      patch: {
        peakWindows: lossWindows('P1').map((w) =>
          w.fromMs === 0 ? { ...w, toMs: 7_900 } : w.fromMs === 8_000 ? { ...w, fromMs: 7_900 } : w,
        ),
      },
      says: /transient was allowed at 7\.9–18\.5 s with no loss to open it/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'its losses’ times not measured',
      patch: {},
      omit: ['lossesAt'],
      says: /the losses’ times were not measured/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'its last stretch unread (a last read that failed, unrecorded)',
      patch: { peakWindows: lossWindows('P1').filter((w) => w.fromMs !== 108_500) },
      says: /peak was not read from 108500 ms to the arm’s end at 140000 ms/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a read of its peak failed',
      patch: { peakReadFailed: 'Error: the DNS simulator did not answer gauge within 10000 ms' },
      says: /a read of the forwarder’s peak failed, so its stretch was judged against nothing/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the arm’s end not measured for its windows',
      patch: {},
      omit: ['peakWindowsEndMs'],
      says: /the arm’s end was not measured for the forwarder’s peak/u,
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
      breaks: 'an answering check failed otherwise (the gate refusing it)',
      patch: { failedOtherwise: { answering: 1, silent: 9 } },
      says: /1 answering checks failed otherwise/u,
    },
    {
      arm: 'zone',
      mode: 'gate',
      breaks: 'a check refused at the pool',
      patch: { refused: 1 },
      says: /1 checks refused/u,
    },
    {
      // Counted, and not in its hang's facts: `P-472`'s allowance takes no check it did not read.
      arm: 'P2',
      mode: 'gate',
      breaks: 'answering checks failed at the helper’s loss',
      patch: { failedOtherwise: { answering: 3, silent: 9 } },
      says: /the hang’s facts read 4 answering checks failed otherwise, where 3 were counted/u,
    },
    {
      arm: 'partial',
      mode: 'gate',
      breaks: 'a cached name failed otherwise',
      patch: { failedOtherwise: { cached: 1 } },
      says: /1 cached checks failed otherwise/u,
    },
    {
      arm: 'steady',
      mode: 'system',
      breaks: 'an answering check failed otherwise (no address)',
      patch: { failedOtherwise: { answering: 2 } },
      says: /2 answering checks failed otherwise/u,
    },
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'an answering check failed otherwise',
      patch: { failedOtherwise: { answering: 1, crash: 10 } },
      says: /1 answering checks failed otherwise/u,
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
      patch: { stopped: { downAfterMs: 3_500, hungAfterMs: 21_000, upAfterMs: 30_000 } },
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
      patch: { stall: { ...cleanStall, unsafeMarks: 1 } },
      says: /1 zones marked unsafe/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'its lookup’s reply not sent before the stall ended',
      patch: { stall: { ...cleanStall, replySent: false } },
      says: /no reply to the stall’s own question was sent before it ended/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'its lookup settled before the stall began (its reply read first)',
      patch: { stall: { ...cleanStall, unsettledAtStart: false } },
      says: /own lookup had settled before the stall began/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'its lookup never answered',
      patch: { stall: { ...cleanStall, answeredAfterMs: undefined } },
      says: /own lookup was never answered/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'its lookup answered before the stall ended',
      patch: { stall: { ...cleanStall, answeredAfterMs: -40 } },
      says: /own lookup was answered 40 ms before the stall ended/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'no stall begun',
      patch: {},
      omit: ['stall'],
      says: /the stall was not begun/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'an answering lookup said passed-stuck by the stall',
      patch: { stall: { ...cleanStall, passedStuck: 1 } },
      says: /1 answering lookups said passed-stuck/u,
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
      arm: 'P5b',
      mode: 'gate',
      breaks: 'a helper of 200 MiB at 60 s',
      patch: { respawn: { ...cleanRespawn, helperRssAt60s: 200 * MIB } },
      says: /resident set at 60 s was 209715200/u,
    },
    {
      arm: 'P5',
      mode: 'gate',
      breaks: 'a child never ready after a kill',
      patch: {
        respawn: { ...cleanRespawn, heldAtEveryKill: false, forkToReadyMs: [200, 200, 200] },
      },
      says: /3 children ready after 4 kills/u,
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
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'the crash name never checked once its zone answered',
      patch: { crashAskedOnceAnswering: 0 },
      says: /not checked once its zone answered/u,
    },
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'its zone never answering (the name never poisoned to begin it)',
      patch: {},
      omit: ['crashAskedOnceAnswering'],
      says: /not checked once its zone answered/u,
    },
    // Each rule's own call of what it shares with others, so that none is seen only passing.
    {
      arm: 'warmzone',
      mode: 'system',
      breaks: 'an answering check failed otherwise',
      patch: { failedOtherwise: { answering: 1 } },
      says: /1 answering checks failed otherwise/u,
    },
    {
      arm: 'warmzone',
      mode: 'gate',
      breaks: 'its silence not measured',
      patch: {},
      omit: ['afterSilence'],
      says: /the silence was not measured/u,
    },
    {
      arm: 'partial',
      mode: 'gate',
      breaks: 'the silent zone past 3 helper lanes with the check on',
      patch: { helperPeak: { silent: 4 } },
      says: /held 4 of the helper’s lanes/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'an answering check given up',
      patch: { givenUp: { answering: 1, silent: 40 } },
      says: /1 answering checks given up/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'a silent name on the probe’s lanes',
      patch: { probeLanes: { answering: 100, silent: 1 } },
      says: /1 getaddrinfo for the silent zone/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'no helper measured',
      patch: {},
      omit: ['helper'],
      says: /no helper was measured/u,
    },
    {
      arm: 'P1',
      mode: 'gate',
      breaks: 'no window of its peak read',
      patch: { peakWindows: [] },
      says: /no window of the forwarder’s peak was read/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a silent name on the probe’s lanes',
      patch: { probeLanes: { answering: 100, silent: 2 } },
      says: /2 getaddrinfo for the silent zone/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'no hung loss',
      patch: {
        helper: {
          ...cleanHelper('P2'),
          losses: { start: 0, skew: 0, exit: 0, hung: 0, memory: 0 },
        },
      },
      says: /0 hung losses, where 1/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the trouble latch set',
      patch: { helper: { ...cleanHelper('P2'), trouble: 1 } },
      says: /lookupHelperTrouble read 1/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'its SIGSTOP not measured',
      patch: {},
      omit: ['stopped'],
      says: /the SIGSTOP was not measured/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the hung loss late',
      patch: { stopped: { downAfterMs: 3_500, hungAfterMs: 25_000, upAfterMs: 25_500 } },
      says: /hung loss came 25000 ms after the SIGSTOP, past 22000/u,
    },
    // `P-472`: P2's allowance, each part failing on the facts that break it, at its edges.
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up, asked as the route left up',
      patch: withHang([...cleanHang.notAnswered, gave(KEPT, 3_300)]),
      says: /^1 answering checks given up outside the hang’s allowance, asked once the route had left up \(dev-1\.zone-a\.test at 3\.3 s\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up for a name neither kept off nor held back',
      patch: withHang([...cleanHang.notAnswered, gave('dev-2.zone-a.test', 500)]),
      says: /^1 answering checks given up outside the hang’s allowance, for a name neither in flight in the stopped child nor held back behind it \(dev-2\.zone-a\.test at 0\.5 s\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up whose result was read at the SIGSTOP',
      patch: withHang([...cleanHang.notAnswered, gave(HELD_ONE, -2_505, 2_500, 0)]),
      says: /^1 answering checks given up outside the hang’s allowance, its result read by the SIGSTOP, so not waiting on the stopped child/u,
    },
    // The review's D2: given up at once, in the resolver's words, before the SIGSTOP. Its words put
    // it outside, and so would its end.
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up at once in the resolver’s words before the SIGSTOP',
      patch: withHang([
        ...cleanHang.notAnswered,
        {
          host: HELD_ONE,
          ended: 'givenUpAtOnce',
          askedAtMs: -2_000,
          waitMs: 2_500,
          endedAtMs: -1_999,
        },
      ]),
      says: /^1 answering checks given up outside the hang’s allowance, in the resolver’s not-answering words, not at its own bound \(dev-3\.zone-a\.test at -2\.0 s\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks:
        'an answering check given up at once in the resolver’s words while the child was stopped',
      patch: withHang([
        ...cleanHang.notAnswered,
        { host: KEPT, ended: 'givenUpAtOnce', askedAtMs: 1_000, waitMs: 2_500, endedAtMs: 1_001 },
      ]),
      says: /^1 answering checks given up outside the hang’s allowance, in the resolver’s not-answering words, not at its own bound/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the review’s D2 with the bound’s words: its result read before the SIGSTOP',
      patch: withHang([...cleanHang.notAnswered, gave(HELD_ONE, -2_000, 2_500, -1_999)]),
      says: /^1 answering checks given up outside the hang’s allowance, its result read by the SIGSTOP/u,
    },
    // The review's D1, a fall-back made late: every held-back name's check asked from 0.9 s gives
    // up as the route leaves up, where a fall-back at `down` would have answered it.
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the held-back names’ fall-back late (the review’s D1)',
      patch: withHang([
        ...cleanHang.notAnswered,
        ...HELD.map((host, i) => gave(host, 900 + i * 183)),
      ]),
      says: /^14 answering checks given up outside the hang’s allowance, for a name held back, its bound still running as the route left up, when its lookup fell back to the probe’s lanes \(dev-3\.zone-a\.test at 0\.9 s, dev-13\.zone-a\.test at 1\.1 s, dev-23\.zone-a\.test at 1\.3 s, and 11 more\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a held-back name’s check given up with the main thread’s lag not measured',
      patch: withHang([...cleanHang.notAnswered, gave(HELD_ONE, 500)], { lagMs: undefined }),
      says: /^8 answering checks given up outside the hang’s allowance, for a name held back, the main thread’s lag not measured/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up with no wait read from its ask',
      patch: withHang([...cleanHang.notAnswered, { ...gave(HELD_ONE, 100), waitMs: undefined }]),
      says: /^1 answering checks given up outside the hang’s allowance, its wait not read from its ask/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up at no ask the resolver was handed',
      patch: withHang([...cleanHang.notAnswered, gave(KEPT, undefined)]),
      says: /^1 answering checks given up outside the hang’s allowance, its ask not measured \(no ask of it was seen\) \(dev-1\.zone-a\.test at unread\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check whose name’s nearest ask was past the lag measured',
      patch: withHang([
        ...cleanHang.notAnswered,
        {
          ...gave(KEPT, undefined),
          notPlaced:
            'no ask of its sensor was seen, and its name’s nearest was 300 ms from its start, past the 40 ms lag measured',
        },
      ]),
      says: /^1 answering checks given up outside the hang’s allowance, its ask not measured \(no ask of its sensor was seen, and its name’s nearest was 300 ms from its start, past the 40 ms lag measured\)/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a refusal asked just before the route left up',
      patch: withHang([...cleanHang.notAnswered, refused(KEPT, 3_299)]),
      says: /^1 answering checks refused by D27 outside the hang’s allowance, asked before the route left up/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a refusal asked as the route left down at the hung loss',
      patch: withHang([...cleanHang.notAnswered, refused(KEPT, 20_300)]),
      says: /^1 answering checks refused by D27 outside the hang’s allowance, asked once the route no longer read down/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a refusal of a name held back, not in flight at the quiet',
      patch: withHang([...cleanHang.notAnswered, refused(HELD_ONE, 5_000)]),
      says: /^1 answering checks refused by D27 outside the hang’s allowance, for a name not in flight in the stopped child at the quiet/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a refusal at no ask the resolver was handed',
      patch: withHang([...cleanHang.notAnswered, refused(KEPT, undefined)]),
      says: /^1 answering checks refused by D27 outside the hang’s allowance, its ask not measured/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      // Its name kept off and its ask while down, so only its words put it outside.
      breaks:
        'an answering check failed in other words (a detached lookup settled at the hung loss)',
      patch: withHang([
        ...cleanHang.notAnswered,
        { host: KEPT, ended: 'failed', askedAtMs: 5_000, waitMs: 2_500, endedAtMs: 5_001 },
      ]),
      says: /^1 answering checks failed otherwise outside the hang’s allowance, in words neither the given-up words nor D27’s refusal/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'an answering check given up that its hang’s facts did not read',
      patch: {
        ...withHang(cleanHang.notAnswered),
        givenUp: { answering: 9, silent: 40, cached: 0 },
      },
      says: /^the hang’s facts read 8 answering checks given up, where 9 were counted$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a kept-off name asked on the probe’s own lanes since the quiet',
      patch: withHang(cleanHang.notAnswered, { keptOffOnProbe: [{ host: KEPT, atMs: 4_100 }] }),
      says: /^1 getaddrinfo on the probe’s own lanes for names in flight in the stopped child, since the route left up \(dev-1\.zone-a\.test at 4\.1 s\): D27 keeps them off \(P-463\)$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'a kept-off name’s checks run since the quiet and none asked the resolver',
      patch: withHang(cleanHang.notAnswered, {
        keptOffChecked: [{ host: KEPT, accepted: 3, asked: 0, askedWhileDown: 0 }],
      }),
      says: /^1 kept-off answering names had checks run since the route left up, and none asked the resolver \(dev-1\.zone-a\.test, 3 run\): the probe’s lanes were judged on nothing of them$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the stopped child not found in the tap',
      patch: withHang(cleanHang.notAnswered, { keptOff: undefined }),
      says: /^the kept-off names were not measured: the stopped child was not found in the tap$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks:
        'the stopped child holding more answering names than the helper’s first and retry lanes',
      patch: withHang(cleanHang.notAnswered, {
        keptOff: {
          answering: Array.from(
            { length: HELPER_FIRST_AND_RETRY_LANES + 1 },
            (_, i) => `dev-${String(10 * i + 1)}.zone-a.test`,
          ),
          silent: SILENT_KEPT,
        },
      }),
      says: new RegExp(
        `^the stopped child held ${String(HELPER_FIRST_AND_RETRY_LANES + 1)} answering names at the quiet, past the helper’s ${String(HELPER_FIRST_AND_RETRY_LANES)} first-lookup and retry lanes$`,
        'u',
      ),
    },
    // The window handed late: the change is handed a microtask after the route moves, so before any
    // poll of the helper's route reads it.
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the route leaving up handed to the resolver after the helper’s route read so',
      patch: withHang(cleanHang.notAnswered, { downAtMs: 3_600 }),
      says: /^the route leaving up was handed to the resolver 3600 ms after the SIGSTOP, after the helper’s own route read so at 3500 ms: the window is not the helper’s$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the route leaving down handed to the resolver after the hung loss was seen',
      patch: withHang(cleanHang.notAnswered, { downUntilMs: 21_001 }),
      says: /^the route leaving down was handed to the resolver 21001 ms after the SIGSTOP, after the helper’s own route read so at 21000 ms: the window is not the helper’s$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the route leaving down never handed to the resolver, though the hung loss came',
      patch: withHang(cleanHang.notAnswered, { downUntilMs: undefined }),
      says: /^the route leaving down was never handed to the resolver, though the hung loss came 21000 ms after the SIGSTOP$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'its hang not measured',
      patch: {},
      omit: ['hang'],
      says: /^the hang’s allowance was not measured/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'its hang not measured, so the checks it would allow fail',
      patch: {},
      omit: ['hang'],
      says: /^8 answering checks given up$/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the route leaving up not handed to the resolver',
      patch: withHang(cleanHang.notAnswered, { downAtMs: undefined }),
      says: /^the route leaving up was not handed to the resolver/u,
    },
    {
      arm: 'P2',
      mode: 'gate',
      breaks: 'the route leaving up not handed to the resolver, so its checks fall outside',
      patch: withHang(cleanHang.notAnswered, { downAtMs: undefined }),
      says: /^8 answering checks given up outside the hang’s allowance, with no route off up handed to the resolver/u,
    },
    {
      arm: 'P3',
      mode: 'gate',
      breaks: 'a helper loss in the stall',
      patch: {
        helper: {
          ...cleanHelper('P3'),
          losses: { start: 0, skew: 0, exit: 1, hung: 0, memory: 0 },
        },
      },
      says: /1 exit losses, where 0/u,
    },
    {
      arm: 'P5',
      mode: 'gate',
      breaks: 'its respawns not measured',
      patch: {},
      omit: ['respawn'],
      says: /the respawns were not measured/u,
    },
    {
      arm: 'P6',
      mode: 'gate',
      breaks: 'two crashes where three find the name',
      patch: {
        helper: {
          ...cleanHelper('P6'),
          losses: { start: 0, skew: 0, exit: 2, hung: 0, memory: 0 },
        },
      },
      says: /2 exit losses, where 3/u,
    },
    {
      // The fourth kill's respawn past `HELPER_REJOIN_MS`: 1,000 ms of backoff and a fork late.
      arm: 'P5',
      mode: 'gate',
      breaks: 'answering checks refused as names avoided at an earlier kill',
      patch: {
        failedOtherwise: { answering: 3, silent: 9 },
        respawn: {
          ...cleanRespawn,
          heldAtEveryKill: false,
          routeDownMs: [0, 0, 0, 120],
          avoidedRefused: 3,
        },
      },
      says: /3 answering checks refused as names in flight at an earlier kill, the route down 0 ms, 0 ms, 0 ms, 120 ms after each kill/u,
    },
    {
      arm: 'walkmemory',
      mode: 'gate',
      breaks: 'no rules of its own (an arm the judge does not know)',
      patch: {},
      says: /no rules for the arm walkmemory/u,
    },
    // `P-465`: walkrate, its baseline, and spread10.
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'a lookup in flight',
      patch: { inFlightMax: 1 },
      says: /a device given as an address was resolved: lookupsInFlight read 1/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'its lookups in flight not measured',
      patch: {},
      omit: ['inFlightMax'],
      says: /lookupsInFlight was not measured/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'a name walked',
      patch: { namesWalked: 1 },
      says: /walked 1 questions for names, devices given as addresses/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'its walk not measured',
      patch: {},
      omit: ['namesWalked'],
      says: /the walk’s questions for names were not measured/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'getaddrinfo asked',
      patch: { probeLanes: { answering: 2 } },
      says: /getaddrinfo was asked 2 times for devices given as addresses/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'getaddrinfo asked in the helper',
      patch: { helperPeak: { answering: 1 } },
      says: /getaddrinfo was asked 1 times for devices given as addresses/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'its event loop not measured',
      patch: {},
      omit: ['eventLoopP99Ms'],
      says: /the event loop was not measured, so walkrate has no baseline/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'a check failed otherwise',
      patch: { failedOtherwise: { answering: 1 } },
      says: /1 answering checks failed otherwise/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'its event loop past the baseline’s and 10 ms',
      patch: { eventLoopP99Ms: 4 + WALKRATE_P99_OVER_MS + 0.5 },
      says: /p99 was 14\.5 ms, past the addresses arm’s 4\.0 ms \+ 10 ms/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'no baseline',
      patch: {},
      omit: ['baseline'],
      says: /the addresses arm was not measured in gate mode/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'a baseline of the other mode',
      patch: {
        baseline: {
          arm: 'addresses',
          mode: 'system',
          eventLoopP99Ms: 4,
          answeringChecks: 3_000,
          answeringNotAnswered: 0,
        },
      },
      says: /the addresses arm was not measured in gate mode/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'a baseline whose event loop was not measured',
      patch: {
        baseline: {
          arm: 'addresses',
          mode: 'gate',
          eventLoopP99Ms: undefined,
          answeringChecks: 3_000,
          answeringNotAnswered: 0,
        },
      },
      says: /the addresses arm was not measured in gate mode/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'its own event loop not measured',
      patch: {},
      omit: ['eventLoopP99Ms'],
      says: /^the event loop was not measured$/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'more channels in a second than the bucket allows',
      patch: { channelsBusiestSecond: CHANNELS_A_SECOND + 1 },
      says: /opened 32 channels in one second, past 31/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'its channels not measured',
      patch: {},
      omit: ['channelsBusiestSecond'],
      says: /the walk’s channels were not measured/u,
    },
    {
      // `MS_DNS_CHECK=off`: no walk, the channels at 0 and the p99 held to a run without it too.
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'the check off',
      patch: { checkOn: false, namesWalked: 0, channelsBusiestSecond: 0 },
      says: /walkrate measures the walk, and the name check was off/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'no name walked',
      patch: { namesWalked: 0 },
      says: /walkrate walked no name, so its event loop was held to the baseline without the walk/u,
    },
    {
      arm: 'walkrate',
      mode: 'gate',
      breaks: 'its walk not measured',
      patch: {},
      omit: ['namesWalked'],
      says: /the walk’s questions for names were not measured/u,
    },
    {
      arm: 'addresses',
      mode: 'gate',
      breaks: 'the check off',
      patch: { checkOn: false },
      says: /addresses is walkrate’s baseline with the name check on, and the check was off/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'the check on',
      patch: { checkOn: true },
      says: /runs the gate with its name check off, and the check was on/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'one answering check more not answered than system’s and its noise',
      patch: { failedOtherwise: { answering: 11, silent: 9 } },
      says: /131 answering checks not answered in the gate \(0 of them not run\), past system’s 40 and 90 \(3% of 3000\)/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'its answering checks not counted',
      patch: {},
      omit: ['answeringResults'],
      says: /the answering checks run and not run were not counted/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'its answering checks not run not counted',
      patch: {},
      omit: ['answeringNotRun'],
      says: /the answering checks run and not run were not counted/u,
    },
    {
      // The review's numbers: system gave up 2,979 of 3,000 at full size in a minute, so its count
      // and the noise pass a gate that gave up every one.
      arm: 'spread10',
      mode: 'gate',
      breaks: 'system answering 21 of 3,000 and the gate none',
      patch: {
        givenUp: { answering: 3_000, silent: 40 },
        failedOtherwise: { silent: 9 },
        baseline: {
          arm: 'spread10',
          mode: 'system',
          eventLoopP99Ms: 9,
          answeringChecks: 3_000,
          answeringNotAnswered: 2_979,
        },
      },
      says: /could not tell the gate from system: system answered 21 of 3000 answering checks, and with 90 of noise \(3% of 3000\) the gate passes answering 0, under 50% of that/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'system answering 55 of 3,000 and the gate failing every one otherwise',
      patch: {
        givenUp: { silent: 40 },
        failedOtherwise: { answering: 3_000, silent: 9 },
        baseline: {
          arm: 'spread10',
          mode: 'system',
          eventLoopP99Ms: 9,
          answeringChecks: 3_000,
          answeringNotAnswered: 2_945,
        },
      },
      says: /system answered 55 of 3000 answering checks, .* the gate passes answering 0/u,
    },
    {
      // At the edge: the gate would pass answering 89, under half of system's 179.
      arm: 'spread10',
      mode: 'gate',
      breaks: 'system answering 179 of 3,000, the bound passing a gate that answered 89',
      patch: {
        baseline: {
          arm: 'spread10',
          mode: 'system',
          eventLoopP99Ms: 9,
          answeringChecks: 3_000,
          answeringNotAnswered: 2_821,
        },
      },
      says: /system answered 179 of 3000 .* the gate passes answering 89, under 50% of that/u,
    },
    {
      // The pool refusing what it cannot run: the 1,500 checks that ran all answered.
      arm: 'spread10',
      mode: 'gate',
      breaks: 'half its answering checks not run, refused for a full queue',
      patch: {
        givenUp: { silent: 40 },
        failedOtherwise: { silent: 9 },
        answeringResults: 1_500,
        answeringNotRun: 1_500,
      },
      says: /1500 answering checks not answered in the gate \(1500 of them not run\), past system’s 40 and 90 \(3% of 3000\)/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'system’s run not measured',
      patch: {},
      omit: ['baseline'],
      says: /spread10 was not measured in system mode/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'a baseline of its own mode',
      patch: {
        baseline: {
          arm: 'spread10',
          mode: 'gate',
          eventLoopP99Ms: 9,
          answeringChecks: 3_000,
          answeringNotAnswered: 40,
        },
      },
      says: /spread10 was not measured in system mode/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'six at risk the gate admitted',
      patch: { risk: { atRisk: 7, overshoot: 1, admitted: 6 } },
      says: /6 of the helper’s lanes at risk at one pick that the gate admitted, past T \+ F = 5/u,
    },
    {
      arm: 'spread10',
      mode: 'gate',
      breaks: 'its lanes at risk not measured',
      patch: {},
      omit: ['risk'],
      says: /the helper’s lanes at risk were not measured/u,
    },
  ];

  it('partial allows the cached checks given up while their name is held, one episode a name: asked within the first scan interval, before the name’s first answer and the lag, in a held name’s words; no other, and no answering one (P-478 fix rounds 1 and 2)', () => {
    const base = clean('partial', 'gate');
    const b20 = 'dev-20.zone-b.test';
    const b40 = 'dev-40.zone-b.test';
    const lanes = '(dev-10.zone-b.test, dev-30.zone-b.test, dev-50.zone-b.test)';
    /** A held cached name's check, as the arm's runs at 1,000 sensors show it giving up. */
    const held = (name: string): string =>
      `the device’s host name did not resolve, querying ${name}:161 over SNMP — the probe’s resolver is not answering (every lane a lookup for ${name} could use is held by a lookup that has run past 1000 ms ${lanes}: no name of zone-b.test has answered in the lookup helper since one of its lookups ran past 1000 ms, so it holds at most 3 of the helper’s lanes; it stays queued)`;
    const placed = (
      checks: readonly {
        readonly name: string;
        readonly askedMs: number;
        readonly message?: string;
      }[],
      given: {
        readonly lagMs?: number | undefined;
        readonly firstAnswerMs?: Record<string, number>;
      } = {},
      patch: Partial<WorldFacts> = {},
    ): WorldFacts => ({
      ...base,
      givenUp: { ...base.givenUp, cached: checks.length },
      cachedGivenUp: {
        intervalMs: 60_000,
        lagMs: 'lagMs' in given ? given.lagMs : 40,
        firstAnswerMs: given.firstAnswerMs ?? { [b20]: 12_000, [b40]: 9_000 },
        checks: checks.map((check) => ({ message: held(check.name), ...check })),
      },
      ...patch,
    });
    // Its ten sensors, all asked while it was held, before its first answer at 12 s: one episode.
    const ten = placed(
      Array.from({ length: 10 }, (_, i) => ({ name: b20, askedMs: 1_000 + 1_100 * i })),
    );
    assert.deepEqual(judgeWorld(ten), [], 'ten checks of one name, before its first answer');
    assert.deepEqual(cachedAllowance(ten), { names: 1, checks: 10, refused: [] });
    // From the facts, not a count: two names.
    const two = placed([
      { name: b20, askedMs: 4_000 },
      { name: b40, askedMs: 8_999 },
    ]);
    assert.deepEqual(judgeWorld(two), []);
    assert.deepEqual(cachedAllowance(two), { names: 2, checks: 2, refused: [] });
    // Within the lag of its first answer: the main thread may have read its ask late.
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 12_039 }])), []);
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 12_040 }])), [
      'a cached check of dev-20.zone-b.test given up, asked at 12.0 s, after dev-20.zone-b.test’s first answer at 12.0 s and the 40 ms lag measured',
    ]);
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 30_000 }])), [
      'a cached check of dev-20.zone-b.test given up, asked at 30.0 s, after dev-20.zone-b.test’s first answer at 12.0 s and the 40 ms lag measured',
    ]);
    // A name never answered is held for as long as the interval.
    assert.deepEqual(
      judgeWorld(placed([{ name: b20, askedMs: 59_999 }], { firstAnswerMs: {} })),
      [],
    );
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 60_000 }], { firstAnswerMs: {} })), [
      'a cached check of dev-20.zone-b.test given up, asked at 60.0 s, past the arm’s first scan interval of 60 s',
    ]);
    // A first answer and no lag measured: not placed before it.
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 1_000 }], { lagMs: undefined })), [
      'a cached check of dev-20.zone-b.test given up, asked at 1.0 s: the lag was not measured, so it is not placed before dev-20.zone-b.test’s first answer',
    ]);
    // Words a held name's check does not give up with: its bound waited out, or another hold.
    const waited =
      'the device’s host name did not resolve within 3000 ms, querying dev-20.zone-b.test:161 over SNMP — the probe’s resolver is not answering';
    assert.deepEqual(judgeWorld(placed([{ name: b20, askedMs: 1_000, message: waited }])), [
      'a cached check of dev-20.zone-b.test given up, asked at 1.0 s, in words a held name’s check does not give up with: the device’s host name did not resolve within N ms, querying <name>:N over SNMP — the probe’s resolver is not answering',
    ]);
    const unvouched = held(b20).replace(
      /no name of zone-b\.test has answered in the lookup helper since one of its lookups ran past 1000 ms/u,
      'the DNS check does not vouch for zone-b.test now',
    );
    const atRisk = held(b20).replace(
      /no name of zone-b\.test .*$/u,
      '4 of the lookup helper’s lanes are held by lookups that may not answer, the most a name not known to answer waits behind; it stays queued)',
    );
    for (const message of [unvouched, atRisk]) {
      assert.match(
        judgeWorld(placed([{ name: b20, askedMs: 1_000, message }])).join('\n'),
        /in words a held name’s check does not give up with/u,
      );
    }
    // The facts must place every one.
    assert.deepEqual(
      judgeWorld(placed([{ name: b20, askedMs: 1_000 }], {}, { givenUp: { cached: 2 } })),
      ['2 cached checks given up, and 1 placed by name and time'],
    );
    assert.deepEqual(judgeWorld({ ...base, givenUp: { cached: 1 } }), ['1 cached checks given up']);
    // Answering checks have none, however the cached ones are placed.
    assert.deepEqual(
      judgeWorld(
        placed([{ name: b20, askedMs: 1_000 }], {}, { givenUp: { cached: 1, answering: 1 } }),
      ),
      ['1 answering checks given up'],
    );
  });

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
    // The check off: the helper's 3 a key is the helper's, not the check's, so `partial` holds the
    // silent zone to them still (`P-478`), and at 3 is clean.
    assert.deepEqual(
      judgeWorld({ ...clean('partial', 'gate'), checkOn: false, helperPeak: { silent: 5 } }),
      ['the silent zone held 5 of the helper’s lanes at once, past 3'],
    );
    assert.deepEqual(
      judgeWorld({ ...clean('partial', 'gate'), checkOn: false, helperPeak: { silent: 3 } }),
      [],
    );
    // `spread10` at the edge of telling the two apart: system answered 180 of 3,000, so the gate
    // must answer 90, half of that, and answered 2,870.
    const spread = clean('spread10', 'gate');
    const edge: Baseline = {
      arm: 'spread10',
      mode: 'system',
      eventLoopP99Ms: 9,
      answeringChecks: 3_000,
      answeringNotAnswered: 2_820,
    };
    assert.deepEqual(judgeWorld({ ...spread, baseline: edge }), [], 'system answering 180');
    // Its noise is of the checks due, not of those run: 100 not run, 30 given up, 130 in all, at
    // system's 40 and 3% of 3,000, where 3% of the 2,900 run would be 87.
    assert.deepEqual(
      judgeWorld({
        ...spread,
        givenUp: { answering: 30, silent: 40 },
        failedOtherwise: { silent: 9 },
        answeringResults: 2_900,
        answeringNotRun: 100,
      }),
      [],
      'the noise of the checks due',
    );
    // P5's route read `down` at its fourth respawn with nothing refused: printed, not judged.
    assert.deepEqual(
      judgeWorld({
        ...clean('P5', 'gate'),
        respawn: { ...cleanRespawn, heldAtEveryKill: false, routeDownMs: [0, 0, 0, 120] },
      }),
      [],
    );
  });

  it('a baseline counts the answering checks not run as checks, and as not answered', () => {
    const held = baselineOf({
      ...clean('spread10', 'system'),
      givenUp: { answering: 30, silent: 40 },
      failedOtherwise: { answering: 5, silent: 9 },
      answeringResults: 2_990,
      answeringNotRun: 10,
    });
    assert.deepEqual(
      { checks: held.answeringChecks, notAnswered: held.answeringNotAnswered },
      { checks: 3_000, notAnswered: 45 },
    );
  });

  it('spread10 runs the check off, and walkrate and addresses on, whatever MS_DNS_CHECK says', () => {
    const on = (checkOff: boolean): string[] =>
      WORLD_ARMS.filter((arm) => armCheckOn(arm, checkOff)).map(({ name }) => name);
    const named = (arm: string): WorldArm | undefined =>
      WORLD_ARMS.find(({ name }) => name === arm);
    assert.ok(['spread10', 'walkrate', 'addresses', 'zone'].every((arm) => named(arm)));
    assert.deepEqual(
      on(true).sort(),
      ['addresses', 'walkrate'],
      'MS_DNS_CHECK=off: only the arms that measure the walk',
    );
    assert.deepEqual(
      on(false).sort(),
      WORLD_ARMS.map(({ name }) => name)
        .filter((name) => name !== 'spread10')
        .sort(),
      'MS_DNS_CHECK unset: every arm but spread10',
    );
  });

  it('MS_DNS_ARMS names only arms there are, bare or by their block', () => {
    const lanes = ['addresses', 'zone'];
    const world = ['zone', 'spread10', 'P1'];
    assert.deepEqual(
      unknownArms(
        [
          'zone',
          'lanes/zone',
          'world/zone',
          'world/spread10',
          'P1',
          'addresses',
          'lanes/addresses',
        ],
        lanes,
        world,
      ),
      [],
    );
    assert.deepEqual(
      unknownArms(
        ['world/spred10', 'lanes/spread10', 'world/addresses', 'walkmemory'],
        lanes,
        world,
      ),
      ['world/spred10', 'lanes/spread10', 'world/addresses', 'walkmemory'],
    );
  });

  it('the route’s time down after each kill is read from its changes, to the next kill', () => {
    const changes: { at: number; route: RouteState }[] = [
      { at: 10, route: 'rejoining' },
      { at: 500, route: 'up' },
      { at: 30_010, route: 'rejoining' },
      { at: 32_010, route: 'down' },
      { at: 32_130, route: 'up' },
      { at: 59_000, route: 'down' },
      { at: 60_005, route: 'up' },
      { at: 60_010, route: 'down' },
    ];
    // The first respawn within its window. After the second, 120 ms down, and from a second before
    // the third. After the third, down from before it, and again to the end.
    assert.deepEqual(routeDownAfter([0, 30_000, 60_000], changes, 61_000), [0, 1_120, 995]);
    assert.deepEqual(routeDownAfter([0], [], 1_000), [0]);
  });

  const p2 = (patch: Partial<WorldFacts>): string[] =>
    judgeWorld({ ...clean('P2', 'gate'), ...patch });

  it('P2’s allowance holds on its edges, and its row says what it used (P-472)', () => {
    // Given up: a kept-off name's asked a millisecond before the route left up; a held-back name's
    // with its bound out at the route's `down` and the lag measured; one read a millisecond past the
    // SIGSTOP. Refused: asked as the route left up, and a millisecond before it left down.
    assert.deepEqual(
      p2(
        withHang([
          ...cleanHang.notAnswered,
          gave(KEPT, 3_299),
          gave(HELD_ONE, 840),
          gave(HELD_ONE, -2_504, 2_500, 1),
          refused(KEPT, 3_300),
          refused(KEPT, 20_299),
        ]),
      ),
      [],
    );
    // Given up in the resolver's words: outside, and counted among those given up.
    assert.deepEqual(
      p2(
        withHang([
          ...cleanHang.notAnswered,
          { host: KEPT, ended: 'givenUpAtOnce', askedAtMs: 100, waitMs: 2_500, endedAtMs: 101 },
        ]),
      ),
      [
        '1 answering checks given up outside the hang’s allowance, in the resolver’s not-answering words, not at its own bound (dev-1.zone-a.test at 0.1 s)',
      ],
    );
    // A millisecond on: the held-back name's bound still running as the route left up.
    assert.deepEqual(
      hangAllowance({ ...cleanHang, notAnswered: [gave(HELD_ONE, 841)] }).outside.map(
        ({ why }) => why,
      ),
      [
        'for a name held back, its bound still running as the route left up, when its lookup fell back to the probe’s lanes',
      ],
    );
    // The kept-off name keeps its rule to the quiet: the same ask is inside it.
    assert.deepEqual(hangAllowance({ ...cleanHang, notAnswered: [gave(KEPT, 841)] }).outside, []);
    // The window handed as the helper's route read so, to the millisecond, passes.
    assert.deepEqual(
      p2({
        ...withHang(cleanHang.notAnswered, { downAtMs: 3_500, downUntilMs: 21_000 }),
      }),
      [],
    );
    // As many answering names held at the quiet as the helper's first and retry lanes; and a
    // kept-off name none of whose checks the pool ran since, which the row shows unjudged.
    assert.deepEqual(
      p2(
        withHang(cleanHang.notAnswered, {
          keptOff: {
            answering: Array.from(
              { length: HELPER_FIRST_AND_RETRY_LANES },
              (_, i) => `dev-${String(10 * i + 1)}.zone-a.test`,
            ),
          },
          keptOffChecked: [
            { host: KEPT, accepted: 4, asked: 4, askedWhileDown: 4 },
            { host: 'dev-11.zone-a.test', accepted: 0, asked: 0, askedWhileDown: 0 },
          ],
        }),
      ),
      [],
    );
    // A route that never left down: a refusal at any time after it left up is inside it, and the
    // missing `hung` loss is the run's failure, by its own bound.
    const never = p2({
      ...withHang([...cleanHang.notAnswered, refused(KEPT, 50_000)], { downUntilMs: undefined }),
      stopped: { downAfterMs: 3_300, hungAfterMs: undefined, upAfterMs: undefined },
    });
    assert.ok(!never.some((said) => /allowance|handed/u.test(said)), JSON.stringify(never));
    assert.ok(
      never.some((said) => /hung loss came never/u.test(said)),
      JSON.stringify(never),
    );
    const line = hangLine(cleanHang, 4);
    assert.match(line, /the route down 3\.3 s to 20\.3 s, the main thread's lag 40 ms;/u);
    assert.match(
      line,
      /in flight in the stopped child as it left up answering 1, silent 3; held back behind it answering 14;/u,
    );
    assert.match(
      line,
      /answering given up at their bound 8, 8 allowed \(asked 0\.0 s–0\.7 s, before the route left up, for those names\), and in the resolver's words 0;/u,
    );
    assert.match(
      line,
      /failed otherwise 4, 4 allowed as D27's refusals of names in flight at the quiet \(asked 4\.1 s–18\.9 s, while it read down\);/u,
    );
    assert.match(
      line,
      /outside it 0; kept-off names on the probe's lanes since 0, kept-off answering names checked while it read down 1 of 1; answering checks refused as avoided names 4$/u,
    );
    assert.match(
      hangLine(cleanHang, 4, { handed: 900, ofSensor: 899 }),
      /refused as avoided names 4; answering asks handed the resolver 900, 899 with their sensor read$/u,
    );
    const outside = {
      ...cleanHang,
      notAnswered: [
        ...cleanHang.notAnswered,
        gave(KEPT, 3_300),
        {
          host: KEPT,
          ended: 'givenUpAtOnce',
          askedAtMs: 100,
          waitMs: 2_500,
          endedAtMs: 101,
        } as const,
      ],
    };
    assert.match(
      hangLine(outside, 4),
      /given up at their bound 9, 8 allowed .*, and in the resolver's words 1; failed otherwise 4, .*; outside it 2 \(asked once the route had left up; in the resolver’s not-answering words, not at its own bound\);/u,
    );
    assert.match(
      hangLine({ ...cleanHang, keptOff: undefined, keptOffChecked: [] }, 0),
      /in flight in the stopped child as it left up not measured; .* kept-off answering names checked while it read down 0 of 0;/u,
    );
  });

  it('P2’s allowance on the root-cause report’s three mutants, as the judge sees each run (P-472)', () => {
    const givenUp = cleanHang.notAnswered.filter(({ ended }) => ended === 'givenUp');
    const refusals = cleanHang.notAnswered.filter(({ ended }) => ended === 'refused');
    const one = (said: string[], pattern: RegExp): void => {
      assert.equal(said.length, 1, JSON.stringify(said));
      assert.match(said[0] ?? '', pattern);
    };
    // M1, no keep-off at the quiet (`P-463`'s own mutant): the name in flight then is walked, heard
    // and asked on the probe's lanes while the route reads down, and its four checks are answered
    // there. The eight given up are all in the allowance: only the new assertion fails the run.
    one(
      p2(
        withHang(givenUp, {
          keptOffOnProbe: [4_100, 8_000, 12_500, 18_900].map((atMs) => ({ host: KEPT, atMs })),
        }),
      ),
      /^4 getaddrinfo on the probe’s own lanes for names in flight in the stopped child, since the route left up \(dev-1\.zone-a\.test at 4\.1 s, dev-1\.zone-a\.test at 8\.0 s, dev-1\.zone-a\.test at 12\.5 s\)/u,
    );
    // M2, the keep-off widened to the helper's queued lookups at the quiet: those names are refused
    // as they fall back, their checks asked before the route left up, and again while it is down.
    one(
      p2(
        withHang([
          gave(KEPT, 10),
          ...HELD.slice(0, 7).map((host, i) => refused(host, 110 + 100 * i)),
          refused(HELD_ONE, 6_000),
          ...refusals,
        ]),
      ),
      /^8 answering checks refused by D27 outside the hang’s allowance, for a name not in flight in the stopped child at the quiet \(dev-3\.zone-a\.test at 0\.1 s, dev-13\.zone-a\.test at 0\.2 s, dev-23\.zone-a\.test at 0\.3 s, and 5 more\)$/u,
    );
    // M2, the refusal kept on once the route reads `rejoining` or `up`.
    one(
      p2(withHang([...cleanHang.notAnswered, refused(KEPT, 20_350), refused(KEPT, 41_000)])),
      /^2 answering checks refused by D27 outside the hang’s allowance, asked once the route no longer read down/u,
    );
    // M3, no fall-back at `down`: the queued lookups wait for the next child, and every check of
    // those names asked meanwhile joins one and gives up.
    one(
      p2(
        withHang([
          ...cleanHang.notAnswered,
          ...HELD.map((host, i) => gave(host, 4_000 + 1_000 * i)),
        ]),
      ),
      /^14 answering checks given up outside the hang’s allowance, asked once the route had left up/u,
    );
    // The review's D4: M1 collected with the stopped child not found in the tap. Its name in
    // flight reads as held back, and its starts on the probe's lanes are not looked for: what was
    // not measured fails the arm.
    one(
      p2(
        withHang(givenUp, {
          keptOff: undefined,
          heldBack: { answering: [...HELD, KEPT] },
          keptOffChecked: [],
        }),
      ),
      /^the kept-off names were not measured: the stopped child was not found in the tap$/u,
    );
  });

  it('P2’s hang is read from what the arm saw: the route’s window, the stopped child’s lookups at the quiet, those held behind it, each check at its own sensor’s ask, and the kept-off names on the probe’s lanes and checked since (P-472)', () => {
    const A = 'dev-1.zone-a.test';
    const S = 'dev-0.zone-b.test';
    const named = (n: number): string => `dev-${String(n)}.zone-a.test`;
    const flight = (host: string, child: number, sentAt: number, endedAt?: number): TapFlight => ({
      host,
      child,
      sentAt,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
    const ask = (
      host: string,
      at: number,
      sensorId: number | undefined,
      reply?: NonNullable<ResolverAsk['reply']>,
    ): ResolverAsk => ({
      host,
      at,
      sensorId,
      waitMs: 2_500,
      ...(reply === undefined ? {} : { reply }),
    });
    const avoided = (at: number): NonNullable<ResolverAsk['reply']> => ({
      at,
      now: true,
      ok: false,
      message:
        'the probe’s resolver does not ask its own getaddrinfo for dev-1.zone-a.test: the lookup helper failed while asking for it lately, and is not answering',
    });
    const end = (
      host: string,
      sensorId: number,
      ended: NotAnsweredEnd,
      endedAt: number,
      durationMs: number,
    ): CheckEnd => ({ host, sensorId, ended, endedAt, durationMs });
    const seen: HangSeen = {
      stoppedAt: 10_000,
      // The second child: the first was lost at the cold start.
      child: 1,
      lastAnswerAt: 10_002,
      changes: [
        // Down before the SIGSTOP, as a first child slow to start reads: not its quiet.
        { at: 200, route: 'down' },
        { at: 500, route: 'up' },
        { at: 13_300, route: 'down' },
        // A change of state the route stays down through.
        { at: 14_000, route: 'down' },
        { at: 30_300, route: 'rejoining' },
        { at: 30_400, route: 'up' },
      ],
      sent: [
        // Silent, from the cold start to the hung loss: kept off.
        flight(S, 1, 1_000, 30_300),
        // Answered before the SIGSTOP; ended as the route left up; the next child's.
        flight(named(5), 1, 9_000, 9_001),
        flight(named(6), 1, 12_000, 13_300),
        flight(named(8), 2, 31_000, 31_002),
        // Sent as the child stopped, and just before the quiet: kept off.
        flight(A, 1, 10_001, 30_300),
        flight(named(7), 1, 13_299.9, 30_300),
        // The first child's, never ended in the tap, and one the stopped child is shown sent after
        // the route left up: neither is the stopped child's at the quiet.
        flight(named(20), 0, 5_000),
        flight(named(21), 1, 13_500),
      ],
      routed: [
        // To the helper, and answered on the probe's lanes since (a late hear): not held back.
        { at: 8_000, host: named(11), pool: 'helper' },
        // Sent at once: not held back.
        { at: 9_000, host: named(5), pool: 'helper' },
        // Still queued at the child's last answer, and routed after it: held back.
        { at: 9_999, host: named(12), pool: 'helper' },
        { at: 10_500, host: named(13), pool: 'helper' },
        // The probe's lanes'; a silent name's, held back by its group; routed as the route left up.
        { at: 11_000, host: named(14), pool: 'probe' },
        { at: 12_000, host: S, pool: 'helper' },
        { at: 13_300, host: named(15), pool: 'helper' },
      ],
      answeredAt: (host) => (host === named(11) ? [8_100] : []),
      probeStarts: new Map([
        [A, [5_000, 13_300, 20_000]],
        // Fallen back at the quiet: held back, not kept off.
        [named(13), [13_301]],
      ]),
      asks: [
        ask(A, 10_080, 1),
        ask(A, 13_299, 5),
        ask(A, 13_301, 2, avoided(13_301)),
        ask(A, 15_000, 1, avoided(15_000)),
        // Served a kept answer in the call, and refused in words not D27's: no check given up, or
        // refused by D27, is either one's.
        ask(A, 15_450, 4, { at: 15_450, now: true, ok: true, message: undefined }),
        ask(A, 15_990, 3, {
          at: 15_990,
          now: true,
          ok: false,
          message: 'the probe’s resolver queue is full, and the name was not asked',
        }),
        // After the route read rejoining, answered.
        ask(A, 31_000, 6, { at: 31_001, now: false, ok: true, message: undefined }),
        // Answered once fallen back, after its own check had given up; and the other sensor's.
        ask(named(13), 10_480, 11, { at: 13_310, now: false, ok: true, message: undefined }),
        ask(named(13), 10_520, 12),
        // Asked after its check had ended.
        ask(named(9), 17_500, 19),
        // Their workers' runs not seen: one within the lag of its check's start, one past it.
        ask(named(40), 10_230, undefined),
        ask(named(41), 10_310, undefined),
        // Another sensor's, nearest its check's start: never its.
        ask(named(42), 10_230, 99),
        // Its own sensor's, from its check of a minute before.
        ask(named(43), 12_000, 43),
      ],
      checks: [
        // Began 10,100: its sensor's ask at 10,080, within the lag.
        end(A, 1, 'givenUp', 12_600, 2_500),
        end(named(40), 40, 'givenUp', 12_700, 2_500),
        end(named(41), 41, 'givenUp', 12_710, 2_500),
        end(named(42), 42, 'givenUp', 12_720, 2_500),
        // Each at its own sensor's ask of the name, though another's is nearer its start.
        end(named(13), 11, 'givenUp', 13_000, 2_500),
        end(named(13), 12, 'givenUp', 13_020, 2_500),
        end(A, 2, 'refused', 13_302.5, 3),
        // Its sensor's earlier ask is taken; the one at 15,000 is its own.
        end(A, 1, 'refused', 15_010, 5),
        end(A, 5, 'givenUp', 15_800, 2_500),
        end(A, 3, 'refused', 16_000, 2),
        end(named(9), 19, 'givenUp', 17_000, 2_500),
        end(A, 4, 'givenUp', 17_950, 2_500),
        end(named(43), 43, 'givenUp', 40_000, 2_500),
      ],
      accepted: [
        { host: A, at: 13_250 },
        { host: A, at: 13_350 },
        { host: A, at: 15_440 },
        { host: A, at: 31_000 },
        { host: named(7), at: 12_000 },
      ],
      lagMs: 40,
      groupOf: (host) => (host.includes('zone-b') ? 'silent' : 'answering'),
    };
    const at = (
      host: string,
      ended: NotAnsweredEnd,
      askedAtMs: number,
      endedAtMs: number,
    ): NotAnswered => ({ host, ended, askedAtMs, waitMs: 2_500, endedAtMs });
    const none = (
      host: string,
      ended: NotAnsweredEnd,
      endedAtMs: number,
      notPlaced: string,
    ): NotAnswered => ({
      host,
      ended,
      askedAtMs: undefined,
      notPlaced,
      waitMs: undefined,
      endedAtMs,
    });
    const nothing = 'no ask of its sensor or its name was seen';
    assert.deepEqual(hangFacts(seen), {
      downAtMs: 3_300,
      downUntilMs: 20_300,
      lagMs: 40,
      keptOff: { answering: [A, named(7)], silent: [S] },
      heldBack: { answering: [named(12), named(13)], silent: [S] },
      notAnswered: [
        at(A, 'givenUp', 80, 2_600),
        at(named(40), 'givenUp', 230, 2_700),
        none(
          named(41),
          'givenUp',
          2_710,
          'no ask of its sensor was seen, and its name’s nearest was 100 ms from its start, past the 40 ms lag measured',
        ),
        none(named(42), 'givenUp', 2_720, nothing),
        at(named(13), 'givenUp', 480, 3_000),
        at(named(13), 'givenUp', 520, 3_020),
        at(A, 'refused', 3_301, 3_302.5),
        at(A, 'refused', 5_000, 5_010),
        at(A, 'givenUp', 3_299, 5_800),
        none(A, 'refused', 6_000, 'its own sensor’s ask at 5990 ms did not end so'),
        none(named(9), 'givenUp', 7_000, nothing),
        none(A, 'givenUp', 7_950, 'its own sensor’s ask at 5450 ms did not end so'),
        none(named(43), 'givenUp', 30_000, nothing),
      ],
      keptOffOnProbe: [
        { host: A, atMs: 3_300 },
        { host: A, atMs: 10_000 },
      ],
      keptOffChecked: [
        { host: A, accepted: 3, asked: 5, askedWhileDown: 4 },
        { host: named(7), accepted: 0, asked: 0, askedWhileDown: 0 },
      ],
    });
    // No route off up after the SIGSTOP: nothing is kept off or held back, and no check has a window.
    const stuckUp = hangFacts({ ...seen, changes: seen.changes.slice(0, 2) });
    assert.deepEqual(
      { ...stuckUp, notAnswered: stuckUp.notAnswered.length },
      {
        downAtMs: undefined,
        downUntilMs: undefined,
        lagMs: 40,
        keptOff: {},
        heldBack: {},
        notAnswered: 13,
        keptOffOnProbe: [],
        keptOffChecked: [],
      },
    );
    // The stopped child not found in the tap: what it held is not measured, and nothing is looked
    // for on the probe's lanes, which the judge fails (the review's D4).
    const lost = hangFacts({ ...seen, child: undefined });
    assert.deepEqual([lost.keptOff, lost.keptOffOnProbe, lost.keptOffChecked], [undefined, [], []]);
  });

  it('P2’s checks end as their words say: at their own bound, in the resolver’s not-answering words, by D27’s refusal, or otherwise (P-472)', async () => {
    // The words the shipped guard gives each, as the arm's `test.named` check is failed with them.
    const said = async (resolve: ResolveHost): Promise<string> => {
      try {
        await checkedTarget({
          host: 'dev-1.zone-a.test',
          resolve,
          policy: 'link-local',
          family: 4,
          timeoutMs: 40,
          signal: new AbortController().signal,
          verb: 'query',
          doing: 'querying dev-1.zone-a.test:161 over SNMP',
        });
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('the name resolved');
    };
    const failing =
      (code: string, message: string): ResolveHost =>
      () =>
        Promise.reject(Object.assign(new Error(message), { code }));
    assert.equal(endedBy(await said(() => new Promise(() => undefined))), 'givenUp');
    for (const code of [RESOLVER_HELD, RESOLVER_STUCK, RESOLVER_FULL, 'EAI_AGAIN']) {
      assert.equal(
        endedBy(await said(failing(code, `the probe’s resolver said ${code} at once`))),
        'givenUpAtOnce',
        code,
      );
    }
    assert.equal(
      endedBy(
        await said(
          failing(
            RESOLVER_FAULT,
            'the probe’s resolver does not ask its own getaddrinfo for dev-1.zone-a.test: the lookup helper failed while asking for it lately, and is not answering',
          ),
        ),
      ),
      'refused',
    );
    assert.equal(
      endedBy(
        await said(
          failing(
            RESOLVER_FAULT,
            'the lookup helper was lost (hung) while asking for dev-1.zone-a.test',
          ),
        ),
      ),
      'failed',
    );
  });

  it('P2’s checks are placed by their own sensor’s ask, so another sensor’s ask before the quiet cannot carry one asked after it into the allowance (P-472, the review’s D3)', () => {
    const H = 'dev-3.zone-a.test';
    const d3: HangSeen = {
      stoppedAt: 10_000,
      child: 0,
      lastAnswerAt: 10_002,
      changes: [
        { at: 13_300, route: 'down' },
        { at: 30_300, route: 'rejoining' },
      ],
      sent: [],
      routed: [{ at: 10_500, host: H, pool: 'helper' }],
      answeredAt: (host) => (host === H ? [13_310] : []),
      probeStarts: new Map(),
      asks: [
        // Another sensor's, just before the quiet, answered once its lookup fell back.
        {
          host: H,
          at: 13_250,
          sensorId: 7,
          waitMs: 2_500,
          reply: { at: 13_310, now: false, ok: true, message: undefined },
        },
        // The check's own, handed after the route left up.
        { host: H, at: 13_400, sensorId: 8, waitMs: 2_500 },
      ],
      // Its worker began at 13,240, nearer the other sensor's ask than its own.
      checks: [{ host: H, sensorId: 8, ended: 'givenUp', endedAt: 15_745, durationMs: 2_505 }],
      accepted: [],
      lagMs: 40,
      groupOf: () => 'answering',
    };
    const placed = hangFacts(d3);
    assert.deepEqual(placed.notAnswered, [
      { host: H, ended: 'givenUp', askedAtMs: 3_400, waitMs: 2_500, endedAtMs: 5_745 },
    ]);
    assert.deepEqual(
      hangAllowance(placed).outside.map(({ why }) => why),
      ['asked once the route had left up'],
    );
    // Its run not seen: placed by its name within the lag, the other sensor's ask, and still
    // outside, since a held-back name's bound runs past the quiet; and past a lag measured shorter,
    // not placed at all.
    const unseen = { ...d3, asks: d3.asks.map((one) => ({ ...one, sensorId: undefined })) };
    const byName = hangFacts(unseen);
    assert.equal(byName.notAnswered[0]?.askedAtMs, 3_250);
    assert.deepEqual(
      hangAllowance(byName).outside.map(({ why }) => why),
      [
        'for a name held back, its bound still running as the route left up, when its lookup fell back to the probe’s lanes',
      ],
    );
    assert.deepEqual(hangFacts({ ...unseen, lagMs: 5 }).notAnswered, [
      {
        host: H,
        ended: 'givenUp',
        askedAtMs: undefined,
        notPlaced:
          'no ask of its sensor was seen, and its name’s nearest was 10 ms from its start, past the 5 ms lag measured',
        waitMs: undefined,
        endedAtMs: 5_745,
      },
    ]);
    assert.equal(
      hangFacts({ ...unseen, lagMs: undefined }).notAnswered[0]?.notPlaced,
      'no ask of its sensor was seen, and the lag to place one of its name by was not measured',
    );
  });

  for (const one of cases) {
    it(`${one.arm}, ${one.mode}: a run with ${one.breaks} fails`, () => {
      const patched: WorldFacts = { ...clean(one.arm, one.mode), ...one.patch };
      const facts = Object.fromEntries(
        Object.entries(patched).filter(([key]) => !(one.omit ?? []).some((left) => left === key)),
      ) as unknown as WorldFacts;
      const said = judgeWorld(facts);
      assert.ok(
        said.some((violation) => one.says.test(violation)),
        `judged ${JSON.stringify(said)}`,
      );
    });
  }

  it('a loss a poll sees takes the window its last read closed, so a transient formed before the look is the loss’s', async () => {
    const time = manualClock();
    // The forwarder's peak at each read. P2's detach falls the helper's lookups back to the
    // probe's lanes before the poll looks, so the read before that look holds the transient: 24.
    const read = [10, 10, 24, 20, 12, 9, 9];
    const peaks = new PeakWindows(() => Promise.resolve(read.shift() ?? 0), {
      clock: time.clock,
      windowMs: 10_000,
    });
    // A read, then a look, every 50 ms: the look after the third read sees the loss.
    for (const at of [10_000, 10_050, 10_100]) {
      time.set(at);
      await peaks.cut();
    }
    await peaks.lossSeen();
    // Read inside the loss's window: still the loss's. Its timer fires early, and a read just
    // after that, before the loss's end on the clock, does not open the transient again.
    time.set(15_000);
    await peaks.cut();
    time.fire();
    time.set(20_099.8);
    await peaks.cut();
    time.set(30_000);
    const windows = await peaks.finish();
    assert.deepEqual(windowRows(windows), [
      [0, 10_000, 10, false],
      [10_000, 10_050, 10, false],
      [10_050, 10_100, 24, true],
      [10_100, 15_000, 20, true],
      [15_000, 20_099.5, 12, true],
      [20_099.5, 20_099.8, 9, false],
      [20_099.8, 30_000, 9, false],
    ]);
    const facts: WorldFacts = {
      ...clean('P2', 'gate'),
      peakHeld: 24,
      peakWindows: windows,
      peakWindowsEndMs: 30_000,
      lossesAt: [{ atMs: 10_100, seen: true }],
    };
    assert.deepEqual(judgeWorld(facts), []);
    // The window before the look judged outside the loss, as a poll that read after it did: the
    // transient held to the bound, and a run that holds it failed.
    const readAfter = windows.map((w) => (w.fromMs === 10_050 ? { ...w, transient: false } : w));
    assert.ok(
      judgeWorld({ ...facts, peakWindows: readAfter }).some((said) =>
        /held 24 slots for the probe at 10\.\d–10\.1 s, past 18 outside a loss/u.test(said),
      ),
    );
  });

  it('P2’s look reads the forwarder’s peak before it looks until its hung loss, and each loss it sees takes the window that read closed', async () => {
    const time = manualClock();
    const none = { start: 0, skew: 0, exit: 0, hung: 0, memory: 0 };
    const hung = { ...none, hung: 1 };
    // What the helper says at each look, and when: stopped at 10 s, the detach seen at 10.1 s,
    // the hung loss at 30 s, the next child up at 30.05 s.
    const looks: (readonly [number, StoppedStats])[] = [
      [10_000, { route: 'up', state: 'up', lossesByReason: none }],
      [10_050, { route: 'up', state: 'up', lossesByReason: none }],
      [10_100, { route: 'down', state: 'unresponsive', lossesByReason: none }],
      [20_000, { route: 'down', state: 'unresponsive', lossesByReason: none }],
      [29_950, { route: 'down', state: 'unresponsive', lossesByReason: none }],
      [30_000, { route: 'down', state: 'starting', lossesByReason: hung }],
      [30_050, { route: 'down', state: 'up', lossesByReason: hung }],
    ];
    // The transient in the read before each look that saw a loss: 24 and 22.
    const read = [10, 10, 24, 20, 12, 13, 22, 8, 7];
    const peaks = new PeakWindows(() => Promise.resolve(read.shift() ?? 0), {
      clock: time.clock,
      windowMs: 10_000,
    });
    const stopped: NonNullable<WorldRecord['stopped']> = { at: 10_000 };
    let seen: StoppedStats = { route: 'up', state: 'up', lossesByReason: none };
    const look = stoppedLook(
      () => seen,
      stopped,
      peaks,
      () => time.clock.now(),
    );
    const lookAt = async (at: number, stats: StoppedStats): Promise<boolean> => {
      time.set(at);
      seen = stats;
      return look();
    };
    const said: boolean[] = [];
    for (const [at, stats] of looks.slice(0, 4)) said.push(await lookAt(at, stats));
    // The detach's window ends on its timer, between the looks.
    time.fire();
    for (const [at, stats] of looks.slice(4)) said.push(await lookAt(at, stats));
    time.fire();
    time.set(50_000);
    const windows = await peaks.finish();
    assert.deepEqual(said, [false, false, false, false, false, false, true]);
    assert.deepEqual(stopped, { at: 10_000, downAt: 10_100, hungAt: 30_000, upAt: 30_050 });
    // No read after the hung loss but its window's end and the arm's.
    assert.deepEqual(windowRows(windows), [
      [0, 10_000, 10, false],
      [10_000, 10_050, 10, false],
      [10_050, 10_100, 24, true],
      [10_100, 20_000, 20, true],
      [20_000, 20_099.5, 12, true],
      [20_099.5, 29_950, 13, false],
      [29_950, 30_000, 22, true],
      [30_000, 39_999.5, 8, true],
      [39_999.5, 50_000, 7, false],
    ]);
    // The losses the judge places the transient by are the look's own stamps.
    const facts = peakFacts(0, peaks, lossTimes({ killedAt: [], stopped }));
    assert.deepEqual(facts.lossesAt, [
      { atMs: 10_100, seen: true },
      { atMs: 30_000, seen: true },
    ]);
    assert.deepEqual(judgeWorld({ ...clean('P2', 'gate'), ...facts }), []);
  });

  it('the transient is judged a run at a time and placed by the losses’ own times: P2’s 50 ms windows pass inside their losses’ stretches, and a seen loss’s may start a second before it', () => {
    const p2 = (patch: Partial<WorldFacts>): string[] =>
      judgeWorld({ ...clean('P2', 'gate'), peakWindows: polledP2(false), ...patch });
    assert.deepEqual(p2({}), []);
    // Each window of the kept-on transient is 50 ms long and inside a loss's 10.5 s, but the run
    // is not: the one violation names the run, not a window.
    const keptOn = p2({ peakWindows: polledP2(true) });
    assert.equal(keptOn.length, 1, JSON.stringify(keptOn));
    assert.match(keptOn[0] ?? '', /allowed at 1[67]\.\d–44\.5 s, past the 10500 ms/u);
    // A seen loss's transient may start up to a second before the look saw it, and no earlier.
    const seenAt = (atMs: number): Partial<WorldFacts> => ({
      lossesAt: [
        { atMs, seen: true },
        { atMs: 34_000, seen: true },
      ],
    });
    assert.deepEqual(p2(seenAt(17_950)), []);
    assert.ok(
      p2(seenAt(18_050)).some((said) =>
        /allowed at 1[67]\.\d–27\.5 s with no loss to open it/u.test(said),
      ),
    );
    // Its end is the loss's window and a late timer's second.
    assert.deepEqual(p2(seenAt(16_000)), []);
    assert.ok(p2(seenAt(15_990)).some((said) => /allowed at 1[67]\.\d–27\.5 s, past/u.test(said)));
  });

  it('the losses reach the judge on the windows’ clock: P1’s kills made, P2’s look’s stamps seen', () => {
    const time = manualClock();
    time.set(5_000);
    const peaks = new PeakWindows(() => Promise.resolve(3), {
      clock: time.clock,
      windowMs: 10_000,
    });
    assert.deepEqual(
      lossTimes({ killedAt: [13_000], stopped: { at: 14_000, downAt: 20_000, hungAt: 40_000 } }),
      [
        { at: 13_000, seen: false },
        { at: 20_000, seen: true },
        { at: 40_000, seen: true },
      ],
    );
    // No stopped child, and a detach with no `hung` loss after it.
    assert.deepEqual(lossTimes({ killedAt: [13_000] }), [{ at: 13_000, seen: false }]);
    assert.deepEqual(lossTimes({ killedAt: [], stopped: { at: 14_000, downAt: 20_000 } }), [
      { at: 20_000, seen: true },
    ]);
    assert.deepEqual(
      peakFacts(0, peaks, [
        { at: 13_000, seen: false },
        { at: 20_000, seen: true },
      ]).lossesAt,
      [
        { atMs: 8_000, seen: false },
        { atMs: 15_000, seen: true },
      ],
    );
  });

  it('a last read of the forwarder’s peak that fails leaves its windows short of the arm’s end, and the judge fails the arm on both', async () => {
    const time = manualClock();
    let failing = false;
    const peaks = new PeakWindows(
      () =>
        failing
          ? Promise.reject(new Error('the DNS simulator did not answer gauge within 10000 ms'))
          : Promise.resolve(5),
      { clock: time.clock, windowMs: 10_000 },
    );
    time.set(8_000);
    await peaks.loss();
    time.fire(0);
    // The timer's read, in before the next one fails.
    await new Promise((resolve) => setImmediate(resolve));
    time.set(130_000);
    failing = true;
    const windows = await peaks.finish();
    assert.deepEqual(windowRows(windows), [
      [0, 8_000, 5, false],
      [8_000, 18_000, 5, true],
    ]);
    assert.equal(peaks.endMs, 130_000);
    const facts = peakFacts(0, peaks, [{ at: 8_000, seen: false }]);
    assert.deepEqual(facts, {
      peakHeld: 5,
      peakWindows: windows,
      peakWindowsEndMs: 130_000,
      peakReadFailed: 'Error: the DNS simulator did not answer gauge within 10000 ms',
      lossesAt: [{ atMs: 8_000, seen: false }],
    });
    // An arm with no loss: the gauge's peak for the run, and no windows to reach its end.
    assert.deepEqual(peakFacts(7, undefined, []), { peakHeld: 7 });
    const said = judgeWorld({ ...clean('P1', 'gate'), ...facts });
    assert.ok(
      said.some((one) => /not read from 18000 ms to the arm’s end at 130000 ms/u.test(one)),
      JSON.stringify(said),
    );
    assert.ok(
      said.some((one) => /a read of the forwarder’s peak failed.*did not answer gauge/u.test(one)),
      JSON.stringify(said),
    );
  });

  it('P3’s setup is read as it happened: its reply sent before the stall ended, its lookup open as the stall began, and answered after it', () => {
    const wall = (at: number): number => performance.timeOrigin + at;
    const host = 'dev-1.zone-a.test';
    const asked = (
      at: number,
      replyAt: number | undefined,
      address = PROBE_SOURCE,
    ): DnsQueryRecord => ({
      seq: 1,
      at: wall(at),
      server: 'ns1',
      family: 4,
      transport: 'udp',
      client: { address, port: 40_000 },
      portClass: undefined,
      id: 1,
      qname: host,
      qtype: 'A',
      opt: false,
      ednsOptions: [],
      outcome: 'forwarded',
      reply:
        replyAt === undefined
          ? undefined
          : { at: wall(replyAt), afterMs: replyAt - at, rcode: 'NOERROR', answers: 1, tc: false },
      fault: undefined,
    });
    // Its lookup began at 39,990 ms and sent its question at 39,999; the stall held 40 to 55 s.
    const stall = (flights: LaneFlight[]): NonNullable<WorldRecord['stall']> => ({
      ms: 15_000,
      host,
      from: 40_000,
      to: 55_000,
      flights,
      repliesDuring: 1,
    });
    const open: LaneFlight = { startedAt: 39_990, settledAt: 55_002, answered: true };
    assert.deepEqual(stallSetUp(stall([open]), [asked(39_999, 40_000)]), {
      ms: 15_000,
      replySent: true,
      unsettledAtStart: true,
      answeredAfterMs: 2,
    });
    // Its reply read before the stall began: no lookup of its name open as it did.
    assert.equal(stallSetUp(stall([]), [asked(39_999, 39_999.5)]).unsettledAtStart, false);
    // The reply sent after the stall; to another client; to a question asked before it began.
    for (const query of [
      asked(39_999, 55_001),
      asked(39_999, 40_000, HELPER_SOURCE),
      asked(39_000, 39_001),
      asked(39_999, undefined),
    ]) {
      assert.equal(stallSetUp(stall([open]), [query]).replySent, false, JSON.stringify(query));
    }
    // Failed after the stall, or never settled: not answered.
    for (const flight of [{ ...open, answered: false }, { startedAt: 39_990 }]) {
      assert.equal(
        stallSetUp(stall([flight]), [asked(39_999, 40_000)]).answeredAfterMs,
        undefined,
        JSON.stringify(flight),
      );
    }
  });

  it('the probe’s lanes say which of a name’s lookups are open: from its start until its reply is read, then settled, and how', async () => {
    const sim = await DnsSimulator.start({
      servers: [{ name: 'ns1', address: WORLD_ADDRESS }],
      zones: {
        'zone-a.test': { reply: replies.addresses('192.0.2.10'), delayMs: 100 },
        'zone-n.test': { reply: replies.nxdomain },
      },
      ipv6: false,
    });
    const lanes = new ProbeSide(sim.server('ns1').port, () => 'answering');
    const openAtSend: number[] = [];
    lanes.onSent = (_group, name) => {
      openAtSend.push(lanes.openFor(name).length);
    };
    try {
      const host = 'dev-1.zone-a.test';
      const answered = lanes.lookup(host, 4);
      const [flight] = lanes.openFor(host);
      assert.ok(flight !== undefined, 'open from its start');
      assert.deepEqual({ ...flight }, { startedAt: flight.startedAt }, 'not settled yet');
      await within(5_000, 'the answer', answered);
      assert.deepEqual(openAtSend, [1], 'open as its question was sent');
      assert.deepEqual(lanes.openFor(host), [], 'settled once its reply was read');
      assert.equal(flight.answered, true);
      assert.ok((flight.settledAt ?? 0) - flight.startedAt >= 90, 'settled at its reply');
      const name = 'dev-2.zone-n.test';
      const failed = lanes.lookup(name, 4).then(
        () => 'answered',
        () => 'failed',
      );
      const [lost] = lanes.openFor(name);
      assert.ok(lost !== undefined, 'open from its start');
      assert.equal(await within(5_000, 'the failure', failed), 'failed');
      assert.equal(lost.answered, false);
      assert.notEqual(lost.settledAt, undefined);
      assert.deepEqual(lanes.openFor(name), []);
    } finally {
      lanes.stop();
      await sim.stop();
    }
  });

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
