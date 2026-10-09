/**
 * What a value refused by its `pattern` is told (`U-53`): `'x-patternMessage'` beside the
 * `pattern`, saying in words what the value must be — *must be a numeric OID, such as
 * 1.3.6.1.2.1.1.3.0*. Written to follow the field's name, as Ajv's other messages do.
 *
 * **The expression is not a message.** Shown as one, `^(?!(?:value|rows)$)[A-Za-z0-9_.-]+$`
 * tells its reader nothing they can act on. So every Ajv that says a refusal to a person says
 * this sentence in its place: the sensor catalogue, the core's 400, the form, the core's
 * registries, and the probe protocol's reasons in a log (`P-376`). Each refuses a `pattern`
 * without one, and one of these without a `pattern`, with `unsaidPatterns`.
 *
 * Here rather than in `@ms/sensors` (where `U-53` put it) because the protocol's schemas live in
 * this package, which `@ms/sensors` depends on and not the other way round (`P-376`).
 */
export const PATTERN_MESSAGE = 'x-patternMessage';

/**
 * The keyword as Ajv is told of it: an annotation, a non-empty string, which constrains no value.
 * Declared so that strict mode admits it, and so that one of the wrong type is refused when the
 * schema compiles, whether strict mode is on or not.
 *
 * **A new object for each Ajv**: `addKeyword` writes the compiled meta-schema back onto the
 * definition it is given (`validateSchema`), so one object shared by several would carry
 * whichever compiled it last. A plain shape rather than Ajv's `KeywordDefinition`, so it is
 * assignable to that type in every package that has its own copy of Ajv.
 */
export function patternMessageKeyword(): {
  readonly keyword: typeof PATTERN_MESSAGE;
  readonly metaSchema: { readonly type: 'string'; readonly minLength: 1 };
} {
  return { keyword: PATTERN_MESSAGE, metaSchema: { type: 'string', minLength: 1 } };
}

/**
 * The `x-patternMessage` a failed `pattern` says, or undefined for any other error or a schema
 * without one (`U-53`).
 *
 * Read from the error's `parentSchema`, which Ajv puts there only with `verbose: true`, and
 * **only from the schema**: `verbose` also puts the refused value on the error as `data`, and
 * nothing here reads it. A caller that turns `verbose` on copies out only the fields it means to
 * say, never `data`.
 */
export function patternMessageOf(error: {
  readonly keyword: string;
  readonly parentSchema?: unknown;
}): string | undefined {
  if (error.keyword !== 'pattern') return undefined;
  const parent = error.parentSchema;
  if (typeof parent !== 'object' || parent === null) return undefined;
  const said: unknown = (parent as Record<string, unknown>)[PATTERN_MESSAGE];
  return typeof said === 'string' && said.trim() !== '' ? said : undefined;
}

/** A `pattern` that would say its expression, or an `x-patternMessage` nothing would say. */
export interface UnsaidPattern {
  /** Dotted, `''` for the schema itself, `*` for an array's entries, and a keyword by name. */
  readonly path: string;
  /** `unsaid`: a pattern with no (or a blank) message. `orphan`: a message with no pattern. */
  readonly fault: 'unsaid' | 'orphan';
}

/** Subschema keywords holding one schema, or a list of them. `items` is walked as `*`. */
const SUBSCHEMAS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
  'contains',
] as const;

/** Subschema keywords holding a map of schemas by name (`properties` is walked by its key). */
const SUBSCHEMA_MAPS = [
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
] as const;

/**
 * Every `pattern` that does not say in words what it wants (`U-53`), and every `x-patternMessage`
 * with no `pattern` beside it to explain, in the order a depth-first walk meets them.
 *
 * **Everywhere a schema can sit**, not only where a form draws a field: a refusal from any of
 * them is said, so a pattern under `additionalProperties` or a `oneOf` branch would show its
 * expression just the same. A `$ref` is not followed; a caller walks the schema it names as a
 * schema of its own.
 */
export function unsaidPatterns(schema: unknown): UnsaidPattern[] {
  const found: UnsaidPattern[] = [];
  walk(schema, '');
  return found;

  function walk(node: unknown, path: string): void {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const said = record[PATTERN_MESSAGE];
    if (record['pattern'] !== undefined && (typeof said !== 'string' || said.trim() === '')) {
      found.push({ path, fault: 'unsaid' });
    }
    if (said !== undefined && record['pattern'] === undefined) {
      found.push({ path, fault: 'orphan' });
    }

    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`);
      }
    }
    const items = record['items'];
    for (const child of Array.isArray(items) ? items : [items]) walk(child, `${path}.*`);
    for (const keyword of SUBSCHEMAS) {
      const branch = record[keyword];
      for (const child of Array.isArray(branch) ? branch : [branch]) {
        walk(child, `${path}.${keyword}`);
      }
    }
    for (const keyword of SUBSCHEMA_MAPS) {
      const map = record[keyword];
      if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
      for (const [key, child] of Object.entries(map as Record<string, unknown>)) {
        walk(child, `${path}.${keyword}.${key}`);
      }
    }
  }
}

/**
 * Why a registry must refuse this schema at load (`P-377`), or undefined when every pattern in it
 * says a sentence and every sentence has a pattern: the first `unsaidPatterns` finds, in the
 * words `MethodRegistry` has used since `P-372`. `owner` names what gave the schema (`method
 * webhook`); `whole` is said when the fault is on the schema itself (`its settings`).
 */
export function unsaidPatternProblem(
  schema: unknown,
  owner: string,
  whole: string,
): string | undefined {
  const [first] = unsaidPatterns(schema);
  if (first === undefined) return undefined;
  const where = first.path === '' ? whole : `"${first.path}"`;
  return first.fault === 'unsaid'
    ? `${owner} gives ${where} a pattern without ${PATTERN_MESSAGE}`
    : `${owner} gives ${where} ${PATTERN_MESSAGE} without a pattern`;
}
