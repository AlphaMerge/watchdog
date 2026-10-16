import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { SensorType } from '@ms/sensors';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** What this build of `test.declares` declares for `status`. A test moves it, as an upgrade can. */
let declared = 'ms.snmp.if-oper-status';

/** A status channel with a declared lookup beside a value with none, as `snmp.traffic` has. */
const declares: SensorType = {
  id: 'test.declares',
  category: 'Custom',
  costHint: 'light',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { gen: { type: 'integer' } },
  },
  channels: (params) => {
    if (params['gen'] === 99) throw new TypeError('generation not understood');
    return [
      { key: 'value', name: 'Value', isPrimary: true },
      { key: 'status', name: 'Status', lookup: declared },
    ];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

interface Channel {
  key: string;
  lookupId: string | null;
  declaredLookup: string | null;
}

/**
 * The lookup a channel's type declares, on every channel record (`U-82`): what the channel table
 * offers first when an operator sets one, for a channel that has none (`P-308`) or another.
 */
describe(
  'a channel record carries the lookup its type declares (U-82)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('declared_lookup');
      db = scratch.db;
      harness = await buildHarness(db, { types: [declares] });
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
        catalogue: testCatalogue([declares]),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'switch',
        host: '192.0.2.82',
      });
      deviceId = device.id;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(() => {
      declared = 'ms.snmp.if-oper-status';
    });

    let made = 0;
    const sensor = async (): Promise<number> => {
      made += 1;
      return (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `declares-${String(made)}`,
          sensorType: 'test.declares',
          params: {},
        })
      ).id;
    };

    const byKey = (channels: readonly Channel[]): Record<string, [string | null, string | null]> =>
      Object.fromEntries(
        channels.map((channel) => [channel.key, [channel.lookupId, channel.declaredLookup]]),
      );

    const listed = async (id: number): Promise<LightMyRequestResponse> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}/channels`,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response;
    };

    it('says it beside the lookup the channel has, on the list, the detail and a set’s answer', async () => {
      const id = await sensor();
      assert.deepEqual(byKey((await listed(id)).json<{ items: Channel[] }>().items), {
        value: [null, null],
        status: ['ms.snmp.if-oper-status', 'ms.snmp.if-oper-status'],
      });

      // Cleared, as somebody may have, or as a clone before `P-302` left it: still declared.
      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(id)}/channels/status`,
        payload: { lookupId: null },
      });
      assert.equal(cleared.statusCode, 200, cleared.body);
      const answer = cleared.json<Channel>();
      assert.equal(answer.lookupId, null);
      assert.equal(answer.declaredLookup, 'ms.snmp.if-oper-status');

      // Another set by hand: the declared one is still the one offered first.
      await harness.service.patchChannel(testActor, id, 'status', { lookupId: 'ms.probe.link' });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}?include=channels`,
      });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.deepEqual(byKey(detail.json<{ channels: Channel[] }>().channels), {
        value: [null, null],
        status: ['ms.probe.link', 'ms.snmp.if-oper-status'],
      });
      assert.deepEqual(byKey(await harness.service.channels(id)), {
        value: [null, null],
        status: ['ms.probe.link', 'ms.snmp.if-oper-status'],
      });
    });

    it('says none where the type cannot answer for the stored parameters, or is not registered', async () => {
      const id = await sensor();
      // Stored behind the type's back, as an earlier build could have left them.
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        id,
        JSON.stringify({ gen: 99 }),
      ]);
      assert.deepEqual(byKey((await listed(id)).json<{ items: Channel[] }>().items), {
        value: [null, null],
        status: ['ms.snmp.if-oper-status', null],
      });
      await db.query(
        `UPDATE sensor_config SET type = 'test.not-in-this-build' WHERE object_id = $1`,
        [id],
      );
      assert.deepEqual(byKey((await listed(id)).json<{ items: Channel[] }>().items), {
        value: [null, null],
        status: ['ms.snmp.if-oper-status', null],
      });
    });

    it('moves the detail’s tag when a build declares another lookup, which moves no version', async () => {
      const id = await sensor();
      const url = `/api/v1/objects/${String(id)}?include=channels`;
      const first = await app.inject({ method: 'GET', url });
      assert.equal(first.statusCode, 200, first.body);
      const tag = String(first.headers['etag']);
      const unchanged = await app.inject({ method: 'GET', url, headers: { 'if-none-match': tag } });
      assert.equal(unchanged.statusCode, 304, 'nothing changed, so revalidated');

      declared = 'ms.probe.link';
      const upgraded = await app.inject({ method: 'GET', url, headers: { 'if-none-match': tag } });
      assert.equal(upgraded.statusCode, 200, 'a 304 would keep the old declaration on screen');
      assert.deepEqual(byKey(upgraded.json<{ channels: Channel[] }>().channels)['status'], [
        'ms.snmp.if-oper-status',
        'ms.probe.link',
      ]);
      const again = await app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': String(upgraded.headers['etag']) },
      });
      assert.equal(again.statusCode, 304, 'and settles on the new tag');
    });
  },
);
