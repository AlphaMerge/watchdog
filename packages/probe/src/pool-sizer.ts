import type { Logger } from 'pino';
import { nextCeiling, poolDemand, type DemandInput } from './runner/demand.js';
import { autoPoolCeilingMax, defaultPoolSize } from './runner/pool.js';
import { ICMP_PING_CHECK_MS, POOL_DEMAND_MARGIN } from './measured.js';

/**
 * The pool ceiling, derived from the work this probe was actually given (`P-34`), as a unit
 * something other than `main()` can run.
 *
 * **Extracted for a measurement, not for tidiness.** `scripts/sizing/bench.mjs` pins the ceiling
 * and measures the pool underneath it, so the sizing *loop* — measure durations, derive a demand,
 * apply hysteresis, move the ceiling, watch the pool shed or grow, measure again — had never once
 * run under sustained load. The alternative was to re-implement the loop inside the benchmark,
 * which is exactly the mistake `P-31` cost a week to: a benchmark that models the code instead of
 * running it is right until the code changes, and says nothing on the day it stops being right.
 *
 * Same split as `core-handlers.ts` (`P-43`): `main()` builds the pool and owns the lifecycle,
 * this owns the policy, and the dependencies are structural so a caller can supply its own pool.
 */

/** Just enough of `CheckPool`. */
export interface SizerPool {
  readonly maxSize: number;
  typicalDurationMs(sensorType: string): number | undefined;
  setMaxSize(next: number): void;
}

export interface PoolSizerDeps {
  logger: Logger;
  pool: SizerPool;
  /** What this probe was told to scan. Only the type and the interval are read. */
  assignments: () => Iterable<DemandInput>;
  /**
   * `config.probe.workerPoolSize`.
   *
   * **Zero or less means derive; anything else is the operator's ceiling and this does nothing.**
   * A non-zero setting is somebody's statement about how much memory this probe may use, and a
   * derived number must not overrule it. That is a `P-34` decision and it is kept here rather
   * than at the call site so there is one place that knows it.
   */
  configuredSize: number;
  /**
   * How often the ceiling is recomputed on its own, in milliseconds.
   *
   * Thirty seconds: far below the interval of anything it sizes for, and far above the cost of
   * summing five thousand assignments. Durations drift as networks do, so this runs whether or
   * not a configuration push has happened. Injectable so a benchmark can watch the loop converge
   * without spending half an hour doing it.
   */
  intervalMs?: number;
  /** Overridable for measurement; each defaults to the number the release ships. */
  fallbackMs?: number;
  min?: number;
  max?: number;
  margin?: number;
}

export interface PoolSizer {
  /** False when `workerPoolSize` fixed the ceiling, in which case nothing here does anything. */
  readonly enabled: boolean;
  /** Recompute now. Called on the timer and shortly after a configuration push (`P-41`). */
  readonly size: () => void;
  /** Arms the timer. Unref'd, so it never holds the process open. */
  readonly start: () => void;
  readonly stop: () => void;
}

export const SIZE_INTERVAL_MS = 30_000;

export function poolSizer(deps: PoolSizerDeps): PoolSizer {
  const enabled = deps.configuredSize <= 0;
  const options = {
    fallbackMs: deps.fallbackMs ?? ICMP_PING_CHECK_MS,
    min: deps.min ?? defaultPoolSize(),
    max: deps.max ?? autoPoolCeilingMax(),
    margin: deps.margin ?? POOL_DEMAND_MARGIN,
  };

  // Consecutive computations the derived ceiling has been meaningfully below the current one
  // (`P-40`). Held here rather than in the pool, because it is a property of this loop's cadence
  // — a pool told to change its ceiling should simply do it.
  let belowStreak = 0;
  let timer: NodeJS.Timeout | undefined;

  const size = (): void => {
    if (!enabled) return;
    const demand = poolDemand(
      deps.assignments(),
      (type) => deps.pool.typicalDurationMs(type),
      options,
    );
    if (demand.clamped && demand.required * options.margin > options.max) {
      // Visible rather than silent (`WORKFLOW.MD` §5). The pool will also saturate and raise
      // `poolUsage` on Probe Health, which is the alarm an operator already has a trigger on;
      // this names the number that was refused so the log says what to do about it.
      deps.logger.warn(
        { required: Math.ceil(demand.required), cap: options.max },
        'workload needs more workers than a probe may derive for itself; set workerPoolSize',
      );
    }
    // **Raise now, lower slowly** (`P-40`). Since `P-39` a lowered ceiling sheds workers at once,
    // so following every twitch in a network's round-trip time would destroy and rebuild workers
    // for a workload that has not changed.
    const decision = nextCeiling({
      current: deps.pool.maxSize,
      derived: demand.ceiling,
      belowStreak,
    });
    belowStreak = decision.belowStreak;
    deps.pool.setMaxSize(decision.ceiling);
  };

  return {
    enabled,
    size,
    start: () => {
      if (!enabled || timer !== undefined) return;
      timer = setInterval(size, deps.intervalMs ?? SIZE_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
