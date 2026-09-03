/**
 * How many workers this probe's own assignments require (`P-34`).
 *
 * **The number a constant cannot know.** A pool completes `workers / checkDuration` checks a
 * second, so it keeps up only while
 *
 *     workers >= Σ over assignments of (check duration / interval)
 *
 * which is Little's law summed per sensor. Both terms are the probe's own: it holds every
 * assignment and its interval, and — since this module was written — it measures what each
 * sensor type actually costs rather than being told.
 *
 * **Why measured rather than declared.** `costHint` on the `SensorType` contract is
 * `light | medium | heavy`, and turning three words into milliseconds is a guess put underneath
 * an arithmetic identity, which is exactly the mistake `P-33` was filed about. A declared
 * duration would be no better: it is a lie the moment a network is slow, and it cannot tell an
 * `http.get` against a fast endpoint from the same type against a slow one. The probe times
 * every check it runs, so the honest source is its own results.
 *
 * **What this is for, and what it is not.** The result is a *ceiling* — a bound on how large the
 * pool may grow — not an allocation. `P-18`'s demand-driven growth and `P-26`'s load tracking
 * still decide what is actually held, so a probe under its ceiling costs nothing for the
 * headroom. This only stops the ceiling being the constraint, which is what `P-32` was.
 */

/** The part of an assignment that decides demand. */
export interface DemandInput {
  readonly sensorType: string;
  readonly intervalSeconds: number;
}

export interface DemandOptions {
  /**
   * What to assume for a type nothing has been measured for yet.
   *
   * A probe that has just started has no timings, and starting from zero would derive a ceiling
   * of nothing and then discover the workload the hard way. 600 ms is `icmp.ping` after `P-07`
   * (`docs/findings/2026-08-29-icmp-throughput.md`) — the type we ship, and a reasonable stand-in
   * for a protocol check that waits for a packet. It is deliberately not the smallest plausible
   * number: guessing low here reproduces `P-32`.
   */
  readonly fallbackMs: number;
  /** Never derive below this, so a small probe still absorbs its first burst without a ramp. */
  readonly min: number;
  /** Never derive above this. The operator's memory bound, and the last word. */
  readonly max: number;
  /**
   * Headroom over the raw requirement.
   *
   * Measured rather than chosen (`docs/findings/2026-09-03-pool-default.md`): at 1.12x the
   * requirement the p95 was 822 ms where the tranche model predicted 600, because queueing the
   * model omits is still on top; by 1.28x it was 614 and the model held. 1.3 is the first round
   * number past that.
   */
  readonly margin: number;
}

export interface Demand {
  /** Raw Little's-law requirement, unrounded — what the workload needs to merely keep up. */
  readonly required: number;
  /** `required x margin`, rounded up and clamped into `[min, max]`. What the ceiling becomes. */
  readonly ceiling: number;
  /** True when the clamp bound the answer, so the ceiling is the operator's number not ours. */
  readonly clamped: boolean;
  /** Assignments whose type had a measured duration, and those that used `fallbackMs`. */
  readonly measured: number;
  readonly assumed: number;
}

/**
 * Sums the requirement and turns it into a ceiling.
 *
 * Pure, and takes the duration lookup as a function, so the arithmetic can be tested against a
 * table without a pool, a wheel or a clock.
 */
export function poolDemand(
  assignments: Iterable<DemandInput>,
  durationMs: (sensorType: string) => number | undefined,
  options: DemandOptions,
): Demand {
  let required = 0;
  let measured = 0;
  let assumed = 0;

  for (const assignment of assignments) {
    // A non-positive interval is not a sensor that runs infinitely often, it is a corrupt
    // assignment; counting it would make the ceiling infinite and take the pool with it.
    if (!Number.isFinite(assignment.intervalSeconds) || assignment.intervalSeconds <= 0) continue;

    const observed = durationMs(assignment.sensorType);
    if (observed === undefined) assumed += 1;
    else measured += 1;

    required += (observed ?? options.fallbackMs) / 1_000 / assignment.intervalSeconds;
  }

  const wanted = Math.ceil(required * options.margin);
  const ceiling = Math.min(options.max, Math.max(options.min, wanted));

  return { required, ceiling, clamped: ceiling !== wanted, measured, assumed };
}

/**
 * Deadband below the current ceiling, inside which a lower answer is not acted on.
 *
 * Ten per cent or four workers, whichever is larger — the constant floor matters because 10% of
 * a small ceiling is less than one worker and would make the band vanish exactly where a single
 * worker is a large fraction of the pool.
 */
const CEILING_DEADBAND = 0.1;
const CEILING_DEADBAND_MIN = 4;

/** Consecutive computations a lower answer must persist for. Two, so ~60 s at a 30 s cadence. */
const LOWER_AFTER = 2;

export interface CeilingDecision {
  /** What the ceiling should be now. Equal to `current` when the answer is to hold. */
  readonly ceiling: number;
  /** Consecutive samples the derived value has been meaningfully lower. Feed back in. */
  readonly belowStreak: number;
}

/**
 * Whether to move the pool ceiling, given what demand now says (`P-40`).
 *
 * **Asymmetric on purpose, and the asymmetry is the whole design.** Raising is immediate: a pool
 * that is too small is a probe falling behind, and every second it waits is checks queueing.
 * Lowering waits, because a ceiling that follows every twitch is worse than one that is briefly
 * too high — since `P-39` a drop sheds workers *at once*, and a worker costs about 35 MB and a
 * registry import to replace.
 *
 * **The thrash this prevents is measured, not imagined.** At the v1 target a ping duration
 * wobbling 600 ± 40 ms moves the derived ceiling between 64 and 73, every thirty seconds. Without
 * a band that is nine workers destroyed and rebuilt a minute, for a workload that has not
 * changed at all.
 *
 * Pure, so the policy can be tested without a pool, a clock or a network.
 */
export function nextCeiling(options: {
  readonly current: number;
  readonly derived: number;
  readonly belowStreak: number;
}): CeilingDecision {
  // Up, or nowhere: act now and forget any downward streak, because the workload just told us
  // the earlier lower readings were not the trend.
  if (options.derived >= options.current) {
    return { ceiling: options.derived, belowStreak: 0 };
  }

  const band = Math.max(CEILING_DEADBAND_MIN, options.current * CEILING_DEADBAND);
  if (options.current - options.derived < band) {
    // Inside the band: not a change, a twitch. The streak resets, so a wobble that never leaves
    // the band never accumulates its way into a drop.
    return { ceiling: options.current, belowStreak: 0 };
  }

  const streak = options.belowStreak + 1;
  if (streak < LOWER_AFTER) return { ceiling: options.current, belowStreak: streak };
  return { ceiling: options.derived, belowStreak: 0 };
}
