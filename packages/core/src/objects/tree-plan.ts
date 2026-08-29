import { ObjectError } from './errors.js';
import type { CreateObjectInput, ObjectId, ObjectKind } from './types.js';

/**
 * Turning a subtree somebody described into the order it has to be written in (`P-19`).
 *
 * **Pure, and separate from the writing, because this is where the mistakes are.** The
 * transaction that follows is a handful of batched inserts; what decides whether it produces the
 * tree the caller meant is the ordering, the reference resolution and the kind rules — none of
 * which need a database to be wrong, and all of which are cheaper to test without one.
 *
 * **Levels rather than a topological list.** A flat ordering would still be one insert per node:
 * the point of this ticket is one statement per *level*, and a level is exactly the set of nodes
 * whose parents are all already written. Falling out of the same walk that detects a cycle costs
 * nothing extra.
 */

/**
 * `Omit` over a union, member by member.
 *
 * A plain `Omit<CreateObjectInput, 'parentId'>` collapses the four kinds into one object with
 * every field optional, which is exactly the "optional-field soup" `CLAUDE.md` forbids — and the
 * compiler then stops noticing that a sensor node must carry a `sensorType`.
 */
type WithoutParent<T> = T extends unknown ? Omit<T, 'parentId'> : never;

/** One node of a subtree, naming its parent within the request rather than by id. */
export type TreeNodeInput = WithoutParent<CreateObjectInput> & {
  /**
   * A name for this node, unique within the request, so later nodes can hang off it.
   *
   * Optional: a leaf nobody points at needs no handle, and requiring one for five thousand
   * sensors would be five thousand strings that exist to be ignored.
   */
  ref?: string;
  /** The `ref` of this node's parent. Absent means the request's own `parentId`. */
  parentRef?: string;
};

export interface TreePlanInput {
  /** Where the subtree hangs. Every node with no `parentRef` is a child of this. */
  parentId: ObjectId;
  nodes: readonly TreeNodeInput[];
}

/** One node, with its parent resolved to something the writer can use. */
export interface PlannedNode {
  /** Index into the caller's `nodes`, so the result can be handed back in their order. */
  index: number;
  ref: string | undefined;
  kind: ObjectKind;
  input: TreeNodeInput;
  /** Set when the parent is an existing object rather than one of these nodes. */
  parentId: ObjectId | undefined;
  /** Set when the parent is in this request. Exactly one of these two is defined. */
  parentIndex: number | undefined;
}

export interface TreePlan {
  /**
   * Nodes grouped by depth: everything in level *n* has its parent written by the end of level
   * *n - 1*, which is what makes one statement per level correct.
   */
  levels: PlannedNode[][];
  count: number;
}

/**
 * The most nodes one request may create.
 *
 * The v1 target, exactly: five thousand objects is what `PLAN.md` states the tree-build criterion
 * for, so a request that builds a whole v1 installation in one go is the largest thing this has
 * to do. Beyond it a caller pages, which is a request they can retry rather than a transaction
 * that holds the tree lock for a minute.
 */
export const MAX_TREE_NODES = 5_000;

/**
 * How deep a subtree one request may describe.
 *
 * The object model allows four kinds below the root and groups nest, so a legitimate request is
 * a handful of levels. This is not a business rule — it is what stops a request whose refs
 * describe a five-thousand-deep chain from becoming five thousand round trips wearing the shape
 * of one.
 */
export const MAX_TREE_DEPTH = 32;

/** Which kinds may contain which. The same table the database enforces (migration 001). */
const ACCEPTS: Readonly<Record<ObjectKind, readonly ObjectKind[]>> = {
  root: [],
  probe: ['root'],
  group: ['probe', 'group'],
  device: ['probe', 'group'],
  sensor: ['device'],
};

export function parentKindAccepts(child: ObjectKind, parent: ObjectKind): boolean {
  return ACCEPTS[child].includes(parent);
}

/**
 * Orders a described subtree into levels, or says exactly which node is wrong.
 *
 * **Every refusal names the node by its index and its ref.** A caller sending five thousand nodes
 * cannot act on "invalid request"; the failures here are all of the form "node 3,417 (`dev-88`)
 * says its parent is `grp-12`, which nothing in this request creates", which is a thing somebody
 * can go and fix.
 */
export function planTree(input: TreePlanInput, parentKind: ObjectKind): TreePlan {
  const { nodes } = input;
  if (nodes.length === 0) {
    throw invalid('a subtree with no nodes in it creates nothing', { nodes: 0 });
  }
  if (nodes.length > MAX_TREE_NODES) {
    throw invalid(
      `${String(nodes.length)} nodes is more than one request may create ` +
        `(${String(MAX_TREE_NODES)})`,
      { nodes: nodes.length, limit: MAX_TREE_NODES },
    );
  }

  const byRef = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.ref === undefined) return;
    const seen = byRef.get(node.ref);
    if (seen !== undefined) {
      // Silently letting the second win would attach children to whichever node the caller did
      // not mean, and the tree would be wrong rather than refused.
      throw invalid(
        `two nodes both call themselves "${node.ref}" (${String(seen)} and ${String(index)})`,
        { ref: node.ref, first: seen, second: index },
      );
    }
    byRef.set(node.ref, index);
  });

  const planned: PlannedNode[] = nodes.map((node, index) => {
    if (node.parentRef === undefined) {
      return {
        index,
        ref: node.ref,
        kind: node.kind,
        input: node,
        parentId: input.parentId,
        parentIndex: undefined,
      };
    }
    const parentIndex = byRef.get(node.parentRef);
    if (parentIndex === undefined) {
      throw invalid(
        `node ${String(index)}${describeRef(node.ref)} says its parent is "${node.parentRef}", ` +
          'which nothing in this request creates',
        { index, parentRef: node.parentRef },
      );
    }
    if (parentIndex === index) {
      throw invalid(`node ${String(index)}${describeRef(node.ref)} is its own parent`, { index });
    }
    return {
      index,
      ref: node.ref,
      kind: node.kind,
      input: node,
      parentId: undefined,
      parentIndex,
    };
  });

  // Kind rules, checked against the parent's kind whether that parent already exists or is being
  // created here. The database enforces the same table on every row it writes; doing it here as
  // well is what turns a constraint violation on row 3,417 into a sentence naming node 3,417.
  for (const node of planned) {
    const parent = node.parentIndex === undefined ? parentKind : nodes[node.parentIndex]?.kind;
    if (parent === undefined) continue;
    if (!parentKindAccepts(node.kind, parent)) {
      throw invalid(
        `node ${String(node.index)}${describeRef(node.ref)} is a ${node.kind}, which cannot ` +
          `go under a ${parent}`,
        { index: node.index, kind: node.kind, parentKind: parent },
      );
    }
  }

  return { levels: intoLevels(planned), count: planned.length };
}

/**
 * Groups nodes by how deep they sit, refusing a chain that never reaches the root.
 *
 * Breadth-first from the nodes whose parent already exists, which is also the cycle check: a
 * reference loop is exactly the set of nodes no level ever reaches, and reporting them by name
 * beats reporting a depth limit that a legitimate deep tree would also hit.
 */
function intoLevels(planned: readonly PlannedNode[]): PlannedNode[][] {
  const children = new Map<number, PlannedNode[]>();
  const levels: PlannedNode[][] = [];
  let current: PlannedNode[] = [];

  for (const node of planned) {
    if (node.parentIndex === undefined) {
      current.push(node);
      continue;
    }
    const siblings = children.get(node.parentIndex) ?? [];
    siblings.push(node);
    children.set(node.parentIndex, siblings);
  }

  let placed = current.length;
  while (current.length > 0) {
    if (levels.length >= MAX_TREE_DEPTH) {
      throw invalid(`this subtree is more than ${String(MAX_TREE_DEPTH)} levels deep`, {
        depth: levels.length,
      });
    }
    levels.push(current);
    const next: PlannedNode[] = [];
    for (const node of current) {
      for (const child of children.get(node.index) ?? []) next.push(child);
    }
    placed += next.length;
    current = next;
  }

  if (placed !== planned.length) {
    const orphan = planned.find((node) => !levels.some((level) => level.includes(node)));
    throw invalid(
      `node ${String(orphan?.index ?? -1)}${describeRef(orphan?.ref)} is in a loop of parent ` +
        'references, so nothing in it hangs off the tree',
      { index: orphan?.index ?? -1 },
    );
  }
  return levels;
}

function describeRef(ref: string | undefined): string {
  return ref === undefined ? '' : ` ("${ref}")`;
}

function invalid(message: string, details: Record<string, unknown>): ObjectError {
  return new ObjectError('OBJECT_INVALID', message, {
    context: { phase: 'create-tree' },
    details,
  });
}
