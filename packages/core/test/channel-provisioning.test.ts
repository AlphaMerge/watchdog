import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { SensorCatalogue, standardCatalogue, type SensorType } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { declaredChannelLookup, declaredLimitsLookup } from '../src/state/declared-limits.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

const available = await databaseAvailable();

/**
 * A type whose channels are the columns its parameters name, each a counter or a lookup as the
 * parameters say — `snmp.table`'s shape without SNMP (`P-297`). Its `{}` answer is a placeholder
 * that declares neither, as the real one's is.
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
            lookup: { type: 'string' },
          },
        },
      },
    },
  },
  channels: (params) => {
    const named = Array.isArray(params['columns'])
      ? (params['columns'] as { key: string; counter?: boolean; lookup?: string }[])
      : [];
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    return named.map((column, at) => ({
      key: column.key,
      name: column.key,
      ...(at === 0 ? { isPrimary: true } : {}),
      ...(column.counter === true ? { counter: { bits: 64 as const } } : {}),
      ...(column.lookup === undefined ? {} : { lookup: column.lookup }),
    }));
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * What a channel gets when **ingestion** creates it rather than sensor creation (`P-80`).
 *
 * `ChannelResolver.resolve` is the only path by which a key a sensor type newly declares reaches
 * the `channel` table on a sensor that already exists — every upgrade, in other words. Its INSERT
 * wrote `limits` and nothing else, so a channel born this way had `lookup_id = NULL` and
 * `counter_bits = NULL`, and neither was noticed because both readers fail *quietly*:
 * `evaluateChannel` falls through every branch and judges the channel by nothing at all, and the
 * counter-to-rate conversion is gated on `counterBits !== null` and simply stores the raw total.
 *
 * The consequence was that `delivering` (`P-74`), `checksCompleting` (`P-76`) and `poolState`
 * (`P-62`) — the headline alarm of each of those tickets, all lookup channels with no limits —
 * could not fire at all on any installation that predated them. On a fresh install the same
 * outage produced Down with the right message; on an upgraded one the sensor stayed Up.
 */
describe(
  'a channel that ingestion creates',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let sensorId: number;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('provisioning');
      db = scratch.db;
      harness = await buildHarness(db, { types: [columns] });
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'router',
        host: '192.0.2.30',
      });
      deviceId = device.id;
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'eth0',
        sensorType: 'snmp.traffic',
        params: {},
      });
      sensorId = sensor.id;

      // **Simulating an installation that predates these channels**, which is the only state in
      // which this path runs. Creation already writes them correctly — that is why the defect
      // was invisible to every test in the suite, all of which create their sensors on this build.
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensorId]);
    });

    after(async () => {
      await scratch.drop();
    });

    it('carries the lookup and counter width its type declares, not just its limits', async () => {
      const catalogue = testCatalogue();
      const resolver = new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
      });

      const result: CheckResult = {
        sensorId,
        at: new Date('2026-09-04T10:00:00.000Z').toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [
          { key: 'in', value: 1_000, counter: '1000', counterBits: 64 },
          { key: 'status', value: 1 },
        ],
      };
      await db.tx((q) => resolver.resolve(q, [result]));

      const rows = await db.query<{
        key: string;
        lookup_id: string | null;
        counter_bits: number | null;
      }>('SELECT key, lookup_id, counter_bits FROM channel WHERE sensor_id = $1 ORDER BY key', [
        sensorId,
      ]);
      const byKey = new Map(rows.map((row) => [row.key, row]));

      // The lookup channel. Null here is what left `ms.probe.delivery`, `ms.probe.checks` and
      // `ms.probe.pool` judged by nothing on every upgraded installation.
      assert.equal(byKey.get('status')?.lookup_id, 'ms.snmp.if-oper-status');
      // And the counter width. Null here stores a cumulative total where a rate was declared, so
      // a limit written for a rate — `spoolUnwritten`'s `upperError: 0.00001`, for instance —
      // latches Down for the life of the probe process and cannot be cleared.
      assert.equal(byKey.get('in')?.counter_bits, 64);
    });

    it('reads a column an edit added from the sensor’s own parameters, not `{}` (P-297)', async () => {
      // **The case `{}` cannot answer.** An edit replaces a sensor's parameters and declares no
      // channels, so a column it adds reaches the `channel` table here, on its first reading.
      // `{}` answers this type with a placeholder `value` that is neither a counter nor a lookup,
      // so read from it the new counter stored cumulative totals and the new status column was
      // judged by nothing.
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'table',
        sensorType: 'test.columns',
        params: { columns: [{ key: 'first' }] },
      });
      await harness.service.update(
        testActor,
        sensor.id,
        {
          kind: 'sensor',
          params: {
            columns: [
              { key: 'first' },
              { key: 'errors', counter: true },
              { key: 'status', lookup: 'ms.snmp.if-oper-status' },
            ],
          },
        },
        { kind: 'none' },
      );
      const declared = await db.query<{ key: string }>(
        'SELECT key FROM channel WHERE sensor_id = $1 ORDER BY key',
        [sensor.id],
      );
      assert.deepEqual(
        declared.map((row) => row.key),
        ['first'],
        'the edit declared no channels, so the two new columns are this path’s to create',
      );

      const catalogue = testCatalogue([columns]);
      const resolver = new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
      });
      await db.tx((q) =>
        resolver.resolve(q, [
          {
            sensorId: sensor.id,
            at: new Date('2026-10-08T10:00:00.000Z').toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'first', value: 1 },
              { key: 'errors', value: 5, counter: '5', counterBits: 64 },
              { key: 'status', value: 1 },
              // Named by no column: a key the sensor's own answer does not declare has neither,
              // whatever `{}` says about it.
              { key: 'value', value: 1 },
            ],
          },
        ]),
      );

      const rows = await db.query<{
        key: string;
        lookup_id: string | null;
        counter_bits: number | null;
      }>('SELECT key, lookup_id, counter_bits FROM channel WHERE sensor_id = $1 ORDER BY key', [
        sensor.id,
      ]);
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          { key: 'errors', lookup_id: null, counter_bits: 64 },
          { key: 'first', lookup_id: null, counter_bits: null },
          { key: 'status', lookup_id: 'ms.snmp.if-oper-status', counter_bits: null },
          { key: 'value', lookup_id: null, counter_bits: null },
        ],
      );
    });
  },
);

interface Shape {
  lookup: string | null;
  counterBits: number | null;
}

/**
 * What `declaredChannelLookup` answers for one sensor (`P-297`), against the shipped catalogue.
 *
 * Each row is a shipped type that is not `fixedChannels` and declares a lookup or a counter.
 * `bare` is what `{}` says, which is what every sensor was given before: it differs from the
 * sensor's answer wherever a parameter chose. `snmp.traffic`'s status is the row where they agree,
 * and the reason reading the fixed types alone, as the limits do, would lose something.
 */
describe('the lookup and counter width a sensor’s own parameters declare', () => {
  const catalogue = standardCatalogue();
  const shipped = declaredChannelLookup(catalogue);
  const ifTable = '1.3.6.1.2.1.2.2.1';
  const twoColumns = [
    { column: '10', name: 'Octets in', mode: 'counter' },
    { column: '8', name: 'Status', lookup: 'ms.snmp.if-oper-status' },
  ];
  const cases: readonly {
    name: string;
    type: string;
    params: Record<string, unknown>;
    key: string;
    shape: Shape | undefined;
    bare: Shape | undefined;
  }[] = [
    {
      name: 'snmp.custom in counter mode is a counter',
      type: 'snmp.custom',
      params: { oid: '1.3.6.1.2.1.1.3.0', mode: 'counter' },
      key: 'value',
      shape: { lookup: null, counterBits: 64 },
      bare: { lookup: null, counterBits: null },
    },
    {
      name: 'snmp.custom.string carries the lookup its parameters name',
      type: 'snmp.custom.string',
      params: { oid: '1.3.6.1.2.1.1.1.0', lookup: 'ms.snmp.if-oper-status' },
      key: 'value',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: { lookup: null, counterBits: null },
    },
    {
      name: 'an snmp.table counter column',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'col10',
      shape: { lookup: null, counterBits: 64 },
      bare: undefined,
    },
    {
      name: 'an snmp.table lookup column',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'col8',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: undefined,
    },
    {
      name: 'snmp.table’s placeholder, which no sensor with columns declares',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'value',
      shape: undefined,
      bare: { lookup: null, counterBits: null },
    },
    {
      name: 'snmp.traffic forced to 32 bits',
      type: 'snmp.traffic',
      params: { counterWidth: '32' },
      key: 'in',
      shape: { lookup: null, counterBits: 32 },
      bare: { lookup: null, counterBits: 64 },
    },
    {
      name: 'snmp.traffic’s status lookup, which no parameter changes',
      type: 'snmp.traffic',
      params: { counterWidth: 'auto' },
      key: 'status',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
    },
  ];

  for (const one of cases) {
    it(one.name, () => {
      // Asked first: an unregistered type answers nothing, which would pass a row expecting it.
      assert.ok(catalogue.has(one.type), `${one.type} is not a shipped type`);
      assert.equal(catalogue.declaration(one.type).fixedChannels, undefined, 'not a fixed type');
      assert.deepEqual(shipped(one.type, one.params).get(one.key), one.shape, 'the sensor');
      assert.deepEqual(shipped(one.type, {}).get(one.key), one.bare, '`{}`');
    });
  }

  it('answers nothing for a type this build does not register', () => {
    assert.equal(shipped('gone.type', { anything: 1 }).size, 0);
  });

  it('falls back to `{}` only when the sensor’s own answer cannot be had', () => {
    const fragile: SensorType = {
      ...columns,
      id: 'test.fragile',
      channels: (params) => {
        if (params['broken'] === true) throw new Error('cannot read these parameters');
        // A limit on a channel only parameters make, which `channelsFor` refuses (`P-293`): a
        // sensor stored before that rule existed.
        if (params['limited'] === true) {
          return [
            { key: 'total', name: 'Total', isPrimary: true, counter: { bits: 32 } },
            { key: 'extra', name: 'Extra', limits: { upperError: 1 } },
          ];
        }
        return [{ key: 'total', name: 'Total', isPrimary: true, counter: { bits: 64 } }];
      },
    };
    const unanswerable: SensorType = {
      ...columns,
      id: 'test.unanswerable',
      channels: (params) => {
        if (params['columns'] === undefined) throw new Error('names no columns');
        return [{ key: 'one', name: 'One', isPrimary: true, counter: { bits: 64 } }];
      },
    };
    const catalogue = new SensorCatalogue();
    catalogue.register(fragile);
    catalogue.register(unanswerable);
    const shapes = declaredChannelLookup(catalogue.seal());

    const bare: Shape = { lookup: null, counterBits: 64 };
    assert.deepEqual(shapes('test.fragile', { broken: true }).get('total'), bare);
    assert.deepEqual(shapes('test.fragile', { limited: true }).get('total'), bare);
    assert.equal(shapes('test.fragile', { limited: true }).get('extra'), undefined);
    // With no `{}` answer to fall back on it answers nothing, rather than throwing into ingestion.
    assert.equal(shapes('test.unanswerable', {}).size, 0);
    assert.deepEqual(shapes('test.unanswerable', { columns: [] }).get('one'), bare);
  });
});
