// Renders `docs/api-reference.md` from an OpenAPI document (H-07, P-318).
//
// Split from `api-reference.mjs` so that the rendering can be tested against a small fixture
// without building a server: `api-reference.mjs` builds the real document and checks or writes
// the file; this turns any document into the page, and nothing else.
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
 * @param {object} doc the OpenAPI document, as `@fastify/swagger` produces it
 * @param {{ extra?: Array<{ path: string, method: string, operation: object }> }} [options]
 *   operations Fastify serves that the document does not carry (the WebSocket stream)
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
      const [first, second] = alternatives;
      // `kind=probe` or `kind=[probe, group]`: a query parameter that takes one or several.
      if (
        alternatives.length === 2 &&
        second.type === 'array' &&
        JSON.stringify(second.items) === JSON.stringify(first)
      ) {
        return `${typeText(first)}, or an array of them`;
      }
      const by = discriminatorOf(alternatives);
      if (by !== undefined) return `one of ${String(alternatives.length)} shapes, by \`${by.key}\``;
      return alternatives.map((one) => typeText(one)).join(' or ');
    }
    if (schema.type === 'array') {
      const items = schema.items === undefined ? 'any' : typeText(schema.items);
      const plain = /^[a-z]+( \([a-z-]+\))?$/u.test(items) || items.startsWith('[');
      return plain ? `${items}[]` : `(${items})[]`;
    }
    if (Array.isArray(schema.type)) return schema.type.join(' or ');
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

  // ---- rules: the `if`/`then`/`not` that constrain which fields appear --------------------

  const names = (keys) => keys.map((key) => code(key));
  const andList = (items) =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const isRequiredOnly = (schema) =>
    Array.isArray(schema?.required) && Object.keys(schema).every((key) => key === 'required');

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

  /** The rules an object schema carries beside its fields, one sentence each. */
  function rulesOf(schema) {
    const rules = [];
    if (typeof schema.minProperties === 'number') {
      rules.push(`at least ${String(schema.minProperties)} field${schema.minProperties === 1 ? '' : 's'} must be given`);
    }
    for (const member of schema.allOf ?? []) rules.push(rule(member));
    if (schema.not !== undefined) rules.push(rule({ not: schema.not }));
    if (schema.if !== undefined) rules.push(rule({ if: schema.if, then: schema.then, else: schema.else }));
    for (const union of ['oneOf', 'anyOf']) {
      const alternatives = schema[union];
      if (Array.isArray(alternatives) && !alternatives.every(isShape)) rules.push(rule({ [union]: alternatives }));
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
      const alternatives = unionOf(shape);
      if (alternatives !== undefined) {
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
        return;
      }
      if (!isObject(shape) && shape.additionalProperties === undefined) return;

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
          `| \`${cell(row.path)}\` | ${cell(typeText(row.schema))} | ${flagsOf(row)} | ${cell(described)} |`,
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
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  const groups = groupsOf();
  const total = groups.reduce((sum, [, routes]) => sum + routes.length, 0);

  say(`# ${doc.info?.title ?? 'API'} reference`, '');
  say(
    '**Generated from the OpenAPI document by `scripts/docs/api-reference.mjs`. Do not edit.** ' +
      'Every route is declared with a JSON Schema that Fastify validates against, so this is a ' +
      'rendering of what runs rather than a description of it, and ' +
      '`packages/core/test/build-hygiene.test.ts` fails when the two disagree.',
    '',
  );
  say(
    'The live document is at `GET /api/v1/openapi.json` on any running installation, and is the ' +
      'one to feed to a client generator. This page is for reading.',
    '',
  );
  say(`${String(total)} routes.`, '');

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
    const described = doc.tags?.find((one) => one.name === tag)?.description;
    if (typeof described === 'string' && described !== '') say(collapse(described), '');

    for (const { path, method, operation } of routes) {
      say(`### \`${method.toUpperCase()} ${path}\``, '');
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
            `| \`${parameter.name}\` | ${parameter.in} | ${cell(typeText(parameter.schema ?? {}))} | ${flags.join(' ')} |${text}`,
          );
        }
        say('');
      }

      const body = operation.requestBody?.content?.['application/json']?.schema;
      if (body !== undefined) {
        const fields = fieldsOf(body);
        if (fields.rows.length === 0) {
          say(`**Body** — ${typeText(body)}`, '');
          if (fields.rules.length > 0) sayFields(fields);
        } else {
          say('**Body**', '');
          sayFields(fields);
        }
      }

      const responses = Object.entries(operation.responses ?? {}).filter(([status]) => status !== 'default');
      if (responses.length > 0) {
        // The summary line, unchanged since H-07: `build-hygiene.test.ts` reads response field
        // names off it to look for credential-shaped ones.
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
      if (fields.rows.length === 0 || text !== 'object') say(text, '');
      sayFields(fields);
      sections.push({ key, schema, body: lines.splice(saved) });
    }
  }
  if (sections.length > 0) {
    say('---', '', '## Schemas', '');
    say('The shapes routes share, each declared once in the code and rendered once here.', '');
    sections.sort((a, b) => nameOf(a.key).localeCompare(nameOf(b.key)));
    for (const { key, schema, body } of sections) {
      say(`<a id="${anchorOf(key)}"></a>`, '', `### \`${nameOf(key)}\``, '');
      if (typeof schema.description === 'string') say(collapse(schema.description), '');
      say(...body);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
