import type { ObjectDetail } from '../objects/types.js';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Fields whose change is the edit someone made.
 *
 * Deliberately not here: `id` and `kind`, which cannot change; `parentId`, because a reparent is
 * `object.moved` and recording it twice would double every move in the history; and `version`,
 * `updatedAt`, `createdAt` and `childCount`, which are bookkeeping. A diff that says "version
 * 7 → 8" on every single edit teaches people to stop reading diffs.
 */
const TRACKED = [
  'name',
  'tags',
  'priority',
  'comments',
  // Who gets told about this subtree is exactly the sort of change somebody needs to be able to
  // find afterwards (`N-16`).
  'inheritsTriggers',
  'host',
  'ipVersion',
  'sensorType',
] as const;

/**
 * Field-level changes between two versions of an object, including sensor parameters by value.
 *
 * Values are safe here **only** because the object service redacts `writeOnly` parameters out
 * of both sides before the audit sink is ever handed them (P-05). Nothing in this file re-checks
 * that; the boundary is `ObjectService.#redact`, and it is deliberately the single one.
 */
export function diffObjects(before: ObjectDetail, after: ObjectDetail): FieldChange[] {
  const changes: FieldChange[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;

  for (const field of TRACKED) {
    if (!(field in b) && !(field in a)) continue;
    if (same(b[field], a[field])) continue;
    changes.push({ field, before: b[field] ?? null, after: a[field] ?? null });
  }
  changes.push(...paramChanges(paramsOf(before), paramsOf(after)));
  return changes;
}

/** The state an object was created in, as a diff from nothing. */
export function describeCreated(after: ObjectDetail): FieldChange[] {
  return snapshot(after).map((change) => ({ ...change, before: null }));
}

/** The state an object was in when it was destroyed. There is no recycle bin; this is the copy. */
export function describeDeleted(before: ObjectDetail): FieldChange[] {
  return snapshot(before).map((change) => ({
    field: change.field,
    before: change.after,
    after: null,
  }));
}

/**
 * Which sensor parameters changed — **the keys, never the values**.
 *
 * Call this on *unredacted* details, and only to build the key list. It is what makes a rotated
 * credential auditable: a `writeOnly` parameter redacts to the same absence before and after, so
 * a diff of what the sink can see would report no change at all.
 */
export function changedParamKeys(before: ObjectDetail, after: ObjectDetail): string[] {
  const b = paramsOf(before);
  const a = paramsOf(after);
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((key) => !same(b[key], a[key])).sort();
}

function paramsOf(object: ObjectDetail): Readonly<Record<string, unknown>> {
  return object.kind === 'sensor' ? object.params : {};
}

function paramChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((key) => !same(before[key], after[key]))
    .map((key) => ({
      field: `params.${key}`,
      before: before[key] ?? null,
      after: after[key] ?? null,
    }));
}

function snapshot(object: ObjectDetail): FieldChange[] {
  const source = object as unknown as Record<string, unknown>;
  const changes: FieldChange[] = [];
  for (const field of TRACKED) {
    if (!(field in source)) continue;
    changes.push({ field, before: null, after: source[field] ?? null });
  }
  changes.push(...paramChanges({}, paramsOf(object)));
  return changes;
}

/**
 * Structural equality by serialisation.
 *
 * Enough for what is compared here — strings, numbers, string arrays — and it treats `undefined`
 * and `null` alike, which matters because an absent optional and an explicit null mean the same
 * thing to an operator reading a history tab.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
