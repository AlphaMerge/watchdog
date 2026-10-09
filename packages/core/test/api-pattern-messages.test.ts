import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { SENSOR_TYPE_ID_MESSAGE } from '@ms/sensors';
import { PATTERN_MESSAGE, unsaidPatterns, type BuildStamp } from '@ms/shared';
import { NODE_ID_MESSAGE } from '../src/libraries/nodes.js';
import { surfaceServer, type SurfaceRoute, type SurfaceServer } from './support/surface.js';

/**
 * A failed `pattern` in the core's own API schemas says a sentence, never its expression
 * (`P-372`), as a sensor parameter's has since `U-53`.
 *
 * Built on the surface harness (`H-13`): every route a full build registers, with no database.
 * Validation runs before any handler, so a refused request is answered by the validator alone.
 */

const STAMP: BuildStamp = {
  version: '0.0.0-dev',
  commit: null,
  dirty: false,
  profile: 'full',
  lock: null,
};

/** The parts of a route's schema the validator compiles, and the responses it documents. */
const REQUEST_PARTS = ['body', 'querystring', 'params', 'headers'] as const;

/** Every schema a route carries, named by where it sits: `GET /api/v1/audit querystring`. */
function schemasOf(routes: readonly SurfaceRoute[]): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const route of routes) {
    const schema = (route.schema ?? {}) as Record<string, unknown>;
    for (const part of REQUEST_PARTS) {
      if (schema[part] !== undefined) found.set(`${route.key} ${part}`, schema[part]);
    }
    const responses = (schema['response'] ?? {}) as Record<string, unknown>;
    for (const [status, response] of Object.entries(responses)) {
      found.set(`${route.key} response ${status}`, response);
    }
    // What a `$ref` names is walked once, as a schema of its own: the walker does not follow one.
    for (const [id, shared] of Object.entries(route.shared)) found.set(id, shared);
  }
  return found;
}

/** Each fault the walker finds, as `where path: fault`. */
function faultsIn(schemas: ReadonlyMap<string, unknown>): string[] {
  const faults: string[] = [];
  for (const [where, schema] of schemas) {
    for (const { path, fault } of unsaidPatterns(schema)) {
      faults.push(`${where} ${path === '' ? '(the schema itself)' : path}: ${fault}`);
    }
  }
  return faults;
}

/** A deep copy with every `x-patternMessage` taken out, as a schema written before `P-372` was. */
function unsaid(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(unsaid);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== PATTERN_MESSAGE)
      .map(([key, value]) => [key, unsaid(value)]),
  );
}

/** A value no schema holds, so finding it anywhere in an answer is the request's own echo. */
const CANARY = 'CANARY-7d1e';

/** The fields Ajv gives an error without `verbose`: what a 400's problems carried before. */
const PROBLEM_FIELDS = new Set([
  'instancePath',
  'schemaPath',
  'keyword',
  'params',
  'propertyName',
  'message',
]);

interface Refusal {
  readonly message: string;
  readonly problems: readonly Record<string, unknown>[];
}

/** A 400 from the validator, checked for what it must never carry. */
function refusalOf(response: LightMyRequestResponse): Refusal {
  assert.equal(response.statusCode, 400, response.body);
  assert.ok(!response.body.includes(CANARY), `the refused value came back: ${response.body}`);
  assert.doesNotMatch(response.body, /must match pattern/u);
  const { error } = response.json<{
    error: {
      code: string;
      message: string;
      context: { phase?: string };
      details: { problems: Record<string, unknown>[] };
    };
  }>();
  assert.equal(error.code, 'OBJECT_INVALID');
  assert.equal(error.context.phase, 'validate-request');
  for (const problem of error.details.problems) {
    const extra = Object.keys(problem).filter((key) => !PROBLEM_FIELDS.has(key));
    assert.deepEqual(extra, [], `verbose's fields reached the answer: ${JSON.stringify(problem)}`);
  }
  return { message: error.message, problems: error.details.problems };
}

/** The pattern problem at `instancePath`, which must be there. */
function patternAt(refusal: Refusal, instancePath: string): Record<string, unknown> {
  const problem = refusal.problems.find(
    (one) => one['keyword'] === 'pattern' && one['instancePath'] === instancePath,
  );
  assert.ok(problem !== undefined, `no pattern refusal at ${instancePath}: ${refusal.message}`);
  return problem;
}

describe('the API schemas’ patterns (P-372)', () => {
  let surface: SurfaceServer;

  before(async () => {
    surface = await surfaceServer(STAMP, { required: false, v2: 'stubbed' });
  });

  after(async () => {
    await surface.close();
  });

  describe('every pattern carries a sentence', () => {
    it('in every registered route’s schemas and every shared schema they can reach', () => {
      assert.deepEqual(faultsIn(schemasOf(surface.routes)), []);
    });

    it('would be refused without one, so the walk reaches each of them', () => {
      // The control: the same schemas with every sentence taken out. Each pattern this ticket
      // gave a sentence is then found, so an empty list above is the sentences' doing.
      const stripped = new Map(
        [...schemasOf(surface.routes)].map(([where, schema]) => [where, unsaid(schema)]),
      );
      const faults = faultsIn(stripped);
      for (const expected of [
        'PATCH /api/v1/objects/{id}/channels/{key} body processing.scaleMul: unsaid',
        'PATCH /api/v1/objects/{id}/channels/{key} body processing.scaleDiv: unsaid',
        'GET /api/v1/audit querystring before: unsaid',
        'GET /api/v1/objects/{id}/audit querystring before: unsaid',
        'ms:createObject sensorType: unsaid',
        'ms:libraryNode id: unsaid',
        'ms:libraryNode rule.types.*: unsaid',
      ]) {
        assert.ok(faults.includes(expected), `${expected} not found in:\n${faults.join('\n')}`);
      }
    });

    it('and a sentence with no pattern is refused too', () => {
      const orphan = {
        properties: { id: { type: 'string', [PATTERN_MESSAGE]: 'must be digits' } },
      };
      assert.deepEqual(faultsIn(new Map([['a schema', orphan]])), ['a schema id: orphan']);
    });
  });

  describe('a refusal says the sentence, and neither the expression nor the value', () => {
    const DECIMAL =
      'must be a decimal number in digits, with an optional leading minus sign and decimal ' +
      'point, such as 8, 0.001 or -2.5';
    const CURSOR = 'must be an audit entry id, 1 to 19 digits, such as the last page’s nextBefore';

    it('a channel’s scaling factors', async () => {
      const refusal = refusalOf(
        await surface.server.app.inject({
          method: 'PATCH',
          url: '/api/v1/objects/1/channels/rtt',
          headers: { 'if-match': 'W/"1"' },
          payload: { processing: { scaleMul: `1e3${CANARY}`, scaleDiv: CANARY } },
        }),
      );
      assert.equal(
        refusal.message,
        `body/processing/scaleMul ${DECIMAL}, body/processing/scaleDiv ${DECIMAL}`,
      );
      assert.equal(patternAt(refusal, '/processing/scaleMul')['message'], DECIMAL);
      assert.equal(patternAt(refusal, '/processing/scaleDiv')['message'], DECIMAL);
    });

    it('a sensor type id on a create', async () => {
      const refusal = refusalOf(
        await surface.server.app.inject({
          method: 'POST',
          url: '/api/v1/objects',
          payload: { kind: 'sensor', parentId: 1, name: 'x', sensorType: `Snmp ${CANARY}` },
        }),
      );
      assert.equal(patternAt(refusal, '/sensorType')['message'], SENSOR_TYPE_ID_MESSAGE);
      assert.ok(refusal.message.includes(`body/sensorType ${SENSOR_TYPE_ID_MESSAGE}`));
    });

    it('the audit cursor, on the log and on an object', async () => {
      for (const url of [`/api/v1/audit?before=${CANARY}`, `/api/v1/objects/1/audit?before=1.5`]) {
        const refusal = refusalOf(await surface.server.app.inject({ method: 'GET', url }));
        assert.equal(refusal.message, `querystring/before ${CURSOR}`, url);
        assert.equal(patternAt(refusal, '/before')['message'], CURSOR);
      }
    });

    it('a library node’s id and a rule’s sensor type', async () => {
      const refusal = refusalOf(
        await surface.server.app.inject({
          method: 'POST',
          url: '/api/v1/libraries',
          payload: {
            name: 'x',
            nodes: [{ id: `bad id ${CANARY}`, name: 'n', rule: { types: [`Bad.${CANARY}`] } }],
          },
        }),
      );
      assert.equal(patternAt(refusal, '/nodes/0/id')['message'], NODE_ID_MESSAGE);
      assert.equal(patternAt(refusal, '/nodes/0/rule/types/0')['message'], SENSOR_TYPE_ID_MESSAGE);
      // The expression stays where a client can read it, in `params`, which names no value.
      assert.deepEqual(patternAt(refusal, '/nodes/0/id')['params'], {
        pattern: '^[A-Za-z0-9_-]{1,40}$',
      });
    });

    it('every other keyword keeps Ajv’s words', async () => {
      const refusal = refusalOf(
        await surface.server.app.inject({
          method: 'GET',
          url: `/api/v1/audit?limit=0&before=${CANARY}`,
        }),
      );
      assert.equal(refusal.message, `querystring/before ${CURSOR}, querystring/limit must be >= 1`);
    });
  });
});
