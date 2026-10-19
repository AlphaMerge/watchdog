import { Resolver } from 'node:dns';
import { isIPv6 } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { Logger } from '@ms/shared';
import type { DeferReason, ForwardBudget, WalkPool, WalkQuestion } from './forward-budget.js';
import { candidateKey } from './lane-rule.js';
import type { Family } from './name-resolver.js';
import {
  candidatesOf,
  typesFor,
  type QType,
  type ResolvConf,
  type SystemNamePolicy,
} from './system-names.js';
import { afterPolls, LATE_MS } from './verdict-timer.js';

/**
 * The name check (`P-432` slice S6, §1.3–§1.5, §1.10): c-ares asks a name's DNS servers what glibc
 * would ask, and its replies decide one thing only, **where `getaddrinfo` runs**. Never what a name
 * resolves to: a reply is read for its rcode and whether it carries records, then thrown away.
 *
 * - **Heard**: every step of the walk answered within the routing wait (`ROUTE_MS`, or a quarter
 *   of the shortest waiting check's bound): `getaddrinfo` runs on the probe's own lanes.
 * - **Silent**: a step not answered by then: it runs in the lookup helper, keyed by the candidate
 *   that went unanswered, where a zone that does not answer holds at most 3 lanes.
 * - **Unvouched**: anything the check cannot or may not judge: the helper too.
 *
 * **The walk** (§1.4) follows `__res_context_search`: the candidates the name policy gives
 * (`candidatesOf`), each asked of the first server, the next server only after SERVFAIL, REFUSED,
 * NOTIMP or ECONNREFUSED, as `res_send` moves on; NXDOMAIN or NODATA for every type moves to the
 * next candidate, as every server's SERVFAIL does; REFUSED or NOTIMP exhausted, or a FORMERR, ends
 * the search, with the name as it is still asked if it was not; addresses for any type end it; and
 * ECONNREFUSED from every server ends it at once, as glibc returns. One fresh c-ares channel per
 * (candidate, server), one try and no resends; an identical question still open is listened to
 * rather than asked again.
 *
 * **Keys** (§1.5, D18): a step's verdict is its key's, `candidateKey` of its candidate. A key's
 * phase is derived from its verdict times, never stored: `heard`, `silent`, `mixed` (both within
 * `KEY_SETTLE_MS`), or `unknown`. An unknown key sends at most `KEY_SCOUTS` scouts and its other
 * names wait for their verdict; a silent key sends nothing until its walk again is due (5 s
 * doubling to 60 s), and its names go straight to the helper; a mixed key walks each name. A
 * verdict is taken after polls, and one whose timer fired more than `LATE_MS` late is dropped
 * (D31): its scout is released and its waiters route unvouched (`stall`).
 *
 * **Sampling** (D20): a refresh rides its zone's heard walk from the last second, with no walk of
 * its own, when its name is asked as it is first, its own last `getaddrinfo` took at most
 * `ROUTE_MS`, and fewer than `SAMPLED_PER_KEY` of its zone's sampled lookups started since the
 * zone's last answer are out. One stuck records NotHeard for its zone (`sampledStuck`).
 *
 * **The budgets** (§1.6, D19): every question is open in the budget's ledger, in one of three pools,
 * until its first reply or `FORWARD_HOLD_MS`; a step short of room waits in its pool's queue until
 * its deadline, then routes `budget`. Each server's bucket gives at most 10 questions a second;
 * a step it refuses routes `rate`, at once.
 *
 * **Proven, misses and the stand-down** (§1.10). The check walks nothing until a reply has proven
 * the path to the servers under this configuration: any reply to a walk, or to the canary, a
 * `localhost.` A question sent at start, after a watched-file change, and every 60 s while
 * unproven. A **miss** is a step still unanswered at `MISS_MS` (3 s) whose lookup the helper
 * answered in at most `STUCK_MS`: the name skips the check for an hour; three names of one key in
 * ten minutes, the key; three keys in ten minutes stand the check down for an hour, doubling to
 * eight for each stand-down within a day of the last one's end. A stand-down raises nothing. A
 * watched-file change, or a restart, clears it all.
 *
 * **Cut, by the design's cut order** (decided 2026-10-19, `docs/TASKS.md`): overflow (1), the
 * pressure detector (3; `nameCheckState` never reads 5), per-name walks of a key's queued helper
 * lookups when it is heard again (4), and Check now's walk path (5: Check now goes to the helper on
 * an urgent token, as with the check off).
 */

/** How long a walk may take to be heard: a quarter of a check's bound at most (§1.3). */
export const ROUTE_MS = 250;
/** A routing wait shorter than this walks nothing (§1.3 row 6). */
export const WALK_MIN_MS = 50;
/** A step still unanswered this long after it was sent, whose lookup the helper answered: a miss. */
export const MISS_MS = 3_000;
/** A c-ares channel's one try. Past the forwarder's 10 s hold, so a late reply still closes it. */
export const CHANNEL_TIMEOUT_MS = 11_000;
export const KEY_SCOUTS = 2;
export const KEY_SETTLE_MS = 60_000;
export const KEY_FRESH_MS = 60_000;
export const KEY_SAMPLE_MS = 1_000;
export const SAMPLED_PER_KEY = 2;
/** A silent key's walk again: 5 s doubling to 60 s, ±20%. */
export const REWALK_FIRST_MS = 5_000;
export const REWALK_MAX_MS = 60_000;
export const REWALK_JITTER = 0.2;
export const CANARY_EVERY_MS = 60_000;
/** A name, then a key, skips the check this long after its misses. */
export const SKIP_MS = 3_600_000;
export const MISS_WINDOW_MS = 600_000;
export const MISSES_PER_KEY = 3;
export const KEYS_TO_STAND_DOWN = 3;
export const STAND_DOWN_FIRST_MS = 3_600_000;
export const STAND_DOWN_MAX_MS = 8 * 3_600_000;
/** A stand-down within this long of the last one's end doubles. */
export const STAND_DOWN_REPEAT_MS = 24 * 3_600_000;
/** A key whose walked lookup passed stuck on the probe's lanes is walked by nobody this long. */
export const UNSAFE_MS = 300_000;
/** A `local` name that passed stuck is walked, keyed by its own name, this long. */
export const NAME_WALKED_MS = 3_600_000;
export const KEY_IDLE_MS = 390_000;
export const MAX_KEYS = 20_000;
/** The canary's name (§1.10): a question every server answers at once, NXDOMAIN or not. */
export const CANARY_NAME = 'localhost.';
const STUCK_MS = 1_000;
const LOG_EVERY_MS = 60_000;
/** A step's verdict within this of the lookup's deadline is taken at it. */
const SAME_DEADLINE_MS = 2;

/** What one question's reply said, as the walk reads it: an rcode, records or not, or nothing. */
export type DnsReplyKind =
  | 'answer'
  | 'nxdomain'
  | 'nodata'
  | 'servfail'
  | 'refused'
  | 'notimp'
  | 'formerr'
  | 'connrefused'
  /** The channel's own try ran out: no reply. */
  | 'timeout'
  /** A reply c-ares could not read, or a failure that is not the server's: the check cannot vouch. */
  | 'bad';

/** A fresh channel to one server: every question asked on it, then closed. */
export interface DnsChannel {
  /** Never rejects: resolves with what the reply said, `timeout` at the latest. */
  ask(name: string, type: QType): Promise<DnsReplyKind>;
  close(): void;
}

/** What the check asks with: c-ares in production (`caresAsker`), a script in tests. */
export interface DnsAsker {
  channel(server: string): DnsChannel;
}

const CARES_KINDS: Readonly<Record<string, DnsReplyKind>> = {
  ENOTFOUND: 'nxdomain',
  ENODATA: 'nodata',
  ESERVFAIL: 'servfail',
  EREFUSED: 'refused',
  ENOTIMP: 'notimp',
  EFORMERR: 'formerr',
  ECONNREFUSED: 'connrefused',
  ETIMEOUT: 'timeout',
  ECANCELLED: 'timeout',
  EDESTRUCTION: 'timeout',
};

/** What a c-ares error code says, as the walk reads it. */
export function caresKind(code: string | undefined): DnsReplyKind {
  return (code === undefined ? undefined : CARES_KINDS[code]) ?? 'bad';
}

/**
 * Node's c-ares (`dns.Resolver`), one channel per (candidate, server) with one try and no resend
 * (§1.4): a long-lived channel's adaptive timeout dropped slow answers, a fresh one took them (the
 * channel experiment). It asks with no OPT record, as glibc does without `options edns0`. A
 * server is asked on `port`, 53 unless a test says.
 */
export function caresAsker(
  options: { readonly port?: number; readonly timeoutMs?: number } = {},
): DnsAsker {
  const port = options.port ?? 53;
  const timeout = options.timeoutMs ?? CHANNEL_TIMEOUT_MS;
  return {
    channel(server) {
      const resolver = new Resolver({ timeout, tries: 1 });
      resolver.setServers([
        isIPv6(server) ? `[${server}]:${String(port)}` : `${server}:${String(port)}`,
      ]);
      return {
        ask(name, type) {
          return new Promise((resolve) => {
            const done = (
              error: NodeJS.ErrnoException | null,
              records: readonly unknown[],
            ): void => {
              if (error !== null) resolve(caresKind(error.code));
              else resolve(records.length > 0 ? 'answer' : 'nodata');
            };
            try {
              if (type === 'A') resolver.resolve4(name, done);
              else resolver.resolve6(name, done);
            } catch {
              resolve('bad');
            }
          });
        },
        close() {
          resolver.cancel();
        },
      };
    },
  };
}

/** What the resolver tells the check of a lookup it is about to queue (§1.3). */
export interface CheckAsk {
  /** As the resolver keys it: trimmed, lower case, a trailing dot kept. */
  readonly host: string;
  readonly family: Family;
  /** A refresh with no failure behind it, not Check now: it may ride a sample (D20). */
  readonly refresh: boolean;
  /** It has a kept or stale answer, or answered within the grace: a mixed key's heard pool. */
  readonly known: boolean;
  /** How long its own last `getaddrinfo` took to give addresses, if it ever did. */
  readonly lastRanMs: number | undefined;
  /** The bound of the check that asked: undefined for a refresh nobody waits for. */
  readonly boundMs: number | undefined;
  /** Its lookup: sampling counts it until `sampledEnded`. */
  readonly ref: object;
}

/** Why a lookup is asked in the helper without being heard or found silent. */
export type UnvouchedWhy =
  | 'off'
  | 'cannotVouch'
  | 'unproven'
  | 'standDown'
  | 'skip'
  | 'unsafe'
  | 'budget'
  | 'rate'
  | 'stall'
  | 'scoutWait';

/** A silent walk's unanswered question, watched for a miss (§1.10). */
export interface MissWatch {
  readonly host: string;
  readonly key: string;
  /** Set once the helper answered the lookup in at most `STUCK_MS` on the child's clock. */
  helperAnswered: boolean;
}

/** Where a lookup runs, by the check's word (§1.3's tables). */
export type CheckRoute =
  | { readonly route: 'local'; readonly key: string }
  | {
      readonly route: 'heard';
      readonly key: string;
      /** Every candidate key the walk asked: what a passed-stuck lookup marks unsafe (O-OS-10). */
      readonly keys: readonly string[];
    }
  | { readonly route: 'sampled'; readonly key: string }
  | { readonly route: 'silent'; readonly key: string; readonly miss: MissWatch | undefined }
  | { readonly route: 'unvouched'; readonly key: string; readonly why: UnvouchedWhy };

/** The check's state for Probe Health's `nameCheckState` (§5), less the helper's rest (0). */
export type CheckState = 1 | 2 | 3 | 4 | 5;

export interface DnsCheckStats {
  readonly state: CheckState;
  readonly proven: boolean;
  readonly misses: number;
  readonly standDowns: number;
  readonly keys: number;
  readonly silentKeys: number;
  readonly mixedKeys: number;
  readonly sampled: number;
  readonly walked: number;
}

export interface DnsCheckOptions {
  readonly logger: Logger;
  readonly policy: SystemNamePolicy;
  readonly budget: ForwardBudget;
  readonly asker: DnsAsker;
  /** The resolver's clock, for every state the check keeps. */
  readonly now: () => number;
  /** A monotonic real clock, for the walk's deadlines and how late a timer fired. */
  readonly realNow?: () => number;
  readonly random?: () => number;
  /** `ROUTE_MS` unless a test says. */
  readonly routeMs?: number;
  /** `MISS_MS` unless a test says. */
  readonly missMs?: number;
  /** `CANARY_EVERY_MS` unless a test says. */
  readonly canaryEveryMs?: number;
  /** A key went silent or mixed: its sampled lookups still queued move to the helper (D20). */
  readonly onKeySilent?: (key: string) => void;
}

type Phase = 'heard' | 'silent' | 'mixed' | 'unknown';
type Wake = Phase | 'dropped';

interface KeyState {
  lastHeardAt: number | undefined;
  lastNotHeardAt: number | undefined;
  /** The send time of the newest heard step: sampling (D20). */
  lastHeardSentAt: number;
  scoutsOut: number;
  freshUntil: number;
  step: number;
  rewalkAt: number;
  readonly waiting: Set<(wake: Wake) => void>;
  usedAt: number;
  /** The send time of each name's newest heard step: a NotHeard older than it is ignored (D18). */
  readonly heardSentBy: Map<string, number>;
  /** Its sampled lookups out, each with the key's answers when it was routed (D20). */
  readonly sampled: Map<object, number>;
  answers: number;
}

interface Question {
  readonly server: string;
  /** On the real clock: a miss is judged from here. */
  readonly sentAt: number;
  readonly ledger: WalkQuestion;
  reply: DnsReplyKind | undefined;
  readonly replied: Promise<DnsReplyKind>;
}

/** What one server said to one step: a reply per type, or why there is none. */
type ServerSaid =
  | { readonly kind: 'replies'; readonly replies: readonly DnsReplyKind[] }
  | { readonly kind: 'silent' | 'stall' }
  | { readonly kind: 'deferred'; readonly why: 'budget' | 'rate' };

/** How a step ended (§1.4): its key heard, or not, and what the walk does next. */
type StepEnd =
  /** Addresses for a type, or every server refused the connection: glibc returns. */
  | { readonly kind: 'answered' }
  /** NXDOMAIN or NODATA for every type, or every server SERVFAIL: the next candidate. */
  | { readonly kind: 'next' }
  /** REFUSED or NOTIMP exhausted, or a FORMERR: the search ends, the name as it is still asked. */
  | { readonly kind: 'done' }
  /** Not answered by the deadline: the question still out is what a miss watches. */
  | { readonly kind: 'silent'; readonly question: Question | undefined }
  | { readonly kind: 'stall' | 'bad' }
  | { readonly kind: 'deferred'; readonly why: 'budget' | 'rate' };

/** A step waiting for room in its pool (§1.4). */
interface RoomWait {
  /** Takes the room if there is some now: true once it has ended, either way. */
  readonly tryNow: () => boolean;
  readonly cancel: () => void;
}

const withoutDot = (host: string): string =>
  host.length > 1 && host.endsWith('.') ? host.slice(0, -1) : host;

export class DnsCheck {
  readonly #logger: Logger;
  readonly #policy: SystemNamePolicy;
  readonly #budget: ForwardBudget;
  readonly #asker: DnsAsker;
  readonly #now: () => number;
  readonly #realNow: () => number;
  readonly #random: () => number;
  readonly #routeMs: number;
  readonly #missMs: number;
  readonly #canaryEveryMs: number;
  readonly #onKeySilent: (key: string) => void;
  readonly #keys = new Map<string, KeyState>();
  /** Questions still open, by (server, name, type): a second asker listens (§1.4). */
  readonly #open = new Map<string, Question>();
  /** Steps waiting for room in a pool, oldest first. */
  readonly #queued: Record<WalkPool, RoomWait[]> = { heard: [], discovery: [], urgent: [] };
  readonly #nameSkips = new Map<string, number>();
  readonly #keySkips = new Map<string, number>();
  readonly #keyMisses = new Map<string, Map<string, number>>();
  readonly #unsafe = new Map<string, number>();
  readonly #walkMarks = new Map<string, number>();
  #skippedKeys: { readonly key: string; readonly at: number }[] = [];
  #standDownUntil: number | undefined;
  #standDownMs = 0;
  #lastRearm: number | undefined;
  #standDowns = 0;
  #misses = 0;
  #sampledCount = 0;
  #walked = 0;
  #proven = false;
  /** Moved on by a watched-file change: what a walk started under. */
  #generation = 0;
  #canaryTimer: NodeJS.Timeout | undefined;
  #stopped = true;
  readonly #lastLog = new Map<string, number>();

  constructor(options: DnsCheckOptions) {
    this.#logger = options.logger.child({ component: 'dns-check' });
    this.#policy = options.policy;
    this.#budget = options.budget;
    this.#asker = options.asker;
    this.#now = options.now;
    this.#realNow = options.realNow ?? (() => performance.now());
    this.#random = options.random ?? Math.random;
    this.#routeMs = options.routeMs ?? ROUTE_MS;
    this.#missMs = options.missMs ?? MISS_MS;
    this.#canaryEveryMs = options.canaryEveryMs ?? CANARY_EVERY_MS;
    this.#onKeySilent = options.onKeySilent ?? (() => undefined);
  }

  /** Sends the canary, and again every `CANARY_EVERY_MS` while the check is unproven. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#canary();
    this.#canaryTimer = setInterval(() => {
      if (!this.#proven) this.#canary();
    }, this.#canaryEveryMs);
    this.#canaryTimer.unref();
  }

  /**
   * Stops the canary; walks under way end by their deadlines, a quarter of a second at most, as
   * unvouched.
   */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#canaryTimer);
    this.#canaryTimer = undefined;
    this.#reset();
  }

  /**
   * A watched file changed (§1.12): proven again from nothing, key states, skips, unsafe marks,
   * name marks and a stand-down cleared, and walks waiting for room end as `budget`. The budget's
   * ledger is not reset: what was asked is still open at the servers.
   */
  reset(): void {
    this.#reset();
    if (!this.#stopped) this.#canary();
  }

  #reset(): void {
    this.#generation += 1;
    this.#proven = false;
    for (const state of this.#keys.values()) {
      for (const wake of [...state.waiting]) wake('dropped');
    }
    this.#keys.clear();
    for (const pool of ['heard', 'discovery', 'urgent'] as const) {
      for (const wait of this.#queued[pool].splice(0)) wait.cancel();
    }
    this.#nameSkips.clear();
    this.#keySkips.clear();
    this.#keyMisses.clear();
    this.#unsafe.clear();
    this.#walkMarks.clear();
    this.#skippedKeys = [];
    this.#standDownUntil = undefined;
  }

  /** Probe Health's `nameCheckState`, less resting: on, off, unproven, stood down. */
  state(): CheckState {
    if (!this.#policy.checkOn()) return 2;
    if (this.#standingDown(this.#now())) return 4;
    if (!this.#proven) return 3;
    return 1;
  }

  stats(): DnsCheckStats {
    const now = this.#now();
    let silentKeys = 0;
    let mixedKeys = 0;
    for (const state of this.#keys.values()) {
      const phase = this.#phase(state, now);
      if (phase === 'silent') silentKeys += 1;
      else if (phase === 'mixed') mixedKeys += 1;
    }
    return {
      state: this.state(),
      proven: this.#proven,
      misses: this.#misses,
      standDowns: this.#standDowns,
      keys: this.#keys.size,
      silentKeys,
      mixedKeys,
      sampled: this.#sampledCount,
      walked: this.#walked,
    };
  }

  /**
   * Where a lookup runs (§1.3 rows 3 to 8): at once when the check need not walk, or once its walk
   * has a verdict. Never rejects.
   */
  route(ask: CheckAsk): CheckRoute | Promise<CheckRoute> {
    const now = this.#now();
    const own = candidateKey(ask.host);
    const marked = this.#marked(this.#walkMarks, ask.host, now);
    const named = this.#policy.classify(ask.host, ask.family);
    if (named.kind === 'local' && !marked) return { route: 'local', key: own };
    if (named.kind === 'off' || !this.#policy.checkOn()) return this.#unvouched(own, 'off');
    if (named.kind === 'cannotVouch') return this.#unvouched(own, 'cannotVouch');
    if (this.#standingDown(now)) return this.#unvouched(own, 'standDown');
    if (!this.#proven) return this.#unvouched(own, 'unproven');
    let candidates: readonly string[] | undefined;
    let types: readonly QType[];
    if (named.kind === 'walk') {
      candidates = named.candidates;
      types = named.types;
    } else {
      // A `local` name that passed stuck: walked as DNS would be asked for it (D25).
      const conf: ResolvConf | undefined = this.#policy.view().conf;
      candidates = conf === undefined ? undefined : candidatesOf(ask.host, conf);
      types = typesFor(ask.family);
    }
    if (candidates === undefined || candidates.length === 0) {
      return this.#unvouched(own, 'cannotVouch');
    }
    const keyOf = (candidate: string): string =>
      marked ? `n:${withoutDot(ask.host)}` : candidateKey(candidate);
    if (
      this.#marked(this.#nameSkips, ask.host, now) ||
      candidates.some((candidate) => this.#marked(this.#keySkips, keyOf(candidate), now))
    ) {
      return this.#unvouched(own, 'skip');
    }
    if (candidates.some((candidate) => this.#marked(this.#unsafe, keyOf(candidate), now))) {
      return this.#unvouched(own, 'unsafe');
    }
    const waitMs = Math.min(
      this.#routeMs,
      ask.boundMs === undefined ? this.#routeMs : Math.floor(ask.boundMs / 4),
    );
    if (waitMs < WALK_MIN_MS) return this.#unvouched(own, 'budget', true);
    const first = candidates[0];
    if (first !== undefined && !marked && ask.refresh && first === withoutDot(ask.host)) {
      const sampled = this.#sample(keyOf(first), ask, now);
      if (sampled !== undefined) return sampled;
    }
    return this.#walk(ask, candidates, types, keyOf, this.#realNow() + waitMs).catch(
      (error: unknown) => {
        this.#logger.error({ err: error, host: ask.host }, 'the DNS check failed on a walk');
        return this.#unvouched(own, 'cannotVouch');
      },
    );
  }

  /** A probe-lane `getaddrinfo` answered with addresses (§1.5): within `ROUTE_MS`, its key is fresh. */
  answered(key: string, ranMs: number): void {
    const state = this.#keys.get(key);
    const now = this.#now();
    if (state !== undefined) state.answers += 1;
    if (ranMs > this.#routeMs) return;
    const fresh = state ?? this.#key(key, now);
    fresh.freshUntil = now + KEY_FRESH_MS;
  }

  /** A sampled lookup has settled: it no longer counts against its key (D20). */
  sampledEnded(key: string, ref: object): void {
    this.#keys.get(key)?.sampled.delete(ref);
  }

  /**
   * A sampled lookup ran past `STUCK_MS` on the probe's lanes, judged after polls (D20, D25): its
   * zone is not heard, as of when it started.
   */
  sampledStuck(key: string, startedAt: number, host: string): void {
    this.#notHeard(key, startedAt, withoutDot(host));
  }

  /** A walked lookup heard on the probe's lanes ran past `STUCK_MS` (D25): every key it asked. */
  markUnsafe(keys: readonly string[]): void {
    const until = this.#now() + UNSAFE_MS;
    for (const key of keys) this.#unsafe.set(key, until);
    this.#say(
      'unsafe',
      'warn',
      { keys },
      'a name the DNS check heard ran past the bound for stuck on the probe’s lanes: its zone is walked by none for 5 minutes',
    );
  }

  /** A `local` lookup ran past `STUCK_MS` (D25): its name is walked, keyed by itself, for an hour. */
  markWalked(host: string): void {
    this.#walkMarks.set(host, this.#now() + NAME_WALKED_MS);
  }

  /**
   * The OS's own evidence for a key never heard of (§1.5): a helper lookup that was never walked,
   * for a name with one candidate, said stuck by the child, counts as NotHeard.
   */
  helperStuck(host: string, family: Family, walked: boolean): void {
    if (walked) return;
    const named = this.#policy.classify(host, family);
    if (named.kind !== 'walk' || named.candidates.length !== 1) return;
    const [candidate] = named.candidates;
    if (candidate === undefined) return;
    const key = candidateKey(candidate);
    const state = this.#keys.get(key);
    if (state !== undefined && this.#phase(state, this.#now()) !== 'unknown') return;
    this.#notHeard(key, this.#now(), candidate);
  }

  /** The helper answered a lookup whose walk went unanswered: a miss, if the step still is. */
  helperAnswered(watch: MissWatch, ranMs: number): void {
    if (ranMs > STUCK_MS) return;
    watch.helperAnswered = true;
  }

  // --- The walk ---------------------------------------------------------------------------------

  #unvouched(key: string, why: UnvouchedWhy, counted = false): CheckRoute {
    if (counted && (why === 'budget' || why === 'rate' || why === 'stall' || why === 'scoutWait')) {
      this.#budget.deferred(why);
    }
    return { route: 'unvouched', key, why };
  }

  #sample(key: string, ask: CheckAsk, now: number): CheckRoute | undefined {
    const state = this.#keys.get(key);
    if (state === undefined || this.#phase(state, now) !== 'heard') return undefined;
    if (now - state.lastHeardSentAt > KEY_SAMPLE_MS) return undefined;
    if (ask.lastRanMs === undefined || ask.lastRanMs > this.#routeMs) return undefined;
    let out = 0;
    for (const answers of state.sampled.values()) if (answers === state.answers) out += 1;
    if (out >= SAMPLED_PER_KEY) return undefined;
    state.sampled.set(ask.ref, state.answers);
    state.usedAt = now;
    this.#sampledCount += 1;
    return { route: 'sampled', key };
  }

  async #walk(
    ask: CheckAsk,
    candidates: readonly string[],
    types: readonly QType[],
    keyOf: (candidate: string) => string,
    deadline: number,
  ): Promise<CheckRoute> {
    this.#walked += 1;
    const generation = this.#generation;
    const bare = withoutDot(ask.host);
    const asked: string[] = [];
    let triedAsIs = false;
    let at = 0;
    while (at < candidates.length) {
      const candidate = candidates[at] ?? bare;
      const key = keyOf(candidate);
      if (generation !== this.#generation) return this.#unvouched(key, 'budget', true);
      const now = this.#now();
      const state = this.#key(key, now);
      const phase = this.#phase(state, now);
      let pool: WalkPool;
      let kind: 'key' | 'name';
      let scout = false;
      if (phase === 'silent') {
        if (now < state.rewalkAt) return { route: 'silent', key, miss: undefined };
        // Its walk again: the next one is a step further off, whatever this one finds.
        state.step = Math.min(state.step + 1, 4);
        state.rewalkAt = now + this.#backoff(state.step);
        pool = 'discovery';
        kind = 'key';
      } else if (phase === 'mixed') {
        pool = ask.known ? 'heard' : 'discovery';
        kind = 'name';
      } else if (phase === 'unknown') {
        if (state.scoutsOut >= KEY_SCOUTS) {
          const woke = await this.#waitKey(state, deadline);
          if (woke === 'timeout') return this.#unvouched(key, 'scoutWait', true);
          if (woke === 'dropped') return this.#unvouched(key, 'stall', true);
          continue;
        }
        state.scoutsOut += 1;
        scout = true;
        pool = 'discovery';
        kind = 'key';
      } else {
        pool = state.freshUntil > now ? 'heard' : 'discovery';
        kind = 'name';
      }
      if (!asked.includes(key)) asked.push(key);
      if (candidate === bare) triedAsIs = true;
      const end = await this.#step(state, key, candidate, types, pool, kind, deadline, scout);
      switch (end.kind) {
        case 'silent':
          return { route: 'silent', key, miss: this.#watchMiss(ask.host, key, end.question) };
        case 'stall':
          return this.#unvouched(key, 'stall', true);
        case 'bad':
          return this.#unvouched(key, 'cannotVouch');
        case 'deferred':
          return this.#unvouched(key, end.why, true);
        case 'answered':
          return { route: 'heard', key, keys: asked };
        case 'next':
          at += 1;
          continue;
        case 'done': {
          const asIs = triedAsIs ? -1 : candidates.indexOf(bare, at + 1);
          if (asIs === -1) return { route: 'heard', key, keys: asked };
          at = asIs;
          continue;
        }
      }
    }
    // Every candidate answered that it has no such name: glibc says so at once.
    return { route: 'heard', key: keyOf(candidates[candidates.length - 1] ?? bare), keys: asked };
  }

  /**
   * A silent walk's miss watch (§1.10): judged after polls at `MISS_MS` from the question's send,
   * a miss if the helper has answered the lookup by then and the question still has no reply.
   */
  #watchMiss(host: string, key: string, question: Question | undefined): MissWatch | undefined {
    if (question === undefined) return undefined;
    const watch: MissWatch = { host: withoutDot(host), key, helperAnswered: false };
    const generation = this.#generation;
    const wait = Math.max(0, question.sentAt + this.#missMs - this.#realNow());
    const timer = setTimeout(() => {
      afterPolls(() => {
        if (generation !== this.#generation) return;
        if (watch.helperAnswered && question.reply === undefined) this.#miss(watch.host, key);
      });
    }, wait);
    timer.unref();
    return watch;
  }

  /**
   * One step: a candidate asked of its servers in `res_send`'s order (all at once under `rotate`,
   * each of which must reply), its key's verdict taken at `ROUTE_MS` from its send, and the lookup's
   * at its own deadline, whichever is first.
   */
  async #step(
    state: KeyState,
    key: string,
    candidate: string,
    types: readonly QType[],
    pool: WalkPool,
    kind: 'key' | 'name',
    deadline: number,
    scout: boolean,
  ): Promise<StepEnd> {
    const sentAt = this.#now();
    let verdictAt = this.#realNow() + this.#routeMs;
    // A step sent as the lookup was asked: its key's verdict and the lookup's are one deadline.
    if (verdictAt - deadline < SAME_DEADLINE_MS) verdictAt = deadline;
    const generation = this.#generation;
    const questions: Question[] = [];
    const chain = this.#chain(candidate, types, pool, kind, verdictAt, questions);
    void chain.then((end) => {
      // A scout never outlives its verdict, taken or dropped (D31).
      if (scout) state.scoutsOut = Math.max(0, state.scoutsOut - 1);
      if (generation !== this.#generation) return;
      switch (end.kind) {
        case 'answered':
        case 'next':
        case 'done':
          this.#heard(key, sentAt, candidate);
          return;
        case 'silent':
          this.#notHeard(key, sentAt, candidate);
          return;
        default:
          // Dropped (D31), deferred or unreadable: no verdict, and its waiters route unvouched.
          for (const wake of [...state.waiting]) wake('dropped');
      }
    });
    if (deadline >= verdictAt) return chain;
    // The lookup's own deadline is the nearer: it routes then, and the key's verdict comes later.
    const own = this.#deadline(deadline).then((late): StepEnd =>
      late
        ? { kind: 'stall' }
        : { kind: 'silent', question: questions.find((asked) => asked.reply === undefined) },
    );
    return Promise.race([chain, own]);
  }

  /** The servers of a step, in `res_send`'s order (§1.4). */
  async #chain(
    candidate: string,
    types: readonly QType[],
    pool: WalkPool,
    kind: 'key' | 'name',
    verdictAt: number,
    questions: Question[],
  ): Promise<StepEnd> {
    const conf = this.#policy.view().conf;
    const servers = conf?.servers ?? [];
    if (servers.length === 0) return { kind: 'bad' };
    const said: ServerSaid[] = [];
    if (conf?.options.rotate === true) {
      const all = await Promise.all(
        servers.map((server) =>
          this.#ask(server, candidate, types, pool, kind, verdictAt, questions),
        ),
      );
      for (const one of all) {
        const blocked = this.#blocked(one, questions);
        if (blocked !== undefined) return blocked;
      }
      said.push(...all);
    } else {
      for (const server of servers) {
        const one = await this.#ask(server, candidate, types, pool, kind, verdictAt, questions);
        const blocked = this.#blocked(one, questions);
        if (blocked !== undefined) return blocked;
        said.push(one);
        const replies = one.kind === 'replies' ? one.replies : [];
        if (!replies.every(isFastFailure)) break;
      }
    }
    return endOf(said);
  }

  /** A server's word that ends the step before its replies are read: silence, a stall, a deferral. */
  #blocked(one: ServerSaid, questions: readonly Question[]): StepEnd | undefined {
    if (one.kind === 'silent') {
      return { kind: 'silent', question: questions.find((asked) => asked.reply === undefined) };
    }
    if (one.kind === 'stall') return { kind: 'stall' };
    if (one.kind === 'deferred') return { kind: 'deferred', why: one.why };
    return undefined;
  }

  /**
   * One server asked a candidate's types: in the heard pool both at once, otherwise A first and
   * AAAA after A's reply, so a silent server holds one question of discovery's four (§1.4).
   */
  async #ask(
    server: string,
    candidate: string,
    types: readonly QType[],
    pool: WalkPool,
    kind: 'key' | 'name',
    verdictAt: number,
    questions: Question[],
  ): Promise<ServerSaid> {
    let channel: DnsChannel | undefined;
    const open: Promise<DnsReplyKind>[] = [];
    const channelOf = (): DnsChannel => {
      channel ??= this.#asker.channel(server);
      return channel;
    };
    const closeLater = (): void => {
      const used = channel;
      if (used === undefined) return;
      void Promise.allSettled(open).then(() => {
        used.close();
      });
    };
    try {
      const one = async (type: QType): Promise<DnsReplyKind | ServerSaid> => {
        const question = await this.#question(
          server,
          candidate,
          type,
          pool,
          kind,
          verdictAt,
          channelOf,
          open,
        );
        if ('kind' in question) return question;
        questions.push(question);
        return this.#replyBy(question, verdictAt);
      };
      const replies: DnsReplyKind[] = [];
      const results = pool === 'heard' ? await Promise.all(types.map(one)) : [];
      if (pool !== 'heard') {
        for (const type of types) {
          const result = await one(type);
          results.push(result);
          if (typeof result !== 'string' || result === 'timeout') break;
        }
      }
      for (const result of results) {
        if (typeof result !== 'string') return result;
        if (result === 'timeout') return { kind: 'silent' };
        replies.push(result);
      }
      return { kind: 'replies', replies };
    } finally {
      closeLater();
    }
  }

  /** A question sent, or joined if one identical is open, or why it was not (D19, §1.6). */
  async #question(
    server: string,
    name: string,
    type: QType,
    pool: WalkPool,
    kind: 'key' | 'name',
    verdictAt: number,
    channelOf: () => DnsChannel,
    open: Promise<DnsReplyKind>[],
  ): Promise<Question | ServerSaid> {
    const id = `${server}|${name}|${type}`;
    const joined = this.#open.get(id);
    if (joined !== undefined && joined.reply === undefined && !joined.ledger.closed) return joined;
    if (!this.#budget.admit(pool, 1)) {
      const room = await this.#room(pool, verdictAt);
      if (!room) return { kind: 'deferred', why: 'budget' };
    }
    if (!this.#budget.serverTake(server, 1, kind)) return { kind: 'deferred', why: 'rate' };
    return this.#send(server, name, type, pool, channelOf(), open, id);
  }

  #send(
    server: string,
    name: string,
    type: QType,
    pool: WalkPool,
    channel: DnsChannel,
    open: Promise<DnsReplyKind>[],
    id: string,
  ): Question {
    const ledger = this.#budget.open(pool);
    const asked = channel.ask(name, type);
    open.push(asked);
    const question: Question = {
      server,
      sentAt: this.#realNow(),
      ledger,
      reply: undefined,
      replied: asked.then((reply) => {
        question.reply = reply;
        this.#budget.reply(ledger);
        if (this.#open.get(id) === question) this.#open.delete(id);
        if (reply !== 'timeout') this.#prove();
        this.#pumpRoom();
        return reply;
      }),
    };
    this.#open.set(id, question);
    return question;
  }

  /** A question's reply, or `timeout` at the deadline (after polls), or `stall` if that fired late. */
  async #replyBy(question: Question, deadline: number): Promise<DnsReplyKind | ServerSaid> {
    if (question.reply !== undefined) return question.reply;
    const late = this.#deadline(deadline).then((stalled): ServerSaid => ({
      kind: stalled ? 'stall' : 'silent',
    }));
    const got = await Promise.race([question.replied, late]);
    if (typeof got === 'string') return got;
    // Read after polls: a reply already in the socket counts (D5).
    return replyOf(question) ?? got;
  }

  /** Resolves at a real-time deadline, after polls, with whether its timer fired late. */
  #deadline(at: number): Promise<boolean> {
    return new Promise((resolve) => {
      const armed = this.#realNow();
      const wait = Math.max(0, at - armed);
      const timer = setTimeout(() => {
        const late = this.#realNow() - armed - wait > LATE_MS;
        afterPolls(() => {
          resolve(late);
        });
      }, wait);
      timer.unref();
    });
  }

  /** Waits for room in a pool until a deadline, in the pool's order (§1.4). */
  #room(pool: WalkPool, deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const end = (room: boolean): void => {
        if (done) return;
        done = true;
        const queue = this.#queued[pool];
        const at = queue.indexOf(wait);
        if (at !== -1) queue.splice(at, 1);
        resolve(room);
      };
      const wait: RoomWait = {
        tryNow: () => {
          if (!this.#budget.admit(pool, 1)) return false;
          end(true);
          return true;
        },
        cancel: () => {
          end(false);
        },
      };
      this.#queued[pool].push(wait);
      void this.#deadline(deadline).then(() => {
        end(false);
      });
    });
  }

  /** A question replied: the oldest step waiting in each pool may take its room, one at a time. */
  #pumpRoom(): void {
    for (const pool of ['heard', 'discovery', 'urgent'] as const) {
      this.#queued[pool][0]?.tryNow();
    }
  }

  /** Waits on an unknown key's scouts until a deadline (§1.5): their verdict, or `timeout`. */
  #waitKey(state: KeyState, deadline: number): Promise<Wake | 'timeout'> {
    return new Promise((resolve) => {
      let done = false;
      const wake = (woke: Wake): void => {
        if (done) return;
        done = true;
        state.waiting.delete(wake);
        resolve(woke);
      };
      state.waiting.add(wake);
      void this.#deadline(deadline).then((late) => {
        if (done) return;
        done = true;
        state.waiting.delete(wake);
        // Late, the main thread stalled: the scouts' silence is no evidence either (D31).
        resolve(late ? 'dropped' : 'timeout');
      });
    });
  }

  // --- Keys -------------------------------------------------------------------------------------

  #key(key: string, now: number): KeyState {
    let state = this.#keys.get(key);
    if (state === undefined) {
      state = {
        lastHeardAt: undefined,
        lastNotHeardAt: undefined,
        lastHeardSentAt: Number.NEGATIVE_INFINITY,
        scoutsOut: 0,
        freshUntil: Number.NEGATIVE_INFINITY,
        step: 0,
        rewalkAt: Number.NEGATIVE_INFINITY,
        waiting: new Set(),
        usedAt: now,
        heardSentBy: new Map(),
        sampled: new Map(),
        answers: 0,
      };
      this.#keys.set(key, state);
      this.#sweep(now);
    } else {
      this.#keys.delete(key);
      this.#keys.set(key, state);
    }
    state.usedAt = now;
    return state;
  }

  /** Keys unused for `KEY_IDLE_MS`, or past `MAX_KEYS`, with nothing waiting on them, are let go. */
  #sweep(now: number): void {
    for (const [key, state] of this.#keys) {
      const idle = now - state.usedAt > KEY_IDLE_MS;
      if (!idle && this.#keys.size <= MAX_KEYS) break;
      if (state.waiting.size > 0 || state.scoutsOut > 0 || state.sampled.size > 0) continue;
      this.#keys.delete(key);
    }
  }

  /** A key's phase, derived from its verdict times (D18). */
  #phase(state: KeyState, now: number): Phase {
    const heard = state.lastHeardAt;
    const notHeard = state.lastNotHeardAt;
    if (
      heard !== undefined &&
      notHeard !== undefined &&
      now - heard <= KEY_SETTLE_MS &&
      now - notHeard <= KEY_SETTLE_MS
    ) {
      return 'mixed';
    }
    if (notHeard !== undefined && (heard === undefined || notHeard > heard)) return 'silent';
    if (heard !== undefined) return 'heard';
    return 'unknown';
  }

  #heard(key: string, sentAt: number, name: string): void {
    const now = this.#now();
    const state = this.#key(key, now);
    state.lastHeardAt = now;
    state.lastHeardSentAt = Math.max(state.lastHeardSentAt, sentAt);
    state.freshUntil = now + KEY_FRESH_MS;
    state.heardSentBy.set(name, Math.max(state.heardSentBy.get(name) ?? sentAt, sentAt));
    if (state.heardSentBy.size > 1_000) {
      const [oldest] = state.heardSentBy.keys();
      if (oldest !== undefined) state.heardSentBy.delete(oldest);
    }
    this.#wake(state, now);
  }

  #notHeard(key: string, sentAt: number, name: string): void {
    const now = this.#now();
    const state = this.#key(key, now);
    const heardAfter = state.heardSentBy.get(name);
    // Only the same name's newer Heard outweighs it (D18): another name's says nothing of this one.
    if (heardAfter !== undefined && heardAfter > sentAt) return;
    const was = this.#phase(state, now);
    const lately = state.lastHeardAt !== undefined && now - state.lastHeardAt < KEY_SETTLE_MS;
    state.step = was === 'silent' || lately ? Math.min(state.step + 1, 4) : 0;
    state.lastNotHeardAt = now;
    state.rewalkAt = now + this.#backoff(state.step);
    const phase = this.#phase(state, now);
    if (phase === 'silent' || phase === 'mixed') {
      if (phase !== was) {
        this.#say(
          `phase:${key}`,
          'info',
          { key, phase },
          'a DNS zone the check walks is not answering every name',
        );
      }
      try {
        this.#onKeySilent(key);
      } catch (error: unknown) {
        this.#logger.error({ err: error, key }, 'the resolver failed on a key gone silent');
      }
    }
    this.#wake(state, now);
  }

  #wake(state: KeyState, now: number): void {
    const phase = this.#phase(state, now);
    for (const wake of [...state.waiting]) wake(phase);
  }

  #backoff(step: number): number {
    const base = Math.min(REWALK_MAX_MS, REWALK_FIRST_MS * 2 ** step);
    return base * (1 - REWALK_JITTER + 2 * REWALK_JITTER * this.#random());
  }

  // --- Proven, misses and the stand-down ----------------------------------------------------------

  #prove(): void {
    if (this.#proven) return;
    this.#proven = true;
    this.#logger.info({}, 'the DNS check is proven: a DNS server answered it');
  }

  /** The canary (§1.10): one `localhost.` A question to the first server, a key walk's. */
  #canary(): void {
    if (this.#proven || this.#stopped) return;
    const server = this.#policy.view().conf?.servers[0];
    if (server === undefined || !this.#policy.checkOn()) return;
    if (!this.#budget.admit('discovery', 1) || !this.#budget.serverTake(server, 1, 'key')) return;
    const open: Promise<DnsReplyKind>[] = [];
    const channel = this.#asker.channel(server);
    this.#send(
      server,
      CANARY_NAME,
      'A',
      'discovery',
      channel,
      open,
      `${server}|${CANARY_NAME}|canary`,
    );
    void Promise.allSettled(open).then(() => {
      channel.close();
    });
    this.#say(
      'unproven',
      'info',
      { server },
      'the DNS check is not proven yet: every name is asked in the lookup helper',
    );
  }

  #miss(host: string, key: string): void {
    const now = this.#now();
    this.#misses += 1;
    this.#nameSkips.set(host, now + SKIP_MS);
    this.#logger.warn(
      { host, key },
      'the DNS check missed a name the lookup helper answered: it skips the check for an hour',
    );
    const names = this.#keyMisses.get(key) ?? new Map<string, number>();
    names.set(host, now);
    for (const [name, at] of names) if (now - at > MISS_WINDOW_MS) names.delete(name);
    this.#keyMisses.set(key, names);
    if (names.size < MISSES_PER_KEY || this.#marked(this.#keySkips, key, now)) return;
    this.#keySkips.set(key, now + SKIP_MS);
    this.#logger.warn(
      { key, names: [...names.keys()] },
      'the DNS check missed three names of one zone in ten minutes: the zone skips the check for an hour',
    );
    this.#skippedKeys = this.#skippedKeys.filter((skipped) => now - skipped.at <= MISS_WINDOW_MS);
    this.#skippedKeys.push({ key, at: now });
    const keys = new Set(this.#skippedKeys.map((skipped) => skipped.key));
    if (keys.size >= KEYS_TO_STAND_DOWN) this.#standDown(now, [...keys]);
  }

  #standDown(now: number, keys: readonly string[]): void {
    const repeat = this.#lastRearm !== undefined && now - this.#lastRearm <= STAND_DOWN_REPEAT_MS;
    this.#standDownMs = repeat
      ? Math.min(STAND_DOWN_MAX_MS, Math.max(STAND_DOWN_FIRST_MS, this.#standDownMs * 2))
      : STAND_DOWN_FIRST_MS;
    this.#standDownUntil = now + this.#standDownMs;
    this.#lastRearm = this.#standDownUntil;
    this.#standDowns += 1;
    this.#skippedKeys = [];
    const said = {
      keys,
      forMs: this.#standDownMs,
      until: 'the stand-down ends, a watched file changes, or ms-probe restarts',
    };
    const words =
      'the DNS check missed names in three zones in ten minutes: it stands down, and every name is asked in the lookup helper';
    if (repeat) this.#logger.warn(said, words);
    else this.#logger.error(said, words);
  }

  #standingDown(now: number): boolean {
    return this.#standDownUntil !== undefined && now < this.#standDownUntil;
  }

  #marked(marks: Map<string, number>, key: string, now: number): boolean {
    const until = marks.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    marks.delete(key);
    return false;
  }

  /** One log line per kind at most once a minute. */
  #say(
    kind: string,
    level: 'info' | 'warn',
    fields: Record<string, unknown>,
    message: string,
  ): void {
    const now = this.#now();
    const last = this.#lastLog.get(kind);
    if (last !== undefined && now - last < LOG_EVERY_MS) return;
    this.#lastLog.set(kind, now);
    if (this.#lastLog.size > 1_000) {
      const [oldest] = this.#lastLog.keys();
      if (oldest !== undefined) this.#lastLog.delete(oldest);
    }
    this.#logger[level](fields, message);
  }
}

/** A question's reply as it is now, read through a call: an await may have set it. */
function replyOf(question: Question): DnsReplyKind | undefined {
  return question.reply;
}

/** SERVFAIL, REFUSED, NOTIMP and ECONNREFUSED move `res_send` to the next server; FORMERR does not. */
function isFastFailure(reply: DnsReplyKind): boolean {
  return (
    reply === 'servfail' || reply === 'refused' || reply === 'notimp' || reply === 'connrefused'
  );
}

/**
 * How a step ends from what its servers said, in order (§1.4). Addresses for any type from a
 * server end it; for family 0 the chain stops at the first server that gives them, whatever the
 * other type said. Every type NXDOMAIN or NODATA: the next candidate. A FORMERR is the step's reply.
 * Fast failures at every server: ECONNREFUSED from all of them returns at once; otherwise the last
 * reply glibc kept decides, SERVFAIL the next candidate and REFUSED or NOTIMP the end.
 */
function endOf(said: readonly ServerSaid[]): StepEnd {
  let last: readonly DnsReplyKind[] = [];
  let everyRefusedConnection = said.length > 0;
  for (const one of said) {
    if (one.kind !== 'replies') return { kind: 'bad' };
    const replies = one.replies;
    if (replies.some((reply) => reply === 'bad' || reply === 'timeout')) return { kind: 'bad' };
    if (replies.includes('answer')) return { kind: 'answered' };
    if (replies.includes('formerr')) return { kind: 'done' };
    // A name error for a type, the others failing fast: glibc keeps the name error's buffer.
    if (
      replies.some(isNameError) &&
      replies.every((reply) => isNameError(reply) || isFastFailure(reply))
    ) {
      return { kind: 'next' };
    }
    if (!replies.every((reply) => reply === 'connrefused')) everyRefusedConnection = false;
    if (replies.some((reply) => reply !== 'connrefused')) last = replies;
  }
  if (everyRefusedConnection) return { kind: 'answered' };
  if (last.includes('servfail')) return { kind: 'next' };
  return { kind: 'done' };
}

function isNameError(reply: DnsReplyKind): boolean {
  return reply === 'nxdomain' || reply === 'nodata';
}

/** Exported for tests: `endOf` over replies alone. */
export function stepEndOf(replies: readonly (readonly DnsReplyKind[])[]): StepEnd['kind'] {
  return endOf(replies.map((one) => ({ kind: 'replies', replies: one }))).kind;
}

export type { DeferReason };
