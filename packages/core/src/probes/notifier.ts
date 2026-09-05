import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';

/** What the notifier pokes. `ProbeEndpoint` is it; the interface keeps sockets out of here. */
export interface ConfigPushTarget {
  /** Recomputes and pushes to every connected probe whose configuration has changed. */
  pushAllConfigs(): void;
}

export interface ConfigChangeNotifierOptions {
  /** Optional at construction: see `attach`. */
  target?: ConfigPushTarget;
  logger: Logger;
  /** How long to wait for a burst to finish before recomputing. */
  debounceMs?: number;
}

/**
 * Turns configuration changes into a push (R-04).
 *
 * It rides the audit sink because that is already called inside *every* mutation's transaction —
 * creates, updates, moves, deletes, clones and setting changes alike. Adding a second
 * notification path beside it would be a second thing to remember on every new mutation, and
 * the one that gets forgotten is the one that leaves a probe scanning last week's tree.
 *
 * **It does not work out which probe was affected.** Every connected probe is recomputed, and
 * the push is skipped for any whose fingerprint has not moved — so the cost of being imprecise
 * is one query per connected probe per burst, not a spurious message. Resolving the mutated
 * object's probe ancestor would need a query inside the mutation's own transaction, which is the
 * cost S-16 went to some trouble to remove. If installations ever run enough probes for the
 * recomputation to matter, the ancestor is the thing to resolve — but at that point it belongs
 * in the flush, not in the transaction.
 *
 * A spurious recomputation is free by construction: it reads the committed tree and compares
 * fingerprints. That is also why it is safe for this to run *after* the transaction it was told
 * about — including one that rolled back, which simply produces the fingerprint already in place.
 */
export class ConfigChangeNotifier implements AuditSink {
  #target: ConfigPushTarget | undefined;
  readonly #logger: Logger;
  readonly #debounceMs: number;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: ConfigChangeNotifierOptions) {
    this.#target = options.target;
    this.#logger = options.logger.child({ component: 'config-push' });
    this.#debounceMs = options.debounceMs ?? 250;
  }

  record(q: Queryable, _actor: Actor, mutations: readonly Mutation[], _at: Date): Promise<void> {
    // Nothing here touches the database or awaits anything: this runs inside the caller's
    // transaction, and a push that made mutations slower would be a bad trade for a probe
    // learning about a change a quarter of a second sooner.
    if (mutations.length === 0) return Promise.resolve();

    // **Armed after the commit, not before it** (`P-138`). The debounce is 250 ms and this runs
    // *inside* the mutation's transaction, so any transaction that takes longer than that — a
    // bulk operation, a tree plan, a clone of a large subtree, a busy database — had its push
    // fire against the uncommitted tree. The recomputation then produced the fingerprint that was
    // already in place, decided nothing had moved, and pushed nothing; the timer was spent, so
    // nothing rescheduled it. The probes were never told, and stayed on the old configuration
    // until something else happened to change something.
    //
    // The class comment argued that running *after* the transaction is safe, including after a
    // rollback, which is true and was never the risk. `afterCommit` is `U-02`'s hook and exists
    // for exactly this: a rolled-back transaction schedules nothing at all.
    if (q.afterCommit !== undefined) {
      q.afterCommit(() => {
        this.#schedule();
      });
      return Promise.resolve();
    }
    // No transaction to wait for — a sink called outside `tx`. Schedule as before.
    this.#schedule();
    return Promise.resolve();
  }

  /**
   * Binds the endpoint once it exists.
   *
   * The object service is assembled before the probe endpoint — it has to be, the endpoint reads
   * configuration through it — so the sink cannot be handed its target at construction. Until it
   * is attached there is nothing listening for a push anyway: a probe cannot be connected to an
   * endpoint that has not been created.
   */
  attach(target: ConfigPushTarget): void {
    this.#target = target;
  }

  /** Flushes immediately. For tests, and for a shutdown that wants the last change delivered. */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#stopped) return;
    this.#target?.pushAllConfigs();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.#target?.pushAllConfigs();
      } catch (error: unknown) {
        this.#logger.error({ err: error }, 'a configuration push failed');
      }
    }, this.#debounceMs);
    // A pending push must never hold the process open: shutdown drains the connections, and a
    // configuration nobody is connected to receive is not worth waiting for.
    this.#timer.unref();
  }
}
