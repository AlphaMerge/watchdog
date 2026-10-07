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
      harness = await buildHarness(db, { types: [shifting, limited] });
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
        catalogue: testCatalogue([shifting, limited]),
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
        assert.equal(error.details['reason'], 'BAD_SENSOR_TYPE');
        assert.equal(error.context['phase'], 'declare-channels');
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
        const written = await db.query<{ count: string }>(
          "SELECT count(*) AS count FROM object WHERE parent_id = $1 AND name = 'Router'",
          [probeId],
        );
        assert.equal(Number(written[0]?.count ?? -1), 0, 'part of the subtree was written');
      });
    }
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

  it('leaves any other throw alone, as a fault of ours rather than the caller’s', () => {
    const throwing: SensorType = {
      ...limited,
      id: 'test.throwing',
      channels: (params) => {
        if (params['limited'] === true) throw new RangeError('a bug in the type');
        return [{ key: 'value', name: 'Value', isPrimary: true }];
      },
    };
    const gate = catalogueSensorTypeGate(testCatalogue([throwing]));
    assert.throws(() => gate.channelsFor('test.throwing', { limited: true }), RangeError);
  });
});
