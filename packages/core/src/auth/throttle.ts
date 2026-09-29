import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { addressKey } from './address-key.js';

/**
 * Login throttling (`A-01`).
 *
 * **Counting per account alone is a denial of service, and counting per address alone is no
 * defence.** Lock an account after five bad passwords and anybody who knows an operator's login
 * can lock them out of their own monitoring system by failing to log in as them — during the
 * outage they are trying to investigate, which is exactly when it would be done. Count only per
 * address and a spray from a botnet never trips anything, because no single address tries twice.
 *
 * So both, with different consequences:
 *
 *   - **Per address**, a hard limit. An address that has failed repeatedly is refused outright,
 *     including for accounts that do not exist — an attacker enumerating logins is failing
 *     against nothing, and that is the traffic worth stopping first.
 *   - **Per account**, a *delay* rather than a lock. Failures make each attempt slower, so a
 *     guessing run collapses while a legitimate operator who has mistyped their password twice
 *     waits a second and gets in.
 *
 * **The delay is a gate, checked before any password is verified** (`A-47`). It was a sleep before
 * the answer, which slows a client that waits for each answer and nobody else: two hundred
 * attempts sent at once each got a full verification, so throughput was whatever argon2 allowed.
 * Now an attempt that arrives before the last failure's delay has passed is refused with
 * `Retry-After`, without being checked; and one login has at most one verification in flight, so
 * a burst sent at once is one attempt (`admit`). The sleep before a failure's answer stays, and lasts
 * exactly as long as the gate it closes: a person who waits for the answer never meets the gate.
 *
 * **A gate is also what an attacker can hold shut.** Failing a known login every five seconds
 * keeps its gate closed almost all the time — the lockout the rule above exists to prevent, by
 * another route. So **an address that has logged in as that login in the last thirty days skips
 * the gate.** The attacker is not at the victim's desk, so the person the attack is aimed at logs
 * in from where they always do, while the attack goes on, as if it were not. What that costs: an
 * attacker who is at such an address — a shared NAT, the office network — guesses without the
 * delay, and is held by the per-address limit, twenty failures a quarter hour, as everybody
 * there is. That is the same ceiling the whole world had before, and much less than the
 * unlimited guessing the gate replaces. The known address still has one verification in flight
 * at a time. What it does not cover: the person under attack logging in from somewhere new, who
 * waits for the gate like anybody else.
 *
 * **An IPv6 address counts as its /64** (`addressKey`), so rotating through one connection's
 * prefix is one client, to the per-address limit and to "known" alike.
 *
 * **Recorded in the database, not in memory**, so restarting the core is not a way to clear the
 * count — an attacker who can crash a service should not be handed a fresh allowance by it. The
 * one-in-flight rule is in memory: it is about this process's verifications, which a restart ends.
 */

export interface LoginThrottleConfig {
  /** Failures from one address within the window before it is refused outright. */
  maxPerAddress: number;
  /** How far back failures are counted. */
  windowMs: number;
  /** Delay added per recent failure against the same login. */
  perAccountDelayMs: number;
  /** The longest that delay grows to, so an attacker cannot make a login hang for ever. */
  maxAccountDelayMs: number;
  /** How long a refused address stays refused after its last failure. */
  addressBlockMs: number;
  /** How long a successful login makes its address known for that login (`A-47`). */
  knownAddressMs: number;
}

export const DEFAULT_THROTTLE: LoginThrottleConfig = {
  maxPerAddress: 20,
  windowMs: 15 * 60_000,
  perAccountDelayMs: 500,
  maxAccountDelayMs: 5_000,
  addressBlockMs: 15 * 60_000,
  knownAddressMs: 30 * 24 * 3_600_000,
};

/**
 * An attempt let in to have its password checked, holding its login's one verification (`A-47`),
 * or turned away before anything was verified.
 */
export type Admission =
  | {
      readonly admitted: true;
      /** How long to wait before answering if this attempt fails: the gate it will close. */
      readonly delayMs: number;
      /** Gives the verification back. Idempotent; call it once the outcome is recorded. */
      readonly release: () => void;
    }
  | {
      readonly admitted: false;
      /**
       * The address's failures, the login's gate, or another attempt at the same login being
       * checked right now.
       */
      readonly why: 'address' | 'login' | 'in-flight';
      /** For the `Retry-After` header. */
      readonly retryAfterSeconds: number;
    };

/** What the recorded attempts say about one more, before its password is checked. */
export type ThrottleVerdict =
  | {
      readonly refused: false;
      /** How long to wait before answering if this attempt fails: the gate it will close. */
      readonly delayMs: number;
    }
  | {
      readonly refused: true;
      /** The address's failures, or the login's gate (`A-47`). */
      readonly why: 'address' | 'login';
      /** For the `Retry-After` header. */
      readonly retryAfterSeconds: number;
    };

export interface LoginThrottleOptions {
  db: Database;
  logger: Logger;
  config?: Partial<LoginThrottleConfig>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class LoginThrottle {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #config: LoginThrottleConfig;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Logins with a verification in flight, lower-cased (`A-47`). */
  readonly #inFlight = new Set<string>();
  /**
   * Per login with an admission being decided: how many are, and how many failures have been
   * recorded against it meanwhile. Only while one is, so it is as big as the logins being tried
   * this instant and no bigger.
   */
  readonly #deciding = new Map<string, { admissions: number; failures: number }>();

  constructor(options: LoginThrottleOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'login-throttle' });
    this.#config = { ...DEFAULT_THROTTLE, ...options.config };
    this.#now = options.now ?? ((): Date => new Date());
    this.#sleep =
      options.sleep ?? ((ms): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Lets one attempt in to be verified, or says why not (`A-47`).
   *
   * **The counts and the slot are taken together** because apart they leave a window: an attempt
   * whose counts were read just before another's failure was recorded would find the gate open,
   * and take the slot the moment the failure gave it back — one verification the gate should have
   * stopped, per failure, for a client that keeps an attempt waiting at every moment. So a failure
   * recorded against this login while this was deciding turns it away, to be tried again in a
   * second, when its counts will include that failure.
   */
  async admit(login: string, remoteAddress: string): Promise<Admission> {
    const key = login.toLowerCase();
    const deciding = this.#deciding.get(key) ?? { admissions: 0, failures: 0 };
    this.#deciding.set(key, deciding);
    deciding.admissions += 1;
    const failuresBefore = deciding.failures;
    let verdict: ThrottleVerdict;
    try {
      verdict = await this.check(login, remoteAddress);
    } finally {
      deciding.admissions -= 1;
      if (deciding.admissions === 0) this.#deciding.delete(key);
    }
    if (verdict.refused) {
      return { admitted: false, why: verdict.why, retryAfterSeconds: verdict.retryAfterSeconds };
    }
    const release = deciding.failures === failuresBefore ? this.#enter(key) : null;
    if (release === null) return { admitted: false, why: 'in-flight', retryAfterSeconds: 1 };
    return { admitted: true, delayMs: verdict.delayMs, release };
  }

  /**
   * What the recorded attempts say about this one, before the password is checked. `admit` is what
   * a login asks; this is the half of it that reads the database.
   *
   * Every count comes from one query: a login attempt is on the critical path of every session
   * this system issues, and two round trips to answer "may I try" is one too many.
   */
  /*
   * **An attempt stamped after now is clamped to now** (`P-247`). The stamps are wall-clock on
   * purpose, since they outlive the process, and a backward step of the clock left every failure
   * before it that far in the future: counted for the step and fifteen minutes more, and an
   * address blocked for as long. The rows this check reads are rewritten to now in the same round
   * trip, and read as now meanwhile, so a block after a step lasts what it would have.
   */
  async check(login: string, remoteAddress: string): Promise<ThrottleVerdict> {
    const now = this.#now();
    const key = addressKey(remoteAddress);
    const since = new Date(now.getTime() - this.#config.windowMs);
    const knownSince = new Date(now.getTime() - this.#config.knownAddressMs);
    const rows = await this.#db.query<{
      by_address: string;
      by_login: string;
      last_address_fail: Date | null;
      last_login_fail: Date | null;
      known: boolean;
    }>(
      `WITH clamped AS (
         UPDATE login_attempt SET at = $5
         WHERE at > $5 AND (address_key = $2 OR lower(login) = lower($1))
         RETURNING 1
       )
       SELECT
         count(*) FILTER (WHERE address_key = $2)                   AS by_address,
         count(*) FILTER (WHERE lower(login) = lower($1))           AS by_login,
         max(least(at, $5)) FILTER (WHERE address_key = $2)         AS last_address_fail,
         max(least(at, $5)) FILTER (WHERE lower(login) = lower($1)) AS last_login_fail,
         EXISTS (
           SELECT 1 FROM login_attempt k
           WHERE lower(k.login) = lower($1) AND k.address_key = $2 AND k.succeeded
             AND k.at >= $4
         ) AS known
       FROM login_attempt
       WHERE succeeded = false AND at >= $3`,
      [login, key, since, knownSince, now],
    );

    const row = rows[0];
    const byAddress = Number(row?.by_address ?? 0);
    const byLogin = Number(row?.by_login ?? 0);

    if (byAddress >= this.#config.maxPerAddress) {
      const lastFail = row?.last_address_fail ?? now;
      const until = new Date(lastFail.getTime() + this.#config.addressBlockMs);
      const remainingMs = Math.max(0, until.getTime() - now.getTime());
      this.#logger.warn(
        { remoteAddress, addressKey: key, failures: byAddress, remainingMs },
        'refusing logins from an address that keeps failing',
      );
      return { refused: true, why: 'address', retryAfterSeconds: Math.ceil(remainingMs / 1000) };
    }

    // A known address neither waits for the gate nor waits out an answer: see the file's comment.
    if (row?.known === true) return { refused: false, delayMs: 0 };

    const lastLoginFail = row?.last_login_fail ?? null;
    if (byLogin > 0 && lastLoginFail !== null) {
      const openAt = lastLoginFail.getTime() + this.#delayAfter(byLogin);
      if (now.getTime() < openAt) {
        const retryAfterSeconds = Math.max(1, Math.ceil((openAt - now.getTime()) / 1000));
        this.#logger.info(
          { login, addressKey: key, failures: byLogin, retryAfterSeconds },
          'refusing a login attempt before its account’s delay has passed',
        );
        return { refused: true, why: 'login', retryAfterSeconds };
      }
    }
    return { refused: false, delayMs: this.#delayAfter(byLogin + 1) };
  }

  /** The gate after this many recent failures against one login. */
  #delayAfter(failures: number): number {
    return Math.min(failures * this.#config.perAccountDelayMs, this.#config.maxAccountDelayMs);
  }

  /**
   * Takes the one verification this login may have in flight (`A-47`), or null while another
   * attempt holds it. The function it returns gives it back, and may be called more than once.
   *
   * **Given back once a failure is recorded and before its answer is waited out.** Before the
   * record, an attempt let in next would be judged without it; after the wait, one failure every
   * few seconds would keep every other attempt out, the known address's included.
   */
  #enter(key: string): (() => void) | null {
    if (this.#inFlight.has(key)) return null;
    this.#inFlight.add(key);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#inFlight.delete(key);
    };
  }

  /**
   * Waits out a failure's delay before answering it.
   *
   * **As long as the gate the failure closes**, so a client that waits for its answer — a person —
   * finds the gate open again, while one that does not finds it shut.
   */
  async waitOut(admission: { readonly delayMs: number }): Promise<void> {
    if (admission.delayMs > 0) await this.#sleep(admission.delayMs);
  }

  /** Records the outcome. Successes are recorded too — they are what an audit of a breach reads. */
  async record(login: string, remoteAddress: string, succeeded: boolean): Promise<void> {
    await this.#db.query(
      `INSERT INTO login_attempt (login, remote_address, address_key, succeeded, at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        login.slice(0, 64),
        remoteAddress.slice(0, 64),
        addressKey(remoteAddress).slice(0, 64),
        succeeded,
        this.#now(),
      ],
    );
    // After the insert, so an admission that started before it is turned away, and one that
    // starts after it reads it.
    if (!succeeded) {
      const deciding = this.#deciding.get(login.toLowerCase());
      if (deciding !== undefined) deciding.failures += 1;
    }
  }

  /**
   * Drops attempts older than the window.
   *
   * Called from housekeeping. Unbounded growth here would be slow rather than dramatic: the
   * counting query is windowed, so an un-pruned table costs an index scan that gets longer for
   * ever and nothing else — which is precisely the kind of decay nobody notices until it is a
   * production incident.
   */
  async prune(): Promise<number> {
    const now = this.#now().getTime();
    const keepSince = new Date(now - this.#config.windowMs * 4);
    // Successes for as long as they make an address known (`A-47`).
    const keepSucceededSince = new Date(now - this.#config.knownAddressMs);
    const rows = await this.#db.query<{ removed: string }>(
      `WITH gone AS (
         DELETE FROM login_attempt
         WHERE at < $2 OR (NOT succeeded AND at < $1)
         RETURNING 1
       )
       SELECT count(*)::text AS removed FROM gone`,
      [keepSince, keepSucceededSince],
    );
    return Number(rows[0]?.removed ?? 0);
  }
}
