/**
 * What this thread's name lookups are doing (`A-66`, `P-426`): Probe Health's two numbers for the
 * resolver.
 *
 * **Every lookup a check makes to check a name comes through `resolveWithin`**, which counts it
 * here: the credential pin (`pinTarget`, `A-41c`) and the target policy's guard (`checkedTarget`,
 * `A-54`, `A-57`), so every transport that connects to a device by name under the default policy,
 * and discovery's identification. A socket that resolves a name itself is not counted: a device
 * under `probe.targetPolicy` "none", a listener sensor's sender, the probe's own link to the core.
 *
 * **On a probe, a lookup is asked of the probe's one resolver** (`P-426`), in its main thread, which
 * keeps answers and runs `getaddrinfo` on libuv's thread pool a bounded number at a time. A check
 * worker asks it over its port to the pool. Such a lookup is that resolver's to count while it
 * runs or waits for a lane, so a check waiting for one does not count it here as well:
 * `countedElsewhere` marks the promise, and `track` leaves it out.
 *
 * - **in flight** counts a lookup made outside the probe's resolver (a fixture pool, a process of
 *   its own) from the moment it is asked until the resolver answers it, whether or not any check
 *   is still waiting. The probe adds the resolver's own running and queued lookups to it.
 * - **given up** counts each check that failed for want of an answer: its bound passed
 *   (`resolveBoundMs`), it was cancelled, or the resolver said it did not answer (`notAnswered`):
 *   `EAI_AGAIN`, a name it holds after one, or every lane the lookup could use being held by
 *   lookups that have run past its bound for stuck. A name that does not exist is an answer, and
 *   so is the probe failing to ask (`probeFailed`), its main thread too busy to take the lookup
 *   or the resolver's own code failing: that is the probe, not DNS. A
 *   running total since the thread started.
 *
 * Per thread, since a module is: each check worker holds its own, the pool sums them, and the
 * main thread's are added to that sum at the report.
 */

/** A thread's lookups. */
export interface LookupCounters {
  /** Lookups asked of a resolver and not yet answered, whether or not a check still waits. */
  readonly inFlight: number;
  /** Checks that failed for want of an answer from the resolver. A running total. */
  readonly givenUp: number;
}

/**
 * The probe's resolver did not answer this name a moment ago, and holds it (`P-426`): new checks
 * fail at once until the hold ends, rather than each waiting out its bound behind a lookup that
 * cannot be cancelled.
 */
export const RESOLVER_HELD = 'ERESOLVERHELD';
/**
 * Every lane this lookup could use is held by a lookup that has run past the resolver's bound for
 * stuck, so the check was not left to wait behind them (`P-426`). The lookup stays queued.
 */
export const RESOLVER_STUCK = 'ERESOLVERSTUCK';
/** The probe's resolver has as many lookups queued as it keeps, and took no more (`P-426`). */
export const RESOLVER_FULL = 'ERESOLVERFULL';
/**
 * The probe's main thread did not take the lookup in time (`P-426`): the probe is overloaded, and
 * nothing is known about DNS. Not counted as given up.
 */
export const RESOLVER_BUSY = 'ERESOLVERBUSY';
/** The probe's resolver failed in its own code, not in DNS (`P-426`). Not counted as given up. */
export const RESOLVER_FAULT = 'ERESOLVERFAULT';
/**
 * A lookup the caller had stopped waiting for, ended so that nothing waits for it for ever
 * (`P-426`). The check has given it up at its bound already, so it is not counted again.
 */
export const RESOLVER_LATE = 'ERESOLVERLATE';

/**
 * The name answered with more addresses than the probe uses for one name (`P-426`): an answer,
 * kept as a denial, whose message names the count. Not "no address", which it is the opposite of.
 */
export const RESOLVER_TOO_MANY = 'ETOOMANYADDRESSES';

/** Every code a lookup ends with when the resolver did not answer (`notAnswered`). */
const NOT_ANSWERED: ReadonlySet<string> = new Set([
  // getaddrinfo's own: a resolver that timed out, or answered SERVFAIL.
  'EAI_AGAIN',
  RESOLVER_HELD,
  RESOLVER_STUCK,
  RESOLVER_FULL,
]);

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Whether a lookup failed because the resolver did not answer, rather than with an answer (a name
 * that does not exist) or for the probe's own reasons. A check that fails so is given up.
 */
export function notAnswered(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && NOT_ANSWERED.has(code);
}

/** Every code a lookup ends with when the probe failed to ask (`probeFailed`). */
const PROBE_FAILED: ReadonlySet<string> = new Set([RESOLVER_BUSY, RESOLVER_FAULT, RESOLVER_LATE]);

/**
 * Whether a lookup failed for the probe's own reasons: its main thread did not take it in time,
 * or the resolver's code failed. Neither is an answer about the name, nor DNS not answering, and a
 * check that fails so says the probe's words rather than that the name does not resolve.
 */
export function probeFailed(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && PROBE_FAILED.has(code);
}

/**
 * Whether the name answered with more addresses than the probe uses (`RESOLVER_TOO_MANY`). A check
 * that fails so passes the resolver's own words on, which name the count, rather than saying the
 * name did not resolve.
 */
export function tooManyAddresses(error: unknown): boolean {
  return codeOf(error) === RESOLVER_TOO_MANY;
}

const ELSEWHERE = Symbol('ms.lookup.countedElsewhere');

/**
 * Marks a lookup as one the probe's resolver counts while it runs or waits (`P-426`), so that
 * `track` does not count it a second time where a check waits for it. Returns the same promise.
 */
export function countedElsewhere<T>(pending: Promise<T>): Promise<T> {
  const marked = Object.defineProperty(pending, ELSEWHERE, { value: true });
  return marked;
}

function isCountedElsewhere(pending: Promise<unknown>): boolean {
  return (pending as Promise<unknown> & { [ELSEWHERE]?: boolean })[ELSEWHERE] === true;
}

export class LookupCount {
  #inFlight = 0;
  #givenUp = 0;

  /**
   * One lookup asked: counted in flight until it settles, however it settles. Not one the probe's
   * resolver counts itself (`countedElsewhere`).
   */
  track(pending: Promise<unknown>): void {
    if (isCountedElsewhere(pending)) return;
    this.#inFlight += 1;
    const answered = (): void => {
      this.#inFlight -= 1;
    };
    pending.then(answered, answered);
  }

  /** A check failed for want of an answer from the resolver. */
  gaveUp(): void {
    this.#givenUp += 1;
  }

  stats(): LookupCounters {
    return { inFlight: this.#inFlight, givenUp: this.#givenUp };
  }
}

/** This thread's. `resolveWithin` counts into it, and the probe's registry reads it. */
export const nameLookups = new LookupCount();
