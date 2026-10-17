import type { ResolvedAddress } from '@ms/sensors';

/**
 * What a check worker and the probe's resolver say to each other over the worker's port to its
 * pool (`P-426`). Plain values, since they cross `postMessage`.
 */

/** A worker asks for a name. `fresh` is "Check now", which asks the resolver rather than the cache. */
export interface ResolveRequest {
  readonly type: 'resolve';
  readonly id: number;
  readonly host: string;
  readonly family: 0 | 4 | 6;
  /** How long the check will wait for it: the resolver forgets the waiter after that. */
  readonly waitMs: number;
  readonly fresh: boolean;
}

/**
 * The resolver has taken a request it cannot answer at once (`P-426`): the worker now waits for
 * the answer, and stops waiting for the main thread. Sent only for a cache miss; an answer it
 * already has is the reply.
 */
export interface ResolveAck {
  readonly type: 'resolve-ack';
  readonly id: number;
}

/** What the resolver says about one request. */
export type ResolveOutcome =
  | {
      readonly ok: true;
      readonly addresses: readonly ResolvedAddress[];
      /** For "Check now" only: it used a cached answer because the resolver did not answer. */
      readonly note?: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type ResolveReply = { readonly type: 'resolved'; readonly id: number } & ResolveOutcome;

/**
 * The code of a lookup the resolver's own code failed on: `@ms/sensors`' `RESOLVER_FAULT`, written
 * out so that the pool, which answers a fault that escapes the resolver, needs nothing of that
 * package but its types, as the rest of the runner does (`CREDENTIALS_WITHHELD`).
 */
export const RESOLVE_FAULT = 'ERESOLVERFAULT';

/** What a pool hands a worker's requests to: the probe's `NameResolver`. */
export interface PoolResolver {
  handle(request: unknown, post: (message: ResolveAck | ResolveReply) => void): void;
}
