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

/** A check accepted by a runner, and when. Monotonic, because this is a duration and not a date. */
interface Outstanding {
  readonly atNs: bigint;
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
  /** When this watchdog started, as the reference for a sensor that has never completed. */
  readonly #startedNs: bigint;
  /** Accepted and not yet settled. Bounded by the runners' own admission, not by sensor count. */
  readonly #outstanding = new Map<number, Outstanding>();
  /** When each sensor last produced a result of any kind, for `behind`. */
  readonly #lastCompleted = new Map<number, bigint>();
  #lastCompletionNs: bigint;

  constructor(options: CheckFlowOptions = {}) {
    this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.#nowNs = options.nowNs ?? ((): bigint => process.hrtime.bigint());
    this.#intervalFor = options.intervalFor ?? ((): undefined => undefined);
    this.#assigned = options.assigned ?? ((): Iterable<number> => []);
    // Starting at "just completed" rather than at zero: a probe that has only just come up has
    // dispatched nothing and returned nothing, and calling that a stall would alarm on every start.
    this.#lastCompletionNs = this.#nowNs();
    this.#startedNs = this.#lastCompletionNs;
  }

  /** A runner accepted this check. Only `accepted` — a deferral was never dispatched. */
  dispatched(sensorId: number, timeoutMs: number): void {
    // Re-dispatch of a sensor already outstanding cannot happen — both runners refuse it with
    // `already-running` — but if it ever did, keeping the *older* timestamp is the safe way round:
    // it is the one that would reveal a stall.
    if (this.#outstanding.has(sensorId)) return;
    this.#outstanding.set(sensorId, { atNs: this.#nowNs(), timeoutMs });
  }

  /** A check settled, however it settled. An error is a completion: the runner came back. */
  completed(sensorId: number): void {
    const now = this.#nowNs();
    this.#outstanding.delete(sensorId);
    this.#lastCompleted.set(sensorId, now);
    this.#lastCompletionNs = now;
  }

  /** A sensor that is no longer assigned stops counting toward `behind`. */
  forget(sensorId: number): void {
    this.#outstanding.delete(sensorId);
    this.#lastCompleted.delete(sensorId);
  }

  stats(): CheckFlowStats {
    const now = this.#nowNs();
    let oldestNs: bigint | null = null;
    let overdue = false;
    for (const one of this.#outstanding.values()) {
      if (oldestNs === null || one.atNs < oldestNs) oldestNs = one.atNs;
      // Against its own timeout as well as the window, so a check configured to run longer than
      // the window is not reported as a stall for taking the time it was given.
      const waited = msSince(one.atNs, now);
      if (waited > this.#stallAfterMs && waited > one.timeoutMs * 2) overdue = true;
    }
    const oldestOutstandingMs = oldestNs === null ? 0 : msSince(oldestNs, now);

    // **Both clauses, and the second is recency rather than a comparison against the oldest.**
    // It used to read `lastCompletionNs <= oldestNs`, which one leaked check disabled for ever:
    // a check that never settles pins `oldestNs` at its dispatch, so any later completion makes
    // the comparison false permanently and no subsequent stall could ever be seen. Asking whether
    // anything has come back *recently* cannot be pinned by a single stuck entry.
    const stalled = overdue && msSince(this.#lastCompletionNs, now) > this.#stallAfterMs;

    // Over the assigned set. A sensor that has never completed counts from when this watchdog
    // started, so "never came back at all" is behind rather than invisible — which is the case
    // that matters most and the one counting completions could not see.
    let behind = 0;
    for (const sensorId of this.#assigned()) {
      const intervalSeconds = this.#intervalFor(sensorId);
      if (intervalSeconds === undefined || intervalSeconds <= 0) continue;
      const since = this.#lastCompleted.get(sensorId) ?? this.#startedNs;
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
