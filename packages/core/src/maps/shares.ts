import { randomBytes } from 'node:crypto';
import { sessionIdFor } from '../auth/passwords.js';

/**
 * Share links: minting one, and bounding what an unauthenticated caller can cost (`G-06`).
 *
 * **The token is 256 bits from `randomBytes` and is never stored.** What goes in the database is
 * its SHA-256, so the URL exists in exactly one place — wherever the person who made it put it.
 * Guessing is not a threat model at this width; reading a backup is, which is why the hash.
 */

/** Long enough that a list is readable, short enough to be useless on its own. */
const PREFIX_LENGTH = 8;

export interface MintedShare {
  /** The secret, returned once and never recoverable. */
  readonly token: string;
  readonly tokenHash: string;
  readonly prefix: string;
}

export function mintShareToken(): MintedShare {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sessionIdFor(token), prefix: token.slice(0, PREFIX_LENGTH) };
}

export function shareTokenHash(token: string): string {
  return sessionIdFor(token);
}

/**
 * How much one share link may ask for (`ADR-002` Decision 1's fourth consequence).
 *
 * **Per token, and per token only, because the address half already exists.** `registerRateLimit`
 * bounds every request by caller — 1,200 a minute, keyed by address for anybody without a
 * session — so somebody working through guesses from one place is already bounded, and a second
 * per-address bucket here would be a second policy to keep in step with the first. What that
 * limiter cannot see is the *link*: a URL posted somewhere public is hit from a thousand
 * addresses, each of them comfortably within their own budget, and only a bucket keyed by the
 * token notices.
 *
 * **Bounded in memory, because the keys are attacker-influenced.** A caller chooses the token in
 * the URL and can choose a new one every request, so an unbounded map of counters is a memory
 * leak with a remote control. Past the ceiling the oldest window is dropped — which is the
 * *right* eviction here, unlike a cache: the entry being dropped is the one whose window is
 * furthest from expiring anyway.
 *
 * Fixed windows rather than a sliding log: a bucket is two numbers, and the failure a sliding
 * window prevents — a double-rate burst across a window boundary — is not a failure that matters
 * for a limit whose job is to stop a flood rather than to meter fairly.
 */
export interface ShareRateLimitOptions {
  /** Requests allowed per key per window. */
  readonly perWindow?: number;
  readonly windowMs?: number;
  /** How many keys are tracked at once. */
  readonly maxKeys?: number;
  /**
   * Monotonic milliseconds (`P-247`): a window is a duration, and on the wall clock a backward
   * step kept a wall display's share refused for the length of the step.
   */
  readonly now?: () => number;
}

export class ShareRateLimit {
  readonly #perWindow: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  /** Insertion-ordered, which is what makes "drop the oldest window" one line. */
  readonly #windows = new Map<string, { startedAt: number; used: number }>();

  constructor(options: ShareRateLimitOptions = {}) {
    this.#perWindow = options.perWindow ?? 60;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? ((): number => performance.now());
  }

  /** True when this request may proceed. Counts it when it may. */
  allow(key: string): boolean {
    const now = this.#now();
    const held = this.#windows.get(key);

    if (held === undefined || now - held.startedAt >= this.#windowMs) {
      // Re-inserted rather than mutated, so the map's order is "least recently started" and the
      // eviction below drops the entry that has been idle longest.
      this.#windows.delete(key);
      this.#windows.set(key, { startedAt: now, used: 1 });
      this.#evict();
      return true;
    }

    if (held.used >= this.#perWindow) return false;
    held.used += 1;
    return true;
  }

  /** How many keys are being tracked. Exposed so the ceiling can be asserted rather than assumed. */
  get size(): number {
    return this.#windows.size;
  }

  #evict(): void {
    while (this.#windows.size > this.#maxKeys) {
      const oldest = this.#windows.keys().next();
      if (oldest.done === true) return;
      this.#windows.delete(oldest.value);
    }
  }
}
