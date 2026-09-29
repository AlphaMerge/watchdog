import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ClockFreeze } from './clock-freeze.js';
import { movesSensors } from './reachability-sync.js';

export interface ClockFreezeSyncOptions {
  /**
   * Read through a closure, because `ClockFreeze` needs the probe endpoint and is built long
   * after the audit sinks. Undefined is a core still starting up, with nothing frozen yet.
   */
  clockFreeze: () => ClockFreeze | undefined;
}

/**
 * Keeps the clock-freeze overlay in step with the tree (`P-239`), as `ReachabilitySync` keeps the
 * unreachable one (`P-103`), on the same mutations and inside the same transaction.
 *
 * **Unlike that one, a failure fails the mutation.** `ClockFreeze.resync` takes its sets back and
 * throws, because by then the transaction is aborted, and a COMMIT on an aborted transaction is
 * rolled back by PostgreSQL without an error: catching here would tell the caller a mutation
 * succeeded that was never written.
 */
export class ClockFreezeSync implements AuditSink {
  readonly #clockFreeze: () => ClockFreeze | undefined;

  constructor(options: ClockFreezeSyncOptions) {
    this.#clockFreeze = options.clockFreeze;
  }

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    _at: Date,
  ): Promise<void> {
    if (!mutations.some(movesSensors)) return;
    await this.#clockFreeze()?.resync(q);
  }
}
