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
  'host',
  'ipVersion',
  'sensorType',
] as const;

/**
 * Field-level changes between two versions of an object.
 *
 * `params` is handled separately and by key only — see `changedParamKeys`.
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
 * `sensor_config.params` is the one field on an object that can hold a secret today: until
 * `P-05` lands `writeOnly` redaction, an operator who pastes an SNMP community into a parameter
 * has put a credential there. The API already returns those verbatim, which is bad enough; a
 * long-lived audit table with its own retention would take a present-tense exposure and make it
 * permanent, and redacting later cannot unwrite history. So the audit records *that* a
 * parameter changed, which is the auditable fact, and `P-05` can add the values once it knows
 * which ones are safe to show.
 */
export function changedParamKeys(before: ObjectDetail, after: ObjectDetail): string[] {
  const b = before.kind === 'sensor' ? before.params : {};
  const a = after.kind === 'sensor' ? after.params : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((key) => !same(b[key], a[key])).sort();
}

function snapshot(object: ObjectDetail): FieldChange[] {
  const source = object as unknown as Record<string, unknown>;
  const changes: FieldChange[] = [];
  for (const field of TRACKED) {
    if (!(field in source)) continue;
    changes.push({ field, before: null, after: source[field] ?? null });
  }
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
