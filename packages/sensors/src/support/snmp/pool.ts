import { credentialFingerprint, type SnmpCredentials } from './credentials.js';
import { SnmpSession, type SnmpSessionOptions, type SnmpTarget } from './session.js';

/**
 * Sessions shared per device (`T-01`).
 *
 * **A session is a UDP socket, and a device has many sensors.** Traffic on each of forty
 * interfaces, CPU, memory, three disks and uptime is forty-six sensors against one agent; a
 * session each is forty-six sockets and forty-six file descriptors for one device, multiplied by
 * however many devices a probe watches. Keyed by where it points and who it is, they collapse to
 * one.
 *
 * **Per worker, not per probe.** Checks run in a `worker_threads` pool and this is module state,
 * so a probe with eight workers may hold up to eight sessions to one agent rather than one. That
 * is deliberate — sharing across threads would mean marshalling every varbind through the parent
 * — and it is still eight rather than forty-six.
 *
 * **A pool with no eviction is a leak.** A device deleted at midnight would otherwise hold its
 * socket until the probe restarts, so a session with no leases is closed once it has been idle
 * for `idleMs`. The timer is `unref`'d: an idle pool must never be the reason a worker cannot
 * exit.
 */
export interface SnmpPoolOptions {
  /** How long a session with no active leases is kept before its socket is closed. */
  readonly idleMs?: number;
  /**
   * Sessions this pool keeps before it starts closing idle ones.
   *
   * Not a refusal. Passing the bound closes the least-recently-used idle session to make room,
   * and if every session is in use it opens one anyway and counts it — refusing would fail a
   * check to protect a file-descriptor budget, which is the wrong trade. `overflowed` in the
   * stats is what makes that visible rather than silent (CLAUDE.md).
   */
  readonly maxSessions?: number;
}

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 64;

/**
 * A borrowed session. Release it when the check is done — in a `finally`, or via `withSnmp`.
 *
 * Releasing does *not* close: the next sensor on the device gets the same socket. It only says
 * this check has stopped using it, which is what lets eviction know the session is idle.
 */
export interface SnmpLease {
  readonly session: SnmpSession;
  release(): void;
}

/** What Probe Health reports about this pool (`P-13`), in the shape the other subsystems use. */
export interface SnmpPoolStats {
  /** Sessions currently held, in use or idle. */
  sessions: number;
  /** Sessions with at least one active lease. */
  inUse: number;
  /** Leases handed out since the pool started. */
  acquired: number;
  /** Leases that reused an existing session — the whole point of the pool. */
  reused: number;
  opened: number;
  closed: number;
  /** Sessions closed because they had been idle longer than `idleMs`. */
  evicted: number;
  /** Sessions opened past `maxSessions` because every existing one was in use. */
  overflowed: number;
}

interface Entry {
  key: string;
  session: SnmpSession;
  leases: number;
  /** When the last lease was released. `0` while in use. */
  idleSince: number;
}

export class SnmpSessionPool {
  readonly #entries = new Map<string, Entry>();
  readonly #idleMs: number;
  readonly #maxSessions: number;
  #sweeper: NodeJS.Timeout | undefined;
  readonly #stats: SnmpPoolStats = {
    sessions: 0,
    inUse: 0,
    acquired: 0,
    reused: 0,
    opened: 0,
    closed: 0,
    evicted: 0,
    overflowed: 0,
  };

  constructor(options: SnmpPoolOptions = {}) {
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /**
   * The session for this agent, opening one if there is not one already.
   *
   * The key is the target *and* the credentials, so rotating a community string produces a new
   * session rather than reusing one authenticating as the old one — and the credentials appear
   * in it only as a digest (see `credentialFingerprint`).
   */
  acquire(
    target: SnmpTarget,
    credentials: SnmpCredentials,
    options: SnmpSessionOptions = {},
  ): SnmpLease {
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
      // Closed underneath us — a socket error, or a close() somebody called directly. Drop it
      // rather than hand out a session every request on which would fail.
      this.#entries.delete(key);
      this.#stats.sessions = this.#entries.size;
    }

    this.#makeRoom();

    const session = SnmpSession.open(target, credentials, options);
    const entry: Entry = { key, session, leases: 1, idleSince: 0 };
    this.#entries.set(key, entry);
    this.#stats.opened += 1;
    this.#stats.sessions = this.#entries.size;
    this.#startSweeping();
    return this.#lease(entry);
  }

  stats(): SnmpPoolStats {
    let inUse = 0;
    for (const entry of this.#entries.values()) if (entry.leases > 0) inUse += 1;
    return { ...this.#stats, sessions: this.#entries.size, inUse };
  }

  /** Closes everything, in use or not. For worker shutdown and for tests. */
  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.session.close();
      this.#stats.closed += 1;
    }
    this.#entries.clear();
    this.#stats.sessions = 0;
    this.#stopSweeping();
  }

  /** Closes sessions idle for longer than `idleMs`. Called by the sweeper; exposed for tests. */
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
    this.#stats.sessions = this.#entries.size;
    if (this.#entries.size === 0) this.#stopSweeping();
    return evicted;
  }

  #lease(entry: Entry): SnmpLease {
    let released = false;
    return {
      session: entry.session,
      release: () => {
        // Guarded because a `finally` that runs twice — a retry wrapper, a double catch — would
        // otherwise take the count below zero and make a session in use look idle and evictable
        // while another check is still reading from it.
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

  /** Makes space for one more session by closing the oldest idle one, if there is one. */
  #makeRoom(): void {
    if (this.#entries.size < this.#maxSessions) return;

    let oldest: Entry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.leases > 0) continue;
      if (oldest === undefined || entry.idleSince < oldest.idleSince) oldest = entry;
    }

    if (oldest === undefined) {
      // Every session is mid-check. Opening past the bound beats failing a check that would
      // otherwise have worked, so it is counted instead of refused.
      this.#stats.overflowed += 1;
      return;
    }
    oldest.session.close();
    this.#entries.delete(oldest.key);
    this.#stats.closed += 1;
    this.#stats.sessions = this.#entries.size;
  }

  #startSweeping(): void {
    if (this.#sweeper !== undefined) return;
    this.#sweeper = setInterval(() => {
      this.sweep();
    }, this.#idleMs);
    // An idle pool must not hold a worker open. `unref` is what makes eviction free.
    this.#sweeper.unref();
  }

  #stopSweeping(): void {
    if (this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}

function keyOf(
  target: SnmpTarget,
  credentials: SnmpCredentials,
  options: SnmpSessionOptions,
): string {
  // Timeout and retries are part of the key because they are baked into the session at open
  // time: two sensors on one device with different deadlines must not silently share the
  // stricter one's socket and inherit its timeout.
  return [
    target.host,
    String(target.port ?? 161),
    target.ipVersion ?? 'auto',
    credentialFingerprint(credentials),
    String(options.timeoutMs ?? ''),
    String(options.retries ?? ''),
  ].join('|');
}

/**
 * The pool this worker uses.
 *
 * A module-level singleton because that is exactly its scope: one per worker thread, shared by
 * every check that thread runs, gone when the thread is.
 */
export const snmpPool = new SnmpSessionPool();

/**
 * Borrow a session, run `body`, and always give it back.
 *
 * The `finally` is the point. A check that threw — or was aborted — while holding a lease would
 * leave the session permanently in use: never evicted, and counted as busy for ever, so the
 * pool's bound would slowly fill with sessions nothing is using.
 */
export async function withSnmp<T>(
  target: SnmpTarget,
  credentials: SnmpCredentials,
  options: SnmpSessionOptions,
  body: (session: SnmpSession) => Promise<T>,
  pool: SnmpSessionPool = snmpPool,
): Promise<T> {
  const lease = pool.acquire(target, credentials, options);
  try {
    return await body(lease.session);
  } finally {
    lease.release();
  }
}
