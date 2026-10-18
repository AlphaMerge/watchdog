import { credentialFingerprint, type SshCredentials } from './credentials.js';
import {
  connectCancelled,
  DEFAULT_CONNECT_TIMEOUT_MS,
  SshSession,
  type SshSessionOptions,
  type SshTarget,
} from './session.js';

/**
 * SSH connections shared per device (`T-07`).
 *
 * **Reuse matters more here than it does for SNMP.** An SNMP session is a UDP socket and opening
 * one costs nothing; an SSH handshake is TCP, key exchange and authentication — hundreds of
 * milliseconds and real CPU on both ends. A device with a dozen SSH sensors on a one-minute
 * interval would otherwise pay for a dozen handshakes a minute, for ever, and a busy probe would
 * spend more time authenticating than checking.
 *
 * **Opening is asynchronous, which is the one structural difference from the SNMP pool**, and it
 * brings the problem that pool does not have: two sensors on the same device coming due on the
 * same tick would both find nothing cached and both start a handshake. So an *in-flight* open is
 * shared — the second caller awaits the first's connection rather than making a second one.
 *
 * **The callers that join an open share the first caller's guard, and its one lookup** (`A-57`).
 * **They do not share its `AbortSignal`** (`A-69`). The open, lookup and handshake both, runs
 * under a signal of the pool's own, which aborts when every caller waiting for that connection
 * has been cancelled and not before. A caller that is cancelled stops waiting at once and is
 * told so; the others go on and get the connection. When the last one goes the socket is
 * destroyed, where a cancelled check used to hold it until the connect timeout.
 *
 * In a running probe a join does not happen at all, which `A-65` settled with a test: a pool
 * belongs to one worker thread, a worker runs one check at a time (the check pool holds a slot
 * until its worker answers, a timed-out check included), no SSH type runs in a check process,
 * and a check only ever makes one `acquire`. So the second sensor on a device finds the
 * connection the first one left, and the caller that is cancelled is the only one waiting.
 * `ssh-shared-open.test.ts` in the probe fails if that stops being true, by a worker running
 * two checks at once or by a join being counted. Nothing here depends on it any more: joining is
 * kept for a caller that does overlap in one thread, which today is a test, and holds for one.
 *
 * **An open its last caller abandoned is gone at once** (`A-73`). Aborting it ends the handshake
 * a few turns later, and until then the open was still there to be joined: a caller arriving in
 * those turns waited on it and was told its own check had been cancelled, which it had not. The
 * abandoned open is forgotten in the turn it is abandoned, and what it does when it ends touches
 * only itself — never an open that has since been started for the same connection.
 *
 * Deliberately not shared code with `support/snmp/pool.ts`, and that is a decision rather than
 * an oversight: the lease counting and idle eviction are the same, but async open, in-flight
 * sharing and liveness checking are not, and an abstraction over two cases guesses wrong about
 * which parts vary. `T-09` (WinRM) is the third, and the point at which the shape is known —
 * see the ticket noted in `TASKS.md`.
 */
export interface SshPoolOptions {
  /** How long a connection with no active leases is kept before it is closed. */
  readonly idleMs?: number;
  /**
   * Connections this pool keeps before it starts closing idle ones.
   *
   * Smaller than the SNMP pool's bound because each of these is a TCP connection and an
   * authenticated session on the far end, where that is a UDP socket. Passing it closes the
   * least-recently-used idle connection; if every one is in use it opens another and counts it,
   * because refusing would fail a check to protect a descriptor budget.
   */
  readonly maxConnections?: number;
  /**
   * The monotonic clock, in nanoseconds, that the lookup before a handshake is timed on
   * (`A-65`). `process.hrtime.bigint` unless a test hands it one it can move (`P-268`).
   */
  readonly monotonic?: () => bigint;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_MAX_CONNECTIONS = 32;

export interface SshLease {
  readonly session: SshSession;
  release(): void;
}

/** What Probe Health reports about this pool (`P-13`), in the shape the others use. */
export interface SshPoolStats {
  connections: number;
  inUse: number;
  acquired: number;
  /** Leases that reused a connection — the whole point, and the handshakes not paid for. */
  reused: number;
  /** Leases that waited on a handshake somebody else had already started. */
  joined: number;
  opened: number;
  closed: number;
  evicted: number;
  overflowed: number;
  /** Connections found dead when a lease was wanted, and replaced. */
  stale: number;
}

interface Entry {
  key: string;
  session: SshSession;
  leases: number;
  /** When the last lease was released. `0` while in use. */
  idleSince: number;
}

/** One caller waiting for a connection that is being opened. */
interface Waiter {
  resolve(lease: SshLease): void;
  reject(error: unknown): void;
  /** Stops listening to the caller's own signal: the open has ended, one way or the other. */
  settle(): void;
}

/** A connection being opened, and everybody waiting for it (`A-69`). */
interface Opening {
  readonly key: string;
  /** For the sentence a waiter is told when the pool is closed under it. */
  readonly host: string;
  readonly waiters: Set<Waiter>;
  /**
   * Aborted when the last waiter is cancelled, or the pool is closed: nobody is left to use the
   * connection. **An open that has been abandoned is not one to join** (`A-73`): it is taken out
   * of `#opening` in the same turn, so the next caller starts its own.
   */
  readonly abandon: AbortController;
}

export class SshSessionPool {
  readonly #entries = new Map<string, Entry>();
  /** Handshakes in progress, so concurrent callers share one rather than racing. */
  readonly #opening = new Map<string, Opening>();
  readonly #idleMs: number;
  readonly #maxConnections: number;
  readonly #monotonic: () => bigint;
  #sweeper: NodeJS.Timeout | undefined;
  readonly #stats: SshPoolStats = {
    connections: 0,
    inUse: 0,
    acquired: 0,
    reused: 0,
    joined: 0,
    opened: 0,
    closed: 0,
    evicted: 0,
    overflowed: 0,
    stale: 0,
  };

  constructor(options: SshPoolOptions = {}) {
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#monotonic = options.monotonic ?? (() => process.hrtime.bigint());
  }

  /**
   * The connection to this host, opening one if there is not a live one already.
   *
   * The key is the target *and* the credentials, so rotating a password opens a new connection
   * rather than reusing one authenticated as the old identity — and the credentials appear in it
   * only as a digest.
   *
   * `signal` is the check's (`A-69`). It ends this caller's wait for a connection being opened,
   * and the open itself once nobody else is waiting for it. It is not read for a connection the
   * pool already holds: that one is handed over, and `exec` is given the signal by its caller.
   */
  async acquire(
    target: SshTarget,
    credentials: SshCredentials,
    options: SshSessionOptions = {},
    signal?: AbortSignal,
  ): Promise<SshLease> {
    const key = keyOf(target, credentials, options);
    this.#stats.acquired += 1;

    const held = this.#entries.get(key);
    if (held !== undefined && !held.session.closed) {
      held.leases += 1;
      held.idleSince = 0;
      this.#stats.reused += 1;
      return this.#lease(held);
    }
    if (held !== undefined) {
      // Dead underneath us: an SSH server closes idle connections, and a firewall forgets a
      // NAT entry. Handing this out would fail every check on it until eviction noticed.
      this.#entries.delete(key);
      this.#stats.stale += 1;
      this.#stats.connections = this.#entries.size;
    }
    // Cancelled before it asked: nothing is opened for it, and nothing it joined is ended.
    if (signal?.aborted === true) throw connectCancelled(target.host.trim());

    // An open somebody abandoned is not here to be found: see `#abandon`.
    let opening = this.#opening.get(key);
    if (opening !== undefined) {
      // Somebody is already shaking hands with this host. Wait for theirs rather than starting
      // a second one — two sensors on one device coming due together is the common case, not
      // the rare one.
      this.#stats.joined += 1;
    } else {
      this.#makeRoom();
      opening = this.#open(key, target, credentials, options);
    }
    return this.#wait(opening, target.host.trim(), signal);
  }

  /**
   * Starts a connection and answers everybody waiting for it when it ends.
   *
   * The waiters are answered here, in one turn, and not by each awaiting a promise: between the
   * connection being recorded and a waiter taking its lease there is then no moment in which a
   * cancelled waiter could leave a lease nobody will give back, or another `acquire` could find
   * neither the connection nor the open and start a second one.
   */
  #open(
    key: string,
    target: SshTarget,
    credentials: SshCredentials,
    options: SshSessionOptions,
  ): Opening {
    const opening: Opening = {
      key,
      host: target.host.trim(),
      waiters: new Set(),
      abandon: new AbortController(),
    };
    const signal = opening.abandon.signal;
    this.#opening.set(key, opening);
    // The target policy is asked here and nowhere above (`A-57`): a connection that is held
    // was checked when it was opened, and is reused without a lookup. Callers that join this
    // open share its one lookup.
    const session = (async (): Promise<SshSession> => {
      // **The lookup and the handshake share the one connect timeout** (`A-65`), as they did
      // when `ssh2`'s socket made the lookup: what the guard took is taken from what the
      // handshake has, so a connection is never opened in more than `connectTimeoutMs`.
      const startedAt = this.#monotonic();
      const checked = await target.guard?.(signal);
      const spentMs = Number(this.#monotonic() - startedAt) / 1e6;
      const wholeMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      return SshSession.open(
        checked === undefined ? target : { ...target, checked },
        credentials,
        target.guard === undefined
          ? options
          : { ...options, connectTimeoutMs: Math.max(1, Math.round(wholeMs - spentMs)) },
        signal,
      );
    })();
    session.then(
      (opened) => {
        this.#forget(opening);
        this.#stats.opened += 1;
        if (opening.waiters.size === 0) {
          // Everybody was cancelled as the handshake finished. Nobody will lease it, and kept
          // it would be a connection opened for no check.
          opened.close();
          this.#stats.closed += 1;
          return;
        }
        const entry = this.#record(key, opened);
        for (const waiter of opening.waiters) {
          waiter.settle();
          entry.leases += 1;
          entry.idleSince = 0;
          waiter.resolve(this.#lease(entry));
        }
        opening.waiters.clear();
      },
      (error: unknown) => {
        // Whether it worked or not: a failed handshake left here would make every later attempt
        // wait on an open that has already failed, so a host that came back would stay broken.
        this.#forget(opening);
        for (const waiter of opening.waiters) {
          waiter.settle();
          waiter.reject(error);
        }
        opening.waiters.clear();
      },
    );
    return opening;
  }

  /**
   * Takes this open out of the opens to be joined, if it is still the one there (`A-73`). Its
   * own ending calls this too, and by then another may have been started under the same key:
   * that one is not this open's to remove.
   */
  #forget(opening: Opening): void {
    if (this.#opening.get(opening.key) === opening) this.#opening.delete(opening.key);
  }

  /**
   * Ends an open nobody is waiting for, and forgets it in the same turn (`A-73`), so no caller
   * can join a handshake that is already being torn down.
   */
  #abandon(opening: Opening): void {
    this.#forget(opening);
    opening.abandon.abort();
  }

  /** One caller's wait for an open: ended by the open, or by the caller's own signal. */
  #wait(opening: Opening, host: string, signal: AbortSignal | undefined): Promise<SshLease> {
    return new Promise<SshLease>((resolve, reject) => {
      const onAbort = (): void => {
        opening.waiters.delete(waiter);
        // **Only the last one out ends the open.** While anybody else is waiting, the handshake
        // is theirs too, and this caller's cancellation is this caller's alone.
        if (opening.waiters.size === 0) this.#abandon(opening);
        reject(connectCancelled(host));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        settle: () => signal?.removeEventListener('abort', onAbort),
      };
      opening.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  stats(): SshPoolStats {
    let inUse = 0;
    for (const entry of this.#entries.values()) if (entry.leases > 0) inUse += 1;
    return { ...this.#stats, connections: this.#entries.size, inUse };
  }

  /**
   * Closes everything, in use or not. For worker shutdown and for tests.
   *
   * **And ends every connection still being opened** (`A-73`): its lookup and its handshake are
   * aborted, so the socket is destroyed now and not at the connect timeout, and whoever was
   * waiting for it is told the connection was cancelled. Until this an open in flight outlived
   * the pool that started it, and recorded its connection in a pool nobody would close again.
   */
  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.session.close();
      this.#stats.closed += 1;
    }
    this.#entries.clear();
    this.#stats.connections = 0;
    for (const opening of [...this.#opening.values()]) {
      const waiters = [...opening.waiters];
      opening.waiters.clear();
      this.#abandon(opening);
      for (const waiter of waiters) {
        waiter.settle();
        waiter.reject(connectCancelled(opening.host));
      }
    }
    this.#stopSweeping();
  }

  /** Closes connections idle for longer than `idleMs`. Called by the sweeper; open for tests. */
  sweep(now: number = Date.now()): number {
    let evicted = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.leases > 0) continue;
      if (now - entry.idleSince < this.#idleMs) continue;
      entry.session.close();
      this.#entries.delete(key);
      evicted += 1;
    }
    this.#stats.evicted += evicted;
    this.#stats.closed += evicted;
    this.#stats.connections = this.#entries.size;
    if (this.#entries.size === 0) this.#stopSweeping();
    return evicted;
  }

  /** The entry for a freshly opened connection, with no lease on it yet. */
  #record(key: string, session: SshSession): Entry {
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.session.closed && existing.session !== session) {
      // Two opens finished for the same key — possible when one was already in flight before a
      // stale entry was dropped. Keep the one already recorded and close the spare rather than
      // leaking a connection nothing will ever evict.
      session.close();
      this.#stats.closed += 1;
      return existing;
    }

    const entry: Entry = { key, session, leases: 0, idleSince: 0 };
    this.#entries.set(key, entry);
    this.#stats.connections = this.#entries.size;
    this.#startSweeping();
    return entry;
  }

  #lease(entry: Entry): SshLease {
    let released = false;
    return {
      session: entry.session,
      release: () => {
        // Guarded: a `finally` that runs twice would take the count below zero and make a
        // connection still in use look idle and evictable.
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases <= 0) {
          entry.leases = 0;
          entry.idleSince = Date.now();
        }
      },
    };
  }

  #makeRoom(): void {
    if (this.#entries.size < this.#maxConnections) return;

    let oldest: Entry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.leases > 0) continue;
      if (oldest === undefined || entry.idleSince < oldest.idleSince) oldest = entry;
    }

    if (oldest === undefined) {
      // Every connection is mid-check. Opening past the bound beats failing a check that would
      // otherwise have worked, so it is counted rather than refused.
      this.#stats.overflowed += 1;
      return;
    }
    oldest.session.close();
    this.#entries.delete(oldest.key);
    this.#stats.closed += 1;
    this.#stats.connections = this.#entries.size;
  }

  #startSweeping(): void {
    if (this.#sweeper !== undefined) return;
    this.#sweeper = setInterval(() => {
      this.sweep();
    }, this.#idleMs);
    // An idle pool must never be the reason a worker cannot exit.
    this.#sweeper.unref();
  }

  #stopSweeping(): void {
    if (this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}

function keyOf(target: SshTarget, credentials: SshCredentials, options: SshSessionOptions): string {
  // The command timeout is *not* in the key: it is applied per `exec` rather than baked into the
  // connection, so two sensors with different command timeouts can share one safely. The connect
  // timeout is, because it shaped the handshake this connection already completed.
  return [
    target.host,
    String(target.port ?? 22),
    // A connection is over the family it was opened with (`A-85`): a device set to IPv4 never
    // rides one a device of the same name set to IPv6, or on `auto`, opened over IPv6.
    target.ipVersion ?? 'auto',
    // A connection is to the address it was opened with (`A-41c`). A name that now resolves
    // elsewhere, still inside the targets, is another connection; one no longer pinned is too.
    target.pinned?.address ?? '',
    // The addresses the target policy checked are **not** in the key (`A-57`): they are read
    // only to open a connection, and a name is one connection whatever it resolves to later.
    // **The device's exception to that policy is** (`A-64`): a connection held is never checked
    // again, so one opened to an address only the exception allowed must not outlive it.
    [...(target.exception ?? [])].sort().join(','),
    credentialFingerprint(credentials),
    // A connection was checked against the keys accepted when it opened. Accepting fewer has to
    // open a new one, or a key taken off the list would go on being trusted until it idled out.
    credentials.hostKeyPolicy,
    credentials.hostKeys.join(','),
    String(options.connectTimeoutMs ?? ''),
  ].join('|');
}

/**
 * The pool this worker uses. One per worker thread, shared by every check it runs.
 */
export const sshPool = new SshSessionPool();

/**
 * Borrow a connection, run `body`, and always give it back.
 *
 * The `finally` is the point: a check that threw while holding a lease would leave the
 * connection permanently in use — never evicted, counted as busy for ever.
 */
export async function withSsh<T>(
  target: SshTarget,
  credentials: SshCredentials,
  options: SshSessionOptions,
  body: (session: SshSession) => Promise<T>,
  pool: SshSessionPool = sshPool,
  /** The check's signal, which ends its wait for a connection being opened (`A-69`). */
  signal?: AbortSignal,
): Promise<T> {
  const lease = await pool.acquire(target, credentials, options, signal);
  try {
    return await body(lease.session);
  } finally {
    lease.release();
  }
}
