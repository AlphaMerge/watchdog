import { describe, expect, it } from 'vitest';
import {
  defaultFor,
  fieldsOf,
  labelFor,
  newEntryFor,
  readAt,
  removeAt,
  scalarEntryOf,
  seedDefaults,
  writeAt,
  type FieldModel,
  type JsonSchema,
} from '../src/forms/schema';
import { allProblems, problemsFor } from '../src/forms/validate';

const PING: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['count'],
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 20, default: 4, title: 'Packets' },
    packetSize: { type: 'integer', minimum: 8, maximum: 65_500, default: 32 },
    host: { type: 'string', minLength: 1, maxLength: 255 },
    verbose: { type: 'boolean' },
    mode: { enum: ['auto', 'v4', 'v6'] },
  },
};

describe('reading a schema', () => {
  it('keeps the order the type declared, not alphabetical', () => {
    // The author put the important parameter first; sorting would throw that away, and the form
    // is theirs to lay out.
    expect(fieldsOf(PING).map((field) => field.name)).toEqual([
      'count',
      'packetSize',
      'host',
      'verbose',
      'mode',
    ]);
  });

  it('prefers the schema title, and makes a readable one when there is none', () => {
    const fields = fieldsOf(PING);
    expect(fields[0]?.label).toBe('Packets');
    expect(fields[1]?.label).toBe('Packet size');
  });

  it('turns camelCase and snake_case into words', () => {
    expect(labelFor('timeoutMs')).toBe('Timeout ms');
    expect(labelFor('snmp_community')).toBe('Snmp community');
    expect(labelFor('port')).toBe('Port');
  });

  it('picks a control from the type, and a select from an enum', () => {
    const kinds = Object.fromEntries(fieldsOf(PING).map((field) => [field.name, field.kind]));
    expect(kinds).toEqual({
      count: 'integer',
      packetSize: 'integer',
      host: 'string',
      verbose: 'boolean',
      mode: 'enum',
    });
  });

  it('marks what the schema required, and only that', () => {
    const required = fieldsOf(PING)
      .filter((field) => field.required)
      .map((field) => field.name);
    expect(required).toEqual(['count']);
  });

  it('recurses into a declared object and keeps the dotted path', () => {
    const fields = fieldsOf({
      type: 'object',
      properties: {
        auth: {
          type: 'object',
          properties: { user: { type: 'string' }, privKey: { type: 'string', writeOnly: true } },
        },
      },
    });
    expect(fields[0]?.kind).toBe('object');
    expect(fields[0]?.children.map((child) => child.path)).toEqual(['auth.user', 'auth.privKey']);
    expect(fields[0]?.children[1]?.writeOnly).toBe(true);
  });

  it('falls back to a JSON box rather than rendering nothing', () => {
    // The failure this prevents: `params` is replaced wholesale on save, so a control that
    // silently skipped an unsupported parameter would delete it the first time somebody saved.
    const fields = fieldsOf({
      type: 'object',
      properties: {
        // `U-12` took this one out of the fallback: an array whose entries are described is a
        // repeating control now. What is left here is what genuinely cannot be drawn.
        ports: { type: 'array', items: { type: 'integer' } },
        loose: { type: 'array' },
        blob: { type: 'object' },
        weird: {},
      },
    });
    expect(fields.map((field) => field.kind)).toEqual(['array', 'json', 'json', 'json']);
  });

  it('builds a control for the non-null half of a nullable type', () => {
    const fields = fieldsOf({ type: 'object', properties: { note: { type: ['string', 'null'] } } });
    expect(fields[0]?.kind).toBe('string');
  });
});

describe('a field default', () => {
  it('is the schema default where there is one', () => {
    // The core applies and *stores* defaults at validation time, so anything else would show one
    // number and save another.
    const [count] = fieldsOf(PING);
    expect(count && defaultFor(count)).toBe(4);
  });

  it('is undefined for a field with none, rather than an invented zero', () => {
    const host = fieldsOf(PING).find((field) => field.name === 'host');
    expect(host && defaultFor(host)).toBeUndefined();
  });

  it('is false for a boolean and the first entry for an enum', () => {
    const verbose = fieldsOf(PING).find((field) => field.name === 'verbose');
    const mode = fieldsOf(PING).find((field) => field.name === 'mode');
    expect(verbose && defaultFor(verbose)).toBe(false);
    expect(mode && defaultFor(mode)).toBe('auto');
  });
});

describe('dotted paths', () => {
  it('reads and writes through nesting, creating what is missing', () => {
    const written = writeAt({}, 'auth.privKey', 'secret');
    expect(written).toEqual({ auth: { privKey: 'secret' } });
    expect(readAt(written, 'auth.privKey')).toBe('secret');
  });

  it('does not mutate what it was given', () => {
    const before = { auth: { user: 'admin' } };
    const after = writeAt(before, 'auth.user', 'root');
    expect(before.auth.user).toBe('admin');
    expect(readAt(after, 'auth.user')).toBe('root');
  });

  it('reads undefined through a missing branch rather than throwing', () => {
    expect(readAt({}, 'auth.privKey')).toBeUndefined();
    expect(readAt({ auth: 'not an object' }, 'auth.privKey')).toBeUndefined();
  });

  it('removes a key, and the object it leaves empty above it', () => {
    // An object with nothing in it is not what the schema asked for either, so the branch goes.
    expect(removeAt({ auth: { user: 'admin' }, port: 22 }, 'auth.user')).toEqual({ port: 22 });
  });

  it('keeps a branch that still holds something', () => {
    expect(removeAt({ auth: { user: 'admin', privKey: 'x' } }, 'auth.privKey')).toEqual({
      auth: { user: 'admin' },
    });
  });
});

describe('checking a value against its schema', () => {
  const field = (name: string) => {
    const found = fieldsOf(PING).find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no field ${name}`);
    return found;
  };

  it('says nothing about a value inside its bounds', () => {
    expect(problemsFor(field('count'), 4)).toEqual([]);
  });

  it('reports a bound in the direction it was crossed', () => {
    expect(problemsFor(field('count'), 99)[0]?.message).toBe('must be 20 or less');
    expect(problemsFor(field('count'), 0)[0]?.message).toBe('must be 1 or more');
  });

  it('reports a required field left empty', () => {
    expect(problemsFor(field('count'), undefined)[0]?.message).toBe('required');
  });

  it('says nothing about an optional field left empty', () => {
    expect(problemsFor(field('host'), undefined)).toEqual([]);
  });

  it('does not call a write-only field missing when it is left alone', () => {
    // Its value is on the server, where this form is never allowed to see it. Calling that
    // "required" would make a credential impossible to leave in place.
    const secret = fieldsOf({
      type: 'object',
      required: ['community'],
      properties: { community: { type: 'string', writeOnly: true } },
    })[0];
    expect(secret && problemsFor(secret, undefined)).toEqual([]);
  });

  it('checks string length and pattern', () => {
    const named = fieldsOf({
      type: 'object',
      properties: { id: { type: 'string', minLength: 3, pattern: '^[a-z]+$' } },
    })[0];
    expect(named && problemsFor(named, 'ab')[0]?.message).toBe('must be at least 3 characters');
    expect(named && problemsFor(named, 'ABC')[0]?.message).toContain('does not match');
  });

  it('leaves an unparseable pattern to the server rather than failing the field', () => {
    // The pattern comes from a sensor type's declaration. One this engine cannot compile must
    // not take the form down; the core has the same string and Ajv's own opinion of it.
    const broken = fieldsOf({
      type: 'object',
      properties: { id: { type: 'string', pattern: '([' } },
    })[0];
    expect(broken && problemsFor(broken, 'anything')).toEqual([]);
  });

  it('gathers problems from a whole tree, including nested objects', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        auth: { type: 'object', required: ['user'], properties: { user: { type: 'string' } } },
        port: { type: 'integer', maximum: 65_535 },
      },
    };
    const problems = allProblems(fieldsOf(schema), { port: 70_000 }, readAt);
    expect(problems.map((problem) => problem.path).sort()).toEqual(['auth.user', 'port']);
  });
});

/**
 * Repeating parameters (`U-12`).
 *
 * The shape this exists for is `http.transaction.steps` and `rest.custom.extract` — arrays of
 * objects, sometimes with arrays of objects inside them, which since `T-04` is the shape of every
 * new sensor type's most important parameter rather than an edge case. Before this they rendered
 * as `U-08`'s JSON textarea, which round-trips correctly and means typing JSON by hand.
 */
const STEPS: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      title: 'Step',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['method'],
        properties: {
          method: { enum: ['GET', 'POST'], default: 'GET' },
          path: { type: 'string', minLength: 1 },
          headers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    tags: { type: 'array', items: { type: 'string' } },
    freeform: { type: 'array' },
  },
};

describe('repeating parameters', () => {
  it('renders a described array as an array, and an undescribed one as JSON', () => {
    const fields = fieldsOf(STEPS);
    expect(fields.map((field) => `${field.name}:${field.kind}`)).toEqual([
      'steps:array',
      'tags:array',
      // No `items`, so "add an entry" has nothing to add — the honest answer is the JSON box,
      // which is the same rule a free-form object follows.
      'freeform:json',
    ]);
  });

  it('carries the item schema, since an entry’s path depends on where it lands', () => {
    const steps = fieldsOf(STEPS)[0];
    expect(steps?.items?.type).toBe('object');
    expect(fieldsOf(STEPS)[2]?.items).toBeUndefined();
  });

  it('names an entry’s fields by index, which is the path the server reports too', () => {
    const items = fieldsOf(STEPS)[0]?.items;
    expect(items).toBeDefined();
    expect(fieldsOf(items as JsonSchema, 'steps.2').map((field) => field.path)).toEqual([
      'steps.2.method',
      'steps.2.path',
      'steps.2.headers',
    ]);
  });

  it('seeds a new entry from the item schema’s own defaults', () => {
    const items = fieldsOf(STEPS)[0]?.items;
    // The core applies and stores defaults at validation time, so an entry that started
    // somewhere else would show one thing and save another.
    expect(newEntryFor(items as JsonSchema)).toEqual({ method: 'GET' });
    expect(newEntryFor({ type: 'string' })).toBe('');
    expect(newEntryFor({ type: 'integer' })).toBe(0);
    expect(newEntryFor({ enum: ['a', 'b'] })).toBe('a');
    expect(newEntryFor({ type: 'object' })).toEqual({});
  });

  it('does not seed an array itself, since an absent one is not an empty one', () => {
    // The schema tells those two apart — `minItems: 1` refuses the second and says nothing about
    // the first — so seeding `[]` would make every form save a parameter nobody set.
    expect(seedDefaults(STEPS)).toEqual({});
    const steps = fieldsOf(STEPS)[0];
    expect(steps).toBeDefined();
    expect(steps === undefined ? 'missing' : defaultFor(steps)).toBeUndefined();
  });
});

describe('paths through an array', () => {
  it('creates an array where the path says index, not an object with a "0" key', () => {
    // The bug this prevents serialises to JSON that looks almost right, validates as the wrong
    // type, and is refused by the server with a message about the parameter rather than the form.
    const written = writeAt({}, 'steps.0.method', 'POST');
    expect(Array.isArray(written['steps'])).toBe(true);
    expect(written).toEqual({ steps: [{ method: 'POST' }] });
  });

  it('reads back through the index it wrote', () => {
    const written = writeAt(writeAt({}, 'steps.0.method', 'GET'), 'steps.1.method', 'POST');
    expect(readAt(written, 'steps.1.method')).toBe('POST');
    expect(readAt(written, 'steps.0.method')).toBe('GET');
    expect(readAt(written, 'steps.9.method')).toBeUndefined();
  });

  it('goes through an array into an array', () => {
    // `U-42`: this wrote `headers.1` into an empty array and expected the hole before it. A hole
    // serialises as `null`; the next position is the one an entry can be written at.
    const written = writeAt({}, 'steps.0.headers.0', 'accept: json');
    expect(written).toStrictEqual({ steps: [{ headers: ['accept: json'] }] });
    expect(readAt(written, 'steps.0.headers.0')).toBe('accept: json');
  });

  it('does not mutate the array it was given', () => {
    const before = { steps: [{ method: 'GET' }] };
    const after = writeAt(before, 'steps.0.method', 'POST');
    expect(before.steps[0]?.method).toBe('GET');
    expect(readAt(after, 'steps.0.method')).toBe('POST');
  });

  it('reads undefined rather than throwing when a path names an index into an object', () => {
    expect(readAt({ steps: { method: 'GET' } }, 'steps.0.method')).toBeUndefined();
  });

  it('replaces a value of the wrong shape rather than writing into it', () => {
    // A parameter that was a string and is now an array — a sensor type's schema changed under a
    // stored value. Writing into the string would throw; keeping it would save something the
    // schema refuses.
    expect(writeAt({ steps: 'nonsense' }, 'steps.0.method', 'GET')).toEqual({
      steps: [{ method: 'GET' }],
    });
  });
});

/** Freezes every container in a value, so a helper that writes into what it was given throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A slot never written (a hole), then an entry: the first reads `undefined`, not an entry. */
const HOLEY: unknown[] = [];
HOLEY[1] = { column: '8', mode: 'gauge' };

describe('removing a path, through objects and arrays (U-39)', () => {
  // `toStrictEqual` throughout: it tells an array from an object keyed "0", and a hole from an
  // entry — the two ways a walk through an array goes wrong while `toEqual` still passes.
  it.each([
    ['a top-level key', { port: 22, host: 'a' }, 'port', { host: 'a' }],
    [
      'a nested key, pruning the object it empties',
      { auth: { user: 'x' }, port: 22 },
      'auth.user',
      { port: 22 },
    ],
    [
      'a nested key, keeping a branch that still holds something',
      { auth: { user: 'x', key: 'k' } },
      'auth.key',
      { auth: { user: 'x' } },
    ],
    [
      'a key in an array entry, the entry and its neighbours staying where they are',
      {
        columns: [
          { column: '10', mode: 'counter' },
          { column: '8', mode: 'gauge' },
        ],
      },
      'columns.1.mode',
      { columns: [{ column: '10', mode: 'counter' }, { column: '8' }] },
    ],
    [
      'the only key in an entry, which leaves the entry, empty',
      { steps: [{ method: 'GET' }, { method: 'POST' }] },
      'steps.0.method',
      { steps: [{}, { method: 'POST' }] },
    ],
    [
      'a key in an object inside an entry, pruning that object and not the entry',
      { steps: [{ path: '/', auth: { user: 'x' } }] },
      'steps.0.auth.user',
      { steps: [{ path: '/' }] },
    ],
    [
      'a key in an entry of an array inside an entry',
      {
        steps: [
          {
            extract: [
              { name: 'a', mode: 'gauge' },
              { name: 'b', mode: 'counter' },
            ],
          },
        ],
      },
      'steps.0.extract.1.mode',
      { steps: [{ extract: [{ name: 'a', mode: 'gauge' }, { name: 'b' }] }] },
    ],
  ] as const)('removes %s', (_label, before, path, after) => {
    expect(
      removeAt(deepFreeze(structuredClone(before)) as Record<string, unknown>, path),
    ).toStrictEqual(after);
  });

  it.each([
    ['a key that is not there', { port: 22 }, 'host'],
    ['under a key that is not there', { port: 22 }, 'auth.user'],
    ['an index past the end', { columns: [{ column: '10', mode: 'counter' }] }, 'columns.3.mode'],
    ['an index into a hole', { columns: HOLEY }, 'columns.0.mode'],
    ['a property name where an array is', { columns: [{ mode: 'gauge' }] }, 'columns.mode'],
    // `Number` reads this as 0; only a plain digit string is a position this form wrote.
    ['an index written another way', { columns: [{ mode: 'gauge' }] }, 'columns.0x0.mode'],
    ['through a string', { auth: 'not an object' }, 'auth.user'],
    ['through a string entry', { tags: ['a', 'b'] }, 'tags.0.length'],
    ['through null', { auth: null }, 'auth.user'],
    // A whole entry is its array's Remove button's to take out; clearing a value never does it.
    ['a whole entry', { tags: ['a', 'b', 'c'] }, 'tags.1'],
    ['a whole object entry', { steps: [{ method: 'GET' }] }, 'steps.0'],
    ['an inherited property', {}, 'toString'],
  ] as const)('removes nothing at %s, and hands back what it was given', (_label, before, path) => {
    const given = deepFreeze(structuredClone(before)) as Record<string, unknown>;
    const result = removeAt(given, path);
    expect(result).toBe(given);
    expect(result).toStrictEqual(before);
  });

  it('copies only what it changes, and never what it was given', () => {
    const untouched = { column: '8', mode: 'gauge' };
    const before = deepFreeze({
      tableOid: '1.3',
      columns: [{ column: '10', mode: 'counter' }, untouched],
    });
    const after = removeAt(before, 'columns.0.mode');
    expect(before.columns[0]).toStrictEqual({ column: '10', mode: 'counter' });
    expect(after['columns']).not.toBe(before.columns);
    expect((after['columns'] as unknown[])[1]).toBe(untouched);
  });

  it('round-trips with writeAt: an entry set and then cleared is the entry it was', () => {
    const before = { columns: [{ column: '6', name: 'Errors' }] };
    const set = writeAt(before, 'columns.0.mode', 'counter');
    expect(readAt(set, 'columns.0.mode')).toBe('counter');
    expect(removeAt(set, 'columns.0.mode')).toStrictEqual(before);
  });
});

describe('writing and reading a path, checked beside removing one (U-39)', () => {
  it.each([
    ['a top-level key', {}, 'port', 22, { port: 22 }],
    [
      'into an existing entry',
      { steps: [{ method: 'GET' }] },
      'steps.0.path',
      '/',
      { steps: [{ method: 'GET', path: '/' }] },
    ],
    ['the next entry, appending', { tags: ['a'] }, 'tags.1', 'b', { tags: ['a', 'b'] }],
    ['the first entry of an empty array', { tags: [] }, 'tags.0', 'a', { tags: ['a'] }],
    [
      'an entry cleared to the empty string (U-41)',
      { tags: ['a', 'b'] },
      'tags.0',
      '',
      {
        tags: ['', 'b'],
      },
    ],
    [
      'an entry of an array inside an entry',
      { steps: [{ extract: [{ name: 'a' }] }] },
      'steps.0.extract.0.mode',
      'gauge',
      { steps: [{ extract: [{ name: 'a', mode: 'gauge' }] }] },
    ],
    [
      'through a string, replacing it with the container the path needs',
      { auth: 'x' },
      'auth.user',
      'u',
      { auth: { user: 'u' } },
    ],
    // Nothing in these to lose, so they are still replaced (`U-43` refuses only a container).
    ['through null', { auth: null }, 'auth.user', 'u', { auth: { user: 'u' } }],
    ['through a string, as an array', { tags: 'a' }, 'tags.0', 'b', { tags: ['b'] }],
    ['through a number, as an array', { tags: 3 }, 'tags.0', 'b', { tags: ['b'] }],
  ] as const)(
    'writes %s, as an array where the path says index',
    (_label, before, path, value, after) => {
      const given = deepFreeze(structuredClone(before)) as Record<string, unknown>;
      const written = writeAt(given, path, value);
      expect(written).toStrictEqual(after);
      expect(readAt(written, path)).toBe(value);
    },
  );

  it.each([
    // Each of these used to write the value with a hole before it, which serialises as `null`.
    ['an index past the end', { tags: ['a'] }, 'tags.4', 'x'],
    ['an index past the end of an empty array', { tags: [] }, 'tags.1', 'x'],
    ['past the end on the way to a key', { steps: [{ method: 'GET' }] }, 'steps.2.method', 'POST'],
    ['past the end of an array the walk created', {}, 'steps.0.headers.1', 'accept: json'],
    ['past the end where no array is yet', {}, 'steps.1.method', 'GET'],
  ] as const)(
    'refuses %s, and hands back what it was given (U-42)',
    (_label, before, path, value) => {
      const given = deepFreeze(structuredClone(before)) as Record<string, unknown>;
      const written = writeAt(given, path, value);
      expect(written).toBe(given);
      expect(written).toStrictEqual(before);
    },
  );

  it.each([
    // Each of these used to replace the container with one of the path's shape, and everything
    // it held went with it: `tags.x` turned `['a', 'b']` into `{x: …}`.
    ['a property name where an array is', { tags: ['a', 'b'] }, 'tags.x', 'v'],
    ['a property name where an empty array is', { tags: [] }, 'tags.x', 'v'],
    ['a property name where an array is, on the way to a key', { tags: ['a'] }, 'tags.x.y', 'v'],
    [
      'a property name where an array inside an entry is',
      { steps: [{ headers: ['accept: json'] }] },
      'steps.0.headers.name',
      'v',
    ],
    ['an index where an object is', { auth: { user: 'u' } }, 'auth.0', 'v'],
    ['an index where an empty object is', { auth: {} }, 'auth.0', 'v'],
    [
      'an index where an object is, on the way to a key',
      { auth: { user: 'u' } },
      'auth.0.user',
      'v',
    ],
    ['an index where an object entry is', { steps: [{ method: 'GET' }] }, 'steps.0.0', 'v'],
  ] as const)(
    'refuses %s, and hands back what it was given (U-43)',
    (_label, before, path, value) => {
      const given = deepFreeze(structuredClone(before)) as Record<string, unknown>;
      const written = writeAt(given, path, value);
      expect(written).toBe(given);
      expect(written).toStrictEqual(before);
    },
  );

  it.each([
    ['an index past the end', { tags: ['a'] }, 'tags.4'],
    ['a property name where an array is', { tags: ['a'] }, 'tags.length.x'],
    ['through a string', { auth: 'x' }, 'auth.user'],
    ['through null', { auth: null }, 'auth.user'],
    ['an index into an object', { steps: { method: 'GET' } }, 'steps.0.method'],
  ] as const)('reads undefined at %s rather than throwing', (_label, source, path) => {
    expect(readAt(source as Record<string, unknown>, path)).toBeUndefined();
  });
});

describe('checking a repeating parameter', () => {
  it('reports the count against minItems and maxItems', () => {
    const steps = fieldsOf(STEPS)[0];
    expect(steps).toBeDefined();
    if (steps === undefined) return;
    expect(problemsFor(steps, []).map((problem) => problem.message)).toEqual(['needs at least 1']);
    expect(problemsFor(steps, [{}, {}, {}, {}]).map((problem) => problem.message)).toEqual([
      'takes at most 3',
    ]);
    expect(problemsFor(steps, [{}])).toEqual([]);
  });

  it('reports a problem inside an entry, at that entry’s own path', () => {
    // Without this a form would submit an array whose entries are missing required properties
    // and learn so from a 400 — the exact round trip this convenience exists to save, missing
    // for the parameter shape that is hardest to type correctly.
    const problems = allProblems(
      fieldsOf(STEPS),
      { steps: [{ method: 'GET' }, { path: '/health' }] },
      readAt,
      fieldsOf,
    );
    expect(problems).toContainEqual({ path: 'steps.1.method', message: 'required' });
    expect(problems.some((problem) => problem.path === 'steps.0.method')).toBe(false);
  });

  it('says nothing about entries that are not there', () => {
    expect(allProblems(fieldsOf(STEPS), {}, readAt, fieldsOf)).toEqual([]);
  });
});

/**
 * Item schemas in the shapes the shipped types declare (`U-41`), written out rather than imported:
 * the web package does not depend on `packages/sensors`.
 */
const ZONE: JsonSchema = { title: 'Blocklist', type: 'string', minLength: 3, maxLength: 253 };
const ARGUMENT: JsonSchema = { title: 'Argument', type: 'string', maxLength: 1_000 };
const DRIVE: JsonSchema = { title: 'Volume', type: 'string', minLength: 1, maxLength: 4 };

const LISTS: JsonSchema = {
  type: 'object',
  required: ['zones'],
  properties: {
    zones: { type: 'array', minItems: 1, title: 'Blocklists', items: ZONE },
    args: { type: 'array', default: [], title: 'Arguments', items: ARGUMENT },
    drives: { type: 'array', default: [], title: 'Volumes', items: DRIVE },
    ports: { type: 'array', title: 'Ports', items: { type: 'integer', minimum: 1 } },
    host: { type: 'string', minLength: 3, title: 'Host' },
    name: { type: 'string', title: 'Name' },
  },
};

const field = (name: string): FieldModel => {
  const found = fieldsOf(LISTS).find((one) => one.name === name);
  if (found === undefined) throw new Error(`no ${name} field`);
  return found;
};

describe('an entry of an array of scalars (U-41)', () => {
  it('is one field at the entry’s own path, required, and marked as an entry', () => {
    const entry = scalarEntryOf(ZONE, field('zones'), 1);
    expect(entry).toMatchObject({
      path: 'zones.1',
      name: '1',
      label: 'Blocklist 2',
      kind: 'string',
      required: true,
      createOnly: false,
      entry: true,
      children: [],
      items: undefined,
    });
    // The parameter's own label where the item names nothing.
    expect(scalarEntryOf({ type: 'integer' }, field('ports'), 0)).toMatchObject({
      label: 'Ports 1',
      kind: 'integer',
      entry: true,
    });
    // Nothing a schema's properties produce is an entry.
    expect(fieldsOf(LISTS).every((one) => !one.entry)).toBe(true);
  });

  it.each([
    // [label, items, array, value, messages]
    [
      'a cleared zone, which minLength refuses',
      ZONE,
      'zones',
      '',
      ['cannot be empty: type a value, or remove the entry'],
    ],
    ['a short zone', ZONE, 'zones', 'ab', ['must be at least 3 characters']],
    ['a zone', ZONE, 'zones', 'zen.spamhaus.org', []],
    ['a zone of spaces, which is three characters to Ajv too', ZONE, 'zones', '   ', []],
    ['a cleared argument, which is an argument', ARGUMENT, 'args', '', []],
    ['an argument of one space', ARGUMENT, 'args', ' ', []],
    [
      'a cleared drive',
      DRIVE,
      'drives',
      '',
      ['cannot be empty: type a value, or remove the entry'],
    ],
    ['a drive too long', DRIVE, 'drives', 'C:\\x\\', ['must be at most 4 characters']],
    ['a hole, which is not a value', ARGUMENT, 'args', undefined, ['required']],
    // A cleared number or JSON entry holds `''` too, and is told what to do (`U-44`).
    [
      'a cleared number',
      { type: 'integer' },
      'ports',
      '',
      ['cannot be empty: type a value, or remove the entry'],
    ],
    [
      'a cleared JSON entry',
      { type: 'object' },
      'ports',
      '',
      ['cannot be empty: type a value, or remove the entry'],
    ],
    ['a JSON entry', { type: 'object' }, 'ports', { a: 1 }, []],
    [
      'a JSON entry that is null, which is not a cleared box',
      { type: 'object' },
      'ports',
      null,
      ['required'],
    ],
    ['a number', { type: 'integer', minimum: 1 }, 'ports', 0, ['must be 1 or more']],
  ] as const)('judges %s', (_label, items, array, value, messages) => {
    const entry = scalarEntryOf(items, field(array), 0);
    expect(problemsFor(entry, value).map((problem) => problem.message)).toEqual(messages);
  });

  it.each([
    // Unchanged for a field that is not an entry: empty is absent, and absent is judged by
    // `required` alone.
    ['an optional string, empty', 'host', '', []],
    ['an optional string of spaces', 'host', '  ', []],
    ['an optional string, short', 'host', 'ab', ['must be at least 3 characters']],
  ] as const)('leaves %s as it was', (_label, name, value, messages) => {
    expect(problemsFor(field(name), value).map((problem) => problem.message)).toEqual(messages);
  });

  it('checks each entry before submit, at the entry’s path, as its control does', () => {
    const problems = allProblems(
      fieldsOf(LISTS),
      { zones: ['zen.spamhaus.org', '', 'ab'], args: ['', '-v'], ports: ['', 2] },
      readAt,
      fieldsOf,
    );
    expect(problems).toStrictEqual([
      { path: 'zones.1', message: 'cannot be empty: type a value, or remove the entry' },
      { path: 'zones.2', message: 'must be at least 3 characters' },
      { path: 'ports.0', message: 'cannot be empty: type a value, or remove the entry' },
    ]);
  });

  it('checks an array of scalars inside an entry of objects', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { headers: { type: 'array', items: { type: 'string', minLength: 1 } } },
          },
        },
      },
    };
    expect(
      allProblems(fieldsOf(schema), { steps: [{ headers: ['a', ''] }] }, readAt, fieldsOf),
    ).toStrictEqual([
      { path: 'steps.0.headers.1', message: 'cannot be empty: type a value, or remove the entry' },
    ]);
  });
});
