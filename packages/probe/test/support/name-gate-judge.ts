import { SAMPLED_PER_KEY } from '../../src/resolver/dns-check.js';
import { FORWARD_HOLD_MS, WALK_BURST, WALK_RATE } from '../../src/resolver/forward-budget.js';
import { RISK_F, RISK_T } from '../../src/resolver/lane-rule.js';
import { ANSWER_MS, RESOLVER_LANES, type RiskSeen } from '../../src/resolver/name-resolver.js';

/**
 * What the name gate's perf arms assert (`P-432` S7, the design's §7.6), as one pure function of
 * what an arm measured, so that each assertion can be shown to fail on a run made to break it
 * (`name-lookups.test.ts`'s judge cases) and is not only ever seen passing.
 *
 * **In every arm, in both modes:**
 * - the forwarder's most slots held at once for the probe, the background's aside: `system` at
 *   most q × 6, P-426's six lanes; gate at most q × 6 + 12, the walk's heard and discovery pools
 *   beside the six tokens (D16). In the arms with a helper loss (P1, P2) the peak is read in
 *   windows cut at each loss and `LOSS_WINDOW_MS` after it: those windows may hold the transient
 *   8 × q more, and every other one is held to q × 6 + 12, as the design's bound table says. Each
 *   run of windows with the transient is judged as one, since P2 cuts one at every look until its
 *   `hung` loss, and is held inside the stretch the losses' own times allow (`lossesAt`, stamped by
 *   the arm, not by the windows): from the loss, or a second before a poll saw it, to
 *   `LOSS_WINDOW_MS` and a late timer's second after it. The windows run on from the forwarder's
 *   start to the arm's end with no stretch unread, and a read that failed fails the arm, since the
 *   stretch it ends was judged against nothing;
 * - no question dropped at the forwarder for want of a slot;
 * - the walk's questions to each server within D19's bucket: 20 at once, refilled at 10 a second
 *   (one more for the time between a token taken and its datagram sent). Check now's walk is cut
 *   (S6), so every question the check sends counts. In `system` mode the check sends none.
 *
 * Each arm adds its own (`ARM_RULES`), from the design's table. Where one says a group's checks are
 * not given up, it means every one of them answered: a check that failed in any other way (the
 * gate's own refusals, `RESOLVER_FAULT` at a helper loss, `ENODATA`) fails the arm as one given up
 * does, since `GIVEN_UP`'s words are only the resolver's for a name it did not hear. P2's answering
 * checks are the one exception, by `P-472`'s decision: an allowance read from the run's own facts
 * (`hangAllowance`), for the checks its stopped child left nowhere to be answered.
 *
 * Two arms are held to another run of the same process (`baseline`), and fail without it
 * (`P-465`): `walkrate`'s event loop to the `addresses` arm's in its mode, both with the name
 * check on and `walkrate` walking names; and `spread10`'s answering checks in gate mode to its own
 * run in `system`, counted over the checks the wheel made due, a check the pool did not run being
 * one not answered, and failed where `system` answered too few for the bound to tell them apart.
 */

export type GateMode = 'system' | 'gate';

/** A lookup's group in the world: what its zone does. */
export type Group = 'answering' | 'silent' | 'cached' | 'crash';

/** A helper loss count by reason, as `LookupHelperStats.lossesByReason` gives it. */
export interface Losses {
  readonly start: number;
  readonly skew: number;
  readonly exit: number;
  readonly hung: number;
  readonly memory: number;
}

/** The forwarder's peak for the probe over one stretch of an arm, in ms from the forwarder's start. */
export interface PeakWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly peak: number;
  /** Opened at a helper loss: D16's transient is allowed in it, and in no other. */
  readonly transient: boolean;
}

/**
 * How long after a loss its window runs (D16, "for at most 10 s after a loss"): a lost child's
 * questions were all sent by the loss and are let go `FORWARD_HOLD_MS` after, and half a second
 * more is the gauge's round trip and the timer's own rounding.
 */
export const LOSS_WINDOW_MS = FORWARD_HOLD_MS + 500;
/** How late a loss window's end may be read: a timer behind a busy event loop (P1's runs: 519 ms). */
const LOSS_WINDOW_LATE_MS = 1_000;
/**
 * How long before a poll saw a loss its transient may be allowed (P2's detach and `hung` loss).
 * The loss came after the look before, and the window the read before that look closed began a
 * poll's 50 ms and two reads' round trips before the look stamped it: a second, behind a busy
 * event loop, as `LOSS_WINDOW_LATE_MS` allows a timer. A loss the arm made itself (P1's kill) is
 * cut at once, so its transient may start no earlier than the loss.
 */
const LOSS_SEEN_EARLY_MS = 1_000;

/** A helper loss the transient is placed by: when it came, on the windows' clock. */
export interface LossAt {
  readonly atMs: number;
  /**
   * Seen by a poll that reads the forwarder's peak before it looks (P2), not made by the arm (P1's
   * kill): the window that read closed is the loss's too.
   */
  readonly seen: boolean;
}

export interface WorldFacts {
  readonly arm: string;
  readonly mode: GateMode;
  /** Whether the name check was on (the policy vouching): `MS_DNS_CHECK=off` turns it off. */
  readonly checkOn: boolean;
  /** Questions one lookup holds at the forwarder: 1 for SNMP's family 4. */
  readonly q: number;
  /** The forwarder's most slots held at once for the probe, background aside. */
  readonly peakHeld: number;
  /** The transient this arm allows past the bound, at a helper loss (D16). */
  readonly transient: number;
  /**
   * The arms with a helper loss: the same peak, read in windows cut at each loss and
   * `LOSS_WINDOW_MS` after it, from the forwarder's start to the arm's end.
   */
  readonly peakWindows?: readonly PeakWindow[];
  /**
   * Where those windows must reach: the arm's end, on their clock, as the last read was asked.
   * A last read that failed leaves the stretch before it judged against nothing, not a gap.
   */
  readonly peakWindowsEndMs?: number;
  /** Why a read of the forwarder's peak failed, if one did: its stretch was judged against nothing. */
  readonly peakReadFailed?: string;
  /**
   * With the windows: the helper losses, as the arm stamped them (P1's kills, P2's detach and
   * `hung` loss), on the windows' clock. The transient is allowed only where these place it, so
   * that a fault in what cuts the windows cannot carry it on unjudged.
   */
  readonly lossesAt?: readonly LossAt[];
  /** Questions the forwarder dropped with every slot held. */
  readonly dropped: number;
  /** The walk's questions, by server: when each was sent, in ms. */
  readonly walkSends: ReadonlyMap<string, readonly number[]>;
  /** Checks given up (failed naming the resolver), by group. */
  readonly givenUp: Readonly<Partial<Record<Group, number>>>;
  /** Checks that failed any other way, by group: the gate's refusals and a helper loss among them. */
  readonly failedOtherwise: Readonly<Partial<Record<Group, number>>>;
  readonly refused: number;
  /** `getaddrinfo` calls on the probe's own lanes, by group. */
  readonly probeLanes: Readonly<Partial<Record<Group, number>>>;
  /** The most lookups in the helper's child at once, by group. */
  readonly helperPeak: Readonly<Partial<Record<Group, number>>>;
  /** `warmzone`: the silent zone's lookups routed to the probe's lanes after it went silent. */
  readonly afterSilence?: { readonly sampled: number; readonly other: number };
  /** `warmzone`: answering names that went longer between answers than their bound. */
  readonly gapsOver?: readonly string[];
  /** The walk's questions a second over the arm's steady window, and its keys. */
  readonly steady?:
    { readonly perSecond: number; readonly keys: number } | { readonly notReached: string };
  /** `zone`: answering names first kept more than a second after their first ask, or never. */
  readonly keptLate?: readonly string[];
  /** `partial`: the cached checks given up, and what places them (`cachedAllowance`). */
  readonly cachedGivenUp?: {
    readonly intervalMs: number;
    /**
     * The event loop's longest turn while the wheel ran, in ms: how late the main thread can have
     * read a time (`P-472`'s `lagMs`). Undefined if it was not measured.
     */
    readonly lagMs: number | undefined;
    /** Each cached name's first answer, in ms from the arm's start. A name never answered is absent. */
    readonly firstAnswerMs: Readonly<Record<string, number>>;
    /** Each cached check given up: its name, when it was asked, and the check's words. */
    readonly checks: readonly {
      readonly name: string;
      readonly askedMs: number;
      readonly message: string;
    }[];
  };
  /** The helper, in gate mode. */
  readonly helper?: {
    readonly losses: Losses;
    readonly poisoned: number;
    /** `lookupHelperTrouble`: the latch's value at the arm's end. */
    readonly trouble: number;
    /** ms the helper spent not answering, `unresponsive` (D26). */
    readonly unresponsiveMs: number;
  };
  /** P2: from the SIGSTOP, when the route left `up`, the `hung` loss, and the next child up. */
  readonly stopped?: {
    readonly downAfterMs: number | undefined;
    readonly hungAfterMs: number | undefined;
    readonly upAfterMs: number | undefined;
  };
  /** P2: what its answering checks' allowance is read from (`P-472`). */
  readonly hang?: HangFacts;
  /**
   * P3: the stall, begun as a probe-lane lookup of an answering name sent its question, and what
   * the probe's lanes said of it. The case D25's marks must survive is that lookup's reply waiting
   * in the probe's socket, unread, while its stuck timer comes due: its reply sent before the stall
   * ended, the lookup not settled when the stall began, and answered only once it was over. Each
   * of the three is measured, since each can fail apart from the others.
   */
  readonly stall?: {
    readonly ms: number;
    /** The reply to that lookup's question was sent before the stall ended, by the simulator's log. */
    readonly replySent: boolean;
    /** The lookup was still open on the probe's lanes as the stall began: its reply not yet read. */
    readonly unsettledAtStart: boolean;
    /**
     * When the lookup was answered, in ms from the stall's end: below 0 is during it, undefined
     * never (or it failed).
     */
    readonly answeredAfterMs: number | undefined;
    readonly unsafeMarks: number;
    readonly passedStuck: number;
  };
  /** P5b: the respawns at the memory gate. */
  readonly respawn?: {
    readonly kills: number;
    /** At every kill the pool held fewer workers than its ceiling allows, for memory. */
    readonly heldAtEveryKill: boolean;
    readonly forkToReadyMs: readonly number[];
    readonly lagAroundForkMs: readonly number[];
    readonly lagBaselineMs: number;
    readonly helperRssAt60s: number | undefined;
    /**
     * How long the helper's route read `down` after each kill, to the next or the arm's end, by
     * the changes the resolver was handed: 0 while every respawn came within `HELPER_REJOIN_MS`.
     */
    readonly routeDownMs: readonly number[];
    /**
     * Answering checks failed by D27's refusal of a name in flight at an earlier loss (`P-453`),
     * which only a route `down` lets through (`#gateRefusal`): read from the checks' own words.
     */
    readonly avoidedRefused: number;
  };
  /** P6: `getaddrinfo` asked on the probe's own lanes for the crash name: the probe would crash. */
  readonly probeCrashes?: number;
  /**
   * P6: the crash name's checks once its zone answered, after it was poisoned: a walk of it would
   * be heard from then on, so only D27 keeps it off the probe's lanes.
   */
  readonly crashAskedOnceAnswering?: number;
  /**
   * The event loop's delay at its 99th percentile while the wheel ran (`monitorEventLoopDelay`),
   * in ms past its resolution.
   */
  readonly eventLoopP99Ms?: number;
  /** The walk's channels opened in the busiest second. */
  readonly channelsBusiestSecond?: number;
  /** The walk's questions for a name: every one but the canary's, which proves the check. */
  readonly namesWalked?: number;
  /** The answering group's checks that ran: answered, given up or failed otherwise. */
  readonly answeringResults?: number;
  /**
   * The answering group's checks the wheel made due that the pool did not run: refused for a full
   * queue, or deferred behind their own sensor's check still running. Each is one not answered.
   */
  readonly answeringNotRun?: number;
  /** Probe Health's `lookupsInFlight` at its highest, sampled each second and at the drain. */
  readonly inFlightMax?: number;
  /** Gate mode: the helper's lanes at risk at a pick at their most, as the resolver kept them. */
  readonly risk?: RiskSeen;
  /** The run this arm is held against, of the same process (`walkrate`, `spread10`). */
  readonly baseline?: Baseline;
}

/**
 * How an answering check that did not answer ended, by its words: given up at its own bound
 * (`did not resolve within N ms`), given up in the resolver's not-answering words, which it says
 * at once (`RESOLVER_HELD`, `RESOLVER_STUCK`, `RESOLVER_FULL`, `EAI_AGAIN`), D27's refusal, or
 * other words.
 */
export type NotAnsweredEnd = 'givenUp' | 'givenUpAtOnce' | 'refused' | 'failed';

/** One answering check that did not answer, in P2 (`P-472`). */
export interface NotAnswered {
  readonly host: string;
  readonly ended: NotAnsweredEnd;
  /**
   * When the resolver was handed its ask, in ms from the SIGSTOP: its own sensor's, or failing
   * that its name's within the main thread's lag of its start. Undefined where neither was found.
   */
  readonly askedAtMs: number | undefined;
  /** Why its ask is not measured, where it is not. */
  readonly notPlaced?: string;
  /** How long its ask said it would wait (`waitMs`): a check given up waited that, and no more. */
  readonly waitMs: number | undefined;
  /** When its result was read, in ms from the SIGSTOP. */
  readonly endedAtMs: number;
}

/** A name in flight in the stopped child at the quiet, and its checks since (`P-472`). */
export interface KeptOffChecked {
  readonly host: string;
  /** Its checks the pool accepted once the route had left `up`, to the arm's end. */
  readonly accepted: number;
  /** Its asks the resolver was handed in that time. */
  readonly asked: number;
  /** Of those, the ones handed while the route read `down`. */
  readonly askedWhileDown: number;
}

/**
 * P2's stopped child, as the arm read it (`P-472`), in ms from the SIGSTOP: what its answering
 * checks' allowance is read from. Every time is the probe's main thread's, where the resolver
 * decides: the route's changes as the resolver was handed them, and each ask as it was handed it.
 */
export interface HangFacts {
  /** The route leaving `up`, at the third quiet tick: the lookups in flight detached (D26). */
  readonly downAtMs: number | undefined;
  /** Its next change from `down`, `rejoining` at the `hung` loss: undefined, never. */
  readonly downUntilMs: number | undefined;
  /**
   * How late the main thread can have been to read anything it stamps: the event loop's longest
   * gap between its delay timer's turns while the wheel ran (`monitorEventLoopDelay`'s max, its
   * resolution in it). A time read so is late by no more.
   */
  readonly lagMs: number | undefined;
  /**
   * The names in flight in the stopped child as the route left `up`, by group: `P-463` keeps them
   * off the probe's lanes from then. Undefined where the stopped child was not found in the tap.
   */
  readonly keptOff: Readonly<Partial<Record<Group, readonly string[]>>> | undefined;
  /**
   * The names held back behind it, by group: a lookup routed to the helper before the route left
   * `up`, and neither sent to a child nor answered by the stopped child's last answer.
   */
  readonly heldBack: Readonly<Partial<Record<Group, readonly string[]>>>;
  /** Every answering check that did not answer, as the checks were counted. */
  readonly notAnswered: readonly NotAnswered[];
  /** Each `getaddrinfo` on the probe's own lanes for a kept-off name, begun once the route left `up`. */
  readonly keptOffOnProbe: readonly { readonly host: string; readonly atMs: number }[];
  /** Each kept-off answering name, and its checks since the route left `up`: what rule 4 judged. */
  readonly keptOffChecked: readonly KeptOffChecked[];
}

/** What P2's allowance makes of its answering checks that did not answer (`hangAllowance`). */
export interface HangVerdict {
  /** Given up at its bound, waiting on the stopped child or on its queue (`hangAllowance`). */
  readonly givenUpAllowed: readonly NotAnswered[];
  /** D27's refusals of a name in flight at the quiet, asked while the route read `down`. */
  readonly refusedAllowed: readonly NotAnswered[];
  /** Every other, and why it is outside. */
  readonly outside: readonly { readonly check: NotAnswered; readonly why: string }[];
}

/**
 * P2's allowance for its answering checks (`P-472`'s decision). The design promises that a hung
 * child holds no name, not that no check is lost in it (§1.11's `up` → `unresponsive` row, §9's risk
 * 3), and two kinds of answering check had nowhere to be answered:
 * - **given up at its own bound**, never in the resolver's at-once words, asked before the route
 *   left `up` and its result read after the SIGSTOP, so still waiting then:
 *   - for a name in flight in the stopped child at the quiet (kept off): it waited on that lookup,
 *     detached at the quiet (D26), so its bound may run out after the route left `up`;
 *   - for a name held back behind it (queued in the helper): its bound ran out before the route
 *     left `up`, its ask and its wait at most the route's `down` and the main thread's lag, since at
 *     `down` the queued lookup falls back to the probe's lanes (`#fallBack`), which answer it;
 * - **failed otherwise**: allowed only as D27's refusal (`P-463`), for a name in flight in the
 *   stopped child at the quiet, asked while the route read `down`: the probe's own `getaddrinfo`
 *   may not ask it, and the only process that may was not answering.
 *
 * Nothing else is allowed, and words other than those two kinds never are. Each check is placed by
 * its own sensor's ask at the resolver and its own name, so the allowance is as large as the run
 * made it, and no constant sets it. A time the main thread read is late by at most `lagMs`, and is
 * given that much, and no more.
 */
export function hangAllowance(hang: HangFacts): HangVerdict {
  const down = hang.downAtMs;
  const downUntil = hang.downUntilMs ?? Number.POSITIVE_INFINITY;
  const lag = hang.lagMs;
  const names = (of: readonly string[] | undefined): Set<string> =>
    new Set((of ?? []).map((name) => name.toLowerCase()));
  const keptOff = names(hang.keptOff?.answering);
  const heldBack = names(hang.heldBack.answering);
  // Why a check given up at its bound, asked at `asked`, is outside, if it is.
  const givenUpOutside = (check: NotAnswered, asked: number, at: number): string | undefined => {
    if (asked >= at) return 'asked once the route had left up';
    if (check.endedAtMs <= 0) {
      return 'its result read by the SIGSTOP, so not waiting on the stopped child';
    }
    const host = check.host.toLowerCase();
    if (keptOff.has(host)) return undefined;
    if (!heldBack.has(host)) {
      return 'for a name neither in flight in the stopped child nor held back behind it';
    }
    if (check.waitMs === undefined) return 'its wait not read from its ask';
    if (lag === undefined) {
      return 'for a name held back, the main thread’s lag not measured to put its bound’s end before the route left up';
    }
    if (asked + check.waitMs > at + lag) {
      return 'for a name held back, its bound still running as the route left up, when its lookup fell back to the probe’s lanes';
    }
    return undefined;
  };
  const givenUpAllowed: NotAnswered[] = [];
  const refusedAllowed: NotAnswered[] = [];
  const outside: { check: NotAnswered; why: string }[] = [];
  for (const check of hang.notAnswered) {
    const host = check.host.toLowerCase();
    const asked = check.askedAtMs;
    let why: string | undefined;
    if (check.ended === 'failed') {
      why = 'in words neither the given-up words nor D27’s refusal';
    } else if (check.ended === 'givenUpAtOnce') {
      why = 'in the resolver’s not-answering words, not at its own bound';
    } else if (asked === undefined) {
      why = `its ask not measured (${check.notPlaced ?? 'no ask of it was seen'})`;
    } else if (down === undefined) {
      why = 'with no route off up handed to the resolver';
    } else if (check.ended === 'givenUp') {
      why = givenUpOutside(check, asked, down);
    } else if (!keptOff.has(host)) {
      why = 'for a name not in flight in the stopped child at the quiet';
    } else if (asked < down) {
      why = 'asked before the route left up';
    } else if (asked >= downUntil) {
      why = 'asked once the route no longer read down';
    }
    if (why !== undefined) outside.push({ check, why });
    else if (check.ended === 'givenUp') givenUpAllowed.push(check);
    else refusedAllowed.push(check);
  }
  return { givenUpAllowed, refusedAllowed, outside };
}

/** What an arm's baseline run measured, for the arm held against it (`P-465`). */
export interface Baseline {
  readonly arm: string;
  readonly mode: GateMode;
  readonly eventLoopP99Ms: number | undefined;
  /** Its answering checks the wheel made due: run, refused or deferred. */
  readonly answeringChecks: number;
  /** Of them, the ones that did not answer: given up, failed any other way, or not run. */
  readonly answeringNotAnswered: number;
}

/** What a run's facts give an arm held against it. */
export function baselineOf(facts: WorldFacts): Baseline {
  const notRun = facts.answeringNotRun ?? 0;
  return {
    arm: facts.arm,
    mode: facts.mode,
    eventLoopP99Ms: facts.eventLoopP99Ms,
    answeringChecks: (facts.answeringResults ?? 0) + notRun,
    answeringNotAnswered:
      count(facts.givenUp, 'answering') + count(facts.failedOtherwise, 'answering') + notRun,
  };
}

/**
 * `spread10`'s bound on the gate's answering checks not answered, from its run and `system`'s
 * (`P-465`), counted over the checks the wheel made due, so that a check the pool refused or
 * deferred is one not answered, and the noise does not shrink as fewer run.
 */
export interface Spread10Bound {
  /** The gate's answering checks the wheel made due. */
  readonly checks: number;
  /** Of them, not answered: given up, failed otherwise, or not run. */
  readonly notAnswered: number;
  /** Of those, not run. */
  readonly notRun: number;
  /** `system`'s answering checks, and how many of them it answered. */
  readonly systemChecks: number;
  readonly systemAnswered: number;
  /** `SPREAD10_NOISE` of the gate's checks. */
  readonly noise: number;
  /** The most the gate may leave not answered: `system`'s and the noise. */
  readonly bound: number;
  /** The fewest the gate must answer to pass: at 0 or less, the bound holds by construction. */
  readonly mustAnswer: number;
}

/** `spread10`'s bound, or undefined where the run did not count its answering checks. */
export function spread10Bound(facts: WorldFacts, base: Baseline): Spread10Bound | undefined {
  const results = facts.answeringResults;
  const notRun = facts.answeringNotRun;
  if (results === undefined || notRun === undefined) return undefined;
  const checks = results + notRun;
  const noise = Math.ceil(SPREAD10_NOISE * checks);
  const bound = base.answeringNotAnswered + noise;
  return {
    checks,
    notAnswered:
      count(facts.givenUp, 'answering') + count(facts.failedOtherwise, 'answering') + notRun,
    notRun,
    systemChecks: base.answeringChecks,
    systemAnswered: base.answeringChecks - base.answeringNotAnswered,
    noise,
    bound,
    mustAnswer: checks - bound,
  };
}

/** How many sends a token bucket of `burst` refilled at `perSecond` could not have admitted. */
export function overBucket(
  sends: readonly number[],
  perSecond: number = WALK_RATE,
  burst: number = WALK_BURST + 1,
): number {
  const times = [...sends].sort((a, b) => a - b);
  let tokens = burst;
  let at = times[0] ?? 0;
  let over = 0;
  for (const time of times) {
    tokens = Math.min(burst, tokens + ((time - at) * perSecond) / 1_000);
    at = time;
    if (tokens >= 1) tokens -= 1;
    else over += 1;
  }
  return over;
}

/** The most sends in any one second, for the record. */
export function busiestSecond(sends: readonly number[]): number {
  const times = [...sends].sort((a, b) => a - b);
  let most = 0;
  let from = 0;
  for (let to = 0; to < times.length; to += 1) {
    while ((times[to] ?? 0) - (times[from] ?? 0) >= 1_000) from += 1;
    most = Math.max(most, to - from + 1);
  }
  return most;
}

/** The bound on the forwarder's slots for the probe (D16). */
export function heldBound(facts: Pick<WorldFacts, 'mode' | 'q' | 'transient'>): number {
  return facts.mode === 'system' ? facts.q * 6 : facts.q * 6 + 12 + facts.transient;
}

const count = (facts: Readonly<Partial<Record<Group, number>>>, group: Group): number =>
  facts[group] ?? 0;

/** The helper's 6 general lanes: a zone that is not answering holds at most 3 (D1). */
const QUIET_KEY_LANES = 3;
/** P2, from the SIGSTOP: not answering by 4 s, `hung` by 22 s, the next child up by 23 s. */
const DOWN_BY_MS = 4_000;
const HUNG_BY_MS = 22_000;
const UP_BY_MS = 23_000;
/**
 * P2: the most answering names the stopped child can hold at the quiet, the helper's first-lookup
 * lanes and its retry lane. The helper's lane set is `laneSet('helper', RESOLVER_LANES)`, whose
 * first lookups take at most all but 2 of its lanes (`firstCap`) and whose retries take one
 * (`#canRun`); src exports the lane count and not the two caps it derives from it, so they are
 * derived here as `laneSet` derives them. Refreshes are not counted: one needs an answer older than
 * `ANSWER_MS`, and P2's quiet comes 13 s into the run.
 */
export const HELPER_FIRST_AND_RETRY_LANES = RESOLVER_LANES - 2 + 1;
/** P5, P5b: fork to `ready`, the main thread's block at a fork past the baseline, the child's RSS. */
const FORK_TO_READY_MS = 1_000;
const FORK_LAG_OVER_MS = 100;
const HELPER_RSS_MAX = 128 * 1024 * 1024;
/** `walkrate`: its event loop's p99 past the `addresses` arm's, at most (round 2's §7.6). */
export const WALKRATE_P99_OVER_MS = 10;
/**
 * `walkrate`: the walk's channels in any one second, at most: one a question for SNMP's one type,
 * so D19's bucket, its burst with the one more `overBucket` allows and a second's refill (§1.6:
 * "about 30 a second").
 */
export const CHANNELS_A_SECOND = WALK_BURST + 1 + WALK_RATE;
/** `spread10`: the helper's lanes at risk at a pick that the gate admitted, at most (T + F). */
const RISK_ADMITTED_MAX = RISK_T + RISK_F;
/**
 * `spread10`: how far past `system`'s the gate's answering checks not answered may be, as a share
 * of them. The two modes run one lane rule here, the helper's lanes a copy of `P-426`'s with the
 * check off, and two full-size minutes of each differed by up to 34 of 3,000 within a mode and 26
 * across (`P-465`): a strict bound is a coin flip between equals. Three times that spread.
 */
export const SPREAD10_NOISE = 0.03;
/**
 * `spread10`: the bound must fail a gate that answered fewer than this share of what `system`
 * answered. Where `system` answers little, `system`'s count and the noise reach about every check,
 * and a gate that answered almost none would pass (`P-465`'s first review): the run is then not a
 * comparison, and is failed as one that could not tell the gate from `system`.
 */
export const SPREAD10_TELLS = 0.5;

type Rule = (facts: WorldFacts, said: (violation: string) => void) => void;

/** Every check of each group answered: none given up, and none failed any other way. */
function allAnswered(facts: WorldFacts, said: (violation: string) => void, groups: Group[]): void {
  for (const group of groups) {
    if (count(facts.givenUp, group) > 0) {
      said(`${String(count(facts.givenUp, group))} ${group} checks given up`);
    }
    if (count(facts.failedOtherwise, group) > 0) {
      said(`${String(count(facts.failedOtherwise, group))} ${group} checks failed otherwise`);
    }
  }
}

/**
 * The words a held cached name's check gives up with in `partial` (`P-478`'s fix round 2), and no
 * others: what the arm's runs showed at 1,000 sensors, check on and off, 12 of 12 each. The
 * helper's key rule fails the check at once as the last of its zone's 3 lookups runs past
 * `STUCK_MS`, and the key is then quiet, since a stuck lookup was the last thing it heard: so the
 * quiet words, never "the DNS check does not vouch for". A check that waited out its bound, or that
 * any other condition held, is not a held cached name's.
 */
export const HELD_CACHED_WORDS =
  /the probe’s resolver is not answering \(every lane a lookup for \S+ could use is held by a lookup that has run past \d+ ms \([^)]*\): no name of \S+ has answered in the lookup helper since one of its lookups ran past \d+ ms, so it holds at most 3 of the helper’s lanes; it stays queued\)$/u;

/** A check's words with its name and its numbers taken out: what `partial`'s row counts. */
export function wordsOf(message: string): string {
  return message.replace(/dev-\d+\.zone-[a-z]\.test/gu, '<name>').replace(/\d[\d,.]*/gu, 'N');
}

/**
 * `partial`'s cached checks given up that the judge allows (`P-478`'s fix rounds 1 and 2), and why
 * each of the rest is not. At a cold start a cached name's first lookup may wait behind its zone's
 * silent lookups, which nothing has yet told apart from it, and every one of its checks that comes
 * due meanwhile gives up with it, as `system`'s do on the probe's lanes: ten sensors a device. So a
 * cached check given up is allowed only while its name is held, one episode a name: asked within
 * the arm's first scan interval, before its name's first answer plus the lag the run measured,
 * and in the words a held name's check gives up with (`HELD_CACHED_WORDS`). Read from the facts,
 * never a count fixed beforehand. Every other is not, nor is one the facts do not place.
 */
export function cachedAllowance(facts: WorldFacts): {
  readonly names: number;
  readonly checks: number;
  readonly refused: readonly string[];
} {
  const total = count(facts.givenUp, 'cached');
  const given = facts.cachedGivenUp;
  if (given === undefined) {
    return {
      names: 0,
      checks: 0,
      refused: total > 0 ? [`${String(total)} cached checks given up`] : [],
    };
  }
  const refused: string[] = [];
  if (given.checks.length !== total) {
    refused.push(
      `${String(total)} cached checks given up, and ${String(given.checks.length)} placed by name and time`,
    );
  }
  const names = new Set<string>();
  let checks = 0;
  const first = `the arm’s first scan interval of ${String(given.intervalMs / 1_000)} s`;
  const s = (ms: number): string => `${(ms / 1_000).toFixed(1)} s`;
  for (const { name, askedMs, message } of given.checks) {
    const which = `a cached check of ${name} given up, asked at ${s(askedMs)}`;
    const answered = given.firstAnswerMs[name];
    if (askedMs < 0 || askedMs >= given.intervalMs) {
      refused.push(`${which}, past ${first}`);
    } else if (answered !== undefined && given.lagMs === undefined) {
      refused.push(
        `${which}: the lag was not measured, so it is not placed before ${name}’s first answer`,
      );
    } else if (answered !== undefined && askedMs >= answered + (given.lagMs ?? 0)) {
      refused.push(
        `${which}, after ${name}’s first answer at ${s(answered)} and the ${String(Math.round(given.lagMs ?? 0))} ms lag measured`,
      );
    } else if (!HELD_CACHED_WORDS.test(message)) {
      refused.push(
        `${which}, in words a held name’s check does not give up with: ${wordsOf(message)}`,
      );
    } else {
      names.add(name);
      checks += 1;
    }
  }
  return { names: names.size, checks, refused };
}

function silentOffProbeLanes(facts: WorldFacts, said: (violation: string) => void): void {
  if (count(facts.probeLanes, 'silent') > 0) {
    said(
      `${String(count(facts.probeLanes, 'silent'))} getaddrinfo for the silent zone on the probe’s lanes`,
    );
  }
}

/**
 * The silent zone held to `QUIET_KEY_LANES` of the helper's lanes at once: the helper's cap, which
 * holds with the check on and off (`P-478`), since the helper judges a key by what its own lookups
 * did, whatever routed them there.
 */
function silentHelperCapped(facts: WorldFacts, said: (violation: string) => void): void {
  if (count(facts.helperPeak, 'silent') > QUIET_KEY_LANES) {
    said(
      `the silent zone held ${String(count(facts.helperPeak, 'silent'))} of the helper’s lanes at once, past ${String(QUIET_KEY_LANES)}`,
    );
  }
}

function steadyWalks(facts: WorldFacts, said: (violation: string) => void): void {
  const steady = facts.steady;
  if (steady === undefined || 'notReached' in steady) return;
  const bound = 1 + steady.keys * facts.q;
  if (steady.perSecond > bound) {
    said(
      `the walk asked ${steady.perSecond.toFixed(2)} questions a second at steady state, past 1 + ${String(steady.keys)} keys × q = ${String(bound)}`,
    );
  }
}

function lossesWere(
  facts: WorldFacts,
  said: (violation: string) => void,
  expected: Partial<Losses>,
): void {
  const losses = facts.helper?.losses;
  if (losses === undefined) {
    said('no helper was measured');
    return;
  }
  for (const reason of ['start', 'skew', 'exit', 'hung', 'memory'] as const) {
    const want = expected[reason] ?? 0;
    if (losses[reason] !== want) {
      said(`${String(losses[reason])} ${reason} losses, where ${String(want)} were made`);
    }
  }
}

function untroubled(facts: WorldFacts, said: (violation: string) => void): void {
  if ((facts.helper?.trouble ?? 0) !== 0) {
    said(`lookupHelperTrouble read ${String(facts.helper?.trouble)}`);
  }
}

const atS = (ms: number | undefined): string =>
  ms === undefined ? 'unread' : `${(ms / 1_000).toFixed(1)} s`;
/** A few of `checks`, by name and ask, for a reader to find in the run. */
const someOf = (checks: readonly NotAnswered[]): string =>
  checks
    .slice(0, 3)
    .map(({ host, askedAtMs }) => `${host} at ${atS(askedAtMs)}`)
    .join(', ') + (checks.length > 3 ? `, and ${String(checks.length - 3)} more` : '');
const ENDED_WORDS: Readonly<Record<NotAnsweredEnd, string>> = {
  givenUp: 'given up',
  givenUpAtOnce: 'given up',
  refused: 'refused by D27',
  failed: 'failed otherwise',
};

/**
 * P2's answering checks (`P-472`): every one answered but those its allowance takes
 * (`hangAllowance`); the facts accounting for every check counted, and their window the one the
 * helper's own route read; the stopped child holding no more answering names than the helper's
 * first and retry lanes; and no name in flight in the stopped child at the quiet asked on the
 * probe's own lanes since, which is what the allowance pays for: without it, a build that let such
 * a name go to the probe's lanes would pass, its checks answered there (`P-463`'s own mutant). That
 * last is judged on every kept-off answering name the pool ran a check of since: one of them that
 * asked the resolver nothing leaves it judged on nothing.
 */
function hangAllowed(facts: WorldFacts, said: (violation: string) => void): void {
  const hang = facts.hang;
  if (hang === undefined) {
    said('the hang’s allowance was not measured, so every answering check is held to answering');
    allAnswered(facts, said, ['answering']);
    return;
  }
  if (hang.downAtMs === undefined) {
    said('the route leaving up was not handed to the resolver, so no answering check is allowed');
  }
  // The window is the resolver's, handed each change a microtask after the helper made it, so
  // before any poll of the helper's own route could read it (`#emit`).
  const stopped = facts.stopped;
  if (stopped !== undefined) {
    const late = (what: string, handed: number, seen: number): void => {
      said(
        `the route ${what} was handed to the resolver ${String(Math.round(handed))} ms after the SIGSTOP, after the helper’s own route read so at ${String(Math.round(seen))} ms: the window is not the helper’s`,
      );
    };
    if (
      hang.downAtMs !== undefined &&
      stopped.downAfterMs !== undefined &&
      hang.downAtMs > stopped.downAfterMs
    ) {
      late('leaving up', hang.downAtMs, stopped.downAfterMs);
    }
    if (stopped.hungAfterMs !== undefined) {
      if (hang.downUntilMs === undefined) {
        said(
          `the route leaving down was never handed to the resolver, though the hung loss came ${String(Math.round(stopped.hungAfterMs))} ms after the SIGSTOP`,
        );
      } else if (hang.downUntilMs > stopped.hungAfterMs) {
        late('leaving down', hang.downUntilMs, stopped.hungAfterMs);
      }
    }
  }
  if (hang.keptOff === undefined) {
    said('the kept-off names were not measured: the stopped child was not found in the tap');
  }
  const keptAnswering = hang.keptOff?.answering?.length ?? 0;
  if (keptAnswering > HELPER_FIRST_AND_RETRY_LANES) {
    said(
      `the stopped child held ${String(keptAnswering)} answering names at the quiet, past the helper’s ${String(HELPER_FIRST_AND_RETRY_LANES)} first-lookup and retry lanes`,
    );
  }
  // Read for every check counted, or the allowance would pass checks it never saw.
  const read = (ended: readonly NotAnsweredEnd[]): number =>
    hang.notAnswered.filter((check) => ended.includes(check.ended)).length;
  const givenUp = count(facts.givenUp, 'answering');
  const otherwise = count(facts.failedOtherwise, 'answering');
  const readGivenUp = read(['givenUp', 'givenUpAtOnce']);
  if (readGivenUp !== givenUp) {
    said(
      `the hang’s facts read ${String(readGivenUp)} answering checks given up, where ${String(givenUp)} were counted`,
    );
  }
  if (read(['refused', 'failed']) !== otherwise) {
    said(
      `the hang’s facts read ${String(read(['refused', 'failed']))} answering checks failed otherwise, where ${String(otherwise)} were counted`,
    );
  }
  const byWhy = new Map<string, NotAnswered[]>();
  for (const { check, why } of hangAllowance(hang).outside) {
    const key = `${ENDED_WORDS[check.ended]} outside the hang’s allowance, ${why}`;
    byWhy.set(key, [...(byWhy.get(key) ?? []), check]);
  }
  for (const [key, checks] of byWhy) {
    said(`${String(checks.length)} answering checks ${key} (${someOf(checks)})`);
  }
  const onProbe = hang.keptOffOnProbe;
  if (onProbe.length > 0) {
    said(
      `${String(onProbe.length)} getaddrinfo on the probe’s own lanes for names in flight in the stopped child, since the route left up (${onProbe
        .slice(0, 3)
        .map(({ host, atMs }) => `${host} at ${atS(atMs)}`)
        .join(', ')}): D27 keeps them off (P-463)`,
    );
  }
  const unasked = hang.keptOffChecked.filter(({ accepted, asked }) => accepted > 0 && asked === 0);
  if (unasked.length > 0) {
    said(
      `${String(unasked.length)} kept-off answering names had checks run since the route left up, and none asked the resolver (${unasked
        .slice(0, 3)
        .map(({ host, accepted }) => `${host}, ${String(accepted)} run`)
        .join('; ')}): the probe’s lanes were judged on nothing of them`,
    );
  }
}

/** P5 and P5b (§7.6): fork to `ready`, the main thread's block at each fork, the child's size. */
function respawned(facts: WorldFacts, said: (violation: string) => void, gated: boolean): void {
  allAnswered(facts, said, ['answering']);
  const respawn = facts.respawn;
  if (respawn === undefined) {
    said('the respawns were not measured');
    return;
  }
  if (gated && !respawn.heldAtEveryKill) {
    said('the pool was not held at its memory gate at every kill');
  }
  if (respawn.forkToReadyMs.length < respawn.kills) {
    said(
      `${String(respawn.forkToReadyMs.length)} children ready after ${String(respawn.kills)} kills`,
    );
  }
  for (const ms of respawn.forkToReadyMs) {
    if (ms > FORK_TO_READY_MS) said(`a child took ${String(Math.round(ms))} ms from fork to ready`);
  }
  for (const ms of respawn.lagAroundForkMs) {
    if (ms > respawn.lagBaselineMs + FORK_LAG_OVER_MS) {
      said(
        `the event loop was held ${String(Math.round(ms))} ms around a fork, past the baseline ${String(Math.round(respawn.lagBaselineMs))} + ${String(FORK_LAG_OVER_MS)}`,
      );
    }
  }
  if (respawn.helperRssAt60s === undefined || respawn.helperRssAt60s > HELPER_RSS_MAX) {
    said(`the helper’s resident set at 60 s was ${String(respawn.helperRssAt60s)}`);
  }
  // Why answering checks failed, where D27 did it: a name in flight at an earlier kill is avoided
  // until ten minutes after the helper is next up (`P-453`), and refused while the route is `down`,
  // which a respawn later than `HELPER_REJOIN_MS` after its loss opens. The route read `down` with
  // nothing refused is not judged: the gate is then only as it would be at any slow start.
  if (respawn.avoidedRefused > 0) {
    said(
      `${String(respawn.avoidedRefused)} answering checks refused as names in flight at an earlier kill, the route down ${respawn.routeDownMs.map((ms) => `${String(Math.round(ms))} ms`).join(', ')} after each kill`,
    );
  }
}

const stretch = (w: Pick<PeakWindow, 'fromMs' | 'toMs'>): string =>
  `${(w.fromMs / 1_000).toFixed(1)}–${(w.toMs / 1_000).toFixed(1)} s`;

/**
 * The windows as runs: each run of windows that meet, with the transient or without, as one
 * stretch with its most. P2 reads one every 50 ms or so until its `hung` loss, so a run is what
 * the transient's length is judged by, and what is printed.
 */
export function stretches(windows: readonly PeakWindow[]): PeakWindow[] {
  const merged: PeakWindow[] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last !== undefined && last.toMs === w.fromMs && last.transient === w.transient) {
      merged[merged.length - 1] = { ...last, toMs: w.toMs, peak: Math.max(last.peak, w.peak) };
    } else merged.push(w);
  }
  return merged;
}

/**
 * Where the losses allow the transient: each from the loss (a seen one's from `LOSS_SEEN_EARLY_MS`
 * before) to `LOSS_WINDOW_MS` and a late timer's second after it, those that meet merged, so that
 * a loss inside another's window carries the transient on to its own end.
 */
function lossStretches(losses: readonly LossAt[]): { fromMs: number; toMs: number }[] {
  const each = losses
    .map(({ atMs, seen }) => ({
      fromMs: atMs - (seen ? LOSS_SEEN_EARLY_MS : 0),
      toMs: atMs + LOSS_WINDOW_MS + LOSS_WINDOW_LATE_MS,
    }))
    .sort((a, b) => a.fromMs - b.fromMs);
  const merged: { fromMs: number; toMs: number }[] = [];
  for (const one of each) {
    const last = merged.at(-1);
    if (last !== undefined && one.fromMs <= last.toMs) {
      merged[merged.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, one.toMs) };
    } else merged.push(one);
  }
  return merged;
}

/**
 * The forwarder's bound for the probe (D16): the whole run's peak, or in the arms with a helper
 * loss each window's, the windows opened at a loss with the transient and every other without,
 * and each run of windows with the transient inside the stretch the losses allow it.
 */
function peaksHeld(facts: WorldFacts, said: (violation: string) => void): void {
  const strict = heldBound({ ...facts, transient: 0 });
  const windows = facts.peakWindows;
  if (windows === undefined) {
    if (facts.transient > 0) said('the forwarder’s peak was not read across each loss');
    else if (facts.peakHeld > strict) {
      said(
        `the forwarder held ${String(facts.peakHeld)} slots for the probe, past ${String(strict)}`,
      );
    }
    return;
  }
  if (windows.length === 0) said('no window of the forwarder’s peak was read');
  if (facts.peakReadFailed !== undefined) {
    said(
      `a read of the forwarder’s peak failed, so its stretch was judged against nothing: ${facts.peakReadFailed}`,
    );
  }
  let from = 0;
  for (const w of windows) {
    if (w.fromMs !== from)
      said(`the forwarder’s peak was not read from ${String(from)} to ${String(w.fromMs)} ms`);
    from = w.toMs;
    const bound = strict + (w.transient ? facts.transient : 0);
    if (w.peak > bound) {
      said(
        `the forwarder held ${String(w.peak)} slots for the probe at ${stretch(w)}, past ${String(bound)} ${w.transient ? 'with the transient after a loss' : 'outside a loss'}`,
      );
    }
  }
  // The transient's length and place, by run: a window at a time, P2's 50 ms windows would let it
  // run on through every look.
  const losses = facts.lossesAt;
  if (losses === undefined) {
    said('the losses’ times were not measured, so the transient was placed by nothing');
  } else {
    const allowed = lossStretches(losses);
    const at = `losses at ${losses.map(({ atMs }) => `${(atMs / 1_000).toFixed(1)} s`).join(', ') || 'none'}`;
    for (const run of stretches(windows).filter(({ transient }) => transient)) {
      const opened = allowed.find(({ fromMs, toMs }) => fromMs <= run.fromMs && run.fromMs <= toMs);
      if (opened === undefined) {
        said(`the transient was allowed at ${stretch(run)} with no loss to open it (${at})`);
      } else if (run.toMs > opened.toMs) {
        said(
          `the transient was allowed at ${stretch(run)}, past the ${String(LOSS_WINDOW_MS)} ms after a loss it lasts (${at})`,
        );
      }
    }
  }
  // The last stretch, to the arm's end: a last read that failed pushes no window and leaves no gap.
  const end = facts.peakWindowsEndMs;
  if (end === undefined) said('the arm’s end was not measured for the forwarder’s peak');
  else if (from !== end) {
    said(
      `the forwarder’s peak was not read from ${String(from)} ms to the arm’s end at ${String(end)} ms`,
    );
  }
}

/** Each arm's own assertions, from the design's table; `system` and gate as each says. */
const ARM_RULES: Readonly<Record<string, Rule>> = {
  slow(facts, said) {
    allAnswered(facts, said, ['answering']);
    if (facts.refused > 0) said(`${String(facts.refused)} checks refused`);
  },
  warmzone(facts, said) {
    allAnswered(facts, said, ['answering']);
    if (facts.mode === 'system') return;
    const after = facts.afterSilence;
    if (after === undefined) {
      said('the silence was not measured');
      return;
    }
    if (after.other > 0) {
      said(
        `${String(after.other)} of the silent zone’s lookups on the probe’s lanes after the silence were not sampled refreshes`,
      );
    }
    if (after.sampled > SAMPLED_PER_KEY) {
      said(
        `${String(after.sampled)} of the silent zone’s refreshes sampled onto the probe’s lanes after the silence, past ${String(SAMPLED_PER_KEY)}`,
      );
    }
    for (const name of facts.gapsOver ?? []) said(`an answering name went too long: ${name}`);
    steadyWalks(facts, said);
  },
  zone(facts, said) {
    if (facts.mode === 'system') return;
    // The design's "answering 31,500 of 31,500": every answering check ran and answered.
    allAnswered(facts, said, ['answering']);
    if (facts.refused > 0) said(`${String(facts.refused)} checks refused`);
    silentOffProbeLanes(facts, said);
    silentHelperCapped(facts, said);
    for (const name of facts.keptLate ?? []) said(`an answering name kept late: ${name}`);
  },
  partial(facts, said) {
    if (facts.mode === 'system') return;
    allAnswered(facts, said, ['answering']);
    // A cached check is given up only as `cachedAllowance` allows, and fails no other way.
    if (count(facts.failedOtherwise, 'cached') > 0) {
      said(`${String(count(facts.failedOtherwise, 'cached'))} cached checks failed otherwise`);
    }
    for (const refused of cachedAllowance(facts).refused) said(refused);
    silentOffProbeLanes(facts, said);
    silentHelperCapped(facts, said);
  },
  steady(facts, said) {
    allAnswered(facts, said, ['answering']);
    if (facts.mode === 'gate') steadyWalks(facts, said);
  },
  P1(facts, said) {
    allAnswered(facts, said, ['answering']);
    silentOffProbeLanes(facts, said);
    lossesWere(facts, said, { exit: 2 });
    untroubled(facts, said);
  },
  P2(facts, said) {
    // Not P1's every-check-answered: the stopped child leaves some nowhere to be (`P-472`).
    hangAllowed(facts, said);
    silentOffProbeLanes(facts, said);
    lossesWere(facts, said, { hung: 1 });
    untroubled(facts, said);
    const stopped = facts.stopped;
    if (stopped === undefined) {
      said('the SIGSTOP was not measured');
      return;
    }
    const by = (what: string, after: number | undefined, bound: number): void => {
      if (after === undefined || after > bound) {
        said(
          `${what} ${after === undefined ? 'never' : `${String(Math.round(after))} ms`} after the SIGSTOP, past ${String(bound)} ms`,
        );
      }
    };
    by('the route left up', stopped.downAfterMs, DOWN_BY_MS);
    by('the hung loss came', stopped.hungAfterMs, HUNG_BY_MS);
    by('the next child was up', stopped.upAfterMs, UP_BY_MS);
  },
  P3(facts, said) {
    lossesWere(facts, said, {});
    if ((facts.helper?.unresponsiveMs ?? 0) > 0) {
      said(`the helper was judged not answering for ${String(facts.helper?.unresponsiveMs)} ms`);
    }
    const stall = facts.stall;
    if (stall === undefined) {
      said('the stall was not begun: no probe-lane lookup of an answering name sent its question');
      return;
    }
    // The case D25 must survive, set up: the reply sent, unread as the stall began, read after it.
    if (!stall.replySent) {
      said(
        'no reply to the stall’s own question was sent before it ended: the case D25 must survive was not set up',
      );
    }
    if (!stall.unsettledAtStart) {
      said(
        'the stall’s own lookup had settled before the stall began: its reply was read, not left waiting',
      );
    }
    if (stall.answeredAfterMs === undefined) {
      said('the stall’s own lookup was never answered: its reply was not the one waiting');
    } else if (stall.answeredAfterMs < 0) {
      said(
        `the stall’s own lookup was answered ${String(Math.round(-stall.answeredAfterMs))} ms before the stall ended`,
      );
    }
    if (stall.unsafeMarks > 0)
      said(`${String(stall.unsafeMarks)} zones marked unsafe by the stall`);
    if (stall.passedStuck > 0) {
      said(`${String(stall.passedStuck)} answering lookups said passed-stuck by the stall`);
    }
  },
  forwarder(facts, said) {
    // `system`'s bound is P-426's lanes, and its drops are judged with every arm's.
    if (facts.mode === 'gate') allAnswered(facts, said, ['answering']);
  },
  P5(facts, said) {
    respawned(facts, said, false);
  },
  P5b(facts, said) {
    respawned(facts, said, true);
  },
  P6(facts, said) {
    allAnswered(facts, said, ['answering']);
    lossesWere(facts, said, { exit: 3 });
    if ((facts.helper?.poisoned ?? 0) !== 1) {
      said(`${String(facts.helper?.poisoned)} names poisoned, where one crashes the helper`);
    }
    if ((facts.probeCrashes ?? 0) > 0) {
      said(`the crash name was asked on the probe’s own lanes ${String(facts.probeCrashes)} times`);
    }
    // While its zone is silent no walk sends it to the probe's lanes: the bound above holds only
    // once one would (`P-471`).
    if ((facts.crashAskedOnceAnswering ?? 0) === 0) {
      said(
        'the crash name was not checked once its zone answered, so nothing but its zone’s silence kept it off the probe’s lanes',
      );
    }
  },
  addresses(facts, said) {
    // `walkrate`'s baseline (round 2's row): every device given as an address, so nothing resolved.
    allAnswered(facts, said, ['answering']);
    // The check on, as in `walkrate`: its canary and its timers are the harness the p99 is net of.
    if (!facts.checkOn) {
      said('addresses is walkrate’s baseline with the name check on, and the check was off');
    }
    if (facts.inFlightMax === undefined) said('lookupsInFlight was not measured');
    else if (facts.inFlightMax > 0) {
      said(
        `a device given as an address was resolved: lookupsInFlight read ${String(facts.inFlightMax)}`,
      );
    }
    // The canary, `localhost.`, proves the check whatever it is asked: it is no walk of a name.
    if (facts.namesWalked === undefined) said('the walk’s questions for names were not measured');
    else if (facts.namesWalked > 0) {
      said(
        `the check walked ${String(facts.namesWalked)} questions for names, devices given as addresses`,
      );
    }
    const asked = [facts.probeLanes, facts.helperPeak].reduce(
      (sum, of) => sum + Object.values(of).reduce((n, v) => n + v, 0),
      0,
    );
    if (asked > 0)
      said(`getaddrinfo was asked ${String(asked)} times for devices given as addresses`);
    if (facts.eventLoopP99Ms === undefined) {
      said('the event loop was not measured, so walkrate has no baseline');
    }
  },
  walkrate(facts, said) {
    const base = facts.baseline;
    const p99 = facts.eventLoopP99Ms;
    if (
      base?.arm !== 'addresses' ||
      base.mode !== facts.mode ||
      base.eventLoopP99Ms === undefined
    ) {
      said(
        `the addresses arm was not measured in ${facts.mode} mode, so the event loop was held to nothing`,
      );
    } else if (p99 === undefined) said('the event loop was not measured');
    else if (p99 > base.eventLoopP99Ms + WALKRATE_P99_OVER_MS) {
      said(
        `the event loop’s p99 was ${p99.toFixed(1)} ms, past the addresses arm’s ${base.eventLoopP99Ms.toFixed(1)} ms + ${String(WALKRATE_P99_OVER_MS)} ms`,
      );
    }
    const channels = facts.channelsBusiestSecond;
    if (channels === undefined) said('the walk’s channels were not measured');
    else if (channels > CHANNELS_A_SECOND) {
      said(
        `the walk opened ${String(channels)} channels in one second, past ${String(CHANNELS_A_SECOND)}`,
      );
    }
    // What the arm is for: with the check off, or nothing walked, both p99s lack the walk.
    if (!facts.checkOn) said('walkrate measures the walk, and the name check was off');
    if (facts.namesWalked === undefined) said('the walk’s questions for names were not measured');
    else if (facts.namesWalked === 0) {
      said('walkrate walked no name, so its event loop was held to the baseline without the walk');
    }
  },
  spread10(facts, said) {
    // `system`'s run is the gate's bound, and holds only every arm's.
    if (facts.mode === 'system') return;
    if (facts.checkOn) said('spread10 runs the gate with its name check off, and the check was on');
    const base = facts.baseline;
    if (base?.arm !== 'spread10' || base.mode !== 'system') {
      said(
        'spread10 was not measured in system mode, so the gate’s answering checks were held to nothing',
      );
    } else {
      const held = spread10Bound(facts, base);
      const noise = `${String(SPREAD10_NOISE * 100)}%`;
      if (held === undefined) said('the answering checks run and not run were not counted');
      else if (held.mustAnswer < SPREAD10_TELLS * held.systemAnswered) {
        // Before the bound itself: a bound that cannot fail would pass it whatever the gate did.
        said(
          `spread10 could not tell the gate from system: system answered ${String(held.systemAnswered)} of ${String(held.systemChecks)} answering checks, and with ${String(held.noise)} of noise (${noise} of ${String(held.checks)}) the gate passes answering ${String(Math.max(0, held.mustAnswer))}, under ${String(SPREAD10_TELLS * 100)}% of that`,
        );
      } else if (held.notAnswered > held.bound) {
        said(
          `${String(held.notAnswered)} answering checks not answered in the gate (${String(held.notRun)} of them not run), past system’s ${String(held.systemChecks - held.systemAnswered)} and ${String(held.noise)} (${noise} of ${String(held.checks)})`,
        );
      }
    }
    const risk = facts.risk;
    if (risk === undefined) said('the helper’s lanes at risk were not measured');
    else if (risk.admitted > RISK_ADMITTED_MAX) {
      said(
        `${String(risk.admitted)} of the helper’s lanes at risk at one pick that the gate admitted, past T + F = ${String(RISK_ADMITTED_MAX)} (at risk at most ${String(risk.atRisk)}, overshoot ${String(risk.overshoot)})`,
      );
    }
  },
};

/** Every assertion the arm fails, in words: none for a run that holds. */
export function judgeWorld(facts: WorldFacts): string[] {
  const violations: string[] = [];
  const said = (violation: string): void => {
    violations.push(violation);
  };
  peaksHeld(facts, said);
  if (facts.dropped > 0) said(`the forwarder dropped ${String(facts.dropped)} questions`);
  for (const [server, sends] of facts.walkSends) {
    if (facts.mode === 'system' && sends.length > 0) {
      said(`system mode walked: ${String(sends.length)} questions to ${server}`);
    }
    const over = overBucket(sends);
    if (facts.mode === 'gate' && over > 0) {
      said(
        `${String(over)} walk questions to ${server} past ${String(WALK_RATE)} a second with a burst of ${String(WALK_BURST)}`,
      );
    }
  }
  const rule = ARM_RULES[facts.arm];
  if (rule === undefined) said(`no rules for the arm ${facts.arm}`);
  else rule(facts, said);
  return violations;
}

/** The arms the judge knows. */
export const JUDGED_ARMS: readonly string[] = Object.keys(ARM_RULES);

/** An answering name's bound between answers (§7.6): its kept answer, its own checks, a second. */
export function gapBound(longestCheckGapMs: number): number {
  return ANSWER_MS + longestCheckGapMs + 1_000;
}
