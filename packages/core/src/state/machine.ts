/**
 * The sensor state machine (`M-02`).
 *
 * `docs/state-machine.md` is the specification and `tables.ts` is the same thing as data; this
 * is the executable form. It is deliberately **pure** — no database, no clock, no logger — so
 * the whole of Phase 3's principal risk can be driven from a table in a test rather than from a
 * running system. `SensorStateService` is what connects it to results and rows.
 *
 * Two functions, and the split matters:
 *
 *   - {@link evaluate} answers "given everything that is true right now, what state is this?".
 *     It is the layered model of §2, in order, first match wins.
 *   - {@link applyResult} is the reducer: it folds one check result into the facts that persist
 *     (the failure count, the last-result time, the acknowledgement) and then evaluates.
 *
 * Everything the layers read is an input. The layers `M-03`, `M-04` and `M-06` fill in are
 * already here as parameters with a defensible default, so those tasks are a wiring change and
 * not a rewrite: `warnFor` is `M-03`'s, and `channel` is `M-04`/`M-06`'s.
 */

import {
  PAUSE_CAUSE,
  PAUSE_SOURCES,
  ROLLUP_SEVERITY,
  type PauseSource,
  type RollupState,
  type SensorState,
  type SensorStateCause,
} from './tables.js';

/** The four pause sources of §3, as an independent set. */
export type PauseFlags = Readonly<Record<PauseSource, boolean>>;

export const NO_PAUSE: PauseFlags = {
  parent: false,
  dependency: false,
  schedule: false,
  manual: false,
};

/** What the check itself did — §2.1's input. */
export type ScanFacts =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly consecutiveFailures: number };

/**
 * One side's answer: a state a scan with readings can produce, and why.
 *
 * Both §2.1 and §2.2 produce one of these, which is what lets §2.3 combine them by comparing
 * severity. `unknown` is deliberately not expressible here — it is decided a layer earlier, and
 * ranking it against Up would let a channel with no reading outvote one that is genuinely down.
 */
export interface Verdict {
  readonly state: RollupState;
  readonly cause: SensorStateCause;
}

/**
 * What the readings were worth — §2.2's output, which `M-04` and `M-06` will produce.
 *
 * `up` carries cause `scan`, because "within limits" is not a fact about a limit. A breach
 * carries `limit` or `lookup` depending on which decided it.
 */
export type ChannelVerdict = Verdict;

/** All channels within their limits, which is every channel until `M-04` ships any. */
export const CHANNELS_CLEAR: ChannelVerdict = { state: 'up', cause: 'scan' };

/**
 * The failure policy of §2.1. `M-03` makes it per-sensor and inheritable; this is its shape and
 * its default.
 *
 * `warnFor` is how many consecutive failures are reported as Warning before Down. Zero is
 * PRTG's "immediate" — the first failure is Down.
 */
export interface FailurePolicy {
  readonly warnFor: number;
}

export const DEFAULT_FAILURE_POLICY: FailurePolicy = { warnFor: 1 };

/** Everything §2 and §3 read. Nothing is optional: an unstated input is a state nobody checked. */
export interface StateFacts {
  readonly pause: PauseFlags;
  readonly simulatedError: boolean;
  /** False only while the owning probe is unreachable. `R-05` is what will set it. */
  readonly probeReachable: boolean;
  readonly acknowledged: boolean;
  readonly scan: ScanFacts;
  /** `null` when there is nothing to judge — no readings, or no limits configured. */
  readonly channel: ChannelVerdict | null;
}

export interface Decision {
  readonly state: SensorState;
  readonly cause: SensorStateCause;
}

/** The facts of a sensor nothing has happened to yet. */
export const INITIAL_FACTS: StateFacts = {
  pause: NO_PAUSE,
  simulatedError: false,
  probeReachable: true,
  acknowledged: false,
  scan: { kind: 'none' },
  channel: null,
};

/**
 * Which pause source is *reported*, or null if none is active.
 *
 * The loop is the whole rule: a sensor is paused while any source is set, and the order of
 * `PAUSE_SOURCES` decides only which cause is named. Written as a scan over the set rather than
 * as a chain of `else if` so that "clearing one source does not resume a sensor another source
 * still holds" is structural rather than remembered.
 */
export function pauseCause(flags: PauseFlags): SensorStateCause | null {
  for (const source of PAUSE_SOURCES) {
    if (flags[source]) return PAUSE_CAUSE[source];
  }
  return null;
}

/**
 * Whether an operator's own action is what decided this state.
 *
 * The three that are: a pause, an acknowledgement and a simulated error. Their message is the
 * operator's words and belongs on the sensor, where anyone looking at it will read it first; a
 * state a *reading* decided already carries the check's own message, and a state that decided
 * itself — Unknown after a resume — has nothing to say beyond that nobody has scanned it.
 */
export function operatorDecided(decision: Decision): boolean {
  return decision.state === 'paused' || decision.cause === 'user' || decision.cause === 'simulated';
}

export function isPaused(flags: PauseFlags): boolean {
  return PAUSE_SOURCES.some((source) => flags[source]);
}

/** §2.1 — did the check run? */
export function queryState(scan: ScanFacts, policy: FailurePolicy): Verdict | null {
  if (scan.kind === 'none') return null;
  if (scan.kind === 'ok') return { state: 'up', cause: 'scan' };
  return {
    state: scan.consecutiveFailures > policy.warnFor ? 'down' : 'warning',
    cause: 'scan',
  };
}

/**
 * §2.3 — the worse of the two, and the cause of whichever produced it.
 *
 * On a tie the channel wins: "the response time exceeded 500 ms" tells an operator more than
 * "the scan succeeded".
 */
function worst(query: Verdict, channel: ChannelVerdict | null): Verdict {
  if (channel === null) return query;
  return ROLLUP_SEVERITY[channel.state] >= ROLLUP_SEVERITY[query.state] ? channel : query;
}

/**
 * The layered model of §2, evaluated in order, first match wins.
 *
 * Every branch here is a row of that table, in that order, and the order is load-bearing —
 * pause beats a lost probe, a lost probe beats a stale reading.
 */
export function evaluate(
  facts: StateFacts,
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
): Decision {
  // 1. Pause beats everything, including a simulated error and a lost probe: it is an explicit
  //    instruction to stop monitoring, and an alarm from something an operator switched off is
  //    the worst kind of false positive.
  const paused = pauseCause(facts.pause);
  if (paused !== null) return { state: 'paused', cause: paused };

  // 2. A forced error, for testing a notification chain (M-14).
  if (facts.simulatedError) return { state: 'down', cause: 'simulated' };

  // 3. A lost probe is Unknown, never Down: we do not know whether the target is up, and saying
  //    Down would be a claim the system cannot support (WORKFLOW.MD §12). The one alarm comes
  //    from Probe Health.
  if (!facts.probeReachable) return { state: 'unknown', cause: 'probe' };

  // 4. Nothing has been measured since this sensor was created or resumed.
  const query = queryState(facts.scan, policy);
  if (query === null) return { state: 'unknown', cause: 'scan' };

  // 5. A failed scan produced no channel values at all — no-data is not zero — so there is
  //    nothing to compare against a limit and §2.2 is not evaluated. Carrying the previous
  //    channel state forward would keep a stale breach alive across an outage and blame a
  //    threshold for it.
  const combined = worst(query, facts.scan.kind === 'failed' ? null : facts.channel);

  // 6. Acknowledgement is applied last and only to Down. Suppressing notifications is all it
  //    does; the sensor keeps scanning and its readings keep being stored.
  if (combined.state === 'down' && facts.acknowledged) {
    return { state: 'down_acknowledged', cause: 'user' };
  }
  return combined;
}

/** What the machine carries between results. The persisted half of it is `sensor_runtime`. */
export interface SensorFacts extends StateFacts {
  /** `null` until the first result, and again after a resume. */
  readonly lastResultAt: Date | null;
  /**
   * When an active acknowledgement lapses; `null` is indefinite.
   *
   * Separate from `acknowledged` because they are two facts, not one fact twice: a far-future
   * sentinel would make "indefinite" and "until the year 9999" indistinguishable, and only one
   * of those should survive an expiry check.
   */
  readonly acknowledgedUntil: Date | null;
}

export const INITIAL_SENSOR_FACTS: SensorFacts = {
  ...INITIAL_FACTS,
  lastResultAt: null,
  acknowledgedUntil: null,
};

/** One check result, as much of it as the machine reads. */
export interface ResultFacts {
  readonly at: Date;
  readonly outcome: 'ok' | 'error';
  /** The probe's message. Kept whatever the outcome; a recovery message is worth reading too. */
  readonly message: string;
  /** `M-04`'s verdict on the readings. Absent means no limits are configured. */
  readonly channel?: ChannelVerdict | null;
}

/**
 * Folds one result into the facts, then evaluates.
 *
 * Ordering inside here is the part worth reading twice:
 *
 *   1. The acknowledgement expires *first*, against the result's own clock rather than the
 *      wall clock, so replaying a spool produces the same history it would have produced live.
 *   2. The failure count moves before evaluation, because §2.1 counts *this* failure.
 *   3. The acknowledgement is cleared by recovery *after* evaluation, and only when a genuine
 *      reading is what produced the recovery — a pause or a lost probe is not recovery, and
 *      clearing an acknowledgement because a probe restarted would un-suppress an outage
 *      nobody has fixed. §2.4 says "cleared by recovery"; this is what recovery means.
 */
export function applyResult(
  facts: SensorFacts,
  result: ResultFacts,
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
): { facts: SensorFacts; decision: Decision } {
  // An indefinite acknowledgement has no `until` and never expires; it is cleared by recovery
  // or by a resume.
  const expired = facts.acknowledged && acknowledgementExpired(facts, result.at);

  const failures = result.outcome === 'error' ? failureCount(facts) + 1 : 0;

  const next: SensorFacts = {
    ...facts,
    acknowledged: facts.acknowledged && !expired,
    lastResultAt: result.at,
    scan:
      result.outcome === 'ok' ? { kind: 'ok' } : { kind: 'failed', consecutiveFailures: failures },
    channel: result.outcome === 'ok' ? (result.channel ?? null) : null,
  };

  const evaluated = evaluate(next, policy);

  // An acknowledgement that has just lapsed reports `user`, not `scan`. The target being down
  // is not news — the sensor was already Down (Acknowledged); what changed, and what an
  // operator has to see, is that the suppression ended.
  const decision: Decision =
    expired && evaluated.state === 'down' ? { state: 'down', cause: 'user' } : evaluated;

  // Recovery clears the acknowledgement — but only when this reading is what decided the
  // state. Layers 1 to 3 short-circuit before the reading is looked at, and a sensor that
  // reads Unknown because its probe went away has not recovered from anything; clearing the
  // acknowledgement there would un-suppress an outage nobody has fixed.
  const decidedByReading = !isPaused(next.pause) && !next.simulatedError && next.probeReachable;
  const recovered =
    next.acknowledged &&
    decidedByReading &&
    decision.state !== 'down' &&
    decision.state !== 'down_acknowledged';

  return {
    facts: recovered ? { ...next, acknowledged: false } : next,
    decision,
  };
}

/**
 * Re-evaluates without a new result. What a pause, a resume, an acknowledgement or a probe
 * going away calls — the tasks that add those (`M-08`…`M-14`, `R-05`) change a flag and ask.
 */
export function reevaluate(
  facts: SensorFacts,
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
): Decision {
  return evaluate(facts, policy);
}

/**
 * What the *last* pause source clearing does to the facts (§3, "Resume").
 *
 * Called by `M-08`…`M-11` after they clear their own flag and find none of the others set —
 * never by clearing a flag on its own, which is precisely the confusion the four independent
 * flags exist to prevent.
 *
 * Not the previous state: the sensor awaits its next scan, and reporting a state measured
 * before the pause would be reporting something the system has not checked since. Dropping the
 * last-result time is what makes that fall out of layer 4 rather than being special-cased, and
 * the failure count goes with it because the next failure is genuinely the first one.
 */
export function clearedByResume(facts: SensorFacts): SensorFacts {
  return {
    ...facts,
    lastResultAt: null,
    scan: { kind: 'none' },
    channel: null,
    acknowledged: false,
  };
}

function failureCount(facts: SensorFacts): number {
  return facts.scan.kind === 'failed' ? facts.scan.consecutiveFailures : 0;
}

function acknowledgementExpired(facts: SensorFacts, at: Date): boolean {
  const until = facts.acknowledgedUntil;
  return until !== null && at.getTime() >= until.getTime();
}
