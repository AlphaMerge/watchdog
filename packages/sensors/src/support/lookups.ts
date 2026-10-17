/**
 * What this thread's name lookups are doing (`A-66`): Probe Health's two numbers for the resolver.
 *
 * **Every lookup a check makes to check a name comes through `resolveWithin`**, which counts it
 * here: the credential pin (`pinTarget`, `A-41c`) and the target policy's guard (`checkedTarget`,
 * `A-54`, `A-57`), so every transport that connects to a device by name under the default policy,
 * and discovery's identification. A socket that resolves a name itself is not counted: a device
 * under `probe.targetPolicy` "none", a listener sensor's sender, the probe's own link to the core.
 *
 * **A lookup is `getaddrinfo` on libuv's thread pool**, shared by every worker thread and the main
 * thread of the probe, and it cannot be cancelled. A check that stops waiting for one leaves it
 * running there: a resolver that does not answer holds the pool's lookup threads for as long as
 * it takes to give up itself, and every lookup asked after it waits behind it, whichever device it
 * is for. So the two numbers are the lookup's, not the check's:
 *
 * - **in flight** counts from the moment a lookup is asked until the resolver answers it, whether
 *   or not any check is still waiting. A number that climbs and does not fall is the resolver
 *   not answering, and its height is how much is queued behind it.
 * - **given up** counts each lookup a check stopped waiting for before the resolver answered: its
 *   bound passed (`resolveBoundMs`) or the check was cancelled. A running total since the thread
 *   started.
 *
 * Per thread, since a module is: each check worker holds its own, the pool sums them, and the
 * main thread's are added to that sum at the report.
 */

/** A thread's lookups. */
export interface LookupCounters {
  /** Lookups asked of the resolver and not yet answered, whether or not a check still waits. */
  readonly inFlight: number;
  /** Lookups a check stopped waiting for before the resolver answered. A running total. */
  readonly givenUp: number;
}

export class LookupCount {
  #inFlight = 0;
  #givenUp = 0;

  /** One lookup asked: counted in flight until it settles, however it settles. */
  track(pending: Promise<unknown>): void {
    this.#inFlight += 1;
    const answered = (): void => {
      this.#inFlight -= 1;
    };
    pending.then(answered, answered);
  }

  /** A check stopped waiting for a lookup the resolver has not answered. */
  gaveUp(): void {
    this.#givenUp += 1;
  }

  stats(): LookupCounters {
    return { inFlight: this.#inFlight, givenUp: this.#givenUp };
  }
}

/** This thread's. `resolveWithin` counts into it, and the probe's registry reads it. */
export const nameLookups = new LookupCount();
