import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ObjectId } from '../objects/types.js';
import type { AlarmEngine } from './engine.js';

export interface TriggerSyncOptions {
  engine: AlarmEngine;
  logger: Logger;
}

/**
 * Keeps standing alarms in step with the configuration changes that move them (`N-02`).
 *
 * The state changes that move alarms arrive through ingestion and `reevaluate`; this is the
 * other half — somebody adding a trigger, editing one, deleting one, or moving a subtree into or
 * out of the reach of one. It rides the audit sink for the reason `M-09`'s and `M-11`'s do: the
 * sink is already inside every mutation's own transaction, so a new mutation path cannot forget.
 *
 * **Adding a trigger during an outage has to arm the outage.** That is the case this exists for.
 * An operator who notices a device is down and adds "tell me when things go down" means *this*
 * one; an engine that only ever reacted to state changes would stay silent until the sensor
 * recovered and failed again, which is precisely when nobody is watching.
 *
 * `object.created` is excluded on the same grounds as `M-09` and `M-11`, and with the same
 * bound: discovery creates sensors in thousands, and a new sensor starts Unknown with no history
 * to alarm about. Its first result reconciles it.
 */
export class TriggerSync implements AuditSink {
  readonly #engine: AlarmEngine;
  readonly #logger: Logger;

  constructor(options: TriggerSyncOptions) {
    this.#engine = options.engine;
    this.#logger = options.logger.child({ component: 'alarms' });
  }

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    // The objects whose subtrees need looking at, deduplicated: a batch that edits three
    // triggers on one device should walk it once.
    const roots = new Set<ObjectId>();
    for (const mutation of mutations) {
      const root = affected(mutation);
      if (root !== null) roots.add(root);
    }
    if (roots.size === 0) return;

    let armed = 0;
    let cleared = 0;
    for (const root of roots) {
      const result = await this.#engine.reconcileSubtree(q, root, at);
      armed += result.armed;
      cleared += result.cleared;
    }
    if (armed > 0 || cleared > 0) {
      this.#logger.info({ armed, cleared }, 'a trigger change moved standing alarms');
    }
  }
}

function affected(mutation: Mutation): ObjectId | null {
  switch (mutation.action) {
    // The trigger's own object, and everything beneath it. Deleting one has to stand its alarms
    // down too — the row cascades, but nothing else would notice that a chain in progress is now
    // a chain nobody asked for.
    case 'trigger.created':
    case 'trigger.updated':
    case 'trigger.deleted':
      return mutation.objectId;
    // A subtree that moved may have arrived under a trigger, or left one behind. Rare and
    // bounded, unlike a create.
    case 'object.moved':
      return mutation.objectId;
    // `N-16`'s fence going up or coming down changes which triggers reach a whole subtree, so
    // it moves standing alarms exactly the way editing a trigger does. Only when it *changed*:
    // an edit reaches this sink on every rename, and reconciling a subtree because somebody
    // fixed a typo is the regression `M-08` paid for once already.
    case 'object.updated':
      return mutation.before.inheritsTriggers === mutation.after.inheritsTriggers
        ? null
        : mutation.objectId;
    default:
      return null;
  }
}
