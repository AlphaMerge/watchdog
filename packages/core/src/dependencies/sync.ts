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
 * `object.created` is handled, but not by a recompute (`P-93`). It used to be skipped on the
 * grounds that "a sensor created under a held master is picked up by the next state change of
 * that master or by the next sweep", and neither was true. There is no periodic dependency
 * recompute anywhere — `sweepPauses` calls only `releaseElapsed`, which does nothing unless a
 * `dependency_clear_at` is due — and the next state change of the master does not arrive while
 * it stays Down, because `react` runs on the transitions a *result batch* produced and a master
 * sitting at Down produces none. So the new sensor scanned through the outage, failed, went
 * Down and armed its own alarm: one outage, two alarms, out of the exact topology the
 * dependency exists to collapse, for as long as the master stayed Down.
 *
 * The original objection stands and is what shapes the fix: discovery creates sensors in
 * thousands and a recompute walks every sensor. So a create resolves the flag for *the created
 * sensors only*, which is one indexed query over that batch rather than a settle over the tree.
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
    // Created sensors are held or not held on their own, without a walk over every other
    // sensor — see the note on `object.created` above.
    const created = mutations.flatMap((mutation) =>
      mutation.action === 'object.created' && mutation.kind === 'sensor' ? [mutation.objectId] : [],
    );
    if (created.length > 0) {
      const held = await this.#pauses.holdNew(q, created, at);
      if (held > 0) {
        this.#logger.info(
          { created: created.length, held },
          'new sensors arrived under a held master',
        );
      }
    }

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
    // bounded, unlike a create — and a clone is the same shape, one mutation for a subtree whose
    // sensors it does not name, so it cannot take the narrow path a create does (`P-109`).
    case 'object.moved':
    case 'object.cloned':
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
    // **A forced Down is a Down** (`P-132`). `M-14`'s simulated error puts sensors into the state
    // the whole dependency mechanism exists to react to — it fires the real notification chain at
    // real people, which is what it is for — and lifting it takes them out again. Neither ran a
    // recompute, so a master forced Down never paused its dependents (the storm the dependency
    // was configured to prevent arrived in full), and if they were already held, lifting the
    // force never released them.
    case 'sensor.simulatedError':
      return true;
    // **A schedule edit moves the master's own pause flag** (`P-133`). `DependencySync` is in
    // `scheduleAuditSinks` — deliberately, and asserted by a test — for an effect this function
    // could not produce: none of the three schedule actions matched, so the sink was inert. A
    // master pausing on a schedule window does not hold its dependents (`docs/state-machine.md`
    // §3: it is switched off, not Down, and nothing has been measured), so the dependents must be
    // released — and they were not, so they stayed dark until something else happened to
    // recompute them.
    case 'schedule.created':
    case 'schedule.updated':
    case 'schedule.deleted':
      return true;
    default:
      return false;
  }
}
