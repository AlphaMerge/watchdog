import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import Fastify, {
  type FastifyInstance,
  type FastifySchema,
  type FastifySchemaValidationError,
} from 'fastify';
import type { BuildStamp } from '@ms/shared';
import {
  createObjectSchema,
  createTreeSchema,
  treeNodeSchema,
  updateObjectSchema,
} from '../src/api/schemas/objects.js';
import { acknowledgeRequestSchema, pauseRequestSchema } from '../src/api/schemas/pause.js';
import { API_VALIDATOR_OPTIONS, requestProblem } from '../src/api/validation.js';
import { responseSchemaAjv } from './support/response-schema-ajv.js';
import {
  surfaceServer,
  type RouteKey,
  type SurfaceRoute,
  type SurfaceServer,
} from './support/surface.js';

/**
 * The API's request validator runs Ajv strict (`P-383`), as every other Ajv in the source does
 * since `P-379`: a route schema with a keyword Ajv cannot read whole stops the build.
 */

const STAMP: BuildStamp = {
  version: '0.0.0-dev',
  commit: null,
  dirty: false,
  profile: 'full',
  lock: null,
};

/** The validator's options as they were before `P-383`: Ajv's default strictness. */
function lax(): Record<string, unknown> {
  const { strict: _strict, ...rest } = API_VALIDATOR_OPTIONS;
  return { ...rest };
}

/** Fastify's error for one route's schema at `ready()`, or null when every route registered. */
async function registrationError(
  customOptions: Record<string, unknown>,
  schema: FastifySchema,
): Promise<string | null> {
  const app = Fastify({ ajv: { customOptions } });
  app.post('/x', { schema }, () => ({}));
  try {
    await app.ready();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await app.close();
  }
}

/**
 * Each response schema and shared schema a route can reach, compiled as the request validator
 * would read it, with what refused it: `fast-json-stringify` compiles them with `strictSchema` off,
 * so nothing at registration would.
 */
function uncompilable(routes: readonly SurfaceRoute[]): { refused: string[]; compiled: number } {
  const refused: string[] = [];
  let compiled = 0;
  for (const route of routes) {
    const responses = ((route.schema as { response?: unknown } | undefined)?.response ??
      {}) as Record<string, object>;
    const ajv = responseSchemaAjv();
    for (const shared of Object.values(route.shared)) ajv.addSchema(shared as object);
    const each: [string, () => unknown][] = [
      ...Object.entries(responses).map(([status, schema]): [string, () => unknown] => [
        `${route.key} response ${status}`,
        () => ajv.compile(schema),
      ]),
      ...Object.keys(route.shared).map((id): [string, () => unknown] => [
        `${route.key} shared ${id}`,
        () => ajv.getSchema(id),
      ]),
    ];
    for (const [where, compile] of each) {
      try {
        compile();
        compiled += 1;
      } catch (error) {
        refused.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { refused, compiled };
}

/**
 * A deep copy with every `properties` that declares only `true` taken out: the schema as it was
 * before `P-383` declared what a `then` or a `not` requires. No schema had such a `properties`
 * before, so this undoes exactly that and nothing else.
 */
function undeclared(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(undeclared);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(
        ([key, value]) =>
          !(
            key === 'properties' &&
            typeof value === 'object' &&
            value !== null &&
            Object.values(value).length > 0 &&
            Object.values(value).every((one) => one === true)
          ),
      )
      .map(([key, value]) => [key, undeclared(value)]),
  );
}

describe('the API validates requests under strict mode (P-383)', () => {
  let surface: SurfaceServer;

  before(async () => {
    surface = await surfaceServer(STAMP, { required: false, v2: 'stubbed' });
  });

  after(async () => {
    await surface.close();
  });

  it('runs strict', () => {
    assert.equal(API_VALIDATOR_OPTIONS.strict, true);
  });

  it('builds every route of a full core with every v2 route under it', () => {
    // `surfaceServer` awaits `ready()`, which is where Fastify compiles each request schema, so a
    // route strict mode refuses would have failed `before`. The routes whose schemas it refused
    // until `P-383` are named, so this is not a build that left them out.
    const changed: readonly RouteKey[] = [
      'POST /api/v1/objects',
      'POST /api/v1/objects/tree',
      'PATCH /api/v1/objects/{id}',
      'POST /api/v1/objects/{id}/pause',
      'POST /api/v1/objects/{id}/acknowledge',
    ];
    for (const route of changed) assert.ok(surface.registered.includes(route), route);
    assert.ok(surface.registered.length > 100, String(surface.registered.length));
  });

  it('every response schema and every shared schema compiles strict too', () => {
    const { refused, compiled } = uncompilable(surface.routes);
    assert.deepEqual(refused, []);
    assert.ok(compiled > surface.routes.length, `only ${String(compiled)} compiled`);
  });

  it('and a mistyped keyword in a response schema is found by that walk', () => {
    // The control: `fast-json-stringify` would serialise this without a word.
    const typo: SurfaceRoute = {
      key: 'GET /typo',
      schema: {
        response: {
          200: { type: 'object', properties: { name: { type: 'string', maxLenght: 5 } } },
        },
      },
      shared: {},
    };
    const { refused } = uncompilable([typo]);
    assert.equal(refused.length, 1, refused.join('\n'));
    assert.match(refused[0] ?? '', /GET \/typo response 200: .*unknown keyword: "maxLenght"/u);
  });
});

describe('a route schema strict mode refuses stops the build (P-383)', () => {
  const body = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    body: { type: 'object', properties, ...extra },
  });

  it('a mistyped keyword', async () => {
    const schema = body({ name: { type: 'string', maxLenght: 5 } });
    assert.match(
      (await registrationError({ ...API_VALIDATOR_OPTIONS }, schema)) ?? '',
      /unknown keyword: "maxLenght"/u,
    );
  });

  it('a mistyped keyword in a querystring and a params schema alike', async () => {
    for (const part of ['querystring', 'params'] as const) {
      const schema = {
        [part]: { type: 'object', properties: { id: { type: 'string', minimun: 1 } } },
      };
      assert.match(
        (await registrationError({ ...API_VALIDATOR_OPTIONS }, schema)) ?? '',
        /unknown keyword: "minimun"/u,
        part,
      );
    }
  });

  it('a keyword with no type to apply to', async () => {
    const schema = body({ count: { minimum: 1 } });
    assert.match(
      (await registrationError({ ...API_VALIDATOR_OPTIONS }, schema)) ?? '',
      /missing type "number" for keyword "minimum"/u,
    );
  });

  it('a required name its schema does not declare', async () => {
    const schema = body({ minutes: { type: 'integer' } }, { not: { required: ['minutes'] } });
    assert.match(
      (await registrationError({ ...API_VALIDATOR_OPTIONS }, schema)) ?? '',
      /required property "minutes" is not defined .*strictRequired/u,
    );
  });

  it('where Ajv’s default refused only the first, and registered the other two', async () => {
    // The control: without `strict` the mistyped keyword is still refused (Ajv's `strictSchema`
    // defaults on), but a keyword with no type is only logged and an undeclared `required` is
    // not checked, so those two are the ones this ticket's option refuses.
    const quiet = { ...lax(), logger: false };
    assert.match(
      (await registrationError(quiet, body({ name: { type: 'string', maxLenght: 5 } }))) ?? '',
      /unknown keyword: "maxLenght"/u,
    );
    assert.equal(await registrationError(quiet, body({ count: { minimum: 1 } })), null);
    assert.equal(
      await registrationError(
        quiet,
        body({ minutes: { type: 'integer' } }, { not: { required: ['minutes'] } }),
      ),
      null,
    );
  });
});

/**
 * The five schemas strict mode refused, each given `properties` of `true` beside a `required` in a
 * `then` or a `not`. `true` constrains nothing, so each must accept and refuse what it did, with
 * the same problems: the request a client sends, the answer it gets back.
 */
describe('the schemas P-383 changed accept and refuse as before', () => {
  interface Answer {
    readonly valid: boolean;
    readonly body: unknown;
    readonly problems: readonly unknown[];
  }

  const SHARED = [createObjectSchema, treeNodeSchema, createTreeSchema, updateObjectSchema];

  /** One route per changed schema, its validation attached so the answer carries the problems. */
  async function validator(
    customOptions: Record<string, unknown>,
    shape: (schema: unknown) => unknown,
  ): Promise<FastifyInstance> {
    const app = Fastify({ ajv: { customOptions } });
    for (const shared of SHARED) app.addSchema(shape(shared));
    const routes: [string, unknown][] = [
      ['/create', { $ref: 'ms:createObject' }],
      ['/tree', { $ref: 'ms:createTree' }],
      ['/update', { $ref: 'ms:updateObject' }],
      ['/pause', shape(pauseRequestSchema)],
      ['/acknowledge', shape(acknowledgeRequestSchema)],
    ];
    for (const [url, schema] of routes) {
      app.post(url, { schema: { body: schema }, attachValidation: true }, (request) => ({
        valid: request.validationError === undefined,
        body: request.body,
        problems: (
          (request.validationError?.validation ?? []) as FastifySchemaValidationError[]
        ).map(requestProblem),
      }));
    }
    await app.ready();
    return app;
  }

  let now: FastifyInstance;
  let then: FastifyInstance;

  before(async () => {
    now = await validator({ ...API_VALIDATOR_OPTIONS }, (schema) => schema);
    then = await validator({ ...lax(), logger: false }, undeclared);
  });

  after(async () => {
    await now.close();
    await then.close();
  });

  const SENSOR = 'core.ping';
  const create = (node: Record<string, unknown>) => ({ parentId: 1, name: 'n', ...node });
  const node = (fields: Record<string, unknown>) => ({ name: 'n', ...fields });

  /** `[url, body, valid]`: what each case is, so a change that refused everything is caught. */
  const CASES: readonly [string, Record<string, unknown>, boolean][] = [
    ['/create', create({ kind: 'device', host: 'h' }), true],
    ['/create', create({ kind: 'device' }), false],
    ['/create', create({ kind: 'device', host: 'h', sensorType: SENSOR }), false],
    ['/create', create({ kind: 'device', host: 'h', gid: 'g' }), false],
    ['/create', create({ kind: 'sensor', sensorType: SENSOR }), true],
    ['/create', create({ kind: 'sensor' }), false],
    ['/create', create({ kind: 'sensor', sensorType: SENSOR, host: 'h' }), false],
    ['/create', create({ kind: 'group' }), true],
    ['/create', create({ kind: 'group', host: 'h' }), false],
    ['/create', create({ kind: 'group', sensorType: SENSOR }), false],
    ['/create', create({ kind: 'group', gid: 'g' }), false],
    ['/create', create({ kind: 'probe', gid: 'g' }), true],
    ['/create', create({ kind: 'probe', host: 'h', sensorType: SENSOR }), false],
    ['/tree', { parentId: 1, nodes: [node({ kind: 'device', host: 'h' })] }, true],
    [
      '/tree',
      {
        parentId: 1,
        nodes: [
          node({ kind: 'device', ref: 'd' }),
          node({ kind: 'sensor', parentRef: 'd', host: 'h' }),
          node({ kind: 'group', gid: 'g', sensorType: SENSOR }),
        ],
      },
      false,
    ],
    [
      '/tree',
      {
        parentId: 1,
        nodes: [
          node({ kind: 'probe', gid: 'g', ref: 'p' }),
          node({ kind: 'sensor', parentRef: 'p', sensorType: SENSOR }),
        ],
      },
      true,
    ],
    ['/update', { kind: 'group', name: 'x' }, true],
    ['/update', { kind: 'group', host: 'h' }, false],
    ['/update', { kind: 'probe', params: {} }, false],
    ['/update', { kind: 'probe', gid: 'g' }, true],
    ['/update', { kind: 'root', gid: 'g' }, false],
    ['/update', { kind: 'device', host: 'h' }, true],
    ['/update', { kind: 'device', params: {} }, false],
    ['/update', { kind: 'sensor', params: {} }, true],
    ['/update', { kind: 'sensor', host: 'h' }, false],
    ['/update', { kind: 'sensor', ipVersion: 'v4' }, false],
    ['/pause', {}, true],
    ['/pause', { minutes: 5 }, true],
    ['/pause', { until: 'later' }, true],
    ['/pause', { from: 'soon', until: 'later' }, true],
    ['/pause', { minutes: 5, until: 'later' }, false],
    ['/pause', { minutes: 5, from: 'soon', until: 'later' }, false],
    ['/pause', { from: 'soon' }, false],
    ['/pause', { minutes: '5', message: 'm' }, true],
    ['/acknowledge', {}, true],
    ['/acknowledge', { minutes: 5 }, true],
    ['/acknowledge', { until: 'later' }, true],
    ['/acknowledge', { minutes: 5, until: 'later' }, false],
  ];

  it('the copy the comparison is made with is the schemas as they were, which strict refuses', async () => {
    // The control: `undeclared` does take the declarations out, so the two sides differ, and
    // takes nothing out of the one schema here that `P-383` did not change, the tree's envelope.
    for (const schema of [
      createObjectSchema,
      treeNodeSchema,
      updateObjectSchema,
      pauseRequestSchema,
      acknowledgeRequestSchema,
    ]) {
      assert.notDeepEqual(undeclared(schema), schema);
    }
    assert.deepEqual(undeclared(createTreeSchema), createTreeSchema);
    const message = await registrationError(
      { ...API_VALIDATOR_OPTIONS },
      { body: undeclared(acknowledgeRequestSchema) },
    );
    assert.match(message ?? '', /strictRequired/u);
  });

  for (const [url, body, valid] of CASES) {
    it(`${url} ${JSON.stringify(body)}`, async () => {
      const ask = async (app: FastifyInstance): Promise<Answer> => {
        const response = await app.inject({ method: 'POST', url, payload: body });
        assert.equal(response.statusCode, 200, response.body);
        return response.json<Answer>();
      };
      const answer = await ask(now);
      assert.deepEqual(answer, await ask(then));
      assert.equal(answer.valid, valid, JSON.stringify(answer.problems));
      assert.equal(answer.problems.length === 0, valid);
    });
  }
});
