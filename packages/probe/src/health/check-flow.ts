/**
 * Whether this probe is getting back the checks it dispatches (`P-76`).
 *
 * **The half of `P-74` the core cannot see.** `P-74` asks whether a probe is delivering anything
 * at all, which is a question about arrivals and therefore the core's to answer. It is deliberately
 * probe-wide: one wedged sensor among five thousand healthy siblings leaves the probe delivering
 * normally, so the core's predicate is false and stays false, and marking 4,999 working sensors
 * Unknown to catch the one would be a false claim that wrecks their SLA.
 *
 * The probe can answer the finer question, and only the probe can. It sees dispatch, completion
 * and shipping on one thread against a monotonic clock, so it is not inferring anything: **a check
 * accepted by a runner must settle.** Both runners guarantee it — `CheckPool` and `ProcessRunner`
 * emit a result on timeout, on a worker or child dying, and on stop. So a check that was accepted
 * and has not come back long after its own timeout is a fault that has been *proved*, not a
 * statistical guess about a slow network.
 *
 * **Two clauses, and the second is what makes it a stall rather than a slow check.** Something
 * outstanding far past its timeout is necessary; *nothing at all having completed since it was
 * dispatched* is what says the runner has stopped, rather than that one check is taking its time
 * while the rest of the probe works. One slow check is that check's problem and its own timeout
 * settles it; a runner that has returned nothing since is everybody's.
 *
 * **Reported, never acted on locally.** This raises a Warning on Probe Health and a count. It does
 * not change any sensor's state, because the probe is not the place that decides state and because
 * the sensors that are still completing are genuinely fine — which is the whole reason this is
 * separate from `P-74` rather than folded into it.
 */

/** Which runner a check went to. Both settle into one sink, so only dispatch knows (`P-82`). */
export type RunnerName = 'pool' | 'process';

/** A check accepted by a runner, and when. Monotonic, because this is a duration and not a date. */
interface Outstanding {
  readonly atNs: bigint;
  /**
   * The runner it was accepted by (`P-82`).
   *
   * Without it a stall was a claim about the *probe*: `#lastCompletionNs` was one value fed from
   * `spoolResult`, the single sink both runners settle into, so a wedged `ProcessRunner` could
   * never be seen while the worker pool kept completing eight checks a second beside it. On any
   * probe carrying both worker checks and EXE/Script checks — which is most of them — the file's
   * own promise that "a runner that has returned nothing since is everybody's" was false.
   */
  readonly runner: RunnerName;
  /**
   * This check's own timeout.
   *
   * The stall window has to clear it, or a sensor legitimately configured to take longer than the
   * window is reported as a stall for running exactly as long as it was told to. A check that has
   * outlived twice its own timeout is overdue by its *own* standard, which is the only standard
   * that means anything across a catalogue where an ICMP ping and an EXE script share a probe.
   */
  readonly timeoutMs: number;
}

export interface CheckFlowStats {
  /** 1 while checks are coming back, 0 when they are dispatched and do not. */
  readonly completing: number;
  /** Checks accepted by a runner and not yet settled. */
  readonly outstanding: number;
  /**
   * How long the oldest outstanding check has been outstanding, in milliseconds.
   *
   * 0 when nothing is outstanding, which is the ordinary state of a probe between ticks — not a
   * gap, because "nothing is waiting" is a real answer and a true one.
   */
  readonly oldestOutstandingMs: number;
  /**
   * Sensors whose last completed check is older than four of their own scan intervals.
   *
   * Four for the reason the history endpoint uses four: past that a reading has stopped being
   * current. Per sensor rather than probe-wide, which is the point — this is the number that says
   * *how much* of a probe is affected when the probe itself is otherwise working.
   */
  readonly behind: number;
}

export interface CheckFlowOptions {
  /**
   * How long the oldest outstanding check may sit, with nothing completing, before this says the
   * runners have stopped.
   *
   * Five minutes, the same window and the same reasoning as the spool's stall detector: long
   * enough that no legitimate check timeout reaches it, short enough that an operator finds out
   * within a scan or two of it mattering.
   */
  readonly stallAfterMs?: number;
  /** Injected so a test does not wait five minutes. `TimingWheel` takes its clock the same way. */
  readonly nowNs?: () => bigint;
  /** The assigned scan interval for a sensor, for the `behind` count. */
  readonly intervalFor?: (sensorId: number) => number | undefined;
  /**
   * Every sensor this probe is currently assigned.
   *
   * Counting over the *assignments* rather than over what has completed is the difference between
   * a number that works and one that reads best in the worst case: a probe where nothing has ever
   * come back has no completions to iterate, so counting those reported `behind: 0` for a probe
   * that was 100% behind.
   */
  readonly assigned?: () => Iterable<number>;
}

const DEFAULT_STALL_AFTER_MS = 300_000;
const BEHIND_INTERVALS = 4;

export class CheckFlowWatchdog {
  readonly #stallAfterMs: number;
  readonly #nowNs: () => bigint;
  readonly #intervalFor: (sensorId: number) => number | undefined;
  readonly #assigned: () => Iterable<number>;
  /** Accepted and not yet settled. Bounded by the runners' own admission, not by sensor count. */
  readonly #outstanding = new Map<number, Outstanding>();
  /** When each sensor last produced a result of any kind, for `behind`. */
  readonly #lastCompleted = new Map<number, bigint>();
  /** When this watchdog started, for a sensor assigned before anything could tell us. */
  readonly #startedNs: bigint;
  /**
   * When each assigned sensor was first *seen* here, as the reference for one that has never
   * completed (`P-80`).
   *
   * `P-77` used the watchdog's own start for that, which counted every sensor assigned after the
   * process came up as behind from the instant it arrived — measured against the probe's whole
   * uptime, before it could possibly have been checked. The ordinary reconnect made that loud:
   * the core's full push is chunked, so a `config-set` of the first 1,000 sensors drops the rest
   * and the deltas re-add them milliseconds later, re-anchoring 4,000 healthy sensors onto a
   * five-day-old constant.
   *
   * Stamped by `assigned()`, which `AssignmentStore.onAdd` drives — the counterpart of the
   * `onDrop` seam that already feeds `forget`. A guess made here instead would be exactly the
   * guess that produced the defect.
   */
  readonly #assignedAt = new Map<number, bigint>();
  /** Per runner, because a stall is a claim about a runner and not about the probe (`P-82`). */
  readonly #lastCompletionNs = new Map<RunnerName, bigint>();

  constructor(options: CheckFlowOptions = {}) {
    this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.#nowNs = options.nowNs ?? ((): bigint => process.hrtime.bigint());
    this.#intervalFor = options.intervalFor ?? ((): undefined => undefined);
    this.#assigned = options.assigned ?? ((): Iterable<number> => []);
    // Starting at "just completed" rather than at zero: a probe that has only just come up has
    // dispatched nothing and returned nothing, and calling that a stall would alarm on every start.
    this.#startedNs = this.#nowNs();
    this.#lastCompletionNs.set('pool', this.#startedNs);
    this.#lastCompletionNs.set('process', this.#startedNs);
  }

  /** A runner accepted this check. Only `accepted` — a deferral was never dispatched. */
  dispatched(sensorId: number, timeoutMs: number, runner: RunnerName = 'pool'): void {
    // Re-dispatch of a sensor already outstanding cannot happen — both runners refuse it with
    // `already-running` — but if it ever did, keeping the *older* timestamp is the safe way round:
    // it is the one that would reveal a stall.
    if (this.#outstanding.has(sensorId)) return;
    this.#outstanding.set(sensorId, { atNs: this.#nowNs(), timeoutMs, runner });
  }

  /** A check settled, however it settled. An error is a completion: the runner came back. */
  completed(sensorId: number): void {
    const now = this.#nowNs();
    // Read before the delete: the outstanding entry is the only record of which runner took it,
    // and both runners settle into one callback that cannot say (`P-82`).
    const runner = this.#outstanding.get(sensorId)?.runner;
    this.#outstanding.delete(sensorId);
    this.#lastCompleted.set(sensorId, now);
    // A completion nobody can attribute — a result for a sensor already forgotten, say — moves no
    // runner's clock. Guessing would be worse in both directions: crediting the wrong runner
    // hides its stall, and crediting all of them hides every stall.
    if (runner !== undefined) this.#lastCompletionNs.set(runner, now);
  }

  /**
   * This probe has become responsible for a sensor, so its four intervals start now.
   *
   * Idempotent on purpose: a re-push of an assignment the probe already holds must not restart
   * the clock, or a busy installation's config churn would hide a sensor that is genuinely late.
   */
  assigned(sensorId: number): void {
    if (!this.#assignedAt.has(sensorId)) this.#assignedAt.set(sensorId, this.#nowNs());
  }

  /** A sensor that is no longer assigned stops counting toward `behind`. */
  forget(sensorId: number): void {
    this.#outstanding.delete(sensorId);
    this.#lastCompleted.delete(sensorId);
    this.#assignedAt.delete(sensorId);
  }

  stats(): CheckFlowStats {
    const now = this.#nowNs();
    let oldestNs: bigint | null = null;
    const overdueRunners = new Set<RunnerName>();
    for (const one of this.#outstanding.values()) {
      if (oldestNs === null || one.atNs < oldestNs) oldestNs = one.atNs;
      // Against its own timeout as well as the window, so a check configured to run longer than
      // the window is not reported as a stall for taking the time it was given.
      const waited = msSince(one.atNs, now);
      if (waited > this.#stallAfterMs && waited > one.timeoutMs * 2) overdueRunners.add(one.runner);
    }
    const oldestOutstandingMs = oldestNs === null ? 0 : msSince(oldestNs, now);

    // **Both clauses, per runner** (`P-82`). The second is recency rather than a comparison
    // against the oldest: it used to read `lastCompletionNs <= oldestNs`, which one leaked check
    // disabled for ever, because a check that never settles pins `oldestNs` at its dispatch. And
    // it is asked of the runner that is overdue rather than of the probe, because one busy runner
    // was otherwise enough to vouch for a wedged one.
    const stalled = [...overdueRunners].some((runner) => {
      const last = this.#lastCompletionNs.get(runner) ?? this.#startedNs;
      return msSince(last, now) > this.#stallAfterMs;
    });

    // Over the assigned set. A sensor that has never completed counts from when it was first seen
    // here, so "never came back at all" is behind rather than invisible — the case that matters
    // most and the one counting completions could not see — while a sensor that arrived a moment
    // ago is given its four intervals like any other rather than being behind on arrival.
    let behind = 0;
    for (const sensorId of this.#assigned()) {
      const intervalSeconds = this.#intervalFor(sensorId);
      if (intervalSeconds === undefined || intervalSeconds <= 0) continue;
      // A sensor assigned before anything told us — which is every sensor if the seam is not
      // wired — falls back to this watchdog's start, so the `P-77` case it was written for
      // (nothing has *ever* come back) still counts rather than silently reading zero.
      const since =
        this.#lastCompleted.get(sensorId) ?? this.#assignedAt.get(sensorId) ?? this.#startedNs;
      if (msSince(since, now) > intervalSeconds * BEHIND_INTERVALS * 1_000) behind += 1;
    }

    return {
      completing: stalled ? 0 : 1,
      outstanding: this.#outstanding.size,
      oldestOutstandingMs,
      behind,
    };
  }
}

function msSince(fromNs: bigint, nowNs: bigint): number {
  return Number((nowNs - fromNs) / 1_000_000n);
}
