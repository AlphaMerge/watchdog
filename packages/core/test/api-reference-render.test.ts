import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The API reference's renderer, against a fixture small enough to read (`P-318`).
 *
 * `build-hygiene.test.ts` already fails when `docs/api-reference.md` drifts from the routes, but
 * that only proves the file is what the renderer makes of them. It cannot see what the renderer
 * leaves out, and the first version left out everything below a route's top-level fields: the
 * `skew.kind` enum on `GET /probes` lacked `ahead` (`P-313`), and the reference could not have
 * shown it. So this pins what must reach the page: a nested enum's values, a nested field's
 * description, `nullable`, `required`, `writeOnly`, and a shared schema rendered once and linked.
 * The review added what still went missing: a field that needs another (`dependencies`), a
 * keyword with no prose, an object's own fields beside a union, and a locale-dependent order.
 */

interface Renderer {
  readonly renderApiReference: (
    doc: unknown,
    options?: { extra?: readonly { path: string; method: string; operation: unknown }[] },
  ) => string;
}

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const rendererUrl = pathToFileURL(
  join(repoRoot, 'scripts', 'docs', 'api-reference-render.mjs'),
).href;
const { renderApiReference } = (await import(rendererUrl)) as Renderer;

const thing = { $ref: '#/components/schemas/def-0' };

/** Shaped the way `@fastify/swagger` writes the document: shared schemas as `def-N` with a title. */
const fixture = {
  openapi: '3.1.0',
  info: { title: 'Fixture' },
  components: {
    schemas: {
      'def-0': {
        title: 'ms:thing',
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          colour: {
            type: 'string',
            enum: ['red', 'blue'],
            description: 'The colour of the thing.',
          },
        },
      },
    },
  },
  paths: {
    '/api/v1/probes': {
      get: {
        tags: ['probes'],
        summary: 'Every probe',
        responses: {
          200: {
            description: 'Default Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['gid'],
                        properties: {
                          gid: { type: 'string' },
                          skew: {
                            type: 'object',
                            required: ['kind'],
                            properties: {
                              kind: {
                                type: 'string',
                                enum: ['current', 'outdated', 'ahead'],
                                description: 'How the two versions compare.',
                              },
                              seenAt: { type: ['null', 'string'], format: 'date-time' },
                            },
                          },
                          thing,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/things': {
      post: {
        tags: ['things'],
        summary: 'Make a thing',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', description: 'What it is called.' },
                  password: { type: 'string', writeOnly: true },
                  owner: thing,
                },
                not: { required: ['name', 'password'] },
                // A keyword the renderer has no prose for: shown raw, never dropped.
                propertyNames: { pattern: '^[a-z]+$' },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Default Response',
            content: { 'application/json': { schema: thing } },
          },
        },
      },
    },
    // `pauseRequestSchema`'s shape (packages/core/src/api/schemas/pause.ts): `from` needs `until`.
    '/api/v1/objects/{id}/pause': {
      post: {
        tags: ['objects'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  minutes: { type: 'integer', minimum: 1 },
                  until: { type: 'string' },
                  from: { type: 'string' },
                  message: { type: 'string' },
                },
                allOf: [
                  { not: { required: ['minutes', 'until'] } },
                  { not: { required: ['minutes', 'from'] } },
                ],
                dependencies: { from: ['until'] },
              },
            },
          },
        },
        responses: { 200: { description: 'Default Response' } },
      },
    },
    // A union beside fields of its own, and one with nothing beside it.
    '/api/v1/readings': {
      get: {
        tags: ['readings'],
        responses: {
          200: {
            description: 'Default Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['at'],
                  minProperties: 2,
                  properties: { at: { type: 'string', description: 'When it was read.' } },
                  additionalProperties: { type: 'integer' },
                  oneOf: [
                    {
                      type: 'object',
                      properties: { kind: { const: 'up' }, since: { type: 'string' } },
                    },
                    {
                      type: 'object',
                      properties: { kind: { const: 'down' }, reason: { type: 'string' } },
                    },
                  ],
                },
              },
            },
          },
          202: {
            description: 'Default Response',
            content: {
              'application/json': {
                schema: {
                  anyOf: [
                    { type: 'object', properties: { left: { type: 'integer' } } },
                    { type: 'object', properties: { right: { type: 'integer' } } },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Tags and schema names that a locale collates differently from code points: Czech sorts `ch`
 * as one letter after `h`, so `localeCompare` under `cs_CZ` puts `h` first.
 */
const collated = {
  openapi: '3.1.0',
  info: { title: 'Collation' },
  components: {
    schemas: {
      'def-0': { title: 'ms:h', type: 'object', properties: { a: { type: 'string' } } },
      'def-1': { title: 'ms:ch', type: 'object', properties: { b: { type: 'string' } } },
    },
  },
  paths: {
    '/api/v1/h': {
      get: {
        tags: ['h'],
        responses: {
          200: {
            description: 'Default Response',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/def-0' } } },
          },
        },
      },
    },
    '/api/v1/ch': {
      get: {
        tags: ['ch'],
        responses: {
          200: {
            description: 'Default Response',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/def-1' } } },
          },
        },
      },
    },
  },
};

const page = renderApiReference(fixture);

/** The table row for a field path. Asserted present before anything is read off it. */
function rowFor(path: string): string {
  const row = page.split('\n').find((line) => line.startsWith(`| \`${path}\` |`));
  assert.ok(row !== undefined, `no row for ${path} in:\n${page}`);
  return row;
}

const count = (needle: string): number => page.split(needle).length - 1;

describe('the API reference renderer', () => {
  it('lists a field three levels down, with every value of its enum', () => {
    const row = rowFor('items[].skew.kind');
    for (const value of ['current', 'outdated', 'ahead'])
      assert.ok(row.includes(`\`${value}\``), row);
    assert.ok(row.includes('**required**'), row);
  });

  it("carries a nested field's description", () => {
    assert.ok(rowFor('items[].skew.kind').includes('How the two versions compare.'));
    assert.ok(rowFor('name').includes('What it is called.'));
  });

  it('marks nullable and required, and keeps the format', () => {
    const row = rowFor('items[].skew.seenAt');
    assert.ok(row.includes('nullable'), row);
    assert.ok(row.includes('string (date-time)'), row);
    assert.equal(row.includes('null or'), false, `null is a flag, not a type: ${row}`);
    assert.ok(rowFor('name').includes('**required**'));
    assert.equal(rowFor('password').includes('**required**'), false);
  });

  it('marks a write-only field', () => {
    assert.ok(rowFor('password').includes('**write-only**'));
    assert.equal(rowFor('name').includes('write-only'), false);
  });

  it('renders a shared schema once, under Schemas, and links it from each use', () => {
    const link = '[ms:thing](#schema-ms-thing)';
    assert.ok(rowFor('items[].thing').includes(link));
    assert.ok(rowFor('owner').includes(link));
    assert.ok(page.includes(`**201** is ${link}`), page);
    assert.equal(count('<a id="schema-ms-thing"></a>'), 1);
    assert.ok(page.includes('## Schemas'));
    // Its fields are not repeated where it is used: three uses, one description.
    assert.equal(count('The colour of the thing.'), 1);
    assert.ok(rowFor('colour').includes('`red` · `blue`'));
    assert.equal(count('items[].thing.'), 0);
  });

  it('says which fields may not appear together', () => {
    assert.ok(page.includes('- `name` and `password` are not allowed together'), page);
  });

  it('says which field needs another, as the pause body does', () => {
    rowFor('from');
    assert.ok(page.includes('- `from` requires `until`'), page);
    assert.ok(page.includes('- `minutes` and `from` are not allowed together'), page);
  });

  it('shows a keyword it has no prose for, rather than dropping it', () => {
    assert.ok(page.includes('- `propertyNames`: `{"pattern":"^[a-z]+$"}`'), page);
  });

  it("lists an object's own fields, map and rules beside the alternatives of its union", () => {
    assert.ok(rowFor('at').includes('When it was read.'));
    assert.ok(rowFor('at').includes('**required**'));
    assert.ok(rowFor('*').includes('integer'));
    assert.ok(page.includes('- at least 2 fields must be given'), page);
    rowFor('{kind=up}');
    rowFor('{kind=up}.since');
    rowFor('{kind=down}.reason');
    // Shared fields read first: they hold whichever alternative matches.
    assert.ok(page.indexOf('| `at` |') < page.indexOf('| `{kind=up}` |'));
  });

  it('lists each alternative of a union with nothing beside it', () => {
    rowFor('{#1}.left');
    rowFor('{#2}.right');
  });

  it('keeps the summary line build-hygiene reads response fields from', () => {
    assert.ok(page.split('\n').includes('**200** { items }'), page);
  });

  it('renders the same document to the same page', () => {
    assert.equal(renderApiReference(structuredClone(fixture)), page);
  });

  it('refuses a reference the document does not define', () => {
    const broken = structuredClone(fixture);
    broken.paths['/api/v1/things'].post.responses[201].content['application/json'].schema = {
      $ref: '#/components/schemas/def-9',
    };
    assert.throws(() => renderApiReference(broken), /def-9/);
  });

  it('orders tags and schemas by code point', () => {
    const ordered = renderApiReference(collated);
    const at = (needle: string): number => {
      const index = ordered.indexOf(needle);
      assert.ok(index >= 0, `${needle} is not on the page:\n${ordered}`);
      return index;
    };
    assert.ok(at('## ch\n') < at('## h\n'));
    assert.ok(at('### `ms:ch`') < at('### `ms:h`'));
  });

  /**
   * `localeCompare` takes its collation from `LANG`, so a page generated under `cs_CZ.UTF-8`
   * differed from the committed one and `--check` failed there. The same render in a process
   * whose default locale is Czech must give the same page.
   */
  it('renders the same page whatever the default locale', () => {
    const script =
      `const { renderApiReference } = await import(${JSON.stringify(rendererUrl)});` +
      `const doc = JSON.parse(process.argv[1]);` +
      `process.stdout.write(JSON.stringify({ probe: 'ch'.localeCompare('h'), page: renderApiReference(doc) }));`;
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(collated)],
      {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'cs_CZ.UTF-8', LC_ALL: 'cs_CZ.UTF-8' },
        timeout: 30_000,
      },
    );
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const answer = JSON.parse(run.stdout) as { probe: number; page: string };
    // Without this the test proves nothing: the child must really collate the Czech way.
    assert.ok(answer.probe > 0, 'the child process did not take the Czech locale');
    assert.equal(answer.page, renderApiReference(collated));
  });
});
