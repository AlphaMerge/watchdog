import { SAMPLED_PER_KEY } from '../../src/resolver/dns-check.js';
import { FORWARD_HOLD_MS, WALK_BURST, WALK_RATE } from '../../src/resolver/forward-budget.js';
import { ANSWER_MS } from '../../src/resolver/name-resolver.js';

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
 *   8 × q more, and every other one is held to q × 6 + 12, as the design's bound table says. The
 *   windows run on from the forwarder's start to the arm's end with no stretch unread, and a read
 *   that failed fails the arm, since the stretch it ends was judged against nothing;
 * - no question dropped at the forwarder for want of a slot;
 * - the walk's questions to each server within D19's bucket: 20 at once, refilled at 10 a second
 *   (one more for the time between a token taken and its datagram sent). Check now's walk is cut
 *   (S6), so every question the check sends counts. In `system` mode the check sends none.
 *
 * Each arm adds its own (`ARM_RULES`), from the design's table. Where one says a group's checks are
 * not given up, it means every one of them answered: a check that failed in any other way (the
 * gate's own refusals, `RESOLVER_FAULT` at a helper loss, `ENODATA`) fails the arm as one given up
 * does, since `GIVEN_UP`'s words are only the resolver's for a name it did not hear.
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
  };
  /** P6: `getaddrinfo` asked on the probe's own lanes for the crash name: the probe would crash. */
  readonly probeCrashes?: number;
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
/** P5, P5b: fork to `ready`, the main thread's block at a fork past the baseline, the child's RSS. */
const FORK_TO_READY_MS = 1_000;
const FORK_LAG_OVER_MS = 100;
const HELPER_RSS_MAX = 128 * 1024 * 1024;

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

function silentOffProbeLanes(facts: WorldFacts, said: (violation: string) => void): void {
  if (count(facts.probeLanes, 'silent') > 0) {
    said(
      `${String(count(facts.probeLanes, 'silent'))} getaddrinfo for the silent zone on the probe’s lanes`,
    );
  }
}

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
}

const stretch = (w: PeakWindow): string =>
  `${(w.fromMs / 1_000).toFixed(1)}–${(w.toMs / 1_000).toFixed(1)} s`;

/**
 * The forwarder's bound for the probe (D16): the whole run's peak, or in the arms with a helper
 * loss each window's, the windows opened at a loss with the transient and every other without.
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
    if (w.transient && w.toMs - w.fromMs > LOSS_WINDOW_MS + LOSS_WINDOW_LATE_MS) {
      said(
        `the transient was allowed at ${stretch(w)}, past the ${String(LOSS_WINDOW_MS)} ms after a loss it lasts`,
      );
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
    allAnswered(facts, said, ['answering', 'cached']);
    silentOffProbeLanes(facts, said);
    if (facts.checkOn) silentHelperCapped(facts, said);
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
    allAnswered(facts, said, ['answering']);
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
