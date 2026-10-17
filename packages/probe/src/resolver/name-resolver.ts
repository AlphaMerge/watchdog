import { createHash } from 'node:crypto';
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
import type { PoolResolver, ResolveAck, ResolveOutcome, ResolveReply } from './protocol.js';

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
/** How often the hosts file and resolv.conf are looked at for a change. */
export const WATCH_EVERY_MS = 5_000;
/** How long a request that says nothing about its bound is waited for. */
const DEFAULT_WAIT_MS = 10_000;
/** How long past its bound a waiter is kept, so that a reply on the edge still lands. */
const FORGET_SLACK_MS = 250;
/** How often a name being held is logged at warn. */
const HOLD_WARN_EVERY_MS = 60_000;
/** What `getaddrinfo` answers when a name has no address: the only failures kept as denials. */
const NO_ADDRESS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

export type Family = 0 | 4 | 6;

/** What asks the system: `getaddrinfo` in production. */
export type SystemLookup = (host: string, family: Family) => Promise<readonly ResolvedAddress[]>;

/** Which lanes a lookup may use. */
type LaneClass = 'first' | 'refresh' | 'retry';

export interface NameResolverOptions {
  readonly logger: Logger;
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
   * (`checkFiles`). The system's hosts file and resolv.conf every `WATCH_EVERY_MS` unless a test
   * says otherwise.
   */
  readonly watch?: { readonly files: readonly string[]; readonly everyMs: number };
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
  pending: Pending | undefined;
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
  state: 'queued' | 'running' | 'done';
  startedAt: number;
  /** Which configuration it was asked under: `#generation` when it started to run. */
  generation: number;
  stuck: boolean;
  stuckTimer: NodeJS.Timeout | undefined;
  readonly waiters: Set<Waiter>;
}

/** How many names of a domain are kept, and how many of them are failing. */
interface DomainCount {
  names: number;
  failing: number;
}

/** What a watched file said at the last look. */
interface Seen {
  readonly digest: string;
  /** A hosts file's names, each with its addresses in the file's order. */
  readonly names: ReadonlyMap<string, string> | undefined;
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

/** The system's hosts file and resolv.conf: what `getaddrinfo` reads that a change would move. */
export function systemResolverFiles(): string[] {
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows';
    return [join(root, 'System32', 'drivers', 'etc', 'hosts')];
  }
  return ['/etc/hosts', '/etc/resolv.conf'];
}

const seconds = (ms: number): string => `${String(Math.max(0, Math.round(ms / 1000)))} s`;

/** A name as it is compared with a hosts file's: lower case, without one trailing dot. */
function nameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * A name's domain: the name less its first label, so `dev-4.zone-b.example` is `zone-b.example`. A
 * name of one label is in the domain `''`, with every other the search list completes.
 */
export function domainOf(host: string): string {
  const name = nameOf(host);
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
      const name = nameOf(field);
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
  /** How long a failing name no check asks about counts against its domain. */
  readonly #countFailingMs: number;
  readonly #watch: { readonly files: readonly string[]; readonly everyMs: number };
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
  /** "Check now"'s lookups still queued. */
  #urgentQueued = 0;
  /** Moved on by a change to the resolver's configuration: what a lookup was asked under. */
  #generation = 0;
  /** What each watched file said at the last look. */
  readonly #seen = new Map<string, Seen>();
  readonly #queues: Record<LaneClass, Pending[]> = { first: [], refresh: [], retry: [] };
  readonly #running: Record<LaneClass, Set<Pending>> = {
    first: new Set(),
    refresh: new Set(),
    retry: new Set(),
  };
  #watchTimer: NodeJS.Timeout | undefined;
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
    // Past the longest hold, an answer's life and its grace: a name a scan still checks has been
    // asked within it.
    this.#countFailingMs = this.#holdMaxMs + this.#answerMs + this.#staleMs;
    this.#watch = options.watch ?? { files: systemResolverFiles(), everyMs: WATCH_EVERY_MS };
  }

  /**
   * Starts looking at the hosts file and resolv.conf. Its first look is the baseline; a change after
   * it is acted on by `checkFiles`.
   */
  start(): void {
    if (this.#watchTimer !== undefined || this.#watch.files.length === 0) return;
    void this.checkFiles();
    this.#watchTimer = setInterval(() => void this.checkFiles(), this.#watch.everyMs);
    this.#watchTimer.unref();
  }

  stop(): void {
    clearInterval(this.#watchTimer);
    this.#watchTimer = undefined;
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
   * - **resolv.conf**: every kept answer is due now, so it is served while one refresh asks under
   *   the new configuration, within the same grace as ever; denials and holds are let go. A name's
   *   failures in a row are kept, so a name that did not answer is asked again on the retry lane,
   *   and a silent zone cannot fill the lanes the answering ones are asked on. A lookup that ran
   *   under the old configuration is left to end and answers its own checks; its answer is kept,
   *   as already due, only for a name the new configuration has said nothing of and is not asking.
   * - **A rewrite with the same contents** changes nothing: a DHCP client renewing a lease does it.
   */
  async checkFiles(): Promise<boolean> {
    if (this.#watching) return false;
    this.#watching = true;
    try {
      const looked = await Promise.all(
        this.#watch.files.map(async (file) => ({ file, text: await this.#read(file) })),
      );
      const hostsChanged = new Set<string>();
      let configChanged = false;
      let changed = false;
      for (const { file, text } of looked) {
        // Unreadable this time for another reason than its absence: compared at the next look.
        if (text === undefined) continue;
        const digest = createHash('sha256').update(text).digest('hex');
        const seen = this.#seen.get(file);
        if (seen?.digest === digest) continue;
        const hosts = isHostsFile(file);
        const names = hosts ? hostsNames(text) : undefined;
        this.#seen.set(file, { digest, names });
        // The first look is the baseline.
        if (seen === undefined) continue;
        changed = true;
        if (hosts) for (const name of namesChanged(seen.names, names)) hostsChanged.add(name);
        else configChanged = true;
      }
      if (!changed) return false;

      let dropped = 0;
      if (hostsChanged.size > 0) {
        for (const [key, entry] of this.#entries) {
          if (!hostsChanged.has(nameOf(entry.host))) continue;
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
      }
      this.#logger.info(
        {
          files: this.#watch.files,
          namesChanged: hostsChanged.size,
          dropped,
          resolverConfigChanged: configChanged,
          answersDue: due,
        },
        'the hosts file or resolv.conf changed: the names it moved are asked again',
      );
      return true;
    } finally {
      this.#watching = false;
    }
  }

  /** A watched file's contents: empty when it is absent, undefined when it cannot be read now. */
  async #read(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8');
    } catch (error: unknown) {
      return codeOf(error) === 'ENOENT' ? '' : undefined;
    }
  }

  stats(): NameResolverStats {
    const running =
      this.#running.first.size + this.#running.refresh.size + this.#running.retry.size;
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
      pending = this.#start(entry, fresh || entry.failures === 0 ? 'first' : 'retry', fresh);
    } else if (fresh && pending.state === 'queued') {
      this.#promote(pending);
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
    if (pending.state === 'queued' && this.#lanesStuck(pending.cls)) {
      return {
        now: this.#unanswered(
          entry,
          fresh,
          now,
          RESOLVER_STUCK,
          this.#stuckWhy(entry, pending.cls),
        ),
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
      pending: undefined,
    };
    this.#entries.set(key, entry);
    const domain = this.#domains.get(entry.domain) ?? { names: 0, failing: 0 };
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
    this.#entries.delete(key);
    const domain = this.#domains.get(entry.domain);
    if (domain === undefined) return;
    domain.names -= 1;
    if (domain.names <= 0) this.#domains.delete(entry.domain);
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

  /** Why a queued lookup's check fails at once: the lanes its class could take, and theirs. */
  #stuckWhy(entry: Entry, cls: LaneClass): string {
    const lanes = this.#blockers(cls)
      .slice(0, 3)
      .map((pending) => pending.entry.host);
    return (
      `every lane a lookup for ${entry.host} could use is held by a lookup that has run past ` +
      `${String(this.#stuckMs)} ms (${lanes.join(', ')}); it stays queued`
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
    const pending = this.#start(entry, entry.failures > 0 ? 'retry' : 'refresh');
    if (pending === undefined) {
      this.#logger.warn(
        { host: entry.host, queued: this.#queuedCount() },
        'the probe’s resolver queue is full: a refresh was not queued',
      );
    }
  }

  #queuedCount(): number {
    return this.#queues.first.length + this.#queues.refresh.length + this.#queues.retry.length;
  }

  /** A new lookup for an entry, queued and started if a lane is free; undefined if full. */
  #start(entry: Entry, cls: LaneClass, urgent = false): Pending | undefined {
    if (this.#queuedCount() >= this.#maxQueued && !this.#canRun(cls)) return undefined;
    const pending: Pending = {
      entry,
      cls,
      urgent,
      state: 'queued',
      startedAt: 0,
      generation: this.#generation,
      stuck: false,
      stuckTimer: undefined,
      waiters: new Set(),
    };
    entry.pending = pending;
    if (urgent) this.#urgentQueued += 1;
    this.#queues[cls].push(pending);
    this.#pump();
    return pending;
  }

  /**
   * "Check now" joining a lookup still queued: moved to the first lookups' lanes, ahead of every
   * other, so that it never waits behind held names' retries.
   */
  #promote(pending: Pending): void {
    const queue = this.#queues[pending.cls];
    const at = queue.indexOf(pending);
    if (at === -1) return;
    queue.splice(at, 1);
    pending.cls = 'first';
    if (!pending.urgent) {
      pending.urgent = true;
      this.#urgentQueued += 1;
    }
    this.#queues.first.push(pending);
    this.#pump();
  }

  /**
   * The queued lookup a free lane of this class takes: "Check now"'s first, then the name whose
   * domain has the least of its names failing, its own failure left out, then, among retries, the
   * name with the fewest failures in a row and then the one that answered most recently, then the
   * oldest. With nothing failing and no "Check now", the oldest.
   */
  #takeNext(cls: LaneClass): Pending | undefined {
    const queue = this.#queues[cls];
    let best = 0;
    if (queue.length > 1 && (this.#failingNames > 0 || this.#urgentQueued > 0)) {
      let bestRank: number[] | undefined;
      for (const [index, pending] of queue.entries()) {
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
    if (next?.urgent === true) this.#urgentQueued -= 1;
    return next;
  }

  #canRun(cls: LaneClass): boolean {
    if (cls === 'retry') return this.#running.retry.size < 1;
    const shared = this.#running.first.size + this.#running.refresh.size;
    return this.#running[cls].size < this.#capOf(cls) && shared < this.#sharedCap;
  }

  /** How many of the shared lanes a class may hold: each leaves the other one. */
  #capOf(cls: 'first' | 'refresh'): number {
    return cls === 'first' ? this.#firstCap : this.#refreshCap;
  }

  /**
   * The lookups whose end could give a queued lookup of this class a lane: its own class's when it
   * holds all it may, and otherwise every shared lane's. Never a lane it could not take.
   */
  #blockers(cls: LaneClass): Pending[] {
    if (cls === 'retry') return [...this.#running.retry];
    if (this.#running[cls].size >= this.#capOf(cls)) return [...this.#running[cls]];
    return [...this.#running.first, ...this.#running.refresh];
  }

  /**
   * Whether every lane a queued lookup of this class could take is held by a lookup that has run
   * past `STUCK_MS`. A check then fails at once rather than waiting out its bound.
   */
  #lanesStuck(cls: LaneClass): boolean {
    const blockers = this.#blockers(cls);
    return blockers.length > 0 && blockers.every((pending) => pending.stuck);
  }

  #pump(): void {
    for (;;) {
      const cls: LaneClass | undefined =
        this.#queues.retry.length > 0 && this.#canRun('retry')
          ? 'retry'
          : this.#queues.first.length > 0 && this.#canRun('first')
            ? 'first'
            : this.#queues.refresh.length > 0 && this.#canRun('refresh')
              ? 'refresh'
              : undefined;
      if (cls === undefined) return;
      const next = this.#takeNext(cls);
      if (next === undefined) return;
      // A lookup nobody waits for any more, for a name the hosts file or resolv.conf has since
      // replaced, is not worth a lane.
      if (next.waiters.size === 0 && this.#entries.get(next.entry.key) !== next.entry) {
        next.state = 'done';
        if (next.entry.pending === next) next.entry.pending = undefined;
        continue;
      }
      this.#run(next);
    }
  }

  #run(pending: Pending): void {
    pending.state = 'running';
    pending.startedAt = this.#now();
    pending.generation = this.#generation;
    this.#running[pending.cls].add(pending);
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
        this.#settle(pending, { addresses });
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
   * early only with an answer: "Check now", given the one kept for the name.
   */
  #onStuck(pending: Pending): void {
    if (pending.state !== 'running') return;
    pending.stuck = true;
    const entry = pending.entry;
    const now = this.#now();
    // Not for a lookup the configuration has moved on from: the name is asked again under the new.
    if (entry.pending === pending) {
      this.#hold(entry, now, `a lookup had no answer after ${String(this.#stuckMs)} ms`);
    }
    for (const waiter of [...pending.waiters]) {
      const outcome = this.#unanswered(entry, waiter.fresh, now, RESOLVER_HELD);
      if (outcome.ok) this.#deliver(pending, waiter, outcome);
    }
    // And whatever is queued behind lanes that are now every one stuck stops waiting too.
    for (const cls of ['first', 'refresh', 'retry'] as const) {
      if (!this.#lanesStuck(cls)) continue;
      for (const queued of this.#queues[cls]) {
        for (const waiter of [...queued.waiters]) {
          this.#deliver(
            queued,
            waiter,
            this.#unanswered(
              queued.entry,
              waiter.fresh,
              now,
              RESOLVER_STUCK,
              this.#stuckWhy(queued.entry, cls),
            ),
          );
        }
      }
    }
  }

  /** One more lookup in a row the resolver did not answer: the name is held for the next step. */
  #hold(entry: Entry, now: number, why: string): void {
    if (entry.failures === 0) {
      // Once a minute at most, with how many more were held since: a resolver outage holds every
      // name it serves, and one line each would bury the log.
      if (this.#lastHoldWarn === undefined || now - this.#lastHoldWarn >= HOLD_WARN_EVERY_MS) {
        this.#logger.warn(
          { host: entry.host, family: entry.family, why, alsoHeld: this.#heldSinceWarn },
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

  #settle(
    pending: Pending,
    result:
      | { readonly addresses: readonly ResolvedAddress[] }
      | { readonly error: unknown }
      | { readonly fault: unknown },
  ): void {
    if (pending.state === 'done') return;
    pending.state = 'done';
    clearTimeout(pending.stuckTimer);
    this.#running[pending.cls].delete(pending);
    const entry = pending.entry;
    // Whether the name still stands for this lookup: not once the configuration moved on.
    const current = entry.pending === pending || pending.generation === this.#generation;
    if (entry.pending === pending) entry.pending = undefined;
    const now = this.#now();

    // The same for every waiter, or undefined when each is told by what the entry now holds.
    let outcome: ResolveOutcome | undefined;
    // A failure that says nothing about the name: each waiter is told it, "Check now" given the
    // kept answer, and nothing is kept.
    let passed: { readonly code: string; readonly why: string } | undefined;
    if ('fault' in result) {
      outcome = failure(RESOLVER_FAULT, this.#fault(result.fault, entry.host).message);
    } else if ('addresses' in result) {
      const addresses = result.addresses.map(({ address, family }) => ({ address, family }));
      if (addresses.length > this.#maxAddresses) {
        const message =
          `${entry.host} resolved to ${String(addresses.length)} addresses, more than the ` +
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
        outcome = { ok: true, addresses };
      }
    } else {
      const code = codeOf(result.error);
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      if (code === 'EAI_AGAIN') {
        if (!current) {
          // Said of a configuration since replaced: nothing held for it.
        } else if (pending.stuck && entry.hold !== undefined) {
          // Held at its bound for stuck already: the hold runs from now, at the same step.
          const step = entry.hold.until - entry.hold.since;
          entry.hold.until = Math.max(entry.hold.until, now + step);
          entry.hold.why = 'getaddrinfo said EAI_AGAIN';
        } else {
          this.#hold(entry, now, 'getaddrinfo said EAI_AGAIN');
        }
      } else if (code !== undefined && NO_ADDRESS.has(code)) {
        if (current) this.#deny(entry, now, code, message);
        else outcome = failure(code, message);
      } else {
        // `EMFILE`, `EAI_MEMORY`, `EAI_FAIL`, no code at all: the probe's or the system's
        // trouble, not an answer about the name, so nothing is kept and the kept answer stays.
        passed = { code: code ?? RESOLVER_FAULT, why: message };
      }
    }

    for (const waiter of [...pending.waiters]) {
      this.#deliver(
        pending,
        waiter,
        outcome ??
          (passed !== undefined
            ? this.#unanswered(entry, waiter.fresh, now, passed.code, passed.why)
            : entry.denial !== undefined
              ? failure(entry.denial.code, entry.denial.message)
              : this.#unanswered(entry, waiter.fresh, now, 'EAI_AGAIN')),
      );
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
}
