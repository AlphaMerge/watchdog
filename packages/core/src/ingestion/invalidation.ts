import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ChannelResolver } from './channels.js';

/** The caches on the result path. Narrow interfaces so this file knows nothing about either. */
export interface ForgetsChannels {
  /** Forgets these sensors' channels in one pass, however many there are (`P-403` review). */
  forgetMany(sensorIds: ReadonlySet<number>): number;
  clear(): void;
}

export interface ForgetsSensors {
  clear(): void;
  /** Drops resolved failure policies, which any setting change or move can have altered. */
  forgetPolicies(): void;
}

/** Which probe may report which sensor (`P-228`). A move or a delete changes the answer. */
export interface ForgetsOwners {
  clear(): void;
}

/** Runs the second pass of a clear. */
type Later = (run: () => void) => void;

export interface ResultCacheInvalidatorOptions {
  channels: ChannelResolver | ForgetsChannels;
  sensors?: ForgetsSensors;
  owners?: ForgetsOwners;
  /**
   * Called once a move or a delete has committed (`A-41c`): what is held against a sensor for the
   * probe it was under is then held against the wrong probe, or against nothing.
   */
  afterMoveOrDelete?: () => void;
  logger: Logger;
  /**
   * How long after the mutation to invalidate a second time, when its `Queryable` cannot say
   * when it committed. See below.
   */
  settleMs?: number;
}

/**
 * Keeps the result path's caches honest when configuration changes (`M-04`).
 *
 * Ingestion caches what it resolves — a channel's id and limits (`M-04`), a sensor's failure
 * policy (`M-03`) — because at the v1 target of 5,000 sensors, re-reading them on every result
 * would be tens of thousands of rows a minute for values that change once a month. The cost of
 * that cache is this: something has to notice when one of those values is edited, or an operator
 * lowers a threshold and nothing happens until the core is restarted. "Immediate effect" is in
 * `M-04`'s own description.
 *
 * It rides the audit sink for the reason `R-04`'s config push does: the sink is already called
 * inside *every* mutation's transaction, so there is one place to remember rather than one per
 * write site — and the one that gets forgotten is the one that leaves a limit inert.
 *
 * **Invalidated twice, deliberately.** The sink runs inside the transaction, before it commits.
 * A results batch that resolves the same channel in that window would read the pre-commit value
 * and cache it again, and the cache would then hold the old thresholds for ever — the failure
 * this class exists to prevent, reintroduced by the fix. So it forgets immediately, and again
 * once the transaction has committed. Forgetting is idempotent and costs one query on the next
 * batch, so doing it twice is free; doing it once is a race.
 *
 * **The second time is after the commit, not after a delay** (`P-240`). It used to be a timer,
 * 250 ms after the sink ran, on the grounds that a transaction could be expected to have settled
 * by then. A move need not have: the sinks after this one do tree-wide work inside the same
 * transaction, and a batch that read the committed, pre-move tree after the timer and before the
 * commit cached the old owner with nothing left to clear it. The probe the sensors were moved to
 * was then refused as `moved`, silently, until the next move anywhere. `afterCommit` is `U-02`'s
 * hook and `probes/notifier.ts` defers to it for the same reason. The timer remains for a
 * `Queryable` without it, which is a caller outside a transaction.
 *
 * **A read in flight across the second clear is not cached either.** Each cache counts its
 * clears and keeps what a read brought back only if none happened while it ran, so a read that
 * began before the commit cannot put the old value back after it.
 */
export class ResultCacheInvalidator implements AuditSink {
  readonly #channels: ForgetsChannels;
  readonly #sensors: ForgetsSensors | undefined;
  readonly #owners: ForgetsOwners | undefined;
  readonly #afterMoveOrDelete: (() => void) | undefined;
  readonly #logger: Logger;
  readonly #settleMs: number;
  #stopped = false;

  constructor(options: ResultCacheInvalidatorOptions) {
    this.#channels = options.channels;
    this.#sensors = options.sensors;
    this.#owners = options.owners;
    this.#afterMoveOrDelete = options.afterMoveOrDelete;
    this.#logger = options.logger.child({ component: 'cache-invalidation' });
    this.#settleMs = options.settleMs ?? 250;
  }

  record(q: Queryable, _actor: Actor, mutations: readonly Mutation[], _at: Date): Promise<void> {
    // Nothing here awaits or touches the database: this runs inside the caller's transaction,
    // and a mutation must not get slower because a cache needed clearing.
    const later = this.#afterCommitOf(q);
    // **Gathered, and forgotten once after the loop** (`P-403` review). A forget is a scan of the
    // whole channel cache, and a move or a clone that clears thousands of sensors' own secrets
    // records an `object.updated` for each in this one call: a scan each would block the event
    // loop for seconds inside the mover's transaction, and again after it commits.
    const sensors = new Set<number>();
    for (const mutation of mutations) {
      // Any change to a channel, by prefix rather than by listing the actions. Every
      // `channel.*` mutation carries the sensor's id, and the alternative — three names to keep
      // in step with the union — is a list `M-07` had already fallen off before its own test
      // caught it.
      // `objectId` is null on the schedule mutations, which are about a library object and
      // never about a channel; the guard is what makes the prefix test type-safe as well as
      // correct.
      if (mutation.action.startsWith('channel.') && mutation.objectId !== null) {
        sensors.add(mutation.objectId);
      } else if (mutation.action === 'object.updated' && mutation.changedParams.length > 0) {
        // A sensor's parameters decide what its type declares for its channels (`P-297`), and
        // the resolver keeps what it decided from a declaration: a primary named by its key that
        // a reading may not rename (`P-403`). An edit that rewrote a channel forgets the sensor
        // by that channel's entry; one that changed only what the declaration would say must
        // too, or an emptied `primaryName` or a repaired parameter waits for a restart. A
        // forgotten sensor costs one query on the next batch.
        sensors.add(mutation.objectId);
      } else if (
        mutation.action === 'setting.set' ||
        mutation.action === 'setting.reverted' ||
        mutation.action === 'object.moved'
      ) {
        // The failure policy is inheritable (M-03), so a change anywhere above a sensor changes
        // it, and a move changes which "above" means. Everything is dropped rather than the
        // affected subtree resolved: working out which sensors those are means walking the tree
        // inside the mutation's own transaction, and re-resolving them costs one query for the
        // whole next batch. The precise version would cost more than the imprecise one.
        this.#forgetPolicies(later);
        // And which probe may report a sensor is exactly what a move changes (`P-228`). All of
        // it, for the same reason: a group's move carries every sensor beneath it, and working
        // out which those are is a walk inside the mover's transaction.
        if (mutation.action === 'object.moved') this.#forgetOwners(later);
      } else if (mutation.action === 'object.deleted') {
        // A subtree delete can destroy thousands of sensors, and forgetting them one at a time
        // would be a scan of the whole cache per sensor inside a transaction. Dropping the lot
        // costs one query per live sensor on the next batch and is bounded; the per-sensor walk
        // is not. Without it, a spooled result for a deleted sensor resolves to a channel id
        // that no longer exists and writes an orphaned reading instead of being counted as a
        // drop.
        this.#forgetEverything(later);
      }
    }
    if (sensors.size > 0) this.#forgetSensors(sensors, later);
    return Promise.resolve();
  }

  /** Stops the second pass. For a shutdown that must not keep a timer alive. */
  stop(): void {
    this.#stopped = true;
  }

  #forgetSensors(sensorIds: ReadonlySet<number>, later: Later): void {
    const dropped = this.#channels.forgetMany(sensorIds);
    if (dropped > 0) {
      this.#logger.debug(
        { sensors: sensorIds.size, channels: dropped },
        'forgot sensors’ cached channels',
      );
    }
    later(() => {
      this.#channels.forgetMany(sensorIds);
    });
  }

  #forgetPolicies(later: Later): void {
    this.#sensors?.forgetPolicies();
    later(() => {
      this.#sensors?.forgetPolicies();
    });
  }

  #forgetOwners(later: Later): void {
    this.#owners?.clear();
    later(() => {
      this.#owners?.clear();
      this.#afterMoveOrDelete?.();
    });
  }

  #forgetEverything(later: Later): void {
    this.#channels.clear();
    this.#sensors?.clear();
    // A deleted sensor has no owner, and a result for one must read as `unknown` rather than as
    // the probe it used to be under (`P-228`).
    this.#owners?.clear();
    later(() => {
      this.#channels.clear();
      this.#sensors?.clear();
      this.#owners?.clear();
      this.#afterMoveOrDelete?.();
    });
  }

  /**
   * When the second pass runs: once `q`'s transaction has committed, and never if it rolls back,
   * since a rollback changed nothing a cache could hold. A timer only for a `Queryable` that
   * cannot tell.
   */
  #afterCommitOf(q: Queryable): Later {
    const run = (fn: () => void): void => {
      if (!this.#stopped) fn();
    };
    if (q.afterCommit !== undefined) {
      const afterCommit = q.afterCommit.bind(q);
      return (fn) => {
        afterCommit(() => {
          run(fn);
        });
      };
    }
    return (fn) => {
      if (this.#stopped) return;
      const timer = setTimeout(() => {
        run(fn);
      }, this.#settleMs);
      // Never a reason to hold the process open: a cache in a process that is exiting is about
      // to stop existing anyway.
      timer.unref();
    };
  }
}
