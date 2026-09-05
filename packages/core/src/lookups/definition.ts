/**
 * What a lookup is (`M-06`).
 *
 * A lookup turns a number a device returned into a state and a phrase: SNMP interface status `2`
 * becomes "down" and Down, printer toner `3` becomes "OK" and Up. Without one, a sensor whose
 * only reading is a status code can be judged solely by limits — and "warn if the value is above
 * 1.5" is not a threshold anybody should have to write, nor one that survives the device adding
 * status code `7`.
 *
 * Pure data and pure functions. Loading them from files is `loader.ts`; holding them is
 * `catalogue.ts`.
 *
 * **Not PRTG's `.ovl` XML.** `CAPABILITIES.MD §15` puts PRTG config-file compatibility out of
 * scope, and every other boundary in this system is a JSON Schema. The concepts are PRTG's —
 * `SingleInt`, `Range`, `undefinedState`, custom definitions overriding built-ins by id — and
 * the encoding is ours.
 */

import type { RollupState } from '../state/tables.js';

/** `ms.snmp.if-oper-status`, `acme.ups.battery`. Same shape as a sensor type id. */
export const LOOKUP_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** One discrete value. */
export interface SingleIntEntry {
  readonly value: number;
  readonly state: RollupState;
  /** What the value means, in words. "Toner empty", not "1". */
  readonly text: string;
}

/**
 * One numeric band.
 *
 * `from` is inclusive and `to` is exclusive — the half-open interval, so adjacent bands neither
 * overlap nor leave a gap between them, and `0–50` followed by `50–80` means what it looks like.
 * Either bound may be absent, which is that side unbounded.
 */
export interface RangeEntry {
  readonly from?: number;
  readonly to?: number;
  readonly state: RollupState;
  readonly text: string;
}

interface LookupCommon {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /**
   * The state for a value no entry covers.
   *
   * Required, with no default, on purpose. A device returning an undocumented status code is
   * either fine or a problem, and which one it is depends entirely on the device — so the author
   * of the lookup has to say. A default here would be this system quietly deciding for them, and
   * whichever way it decided would be wrong for half the lookups in existence.
   */
  readonly undefinedState: RollupState;
}

export type LookupDefinition =
  | (LookupCommon & { readonly type: 'singleInt'; readonly entries: readonly SingleIntEntry[] })
  | (LookupCommon & { readonly type: 'range'; readonly entries: readonly RangeEntry[] });

/** What a value mapped to. */
export interface LookupMatch {
  readonly state: RollupState;
  /** The entry's text, or empty when nothing matched. */
  readonly text: string;
  /** False when no entry covered the value and `undefinedState` decided it. */
  readonly defined: boolean;
}

/**
 * Maps a reading through a lookup.
 *
 * Never throws and never returns nothing: every value has a state, because `undefinedState`
 * covers the ones no entry does. That totality is the point — a sensor whose device started
 * returning a status code nobody anticipated must still have a state, and it must be the one the
 * lookup's author chose rather than whatever the code happens to do.
 */
export function applyLookup(definition: LookupDefinition, value: number): LookupMatch {
  const undefinedMatch: LookupMatch = {
    state: definition.undefinedState,
    text: '',
    defined: false,
  };
  if (!Number.isFinite(value)) return undefinedMatch;

  if (definition.type === 'singleInt') {
    const entry = definition.entries.find((each) => each.value === value);
    return entry === undefined
      ? undefinedMatch
      : { state: entry.state, text: entry.text, defined: true };
  }

  for (const entry of definition.entries) {
    if (entry.from !== undefined && value < entry.from) continue;
    if (entry.to !== undefined && value >= entry.to) continue;
    return { state: entry.state, text: entry.text, defined: true };
  }
  return undefinedMatch;
}

/**
 * What is wrong with a definition, in words, or an empty list.
 *
 * The JSON Schema below checks the shape; these are the rules a schema cannot express. Both run
 * before anything is registered, because a lookup that is wrong is worse than one that is
 * missing: a missing lookup is reported, and a wrong one quietly gives a device the wrong state.
 */
export function validateLookup(definition: LookupDefinition): string[] {
  const problems: string[] = [];

  if (!LOOKUP_ID.test(definition.id)) {
    problems.push(
      `"${definition.id}" is not a usable lookup id; expected something like "ms.snmp.if-oper-status"`,
    );
  }
  if (definition.entries.length === 0) {
    problems.push('a lookup with no entries maps everything to its undefined state');
  }

  if (definition.type === 'singleInt') {
    const seen = new Set<number>();
    for (const entry of definition.entries) {
      // A missing `value` is refused by the schema now (`P-101`), which is where it belongs and
      // is the only place that can see it: this function's parameter type already promises the
      // field is there, so a check here is one the compiler calls unreachable and is wrong to.
      if (seen.has(entry.value)) {
        problems.push(`value ${String(entry.value)} is listed more than once`);
      }
      seen.add(entry.value);
    }
    return problems;
  }

  // Ranges: every entry must bound something, and no two may claim the same value — first match
  // would otherwise win silently, and which entry is "first" is an accident of authoring order.
  //
  // An entry with neither bound claims everything, and is refused by the schema (`P-101`).
  const bounded = definition.entries.map((entry, index) => ({
    index,
    from: entry.from ?? Number.NEGATIVE_INFINITY,
    to: entry.to ?? Number.POSITIVE_INFINITY,
  }));
  for (const entry of bounded) {
    if (entry.from >= entry.to) {
      problems.push(
        `range ${String(entry.index + 1)} is empty: from ${String(entry.from)} is not below ` +
          `to ${String(entry.to)}`,
      );
    }
  }
  const sorted = [...bounded].sort((a, b) => a.from - b.from);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (current.from < previous.to) {
      problems.push(
        `ranges ${String(previous.index + 1)} and ${String(current.index + 1)} overlap between ` +
          `${String(current.from)} and ${String(Math.min(previous.to, current.to))}`,
      );
    }
  }
  return problems;
}

/**
 * The shape, for the file loader and for anything that accepts a definition over the wire.
 *
 * **Discriminated on `type`, because the entry shapes are not interchangeable** (`P-101`). One
 * `items` schema used to serve both kinds with `value`, `from` and `to` all optional — so a
 * singleInt entry with a forgotten `"value"` and a range entry with neither bound were both
 * accepted. The first can never match, and the reading fell through to `undefinedState` while
 * the message told the operator the lookup "does not define" a code they can see in their own
 * file; the second matches everything and forced every reading to one state.
 *
 * `TypeScript` already said this — `SingleIntEntry.value` is required — and the schema did not,
 * which is the sort of disagreement that only shows up through the door the type cannot guard:
 * a file on disk. `CLAUDE.md` says validate at boundaries with JSON Schema, so the boundary is
 * where this belongs rather than in a hand-written check the compiler then calls unreachable.
 */
export const lookupDefinitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'type', 'undefinedState', 'entries'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 1000 },
    type: { enum: ['singleInt', 'range'] },
    undefinedState: { enum: ['up', 'warning', 'down'] },
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'text'],
        properties: {
          value: { type: 'number' },
          from: { type: 'number' },
          to: { type: 'number' },
          state: { enum: ['up', 'warning', 'down'] },
          text: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'singleInt' } }, required: ['type'] },
      // One integer per entry, so an entry without one can never match anything.
      then: { properties: { entries: { items: { required: ['state', 'text', 'value'] } } } },
    },
    {
      if: { properties: { type: { const: 'range' } }, required: ['type'] },
      // At least one bound. Open at one end is the ordinary case — "above 90 is critical" — so
      // this refuses only the entry that is open at *both*, which matches every reading.
      then: {
        properties: {
          entries: { items: { anyOf: [{ required: ['from'] }, { required: ['to'] }] } },
        },
      },
    },
  ],
} as const;
