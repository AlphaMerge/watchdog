import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  countedElsewhere,
  RESOLVER_FAULT,
  RESOLVER_FULL,
  RESOLVER_HELD,
  RESOLVER_LATE,
  RESOLVER_STUCK,
  RESOLVER_TOO_MANY,
  systemResolve,
  type ResolvedAddress,
  type ResolveHost,
  type ResolveOptions,
} from '@ms/sensors';
import type { Logger } from '@ms/shared';
import {
  DnsCheck,
  type CheckRoute,
  type CheckState,
  type DnsAsker,
  type DnsCheckOptions,
  type MissWatch,
  type SilentEvidence,
} from './dns-check.js';
import { ForwardBudget, questionsOf, type GaiToken, type TokenKind } from './forward-budget.js';
import {
  admitHelper,
  candidateKey,
  firstLoad,
  gateFirstRule,
  heldBy,
  helperKeyOk,
  helperRiskOk,
  helperUngated,
  HelperKeys,
  KEY_QUIET,
  keyWords,
  probeFirstRule,
  RISK_T,
  type HeldBy,
  type HelperAdmitAsk,
  type HelperOutcome,
  type HelperToken,
  type KeyRule,
} from './lane-rule.js';
// Types only: the helper's module imports this one's values (`STUCK_MS`), so a value imported
// back would be read before it is made.
import type {
  HelperAnswer,
  HelperChange,
  HelperLostError,
  HelperPort,
  HelperState,
  LateOutcome,
  LossReason,
  RouteState,
} from './lookup-helper.js';
import type { PoolResolver, ResolveAck, ResolveOutcome, ResolveReply } from './protocol.js';
import {
  digestOf,
  digestOfError,
  type PolicyChange,
  type SystemNamePolicy,
} from './system-names.js';
import { afterPolls, LATE_MS } from './verdict-timer.js';

/**
 * The probe's one resolver (`P-426`): every name a check resolves to check it, asked once and kept
 * a short while, in the probe's main thread.
 *
 * **Why it exists.** A check resolves its device's name once a scan (`A-57`), with `getaddrinfo`,
 * which libuv runs on its thread pool, at most half the pool's threads at a time, and which cannot
 * be cancelled. `A-66` measured what that cost at the 5,000-sensor class: a resolver answering in
 * 100 ms, or one zone in ten not answering, held every lookup lane and took the probe down
 * (`docs/findings/2026-10-17-name-lookups-a-scan.md`). This keeps answers, so a name is asked about
 * once in `ANSWER_MS` rather than once a scan, and it decides what runs on the lanes, so a silent
 * name cannot take them all.
 *
 * **The answers are getaddrinfo's, for exactly the family asked**, so nothing about what a name
 * resolves to changes: the hosts file, nsswitch, the search list and the address order are the
 * system's, as before. Family 0 is its own key and its own call, never put together from 4 and 6.
 * Only answers are kept, never a verdict: the target policy and a credential pin judge every
 * address at every check, a kept one as a fresh one.
 *
 * **What is kept, and for how long:**
 * - an answer for `ANSWER_MS` (30 s). `getaddrinfo` gives no TTL, and a DNS failover must be
 *   followed within about a scan;
 * - a denial for `DENIAL_MS` (30 s): `ENOTFOUND` or `ENODATA`, the name has no address, or more
 *   than `MAX_ADDRESSES`. Any other failure (`EMFILE`, `EAI_MEMORY`, `EAI_FAIL`…) says nothing
 *   about the name: the checks waiting are told it, and nothing is kept, the kept answer included;
 * - an expired answer is served at once while one refresh runs, and for at most `STALE_MS` (5 min)
 *   past its expiry while the resolver does not answer the refresh. A denial drops it.
 *
 * **A name the resolver does not answer is held**: its lookup returned `EAI_AGAIN`, or has run past
 * `STUCK_MS`. New checks for it fail at once naming the resolver (or get its stale answer) until the
 * hold ends, 5 s doubling to 60 s with ±20%, reset by any answer. A check already waiting for that
 * lookup is not one of them: it waits for its answer up to its own bound, as it would have without
 * this resolver. A retry runs only when a check asks after the hold, or "Check now" asks during it,
 * so a deleted device's name is not asked about for ever.
 *
 * **"Check now" asks fresh**: it joins a lookup running for the name, or starts one ahead of every
 * lookup queued, on a lane first lookups use, so it never waits behind held names' retries. It uses
 * a kept answer only when the resolver does not answer in time, saying so in the check's message.
 * It is how an operator sees that a DNS fix has taken.
 *
 * **The lanes.** At most `RESOLVER_LANES` (6) lookups run at once, of libuv's 8 when
 * `UV_THREADPOOL_SIZE` is 16 (the launcher and the unit set it), so 2 stay free for the probe's link
 * to the core and anything else that resolves. Of the 6, at most 1 is a held name's retry; the
 * other 5 are shared by first lookups and refreshes, at most 4 each, so 1 is always kept for each
 * (`P-426`'s second review: a warm zone that went silent filled all 5 with its first refreshes,
 * and every first lookup and "Check now" behind them failed). A check whose lookup is queued
 * behind every lane its class could take, each held by a lookup past `STUCK_MS`, fails at once
 * rather than waiting out its bound; its lookup stays queued.
 *
 * **A domain takes all 4 first-lookup lanes only while it is known to answer** (`P-438`): one of
 * its names has answered from DNS under the current configuration within the last `ANSWER_MS`
 * (not a name the hosts file lists for the family, which answers for a silent zone too, whatever
 * nsswitch.conf says; an answer the answer file gave counting until a lookup for its name settles,
 * and never past its own grace), and it has had no lookup stuck lately: none in flight, a first
 * lookup, a refresh or a retry, has run past `STUCK_MS` with no lookup of its domain that ran as
 * long answering since it started, and none ended so, stuck without an answer, within the last
 * `STUCK_MS` or since the last of its names answered from DNS. A resolver that answers every
 * lookup slowly, as glibc does in 5 s behind a first nameserver that is down, is answering, not
 * silent: its lookups past `STUCK_MS` keep answering, and its first lookups are not held for them
 * (`P-438`'s narrow check). The `STUCK_MS` after an end is timed: when it is over, the queue is
 * looked at again, as it is when a check asks. Otherwise it takes at most 3 (`P-432` calls it
 * "unacked: 3", and `lane-rule.ts`'s `probeFirstRule` is the rule). A domain is keyed as the
 * ranking below keys one, so a sub-zone is a domain of its own. So a probe started cold in the
 * middle of a zone's outage gives that zone 3 lanes from its first tick, before any of its
 * lookups is stuck, since none of its names has answered, and the answering
 * zones are asked on the fourth; a zone answering for some names while others hang is held to 3
 * while they hang, and through the `STUCK_MS` after its hanging lookups end together, by when
 * those started as they ended are stuck in turn; and a domain that answers is held to 3 only until
 * its first answer, a lookup's time after the start. A first lookup held back waits for one of its
 * own domain's to end, and its check fails at once when each of those is stuck. **And the last
 * shared lane** is not taken by a first lookup of a domain with a lookup stuck lately, counting as
 * taken every lane the refreshes running and queued may hold: a warm zone gone silent fills the 4
 * refresh lanes, and since a lane freed goes to a first lookup before a refresh, its first lookups
 * would otherwise take the one left each time one of its refreshes ended. "Check now" is held to
 * neither, nor is a name the hosts file gives for the family asked when nsswitch.conf reads the
 * file before DNS, as Windows always does: `getaddrinfo` answers it from the file. **Not
 * reached**: two domains held to 3 at once can take the 4 between them, which `P-432` bounds.
 *
 * **Which queued lookup a lane takes** (`P-426`'s reviews): "Check now"'s first; then the name whose
 * domain (the name less its first label) has the smallest share of its names failing, the name's
 * own failure left out; among held names' retries, the one with fewer failures in a row, then the
 * one that answered most recently; then the oldest. A zone that stops answering is a domain, so its
 * names wait behind those of zones that answer: a name held once by a passing failure is asked
 * again at the next retry, not after every silent name's, whether its domain is its own, a large
 * one with a few names failing, or the silent zone's own; and a silent zone's refreshes and first
 * lookups cannot keep an answering zone's off the lanes. A failing name no check has asked about
 * for `HOLD_MAX_MS + ANSWER_MS + STALE_MS` stops counting against its domain until one does, so a
 * zone whose devices were deleted during an outage does not rank last for good.
 *
 * **Counted for Probe Health**: what is running and queued here is `lookupsInFlight`, beside what
 * resolves elsewhere. A check that fails for want of an answer is given up where it waits
 * (`resolveWithin`), not here.
 */

/** How long an answer is kept. */
export const ANSWER_MS = 30_000;
/** How long a denial is kept. */
export const DENIAL_MS = 30_000;
/** How long past its expiry an answer may still be used while the resolver does not answer. */
export const STALE_MS = 300_000;
/** A lookup that has run this long without an answer holds its name, and its lane is stuck. */
export const STUCK_MS = 1_000;
/** The first hold, and the longest: each failure in a row doubles it. */
export const HOLD_FIRST_MS = 5_000;
export const HOLD_MAX_MS = 60_000;
/** How far either way a hold is moved, so that names held together are not retried together. */
export const HOLD_JITTER = 0.2;
/** The most names kept. The least recently asked for goes first. */
export const MAX_ENTRIES = 10_000;
/** The most lookups queued for a lane. */
export const MAX_QUEUED = 10_000;
/** An answer with more addresses than this fails, naming the count, rather than being kept. */
export const MAX_ADDRESSES = 64;
/** Lookups at once: of libuv's 8 at `UV_THREADPOOL_SIZE` 16, leaving 2 for everything else. */
export const RESOLVER_LANES = 6;
/** How often the hosts file, resolv.conf and nsswitch.conf are looked at for a change. */
export const WATCH_EVERY_MS = 5_000;
/** How long a request that says nothing about its bound is waited for. */
const DEFAULT_WAIT_MS = 10_000;
/** How long past its bound a waiter is kept, so that a reply on the edge still lands. */
const FORGET_SLACK_MS = 250;
/** How often a name being held is logged at warn. */
const HOLD_WARN_EVERY_MS = 60_000;
/** What `getaddrinfo` answers when a name has no address: the only failures kept as denials. */
const NO_ADDRESS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);
/** How often gate mode looks at its clocks: the time with the check on, poison names due. */
export const GATE_TICK_MS = 1_000;
/** How often gate mode logs its summary. */
export const GATE_SUMMARY_MS = 3_600_000;
/**
 * The lookup helper's changes of state, and its losses, the hourly summary lists one by one: the
 * first of the hour, and a count of the rest. A healthy hour has none, a helper failing over and
 * over a few dozen, and each loss has its own line besides (`P-467`).
 */
export const SUMMARY_LISTED = 20;

/**
 * What the hourly summary says of the check's state (`P-467`), numbered as `GateHealth`'s
 * `checkState`: 0 while the helper rests, else the check's own. Probe Health has no channel for
 * it (OPEN-5), so the words are here, and the start line, the stand-down line and the lines of
 * a file that moved say the rest.
 */
export const CHECK_STATE_SAID: Readonly<Record<0 | CheckState, string>> = {
  0: 'resting: the lookup helper rests, and names are asked as with system',
  1: 'on',
  2: 'off for this system’s name settings or platform, or while they are slow to read: off says why',
  3: 'not proven: no DNS server has answered it yet',
  4: 'stood down after misses: the stand-down line names the zones',
  5: 'walks off at a DNS server',
};
/** The domains Probe Health names as not answering (`P-441`). */
export const NOT_ANSWERING_NAMED = 3;

export type Family = 0 | 4 | 6;

/** What asks the system: `getaddrinfo` in production. */
export type SystemLookup = (host: string, family: Family) => Promise<readonly ResolvedAddress[]>;

/** Which lanes a lookup may use. */
type LaneClass = 'first' | 'refresh' | 'retry';

/** Which lane set runs a lookup (`P-432`): the probe's own, or the lookup helper's. */
type Pool = 'probe' | 'helper';

/**
 * How gate mode routed a lookup (`P-432` §1.3): `local` when the policy says glibc answers it
 * without the network, `heard` when its own walk was heard and `sampled` when it rode its zone's
 * heard walk (D20), each run on the probe's lanes; `silent` when a step of its walk went
 * unanswered, run in the lookup helper and only there, a check failing at once while the helper
 * is down; `unvouched` for everything the check cannot or may not judge, run in the helper while
 * it is up, and on the probe's lanes under the domain's first-lane rule (D24) while it is down.
 * While the helper rests, every lookup runs as `system` routes it.
 */
export type GateRoute = 'local' | 'heard' | 'sampled' | 'silent' | 'unvouched';

/**
 * What gate mode is built from (`P-432` S3): the lookup helper the probe starts, and the system's
 * name policy, which says which names glibc answers without the network and which files it reads
 * once. In `system` mode none of it exists, and every branch that reads it is dead.
 */
export interface GateParts {
  readonly helper: HelperPort;
  readonly policy: SystemNamePolicy;
  /** The question budget: a new one on the resolver's clock unless a test hands one in. */
  readonly budget?: ForwardBudget;
  /** What the helper knows of each key: a new one unless a test hands one in. */
  readonly keys?: HelperKeys;
  /** How often its clocks are looked at: `GATE_TICK_MS` unless a test says. */
  readonly tickMs?: number;
  /** A monotonic clock for the stuck timer's lateness (D25): real time unless a test says. */
  readonly realNow?: () => number;
  /**
   * The name check (`P-432` S6): what it asks DNS with, c-ares in production, and its other
   * settings. Absent, as in S3's tests, the check is not built and every name the hosts file does
   * not give is unvouched.
   */
  readonly check?: { readonly asker: DnsAsker } & Partial<
    Omit<DnsCheckOptions, 'logger' | 'policy' | 'budget' | 'asker' | 'now' | 'onKeySilent'>
  >;
}

/**
 * What gate mode has done since the probe started. Probe Health sends the mode, the time with the
 * check on and the two stuck counts (protocol 38); the rest is the hourly summary's (OPEN-5,
 * `P-467`), and the tests' and the perf arms'.
 */
export interface GateHealth {
  /** 2 while the helper serves its route, 3 while it rests and the probe resolves as `system`. */
  readonly mode: 2 | 3;
  /** Seconds with the check on (the policy vouching) and the helper up: a running total. */
  readonly checkOnSeconds: number;
  /** Probe-lane `local` lookups past `STUCK_MS`, judged after polls (D25): a running total. */
  readonly passedStuck: number;
  /** Helper lookups the child said were stuck: a running total. */
  readonly helperStuck: number;
  /**
   * The check's state (§5's numbering, `CHECK_STATE_SAID`): 0 resting; 1 on; 2 off for the
   * environment or platform; 3 not proven; 4 stood down; 5 walks off at a server (never in this
   * build: the pressure detector is cut).
   */
  readonly checkState: 0 | CheckState;
  /** Lookups run on the probe's lanes because their walk, or their zone's sample, was heard. */
  readonly lookupsHeard: number;
  /** Lookups run in the lookup helper, any route. */
  readonly lookupsToHelper: number;
  /** The check's misses: a running total. */
  readonly misses: number;
  /** Walks deferred, every reason: a running total. */
  readonly walksDeferred: number;
}

export interface NameResolverOptions {
  readonly logger: Logger;
  /** Gate mode (`P-432`), with what it is built from. Absent: `system` mode, `P-426` with `P-438`. */
  readonly gate?: GateParts;
  /** What asks the system. `systemResolve` (getaddrinfo) unless a test hands one in. */
  readonly lookup?: SystemLookup;
  /** A monotonic clock in milliseconds. `performance.now` unless a test hands one in. */
  readonly now?: () => number;
  /** Uniform in [0, 1), for the holds' jitter. `Math.random` unless a test hands one in. */
  readonly random?: () => number;
  readonly lanes?: number;
  readonly answerMs?: number;
  readonly denialMs?: number;
  readonly staleMs?: number;
  readonly stuckMs?: number;
  readonly holdFirstMs?: number;
  readonly holdMaxMs?: number;
  readonly maxEntries?: number;
  readonly maxQueued?: number;
  readonly maxAddresses?: number;
  /**
   * The files whose change moves what `getaddrinfo` answers, and how often they are looked at. A
   * file named `hosts` is read as a hosts file, and any other as the resolver's configuration
   * (`checkFiles`); one named `nsswitch.conf` also says whether the hosts file is read before DNS
   * (`hostsGive`). The system's (`systemResolverFiles`) every `WATCH_EVERY_MS` unless a test says
   * otherwise.
   *
   * `onLook`, when given, is told after every look what it read that it had not told before: each
   * file whose digest (its contents, or why it could not be read) moved since the last look, and
   * at the first look every file, as this look read it. It is awaited, and its failure is logged
   * and fails nothing. The gate's name policy (`P-432`) takes its readings from here, so that it
   * and this resolver act on one reading of a file, and looks at the nscd socket on the same tick.
   * What this resolver acts on is unchanged by it: a file it cannot read is still compared at the
   * next look.
   */
  readonly watch?: {
    readonly files: readonly string[];
    readonly everyMs: number;
    readonly onLook?: (readings: readonly WatchedReading[]) => Promise<unknown>;
  };
}

/** What one look at a watched file read (`watch.onLook`). */
export interface WatchedReading {
  readonly file: string;
  /** Its contents as UTF-8: `''` when it is absent, undefined when it cannot be read for another reason. */
  readonly text: string | undefined;
  /**
   * Its digest by the contract `P-432`'s policy and lookup helper share (system-names.ts, `digestOf`):
   * sha256 of the bytes read, `absent`, or `unreadable:<code>`.
   */
  readonly digest: string;
}

/** What the resolver is doing now, for Probe Health and the log. */
export interface NameResolverStats {
  /** Lookups running on a lane. */
  readonly running: number;
  /** Lookups waiting for one. */
  readonly queued: number;
  /** Names kept. */
  readonly entries: number;
}

/**
 * An answer as the probe's answer file keeps it across a restart (`P-438`): its times relative to
 * the clock when it was read, since the resolver's clock is monotonic and a file's is the wall's.
 */
export interface KeptAnswer {
  readonly host: string;
  readonly family: Family;
  readonly addresses: readonly ResolvedAddress[];
  /** How long ago the resolver answered it. */
  readonly answeredAgoMs: number;
  /** How long until it expires: none, or less, once it has. */
  readonly expiresInMs: number;
}

/** What `restore` kept of an answer file, and why it kept no more. */
export interface RestoreCounts {
  readonly loaded: number;
  /** Past its grace: expired more than `STALE_MS` ago. */
  readonly pastGrace: number;
  /** A name the hosts file gives now, which `getaddrinfo` answers from it at once. */
  readonly hostsFile: number;
  /** A name kept already, or given twice. */
  readonly duplicate: number;
  /** More names than the resolver keeps. */
  readonly overCap: number;
  /** No name, an address for a name, or no address or too many. */
  readonly invalid: number;
}

interface Answer {
  readonly addresses: readonly ResolvedAddress[];
  readonly answeredAt: number;
  readonly expiresAt: number;
}

interface Denial {
  readonly code: string;
  readonly message: string;
  readonly until: number;
}

interface Hold {
  readonly since: number;
  until: number;
  why: string;
}

interface Entry {
  readonly key: string;
  readonly host: string;
  readonly family: Family;
  /** The name less its first label (`domainOf`): what a queued lookup is ranked by. */
  readonly domain: string;
  answer: Answer | undefined;
  denial: Denial | undefined;
  hold: Hold | undefined;
  /** Lookups in a row the resolver did not answer: the hold's step. Set by `#setFailures`. */
  failures: number;
  /**
   * When the name last answered with addresses, kept when the answer itself is dropped: among held
   * names, one that answered lately is retried before one that never has.
   */
  lastAnsweredAt: number | undefined;
  /** Gate mode: how long its last `getaddrinfo` took to give addresses (D20's sampling). */
  lastRanMs: number | undefined;
  pending: Pending | undefined;
  /**
   * Gate mode: the lookup helper named it a suspect at a crash it had run past `STUCK_MS` in
   * (D27), so its next lookup is sent alone while the helper isolates.
   */
  suspect: boolean;
}

interface Waiter {
  /** "Check now": a cached answer is used only when the resolver did not answer, and said so. */
  readonly fresh: boolean;
  /** Undefined once the waiter has been forgotten at its bound. */
  readonly deliver: (outcome: ResolveOutcome | undefined) => void;
  readonly timers: NodeJS.Timeout[];
}

interface Pending {
  readonly entry: Entry;
  /** Moved to `first` when "Check now" joins a lookup still queued (`#promote`). */
  cls: LaneClass;
  /** "Check now"'s: taken before any other queued lookup. */
  urgent: boolean;
  /** `scouting`: gate mode, its walk under way and in no queue yet (§1.4). */
  state: 'scouting' | 'queued' | 'running' | 'done';
  startedAt: number;
  /** Which configuration it was asked under: `#generation` when it started to run. */
  generation: number;
  /** `#events` when it started to run: which of its domain's answers came after it started. */
  startedSeq: number;
  stuck: boolean;
  stuckTimer: NodeJS.Timeout | undefined;
  readonly waiters: Set<Waiter>;
  /** Gate mode: the lane set it is queued on or runs on. Always the probe's in `system` mode. */
  pool: Pool;
  /** Gate mode: how it was routed. */
  route: GateRoute;
  /** Gate mode: the key the helper judges it by: its walk's verdict's, else `candidateKey`. */
  key: string;
  /** Gate mode: every candidate key its walk asked, when it was heard (O-OS-10). */
  walkKeys: readonly string[];
  /** Gate mode: its walk's unanswered question, watched for a miss (§1.10). */
  miss: MissWatch | undefined;
  /** Gate mode: what its silent route rests on, for the words of a check failed meanwhile. */
  silent: SilentEvidence | undefined;
  /** Gate mode: it was walked, so the helper's stuck word is not the OS's evidence of its key. */
  walked: boolean;
  /** Gate mode: the helper token it holds, carried across a loss (D7). */
  token: GaiToken | undefined;
  /** Gate mode: detached when the helper went quiet (D26): it no longer stands for its name. */
  detached: boolean;
  /** Gate mode: sent alone while the helper isolates (D27). */
  suspect: boolean;
  /** Gate mode: a poison name's hourly ask, sent alone in the helper (D27). */
  poisonAsk: boolean;
  /**
   * Gate mode: why `#offProbe` failed it as it would have started on the probe's lanes (D27). Read
   * by the check whose own pump started it (`#ask`), which joined it before it was settled.
   */
  refused: string | undefined;
  /** Gate mode: a probe-lane DNS lookup past `STUCK_MS` after polls, counted in U (D25). */
  untokened: boolean;
  /** Gate mode: ungated when it started in the helper, which the kept token needs (I8). */
  ungated: boolean;
  /** When its stuck timer was set, on a real clock: how late it fired (D25). */
  armedAt: number;
}

/**
 * One of `P-426`'s lane sets: the probe's, or in gate mode the lookup helper's, which is a second
 * copy with the same classes and caps (`P-432` §1.8).
 */
interface LaneSet {
  readonly pool: Pool;
  readonly queues: Record<LaneClass, Pending[]>;
  readonly running: Record<LaneClass, Set<Pending>>;
  /** "Check now"'s lookups still queued. */
  urgentQueued: number;
  readonly sharedCap: number;
  readonly firstCap: number;
  readonly refreshCap: number;
}

function laneSet(pool: Pool, lanes: number): LaneSet {
  return {
    pool,
    queues: { first: [], refresh: [], retry: [] },
    running: { first: new Set(), refresh: new Set(), retry: new Set() },
    urgentQueued: 0,
    sharedCap: lanes - 1,
    firstCap: lanes - 2,
    refreshCap: lanes - 2,
  };
}

/** The counts the hourly summary gives for the hour, as their running totals stood at its start. */
interface HourCounts {
  readonly lookupsHeard: number;
  readonly lookupsToHelper: number;
  readonly misses: number;
  readonly walksDeferred: number;
  readonly passedStuck: number;
  readonly helperStuck: number;
}

/** A change of the lookup helper's state, as the hourly summary lists it (`P-467`). */
interface SummaryChange {
  /** Wall-clock, to set beside the helper's own lines in the journal. */
  readonly at: string;
  readonly from: HelperState;
  readonly to: HelperState;
  /** The loss that moved it, when one did. */
  readonly loss?: LossReason;
}

/** A loss of the lookup helper, as the hourly summary lists it: its reason, and how it ended. */
interface SummaryLoss {
  readonly at: string;
  readonly reason: LossReason;
  readonly pid: number | undefined;
  readonly why: string | undefined;
  /** How the child ended, once its exit says: null until then, and for a child never ended. */
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  /** The helper's own time of the loss, to know it again in `stats().lastLoss` (not logged). */
  readonly lossAt: number | undefined;
}

/** What the hourly summary lists of the lookup helper this hour (`P-467`). */
interface HelperHour {
  readonly changes: SummaryChange[];
  changesNotListed: number;
  readonly lost: SummaryLoss[];
  lostNotListed: number;
  /** The last loss listed while its child's end is not yet read, to fill in from the helper. */
  awaitingEnd: SummaryLoss | undefined;
}

/** The parts of gate mode the resolver keeps, made whole. */
interface Gate {
  readonly helper: HelperPort;
  readonly policy: SystemNamePolicy;
  readonly budget: ForwardBudget;
  readonly keys: HelperKeys;
  /** The name check (S6): undefined when not built. */
  readonly check: DnsCheck | undefined;
  /** Lookups whose walk is under way, in no queue yet. */
  readonly scouting: Set<Pending>;
  /** Lookups run on the probe's lanes as heard or sampled, and in the helper: running totals. */
  lookupsHeard: number;
  lookupsToHelper: number;
  readonly lanes: LaneSet;
  /** Helper lookups running on any token for "Check now": outside the classes' caps. */
  readonly urgentRunning: Set<Pending>;
  readonly tickMs: number;
  readonly realNow: () => number;
  /**
   * The names the helper made suspects at a crash (D27) and still to be asked alone: asked again
   * at once, or held first, as a lookup the child had said was stuck is. Isolation ends only once
   * none is left and no suspect in flight is unsaid stuck, or at the helper's own lapse.
   */
  readonly suspects: Set<Entry>;
  checkOnMs: number;
  checkOnSince: number | undefined;
  passedStuck: number;
  helperStuck: number;
  /** The route at the last change, to tell a move. */
  route: RouteState;
  tick: NodeJS.Timeout | undefined;
  lastSummaryAt: number;
  /**
   * For the hourly summary: what was routed where, and the highest at risk, since the last. Each
   * counts lookups: `faulted` is one for each lookup the gate refused, however many checks waited
   * for it, none among them, and one for each check refused as it asked, which starts none.
   */
  readonly routed: Record<'local' | 'helper' | 'probe' | 'faulted' | 'resting', number>;
  /**
   * For the hourly summary, since the last: the checks those refusals failed (`RESOLVER_FAULT`),
   * each once, a check served its kept answer not among them (`P-463` fix round 2). What keeping a
   * name off costs, where `routed.faulted` is a refresh nobody waited for as much as two checks.
   */
  checksFaulted: number;
  riskPeak: number;
  /** For the hourly summary: the running totals at the last, and the helper's hour (`P-467`). */
  hourFrom: HourCounts;
  helperHour: HelperHour;
  /** What the policy was last told the hosts file says, for the first look. */
  loaded: boolean;
}

/**
 * How many names of a domain are kept, and how many of them are failing; and whether it is known to
 * answer (`P-438`): when one of its names last answered from DNS under the current configuration,
 * the names that hold an answer the answer file gave, and when one of its lookups last ended stuck
 * without an answer. `answeredSeq` and `stuckSeq` order the last answer and that end, which the
 * clock may not tell apart; `slowSeq` is the last answer from a lookup that had run past
 * `STUCK_MS` first, which says that a lookup of the domain stuck is one still to answer.
 */
interface DomainCount {
  names: number;
  failing: number;
  answeredAt: number | undefined;
  answeredSeq: number;
  slowSeq: number;
  readonly loaded: Set<Entry>;
  stuckAt: number | undefined;
  stuckSeq: number;
}

/** What a watched file said at the last look. */
interface Seen {
  readonly digest: string;
  /** A hosts file's names, each with its addresses in the file's order. */
  readonly names: ReadonlyMap<string, string> | undefined;
  /** An nsswitch.conf's: whether its hosts line asks the hosts file before anything else. */
  readonly filesFirst: boolean | undefined;
}

/** What the hosts file gives ahead of DNS: nothing, unless the system reads the file first. */
interface HostsView {
  readonly first: boolean;
  readonly names: ReadonlyMap<string, string>;
}

type Asked =
  { readonly now: ResolveOutcome } | { readonly later: Promise<ResolveOutcome | undefined> };

/**
 * How many threads libuv's pool has, read as libuv reads `UV_THREADPOOL_SIZE` when it first starts
 * it: 4 when unset, at least 1, at most 1,024. Read at start, since a change after the pool's first
 * use moves nothing, which is why the launcher and the unit set it rather than the probe.
 */
export function threadpoolSize(setting: string | undefined): number {
  if (setting === undefined) return 4;
  const parsed = Number.parseInt(setting, 10);
  // libuv's `atoi` into an unsigned: nothing readable is 0, which it makes 1, and a negative wraps
  // past the ceiling.
  if (Number.isNaN(parsed) || parsed === 0) return 1;
  if (parsed < 0 || parsed > 1_024) return 1_024;
  return parsed;
}

/**
 * How many lookups libuv runs at once: slow I/O, which `getaddrinfo` is, takes at most half its
 * threads, rounded up, so that file access is never starved by it.
 */
export function lookupLanes(threads: number): number {
  return Math.floor((threads + 1) / 2);
}

/**
 * The resolver's lanes for libuv's: `RESOLVER_LANES` when the threads leave 2 lanes beside it, as
 * `UV_THREADPOOL_SIZE` 16 does, fewer when they do not, and never fewer than the 3 its classes
 * need. Below 8 libuv lanes the probe says so at start: its lookups then queue inside libuv, where
 * one behind a silent name reads as stuck too.
 */
export function resolverLanes(libuvLanes: number): number {
  return Math.max(3, Math.min(RESOLVER_LANES, libuvLanes - 2));
}

/**
 * The system's hosts file, resolv.conf and nsswitch.conf: what `getaddrinfo` reads that a change
 * would move. Windows reads its hosts file before DNS and has neither of the others.
 */
export function systemResolverFiles(): string[] {
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows';
    return [join(root, 'System32', 'drivers', 'etc', 'hosts')];
  }
  return ['/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf'];
}

/** Whether a watched file is read as nsswitch.conf: by its name. */
function isNsswitch(file: string): boolean {
  return file.split(/[\\/]/u).at(-1)?.toLowerCase() === 'nsswitch.conf';
}

/** Sources of a `hosts` line that never ask DNS, which glibc passes by for any other name. */
const LOCAL_SOURCES = new Set(['myhostname', 'mymachines']);

/**
 * Whether a name the hosts file gives is answered from it before DNS is asked, by nsswitch.conf's
 * `hosts` line as glibc reads it (`P-438`'s narrow check): the last `hosts` line, its name ended
 * at a blank or a colon, either way; a `#` ending any line; actions in brackets left out, and a
 * list that starts with one read as none. The file is read first when `files` comes before any
 * source that asks DNS, with only `myhostname` or `mymachines` ahead of it, or when `resolve`
 * does, since systemd-resolved answers the hosts file's names itself. Any other source, `dns`,
 * `mdns4_minimal` or `nis`, is taken as asking DNS. A file without a `hosts` line, or none at
 * all, is glibc's default, `dns [!UNAVAIL=return] files`: DNS first.
 */
export function hostsFileFirst(text: string): boolean {
  let list: string | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const match = /^\s*([^\s:]+)[\s:]*(.*)$/u.exec(raw.replace(/#.*$/u, ''));
    if (match?.[1] === 'hosts') list = match[2] ?? '';
  }
  if (list === undefined || list.trimStart().startsWith('[')) return false;
  for (const source of list
    .replace(/\[[^\]]*\]/gu, ' ')
    .trim()
    .split(/\s+/u)) {
    if (source === 'files' || source === 'resolve') return true;
    if (!LOCAL_SOURCES.has(source)) return false;
  }
  return false;
}

/**
 * What the watched files say the hosts file gives ahead of DNS: their hosts files' names, and
 * whether nsswitch.conf reads them first. With no nsswitch.conf watched, Windows reads its hosts
 * file first, and on any other system it is not known, so nothing is taken as the file's.
 */
function viewOf(seen: Iterable<readonly [string, Seen]>): HostsView {
  const names = new Map<string, string>();
  let first: boolean | undefined;
  for (const [file, look] of seen) {
    if (isNsswitch(file)) first = look.filesFirst === true;
    for (const [name, addresses] of look.names ?? []) {
      const before = names.get(name);
      names.set(name, before === undefined ? addresses : `${before} ${addresses}`);
    }
  }
  return { first: first ?? process.platform === 'win32', names };
}

/** What one watched file says, from its text. */
function seenOf(file: string, text: string, digest = ''): Seen {
  return {
    digest,
    names: isHostsFile(file) ? hostsNames(text) : undefined,
    filesFirst: isNsswitch(file) ? hostsFileFirst(text) : undefined,
  };
}

/**
 * Whether the hosts file lists a name for the family asked: an address of that family, or any for
 * family 0. Whatever nsswitch.conf says, such a name's answer says nothing of whether its domain
 * answers from DNS (`P-438`'s narrow check: read by the order on the line, a reader's mistake
 * counted a silent zone as answering).
 */
function hostsLists(view: HostsView, host: string, family: Family): boolean {
  const addresses = view.names.get(hostsKey(host));
  if (addresses === undefined) return false;
  return family === 0 || addresses.split(' ').some((address) => isIP(address) === family);
}

/**
 * Whether `getaddrinfo` answers a name from the hosts file for the family asked (`P-438`'s
 * review): the file read first (`hostsFileFirst`), and listing it for that family. A name it lists
 * only for the other family is asked of DNS.
 */
function hostsGive(view: HostsView, host: string, family: Family): boolean {
  return view.first && hostsLists(view, host, family);
}

const seconds = (ms: number): string => `${String(Math.max(0, Math.round(ms / 1000)))} s`;

/**
 * A name as glibc compares it with a hosts file's: lower case, a trailing dot kept, so that
 * `foo.test.` is not the file's `foo.test`, and is asked of DNS (`P-438`'s narrow check).
 */
function hostsKey(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * A name's domain: the name less its first label, so `dev-4.zone-b.example` is `zone-b.example`,
 * and `dev-4.zone-b.example.` too. A name of one label is in the domain `''`, with every other the
 * search list completes.
 */
export function domainOf(host: string): string {
  const lower = host.trim().toLowerCase();
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/** Whether a watched file is read as a hosts file: by its name, on any platform. */
function isHostsFile(file: string): boolean {
  return file.split(/[\\/]/u).at(-1)?.toLowerCase() === 'hosts';
}

/**
 * Each name a hosts file gives, with its addresses as one string in the file's order: what
 * `getaddrinfo` answers it with ahead of DNS. A line whose first field is not an address is not
 * one `getaddrinfo` reads either.
 */
export function hostsNames(text: string): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/u)) {
    const fields = raw.replace(/#.*$/u, '').trim().split(/\s+/u);
    const address = fields[0]?.toLowerCase() ?? '';
    if (isIP(address) === 0) continue;
    for (const field of fields.slice(1)) {
      const name = hostsKey(field);
      if (name === '') continue;
      const addresses = byName.get(name) ?? [];
      addresses.push(address);
      byName.set(name, addresses);
    }
  }
  return new Map([...byName].map(([name, addresses]) => [name, addresses.join(' ')]));
}

/** The names two readings of a hosts file give differently: added, removed or changed. */
function namesChanged(
  before: ReadonlyMap<string, string> | undefined,
  after: ReadonlyMap<string, string> | undefined,
): Set<string> {
  const changed = new Set<string>();
  for (const [name, addresses] of before ?? []) {
    if (after?.get(name) !== addresses) changed.add(name);
  }
  for (const [name, addresses] of after ?? []) {
    if (before?.get(name) !== addresses) changed.add(name);
  }
  return changed;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** Lexicographic: whether rank `a` is taken before rank `b`. */
function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function failure(code: string, message: string): ResolveOutcome {
  return { ok: false, code, message };
}

/** `HELPER_LOST` (lookup-helper.ts), the code a lookup the helper no longer has is rejected with. */
export const HELPER_LOST_CODE = 'ERESOLVERHELPERLOST';

/** A `HelperLostError`, told by its code: the helper's module cannot be imported for its values. */
function isHelperLost(error: unknown): error is HelperLostError {
  return (error as { code?: unknown } | null | undefined)?.code === HELPER_LOST_CODE;
}

/** How a lookup ended, as `#settle` reads it. */
type Settled =
  | {
      readonly addresses: readonly ResolvedAddress[];
      readonly total?: number;
      /** How long `getaddrinfo` took: on the probe's clock, or the helper child's. */
      readonly ranMs?: number;
    }
  | { readonly error: unknown }
  | { readonly fault: unknown }
  /** A failure that says nothing of the name: told to its checks, nothing kept (gate mode). */
  | {
      readonly passed: { readonly code: string; readonly why: string };
      /** Refused by the gate (`#refuse`): each check it fails counts in `checksFaulted`. */
      readonly refused?: true;
    }
  /** Lost with the lookup helper after the child said it was stuck: held, and said so. */
  | { readonly held: string };

/** Why a queued helper lookup fails fast, and what holds it (§1.8). */
interface HelperBlock {
  readonly condition: 'key' | 'unit' | 'risk' | 'class' | 'token';
  readonly lookups: readonly Pending[];
  /** Ghosts and U among the blockers: each stuck. */
  readonly ghosts: number;
}

/** A lookup's state as it is now, for a read after a call that may have moved it. */
function stateOf(pending: Pending): Pending['state'] {
  return pending.state;
}

/** What a lookup the probe's stop settles tells its checks (gate mode). */
function stopping(host: string): string {
  return `the probe is stopping: ${host} was not answered`;
}

/** How long a settled `getaddrinfo` ran, when it says: the helper's errors carry the child's. */
function ranMsOf(result: Settled): number | undefined {
  if ('addresses' in result) return result.ranMs;
  if ('error' in result) {
    const ran = (result.error as { ranMs?: unknown } | null | undefined)?.ranMs;
    return typeof ran === 'number' ? ran : undefined;
  }
  return undefined;
}

/** A check's bound, as `#wait` takes it. */
function boundOf(waitMs: number | undefined): number {
  return waitMs !== undefined && Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_WAIT_MS;
}

const NO_COUNTS: HourCounts = {
  lookupsHeard: 0,
  lookupsToHelper: 0,
  misses: 0,
  walksDeferred: 0,
  passedStuck: 0,
  helperStuck: 0,
};

function newHelperHour(): HelperHour {
  return { changes: [], changesNotListed: 0, lost: [], lostNotListed: 0, awaitingEnd: undefined };
}

/** The walks deferred, every reason: a running total. */
function walksDeferredOf(budget: ForwardBudget): number {
  const { deferred } = budget.stats();
  return deferred.budget + deferred.rate + deferred.stall + deferred.scoutWait;
}

function queuedIn(set: LaneSet): number {
  return set.queues.first.length + set.queues.refresh.length + set.queues.retry.length;
}

/** How many of the shared lanes a class may hold: each leaves the other one. */
function capOf(set: LaneSet, cls: 'first' | 'refresh'): number {
  return cls === 'first' ? set.firstCap : set.refreshCap;
}

/** Every helper lookup running, "Check now"'s with them. */
function helperRunning(gate: Gate): Pending[] {
  const { running } = gate.lanes;
  return [...running.first, ...running.refresh, ...running.retry, ...gate.urgentRunning];
}

export class NameResolver implements PoolResolver {
  readonly #logger: Logger;
  readonly #lookup: SystemLookup;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #answerMs: number;
  readonly #denialMs: number;
  readonly #staleMs: number;
  readonly #stuckMs: number;
  readonly #holdFirstMs: number;
  readonly #holdMaxMs: number;
  readonly #maxEntries: number;
  readonly #maxQueued: number;
  readonly #maxAddresses: number;
  /**
   * Retries take at most one lane; first lookups at most `#firstCap` and refreshes at most
   * `#refreshCap`, each one fewer than the two share (`#sharedCap`), so each keeps one.
   */
  readonly #sharedCap: number;
  readonly #firstCap: number;
  readonly #refreshCap: number;
  /**
   * What a domain's first lookups may hold (`P-438`, written on `P-432`'s lane rule): one fewer
   * than all, and never none, while it is not known to answer or has a lookup stuck.
   */
  readonly #firstRule: KeyRule;
  /** `#answering`, as `firstLoad` asks it. */
  readonly #answeringOf = (count: DomainCount, now: number): boolean => this.#answering(count, now);
  /** How long a failing name no check asks about counts against its domain. */
  readonly #countFailingMs: number;
  readonly #watch: NonNullable<NameResolverOptions['watch']>;
  /** Least recently asked first: a check's ask moves its name to the end, nothing else does. */
  readonly #entries = new Map<string, Entry>();
  /** Every domain with a name kept, and how many of its names are failing. */
  readonly #domains = new Map<string, DomainCount>();
  /**
   * The failing names counted in their domains, each with when a check last asked for it or it
   * last failed: oldest first, so the ones no longer asked about are let go from the front.
   */
  readonly #failing = new Map<Entry, number>();
  /** Names counted in `#failing`, over every domain. */
  #failingNames = 0;
  /** Moved on by a change to the resolver's configuration: what a lookup was asked under. */
  #generation = 0;
  /** What each watched file said at the last look. */
  readonly #seen = new Map<string, Seen>();
  /** What they say the hosts file gives ahead of DNS, at the last look. */
  #view: HostsView = viewOf([]);
  /** Orders each domain's last answer and last lookup stuck (`P-438`). */
  #events = 0;
  /** What `watch.onLook` was last told of each file: its digest. */
  readonly #told = new Map<string, string>();
  /** The probe's own lanes: `P-426`'s lane set. */
  readonly #probe: LaneSet;
  /** Gate mode (`P-432`): undefined in `system` mode. */
  readonly #gate: Gate | undefined;
  /** Whether `firstLook` took the watch's baseline, so `start` need not. */
  #firstLooked = false;
  /**
   * Set by `stop`: the check pool has drained (`main.ts` stops the resolver after it), so a helper
   * that goes down from here has nobody to answer on the probe's lanes (`P-432` S3).
   */
  #stopped = false;
  #watchTimer: NodeJS.Timeout | undefined;
  /** Each pumps the queue when the `STUCK_MS` after a lookup ended stuck is over (`#endedStuck`). */
  readonly #windowTimers = new Set<NodeJS.Timeout>();
  #watching = false;
  #lastHoldWarn: number | undefined;
  #heldSinceWarn = 0;

  constructor(options: NameResolverOptions) {
    this.#logger = options.logger.child({ component: 'name-resolver' });
    this.#lookup = options.lookup ?? ((host, family) => systemResolve(host, family));
    this.#now = options.now ?? (() => performance.now());
    this.#random = options.random ?? Math.random;
    this.#answerMs = options.answerMs ?? ANSWER_MS;
    this.#denialMs = options.denialMs ?? DENIAL_MS;
    this.#staleMs = options.staleMs ?? STALE_MS;
    this.#stuckMs = options.stuckMs ?? STUCK_MS;
    this.#holdFirstMs = options.holdFirstMs ?? HOLD_FIRST_MS;
    this.#holdMaxMs = options.holdMaxMs ?? HOLD_MAX_MS;
    this.#maxEntries = Math.max(1, options.maxEntries ?? MAX_ENTRIES);
    this.#maxQueued = Math.max(1, options.maxQueued ?? MAX_QUEUED);
    this.#maxAddresses = Math.max(1, options.maxAddresses ?? MAX_ADDRESSES);
    // At least a retry lane, a first lane and a refresh lane.
    const lanes = Math.max(3, Math.trunc(options.lanes ?? RESOLVER_LANES));
    this.#sharedCap = lanes - 1;
    this.#firstCap = lanes - 2;
    this.#refreshCap = lanes - 2;
    this.#probe = laneSet('probe', lanes);
    // One lane rule (D24, decided 2026-10-19): gate mode's is `P-438`'s, and only the load differs.
    this.#firstRule =
      options.gate === undefined
        ? probeFirstRule(this.#firstCap, this.#sharedCap)
        : gateFirstRule(this.#firstCap, this.#sharedCap);
    const gate = options.gate;
    const budget =
      gate === undefined ? undefined : (gate.budget ?? new ForwardBudget({ now: this.#now }));
    this.#gate =
      gate === undefined || budget === undefined
        ? undefined
        : {
            helper: gate.helper,
            policy: gate.policy,
            budget,
            keys: gate.keys ?? new HelperKeys(),
            check:
              gate.check === undefined
                ? undefined
                : new DnsCheck({
                    ...gate.check,
                    logger: this.#logger,
                    policy: gate.policy,
                    budget,
                    now: this.#now,
                    ...(gate.realNow === undefined || gate.check.realNow !== undefined
                      ? {}
                      : { realNow: gate.realNow }),
                    onKeySilent: (key) => {
                      this.#keySilent(key);
                    },
                  }),
            scouting: new Set(),
            lookupsHeard: 0,
            lookupsToHelper: 0,
            // A second copy of `P-426`'s lane set (§1.8): the child has lanes enough for it.
            lanes: laneSet('helper', RESOLVER_LANES),
            urgentRunning: new Set(),
            tickMs: gate.tickMs ?? GATE_TICK_MS,
            realNow: gate.realNow ?? (() => performance.now()),
            suspects: new Set(),
            checkOnMs: 0,
            checkOnSince: undefined,
            passedStuck: 0,
            helperStuck: 0,
            route: gate.helper.routeState(),
            tick: undefined,
            lastSummaryAt: this.#now(),
            routed: { local: 0, helper: 0, probe: 0, faulted: 0, resting: 0 },
            checksFaulted: 0,
            riskPeak: 0,
            hourFrom: NO_COUNTS,
            helperHour: newHelperHour(),
            loaded: false,
          };
    // Past the longest hold, an answer's life and its grace: a name a scan still checks has been
    // asked within it.
    this.#countFailingMs = this.#holdMaxMs + this.#answerMs + this.#staleMs;
    // In gate mode the policy's files too (§1.12): gai.conf beside the three `P-438` watches.
    this.#watch = options.watch ?? {
      files: [...systemResolverFiles(), ...(gate?.policy.watchedFiles() ?? [])],
      everyMs: WATCH_EVERY_MS,
    };
  }

  /**
   * Starts looking at the hosts file, resolv.conf and nsswitch.conf. Its first look is the
   * baseline; a change after
   * it is acted on by `checkFiles`.
   */
  start(): void {
    this.#stopped = false;
    this.#startGate();
    this.#gate?.check?.start();
    if (this.#watchTimer !== undefined || this.#watch.files.length === 0) return;
    if (!this.#firstLooked) void this.checkFiles();
    this.#watchTimer = setInterval(() => void this.checkFiles(), this.#watch.everyMs);
    this.#watchTimer.unref();
  }

  /**
   * Stops the watch and gate mode's clock. A gate that was started says its summary for the hour so
   * far first (`P-463` fix round 2): the tick is the only other place it is said, so a stop would
   * otherwise lose up to an hour of `routed` and `checksFaulted`, and the helper's last `quiets`.
   * It is said before the helper stops, so what the stop itself fails is in no summary.
   */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#watchTimer);
    this.#watchTimer = undefined;
    if (this.#gate !== undefined) {
      if (this.#gate.tick !== undefined) {
        try {
          this.#summary(this.#gate, this.#now(), true);
        } catch (error: unknown) {
          this.#logger.error({ err: error }, 'the probe’s resolver failed on its last summary');
        }
      }
      clearInterval(this.#gate.tick);
      this.#gate.tick = undefined;
      this.#gate.check?.stop();
    }
    for (const timer of this.#windowTimers) clearTimeout(timer);
    this.#windowTimers.clear();
  }

  /**
   * Looks at the watched files once, by their contents, and acts on what changed since the last
   * look. Resolves true when something did. `start` calls it on a timer.
   *
   * **Not a cold start** (`P-426`'s review): an operator editing the hosts file in the middle of a
   * zone's outage is applying the usual fix, and dropping every answer then failed the zones that
   * still answer for as long as the silent zone's lookups held the lanes.
   * - **The hosts file**: only the names whose lines changed are dropped, so their next check asks
   *   `getaddrinfo`, which reads the file first. Every other name is as it was.
   * - **resolv.conf or nsswitch.conf**: every kept answer is due now, so it is served while one
   *   refresh asks under the new configuration, within the same grace as ever; denials and holds
   *   are let go. A name's failures in a row are kept, so a name that did not answer is asked again
   *   on the retry lane, and a silent zone cannot fill the lanes the answering ones are asked on. A
   *   lookup that ran under the old configuration is left to end and answers its own checks; its
   *   answer is kept, as already due, only for a name the new configuration has said nothing of and
   *   is not asking.
   * - **A rewrite with the same contents** changes nothing: a DHCP client renewing a lease does it.
   */
  async checkFiles(): Promise<boolean> {
    if (this.#watching) return false;
    this.#watching = true;
    try {
      const looked = await Promise.all(this.#watch.files.map((file) => this.#read(file)));
      const hostsChanged = new Set<string>();
      const readings: WatchedReading[] = [];
      let configChanged = false;
      let changed = false;
      for (const reading of looked) {
        if (this.#told.get(reading.file) !== reading.digest) {
          this.#told.set(reading.file, reading.digest);
          readings.push(reading);
        }
        const { file, text } = reading;
        // Unreadable this time for another reason than its absence: compared at the next look.
        if (text === undefined) continue;
        // An absent file and an empty one say the same to this resolver, as to glibc.
        const digest = text === '' ? '' : reading.digest;
        const seen = this.#seen.get(file);
        if (seen?.digest === digest) continue;
        const now = seenOf(file, text, digest);
        this.#seen.set(file, now);
        // The first look is the baseline.
        if (seen === undefined) continue;
        changed = true;
        if (isHostsFile(file)) {
          for (const name of namesChanged(seen.names, now.names)) hostsChanged.add(name);
        } else {
          configChanged = true;
        }
      }
      this.#view = viewOf(this.#seen);
      if (!changed) {
        await this.#loadPolicy(looked);
        await this.#tell(readings);
        return false;
      }

      let dropped = 0;
      if (hostsChanged.size > 0) {
        for (const [key, entry] of this.#entries) {
          if (!hostsChanged.has(hostsKey(entry.host))) continue;
          this.#forget(key, entry);
          dropped += 1;
        }
      }
      let due = 0;
      if (configChanged) {
        this.#generation += 1;
        const now = this.#now();
        for (const entry of this.#entries.values()) {
          if (entry.answer !== undefined && entry.answer.expiresAt > now) {
            entry.answer = { ...entry.answer, expiresAt: now };
            due += 1;
          }
          entry.denial = undefined;
          entry.hold = undefined;
          // A lookup running under the old configuration holds its lane until it ends, as it must,
          // but no longer stands for the name: the next check asks under the new one.
          if (entry.pending?.state === 'running') entry.pending = undefined;
        }
        // What the old configuration answered, or the answer file kept, says nothing of whether
        // the new one answers a domain (`P-438`): each is held to 3 first lanes until it does.
        // Nor does what hung under the old one.
        for (const count of this.#domains.values()) {
          count.answeredAt = undefined;
          count.answeredSeq = 0;
          count.slowSeq = 0;
          count.loaded.clear();
          count.stuckAt = undefined;
          count.stuckSeq = 0;
        }
        // Nor what the helper's keys said (§1.12): its lookups running count against no key.
        this.#gate?.keys.detachAll();
      }
      this.#logger.info(
        {
          files: this.#watch.files,
          namesChanged: hostsChanged.size,
          dropped,
          resolverConfigChanged: configChanged,
          answersDue: due,
        },
        'the hosts file, resolv.conf or nsswitch.conf changed: the names it moved are asked again',
      );
      // What held a queued lookup back may be gone: a domain's history, or a name not the file's.
      this.#pump();
      await this.#loadPolicy(looked);
      await this.#tell(readings);
      // The name check starts again from nothing (§1.12): proven, keys, skips and a stand-down.
      this.#gate?.check?.reset();
      if (this.#gate !== undefined) {
        this.#logger.info(
          { ...this.#gate.policy.describe() },
          'the name policy after the change: what the gate routes by',
        );
      }
      return true;
    } finally {
      this.#watching = false;
    }
  }

  /**
   * `watch.onLook`, told what this look read; its failure fails nothing here. In gate mode the
   * name policy is told first (§1.12), and a read-once file that moved skews the helper (D28).
   */
  async #tell(readings: readonly WatchedReading[]): Promise<void> {
    const gate = this.#gate;
    if (gate !== undefined) {
      try {
        this.#accrueCheckOn(gate, this.#now());
        this.#policyMoved(gate, await gate.policy.looked(readings));
      } catch (error: unknown) {
        this.#logger.error(
          { err: error, files: readings.map((reading) => reading.file) },
          'what a watched file says could not reach the name policy',
        );
      }
    }
    const onLook = this.#watch.onLook;
    if (onLook === undefined) return;
    try {
      await onLook(readings);
    } catch (error: unknown) {
      this.#logger.error({ err: error }, 'what a watched file says could not be passed on');
    }
  }

  /** A watched file as one look reads it: see `WatchedReading`. */
  async #read(file: string): Promise<WatchedReading> {
    try {
      const bytes = await readFile(file);
      return { file, text: bytes.toString('utf8'), digest: digestOf(bytes) };
    } catch (error: unknown) {
      const text = codeOf(error) === 'ENOENT' ? '' : undefined;
      return { file, text, digest: digestOfError(error) };
    }
  }

  /**
   * The answers kept, for the probe's answer file (`P-438`): most recently asked first, read a
   * slice at a time so that saving them never holds the event loop, each slice at the clock when
   * it is taken. Not a name the hosts file lists for its family (`hostsLists`), whatever
   * nsswitch.conf is read to say of the order (`P-432` S3's review): `getaddrinfo` may answer it
   * from the file, and the file may change before the next start. None past its grace either.
   */
  answersToSave(): { take(count: number): KeptAnswer[] } {
    const entries = [...this.#entries.values()].reverse();
    const view = this.#view;
    let at = 0;
    return {
      take: (count) => {
        const now = this.#now();
        const taken: KeptAnswer[] = [];
        while (at < entries.length && taken.length < count) {
          const entry = entries[at];
          at += 1;
          const answer = entry?.answer;
          // Forgotten since the slice began, or nothing kept for it.
          if (entry === undefined || answer === undefined) continue;
          if (this.#entries.get(entry.key) !== entry) continue;
          if (now >= answer.expiresAt + this.#staleMs) continue;
          if (hostsLists(view, entry.host, entry.family)) continue;
          taken.push({
            host: entry.host,
            family: entry.family,
            addresses: answer.addresses,
            answeredAgoMs: now - answer.answeredAt,
            expiresInMs: answer.expiresAt - now,
          });
        }
        return taken;
      },
    };
  }

  /**
   * Answers from the probe's answer file, kept before the first check asks (`P-438`), most
   * recently asked first as `answersToSave` gives them. Each is kept as expired, whatever was
   * left of it, so the first check of its name is served it while a refresh asks again, as an
   * expired answer always is, and never past its grace: what the probe answers after a restart
   * is asked again, and what it was served meanwhile is what it had. Not kept: a name the hosts
   * file lists now for its family (`hostsLists`, the files read now, since the first look may not
   * have been), whatever nsswitch.conf is read to say of the order, a name already kept, one past
   * its grace, and any over `maxEntries`. Each one kept
   * counts its domain as answering until a lookup for its name settles, and never past its own
   * grace, so the domain may take all 4 first lanes before any of its names is asked again.
   */
  async restore(answers: Iterable<KeptAnswer>): Promise<RestoreCounts> {
    const looked: [string, Seen][] = [];
    for (const file of this.#watch.files) {
      if (!isHostsFile(file) && !isNsswitch(file)) continue;
      looked.push([file, seenOf(file, (await this.#read(file)).text ?? '')]);
    }
    const view = viewOf(looked);
    const counts = { loaded: 0, pastGrace: 0, hostsFile: 0, duplicate: 0, overCap: 0, invalid: 0 };
    const now = this.#now();
    const taken: { readonly key: string; readonly answer: KeptAnswer }[] = [];
    const seen = new Set<string>();
    for (const answer of answers) {
      const host = answer.host.trim().toLowerCase();
      const key = `${String(answer.family)}:${host}`;
      if (
        host === '' ||
        isIP(host) !== 0 ||
        answer.addresses.length === 0 ||
        answer.addresses.length > this.#maxAddresses
      ) {
        counts.invalid += 1;
      } else if (seen.has(key) || this.#entries.has(key)) {
        counts.duplicate += 1;
      } else if (answer.expiresInMs + this.#staleMs <= 0) {
        counts.pastGrace += 1;
      } else if (hostsLists(view, host, answer.family)) {
        counts.hostsFile += 1;
      } else if (taken.length + this.#entries.size >= this.#maxEntries) {
        counts.overCap += 1;
      } else {
        seen.add(key);
        taken.push({ key, answer: { ...answer, host } });
      }
    }
    // Least recently asked first, as the entries are kept.
    for (const { key, answer } of taken.reverse()) {
      const entry = this.#add(key, answer.host, answer.family);
      const answeredAt = now - answer.answeredAgoMs;
      // Expired now at the latest, its grace from its own expiry or from now, whichever is
      // sooner: never longer than it had.
      const expiresAt = Math.min(now + answer.expiresInMs, now);
      entry.answer = {
        addresses: answer.addresses.map(({ address, family }) => ({ address, family })),
        answeredAt,
        expiresAt,
      };
      entry.lastAnsweredAt = answeredAt;
      // Not for a name the hosts file lists for its family, which says nothing of DNS (L1).
      if (!hostsLists(view, answer.host, answer.family)) {
        this.#domains.get(entry.domain)?.loaded.add(entry);
      }
      counts.loaded += 1;
    }
    return counts;
  }

  /** In gate mode, both lane sets: every lookup asked for is in flight, wherever it runs. */
  stats(): NameResolverStats {
    const gate = this.#gate;
    const running =
      this.#probeRunning().length + (gate === undefined ? 0 : helperRunning(gate).length);
    return { running, queued: this.#queuedCount(), entries: this.#entries.size };
  }

  /**
   * A `ResolveHost` for the main thread's own callers (discovery's identification): the same cache
   * and lanes as a worker's request, counted here rather than where the caller waits.
   */
  readonly resolveHost: ResolveHost = (host, family, options?: ResolveOptions) =>
    countedElsewhere(this.resolve(host, family, options ?? {}));

  /** The answer for a name, or a rejection carrying the resolver's code and words. */
  resolve(
    host: string,
    family: Family,
    request: { readonly waitMs?: number; readonly fresh?: boolean },
  ): Promise<readonly ResolvedAddress[]> {
    let asked: Asked;
    try {
      asked = this.#ask(host, family, request);
    } catch (error: unknown) {
      return Promise.reject(this.#fault(error, host));
    }
    const outcome = 'now' in asked ? Promise.resolve(asked.now) : asked.later;
    return outcome.then((settled) => {
      if (settled === undefined) {
        throw Object.assign(
          new Error(`the probe’s resolver had not answered ${host} when the check stopped waiting`),
          { code: RESOLVER_LATE },
        );
      }
      if (settled.ok) return settled.addresses;
      throw Object.assign(new Error(settled.message), { code: settled.code });
    });
  }

  /**
   * A worker's request, answered on its port (`P-426`): at once when the answer is known, and
   * otherwise acknowledged at once and answered when it is, or never if the worker's check stopped
   * waiting first (the worker settles that itself). **Nothing here may throw into the pool**: a
   * fault in this code fails the one lookup, saying so, and is logged.
   */
  handle(request: unknown, post: (message: ResolveAck | ResolveReply) => void): void {
    const id = (request as { id?: unknown } | null)?.id;
    if (typeof id !== 'number') return;
    // A worker gone since it asked is the pool's business: nothing posted here may throw.
    const send = (message: ResolveAck | ResolveReply): void => {
      try {
        post(message);
      } catch (error: unknown) {
        this.#logger.warn(
          { err: error, id },
          'a lookup’s answer could not be posted to its worker',
        );
      }
    };
    const reply = (outcome: ResolveOutcome): void => {
      send({ type: 'resolved', id, ...outcome });
    };
    try {
      const { host, family, waitMs, fresh } = request as {
        host?: unknown;
        family?: unknown;
        waitMs?: unknown;
        fresh?: unknown;
      };
      if (
        typeof host !== 'string' ||
        host.length > 1_024 ||
        (family !== 0 && family !== 4 && family !== 6)
      ) {
        reply(failure(RESOLVER_FAULT, 'the probe’s resolver was sent a request it cannot read'));
        return;
      }
      const asked = this.#ask(host, family, {
        ...(typeof waitMs === 'number' ? { waitMs } : {}),
        fresh: fresh === true,
      });
      if ('now' in asked) {
        reply(asked.now);
        return;
      }
      send({ type: 'resolve-ack', id });
      asked.later.then(
        (outcome) => {
          if (outcome !== undefined) reply(outcome);
        },
        (error: unknown) => {
          const fault = this.#fault(error, host);
          reply(failure(RESOLVER_FAULT, fault.message));
        },
      );
    } catch (error: unknown) {
      const fault = this.#fault(error, String((request as { host?: unknown }).host));
      reply(failure(RESOLVER_FAULT, fault.message));
    }
  }

  #fault(error: unknown, host: string): Error {
    this.#logger.error({ err: error, host }, 'the probe’s resolver failed on a lookup');
    return Object.assign(
      new Error(
        `the probe’s resolver failed on ${host}: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { code: RESOLVER_FAULT },
    );
  }

  /** What a check asking for a name gets: now, or once a lookup settles. */
  #ask(
    rawHost: string,
    family: Family,
    request: { readonly waitMs?: number; readonly fresh?: boolean },
  ): Asked {
    const host = rawHost.trim().toLowerCase();
    const literal = isIP(host);
    if (literal !== 0)
      return { now: { ok: true, addresses: [{ address: host, family: literal }] } };
    if (host === '') return { now: failure('ENOTFOUND', 'an empty name resolves to nothing') };

    const now = this.#now();
    this.#expireFailing(now);
    const entry = this.#touch(`${String(family)}:${host}`, host, family, now);
    const fresh = request.fresh === true;
    if (entry.answer !== undefined && now >= entry.answer.expiresAt + this.#staleMs) {
      entry.answer = undefined;
      // Past its grace, a loaded answer no longer stands for its domain either (`P-438`).
      this.#unload(entry);
    }
    if (entry.denial !== undefined && now >= entry.denial.until) entry.denial = undefined;

    if (!fresh) {
      const answer = entry.answer;
      if (answer !== undefined && now < answer.expiresAt) {
        return { now: { ok: true, addresses: answer.addresses } };
      }
      if (entry.denial !== undefined) {
        return { now: failure(entry.denial.code, entry.denial.message) };
      }
      if (answer !== undefined) {
        // Expired and within the grace: served now, and refreshed behind it.
        this.#background(entry, now);
        return { now: { ok: true, addresses: answer.addresses } };
      }
    }

    // A held name fails at once. "Check now" asks again even so, ahead of every queued lookup,
    // unless a lookup for it is already stuck: it is how an operator sees that a DNS fix has taken.
    if (entry.pending?.stuck === true || (!fresh && this.#holding(entry, now))) {
      return { now: this.#unanswered(entry, fresh, now, RESOLVER_HELD) };
    }

    let pending = entry.pending;
    if (pending === undefined) {
      // Gate mode: a poison name, or one the probe's own `getaddrinfo` must not be asked for while
      // the helper cannot (§1.3 row 0).
      const refusal = this.#gateRefusal(entry);
      if (refusal !== undefined) {
        if (this.#gate !== undefined) this.#gate.routed.faulted += 1;
        return { now: this.#refusedNow(entry, fresh, now, refusal) };
      }
      pending = this.#start(
        entry,
        fresh || entry.failures === 0 ? 'first' : 'retry',
        fresh,
        boundOf(request.waitMs),
      );
    } else if (fresh && pending.state === 'queued') {
      this.#promote(pending);
    } else if (fresh && pending.state === 'scouting') {
      // Queued once its walk has a verdict, ahead of every other, as `#promote` puts it.
      pending.cls = 'first';
      pending.urgent = true;
    }
    if (pending === undefined) {
      return {
        now: this.#unanswered(
          entry,
          fresh,
          now,
          RESOLVER_FULL,
          `the probe’s resolver already has ${String(this.#queuedCount())} lookups queued, its most`,
        ),
      };
    }
    // A lookup held back only by time, its domain's `STUCK_MS` window now over, takes a free lane
    // here, rather than its check failing for lanes it need not wait for (`P-438`'s narrow check).
    if (pending.state === 'queued') this.#pump();
    // Gate mode: refused as one of the pumps above would have started it (`#offProbe`, D27), and
    // settled then, with its checks told why, before this one had joined them. It is told now, as
    // they were; it would otherwise wait on a settled lookup for its whole bound (`RESOLVER_LATE`).
    // Counted as a check refused, not as a lookup again: `#offProbe` counted the lookup.
    if (pending.refused !== undefined) {
      return { now: this.#refusedNow(entry, fresh, now, pending.refused) };
    }
    // Gate mode: a name DNS did not answer, while the helper that alone may ask it is down.
    const refused = pending.state === 'queued' ? this.#silentRefusal(pending) : undefined;
    if (refused !== undefined) {
      return { now: this.#unanswered(entry, fresh, now, RESOLVER_FAULT, refused) };
    }
    if (pending.state === 'queued' && this.#lanesStuck(pending)) {
      return {
        now: this.#unanswered(entry, fresh, now, RESOLVER_STUCK, this.#stuckWhy(pending)),
      };
    }
    return { later: this.#wait(pending, fresh, request.waitMs) };
  }

  /**
   * A name's entry, made if new, and moved to the most recently asked end. A failing name asked
   * about counts against its domain from now, again if it had stopped.
   */
  #touch(key: string, host: string, family: Family, now: number): Entry {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      if (existing.failures > 0) this.#count(existing, now);
      return existing;
    }
    return this.#add(key, host, family);
  }

  /** A new entry, at the most recently asked end, and in its domain's count. */
  #add(key: string, host: string, family: Family): Entry {
    const entry: Entry = {
      key,
      host,
      family,
      domain: domainOf(host),
      answer: undefined,
      denial: undefined,
      hold: undefined,
      failures: 0,
      lastAnsweredAt: undefined,
      lastRanMs: undefined,
      pending: undefined,
      suspect: false,
    };
    this.#entries.set(key, entry);
    const domain = this.#domains.get(entry.domain) ?? {
      names: 0,
      failing: 0,
      answeredAt: undefined,
      answeredSeq: 0,
      slowSeq: 0,
      loaded: new Set<Entry>(),
      stuckAt: undefined,
      stuckSeq: 0,
    };
    domain.names += 1;
    this.#domains.set(entry.domain, domain);
    if (this.#entries.size > this.#maxEntries) {
      // The least recently asked for that has no lookup on its way. A name with one is kept for
      // its answer; the bound is then over by at most the lookups queued and running.
      for (const [oldKey, old] of this.#entries) {
        if (old.pending === undefined && old !== entry) {
          this.#forget(oldKey, old);
          break;
        }
      }
    }
    return entry;
  }

  /** A name no longer kept: out of the entries, and out of its domain's counts. */
  #forget(key: string, entry: Entry): void {
    if (this.#entries.get(key) !== entry) return;
    this.#uncount(entry);
    this.#unload(entry);
    this.#entries.delete(key);
    const domain = this.#domains.get(entry.domain);
    if (domain === undefined) return;
    domain.names -= 1;
    if (domain.names <= 0) this.#domains.delete(entry.domain);
  }

  /**
   * Why a queued first lookup must wait though its class may run another (`P-438`), or undefined
   * when it need not: `P-432`'s lane rule (`mayStart`, here `heldBy` for why), with the domain's
   * load (`firstLoad`) and `probeFirstRule`. Its domain may hold `#firstRule.cappedLanes` first
   * lanes while it has a lookup stuck lately: one ended stuck lately (`stuckLately`), or one in
   * flight silent so far (`silentSoFar`): `cappedLanes` when it holds them; and otherwise
   * `#firstRule.unacked` unless it is known to answer (`#answering`): `unacked` when it holds them.
   * Either way the lookup waits for one of its domain's to end. And `shared` when it has a lookup
   * stuck lately and this would take the last shared lane, counting as taken every lane the
   * refreshes running and queued may hold, since a lane freed goes to a first lookup before a
   * refresh: that lane is left to the other domains. "Check now" waits for neither, nor does a
   * name the hosts file gives for its family (`hostsGive`): the operator's fix for a device of a
   * silent zone is asked at its next check.
   */
  #heldBack(pending: Pending): HeldBy | undefined {
    if (pending.cls !== 'first' || pending.urgent || pending.pool !== 'probe') return undefined;
    const entry = pending.entry;
    if (hostsGive(this.#view, entry.host, entry.family)) return undefined;
    const load = firstLoad({
      domain: entry.domain,
      history: this.#domains.get(entry.domain),
      now: this.#now(),
      stuckMs: this.#stuckMs,
      running: this.#probe.running,
      refreshQueued: this.#probe.queues.refresh.length,
      refreshCap: this.#refreshCap,
      // Gate mode (D24): the domain's helper lookups the child said are stuck cap it too.
      helperStuck: this.#gate === undefined ? 0 : this.#helperStuckOf(this.#gate, entry.domain),
      answering: this.#answeringOf,
    });
    return heldBy(load, this.#firstRule);
  }

  /**
   * Whether one of a domain's names has answered from DNS under the current configuration within
   * the last `ANSWER_MS`, or holds an answer the answer file gave that no lookup has settled
   * since, within that answer's own grace (`P-438`). One past its grace is let go here.
   */
  #answering(count: DomainCount, now: number): boolean {
    if (count.answeredAt !== undefined && now - count.answeredAt < this.#answerMs) return true;
    for (const entry of count.loaded) {
      const answer = entry.answer;
      if (answer !== undefined && now < answer.expiresAt + this.#staleMs) return true;
      count.loaded.delete(entry);
    }
    return false;
  }

  /** A lookup of a domain ended stuck without an answer, under the current configuration. */
  #endedStuck(entry: Entry, now: number): void {
    const count = this.#domains.get(entry.domain);
    if (count === undefined) return;
    count.stuckAt = now;
    this.#events += 1;
    count.stuckSeq = this.#events;
    // The queue is looked at again when the `STUCK_MS` after it is over (`P-438`'s narrow check):
    // the one thing that lets a held-back lookup go with no lookup starting or ending, so without
    // it one no longer held sat queued beside a free lane until one did, and its checks failed. A
    // timer for each such end: each took a lane past `STUCK_MS`, so there are never more than the
    // lanes at once.
    const timer = setTimeout(() => {
      this.#windowTimers.delete(timer);
      this.#pump();
    }, this.#stuckMs);
    timer.unref();
    this.#windowTimers.add(timer);
  }

  /** A loaded answer no longer counting its domain as answering: a lookup for it settled. */
  #unload(entry: Entry): void {
    this.#domains.get(entry.domain)?.loaded.delete(entry);
  }

  /** The first lookups running of a pending lookup's domain: what one held back waits for. */
  #domainRunning(pending: Pending): Pending[] {
    return [...this.#probe.running.first].filter(
      (running) => running.entry.domain === pending.entry.domain,
    );
  }

  /** A name's failures in a row, and whether it counts against its domain. */
  #setFailures(entry: Entry, failures: number, now: number): void {
    entry.failures = failures;
    if (failures > 0) this.#count(entry, now);
    else this.#uncount(entry);
  }

  /** A failing name counted against its domain from now: again if it had stopped, moved if not. */
  #count(entry: Entry, now: number): void {
    // A name already forgotten is in no count.
    if (this.#entries.get(entry.key) !== entry) return;
    if (!this.#failing.delete(entry)) {
      const domain = this.#domains.get(entry.domain);
      if (domain === undefined) return;
      domain.failing += 1;
      this.#failingNames += 1;
    }
    this.#failing.set(entry, now);
  }

  /** A name no longer counted against its domain: answering, forgotten, or not asked about. */
  #uncount(entry: Entry): void {
    if (!this.#failing.delete(entry)) return;
    const domain = this.#domains.get(entry.domain);
    if (domain !== undefined) domain.failing -= 1;
    this.#failingNames -= 1;
  }

  /**
   * Lets go of the failing names no check has asked about, and that have not failed again, for
   * `#countFailingMs` (`P-426`'s second review): a dead zone's deleted devices would otherwise
   * rank a device added there later behind every other for good, and keep the ranking running on
   * every pick. Their failures in a row are kept: asked again, a name is a retry as before.
   */
  #expireFailing(now: number): void {
    const before = now - this.#countFailingMs;
    for (const [entry, at] of this.#failing) {
      if (at > before) return;
      this.#uncount(entry);
    }
  }

  /**
   * How much of a name's domain is failing, the name's own failure left out (`P-426`'s second
   * review): a name held once is no failing zone, whether its domain is its own or a large one
   * with a few names failing.
   */
  #failingShare(entry: Entry): number {
    const count = this.#domains.get(entry.domain);
    if (count === undefined || count.names <= 0) return 0;
    const others = count.failing - (this.#failing.has(entry) ? 1 : 0);
    return Math.max(0, others) / count.names;
  }

  #holding(entry: Entry, now: number): boolean {
    return entry.hold !== undefined && now < entry.hold.until;
  }

  #held(entry: Entry, now: number): boolean {
    return entry.pending?.stuck === true || this.#holding(entry, now);
  }

  /**
   * What a check gets when the resolver has not answered its name: for "Check now", the answer
   * kept for it, if it has one within the grace, saying so; otherwise a failure naming why.
   */
  #unanswered(
    entry: Entry,
    fresh: boolean,
    now: number,
    code: string,
    why: string = this.#why(entry, now),
  ): ResolveOutcome {
    const answer = entry.answer;
    if (fresh && answer !== undefined && now < answer.expiresAt + this.#staleMs) {
      return {
        ok: true,
        addresses: answer.addresses,
        note:
          `the probe’s resolver did not answer for ${entry.host} (${why}), so this check used ` +
          `the address it answered ${seconds(now - answer.answeredAt)} ago`,
      };
    }
    return failure(code, why);
  }

  /**
   * A check the gate refuses as it asks (§1.3 row 0, D27): told as `#unanswered` tells it, and
   * counted in `checksFaulted` when it fails, not when "Check now" is served its kept answer.
   */
  #refusedNow(entry: Entry, fresh: boolean, now: number, why: string): ResolveOutcome {
    const told = this.#unanswered(entry, fresh, now, RESOLVER_FAULT, why);
    if (!told.ok && this.#gate !== undefined) this.#gate.checksFaulted += 1;
    return told;
  }

  /**
   * A lookup the gate refuses on its way to a lane (§1.3 row 0, D27): settled with `RESOLVER_FAULT`
   * and counted once in `routed.faulted`, however many checks wait for it, none among them; each
   * check it fails counts in `checksFaulted` as it is told (`#settle`).
   */
  #refuse(gate: Gate, pending: Pending, why: string): void {
    gate.routed.faulted += 1;
    this.#settle(pending, { passed: { code: RESOLVER_FAULT, why }, refused: true });
  }

  /** Why a queued lookup's check fails at once: the lanes it could take, and theirs. */
  #stuckWhy(pending: Pending): string {
    const gate = this.#gate;
    if (pending.pool === 'helper' && gate !== undefined) {
      const block = this.#helperBlocked(gate, pending);
      if (block !== undefined) return this.#helperWhy(gate, pending, block);
    }
    const host = pending.entry.host;
    const lanes = this.#blockers(pending)
      .slice(0, 3)
      .map((blocker) => blocker.entry.host);
    const held = this.#heldBack(pending);
    const rule = this.#firstRule;
    // The limit that held it, named as `heldBy` found it: a capped domain's, or the one a domain
    // not known to answer is held to.
    const whose =
      held === 'cappedLanes'
        ? `, its own domain’s, which holds the ${String(rule.cappedLanes)} first lanes a domain ` +
          `may while one of its lookups has`
        : held === 'unacked'
          ? `, its own domain’s, which holds the ${String(rule.unacked)} first lanes a domain ` +
            `may while none of its names has answered within ${seconds(this.#answerMs)}`
          : held === 'lanes'
            ? `, its own domain’s, which holds the ${String(rule.lanes)} first lanes a domain may`
            : held === 'shared'
              ? ', and the one lane left is kept for other domains while its own domain has a ' +
                'lookup stuck lately'
              : '';
    return (
      `every lane a lookup for ${host} could use is held by a lookup that has run past ` +
      `${String(this.#stuckMs)} ms (${lanes.join(', ')})${whose}; it stays queued`
    );
  }

  #why(entry: Entry, now: number): string {
    const pending = entry.pending;
    if (pending?.stuck === true) {
      return `a lookup for ${entry.host} has run ${seconds(now - pending.startedAt)} without an answer`;
    }
    const hold = entry.hold;
    if (hold !== undefined && now < hold.until) {
      return `${entry.host} is held for ${seconds(hold.until - now)} more: ${hold.why}`;
    }
    return `getaddrinfo said EAI_AGAIN for ${entry.host}`;
  }

  /** A refresh, or a held name's retry, that nobody waits for. Not when one is on its way. */
  #background(entry: Entry, now: number): void {
    if (entry.pending !== undefined || this.#held(entry, now)) return;
    if (this.#gateRefusal(entry) !== undefined) return;
    const pending = this.#start(entry, entry.failures > 0 ? 'retry' : 'refresh');
    if (pending === undefined) {
      this.#logger.warn(
        { host: entry.host, queued: this.#queuedCount() },
        'the probe’s resolver queue is full: a refresh was not queued',
      );
    }
  }

  #queuedCount(): number {
    const gate = this.#gate;
    return (
      queuedIn(this.#probe) + (gate === undefined ? 0 : queuedIn(gate.lanes) + gate.scouting.size)
    );
  }

  /** The lane set a lookup is queued on or runs on. */
  #setOf(pending: Pending): LaneSet {
    return pending.pool === 'helper' && this.#gate !== undefined ? this.#gate.lanes : this.#probe;
  }

  /** The running set a lookup is in while it runs: "Check now"'s in the helper are apart. */
  #runningOf(pending: Pending): Set<Pending> {
    const gate = this.#gate;
    if (pending.pool === 'helper' && gate !== undefined) {
      return pending.urgent ? gate.urgentRunning : gate.lanes.running[pending.cls];
    }
    return this.#probe.running[pending.cls];
  }

  /**
   * A new lookup for an entry, queued and started if a lane is free; undefined if full. In gate
   * mode with the name check built, its walk decides where (§1.3): at once when it need not walk,
   * and otherwise the lookup scouts, in no queue, until its walk's verdict (`#scouted`).
   */
  #start(entry: Entry, cls: LaneClass, urgent = false, boundMs?: number): Pending | undefined {
    const gate = this.#gate;
    const check = gate?.check;
    // A name the probe's own getaddrinfo must not be asked for is outside the check (D27): it goes
    // as S3 sends it, unvouched, to the helper while the helper can ask it.
    const avoided = gate !== undefined && this.#avoided(gate, entry);
    if (
      gate !== undefined &&
      check !== undefined &&
      !urgent &&
      !avoided &&
      gate.helper.routeState() !== 'resting' &&
      // A full queue walks nothing: the lookup goes unwalked, queued only if it can run now.
      this.#queuedCount() < this.#maxQueued
    ) {
      const pending = this.#pendingFor(entry, cls, urgent, 'helper', 'unvouched');
      const verdict = this.#checkRoute(check, pending, cls, boundMs);
      if (verdict instanceof Promise) {
        pending.state = 'scouting';
        pending.walked = true;
        entry.pending = pending;
        gate.scouting.add(pending);
        verdict.then(
          (routed) => {
            this.#scouted(gate, pending, routed);
          },
          (error: unknown) => {
            this.#logger.error(
              { err: error, host: entry.host },
              'the name check failed on a lookup',
            );
            this.#scouted(gate, pending, {
              route: 'unvouched',
              key: pending.key,
              why: 'cannotVouch',
            });
          },
        );
        return pending;
      }
      pending.pool = this.#poolFor(gate, verdict.route);
      entry.pending = pending;
      this.#routed(gate, pending, verdict);
      this.#enqueue(pending);
      return pending;
    }
    const route =
      gate === undefined || avoided ? ('unvouched' as const) : this.#routeOf(gate, entry);
    const pool = gate === undefined ? 'probe' : this.#poolFor(gate, route);
    const set = pool === 'helper' && gate !== undefined ? gate.lanes : this.#probe;
    if (this.#queuedCount() >= this.#maxQueued && !this.#canRun(set, cls)) return undefined;
    const pending = this.#pendingFor(entry, cls, urgent, pool, route);
    entry.pending = pending;
    if (gate !== undefined) this.#routed(gate, pending, undefined);
    this.#enqueue(pending);
    return pending;
  }

  /** A lookup not yet queued. */
  #pendingFor(
    entry: Entry,
    cls: LaneClass,
    urgent: boolean,
    pool: Pool,
    route: GateRoute,
  ): Pending {
    const gate = this.#gate;
    return {
      entry,
      cls,
      urgent,
      state: 'queued',
      startedAt: 0,
      generation: this.#generation,
      startedSeq: 0,
      stuck: false,
      stuckTimer: undefined,
      waiters: new Set(),
      pool,
      route,
      key: gate === undefined ? '' : candidateKey(entry.host),
      walkKeys: [],
      miss: undefined,
      silent: undefined,
      walked: false,
      token: undefined,
      detached: false,
      suspect: pool === 'helper' && entry.suspect,
      poisonAsk: false,
      refused: undefined,
      untokened: false,
      ungated: false,
      armedAt: 0,
    };
  }

  /** What the name check makes of a lookup (§1.3): never throws, an unvouched route at worst. */
  #checkRoute(
    check: DnsCheck,
    pending: Pending,
    cls: LaneClass,
    boundMs: number | undefined,
  ): CheckRoute | Promise<CheckRoute> {
    const entry = pending.entry;
    const now = this.#now();
    try {
      return check.route({
        host: entry.host,
        family: entry.family,
        refresh: cls === 'refresh' && entry.failures === 0,
        known:
          entry.answer !== undefined ||
          (entry.lastAnsweredAt !== undefined && now - entry.lastAnsweredAt <= this.#staleMs),
        lastRanMs: entry.lastRanMs,
        boundMs,
        ref: pending,
      });
    } catch (error: unknown) {
      this.#logger.error({ err: error, host: entry.host }, 'the name check failed on a name');
      return { route: 'unvouched', key: pending.key, why: 'cannotVouch' };
    }
  }

  /** A route taken: what it says of the lookup, counted and logged (debug, S-F10). */
  #routed(gate: Gate, pending: Pending, verdict: CheckRoute | undefined): void {
    if (verdict !== undefined) {
      pending.route = verdict.route;
      pending.key = verdict.key;
      if (verdict.route === 'heard') pending.walkKeys = verdict.keys;
      if (verdict.route === 'silent') {
        pending.miss = verdict.miss;
        pending.silent = verdict.evidence;
      }
    }
    const { entry, pool, route } = pending;
    gate.routed[pool === 'helper' ? 'helper' : route === 'local' ? 'local' : 'probe'] += 1;
    if (gate.helper.routeState() === 'resting') gate.routed.resting += 1;
    this.#logger.debug(
      {
        host: entry.host,
        family: entry.family,
        route,
        key: pending.key,
        pool,
        ...(verdict?.route === 'unvouched' ? { why: verdict.why } : {}),
      },
      'routed a lookup',
    );
  }

  /** Queues a lookup on its lane set, and pumps. */
  #enqueue(pending: Pending): void {
    const set = this.#setOf(pending);
    if (pending.urgent) set.urgentQueued += 1;
    set.queues[pending.cls].push(pending);
    this.#pump();
  }

  /**
   * A walk's verdict for a lookup that scouted (§1.4): queued where it says, and its checks told
   * at once what a check asking now would be told, a silent name while the helper is down or
   * lanes every one stuck. Once the probe is stopping, one with no helper to ask it is settled,
   * and so is an avoided name, whatever its pool (D27).
   */
  #scouted(gate: Gate, pending: Pending, walked: CheckRoute): void {
    gate.scouting.delete(pending);
    if (pending.state !== 'scouting') return;
    pending.state = 'queued';
    const entry = pending.entry;
    // Judged again as the ask was (§1.3 row 0): the walk took time, and a crash in it, a rest or
    // the helper going down may have made the name one the probe's own getaddrinfo must not ask.
    // Once stopped, an avoided name is settled whatever its pool: a verdict that comes after the
    // stop would otherwise queue it on the probe's lanes while the helper is down or resting.
    const refusal = this.#stopped
      ? this.#avoided(gate, entry)
        ? stopping(entry.host)
        : undefined
      : this.#gateRefusal(entry);
    if (refusal !== undefined) {
      this.#refuse(gate, pending, refusal);
      return;
    }
    // Avoided, and not refused: the helper can ask it, and alone may (D27). A walk's verdict is
    // never `sampled`, which is routed at once, so no sample is out for it.
    const verdict: CheckRoute =
      this.#poolFor(gate, walked.route) === 'probe' && this.#avoided(gate, entry)
        ? { route: 'unvouched', key: walked.key, why: 'avoided' }
        : walked;
    pending.pool = this.#poolFor(gate, verdict.route);
    this.#routed(gate, pending, verdict);
    if (this.#stopped && pending.pool === 'helper' && gate.helper.routeState() !== 'up') {
      this.#settle(pending, { passed: { code: RESOLVER_FAULT, why: stopping(entry.host) } });
      return;
    }
    this.#enqueue(pending);
    // Read through a call: the pump may have started it, which a narrowed read would hide.
    if (stateOf(pending) !== 'queued' || pending.waiters.size === 0) return;
    const now = this.#now();
    const refused = this.#silentRefusal(pending);
    if (refused === undefined && !this.#lanesStuck(pending)) return;
    for (const waiter of [...pending.waiters]) {
      const outcome =
        refused === undefined
          ? this.#unanswered(
              pending.entry,
              waiter.fresh,
              now,
              RESOLVER_STUCK,
              this.#stuckWhy(pending),
            )
          : this.#unanswered(pending.entry, waiter.fresh, now, RESOLVER_FAULT, refused);
      this.#deliver(pending, waiter, outcome);
    }
  }

  /**
   * Why a queued lookup DNS did not answer fails its checks at once (§1.11): the helper, which alone
   * may ask it, is down. It stays queued for the helper. Undefined otherwise.
   */
  #silentRefusal(pending: Pending): string | undefined {
    const gate = this.#gate;
    if (gate === undefined || pending.route !== 'silent' || pending.pool !== 'helper')
      return undefined;
    if (gate.helper.routeState() !== 'down') return undefined;
    return (
      `the probe could not ask getaddrinfo for ${pending.entry.host}: its lookup helper is not ` +
      `answering, and ${this.#silentWords(pending)}, so it is asked only in the helper; it stays ` +
      `queued`
    );
  }

  /** What a silent route rests on, in words: the name's own step, or its zone's silence before. */
  #silentWords(pending: Pending): string {
    const evidence = pending.silent;
    if (evidence?.kind === 'asked') {
      return `no DNS server answered the name within ${String(evidence.waitMs)} ms`;
    }
    const zone = pending.key.startsWith('d:')
      ? `its zone ${keyWords(pending.key)}`
      : `the name ${keyWords(pending.key)}`;
    // No evidence of its own: a sampled lookup moved when its zone stopped answering every name.
    if (evidence === undefined) {
      return `${zone} stopped answering every name the check asks, and the name was not asked`;
    }
    return (
      `${zone} did not answer the check ${seconds(this.#now() - evidence.since)} ago, and the ` +
      `name was not asked`
    );
  }

  /**
   * A key the check found silent or mixed (D20): its sampled lookups still queued on the probe's
   * lanes move to the helper as silent, unless it rests.
   */
  #keySilent(key: string): void {
    const gate = this.#gate;
    if (gate === undefined || gate.helper.routeState() === 'resting') return;
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      for (const pending of [...this.#probe.queues[cls]]) {
        if (pending.route !== 'sampled' || pending.key !== key) continue;
        this.#unqueue(pending);
        gate.check?.sampledEnded(key, pending);
        pending.route = 'silent';
        pending.pool = 'helper';
        gate.lanes.queues[cls].push(pending);
        if (pending.urgent) gate.lanes.urgentQueued += 1;
        const refused = this.#silentRefusal(pending);
        if (refused === undefined) continue;
        const now = this.#now();
        for (const waiter of [...pending.waiters]) {
          this.#deliver(
            pending,
            waiter,
            this.#unanswered(pending.entry, waiter.fresh, now, RESOLVER_FAULT, refused),
          );
        }
      }
    }
    this.#pump();
  }

  /**
   * "Check now" joining a lookup still queued: moved to the first lookups' lanes, ahead of every
   * other, so that it never waits behind held names' retries. In the helper it becomes urgent
   * there, and takes an urgent token when one is free (§1.3).
   */
  #promote(pending: Pending): void {
    const set = this.#setOf(pending);
    const queue = set.queues[pending.cls];
    const at = queue.indexOf(pending);
    if (at === -1) return;
    queue.splice(at, 1);
    pending.cls = 'first';
    if (!pending.urgent) {
      pending.urgent = true;
      set.urgentQueued += 1;
    }
    set.queues.first.push(pending);
    this.#pump();
  }

  /**
   * The queued lookup a free lane of this class takes: "Check now"'s first, then the name whose
   * domain has the least of its names failing, its own failure left out, then, among retries, the
   * name with the fewest failures in a row and then the one that answered most recently, then the
   * oldest. With nothing failing and no "Check now", the oldest. Never one `mayTake` refuses: on
   * the probe's lanes a first lookup held back (`P-438`), in the helper one its admission refuses
   * (§1.8). Undefined when every one queued is refused.
   */
  #takeNext(
    set: LaneSet,
    cls: LaneClass,
    mayTake: (pending: Pending) => boolean,
  ): Pending | undefined {
    const queue = set.queues[cls];
    // A first lookup whose domain holds all it may, or that would take the last shared lane from
    // the other domains, waits (`P-438`).
    let best = queue.findIndex(mayTake);
    if (best === -1) return undefined;
    if (queue.length > 1 && (this.#failingNames > 0 || set.urgentQueued > 0)) {
      let bestRank: number[] | undefined;
      for (const [index, pending] of queue.entries()) {
        // Those before the first that may run are each held back.
        if (index < best || (index > best && !mayTake(pending))) continue;
        const entry = pending.entry;
        const rank = [
          pending.urgent ? 0 : 1,
          this.#failingShare(entry),
          cls === 'retry' ? entry.failures : 0,
          // A name that answered lately before one whose answer is older, or that never answered
          // (`P-426`'s second review): one domain's names, or names of one label, tie on their
          // share, and a name held once by a passing failure waited behind every silent one.
          cls === 'retry' ? -(entry.lastAnsweredAt ?? Number.NEGATIVE_INFINITY) : 0,
        ];
        if (bestRank === undefined || before(rank, bestRank)) {
          best = index;
          bestRank = rank;
        }
      }
    }
    const [next] = queue.splice(best, 1);
    if (next?.urgent === true) set.urgentQueued -= 1;
    return next;
  }

  /** Takes one lookup out of its queue, wherever it is in it. */
  #unqueue(pending: Pending): boolean {
    const set = this.#setOf(pending);
    const queue = set.queues[pending.cls];
    const at = queue.indexOf(pending);
    if (at === -1) return false;
    queue.splice(at, 1);
    if (pending.urgent) set.urgentQueued -= 1;
    return true;
  }

  #canRun(set: LaneSet, cls: LaneClass): boolean {
    if (cls === 'retry') return set.running.retry.size < 1;
    const shared = set.running.first.size + set.running.refresh.size;
    return set.running[cls].size < capOf(set, cls) && shared < set.sharedCap;
  }

  /**
   * The lookups whose end could give a queued lookup a lane: its domain's first lookups, when it is
   * held back to them (`P-438`); its own class's when that holds all it may; and otherwise every
   * shared lane's, as when it is held back from the last of them. Never a lane it could not take.
   */
  #blockers(pending: Pending): Pending[] {
    const set = this.#setOf(pending);
    const cls = pending.cls;
    if (cls === 'retry') return [...set.running.retry];
    if (set.pool === 'probe') {
      const held = this.#heldBack(pending);
      if (held !== undefined && held !== 'shared') return this.#domainRunning(pending);
    }
    if (set.running[cls].size >= capOf(set, cls)) return [...set.running[cls]];
    return [...set.running.first, ...set.running.refresh];
  }

  /**
   * Whether every lane a queued lookup could take is held by a lookup that has run past
   * `STUCK_MS`. A check then fails at once rather than waiting out its bound. In the helper, by
   * the condition that holds it (§1.8's fail fast).
   */
  #lanesStuck(pending: Pending): boolean {
    const gate = this.#gate;
    if (pending.pool === 'helper' && gate !== undefined) {
      return this.#helperBlocked(gate, pending) !== undefined;
    }
    const blockers = this.#blockers(pending);
    return blockers.length > 0 && blockers.every((blocker) => blocker.stuck);
  }

  /** The probe's lanes, then in gate mode the helper's. */
  #pump(): void {
    this.#pumpProbe();
    if (this.#gate !== undefined) this.#pumpHelper(this.#gate);
  }

  #pumpProbe(): void {
    for (;;) {
      const next = this.#next(this.#probe);
      if (next === undefined) return;
      // A lookup nobody waits for any more, for a name the watched files have since
      // replaced, is not worth a lane.
      if (next.waiters.size === 0 && this.#entries.get(next.entry.key) !== next.entry) {
        next.state = 'done';
        if (next.entry.pending === next) next.entry.pending = undefined;
        continue;
      }
      this.#run(next);
    }
  }

  /**
   * The queued lookup the next free lane takes: a retry, then a first lookup, then a refresh, each
   * when its class may run another. A class whose queued lookups are all held back (`P-438`)
   * leaves the lane to the next.
   */
  #next(set: LaneSet): Pending | undefined {
    for (const cls of ['retry', 'first', 'refresh'] as const) {
      if (set.queues[cls].length === 0 || !this.#canRun(set, cls)) continue;
      const next = this.#takeNext(set, cls, (pending) => this.#heldBack(pending) === undefined);
      if (next !== undefined) return next;
    }
    return undefined;
  }

  /**
   * Starts a lookup on the probe's lanes: the one place the probe's own `getaddrinfo` is asked. In
   * gate mode a name avoided by now (D27) does not start here (`#offProbe`).
   */
  #run(pending: Pending): void {
    if (this.#gate !== undefined && this.#offProbe(this.#gate, pending)) return;
    pending.state = 'running';
    pending.startedAt = this.#now();
    pending.startedSeq = this.#events;
    pending.generation = this.#generation;
    this.#probe.running[pending.cls].add(pending);
    if (this.#gate !== undefined) {
      pending.armedAt = this.#gate.realNow();
      if (pending.route === 'heard' || pending.route === 'sampled') this.#gate.lookupsHeard += 1;
    }
    pending.stuckTimer = setTimeout(() => {
      this.#onStuck(pending);
    }, this.#stuckMs);
    pending.stuckTimer.unref();
    const { host, family } = pending.entry;
    let asked: Promise<readonly ResolvedAddress[]>;
    try {
      asked = this.#lookup(host, family);
    } catch (error: unknown) {
      // Thrown rather than rejected: not an answer about the name, so nothing is kept. Settled
      // after the asking check has started waiting for it, as an answer would be.
      queueMicrotask(() => {
        this.#settle(pending, { fault: error });
      });
      return;
    }
    asked.then(
      (addresses) => {
        this.#settle(pending, { addresses, ranMs: this.#now() - pending.startedAt });
      },
      (error: unknown) => {
        this.#settle(pending, { error });
      },
    );
  }

  /**
   * A lookup has run past `STUCK_MS`: its lane is stuck, and its name is held for new checks. The
   * checks already waiting for it keep waiting, up to their own bound (`P-426`'s review): a
   * resolver that answers in two seconds answers them, as it did before this resolver. They stop
   * early only with an answer: "Check now", given the one kept for the name. In the helper, the
   * child's clock says so (D4); on the probe's lanes in gate mode, the gate's marks are taken
   * after polls (D25).
   */
  #onStuck(pending: Pending): void {
    if (pending.state !== 'running') return;
    pending.stuck = true;
    const entry = pending.entry;
    const now = this.#now();
    // Not for a lookup the configuration has moved on from: the name is asked again under the new.
    if (entry.pending === pending) {
      this.#hold(
        entry,
        now,
        pending.pool === 'helper'
          ? `a lookup had no answer after ${String(this.#stuckMs)} ms in the lookup helper`
          : `a lookup had no answer after ${String(this.#stuckMs)} ms`,
        pending.pool,
      );
    }
    for (const waiter of [...pending.waiters]) {
      const outcome = this.#unanswered(entry, waiter.fresh, now, RESOLVER_HELD);
      if (outcome.ok) this.#deliver(pending, waiter, outcome);
    }
    // And whatever is queued behind lanes that are now every one stuck stops waiting too, on
    // either lane set.
    const sets = this.#gate === undefined ? [this.#probe] : [this.#probe, this.#gate.lanes];
    for (const set of sets) {
      for (const cls of ['first', 'refresh', 'retry'] as const) {
        for (const queued of set.queues[cls]) {
          if (queued.waiters.size === 0 || !this.#lanesStuck(queued)) continue;
          for (const waiter of [...queued.waiters]) {
            this.#deliver(
              queued,
              waiter,
              this.#unanswered(
                queued.entry,
                waiter.fresh,
                now,
                RESOLVER_STUCK,
                this.#stuckWhy(queued),
              ),
            );
          }
        }
      }
    }
    if (this.#gate !== undefined && pending.pool === 'probe')
      this.#markAfterPolls(this.#gate, pending);
  }

  /** One more lookup in a row the resolver did not answer: the name is held for the next step. */
  #hold(entry: Entry, now: number, why: string, via: Pool = 'probe'): void {
    if (entry.failures === 0) {
      // Once a minute at most, with how many more were held since: a resolver outage holds every
      // name it serves, and one line each would bury the log.
      if (this.#lastHoldWarn === undefined || now - this.#lastHoldWarn >= HOLD_WARN_EVERY_MS) {
        this.#logger.warn(
          {
            host: entry.host,
            family: entry.family,
            why,
            alsoHeld: this.#heldSinceWarn,
            ...(this.#gate === undefined ? {} : { via: via === 'helper' ? 'helper' : 'lane' }),
          },
          'the probe’s resolver did not answer a name: holding it',
        );
        this.#lastHoldWarn = now;
        this.#heldSinceWarn = 0;
      } else {
        this.#heldSinceWarn += 1;
        this.#logger.debug({ host: entry.host, family: entry.family, why }, 'holding a name');
      }
    }
    this.#setFailures(entry, entry.failures + 1, now);
    const step = Math.min(this.#holdMaxMs, this.#holdFirstMs * 2 ** (entry.failures - 1));
    const jittered = step * (1 - HOLD_JITTER + 2 * HOLD_JITTER * this.#random());
    entry.hold = { since: now, until: now + jittered, why };
  }

  #settle(pending: Pending, result: Settled): void {
    if (pending.state === 'done') return;
    pending.state = 'done';
    clearTimeout(pending.stuckTimer);
    this.#runningOf(pending).delete(pending);
    const entry = pending.entry;
    // Whatever it said, a loaded answer no longer stands for its domain (`P-438`).
    this.#unload(entry);
    // Whether the name still stands for this lookup: not once the configuration moved on, nor
    // once the lookup helper went quiet with it in flight (D26).
    const current =
      !pending.detached && (entry.pending === pending || pending.generation === this.#generation);
    if (entry.pending === pending) entry.pending = undefined;
    const now = this.#now();

    // The same for every waiter, or undefined when each is told by what the entry now holds.
    let outcome: ResolveOutcome | undefined;
    // An answer under the current configuration: else a lookup stuck stays its domain's history.
    let answered = false;
    // A failure that says nothing about the name: each waiter is told it, "Check now" given the
    // kept answer, and nothing is kept.
    let passed: { readonly code: string; readonly why: string } | undefined;
    // Refused by the gate (`#refuse`): each check it fails counts in `checksFaulted`.
    let refused = false;
    // What the lookup helper learns of the lookup's key (§1.8).
    let learned: HelperOutcome = 'neutral';
    if ('fault' in result) {
      outcome = failure(RESOLVER_FAULT, this.#fault(result.fault, entry.host).message);
    } else if ('passed' in result) {
      passed = result.passed;
      refused = result.refused === true;
    } else if ('addresses' in result) {
      learned = 'answer';
      const addresses = result.addresses.map(({ address, family }) => ({ address, family }));
      // The helper sends at most one more than the cap, and says how many there were (O-OS-9).
      const total = result.total ?? addresses.length;
      if (total > this.#maxAddresses) {
        const message =
          `${entry.host} resolved to ${String(total)} addresses, more than the ` +
          `${String(this.#maxAddresses)} the probe uses for one name`;
        if (current) this.#deny(entry, now, RESOLVER_TOO_MANY, message);
        else outcome = failure(RESOLVER_TOO_MANY, message);
      } else if (!current) {
        // Asked under a configuration since replaced (`P-426`'s second review): what the new one
        // has said, or is asking, stands, its denial, its hold and its failures in a row with it,
        // and this goes to the checks that waited for it. Only a name the new configuration has
        // said nothing of keeps it, and as due, so the next check asks under the new one and is
        // served this meanwhile.
        entry.lastAnsweredAt = now;
        if (
          entry.answer === undefined &&
          entry.denial === undefined &&
          entry.hold === undefined &&
          entry.pending === undefined
        ) {
          entry.answer = { addresses, answeredAt: now, expiresAt: now };
        }
        outcome = { ok: true, addresses };
      } else {
        if (entry.failures > 0) {
          this.#logger.debug(
            { host: entry.host, family: entry.family },
            'a held name answered again',
          );
        }
        entry.lastAnsweredAt = now;
        entry.answer = { addresses, answeredAt: now, expiresAt: now + this.#answerMs };
        entry.denial = undefined;
        entry.hold = undefined;
        this.#setFailures(entry, 0, now);
        // Its domain answers under this configuration (`P-438`): from DNS, not from the hosts
        // file, which `getaddrinfo` reads first and which answers for a silent zone too. On
        // either lane set: a helper answer is the same evidence (`P-432` S3).
        const domain = this.#domains.get(entry.domain);
        if (domain !== undefined && !hostsLists(this.#view, entry.host, entry.family)) {
          domain.answeredAt = now;
          this.#events += 1;
          domain.answeredSeq = this.#events;
          // An answer after `STUCK_MS`: the domain's resolver is slow, not silent (`P-438`'s
          // narrow check).
          if (pending.stuck) domain.slowSeq = this.#events;
        }
        answered = true;
        outcome = { ok: true, addresses };
      }
    } else if ('held' in result) {
      // Lost with the lookup helper after the child said it was stuck: as `EAI_AGAIN` after
      // stuck, the hold runs from now at the same step, and its waiters are told it is held.
      learned = 'giveUp';
      if (current && entry.hold !== undefined) {
        const step = entry.hold.until - entry.hold.since;
        entry.hold.until = Math.max(entry.hold.until, now + step);
        entry.hold.why = result.held;
      } else if (current) {
        this.#hold(entry, now, result.held, pending.pool);
      }
      passed = { code: RESOLVER_HELD, why: result.held };
    } else {
      const code = codeOf(result.error);
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      if (code === 'EAI_AGAIN') {
        if (pending.stuck) learned = 'giveUp';
        if (!current) {
          // Said of a configuration since replaced: nothing held for it.
        } else if (pending.stuck && entry.hold !== undefined) {
          // Held at its bound for stuck already: the hold runs from now, at the same step.
          const step = entry.hold.until - entry.hold.since;
          entry.hold.until = Math.max(entry.hold.until, now + step);
          entry.hold.why = 'getaddrinfo said EAI_AGAIN';
        } else {
          this.#hold(entry, now, 'getaddrinfo said EAI_AGAIN', pending.pool);
        }
      } else if (code !== undefined && NO_ADDRESS.has(code)) {
        learned = 'answer';
        if (current) this.#deny(entry, now, code, message);
        else outcome = failure(code, message);
      } else {
        if (pending.stuck) learned = 'giveUp';
        // `EMFILE`, `EAI_MEMORY`, `EAI_FAIL`, no code at all: the probe's or the system's
        // trouble, not an answer about the name, so nothing is kept and the kept answer stays.
        passed = { code: code ?? RESOLVER_FAULT, why: message };
      }
    }
    // Ended stuck without an answer (`P-438`'s review): its domain counts as stuck for `STUCK_MS`
    // more, while what started as it ended is not stuck yet.
    if (pending.stuck && !answered && pending.generation === this.#generation) {
      this.#endedStuck(entry, now);
    }
    if (this.#gate !== undefined) {
      this.#gateSettled(this.#gate, pending, learned, ranMsOf(result), 'addresses' in result);
    }

    for (const waiter of [...pending.waiters]) {
      const told =
        outcome ??
        (passed !== undefined
          ? this.#unanswered(entry, waiter.fresh, now, passed.code, passed.why)
          : entry.denial !== undefined
            ? failure(entry.denial.code, entry.denial.message)
            : this.#unanswered(entry, waiter.fresh, now, 'EAI_AGAIN'));
      // Each waiter once: the loop reads a copy, and only `#deliver` lets a waiter go.
      if (refused && !told.ok && this.#gate !== undefined) this.#gate.checksFaulted += 1;
      this.#deliver(pending, waiter, told);
    }
    this.#pump();
  }

  /** An answer that the name has no address, or one the probe will not use. A denial drops a kept answer. */
  #deny(entry: Entry, now: number, code: string, message: string): void {
    entry.denial = { code, message, until: now + this.#denialMs };
    entry.answer = undefined;
    entry.hold = undefined;
    this.#setFailures(entry, 0, now);
  }

  #wait(
    pending: Pending,
    fresh: boolean,
    waitMs: number | undefined,
  ): Promise<ResolveOutcome | undefined> {
    const bound =
      waitMs !== undefined && Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_WAIT_MS;
    return new Promise((resolve) => {
      const waiter: Waiter = { fresh, deliver: resolve, timers: [] };
      const forget = setTimeout(() => {
        this.#deliver(pending, waiter, undefined);
      }, bound + FORGET_SLACK_MS);
      forget.unref();
      waiter.timers.push(forget);
      if (fresh) {
        // "Check now" behind lanes busy but not stuck: given the kept answer while the reply can
        // still reach the check inside its bound, rather than failing it with an answer kept. A
        // quarter of the bound at most, so a short one still asks for most of it (`P-426`'s
        // second review: at 250 ms or less it used the kept answer at once).
        const earlyMs = bound - Math.min(FORGET_SLACK_MS, Math.floor(bound / 4));
        const early = setTimeout(() => {
          const entry = pending.entry;
          const outcome = this.#unanswered(
            entry,
            true,
            this.#now(),
            RESOLVER_LATE,
            `a lookup for ${entry.host} had not been answered within ${String(earlyMs)} ms`,
          );
          if (outcome.ok) this.#deliver(pending, waiter, outcome);
        }, earlyMs);
        early.unref();
        waiter.timers.push(early);
      }
      pending.waiters.add(waiter);
    });
  }

  #deliver(pending: Pending, waiter: Waiter, outcome: ResolveOutcome | undefined): void {
    if (!pending.waiters.delete(waiter)) return;
    for (const timer of waiter.timers) clearTimeout(timer);
    waiter.deliver(outcome);
  }

  // --- Gate mode (`P-432` S3) --------------------------------------------------------------------

  /** How the policy routes a name (§1.3 rows 3 to 5, with the walk `S6`'s): `local` or not. */
  #routeOf(gate: Gate, entry: Entry): GateRoute {
    try {
      return gate.policy.classify(entry.host, entry.family).kind === 'local'
        ? 'local'
        : 'unvouched';
    } catch (error: unknown) {
      this.#logger.error({ err: error, host: entry.host }, 'the name policy failed on a name');
      return 'unvouched';
    }
  }

  /**
   * Which lane set a lookup goes to (§1.3's table): the probe's for `local`, `heard` and `sampled`,
   * and for everything while the helper rests, as `system` routes; the helper's for `silent`, in
   * every other state; and for `unvouched` the helper's while it is up or rejoining, and the
   * probe's under D24's rule while it is down.
   */
  #poolFor(gate: Gate, route: GateRoute): Pool {
    const state = gate.helper.routeState();
    if (state === 'resting') return 'probe';
    if (route === 'local' || route === 'heard' || route === 'sampled') return 'probe';
    if (route === 'silent') return 'helper';
    return state === 'up' || state === 'rejoining' ? 'helper' : 'probe';
  }

  /**
   * Whether the probe's own `getaddrinfo` must not be asked for a name now, in any state (D27): a
   * suspect, poison in a family a lookup of it asks, or a name in flight at a crash, or when the
   * helper's child went quiet (`P-463`), until ten minutes after the helper is next up. Such a name
   * is never walked and never heard.
   */
  #avoided(gate: Gate, entry: Entry): boolean {
    return entry.suspect || gate.helper.avoidsSystem(entry.host, entry.family);
  }

  /**
   * D27 as a lookup leaves the probe's queues to start (`#run`): one for a name avoided by now is
   * not started. It goes to the helper, unvouched, as `#start` sends an avoided name, while the
   * helper can ask it; it fails its checks at once (`RESOLVER_FAULT`) as `#fallBack` fails one,
   * when the helper cannot or the name is poison; and once the probe is stopping it is settled as
   * the stop settles the helper's. True when the lookup was moved or settled.
   *
   * Checked here rather than where lookups are queued, because a name becomes avoided while its
   * lookup waits: a crash of the name's other family in the helper, a poison mark or a suspect
   * comes at any time, and every path to the probe's lanes (a route at the ask, a walk's verdict,
   * a sample, a fall-back, Check now's promotion) ends in this start. It is the state at the moment
   * `getaddrinfo` would be asked that D27 is about, and only here is that moment.
   */
  #offProbe(gate: Gate, pending: Pending): boolean {
    const entry = pending.entry;
    if (!this.#avoided(gate, entry)) return false;
    const refusal = this.#stopped ? stopping(entry.host) : this.#gateRefusal(entry);
    if (refusal !== undefined) {
      pending.refused = refusal;
      this.#refuse(gate, pending, refusal);
      return true;
    }
    // A sample out for its zone is no longer (D20): it is not asked on the probe's lanes.
    if (pending.route === 'sampled') gate.check?.sampledEnded(pending.key, pending);
    pending.route = 'unvouched';
    pending.pool = 'helper';
    this.#logger.debug(
      { host: entry.host, family: entry.family, key: pending.key },
      'a lookup queued on the probe’s lanes for a name the probe may no longer ask: moved to the lookup helper',
    );
    this.#enqueue(pending);
    return true;
  }

  /**
   * Why gate mode fails a name's check at once rather than queue a lookup for it, or undefined
   * (§1.3 row 0, S2's names kept off the probe's lanes): a poison name in any state, and while the
   * helper rests or is down, a name the probe's own `getaddrinfo` must not be asked for (`#avoided`,
   * a suspect included).
   */
  #gateRefusal(entry: Entry): string | undefined {
    const gate = this.#gate;
    if (gate === undefined) return undefined;
    const mark = gate.helper.poison(entry.host, entry.family);
    if (mark !== undefined) {
      const signal = mark.signal === null ? '' : ` (${mark.signal})`;
      const next = Math.max(0, mark.nextAskAt - this.#now());
      return (
        `asking getaddrinfo for ${entry.host} made the lookup helper fail${signal}: it is not ` +
        `asked on the probe’s own lanes, and is asked again alone in the helper in ${seconds(next)}`
      );
    }
    const state = gate.helper.routeState();
    if ((state === 'resting' || state === 'down') && this.#avoided(gate, entry)) {
      return (
        `the probe’s resolver does not ask its own getaddrinfo for ${entry.host}: the lookup ` +
        `helper failed while asking for it lately, and is ${state === 'resting' ? 'resting' : 'not answering'}`
      );
    }
    return undefined;
  }

  /** The domain's helper lookups the child said are stuck (D24's `helperStuck`). */
  #helperStuckOf(gate: Gate, domain: string): number {
    let stuck = 0;
    for (const pending of helperRunning(gate)) {
      if (pending.stuck && pending.entry.domain === domain) stuck += 1;
    }
    return stuck;
  }

  /**
   * D25's marks for a probe-lane lookup past `STUCK_MS`, taken after polls, so that a stall with
   * its answer waiting to be read sets none: a `local` lookup is passed-stuck when its timer fired
   * no later than `LATE_MS`, and any other is in U while it runs, late or not, because it really
   * has run that long.
   */
  #markAfterPolls(gate: Gate, pending: Pending): void {
    const late = gate.realNow() - pending.armedAt - this.#stuckMs;
    afterPolls(() => {
      if (pending.state !== 'running') return;
      const { host, family } = pending.entry;
      if (pending.route === 'local') {
        if (late > LATE_MS) return;
        gate.passedStuck += 1;
        // Walked from now, keyed by its own name, for an hour (D25).
        gate.check?.markWalked(host);
        this.#logger.warn(
          { host, family },
          'a name the system answers without the network ran past the bound for stuck on the probe’s lanes',
        );
        return;
      }
      if (late <= LATE_MS && pending.route === 'heard') {
        // Passed-stuck, walked: every candidate key its walk asked is unsafe (O-OS-10).
        gate.passedStuck += 1;
        gate.check?.markUnsafe(pending.walkKeys);
        // Each named, as a local one is: the field test explains every passed-stuck from it.
        this.#logger.warn(
          { host, family, route: 'heard', key: pending.key, walkKeys: pending.walkKeys },
          'a name the DNS check heard ran past the bound for stuck on the probe’s lanes: the zones its walk asked are walked by none for 5 minutes',
        );
      } else if (late <= LATE_MS && pending.route === 'sampled') {
        // Passed-stuck, sampled: NotHeard for its zone as of its start, never unsafe (D20).
        gate.passedStuck += 1;
        gate.check?.sampledStuck(pending.key, pending.startedAt, host);
        this.#logger.warn(
          { host, family, route: 'sampled', key: pending.key },
          'a refresh that rode its zone’s heard walk ran past the bound for stuck on the probe’s lanes: its zone is taken as not heard',
        );
      }
      pending.untokened = true;
      gate.budget.untokenedStuck(pending, questionsOf(family));
    });
  }

  /**
   * What a settled lookup gives back in gate mode: its token or its place in U, its key's evidence,
   * and what the name check learns of it: a quick answer freshens its key (§1.5), a sampled one is
   * no longer out (D20), and the helper's answer for a name whose walk went unanswered may be a
   * miss (§1.10).
   */
  #gateSettled(
    gate: Gate,
    pending: Pending,
    learned: HelperOutcome,
    ranMs: number | undefined,
    addresses: boolean,
  ): void {
    if (pending.token !== undefined) {
      gate.budget.releaseGai(pending.token);
      pending.token = undefined;
    }
    if (pending.untokened) {
      pending.untokened = false;
      gate.budget.untokenedDone(pending);
    }
    if (pending.pool === 'helper') gate.keys.ended(pending, learned);
    const check = gate.check;
    if (check === undefined) return;
    if (pending.route === 'sampled') check.sampledEnded(pending.key, pending);
    if (addresses && ranMs !== undefined) {
      pending.entry.lastRanMs = ranMs;
      check.answered(pending.key, ranMs);
    }
    if (pending.miss !== undefined && pending.pool === 'helper' && learned === 'answer') {
      check.helperAnswered(pending.miss, ranMs ?? Number.POSITIVE_INFINITY);
    }
  }

  /** Sends what the helper's lanes admit (§1.8's pick), while its route is up. */
  #pumpHelper(gate: Gate): void {
    for (;;) {
      if (gate.helper.routeState() !== 'up') return;
      const picked = this.#nextHelper(gate);
      if (picked === undefined) return;
      const { pending, token } = picked;
      // As on the probe's lanes: nobody waits, for a name the watched files have since replaced.
      if (
        pending.waiters.size === 0 &&
        !pending.poisonAsk &&
        this.#entries.get(pending.entry.key) !== pending.entry
      ) {
        pending.state = 'done';
        gate.budget.releaseGai(token);
        pending.token = undefined;
        if (pending.entry.pending === pending) pending.entry.pending = undefined;
        continue;
      }
      this.#runHelper(gate, pending, token);
    }
  }

  /**
   * The helper lookup to send next, with its token, or undefined (§1.8): a poison name's re-ask
   * at a moment nothing is in flight, holding nothing back (D27); while isolating, a suspect alone,
   * one at a time; then "Check now"'s on an urgent token, or a shared one as its key's first look;
   * then `P-426`'s order over the helper's queues, each lookup admitted by its key, the at-risk
   * count, its class and a token. A lookup asked again after a loss carries its token and starts
   * first.
   */
  #nextHelper(gate: Gate): { pending: Pending; token: GaiToken } | undefined {
    const running = helperRunning(gate);
    const isolating = gate.helper.isolating();
    if (running.length === 0 && !isolating) {
      const poison = this.#poisonAsk(gate);
      if (poison !== undefined) return poison;
    }
    if (isolating) {
      const pick = this.#isolationPick(gate, running);
      if (pick !== 'free') return pick === 'wait' ? undefined : pick;
    }
    // A lookup asked again after a loss: it carries its token, and was admitted when it first ran.
    for (const cls of ['retry', 'first', 'refresh'] as const) {
      const carried = gate.lanes.queues[cls].find((p) => p.token !== undefined);
      if (carried?.token !== undefined && (carried.urgent || this.#canRun(gate.lanes, cls))) {
        this.#unqueue(carried);
        return { pending: carried, token: carried.token };
      }
    }
    const atRisk = this.#atRisk(gate);
    gate.riskPeak = Math.max(gate.riskPeak, atRisk);
    const admitted = new Map<string, HelperToken | undefined>();
    const admit = (pending: Pending): HelperToken | undefined => {
      const at = `${pending.key}|${pending.cls}|${String(pending.urgent)}`;
      if (admitted.has(at)) return admitted.get(at);
      const token = admitHelper(this.#admitAsk(gate, pending, atRisk));
      admitted.set(at, token);
      return token;
    };
    const urgent = gate.lanes.queues.first.find(
      (pending) => pending.urgent && admit(pending) !== undefined,
    );
    if (urgent !== undefined) {
      const kind = admit(urgent);
      this.#unqueue(urgent);
      return kind === undefined ? undefined : this.#started(gate, urgent, kind, atRisk);
    }
    for (const cls of ['retry', 'first', 'refresh'] as const) {
      if (gate.lanes.queues[cls].length === 0 || !this.#canRun(gate.lanes, cls)) continue;
      const next = this.#takeNext(gate.lanes, cls, (p) => !p.urgent && admit(p) !== undefined);
      if (next === undefined) continue;
      const kind = admit(next);
      return kind === undefined ? undefined : this.#started(gate, next, kind, atRisk);
    }
    return undefined;
  }

  /**
   * The pick while the helper isolates (D27). A suspect in flight that the child has not said is
   * stuck goes alone: nothing else starts. The next suspect that may run goes alone too, once
   * nothing else is in flight but lookups the child said are stuck or that were let go, which
   * never answer for the crash; until then nothing else starts, at most the child's bound for
   * stuck. With none to send, the rest go: a suspect held until its hold ends holds nothing back.
   * Isolation ends once no suspect is left to ask (`#suspectsLeft`); the helper also ends it at its
   * own lapse, so that none of this outlasts 8 s after a crash, or a held suspect's ask
   * (`suspectHeld`).
   */
  #isolationPick(
    gate: Gate,
    running: readonly Pending[],
  ): { pending: Pending; token: GaiToken } | 'wait' | 'free' {
    const unsaid = running.filter((pending) => !pending.stuck && !pending.detached);
    if (unsaid.some((pending) => pending.suspect)) return 'wait';
    // Within its class's cap: a stuck suspect holds its lane as any lookup does (LR7 I3).
    const alone = (cls: LaneClass) => (p: Pending) =>
      p.suspect && (p.urgent || this.#canRun(gate.lanes, cls));
    const suspect =
      this.#takeNext(gate.lanes, 'first', alone('first')) ??
      this.#takeNext(gate.lanes, 'retry', alone('retry')) ??
      this.#takeNext(gate.lanes, 'refresh', alone('refresh'));
    if (suspect === undefined) {
      if (this.#suspectsLeft(gate) === 0) gate.helper.endIsolation();
      return 'free';
    }
    const token =
      unsaid.length > 0 ? undefined : (suspect.token ?? this.#takeToken(gate, suspect, 'shared'));
    if (token !== undefined) return { pending: suspect, token };
    this.#requeueFront(suspect);
    // Waiting for a token, as any lookup does, it holds nothing back.
    return unsaid.length > 0 ? 'wait' : 'free';
  }

  /** The suspects still to be asked alone, those since forgotten or asked let go (D27). */
  #suspectsLeft(gate: Gate): number {
    for (const entry of gate.suspects) {
      if (!entry.suspect || this.#entries.get(entry.key) !== entry) gate.suspects.delete(entry);
    }
    return gate.suspects.size;
  }

  /**
   * Isolation over (D27): a suspect not yet asked is a name like any other, and a lookup of one
   * queued goes as any lookup does.
   */
  #dropSuspects(gate: Gate): void {
    for (const entry of gate.suspects) entry.suspect = false;
    gate.suspects.clear();
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      for (const pending of gate.lanes.queues[cls]) pending.suspect = false;
    }
  }

  /**
   * A suspect held, as a lookup the child had said was stuck is, is asked again alone once its
   * hold ends, with nobody waiting for it (D27): isolation is for finding what crashed the child,
   * and a check may not ask for it before the helper's lapse ends isolation. Only while isolating:
   * the change that ends it drops every suspect (`#dropSuspects`).
   */
  #askHeldSuspects(gate: Gate, now: number): void {
    // Those asked since, or forgotten, first: none is asked again.
    this.#suspectsLeft(gate);
    for (const entry of gate.suspects) {
      if (entry.pending !== undefined || this.#held(entry, now)) continue;
      this.#start(entry, entry.failures > 0 ? 'retry' : 'first');
    }
  }

  /**
   * A lookup the pick took out of its queue, with the token its admission named, and whether it
   * was ungated as it started (I8). Back at the front of its queue if the token is gone.
   */
  #started(
    gate: Gate,
    pending: Pending,
    kind: HelperToken,
    atRisk: number,
  ): { pending: Pending; token: GaiToken } | undefined {
    pending.ungated = helperUngated(this.#admitAsk(gate, pending, atRisk));
    const token = this.#takeToken(gate, pending, kind);
    if (token === undefined) {
      this.#requeueFront(pending);
      return undefined;
    }
    return { pending, token };
  }

  #takeToken(gate: Gate, pending: Pending, kind: TokenKind): GaiToken | undefined {
    return gate.budget.takeGai(kind, questionsOf(pending.entry.family), pending);
  }

  /** Puts a lookup the pick took back at the front of its queue. */
  #requeueFront(pending: Pending): void {
    const set = this.#setOf(pending);
    set.queues[pending.cls].unshift(pending);
    if (pending.urgent) set.urgentQueued += 1;
  }

  #runHelper(gate: Gate, pending: Pending, token: GaiToken): void {
    pending.state = 'running';
    pending.startedAt = this.#now();
    pending.startedSeq = this.#events;
    pending.generation = this.#generation;
    pending.token = token;
    this.#runningOf(pending).add(pending);
    gate.keys.started(pending, pending.key, pending.cls);
    gate.lookupsToHelper += 1;
    if (pending.suspect) pending.entry.suspect = false;
    const { host, family } = pending.entry;
    let asked: Promise<HelperAnswer>;
    try {
      asked = gate.helper.ask({
        host,
        family,
        max: this.#maxAddresses,
        onStuck: () => {
          this.#onHelperStuck(gate, pending);
        },
        ref: pending,
        suspect: pending.suspect,
      });
    } catch (error: unknown) {
      queueMicrotask(() => {
        this.#settle(pending, { fault: error });
      });
      return;
    }
    asked.then(
      (answer) => {
        this.#settle(pending, {
          addresses: answer.addresses,
          total: answer.total,
          ranMs: answer.ranMs,
        });
      },
      (error: unknown) => {
        if (isHelperLost(error)) this.#onHelperLost(gate, pending, error);
        else this.#settle(pending, { error });
      },
    );
  }

  /** The child said a helper lookup ran past `STUCK_MS` (D4): held as on a lane, and its key told. */
  #onHelperStuck(gate: Gate, pending: Pending): void {
    if (pending.state !== 'running' || pending.stuck) return;
    gate.keys.stuck(pending);
    gate.helperStuck += 1;
    // The OS's own evidence for a key never heard of (§1.5).
    gate.check?.helperStuck(pending.entry.host, pending.entry.family, pending.walked);
    this.#onStuck(pending);
    // A suspect said stuck lets the next go (D27).
    this.#pump();
  }

  /**
   * A helper lookup lost with its child, or never sent (§1.11's table). Never sent
   * (`unavailable`): kept and routed again. Asked again in the next child (`requeue`): at the
   * front, with its waiters and its token, and a ledger ghost for what the forwarder still holds.
   * Stuck when lost: held as for `EAI_AGAIN` after stuck, a give-up for its key, and an
   * availability ghost. Otherwise, a hung child's, a detached one, one charged with the crash, or
   * one with no child to ask it in: its checks fail at once (`RESOLVER_FAULT`), with no hold.
   */
  #onHelperLost(gate: Gate, pending: Pending, error: HelperLostError): void {
    if (pending.state !== 'running') return;
    const host = pending.entry.host;
    if (error.reason === 'unavailable') {
      this.#runningOf(pending).delete(pending);
      gate.keys.ended(pending, 'neutral');
      if (pending.token !== undefined) gate.budget.releaseGai(pending.token);
      pending.token = undefined;
      pending.state = 'queued';
      this.#requeueFront(pending);
      // Routed again by the change that follows, or by the next tick if the route still says up.
      queueMicrotask(() => {
        if (gate.helper.routeState() !== 'up') this.#reroute(gate);
      });
      return;
    }
    if (error.reason === 'stop') {
      this.#settle(pending, { passed: { code: RESOLVER_FAULT, why: stopping(host) } });
      return;
    }
    const stuck = pending.stuck || error.stuck;
    const ghostly = stuck || error.reason === 'hung' || pending.detached || error.detached;
    if (pending.token !== undefined) {
      gate.budget.lose([{ token: pending.token, stuck: ghostly, started: error.started }]);
      if (ghostly) pending.token = undefined;
    }
    if (error.suspect) {
      pending.entry.suspect = true;
      gate.suspects.add(pending.entry);
    }
    if (error.requeue && !ghostly) {
      this.#runningOf(pending).delete(pending);
      gate.keys.ended(pending, 'neutral');
      pending.state = 'queued';
      pending.suspect = error.suspect;
      // At the front, behind those of the same loss asked again before it: in their order.
      const set = this.#setOf(pending);
      const queue = set.queues[pending.cls];
      const at = queue.findIndex((queued) => queued.token === undefined);
      queue.splice(at === -1 ? queue.length : at, 0, pending);
      if (pending.urgent) set.urgentQueued += 1;
      return;
    }
    if (stuck) {
      this.#settle(pending, {
        held:
          `a lookup for ${host} had run past ${String(this.#stuckMs)} ms in the lookup helper ` +
          `when the helper was lost (${error.reason})`,
      });
      // A suspect held (D27): the helper's lapse waits for its hold, and a tick to ask it in.
      const hold = pending.entry.hold;
      if (error.suspect && hold !== undefined) {
        gate.helper.suspectHeld(hold.until - this.#now() + gate.tickMs);
      }
      return;
    }
    const why =
      error.reason === 'hung' || pending.detached || error.detached
        ? `the lookup helper stopped answering while asking for ${host}`
        : error.charged
          ? `asking getaddrinfo for ${host} made the lookup helper fail: it is not asked for an hour`
          : `the lookup helper failed (${error.reason}) while asking for ${host}`;
    this.#settle(pending, { passed: { code: RESOLVER_FAULT, why } });
  }

  /**
   * The lookup helper changed state, route or isolation (S2's `onChange`), a microtask after the
   * lookups it affects were settled. Up: what fell back to the probe's lanes moves into the helper
   * (`#rejoin`). Down: the helper's queued lookups go to their `P-426` class under D24's rule
   * (`#fallBack`). Resting: everything does, as `system` routes. Detached: the lookups in flight
   * no longer stand for their names (D26). Rejoining: what is queued waits for the next child.
   */
  onHelperChange(change: HelperChange): void {
    const gate = this.#gate;
    if (gate === undefined) return;
    try {
      // The time with the check on runs to the change, not to the next read.
      this.#accrueCheckOn(gate, this.#now());
      this.#noteHelperChange(gate, change);
      for (const ref of change.detached ?? []) this.#detach(gate, ref);
      // Isolation over, by the resolver's word or at the helper's lapse: no suspect is owed.
      if (!change.isolating) this.#dropSuspects(gate);
      gate.route = change.route;
      // Stopped, or stopping once the resolver has: the helper's stop takes its child before it
      // says it is stopped, and what is queued for it then is the probe's stop's, never the
      // probe's lanes' (`P-432` S3). While the pool drains, a lost child's lookups fall back.
      if (change.state === 'stopped' || (this.#stopped && change.route !== 'up')) {
        this.#fallBack(gate, 'stopped');
        return;
      }
      this.#reroute(gate);
    } catch (error: unknown) {
      // The change it failed on, its loss included; the lookups it detached, counted.
      const { detached, ...said } = change;
      this.#logger.error(
        {
          err: error,
          change: { ...said, ...(detached === undefined ? {} : { detached: detached.length }) },
        },
        'the probe’s resolver failed on a lookup helper change',
      );
    }
  }

  /**
   * A change of the helper's state, and the loss that moved it, for the hourly summary (`P-467`):
   * Probe Health has no channel for either (OPEN-5). A loss is listed with what the helper says
   * of it now; how its child ended is filled in once its exit says (`#fillLossEnd`).
   */
  #noteHelperChange(gate: Gate, change: HelperChange): void {
    const hour = gate.helperHour;
    const at = new Date().toISOString();
    if (change.state !== change.previous) {
      if (hour.changes.length < SUMMARY_LISTED) {
        hour.changes.push({
          at,
          from: change.previous,
          to: change.state,
          ...(change.loss === undefined ? {} : { loss: change.loss }),
        });
      } else hour.changesNotListed += 1;
    }
    if (change.loss === undefined) return;
    if (hour.lost.length >= SUMMARY_LISTED) {
      hour.lostNotListed += 1;
      return;
    }
    const last = gate.helper.stats().lastLoss;
    const said = last?.reason === change.loss ? last : undefined;
    const loss: SummaryLoss = {
      at,
      reason: change.loss,
      pid: said?.pid,
      why: said?.why,
      signal: said?.signal ?? null,
      exitCode: said?.exitCode ?? null,
      lossAt: said?.at,
    };
    hour.lost.push(loss);
    hour.awaitingEnd = loss.signal === null && loss.exitCode === null ? loss : undefined;
  }

  /**
   * How the last loss listed ended, once the helper's word on it says: a child the probe killed,
   * or one whose channel closed first, exits after its loss is taken. Only while it is still the
   * helper's last loss; a later one ends the wait.
   */
  #fillLossEnd(gate: Gate): void {
    const loss = gate.helperHour.awaitingEnd;
    if (loss === undefined) return;
    const last = gate.helper.stats().lastLoss;
    if (last === undefined || last.at !== loss.lossAt || last.pid !== loss.pid) {
      gate.helperHour.awaitingEnd = undefined;
      return;
    }
    if (last.signal === null && last.exitCode === null) return;
    loss.signal = last.signal;
    loss.exitCode = last.exitCode;
    gate.helperHour.awaitingEnd = undefined;
  }

  /** Routes what is queued again, by the helper's route now. */
  #reroute(gate: Gate): void {
    const route = gate.helper.routeState();
    if (route === 'up') this.#rejoin(gate);
    else if (route === 'down') this.#fallBack(gate, 'vouched');
    else if (route === 'resting') this.#fallBack(gate, 'all');
    this.#pump();
  }

  /**
   * A lost child's answer for a lookup asked again and not yet re-sent (L-F5): taken out of its
   * queue, wherever it went since, and settled once. Anything else is the helper's to drop.
   */
  onHelperLateAnswer(ref: object, outcome: LateOutcome): void {
    const gate = this.#gate;
    if (gate === undefined) return;
    const pending = this.#queuedPending(gate, ref);
    if (pending === undefined) return;
    this.#unqueue(pending);
    this.#settle(
      pending,
      outcome.ok
        ? { addresses: outcome.answer.addresses, total: outcome.answer.total }
        : { error: outcome.error },
    );
  }

  /** A queued lookup by its reference, on either lane set. */
  #queuedPending(gate: Gate, ref: object): Pending | undefined {
    for (const set of [gate.lanes, this.#probe]) {
      for (const cls of ['first', 'refresh', 'retry'] as const) {
        const found = set.queues[cls].find((pending) => pending === ref);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /** At `unresponsive` (D26): the lookup no longer stands for its name, nor counts for its key. */
  #detach(gate: Gate, ref: object): void {
    const pending = helperRunning(gate).find((running) => running === ref);
    if (pending === undefined || pending.detached) return;
    pending.detached = true;
    if (pending.entry.pending === pending) pending.entry.pending = undefined;
    gate.keys.detach(pending);
  }

  /**
   * Back up (§1.11): the queued lookups that fell back to the probe's lanes move into the helper,
   * unvouched ones and, from a rest, silent ones, which outside a rest are asked only there.
   */
  #rejoin(gate: Gate): void {
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      const queue = this.#probe.queues[cls];
      for (let at = 0; at < queue.length;) {
        const pending = queue[at];
        if (
          pending === undefined ||
          (pending.route !== 'unvouched' && pending.route !== 'silent')
        ) {
          at += 1;
          continue;
        }
        queue.splice(at, 1);
        if (pending.urgent) this.#probe.urgentQueued -= 1;
        pending.pool = 'helper';
        gate.lanes.queues[cls].push(pending);
        if (pending.urgent) gate.lanes.urgentQueued += 1;
      }
    }
  }

  /**
   * The helper's queued lookups leave it (§1.11): to their `P-426` class on the probe's lanes, with
   * a carried token released, at `down` (`vouched`: the unvouched ones, D24's; a silent one stays
   * for the helper) and at a rest (`all`); failed at once for a name the probe's own `getaddrinfo`
   * must not be asked for.
   * When the helper has stopped, every one fails: the probe is stopping.
   */
  #fallBack(gate: Gate, which: 'vouched' | 'all' | 'stopped'): void {
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      const queue = gate.lanes.queues[cls];
      for (const pending of [...queue]) {
        if (which === 'vouched' && pending.route !== 'unvouched') continue;
        this.#unqueue(pending);
        if (pending.token !== undefined) {
          gate.budget.releaseGai(pending.token);
          pending.token = undefined;
        }
        const refusal =
          which === 'stopped' ? stopping(pending.entry.host) : this.#gateRefusal(pending.entry);
        if (refusal !== undefined) {
          this.#refuse(gate, pending, refusal);
          continue;
        }
        pending.pool = 'probe';
        this.#probe.queues[cls].push(pending);
        if (pending.urgent) this.#probe.urgentQueued += 1;
      }
    }
    // What stays for the helper alone, a name DNS did not answer, fails its checks at once (§1.11).
    if (which !== 'vouched') return;
    const now = this.#now();
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      for (const pending of [...gate.lanes.queues[cls]]) {
        const refused = this.#silentRefusal(pending);
        if (refused === undefined) continue;
        for (const waiter of [...pending.waiters]) {
          this.#deliver(
            pending,
            waiter,
            this.#unanswered(pending.entry, waiter.fresh, now, RESOLVER_FAULT, refused),
          );
        }
      }
    }
  }

  /**
   * The helper's lanes at risk now (§1.8): its general tokens held by a lookup the child said is
   * stuck, a detached one, or a gated one on a shared token; availability ghosts; and U.
   */
  #atRisk(gate: Gate): number {
    let risk = gate.budget.ghosts('shared') + gate.budget.ghosts('kept') + gate.budget.untokened();
    for (const pending of helperRunning(gate)) {
      const token = pending.token;
      if (token === undefined || token.kind === 'urgent') continue;
      if (pending.stuck || pending.detached) risk += 1;
      else if (token.kind === 'shared' && !this.#ungatedNow(gate, pending)) risk += 1;
    }
    return risk;
  }

  #ungatedNow(gate: Gate, pending: Pending): boolean {
    return helperUngated({
      overflow: false,
      vouched: false,
      keyQuiet: gate.keys.quiet(pending.key),
      unitCapped: gate.keys.capped(pending.key, pending.cls),
    });
  }

  /** What the admission reads of a queued helper lookup (§1.8). The walk's vouching is `S6`'s. */
  #admitAsk(gate: Gate, pending: Pending, atRisk: number): HelperAdmitAsk {
    const { keys, budget } = gate;
    const key = pending.key;
    const domain = pending.entry.domain;
    const stuckAnywhere = [...this.#probeRunning(), ...helperRunning(gate)].some(
      (running) => running.stuck && (running.key === key || running.entry.domain === domain),
    );
    return {
      urgent: pending.urgent,
      overflow: false,
      stuckAnywhere,
      keyNew: keys.isNew(key),
      keyQuiet: keys.quiet(key),
      keyRunning: keys.running(key),
      vouched: false,
      unitRunning: keys.unitRunning(key, pending.cls),
      unitCapped: keys.capped(key, pending.cls),
      atRisk,
      classOk: pending.urgent || this.#canRun(gate.lanes, pending.cls),
      urgentAvailable: budget.available('urgent'),
      sharedAvailable: budget.available('shared'),
      keptAvailable: budget.available('kept'),
    };
  }

  #probeRunning(): Pending[] {
    const { running } = this.#probe;
    return [...running.first, ...running.refresh, ...running.retry];
  }

  /**
   * Why a queued helper lookup's checks fail at once (§1.8's fail fast), or undefined: a condition
   * that holds it, whose blockers are every one stuck. Stuck is what the child said, or a ghost;
   * U is stuck too. The lookup stays queued.
   */
  #helperBlocked(gate: Gate, pending: Pending): HelperBlock | undefined {
    if (pending.token !== undefined) return undefined;
    const atRisk = this.#atRisk(gate);
    const ask = this.#admitAsk(gate, pending, atRisk);
    if (admitHelper(ask) !== undefined) return undefined;
    const { keys, budget } = gate;
    const blocks: HelperBlock[] = [];
    if (!helperKeyOk(ask)) {
      const quiet = ask.keyQuiet && !ask.vouched;
      blocks.push({
        condition: quiet ? 'key' : 'unit',
        lookups: (quiet
          ? keys.runningOf(pending.key)
          : keys.runningOf(pending.key, pending.cls)
        ).map((lookup) => lookup as Pending),
        ghosts: 0,
      });
    }
    if (!helperRiskOk(ask)) {
      blocks.push({
        condition: 'risk',
        lookups: helperRunning(gate).filter(
          (running) =>
            running.token !== undefined &&
            running.token.kind !== 'urgent' &&
            (running.stuck ||
              running.detached ||
              (running.token.kind === 'shared' && !this.#ungatedNow(gate, running))),
        ),
        ghosts: budget.ghosts('shared') + budget.ghosts('kept') + budget.untokened(),
      });
    }
    if (!ask.classOk) {
      blocks.push({ condition: 'class', lookups: this.#blockers(pending), ghosts: 0 });
    }
    const ungated = helperUngated(ask);
    const noToken =
      ask.sharedAvailable <= 0 &&
      !(pending.urgent && ask.urgentAvailable > 0) &&
      !(!pending.urgent && ungated && ask.keptAvailable > 0);
    if (noToken) {
      const kinds: TokenKind[] = ['shared'];
      if (ungated && !pending.urgent) kinds.push('kept');
      if (pending.urgent) kinds.push('urgent');
      blocks.push({
        condition: 'token',
        lookups: helperRunning(gate).filter(
          (running) => running.token !== undefined && kinds.includes(running.token.kind),
        ),
        ghosts: kinds.reduce((sum, kind) => sum + budget.ghosts(kind), 0) + budget.untokened(),
      });
    }
    return blocks.find(
      (block) =>
        block.lookups.length + block.ghosts > 0 && block.lookups.every((lookup) => lookup.stuck),
    );
  }

  /** The words a helper lookup's fail-fast message names its condition in (§5). */
  #helperWhy(gate: Gate, pending: Pending, block: HelperBlock): string {
    const lanes = block.lookups
      .slice(0, 3)
      .map((blocker) => blocker.entry.host)
      .join(', ');
    const named = lanes === '' ? '' : ` (${lanes})`;
    const prefix =
      `every lane a lookup for ${pending.entry.host} could use is held by a lookup that has run ` +
      `past ${String(this.#stuckMs)} ms${named}`;
    const domain = keyWords(pending.key);
    switch (block.condition) {
      case 'key':
        return (
          `${prefix}: no name of ${domain} has answered in the lookup helper since one of its ` +
          `lookups ran past ${String(this.#stuckMs)} ms, so it holds at most ` +
          `${String(KEY_QUIET)} of the helper’s lanes; it stays queued`
        );
      case 'unit':
        return (
          `${prefix}: a ${pending.cls} lookup of ${domain} gave up or is stuck in the lookup ` +
          `helper, so its ${pending.cls} lookups hold at most 3 of the helper’s lanes until one ` +
          `answers; it stays queued`
        );
      case 'risk':
        return (
          `${prefix}: ${String(RISK_T)} of the lookup helper’s lanes are held by lookups that ` +
          `may not answer, the most a name not known to answer waits behind; it stays queued`
        );
      case 'class':
        return `${prefix}, in the lookup helper; it stays queued`;
      case 'token':
        return (
          `${prefix}, and every lane of the lookup helper is taken, ` +
          `${String(gate.budget.ghosts('shared') + gate.budget.ghosts('kept'))} of them by ` +
          `questions a lost helper left at the DNS server; it stays queued`
        );
    }
  }

  /**
   * Gate mode's start (§1.2, L-N3): the watch's first look, awaited, which loads the name policy
   * from this same reading of the hosts file before the policy is told of the look. `start` then
   * does not look again at once. In `system` mode it is the first look alone.
   */
  async firstLook(): Promise<void> {
    this.#firstLooked = true;
    await this.checkFiles();
  }

  /** The name policy, loaded once, from the hosts file as the watch's first look read it. */
  async #loadPolicy(looked: readonly WatchedReading[]): Promise<void> {
    const gate = this.#gate;
    if (gate === undefined || gate.loaded) return;
    gate.loaded = true;
    const hosts = looked.find((reading) => isHostsFile(reading.file))?.text;
    await gate.policy.load(hosts === undefined ? {} : { hosts });
  }

  /**
   * What the policy makes of a look (§1.12, D28): a read-once file that moved marks the helper
   * skewed, so its next loss rests it until the probe restarts.
   */
  #policyMoved(gate: Gate, change: PolicyChange): void {
    if (change.moved.length === 0 && !gate.policy.skewed()) return;
    const readOnce = gate.policy.describe().readOnce;
    let marked = false;
    for (const file of change.moved) {
      if (!readOnce.includes(file)) continue;
      gate.helper.markSkewed(file);
      marked = true;
    }
    if (!marked && gate.policy.skewed()) {
      gate.helper.markSkewed(readOnce[0] ?? 'a file glibc reads once');
    }
  }

  /** Starts gate mode's clock: the time with the check on, poison names due, the summary. */
  #startGate(): void {
    const gate = this.#gate;
    if (gate === undefined || gate.tick !== undefined) return;
    gate.tick = setInterval(() => {
      this.#gateTick(gate);
    }, gate.tickMs);
    gate.tick.unref();
  }

  #gateTick(gate: Gate): void {
    try {
      const now = this.#now();
      this.#accrueCheckOn(gate, now);
      this.#fillLossEnd(gate);
      if (gate.helper.routeState() === 'up') this.#askHeldSuspects(gate, now);
      if (now - gate.lastSummaryAt >= GATE_SUMMARY_MS) this.#summary(gate, now);
      this.#pump();
    } catch (error: unknown) {
      this.#logger.error({ err: error }, 'the probe’s resolver failed on its gate tick');
    }
  }

  /**
   * The time with the check on and the helper up (`nameCheckOnSeconds`), to now: the check's state
   * 1, proven and not stood down. Without the check built, the policy's word alone.
   */
  #accrueCheckOn(gate: Gate, now: number): void {
    const on =
      (gate.check === undefined ? gate.policy.checkOn() : gate.check.state() === 1) &&
      gate.helper.routeState() === 'up';
    if (gate.checkOnSince !== undefined) gate.checkOnMs += Math.max(0, now - gate.checkOnSince);
    gate.checkOnSince = on ? now : undefined;
  }

  /**
   * A poison name due its re-ask (D27), sent now, as nothing is in flight, so that a crash is its
   * alone at the start. It holds nothing back: what is asked meanwhile starts beside it, and a
   * crash with any of that in flight is charged to no one, every name in flight kept off the
   * probe's lanes; a crash with it alone is charged to it. One due that finds no such moment for a
   * whole period waits for its next (`poisonDue`).
   */
  #poisonAsk(gate: Gate): { pending: Pending; token: GaiToken } | undefined {
    for (const mark of gate.helper.poisonDue()) {
      const key = `${String(mark.family)}:${mark.host}`;
      const entry = this.#entries.get(key) ?? this.#add(key, mark.host, mark.family);
      if (entry.pending !== undefined) continue;
      const pending: Pending = {
        entry,
        cls: 'retry',
        urgent: false,
        state: 'queued',
        startedAt: 0,
        generation: this.#generation,
        startedSeq: 0,
        stuck: false,
        stuckTimer: undefined,
        waiters: new Set(),
        pool: 'helper',
        route: 'unvouched',
        key: candidateKey(entry.host),
        walkKeys: [],
        miss: undefined,
        silent: undefined,
        walked: false,
        token: undefined,
        detached: false,
        suspect: false,
        poisonAsk: true,
        refused: undefined,
        untokened: false,
        ungated: false,
        armedAt: 0,
      };
      const token = this.#takeToken(gate, pending, 'shared');
      if (token === undefined) return undefined;
      entry.pending = pending;
      return { pending, token };
    }
    return undefined;
  }

  /**
   * The hourly summary (§5): what was routed where, the helper's peaks and its losses. Since the
   * user's decision of 2026-10-18 (OPEN-5) it is also where the field test reads what Probe Health
   * does not carry (`P-467`): the helper's changes of state and its losses this hour, each loss
   * with its reason and how its child ended, and its resident memory now; the check's state and
   * why; and the lookups heard, run in the helper, the misses and the walks deferred, this hour
   * and since the probe started. Said every hour, it also carries what a quiet helper costs
   * whatever its rate-limited line said (`P-463` fix round 1): `checksFaulted`, the checks failed
   * at once (fix round 2: `routed.faulted` counts lookups), the helper's quiets, the most names it
   * kept off the probe's lanes at once, and its time not answering (`msInState.unresponsive`).
   * Said again as the probe stops, for the part of the hour since the last, with `stopping` (fix
   * round 2).
   */
  #summary(gate: Gate, now: number, stopping = false): void {
    this.#fillLossEnd(gate);
    const helper = gate.helper.stats();
    const budget = gate.budget.stats();
    const totals = this.#gateCounts(gate);
    const from = gate.hourFrom;
    const checkState = this.#checkState(gate);
    const off = checkState === 2 ? gate.policy.describe().off : undefined;
    const hour = gate.helperHour;
    this.#logger.info(
      {
        ...(stopping ? { stopping: true } : {}),
        routed: { ...gate.routed },
        hour: {
          lookupsHeard: totals.lookupsHeard - from.lookupsHeard,
          lookupsToHelper: totals.lookupsToHelper - from.lookupsToHelper,
          misses: totals.misses - from.misses,
          walksDeferred: totals.walksDeferred - from.walksDeferred,
          passedStuck: totals.passedStuck - from.passedStuck,
          helperStuck: totals.helperStuck - from.helperStuck,
        },
        checksFaulted: gate.checksFaulted,
        passedStuck: gate.passedStuck,
        helperStuck: gate.helperStuck,
        lookupsHeard: gate.lookupsHeard,
        lookupsToHelper: gate.lookupsToHelper,
        misses: totals.misses,
        walksDeferred: { ...budget.deferred, total: totals.walksDeferred },
        check: {
          ...(gate.check === undefined ? {} : gate.check.stats()),
          state: checkState,
          said: CHECK_STATE_SAID[checkState],
          ...(off === undefined ? {} : { off }),
        },
        atRiskPeak: gate.riskPeak,
        questionsOpenPeak: budget.peak,
        helper: {
          state: helper.state,
          // At the child's last beat; null with no child (lost, resting or stopped).
          rss: helper.rss ?? null,
          rssPeak: helper.rssPeak,
          lagPeakMs: helper.lagPeakMs,
          poisoned: helper.poisoned,
          msInState: helper.msInState,
          losses: { ...helper.lossesByReason, total: helper.losses },
          changes: hour.changes.map((change) => ({ ...change })),
          ...(hour.changesNotListed === 0 ? {} : { changesNotListed: hour.changesNotListed }),
          lost: hour.lost.map(({ lossAt: _at, ...loss }) => loss),
          ...(hour.lostNotListed === 0 ? {} : { lostNotListed: hour.lostNotListed }),
          quiets: helper.quiets,
          keptOffPeak: helper.keptOffPeak,
        },
      },
      'the probe’s resolver in gate mode, this hour',
    );
    gate.lastSummaryAt = now;
    for (const kind of Object.keys(gate.routed) as (keyof Gate['routed'])[]) gate.routed[kind] = 0;
    gate.checksFaulted = 0;
    gate.riskPeak = 0;
    gate.hourFrom = totals;
    gate.helperHour = newHelperHour();
  }

  /** The running totals the hourly summary counts its hour by. */
  #gateCounts(gate: Gate): HourCounts {
    return {
      lookupsHeard: gate.lookupsHeard,
      lookupsToHelper: gate.lookupsToHelper,
      misses: gate.check?.stats().misses ?? 0,
      walksDeferred: walksDeferredOf(gate.budget),
      passedStuck: gate.passedStuck,
      helperStuck: gate.helperStuck,
    };
  }

  /**
   * The check's state (§5's numbering): 0 resting; 1 on; 2 off for the environment or platform;
   * 3 not proven; 4 stood down; 5 walks off at a server (never in this build).
   */
  #checkState(gate: Gate): 0 | CheckState {
    if (gate.helper.routeState() === 'resting') return 0;
    return gate.check?.state() ?? (gate.policy.checkOn() ? 1 : 2);
  }

  /** What gate mode has done, for Probe Health: undefined in `system` mode. */
  gateHealth(): GateHealth | undefined {
    const gate = this.#gate;
    if (gate === undefined) return undefined;
    this.#accrueCheckOn(gate, this.#now());
    const resting = gate.helper.routeState() === 'resting';
    const counts = this.#gateCounts(gate);
    return {
      mode: resting ? 3 : 2,
      checkOnSeconds: Math.floor(gate.checkOnMs / 1_000),
      passedStuck: counts.passedStuck,
      helperStuck: counts.helperStuck,
      checkState: this.#checkState(gate),
      lookupsHeard: counts.lookupsHeard,
      lookupsToHelper: counts.lookupsToHelper,
      misses: counts.misses,
      walksDeferred: counts.walksDeferred,
    };
  }

  /**
   * The most DNS questions the probe's `getaddrinfo` calls held unanswered at the site's servers
   * since the last take (§1.6), and from now the count starts again: undefined in `system` mode.
   */
  takeQuestionsPeak(): number | undefined {
    return this.#gate?.budget.takePeak();
  }

  /** The same peak, read without taking it: undefined in `system` mode. */
  questionsPeak(): number | undefined {
    return this.#gate?.budget.stats().peak;
  }

  /**
   * The domains with the most names failing now, most first (`P-441`): what Probe Health names as
   * not answering. A name of one label is in the domain `''`. In either mode.
   */
  notAnswering(count = NOT_ANSWERING_NAMED): string[] {
    return [...this.#domains]
      .filter(([, domain]) => domain.failing > 0)
      .sort(([a, x], [b, y]) => y.failing - x.failing || a.localeCompare(b))
      .slice(0, count)
      .map(([name]) => name);
  }
}
