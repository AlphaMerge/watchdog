import type { LiveState } from '../api/stream';
import type { ObjectSummary, SensorState } from '../api/types';

/** One row of the flattened, visible tree. */
export interface TreeRowModel {
  readonly object: ObjectSummary;
  readonly depth: number;
  readonly expanded: boolean;
  /** False for a leaf, so a row can render a disclosure or a space. */
  readonly expandable: boolean;
  /** True while its children are on their way. */
  readonly loading: boolean;
}

/** What has been loaded, and what the operator has opened. */
export interface TreeState {
  /** Children by parent id. Absent means "not fetched yet", empty means "fetched, none". */
  readonly children: ReadonlyMap<number, readonly ObjectSummary[]>;
  readonly expanded: ReadonlySet<number>;
  readonly loading: ReadonlySet<number>;
}

export const EMPTY_TREE: TreeState = {
  children: new Map(),
  expanded: new Set(),
  loading: new Set(),
};

/**
 * The visible rows, in order, from what has been loaded and what is open.
 *
 * **Lazy by level, not one fetch of everything.** `GET /objects/{id}/tree` caps at 5,000 objects
 * and has no cursor, and the v1 target is 5,000 *sensors* plus the devices and groups above them
 * — so the one-fetch tree is truncated at exactly the size this task has to be responsive at.
 * Loading a level at a time also makes first paint independent of how big the installation is,
 * which is the property that actually matters to somebody opening the page.
 *
 * Iterative rather than recursive: a tree is operator-shaped and shallow in practice, but
 * "in practice" is not a bound, and a stack overflow in a render is a blank page.
 */
export function flatten(state: TreeState, rootId: number | null): TreeRowModel[] {
  if (rootId === null) return [];
  const rows: TreeRowModel[] = [];
  const stack: { readonly items: readonly ObjectSummary[]; index: number; depth: number }[] = [
    { items: state.children.get(rootId) ?? [], index: 0, depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.items.length) {
      stack.pop();
      continue;
    }
    const object = frame.items[frame.index];
    frame.index += 1;
    if (object === undefined) continue;

    const expanded = state.expanded.has(object.id);
    rows.push({
      object,
      depth: frame.depth,
      expanded,
      expandable: object.hasChildren,
      loading: state.loading.has(object.id),
    });
    if (expanded && object.hasChildren) {
      stack.push({ items: state.children.get(object.id) ?? [], index: 0, depth: frame.depth + 1 });
    }
  }
  return rows;
}

/**
 * How alarming each state is, for the purpose of colouring a container.
 *
 * **Decided here, and not the core's `ROLLUP_SEVERITY`.** That one ranks `up`, `warning` and
 * `down` for the multi-channel rollup *within* one sensor, and deliberately says nothing about
 * the rest. Rolling a subtree up to a group is a different question with two answers the core
 * never has to give:
 *
 * - **`up` beats `paused`.** A group holding one paused sensor and one healthy one is Up.
 *   Showing it as Paused would say the whole group is switched off — which is a real and
 *   different thing, because a group *can* be paused and then everything under it is.
 * - **`unknown` beats `up`.** A subtree with a sensor nothing has measured yet is not simply
 *   fine; grey says "not all of this is being watched", which is the honest reading and the one
 *   that gets a forgotten sensor noticed.
 *
 * Below the downs, `unusual` outranks `unknown`: a reading that looks wrong is more actionable
 * than no reading. And `down_acknowledged` sits under `down_partial`, because somebody has taken
 * the acknowledged one.
 */
const SEVERITY: Record<SensorState, number> = {
  down: 7,
  down_partial: 6,
  down_acknowledged: 5,
  warning: 4,
  unusual: 3,
  unknown: 2,
  up: 1,
  paused: 0,
};

export function worstOf(a: SensorState, b: SensorState): SensorState {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/**
 * The worst state beneath every ancestor, from the live states alone.
 *
 * **No tree walk, because the stream already carries the answer.** `U-02`'s events and snapshot
 * entries each carry the sensor's absolute path, root first — which is exactly what makes a
 * rollup possible over a tree that has only been *partly* loaded. A collapsed group whose
 * children have never been fetched still shows the colour of the outage inside it, which is the
 * whole point of colouring a collapsed group.
 *
 * One pass over the states, touching each sensor's ancestors once.
 */
export function rollup(states: Iterable<LiveState>): Map<number, SensorState> {
  const worst = new Map<number, SensorState>();
  for (const live of states) {
    for (const ancestor of live.path) {
      const held = worst.get(ancestor);
      worst.set(ancestor, held === undefined ? live.state : worstOf(held, live.state));
    }
  }
  return worst;
}

/**
 * What a row shows as its state: a sensor's own, or the worst thing beneath a container.
 *
 * Undefined rather than `unknown` when nothing is known, so a row can render nothing at all —
 * a group with no sensors under it has no status, and drawing it grey would be a claim.
 */
export function stateFor(
  object: ObjectSummary,
  live: ReadonlyMap<number, LiveState>,
  worst: ReadonlyMap<number, SensorState>,
): SensorState | undefined {
  if (object.kind === 'sensor') return live.get(object.id)?.state ?? object.state;
  return worst.get(object.id);
}
