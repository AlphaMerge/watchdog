import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ChannelResolver } from './channels.js';

/** The caches on the result path. Narrow interfaces so this file knows nothing about either. */
export interface ForgetsChannels {
  forget(sensorId: number): number;
  clear(): void;
}

export interface ForgetsSensors {
  clear(): void;
  /** Drops resolved failure policies, which any setting change or move can have altered. */
  forgetPolicies(): void;
}

export interface ResultCacheInvalidatorOptions {
  channels: ChannelResolver | ForgetsChannels;
  sensors?: ForgetsSensors;
  logger: Logger;
  /** How long after the transaction to invalidate a second time. See below. */
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
 * this class exists to prevent, reintroduced by the fix. So it forgets immediately, and again a
 * moment after the transaction can be expected to have settled. Forgetting is idempotent and
 * costs one query on the next batch, so doing it twice is free; doing it once is a race.
 */
export class ResultCacheInvalidator implements AuditSink {
  readonly #channels: ForgetsChannels;
  readonly #sensors: ForgetsSensors | undefined;
  readonly #logger: Logger;
  readonly #settleMs: number;
  #stopped = false;

  constructor(options: ResultCacheInvalidatorOptions) {
    this.#channels = options.channels;
    this.#sensors = options.sensors;
    this.#logger = options.logger.child({ component: 'cache-invalidation' });
    this.#settleMs = options.settleMs ?? 250;
  }

  record(_q: Queryable, _actor: Actor, mutations: readonly Mutation[], _at: Date): Promise<void> {
    // Nothing here awaits or touches the database: this runs inside the caller's transaction,
    // and a mutation must not get slower because a cache needed clearing.
    for (const mutation of mutations) {
      // Any change to a channel, by prefix rather than by listing the actions. Every
      // `channel.*` mutation carries the sensor's id, and the alternative — three names to keep
      // in step with the union — is a list `M-07` had already fallen off before its own test
      // caught it.
      // `objectId` is null on the schedule mutations, which are about a library object and
      // never about a channel; the guard is what makes the prefix test type-safe as well as
      // correct.
      if (mutation.action.startsWith('channel.') && mutation.objectId !== null) {
        this.#forgetSensor(mutation.objectId);
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
        this.#forgetPolicies();
      } else if (mutation.action === 'object.deleted') {
        // A subtree delete can destroy thousands of sensors, and forgetting them one at a time
        // would be a scan of the whole cache per sensor inside a transaction. Dropping the lot
        // costs one query per live sensor on the next batch and is bounded; the per-sensor walk
        // is not. Without it, a spooled result for a deleted sensor resolves to a channel id
        // that no longer exists and writes an orphaned reading instead of being counted as a
        // drop.
        this.#forgetEverything();
      }
    }
    return Promise.resolve();
  }

  /** Stops the deferred pass. For a shutdown that must not keep a timer alive. */
  stop(): void {
    this.#stopped = true;
  }

  #forgetSensor(sensorId: number): void {
    const dropped = this.#channels.forget(sensorId);
    if (dropped > 0) {
      this.#logger.debug({ sensorId, channels: dropped }, 'forgot a sensor’s cached channels');
    }
    this.#later(() => {
      this.#channels.forget(sensorId);
    });
  }

  #forgetPolicies(): void {
    this.#sensors?.forgetPolicies();
    this.#later(() => {
      this.#sensors?.forgetPolicies();
    });
  }

  #forgetEverything(): void {
    this.#channels.clear();
    this.#sensors?.clear();
    this.#later(() => {
      this.#channels.clear();
      this.#sensors?.clear();
    });
  }

  #later(run: () => void): void {
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      if (!this.#stopped) run();
    }, this.#settleMs);
    // Never a reason to hold the process open: a cache in a process that is exiting is about to
    // stop existing anyway.
    timer.unref();
  }
}
