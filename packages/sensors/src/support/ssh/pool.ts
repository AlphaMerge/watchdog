import { credentialFingerprint, type SshCredentials } from './credentials.js';
import { SshSession, type SshSessionOptions, type SshTarget } from './session.js';

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

export class SshSessionPool {
  readonly #entries = new Map<string, Entry>();
  /** Handshakes in progress, so concurrent callers share one rather than racing. */
  readonly #opening = new Map<string, Promise<SshSession>>();
  readonly #idleMs: number;
  readonly #maxConnections: number;
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
  }

  /**
   * The connection to this host, opening one if there is not a live one already.
   *
   * The key is the target *and* the credentials, so rotating a password opens a new connection
   * rather than reusing one authenticated as the old identity — and the credentials appear in it
   * only as a digest.
   */
  async acquire(
    target: SshTarget,
    credentials: SshCredentials,
    options: SshSessionOptions = {},
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

    const pending = this.#opening.get(key);
    if (pending !== undefined) {
      // Somebody is already shaking hands with this host. Wait for theirs rather than starting
      // a second one — two sensors on one device coming due together is the common case, not
      // the rare one.
      this.#stats.joined += 1;
      const session = await pending;
      return this.#attach(key, session);
    }

    this.#makeRoom();
    const opening = SshSession.open(target, credentials, options);
    this.#opening.set(key, opening);
    try {
      const session = await opening;
      this.#stats.opened += 1;
      return this.#attach(key, session);
    } finally {
      // Whether it worked or not: a failed handshake left here would make every later attempt
      // await a promise that has already rejected, so a host that came back would stay broken.
      this.#opening.delete(key);
    }
  }

  stats(): SshPoolStats {
    let inUse = 0;
    for (const entry of this.#entries.values()) if (entry.leases > 0) inUse += 1;
    return { ...this.#stats, connections: this.#entries.size, inUse };
  }

  /** Closes everything, in use or not. For worker shutdown and for tests. */
  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.session.close();
      this.#stats.closed += 1;
    }
    this.#entries.clear();
    this.#stats.connections = 0;
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

  /** Records a freshly opened connection and hands out the first lease on it. */
  #attach(key: string, session: SshSession): SshLease {
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.session.closed && existing.session !== session) {
      // Two opens finished for the same key — possible when one was already in flight before a
      // stale entry was dropped. Keep the one already recorded and close the spare rather than
      // leaking a connection nothing will ever evict.
      session.close();
      this.#stats.closed += 1;
      existing.leases += 1;
      existing.idleSince = 0;
      return this.#lease(existing);
    }

    const entry: Entry = { key, session, leases: 1, idleSince: 0 };
    this.#entries.set(key, entry);
    this.#stats.connections = this.#entries.size;
    this.#startSweeping();
    return this.#lease(entry);
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
    // A connection is to the address it was opened with (`A-41c`). A name that now resolves
    // elsewhere, still inside the targets, is another connection; one no longer pinned is too.
    target.pinned?.address ?? '',
    // Likewise for the addresses the target policy checked (`A-57`): a name whose addresses
    // have changed is another connection. Sorted, so a resolver that rotates them is not.
    (target.checked ?? [])
      .map((one) => one.address)
      .sort()
      .join(','),
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
): Promise<T> {
  const lease = await pool.acquire(target, credentials, options);
  try {
    return await body(lease.session);
  } finally {
    lease.release();
  }
}
