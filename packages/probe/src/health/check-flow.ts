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
}

const DEFAULT_STALL_AFTER_MS = 300_000;
const BEHIND_INTERVALS = 4;

export class CheckFlowWatchdog {
  readonly #stallAfterMs: number;
  readonly #nowNs: () => bigint;
  readonly #intervalFor: (sensorId: number) => number | undefined;
  /** Accepted and not yet settled. Bounded by the runners' own admission, not by sensor count. */
  readonly #outstanding = new Map<number, Outstanding>();
  /** When each sensor last produced a result of any kind, for `behind`. */
  readonly #lastCompleted = new Map<number, bigint>();
  #lastCompletionNs: bigint;

  constructor(options: CheckFlowOptions = {}) {
    this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.#nowNs = options.nowNs ?? ((): bigint => process.hrtime.bigint());
    this.#intervalFor = options.intervalFor ?? ((): undefined => undefined);
    // Starting at "just completed" rather than at zero: a probe that has only just come up has
    // dispatched nothing and returned nothing, and calling that a stall would alarm on every start.
    this.#lastCompletionNs = this.#nowNs();
  }

  /** A runner accepted this check. Only `accepted` — a deferral was never dispatched. */
  dispatched(sensorId: number): void {
    // Re-dispatch of a sensor already outstanding cannot happen — both runners refuse it with
    // `already-running` — but if it ever did, keeping the *older* timestamp is the safe way round:
    // it is the one that would reveal a stall.
    if (this.#outstanding.has(sensorId)) return;
    this.#outstanding.set(sensorId, { atNs: this.#nowNs() });
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
    for (const one of this.#outstanding.values()) {
      if (oldestNs === null || one.atNs < oldestNs) oldestNs = one.atNs;
    }
    const oldestOutstandingMs = oldestNs === null ? 0 : msSince(oldestNs, now);

    // Both clauses. Something stuck far past any timeout, *and* nothing at all having come back
    // since it was dispatched — which is what separates a stopped runner from a slow check.
    const stalled =
      oldestNs !== null &&
      oldestOutstandingMs > this.#stallAfterMs &&
      this.#lastCompletionNs <= oldestNs;

    let behind = 0;
    for (const [sensorId, at] of this.#lastCompleted) {
      const intervalSeconds = this.#intervalFor(sensorId);
      if (intervalSeconds === undefined || intervalSeconds <= 0) continue;
      if (msSince(at, now) > intervalSeconds * BEHIND_INTERVALS * 1_000) behind += 1;
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
