import { describe, expect, it } from 'vitest';
import {
  defaultFor,
  fieldsOf,
  labelFor,
  readAt,
  removeAt,
  writeAt,
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
        ports: { type: 'array', items: { type: 'integer' } },
        blob: { type: 'object' },
        weird: {},
      },
    });
    expect(fields.map((field) => field.kind)).toEqual(['json', 'json', 'json']);
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
