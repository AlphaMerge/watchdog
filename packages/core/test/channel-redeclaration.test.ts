import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import { BUILT_IN_SENSOR_TYPES, type SensorType } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { planRedeclaration, type StoredChannel } from '../src/objects/redeclare.js';
import type { ChannelDraft } from '../src/objects/sensor-type-gate.js';
import { declaredChannelLookup } from '../src/state/declared-limits.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** The shipped types whose channels an edit changes (`P-297` found them). */
function shipped(id: string): SensorType {
  const found = BUILT_IN_SENSOR_TYPES.find((type) => type.id === id);
  assert.ok(found !== undefined, `${id} is not a built-in sensor type`);
  return found;
}
const snmpCustom = shipped('snmp.custom');
const snmpCustomString = shipped('snmp.custom.string');

/**
 * A column key `test.columns` throws for, with the key in its message — standing in for stored
 * parameters a later build's type cannot answer for (`P-311`).
 */
const UNREADABLE = 'unreadable-column';

/**
 * `snmp.table`'s shape without SNMP: each column a channel, a counter or a lookup as its
 * parameters say. The real type's column keys come from OIDs, which make a test about keys hard
 * to read, and what is under test is the core, not the type.
 */
const columns: SensorType = {
  id: 'test.columns',
  category: 'Custom',
  costHint: 'light',
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
          properties: {
            key: { type: 'string', minLength: 1 },
            counter: { type: 'boolean' },
            bits: { enum: [32, 64] },
            lookup: { type: 'string' },
          },
        },
      },
    },
  },
  channels: (params) => {
    const named = Array.isArray(params['columns'])
      ? (params['columns'] as { key: string; counter?: boolean; bits?: 32 | 64; lookup?: string }[])
      : [];
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    const unreadable = named.find((column) => column.key === UNREADABLE);
    if (unreadable !== undefined) throw new Error(`no column called ${unreadable.key} here`);
    return named.map((column, at) => ({
      key: column.key,
      name: column.key,
      ...(at === 0 ? { isPrimary: true } : {}),
      ...(column.counter === true ? { counter: { bits: column.bits ?? 64 } } : {}),
      ...(column.lookup === undefined ? {} : { lookup: column.lookup }),
    }));
  },
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

interface Row {
  key: string;
  name: string;
  unit: string;
  lookup_id: string | null;
  counter_bits: number | null;
  limits_source: string;
}

/**
 * An edit to a sensor's parameters, and the channels it already has (`P-303`).
 *
 * An update replaced `params` and declared no channels, so a lookup, name or unit an edit changed
 * stayed as the create wrote it. Now the channels whose declaration the edit changes are written
 * to match, and an edit that would turn a channel from a counter into a gauge or back is refused,
 * since its stored samples are rates on one side of the edit and raw values on the other.
 */
describe(
  'editing a sensor’s parameters re-declares the channels the edit changes',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let resolver: ChannelResolver;
    let deviceId: number;
    const types = [snmpCustom, snmpCustomString, columns];
    /** What the object service logs (`P-311`). */
    const lines: string[] = [];

    before(async () => {
      scratch = await createScratchDatabase('redeclare');
      db = scratch.db;
      harness = await buildHarness(db, {
        types,
        logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
      });
      // Where the result path's cache sits in production: behind the audit sink, inside the
      // mutation's transaction (`M-04`). And the real audit log, to read the entries back.
      resolver = new ChannelResolver({ logger: silent });
      harness.audit.also = new CompositeAuditSink([
        new DatabaseAuditSink(),
        new ResultCacheInvalidator({ channels: resolver, logger: silent }),
      ]);
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
        host: '192.0.2.70',
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

    const etagOf = async (id: number): Promise<string> => {
      const response = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      assert.equal(response.statusCode, 200, response.body);
      return String(response.headers['etag']);
    };

    const edit = async (
      id: number,
      params: Record<string, unknown>,
      etag?: string,
    ): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}`,
        headers: { 'if-match': etag ?? (await etagOf(id)) },
        payload: { kind: 'sensor', params },
      });

    const rows = async (id: number): Promise<Row[]> =>
      (
        await db.query<Row>(
          `SELECT key, name, unit, lookup_id, counter_bits, limits_source
           FROM channel WHERE sensor_id = $1 ORDER BY key`,
          [id],
        )
      ).map((row) => ({ ...row }));

    const storedParams = async (id: number): Promise<Record<string, unknown>> => {
      const found = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [id],
      );
      return found[0]?.params ?? {};
    };

    const redeclaredEntries = async (
      id: number,
    ): Promise<
      { channelKey: unknown; diff: { field: string; before: unknown; after: unknown }[] }[]
    > =>
      (await new AuditRepository().list(db, { objectId: id, categories: ['channel'], limit: 50 }))
        .filter((entry) => entry.action === 'channel.redeclared')
        .map((entry) => ({
          channelKey: entry.summary['channelKey'],
          diff: entry.diff.map((change) => ({ ...change })),
        }));

    it('points `snmp.custom.string`’s channel at the lookup an edit names, and back off it', async () => {
      const id = await create('snmp.custom.string', {
        oid: '1.3.6.1.4.1.9.1.0',
        lookup: 'ms.snmp.if-oper-status',
      });
      assert.equal((await rows(id))[0]?.lookup_id, 'ms.snmp.if-oper-status', 'as created');

      const changed = await edit(id, { oid: '1.3.6.1.4.1.9.1.0', lookup: 'ms.test.other' });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal((await rows(id))[0]?.lookup_id, 'ms.test.other');

      // The answer's ETag is the sensor's version after the channel was written, so it is good
      // for the next write rather than a 412 (`P-29`).
      const etag = String(changed.headers['etag']);
      const current = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}` });
      assert.equal(
        changed.json<{ version: number }>().version,
        current.json<{ version: number }>().version,
        'the edit answered with a version already stale',
      );
      const cleared = await edit(id, { oid: '1.3.6.1.4.1.9.1.0', lookup: '' }, etag);
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal((await rows(id))[0]?.lookup_id, null, 'a lookup the edit takes away is gone');

      assert.deepEqual(await redeclaredEntries(id), [
        {
          channelKey: 'value',
          diff: [{ field: 'channel.value.lookupId', before: 'ms.test.other', after: null }],
        },
        {
          channelKey: 'value',
          diff: [
            {
              field: 'channel.value.lookupId',
              before: 'ms.snmp.if-oper-status',
              after: 'ms.test.other',
            },
          ],
        },
      ]);
    });

    it('re-names and re-labels a channel an edit renames, and leaves its limits alone', async () => {
      const id = await create('snmp.custom', { oid: '1.3.6.1.2.1.2.2.1.10.1', mode: 'counter' });
      // An operator's thresholds, which nothing an edit does may touch.
      const limited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/value`,
        headers: { 'if-match': await etagOf(id) },
        payload: { limits: { upperError: 1000 } },
      });
      assert.equal(limited.statusCode, 200, limited.body);

      const renamed = await edit(id, {
        oid: '1.3.6.1.2.1.2.2.1.10.1',
        mode: 'counter',
        channelName: 'Inbound',
        unit: 'octets',
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.deepEqual(await rows(id), [
        {
          key: 'value',
          name: 'Inbound',
          // A counter's stored sample is a rate, and its type says so in the unit.
          unit: 'octets/s',
          lookup_id: null,
          counter_bits: 64,
          limits_source: 'operator',
        },
      ]);
      const limits = await db.query<{ limits: Record<string, unknown> }>(
        'SELECT limits FROM channel WHERE sensor_id = $1',
        [id],
      );
      assert.equal(limits[0]?.limits['upperError'], 1000);
    });

    for (const [from, to] of [
      ['gauge', 'counter'],
      ['counter', 'gauge'],
    ] as const) {
      it(`refuses an edit that turns a ${from} into a ${to}, and changes nothing`, async () => {
        const id = await create('snmp.custom', { oid: '1.3.6.1.2.1.1.3.0', mode: from });
        const was = await rows(id);
        const paramsWere = await storedParams(id);

        const response = await edit(id, { oid: '1.3.6.1.2.1.1.3.0', mode: to, unit: 'things' });
        assert.equal(response.statusCode, 409, response.body);
        const { error } = response.json<Envelope>();
        assert.equal(error.code, 'OBJECT_CHANNEL_MODE_FIXED');
        assert.match(error.message, new RegExp(`"value" from a ${from} into a ${to}`, 'u'));
        assert.match(error.message, /Add a new sensor/u, 'the message says what to do instead');
        assert.deepEqual(error.details['channels'], [{ key: 'value', from, to }]);
        assert.equal(error.details['sensorType'], 'snmp.custom');
        assert.equal(error.context['phase'], 'redeclare-channels');

        assert.deepEqual(await rows(id), was, 'the refused edit wrote a channel');
        assert.deepEqual(await storedParams(id), paramsWere, 'the refused edit wrote params');
      });
    }

    it('keeps a lookup an operator chose through an edit that does not change it', async () => {
      const id = await create('snmp.custom.string', {
        oid: '1.3.6.1.4.1.9.2.0',
        lookup: 'ms.snmp.if-oper-status',
      });
      const pointed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/value`,
        headers: { 'if-match': await etagOf(id) },
        payload: { lookupId: 'ms.operator.choice' },
      });
      assert.equal(pointed.statusCode, 200, pointed.body);

      // The OID moves, the declared lookup does not: the operator's choice stands.
      const moved = await edit(id, { oid: '1.3.6.1.4.1.9.3.0', lookup: 'ms.snmp.if-oper-status' });
      assert.equal(moved.statusCode, 200, moved.body);
      assert.equal((await rows(id))[0]?.lookup_id, 'ms.operator.choice');
      assert.deepEqual(await redeclaredEntries(id), [], 'an edit that changed no channel said so');

      // An edit that is about the lookup is the later decision.
      const relooked = await edit(id, { oid: '1.3.6.1.4.1.9.3.0', lookup: 'ms.test.newer' });
      assert.equal(relooked.statusCode, 200, relooked.body);
      assert.equal((await rows(id))[0]?.lookup_id, 'ms.test.newer');
    });

    it('re-declares table columns one by one, and refuses a column whose mode an edit flips', async () => {
      const id = await create('test.columns', {
        columns: [{ key: 'octets', counter: true }, { key: 'status' }],
      });

      // A column added by an edit is not written here: its first reading creates it (`P-297`).
      // Its lookup is new on `status`, and `octets`' width moved; both are written.
      const widened = await edit(id, {
        columns: [
          { key: 'octets', counter: true, bits: 32 },
          { key: 'status', lookup: 'ms.snmp.if-oper-status' },
          { key: 'errors', counter: true },
        ],
      });
      assert.equal(widened.statusCode, 200, widened.body);
      assert.deepEqual(
        (await rows(id)).map((row) => [row.key, row.lookup_id, row.counter_bits]),
        [
          ['octets', null, 32],
          ['status', 'ms.snmp.if-oper-status', null],
        ],
      );

      const flipped = await edit(id, {
        columns: [
          { key: 'octets', bits: 32 },
          { key: 'status', lookup: 'ms.snmp.if-oper-status' },
        ],
      });
      assert.equal(flipped.statusCode, 409, flipped.body);
      assert.deepEqual(flipped.json<Envelope>().error.details['channels'], [
        { key: 'octets', from: 'counter', to: 'gauge' },
      ]);

      // Taken out, the column keeps its row and its history; put back as the other mode, it is
      // the same channel, and the same refusal.
      const removed = await edit(id, { columns: [{ key: 'status' }] });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(
        (await rows(id)).map((row) => [row.key, row.lookup_id, row.counter_bits]),
        [
          ['octets', null, 32],
          ['status', null, null],
        ],
        'a removed column keeps its row',
      );
      const backAsGauge = await edit(id, { columns: [{ key: 'status' }, { key: 'octets' }] });
      assert.equal(backAsGauge.statusCode, 409, backAsGauge.body);
      const backAsCounter = await edit(id, {
        columns: [{ key: 'status' }, { key: 'octets', counter: true }],
      });
      assert.equal(backAsCounter.statusCode, 200, backAsCounter.body);
      assert.equal(
        (await rows(id)).find((row) => row.key === 'octets')?.counter_bits,
        64,
        'put back, the column takes the width its declaration now gives',
      );
    });

    it('makes ingestion forget the channel it cached, so the next reading is judged by the new lookup', async () => {
      const id = await create('snmp.custom.string', {
        oid: '1.3.6.1.4.1.9.4.0',
        lookup: 'ms.snmp.if-oper-status',
      });
      const reading = {
        sensorId: id,
        at: new Date('2026-10-08T10:00:00.000Z').toISOString(),
        outcome: 'ok' as const,
        message: '',
        durationMs: 1,
        channels: [{ key: 'value', value: 1 }],
      };
      const first = await db.tx((q) => resolver.resolve(q, [reading]));
      assert.equal(first.ids.get(`${String(id)}:value`)?.lookupId, 'ms.snmp.if-oper-status');

      const changed = await edit(id, { oid: '1.3.6.1.4.1.9.4.0', lookup: 'ms.test.other' });
      assert.equal(changed.statusCode, 200, changed.body);

      const second = await db.tx((q) => resolver.resolve(q, [reading]));
      assert.equal(second.ids.get(`${String(id)}:value`)?.lookupId, 'ms.test.other');
    });

    // ── which channel is primary (`P-309`) ─────────────────────────────────────────────────────

    const primaryOf = async (id: number): Promise<string[]> =>
      (
        await db.query<{ key: string }>(
          'SELECT key FROM channel WHERE sensor_id = $1 AND is_primary ORDER BY key',
          [id],
        )
      ).map((found) => found.key);

    it('makes the column an edit puts first the primary, as a create of those columns would', async () => {
      const id = await create('test.columns', { columns: [{ key: 'used' }, { key: 'free' }] });
      assert.deepEqual(await primaryOf(id), ['used'], 'as created');

      const reordered = await edit(id, { columns: [{ key: 'free' }, { key: 'used' }] });
      assert.equal(reordered.statusCode, 200, reordered.body);
      assert.deepEqual(await primaryOf(id), ['free']);
      assert.deepEqual(
        (await redeclaredEntries(id)).sort((a, b) =>
          String(a.channelKey).localeCompare(String(b.channelKey)),
        ),
        [
          {
            channelKey: 'free',
            diff: [{ field: 'channel.free.isPrimary', before: false, after: true }],
          },
          {
            channelKey: 'used',
            diff: [{ field: 'channel.used.isPrimary', before: true, after: false }],
          },
        ],
      );

      // Back again, on the version the edit answered with: the swap is not refused by the
      // one-primary index halfway, and the ETag is current.
      const back = await edit(
        id,
        { columns: [{ key: 'used' }, { key: 'free' }] },
        String(reordered.headers['etag']),
      );
      assert.equal(back.statusCode, 200, back.body);
      assert.deepEqual(await primaryOf(id), ['used']);
    });

    it('keeps the primary while the column put first has no row, and moves it off a removed one', async () => {
      const id = await create('test.columns', { columns: [{ key: 'used' }, { key: 'free' }] });

      // `fresh` has no row until its first reading, so the sensor keeps the primary it has
      // rather than none.
      const added = await edit(id, {
        columns: [{ key: 'fresh' }, { key: 'used' }, { key: 'free' }],
      });
      assert.equal(added.statusCode, 200, added.body);
      assert.deepEqual(await primaryOf(id), ['used'], 'a sensor left with no primary channel');

      // `used` is taken out and `free` leads: the removed row keeps its history, not the primary.
      const removed = await edit(id, { columns: [{ key: 'free' }] });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(await primaryOf(id), ['free']);
      assert.deepEqual(
        (await rows(id)).map((found) => found.key),
        ['free', 'used'],
        'a removed column keeps its row',
      );
    });

    // ── a type that cannot answer for what is stored (`P-311`) ─────────────────────────────────

    it('leaves a lookup as it is when the type cannot say what the stored parameters declared, and says so', async () => {
      const id = await create('test.columns', {
        columns: [{ key: 'value', lookup: 'ms.declared.first' }],
      });
      const pointed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/value`,
        headers: { 'if-match': await etagOf(id) },
        payload: { lookupId: 'ms.operator.choice' },
      });
      assert.equal(pointed.statusCode, 200, pointed.body);
      // Parameters this build's type throws for, as an older build could have stored them.
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        id,
        JSON.stringify({
          columns: [{ key: 'value', lookup: 'ms.declared.first' }, { key: UNREADABLE }],
        }),
      ]);
      lines.length = 0;

      const edited = await edit(id, { columns: [{ key: 'value', lookup: 'ms.declared.second' }] });
      assert.equal(edited.statusCode, 200, edited.body);
      assert.equal(
        (await rows(id))[0]?.lookup_id,
        'ms.operator.choice',
        'the operator’s lookup was replaced by an edit that could not tell it was theirs',
      );
      assert.deepEqual(await redeclaredEntries(id), []);

      const said = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['phase'] === 'redeclare-channels');
      assert.equal(said.length, 1, lines.join(''));
      const logged = said.at(0);
      assert.ok(logged !== undefined);
      assert.equal(logged['objectId'], id);
      assert.equal(logged['sensorType'], 'test.columns');
      assert.deepEqual(logged['channels'], ['value']);
      const err = logged['err'] as Record<string, unknown>;
      assert.equal(err['code'], 'Error');
      assert.equal(err['message'], 'no column called [a parameter] here');
      assert.ok(!lines.join('').includes(UNREADABLE), 'a parameter’s value reached the log');
    });

    // ── an edit and a channel's first reading at once (`P-303` review) ─────────────────────────

    /** A resolver that declares shapes, as `main.ts` builds it. */
    const declaring = (): ChannelResolver =>
      new ChannelResolver({
        logger: silent,
        declaredShape: declaredChannelLookup(testCatalogue(types)),
      });

    /** Until some session in this database waits on a lock: the other side is blocked. */
    const somebodyWaits = (what: string): Promise<void> =>
      within(
        10_000,
        what,
        (async () => {
          for (;;) {
            const waiting = await db.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            );
            if ((waiting[0]?.n ?? 0) > 0) return;
            await sleep(20);
          }
        })(),
      );

    /**
     * A table sensor with a column `x` its parameters declare and no row yet — added by an edit,
     * not yet reported — so `x` is ingestion's to create, with lookup `ms.test.old`.
     */
    const columnNotYetReported = async (): Promise<number> => {
      const id = await create('test.columns', { columns: [{ key: 'first' }] });
      await harness.service.update(
        testActor,
        id,
        {
          kind: 'sensor',
          params: { columns: [{ key: 'first' }, { key: 'x', lookup: 'ms.test.old' }] },
        },
        { kind: 'none' },
      );
      assert.deepEqual(
        (await rows(id)).map((row) => row.key),
        ['first'],
      );
      return id;
    };
    const renewed = { columns: [{ key: 'first' }, { key: 'x', lookup: 'ms.test.new' }] };
    const readingOfX = (id: number): CheckResult => ({
      sensorId: id,
      at: new Date('2026-10-08T11:00:00.000Z').toISOString(),
      outcome: 'ok',
      message: '',
      durationMs: 1,
      channels: [{ key: 'x', value: 1 }],
    });

    it('gives a channel first read during an edit the edit’s declaration, not the one it replaced', async () => {
      // The edit has written the new parameters and looked for `x`'s row — there is none — and
      // is held open before its commit. A first reading of `x` arrives. Read unlocked, its
      // parameters were the old ones, the edit committed having seen no row, and `x` kept
      // `ms.test.old` for good: the stored declaration then matched, so no edit looked again.
      const id = await columnNotYetReported();
      const ingesting = declaring();
      const was = harness.audit.also;
      let creating: Promise<unknown> | undefined;
      harness.audit.also = {
        record: async (_q, _actor, mutations) => {
          if (!mutations.some((one) => one.action === 'object.updated')) return;
          creating = db.tx((q) => ingesting.resolve(q, [readingOfX(id)]));
          await somebodyWaits('the first reading of x waiting for the edit');
        },
      };
      try {
        await harness.service.update(
          testActor,
          id,
          { kind: 'sensor', params: renewed },
          { kind: 'none' },
        );
      } finally {
        harness.audit.also = was;
      }
      assert.ok(creating !== undefined, 'the edit never reached its audit entry');
      await within(10_000, 'the first reading of x', creating);

      assert.equal(
        (await rows(id)).find((row) => row.key === 'x')?.lookup_id,
        'ms.test.new',
        'the channel was created from the parameters the edit replaced',
      );
    });

    it('re-declares a channel whose first reading committed while the edit waited', async () => {
      // The other order: the reading holds its sensor while it creates `x`, the edit waits, and
      // then finds the row and writes the new declaration over it.
      const id = await columnNotYetReported();
      const ingesting = declaring();
      let editing: Promise<unknown> | undefined;
      await db.tx(async (q) => {
        await ingesting.resolve(q, [readingOfX(id)]);
        editing = harness.service.update(
          testActor,
          id,
          { kind: 'sensor', params: renewed },
          { kind: 'none' },
        );
        await somebodyWaits('the edit waiting for the first reading of x');
      });
      assert.ok(editing !== undefined);
      await within(10_000, 'the edit', editing);

      assert.equal((await rows(id)).find((row) => row.key === 'x')?.lookup_id, 'ms.test.new');
    });
  },
);

const draft = (key: string, more: Partial<ChannelDraft> = {}): ChannelDraft => ({
  key,
  name: key,
  ...more,
});

const row = (key: string, more: Partial<StoredChannel> = {}): StoredChannel => ({
  key,
  name: key,
  unit: '',
  lookupId: null,
  counterBits: null,
  isPrimary: false,
  ...more,
});

/**
 * The rule itself, one case a row: what the stored parameters declared, what the edit declares,
 * what the row holds, and what is written or refused.
 */
describe('what an edit re-declares', () => {
  const cases: {
    name: string;
    stored: readonly ChannelDraft[] | null;
    next: readonly ChannelDraft[];
    rows: readonly StoredChannel[];
    written?: readonly (readonly [string, Partial<StoredChannel>])[];
    /** The lookups left as the rows hold them for want of the stored answer (`P-311`). */
    kept?: readonly string[];
    refused?: readonly { key: string; from: 'counter' | 'gauge'; to: 'counter' | 'gauge' }[];
  }[] = [
    {
      name: 'nothing, when the declaration did not move',
      stored: [draft('value', { lookup: 'a' })],
      next: [draft('value', { lookup: 'a' })],
      rows: [row('value', { lookupId: 'operator' })],
      written: [],
    },
    {
      name: 'a lookup the edit changed, over whatever the row held',
      stored: [draft('value', { lookup: 'a' })],
      next: [draft('value', { lookup: 'b' })],
      rows: [row('value', { lookupId: 'operator' })],
      written: [['value', { lookupId: 'b' }]],
    },
    {
      name: 'only the fields that moved',
      stored: [draft('value', { unit: 'C', lookup: 'a' })],
      next: [draft('value', { name: 'Renamed', unit: 'C', lookup: 'a' })],
      rows: [row('value', { unit: 'C', lookupId: 'operator' })],
      written: [['value', { name: 'Renamed', unit: 'C', lookupId: 'operator' }]],
    },
    {
      name: 'nothing, when the row already holds the new declaration',
      stored: [draft('value', { lookup: 'a' })],
      next: [draft('value', { lookup: 'b' })],
      rows: [row('value', { lookupId: 'b' })],
      written: [],
    },
    {
      name: 'every field of a key the stored answer did not name',
      stored: [draft('first')],
      next: [draft('first'), draft('back', { name: 'Back', lookup: 'b' })],
      rows: [row('first'), row('back', { lookupId: 'old' })],
      written: [['back', { name: 'Back', lookupId: 'b' }]],
    },
    {
      name: 'no lookup, when the stored answer cannot be had: the row’s may be an operator’s',
      stored: null,
      next: [draft('value', { lookup: 'b' })],
      rows: [row('value', { lookupId: 'a' })],
      written: [],
      kept: ['value'],
    },
    {
      name: 'the other fields against the rows, when the stored answer cannot be had',
      stored: null,
      next: [draft('value', { name: 'Renamed', unit: 'C', lookup: 'a', counterBits: 32 })],
      rows: [row('value', { lookupId: 'a', counterBits: 64 })],
      written: [['value', { name: 'Renamed', unit: 'C', counterBits: 32 }]],
    },
    {
      name: 'a refusal against the row, when the stored answer cannot be had',
      stored: null,
      next: [draft('value', { counterBits: 64, lookup: 'b' })],
      rows: [row('value')],
      refused: [{ key: 'value', from: 'gauge', to: 'counter' }],
    },
    {
      name: 'the primary, moved to the column the edit puts first',
      stored: [draft('a', { isPrimary: true }), draft('b')],
      next: [draft('b', { isPrimary: true }), draft('a')],
      rows: [row('a', { isPrimary: true }), row('b')],
      written: [
        ['b', { isPrimary: true }],
        ['a', { isPrimary: false }],
      ],
    },
    {
      name: 'the primary, kept while the declared one has no row',
      stored: [draft('a', { isPrimary: true })],
      next: [draft('fresh', { isPrimary: true }), draft('a')],
      rows: [row('a', { isPrimary: true })],
      written: [],
    },
    {
      name: 'the primary, taken off a removed key when the declared one has a row',
      stored: [draft('a', { isPrimary: true }), draft('b')],
      next: [draft('b', { isPrimary: true })],
      rows: [row('a', { isPrimary: true }), row('b')],
      written: [
        ['b', { isPrimary: true }],
        ['a', { isPrimary: false }],
      ],
    },
    {
      name: 'the primary, given to a sensor with none whatever the stored answer said',
      stored: [draft('a', { isPrimary: true })],
      next: [draft('a', { isPrimary: true, name: 'A' })],
      rows: [row('a')],
      written: [['a', { name: 'A', isPrimary: true }]],
    },
    {
      name: 'the primary, left as the rows hold it when the edit declares none',
      stored: [draft('a')],
      next: [draft('a', { lookup: 'x' })],
      rows: [row('a', { isPrimary: true })],
      written: [['a', { lookupId: 'x' }]],
    },
    {
      name: 'a counter’s new width',
      stored: [draft('value', { counterBits: 64 })],
      next: [draft('value', { counterBits: 32 })],
      rows: [row('value', { counterBits: 64 })],
      written: [['value', { counterBits: 32 }]],
    },
    {
      name: 'nothing for a key with no row: its first reading creates it',
      stored: [draft('first')],
      next: [draft('first'), draft('added', { counterBits: 64 })],
      rows: [row('first')],
      written: [],
    },
    {
      name: 'a refusal for a gauge turned counter',
      stored: [draft('value')],
      next: [draft('value', { counterBits: 64 })],
      rows: [row('value')],
      refused: [{ key: 'value', from: 'gauge', to: 'counter' }],
    },
    {
      name: 'a refusal for a counter turned gauge, with nothing else written',
      stored: [draft('octets', { counterBits: 64 }), draft('status')],
      next: [draft('octets'), draft('status', { lookup: 'b' })],
      rows: [row('octets', { counterBits: 64 }), row('status')],
      refused: [{ key: 'octets', from: 'counter', to: 'gauge' }],
    },
    {
      name: 'a refusal for a key put back as the other mode',
      stored: [draft('first')],
      next: [draft('first'), draft('back')],
      rows: [row('first'), row('back', { counterBits: 64 })],
      refused: [{ key: 'back', from: 'counter', to: 'gauge' }],
    },
    {
      name: 'no refusal when the row already has the mode the edit declares',
      stored: [draft('value', { counterBits: 64 })],
      next: [draft('value')],
      rows: [row('value')],
      written: [],
    },
    {
      name: 'a row whose mode no declaration matches, left alone by an edit that moves neither',
      stored: [draft('value', { counterBits: 64, lookup: 'a' })],
      next: [draft('value', { counterBits: 64, lookup: 'b' })],
      rows: [row('value', { lookupId: 'a' })],
      written: [['value', { lookupId: 'b' }]],
    },
  ];

  for (const one of cases) {
    it(one.name, () => {
      const plan = planRedeclaration(one.stored, one.next, one.rows);
      if (one.refused !== undefined) {
        assert.deepEqual(plan, { kind: 'refused', modeChanges: one.refused });
        return;
      }
      assert.equal(plan.kind, 'redeclare');
      assert.deepEqual(plan.lookupsKept, one.kept ?? []);
      assert.deepEqual(
        plan.changes.map((change) => [change.key, change.after]),
        (one.written ?? []).map(([key, more]) => {
          const was = one.rows.find((stored) => stored.key === key);
          assert.ok(was !== undefined, `no row for ${key} in the case`);
          const { key: _key, ...declaration } = { ...was, ...more };
          return [key, declaration];
        }),
      );
      for (const change of plan.changes) {
        const was = one.rows.find((stored) => stored.key === change.key);
        assert.ok(was !== undefined);
        const { key: _key, ...declaration } = was;
        assert.deepEqual(change.before, declaration, 'before is the row as it was');
      }
    });
  }
});
