import { fork, type ForkOptions } from 'node:child_process';
import { getDefaultResultOrder } from 'node:dns';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import type { Logger } from '@ms/shared';
import {
  glibcRuntime,
  helperChildArgs,
  HELPER_PROTOCOL,
  type AnswerMessage,
  type AskMessage,
  type BeatMessage,
  type ChildMessage,
  type FailedMessage,
  type HelperAddress,
  type HelperFamily,
  type ReadyMessage,
} from './lookup-helper-child.js';
import { lookupLanes, STUCK_MS } from './name-resolver.js';
import { afterPolls } from './verdict-timer.js';

/**
 * The probe's lookup helper, its parent side (`P-432`, design §1.11): starts the child in
 * `lookup-helper-child.ts`, sends it lookups, judges whether it is alive, and replaces it when it
 * is lost. **Not wired into the resolver yet** (S2): `NameResolver` reaches it through `HelperPort`
 * in S3, with its own lanes and tokens deciding what is asked here.
 *
 * **What it promises the resolver.**
 * - An ask is sent only while the helper is up (`routeState() === 'up'`), and every send passes a
 *   callback: a send that fails is a loss with reason `exit`, never an uncaught exception (L-F5).
 *   An ask refused because it is not up rejects with reason `unavailable` and `started: false`:
 *   no loss, nothing was sent, and the resolver keeps the lookup and routes it again.
 * - Ids come from one counter for the whole process, never reused across children, and each child
 *   keeps its table of ids until its channel closes (L-F5). A late answer from a lost child
 *   settles a lookup only if that lookup was requeued and has not been asked again since, and it
 *   is handed on a turn after the loss, once the lookup's rejection has reached the resolver.
 * - **"Stuck" is the child's word, never the probe's timer** (D4): `onStuck` is called when the
 *   child says a lookup has run `STUCK_MS` on its clock, which it decides after its polls, so an
 *   answer already completed is always read first.
 * - **At a loss, every lookup of the lost child is rejected in one turn, before the state change
 *   is emitted** (a microtask later), with a `HelperLostError` saying what it was: stuck, detached,
 *   charged with a crash, and whether it may be asked again. A stuck lookup, a hung child's and a
 *   detached one are never asked again (D26), and neither is any lookup of a crash that rests the
 *   helper or comes while the probe stops: it may be what crashed it (D27), and there is no
 *   helper to ask it in. The guarantee holds for a handler attached to the ask's own promise.
 *
 * **Liveness is counted in the probe's own ticks, not timed** (D4, L-N4). Every `tickMs` the probe
 * asks, after its polls, whether it has read anything from the child since the last tick. The
 * child beats every `beatMs`, so a quiet tick means nothing at all came. `unresponsiveTicks` quiet
 * ticks detach the lookups in flight (D26) and route as `down`; `rejoinTicks` heard ticks in a row
 * bring it back; `hungTicks` quiet ticks since it last answered kill it, counted across heard ticks
 * that did not bring it back, so a child heard only now and then is replaced too. A child is
 * judged the same way while the probe stops, and one that goes quiet then routes as `down`
 * without being replaced. A stall of the probe of any length is one tick,
 * since Node re-arms an interval from the start of its callback, and nothing already in the pipe
 * can be missed, since the verdict waits for the polls: no verdict comes from a timer that could
 * fire before a reply already sent is read.
 *
 * **Losses and rest.** A loss is followed by a new child after 0, 250, 500 or 1,000 ms. The fifth
 * loss in ten minutes, or a loss within ten minutes of a start that ended a rest, rests the helper
 * for ten minutes, doubling to an hour, and the probe then routes every name as `system` does.
 * Ten minutes up resets the doubling. A crash charged to a name is not counted toward a rest: it
 * found what crashed the child, which is not asked again, so several names that crash
 * `getaddrinfo` are each found rather than resting the helper with some of them unfound (D27). A
 * `ready` that says the child runs another Node, another glibc or read other read-once files
 * (D28) is a `skew` loss, and the helper rests until the probe restarts, since a second child
 * would read the same.
 *
 * **Isolation and poison** (D27). After the second `exit` loss in ten minutes that leaves crash
 * candidates, those are suspects, which the resolver sends alone: the lookups asked again, and a
 * lookup the child had said was stuck, once its hold ends (a crash on a slow reply comes after the
 * child said so). Isolation ends when the resolver says it has no suspect left (`endIsolation`):
 * none to ask, held or queued, and none in flight the child has not said is stuck. It ends in any
 * case at its lapse, whether or not a suspect is in flight, so that a `getaddrinfo` that never
 * returns cannot keep it on: `isolationMaxMs` (8 s) after the crash that began it or the last one
 * during it, or later while the resolver holds a suspect (`suspectHeld`), until that suspect's
 * hold has ended and the child could have said it is stuck. Every change says whether it is on. A
 * suspect asked while isolating stays one until it settles, isolation over or not. One rule
 * charges every crash: to a lookup alone in flight, a suspect or a poison name's re-ask, and
 * otherwise to no one, so that a working name is never poison for another's crash. **Only a crash
 * is charged** (`P-453`): a child ended by a signal a crash raises (`CRASH_SIGNALS`). SIGKILL,
 * SIGTERM or SIGINT from outside (an operator, the kernel's OOM killer, a cgroup kill) and an exit
 * code say nothing of a name, so such an end is an `exit` loss charged to no one, its suspects
 * asked again alone. A loss taken on its channel closing, a failed send or a broken protocol,
 * before the exit is read, waits for the exit when a crash could be charged on it, at most
 * `exitWaitMs`. Every name in flight at an `exit` loss, crash or not, charged or not, is avoided,
 * and at a `memory` loss too, and those asked again go alone. A charged name is poison, never
 * asked on a probe lane, and asked again alone here after an hour, then after twice as long at each
 * crash, to a day at most, at a moment nothing else is in flight; one that finds none for a whole
 * period waits for the next. An answer clears the mark; a restart of the probe does too.
 * `memory`, `hung` and `start` losses are never charged to a name. A change and a loss say whether
 * a crash made a `new` mark or crashed `again` at a re-ask: the trouble latch counts the first and
 * not the second.
 *
 * **Names kept off the probe's lanes** (`avoidsSystem`). The helper is there so that a name that
 * crashes `getaddrinfo` cannot take the probe down. So in any state the resolver never asks the
 * probe's own `getaddrinfo` for a poison name, a current suspect, or a name in flight at an `exit`
 * or a `memory` loss: it sends it to the helper while the helper can ask it, and fails that check
 * at once while the route is `resting` or `down`. Such a name is avoided from its loss until ten
 * minutes after the helper is next up, so that a rest, or a start that does not come up, never
 * ends its ten minutes before a child has run them.
 */

/** libuv threads in the child: 16 lookup lanes, twice the helper's 8 tokens (D3). */
export const HELPER_THREADS = 32;
/** The fewest lookup lanes a child must report: accounting slips must never queue inside libuv. */
export const HELPER_MIN_LOOKUP_LANES = 16;
/** How often the child beats. */
export const HELPER_BEAT_MS = 500;
/** How often the probe judges whether it read anything from the child. */
export const HELPER_TICK_MS = 1_000;
/** Quiet ticks in a row that detach the child's lookups and route as `down`. */
export const HELPER_UNRESPONSIVE_TICKS = 3;
/** Heard ticks in a row that bring a quiet child back up (L-N4). */
export const HELPER_REJOIN_TICKS = 2;
/** Quiet ticks in a row that kill it as `hung`. */
export const HELPER_HUNG_TICKS = 20;
/** How long a child may take to say it is ready. */
export const HELPER_START_MS = 30_000;
/** How long the probe's start waits for the first child before it goes on without it. */
export const HELPER_START_WAIT_MS = 5_000;
/** After a loss, how long the resolver keeps lookups queued for the next child (`rejoining`). */
export const HELPER_REJOIN_MS = 2_000;
/** The wait before each new child after a loss: the first loss, the second, the third, more. */
export const HELPER_BACKOFF_MS: readonly number[] = [0, 250, 500, 1_000];
/** The window losses are counted in, and the one that resets a rest's doubling. */
export const HELPER_STABLE_MS = 600_000;
/** Losses in that window that rest the helper. */
export const HELPER_LOSSES_TO_REST = 5;
/** The first rest, and the longest. */
export const HELPER_REST_FIRST_MS = 600_000;
export const HELPER_REST_MAX_MS = 3_600_000;
/** The child's V8 heap. */
export const HELPER_HEAP_MB = 64;
/** A beat reporting more resident memory than this kills the child as `memory`. */
export const HELPER_RSS_MAX = 256 * 1024 * 1024;
/** How long `stop()` waits for the killed child to exit. */
export const HELPER_STOP_MS = 500;
/** How long after it is marked a poison name is asked again, alone; doubled at each crash. */
export const HELPER_POISON_RETRY_MS = 3_600_000;
/** The longest a poison name waits for its re-ask. */
export const HELPER_POISON_RETRY_MAX_MS = 86_400_000;
/**
 * How long isolation lasts after the crash that began it, or the last crash during it, with no
 * suspect held (D27): at most 8 suspects, each sent alone until the child says it is stuck, at
 * most `STUCK_MS` on the child's clock (§1.11). A suspect the resolver holds keeps it on until its
 * hold has ended and `STUCK_MS` more (`suspectHeld`): still bounded, since a hold is at most the
 * resolver's `HOLD_MAX_MS` and its jitter. It ends then whether or not a suspect is in flight.
 */
export const HELPER_ISOLATION_MAX_MS = 8_000;
/** How much of the child's stderr is kept, and how much of it a loss's log line carries. */
const STDERR_KEEP = 4_096;
const STDERR_SAID = 400;
/** "Not answering" is warned at most this often, with a count of the times since. */
const NOT_ANSWERING_WARN_MS = 60_000;
/** How long a loss's log line waits for the child's exit status and the rest of its stderr. */
export const HELPER_LOSS_SAY_MS = 1_000;
/**
 * How long a loss that a crash could be charged on waits for the child's exit status (`P-453`):
 * its channel closed, a send failed or it broke the protocol first, and only the signal it ended
 * with says whether `getaddrinfo` crashed. The child is killed meanwhile, so the exit comes at
 * once unless the process cannot go; one that has not come by then charges no one.
 */
export const HELPER_EXIT_WAIT_MS = 1_000;
/**
 * The signals a crash raises (`P-453`): only a child ended by one of these is charged to the
 * lookup alone in it. SIGKILL, SIGTERM and SIGINT come from outside (an operator, the kernel's OOM
 * killer, a cgroup kill, or this helper), and an exit code is the child's own word: neither says
 * anything of a name. SIGABRT is glibc's own end for a corrupted heap, and V8's for its heap
 * limit.
 */
export const CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set<NodeJS.Signals>([
  'SIGSEGV',
  'SIGBUS',
  'SIGABRT',
  'SIGILL',
  'SIGFPE',
  'SIGTRAP',
  'SIGSYS',
]);

/** Whether a child ended by this signal crashed (`P-453`): undefined while its exit is not known. */
export function crashedBy(signal: NodeJS.Signals | null | undefined): boolean {
  return signal !== null && signal !== undefined && CRASH_SIGNALS.has(signal);
}
/** Inherited by the child from nowhere: systemd's, the probe's own settings, and every Node one. */
const NOT_INHERITED = new Set(['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'WATCHDOG_PID']);

/** Every bound the helper keeps, injectable in tests. */
export interface HelperLimits {
  readonly protocol: number;
  readonly stuckMs: number;
  readonly beatMs: number;
  readonly tickMs: number;
  readonly unresponsiveTicks: number;
  readonly rejoinTicks: number;
  readonly hungTicks: number;
  readonly startMs: number;
  readonly startWaitMs: number;
  readonly rejoinMs: number;
  readonly backoffMs: readonly number[];
  readonly stableMs: number;
  readonly lossesToRest: number;
  readonly restFirstMs: number;
  readonly restMaxMs: number;
  readonly heapMb: number;
  readonly rssMax: number;
  readonly stopMs: number;
  readonly poisonRetryMs: number;
  readonly poisonRetryMaxMs: number;
  readonly isolationMaxMs: number;
  readonly lossSayMs: number;
  readonly exitWaitMs: number;
}

export const HELPER_LIMITS: HelperLimits = {
  protocol: HELPER_PROTOCOL,
  stuckMs: STUCK_MS,
  beatMs: HELPER_BEAT_MS,
  tickMs: HELPER_TICK_MS,
  unresponsiveTicks: HELPER_UNRESPONSIVE_TICKS,
  rejoinTicks: HELPER_REJOIN_TICKS,
  hungTicks: HELPER_HUNG_TICKS,
  startMs: HELPER_START_MS,
  startWaitMs: HELPER_START_WAIT_MS,
  rejoinMs: HELPER_REJOIN_MS,
  backoffMs: HELPER_BACKOFF_MS,
  stableMs: HELPER_STABLE_MS,
  lossesToRest: HELPER_LOSSES_TO_REST,
  restFirstMs: HELPER_REST_FIRST_MS,
  restMaxMs: HELPER_REST_MAX_MS,
  heapMb: HELPER_HEAP_MB,
  rssMax: HELPER_RSS_MAX,
  stopMs: HELPER_STOP_MS,
  poisonRetryMs: HELPER_POISON_RETRY_MS,
  poisonRetryMaxMs: HELPER_POISON_RETRY_MAX_MS,
  isolationMaxMs: HELPER_ISOLATION_MAX_MS,
  lossSayMs: HELPER_LOSS_SAY_MS,
  exitWaitMs: HELPER_EXIT_WAIT_MS,
};

export type HelperState =
  'idle' | 'starting' | 'up' | 'unresponsive' | 'backoff' | 'resting' | 'stopping' | 'stopped';

/** What the resolver routes by (design §1.3, §1.11). */
export type RouteState = 'up' | 'rejoining' | 'down' | 'resting';

/**
 * Why a child was lost: it failed to start, it is not the probe's twin (D28), it exited or its
 * channel broke, it stopped answering, or it grew past its memory.
 */
export type LossReason = 'start' | 'skew' | 'exit' | 'hung' | 'memory';

/** What the probe's policy read at start (D28): each read-once file with its digest. */
export interface HelperSnapshot {
  readonly digests: Readonly<Record<string, string>>;
}

/** What the child must match: this process, unless a test says otherwise. */
export interface HelperSelf {
  readonly node: string;
  readonly glibc: string | null;
  readonly order: string;
}

/** One lookup to ask. */
export interface HelperAsk {
  readonly host: string;
  readonly family: HelperFamily;
  /** The most addresses the probe uses for one name: the child sends at most one more. */
  readonly max: number;
  /** Called at most once, when the child says the lookup has run past its bound for stuck. */
  readonly onStuck?: (ranMs: number) => void;
  /** The lookup this is: the same object each time it is asked again after a loss. */
  readonly ref?: object;
  /**
   * An isolation suspect, sent alone (D27): a crash while it runs is charged to it, if no other
   * suspect and no lookup said stuck runs with it. Only while the helper is isolating, and only
   * until isolation ends.
   */
  readonly suspect?: boolean;
}

/** What `getaddrinfo` answered in the child. */
export interface HelperAnswer {
  /** At most `max + 1`, in `getaddrinfo`'s order. */
  readonly addresses: readonly HelperAddress[];
  /** How many there were: the cap is judged on this (O-OS-9). */
  readonly total: number;
  /** How long the lookup ran, on the child's clock. */
  readonly ranMs: number;
}

/** `getaddrinfo` failed in the child: its code and words, as the probe's own lookup would have. */
export class HelperLookupError extends Error {
  readonly code: string | undefined;
  readonly ranMs: number;

  constructor(message: string, code: string | undefined, ranMs: number) {
    super(message);
    this.name = 'HelperLookupError';
    this.code = code;
    this.ranMs = ranMs;
  }
}

/** A lost child's answer for a lookup that was requeued and not asked again since. */
export type LateOutcome =
  | { readonly ok: true; readonly answer: HelperAnswer }
  | { readonly ok: false; readonly error: HelperLookupError };

export const HELPER_LOST = 'ERESOLVERHELPERLOST';

/**
 * A lookup the helper no longer has, or never took (internal: never shown to a check). `reason`
 * is the loss's, `stop` when the probe is stopping, or `unavailable` when it was asked while not
 * up. **`unavailable` is no loss**: nothing was sent (`started: false`), and the resolver keeps the
 * lookup and routes it again by `routeState()`, whatever `requeue` says. It never faults it.
 */
export class HelperLostError extends Error {
  readonly code = HELPER_LOST;
  readonly reason: LossReason | 'stop' | 'unavailable';
  /** The child had said it was stuck. */
  readonly stuck: boolean;
  /** Detached when the child went quiet (D26): it no longer stands for its name. */
  readonly detached: boolean;
  /** It had been sent to the child, so its questions may still be open at the forwarder (D26). */
  readonly started: boolean;
  /** The crash is charged to it (D27): its name is poison. */
  readonly charged: boolean;
  /**
   * Lost with its child, it may be asked again: an `exit` or `memory` loss, and it was not stuck,
   * detached or charged, and an `exit` loss that neither rested the helper nor came while the
   * probe stops. Always false for `unavailable`, which was never asked.
   */
  readonly requeue: boolean;
  /**
   * Asked again as an isolation suspect, alone (D27): a lookup asked again, or one the child had
   * said was stuck, asked again once its hold ends.
   */
  readonly suspect: boolean;
  readonly pid: number | undefined;

  constructor(
    message: string,
    facts: {
      readonly reason: LossReason | 'stop' | 'unavailable';
      readonly stuck: boolean;
      readonly detached: boolean;
      readonly started: boolean;
      readonly charged: boolean;
      readonly requeue: boolean;
      readonly suspect: boolean;
      readonly pid: number | undefined;
    },
  ) {
    super(message);
    this.name = 'HelperLostError';
    this.reason = facts.reason;
    this.stuck = facts.stuck;
    this.detached = facts.detached;
    this.started = facts.started;
    this.charged = facts.charged;
    this.requeue = facts.requeue;
    this.suspect = facts.suspect;
    this.pid = facts.pid;
  }
}

export function isHelperLost(error: unknown): error is HelperLostError {
  return error instanceof HelperLostError;
}

/**
 * Whether a lookup lost with its child may be asked again (D26, D27): only after an `exit` or a
 * `memory` loss, and only if the child had not said it was stuck, it was not detached when the
 * child went quiet, and the crash is not charged to it. A hung child's lookups never are. Nor is
 * any lookup of an `exit` loss that `ends` the helper for now (it rests, or the probe stops): with
 * no child to ask it in, it would be asked on the probe's lanes, and it may be what crashed it.
 */
export function mayRequeue(
  reason: LossReason,
  lookup: { readonly stuck: boolean; readonly detached: boolean; readonly charged: boolean },
  ends = false,
): boolean {
  if (reason !== 'exit' && reason !== 'memory') return false;
  if (reason === 'exit' && ends) return false;
  return !lookup.stuck && !lookup.detached && !lookup.charged;
}

/** A name that crashed `getaddrinfo` (D27). */
export interface PoisonMark {
  readonly host: string;
  readonly family: HelperFamily;
  readonly markedAt: number;
  /** The signal the child died of, once known. */
  signal: NodeJS.Signals | null;
  /** When it is next asked, alone, here. */
  nextAskAt: number;
  /** How long after an ask it is asked again: an hour, doubled at each crash, a day at most. */
  retryMs: number;
}

/** A crash charged to a name: a new poison mark, or a poison name crashing again at its re-ask. */
export type ChargedKind = 'new' | 'again';

/** A child lost, as its log line says it. Completed when the child's exit status is known. */
export interface HelperLoss {
  readonly at: number;
  readonly reason: LossReason;
  readonly pid: number | undefined;
  readonly why: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** What the child said as it ended itself (`fatal`), once read. */
  fatal: string | undefined;
  /** Lookups the child had said were stuck. */
  readonly held: number;
  /** Lookups that may be asked again. */
  readonly requeued: number;
  /** Lookups neither: hung, detached, or charged. */
  readonly faulted: number;
  /**
   * The name the crash is charged to: a suspect while isolating, or a poison name's re-ask, alone
   * in a child ended by a signal a crash raises (`P-453`).
   */
  readonly chargedTo: string | undefined;
  /** Whether that made a new poison mark or crashed again at a re-ask. */
  readonly charged: ChargedKind | undefined;
}

/**
 * A change of state, of route or of isolation, emitted a microtask after the lookups it affects
 * were settled. `state === previous` when only the route or isolation moved.
 */
export interface HelperChange {
  readonly state: HelperState;
  readonly previous: HelperState;
  readonly route: RouteState;
  /** Whether the lookups asked again after a crash are being sent alone (D27), at this change. */
  readonly isolating: boolean;
  /** The loss that moved it, when one did. */
  readonly loss?: LossReason;
  /**
   * At that loss's change, when the crash was charged to a name: `new` when it made a poison mark,
   * `again` when a poison name crashed again at its re-ask. The trouble latch counts a loss toward
   * its three in ten minutes unless it is `again`: a fault already found, and asked on purpose.
   */
  readonly charged?: ChargedKind;
  /** At `unresponsive`, or a stopping child gone quiet: each lookup in flight, now detached (D26). */
  readonly detached?: readonly object[];
  /** At `backoff` or `resting`: the wait before the next child. Absent for a rest until restart. */
  readonly delayMs?: number;
}

export interface LookupHelperStats {
  readonly state: HelperState;
  readonly route: RouteState;
  readonly pid: number | undefined;
  readonly inFlight: number;
  readonly losses: number;
  readonly lossesByReason: Readonly<Record<LossReason, number>>;
  readonly lastLoss: Readonly<HelperLoss> | undefined;
  /**
   * The live child's resident set at its last beat, undefined while there is no child (lost,
   * resting, stopped) or before its first beat; and the most seen.
   */
  readonly rss: number | undefined;
  readonly rssPeak: number;
  /** The child's event loop's worst delay at its last beat, and the most seen. */
  readonly lagMaxMs: number | undefined;
  readonly lagPeakMs: number;
  readonly isolating: boolean;
  readonly poisoned: number;
  readonly msInState: Readonly<Record<HelperState, number>>;
  /** Liveness: ticks judged, the quiet and heard runs now, and messages read from this child. */
  readonly ticks: number;
  readonly quietTicks: number;
  readonly heardTicks: number;
  readonly messages: number;
  /** The rest now, when resting on a timer. */
  readonly restMs: number | undefined;
}

/** The part of a child process the helper uses: `fork`'s in production, a script's in tests. */
export interface HelperProcess {
  readonly pid?: number | undefined;
  readonly stderr: Readable | null;
  readonly channel?: { unref(): void } | null | undefined;
  send(message: AskMessage, callback: (error: Error | null) => void): boolean;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'disconnect' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * `fork`'s options, and `windowsHide`: `fork` hands its options on to `spawn`, which honours it,
 * though `@types/node` leaves it out of `ForkOptions`.
 */
export type HelperForkOptions = ForkOptions & { readonly windowsHide?: boolean };

export type ForkHelper = (
  module: string,
  args: readonly string[],
  options: HelperForkOptions,
) => HelperProcess;

export type HelperTimer = object;

/** The clock and timers the helper keeps time with: the process's, unless a test hands its own. */
export interface HelperTimers {
  now(): number;
  /** Unref'd, unless `keepAlive`: only the start's wait holds the process open. */
  setTimeout(fn: () => void, ms: number, keepAlive?: boolean): HelperTimer;
  clearTimeout(timer: HelperTimer | undefined): void;
  setInterval(fn: () => void, ms: number): HelperTimer;
  clearInterval(timer: HelperTimer | undefined): void;
}

/**
 * Real timers, every one unref'd but the start's wait: the helper never keeps the probe alive,
 * except while the probe's start is waiting for it, when nothing else may be holding it open yet.
 */
export const REAL_TIMERS: HelperTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms, keepAlive) => {
    const timer = setTimeout(fn, ms);
    return keepAlive === true ? timer : timer.unref();
  },
  clearTimeout: (timer) => {
    if (timer !== undefined) clearTimeout(timer as NodeJS.Timeout);
  },
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (timer) => {
    if (timer !== undefined) clearInterval(timer as NodeJS.Timeout);
  },
};

/**
 * What the resolver uses of the helper (S3). A lost lookup's rejection reaches a handler attached
 * to the promise `ask` returns before the change that follows it; a handler a step further on
 * (`.then(a).catch(b)`, an `async` wrapper that awaits again) may see the change first.
 *
 * - **Read `routeState()` just before each `ask`**, never the route of the last change: at a loss
 *   the state moves before its change is handed on, and a child judged quiet while the probe stops
 *   routes `down` at once. An ask refused for it rejects with reason `unavailable`: nothing was
 *   sent, so the lookup is kept and routed again, never faulted (`requeue` does not say so). So
 *   is one asked while a lost child's exit is awaited (`P-453`), the route still `up` until the
 *   loss is taken, a second at most.
 * - **Ask `avoidsSystem(host, family)` before any name goes to the probe's own `getaddrinfo`, in
 *   any state, and again as it starts there**: a name it names may be what crashed the helper, so
 *   it is asked in the helper while the route is `up` or `rejoining`, and fails its check at once
 *   (`RESOLVER_FAULT`) while it is `resting` or `down`. The name check never walks it, so it is
 *   never heard or sampled. A name becomes avoided at any loss, a lookup of it waiting on the
 *   probe's lanes included.
 */
export interface HelperPort {
  start(snapshot?: HelperSnapshot): Promise<boolean>;
  ask(request: HelperAsk): Promise<HelperAnswer>;
  routeState(): RouteState;
  isolating(): boolean;
  endIsolation(): void;
  /** A suspect is held for `forMs` before it is asked again alone: the lapse waits for it (D27). */
  suspectHeld(forMs: number): void;
  avoidsSystem(host: string, family: HelperFamily): boolean;
  poison(host: string, family: HelperFamily): PoisonMark | undefined;
  poisonDue(): readonly PoisonMark[];
  markSkewed(file: string): void;
  stats(): LookupHelperStats;
  stop(): Promise<void>;
}

export interface LookupHelperOptions {
  readonly logger: Logger;
  /** The child's entry. The production child unless a test hands in a scripted one. */
  readonly childModule?: string;
  /** The Node the child runs on: the probe's. */
  readonly execPath?: string;
  /** The environment the child's is made from: the probe's unless a test hands one in. */
  readonly env?: NodeJS.ProcessEnv;
  /** The probe's lifecycle signal: once aborted, no new child is started. */
  readonly signal?: AbortSignal;
  readonly timers?: HelperTimers;
  readonly fork?: ForkHelper;
  readonly limits?: Partial<HelperLimits>;
  readonly self?: HelperSelf;
  /** Every change of state, a microtask after the lookups it affects were settled. */
  readonly onChange?: (change: HelperChange) => void;
  /** A lost child's answer for a lookup requeued and not asked again since (L-F5). */
  readonly onLateAnswer?: (ref: object, outcome: LateOutcome) => void;
}

/**
 * The child's environment (L-N2): the probe's, less what must never reach it. Windows reads
 * names in any case (`Node_Options` is `NODE_OPTIONS` there), so on win32 they are compared so.
 */
export function helperEnv(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const anyCase = platform === 'win32';
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const said = anyCase ? name.toUpperCase() : name;
    // systemd's: the child must never vouch for the probe (P-243). The probe's own settings. And
    // every Node one, `NODE_OPTIONS` first: a `--require` meant for the probe is not the child's.
    if (NOT_INHERITED.has(said) || said.startsWith('MS_') || said.startsWith('NODE_')) continue;
    // Set below, and only once.
    if (said === 'UV_THREADPOOL_SIZE') continue;
    env[name] = value;
  }
  env['UV_THREADPOOL_SIZE'] = String(HELPER_THREADS);
  return env;
}

let selfSeen: HelperSelf | undefined;

/** This process: what a child must match. Read once, since the report is not free. */
export function helperSelf(): HelperSelf {
  selfSeen ??= { node: process.version, glibc: glibcRuntime(), order: getDefaultResultOrder() };
  return selfSeen;
}

/** One counter for every ask this process makes, so no id is ever used twice (L-F5). */
let lastAskId = 0;

const poisonKey = (host: string, family: HelperFamily): string => `${String(family)}:${host}`;

/** The families a lookup of `family` asks for: `0` asks both, so it meets 4 and 6 alike. */
export const familiesMet = (family: HelperFamily): readonly HelperFamily[] =>
  family === 0 ? [0, 4, 6] : [family, 0];

interface InFlight {
  readonly id: number;
  readonly host: string;
  readonly family: HelperFamily;
  readonly max: number;
  readonly ref: object;
  /** A suspect asked while isolating (D27), until isolation ends: a crash may be charged to it. */
  suspect: boolean;
  /** A poison name's hourly ask: a crash is charged to it whether or not the helper isolates. */
  readonly poisonAsk: boolean;
  readonly onStuck: ((ranMs: number) => void) | undefined;
  stuck: boolean;
  detached: boolean;
  /** Its ask could not be written to the child: it cannot have crashed it (`P-453`). */
  unsent: boolean;
  readonly resolve: (answer: HelperAnswer) => void;
  readonly reject: (error: Error) => void;
}

/** A loss waiting for the child's exit (`P-453`): why it was lost, and the wait's bound. */
interface ExitWait {
  readonly why: string;
  /** The bound has passed: the loss is taken with no exit read. */
  over: boolean;
  timer: HelperTimer | undefined;
}

interface ChildRecord {
  readonly process: HelperProcess | undefined;
  readonly pid: number | undefined;
  readonly spawnedAt: number;
  /** Asked of this child and not answered. */
  readonly table: Map<number, InFlight>;
  /** Lost with it and requeued: a late answer may settle one, until its channel closes. */
  readonly requeued: Map<number, object>;
  ready: ReadyMessage | undefined;
  lost: LossReason | 'stop' | undefined;
  loss: HelperLoss | undefined;
  lossSaid: boolean;
  connected: boolean;
  exited: boolean;
  closed: boolean;
  fatal: string | undefined;
  stderr: string;
  startTimer: HelperTimer | undefined;
  /** The poison mark its crash was charged to (D27). */
  chargedKey: string | undefined;
  /** The signal it ended with, once its exit is read: undefined until then (`P-453`). */
  endSignal: NodeJS.Signals | null | undefined;
  /**
   * Lost, and its loss waiting for the exit to say whether it crashed (`P-453`). Nothing is sent
   * to it, and nothing it says is read, meanwhile.
   */
  ending: ExitWait | undefined;
  mismatches: number;
  readonly exit: Promise<void>;
  readonly markExited: () => void;
}

/** What follows a loss of the current child, decided before its lookups are told (§1.11). */
type AfterLoss =
  | { readonly kind: 'stopping' }
  | {
      readonly kind: 'rest';
      readonly reason: LossReason;
      readonly untilRestart: boolean;
      readonly why: string;
    }
  | { readonly kind: 'backoff'; readonly reason: LossReason; readonly delayMs: number };

/** What a change says of the loss that moved it. */
interface LossSaid {
  readonly loss?: LossReason;
  readonly charged?: ChargedKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function readAddresses(value: unknown): HelperAddress[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const addresses: HelperAddress[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { address, family } = item;
    if (typeof address !== 'string' || (family !== 4 && family !== 6)) return undefined;
    addresses.push({ address, family });
  }
  return addresses;
}

/** A child's message, if it is one this parent can read (validated on receipt). */
export function readChildMessage(raw: unknown): ChildMessage | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw['t']) {
    case 'ready': {
      const { protocol, order, threads, pid, selfTest, node, glibc, digests } = raw;
      if (!isCount(protocol) || typeof order !== 'string' || !isCount(threads)) return undefined;
      if (!isCount(pid) || typeof selfTest !== 'boolean' || typeof node !== 'string')
        return undefined;
      if (glibc !== null && typeof glibc !== 'string') return undefined;
      if (!isRecord(digests)) return undefined;
      const read: Record<string, string> = {};
      for (const [file, digest] of Object.entries(digests)) {
        if (typeof digest !== 'string') return undefined;
        read[file] = digest;
      }
      return { t: 'ready', protocol, order, threads, pid, selfTest, node, glibc, digests: read };
    }
    case 'answer': {
      const { id, ok, ranMs } = raw;
      if (!isCount(id) || !isCount(ranMs)) return undefined;
      if (ok === true) {
        const addresses = readAddresses(raw['addresses']);
        const total = raw['total'];
        if (addresses === undefined || !isCount(total) || total < addresses.length)
          return undefined;
        return { t: 'answer', id, ok: true, total, addresses, ranMs };
      }
      if (ok !== false) return undefined;
      const { code, message } = raw;
      if ((code !== null && typeof code !== 'string') || typeof message !== 'string') {
        return undefined;
      }
      return { t: 'answer', id, ok: false, code, message, ranMs };
    }
    case 'stuck': {
      const { id, ranMs } = raw;
      return isCount(id) && isCount(ranMs) ? { t: 'stuck', id, ranMs } : undefined;
    }
    case 'beat': {
      const { seq, rss, inFlight, asked, lagMaxMs } = raw;
      if (!isCount(seq) || !isCount(rss) || !isCount(inFlight) || !isCount(asked)) {
        return undefined;
      }
      if (!isCount(lagMaxMs)) return undefined;
      return { t: 'beat', seq, rss, inFlight, asked, lagMaxMs };
    }
    case 'fatal': {
      const { message } = raw;
      return typeof message === 'string' ? { t: 'fatal', message } : undefined;
    }
    default:
      return undefined;
  }
}

/** Two digest tables say the same: the same files, each read the same. */
function sameDigests(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((file) => Object.hasOwn(b, file) && b[file] === a[file]);
}

const answerOf = (message: AnswerMessage): HelperAnswer => ({
  addresses: message.addresses,
  total: message.total,
  ranMs: message.ranMs,
});

const failureOf = (message: FailedMessage): HelperLookupError =>
  new HelperLookupError(message.message, message.code ?? undefined, message.ranMs);

export class LookupHelper implements HelperPort {
  readonly #logger: Logger;
  readonly #childModule: string;
  readonly #execPath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #signal: AbortSignal | undefined;
  readonly #timers: HelperTimers;
  readonly #fork: ForkHelper;
  readonly #limits: HelperLimits;
  readonly #self: HelperSelf | undefined;
  readonly #onChange: ((change: HelperChange) => void) | undefined;
  readonly #onLateAnswer: ((ref: object, outcome: LateOutcome) => void) | undefined;

  #state: HelperState = 'idle';
  #stateSince: number;
  readonly #msInState: Record<HelperState, number> = {
    idle: 0,
    starting: 0,
    up: 0,
    unresponsive: 0,
    backoff: 0,
    resting: 0,
    stopping: 0,
    stopped: 0,
  };
  #lastRoute: RouteState = 'down';
  #snapshot: HelperSnapshot = { digests: {} };
  /** The child asks go to, while it is not lost. */
  #child: ChildRecord | undefined;
  #tick: HelperTimer | undefined;
  #backoffTimer: HelperTimer | undefined;
  #restTimer: HelperTimer | undefined;
  #rejoinTimer: HelperTimer | undefined;
  #startWaitTimer: HelperTimer | undefined;
  #startWaiters: ((up: boolean) => void)[] = [];
  #stopping: Promise<void> | undefined;

  /** Liveness (§1.11): messages read from the current child, and the ticks that judged them. */
  #heard = 0;
  #judgedAt = 0;
  #quiet = 0;
  #heardTicks = 0;
  #ticks = 0;
  /** The current child answers: false from the tick it is judged quiet until it is heard again. */
  #answering = false;
  /** Ticks it was heard on since it stopped answering, too few in a row to bring it back. */
  #heardSince = 0;
  #notAnsweringWarnAt: number | undefined;
  #notAnsweringUnsaid = 0;

  /** After a loss, until its timer closes it: the resolver keeps lookups for the next child. */
  #rejoinOpen = false;
  /** Which loss's window is open: a timer closes only its own (R2-1). */
  #rejoinWindow = 0;
  /**
   * Every loss in the last `stableMs` but those charged to a name, and every `exit` loss:
   * isolation's count (D27).
   */
  #losses: number[] = [];
  #exitLosses: number[] = [];
  readonly #lossTotals: Record<LossReason, number> = {
    start: 0,
    skew: 0,
    exit: 0,
    hung: 0,
    memory: 0,
  };
  #lastLoss: HelperLoss | undefined;
  #upAt: number | undefined;
  #restEndedAt: number | undefined;
  #restLevel = 0;
  #restMs: number | undefined;
  /** A read-once file changed (D28): the next loss rests the helper until the probe restarts. */
  #skewed: string | undefined;
  readonly #skewSaid = new Set<string>();
  #isolating = false;
  /**
   * Isolation's lapse (D27): its timer, the instant it falls on the helper's clock, and the
   * generation of its timer, so that a timer whose callback still waits for the polls when a later
   * crash or hold arms another never ends isolation (as the rejoin window's, R2-1).
   */
  #isolationTimer: HelperTimer | undefined;
  #lapseAt = 0;
  #lapseGeneration = 0;
  readonly #poison = new Map<string, PoisonMark>();
  /**
   * Each name in flight at an `exit` or a `memory` loss, charged or not, kept off probe lanes:
   * with the time its ten minutes run from, the helper's next `up`, and undefined until then.
   */
  readonly #crashed = new Map<string, number | undefined>();
  /** The current suspects, sent alone until they answer or isolation ends (D27). */
  readonly #suspects = new Set<string>();
  /** The id each lookup was last asked under: a late answer under an older one is dropped. */
  readonly #lastAsked = new WeakMap<object, number>();

  #rss: number | undefined;
  #rssPeak = 0;
  #lagMax: number | undefined;
  #lagPeak = 0;

  constructor(options: LookupHelperOptions) {
    this.#logger = options.logger.child({ component: 'lookup-helper' });
    this.#childModule = options.childModule ?? join(import.meta.dirname, 'lookup-helper-child.js');
    this.#execPath = options.execPath ?? process.execPath;
    this.#env = options.env ?? process.env;
    this.#signal = options.signal;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#fork =
      options.fork ?? ((module, args, forkOptions) => fork(module, [...args], forkOptions));
    this.#limits = { ...HELPER_LIMITS, ...options.limits };
    this.#self = options.self;
    this.#onChange = options.onChange;
    this.#onLateAnswer = options.onLateAnswer;
    this.#stateSince = this.#timers.now();
  }

  get state(): HelperState {
    return this.#state;
  }

  /** The current child's pid, while there is one. */
  pid(): number | undefined {
    return this.#child?.pid;
  }

  /**
   * Starts the first child. Resolves true once it is up, or false when it is not up within
   * `startWaitMs` (decided after polls), when it rests, or when the probe stops. Never rejects: a
   * child that fails is a loss, and the helper goes on trying in the background.
   */
  start(snapshot: HelperSnapshot = { digests: {} }): Promise<boolean> {
    if (this.#state !== 'idle') return Promise.resolve(this.#state === 'up');
    this.#snapshot = snapshot;
    const waiting = new Promise<boolean>((resolve) => {
      this.#startWaiters.push(resolve);
    });
    if (this.#signal?.aborted === true) {
      this.#setState('stopping');
      this.#settleStart(false);
      return waiting;
    }
    this.#signal?.addEventListener(
      'abort',
      () => {
        this.#onAbort();
      },
      { once: true },
    );
    this.#tick = this.#timers.setInterval(() => {
      afterPolls(() => {
        this.#judge();
      });
    }, this.#limits.tickMs);
    // Held open: a start awaited before anything else keeps the process up must not end it.
    this.#startWaitTimer = this.#timers.setTimeout(
      () => {
        afterPolls(() => {
          this.#settleStart(this.#state === 'up');
        });
      },
      this.#limits.startWaitMs,
      true,
    );
    this.#spawn();
    return waiting;
  }

  /** Where the resolver sends a lookup now (§1.3). */
  routeState(): RouteState {
    switch (this.#state) {
      case 'up':
        return 'up';
      case 'resting':
        return 'resting';
      case 'starting':
      case 'backoff':
        return this.#rejoinOpen ? 'rejoining' : 'down';
      case 'stopping':
        // A child still connected and answering serves the check pool's drain (L-N1). One judged
        // quiet does not, whether it went quiet before the probe began to stop or since.
        return this.#serving() !== undefined && this.#answering ? 'up' : 'down';
      default:
        return 'down';
    }
  }

  /** The current child, ready, not lost, not waiting for its exit (`P-453`) and connected. */
  #serving(): ChildRecord | undefined {
    const record = this.#child;
    if (
      record?.ready === undefined ||
      record.lost !== undefined ||
      record.ending !== undefined ||
      !record.connected
    ) {
      return undefined;
    }
    return record;
  }

  /**
   * Asks the child for a name. Resolves with `getaddrinfo`'s addresses, rejects with its error
   * (`HelperLookupError`), or with `HelperLostError` when the child is lost first or the helper
   * is not up.
   */
  ask(request: HelperAsk): Promise<HelperAnswer> {
    const record = this.#serving();
    // Sent only while the route says so: never to a child judged quiet (D26).
    if (record?.process === undefined || this.routeState() !== 'up') {
      return Promise.reject(
        new HelperLostError(
          `the lookup helper is not up (${this.#state}): ${request.host} was not asked`,
          {
            reason: 'unavailable',
            stuck: false,
            detached: false,
            started: false,
            charged: false,
            requeue: false,
            suspect: false,
            pid: this.#child?.pid,
          },
        ),
      );
    }
    if (request.host.length > 1_024 || !Number.isSafeInteger(request.max) || request.max < 0) {
      // The child would end itself on an ask it cannot read, and take every other lookup with it.
      return Promise.reject(
        new HelperLookupError(
          `the lookup helper cannot be asked for ${request.host.slice(0, 64)}`,
          undefined,
          0,
        ),
      );
    }
    const child = record.process;
    lastAskId += 1;
    const id = lastAskId;
    const ref = request.ref ?? {};
    this.#lastAsked.set(ref, id);
    const key = poisonKey(request.host, request.family);
    const mark = this.#poison.get(key);
    // A poison name's re-ask: not due again while it runs, and charged with a crash (D27).
    if (mark !== undefined) mark.nextAskAt = this.#timers.now() + mark.retryMs;
    // A suspect only while isolating (D27): a crash outside isolation is charged to no one.
    const suspect = request.suspect === true && this.#isolating;
    if (suspect) this.#suspects.add(key);
    return new Promise<HelperAnswer>((resolve, reject) => {
      const flight: InFlight = {
        id,
        host: request.host,
        family: request.family,
        max: request.max,
        ref,
        suspect,
        poisonAsk: mark !== undefined,
        onStuck: request.onStuck,
        stuck: false,
        detached: false,
        unsent: false,
        resolve,
        reject,
      };
      record.table.set(id, flight);
      const message: AskMessage = {
        t: 'ask',
        id,
        host: request.host,
        family: request.family,
        max: request.max,
      };
      const failed = (error: unknown): void => {
        const words = error instanceof Error ? error.message : String(error);
        flight.unsent = true;
        this.#lose(record, 'exit', `an ask could not be written to it: ${words}`);
      };
      try {
        // A callback on every send (L-F5): an error reaches it, never an uncaught 'error'.
        child.send(message, (error) => {
          if (error !== null) failed(error);
        });
      } catch (error: unknown) {
        failed(error);
      }
    });
  }

  /** Whether the lookups asked again after a crash are being sent alone (D27). */
  isolating(): boolean {
    return this.#isolating;
  }

  /** The resolver has no suspect left: isolation is over, and no new suspect is asked. */
  endIsolation(): void {
    this.#endIsolation('the resolver has no suspect left');
  }

  /**
   * A suspect the resolver holds for `forMs` (its hold, and a tick to ask it in) before asking it
   * again alone (D27): the lapse falls no sooner than that and `stuckMs` more, so that the suspect
   * is asked alone and the child can say it is stuck before isolation ends.
   */
  suspectHeld(forMs: number): void {
    if (!this.#isolating) return;
    const at = this.#timers.now() + forMs + this.#limits.stuckMs;
    if (at <= this.#lapseAt) return;
    this.#lapseAt = at;
    this.#armIsolationLapse();
  }

  #endIsolation(why: string): void {
    if (!this.#isolating) return;
    this.#isolating = false;
    this.#timers.clearTimeout(this.#isolationTimer);
    this.#isolationTimer = undefined;
    // No new suspect (D27). One still in flight stays one until it settles: a crash on its slow
    // reply, after the child said it was stuck and isolation ended, is still charged to it.
    this.#suspects.clear();
    this.#logger.info({ why }, 'the lookup helper is no longer isolating suspects');
    this.#emitIsolation();
  }

  /**
   * Isolation's lapse, armed again at each crash while it is on and at each suspect held (D27): it
   * ends isolation at `#lapseAt`, a suspect in flight or not, after the polls, so that an answer
   * already in the pipe is read first. Only its own generation's: a timer that fired before a later
   * crash or hold armed another, its callback still waiting for the polls, does nothing.
   */
  #armIsolationLapse(): void {
    this.#timers.clearTimeout(this.#isolationTimer);
    this.#lapseGeneration += 1;
    const generation = this.#lapseGeneration;
    this.#isolationTimer = this.#timers.setTimeout(() => {
      this.#isolationTimer = undefined;
      afterPolls(() => {
        if (generation !== this.#lapseGeneration) return;
        this.#endIsolation(
          `its lapse: ${String(this.#limits.isolationMaxMs)} ms since the last crash, and any held suspect's hold, have passed`,
        );
      });
    }, this.#lapseAt - this.#timers.now());
  }

  /**
   * Whether the probe's own `getaddrinfo` must not be asked for this name now: it is poison, a
   * current suspect, or was in flight at an `exit` or a `memory` loss, until `stableMs` after the
   * helper was next up, in its family or one a lookup of it would also ask for. The resolver asks before routing a
   * name to the probe's lanes in any state: in the helper instead while it can ask, and otherwise
   * its check fails.
   */
  avoidsSystem(host: string, family: HelperFamily): boolean {
    const now = this.#timers.now();
    for (const met of familiesMet(family)) {
      const key = poisonKey(host, met);
      if (this.#poison.has(key) || this.#suspects.has(key)) return true;
      if (this.#crashed.has(key)) {
        const since = this.#crashed.get(key);
        if (since === undefined || now - since < this.#limits.stableMs) return true;
      }
    }
    return false;
  }

  /** The name's poison mark, while it has one (D27). */
  poison(host: string, family: HelperFamily): PoisonMark | undefined {
    return this.#poison.get(poisonKey(host, family));
  }

  /**
   * The poison names due their hourly ask. One due a whole period ago and not asked, since the
   * resolver found no moment with nothing in flight, waits for its next (D27): a re-ask put off
   * costs nothing, and one that waited would hold every lookup back.
   */
  poisonDue(): readonly PoisonMark[] {
    const now = this.#timers.now();
    const due: PoisonMark[] = [];
    for (const mark of this.#poison.values()) {
      if (mark.nextAskAt > now) continue;
      if (now - mark.nextAskAt < mark.retryMs) {
        due.push(mark);
        continue;
      }
      mark.nextAskAt = now + mark.retryMs;
      this.#logger.debug(
        { host: mark.host, family: mark.family, nextAskInMs: mark.retryMs },
        'a poison name’s re-ask found the lookup helper never idle: it waits for its next',
      );
    }
    return due;
  }

  /**
   * A read-once file changed (D28): the current child is kept, and the next loss rests the helper
   * until the probe restarts, since a new child would read the new file and the probe the old.
   */
  markSkewed(file: string): void {
    this.#skewed ??= file;
    if (this.#skewSaid.has(file)) return;
    this.#skewSaid.add(file);
    this.#logger.warn({ file }, `${file} changed: restart ms-probe to apply it`);
  }

  stats(): LookupHelperStats {
    const now = this.#timers.now();
    const msInState = { ...this.#msInState };
    msInState[this.#state] += now - this.#stateSince;
    return {
      state: this.#state,
      route: this.routeState(),
      pid: this.#child?.pid,
      inFlight: this.#child?.table.size ?? 0,
      losses: Object.values(this.#lossTotals).reduce((sum, n) => sum + n, 0),
      lossesByReason: { ...this.#lossTotals },
      lastLoss: this.#lastLoss === undefined ? undefined : { ...this.#lastLoss },
      rss: this.#rss,
      rssPeak: this.#rssPeak,
      lagMaxMs: this.#lagMax,
      lagPeakMs: this.#lagPeak,
      isolating: this.#isolating,
      poisoned: this.#poison.size,
      msInState,
      ticks: this.#ticks,
      quietTicks: this.#quiet,
      heardTicks: this.#heardTicks,
      messages: this.#heard,
      restMs: this.#state === 'resting' ? this.#restMs : undefined,
    };
  }

  /**
   * Ends the helper: no new child, every lookup in flight rejected (`stop`), the child SIGKILLed
   * and waited for at most `stopMs`.
   */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    for (const timer of [this.#backoffTimer, this.#restTimer, this.#startWaitTimer]) {
      this.#timers.clearTimeout(timer);
    }
    this.#timers.clearInterval(this.#tick);
    this.#isolating = false;
    this.#timers.clearTimeout(this.#isolationTimer);
    this.#isolationTimer = undefined;
    this.#closeRejoin();
    const record = this.#child;
    this.#child = undefined;
    this.#rss = undefined;
    if (this.#state !== 'stopping') this.#setState('stopping');
    if (record !== undefined && record.lost === undefined) {
      record.lost = 'stop';
      this.#timers.clearTimeout(record.startTimer);
      this.#timers.clearTimeout(record.ending?.timer);
      const lost = [...record.table.values()];
      record.table.clear();
      for (const flight of lost) {
        flight.reject(
          new HelperLostError(`the probe is stopping: ${flight.host} was not answered`, {
            reason: 'stop',
            stuck: flight.stuck,
            detached: flight.detached,
            started: true,
            charged: false,
            requeue: false,
            suspect: false,
            pid: record.pid,
          }),
        );
      }
      this.#killProcess(record);
      let waited: HelperTimer | undefined;
      await Promise.race([
        record.exit,
        new Promise<void>((resolve) => {
          waited = this.#timers.setTimeout(resolve, this.#limits.stopMs);
        }),
      ]);
      this.#timers.clearTimeout(waited);
    }
    this.#setState('stopped');
    this.#settleStart(false);
  }

  #onAbort(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') return;
    for (const timer of [this.#backoffTimer, this.#restTimer]) this.#timers.clearTimeout(timer);
    this.#closeRejoin();
    this.#logger.debug(
      'the probe is stopping: the lookup helper serves until it stops, and is not replaced',
    );
    this.#setState('stopping');
    this.#settleStart(false);
  }

  #spawn(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') return;
    this.#setState('starting');
    const now = this.#timers.now();
    let markExited = (): void => {};
    const exit = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const args = helperChildArgs({
      protocol: this.#limits.protocol,
      order: (this.#self ?? helperSelf()).order,
      stuckMs: this.#limits.stuckMs,
      beatMs: this.#limits.beatMs,
      digests: Object.keys(this.#snapshot.digests),
    });
    let child: HelperProcess | undefined;
    let spawnError: unknown;
    try {
      child = this.#fork(this.#childModule, args, {
        execPath: this.#execPath,
        execArgv: [`--max-old-space-size=${String(this.#limits.heapMb)}`],
        env: helperEnv(this.#env),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'json',
        // As every probe child: on Windows, its own hidden console, so the Ctrl+C WinSW sends
        // the probe at a stop does not end it before the drain it serves (L-N1).
        windowsHide: true,
      });
    } catch (error: unknown) {
      spawnError = error;
    }
    const record: ChildRecord = {
      process: child,
      pid: child?.pid,
      spawnedAt: now,
      table: new Map(),
      requeued: new Map(),
      ready: undefined,
      lost: undefined,
      loss: undefined,
      lossSaid: false,
      connected: child !== undefined,
      exited: child === undefined,
      closed: child === undefined,
      fatal: undefined,
      stderr: '',
      startTimer: undefined,
      chargedKey: undefined,
      endSignal: undefined,
      ending: undefined,
      mismatches: 0,
      exit,
      markExited,
    };
    if (child === undefined) {
      markExited();
      this.#child = record;
      const words = spawnError instanceof Error ? spawnError.message : String(spawnError);
      this.#lose(record, 'start', `it could not be started: ${words}`);
      return;
    }
    this.#child = record;
    // For its whole life (L-F5): a spawn failure, a failed kill or a channel error is a loss,
    // never an uncaught exception in the probe.
    child.on('error', (error: Error) => {
      this.#onError(record, error);
    });
    child.on('message', (message: unknown) => {
      this.#onMessage(record, message);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#onExit(record, code, signal);
    });
    child.on('disconnect', () => {
      this.#onDisconnect(record);
    });
    child.on('close', () => {
      record.closed = true;
      record.markExited();
      this.#sayLoss(record);
    });
    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.setEncoding('utf8');
      stderr.on('data', (chunk: string) => {
        record.stderr = (record.stderr + chunk).slice(-STDERR_KEEP);
      });
      (stderr as Readable & { unref?: () => void }).unref?.();
    }
    child.unref();
    child.channel?.unref();
    record.startTimer = this.#timers.setTimeout(() => {
      afterPolls(() => {
        if (this.#child !== record || record.ready !== undefined || record.lost !== undefined)
          return;
        this.#lose(
          record,
          'start',
          `it had not said it was ready after ${String(this.#limits.startMs)} ms`,
        );
      });
    }, this.#limits.startMs);
  }

  #onError(record: ChildRecord, error: Error): void {
    this.#logger.warn(
      { err: error, pid: record.pid },
      'the lookup helper’s process reported an error',
    );
    if (record.pid === undefined) {
      // It never started: no 'exit' will tell of it.
      record.exited = true;
      record.closed = true;
      record.markExited();
    }
    this.#lose(
      record,
      record.ready === undefined ? 'start' : 'exit',
      `its process reported an error: ${error.message}`,
    );
  }

  #onExit(record: ChildRecord, code: number | null, signal: NodeJS.Signals | null): void {
    record.exited = true;
    record.endSignal = signal;
    record.markExited();
    const why =
      record.fatal !== undefined
        ? `it ended itself: ${record.fatal}`
        : signal !== null
          ? `it was ended by ${signal}`
          : `it exited with code ${String(code)}`;
    this.#lose(record, record.ready === undefined ? 'start' : 'exit', why);
    if (record.loss !== undefined) {
      record.loss.exitCode = code;
      record.loss.signal = signal;
    }
    this.#fillPoison(record);
  }

  #onDisconnect(record: ChildRecord): void {
    record.connected = false;
    this.#lose(
      record,
      record.ready === undefined ? 'start' : 'exit',
      'its channel to the probe closed',
    );
    // Everything it sent has been read: no late answer can come any more.
    record.requeued.clear();
    if (this.#state === 'stopping') this.#emitRoute();
  }

  #onMessage(record: ChildRecord, raw: unknown): void {
    const message = readChildMessage(raw);
    // Kept from any child, current or not: the loss's line says it.
    if (message?.t === 'fatal') record.fatal = message.message;
    // Lost, and waiting for its exit (`P-453`): nothing more it says is taken.
    if (record.ending !== undefined) return;
    if (record !== this.#child) {
      if (message?.t === 'answer') this.#lateAnswer(record, message);
      return;
    }
    if (message === undefined) {
      this.#lose(
        record,
        record.ready === undefined ? 'start' : 'exit',
        'it sent a message the probe cannot read',
      );
      return;
    }
    this.#heard += 1;
    switch (message.t) {
      case 'ready':
        this.#onReady(record, message);
        return;
      case 'fatal':
        return;
      case 'answer':
        this.#onAnswer(record, message);
        return;
      case 'stuck': {
        const flight = record.table.get(message.id);
        if (flight === undefined || flight.stuck) return;
        flight.stuck = true;
        try {
          flight.onStuck?.(message.ranMs);
        } catch (error: unknown) {
          this.#logger.error({ err: error, host: flight.host }, 'a lookup’s stuck callback failed');
        }
        return;
      }
      case 'beat':
        this.#onBeat(record, message);
        return;
    }
  }

  #onReady(record: ChildRecord, ready: ReadyMessage): void {
    if (record.ready !== undefined) {
      this.#lose(record, 'exit', 'it said it was ready twice');
      return;
    }
    const self = this.#self ?? helperSelf();
    const skew: string[] = [];
    if (ready.node !== self.node) skew.push(`it runs Node ${ready.node}, the probe ${self.node}`);
    if (ready.glibc !== self.glibc) {
      skew.push(`it runs glibc ${String(ready.glibc)}, the probe ${String(self.glibc)}`);
    }
    if (!sameDigests(ready.digests, this.#snapshot.digests)) {
      skew.push('it read different read-once files than the probe did at its start');
    }
    if (skew.length > 0) {
      this.#lose(record, 'skew', skew.join('; '));
      return;
    }
    const wrong: string[] = [];
    if (ready.protocol !== this.#limits.protocol) {
      wrong.push(`it speaks protocol ${String(ready.protocol)}`);
    }
    if (ready.order !== self.order)
      wrong.push(`its address order is ${ready.order}, the probe's ${self.order}`);
    if (lookupLanes(ready.threads) < HELPER_MIN_LOOKUP_LANES) {
      wrong.push(`it has ${String(ready.threads)} libuv threads`);
    }
    if (!ready.selfTest) wrong.push('getaddrinfo did not answer 127.1 in it');
    if (record.pid !== undefined && ready.pid !== record.pid) {
      wrong.push(`it says its pid is ${String(ready.pid)}`);
    }
    if (wrong.length > 0) {
      this.#lose(record, 'start', `its ready was not valid: ${wrong.join('; ')}`);
      return;
    }
    record.ready = ready;
    this.#timers.clearTimeout(record.startTimer);
    const now = this.#timers.now();
    this.#logger.info(
      {
        pid: ready.pid,
        threads: ready.threads,
        order: ready.order,
        node: ready.node,
        glibc: ready.glibc,
        startedInMs: Math.round(now - record.spawnedAt),
      },
      'the lookup helper is ready',
    );
    this.#answering = true;
    this.#judgedAt = this.#heard;
    this.#quiet = 0;
    this.#heardTicks = 0;
    this.#heardSince = 0;
    // Asked to stop meanwhile: it serves the drain, and nothing more.
    if (this.#state !== 'starting') {
      this.#emitRoute();
      return;
    }
    this.#upAt = now;
    this.#setState('up');
    this.#settleStart(true);
  }

  #onAnswer(record: ChildRecord, message: AnswerMessage | FailedMessage): void {
    const flight = record.table.get(message.id);
    if (flight === undefined) {
      this.#logger.debug(
        { id: message.id, pid: record.pid },
        'an answer for a lookup the helper no longer has',
      );
      return;
    }
    if (message.ok && message.addresses.length > flight.max + 1) {
      this.#lose(
        record,
        'exit',
        `it sent ${String(message.addresses.length)} addresses for ${flight.host}`,
      );
      return;
    }
    record.table.delete(message.id);
    const key = poisonKey(flight.host, flight.family);
    // Answered here: no suspect any more, whether or not it was asked as one.
    this.#suspects.delete(key);
    if (this.#poison.delete(key)) {
      this.#logger.info(
        { host: flight.host, family: flight.family },
        'a poison name answered in the lookup helper: it is asked as any other name again',
      );
    }
    if (message.ok) flight.resolve(answerOf(message));
    else flight.reject(failureOf(message));
  }

  #lateAnswer(record: ChildRecord, message: AnswerMessage | FailedMessage): void {
    const ref = record.requeued.get(message.id);
    if (ref === undefined) return;
    record.requeued.delete(message.id);
    // A turn later: an answer read in the same chunk as the message that lost the child would
    // otherwise reach the resolver before the lookup's rejection does.
    setImmediate(() => {
      if (this.#lastAsked.get(ref) !== message.id) {
        // Asked of the new child since: its answer settles the lookup.
        this.#logger.debug(
          { id: message.id, pid: record.pid },
          'a lost lookup helper’s answer for a lookup asked again since: dropped',
        );
        return;
      }
      const outcome: LateOutcome = message.ok
        ? { ok: true, answer: answerOf(message) }
        : { ok: false, error: failureOf(message) };
      try {
        this.#onLateAnswer?.(ref, outcome);
      } catch (error: unknown) {
        this.#logger.error({ err: error }, 'a late answer could not be handed to the resolver');
      }
    });
  }

  #onBeat(record: ChildRecord, beat: BeatMessage): void {
    this.#rss = beat.rss;
    this.#rssPeak = Math.max(this.#rssPeak, beat.rss);
    this.#lagMax = beat.lagMaxMs;
    this.#lagPeak = Math.max(this.#lagPeak, beat.lagMaxMs);
    if (record.ready === undefined) return;
    // In any state the child serves in, quiet and stopping included.
    if (beat.rss > this.#limits.rssMax) {
      this.#lose(
        record,
        'memory',
        `its resident set was ${String(beat.rss)} bytes, past the ${String(this.#limits.rssMax)} it may use`,
      );
      return;
    }
    // What the child could have counted: the asks it had read. Ids come in order on one channel,
    // and its answers before the beat were read before it, so the count is exact under traffic.
    let probeInFlight = 0;
    for (const id of record.table.keys()) if (id <= beat.asked) probeInFlight += 1;
    if (beat.inFlight === probeInFlight) {
      record.mismatches = 0;
      return;
    }
    record.mismatches += 1;
    if (record.mismatches === 3) {
      this.#logger.error(
        { pid: record.pid, seq: beat.seq, childInFlight: beat.inFlight, probeInFlight },
        'the lookup helper and the probe disagree on its lookups in flight, three beats in a row',
      );
    }
  }

  /**
   * One tick's verdict, after the polls (§1.11): never on a timer that could miss a reply. The
   * child is judged while it serves, the probe's stop included (L-N1 serves the drain only with a
   * child that answers). Quiet ticks count from the last tick it answered, across heard ticks that
   * did not bring it back, so a child heard only now and then still reaches `hungTicks`.
   */
  #judge(): void {
    // A child lost and waiting for its exit (`P-453`) is not judged: it has nothing more to say.
    if (this.#child?.ending !== undefined) return;
    const judged =
      this.#state === 'up' ||
      this.#state === 'unresponsive' ||
      (this.#state === 'stopping' && this.#serving() !== undefined);
    if (!judged) return;
    this.#ticks += 1;
    const heard = this.#heard !== this.#judgedAt;
    this.#judgedAt = this.#heard;
    if (this.#answering) {
      if (heard) {
        this.#quiet = 0;
        return;
      }
      this.#quiet += 1;
      if (this.#quiet >= this.#limits.unresponsiveTicks) this.#notAnswering();
    } else if (heard) {
      this.#heardTicks += 1;
      this.#heardSince += 1;
      if (this.#heardTicks >= this.#limits.rejoinTicks) this.#answeringAgain();
      return;
    } else {
      this.#heardTicks = 0;
      this.#quiet += 1;
    }
    if (this.#quiet >= this.#limits.hungTicks) {
      const record = this.#child;
      if (record !== undefined) {
        // What the count is: quiet ticks since it last answered, some perhaps with heard ones
        // between them, never enough in a row to bring it back (R2-3).
        const { tickMs, rejoinTicks } = this.#limits;
        this.#lose(
          record,
          'hung',
          `it was quiet for ${String(this.#quiet)} ticks of ${String(tickMs)} ms since it last answered, and heard on ${String(this.#heardSince)} ticks between them, never ${String(rejoinTicks)} in a row`,
        );
      }
    }
  }

  /** Quiet: its lookups in flight are detached (D26), and the resolver routes as `down`. */
  #notAnswering(): void {
    const record = this.#child;
    this.#answering = false;
    this.#heardTicks = 0;
    this.#heardSince = 0;
    const detached: object[] = [];
    for (const flight of record?.table.values() ?? []) {
      if (flight.detached) continue;
      flight.detached = true;
      detached.push(flight.ref);
    }
    const now = this.#timers.now();
    if (
      this.#notAnsweringWarnAt === undefined ||
      now - this.#notAnsweringWarnAt >= NOT_ANSWERING_WARN_MS
    ) {
      this.#logger.warn(
        {
          pid: record?.pid,
          quietTicks: this.#quiet,
          tickMs: this.#limits.tickMs,
          detached: detached.length,
          alsoNotAnswering: this.#notAnsweringUnsaid,
        },
        'the lookup helper is not answering: its lookups in flight are detached, and names are asked elsewhere',
      );
      this.#notAnsweringWarnAt = now;
      this.#notAnsweringUnsaid = 0;
    } else {
      this.#notAnsweringUnsaid += 1;
    }
    // While the probe stops it stays `stopping`: only the route moves.
    if (this.#state === 'up') this.#setState('unresponsive', { detached });
    else this.#emitRoute({ detached });
  }

  #answeringAgain(): void {
    this.#answering = true;
    this.#quiet = 0;
    this.#heardTicks = 0;
    this.#heardSince = 0;
    this.#logger.info({ pid: this.#child?.pid }, 'the lookup helper is answering again');
    if (this.#state === 'unresponsive') this.#setState('up');
    else this.#emitRoute();
  }

  /**
   * A child lost: every lookup it had is rejected now, in one turn, saying what it was; then a new
   * child, a rest, or nothing when the probe is stopping. Idempotent per child. An `exit` loss with
   * a lookup a crash could be charged to, taken before the exit is read, waits for it
   * (`#awaitExit`, `P-453`).
   */
  #lose(record: ChildRecord, reason: LossReason, why: string): void {
    if (record.lost !== undefined) return;
    const wait = record.ending;
    // Waiting for the exit: only the exit, or the wait's end, takes the loss.
    if (wait !== undefined && record.endSignal === undefined && !wait.over) return;
    if (
      wait === undefined &&
      reason === 'exit' &&
      record.endSignal === undefined &&
      this.#chargeable(record) !== undefined
    ) {
      this.#awaitExit(record, why);
      return;
    }
    // The cause the loss was first taken on, the exit's status filling it in when it comes.
    const said = wait?.why ?? why;
    this.#timers.clearTimeout(wait?.timer);
    record.lost = reason;
    this.#timers.clearTimeout(record.startTimer);
    const current = this.#child === record;
    if (current) {
      this.#child = undefined;
      this.#answering = false;
      // No child, no resident set: the channel gaps until the next child's first beat.
      this.#rss = undefined;
    }
    this.#killProcess(record);
    const now = this.#timers.now();

    // One rule for every crash (D27): charged only to a lookup alone in flight, a suspect asked
    // while isolating (still in flight whether or not isolation has ended since) or a poison
    // name's re-ask. With anything else in flight, said stuck or let go included, no one is
    // charged, so a working name is never made poison for another's crash. And only a crash
    // (`P-453`): an `exit` loss whose child ended by a signal a crash raises. Any other end, a
    // kill from outside, an exit code or no exit read, is charged to no one, and its suspects are
    // asked again alone. `memory`, `hung` and `start` losses are never charged.
    const charged =
      reason === 'exit' && crashedBy(record.endSignal) ? this.#chargeable(record) : undefined;
    const lost = [...record.table.values()];
    record.table.clear();
    let chargedKind: ChargedKind | undefined;
    if (charged !== undefined) {
      const marked = this.#markPoison(charged, now);
      record.chargedKey = marked.key;
      chargedKind = marked.kind;
    }
    // What follows is decided before the lookups are told: a crash that rests the helper, or
    // comes while the probe stops, leaves no child to ask them again in (D27).
    const next = current ? this.#nextAfterLoss(reason, now, charged !== undefined, why) : undefined;
    const ends = next?.kind !== 'backoff';
    const facts = lost.map((flight) => {
      const requeue = mayRequeue(reason, { ...flight, charged: flight === charged }, ends);
      // A crash candidate: asked again, or stuck when the child crashed, since a crash on a slow
      // reply comes after the child said so. Held by the resolver, then asked again alone.
      const stuckCandidate =
        reason === 'exit' && flight.stuck && !flight.detached && flight !== charged;
      return { flight, requeue, candidate: requeue || (stuckCandidate && !ends) };
    });
    let held = 0;
    let requeued = 0;
    let faulted = 0;
    let candidates = 0;
    for (const { flight, requeue, candidate } of facts) {
      if (flight.stuck) held += 1;
      else if (requeue) requeued += 1;
      else faulted += 1;
      if (candidate) candidates += 1;
    }
    if (reason === 'exit') {
      this.#exitLosses = this.#exitLosses.filter((at) => now - at < this.#limits.stableMs);
      this.#exitLosses.push(now);
      // From the second crash in ten minutes that leaves a candidate to ask again (D27).
      if (candidates > 0 && this.#exitLosses.length >= 2 && !this.#isolating) {
        this.#isolating = true;
        this.#lapseAt = 0;
        this.#logger.info(
          { crashes: this.#exitLosses.length, suspects: candidates },
          'the lookup helper is isolating suspects: the lookups asked again are sent alone',
        );
      }
      // Its lapse runs from this crash, whether it began isolation or came during it, and no
      // sooner than a suspect held is asked again.
      if (this.#isolating) {
        this.#lapseAt = Math.max(this.#lapseAt, now + this.#limits.isolationMaxMs);
        this.#armIsolationLapse();
      }
    }
    // Every name in flight, charged or not, crash or not (`P-453`), and at a `memory` loss too:
    // any of them may be what ended the child, a crash or a name whose lookup grows the child's
    // memory until this helper or the kernel's OOM killer ends it, neither of which is told from
    // a kill from outside or a leak. So none goes to the probe's own getaddrinfo until ten minutes
    // after the helper is next up, resting or not.
    if (reason === 'exit' || reason === 'memory') {
      for (const [key, since] of this.#crashed) {
        if (since !== undefined && now - since >= this.#limits.stableMs) this.#crashed.delete(key);
      }
      for (const flight of lost) {
        this.#crashed.set(poisonKey(flight.host, flight.family), undefined);
      }
    }

    for (const { flight, requeue, candidate } of facts) {
      if (requeue) record.requeued.set(flight.id, flight.ref);
      const suspect = candidate && this.#isolating;
      if (suspect) this.#suspects.add(poisonKey(flight.host, flight.family));
      flight.reject(
        new HelperLostError(
          `the lookup helper was lost (${reason}) while asking for ${flight.host}`,
          {
            reason,
            stuck: flight.stuck,
            detached: flight.detached,
            started: true,
            charged: flight === charged,
            requeue,
            suspect,
            pid: record.pid,
          },
        ),
      );
    }
    this.#lossTotals[reason] += 1;
    record.loss = {
      at: now,
      reason,
      pid: record.pid,
      why: said,
      exitCode: null,
      signal: null,
      stderr: '',
      fatal: undefined,
      held,
      requeued,
      faulted,
      chargedTo: charged?.host,
      charged: chargedKind,
    };
    this.#lastLoss = record.loss;
    if (record.closed) this.#sayLoss(record);
    else {
      this.#timers.setTimeout(() => {
        this.#sayLoss(record);
      }, this.#limits.lossSayMs);
    }
    if (next !== undefined) {
      this.#afterLoss(next, chargedKind === undefined ? {} : { charged: chargedKind });
    }
  }

  /** SIGKILL, whatever it is doing: a hung `getaddrinfo` ignores anything gentler. */
  #killProcess(record: ChildRecord): void {
    if (record.process === undefined || record.exited) return;
    try {
      record.process.kill('SIGKILL');
    } catch (error: unknown) {
      this.#logger.warn({ err: error, pid: record.pid }, 'the lookup helper could not be killed');
    }
  }

  /**
   * The lookup a crash of this child would be charged to (D27): the one in flight, a suspect or a
   * poison name's re-ask, whose ask reached the child. Undefined otherwise.
   */
  #chargeable(record: ChildRecord): InFlight | undefined {
    if (record.table.size !== 1) return undefined;
    const [only] = record.table.values();
    if (only === undefined || only.unsent) return undefined;
    return only.suspect || only.poisonAsk ? only : undefined;
  }

  /**
   * An `exit` loss taken before the child's exit was read, with a lookup a crash would be charged
   * to (`P-453`): its channel closed first, a send failed, or it broke the protocol. Whether it
   * crashed is the signal it ends with, so the loss waits for the exit, the child killed now so
   * that it exits whatever it was doing (a kill does nothing to one already dead, whose exit still
   * says how it died). Nothing is sent to it, and nothing it says is read, meanwhile. An exit not
   * read within `exitWaitMs`, after the polls so that one already in the pipe is read first, is
   * taken as no crash: the loss is charged to no one.
   */
  #awaitExit(record: ChildRecord, why: string): void {
    const wait: ExitWait = { why, over: false, timer: undefined };
    record.ending = wait;
    wait.timer = this.#timers.setTimeout(() => {
      afterPolls(() => {
        wait.over = true;
        this.#lose(record, 'exit', why);
      });
    }, this.#limits.exitWaitMs);
    this.#killProcess(record);
    this.#logger.debug(
      { pid: record.pid, why },
      'the lookup helper was lost with a lookup a crash would be charged to: waiting for its exit to say whether it crashed',
    );
  }

  #markPoison(flight: InFlight, now: number): { readonly key: string; readonly kind: ChargedKind } {
    const key = poisonKey(flight.host, flight.family);
    this.#suspects.delete(key);
    const mark = this.#poison.get(key);
    if (mark !== undefined) {
      // Crashed again at its re-ask: asked half as often, a day apart at most, until it answers.
      mark.retryMs = Math.min(this.#limits.poisonRetryMaxMs, mark.retryMs * 2);
      mark.nextAskAt = now + mark.retryMs;
      return { key, kind: 'again' };
    }
    this.#poison.set(key, {
      host: flight.host,
      family: flight.family,
      markedAt: now,
      signal: null,
      nextAskAt: now + this.#limits.poisonRetryMs,
      retryMs: this.#limits.poisonRetryMs,
    });
    return { key, kind: 'new' };
  }

  /** The signal a charged crash died of, once the child's exit says it. */
  #fillPoison(record: ChildRecord): void {
    const mark = record.chargedKey === undefined ? undefined : this.#poison.get(record.chargedKey);
    if (mark !== undefined && mark.signal === null) mark.signal = record.loss?.signal ?? null;
  }

  /** The loss's log line, once the exit status and stderr are in, or after `lossSayMs`. */
  #sayLoss(record: ChildRecord): void {
    const loss = record.loss;
    if (loss === undefined || record.lossSaid) return;
    record.lossSaid = true;
    loss.stderr = record.stderr.slice(-STDERR_SAID);
    loss.fatal = record.fatal;
    this.#fillPoison(record);
    this.#logger.warn(
      {
        pid: loss.pid,
        reason: loss.reason,
        why: loss.why,
        ...(loss.fatal === undefined ? {} : { fatal: loss.fatal }),
        exitCode: loss.exitCode,
        signal: loss.signal,
        stderr: loss.stderr,
        held: loss.held,
        requeued: loss.requeued,
        faulted: loss.faulted,
        ...(loss.chargedTo === undefined ? {} : { suspect: loss.chargedTo, charged: loss.charged }),
      },
      'the lookup helper was lost',
    );
    if (record.chargedKey !== undefined) {
      const mark = this.#poison.get(record.chargedKey);
      if (mark !== undefined && mark.markedAt === loss.at) {
        this.#logger.error(
          {
            host: mark.host,
            family: mark.family,
            signal: mark.signal,
            nextAskInMs: Math.round(mark.nextAskAt - this.#timers.now()),
          },
          `asking getaddrinfo for ${mark.host} made the lookup helper fail: it is not asked for an hour`,
        );
      }
    }
  }

  /**
   * What follows a loss of the current child (§1.11's table), decided before its lookups are told.
   * A crash charged to a name is not counted toward a rest (D27): it found what crashed the child,
   * and that name is not asked again but alone, an hour later at the soonest.
   */
  #nextAfterLoss(reason: LossReason, now: number, charged: boolean, why: string): AfterLoss {
    // No new child once the probe is stopping (L-N1).
    if (this.#state === 'stopping' || this.#state === 'stopped') return { kind: 'stopping' };
    this.#losses = this.#losses.filter((at) => now - at < this.#limits.stableMs);
    if (!charged) this.#losses.push(now);
    // Ten minutes up resets a rest's doubling.
    if (this.#upAt !== undefined && now - this.#upAt >= this.#limits.stableMs) this.#restLevel = 0;
    this.#upAt = undefined;
    if (reason === 'skew' || this.#skewed !== undefined) {
      const said = reason === 'skew' ? why : `${this.#skewed ?? ''} changed`;
      return { kind: 'rest', reason, untilRestart: true, why: said };
    }
    const afterRest =
      !charged &&
      this.#restEndedAt !== undefined &&
      now - this.#restEndedAt < this.#limits.stableMs;
    if (this.#losses.length >= this.#limits.lossesToRest || afterRest) {
      const said = afterRest
        ? 'it was lost within ten minutes of a start that ended a rest'
        : `it was lost ${String(this.#losses.length)} times in ten minutes`;
      return { kind: 'rest', reason, untilRestart: false, why: said };
    }
    const delays = this.#limits.backoffMs;
    const delayMs = delays[Math.min(Math.max(this.#losses.length, 1), delays.length) - 1] ?? 0;
    return { kind: 'backoff', reason, delayMs };
  }

  #afterLoss(next: AfterLoss, said: { readonly charged?: ChargedKind }): void {
    if (next.kind === 'stopping') {
      this.#emitRoute();
      return;
    }
    if (next.kind === 'rest') {
      this.#rest(next.reason, next.untilRestart, next.why, said);
      return;
    }
    this.#closeRejoin();
    this.#rejoinOpen = true;
    this.#setState('backoff', { loss: next.reason, ...said, delayMs: next.delayMs });
    this.#backoffTimer = this.#timers.setTimeout(() => {
      this.#spawn();
    }, next.delayMs);
    // The rejoin window is closed by its timer, after polls so a `ready` already sent is read
    // first, and never by reading the clock again: a timer may fire a little before its time.
    // Only its own window (R2-1): a timer that fired just before a later loss, its callback still
    // waiting for the polls, must not close the window that loss opened.
    const window = this.#rejoinWindow;
    this.#rejoinTimer = this.#timers.setTimeout(() => {
      afterPolls(() => {
        if (this.#rejoinWindow !== window) return;
        this.#rejoinOpen = false;
        this.#emitRoute();
      });
    }, this.#limits.rejoinMs);
  }

  /** Whatever rejoin window is open is closed, and no timer of it closes a later one. */
  #closeRejoin(): void {
    this.#timers.clearTimeout(this.#rejoinTimer);
    this.#rejoinTimer = undefined;
    this.#rejoinWindow += 1;
    this.#rejoinOpen = false;
  }

  #rest(
    reason: LossReason,
    untilRestart: boolean,
    why: string,
    said: { readonly charged?: ChargedKind },
  ): void {
    this.#closeRejoin();
    if (untilRestart) {
      this.#restMs = undefined;
      this.#logger.error(
        { reason, why },
        'the lookup helper is resting until ms-probe restarts: names are asked as with "system"; restart ms-probe to end it',
      );
      this.#setState('resting', { loss: reason, ...said });
      this.#settleStart(false);
      return;
    }
    const restMs = Math.min(
      this.#limits.restMaxMs,
      this.#limits.restFirstMs * 2 ** this.#restLevel,
    );
    this.#restLevel += 1;
    this.#restMs = restMs;
    this.#logger.error(
      { reason, why, restMs, losses: this.#losses.length },
      'the lookup helper is resting: names are asked as with "system" until it is started again',
    );
    this.#setState('resting', { loss: reason, ...said, delayMs: restMs });
    this.#settleStart(false);
    this.#restTimer = this.#timers.setTimeout(() => {
      this.#restEndedAt = this.#timers.now();
      this.#logger.info({ restMs }, 'the lookup helper’s rest is over: starting it again');
      this.#spawn();
    }, restMs);
  }

  #settleStart(up: boolean): void {
    this.#timers.clearTimeout(this.#startWaitTimer);
    this.#startWaitTimer = undefined;
    const waiters = this.#startWaiters;
    this.#startWaiters = [];
    for (const resolve of waiters) resolve(up);
  }

  #setState(
    next: HelperState,
    extra: LossSaid & {
      readonly detached?: readonly object[];
      readonly delayMs?: number;
    } = {},
  ): void {
    const now = this.#timers.now();
    const previous = this.#state;
    this.#msInState[previous] += now - this.#stateSince;
    this.#stateSince = now;
    this.#state = next;
    // Up: a name crashed since the helper was last up runs its ten minutes from now.
    if (next === 'up') {
      for (const [key, since] of this.#crashed) {
        if (since === undefined) this.#crashed.set(key, now);
      }
    }
    this.#lastRoute = this.routeState();
    this.#emit({
      state: next,
      previous,
      route: this.#lastRoute,
      isolating: this.#isolating,
      ...extra,
    });
  }

  /**
   * The route moved without a state change: the rejoin window closed, or a stopping child went
   * quiet, answered again or left.
   */
  #emitRoute(extra: { readonly detached?: readonly object[] } = {}): void {
    const route = this.routeState();
    if (route === this.#lastRoute) return;
    this.#lastRoute = route;
    this.#emit({
      state: this.#state,
      previous: this.#state,
      route,
      isolating: this.#isolating,
      ...extra,
    });
  }

  /** Isolation ended without a change of state. */
  #emitIsolation(): void {
    this.#lastRoute = this.routeState();
    this.#emit({
      state: this.#state,
      previous: this.#state,
      route: this.#lastRoute,
      isolating: this.#isolating,
    });
  }

  /** A microtask later: after the rejections of the same turn have reached the resolver. */
  #emit(change: HelperChange): void {
    const listener = this.#onChange;
    if (listener === undefined) return;
    queueMicrotask(() => {
      try {
        listener(change);
      } catch (error: unknown) {
        this.#logger.error(
          { err: error, state: change.state },
          'a lookup helper change could not be handed on',
        );
      }
    });
  }
}
