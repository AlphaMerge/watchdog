import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { referenceMarks } from './support/api-reference-marks.js';

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
  readonly absentFromRelease: (
    doc: unknown,
    extra: readonly { path: string; method: string }[],
    routers: { registered: Iterable<string>; release: Iterable<string>; name: string },
  ) => string[];
  readonly routeKeyOf: (method: string, url: string) => string;
  readonly renderApiReference: (
    doc: unknown,
    options?: {
      extra?: readonly { path: string; method: string; operation: unknown }[];
      release?: { name: string; absent: readonly string[] };
    },
  ) => string;
}

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const rendererUrl = pathToFileURL(
  join(repoRoot, 'scripts', 'docs', 'api-reference-render.mjs'),
).href;
const { absentFromRelease, renderApiReference, routeKeyOf } = (await import(
  rendererUrl
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
                // The second as the pause body has it since `P-383`, its names declared `true`
                // for strict mode; the third declares one with a type, which does constrain.
                allOf: [
                  { not: { required: ['minutes', 'until'] } },
                  {
                    not: {
                      properties: { minutes: true, from: true },
                      required: ['minutes', 'from'],
                    },
                  },
                  { not: { properties: { message: { type: 'string' } }, required: ['message'] } },
                ],
                dependencies: { from: ['until'] },
              },
            },
          },
        },
        responses: { 200: { description: 'Default Response' } },
      },
    },
    // Every constraint keyword, on parameters, on fields, on array elements and on a union
    // (`P-337`). Field names say what each carries, so a failure names the one that went missing.
    '/api/v1/limits/{port}': {
      put: {
        tags: ['limits'],
        parameters: [
          {
            name: 'port',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1, maximum: 65535 },
          },
          {
            name: 'tag',
            in: 'query',
            schema: {
              oneOf: [
                { type: 'string', maxLength: 40 },
                { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 10 },
              ],
            },
          },
          // The same as a type list, as `tag` and `effective` are declared (`P-347`).
          {
            name: 'keys',
            in: 'query',
            schema: {
              type: ['string', 'array'],
              items: { type: 'string', maxLength: 20 },
              maxLength: 20,
              maxItems: 7,
            },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
                  draft4: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10 },
                  floor: { type: 'integer', minimum: 0 },
                  ceiling: { type: 'integer', maximum: 5 },
                  pinned: { type: 'integer', minimum: 3, maximum: 3 },
                  step: { type: 'integer', multipleOf: 5 },
                  label: { type: 'string', maxLength: 255 },
                  login: { type: 'string', minLength: 1, maxLength: 64 },
                  passphrase: { type: 'string', minLength: 12 },
                  code: { type: 'string', minLength: 6, maxLength: 6 },
                  slug: { type: 'string', pattern: '^[a-z]+$' },
                  ticked: { type: 'string', pattern: 'a`b' },
                  said: {
                    type: 'string',
                    pattern: '^[0-9]+$',
                    'x-patternMessage': 'must be digits, such as 7 or 42',
                  },
                  saidEach: {
                    type: 'array',
                    items: {
                      type: 'string',
                      pattern: '^[a-z]+$',
                      'x-patternMessage': 'must be lowercase letters',
                    },
                  },
                  names: {
                    type: 'array',
                    items: { type: 'string', minLength: 1, maxLength: 100 },
                    minItems: 1,
                    uniqueItems: true,
                  },
                  few: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
                  maybe: { type: ['string', 'null'], maxLength: 8 },
                  stamp: { type: 'string', format: 'date-time' },
                  odd: { type: 'string', contentEncoding: 'base64' },
                },
              },
            },
          },
        },
        responses: { 204: { description: 'Default Response' } },
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

const operation = (tag: string, summary: string): object => ({
  tags: [tag],
  summary,
  responses: {},
});

/**
 * A release that lacks one tag whole, one route of another, and nothing of a third, the way the
 * v1 build lacks maps, libraries and reports (`H-51`). The live map is a route the document does
 * not carry, as the WebSocket stream is.
 */
const released = {
  openapi: '3.1.0',
  info: { title: 'Release' },
  tags: [{ name: 'maps', description: 'Maps, and what is on them.' }],
  paths: {
    '/api/v1/maps': { get: operation('maps', 'Every map'), post: operation('maps', 'A new map') },
    '/api/v1/maps/{id}': { get: operation('maps', 'One map') },
    '/api/v1/probes': { get: operation('probes', 'Every probe') },
    '/api/v1/probes/{gid}': {
      get: operation('probes', 'One probe'),
      delete: operation('probes', 'Forget a probe'),
    },
    '/api/v1/state': { get: operation('state', 'Every state') },
  },
};
const liveMap = {
  path: '/api/v1/maps/{id}/live',
  method: 'get',
  operation: { tags: ['maps'], summary: 'A map as it changes', responses: {} },
};
const lacking = [
  'get /api/v1/maps',
  'post /api/v1/maps',
  'get /api/v1/maps/{id}',
  'get /api/v1/maps/{id}/live',
  'delete /api/v1/probes/{gid}',
];
const releasePage = renderApiReference(released, {
  extra: [liveMap],
  release: { name: '1.0', absent: lacking },
});
const MARK = '**Not in 1.0 — v2, in the full build only.**';

/** The lines of a `## tag` section of the release page, its heading first. */
function sectionOf(tag: string): string[] {
  const lines = releasePage.split('\n');
  const start = lines.indexOf(`## ${tag}`);
  assert.ok(start >= 0, `no ${tag} section in:\n${releasePage}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The first line after `heading` in `lines` that is not blank. */
function after(lines: readonly string[], heading: string): string {
  const index = lines.indexOf(heading);
  assert.ok(index >= 0, `no ${heading} in:\n${lines.join('\n')}`);
  return lines.slice(index + 1).find((line) => line !== '') ?? '';
}

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

  it('reads a `properties` that only declares its required names as saying nothing (P-383)', () => {
    // The `true`s are there for strict mode, so the rule reads as it did without them; a
    // `properties` that constrains is still shown raw, so this is not a renderer that drops them.
    assert.ok(page.includes('- `minutes` and `until` are not allowed together'), page);
    assert.ok(page.includes('- `minutes` and `from` are not allowed together'), page);
    assert.ok(
      page.includes(
        '- `{"not":{"properties":{"message":{"type":"string"}},"required":["message"]}}`',
      ),
      page,
    );
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

  describe('says the constraints in words (P-337)', () => {
    /** The type cell of a field's row: what the constraints are rendered into. */
    const typeOf = (path: string): string => rowFor(path).split(' | ')[1] ?? '';
    const parameterRow = (name: string): string => {
      const row = page
        .split('\n')
        .find((line) =>
          ['path', 'query'].some((where) => line.startsWith(`| \`${name}\` | ${where} |`)),
        );
      assert.ok(row !== undefined, `no parameter row for ${name} in:\n${page}`);
      return row;
    };

    it('a numeric range, inclusive or not, in either draft', () => {
      assert.equal(parameterRow('port').split(' | ')[2], 'integer, 1–65535');
      assert.equal(typeOf('ratio'), 'number, more than 0 and less than 1');
      assert.equal(typeOf('draft4'), 'number, more than 0 and at most 10');
      assert.equal(typeOf('floor'), 'integer, at least 0');
      assert.equal(typeOf('ceiling'), 'integer, at most 5');
      assert.equal(typeOf('pinned'), 'integer, exactly 3');
    });

    it('a multiple', () => {
      assert.equal(typeOf('step'), 'integer, a multiple of 5');
    });

    it('a length in characters', () => {
      assert.equal(typeOf('label'), 'string, at most 255 characters');
      assert.equal(typeOf('login'), 'string, 1–64 characters');
      assert.equal(typeOf('passphrase'), 'string, at least 12 characters');
      assert.equal(typeOf('code'), 'string, exactly 6 characters');
    });

    it('a pattern, as code even when it holds a backtick', () => {
      assert.equal(typeOf('slug'), 'string, matches `^[a-z]+$`');
      assert.equal(typeOf('ticked'), 'string, matches ``a`b``');
    });

    it('a pattern’s sentence beside it, in brackets, and never as a raw keyword (P-372)', () => {
      assert.equal(typeOf('said'), 'string, matches `^[0-9]+$` (must be digits, such as 7 or 42)');
      assert.equal(
        typeOf('saidEach'),
        'string[], each matches `^[a-z]+$` (must be lowercase letters)',
      );
      assert.ok(!page.includes('`x-patternMessage`'), 'the keyword is not printed as unknown');
    });

    it("an array's count, its uniqueness and its elements' own", () => {
      assert.equal(
        typeOf('names'),
        'string[], at least 1 item, unique items, each 1–100 characters',
      );
      assert.equal(typeOf('few'), 'integer[], at most 3 items');
    });

    it('a parameter that takes one value or several, its elements said once', () => {
      assert.equal(
        parameterRow('tag').split(' | ')[2],
        'string, or an array of them, at most 40 characters, at most 10 items',
      );
    });

    it("the same as a type list, the array's elements and count said too (P-347)", () => {
      assert.equal(
        parameterRow('keys').split(' | ')[2],
        'string or string[], at most 20 characters, at most 7 items, each at most 20 characters',
      );
    });

    it('beside nullable and format, which keep their places', () => {
      assert.equal(typeOf('maybe'), 'string, at most 8 characters');
      assert.ok(rowFor('maybe').includes('nullable'));
      assert.equal(typeOf('stamp'), 'string (date-time)');
    });

    it('and a keyword it has no words for, raw rather than dropped', () => {
      assert.equal(typeOf('odd'), 'string, `contentEncoding`: `base64`');
    });
  });

  describe('marks what a release lacks, where a reader meets it (`H-51`)', () => {
    it('in the count: how many, and under which tags', () => {
      assert.ok(
        releasePage
          .split('\n')
          .includes(
            '8 routes. 5 of them are not in 1.0 — v2, in the full build only: every route ' +
              'under **maps** and 1 of the 3 under **probes**. A 1.0 core registers the other 3.',
          ),
        releasePage,
      );
    });

    it('under the heading of a tag it has none of, before the tag’s own description', () => {
      const section = sectionOf('maps');
      const note = after(section, '## maps');
      assert.ok(
        note.startsWith(`${MARK} The 1.0 build leaves out the subsystem these 4 routes`),
        note,
      );
      assert.ok(note.includes('`404` `ROUTE_NOT_FOUND`'), note);
      assert.ok(
        note.includes("the core's own `GET /api/v1/openapi.json` does not list them"),
        note,
      );
      assert.equal(after(section, note), 'Maps, and what is on them.');
      // Once for the tag, and not again on each of its routes, the live map among them.
      assert.equal(section.filter((line) => line.includes(MARK)).length, 1, section.join('\n'));
      assert.equal(after(section, '### `GET /api/v1/maps/{id}/live`'), 'A map as it changes');
    });

    it('under the heading of a route it lacks, in a tag it has the rest of', () => {
      const section = sectionOf('probes');
      assert.equal(after(section, '## probes').startsWith(MARK), false, 'the tag is marked');
      assert.ok(
        after(section, '### `DELETE /api/v1/probes/{gid}`').startsWith(
          `${MARK} A 1.0 core does not register this route`,
        ),
        section.join('\n'),
      );
      assert.equal(after(section, '### `GET /api/v1/probes/{gid}`'), 'One probe');
      assert.equal(after(section, '### `GET /api/v1/probes`'), 'Every probe');
      assert.equal(section.filter((line) => line.includes(MARK)).length, 1, section.join('\n'));
    });

    it('nowhere in a tag it has all of', () => {
      assert.equal(
        sectionOf('state').some((line) => line.includes('Not in')),
        false,
        sectionOf('state').join('\n'),
      );
    });

    it('as the tests that read the shipped page read them, a tag’s mark and a route’s alike', () => {
      // `candidate-surface.test.ts` and `release-docs.test.ts` read the shipped page's marks with
      // this reader. The shipped page marks no route alone today, so only this holds that case.
      const marks = referenceMarks(releasePage);
      const keyed = (marked: boolean): string[] =>
        [...marks]
          .filter(([, mark]) => mark === marked)
          .map(([key]) => key)
          .sort();
      assert.deepEqual(
        keyed(true),
        lacking.map((key) => key.replace(/^[a-z]+/u, (method) => method.toUpperCase())).sort(),
      );
      assert.deepEqual(keyed(false), [
        'GET /api/v1/probes',
        'GET /api/v1/probes/{gid}',
        'GET /api/v1/state',
      ]);
    });

    it('in what it says the live document lists', () => {
      assert.ok(
        releasePage.includes(
          'it lists the routes that installation registers. This page is rendered from the full ' +
            'build, marks the routes a 1.0 core does not have, and is for reading.',
        ),
        releasePage,
      );
    });

    it('and the page it always made when the release lacks nothing', () => {
      const whole = renderApiReference(released, {
        extra: [liveMap],
        release: { name: '1.0', absent: [] },
      });
      assert.equal(whole, renderApiReference(released, { extra: [liveMap] }));
      assert.ok(whole.split('\n').includes('8 routes.'), whole);
      assert.equal(whole.includes('Not in'), false);
    });

    it('from what each router registered, the stream beside the document included', () => {
      const registered = [
        ['GET', '/api/v1/maps'],
        ['POST', '/api/v1/maps'],
        ['GET', '/api/v1/maps/:id'],
        ['GET', '/api/v1/maps/:id/live'],
        ['GET', '/api/v1/probes'],
        ['GET', '/api/v1/probes/:gid'],
        ['DELETE', '/api/v1/probes/:gid'],
        ['GET', '/api/v1/state'],
      ].map(([method = '', url = '']) => routeKeyOf(method, url));
      assert.equal(registered[2], 'get /api/v1/maps/{id}', 'spelled as the document spells it');
      const release = ['get /api/v1/probes', 'get /api/v1/probes/{gid}', 'get /api/v1/state'];
      // In the order the document lists them, the routes beside it last.
      assert.deepEqual(
        absentFromRelease(released, [liveMap], { registered, release, name: '1.0' }),
        [
          'get /api/v1/maps',
          'post /api/v1/maps',
          'get /api/v1/maps/{id}',
          'delete /api/v1/probes/{gid}',
          'get /api/v1/maps/{id}/live',
        ],
      );
      // A release with everything lacks nothing.
      assert.deepEqual(
        absentFromRelease(released, [liveMap], { registered, release: registered, name: '1.0' }),
        [],
      );
    });

    it('refuses to compare routers that do not match the document, either way', () => {
      const registered = [
        ...lacking,
        'get /api/v1/probes',
        'get /api/v1/probes/{gid}',
        'get /api/v1/state',
      ];
      // Only the release registers it, so the page rendered from the other build leaves it out.
      assert.throws(
        () =>
          absentFromRelease(released, [liveMap], {
            registered,
            release: ['get /api/v1/state', 'get /api/v1/alarms'],
            name: '1.0',
          }),
        /1\.0 registers get \/api\/v1\/alarms, which the page's build does not/u,
      );
      // Spelled so that its own router's registration cannot be found, it cannot be looked up.
      assert.throws(
        () =>
          absentFromRelease(released, [liveMap], {
            registered: registered.filter((key) => key !== 'get /api/v1/maps/{id}'),
            release: ['get /api/v1/state'],
            name: '1.0',
          }),
        /the document lists get \/api\/v1\/maps\/\{id\}, which its router did not register/u,
      );
    });

    it('refuses to mark a route the document does not carry', () => {
      assert.throws(
        () =>
          renderApiReference(released, {
            release: { name: '1.0', absent: ['get /api/v1/maps', 'get /api/v1/nowhere'] },
          }),
        /lack get \/api\/v1\/nowhere, which the document does not carry/u,
      );
    });
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
   * Registering every route used to print Ajv's "strict mode: use allowUnionTypes" three times,
   * for `tag` and `effective` (`P-337`). A warning printed on every run is one nobody reads, and
   * the next one hides behind it, so generating the document now prints nothing at all to
   * stderr: any strict-mode warning, from any schema, fails here.
   */
  it('builds the document from the real routes without a warning', () => {
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'docs', 'api-reference.mjs'), '--openapi'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', 'generating the API reference printed to stderr');
    assert.ok(run.stdout.includes('"openapi"'), 'no document was printed');
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
