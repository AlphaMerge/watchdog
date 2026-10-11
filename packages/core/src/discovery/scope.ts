import type { Visibility } from '../auth/access.js';
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
  if (!(await isUnderProbe(q, groupId, probeId))) throw wrongProbe(groupId);
}

/**
 * Refuses a probe its caller cannot see, in the words `requireGroupProbe` refuses any wrong one
 * (`A-77`).
 *
 * **Otherwise the right probe is an oracle.** `requireGroupProbe` accepts exactly one id, the
 * probe above the group, so a writer given the group and not the probe could try ids until one
 * was accepted and learn which object that is. Asked before it, by the routes that take a probe
 * from their caller, so a hidden probe is answered as an id nobody used: a discovery runs from a
 * probe its caller can see. A schedule firing has no caller and is not asked.
 */
export async function requireProbeInView(
  q: Queryable,
  sees: Visibility,
  groupId: number,
  probeId: number,
): Promise<void> {
  if (sees.everything) return;
  if (!(await sees.visibleAmong(q, [probeId])).has(probeId)) throw wrongProbe(groupId);
}

/**
 * The probe a discovery its caller asked for runs from (`A-77`): the one they named, if they may
 * name it, or else the one the group is under.
 *
 * **Left out is how a writer granted a branch starts one.** Naming the probe above their group is
 * refused once they cannot see it, as any wrong probe is, and the group's own is still the only
 * probe a run may use; so the caller may leave the choice to the group, which has only one answer.
 */
export async function probeFor(
  q: Queryable,
  sees: Visibility,
  groupId: number,
  named: number | undefined,
): Promise<number> {
  if (named !== undefined) {
    await requireProbeInView(q, sees, groupId, named);
    return named;
  }
  const nearest = await objects.nearestProbe(q, groupId);
  if (nearest === null) throw wrongProbe(groupId);
  return nearest.id;
}

/**
 * What carries the probe a discovery runs from: a run, its summary, a rediscovery rule.
 */
interface NamesItsProbe {
  readonly probeId: number;
}

/** The same, without the probe when its reader cannot see it. */
export type ProbeAsSeen<T extends NamesItsProbe> = Omit<T, 'probeId'> & { probeId?: number };

/**
 * Runs, summaries or rules as their reader may see them (`A-80`): without `probeId` where that
 * probe is outside the reader's view.
 *
 * **A run is read with read on its group, and the probe above it is another object.** A writer
 * granted one branch below a probe they cannot see reads the runs and rules of their own group,
 * and each carried the id `requireProbeInView` refuses to confirm — so the oracle `A-77` closed
 * at the door was open in every read. Left out rather than `null`, in every reply that carries
 * one, so a client tells "a probe you cannot see" by the key being absent and never reads an id.
 * An administrator, and anybody who can see the probe, is answered as before.
 */
export async function probesAsSeen<T extends NamesItsProbe>(
  q: Queryable,
  sees: Visibility,
  items: readonly T[],
): Promise<ProbeAsSeen<T>[]> {
  if (sees.everything || items.length === 0) return [...items];
  const seen = await sees.visibleAmong(q, [...new Set(items.map((item) => item.probeId))]);
  return items.map((item) => {
    if (seen.has(item.probeId)) return item;
    const shown: ProbeAsSeen<T> = { ...item };
    delete shown.probeId;
    return shown;
  });
}

/** `probesAsSeen` for one. */
export async function probeAsSeen<T extends NamesItsProbe>(
  q: Queryable,
  sees: Visibility,
  item: T,
): Promise<ProbeAsSeen<T>> {
  const [shown] = await probesAsSeen(q, sees, [item]);
  return shown ?? item;
}

/** The one refusal for every wrong probe, so the checks above cannot come to differ. */
function wrongProbe(groupId: number): DiscoveryError {
  return new DiscoveryError(
    'DISCOVERY_PROBE_INVALID',
    'a discovery runs from the probe its group is under, and that is not the probe given',
    { context: { groupId, phase: 'discovery' } },
  );
}

/**
 * Whether a group is under this probe now: the one rule above, asked of a run already going.
 *
 * A run keeps the probe it started on, and its group can move under another afterwards
 * (`P-241`). Asked again wherever the run is offered to its probe, and before anything is
 * provisioned from it.
 */
export async function isUnderProbe(
  q: Queryable,
  groupId: number,
  probeId: number,
): Promise<boolean> {
  const nearest = await objects.nearestProbe(q, groupId);
  return nearest !== null && nearest.id === probeId;
}
