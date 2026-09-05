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
 * Whether this state needs a sentence of its own on the sensor.
 *
 * Four that do: a pause, an acknowledgement, a simulated error and a lost probe. The first three
 * are an operator's own words; the fourth is `R-05`'s, and it belongs here for the same reason —
 * a sensor reading "Unknown" with nothing beside it is the thing to avoid, and "the probe
 * carrying this sensor stopped answering" is the whole of what an operator needs to know.
 *
 * A state a *reading* decided already carries the check's own message, and a state that decided
 * itself — Unknown after a resume — has nothing to say beyond that nobody has scanned it yet.
 */
export function operatorDecided(decision: Decision): boolean {
  return (
    decision.state === 'paused' ||
    decision.cause === 'user' ||
    decision.cause === 'simulated' ||
    decision.cause === 'probe'
  );
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
  //
  //    Acknowledgeable, and that is `N-17`'s decision. The purpose of a simulated error is to
  //    rehearse a notification chain end to end, and acknowledging is a step in that chain —
  //    the one an operator most wants to be sure of, because it is what stops the repeats at
  //    three in the morning. Layer 2 says "behave as though this were down"; `down_acknowledged`
  //    is how a Down behaves once somebody has acknowledged it, so refusing it here would make
  //    the rehearsal unfaithful at exactly the step worth rehearsing.
  //
  //    It still short-circuits layers 3 to 5: a forced outage ignores the probe and the
  //    readings. Only the acknowledgement layer is applied.
  if (facts.simulatedError) return acknowledged({ state: 'down', cause: 'simulated' }, facts);

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
  return acknowledged(combined, facts);
}

/**
 * §2.4 — the acknowledgement layer, in one place because two layers reach it.
 *
 * Layer 5 arrives here with a reading's verdict and layer 2 with a forced one (`N-17`). One
 * function rather than two copies of the rule: a second copy is how "acknowledging works, except
 * on the path nobody tested" happens.
 */
function acknowledged(verdict: Verdict, facts: StateFacts): Decision {
  return verdict.state === 'down' && facts.acknowledged
    ? { state: 'down_acknowledged', cause: 'user' }
    : verdict;
}

/** What the machine carries between results. The persisted half of it is `sensor_runtime`. */
export interface SensorFacts extends StateFacts {
  /**
   * The newest result ever applied. `null` until the first one, and **never nulled after**
   * (`P-97`) — it is the high-water mark that makes the at-least-once probe protocol safe, and a
   * resume that erased it turned every duplicate into a fresh reading.
   */
  readonly lastResultAt: Date | null;
  /**
   * When this sensor last came back from a pause; `null` if it never has.
   *
   * The other half of what `lastResultAt` used to carry alone. It says "nothing measured since"
   * — so the scan facts read `none` while it is at or after `lastResultAt` — and it is a second
   * floor on staleness, because a probe that lost its link keeps scanning a sensor the core has
   * since paused and its spool holds readings from inside the window.
   */
  readonly resumedAt: Date | null;
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
  resumedAt: null,
  acknowledgedUntil: null,
};

/**
 * Whether a result is older than what the sensor has already seen, and so must be discarded.
 *
 * **Strictly newer wins.** The probe protocol is at-least-once by design — a batch acknowledged
 * after it was stored is offered again when the connection drops at the wrong moment — and this
 * predicate is the whole of what makes that safe: a duplicate delivery is a no-op rather than a
 * second failure, which would otherwise advance a two-step policy twice and take a sensor Down
 * on one bad scan.
 *
 * Here rather than inline in the ingestion fold, so that `M-16`'s property tests exercise the
 * rule production uses instead of a second copy of it that could drift from it.
 */
export function isStaleResult(facts: SensorFacts, at: Date): boolean {
  // **Both watermarks, not just the newer result** (`P-97`). A resume used to erase
  // `lastResultAt`, which turned every duplicate the at-least-once protocol can produce into a
  // fresh reading — and admitted results a disconnected probe measured *inside* the pause
  // window, which is a state neither the spec nor the code had a name for. `resumedAt` is the
  // other floor: nothing measured at or before the resume has anything to say about now.
  const floor = Math.max(
    facts.lastResultAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    facts.resumedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(floor) && at.getTime() <= floor;
}

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
  //
  // Two conditions, and between them they are `M-16`'s lesson: the override must not claim to
  // explain a change nobody could have seen.
  //
  // The suppression has to have been *in effect* — §2.4's "the sensor was already Down
  // (Acknowledged)". An acknowledgement sitting on a sensor that read Unknown silenced nothing,
  // so its lapsing ends nothing.
  //
  // And the sensor has to be visibly Down now, which is also what excludes the layers that
  // short-circuit above the reading: a paused sensor evaluates to `paused` and one whose probe
  // is away to `unknown`, so neither reaches this. A sensor held Down by a *simulated* error
  // does reach it, and should: since `N-17` the acknowledgement was genuinely suppressing that
  // Down, so its lapsing is exactly the change `user` names.
  const wasSuppressed = expired && evaluate(facts, policy).state === 'down_acknowledged';
  const decision: Decision =
    wasSuppressed && evaluated.state === 'down' ? { state: 'down', cause: 'user' } : evaluated;

  return { facts: clearedByRecovery(next, decision), decision };
}

/**
 * Drops an acknowledgement that the sensor has recovered out of (§2.4).
 *
 * **Only when the reading decided the state.** Layers 1 to 3 short-circuit before the reading is
 * looked at, and a sensor that reads Unknown because its probe went away has not recovered from
 * anything; clearing the acknowledgement there would un-suppress an outage nobody has fixed.
 *
 * Applied on *every* path that produces a decision, not only on a result — which is what `M-16`
 * found it was missing. Force a simulated error on a healthy sensor, acknowledge the forced
 * alarm, then lift the force: the sensor is Up again, and the acknowledgement it was carrying
 * had nothing to do with any real outage. Before this ran on the re-evaluation path it stayed,
 * invisibly, and silenced the sensor's next genuine failure.
 */
export function clearedByRecovery(facts: SensorFacts, decision: Decision): SensorFacts {
  if (!facts.acknowledged) return facts;
  const decidedByReading = !isPaused(facts.pause) && !facts.simulatedError && facts.probeReachable;
  const recovered =
    decidedByReading && decision.state !== 'down' && decision.state !== 'down_acknowledged';
  return recovered ? { ...facts, acknowledged: false, acknowledgedUntil: null } : facts;
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
export function clearedByResume(facts: SensorFacts, at: Date): SensorFacts {
  // `lastResultAt` survives (`P-97`): it is the idempotence guard, not a statement about
  // whether anything has been measured since. The scan facts say that, and `resumedAt` is what
  // reconstructs them from the row.
  //
  // `at` is taken rather than left to the row write, so these facts and the row the same
  // transaction writes agree. They would otherwise differ for exactly as long as the cached
  // entry lives, and "the cache is dropped on this path anyway" is the kind of reasoning that
  // is true until somebody adds a path where it is not.
  return {
    ...facts,
    scan: { kind: 'none' },
    channel: null,
    acknowledged: false,
    resumedAt: at,
  };
}

function failureCount(facts: SensorFacts): number {
  return facts.scan.kind === 'failed' ? facts.scan.consecutiveFailures : 0;
}

function acknowledgementExpired(facts: SensorFacts, at: Date): boolean {
  const until = facts.acknowledgedUntil;
  return until !== null && at.getTime() >= until.getTime();
}
