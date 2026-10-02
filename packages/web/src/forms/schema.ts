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
      children: kind === 'object' ? fieldsOf(property, path) : [],
      items: kind === 'array' ? property.items : undefined,
    };
  });
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
    const child = readChild(cursor, segment);
    const copy = copyContainer(child, isIndex(lookahead));
    writeChild(cursor, segment, copy);
    cursor = copy;
  }

  const last = segments[segments.length - 1];
  if (last !== undefined) writeChild(cursor, last, value);
  return next;
}

type Container = Record<string, unknown> | unknown[];

function readChild(container: Container, segment: string): unknown {
  return Array.isArray(container) ? container[Number(segment)] : container[segment];
}

function writeChild(container: Container, segment: string, value: unknown): void {
  if (Array.isArray(container)) container[Number(segment)] = value;
  else container[segment] = value;
}

/** A copy of what is there, or a fresh container of the shape the path needs. */
function copyContainer(child: unknown, wantArray: boolean): Container {
  if (wantArray) return Array.isArray(child) ? [...(child as unknown[])] : [];
  return typeof child === 'object' && child !== null && !Array.isArray(child)
    ? { ...(child as Record<string, unknown>) }
    : {};
}

/**
 * Removes a dotted path, and any object it leaves empty above it.
 *
 * `Reflect.deleteProperty` rather than `delete next[head]`: the key is data, and the lint rule
 * against dynamic delete exists to catch objects being used as maps, which is exactly what
 * `params` is — the same reasoning the catalogue's own `deleteAtPath` records.
 */
export function removeAt(target: Record<string, unknown>, path: string): Record<string, unknown> {
  const segments = path.split('.');
  const head = segments[0];
  if (head === undefined) return target;
  const next = { ...target };
  if (segments.length === 1) {
    Reflect.deleteProperty(next, head);
    return next;
  }
  const child = next[head];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return next;
  const pruned = removeAt(child as Record<string, unknown>, segments.slice(1).join('.'));
  // An object left with nothing in it is not the same as an object with an empty child; the
  // schema asked for neither, so the branch goes too.
  if (Object.keys(pruned).length === 0) Reflect.deleteProperty(next, head);
  else next[head] = pruned;
  return next;
}
