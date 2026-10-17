import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { BUILT_IN_SENSOR_TYPES, type SensorType } from '@ms/sensors';
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

const snmpTable: SensorType = (() => {
  const found = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'snmp.table');
  assert.ok(found !== undefined, 'snmp.table is not a built-in sensor type');
  return found;
})();

const TABLE_OID = '1.3.6.1.2.1.2.2.1';

interface Declared {
  key: string;
  name: string;
  unit: string;
  isPrimary: boolean;
  lookupId: string | null;
  counterBits: number | null;
}

interface Row extends Declared {
  retired: boolean;
}

/**
 * The channels a set of parameters would declare, asked of the core (`U-40`), and what each
 * channel stores on the channel list.
 *
 * An edit that takes an `snmp.table` column out keeps its channel (`P-310`); an edit that puts it
 * back as the other mode is refused (`P-303`). The edit form holds such a column to what its kept
 * channel stores, and needs two answers for it: which channel the column lands on, which is the
 * type's to say (`POST /sensor-types/{id}/channels`), and what that channel stores (`counterBits`
 * on the channel list). These hold both to what the core does: the dry run is what a create
 * writes, and its comparison with the row is the one the edit's refusal makes. The shipped
 * `snmp.table`, so the keys are the real type's.
 */
describe(
  'the channels parameters would declare, and what each channel stores (U-40)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('declared_channels');
      db = scratch.db;
      harness = await buildHarness(db, { types: [snmpTable] });
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
        catalogue: testCatalogue([snmpTable]),
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
        host: '192.0.2.40',
      });
      deviceId = device.id;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    const declare = (params: unknown, typeId = 'snmp.table'): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: `/api/v1/sensor-types/${typeId}/channels`,
        payload: { params },
      });

    const listed = async (id: number): Promise<Row[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}/channels`,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ items: Row[] }>().items;
    };

    const declaredOf = (row: Row): Declared => ({
      key: row.key,
      name: row.name,
      unit: row.unit,
      isPrimary: row.isPrimary,
      lookupId: row.lookupId,
      counterBits: row.counterBits,
    });

    let made = 0;
    const create = async (params: Record<string, unknown>): Promise<number> => {
      made += 1;
      return (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `table-${String(made)}`,
          sensorType: 'snmp.table',
          params,
        })
      ).id;
    };

    const PARAMS = {
      tableOid: TABLE_OID,
      columns: [
        { column: '10', name: 'In', unit: 'octets', mode: 'counter' },
        { column: '8', name: 'Status', lookup: 'ms.snmp.if-oper-status' },
        { column: '1.2', name: 'Nested' },
      ],
    };

    it('answers what a create of the parameters writes, defaults and all', async () => {
      const response = await declare(PARAMS);
      assert.equal(response.statusCode, 200, response.body);
      const answer = response.json<{ sensorType: string; channels: Declared[] }>();
      assert.equal(answer.sensorType, 'snmp.table');
      assert.deepEqual(answer.channels, [
        // A counter's unit is per second, as the type labels it; absent `mode` is the gauge.
        {
          key: 'col10',
          name: 'In',
          unit: 'octets/s',
          isPrimary: true,
          lookupId: null,
          counterBits: 64,
        },
        {
          key: 'col8',
          name: 'Status',
          unit: '',
          isPrimary: false,
          lookupId: 'ms.snmp.if-oper-status',
          counterBits: null,
        },
        {
          key: 'col1_2',
          name: 'Nested',
          unit: '',
          isPrimary: false,
          lookupId: null,
          counterBits: null,
        },
      ]);

      // The rows a create of the same parameters writes say the same, field for field.
      const id = await create(PARAMS);
      const rows = (await listed(id)).map(declaredOf);
      assert.deepEqual(
        [...rows].sort((a, b) => a.key.localeCompare(b.key)),
        [...answer.channels].sort((a, b) => a.key.localeCompare(b.key)),
      );
    });

    it('refuses what a create refuses, and a type nobody registered, and writes nothing', async () => {
      const objects = async (): Promise<string | undefined> =>
        (await db.query<{ n: string }>('SELECT count(*) AS n FROM object'))[0]?.n;
      const before = await objects();
      harness.audit.recorded.length = 0;

      // No name on a column: the schema's `required`, as the create would say it.
      const invalid = await declare({ tableOid: TABLE_OID, columns: [{ column: '6' }] });
      assert.equal(invalid.statusCode, 400, invalid.body);
      const error = invalid.json<{
        error: { code: string; details: { problems: { path: string }[] } };
      }>().error;
      assert.equal(error.code, 'OBJECT_INVALID');
      assert.ok(error.details.problems.length > 0, invalid.body);

      // No params at all is the body's own refusal.
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/v1/sensor-types/snmp.table/channels' }))
          .statusCode,
        400,
      );

      const missing = await declare({}, 'nope.missing');
      assert.equal(missing.statusCode, 404, missing.body);
      assert.match(missing.json<{ error: { message: string } }>().error.message, /nope\.missing/u);

      assert.equal(await objects(), before);
      assert.deepEqual(harness.audit.recorded, [], 'nothing changed, so nothing to audit');
    });

    it('says what each channel stores, and a column taken out keeps it, as the edit is judged', async () => {
      const id = await create({
        tableOid: TABLE_OID,
        columns: [
          { column: '10', name: 'In', mode: 'counter' },
          { column: '6', name: 'Errors', mode: 'counter' },
          { column: '8', name: 'Status' },
        ],
      });
      const stores = (rows: readonly Row[]): Record<string, [number | null, boolean]> =>
        Object.fromEntries(rows.map((row) => [row.key, [row.counterBits, row.retired]]));
      assert.deepEqual(stores(await listed(id)), {
        col10: [64, false],
        col6: [64, false],
        col8: [null, false],
      });

      // Column 6 taken out: its row stays, retired, and still says it stores a counter.
      const edit = (columns: Record<string, unknown>[]) =>
        harness.service.update(
          testActor,
          id,
          { kind: 'sensor', params: { tableOid: TABLE_OID, columns } },
          { kind: 'none' },
        );
      await edit([
        { column: '10', name: 'In', mode: 'counter' },
        { column: '8', name: 'Status' },
      ]);
      assert.deepEqual(stores(await listed(id)), {
        col10: [64, false],
        col6: [64, true],
        col8: [null, false],
      });

      // What the form asks when column 6 is put back: the stored parameters with that column
      // alone. As a gauge it lands on col6 as a gauge — not what the row stores — and the edit
      // is refused for exactly that channel; as a counter it matches, and is accepted.
      const putBack = async (mode: string): Promise<Declared[]> =>
        (
          await declare({ tableOid: TABLE_OID, columns: [{ column: '6', name: 'Errors', mode }] })
        ).json<{ channels: Declared[] }>().channels;
      assert.deepEqual(
        (await putBack('gauge')).map((one) => [one.key, one.counterBits]),
        [['col6', null]],
      );
      await assert.rejects(
        edit([
          { column: '10', name: 'In', mode: 'counter' },
          { column: '8', name: 'Status' },
          { column: '6', name: 'Errors', mode: 'gauge' },
        ]),
        (error: unknown) => {
          const refused = error as { code?: string; details?: { channels?: unknown } };
          assert.equal(refused.code, 'OBJECT_CHANNEL_MODE_FIXED');
          assert.deepEqual(refused.details?.channels, [
            { key: 'col6', from: 'counter', to: 'gauge' },
          ]);
          return true;
        },
      );
      assert.deepEqual(
        (await putBack('counter')).map((one) => [one.key, one.counterBits]),
        [['col6', 64]],
      );
      await edit([
        { column: '10', name: 'In', mode: 'counter' },
        { column: '8', name: 'Status' },
        { column: '6', name: 'Errors', mode: 'counter' },
      ]);
      assert.deepEqual(stores(await listed(id)), {
        col10: [64, false],
        col6: [64, false],
        col8: [null, false],
      });
    });
  },
);
