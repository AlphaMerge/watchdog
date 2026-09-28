import type { Queryable } from '../db/pool.js';
import { ObjectRepository } from '../objects/repository.js';
import { DiscoveryError } from './errors.js';

const objects = new ObjectRepository();

/**
 * Refuses a discovery whose probe is not the one its group is under (`A-28`).
 *
 * **The group was checked and the probe was not.** Starting a run, or a schedule that starts
 * them, needed write on the group the results land in and nothing at all on the probe that
 * sends the packets — so a writer on one customer's group could name another customer's probe
 * and sweep *that* customer's network from inside it, read what answered under their own group,
 * provision it, put it on a timer, and hold the other customer's probe busy while they did. The
 * probe a run may use is not a choice: it is the one the group is under, because that is the
 * machine whose network the group's devices live on and whose checks they already run on.
 *
 * **One sentence for every wrong probe**, whether it is somebody else's, one the caller cannot
 * see, not a probe at all, or no object whatever: telling those apart would say which ids exist
 * above a branch the caller was not given (`A-15`, `A-16`). The sentence names neither id.
 *
 * Here rather than in the route, so every path that starts a run passes it — a schedule firing
 * long after it was created included, when the group may since have moved under another probe.
 */
export async function requireGroupProbe(
  q: Queryable,
  groupId: number,
  probeId: number,
): Promise<void> {
  const nearest = await objects.nearestProbe(q, groupId);
  if (nearest === null || nearest.id !== probeId) {
    throw new DiscoveryError(
      'DISCOVERY_PROBE_INVALID',
      'a discovery runs from the probe its group is under, and that is not the probe given',
      { context: { groupId, phase: 'discovery' } },
    );
  }
}
