import { strict as assert } from 'node:assert';
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
 */

interface Renderer {
  readonly renderApiReference: (
    doc: unknown,
    options?: { extra?: readonly { path: string; method: string; operation: unknown }[] },
  ) => string;
}

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const { renderApiReference } = (await import(
  pathToFileURL(join(repoRoot, 'scripts', 'docs', 'api-reference-render.mjs')).href
)) as Renderer;

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
});
