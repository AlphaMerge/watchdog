import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import { DEPENDENCY_DELAY_SECONDS, DEPENDENCY_MASTER_ID } from '../settings/registry.js';
import type { DependencyPauses } from './pauses.js';

export interface DependencySyncOptions {
  pauses: DependencyPauses;
  logger: Logger;
}

/**
 * Keeps `paused_by_dependency` in step with the configuration changes that move it (`M-11`).
 *
 * The state changes that move it arrive through ingestion; this is the other half — somebody
 * pointing a device at a different master, clearing the assignment, or moving a subtree so that
 * it inherits a different one. It rides the audit sink for the reason `M-09`'s does: the sink is
 * already inside every mutation's transaction, so a new mutation path cannot forget.
 *
 * `object.created` is excluded on the same grounds as `M-09` and with the same bound: discovery
 * creates sensors in thousands, a recompute walks every sensor, and a sensor created under a
 * held master is picked up by the next state change of that master or by the next sweep.
 */
export class DependencySync implements AuditSink {
  readonly #pauses: DependencyPauses;
  readonly #logger: Logger;

  constructor(options: DependencySyncOptions) {
    this.#pauses = options.pauses;
    this.#logger = options.logger.child({ component: 'dependencies' });
  }

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    if (!mutations.some(invalidates)) return;
    const result = await this.#pauses.recompute(q, at);
    if (result.moved > 0) {
      this.#logger.info(
        { moved: result.moved, transitions: result.transitions },
        'a dependency change moved sensors',
      );
    }
  }
}

function invalidates(mutation: Mutation): boolean {
  switch (mutation.action) {
    case 'setting.set':
    case 'setting.reverted':
      return (
        mutation.key === DEPENDENCY_MASTER_ID.key || mutation.key === DEPENDENCY_DELAY_SECONDS.key
      );
    // A device moved into a subtree that carries a dependency inherits it on arrival. Rare and
    // bounded, unlike a create.
    case 'object.moved':
      return true;
    // The master itself going away. Its dependents have nothing holding them any more, and a
    // stale flag would pause them for ever with no object left to point at.
    case 'object.deleted':
      return true;
    // **The master being paused, or resumed, is a dependency change** (`P-87`).
    // `docs/state-machine.md` §3 says a paused master does not hold its dependents by
    // dependency — it is not Down, it is switched off, and nothing has been measured to hold
    // anybody on. `applyPauses`' `holding` CTE implements that rule; nothing ran it. `react` is
    // reachable only from ingestion, with the transitions a *result batch* produced, and a
    // paused master is excluded from `assignmentsFor` and so produces no further results. So
    // the dependents kept `paused_by_dependency`, dropped out of the probe configuration, and
    // were never scanned again — while `#dependencyView.holding`, computed from the master's
    // *current* state, reported nothing holding them, so the pause API said `paused: false` and
    // `resume` refused them. Silently unmonitored, indefinitely, and unresumable.
    case 'object.paused':
    case 'object.resumed':
      return true;
    default:
      return false;
  }
}
