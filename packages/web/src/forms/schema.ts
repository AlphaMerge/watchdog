import type { PATTERN_MESSAGE } from '@ms/shared/pattern-message';

/**
 * The JSON Schema subset a sensor type's `paramsSchema` may use, as this form reads it.
 *
 * Deliberately structural and permissive: anything the catalogue accepts at registration can
 * arrive here, and a field this cannot render is shown as raw JSON rather than dropped. Dropping
 * would silently delete a parameter on the next save.
 */
export interface JsonSchema {
  readonly type?: string | string[];
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly writeOnly?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  /**
   * Fixed once the sensor exists (`U-34`): shown read-only when editing one, open when adding.
   * The sensor catalogue documents it (`CREATE_ONLY`) and refuses one this form could not honour.
   */
  readonly 'x-createOnly'?: boolean;
  /**
   * On an array's entry schema: the property that says which existing entry this is (`U-34`), so
   * a fixed field is matched to what the sensor has by what the entry *is*, not where it sits.
   */
  readonly 'x-entryKey'?: string;
  /**
   * What a value `pattern` refuses is told, in words (`U-53`): shown in place of the expression,
   * as the core's 400 shows it. The catalogue refuses a pattern without one. The key is
   * `@ms/shared`'s own (`P-379`), from the subpath that imports nothing.
   */
  readonly [PATTERN_MESSAGE]?: string;
}

/** What kind of control a property gets. `json` is the honest fallback, never a silent drop. */
export type FieldKind =
  'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'object' | 'array' | 'json';

export interface FieldModel {
  /** Dotted path from the root of `params`, which is also the key the API expects. */
  readonly path: string;
  readonly name: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly kind: FieldKind;
  readonly schema: JsonSchema;
  readonly required: boolean;
  /** A credential. Never populated from a read, and omitted from a save unless it was replaced. */
  readonly writeOnly: boolean;
  /** Fixed once the sensor exists (`U-34`). What that means for a control is `fixedState`'s. */
  readonly createOnly: boolean;
  /**
   * One entry of an array of scalars, at its own path (`U-41`): `scalarEntryOf` builds it.
   *
   * Such an entry is never absent — only its array's Remove takes it out — so a control cleared
   * empty holds `''` rather than being removed, and a string entry's `''` is a value its schema
   * judges (`minLength`), not a missing one.
   */
  readonly entry: boolean;
  /** Set for `kind: 'object'`. */
  readonly children: readonly FieldModel[];
  /**
   * What one entry of an array looks like. Set for `kind: 'array'` and nothing else.
   *
   * The schema rather than a `FieldModel`, because an entry's path depends on where it ends up:
   * `steps.0.method` and `steps.3.method` are the same declaration at two positions, and a model
   * built once would have to carry a path that is wrong for every entry but one.
   */
  readonly items: JsonSchema | undefined;
}

function typeOf(schema: JsonSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  // A union like `['string', 'null']` — the nullable form. The first non-null entry is what a
  // control is built for; null is expressed by leaving the field empty.
  if (Array.isArray(schema.type)) return schema.type.find((entry) => entry !== 'null');
  return undefined;
}

function kindOf(schema: JsonSchema): FieldKind {
  if (schema.enum !== undefined && schema.enum.length > 0) return 'enum';
  switch (typeOf(schema)) {
    case 'string':
      return 'string';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      // Only when it declares what is in it. A free-form object is a JSON blob and is shown as
      // one, because a form with no fields to draw is not a form.
      return schema.properties === undefined ? 'json' : 'object';
    case 'array':
      // Same rule, one level down (`U-12`): an array whose entries are undescribed is a JSON
      // blob, because "add an entry" has nothing to add. `snmp.table.columns`,
      // `http.transaction.steps` and `rest.custom.extract` all describe theirs.
      return schema.items === undefined ? 'json' : 'array';
    default:
      return 'json';
  }
}

/**
 * A readable label from a `camelCase` or `snake_case` key, for a property with no `title`.
 *
 * Sentence case, not Title Case, because that is what the rest of this UI uses — "Response
 * time", "Sensor type" — and a generated label that shouted "Packet Size" beside a declared one
 * reading "Payload size" would make the generated ones look like a different product.
 *
 * A type author who wants something else sets `title`, which always wins.
 */
export function labelFor(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, (_match, before: string, after: string) => {
      return `${before} ${after.toLowerCase()}`;
    })
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The fields a schema describes, in declaration order.
 *
 * **Declaration order, not alphabetical.** A sensor type's author put the important parameter
 * first, and sorting would throw that away — the form is theirs to lay out, which is the whole
 * point of generating it from their schema.
 */
export function fieldsOf(schema: JsonSchema, prefix = ''): FieldModel[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  return Object.entries(properties).map(([name, property]) => {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    const kind = kindOf(property);
    return {
      path,
      name,
      label: property.title ?? labelFor(name),
      description: property.description,
      kind,
      schema: property,
      required: required.has(name),
      writeOnly: property.writeOnly === true,
      createOnly: property['x-createOnly'] === true,
      entry: false,
      children: kind === 'object' ? fieldsOf(property, path) : [],
      items: kind === 'array' ? property.items : undefined,
    };
  });
}

/**
 * Whether an array's entries are scalars, each one control at the entry's own path, rather than
 * objects whose properties are laid out (`U-12`).
 */
export function hasScalarEntries(items: JsonSchema): boolean {
  return fieldsOf(items).length === 0;
}

/**
 * The field one entry of an array of scalars is (`U-12`, `U-41`): a list of strings is as
 * legitimate a repeating parameter as a list of objects, and its entry has no property to lay out.
 *
 * One builder for the control and for the check before submit, so the two cannot disagree about
 * what an entry is. Required, because an entry cannot be absent; no key to tell a stored entry
 * from a new one, so never fixed (`U-34`).
 */
export function scalarEntryOf(items: JsonSchema, array: FieldModel, index: number): FieldModel {
  const kind = kindOf(items);
  return {
    path: `${array.path}.${String(index)}`,
    name: String(index),
    label: `${items.title ?? array.label} ${String(index + 1)}`,
    description: undefined,
    kind,
    schema: items,
    required: true,
    writeOnly: items.writeOnly === true,
    createOnly: false,
    entry: true,
    children: [],
    items: kind === 'array' ? items.items : undefined,
  };
}

/**
 * Whether a string field holds more than one line (`U-21`).
 *
 * Asked of a secret, where it decides the control: a single-line input drops the line breaks out
 * of whatever is pasted into it, and an SSH private key without its line breaks is not a key. No
 * schema keyword says "multi-line", so the length it allows stands in for one: nothing that fits
 * on a line is declared with room for four thousand characters.
 */
export function isMultiline(schema: JsonSchema): boolean {
  return schema.maxLength !== undefined && schema.maxLength > MULTILINE_ABOVE;
}

const MULTILINE_ABOVE = 4_096;

/**
 * The value a field starts at when nothing is stored.
 *
 * The schema's own `default` where it has one, because the core applies and *stores* defaults at
 * validation time — a form that started somewhere else would show one number and save another.
 */
export function defaultFor(field: FieldModel): unknown {
  if (field.schema.default !== undefined) return field.schema.default;
  if (field.kind === 'boolean') return false;
  if (field.kind === 'enum') return field.schema.enum?.[0];
  // **Not `[]` for an array with no declared default.** An absent optional array and an empty one
  // are different things to the schema — `minItems: 1` refuses the second and says nothing about
  // the first — and seeding one would make every form save a parameter nobody set.
  return undefined;
}

/**
 * A new entry for an array field, pre-filled from its item schema's own defaults (`U-12`).
 *
 * The same rule the whole form follows: the core applies and *stores* defaults at validation
 * time, so an entry that started somewhere else would show one thing and save another. An entry
 * whose schema declares nothing is an empty object, which is what "add a row" should give you.
 */
export function newEntryFor(items: JsonSchema): unknown {
  if (items.default !== undefined) return items.default;
  if (items.properties !== undefined) return seedDefaults(items);
  const kind = kindOf(items);
  if (kind === 'boolean') return false;
  if (kind === 'enum') return items.enum?.[0] ?? '';
  if (kind === 'integer' || kind === 'number') return 0;
  // A free-form container starts as that container rather than as a string. It renders as a JSON
  // box either way, and a box that opened on `""` for something declared an object would make
  // the operator's first action deleting what the form put there.
  if (typeOf(items) === 'object') return {};
  if (typeOf(items) === 'array') return [];
  return '';
}

/**
 * A whole document pre-filled from the defaults a schema declares.
 *
 * **One function, because there are three forms.** Sensor parameters (`U-08`), notification
 * method settings and trigger-kind settings (`U-10`) all seed the same way, and three copies of
 * the loop meant three chances to walk only the top level — which all three of them did, so a
 * default nested inside an object property was declared, rendered as an empty control, and never
 * saved. `fieldsOf` returns a tree; this walks it.
 *
 * **Never a credential.** A `writeOnly` field with a declared default would otherwise be seeded
 * with that default and written, which invents a secret nobody typed. The field starts empty and
 * the core applies its own default if it has one.
 */
export function seedDefaults(schema: JsonSchema): Record<string, unknown> {
  let seeded: Record<string, unknown> = {};
  const visit = (fields: readonly FieldModel[]): void => {
    for (const field of fields) {
      if (field.writeOnly) continue;
      if (field.kind === 'object') {
        visit(field.children);
        continue;
      }
      // An array's *entries* have defaults; the array does not have entries yet. Descending here
      // would seed `steps.0.method` into a document with no `steps`.
      const value = defaultFor(field);
      if (value !== undefined) seeded = writeAt(seeded, field.path, value);
    }
  };
  visit(fieldsOf(schema));
  return seeded;
}

/**
 * Whether a path segment addresses an array position rather than a property.
 *
 * A digit string and nothing else. A property genuinely called `0` would be indistinguishable —
 * which is why this is only ever asked about paths *this form produced*, where an index segment
 * comes from an array field and a property name comes from a schema's `properties`.
 */
function isIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/** Reads a dotted path out of a params object, descending through arrays by index (`U-12`). */
export function readAt(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      if (!isIndex(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Writes a dotted path, creating the containers on the way.
 *
 * **The container's shape comes from the *next* segment, not from this one** (`U-12`). Writing
 * `steps.0.method` into an empty document has to produce `{steps: [{method: …}]}`, and a walk
 * that always created objects would produce `{steps: {"0": {method: …}}}` — which serialises to
 * JSON that looks almost right, validates as the wrong type, and is refused by the server with a
 * message about `steps` rather than about the form.
 *
 * **An array position it cannot write is refused, and the document handed back unchanged** (`U-42`)
 * — the same object, as `removeAt` does with what it does not remove. That is an index past the
 * end, which used to be written there with empty slots before it: a hole serialises as `null`,
 * which the core refuses with a message about the parameter rather than the form. Appending it
 * instead would put the value somewhere the path does not say, so reading the path back would not
 * find it. The form never asks for one (`U-39` checked): an entry's controls exist only for
 * entries the array holds, and Add appends, so every index it writes is one the array has or the
 * next one — which is still written, and is how an entry is appended.
 *
 * **So is a container of the other shape** (`U-43`): a property name where an array is
 * (`tags.x`), or an index where an object is (`auth.0`). Taking the container's shape from the
 * path there would replace the array or the object with a fresh one, and every entry or key it
 * held would go with it, for one value written somewhere the schema does not have. The form never
 * writes such a path. What is not a container — a string, a number, `null`, nothing — holds no
 * entries to lose, and is still replaced with the container the path needs ("wrong shape": a
 * parameter whose type's schema changed under a stored value).
 */
export function writeAt(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.');
  const next = { ...target };
  let cursor: Record<string, unknown> | unknown[] = next;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const lookahead = segments[index + 1];
    if (segment === undefined || lookahead === undefined) break;
    if (!writable(cursor, segment)) return target;
    const child = readChild(cursor, segment);
    const wantArray = isIndex(lookahead);
    if (isContainer(child) && Array.isArray(child) !== wantArray) return target;
    const copy = copyContainer(child, wantArray);
    writeChild(cursor, segment, copy);
    cursor = copy;
  }

  const last = segments[segments.length - 1];
  if (last === undefined || !writable(cursor, last)) return target;
  writeChild(cursor, last, value);
  return next;
}

type Container = Record<string, unknown> | unknown[];

/**
 * An object takes any key; an array, a position it has or the next one (`U-42`).
 *
 * The walk only ever stands in an array when this segment is an index — it chose the container's
 * shape from it, one step back — so the position is all there is to check.
 */
function writable(container: Container, segment: string): boolean {
  return !Array.isArray(container) || Number(segment) <= container.length;
}

function readChild(container: Container, segment: string): unknown {
  return Array.isArray(container) ? container[Number(segment)] : container[segment];
}

function writeChild(container: Container, segment: string, value: unknown): void {
  if (Array.isArray(container)) container[Number(segment)] = value;
  else container[segment] = value;
}

/**
 * A copy of what is there, or a fresh container of the shape the path needs where nothing that
 * holds anything is (`writeAt` has already refused a container of the other shape, `U-43`).
 */
function copyContainer(child: unknown, wantArray: boolean): Container {
  if (wantArray) return Array.isArray(child) ? [...(child as unknown[])] : [];
  return typeof child === 'object' && child !== null && !Array.isArray(child)
    ? { ...(child as Record<string, unknown>) }
    : {};
}

/**
 * Removes a dotted path, and any object it leaves empty above it — through arrays too (`U-39`).
 *
 * **Through an array, by index, and the entry stays.** `columns.0.mode` is how an optional field
 * inside an entry is set back to "—", and the walk used to stop at the array and hand the document
 * back unchanged, so the choice was ignored without a word. Now the entry is copied without the
 * key and put back at its own position: the array stays an array, the same length, with no hole
 * where an entry was; and an entry left with nothing in it is still an entry, because it is one
 * of the operator's rows, not an empty branch the schema never asked for. Objects above and inside
 * an entry are pruned as before.
 *
 * **Never an entry itself.** A path whose last segment is a position names a whole entry, and an
 * entry is taken out by its array's own Remove (`ArrayField`), which says which one it removed.
 * Splicing here would delete an entry from under a control being cleared and shift every one after
 * it; deleting the slot would leave a hole that serialises as `null`. So that, an index past the
 * end, a property name where an array is, and a path through something that is not a container all
 * remove nothing — and nothing removed hands back the very object it was given.
 *
 * `Reflect.deleteProperty` rather than `delete next[head]`: the key is data, and the lint rule
 * against dynamic delete exists to catch objects being used as maps, which is exactly what
 * `params` is — the same reasoning the catalogue's own `deleteAtPath` records.
 */
export function removeAt(target: Record<string, unknown>, path: string): Record<string, unknown> {
  const removed = removeFrom(target, path.split('.'));
  return isRecord(removed) ? removed : target;
}

/** What `container` becomes without the path, or `undefined` when there was nothing to remove. */
function removeFrom(container: Container, segments: readonly string[]): Container | undefined {
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;

  if (Array.isArray(container)) {
    if (rest.length === 0 || !isIndex(head)) return undefined;
    const at = Number(head);
    // Past the end, or a hole, reads `undefined`, which is not a container: nothing to remove.
    const entry: unknown = container[at];
    if (!isContainer(entry)) return undefined;
    const pruned = removeFrom(entry, rest);
    if (pruned === undefined) return undefined;
    const next = [...container];
    next[at] = pruned;
    return next;
  }

  if (!Object.hasOwn(container, head)) return undefined;
  const next = { ...container };
  if (rest.length === 0) {
    Reflect.deleteProperty(next, head);
    return next;
  }
  const child = container[head];
  if (!isContainer(child)) return undefined;
  const pruned = removeFrom(child, rest);
  if (pruned === undefined) return undefined;
  // An object left with nothing in it is not the same as an object with an empty child; the
  // schema asked for neither, so the branch goes too. An array is never emptied here — the walk
  // does not take entries out — so only an object can be left empty.
  if (isRecord(pruned) && Object.keys(pruned).length === 0) Reflect.deleteProperty(next, head);
  else next[head] = pruned;
  return next;
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

/**
 * `paths` after the entries of the array at `array` were rearranged (`U-49`): `order[j]` is the
 * position the entry now at `j` held before, so a Move swaps two positions and a Remove leaves
 * one out.
 *
 * **A path into an entry goes with the entry.** The form keeps what it knows about a control —
 * that the operator has left it — by path, and a path carries its entry's position, so without
 * this a Move left that knowledge with the position: the moved entry said nothing until it was
 * left again, and its neighbour, never touched, inherited it. A path into an entry no longer in
 * `order` is dropped, so it cannot attach to the entry that takes its place; every path outside
 * the array is kept as it is. Paths inside a nested array come along with their outer entry.
 */
export function movedPaths(
  paths: ReadonlySet<string>,
  array: string,
  order: readonly number[],
): ReadonlySet<string> {
  const moved = pathMover(array, order);
  const next = new Set<string>();
  for (const path of paths) {
    const at = moved(path);
    if (at !== undefined) next.add(at);
  }
  return next;
}

/**
 * `movedPaths` for one path at a time: where `path` is after the rearrangement, or `undefined`
 * when it was inside an entry that is gone. For what is kept by path beside other things — a
 * server problem carries its message (`U-50`) — so the rule is written once.
 */
export function pathMover(
  array: string,
  order: readonly number[],
): (path: string) => string | undefined {
  const prefix = `${array}.`;
  const now = new Map(order.map((was, at) => [was, at]));
  return (path) => {
    if (!path.startsWith(prefix)) return path;
    const rest = path.slice(prefix.length);
    const dot = rest.indexOf('.');
    const head = dot === -1 ? rest : rest.slice(0, dot);
    // Not an entry's position: not a path this rearrangement says anything about.
    if (!isIndex(head)) return path;
    const at = now.get(Number(head));
    return at === undefined
      ? undefined
      : `${prefix}${String(at)}${dot === -1 ? '' : rest.slice(dot)}`;
  };
}

// ---------------------------------------------------------------------------------------------
// Fixed once the sensor exists (`U-34`).
// ---------------------------------------------------------------------------------------------

/**
 * What the sensor already has, at the level of the object a field sits in: the stored parameters
 * at the top, a stored object one level down, the stored entry an array entry *is* inside an
 * array. `undefined` means nothing exists there yet — a sensor being added, or an entry this edit
 * added — and a fixed field there may take any value.
 */
export type Existing = Readonly<Record<string, unknown>> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What exists inside an object field, given what exists around it.
 *
 * An object the stored parameters leave out still exists when its parent does: the core stores
 * defaults, so an absent child is one whose every value is its default, not one being added.
 */
export function existingWithin(existing: Existing, name: string): Existing {
  if (existing === undefined) return undefined;
  const child = existing[name];
  return isRecord(child) ? child : {};
}

/**
 * The stored entry an array entry is, matched by the entry schema's `x-entryKey` (`U-34`).
 *
 * **By what the entry is, never by where it sits.** Entries reorder, and a column added above
 * the others moves every one of them, so "the stored entry at this index" would lock the wrong
 * column's mode after the first move and leave the right one open. An entry whose key matches
 * nothing stored is new to this edit; so is every entry of an array whose schema names no key,
 * which the catalogue refuses for any entry that holds a fixed field.
 */
export function existingEntry(items: JsonSchema, entry: unknown, storedEntries: unknown): Existing {
  const key = items['x-entryKey'];
  if (key === undefined || !isRecord(entry) || !Array.isArray(storedEntries)) return undefined;
  const identity = entry[key];
  if (identity === undefined) return undefined;
  return (storedEntries as unknown[]).filter(isRecord).find((stored) => stored[key] === identity);
}

/**
 * Why a field marked `x-createOnly` is read-only on an existing sensor (`U-34`).
 *
 * One sentence for every such field, because the reason is the same one: the core refuses the
 * change (`P-303`), and the way to the other value is another sensor. The type's own description,
 * shown above it, says what the field means and why it is fixed for that type.
 */
export const FIXED_REASON = 'Fixed once the sensor exists; add a new sensor to change it.';

/** The same, for a `changed` field: what is stored, so the operator can put it back. */
export function fixedChangedReason(stored: unknown): string {
  const shown = typeof stored === 'string' ? stored : JSON.stringify(stored);
  return (
    `Fixed once the sensor exists, where it is “${shown}”: saving another value is refused. ` +
    'Put it back, or add a new sensor to change it.'
  );
}

/**
 * Whether a fixed field can be changed here.
 *
 * - `open`: not fixed, or nothing exists here yet. The ordinary control.
 * - `locked`: it exists and holds what is stored. Read-only, with the reason.
 * - `changed`: it exists, and what the form holds is not what is stored. Only reachable inside an
 *   array — an entry's key edited to name a column the sensor has with the other mode — and left
 *   editable, saying what is stored, so the operator can put it back. Locking it would freeze a
 *   value the core refuses, with no control to undo it but retyping the key.
 *
 * Absent is the schema's default on both sides, as the core stores it. So `locked` carries the
 * value it compared, which is what the read-only box shows: a field the form holds as absent (an
 * optional select's "—") is locked at the default, and showing the form's `undefined` instead would
 * be an empty box announced as nothing.
 */
export type FixedState =
  | { readonly kind: 'open' }
  | { readonly kind: 'locked'; readonly value: unknown }
  | { readonly kind: 'changed'; readonly stored: unknown };

export function fixedState(field: FieldModel, existing: Existing, value: unknown): FixedState {
  if (!field.createOnly || existing === undefined) return { kind: 'open' };
  const fallback = defaultFor(field);
  const stored = existing[field.name] ?? fallback;
  const held = value ?? fallback;
  return JSON.stringify(held) === JSON.stringify(stored)
    ? { kind: 'locked', value: held }
    : { kind: 'changed', stored };
}
