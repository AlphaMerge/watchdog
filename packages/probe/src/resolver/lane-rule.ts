/**
 * The lane rule (`P-432`, D24): whether one more lookup of a key may start, from what the key holds
 * (`KeyLoad`) and what it may hold (`KeyRule`). One rule for both lane sets: the probe's, where a
 * key is a domain and the rule is `P-438`'s first-lane cap, and the lookup helper's (`P-432` S3).
 *
 * **Uncapped**, a key may start one more while it runs fewer than `lanes`, and fewer than `unacked`
 * of those are lookups no answer vouches for. **Capped**, with a lookup stuck now or lately, it may
 * start one more while it runs fewer than `cappedLanes`, and never the last shared lane
 * (`sharedLanes`), counting as taken what `sharedTaken` counts.
 *
 * **Wider than `P-432`'s design.** Its `KeyLoad` and `KeyRule` had no shared lanes: `P-438`'s rule
 * as built keeps the last shared lane from a capped domain's first lookup (its review's L2), which
 * no count of the key's own lookups can say, so the load carries `sharedTaken` and the rule
 * `sharedLanes`. A key with no shared-lane rule, as the helper's, has `sharedLanes` infinite.
 */

/** What a key holds when one more of its lookups asks to start. */
export interface KeyLoad {
  /** Its lookups running in the class asking: for `P-438`, the domain's first lookups. */
  readonly running: number;
  /**
   * Of those, the ones no answer vouches for. `P-438` counts every one while its domain is not
   * known to answer (`firstLoad`), and none while it is. A rule's `unacked` that is not finite is
   * no limit, whatever this says.
   */
  readonly unacked: number;
  /** Whether it has a lookup stuck, in flight or lately: it is held to `cappedLanes`. */
  readonly capped: boolean;
  /**
   * The shared lanes counted as taken, when a capped key asks for one (`P-438`'s L2): every first
   * lookup running, and as many as the refreshes running and queued may hold.
   */
  readonly sharedTaken: number;
}

/** What a key may hold. A limit that is not finite is no limit, whatever the load says. */
export interface KeyRule {
  /** The most it may run while uncapped. */
  readonly lanes: number;
  /** The most it may run while capped. */
  readonly cappedLanes: number;
  /** The most lookups no answer vouches for it may run while uncapped. */
  readonly unacked: number;
  /** The lanes first lookups and refreshes share: a capped key never takes the last of them. */
  readonly sharedLanes: number;
}

/**
 * Why a key may not start one more: the limit of its own it is at (`lanes`, `cappedLanes` or
 * `unacked`), and the lookup waits for one of its own to end; or the last shared lane.
 */
export type HeldBy = 'lanes' | 'cappedLanes' | 'unacked' | 'shared';

/** Whether a count is at or past its limit, as `P-438` compares them: one not finite is no limit. */
function atOrPast(count: number, limit: number): boolean {
  return Number.isFinite(limit) && count >= limit;
}

/**
 * Why a key may not start one more lookup, or undefined when it may. `P-438`'s order: a capped key
 * at `cappedLanes` waits for its own lookups before the last shared lane is asked about; an
 * uncapped one is held by `lanes` before `unacked`.
 */
export function heldBy(load: KeyLoad, rule: KeyRule): HeldBy | undefined {
  if (load.capped) {
    if (atOrPast(load.running, rule.cappedLanes)) return 'cappedLanes';
    return atOrPast(load.sharedTaken + 1, rule.sharedLanes) ? 'shared' : undefined;
  }
  if (atOrPast(load.running, rule.lanes)) return 'lanes';
  return atOrPast(load.unacked, rule.unacked) ? 'unacked' : undefined;
}

/** Whether a key may start one more lookup: `heldBy` holds it by nothing. */
export function mayStart(load: KeyLoad, rule: KeyRule): boolean {
  return heldBy(load, rule) === undefined;
}

/**
 * The probe's first-lane rule in `system` mode: `P-438`'s as built, over `P-426`'s lane set: the
 * first lanes (`firstCap`) and the lanes first lookups and refreshes share (`sharedCap`, all but
 * the retry's), each taken from the lane set rather than worked out from the other. A domain known
 * to answer with nothing stuck is held by nothing but the class's own cap (`#canRun`), so `lanes`
 * is infinite: a finite one would name the domain where `P-438` names the class, once the domain
 * holds every first lane. One not known to answer, or capped, holds one fewer than all first lanes
 * and never none, and a capped one never the last shared lane. Not the design's `{lanes: 4,
 * cappedLanes: 3, unacked: ∞}`, written before `P-438` took `unacked: 3` (OPEN-1): a domain not
 * known to answer is held to 3 with nothing stuck, so `unacked` is 3 too, and `firstLoad` counts
 * its first lookups.
 */
export function probeFirstRule(firstCap: number, sharedCap: number): KeyRule {
  const held = Math.max(1, firstCap - 1);
  return {
    lanes: Number.POSITIVE_INFINITY,
    cappedLanes: held,
    unacked: held,
    sharedLanes: sharedCap,
  };
}

/**
 * The probe's first-lane rule in gate mode (D24): `P-438`'s, as one lane rule (decided 2026-10-19).
 * `P-438` took `unacked: 3` itself (`P-432`'s OPEN-1), one fewer than the first lanes, 3 at
 * `P-426`'s 6, and the gate adds no second, count-based `unacked` of its own (the design's "first
 * lookups started since the domain's latest answer"): one source of truth for when a domain may
 * take the first lanes, where two would drift. What differs in gate mode is the load alone:
 * `capped` also counts the domain's helper lookups the child reported stuck
 * (`FirstAsk.helperStuck`).
 */
export function gateFirstRule(firstCap: number, sharedCap: number): KeyRule {
  return probeFirstRule(firstCap, sharedCap);
}

/**
 * A domain's history as `P-438` keeps it beside its counts: `#events` at its last answer from DNS
 * (`answeredSeq`), and at the last from a lookup that had run past `STUCK_MS` first (`slowSeq`);
 * when, and at which event, one of its lookups last ended stuck without an answer.
 */
export interface DomainHistory {
  readonly answeredSeq: number;
  readonly slowSeq: number;
  readonly stuckAt: number | undefined;
  readonly stuckSeq: number;
}

/** A lookup running, as the first-lane rule reads it. */
export interface RunningLookup {
  readonly entry: { readonly domain: string };
  /** Whether it has run past `STUCK_MS`. */
  readonly stuck: boolean;
  /** `#events` when it started to run. */
  readonly startedSeq: number;
}

/** What `firstLoad` reads when a first lookup of `domain` asks for a lane. */
export interface FirstAsk<H extends DomainHistory> {
  readonly domain: string;
  /** Its domain's history: undefined when no name of it is kept. */
  readonly history: H | undefined;
  readonly now: number;
  readonly stuckMs: number;
  /** Every lookup running, of every domain, by class. */
  readonly running: Readonly<Record<'first' | 'refresh' | 'retry', ReadonlySet<RunningLookup>>>;
  /** Refreshes queued, and the most lanes refreshes may hold. */
  readonly refreshQueued: number;
  readonly refreshCap: number;
  /** The domain's helper lookups the child reported stuck: none in `system` mode. */
  readonly helperStuck: number;
  /**
   * Whether the domain is known to answer (`P-438`'s `#answering`), asked only of a domain kept and
   * with nothing stuck, as `P-438` asks it.
   */
  readonly answering: (history: H, now: number) => boolean;
}

/**
 * Whether a lookup in flight says its domain is silent: it has run past `STUCK_MS`, and no lookup
 * of its domain that ran as long has answered since it started (`P-438`'s narrow check). A
 * resolver that answers every lookup in 5 s, as glibc does behind a first nameserver that is
 * down, has every lookup past `STUCK_MS`: counted as silent, its one domain's refreshes kept the
 * last shared lane from its own first lookups, and most of its names never resolved. An answer
 * that came quickly is no such evidence: a zone answering some names from a cache while others
 * hang is still held for those (`P-432`'s attack round).
 */
export function silentSoFar(running: RunningLookup, history: DomainHistory | undefined): boolean {
  return running.stuck && (history === undefined || history.slowSeq <= running.startedSeq);
}

/**
 * Whether a domain had a lookup stuck lately (`P-438`'s review, L4): one ended stuck without an
 * answer within `STUCK_MS`, or since the last of its names answered from DNS; those in flight are
 * counted apart. A domain's hanging lookups start together and end together, and those started as
 * they end are not stuck for another `STUCK_MS`: without this, it took every lane again in between.
 */
export function stuckLately(history: DomainHistory, now: number, stuckMs: number): boolean {
  if (history.stuckSeq > history.answeredSeq) return true;
  return history.stuckAt !== undefined && now - history.stuckAt < stuckMs;
}

/**
 * A domain's load when one of its first lookups asks for a lane (`P-438`). Capped while it has a
 * lookup stuck lately (`stuckLately`), one in flight of any class silent so far (`silentSoFar`), or
 * a helper lookup stuck. Uncapped, its first lookups running are every one unacked unless it is
 * known to answer.
 */
export function firstLoad<H extends DomainHistory>(ask: FirstAsk<H>): KeyLoad {
  const { domain, history, running } = ask;
  let held = 0;
  let stuck = history !== undefined && stuckLately(history, ask.now, ask.stuckMs);
  for (const lookup of running.first) {
    if (lookup.entry.domain !== domain) continue;
    held += 1;
    if (silentSoFar(lookup, history)) stuck = true;
  }
  for (const lookup of running.refresh) {
    if (lookup.entry.domain === domain && silentSoFar(lookup, history)) stuck = true;
  }
  for (const lookup of running.retry) {
    if (lookup.entry.domain === domain && silentSoFar(lookup, history)) stuck = true;
  }
  const capped = stuck || ask.helperStuck > 0;
  const known = !capped && history !== undefined && ask.answering(history, ask.now);
  return {
    running: held,
    unacked: known ? 0 : held,
    capped,
    sharedTaken:
      running.first.size + Math.min(ask.refreshCap, running.refresh.size + ask.refreshQueued),
  };
}
