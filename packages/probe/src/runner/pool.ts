import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describeError, fitResult, type CheckResult, type Logger } from '@ms/shared';
import type { MemoryCapReading } from './memory-cap.js';
import { failureField } from './failure.js';
import { STARTUP_TIMEOUT_MS, unfit } from './process-runner.js';
import { RefusalLog } from './refusal-log.js';
import {
  RESOLVE_FAULT,
  type PoolResolver,
  type ResolveAck,
  type ResolveReply,
} from '../resolver/protocol.js';
import {
  notStarted,
  type CheckPhase,
  type CheckRequest,
  type LookupCounters,
  type ResultMeta,
  type SessionCounters,
} from './types.js';

/** Latencies kept for the percentiles Probe Health reports (P-13). */
const LATENCY_WINDOW = 1_024;

/**
 * Consecutive worker starts that may fail before the pool gives up.
 *
 * A worker that dies during start-up — a broken registry module, a missing file — dies again the
 * moment it is replaced. Respawning for ever would fill the log at the speed of the event loop
 * and hide the one line that mattered.
 */
const MAX_CONSECUTIVE_START_FAILURES = 3;

/**
 * Hangs in a row, with no worker ever ready, before the pool gives up as it does on deaths
 * (`P-272`, decided by the user 2026-10-11).
 *
 * A hang is not proof that the registry cannot load (`P-263`): it may be the machine. Thirty in a
 * row at the start of a pool's life, with not one worker ever ready, is: on one slot it is half an
 * hour of starts each given the full bound and a delay of up to thirty seconds, and on eight it is
 * every slot hanging four times over. A pool that has had a worker ready has loaded this registry,
 * so its hangs are load, and it never latches on them.
 */
export const MAX_CONSECUTIVE_START_HANGS = 30;

/**
 * How long a failed worker start waits before the next attempt, doubling with each consecutive
 * failure up to the ceiling (`P-227`).
 *
 * The latch above only fires when nothing is working (`P-80`), and a live probe always holds
 * ready workers. So a start failure that persists, such as a tree half-copied by an upgrade or a
 * full disk, used to respawn at once and without limit: a worker booted, failed its import, logged
 * an error and was replaced, eight chains at a time, for as long as the cause lasted. Backing off
 * keeps the retry going, because the cause may clear, at a rate the log and the CPU can carry.
 */
const START_RETRY_BASE_MS = 250;
const START_RETRY_MAX_MS = 30_000;

/**
 * How much recent history the *sizing* estimate is allowed to see (`P-46`).
 *
 * **Counted in seconds, and that is the whole point.** This window used to be the same 1,024
 * samples as every other latency window, and a median over N samples only moves once more than
 * half of them are new — so the time to notice a change was `512 ÷ completions per second`, and
 * the completion rate is set by the pool size. `P-44` measured the consequence: 12 s to notice at
 * 66 workers, 25 s at 31, and about 85 s at 9. A pool that is too small completes fewer checks, so
 * it measured more slowly, so it stayed too small. That is positive feedback, and it is removed by
 * counting the window in time: half the window, at any pool size.
 *
 * Thirty seconds because the sizing loop runs at thirty (`SIZE_INTERVAL_MS`), so the median has
 * crossed by the tick after the one that saw the change.
 */
const DURATION_WINDOW_MS = 30_000;

/**
 * Never estimate from fewer than this, however old they are.
 *
 * A probe with three sensors on a five-minute interval produces nothing inside thirty seconds, and
 * an empty window means `typicalDurationMs` returns undefined and the sizer falls back to an
 * assumption it already has a measurement for. Stale but real beats fresh and absent.
 */
const MIN_DURATION_SAMPLES = 8;

/**
 * How soon to look again when the pool is over its ceiling but nothing was spare (`P-45`).
 *
 * Short enough that a probe gives memory back within a few seconds of a check finishing, rather
 * than at the next 60-second idle window; long enough that it is a handful of cheap sweeps and not
 * a spin. A check that keeps every slot busy for longer than this is a workload that still needs
 * them, and the next sweep finds that out too.
 */
const OVER_CEILING_RETRY_MS = 250;

/**
 * How often an idle worker tells the pool its session pools changed (`P-256`).
 *
 * The pools close idle sessions every `idleMs` — 60 s for SNMP, 120 s for SSH — so five seconds
 * puts a close on Probe Health well inside the interval it happened in, for a comparison of four
 * integers per worker and no message at all when nothing changed. Its name lookups ride the same
 * timer (`A-66`): a lookup settles with no check running, and a check waiting for one has no
 * result to carry it yet.
 */
const SESSION_REPORT_MS = 5_000;

/**
 * Workers allowed to load their registry at the same time (`P-206`).
 *
 * **Loading together is most of what made a probe's start-up expensive.** Measured at 64 workers
 * running `port.tcp` in one-second bursts (`docs/findings/2026-09-13-probe-startup-memory.md`):
 *
 *     at once   8 cores               2 cores
 *          64   4,331+ MiB, 12.1 s    4,250 MiB, 16.2 s     <- the growth burst as it was
 *          16   3,749 MiB,   5.6 s
 *           8   2,900 MiB,   6.1 s    2,856 MiB, 12.7 s     <- this
 *           4   2,802 MiB,   8.6 s
 *           2                         2,803 MiB, 13.9 s
 *
 * Peak resident memory, then the time until all 64 were ready. The 4,331 is a floor: that run was
 * killed by the kernel fifty seconds in, on the 8 GB dev VM, which is the defect being measured.
 *
 * **A constant, not a function of the core count**, because the two-core column has the same shape
 * as the eight: the excess is heap each isolate commits while dozens load at once, which V8 then
 * holds for about a minute and a half, and it does not track the cores. Eight is within 100 MiB of
 * the lowest peak on both and brings a pool to its ceiling faster than starting everything at once
 * did, so no latency is traded for the memory.
 *
 * On the live dev probe it took the peak from 3,567 to 3,041 MiB — less than above, because a live
 * pool already grows in steps as the wheel's bursts arrive rather than all at once.
 */
export const SPAWN_CONCURRENCY = 8;

/**
 * The young generation each check worker may grow to, in MiB (`P-207`).
 *
 * **Left to itself V8 grew every worker's to 123 MiB** under allocation-heavy checks — a 500 KB
 * JSON document through JSONPath, 5,000 database rows, an SNMP table walk — and kept it: 986 MiB of
 * young generation across eight workers, which at the pool's ceiling of 64 would be 7.9 GiB before
 * the old generation held anything at all. Not measured at 64; the arithmetic is enough to want a
 * bound. Capping it is one option on the
 * `Worker`. Measured side by side, every arm on the same load in the same process so the host's
 * noise lands on all of them at once (`docs/findings/2026-09-13-young-generation-cost.md`):
 *
 *     cap     heap, 8 workers   p95 against uncapped, per window     CPU per check
 *     none    1,348 / 1,300     —                                    —
 *        2      286             rest 1.12, database 1.11             1.22   <- measurably worse
 *        4      320             0.93 – 1.02                          0.98
 *        8      407 /   368     0.91 – 0.96 / 0.98 – 1.02            0.91 / 0.97   <- this
 *       16      540 /   453     0.88 – 0.95 / 0.97 – 0.98            0.87 / 0.95
 *
 * Two runs where there are two numbers. Every cap from 4 up costs nothing measurable in latency or
 * CPU and most save a little; 2 is where the scavenger starts to cost more than the nursery it
 * saves.
 *
 * **Eight rather than four or sixteen**, because of the other end of a probe's life. Sixty-four
 * workers starting eight at a time peaked at 2,702 MiB uncapped, 2,129 at 8, 1,873 at 4 — and
 * 2,709 at 16, which never binds on a light check. Four saves 250 MiB more at start-up and is one
 * halving from the cap that hurt; eight keeps two halvings of margin for checks heavier than these
 * and still takes 70% off a busy pool's heap.
 */
export const WORKER_YOUNG_GENERATION_MB = 8;

/**
 * `disabled` is separate from `stopped` on purpose (`P-62`).
 *
 * Stopping is something an operator did and the probe stops heartbeating for; the pool giving up
 * is a fault that leaves the probe connected, answering, and running nothing. Collapsing them
 * meant the one that needs an alarm was reported as the one that needs none.
 */
export type SubmitOutcome = 'accepted' | 'already-running' | 'queue-full' | 'stopped' | 'disabled';

export interface PoolStats {
  /** Workers held right now. Since `P-18` this moves with the load. */
  size: number;
  /** The ceiling it will not grow past. `size` at it is a probe that wants a bigger one. */
  maxSize: number;
  /**
   * The ceiling in force: `maxSize`, or fewer where memory allows fewer (`P-236`).
   *
   * Equal to `maxSize` whenever memory is not what binds, and always where the cap is not
   * enforced — an explicit `workerPoolSize` is the operator's word.
   */
  ceiling: number;
  /**
   * The most workers the memory this probe may use can hold, or absent where it cannot be read
   * (`P-236`). Reported whether or not it is enforced, so an explicit size above it shows.
   */
  memoryCap?: number;
  /** `maxSize` less `ceiling`: the workers the ceiling would allow and memory does not. */
  heldBack: number;
  /** Workers added because checks were waiting, and given up again while nothing was. */
  grown: number;
  shrunk: number;
  busy: number;
  queued: number;
  submitted: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** Checks skipped because the previous scan of that sensor had not finished. */
  deferred: number;
  /**
   * Session-pool counters summed across workers, absent when no registry keeps pools (`P-36`).
   */
  sessions?: SessionCounters;
  /**
   * Name lookups summed across workers, absent when no registry counts them (`A-66`): those in
   * flight on the thread pool now, waited for or given up, and those given up since the pool
   * started.
   */
  lookups?: LookupCounters;
  /** Checks refused because the queue was full. */
  refused: number;
  /**
   * Checks thrown away because the pool has given up (`P-62`).
   *
   * Not `refused`, which is a full queue on a pool that is still working — a matter of degree,
   * and recoverable within one interval. Every one of these is a scan that produced no reading
   * anywhere, from a pool that will run nothing until the probe restarts.
   */
  discarded: number;
  /**
   * The pool has latched itself off after repeated worker start failures.
   *
   * **The signal that matters, and it is a state rather than a number.** A latched pool answers
   * nothing and reports `busy: 0`, which reads as an idle probe on a quiet night; meanwhile every
   * sensor under it keeps its last state for ever, because the core re-evaluates on an arriving
   * result and none arrive. The counter above says how much was lost; this says the pool is dead.
   */
  disabled: boolean;
  workerCrashes: number;
  /**
   * Workers that never said ready (`P-263`): still loading their registry when the start-up bound
   * passed, so the pool terminated them, or dead while loading. A running total.
   *
   * **A worker that dies while loading is also in `workerCrashes`**, as it always was. One that
   * hangs is only here: nothing crashed, the pool gave up on it. The checks it would have run went
   * to other workers, so no sensor reads anything for it; this is where it shows.
   */
  startupFailed: number;
  /**
   * Channel readings `fitResult` took out of this pool's results because they could not be sent
   * (`P-283`): a key or a value the wire cannot carry, or channels past the limit. A running
   * total; each is logged with its sensor.
   */
  channelsDropped: number;
  waitMs: { p50: number; p95: number; p99: number; max: number };
  runMs: { p50: number; p95: number; p99: number; max: number };
}

export interface CheckPoolOptions {
  logger: Logger;
  /**
   * The most workers this pool will ever hold. 0 derives it from the machine.
   *
   * A ceiling rather than a headcount since `P-18`: the pool starts at `minSize` and grows
   * towards this only while work is actually waiting.
   */
  size?: number;
  /**
   * Workers to start with, and never to drop below (`P-18`).
   *
   * **The asymmetry is the design.** Growth happens the instant a check has nowhere to go —
   * every worker busy and something queued — because a delayed check is a measurement taken
   * late, and `P-15` measured what an undersized pool costs: 21% of checks refused and the rest
   * delayed by a p95 of 15.8 seconds. Shrinking waits for a whole quiet minute and gives up one
   * worker at a time, because the only thing it buys is memory, and buying memory back at the
   * cost of a re-spawn during the next spike is a bad trade.
   *
   * Equal to `size` means the old fixed-size behaviour, which is what a probe with a known
   * steady workload should set.
   */
  minSize?: number;
  /**
   * How long every worker must have been idle before one is given up. Default 60 s.
   *
   * Long, on purpose: a one-minute scan interval means a probe is idle between ticks by design,
   * and a shrink policy shorter than the interval would spend its life dropping workers it is
   * about to re-spawn.
   */
  idleShrinkMs?: number;
  /**
   * How much recent history the sizing estimate sees, in milliseconds (`P-46`).
   *
   * Defaults to `DURATION_WINDOW_MS`. Injectable so a test can bury a stale reading without
   * spending thirty seconds doing it, and so the sizing benchmark can vary it.
   */
  durationWindowMs?: number;
  queueMaxLength?: number;
  /** How often a refusal episode is summarised in the log (`P-216` part 3). Injectable for tests. */
  refusalSummaryMs?: number;
  /**
   * How long a check has to honour its abort before the worker is terminated.
   *
   * The cooperative path is the cheap one — an aborted check returns and its worker is reusable
   * immediately. Termination is the backstop for a check that cannot be interrupted, and it
   * costs a worker restart.
   */
  abortGraceMs?: number;
  /**
   * How long a new worker has to load its registry and say ready (`P-263`). `STARTUP_TIMEOUT_MS`
   * unless a test sets it. A worker still loading at the bound is terminated, counted in
   * `startupFailed`, and replaced after a growing delay.
   */
  startupTimeoutMs?: number;
  /**
   * Hangs in a row, with no worker ever ready, before the pool latches (`P-272`).
   * `MAX_CONSECUTIVE_START_HANGS` unless a test sets it.
   */
  startHangLimit?: number;
  /**
   * How often an idle worker reports a change in its session pools (`P-256`) or its name lookups
   * (`A-66`). `SESSION_REPORT_MS` unless a test sets it.
   */
  sessionReportMs?: number;
  /** Module whose default export is a `CheckRegistry`. P-05 supplies the real one. */
  registryModule?: string;
  /**
   * How many workers memory allows (`P-236`). Absent means no memory bound, as before it.
   *
   * Asked with the number of workers already started, and answers with an absolute count that
   * includes them. `MemoryCap` is the real one.
   */
  memoryCap?: { read: (held: number) => MemoryCapReading | undefined };
  /**
   * Whether the pool obeys `memoryCap` or only reports it. Default true.
   *
   * False where `workerPoolSize` was set: a non-zero setting is the operator's statement of how
   * much memory the probe may use (`P-34`), and a derived number must not overrule it. The pool
   * still says, once per episode, when that setting is more than memory holds.
   */
  enforceMemoryCap?: boolean;
  /**
   * The probe's resolver (`P-426`). Given, this pool's workers ask it for every name a check
   * resolves to check it, over their port, and it answers here. Absent, each worker resolves for
   * itself, as a fixture pool's does.
   */
  resolver?: PoolResolver;
  /** Whether those lookups ask the resolver rather than its cache: "Check now"'s pool. */
  freshLookups?: boolean;
  onResult: (result: CheckResult, meta: ResultMeta) => void;
}

interface Job {
  id: string;
  request: CheckRequest;
  queuedAt: bigint;
  startedAt: bigint;
  waitMs: number;
  timeout: NodeJS.Timeout | undefined;
  grace: NodeJS.Timeout | undefined;
  /** True once a result has been emitted; a late reply from the worker is then ignored. */
  settled: boolean;
}

interface Slot {
  id: number;
  worker: Worker;
  ready: boolean;
  job: Job | undefined;
  /**
   * This worker's session-pool counters as of its last result or report (`P-36`, `P-256`).
   *
   * Per slot because each worker thread holds its own pools — the module singletons in
   * `@ms/sensors` are per-thread — so the probe's real total is the sum over workers, not any
   * one of them. `undefined` until the worker has finished a check or reported, and for ever on
   * a build whose registry keeps no pools.
   */
  sessions: SessionCounters | undefined;
  /** This worker's name lookups as of its last result or report (`A-66`), per slot likewise. */
  lookups: LookupCounters | undefined;
  /**
   * Set when the pool itself is taking this worker out of service.
   *
   * Terminating a worker fires the same `exit` event a crash does, and without this the pool
   * would count its own recycle as a crash and spawn a *second* replacement — ending up one
   * worker over its bound every time a check ignored an abort.
   */
  retired: boolean;
  /**
   * Set the first time this worker is reported gone, so it is only counted once (`P-73`).
   *
   * `retired` above covers the pool's own recycles. This covers the other double-count, which it
   * did not: a worker that dies from an uncaught exception fires **both** `error` and `exit`, and
   * `#onWorkerGone` ran for each. One death then counted two crashes, took two off the
   * consecutive-start-failure budget — so the pool gave up after two failing workers rather than
   * the three its own comment describes — and spawned two replacements, leaving the pool one
   * worker over its bound each time.
   */
  gone: boolean;
  /**
   * Monotonic instant this worker last had nothing to do, or `0n` while it has a job.
   *
   * **Per worker rather than per pool**, and that distinction is the whole of `P-26`. The pool
   * used to time "nothing has been submitted at all", which on a probe watching five thousand
   * sensors — eighty-three checks a second — is never true for a minute, so the shrink could not
   * fire on the one probe that had grown a large pool. What matters is whether *this worker* has
   * been spare, which is what the pool is being asked to give back.
   */
  idleSince: bigint;
}

/**
 * The bounded worker pool that runs checks (ADR-001 Decision 3).
 *
 * Three guarantees, in the order they matter.
 *
 * **Nothing blocks the scheduler.** `submit` returns immediately; results arrive by callback.
 * The timing wheel hands over ids and gets on with the next tick.
 *
 * **A hung check costs one worker, briefly, and nothing else.** The result is emitted the instant
 * the timeout expires, not when the check finally returns — so a sensor stuck on a dead SSH
 * connection reports Down on time. The worker is asked to abort, and terminated if it will not.
 *
 * **A sensor never stacks.** A check whose next scan comes due while the previous is still
 * running is skipped and counted (`WORKFLOW.MD` §3), which costs nothing to decide because the
 * wheel has already scheduled the next one.
 */
/**
 * How many checks may run at once when nothing says otherwise.
 *
 * **Not derived from the core count, deliberately.** It used to be `availableParallelism() - 1`,
 * on the reasoning that one core should be left for the event loop that owns the wheel, the
 * transport and the spool. That is right about the event loop and wrong about the pool: a check
 * is not CPU work. ICMP, SNMP and HTTP checks spend nearly all of their time awaiting a packet,
 * so a worker holds a *slot* while using almost no CPU, and the number of cores has nothing to
 * do with how many packets are in the air.
 *
 * `P-15` measured what governs it instead (`docs/findings/2026-08-26-scheduler-benchmark.md`).
 * The wheel dispatches **once a second, handing over a whole second's batch at once** — at the
 * v1 target of 5,000 sensors on a 60-second interval that is 83 sensors in one go. So the queue
 * drains in tranches of `ceil(batch / slots)`, and the wait a sensor sees is
 * `(tranches - 1) x checkDuration`. The measured curve is exactly that shape: 32 slots is three
 * tranches and a p95 of 405 ms; 48 is two and 213 ms; 128 takes the whole batch at once and 7 ms.
 *
 * **That tranche model is necessary and not sufficient, which is how this was wrong for a week**
 * (`P-32`, `P-33`). It bounds the wait for *one* batch and never asks whether the batch clears
 * before the next arrives a second later. The constraint it was missing is Little's law: a pool
 * completes `slots / checkDuration` checks a second, and below the arrival rate the backlog
 * grows for as long as the probe runs — quietly, because the queue absorbs it and nothing is
 * refused until the queue's own bound is reached.
 *
 *     slots >= burst x checkDuration
 *
 * **`icmp.ping` is what made that bite.** `P-15` chose 48 against a 200 ms model, where the
 * floor is 16.7 and 48 is nearly three times it. `P-07` then measured a real ping check at
 * **600 ms** — four packets at `-i 0.2` — and at the v1 target that floor is `83.3 x 0.6 = 50`.
 * **48 was one worker under the line for the sensor type this project actually ships**, and
 * `P-07`'s own finding had already said 83/s "needs about 55 now" without anyone putting 55 next
 * to 48.
 *
 * Swept at 600 ms checks, 5,000 sensors, 90 s a point
 * (`docs/findings/2026-09-03-pool-default.md`):
 *
 *     ceiling   ratio to floor   p50        p95        benchmark RSS
 *          48            0.96x   3,081 ms   5,082 ms   656 MB   <- backlog, not a tail
 *          56            1.12x     220 ms     822 ms   753 MB
 *          64            1.28x       8 ms     614 ms   851 MB   <- this
 *          80            1.60x       4 ms     608 ms   1,037 MB
 *          96            1.92x       4 ms       7 ms   1,215 MB
 *         128            2.54x       3 ms       9 ms   1,514 MB
 *
 * **64, because the margin above the floor is doing visible work.** 56 and 64 are both two
 * tranches and the tranche model predicts 600 ms for each; 56 measures 822 and 64 measures 614,
 * because at 1.12x the floor the queueing noise the model ignores is still on top. 64 sits 39%
 * inside the one-second budget. 96 buys the last 600 ms by taking the batch in one tranche, and
 * costs another 32 workers — about 1.1 GB in a real probe, where a worker carries the sensor
 * catalogue at ~35 MB — to improve a budget that is already met.
 *
 * **What this costs the workload it does not help**, stated plainly: a probe at the v1 target
 * whose checks are fast now holds 64 workers where it held 48, about **+560 MB** in a real
 * probe, and gains nothing — 83 in two tranches either way. The pool is demand-driven since
 * `P-18` and tracks its load since `P-26`, so nothing below the v1 target pays this at all, but
 * a large fast-check probe does. The honest fix is a ceiling derived from the measured duration
 * of the checks actually assigned rather than one constant for every workload; `costHint` is a
 * three-value enum and not that number, so it needs its own ticket rather than a guess here.
 *
 * `probe.workerPoolSize` overrides it, and `docs/sizing.md` is written in terms of the floor.
 */
export function defaultPoolSize(): number {
  return 64;
}

/**
 * The most the probe will derive for itself when `workerPoolSize` is left at 0 (`P-34`).
 *
 * **A bound on what auto-sizing may ask for, not on what an operator may configure.** Setting
 * `workerPoolSize` explicitly still takes any value the schema allows; this is only the ceiling
 * on a number the probe worked out on its own, because a derived value that can climb without
 * limit is one OOM away from being worse than the constant it replaced. At the ~35 MB a worker
 * costs in a real probe, 256 is about 9 GB — past any probe size `docs/sizing.md` describes, so
 * a workload that derives past it is one an operator needs to hear about rather than have
 * quietly served.
 *
 * Reaching it is visible without a new signal: the pool saturates, and `poolUsage` on Probe
 * Health already alarms at 80% sustained and 95% (`S-18`). What the cap adds is a log line
 * naming the number that was refused.
 */
export function autoPoolCeilingMax(): number {
  return 256;
}

export class CheckPool {
  readonly #logger: Logger;
  #maxSize: number;
  readonly #minSize: number;
  readonly #idleShrinkMs: number;
  readonly #durationWindowMs: number;
  readonly #queueMax: number;
  readonly #abortGraceMs: number;
  readonly #startupTimeoutMs: number;
  readonly #startHangLimit: number;
  readonly #sessionReportMs: number;
  readonly #registryModule: string;
  readonly #resolver: PoolResolver | undefined;
  readonly #freshLookups: boolean;
  readonly #onResult: (result: CheckResult, meta: ResultMeta) => void;

  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  /** Sensors queued or running, so a second scan of the same sensor is skipped. */
  readonly #active = new Set<number>();
  readonly #wait: number[] = [];
  readonly #run: number[] = [];
  /**
   * Recent run durations per sensor type, for `P-34`'s demand calculation.
   *
   * Per type rather than pooled, because the whole point is that types differ: an `icmp.ping` at
   * 600 ms and an `snmp.traffic` at 40 ms make a pooled median that describes neither. Bounded
   * the same way as the latency windows — a probe watching one type for a month must not grow a
   * list for it.
   */
  readonly #runByType = new Map<string, DurationSample[]>();
  /**
   * Session-pool counters from workers the pool has already retired (`P-36`).
   *
   * **Without this the totals would go backwards.** Each worker keeps its own pools, so the
   * published figure is a sum over live workers; shrinking the pool would then *lower* a
   * cumulative counter, and a counter that falls is one a trigger cannot be set on. A retired
   * worker's last snapshot is added here instead, and `open` is left out because it is a gauge
   * — a retired worker holds no sessions, and saying it does would be worse than saying nothing.
   */
  #retiredSessions = { overflowed: 0, evicted: 0, opened: 0 };
  /**
   * Lookups given up by workers the pool has already retired (`A-66`), for the same reason.
   *
   * **What a retired worker had in flight is left out**, as `open` is, and that is a loss: a
   * lookup cannot be cancelled, so one a terminated worker was waiting for still holds its thread
   * until the resolver answers, and nothing is left to say when it has. A worker is terminated
   * only for a check that ignored its abort, and the lookup is bounded below the check's time, so
   * a lookup is what keeps a worker running a check only when the pool's timeout is the shorter.
   */
  #retiredLookups = { givenUp: 0 };
  /** Whether a worker this pool retired had reported lookups, so a pool of them still reads. */
  #lookupsReported = false;

  #nextJobId = 0;
  #nextWorkerId = 0;
  /**
   * Spawns in flight, so a burst of pumps does not order the same worker several times over.
   *
   * **Every spawn is in it until it settles** (`P-263`, `P-271`): `start`'s own, a growth step's, a
   * failed start's retry while it waits out its delay, a crash's replacement and a recycle's. Each
   * can wait out of `#slots` — for a loading turn, a delay or a terminate — and one left out of
   * this as well is a gap `#grow` buys a second worker for.
   */
  #growing = 0;
  /** Workers loading their registry right now, bounded by `SPAWN_CONCURRENCY` (`P-206`). */
  #loading = 0;
  readonly #loadingWaiters: (() => void)[] = [];
  #grown = 0;
  #shrunk = 0;
  /** When every slot was last seen busy, or the queue non-empty. Monotonic (`CLAUDE.md`). */
  #shrinkTimer: NodeJS.Timeout | undefined;
  /** Start retries waiting out their backoff, cleared by `stop`. */
  readonly #retryTimers = new Set<NodeJS.Timeout>();
  /** Set only while the pool is above its ceiling and still has workers to give back (`P-45`). */
  #overCeilingTimer: NodeJS.Timeout | undefined;
  readonly #memoryCap: { read: (held: number) => MemoryCapReading | undefined } | undefined;
  readonly #enforceMemoryCap: boolean;
  /**
   * Set while memory is holding the pool back, so the log says so once per episode (`P-236`).
   *
   * An episode ends when nothing is waiting any more. Once per growth attempt would be once per
   * submit on a saturated probe, which is the refusal flood `P-216` was about.
   */
  #memoryBinding = false;
  /**
   * Workers given up whose threads have not exited yet (`P-236`).
   *
   * Still resident, so still inside any memory reading, and not in `#slots`. Without them a pool
   * shedding workers for memory would read the memory they have not yet released as memory taken
   * by something else, and shed more.
   */
  #terminating = 0;
  /** Failed starts since a worker last said ready, hangs included: the backoff's exponent. */
  #startFailures = 0;
  /**
   * Starts that *died* since a worker last said ready: the latch's count (`P-62`, `P-80`).
   *
   * Separate from `#startFailures` because a hang is not evidence that the registry cannot load
   * (`P-263`), so counting it here let hang, hang, death latch a pool, and with eight hangs in
   * flight one death did. A hang does not reset this either: only a worker that says ready proves
   * the registry loads, and a hang proves nothing either way, so the deaths before it still stand.
   */
  #startDeaths = 0;
  /** Hangs since a worker last said ready: the second latch's count (`P-272`). */
  #startHangs = 0;
  /** Whether any worker of this pool has ever said ready: the registry loads here (`P-272`). */
  #everReady = false;
  #stopped = false;
  #disabled = false;
  /** Set only while `stop` is waiting for running checks to settle. */
  #onDrained: (() => void) | undefined;

  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #timedOut = 0;
  #deferred = 0;
  #refused = 0;
  /** Refusals logged once per episode, with a count every thirty seconds (`P-216` part 3). */
  readonly #refusals: RefusalLog;
  #discarded = 0;
  #crashes = 0;
  #startupFailed = 0;
  #channelsDropped = 0;

  constructor(options: CheckPoolOptions) {
    this.#logger = options.logger.child({ component: 'check-pool' });
    this.#maxSize =
      options.size !== undefined && options.size > 0 ? options.size : defaultPoolSize();
    // Clamped rather than trusted: a minimum above the maximum is a configuration file that says
    // two contradictory things, and starting more workers than the ceiling allows would make
    // every later decision arithmetic on a number that was already wrong.
    this.#minSize = Math.max(1, Math.min(options.minSize ?? this.#maxSize, this.#maxSize));
    this.#idleShrinkMs = options.idleShrinkMs ?? 60_000;
    this.#durationWindowMs = options.durationWindowMs ?? DURATION_WINDOW_MS;
    this.#queueMax = options.queueMaxLength ?? 1_000;
    this.#abortGraceMs = options.abortGraceMs ?? 2_000;
    this.#startupTimeoutMs = Math.max(1, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    this.#startHangLimit = Math.max(1, options.startHangLimit ?? MAX_CONSECUTIVE_START_HANGS);
    this.#sessionReportMs = Math.max(1, options.sessionReportMs ?? SESSION_REPORT_MS);
    this.#registryModule =
      options.registryModule ?? join(import.meta.dirname, 'catalogue-registry.js');
    this.#resolver = options.resolver;
    this.#freshLookups = options.freshLookups ?? false;
    this.#onResult = options.onResult;
    this.#memoryCap = options.memoryCap;
    this.#enforceMemoryCap = options.enforceMemoryCap ?? true;
    this.#refusals = new RefusalLog(this.#logger, 'check queue is full, refusing a check', {
      ...(options.refusalSummaryMs === undefined ? {} : { summaryMs: options.refusalSummaryMs }),
    });
  }

  /** How long a new worker has to load and say ready before it is ended (`P-263`). */
  get startupTimeoutMs(): number {
    return this.#startupTimeoutMs;
  }

  /** Workers held right now, which since `P-18` is not the same as the configured maximum. */
  get size(): number {
    return this.#slots.length;
  }

  /** The ceiling. What `stats().size` used to report, and what a capacity alarm compares to. */
  get maxSize(): number {
    return this.#maxSize;
  }

  /**
   * Moves the ceiling (`P-34`).
   *
   * **Raising it takes effect on the next pump rather than immediately**, which is the whole
   * point: `#grow` is what decides to spawn, and it now has more room. Nothing is allocated
   * here, so a probe that never needs the headroom never pays for it.
   *
   * **Lowering it below what is already held is allowed and does not kill anybody.** The slots
   * over the new line are left to `#considerShrink`, which only ever retires a worker that is
   * ready, jobless and has been idle for the whole window — a ceiling change must not take a
   * worker out of the middle of a check, and this is the same rule `P-26` established.
   *
   * Clamped to at least `minSize`, because a ceiling under the floor is two settings that
   * contradict each other, and the floor is the one an operator set deliberately.
   */
  setMaxSize(next: number): void {
    const clamped = Math.max(this.#minSize, Math.trunc(next));
    if (clamped === this.#maxSize || !Number.isFinite(clamped) || clamped < 1) return;
    const previous = this.#maxSize;
    this.#maxSize = clamped;
    this.#logger.info({ from: previous, to: clamped, held: this.#slots.length }, 'pool ceiling');
    if (clamped > previous) this.#pump();
    // Lowering it acts now rather than at the next window, for the same reason the pass above
    // does not wait for one: the pool is over a bound, and an hour of holding memory it may not
    // have is not a policy anybody chose.
    else this.#considerShrink();
  }

  /**
   * What a check of this type has recently cost, in milliseconds, or `undefined` if none has run.
   *
   * The median rather than the mean, because a check that timed out is in this window too and
   * one 30-second timeout would drag a mean far enough to size the pool for a workload that does
   * not exist.
   */
  typicalDurationMs(sensorType: string): number | undefined {
    return typicalOf(
      this.#runByType.get(sensorType) ?? [],
      process.hrtime.bigint(),
      this.#durationWindowMs,
    );
  }

  /**
   * Adds a departing worker's counters to the retired baseline (`P-36`).
   *
   * Called wherever a slot leaves `#slots` — shrink, crash, failed start — because the published
   * totals are a sum over live workers and a worker leaving must not make a cumulative counter
   * fall. Idempotent by clearing the slot's snapshot: a crash path that also runs the shrink
   * path would otherwise bank the same numbers twice. Its lookups the same way (`A-66`).
   */
  #bankCounters(slot: Slot): void {
    const lookups = slot.lookups;
    if (lookups !== undefined) {
      this.#retiredLookups.givenUp += lookups.givenUp;
      this.#lookupsReported = true;
      slot.lookups = undefined;
    }
    const counters = slot.sessions;
    if (counters === undefined) return;
    this.#retiredSessions.overflowed += counters.overflowed;
    this.#retiredSessions.evicted += counters.evicted;
    this.#retiredSessions.opened += counters.opened;
    slot.sessions = undefined;
  }

  /**
   * What every worker's name lookups add up to, or `undefined` if none has ever reported
   * (`A-66`): a registry that does not count them gaps both channels rather than reading zero.
   */
  lookupCounters(): LookupCounters | undefined {
    let reported = this.#lookupsReported;
    let inFlight = 0;
    let givenUp = this.#retiredLookups.givenUp;
    for (const slot of this.#slots) {
      const lookups = slot.lookups;
      if (lookups === undefined) continue;
      reported = true;
      inFlight += lookups.inFlight;
      givenUp += lookups.givenUp;
    }
    return reported ? { inFlight, givenUp } : undefined;
  }

  /**
   * What every worker's session pools add up to, or `undefined` if none has reported (`P-36`).
   *
   * `undefined` rather than zeros, so a build whose registry keeps no pools gaps the channel
   * instead of publishing a confident nothing — no-data is not zero.
   */
  sessionCounters(): SessionCounters | undefined {
    let reported = false;
    const total: SessionCounters = { open: 0, overflowed: 0, evicted: 0, opened: 0 };
    for (const slot of this.#slots) {
      const counters = slot.sessions;
      if (counters === undefined) continue;
      reported = true;
      total.open += counters.open;
      total.overflowed += counters.overflowed;
      total.evicted += counters.evicted;
      total.opened += counters.opened;
    }
    const retired = this.#retiredSessions;
    if (!reported && retired.opened === 0 && retired.overflowed === 0 && retired.evicted === 0) {
      return undefined;
    }
    total.overflowed += retired.overflowed;
    total.evicted += retired.evicted;
    total.opened += retired.opened;
    return total;
  }

  #recordTypeDuration(sensorType: string, durationMs: number): void {
    const sample: DurationSample = { at: process.hrtime.bigint(), ms: durationMs };
    const window = this.#runByType.get(sensorType);
    if (window === undefined) {
      this.#runByType.set(sensorType, [sample]);
      return;
    }
    window.push(sample);
    // Still bounded by count, so a busy type cannot grow without limit; the count is a memory
    // bound now rather than the estimate's window.
    if (window.length > LATENCY_WINDOW) window.shift();
  }

  /** Resolves once every worker has loaded its registry and is ready for work. */
  async start(): Promise<void> {
    if (this.#slots.length > 0) return;
    // **Counted as on their way until each has started** (`P-271`), like every other spawn. Past
    // `SPAWN_CONCURRENCY` they wait for a loading turn out of `#slots`, and uncounted in that time
    // a check queuing made `#grow` start a worker for a slot that one of these was about to fill:
    // a fixed pool of ten held eleven.
    this.#growing += this.#minSize;
    await Promise.all(
      Array.from({ length: this.#minSize }, () =>
        this.#spawn().finally(() => {
          this.#growing -= 1;
          this.#pump();
        }),
      ),
    );
    // Zero means never give a worker back, which is what a probe on a machine with memory to
    // spare and spiky work should choose: the pool then only ever climbs.
    if (this.#minSize < this.#maxSize && this.#idleShrinkMs > 0) {
      this.#shrinkTimer = setInterval(() => {
        this.#considerShrink();
      }, this.#idleShrinkMs);
      // The sizing loop must never be the reason the process stays alive.
      this.#shrinkTimer.unref();
    }
    this.#logger.info(
      { size: this.#slots.length, max: this.#maxSize, registry: this.#registryModule },
      'check pool started',
    );
  }

  /**
   * Stops accepting work, lets what is running finish for up to `drainMs`, and terminates every
   * worker.
   *
   * **Queued checks are answered at once**, as `pool-stopped`: they never started, so there is no
   * reading to wait for. **Running ones get the drain window.** A check a worker is already doing
   * is a reading the spool is still open to take — `main.ts` closes it after this returns — and
   * throwing it away was the `P-80` shutdown loss. Bounded, because the slowest hung check must
   * not decide how long shutdown takes: whatever is still running when the window closes is
   * abandoned as `pool-stopped`, and a check that times out inside it reports `timeout` as it
   * would on any other day. Zero, the default, abandons everything in flight immediately.
   */
  async stop(options: { drainMs?: number } = {}): Promise<void> {
    this.#stopped = true;
    this.#refusals.stop();
    if (this.#shrinkTimer !== undefined) clearInterval(this.#shrinkTimer);
    this.#shrinkTimer = undefined;
    if (this.#overCeilingTimer !== undefined) clearTimeout(this.#overCeilingTimer);
    this.#overCeilingTimer = undefined;
    // Each was counted in `#growing` while it waited; none will spawn now.
    this.#growing -= this.#retryTimers.size;
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#retryTimers.clear();
    for (const job of this.#queue.splice(0)) this.#settle(job, 'pool-stopped', 'probe is stopping');

    const running = this.#inFlight();
    const drainMs = options.drainMs ?? 0;
    if (running > 0 && drainMs > 0) {
      let deadline: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.#onDrained = resolve;
        deadline = setTimeout(resolve, drainMs);
        deadline.unref();
      });
      clearTimeout(deadline);
      this.#onDrained = undefined;
    }
    const abandoned = this.#inFlight();

    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.job !== undefined) {
          this.#settle(slot.job, 'pool-stopped', 'probe is stopping');
        }
        await slot.worker.terminate();
      }),
    );
    this.#slots.length = 0;
    this.#logger.info(
      { ...this.stats(), drainMs, finishedWhileDraining: running - abandoned, abandoned },
      'check pool stopped',
    );
  }

  /** Checks a worker has started and nobody has answered for yet. */
  #inFlight(): number {
    return this.#slots.filter((slot) => slot.job !== undefined && !slot.job.settled).length;
  }

  /** Offers a check. Never blocks, never throws, always answers what it did. */
  /**
   * Whether a check offered right now would be taken — `submit`'s rule without `submit`'s counters
   * (`P-57`).
   *
   * **It exists so a listener sensor's messages are not drained into a check that is then
   * refused.** `NotificationRing.drain` advances the cursor unconditionally and hands the batch
   * back, so a caller that drains first and submits second loses everything it drained whenever
   * the answer is `already-running` — which is the ordinary case, not an exotic one: skipping
   * while the previous scan is still going is the rule (`WORKFLOW.MD §3`), and a syslog sensor
   * under a flood is exactly the sensor whose previous scan is still going.
   *
   * Safe to ask separately only because the wheel's `onDue` is synchronous and single-threaded:
   * nothing can change between the question and the `submit` that follows it. It shares
   * `#admission` with `submit` rather than restating the rule, so the two cannot drift.
   */
  accepts(sensorId: number): boolean {
    return this.#admission(sensorId) === 'accepted';
  }

  /** The decision alone. Counting is `submit`'s, so asking twice never moves a counter. */
  #admission(sensorId: number): SubmitOutcome {
    if (this.#stopped) return 'stopped';
    if (this.#disabled) return 'disabled';
    // The previous scan of this sensor is still going. Skipping is the rule (WORKFLOW.MD §3)
    // and it is free: the wheel has already scheduled the next one.
    if (this.#active.has(sensorId)) return 'already-running';
    if (this.#queue.length >= this.#queueMax) return 'queue-full';
    return 'accepted';
  }

  submit(request: CheckRequest): SubmitOutcome {
    const verdict = this.#admission(request.sensorId);
    if (verdict === 'stopped') return 'stopped';
    if (verdict === 'disabled') {
      // **Counted, because the alternative is a probe that looks idle** (`P-62`). Once the latch
      // is on, every check submitted from here on vanishes; nothing else moves, and Probe Health
      // reads a pool with slots and nothing to do. `#stopped` deliberately does not come through
      // here: a probe on its way down stops heartbeating, and the link channel already says so.
      this.#discarded += 1;
      return 'disabled';
    }
    this.#submitted += 1;

    if (verdict === 'already-running') {
      this.#deferred += 1;
      return 'already-running';
    }
    if (verdict === 'queue-full') {
      this.#refused += 1;
      this.#refusals.refused({
        sensorId: request.sensorId,
        sensorType: request.sensorType,
        queued: this.#queue.length,
        queueMax: this.#queueMax,
      });
      return 'queue-full';
    }

    this.#nextJobId += 1;
    this.#queue.push({
      id: String(this.#nextJobId),
      request,
      queuedAt: process.hrtime.bigint(),
      startedAt: 0n,
      waitMs: 0,
      timeout: undefined,
      grace: undefined,
      settled: false,
    });
    this.#active.add(request.sensorId);
    this.#pump();
    return 'accepted';
  }

  stats(): PoolStats {
    return {
      size: this.#slots.length,
      maxSize: this.#maxSize,
      ...(() => {
        const memory = this.#readMemory();
        const ceiling = this.#ceiling(memory);
        return {
          ceiling,
          ...(memory === undefined ? {} : { memoryCap: memory.workers }),
          heldBack: this.#maxSize - ceiling,
        };
      })(),
      grown: this.#grown,
      shrunk: this.#shrunk,
      busy: this.#slots.filter((slot) => slot.job !== undefined).length,
      queued: this.#queue.length,
      submitted: this.#submitted,
      completed: this.#completed,
      failed: this.#failed,
      timedOut: this.#timedOut,
      deferred: this.#deferred,
      ...(() => {
        const sessions = this.sessionCounters();
        return sessions === undefined ? {} : { sessions };
      })(),
      ...(() => {
        const lookups = this.lookupCounters();
        return lookups === undefined ? {} : { lookups };
      })(),
      refused: this.#refused,
      discarded: this.#discarded,
      disabled: this.#disabled,
      workerCrashes: this.#crashes,
      startupFailed: this.#startupFailed,
      channelsDropped: this.#channelsDropped,
      waitMs: percentiles(this.#wait),
      runMs: percentiles(this.#run),
    };
  }

  #pump(): void {
    // **Over memory, a worker that comes free is given up rather than handed the next check**
    // (`P-236`). The over-ceiling sweep only retires workers it finds spare, and a saturated pool
    // has none: each hands its slot to the next queued check the moment it finishes. So memory
    // taken by something else would never be given back while the probe is busy, which is exactly
    // when it matters. Only a ready worker holding nothing is taken, as `P-26` requires.
    const over = this.#overMemory();
    let retired = 0;
    for (const slot of [...this.#slots]) {
      if (retired >= over) break;
      if (!slot.ready || slot.job !== undefined || slot.retired) continue;
      this.#retire(slot, { overMemory: over - retired });
      retired += 1;
    }
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) break;
      if (!slot.ready || slot.job !== undefined) continue;
      const job = this.#queue.shift();
      /* c8 ignore next -- guarded by the length check above */
      if (job === undefined) break;
      this.#dispatch(slot, job);
    }
    // After the loop, never inside it: `#grow` appends to `#slots`, and growing a collection
    // while iterating it is how a worker gets skipped or visited twice.
    this.#grow();
  }

  /**
   * Adds workers while checks have nowhere to go (`P-18`).
   *
   * The trigger is not "the queue is long" but "a check has nowhere to go", and **`#pump` has
   * already established that** — it is called immediately above, and it hands work to every
   * ready idle worker there is. So a queue that is still non-empty when it returns is a queue
   * behind workers that are all busy, which is the only state in which another worker would have
   * started a check that is instead waiting. Re-checking for an idle slot here would be a
   * condition that cannot be false, which is a condition that is not doing anything.
   *
   * **The step is a doubling, and that is a judgement rather than a measurement.** The load this
   * exists for arrives in tranches — the wheel hands over a whole second's worth at once
   * (`P-15`) — and a growth event only happens on a pump, so a linear step climbs in as many
   * rounds as it needs workers where a doubling takes a handful. One-at-a-time was not measured
   * against it; what *was* measured is the ramp as shipped, which costs nothing at the p95
   * (`docs/findings/2026-08-29-pool-sizing.md`), so there is no case open against it either.
   *
   * Bounded twice over: by the configured maximum, and by what is actually queued — forty
   * workers for three waiting checks is memory bought for work that does not exist.
   */
  #grow(): void {
    if (this.#stopped || this.#disabled) return;
    if (this.#queue.length === 0) {
      this.#endMemoryEpisode();
      return;
    }
    const held = this.#slots.length + this.#growing;
    if (held >= this.#maxSize) return;

    // **The queue that pending spawns will absorb must not also justify more spawns.** `held`
    // already counts the workers on their way, so counting the whole queue as unmet demand
    // counts the same pending workers on both sides of the comparison. A worker takes a few
    // hundred milliseconds to import its registry, and every tick that lands inside that window
    // saw the queue it had already paid for and bought against it again: measured at 500 sensors
    // — a steady-state need of 1.7 workers — the pool reached **74**.
    //
    // Discounting the queue also removes the need to double. One step to meet the demand that is
    // actually unmet answers a whole tranche at once, which is what the doubling was for: 83
    // checks arriving against 4 workers now goes straight to the ceiling in a single step rather
    // than in a handful of rounds.
    const unmet = Math.max(0, this.#queue.length - this.#growing);
    const wanted = Math.min(this.#maxSize, held + unmet);
    // **Memory is the last word on growth** (`P-236`), read at every step rather than folded into
    // the sizer's ceiling, because growth is immediate and the sizer runs every thirty seconds:
    // `P-216b`'s probe went from 5 workers to 108 in eleven.
    const want = this.#memoryBound(wanted, held, this.#readMemory());
    const add = want - held;
    if (add <= 0) return;

    this.#grown += add;
    this.#growing += add;
    this.#logger.info(
      { from: held, to: want, queued: this.#queue.length },
      'growing the check pool',
    );
    for (let i = 0; i < add; i += 1) {
      void this.#spawn().finally(() => {
        this.#growing -= 1;
        this.#pump();
      });
    }
  }

  /**
   * Gives up one worker after a whole quiet interval (`P-18`).
   *
   * One at a time and only when *nothing* has been waiting for the full interval, because the
   * only thing shrinking buys is resident memory — about six megabytes a worker — and paying a
   * spawn during the next spike to have saved it is a bad trade. The clock is monotonic, so a
   * wall-clock jump cannot make a busy pool look idle.
   */
  #considerShrink(): void {
    if (this.#stopped || this.#slots.length <= this.#minSize) return;

    // **Over the ceiling comes down now, not one worker a minute** (`P-34` made this reachable).
    // `P-26` set the decay at one worker per idle window, which was right while the ceiling never
    // moved: it decays a burst-sized pool gently and cannot thrash. A *derived* ceiling moves, and
    // a pool above one is holding memory it has been told it may not have — 256 down to 64 is 192
    // workers, which at one a minute is over three hours and about 6.6 GB in a real probe.
    //
    // The idle window is a thrash guard and a bound is not a hint, so this pass does not wait for
    // one. What it does keep is the only condition that was ever about safety: a worker must be
    // ready and holding no job. A ceiling change must never take a worker out of the middle of a
    // check, which is `P-26`'s rule and the one that would corrupt a result if it were wrong.
    while (this.#slots.length > this.#maxSize && this.#slots.length > this.#minSize) {
      const spare = this.#spareSlots()[0];
      if (spare === undefined) break;
      this.#retire(spare, { over: this.#slots.length - this.#maxSize });
    }

    // **Come back for the rest in a moment, not in a minute** (`P-45`).
    //
    // The pass above takes whatever is spare *at this instant* and stops at the first slot holding
    // a job, which is the one rule here that is about safety. What it is not is a schedule: a
    // wheel firing every second means most slots are briefly busy inside a burst, so a pass landing
    // in one sheds almost nothing. Before this the next chance was the 60-second idle timer, and
    // `P-44` measured the result — a pool asked to go from 66 workers to 9 sat at 31 for two
    // minutes, twice observed completely idle while it did, holding about 770 MB in a real probe
    // that it had already been told to release.
    //
    // It stops on its own, because the condition is being over a bound: reaching the bound ends it.
    this.#scheduleOverCeilingSweep();

    if (this.#slots.length <= this.#minSize) return;

    // The ordinary decay, one worker per window: the oldest genuinely spare worker, ready,
    // holding no job, and untouched for the whole interval. Asking "has anything been submitted
    // lately" instead — which is what this did before `P-26` — answers a different question, and
    // answers it "yes" on every probe that is doing any work at all.
    const now = process.hrtime.bigint();
    const spare = this.#spareSlots().filter(
      (slot) => Number(now - slot.idleSince) / 1e6 >= this.#idleShrinkMs,
    )[0];
    if (spare === undefined) return;

    this.#retire(spare, { idleForMs: Math.round(Number(now - spare.idleSince) / 1e6) });
  }

  /**
   * What memory allows, as a number of workers resident at once.
   *
   * Asked with every worker whose memory is in the reading: those held, and those given up whose
   * threads have not exited. **The two uses treat the second kind differently, on purpose.**
   * Shrinking compares the workers held with the cap, because the ones exiting are already on
   * their way out and counting them would give up more to free memory that is coming back anyway.
   * Growing counts them, because until they exit their memory is not free to spend.
   */
  #readMemory(): MemoryCapReading | undefined {
    return this.#memoryCap?.read(this.#slots.length + this.#terminating);
  }

  /** The ceiling in force given a memory reading: `maxSize`, or less where memory binds. */
  #ceiling(memory: MemoryCapReading | undefined): number {
    if (memory === undefined || !this.#enforceMemoryCap) return this.#maxSize;
    // Never under the floor: `minSize` is a number an operator set, and the pool starts that many
    // whatever memory says. The floor is also what `start` spawned, so a cap below it would retire
    // workers the pool is about to need again.
    return Math.max(this.#minSize, Math.min(this.#maxSize, memory.workers));
  }

  /** Workers held beyond what memory allows, for `#pump` to give up as they come free. */
  #overMemory(): number {
    if (!this.#enforceMemoryCap || this.#stopped) return 0;
    const memory = this.#readMemory();
    if (memory === undefined) return 0;
    return Math.max(0, this.#slots.length - this.#ceiling(memory));
  }

  /**
   * How far growth may go, given what memory allows; logs the first time in an episode that it
   * binds.
   */
  #memoryBound(wanted: number, held: number, memory: MemoryCapReading | undefined): number {
    if (memory === undefined) return wanted;
    // Workers still exiting hold memory growth cannot spend yet (`#readMemory`).
    const room = Math.max(this.#minSize, memory.workers - this.#terminating);
    if (wanted <= room) return wanted;
    if (!this.#memoryBinding) {
      this.#memoryBinding = true;
      const fields = {
        held,
        wanted,
        cap: memory.workers,
        maxSize: this.#maxSize,
        queued: this.#queue.length,
        availableMb: Math.round(memory.availableBytes / 2 ** 20),
        reserveMb: Math.round(memory.reserveBytes / 2 ** 20),
        perWorkerMb: Math.round(memory.perWorkerBytes / 2 ** 20),
        source: memory.source,
      };
      if (this.#enforceMemoryCap) {
        this.#logger.warn(
          fields,
          'memory is holding the check pool back; checks will wait and be refused rather than the probe run out',
        );
      } else {
        this.#logger.warn(
          fields,
          "workerPoolSize allows more workers than memory holds; growing past it on the operator's setting",
        );
      }
    }
    return this.#enforceMemoryCap ? Math.max(held, Math.min(this.#maxSize, room)) : wanted;
  }

  #endMemoryEpisode(): void {
    if (!this.#memoryBinding) return;
    this.#memoryBinding = false;
    this.#logger.info(
      { size: this.#slots.length, maxSize: this.#maxSize },
      'nothing is waiting for a worker; memory is no longer holding the check pool back',
    );
  }

  /** Workers that can be retired safely, oldest idle first. Never one in the middle of a check. */
  #scheduleOverCeilingSweep(): void {
    if (this.#overCeilingTimer !== undefined || this.#stopped) return;
    if (this.#slots.length <= this.#maxSize || this.#slots.length <= this.#minSize) return;

    this.#overCeilingTimer = setTimeout(() => {
      this.#overCeilingTimer = undefined;
      this.#considerShrink();
    }, OVER_CEILING_RETRY_MS);
    // Giving memory back must never be the reason the process stays alive.
    this.#overCeilingTimer.unref();
  }

  #spareSlots(): Slot[] {
    return this.#slots
      .filter((slot) => slot.ready && slot.job === undefined && slot.idleSince !== 0n)
      .sort((a, b) => (a.idleSince < b.idleSince ? -1 : 1));
  }

  #retire(slot: Slot, why: Record<string, number>): void {
    this.#shrunk += 1;
    this.#logger.info({ from: this.#slots.length, ...why }, 'shrinking the check pool');
    slot.retired = true;
    this.#bankCounters(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    this.#terminating += 1;
    void slot.worker.terminate().finally(() => {
      this.#terminating -= 1;
    });
  }

  #dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    // Zero while working, so a busy worker can never look like the oldest spare one.
    slot.idleSince = 0n;
    job.startedAt = process.hrtime.bigint();
    job.waitMs = Number(job.startedAt - job.queuedAt) / 1e6;
    record(this.#wait, job.waitMs);

    job.timeout = setTimeout(() => {
      this.#onTimeout(slot, job);
    }, job.request.timeoutMs);
    job.timeout.unref();

    slot.worker.postMessage({
      type: 'run',
      jobId: job.id,
      sensorId: job.request.sensorId,
      sensorType: job.request.sensorType,
      target: job.request.target,
      params: job.request.params,
      // So that a phase can be given a share of it: the name's resolution, bounded below the
      // check's timeout so that a resolver that hangs is a refusal and not a failed scan (`A-41c`).
      timeoutMs: job.request.timeoutMs,
      ...(job.request.credentials === undefined ? {} : { credentials: job.request.credentials }),
      ...(job.request.received === undefined ? {} : { received: job.request.received }),
    });
  }

  /**
   * The check ran out of time.
   *
   * The result goes out now rather than when the check eventually returns: a sensor stuck on a
   * dead connection has to report Down on schedule, or the state machine learns about an outage
   * a minute late. Freeing the worker is a separate problem, handled below it.
   */
  #onTimeout(slot: Slot, job: Job): void {
    if (job.settled) return;
    this.#timedOut += 1;
    this.#settle(
      job,
      'timeout',
      `the check did not finish within ${String(job.request.timeoutMs)} ms`,
    );

    slot.worker.postMessage({ type: 'abort', jobId: job.id });
    job.grace = setTimeout(() => {
      if (slot.job !== job) return;
      this.#logger.warn(
        { sensorId: job.request.sensorId, workerId: slot.id },
        'a check ignored its abort signal; terminating the worker',
      );
      void this.#recycle(slot);
    }, this.#abortGraceMs);
    job.grace.unref();
  }

  /**
   * A worker asks the probe's resolver for a name (`P-426`). Answered on the worker's port, and
   * never to a worker the pool has let go since. **Nothing here throws into the pool**: the
   * resolver answers its own faults as failed lookups, and this answers one that escapes it.
   */
  #onResolve(slot: Slot, request: unknown): void {
    const post = (reply: ResolveAck | ResolveReply): void => {
      if (slot.retired || slot.gone) return;
      slot.worker.postMessage(reply);
    };
    const id = (request as { id?: unknown }).id;
    try {
      if (this.#resolver === undefined) {
        throw new Error('this pool was started without the probe’s resolver');
      }
      this.#resolver.handle(request, post);
    } catch (error: unknown) {
      this.#logger.error(
        { err: describeError(error), workerId: slot.id },
        'a worker’s lookup could not be handed to the probe’s resolver',
      );
      if (typeof id !== 'number') return;
      try {
        post({
          type: 'resolved',
          id,
          ok: false,
          code: RESOLVE_FAULT,
          message: `the probe’s resolver failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // A worker gone between the check above and the post: its check is the pool's already.
      }
    }
  }

  #onWorkerMessage(slot: Slot, message: unknown): void {
    const parsed = message as { type?: string; jobId?: string };
    // A worker the pool has let go: one that said ready just after its start-up bound passed
    // (`P-263`) must not end the streak of failed starts, and is no longer in `#slots` to serve.
    if (slot.retired) return;
    if (parsed.type === 'resolve') {
      this.#onResolve(slot, message);
      return;
    }
    if (parsed.type === 'ready') {
      slot.ready = true;
      if (this.#startFailures > 0) {
        this.#logger.info(
          { workerId: slot.id, failedStarts: this.#startFailures },
          'a check worker started after consecutive failed starts',
        );
      }
      this.#startFailures = 0;
      this.#startDeaths = 0;
      this.#startHangs = 0;
      this.#everReady = true;
      this.#pump();
      return;
    }
    if (parsed.type === 'sessions') {
      // An idle worker's pools closed something, or a busy one's changed mid-check (`P-256`).
      slot.sessions = (message as { sessions: SessionCounters }).sessions;
      return;
    }
    if (parsed.type === 'lookups') {
      // A lookup settled with no check waiting for it, or a check is still waiting (`A-66`).
      slot.lookups = (message as { lookups: LookupCounters }).lookups;
      return;
    }
    if (parsed.type !== 'result') return;

    // **The worker's counters whatever became of the check**, and before it is matched to one
    // (`A-66`). They are the worker's, not the check's, and a worker that sent them on a result
    // does not send them again until they change: taken only from a result the pool had not
    // already settled, a check the pool timed out left the lookup it gave up on in flight and
    // given up on the worker and nowhere else, for as long as the resolver did not answer.
    const counted = message as { sessions?: SessionCounters; lookups?: LookupCounters };
    if (counted.sessions !== undefined) slot.sessions = counted.sessions;
    if (counted.lookups !== undefined) slot.lookups = counted.lookups;

    const job = slot.job;
    if (job === undefined || job.id !== parsed.jobId) return;
    clear(job);
    slot.job = undefined;
    slot.idleSince = process.hrtime.bigint();

    if (!job.settled) {
      const result = message as {
        durationMs: number;
        ok: boolean;
        aborted?: boolean;
        unknownType?: boolean;
        withheld?: boolean;
        message: string;
        /** What the error said of where it failed (`failureSaid`); bounded by `failureOf`. */
        failure?: unknown;
        channels?: { key: string; value: number; name?: string; unit?: string }[];
      };
      record(this.#run, result.durationMs);
      this.#recordTypeDuration(job.request.sensorType, result.durationMs);
      if (result.ok) {
        this.#completed += 1;
        this.#emit(job, slot, 'execute', {
          outcome: 'ok',
          message: result.message,
          durationMs: result.durationMs,
          channels: result.channels ?? [],
        });
      } else {
        this.#failed += 1;
        const phase: CheckPhase =
          result.unknownType === true
            ? 'unknown-type'
            : result.aborted === true
              ? 'aborted'
              : 'execute';
        this.#emit(job, slot, phase, {
          outcome: 'error',
          message: result.message,
          durationMs: result.durationMs,
          channels: [],
          // Refused over where its credentials may go (`A-41c`), which is not a failed scan.
          ...(result.withheld === true ? { withheld: true as const } : {}),
          said: result.failure,
        });
      }
    }

    this.#pump();
  }

  /** A worker died: mid-check, or during start-up. */
  #onWorkerGone(slot: Slot, reason: string): void {
    if (slot.retired || slot.gone) return;
    if (this.#stopped) {
      // Inside `stop`'s drain window a check that loses its worker still owes an answer, and
      // giving it now saves the drain waiting out its whole bound for one that cannot come.
      // Nothing is respawned. Workers `stop` terminates itself arrive here with their jobs
      // already settled, so they count as nothing.
      const job = slot.job;
      if (job === undefined || job.settled) return;
      slot.gone = true;
      this.#crashes += 1;
      slot.job = undefined;
      this.#settle(job, 'worker-crash', `the worker running this check ${reason}`);
      return;
    }
    slot.gone = true;
    this.#crashes += 1;

    const job = slot.job;
    if (job !== undefined) {
      // Exactly one result is lost, and it is reported rather than dropped.
      this.#settle(job, 'worker-crash', `the worker running this check ${reason}`);
      slot.job = undefined;
      slot.idleSince = process.hrtime.bigint();
    }

    // Out of the pool before anything else, including before the latch below returns. It used to
    // return first, so the slot that killed the pool stayed in `#slots` for the life of the
    // process — counted as `poolSize`, and enough to stop `poolUsage` gapping the way it does at
    // size 0, so the reading was "0% of five workers" rather than no reading at all (`P-62`).
    this.#bankCounters(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);

    if (!slot.ready) {
      this.#startFailed(reason, { hung: false });
      return;
    }
    // Counted as on its way until it has started (`P-263`), like a failed start's replacement
    // below: it can wait for a loading turn for as long as the eight loading take, and uncounted
    // in that time `#grow` started a second worker for the same gap.
    this.#growing += 1;
    void this.#spawn().finally(() => {
      this.#growing -= 1;
      this.#pump();
    });
  }

  /**
   * A worker was still loading its registry when its start-up bound passed (`P-263`).
   *
   * Terminated, so it holds neither a loading turn nor its memory, and replaced like any other
   * failed start: after a growing delay, so a registry that always hangs is retried at a rate the
   * log and the CPU can carry. Its exit is the pool's own doing, so `retired` keeps it out of
   * `#onWorkerGone` and it is not a crash.
   */
  #startTimedOut(slot: Slot, startedAt: bigint): void {
    if (slot.ready || slot.gone || slot.retired || this.#stopped) return;
    slot.retired = true;
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    // Still resident until its thread exits, as a retired worker is (`#readMemory`).
    this.#terminating += 1;
    void slot.worker.terminate().finally(() => {
      this.#terminating -= 1;
    });
    const tookMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    this.#startFailed(
      `had not loaded its sensor types within the ${String(this.#startupTimeoutMs)} ms it is allowed (${String(tookMs)} ms)`,
      { hung: true, workerId: slot.id },
    );
  }

  /**
   * A worker never said ready: counted, then replaced after a growing delay, or the pool gives up.
   *
   * **A hang latches the pool off only after a long streak, and only in a pool where no worker
   * was ever ready.** The latch is for a pool that cannot run checks at all (`P-62`, `P-80`): a
   * registry that throws throws again on every attempt, and three such deaths with nothing working
   * is proof. A worker that misses the bound may be the machine and not the registry — `P-258`
   * measured the catalogue's import at up to 14.8 s on an overloaded VM — and a latch lasts until
   * somebody restarts the probe, long after the load has gone. So a hang is retried, at most one
   * start per slot per bound plus delay, and `startupFailed` climbing on Probe Health is how it
   * shows. Hangs and deaths together set the delay; deaths, `#startDeaths`, decide the latch, and
   * so do hangs, `#startHangs`, once `MAX_CONSECUTIVE_START_HANGS` of them have come with no worker
   * ever ready (`P-272`): until then a registry that always hangs held every accepted check in the
   * queue until it filled, and refused the rest, rather than answering them.
   */
  #startFailed(reason: string, how: { hung: boolean; workerId?: number }): void {
    this.#startupFailed += 1;
    this.#startFailures += 1;
    if (how.hung) this.#startHangs += 1;
    else this.#startDeaths += 1;
    // **Already given up: counted, and nothing more** (`P-227`, one error per streak). A worker
    // still loading when the pool latched reaches its bound, or dies, afterwards; it was terminated
    // or is gone, and latching and logging again for each one was a second error line per
    // straggler for the one event. Nothing is retried on a disabled pool either.
    if (this.#disabled) return;
    // **Deaths only, never hangs** (above, `#startDeaths`), and **only when nothing is left
    // working** (`P-80`). The count is pool-wide and reset only by a worker reaching `ready`, and
    // it used to latch on its own — so three failures during a
    // *growth* burst killed a pool that was running fine. `#grow` spawned the whole shortfall at
    // once (sixty at the v1 target, each loading the ~35 MB catalogue; eight at a time since
    // `P-206`, which still leaves room for three), so on a memory-tight host three died during
    // bootstrap before any sibling reported ready, and the probe
    // monitored nothing until somebody restarted it — `#admission` answers `disabled` before it
    // looks at anything else. The latch is for a pool that cannot run checks at all, which is
    // `P-62`'s broken registry: there every worker dies, so nothing is ready and this still
    // fires. Holding ready workers is exactly the difference between the two.
    const working = this.#slots.some((held) => held.ready);
    const dying = this.#startDeaths >= MAX_CONSECUTIVE_START_FAILURES && !working;
    // **Hangs, but only where nothing was ever ready** (`P-272`): a pool that has had a worker
    // ready has loaded this registry, so its hangs are the machine, however long they go on.
    const hanging = this.#startHangs >= this.#startHangLimit && !this.#everReady;
    if (dying || hanging) {
      this.#disabled = true;
      // **And answer what was already accepted.** A queued job carries no timeout — the timer is
      // armed in `#dispatch`, when it *leaves* the queue — so returning here left every accepted
      // check permanently unsettled: no result, no timer, and counted in none of `completed`,
      // `failed`, `timedOut`, `refused` or `discarded`. `stop()` has always drained for this
      // exact reason, and `check-flow.ts` states the guarantee verbatim: a check accepted by a
      // runner must settle.
      const abandoned = this.#queue.splice(0);
      for (const job of abandoned) {
        this.#settle(job, 'pool-disabled', 'the worker pool has given up and cannot run checks');
      }
      this.#logger.error(
        {
          failures: this.#startDeaths,
          hangs: this.#startHangs,
          gaveUpOn: dying ? 'deaths' : 'hangs',
          startupTimeoutMs: this.#startupTimeoutMs,
          registry: this.#registryModule,
          abandoned: abandoned.length,
        },
        'check workers keep failing to start; the pool is disabled until the probe restarts',
      );
      return;
    }
    // Some workers are working, or this was a hang, so this keeps trying, but not at the speed of
    // the event loop.
    const delayMs = Math.min(
      START_RETRY_MAX_MS,
      START_RETRY_BASE_MS * 2 ** (this.#startFailures - 1),
    );
    // One line per streak at warn, the rest at debug (`P-227`); the streak's end is the line `ready`
    // logs, and its size is in `startupFailed`.
    const level = this.#startFailures === 1 ? 'warn' : 'debug';
    if (how.hung) {
      this.#logger[level](
        {
          workerId: how.workerId,
          reason,
          startupTimeoutMs: this.#startupTimeoutMs,
          registry: this.#registryModule,
          retryInMs: delayMs,
        },
        'a check worker had not loaded its sensor types within its start-up bound; terminated it, and retrying with a growing delay',
      );
    } else if (level === 'warn') {
      this.#logger.warn(
        { reason, registry: this.#registryModule, retryInMs: delayMs },
        'a check worker failed to start; retrying with a growing delay while the others work',
      );
    }
    // **Counted as on its way while it waits** (`P-263`). Out of `#slots` and in no other count,
    // the replacement was invisible to `#grow`, which started a worker for the same gap the moment
    // a check queued, and then the retry started another: a pool of two held three after one hang.
    // A start failure's delay made that window 250 ms to 30 s; a hang's bound made it likely.
    this.#growing += 1;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      void this.#spawn().finally(() => {
        this.#growing -= 1;
        this.#pump();
      });
    }, delayMs);
    this.#retryTimers.add(timer);
  }

  /**
   * Terminates a worker whose check ignored its abort, and starts its replacement.
   *
   * **The replacement is counted as on its way from the moment the worker leaves `#slots`**
   * (`P-271`), through the terminate — which lasts as long as the thread takes to stop, and a
   * thread blocked in native code stops only when that returns — and through the wait for a
   * loading turn. Uncounted, a check queuing in that time made `#grow` start a worker for the same
   * gap, and the replacement then made a pool of two hold three.
   *
   * **And the worker itself is counted as still resident through the same terminate** (`P-286`),
   * as `#retire` and `#startTimedOut` count theirs: out of `#slots` and not yet exited, its memory
   * is in any reading taken meanwhile, and uncounted it was read as memory taken by something
   * else.
   */
  async #recycle(slot: Slot): Promise<void> {
    slot.retired = true;
    this.#bankCounters(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    slot.job = undefined;
    slot.idleSince = process.hrtime.bigint();
    this.#growing += 1;
    try {
      this.#terminating += 1;
      try {
        await slot.worker.terminate();
      } finally {
        this.#terminating -= 1;
      }
      if (this.#stopped) return;
      await this.#spawn();
    } finally {
      this.#growing -= 1;
    }
    this.#pump();
  }

  async #spawn(): Promise<void> {
    if (this.#stopped || this.#disabled) return;
    await this.#loadingTurn();
    try {
      // Checked again: the pool can have stopped, or latched, while this spawn waited its turn.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- both are set by stop() and #onWorkerGone during the await above; the checker narrows across it
      if (this.#stopped || this.#disabled) return;
      await this.#start();
    } finally {
      this.#endLoadingTurn();
    }
  }

  /**
   * Waits until fewer than `SPAWN_CONCURRENCY` workers are loading (`P-206`).
   *
   * Every spawn goes through here — `start`, a growth burst, a crash's replacement, a recycle —
   * because the cost is per concurrent load wherever it comes from. `#grow` used to start the
   * whole shortfall at once, and a worker loaded among sixty-three others finished with about
   * 52 MiB of committed heap where one loaded among seven has 36; see the constant for the run.
   * A waiting spawn, whichever of those it is, is already counted in `#growing` (`P-271`), so a
   * queue that it will absorb does not order it a second time.
   */
  #loadingTurn(): Promise<void> {
    if (this.#loading < SPAWN_CONCURRENCY) {
      this.#loading += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#loadingWaiters.push(resolve));
  }

  /** Hands the turn to the next waiting spawn, or gives it back. */
  #endLoadingTurn(): void {
    const next = this.#loadingWaiters.shift();
    if (next === undefined) this.#loading -= 1;
    else next();
  }

  /**
   * Starts one worker and resolves when it has said ready, died trying, or missed its start-up
   * bound.
   *
   * **The bound is `STARTUP_TIMEOUT_MS`, the check process's** (`P-260`), because it bounds the
   * same work: booting a runtime and importing `catalogue-registry.js`. `P-258` measured that import
   * at 0.45–14.8 s beside two probe suites at load 6.5–29, and `P-206` measured a pool loading
   * eight workers at a time with all 64 ready in 6.1 s on 8 cores and 12.7 s on 2, so a turn of
   * eight finishes in well under two seconds. Thirty seconds is twice the worst ever seen, and what
   * a false positive costs here is small — a slow worker started again, not a check failed and not
   * the pool latched — so there is no case for more.
   */
  async #start(): Promise<void> {
    this.#nextWorkerId += 1;
    const worker = new Worker(join(import.meta.dirname, 'check-worker.js'), {
      workerData: {
        registryModule: pathToFileURL(this.#registryModule).href,
        sessionReportMs: this.#sessionReportMs,
        // Read by the worker's resolver client (`P-426`, `resolve-client.ts`).
        resolveThroughPool: this.#resolver !== undefined,
        freshLookups: this.#freshLookups,
      },
      resourceLimits: { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB },
    });
    const slot: Slot = {
      id: this.#nextWorkerId,
      worker,
      ready: false,
      idleSince: process.hrtime.bigint(),
      sessions: undefined,
      lookups: undefined,
      job: undefined,
      retired: false,
      gone: false,
    };
    this.#slots.push(slot);

    worker.on('message', (message: unknown) => {
      this.#onWorkerMessage(slot, message);
    });
    worker.on('error', (error) => {
      // One error line per streak of failed starts, not one per attempt (`P-227`): the retries
      // back off, and the rest of the streak is in `workerCrashes` and the line `ready` logs.
      const repeat = !slot.ready && this.#startFailures > 0;
      this.#logger[repeat ? 'debug' : 'error'](
        { err: describeError(error), workerId: slot.id },
        'check worker failed',
      );
      this.#onWorkerGone(slot, 'failed');
    });
    worker.on('exit', (code) => {
      if (slot.ready && code === 0 && this.#stopped) return;
      this.#onWorkerGone(slot, `exited with code ${String(code)}`);
    });

    // **Bounded** (`P-263`). Until a worker says ready it holds one of `SPAWN_CONCURRENCY`'s loading
    // turns, so one whose registry import never finishes held it for ever, and with eight such the
    // pool could start nothing. No check waits on it — checks go only to ready workers — so the
    // cost of a hang is the turn, the memory and the silence, and the bound ends all three.
    const startedAt = process.hrtime.bigint();
    await new Promise<void>((resolve) => {
      const bound = setTimeout(() => {
        this.#startTimedOut(slot, startedAt);
        resolve();
      }, this.#startupTimeoutMs);
      // The worker itself keeps the process alive while it loads; its bound must not.
      bound.unref();
      const settle = (): void => {
        clearTimeout(bound);
        resolve();
      };
      worker.once('message', settle);
      worker.once('error', settle);
      worker.once('exit', settle);
    });
  }

  #settle(job: Job, phase: CheckPhase, message: string): void {
    if (job.settled) return;
    if (phase === 'worker-crash' || phase === 'pool-stopped') this.#failed += 1;
    this.#emit(job, undefined, phase, {
      outcome: 'error',
      message,
      durationMs: job.startedAt === 0n ? 0 : Number(process.hrtime.bigint() - job.startedAt) / 1e6,
      channels: [],
    });
  }

  #emit(
    job: Job,
    slot: Slot | undefined,
    phase: CheckPhase,
    parts: {
      outcome: 'ok' | 'error';
      message: string;
      durationMs: number;
      channels: { key: string; value: number; name?: string; unit?: string }[];
      withheld?: true;
      /** What the check's error said of where it failed, for `failureOf` (`P-285`). */
      said?: unknown;
    },
  ): void {
    job.settled = true;
    clear(job);
    this.#active.delete(job.request.sensorId);

    // **Made to fit the wire before it is spooled** (`P-277`). A worker runs this probe's own
    // code, but what a check returns is a device's words and a script's numbers, and one result
    // the core's schema refuses closes the connection on every resend of its batch, for every
    // sensor on this probe.
    const { result, problems, dropped } = fitResult({
      sensorId: job.request.sensorId,
      at: new Date().toISOString(),
      outcome: parts.outcome,
      message: parts.message,
      durationMs: Number(parts.durationMs.toFixed(3)),
      // A failed check records no channel values: the gap is the data (CLAUDE.md).
      channels: parts.outcome === 'ok' ? parts.channels : [],
      ...(parts.outcome === 'error' && parts.withheld === true ? { withheld: true as const } : {}),
      // **A check the pool gave up on before it ran** (`P-265`): the device was never asked, so
      // the core holds the sensor behind the probe's one alarm instead of failing it.
      ...(parts.outcome === 'error' && notStarted(phase) ? { notStarted: true as const } : {}),
      // Where it failed (`P-285`): the error's phase, else this pool's when it is not `execute`.
      ...failureField(parts.outcome, phase, parts.said),
    } satisfies CheckResult);
    if (problems.length > 0) unfit(this.#logger, job.request, problems);
    // Counted for Probe Health (`P-283`): the log names the sensor, and this says how often.
    this.#channelsDropped += dropped;
    this.#onResult(result, { phase, waitMs: job.waitMs, workerId: slot?.id ?? 0 });
    if (this.#onDrained !== undefined && this.#inFlight() === 0) this.#onDrained();
  }
}

function clear(job: Job): void {
  if (job.timeout !== undefined) clearTimeout(job.timeout);
  if (job.grace !== undefined) clearTimeout(job.grace);
  job.timeout = undefined;
  job.grace = undefined;
}

/** One measured check duration and when it was measured, for the sizing window (`P-46`). */
export interface DurationSample {
  /** `process.hrtime.bigint()` when the check finished. */
  readonly at: bigint;
  readonly ms: number;
}

/**
 * The median of the samples inside `windowMs` of `now`, keeping at least `MIN_DURATION_SAMPLES`
 * however old, or `undefined` for none (`CheckPool.typicalDurationMs`).
 *
 * **A function of its arguments alone** (`P-234`), so a test hands it durations and a clock. The
 * test through a running pool compared real check durations, and under load a 20 ms check
 * measured 20 ms or 85 ms by turns. The median of nine sat on the boundary between the two, and
 * one outlier moved it from 21 to 85, which read as the median failing when it was the input.
 */
export function typicalOf(
  window: readonly DurationSample[],
  now: bigint,
  windowMs: number,
): number | undefined {
  if (window.length === 0) return undefined;

  // Samples are appended in order, so the first fresh one bounds every later one.
  const cutoff = now - BigInt(windowMs) * 1_000_000n;
  let fresh = 0;
  for (const sample of window) {
    if (sample.at >= cutoff) break;
    fresh += 1;
  }
  const from = Math.min(fresh, Math.max(0, window.length - MIN_DURATION_SAMPLES));

  const sorted = window
    .slice(from)
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))];
}

function record(window: number[], value: number): void {
  window.push(value);
  if (window.length > LATENCY_WINDOW) window.shift();
}

function percentiles(values: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return Number((sorted[index] ?? 0).toFixed(3));
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
