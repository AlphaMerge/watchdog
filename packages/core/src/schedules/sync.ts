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
 * **`object.created` is deliberately not in the list.** A recompute walks every sensor, and
 * discovery creates them in thousands — one full walk per create is the shape of regression
 * that `P-04`'s budget caught in `M-08`. A sensor created inside a closed window therefore
 * starts unpaused and is paused by the next sweep, within a minute and before its first scan
 * interval has usually elapsed. That is the one hole in "a schedule takes effect immediately",
 * it is bounded, and closing it properly means a subtree-scoped recompute — filed with `M-12`
 * rather than smuggled in here.
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
    // affordable on this path.
    case 'object.moved':
      return true;
    default:
      return false;
  }
}
