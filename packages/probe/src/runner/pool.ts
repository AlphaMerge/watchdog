import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describeError, type CheckResult, type Logger } from '@ms/shared';
import type { CheckPhase, CheckRequest, ResultMeta, SessionCounters } from './types.js';

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
  /**
   * How long a check has to honour its abort before the worker is terminated.
   *
   * The cooperative path is the cheap one — an aborted check returns and its worker is reusable
   * immediately. Termination is the backstop for a check that cannot be interrupted, and it
   * costs a worker restart.
   */
  abortGraceMs?: number;
  /** Module whose default export is a `CheckRegistry`. P-05 supplies the real one. */
  registryModule?: string;
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
   * This worker's session-pool counters as of its last result (`P-36`).
   *
   * Per slot because each worker thread holds its own pools — the module singletons in
   * `@ms/sensors` are per-thread — so the probe's real total is the sum over workers, not any
   * one of them. `undefined` until the worker has finished a check, and for ever on a build
   * whose registry keeps no pools.
   */
  sessions: SessionCounters | undefined;
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
  readonly #registryModule: string;
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

  #nextJobId = 0;
  #nextWorkerId = 0;
  /** Spawns in flight, so a burst of pumps does not order the same worker several times over. */
  #growing = 0;
  #grown = 0;
  #shrunk = 0;
  /** When every slot was last seen busy, or the queue non-empty. Monotonic (`CLAUDE.md`). */
  #shrinkTimer: NodeJS.Timeout | undefined;
  /** Set only while the pool is above its ceiling and still has workers to give back (`P-45`). */
  #overCeilingTimer: NodeJS.Timeout | undefined;
  #startFailures = 0;
  #stopped = false;
  #disabled = false;

  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #timedOut = 0;
  #deferred = 0;
  #refused = 0;
  #discarded = 0;
  #crashes = 0;

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
    this.#registryModule =
      options.registryModule ?? join(import.meta.dirname, 'catalogue-registry.js');
    this.#onResult = options.onResult;
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
    const window = this.#runByType.get(sensorType);
    if (window === undefined || window.length === 0) return undefined;

    // Samples are appended in order, so the first fresh one bounds every later one.
    const cutoff = process.hrtime.bigint() - BigInt(this.#durationWindowMs) * 1_000_000n;
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

  /**
   * Adds a departing worker's counters to the retired baseline (`P-36`).
   *
   * Called wherever a slot leaves `#slots` — shrink, crash, failed start — because the published
   * totals are a sum over live workers and a worker leaving must not make a cumulative counter
   * fall. Idempotent by clearing the slot's snapshot: a crash path that also runs the shrink
   * path would otherwise bank the same numbers twice.
   */
  #bankSessions(slot: Slot): void {
    const counters = slot.sessions;
    if (counters === undefined) return;
    this.#retiredSessions.overflowed += counters.overflowed;
    this.#retiredSessions.evicted += counters.evicted;
    this.#retiredSessions.opened += counters.opened;
    slot.sessions = undefined;
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
    await Promise.all(Array.from({ length: this.#minSize }, () => this.#spawn()));
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
   * Stops accepting work and terminates every worker.
   *
   * Checks in flight are abandoned rather than awaited: a probe shutting down has nothing useful
   * to do with a result nobody will read, and waiting would mean the slowest hung check decides
   * how long shutdown takes.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#shrinkTimer !== undefined) clearInterval(this.#shrinkTimer);
    this.#shrinkTimer = undefined;
    if (this.#overCeilingTimer !== undefined) clearTimeout(this.#overCeilingTimer);
    this.#overCeilingTimer = undefined;
    for (const job of this.#queue.splice(0)) this.#settle(job, 'pool-stopped', 'probe is stopping');
    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.job !== undefined) {
          this.#settle(slot.job, 'pool-stopped', 'probe is stopping');
        }
        await slot.worker.terminate();
      }),
    );
    this.#slots.length = 0;
    this.#logger.info(this.stats(), 'check pool stopped');
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
      this.#logger.warn(
        { sensorId: request.sensorId, queued: this.#queue.length },
        'check queue is full, refusing a check',
      );
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
      refused: this.#refused,
      discarded: this.#discarded,
      disabled: this.#disabled,
      workerCrashes: this.#crashes,
      waitMs: percentiles(this.#wait),
      runMs: percentiles(this.#run),
    };
  }

  #pump(): void {
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
    const held = this.#slots.length + this.#growing;
    if (held >= this.#maxSize) return;
    if (this.#queue.length === 0) return;

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
    const want = Math.min(this.#maxSize, held + unmet);
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
    this.#bankSessions(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    void slot.worker.terminate();
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

  #onWorkerMessage(slot: Slot, message: unknown): void {
    const parsed = message as { type?: string; jobId?: string };
    if (parsed.type === 'ready') {
      slot.ready = true;
      this.#startFailures = 0;
      this.#pump();
      return;
    }
    if (parsed.type !== 'result') return;

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
        message: string;
        channels?: { key: string; value: number; name?: string; unit?: string }[];
        sessions?: SessionCounters;
      };
      record(this.#run, result.durationMs);
      this.#recordTypeDuration(job.request.sensorType, result.durationMs);
      if (result.sessions !== undefined) slot.sessions = result.sessions;
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
        });
      }
    }

    this.#pump();
  }

  /** A worker died: mid-check, or during start-up. */
  #onWorkerGone(slot: Slot, reason: string): void {
    if (this.#stopped || slot.retired || slot.gone) return;
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
    this.#bankSessions(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);

    if (!slot.ready) {
      this.#startFailures += 1;
      if (this.#startFailures >= MAX_CONSECUTIVE_START_FAILURES) {
        this.#disabled = true;
        this.#logger.error(
          { failures: this.#startFailures, registry: this.#registryModule },
          'check workers keep failing to start; the pool is disabled until the probe restarts',
        );
        return;
      }
    }
    void this.#spawn().then(() => {
      this.#pump();
    });
  }

  async #recycle(slot: Slot): Promise<void> {
    slot.retired = true;
    this.#bankSessions(slot);
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    slot.job = undefined;
    slot.idleSince = process.hrtime.bigint();
    await slot.worker.terminate();
    if (this.#stopped) return;
    await this.#spawn();
    this.#pump();
  }

  async #spawn(): Promise<void> {
    if (this.#stopped || this.#disabled) return;
    this.#nextWorkerId += 1;
    const worker = new Worker(join(import.meta.dirname, 'check-worker.js'), {
      workerData: { registryModule: pathToFileURL(this.#registryModule).href },
    });
    const slot: Slot = {
      id: this.#nextWorkerId,
      worker,
      ready: false,
      idleSince: process.hrtime.bigint(),
      sessions: undefined,
      job: undefined,
      retired: false,
      gone: false,
    };
    this.#slots.push(slot);

    worker.on('message', (message: unknown) => {
      this.#onWorkerMessage(slot, message);
    });
    worker.on('error', (error) => {
      this.#logger.error({ err: describeError(error), workerId: slot.id }, 'check worker failed');
      this.#onWorkerGone(slot, 'failed');
    });
    worker.on('exit', (code) => {
      if (slot.ready && code === 0 && this.#stopped) return;
      this.#onWorkerGone(slot, `exited with code ${String(code)}`);
    });

    await new Promise<void>((resolve) => {
      const settle = (): void => {
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
    },
  ): void {
    job.settled = true;
    clear(job);
    this.#active.delete(job.request.sensorId);

    const result: CheckResult = {
      sensorId: job.request.sensorId,
      at: new Date().toISOString(),
      outcome: parts.outcome,
      message: parts.message,
      durationMs: Number(parts.durationMs.toFixed(3)),
      // A failed check records no channel values: the gap is the data (CLAUDE.md).
      channels: parts.outcome === 'ok' ? parts.channels : [],
    };
    this.#onResult(result, { phase, waitMs: job.waitMs, workerId: slot?.id ?? 0 });
  }
}

function clear(job: Job): void {
  if (job.timeout !== undefined) clearTimeout(job.timeout);
  if (job.grace !== undefined) clearTimeout(job.grace);
  job.timeout = undefined;
  job.grace = undefined;
}

/** One measured check duration and when it was measured, for the sizing window (`P-46`). */
interface DurationSample {
  readonly at: bigint;
  readonly ms: number;
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
