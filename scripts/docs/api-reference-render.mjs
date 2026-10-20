// Renders `docs/api-reference.md` from an OpenAPI document (H-07, P-318).
//
// Split from `api-reference.mjs` so that the rendering can be tested against a small fixture
// without building a server: `api-reference.mjs` builds the real document and checks or writes
// the file; this turns any document into the page, and works out from two routers' registrations
// which of its routes a release lacks (`H-51`), and nothing else.
//
// **Why it renders every level (`P-318`).** The first version listed a route's top-level fields
// only. `GET /probes` declared `skew.kind` without `ahead`, a kind the core had been serving for
// months, and nobody reading the reference could have seen it: the enum sat one level down. So
// every field is rendered at every depth with its type, its enum values, its description and its
// flags, and a shared schema (`ms:channelRecord`) is rendered once, under **Schemas**, and linked
// from each route that uses it rather than repeated in each.
//
// Deterministic by construction: it reads the document in the order the document lists things,
// sorts what it groups, and reads no clock or environment.

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const collapse = (text) => String(text).replace(/\s+/gu, ' ').trim();
/** A table cell: one line, and a `|` that does not end the cell. */
const cell = (text) => collapse(text).replace(/\|/gu, '\\|');
const code = (value) => `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
/** Deeper than any route declares; a guard against a schema that nests without end. */
const MAX_DEPTH = 12;

/**
 * Orders by UTF-16 code unit, never by locale. `localeCompare` reads the collation from `LANG`,
 * so under `cs_CZ.UTF-8` `ch` sorts after `h`, and `--check` would fail on one machine for a page
 * another generated (`P-318` review).
 */
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `get /api/v1/maps/{id}`: a route as the document spells it, and as `release.absent` takes it. */
export const routeKeyOf = (method, url) =>
  `${method.toLowerCase()} ${url.replace(/:([a-zA-Z]+)/gu, '{$1}')}`;

/**
 * The routes of the page that a release's router did not register (`H-51`), for `release.absent`.
 *
 * `registered` is what the router the document came from registered, and `release` what the
 * release's did, both as `routeKeyOf` spells them. The two are compared before anything is
 * marked, and either way of not matching is refused: a route only the release registers is one
 * the page, rendered from the other, leaves out; a route of the document that its own router did
 * not register under that spelling could not be looked up in the release at all.
 *
 * @param {object} doc the OpenAPI document
 * @param {Array<{ path: string, method: string }>} extra routes the page lists beside it
 * @param {{ registered: Iterable<string>, release: Iterable<string>, name: string }} routers
 * @returns {string[]} the page's routes the release lacks, in the order the document lists them
 */
export function absentFromRelease(doc, extra, { registered, release, name }) {
  const full = new Set(registered);
  const released = new Set(release);
  const documented = [
    ...Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      METHODS.filter((method) => item[method] !== undefined).map((method) => `${method} ${path}`),
    ),
    ...extra.map((route) => `${route.method} ${route.path}`),
  ];
  const problems = [
    ...[...released]
      .filter((key) => !full.has(key))
      .map((key) => `${name} registers ${key}, which the page's build does not`),
    ...documented
      .filter((key) => !full.has(key))
      .map((key) => `the document lists ${key}, which its router did not register`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `cannot tell which routes ${name} lacks:\n  ${problems.sort(byCodePoint).join('\n  ')}`,
    );
  }
  return documented.filter((key) => !released.has(key));
}

/**
 * @param {object} doc the OpenAPI document, as `@fastify/swagger` produces it
 * @param {{
 *   extra?: Array<{ path: string, method: string, operation: object }>,
 *   release?: { name: string, absent: readonly string[] },
 * }} [options]
 *   `extra`: operations Fastify serves that the document does not carry (the WebSocket stream).
 *   `release`: the routes a release's build does not register, each as `get /api/v1/maps` — the
 *   method in lower case and the path as the document spells it — marked where a reader meets
 *   them (`H-51`): in the route count, under a tag's heading when the release has none of the
 *   tag's routes, and under a route's own heading when it has some of them.
 * @returns {string} the page, ending in one newline
 */
export function renderApiReference(doc, options = {}) {
  const components = doc.components?.schemas ?? {};
  const lines = [];
  const say = (...text) => lines.push(...text);

  // ---- shared schemas ---------------------------------------------------------------------

  /** `#/components/schemas/def-5` → `def-5`, or undefined for anything else. */
  const refKey = (ref) => {
    const match = /^#\/components\/schemas\/(.+)$/u.exec(String(ref));
    return match === null ? undefined : match[1];
  };
  /** The name a reader knows a shared schema by: its `$id` (`ms:channelRecord`), carried as `title`. */
  const nameOf = (key) => components[key]?.title ?? key;
  const anchorOf = (key) => `schema-${nameOf(key).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
  const linked = new Set();
  const linkTo = (ref) => {
    const key = refKey(ref);
    if (key === undefined || components[key] === undefined) {
      throw new Error(`the document refers to ${String(ref)}, which it does not define`);
    }
    linked.add(key);
    return `[${nameOf(key)}](#${anchorOf(key)})`;
  };

  /** `#/components/schemas/Sensor` → its schema, following one level. For the summary line. */
  const resolveRef = (schema) => {
    if (schema?.$ref === undefined) return schema;
    return components[refKey(schema.$ref) ?? ''] ?? {};
  };

  // ---- shapes -----------------------------------------------------------------------------

  /** A schema that describes a value, as opposed to one that only constrains which fields appear. */
  const isShape = (schema) =>
    schema !== null &&
    typeof schema === 'object' &&
    ['type', 'properties', 'enum', 'const', '$ref', 'items', 'oneOf', 'anyOf', 'additionalProperties'].some(
      (key) => schema[key] !== undefined,
    );
  const isNull = (schema) =>
    schema?.type === 'null' || (Array.isArray(schema?.enum) && schema.enum.length === 1 && schema.enum[0] === null);

  /**
   * The schema with `null` taken out of it, and whether it was there. `nullable` is how the
   * reader is told, rather than a `null` in every type and enum.
   */
  function withoutNull(schema) {
    if (schema === undefined || schema === null || typeof schema !== 'object') {
      return { schema: schema ?? {}, nullable: false };
    }
    let nullable = schema.nullable === true;
    let rest = schema;
    if (Array.isArray(rest.type) && rest.type.includes('null')) {
      const types = rest.type.filter((type) => type !== 'null');
      rest = { ...rest, type: types.length === 1 ? types[0] : types };
      nullable = true;
    }
    if (Array.isArray(rest.enum) && rest.enum.includes(null)) {
      rest = { ...rest, enum: rest.enum.filter((value) => value !== null) };
      nullable = true;
    }
    for (const union of ['oneOf', 'anyOf']) {
      const alternatives = rest[union];
      if (!Array.isArray(alternatives) || !alternatives.some(isNull)) continue;
      const others = alternatives.filter((alternative) => !isNull(alternative));
      nullable = true;
      if (others.length === 1) {
        const { [union]: _dropped, ...outer } = rest;
        // The one alternative left is the shape; the outer schema keeps its description.
        const inner = withoutNull(others[0]);
        rest = { ...inner.schema, ...outer };
        nullable = true;
      } else {
        rest = { ...rest, [union]: others };
      }
    }
    return { schema: rest, nullable };
  }

  /** The shape alternatives of a union (`oneOf` / `anyOf` whose members describe values). */
  const unionOf = (schema) => {
    for (const union of ['oneOf', 'anyOf']) {
      const alternatives = schema[union];
      if (Array.isArray(alternatives) && alternatives.every(isShape)) return alternatives;
    }
    return undefined;
  };
  const isObject = (schema) =>
    schema.type === 'object' || (schema.type === undefined && schema.properties !== undefined);

  /**
   * The property every alternative pins to one value, so that a reader can tell them apart:
   * `kind` in `{ kind: 'own', … } | { kind: 'inherited', … }`.
   */
  function discriminatorOf(alternatives) {
    if (!alternatives.every((one) => isObject(one) && one.properties !== undefined)) return undefined;
    const pinned = (schema, key) => {
      const property = schema.properties?.[key];
      if (property === undefined) return undefined;
      if (property.const !== undefined) return property.const;
      if (Array.isArray(property.enum) && property.enum.length === 1) return property.enum[0];
      return undefined;
    };
    const key = Object.keys(alternatives[0].properties).find((candidate) =>
      alternatives.every((one) => pinned(one, candidate) !== undefined),
    );
    if (key === undefined) return undefined;
    return { key, labels: alternatives.map((one) => `${key}=${String(pinned(one, key))}`) };
  }

  /** `[x, x[]]`: one value or an array of the same values, as a repeatable query parameter takes. */
  const isOneOrSeveral = (alternatives) =>
    alternatives.length === 2 &&
    alternatives[1].type === 'array' &&
    JSON.stringify(alternatives[1].items) === JSON.stringify(alternatives[0]);

  /** How a value's type reads in one cell: `string (date-time)`, `` `a` · `b` ``, a link. */
  function typeText(raw) {
    const { schema } = withoutNull(raw);
    if (schema.$ref !== undefined) return linkTo(schema.$ref);
    if (schema.const !== undefined) return code(schema.const);
    if (Array.isArray(schema.enum)) {
      return schema.enum.length === 0 ? 'nothing' : schema.enum.map((one) => code(String(one))).join(' · ');
    }
    const alternatives = unionOf(schema);
    if (alternatives !== undefined) {
      // `kind=probe` or `kind=[probe, group]`: a query parameter that takes one or several.
      if (isOneOrSeveral(alternatives)) return `${typeText(alternatives[0])}, or an array of them`;
      const by = discriminatorOf(alternatives);
      if (by !== undefined) return `one of ${String(alternatives.length)} shapes, by \`${by.key}\``;
      return alternatives.map((one) => typeText(one)).join(' or ');
    }
    if (schema.type === 'array') {
      const items = schema.items === undefined ? 'any' : typeText(schema.items);
      const plain = /^[a-z]+( \([a-z-]+\))?$/u.test(items) || items.startsWith('[');
      return plain ? `${items}[]` : `(${items})[]`;
    }
    // `string or string[]`: a query parameter that takes one or several as a type list (`P-347`).
    if (Array.isArray(schema.type)) {
      return schema.type
        .map((type) => (type === 'array' && schema.items !== undefined ? typeText({ type, items: schema.items }) : type))
        .join(' or ');
    }
    if (isObject(schema) || schema.additionalProperties !== undefined) {
      const map = schema.additionalProperties;
      if (map !== undefined && typeof map === 'object' && Object.keys(schema.properties ?? {}).length === 0) {
        return `map of ${typeText(map)}`;
      }
      return 'object';
    }
    if (schema.type === undefined) return 'any';
    return schema.format === undefined ? schema.type : `${schema.type} (${schema.format})`;
  }

  // ---- constraints: the bounds a value must keep (`P-337`) --------------------------------

  /**
   * Keywords a value's schema may carry that this renders somewhere: as its type, its flags, its
   * description, its constraints, or as fields and rules of their own. Anything else on a field
   * that is not an object is printed raw beside its constraints, as `rulesOf` does for an object,
   * so a keyword this renderer has not learnt is shown rather than silently left out.
   */
  const RENDERED = new Set([
    'type',
    'format',
    'enum',
    'const',
    'items',
    '$ref',
    'oneOf',
    'anyOf',
    'title',
    'description',
    '$id',
    '$schema',
    '$comment',
    'nullable',
    'readOnly',
    'writeOnly',
    'deprecated',
    'default',
    'examples',
    'example',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    // Said beside its pattern (`P-372`), in brackets, as the 400 says it.
    'x-patternMessage',
    'minItems',
    'maxItems',
    'uniqueItems',
  ]);

  /** A code span that holds any text, backticks included (a `pattern` may have one). */
  const literal = (text) => {
    const longest = Math.max(0, ...[...String(text).matchAll(/`+/gu)].map(([run]) => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = /^`|`$/u.test(text) ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  };
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  /**
   * `1–65535`, `at least 1 and less than 100`: a numeric range, inclusive or not. Draft 4 spells
   * an exclusive bound as `exclusiveMinimum: true` beside `minimum`; 2019-09 and OpenAPI 3.1 as
   * `exclusiveMinimum: 0` alone. Both are read.
   */
  function rangeOf(low, high, unit = (text) => text) {
    if (low === undefined && high === undefined) return undefined;
    if (low !== undefined && high !== undefined && !low.exclusive && !high.exclusive) {
      return low.value === high.value
        ? `exactly ${unit(String(low.value), low.value)}`
        : unit(`${String(low.value)}–${String(high.value)}`, high.value);
    }
    const parts = [];
    if (low !== undefined) {
      parts.push(`${low.exclusive ? 'more than' : 'at least'} ${unit(String(low.value), low.value)}`);
    }
    if (high !== undefined) {
      parts.push(`${high.exclusive ? 'less than' : 'at most'} ${unit(String(high.value), high.value)}`);
    }
    return parts.join(' and ');
  }

  const bound = (schema, inclusive, exclusive) => {
    if (isNumber(schema[exclusive])) return { value: schema[exclusive], exclusive: true };
    if (isNumber(schema[inclusive])) return { value: schema[inclusive], exclusive: schema[exclusive] === true };
    return undefined;
  };
  const counted = (word) => (text, last) => `${text} ${word}${last === 1 ? '' : 's'}`;

  /**
   * A value's constraints in words, in a fixed order: `1–65535`, `at most 255 characters`,
   * `matches ^[a-z]+$`, `at least 1 item`, `unique items`, `a multiple of 5`. An array of
   * scalars says its elements' as `each …`, since the elements have no row of their own; so do
   * the alternatives of a union that have none (`withAlternatives`), as a query parameter's do.
   */
  function constraintsOf(raw, withAlternatives) {
    const { schema } = withoutNull(raw);
    if (schema.$ref !== undefined) return [];
    const said = [];
    const numbers = rangeOf(
      bound(schema, 'minimum', 'exclusiveMinimum'),
      bound(schema, 'maximum', 'exclusiveMaximum'),
    );
    if (numbers !== undefined) said.push(numbers);
    if (isNumber(schema.multipleOf)) said.push(`a multiple of ${String(schema.multipleOf)}`);
    const length = rangeOf(
      isNumber(schema.minLength) && schema.minLength > 0 ? { value: schema.minLength } : undefined,
      isNumber(schema.maxLength) ? { value: schema.maxLength } : undefined,
      counted('character'),
    );
    if (length !== undefined) said.push(length);
    if (typeof schema.pattern === 'string') {
      // The expression for a client to check against, and the sentence a refusal says (`P-372`).
      // In brackets, since the sentence may hold the commas this list is joined with.
      const words = schema['x-patternMessage'];
      said.push(
        `matches ${literal(schema.pattern)}` +
          (typeof words === 'string' && words.trim() !== '' ? ` (${words.trim()})` : ''),
      );
    }
    const count = rangeOf(
      isNumber(schema.minItems) && schema.minItems > 0 ? { value: schema.minItems } : undefined,
      isNumber(schema.maxItems) ? { value: schema.maxItems } : undefined,
      counted('item'),
    );
    if (count !== undefined) said.push(count);
    if (schema.uniqueItems === true) said.push('unique items');

    const object = isObject(schema) || schema.additionalProperties !== undefined;
    if (!object) {
      for (const [keyword, value] of Object.entries(schema)) {
        if (!RENDERED.has(keyword)) said.push(`${code(keyword)}: ${code(value)}`);
      }
    }
    // Elements with no row of their own: an array of strings says how long each may be.
    const array = schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'));
    const items = array ? schema.items : undefined;
    if (items !== undefined && items !== null && typeof items === 'object') {
      const { schema: element } = withoutNull(items);
      if (!(isObject(element) || element.additionalProperties !== undefined)) {
        const each = constraintsOf(element, true);
        if (each.length > 0) said.push(`each ${each.join(', ')}`);
      }
    }
    const alternatives = unionOf(schema);
    if (alternatives !== undefined) {
      // `string, or an array of them, at most 40 characters, at most 10 items`: the elements are
      // the first alternative, whose constraints are already said once.
      const [first, several] = alternatives;
      const own = isOneOrSeveral(alternatives) ? [first, { ...several, items: undefined }] : alternatives;
      for (const alternative of own) {
        const { schema: inner } = withoutNull(alternative);
        // A field's object or array alternative is a row of its own, with these in its cell.
        if (!withAlternatives && (isObject(inner) || inner.type === 'array')) continue;
        for (const text of constraintsOf(inner, withAlternatives)) {
          if (!said.includes(text)) said.push(text);
        }
      }
    }
    return said;
  }

  /** A type cell: the type, then its constraints. `integer, 1–500`. */
  const typeCell = (schema, withAlternatives = false) =>
    [typeText(schema), ...constraintsOf(schema, withAlternatives)].join(', ');

  // ---- rules: the `if`/`then`/`not` that constrain which fields appear --------------------

  const names = (keys) => keys.map((key) => code(key));
  const andList = (items) =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  // A `properties` that only declares, as `true`, names its `required` lists says nothing more:
  // it is there because strict mode refuses a `required` its own schema does not declare (`P-383`).
  const declaresOnly = (schema) =>
    schema.properties === undefined ||
    (typeof schema.properties === 'object' &&
      schema.properties !== null &&
      Object.entries(schema.properties).every(
        ([key, value]) => value === true && schema.required.includes(key),
      ));
  const isRequiredOnly = (schema) =>
    Array.isArray(schema?.required) &&
    Object.keys(schema).every((key) => key === 'required' || key === 'properties') &&
    declaresOnly(schema);

  function condition(schema) {
    const parts = Object.entries(schema.properties ?? {}).map(([key, property]) => {
      if (property.const !== undefined) return `${code(key)} is ${code(property.const)}`;
      if (Array.isArray(property.enum)) {
        return `${code(key)} is ${property.enum.map((one) => code(String(one))).join(' or ')}`;
      }
      return `${code(key)} matches ${code(property)}`;
    });
    const extra = Object.keys(schema).filter((key) => key !== 'properties' && key !== 'required');
    if (parts.length === 0 || extra.length > 0) return code(schema);
    return parts.join(' and ');
  }

  function rule(schema) {
    if (isRequiredOnly(schema)) {
      const keys = names(schema.required);
      return `${andList(keys)} ${keys.length === 1 ? 'is' : 'are'} required`;
    }
    if (schema.if !== undefined && Object.keys(schema).every((key) => ['if', 'then', 'else'].includes(key))) {
      const then = schema.then === undefined ? '' : `, ${rule(schema.then)}`;
      const otherwise = schema.else === undefined ? '' : `; otherwise ${rule(schema.else)}`;
      return `when ${condition(schema.if)}${then}${otherwise}`;
    }
    if (schema.not !== undefined && Object.keys(schema).length === 1) {
      const not = schema.not;
      if (isRequiredOnly(not)) {
        return not.required.length === 1
          ? `${code(not.required[0])} is not allowed`
          : `${andList(names(not.required))} are not allowed together`;
      }
      const any = not.anyOf ?? not.oneOf;
      if (Array.isArray(any) && Object.keys(not).length === 1 && any.every(isRequiredOnly)) {
        const options = any.map((one) => andList(names(one.required)));
        return options.length === 2
          ? `neither ${options[0]} nor ${options[1]} is allowed`
          : `none of ${options.join(', ')} is allowed`;
      }
    }
    if (Array.isArray(schema.allOf) && Object.keys(schema).length === 1) {
      return schema.allOf.map(rule).join('; ');
    }
    for (const union of ['anyOf', 'oneOf']) {
      const alternatives = schema[union];
      if (Array.isArray(alternatives) && Object.keys(schema).length === 1 && alternatives.every(isRequiredOnly)) {
        const options = alternatives.map((one) => andList(names(one.required)));
        return union === 'anyOf'
          ? `at least one of ${options.join(', ')} is required`
          : `exactly one of ${options.join(', ')} is given`;
      }
    }
    return code(schema);
  }

  /**
   * Object-level keywords this renders as fields, flags or prose, or that say nothing about what
   * may be sent. Any other keyword on an object is printed as it is (`rulesOf`'s last step), so a
   * constraint this renderer has not learnt is shown raw rather than silently left out.
   */
  const UNDERSTOOD = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'minProperties',
    'maxProperties',
    'allOf',
    'oneOf',
    'anyOf',
    'not',
    'if',
    'then',
    'else',
    'dependencies',
    'dependentRequired',
    'title',
    'description',
    '$id',
    '$schema',
    '$comment',
    'nullable',
    'readOnly',
    'writeOnly',
    'deprecated',
    'default',
    'examples',
    'example',
  ]);
  const plural = (count, word) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

  /** The rules an object schema carries beside its fields, one sentence each. */
  function rulesOf(schema) {
    const rules = [];
    if (typeof schema.minProperties === 'number') {
      rules.push(`at least ${plural(schema.minProperties, 'field')} must be given`);
    }
    if (typeof schema.maxProperties === 'number') {
      rules.push(`at most ${plural(schema.maxProperties, 'field')} may be given`);
    }
    for (const member of schema.allOf ?? []) rules.push(rule(member));
    if (schema.not !== undefined) rules.push(rule({ not: schema.not }));
    if (schema.if !== undefined) rules.push(rule({ if: schema.if, then: schema.then, else: schema.else }));
    for (const union of ['oneOf', 'anyOf']) {
      const alternatives = schema[union];
      if (Array.isArray(alternatives) && !alternatives.every(isShape)) rules.push(rule({ [union]: alternatives }));
    }
    // `dependencies` (draft 7) and `dependentRequired` (2019-09): a field that needs others.
    // The pause body's `from` needs `until`, and a client that sends `from` alone gets a 400.
    for (const keyword of ['dependencies', 'dependentRequired']) {
      for (const [key, needs] of Object.entries(schema[keyword] ?? {})) {
        rules.push(
          Array.isArray(needs)
            ? `${code(key)} requires ${andList(names(needs))}`
            : `when ${code(key)} is given, ${rule(needs)}`,
        );
      }
    }
    for (const [keyword, value] of Object.entries(schema)) {
      if (!UNDERSTOOD.has(keyword)) rules.push(`${code(keyword)}: ${code(value)}`);
    }
    return rules;
  }

  // ---- fields -----------------------------------------------------------------------------

  /**
   * The table rows for a schema's fields, every level down, and the rules that go with them.
   * A field's path names its parents: `skew.kind`, `items[].name`, `effective.*`, and
   * `source{kind=own}.objectId` for a field of one alternative of a union.
   */
  function fieldsOf(schema) {
    const rows = [];
    const rules = [];

    const walk = (raw, path, depth) => {
      if (depth > MAX_DEPTH) throw new Error(`a schema nests deeper than ${String(MAX_DEPTH)} at ${path}`);
      const { schema: shape } = withoutNull(raw);
      if (shape.$ref !== undefined) return;
      const prefix = path === '' ? '' : `${path}.`;

      if (shape.type === 'array' && shape.items !== undefined) {
        walk(shape.items, `${path}[]`, depth + 1);
        return;
      }
      // An object's own fields and rules first: they hold whichever alternative of a union
      // beside them matches, so they are listed even when there is one (`P-318` review).
      if (isObject(shape) || shape.additionalProperties !== undefined) {
        for (const text of rulesOf(shape)) rules.push(path === '' ? text : `${code(path)}: ${text}`);
        const required = new Set(shape.required ?? []);
        for (const [key, property] of Object.entries(shape.properties ?? {})) {
          rows.push({ path: `${prefix}${key}`, schema: property, required: required.has(key) });
          walk(property, `${prefix}${key}`, depth + 1);
        }
        const map = shape.additionalProperties;
        if (map !== undefined && typeof map === 'object' && Object.keys(map).length > 0) {
          rows.push({ path: `${prefix}*`, schema: map, required: false, map: true });
          walk(map, `${prefix}*`, depth + 1);
        }
      }

      const alternatives = unionOf(shape);
      if (alternatives === undefined) return;
      const by = discriminatorOf(alternatives);
      alternatives.forEach((alternative, index) => {
        const label = by === undefined ? `#${String(index + 1)}` : by.labels[index];
        const branch = `${path}{${label}}`;
        const { schema: inner } = withoutNull(alternative);
        // A scalar alternative has no fields; it is already named in the parent's type.
        if (inner.$ref !== undefined || !(isObject(inner) || inner.type === 'array')) return;
        rows.push({ path: branch, schema: alternative, required: false });
        walk(alternative, branch, depth + 1);
      });
    };
    walk(schema, '', 0);
    return { rows, rules };
  }

  function flagsOf(row) {
    const { schema, nullable } = withoutNull(row.schema);
    const flags = [];
    if (row.required) flags.push('**required**');
    if (nullable) flags.push('nullable');
    if (row.schema.writeOnly === true || schema.writeOnly === true) flags.push('**write-only**');
    if (row.schema.readOnly === true || schema.readOnly === true) flags.push('read-only');
    if (row.schema.deprecated === true) flags.push('deprecated');
    if (row.schema.default !== undefined) flags.push(`default ${code(row.schema.default)}`);
    return flags.join(' ');
  }

  function sayFields({ rows, rules }) {
    if (rows.length > 0) {
      say('| Field | Type | | Description |', '| --- | --- | --- | --- |');
      for (const row of rows) {
        const described = row.schema.description ?? withoutNull(row.schema).schema.description ?? '';
        say(
          `| \`${cell(row.path)}\` | ${cell(typeCell(row.schema))} | ${flagsOf(row)} | ${cell(described)} |`,
        );
      }
      say('');
    }
    if (rules.length > 0) {
      say(...rules.map((text) => `- ${collapse(text)}`), '');
    }
  }

  /** `{ a, b, c }` — the one-line shape the summary line has always carried. */
  function shapeOf(schema, depth = 0) {
    const resolved = resolveRef(schema);
    if (resolved === undefined) return '—';
    if (resolved.type === 'array') return `${shapeOf(resolved.items, depth)}[]`;
    if (Array.isArray(resolved.enum)) return resolved.enum.map((one) => `\`${String(one)}\``).join(' · ');
    if (resolved.type !== 'object' || depth > 0) return resolved.type ?? 'object';
    const keys = Object.keys(resolved.properties ?? {});
    if (keys.length === 0) return 'object';
    return `{ ${keys.join(', ')} }`;
  }

  // ---- routes -----------------------------------------------------------------------------

  /** The routes' own tags, in the order the document lists them, with the rest after. */
  function groupsOf() {
    const seen = new Map();
    const add = (tag, route) => seen.set(tag, [...(seen.get(tag) ?? []), route]);
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of METHODS) {
        const operation = item[method];
        if (operation === undefined) continue;
        add(operation.tags?.[0] ?? 'Other', { path, method, operation });
      }
    }
    for (const route of options.extra ?? []) add(route.operation.tags?.[0] ?? 'Other', route);
    return [...seen.entries()].sort(([a], [b]) => byCodePoint(a, b));
  }

  const groups = groupsOf();
  const total = groups.reduce((sum, [, routes]) => sum + routes.length, 0);

  // ---- what a release lacks (`H-51`) ------------------------------------------------------

  const routeKey = ({ method, path }) => `${method} ${path}`;
  const release = options.release;
  const absent = new Set(release?.absent ?? []);
  {
    // A mark for a route this page does not list is a release that cannot be described, and
    // printing the page without it would say the release has everything.
    const listed = new Set(groups.flatMap(([, routes]) => routes.map(routeKey)));
    const unknown = [...absent].filter((key) => !listed.has(key)).sort(byCodePoint);
    if (unknown.length > 0) {
      throw new Error(
        `the release is said to lack ${unknown.join(', ')}, which the document does not carry`,
      );
    }
  }
  /** `**Not in 1.0 — v2, in the full build only.**`: the words every mark starts with. */
  const notIn = () => `**Not in ${String(release?.name)} — v2, in the full build only.**`;
  /** Per tag: whether the release has none of its routes, some, or every one. */
  const lacking = (routes) => {
    const count = routes.filter((route) => absent.has(routeKey(route))).length;
    return count === 0 ? 'none' : count === routes.length ? 'all' : 'some';
  };

  say(`# ${doc.info?.title ?? 'API'} reference`, '');
  say(
    '**Generated from the OpenAPI document by `scripts/docs/api-reference.mjs`. Do not edit.** ' +
      'Every route is declared with a JSON Schema that Fastify validates against, so this is a ' +
      'rendering of what runs rather than a description of it, and ' +
      '`packages/core/test/build-hygiene.test.ts` fails when the two disagree.',
    '',
  );
  if (absent.size === 0) {
    say(
      'The live document is at `GET /api/v1/openapi.json` on any running installation, and is ' +
        'the one to feed to a client generator. This page is for reading.',
      '',
    );
    say(`${String(total)} routes.`, '');
  } else {
    const name = String(release?.name);
    say(
      'The live document is at `GET /api/v1/openapi.json` on any running installation, to any ' +
        'session or API token, and is the one to feed to a client generator: it lists the routes ' +
        'that installation registers. This page is rendered from the full build, marks the ' +
        `routes a ${name} core does not have, and is for reading.`,
      '',
    );
    const whole = groups.filter(([, routes]) => lacking(routes) === 'all').map(([tag]) => tag);
    const partial = groups
      .filter(([, routes]) => lacking(routes) === 'some')
      .map(([tag, routes]) => {
        const count = routes.filter((route) => absent.has(routeKey(route))).length;
        return `${String(count)} of the ${String(routes.length)} under **${tag}**`;
      });
    const where = [
      ...(whole.length === 0
        ? []
        : [`every route under ${andList(whole.map((tag) => `**${tag}**`))}`]),
      ...partial,
    ];
    say(
      `${String(total)} routes. ${String(absent.size)} of them are not in ${name} — v2, in the ` +
        `full build only: ${andList(where)}. A ${name} core registers the other ` +
        `${String(total - absent.size)}.`,
      '',
    );
  }

  say('## Conventions', '');
  say(
    '- **Everything is under `/api/v1`.** The version is in the path and will change only for a ' +
      'breaking change.',
    '- **Authentication** is a session cookie or an API token in `Authorization: Bearer`. Token ' +
      "rights are the account's rights, never more.",
    '- **Writes need the CSRF header** when they authenticate by cookie — see `docs/administration.md`.',
    '- **Errors** share one shape: `{ error: { code, message } }`, with the code taken from a ' +
      'fixed set (`OBJECT_INVALID`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, …) so a client can ' +
      'branch on it without matching on prose.',
    '- **Credentials are never returned.** Parameters a sensor type marks `writeOnly` are stripped ' +
      'from every response in one place; reads carry `redactedParams` instead.',
    "- **Concurrent edits** use `If-Match` with the object's `version`; a stale one is `409`.",
    '- **A body whose schema requires nothing may be left out.** It is read as `{}`, defaults and ' +
      'all. A body that is present has to be JSON: an empty one sent as `application/json` is a `400`.',
    '',
  );
  say('### Reading the field tables', '');
  say(
    '- **Every level is listed.** A field\'s path names its parents: `skew.kind` is `kind` inside ' +
      '`skew`, `items[].name` is `name` in each element of `items`, and `counts.*` is every value ' +
      'of a map keyed by name.',
    '- **A field that takes one of several shapes** lists each under its own path, named by the ' +
      'field that tells them apart: `source{kind=own}.objectId` exists only when `kind` is `own`.',
    '- **Shared shapes are under [Schemas](#schemas)** and linked wherever a route uses them, ' +
      'rather than listed again in each.',
    '- **Flags:** `required` must be present, `nullable` may be `null`, `write-only` is accepted ' +
      'and never returned, `default` is what an absent field is read as.',
    '- **Rules** below a table are the conditions that decide which fields may appear together.',
    '',
  );
  say('---', '');

  for (const [tag, routes] of groups) {
    say(`## ${tag}`, '');
    // First under the heading, before anything that reads as though the release had it.
    const lacks = lacking(routes);
    if (lacks === 'all') {
      say(
        `${notIn()} The ${String(release?.name)} build leaves out the subsystem these ` +
          `${String(routes.length)} routes belong to, so a ${String(release?.name)} core ` +
          'registers none of them: with a credential each answers `404` `ROUTE_NOT_FOUND`, and ' +
          "the core's own `GET /api/v1/openapi.json` does not list them. `GET /api/v1/build` " +
          'says which optional subsystems a core constructed.',
        '',
      );
    }
    const described = doc.tags?.find((one) => one.name === tag)?.description;
    if (typeof described === 'string' && described !== '') say(collapse(described), '');

    for (const route of routes) {
      const { path, method, operation } = route;
      say(`### \`${method.toUpperCase()} ${path}\``, '');
      if (lacks === 'some' && absent.has(routeKey(route))) {
        say(
          `${notIn()} A ${String(release?.name)} core does not register this route: with a ` +
            'credential it answers `404` `ROUTE_NOT_FOUND`.',
          '',
        );
      }
      if (typeof operation.summary === 'string') say(collapse(operation.summary), '');
      if (typeof operation.description === 'string') say(collapse(operation.description), '');

      const parameters = operation.parameters ?? [];
      if (parameters.length > 0) {
        const describedOf = (parameter) =>
          parameter.description ?? parameter.schema?.description ?? '';
        // A description column only where a parameter has one: most are explained in the prose.
        const withText = parameters.some((parameter) => describedOf(parameter) !== '');
        say(
          withText ? '| Parameter | In | Type | | Description |' : '| Parameter | In | Type | |',
          withText ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- |',
        );
        for (const parameter of parameters) {
          const flags = [];
          if (parameter.required === true) flags.push('**required**');
          if (parameter.schema?.default !== undefined) {
            flags.push(`default ${code(parameter.schema.default)}`);
          }
          const text = withText ? ` ${cell(describedOf(parameter))} |` : '';
          say(
            `| \`${parameter.name}\` | ${parameter.in} | ${cell(typeCell(parameter.schema ?? {}, true))} | ${flags.join(' ')} |${text}`,
          );
        }
        say('');
      }

      const body = operation.requestBody?.content?.['application/json']?.schema;
      if (body !== undefined) {
        const fields = fieldsOf(body);
        if (fields.rows.length === 0) {
          say(`**Body** — ${typeCell(body, true)}`, '');
          if (fields.rules.length > 0) sayFields(fields);
        } else {
          say('**Body**', '');
          sayFields(fields);
        }
      }

      const responses = Object.entries(operation.responses ?? {}).filter(([status]) => status !== 'default');
      if (responses.length > 0) {
        // The summary line, unchanged since H-07. Nothing reads it any more: `build-hygiene.test.ts`
        // walks the OpenAPI document for credential-shaped fields instead (`P-336`).
        say(
          responses
            .map(([status, response]) => {
              const schema = response.content?.['application/json']?.schema;
              const shape = schema === undefined ? '' : ` ${shapeOf(schema)}`;
              // Fastify writes "Default Response" wherever a route did not describe one, on every
              // response of every route. Repeating it 119 times says nothing.
              const text = collapse(response.description ?? '');
              return [`**${status}**`, text === 'Default Response' ? '' : text, shape.trim()]
                .filter((one) => one !== '')
                .join(' ');
            })
            .join(' · '),
          '',
        );

        const shared = [];
        for (const [status, response] of responses) {
          const schema = response.content?.['application/json']?.schema;
          if (schema === undefined) continue;
          const fields = fieldsOf(schema);
          if (fields.rows.length > 0) {
            say(`**${status} response**`, '');
            sayFields(fields);
          } else {
            const text = typeText(schema);
            if (text.includes('](#')) shared.push(`**${status}** is ${text}`);
            if (fields.rules.length > 0) sayFields(fields);
          }
        }
        if (shared.length > 0) say(shared.join(' · '), '');
      }
    }
  }

  // ---- schemas ----------------------------------------------------------------------------

  // Every shared schema a route reached, and every one those reach, each once.
  const rendered = new Set();
  const sections = [];
  for (;;) {
    const next = [...linked].filter((key) => !rendered.has(key));
    if (next.length === 0) break;
    for (const key of next) {
      rendered.add(key);
      // Rendering one may link more; the loop goes round until nothing new is reached.
      const schema = components[key];
      const saved = lines.length;
      const fields = fieldsOf(schema);
      // A shared schema that is not a plain object (a union, a bare enum) says so before its fields.
      const text = typeText(schema);
      if (fields.rows.length === 0 || text !== 'object') {
        say(typeCell(schema, fields.rows.length === 0), '');
      }
      sayFields(fields);
      sections.push({ key, schema, body: lines.splice(saved) });
    }
  }
  if (sections.length > 0) {
    say('---', '', '## Schemas', '');
    say('The shapes routes share, each declared once in the code and rendered once here.', '');
    sections.sort((a, b) => byCodePoint(nameOf(a.key), nameOf(b.key)));
    for (const { key, schema, body } of sections) {
      say(`<a id="${anchorOf(key)}"></a>`, '', `### \`${nameOf(key)}\``, '');
      if (typeof schema.description === 'string') say(collapse(schema.description), '');
      say(...body);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
