import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Password hashing (`A-01`).
 *
 * **argon2id, and the parameters are here rather than in the schema** because they are tuned to
 * the machine and have to be able to change without a migration. Every hash carries the
 * parameters it was made with, so raising them affects new and re-entered passwords and leaves
 * existing ones verifiable — `needsRehash` is what turns a successful login into an upgrade.
 *
 * **A slow hash here, a fast one for machine keys.** The probe access key is 32 random bytes and
 * SHA-256 (`R-01`); this is a value a person chose, drawn from a space small enough to search
 * offline, so the cost of a guess is the whole defence. The two look like the same problem and
 * are opposites.
 */

/**
 * OWASP's second recommended argon2id configuration (19 MiB, t=2, p=1), which is the one that
 * fits a machine also running a database and a scheduler.
 *
 * **Memory is the parameter that matters.** Iterations cost an attacker the same multiple they
 * cost us; memory costs them silicon, which is what makes a GPU farm uneconomic. Measured on the
 * development container this is ~45 ms per hash, which is a login nobody notices and a rate no
 * one brute-forces.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, OPTIONS);
}

/**
 * Whether this password matches this hash.
 *
 * Never throws for a malformed hash: a row corrupted or written by an older build must read as
 * "wrong password" rather than as a 500, because a 500 here is an oracle telling an attacker
 * which accounts are interesting.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/** Whether a successful login should quietly re-hash at the current parameters. */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, OPTIONS);
  } catch {
    // Unreadable, so it cannot be verified against either; treat it as needing replacement.
    return true;
  }
}

/**
 * **Spends the same time on a login that names no account as on one that does.**
 *
 * Without it, "no such user" returns in a microsecond and "wrong password" takes 45 ms, and the
 * difference tells an attacker which of a list of logins exist — which is the first half of
 * every credential-stuffing run. Verifying against a real hash of a random value costs exactly
 * what a real verification costs, because it *is* one.
 */
const DECOY_HASH_PROMISE = hashPassword(randomBytes(32).toString('base64url'));

export async function spendVerificationTime(plaintext: string): Promise<void> {
  await verifyPassword(await DECOY_HASH_PROMISE, plaintext);
}

/**
 * A new session token, and the value stored for it.
 *
 * **What the browser holds and what the database holds are not the same string.** A database a
 * backup can read, or a `SELECT` a bug can expose, must not yield a working session — so the
 * row holds a SHA-256 of the token, exactly as `R-01` does for a probe's access key. 32 bytes
 * from the CSPRNG has nothing to guess, so a fast hash is the correct one.
 */
export function newSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: sessionIdFor(token) };
}

export function sessionIdFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison for two strings that are supposed to be equal.
 *
 * Length is compared first and is not itself secret here — every token this compares is the same
 * length by construction, so an early return on a different length reveals only that something
 * malformed arrived.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
