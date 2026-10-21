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

// --- The lookup helper's lanes (`P-432` §1.8, S3) ---------------------------------------------

/**
 * The most lookups a key the walk does not vouch for runs in the helper at once, quiet or not
 * (`P-478`). Not only a quiet one, as §1.8 had it: one answer from a name its recursor still
 * caches lifts a key's quiet, and for a cold start's first second nothing is stuck, so nothing in
 * the helper's own evidence tells a zone that answers some names from one that answers all.
 */
export const KEY_QUIET = 3;
/** At-risk helper lanes at which a gated start waits (T). */
export const RISK_T = 4;
/** One more at-risk lane a never-seen key's first look may start at (F). */
export const RISK_F = 1;
/**
 * What a key's unit (its lookups of one class) may run in the helper: nothing holds it but its
 * class's cap while it answers, and 3 once capped. `unacked` and `sharedLanes` are no limit, so
 * the load's own counts of them are whatever it says (`heldBy`'s rule for a limit not finite).
 */
export const HELPER_UNIT_RULE: KeyRule = {
  lanes: Number.POSITIVE_INFINITY,
  cappedLanes: 3,
  unacked: Number.POSITIVE_INFINITY,
  sharedLanes: Number.POSITIVE_INFINITY,
};
/** The most keys the helper remembers: the least recently used with nothing running goes first. */
export const HELPER_MAX_KEYS = 20_000;

/**
 * The key a name is judged by in the helper and the walk (D6): `d:<suffix>`, the name less its
 * first label, for a name of more than one label, and `n:<label>` for a single label, so that
 * single labels are each their own key and the search list's domains are judged by the walk.
 * Lower case, a trailing dot dropped; never `''` and never `d:` with nothing after it.
 */
export function candidateKey(name: string): string {
  const lower = name.trim().toLowerCase();
  const bare = lower.length > 1 && lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const dot = bare.indexOf('.');
  if (dot <= 0 || dot === bare.length - 1) return `n:${bare}`;
  return `d:${bare.slice(dot + 1)}`;
}

/** The words a key is named by in a message: its domain, or its single label. */
export function keyWords(key: string): string {
  return key.slice(2);
}

export type HelperClass = 'first' | 'refresh' | 'retry';
/**
 * What a helper lookup's end says of its key (§1.8): an answer (addresses, `ENOTFOUND`, `ENODATA`
 * or too many addresses), a give-up (a failure of a lookup the child said was stuck, or one lost
 * while stuck), or nothing.
 */
export type HelperOutcome = 'answer' | 'giveUp' | 'neutral';

interface Unit {
  running: number;
  /** Its lookups running that the child said are stuck. */
  stuck: number;
  answeredSeq: number;
  gaveUpSeq: number;
}

interface KeyEvidence {
  answeredSeq: number;
  stuckSeq: number;
  running: number;
  readonly units: Record<HelperClass, Unit>;
  /** Its lookups running, for the fail-fast blockers. */
  readonly lookups: Set<object>;
}

interface Started {
  readonly key: string;
  readonly cls: HelperClass;
  readonly evidence: KeyEvidence;
  stuck: boolean;
  /** Let go at a configuration change (`detachAll`): its end says nothing of the key now. */
  detached: boolean;
}

const unit = (): Unit => ({ running: 0, stuck: 0, answeredSeq: 0, gaveUpSeq: 0 });

/**
 * What the helper knows of each key (§1.8), from helper lookups only: whether it has answered,
 * whether one of its lookups has been stuck since, and per class whether its unit is capped. The
 * order of events is a counter, never the clock, which may not tell two events apart.
 *
 * - `new(K)`: no answer and nothing stuck, ever.
 * - `quiet(K)`: new, or stuck since its last answer.
 * - `capped(K, c)`: a lookup of class `c` stuck and running, or one that gave up since that class
 *   last answered.
 */
export class HelperKeys {
  readonly #keys = new Map<string, KeyEvidence>();
  readonly #lookups = new Map<object, Started>();
  readonly #maxKeys: number;
  #seq = 0;

  constructor(options: { readonly maxKeys?: number } = {}) {
    this.#maxKeys = Math.max(1, options.maxKeys ?? HELPER_MAX_KEYS);
  }

  /** A key's evidence, made if new, and moved to the most recently used end. */
  #evidence(key: string): KeyEvidence {
    let found = this.#keys.get(key);
    if (found === undefined) {
      found = {
        answeredSeq: 0,
        stuckSeq: 0,
        running: 0,
        units: { first: unit(), refresh: unit(), retry: unit() },
        lookups: new Set(),
      };
    } else {
      this.#keys.delete(key);
    }
    this.#keys.set(key, found);
    if (this.#keys.size > this.#maxKeys) {
      for (const [old, evidence] of this.#keys) {
        if (evidence.running === 0 && old !== key) {
          this.#keys.delete(old);
          break;
        }
      }
    }
    return found;
  }

  #peek(key: string): KeyEvidence | undefined {
    return this.#keys.get(key);
  }

  isNew(key: string): boolean {
    const k = this.#peek(key);
    return k === undefined || (k.answeredSeq === 0 && k.stuckSeq === 0);
  }

  quiet(key: string): boolean {
    const k = this.#peek(key);
    return k === undefined || this.isNew(key) || k.stuckSeq > k.answeredSeq;
  }

  capped(key: string, cls: HelperClass): boolean {
    const u = this.#peek(key)?.units[cls];
    return u !== undefined && (u.stuck > 0 || u.gaveUpSeq > u.answeredSeq);
  }

  running(key: string): number {
    return this.#peek(key)?.running ?? 0;
  }

  unitRunning(key: string, cls: HelperClass): number {
    return this.#peek(key)?.units[cls].running ?? 0;
  }

  /** The lookups of a key running, or of its unit of one class. */
  runningOf(key: string, cls?: HelperClass): object[] {
    const k = this.#peek(key);
    if (k === undefined) return [];
    return [...k.lookups].filter(
      (lookup) => cls === undefined || this.#lookups.get(lookup)?.cls === cls,
    );
  }

  /** Whether the child said this lookup is stuck, as the key knows it. */
  isStuck(lookup: object): boolean {
    return this.#lookups.get(lookup)?.stuck === true;
  }

  started(lookup: object, key: string, cls: HelperClass): void {
    if (this.#lookups.has(lookup)) return;
    const evidence = this.#evidence(key);
    evidence.running += 1;
    evidence.units[cls].running += 1;
    evidence.lookups.add(lookup);
    this.#lookups.set(lookup, { key, cls, evidence, stuck: false, detached: false });
  }

  /** The child said a lookup has run past `STUCK_MS`. */
  stuck(lookup: object): void {
    const started = this.#lookups.get(lookup);
    if (started === undefined || started.stuck) return;
    started.stuck = true;
    if (started.detached) return;
    this.#seq += 1;
    started.evidence.stuckSeq = this.#seq;
    started.evidence.units[started.cls].stuck += 1;
  }

  ended(lookup: object, outcome: HelperOutcome): void {
    const started = this.#lookups.get(lookup);
    if (started === undefined) return;
    this.#lookups.delete(lookup);
    if (started.detached) return;
    const { evidence, cls } = started;
    const u = evidence.units[cls];
    evidence.running -= 1;
    u.running -= 1;
    evidence.lookups.delete(lookup);
    if (started.stuck) u.stuck -= 1;
    if (outcome === 'neutral') return;
    this.#seq += 1;
    if (outcome === 'answer') {
      evidence.answeredSeq = this.#seq;
      u.answeredSeq = this.#seq;
    } else {
      u.gaveUpSeq = this.#seq;
    }
  }

  /**
   * One lookup detached when the helper went quiet (D26): it no longer counts against its key, and
   * its end says nothing of it. It still holds its token until it ends.
   */
  detach(lookup: object): void {
    const started = this.#lookups.get(lookup);
    if (started === undefined || started.detached) return;
    const { evidence, cls } = started;
    evidence.running -= 1;
    evidence.units[cls].running -= 1;
    if (started.stuck) evidence.units[cls].stuck -= 1;
    evidence.lookups.delete(lookup);
    started.detached = true;
  }

  /**
   * A configuration change (§1.12): what every key said is let go, and the lookups running no
   * longer count against their keys. They still hold their lanes and tokens until they end.
   */
  detachAll(): void {
    for (const started of this.#lookups.values()) started.detached = true;
    this.#keys.clear();
  }

  /** Lookups started and not ended, detached ones included: a recount for tests. */
  size(): { readonly keys: number; readonly lookups: number } {
    return { keys: this.#keys.size, lookups: this.#lookups.size };
  }
}

/** What the helper's admission reads of one queued lookup and the helper's lanes (§1.8). */
export interface HelperAdmitAsk {
  /** "Check now". */
  readonly urgent: boolean;
  /** Heard on the probe's lanes and over its class's cap there (S6): never in S3. */
  readonly overflow: boolean;
  /** Its key or its domain has a lookup past `STUCK_MS` on either lane set. */
  readonly stuckAnywhere: boolean;
  readonly keyNew: boolean;
  readonly keyQuiet: boolean;
  readonly keyRunning: number;
  /**
   * The walk vouches for the key (D23, `P-478`): its phase heard and fresh at the check, which is
   * on, and none of its lookups on either lane set past `STUCK_MS`. Never with the check off.
   */
  readonly vouched: boolean;
  /**
   * Its name answers (`P-478`'s fix round 1): its own last lookup answered, with addresses or a
   * denial, and none of its lookups is stuck or failing now.
   */
  readonly nameAnswering: boolean;
  /** Its key has a lookup queued in the helper for a name that answers, as `nameAnswering` says. */
  readonly keyAnsweringQueued: boolean;
  /**
   * Its key's lookups running in the helper for names that do not answer now (`nameAnswering`):
   * past `STUCK_MS`, of a name failing, or of one that has never answered.
   */
  readonly keyFailingRunning: number;
  /**
   * For a first lookup, its key's first lookups running in the helper, as its unit counts them
   * (`P-481`, `P-483`): a lookup let go at a configuration change or as the child went quiet counts
   * against no key. 0 for a refresh or a retry, which take no first lane.
   */
  readonly keyFirstRunning: number;
  /** The helper's first lanes (`P-426`'s `firstCap`). */
  readonly firstCap: number;
  readonly unitRunning: number;
  readonly unitCapped: boolean;
  /** The helper's lanes at risk now. */
  readonly atRisk: number;
  /** Its class may run another in the helper (`#canRun`). */
  readonly classOk: boolean;
  /**
   * One more of its class leaves the helper's last free first lane and its last free shared lane
   * (`helperSpare`): what a lookup the gate holds may take while they are kept (`keepLast`).
   */
  readonly classSpare: boolean;
  /**
   * The check is on, so the helper's last first lane and last shared lane are kept for lookups the
   * gate does not hold (`P-478`): with it off, nothing can tell zones apart, and a never-seen key's
   * first look takes the last lane, as `system` does (§3, risk 11).
   */
  readonly keepLast: boolean;
  readonly urgentAvailable: number;
  readonly sharedAvailable: number;
  readonly keptAvailable: number;
}

export type HelperToken = 'urgent' | 'shared' | 'kept';

/**
 * The key rule (§1.8's `keyOk`, `P-478`): a key the walk does not vouch for runs at most
 * `KEY_QUIET`, quiet or not, and keeps the last of them for its names that answer
 * (`helperAnsweringOk`); a vouched one is held by its unit.
 */
export function helperKeyOk(a: HelperAdmitAsk): boolean {
  if (a.overflow) return !a.stuckAnywhere;
  if (!a.vouched) return a.keyRunning < KEY_QUIET && helperAnsweringOk(a);
  return mayStart(
    { running: a.unitRunning, unacked: 0, capped: a.unitCapped, sharedTaken: 0 },
    HELPER_UNIT_RULE,
  );
}

/**
 * Whether a lookup of a key held to `KEY_QUIET` may take a lane its names that answer would want
 * (`P-478`'s fix round 1): while one of them is queued, its key's names that are failing or have
 * never answered hold at most `KEY_QUIET - 1` of its lanes, and the last goes to the name that
 * answers. One lane serves all of a key's answering refreshes, since each answers at once; with
 * none queued, or for a name that answers, the cap alone holds it. A name whose zone has just gone
 * silent still answers by this until its own lookup is stuck or fails, so at an outage's onset the
 * cap of 3 is what holds the zone, as before.
 */
export function helperAnsweringOk(
  a: Pick<HelperAdmitAsk, 'nameAnswering' | 'keyAnsweringQueued' | 'keyFailingRunning'>,
): boolean {
  return a.nameAnswering || a.keyFailingRunning < KEY_QUIET - 1 || !a.keyAnsweringQueued;
}

/**
 * Whether a lookup may take the helper's last first lane (`P-481`, `P-483`): never one whose key
 * runs every other, vouched or not, whether or not another key's first lookup is queued. A key's
 * walk evidence says that its names answered the walk, not that each will answer `getaddrinfo`: a
 * zone the walk heard through a name its recursor caches took all 4 first lanes with names that
 * hang, for 30 s, while other zones' names that answer waited. `P-481` refused it the fourth only
 * while another key's first lookup was queued, but a zone vouched in a cold start's first second
 * asks for its first lanes within milliseconds, before another zone's lookup is queued, and with
 * none of its own stuck yet to unvouch it. So no key ever runs every first lane: a zone alone in
 * the helper loses a quarter of them, and every other zone has one from the first scan (while the
 * check is on, a zone the gate does not hold: `helperClassOk`). It binds a vouched key alone, since
 * the key rule holds one the walk does not vouch for to `KEY_QUIET`, fewer than the first lanes.
 * Never a fail-fast condition of its own: the key's first lookups it waits behind are none of them
 * past `STUCK_MS`, since one that is unvouches the key, and the key rule then holds it and names
 * them. Never asked of "Check now", which takes no lane of a class.
 */
export function helperLastFirstOk(
  a: Pick<HelperAdmitAsk, 'keyFirstRunning' | 'firstCap'>,
): boolean {
  return a.keyFirstRunning < a.firstCap - 1;
}

/** Whether a lookup is ungated (§1.8, D23): its key answers, or is vouched, and its unit is not capped. */
export function helperUngated(
  a: Pick<HelperAdmitAsk, 'overflow' | 'vouched' | 'keyQuiet' | 'unitCapped'>,
): boolean {
  return !a.overflow && (a.vouched || !a.keyQuiet) && !a.unitCapped;
}

/** The at-risk gate (§1.8's `riskOk`): T, or T + F for a never-seen key's first look. */
export function helperRiskOk(a: HelperAdmitAsk): boolean {
  if (helperUngated(a)) return true;
  const firstLook = a.keyNew && a.keyRunning === 0 && !a.overflow;
  return a.atRisk < (firstLook ? RISK_T + RISK_F : RISK_T);
}

/** What the helper's first and refresh classes hold, and its caps (`P-426`'s lane set). */
export interface HelperLanes {
  readonly first: number;
  readonly refresh: number;
  readonly firstCap: number;
  readonly refreshCap: number;
  /** The lanes first lookups and refreshes share. */
  readonly sharedCap: number;
}

/**
 * Whether one more of a class leaves the last free first lane and the last free shared lane
 * (`P-478`): what a lookup the gate holds may take while they are kept. The retry lane is its own,
 * and nothing of it is kept: its class's cap alone holds it (`classOk`).
 */
export function helperSpare(lanes: HelperLanes, cls: HelperClass): boolean {
  if (cls === 'retry') return true;
  const shared = lanes.first + lanes.refresh;
  if (shared >= lanes.sharedCap - 1) return false;
  return cls === 'first' ? lanes.first < lanes.firstCap - 1 : lanes.refresh < lanes.refreshCap;
}

/**
 * Whether a lookup's class has a lane for it (§1.8's `classOk`, `P-478`): its class's cap, and,
 * while the last lanes are kept, a lookup the gate holds never takes the last free first lane or
 * the last free shared lane. D22's kept token made a kept lane: without it, whatever passed the
 * key rule could fill the 4 first lanes, since T and T + F are not below them.
 */
export function helperClassOk(
  a: Pick<
    HelperAdmitAsk,
    'classOk' | 'classSpare' | 'keepLast' | 'overflow' | 'vouched' | 'keyQuiet' | 'unitCapped'
  >,
): boolean {
  if (!a.classOk) return false;
  return !a.keepLast || a.classSpare || helperUngated(a);
}

/**
 * The token a queued helper lookup starts on, or undefined while it waits (§1.3's Check now and
 * §1.8's `admit`). "Check now" takes an urgent token when one is free, under no key rule, so it
 * passes a silent zone's stuck lookups; otherwise a shared one, as its key's first look, under the
 * key rule and T. Any other lookup needs the key rule, T and its class's lane (`helperClassOk`),
 * never its key's last first lane (`helperLastFirstOk`), and takes a shared token, or the kept one
 * only while ungated: the kept token is never a gated lookup's.
 */
export function admitHelper(a: HelperAdmitAsk): HelperToken | undefined {
  if (a.urgent && a.urgentAvailable > 0) return 'urgent';
  if (!helperKeyOk(a) || !helperRiskOk(a)) return undefined;
  if (!a.urgent && (!helperClassOk(a) || !helperLastFirstOk(a))) return undefined;
  if (a.sharedAvailable > 0) return 'shared';
  if (!a.urgent && helperUngated(a) && a.keptAvailable > 0) return 'kept';
  return undefined;
}
