import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import { SCHEDULE_ID } from '../settings/registry.js';
import type { SchedulePauses } from './pauses.js';

export interface ScheduleSyncOptions {
  pauses: SchedulePauses;
  logger: Logger;
}

/**
 * Keeps `paused_by_schedule` in step with the changes that can invalidate it (`M-09`).
 *
 * It rides the audit sink for the reason `R-04`'s config push and `M-04`'s cache invalidation
 * do: the sink already runs inside *every* mutation's transaction, so a new mutation path
 * cannot forget to tell the schedules about itself. Editing a schedule's periods, assigning
 * one to a group, reverting that assignment and moving a device into a scheduled group are four
 * different code paths, and all four end here.
 *
 * **`object.created` is handled, but not by a full recompute** (`P-109`). It used to be excluded
 * on the grounds that a sensor created inside a closed window "is paused by the next sweep,
 * within a minute and before its first scan interval has usually elapsed". The cost half of that
 * was right — a recompute walks every sensor and discovery creates them in thousands, which is
 * the regression `P-04`'s budget caught in `M-08` — and the timing half was not.
 * `TimingWheel.add` documents the opposite: "the first firing is the next tick that lands on the
 * sensor's own phase — not a whole interval away", so the first scan lands uniformly in
 * (0, intervalSeconds] while the sweep is armed at the next wall-clock minute. At the registry
 * default of 60 s that is a coin flip; below 60 s the scan always wins.
 *
 * So the subtree-scoped recompute that was filed for later is here: a create resolves the flag
 * for the sensors it made and nothing else, which is one indexed lookup rather than a walk. A
 * bulk create emits one mutation per object, so the whole batch is named.
 *
 * **`object.cloned` takes the full recompute instead**, because it cannot be narrowed: cloning a
 * device emits *one* mutation, for the device, and the sensors it produced are not in it. Clones
 * are rare and bounded, which is the same argument that already admits `object.moved` — and it
 * was missing from the old list altogether, which is another way a subtree lands under an
 * assignment unnoticed.
 */
export class ScheduleSync implements AuditSink {
  readonly #pauses: SchedulePauses;
  readonly #logger: Logger;

  constructor(options: ScheduleSyncOptions) {
    this.#pauses = options.pauses;
    this.#logger = options.logger.child({ component: 'schedules' });
  }

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    // Created sensors are resolved on their own, without walking every other sensor — see the
    // note on `object.created` above.
    const created = mutations.flatMap((mutation) =>
      mutation.action === 'object.created' && mutation.kind === 'sensor' ? [mutation.objectId] : [],
    );
    if (created.length > 0) {
      const held = await this.#pauses.holdNew(q, created, at);
      if (held > 0) {
        this.#logger.info(
          { created: created.length, held },
          'new sensors arrived inside a closed window',
        );
      }
    }

    if (!mutations.some(invalidates)) return;
    const result = await this.#pauses.recompute(q, at);
    if (result.moved > 0) {
      this.#logger.info(
        { moved: result.moved, transitions: result.transitions },
        'a schedule change moved sensors',
      );
    }
  }
}

function invalidates(mutation: Mutation): boolean {
  switch (mutation.action) {
    case 'schedule.created':
    case 'schedule.updated':
    case 'schedule.deleted':
      return true;
    case 'setting.set':
    case 'setting.reverted':
      return mutation.key === SCHEDULE_ID.key;
    // A device moved from an unscheduled group into a scheduled one inherits the schedule the
    // moment it lands. Moves are rare and bounded, unlike creates, so the recompute is
    // affordable on this path — and a clone is the same shape, one mutation for a subtree whose
    // sensors it does not name (`P-109`).
    case 'object.moved':
    case 'object.cloned':
      return true;
    default:
      return false;
  }
}
