import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { BUILT_IN_SENSOR_TYPES, standardCatalogue, type SensorType } from '@ms/sensors';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { IngestionService } from '../src/ingestion/service.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { SensorStateService } from '../src/state/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

interface Column {
  key: string;
}

/**
 * `snmp.table`'s shape without SNMP, and its promise: each column a channel, and no reading for
 * a key the columns do not name. A column named `broken` makes `channels()` throw, which no
 * create or edit lets through (`P-305`), so a test that needs one writes it straight to the row.
 */
const columns: SensorType = {
  id: 'test.columns',
  category: 'Custom',
  costHint: 'light',
  declaresEveryChannel: true,
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      columns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
  channels: (params) => {
    const named = Array.isArray(params['columns']) ? (params['columns'] as Column[]) : [];
    if (named.some((column) => column.key === 'broken')) throw new TypeError('no such column');
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    return named.map((column, at) => ({
      key: column.key,
      name: `Column ${column.key}`,
      ...(at === 0 ? { isPrimary: true } : {}),
    }));
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * A script's shape: it declares the channel its parameters name, and its readings name whatever
 * the script printed. It makes no promise, so nothing of it is ever called retired.
 */
const script: SensorType = {
  id: 'test.script',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { primaryChannel: { type: 'string', minLength: 1, default: 'value' } },
  },
  channels: (params) => [
    {
      key: typeof params['primaryChannel'] === 'string' ? params['primaryChannel'] : 'value',
      name: 'Primary',
      isPrimary: true,
    },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

interface Channel {
  key: string;
  retired: boolean;
}

interface HistoryChannel {
  key: string;
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  count: (number | null)[];
}

/**
 * A channel an edit took out of a sensor's parameters (`P-310`).
 *
 * It keeps its row and its history and receives no more readings (`P-303`). The channel says so:
 * `retired`, worked out on each read from the type's declaration for the stored parameters, for a
 * type that promises its readings name no other key. Its graph stops at the edit as a gap, and it
 * plays no part in the sensor's state.
 */
describe(
  'a channel an edit took out of a sensor’s parameters is retired',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let resolver: ChannelResolver;
    let states: SensorStateService;
    let deviceId: number;
    const snmpTable = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'snmp.table');
    assert.ok(snmpTable !== undefined);
    const types = [columns, script, snmpTable];

    before(async () => {
      scratch = await createScratchDatabase('retired');
      db = scratch.db;
      harness = await buildHarness(db, { types });
      // As in production: an edit makes ingestion forget the sensor's cached channels (`M-04`).
      resolver = new ChannelResolver({ logger: silent });
      harness.audit.also = new CompositeAuditSink([
        new DatabaseAuditSink(),
        new ResultCacheInvalidator({ channels: resolver, logger: silent }),
      ]);
      states = new SensorStateService({
        db,
        logger: silent,
        settings: harness.resolver,
        pauses: new PauseRepository(),
      });
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
        catalogue: testCatalogue(types),
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
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'device',
        host: '192.0.2.80',
      });
      deviceId = device.id;
    });

    const create = async (sensorType: string, params: Record<string, unknown>): Promise<number> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        payload: { kind: 'sensor', parentId: deviceId, name: 'sensor', sensorType, params },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: number }>().id;
    };

    const edit = async (id: number, params: Record<string, unknown>): Promise<void> => {
      const read = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      const response: LightMyRequestResponse = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}`,
        headers: { 'if-match': String(read.headers['etag']) },
        payload: { kind: 'sensor', params },
      });
      assert.equal(response.statusCode, 200, response.body);
    };

    /** `GET /objects/:id/channels`, as key → retired. */
    const retirement = async (id: number): Promise<Record<string, boolean>> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}/channels`,
      });
      assert.equal(response.statusCode, 200, response.body);
      return Object.fromEntries(
        response
          .json<{ items: Channel[] }>()
          .items.map((channel) => [channel.key, channel.retired]),
      );
    };

    /** One batch through ingestion and the state machine, as the probe endpoint delivers it. */
    const deliver = async (results: readonly CheckResult[], batchId: string): Promise<void> => {
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const service = new IngestionService({ db, logger: silent, ingestor, states, resolver });
      const reply = await service.acceptResults('probe-retired', {
        type: 'results',
        batchId,
        results: [...results],
      });
      await ingestor.stop();
      assert.equal(reply.type, 'results-ack');
    };

    it('says so on the channel list, the object read and a channel write, and not once put back', async () => {
      const id = await create('test.columns', {
        columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      });
      assert.deepEqual(await retirement(id), { a: false, b: false, c: false });

      await edit(id, { columns: [{ key: 'a' }, { key: 'c' }] });
      assert.deepEqual(await retirement(id), { a: false, b: true, c: false });

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}?include=channels`,
      });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.deepEqual(
        detail
          .json<{ channels: Channel[] }>()
          .channels.map((channel) => [channel.key, channel.retired]),
        [
          ['a', false],
          ['b', true],
          ['c', false],
        ],
      );

      // Still a channel an operator can set, for the day it is put back; the answer says what
      // the list says.
      const read = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/b`,
        headers: { 'if-match': String(read.headers['etag']) },
        payload: { limits: { upperError: 10 } },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      assert.equal(patched.json<Channel>().retired, true);
      const again = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      const live = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/a`,
        headers: { 'if-match': String(again.headers['etag']) },
        payload: { limits: { upperError: 10 } },
      });
      assert.equal(live.statusCode, 200, live.body);
      assert.equal(live.json<Channel>().retired, false);

      await edit(id, { columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] });
      assert.deepEqual(await retirement(id), { a: false, b: false, c: false });
    });

    it('is exact for the shipped `snmp.table`', async () => {
      const id = await create('snmp.table', {
        tableOid: '1.3.6.1.2.1.25.2.3.1',
        rowIndex: '1',
        columns: [
          { column: '5', name: 'Size' },
          { column: '6', name: 'Used' },
        ],
      });
      assert.deepEqual(await retirement(id), { col5: false, col6: false });
      await edit(id, {
        tableOid: '1.3.6.1.2.1.25.2.3.1',
        rowIndex: '1',
        columns: [{ column: '5', name: 'Size' }],
      });
      assert.deepEqual(await retirement(id), { col5: false, col6: true });
    });

    it('is never said of a type whose readings can name channels it does not declare', async () => {
      const id = await create('test.script', { primaryChannel: 'first' });
      // A key the script printed: its row comes from the reading, as the first scan of any
      // script sensor's extra channels does.
      await deliver(
        [
          {
            sensorId: id,
            at: new Date(Date.now() - 60_000).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'first', value: 1 },
              { key: 'printed', value: 2 },
            ],
          },
        ],
        `script-${String(id)}`,
      );
      await edit(id, { primaryChannel: 'second' });
      // `first` and `printed` are both undeclared now, and the script may still print either.
      // (`second` has no row until a reading names it: an edit writes no new channel, `P-303`.)
      assert.deepEqual(await retirement(id), { first: false, printed: false });
    });

    it('is never said when the type cannot declare for what is stored', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }, { key: 'b' }] });
      // Parameters no create or edit would write any more (`P-305`), as a row from an older build.
      await db.query(
        `UPDATE sensor_config SET params = '{"columns":[{"key":"a"},{"key":"broken"}]}'::jsonb
         WHERE object_id = $1`,
        [id],
      );
      assert.deepEqual(await retirement(id), { a: false, b: false });
    });

    it('stops its graph at the edit as a gap, and leaves the sensor’s state to the channels still read', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }, { key: 'b' }] });
      const read = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      const limited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/b`,
        headers: { 'if-match': String(read.headers['etag']) },
        payload: { limits: { upperError: 10 } },
      });
      assert.equal(limited.statusCode, 200, limited.body);

      // On whole minutes, so each reading is one bucket of a 60 s history.
      const base = Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000;
      const at = (minute: number): string => new Date(base + minute * 60_000).toISOString();
      const scan = (minute: number, readings: CheckResult['channels']): CheckResult => ({
        sensorId: id,
        at: at(minute),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: readings,
      });

      // Before the edit `b` reads 50, past its error limit: the sensor is Down by it.
      await deliver(
        [0, 1, 2].map((minute) =>
          scan(minute, [
            { key: 'a', value: 1 + minute },
            { key: 'b', value: 50 + minute },
          ]),
        ),
        `before-${String(id)}`,
      );
      const down = await db.query<{ state: string }>(
        'SELECT state FROM sensor_runtime WHERE object_id = $1',
        [id],
      );
      assert.equal(down[0]?.state, 'down', 'the limit on `b` is enforced while it is read');

      await edit(id, { columns: [{ key: 'a' }] });
      assert.deepEqual(await retirement(id), { a: false, b: true });

      // After it, only `a` is read, and `b`'s limit judges nothing.
      await deliver(
        [3, 4, 5].map((minute) => scan(minute, [{ key: 'a', value: 1 + minute }])),
        `after-${String(id)}`,
      );
      const now = await db.query<{ state: string; cause: string; message: string }>(
        'SELECT state, cause, message FROM sensor_runtime WHERE object_id = $1',
        [id],
      );
      assert.deepEqual(
        now.map((row) => ({ ...row })),
        [{ state: 'up', cause: 'scan', message: '' }],
        'a retired channel holds no state, however its last reading stood',
      );

      const history = await app.inject({
        method: 'GET',
        url:
          `/api/v1/sensors/${String(id)}/history?from=${encodeURIComponent(at(0))}` +
          `&to=${encodeURIComponent(at(6))}&resolutionSeconds=60`,
      });
      assert.equal(history.statusCode, 200, history.body);
      const body = history.json<{ buckets: string[]; channels: HistoryChannel[] }>();
      const minuteOf = (bucket: string): number => (Date.parse(bucket) - base) / 60_000;
      const series = (key: string): HistoryChannel => {
        const found = body.channels.find((channel) => channel.key === key);
        assert.ok(found !== undefined, `no history for ${key}`);
        return found;
      };
      const byMinute = (values: (number | null)[]): Map<number, number | null> =>
        new Map(body.buckets.map((bucket, index) => [minuteOf(bucket), values[index] ?? null]));

      const retired = series('b');
      const live = series('a');
      for (const minute of [0, 1, 2]) {
        assert.equal(
          byMinute(retired.avg).get(minute),
          50 + minute,
          `b at minute ${String(minute)}`,
        );
      }
      for (const minute of [3, 4, 5]) {
        assert.ok(byMinute(retired.avg).has(minute), `no bucket for minute ${String(minute)}`);
        for (const values of [retired.avg, retired.min, retired.max, retired.count]) {
          assert.equal(byMinute(values).get(minute), null, `b after the edit is a gap`);
        }
        assert.equal(byMinute(live.avg).get(minute), 1 + minute, `a at minute ${String(minute)}`);
      }
      for (const values of [retired.avg, retired.min, retired.max, retired.count]) {
        assert.ok(!values.includes(0), 'never a zero');
      }
    });
  },
);

describe('which types say a channel is retired', () => {
  const gate = catalogueSensorTypeGate(standardCatalogue());

  it('is the shipped types whose every reading is a channel they declare', () => {
    // Each read for it (`P-310`): a type added here is one whose `execute` has been checked to
    // report only keys `channels(params)` names for the same parameters.
    assert.deepEqual(
      BUILT_IN_SENSOR_TYPES.filter((type) => type.declaresEveryChannel === true)
        .map((type) => type.id)
        .sort(),
      [
        'flow.netflow',
        'http.advanced',
        'http.content',
        'http.request',
        'http.transaction',
        'mail.smtp',
        'port.tcp',
        'rest.custom',
        'snmp.table',
      ],
    );
  });

  it('answers no keys for a type whose readings come from what it ran', () => {
    assert.equal(gate.reportableKeys('exe.script.advanced', { primaryChannel: 'x' }), null);
    assert.equal(gate.reportableKeys('ssh.script', {}), null);
  });

  it('answers no keys for a type this build does not register', () => {
    assert.equal(gate.reportableKeys('test.gone', {}), null);
  });

  it('answers the declared keys for one that promises them', () => {
    assert.deepEqual([...(gate.reportableKeys('http.request', { method: 'HEAD' }) ?? [])].sort(), [
      'redirects',
      'responseTime',
      'statusCode',
      'timeToFirstByte',
    ]);
    assert.deepEqual([...(gate.reportableKeys('http.request', { method: 'GET' }) ?? [])].sort(), [
      'redirects',
      'responseTime',
      'size',
      'statusCode',
      'timeToFirstByte',
    ]);
  });
});
