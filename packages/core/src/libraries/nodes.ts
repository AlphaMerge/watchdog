import { SENSOR_TYPE_ID } from '@ms/sensors';
import { SENSOR_STATES, type SensorState } from '../state/tables.js';
import { LibraryError } from './errors.js';

/**
 * What a library is made of: nodes, and the rules that say what each one shows (`L-01`).
 *
 * **A library holds rules, never sensors** (Phase 14, decision 1). A rule names roots, sensor
 * types, tags and states; `L-02` evaluates it whenever the library is read. A node without a rule
 * is a heading, there to group the nodes under it.
 *
 * **Refused at the write, unlike a map's widgets.** A map reads its layout defensively and keeps a
 * widget it cannot parse as a broken tile (`G-02`), because a canvas is free-form and one odd tile
 * should not take a wall display down. A library node is a question about which sensors an
 * operator is shown, and a malformed one would not look broken — it would quietly answer a
 * different question, "every sensor" or "none". So a document that does not fit is refused whole,
 * with the path to the node that is wrong. What can go stale *after* a write — a type the
 * catalogue later drops, a root that is deleted — is `L-02`'s to report at read time.
 *
 * The limits are exported so the route's JSON Schema is built from them rather than restating
 * them: a schema and a validator that disagree about a bound refuse a request with two different
 * messages depending on which one it reaches first.
 */

export interface NodeRule {
  /** Object ids whose subtrees the node draws from. Empty is the whole installation. */
  readonly roots: readonly number[];
  /** Sensor type ids, any of. Empty is any type. */
  readonly types: readonly string[];
  /**
   * Tags, all of, and meant the way the tree's tag box means them: effective (inherited from
   * ancestors) and compared folded (Phase 14, decision 3). Stored as written.
   */
  readonly tags: readonly string[];
  /** Current states, any of. Empty is any state. */
  readonly states: readonly SensorState[];
}

export interface LibraryNode {
  /** Stable within the library, so a view can be matched back to the node that asked (`L-02`). */
  readonly id: string;
  readonly name: string;
  /** What the node shows, or `null` for a heading that only groups the nodes under it. */
  readonly rule: NodeRule | null;
  readonly children: readonly LibraryNode[];
}

/**
 * Nodes in one library, counting every level.
 *
 * `MAX_WIDGETS` is the precedent: high enough that no real arrangement meets it, low enough that
 * one document cannot be made to cost `L-02` an unbounded resolve.
 */
export const MAX_NODES = 200;
/** Levels, counting the top as one. Customer, site, role and a spare; a tree deeper than this
 * no longer fits on the screen it is meant to be read on. */
export const MAX_DEPTH = 6;
export const NODE_ID_PATTERN = '^[A-Za-z0-9_-]{1,40}$';
/**
 * What an id outside `NODE_ID_PATTERN` is told, by `validateNodes` and by the API schema's 400
 * alike (`P-372`).
 */
export const NODE_ID_MESSAGE = 'must be 1 to 40 letters, digits, "-" or "_"';
export const MAX_NODE_NAME = 100;
export const MAX_ROOTS = 50;
export const MAX_TYPES = 50;
/** The limits an object's own tags have, so a rule can name anything an object can carry. */
export const MAX_TAGS = 50;
export const MAX_TAG = 100;

const NODE_ID = new RegExp(NODE_ID_PATTERN);

/**
 * The nodes of a library, checked and normalised, or a refusal naming the node that is wrong.
 *
 * Normalised means: names trimmed, a missing `rule` read as a heading, missing lists as empty.
 * Nothing is de-duplicated or reordered — a rule listing a tag twice is refused rather than
 * silently tidied, because the author meant something by it and should be told.
 */
export function validateNodes(raw: unknown): LibraryNode[] {
  if (!Array.isArray(raw)) throw invalid('nodes', 'must be a list');
  const seen = new Set<string>();
  let count = 0;

  const readNode = (value: unknown, path: string, depth: number): LibraryNode => {
    count += 1;
    if (count > MAX_NODES) {
      throw invalid(path, `a library holds at most ${String(MAX_NODES)} nodes`);
    }
    if (depth > MAX_DEPTH) {
      throw invalid(path, `a library is at most ${String(MAX_DEPTH)} levels deep`);
    }
    if (!isRecord(value)) throw invalid(path, 'must be an object');
    for (const key of Object.keys(value)) {
      if (!['id', 'name', 'rule', 'children'].includes(key)) {
        throw invalid(path, `has a field "${key}" that a node does not have`);
      }
    }

    const id = value['id'];
    if (typeof id !== 'string' || !NODE_ID.test(id)) {
      throw invalid(`${path}.id`, NODE_ID_MESSAGE);
    }
    if (seen.has(id)) throw invalid(`${path}.id`, `"${id}" is already used by another node`);
    seen.add(id);

    const rawName = value['name'];
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length === 0 || name.length > MAX_NODE_NAME) {
      throw invalid(`${path}.name`, `must be 1 to ${String(MAX_NODE_NAME)} characters`);
    }

    const rawRule = value['rule'];
    const rule =
      rawRule === undefined || rawRule === null ? null : readRule(rawRule, `${path}.rule`);

    const rawChildren = value['children'] ?? [];
    if (!Array.isArray(rawChildren)) throw invalid(`${path}.children`, 'must be a list');
    const children = rawChildren.map((child, index) =>
      readNode(child, `${path}.children[${String(index)}]`, depth + 1),
    );

    return { id, name, rule, children };
  };

  return raw.map((node, index) => readNode(node, `nodes[${String(index)}]`, 1));
}

/**
 * Refuses nodes nested deeper than `MAX_DEPTH`, without recursing (`L-06`).
 *
 * **Asked before the route's schema runs.** `ms:libraryNode` refers to itself, so the schema walks
 * a body one stack frame per level, and a body a few thousand levels deep ran out of stack before
 * `validateNodes` could say that six is the most — which answered 500. This walk keeps its own
 * stack and stops at the first node too deep, so it costs no more than the body limit allows and
 * answers as `validateNodes` would, at the same path.
 *
 * Everything that is not the shape of a node is left alone: saying what is wrong with it is the
 * schema's job, and this runs so that the schema can.
 */
export function refuseTooDeep(raw: unknown): void {
  if (!Array.isArray(raw)) return;
  // Reversed onto the stack, so nodes come off it in document order and the one named is the
  // first too-deep node a reader would reach.
  const pending: { value: unknown; path: string; depth: number }[] = [];
  const push = (values: readonly unknown[], at: (index: number) => string, depth: number): void => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      pending.push({ value: values[index], path: at(index), depth });
    }
  };
  push(raw, (index) => `nodes[${String(index)}]`, 1);

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.depth > MAX_DEPTH) {
      throw invalid(node.path, `a library is at most ${String(MAX_DEPTH)} levels deep`);
    }
    const children = isRecord(node.value) ? node.value['children'] : undefined;
    if (!Array.isArray(children)) continue;
    const parent = node;
    push(children, (index) => `${parent.path}.children[${String(index)}]`, parent.depth + 1);
  }
}

function readRule(value: unknown, path: string): NodeRule {
  if (!isRecord(value)) throw invalid(path, 'must be an object or null');
  for (const key of Object.keys(value)) {
    if (!['roots', 'types', 'tags', 'states'].includes(key)) {
      throw invalid(path, `has a field "${key}" that a rule does not have`);
    }
  }

  const roots = list(value['roots'], `${path}.roots`, MAX_ROOTS, (item, at) => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
      throw invalid(at, 'must be an object id, a positive whole number');
    }
    return item;
  });
  const types = list(value['types'], `${path}.types`, MAX_TYPES, (item, at) => {
    if (typeof item !== 'string' || !SENSOR_TYPE_ID.test(item)) {
      throw invalid(at, 'must be a sensor type id, lowercase and dotted, e.g. "snmp.traffic"');
    }
    return item;
  });
  const tags = list(
    value['tags'],
    `${path}.tags`,
    MAX_TAGS,
    (item, at) => {
      if (typeof item !== 'string' || item.length === 0 || item.length > MAX_TAG) {
        throw invalid(at, `must be a tag of 1 to ${String(MAX_TAG)} characters`);
      }
      return item;
    },
    // Folded, because that is how a tag is compared: "Berlin" and "berlin" are one tag listed
    // twice, and a rule that seemed to ask for both would be asking for one.
    (item) => item.toLowerCase(),
  );
  const states = list(value['states'], `${path}.states`, SENSOR_STATES.length, (item, at) => {
    if (typeof item !== 'string' || !(SENSOR_STATES as readonly string[]).includes(item)) {
      throw invalid(at, `must be one of ${SENSOR_STATES.join(', ')}`);
    }
    return item as SensorState;
  });

  return { roots, types, tags, states };
}

/** A list field: absent is empty, bounded, each item read, and nothing listed twice. */
function list<T>(
  value: unknown,
  path: string,
  max: number,
  read: (item: unknown, at: string) => T,
  sameAs: (item: T) => unknown = (item) => item,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(path, 'must be a list');
  if (value.length > max) throw invalid(path, `may list at most ${String(max)}`);
  const seen = new Set<unknown>();
  return value.map((item, index) => {
    const at = `${path}[${String(index)}]`;
    const read_ = read(item, at);
    const key = sameAs(read_);
    if (seen.has(key)) throw invalid(at, 'is listed twice');
    seen.add(key);
    return read_;
  });
}

function invalid(path: string, problem: string): LibraryError {
  return new LibraryError('LIBRARY_INVALID', `${path} ${problem}`, {
    context: { phase: 'validate' },
    details: { field: 'nodes', path },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How many nodes a document holds, at every level. */
export function countNodes(nodes: readonly LibraryNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/**
 * The nodes as the audit log records them: one line per node, its path and what it shows.
 *
 * A person reads the diff, so the line is the one they would say aloud — "Customer A › Routers:
 * types snmp.traffic; states down" — rather than the stored document. Paths rather than ids
 * because that is how an editor knows a node; the id is in the document for whoever needs it.
 */
export function describeNodes(nodes: readonly LibraryNode[]): string {
  const lines: string[] = [];
  const walk = (level: readonly LibraryNode[], trail: readonly string[]): void => {
    for (const node of level) {
      const path = [...trail, node.name];
      lines.push(
        node.rule === null ? path.join(' › ') : `${path.join(' › ')}: ${describeRule(node.rule)}`,
      );
      walk(node.children, path);
    }
  };
  walk(nodes, []);
  return lines.join('\n');
}

function describeRule(rule: NodeRule): string {
  const parts = [
    rule.roots.length === 0 ? '' : `under ${rule.roots.map((id) => `#${String(id)}`).join(', ')}`,
    rule.types.length === 0 ? '' : `types ${rule.types.join(', ')}`,
    rule.tags.length === 0 ? '' : `tags ${rule.tags.join(', ')}`,
    rule.states.length === 0 ? '' : `states ${rule.states.join(', ')}`,
  ].filter((part) => part !== '');
  // An empty rule is not a heading: it asks for every sensor the viewer can read, and the log
  // should say that rather than show a node that seems to ask for nothing.
  return parts.length === 0 ? 'every sensor' : parts.join('; ');
}
