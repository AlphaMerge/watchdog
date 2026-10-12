import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { BUILT_IN_SENSOR_TYPES, standardCatalogue, type SensorType } from '@ms/sensors';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver, DECLARATION_SETTLE_MS } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { IngestionService, type ResultStats } from '../src/ingestion/service.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { declaredChannelLookup } from '../src/state/declared-limits.js';
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
  channelsFromWhatItReads: 'its readings name whatever the script printed',
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
      // As in production: an edit makes ingestion forget the sensor's cached channels (`M-04`),
      // and a channel a reading creates is checked against its declaration (`P-321`).
      resolver = new ChannelResolver({
        logger: silent,
        declaredShape: declaredChannelLookup(testCatalogue(types)),
      });
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
    const deliver = async (
      results: readonly CheckResult[],
      batchId: string,
    ): Promise<ResultStats> => {
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const service = new IngestionService({ db, logger: silent, ingestor, states, resolver });
      const reply = await service.acceptResults('probe-retired', {
        type: 'results',
        batchId,
        results: [...results],
      });
      await ingestor.stop();
      assert.equal(reply.type, 'results-ack');
      return service.stats();
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

    // `P-322`. `retired` asks this core's catalogue, but readings come from the probe's build, and
    // ADR-001 Decision 13 lets a probe run ahead of the core: a key a newer build reports that this
    // build's declaration does not name, or one this build's edit took out and a newer build still
    // reads. A channel with a reading newer than the sensor's last change is read, so it is not
    // retired, whatever the declaration says.
    it('is not said of a channel read after the change that stopped declaring it, as from a probe ahead of the core', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }, { key: 'b' }] });
      const scan = (at: Date, keys: readonly string[]): CheckResult => ({
        sensorId: id,
        at: at.toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: keys.map((key) => ({ key, value: 1 })),
      });
      /** Just after the sensor's last change: a reading the probe took once it had it. */
      const afterChange = async (): Promise<Date> => {
        const rows = await db.query<{ at: Date }>(
          'SELECT params_changed_at AS at FROM sensor_config WHERE object_id = $1',
          [id],
        );
        const at = rows[0]?.at;
        assert.ok(at !== undefined);
        // A JS date drops the microseconds, so one millisecond on is strictly after.
        return new Date(at.getTime() + 1);
      };

      await deliver([scan(new Date(Date.now() - 5 * 60_000), ['a', 'b'])], `ahead-0-${String(id)}`);
      await edit(id, { columns: [{ key: 'a' }] });
      assert.deepEqual(await retirement(id), { a: false, b: true }, 'no reading since the edit');

      // A probe running a newer build reads `b` still, and a key this core never declared.
      const stats = await deliver(
        [scan(await afterChange(), ['a', 'b', 'newer'])],
        `ahead-1-${String(id)}`,
      );
      assert.equal(
        stats.channelsCreatedOutsideDeclaration,
        0,
        '`newer` is created, its reading kept, and not counted (`P-321` review): taken in the ' +
          'minute after the edit, it may have run under the parameters before it',
      );
      assert.deepEqual(
        await retirement(id),
        { a: false, b: false, newer: false },
        'each read since the edit, so neither is called retired',
      );

      // **A write that changes no parameter is not a change** (`P-340`): recording who vouched
      // for the sensor, as `recordVoucher` does, after the reading. `updated_at` moved past the
      // reading and called `b` retired again until the next one; the parameters' own time did not.
      await db.query('SELECT pg_sleep(0.01)');
      await db.query(`UPDATE sensor_config SET vouched_by = 'account' WHERE object_id = $1`, [id]);
      assert.deepEqual(
        await retirement(id),
        { a: false, b: false, newer: false },
        'a voucher write does not undo a reading',
      );

      // Put back: live, as it is declared.
      await edit(id, { columns: [{ key: 'a' }, { key: 'b' }] });
      assert.deepEqual(await retirement(id), { a: false, b: false, newer: true });

      // Taken out again, and nothing has read it since: retired once more. The database's clock
      // has to have moved past the last reading's for the edit to come after it.
      await db.query('SELECT pg_sleep(0.01)');
      await edit(id, { columns: [{ key: 'a' }] });
      assert.deepEqual(await retirement(id), { a: false, b: true, newer: true });

      // The channel `PATCH` answers from the same rule.
      await deliver([scan(await afterChange(), ['a', 'b'])], `ahead-2-${String(id)}`);
      const read = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/b`,
        headers: { 'if-match': String(read.headers['etag']) },
        payload: { limits: { upperError: 10 } },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      assert.equal(patched.json<Channel>().retired, false, 'read since the edit');
      assert.deepEqual(await retirement(id), { a: false, b: false, newer: true });
    });

    it('counts a key a probe ahead of the core adds, and does not call its channel retired', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }] });
      const rows = await db.query<{ at: Date }>(
        'SELECT params_changed_at AS at FROM sensor_config WHERE object_id = $1',
        [id],
      );
      const changedAt = rows[0]?.at;
      assert.ok(changedAt !== undefined);
      // Well after the sensor's last change, so taken under its parameters (`P-321` review);
      // ahead of the core's clock by two minutes, inside what ingestion accepts.
      const stats = await deliver(
        [
          {
            sensorId: id,
            at: new Date(changedAt.getTime() + 2 * DECLARATION_SETTLE_MS).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'a', value: 1 },
              { key: 'newer', value: 2 },
            ],
          },
        ],
        `newer-${String(id)}`,
      );
      assert.equal(stats.channelsCreatedOutsideDeclaration, 1, 'counted through ingestion');
      assert.deepEqual(await retirement(id), { a: false, newer: false });
    });

    // `P-322` review: `retired` is derived from `sample` on every read, and a reading changes it
    // without moving the sensor's version. The detail's validator carries it, so a client
    // revalidating `?include=channels` is not kept on a stale answer either way.
    it('moves the detail’s tag when a reading changes which channels are retired', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }, { key: 'b' }] });
      await edit(id, { columns: [{ key: 'a' }] });
      const url = `/api/v1/objects/${String(id)}?include=channels`;
      const retiredIn = (response: LightMyRequestResponse): Record<string, boolean> =>
        Object.fromEntries(
          response
            .json<{ channels: Channel[] }>()
            .channels.map((channel) => [channel.key, channel.retired]),
        );

      const first = await app.inject({ method: 'GET', url });
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(retiredIn(first), { a: false, b: true });
      const tag = String(first.headers['etag']);
      const unchanged = await app.inject({ method: 'GET', url, headers: { 'if-none-match': tag } });
      assert.equal(unchanged.statusCode, 304, 'nothing changed, so revalidated');

      // A reading of `b` after the edit, as a probe ahead of the core sends: live again.
      const rows = await db.query<{ at: Date }>(
        'SELECT params_changed_at AS at FROM sensor_config WHERE object_id = $1',
        [id],
      );
      const changedAt = rows[0]?.at;
      assert.ok(changedAt !== undefined);
      await deliver(
        [
          {
            sensorId: id,
            at: new Date(changedAt.getTime() + 1).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'a', value: 1 },
              { key: 'b', value: 1 },
            ],
          },
        ],
        `tag-${String(id)}`,
      );
      const live = await app.inject({ method: 'GET', url, headers: { 'if-none-match': tag } });
      assert.equal(live.statusCode, 200, 'the version did not move, but the answer did');
      assert.deepEqual(retiredIn(live), { a: false, b: false });
      const liveTag = String(live.headers['etag']);
      assert.notEqual(liveTag, tag);
      assert.equal(
        (await app.inject({ method: 'GET', url, headers: { 'if-none-match': liveTag } }))
          .statusCode,
        304,
      );

      // And back, as retention dropping the only reading after the edit would leave it.
      await db.query(
        `DELETE FROM sample s USING channel c, sensor_config sc
         WHERE s.channel_id = c.id AND c.sensor_id = $1 AND c.key = 'b'
           AND sc.object_id = c.sensor_id AND s.time > sc.params_changed_at`,
        [id],
      );
      const retiredAgain = await app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': liveTag },
      });
      assert.equal(retiredAgain.statusCode, 200);
      assert.deepEqual(retiredIn(retiredAgain), { a: false, b: true });
      assert.equal(String(retiredAgain.headers['etag']), tag, 'the same answer, the same tag');
    });

    // `U-38`. The channel table polls `/values`; it carries the list's `retired`, from the same
    // derivation, so a client reading only the values is told the same thing as the list.
    it('is carried by `/values`, as the list says it, and moves with a reading after the edit', async () => {
      const id = await create('test.columns', { columns: [{ key: 'a' }, { key: 'b' }] });
      const url = `/api/v1/sensors/${String(id)}/values`;
      const valuesRetirement = async (): Promise<Record<string, boolean>> => {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, response.body);
        return Object.fromEntries(
          response
            .json<{ channels: Channel[] }>()
            .channels.map((channel) => [channel.key, channel.retired]),
        );
      };

      assert.deepEqual(await valuesRetirement(), { a: false, b: false });
      await edit(id, { columns: [{ key: 'a' }] });
      assert.deepEqual(await valuesRetirement(), { a: false, b: true }, 'no reading since');
      assert.deepEqual(await retirement(id), await valuesRetirement(), 'the list agrees');

      // A reading of `b` after the edit, as a probe ahead of the core sends (`P-322`): live.
      const rows = await db.query<{ at: Date }>(
        'SELECT params_changed_at AS at FROM sensor_config WHERE object_id = $1',
        [id],
      );
      const changedAt = rows[0]?.at;
      assert.ok(changedAt !== undefined);
      await deliver(
        [
          {
            sensorId: id,
            at: new Date(changedAt.getTime() + 1).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'a', value: 1 },
              { key: 'b', value: 2 },
            ],
          },
        ],
        `values-${String(id)}`,
      );
      assert.deepEqual(await valuesRetirement(), { a: false, b: false }, 'read since the edit');
      assert.deepEqual(await retirement(id), await valuesRetirement(), 'the list agrees again');
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
    // Each read for it (`P-310`, `P-320`): a type added here is one whose `execute` has been
    // checked to report only keys `channels(params)` names for the same parameters; for the three
    // the core evaluates, the core's evaluator was read instead.
    assert.deepEqual(
      BUILT_IN_SENSOR_TYPES.filter((type) => type.declaresEveryChannel === true)
        .map((type) => type.id)
        .sort(),
      [
        'core.factory',
        'db.mssql',
        'db.mysql',
        'db.postgresql',
        'dns.blocklist',
        'dns.record',
        'exe.script',
        'flow.netflow',
        'http.advanced',
        'http.content',
        'http.request',
        'http.transaction',
        'icmp.jitter',
        'icmp.ping',
        'mail.imap',
        'mail.pop3',
        'mail.roundtrip',
        'mail.smtp',
        'ms.core.health',
        'ms.probe.health',
        'port.range',
        'port.tcp',
        'rest.custom',
        'snmp.cpu',
        'snmp.custom',
        'snmp.custom.string',
        'snmp.diskfree',
        'snmp.memory',
        'snmp.table',
        'snmp.traffic',
        'snmp.trap',
        'snmp.uptime',
        'ssh.diskfree',
        'ssh.load',
        'ssh.meminfo',
        'ssh.script',
        'syslog.receiver',
        'tls.certificate',
        'tls.security',
        'windows.memory',
        'windows.service',
      ],
    );
  });

  it('is every shipped type but the three whose keys come from what they read (`P-320`)', () => {
    // The script's own keys, a channel per logical processor, and a set of channels per volume:
    // a key none of their declarations names may be one their readings do.
    assert.deepEqual(
      BUILT_IN_SENSOR_TYPES.filter((type) => type.declaresEveryChannel !== true)
        .map((type) => type.id)
        .sort(),
      ['exe.script.advanced', 'windows.cpu', 'windows.volume'],
    );
    // And each says why, as the catalogue requires of a type without the flag (`P-350`); no
    // flagged type gives a reason too.
    assert.deepEqual(
      BUILT_IN_SENSOR_TYPES.filter((type) => (type.channelsFromWhatItReads ?? '').trim() !== '')
        .map((type) => type.id)
        .sort(),
      ['exe.script.advanced', 'windows.cpu', 'windows.volume'],
    );
  });

  it('answers no keys for a type whose readings come from what it ran', () => {
    assert.equal(gate.reportableKeys('exe.script.advanced', { primaryChannel: 'x' }), null);
    assert.equal(gate.reportableKeys('windows.cpu', {}), null);
    assert.equal(gate.reportableKeys('windows.volume', { drives: ['C:'] }), null);
  });

  it('answers the declared keys of a script type that reports only those (`P-320`)', () => {
    // `ssh.script` reads what the script printed, but reports only the keys `channels` names.
    assert.deepEqual(
      [
        ...(gate.reportableKeys('ssh.script', {
          command: './check.sh',
          channels: [{ key: 'queue' }, { key: 'temperature' }],
        }) ?? []),
      ].sort(),
      ['queue', 'temperature'],
    );
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
