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
}

/** What kind of control a property gets. `json` is the honest fallback, never a silent drop. */
export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'object' | 'json';

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
    };
  });
}

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
  return undefined;
}

/** Reads a dotted path out of a params object. */
export function readAt(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Writes a dotted path into a params object, creating the objects on the way. */
export function writeAt(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.');
  const next = { ...target };
  let cursor = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) break;
    const child = cursor[segment];
    const copy =
      typeof child === 'object' && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    cursor[segment] = copy;
    cursor = copy;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) cursor[last] = value;
  return next;
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
