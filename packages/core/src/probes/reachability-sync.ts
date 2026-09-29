import type { Logger } from '@ms/shared';
import { describeError } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ProbeReachability } from './reachability.js';

export interface ReachabilitySyncOptions {
  /**
   * Read through a closure, because `ProbeReachability` is built long after the audit sink that
   * needs it — the same forward reference `SensorStateService.unreachableSensors` uses, and for
   * the same reason. Undefined means nothing is watching probes yet, which is a core still
   * starting up and has no overlay to keep in step.
   */
  reachability: () => ProbeReachability | undefined;
  logger: Logger;
}

/**
 * Keeps the unreachable-sensor overlay in step with the tree (`P-103`).
 *
 * `ProbeReachability.lost` snapshots which sensors a probe was carrying, and that snapshot used
 * to outlive the topology it was taken from. The obvious remediation for a dead probe is to move
 * its devices onto a live one — and doing so left every moved sensor reading `unknown`/`probe`
 * for as long as the dead probe stayed away, which is for ever if it was decommissioned. No
 * transition was written, because the state did not change; the sensors were simply dark, and
 * unable to alarm, while their new probe scanned them without complaint.
 *
 * It rides the audit sink for the reason `M-09`'s and `M-11`'s do: the sink is already inside
 * every mutation's transaction, so a new path that moves objects cannot forget.
 *
 * **`object.created` is included, unlike in `ScheduleSync`.** The objection there is cost —
 * discovery creates sensors in thousands and a recompute walks every sensor — and it does not
 * apply here: the work is gated on at least one probe being offline, which is the abnormal case,
 * and an installation with nothing offline pays one `Map.size` check per mutation.
 */
export class ReachabilitySync implements AuditSink {
  readonly #reachability: () => ProbeReachability | undefined;
  readonly #logger: Logger;

  constructor(options: ReachabilitySyncOptions) {
    this.#reachability = options.reachability;
    this.#logger = options.logger.child({ component: 'probe-reachability' });
  }

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    _at: Date,
  ): Promise<void> {
    if (!mutations.some(movesSensors)) return;
    const reachability = this.#reachability();
    if (reachability === undefined) return;
    try {
      await reachability.resync(q);
    } catch (error) {
      // Never fatal to the mutation. The overlay being stale is what this fixes; refusing a
      // legitimate move because the fix could not run would be worse than the defect.
      this.#logger.error(
        { err: describeError(error) },
        'could not re-derive probe reachability after a tree change',
      );
    }
  }
}

/**
 * Whether a mutation can change which probe carries a sensor. Asked by `ClockFreezeSync` too, so
 * the two overlays are kept in step with the tree on exactly the same changes (`P-239`).
 */
export function movesSensors(mutation: Mutation): boolean {
  switch (mutation.action) {
    // A subtree arriving under, or leaving, a probe that is currently away.
    case 'object.moved':
    case 'object.created':
    case 'object.cloned':
    case 'object.deleted':
      return true;
    default:
      return false;
  }
}
