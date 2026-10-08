import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import type { SensorType } from '@ms/sensors';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ObjectError } from '../src/objects/errors.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Says its channels do not depend on its parameters, and `extra` gives it a second one. The
 * catalogue can only check `{}` and the schema's defaults at registration, and both keep the
 * promise, so it registers; only a sensor's real parameters break it (`P-293`).
 */
const shifting: SensorType = {
  id: 'test.shifting',
  category: 'Custom',
  costHint: 'light',
  fixedChannels: true,
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { extra: { type: 'boolean' } },
  },
  channels: (params) => [
    { key: 'value', name: 'Value', isPrimary: true },
    ...(params['extra'] === true ? [{ key: 'extra', name: 'Extra' }] : []),
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/** No `fixedChannels`, and declares limits on a channel only `limited` makes (`P-293`). */
const limited: SensorType = {
  id: 'test.limited',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limited: { type: 'boolean' } },
  },
  channels: (params) => [
    { key: 'value', name: 'Value', isPrimary: true },
    ...(params['limited'] === true
      ? [{ key: 'bounded', name: 'Bounded', limits: { upperError: 10 } }]
      : []),
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/** A secret the throwing type is given, which no reply or log line may carry (`P-305`). */
const SECRET = 'sekret-community-string';
/** A parameter the throwing type puts in its own message. */
const COLUMN = 'bogus-column';

/**
 * Throws from `channels()` for parameters its own schema accepts, with their values in the
 * message — a bug in the type, which is what `P-305` is about. `community` is `writeOnly`, so on
 * an edit it is carried from what is stored, and the caller never sent it.
 */
const throwing: SensorType = {
  id: 'test.throwing',
  category: 'Custom',
  costHint: 'light',
  secretDestinations: { community: [] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      column: { type: 'string', minLength: 1 },
      community: { type: 'string', minLength: 1, writeOnly: true },
    },
  },
  channels: (params) => {
    const column = typeof params['column'] === 'string' ? params['column'] : '';
    if (column === COLUMN) {
      const community = typeof params['community'] === 'string' ? params['community'] : '';
      throw new TypeError(`no column called ${column} answers for ${community}`);
    }
    return [{ key: 'value', name: 'Value', isPrimary: true }];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

const brokenTypes = [shifting, limited, throwing];

interface Envelope {
  error: {
    code: string;
    message: string;
    context: Record<string, unknown>;
    details: Record<string, unknown>;
  };
}

/**
 * A type that breaks its own channel declaration, met at a sensor create (`P-296`).
 *
 * `channelsFor` is the only place the catalogue sees a sensor's real parameters, so it is where
 * such a type is caught, and it threw `BAD_SENSOR_TYPE` straight into the create: a 500 that told
 * the caller "the request could not be completed" and nothing else. The create is refused instead,
 * as a 400 naming the type, and writes nothing.
 */
describe(
  'creating a sensor of a type that breaks its own channel declaration',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let probeId: number;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('brokentype');
      db = scratch.db;
      harness = await buildHarness(db, { types: brokenTypes });
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(brokenTypes),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'device',
        host: '192.0.2.90',
      });
      deviceId = device.id;
    });

    const post = (url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'POST', url, payload });

    const sensorsUnder = async (parentId: number): Promise<number> => {
      const rows = await db.query<{ count: string }>(
        "SELECT count(*) AS count FROM object WHERE kind = 'sensor' AND parent_id = $1",
        [parentId],
      );
      return Number(rows[0]?.count ?? -1);
    };

    const refusals = [
      {
        name: 'a fixed type whose parameters change its channels',
        sensorType: 'test.shifting',
        broken: { extra: true },
        kept: {},
        says: /says its channels do not depend on its parameters/u,
      },
      {
        name: 'a type without the flag declaring limits on a channel its parameters make',
        sensorType: 'test.limited',
        broken: { limited: true },
        kept: { limited: false },
        says: /declares limits on channel "bounded" without `fixedChannels`/u,
      },
      {
        name: 'a type whose channels() throws for parameters its schema accepts (P-305)',
        sensorType: 'test.throwing',
        broken: { column: COLUMN, community: SECRET },
        kept: { column: 'good', community: SECRET },
        says: /failed to declare its channels for them \(TypeError: no column called \[a parameter\] answers for \[a parameter\]\)/u,
        reason: 'CHANNELS_FAILED',
      },
    ];

    for (const one of refusals) {
      it(`refuses ${one.name} as a 400 naming the type, and writes nothing`, async () => {
        const response = await post('/api/v1/objects', {
          kind: 'sensor',
          parentId: deviceId,
          name: 'broken',
          sensorType: one.sensorType,
          params: one.broken,
        });

        assert.equal(response.statusCode, 400, response.body);
        const { error } = response.json<Envelope>();
        assert.equal(error.code, 'OBJECT_INVALID');
        assert.match(error.message, new RegExp(`"${one.sensorType.replace('.', '\\.')}"`, 'u'));
        assert.match(error.message, one.says, 'the message says what the type got wrong');
        assert.equal(error.details['sensorType'], one.sensorType);
        assert.equal(error.details['reason'], one.reason ?? 'BAD_SENSOR_TYPE');
        assert.equal(error.context['phase'], 'declare-channels');
        assert.ok(!response.body.includes(SECRET), 'a secret reached the reply');
        assert.ok(!response.body.includes(COLUMN), 'a parameter’s value reached the reply');
        assert.equal(await sensorsUnder(deviceId), 0, 'the refused sensor was written');

        // The type is otherwise usable: parameters that keep its promise make a sensor.
        const kept = await post('/api/v1/objects', {
          kind: 'sensor',
          parentId: deviceId,
          name: 'kept',
          sensorType: one.sensorType,
          params: one.kept,
        });
        assert.equal(kept.statusCode, 201, kept.body);
        assert.equal(await sensorsUnder(deviceId), 1);
      });

      it(`refuses ${one.name} inside a subtree create, and writes none of the subtree`, async () => {
        const response = await post('/api/v1/objects/tree', {
          parentId: probeId,
          nodes: [
            { kind: 'device', name: 'Router', host: '192.0.2.91', ref: 'd' },
            {
              kind: 'sensor',
              name: 'Fine',
              sensorType: one.sensorType,
              params: one.kept,
              parentRef: 'd',
            },
            {
              kind: 'sensor',
              name: 'Broken',
              sensorType: one.sensorType,
              params: one.broken,
              parentRef: 'd',
            },
          ],
        });

        assert.equal(response.statusCode, 400, response.body);
        const { error } = response.json<Envelope>();
        assert.equal(error.code, 'OBJECT_INVALID');
        assert.equal(error.details['sensorType'], one.sensorType);
        assert.ok(!response.body.includes(SECRET), 'a secret reached the reply');
        const written = await db.query<{ count: string }>(
          "SELECT count(*) AS count FROM object WHERE parent_id = $1 AND name = 'Router'",
          [probeId],
        );
        assert.equal(Number(written[0]?.count ?? -1), 0, 'part of the subtree was written');
      });
    }

    it('refuses an edit to parameters the type cannot answer for, without the stored secret (P-305)', async () => {
      const created = await post('/api/v1/objects', {
        kind: 'sensor',
        parentId: deviceId,
        name: 'edited',
        sensorType: 'test.throwing',
        params: { column: 'good', community: SECRET },
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json<{ id: number }>().id;
      const stored = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [id],
      );

      // No `community`: a read never returns it, so it is carried from what is stored, and the
      // type's message would have carried it back to a caller who never had it.
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}`,
        headers: { 'if-match': String(created.headers['etag']) },
        payload: { kind: 'sensor', params: { column: COLUMN } },
      });
      assert.equal(response.statusCode, 400, response.body);
      const { error } = response.json<Envelope>();
      assert.equal(error.code, 'OBJECT_INVALID');
      assert.equal(error.details['reason'], 'CHANNELS_FAILED');
      assert.match(error.message, /"test\.throwing"/u);
      assert.ok(!response.body.includes(SECRET), 'a stored secret reached the reply');
      assert.ok(!response.body.includes(COLUMN), 'a parameter’s value reached the reply');

      const after = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [id],
      );
      assert.deepEqual(after[0]?.params, stored[0]?.params, 'the refused edit was written');
    });
  },
);

describe('the sensor-type gate, given a type that breaks its own channel declaration', () => {
  it('throws a client error naming the type and logs a warning for whoever ships it', () => {
    const lines: string[] = [];
    const gate = catalogueSensorTypeGate(testCatalogue([shifting]), {
      logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
    });

    assert.equal(gate.channelsFor('test.shifting', {}).length, 1, 'its promise, kept');
    assert.equal(lines.length, 0);

    let thrown: unknown;
    try {
      gate.channelsFor('test.shifting', { extra: true });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ObjectError, `expected an ObjectError, got ${String(thrown)}`);
    assert.equal(thrown.status, 400);
    assert.equal(thrown.details['sensorType'], 'test.shifting');

    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0] ?? '{}') as { level: number; sensorType: string };
    assert.equal(logged.level, 40, 'a warning');
    assert.equal(logged.sensorType, 'test.shifting');
  });

  it('refuses any other throw as the type’s fault too, and says it without a value (P-305)', () => {
    const lines: string[] = [];
    const gate = catalogueSensorTypeGate(testCatalogue([throwing]), {
      logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
    });

    let thrown: unknown;
    try {
      gate.channelsFor('test.throwing', { column: COLUMN, community: SECRET });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ObjectError, `expected an ObjectError, got ${String(thrown)}`);
    assert.equal(thrown.status, 400);
    assert.equal(thrown.details['sensorType'], 'test.throwing');
    assert.equal(thrown.details['reason'], 'CHANNELS_FAILED');
    assert.match(thrown.message, /"test\.throwing"/u);
    assert.match(thrown.message, /TypeError/u, 'the message says what kind of error it was');
    for (const said of [thrown.message, String((thrown.cause as Error | undefined)?.message)]) {
      assert.ok(!said.includes(SECRET), `a secret reached the error: ${said}`);
      assert.ok(!said.includes(COLUMN), `a parameter's value reached the error: ${said}`);
    }

    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0] ?? '{}') as {
      level: number;
      sensorType: string;
      err: { code: string; message: string; stack?: string };
    };
    assert.equal(logged.level, 40, 'a warning');
    assert.equal(logged.sensorType, 'test.throwing');
    assert.equal(logged.err.code, 'TypeError');
    assert.ok(logged.err.stack !== undefined, 'the stack, for whoever ships the type');
    assert.ok(!(lines[0] ?? '').includes(SECRET), `a secret reached the log: ${lines[0] ?? ''}`);
    assert.ok(!(lines[0] ?? '').includes(COLUMN), `a value reached the log: ${lines[0] ?? ''}`);
  });

  it('answers a stored sensor’s channels without refusing or logging when it can, and null when not', () => {
    const lines: string[] = [];
    const gate = catalogueSensorTypeGate(testCatalogue([throwing]), {
      logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
    });
    assert.equal(gate.storedChannelsFor('test.throwing', { column: 'good' })?.length, 1);
    assert.equal(gate.storedChannelsFor('test.throwing', { column: COLUMN }), null);
    assert.equal(gate.storedChannelsFor('test.unregistered', {}), null);
    assert.equal(lines.length, 0, 'nobody asked to write these parameters');
  });
});
