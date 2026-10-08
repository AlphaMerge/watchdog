import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import { SensorCatalogue, standardCatalogue, type SensorType } from '@ms/sensors';
import { encodedForms, type CheckResult, type IngestionConfig } from '@ms/shared';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
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
 * A type that cannot answer for some stored parameters (`P-297` review): `limited` puts limits on
 * a channel only parameters make, which `channelsFor` refuses with `BAD_SENSOR_TYPE` (`P-293`),
 * and `typeError` is a type's own bug, with a secret and a label in its message. Its `{}` answer
 * is a 64-bit counter, which is what the fallback gives.
 */
const brittle: SensorType = {
  id: 'test.brittle',
  category: 'Custom',
  costHint: 'light',
  secretDestinations: { token: [] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { enum: ['fine', 'limited', 'typeError'] },
      token: { type: 'string', writeOnly: true },
      label: { type: 'string' },
    },
  },
  channels: (params) => {
    if (params['mode'] === 'typeError') {
      const token = String(params['token']);
      // As spelled, base64'd as a header carries it, and JSON-escaped inside the parameters
      // (`P-305` review): a type quoting what it was given in any of them.
      throw new TypeError(
        `no column "${String(params['label'])}" readable with ${token} ` +
          `(${Buffer.from(token, 'utf8').toString('base64')}, ${JSON.stringify(params)})`,
      );
    }
    return [
      { key: 'value', name: 'Value', isPrimary: true, counter: { bits: 64 } },
      ...(params['mode'] === 'limited'
        ? [{ key: 'bounded', name: 'Bounded', limits: { upperError: 1 } }]
        : []),
    ];
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
      harness = await buildHarness(db, { types: [columns, brittle] });
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

    it('says once, without a parameter’s value, when a type cannot answer for a sensor', async () => {
      // `P-297` review. The fallback is still taken, so the batch keeps its readings, but a
      // channel created from it may never get its lookup or counter width, and that is logged.
      const SECRET = 'k9'; // short, so only being a secret takes it out of the message
      const LABEL = 'router-west';
      const sensors: number[] = [];
      for (const name of ['type-error', 'type-error-again', 'limited', 'limited-again']) {
        const sensor = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name,
          sensorType: 'test.brittle',
          params: { mode: 'fine' },
        });
        sensors.push(sensor.id);
      }
      // Stored behind the type's back, as an earlier build or an earlier rule would have left
      // them: a create with these is refused now (`P-296`).
      const [typeError, typeErrorAgain, limitedOne, limitedAgain] = sensors as [
        number,
        number,
        number,
        number,
      ];
      for (const [id, mode] of [
        [typeError, 'typeError'],
        [typeErrorAgain, 'typeError'],
        [limitedOne, 'limited'],
        [limitedAgain, 'limited'],
      ] as const) {
        await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
          id,
          JSON.stringify({ mode, token: SECRET, label: LABEL }),
        ]);
      }
      await db.query('DELETE FROM channel WHERE sensor_id = ANY($1::bigint[])', [sensors]);

      const lines: string[] = [];
      const catalogue = testCatalogue([columns, brittle]);
      const resolver = new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue, {
          logger: pino(
            { level: 'info', base: null },
            { write: (line: string) => lines.push(line) },
          ),
        }),
      });
      const reading = (sensorId: number, key: string): CheckResult => ({
        sensorId,
        at: new Date('2026-10-08T11:00:00.000Z').toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [{ key, value: 1 }],
      });
      const resolved = await db.tx((q) =>
        resolver.resolve(
          q,
          sensors.map((id) => reading(id, 'value')),
        ),
      );
      // And a later channel of the first sensor: the same type, the same kind of error.
      const later = await db.tx((q) => resolver.resolve(q, [reading(typeError, 'later')]));

      assert.equal(resolved.created, 4, 'every channel was still created');
      assert.equal(resolved.droppedReadings, 0);
      // `P-306`: and every one of them counted, though the log said it twice.
      assert.equal(resolved.createdUndeclared, 4);
      assert.equal(later.created, 1);
      assert.equal(later.createdUndeclared, 1);
      const rows = await db.query<{ sensor_id: string; key: string; counter_bits: number | null }>(
        'SELECT sensor_id::text AS sensor_id, key, counter_bits FROM channel ' +
          'WHERE sensor_id = ANY($1::bigint[]) ORDER BY sensor_id, key',
        [sensors],
      );
      assert.equal(rows.length, 5);
      for (const row of rows.filter((one) => one.key === 'value')) {
        assert.equal(row.counter_bits, 64, `sensor ${row.sensor_id} took the type's {} answer`);
      }

      const warnings = lines.map(
        (line) =>
          JSON.parse(line) as {
            level: number;
            sensorType: string;
            sensorId: number;
            phase: string;
            err: { code: string; message: string };
          },
      );
      assert.deepEqual(
        warnings.map((one) => [one.level, one.sensorType, one.phase, one.err.code]),
        [
          [40, 'test.brittle', 'declare-channels-on-ingest', 'TypeError'],
          [40, 'test.brittle', 'declare-channels-on-ingest', 'BAD_SENSOR_TYPE'],
        ],
        'one warning for each kind of error, however many sensors and channels met it',
      );
      const [first, second] = warnings;
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(first.sensorId, typeError);
      assert.equal(second.sensorId, limitedOne);
      assert.match(first.err.message, /\[a parameter\]/u);
      assert.match(second.err.message, /declares limits on channel "bounded"/u);
      for (const line of lines) {
        for (const form of encodedForms(SECRET)) {
          assert.ok(!line.includes(form), `a secret reached the log as ${form}: ${line}`);
        }
        assert.ok(!line.includes(LABEL), `a parameter's value reached the log: ${line}`);
      }
    });

    // `P-306`: the fallback was said once a type and kind of error, and counted nowhere an
    // operator watches. Ingestion counts each channel it created from it, for Core Health; only
    // those it created, since the lookup is asked again for every channel that exists already
    // when the cache is empty, which after a restart is every one.
    it('counts on ingestion the channels it created without their declared shape, and no others', async () => {
      const fine = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'counted-fine',
        sensorType: 'test.brittle',
        params: { mode: 'fine' },
      });
      const broken = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'counted-broken',
        sensorType: 'test.brittle',
        params: { mode: 'fine' },
      });
      // Stored behind the type's back, as an earlier build would have left them.
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        broken.id,
        JSON.stringify({ mode: 'typeError', label: 'west' }),
      ]);
      await db.query('DELETE FROM channel WHERE sensor_id = ANY($1::bigint[])', [
        [fine.id, broken.id],
      ]);

      const catalogue = testCatalogue([columns, brittle]);
      const config: IngestionConfig = {
        queueMaxRows: 200_000,
        batchMaxRows: 5_000,
        batchMaxDelayMs: 5,
        slowDownAtPercent: 50,
        retryAfterMs: 1_000,
        replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
      };
      const ingestor = new Ingestor({ db, logger: silent, config });
      // A core's ingestion as `main.ts` builds it, and a second one standing for a restart: a
      // resolver with nothing cached, over channels that exist.
      const service = (): IngestionService =>
        new IngestionService({
          db,
          logger: silent,
          ingestor,
          resolver: new ChannelResolver({
            logger: silent,
            declaredLimits: declaredLimitsLookup(catalogue),
            declaredShape: declaredChannelLookup(catalogue),
          }),
        });
      // Recent, so ingestion's clock checks take every result.
      const since = Date.now() - 600_000;
      let minute = 0;
      const batch = (): Parameters<IngestionService['acceptResults']>[1] => {
        minute += 1;
        const at = new Date(since + minute * 60_000).toISOString();
        return {
          type: 'results',
          batchId: `undeclared-${String(minute)}`,
          results: [fine.id, broken.id].map((sensorId) => ({
            sensorId,
            at,
            outcome: 'ok' as const,
            message: '',
            durationMs: 1,
            channels: [
              { key: 'value', value: minute },
              { key: 'other', value: minute },
            ],
          })),
        };
      };
      try {
        const first = service();
        assert.equal((await first.acceptResults('probe-1', batch())).type, 'results-ack');
        assert.equal(first.stats().channelsCreated, 4);
        assert.equal(
          first.stats().channelsCreatedUndeclared,
          2,
          'the broken sensor’s two, not the fine one’s',
        );
        // The same channels again: cached, so nothing created and nothing counted.
        assert.equal((await first.acceptResults('probe-1', batch())).type, 'results-ack');
        assert.equal(first.stats().channelsCreatedUndeclared, 2);

        const restarted = service();
        assert.equal((await restarted.acceptResults('probe-1', batch())).type, 'results-ack');
        assert.equal(restarted.stats().channelsCreated, 0);
        assert.equal(
          restarted.stats().channelsCreatedUndeclared,
          0,
          'asked again, created nothing',
        );
      } finally {
        await ingestor.stop();
      }
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
      const answer = shipped(one.type, one.params, 1);
      assert.deepEqual(answer.shapes.get(one.key), one.shape, 'the sensor');
      assert.equal(answer.undeclared, false, 'answered for its own parameters (`P-306`)');
      assert.deepEqual(shipped(one.type, {}, 1).shapes.get(one.key), one.bare, '`{}`');
    });
  }

  it('answers nothing for a type this build does not register', () => {
    const answer = shipped('gone.type', { anything: 1 }, 1);
    assert.equal(answer.shapes.size, 0);
    // Nothing to fall back from: not counted as a channel created without its shape (`P-306`).
    assert.equal(answer.undeclared, false);
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
    const broken = shapes('test.fragile', { broken: true }, 1);
    const limited = shapes('test.fragile', { limited: true }, 1);
    assert.deepEqual(broken.shapes.get('total'), bare);
    assert.deepEqual(limited.shapes.get('total'), bare);
    assert.equal(limited.shapes.get('extra'), undefined);
    // Each fallback says so, for the resolver to count what it creates from it (`P-306`).
    assert.equal(broken.undeclared, true);
    assert.equal(limited.undeclared, true);
    assert.equal(shapes('test.fragile', {}, 1).undeclared, false);
    // With no `{}` answer to fall back on it answers nothing, rather than throwing into ingestion,
    // and that is a fallback too.
    const nothing = shapes('test.unanswerable', {}, 1);
    assert.equal(nothing.shapes.size, 0);
    assert.equal(nothing.undeclared, true);
    const answered = shapes('test.unanswerable', { columns: [] }, 1);
    assert.deepEqual(answered.shapes.get('one'), bare);
    assert.equal(answered.undeclared, false);
  });
});

/**
 * A type whose channels depend on a parameter with a default (`P-304`): `{}` is a gauge, and the
 * filled-in `{ mode: 'counter' }` a counter with a second channel, as `snmp.custom`'s would be if
 * its default were a counter. The stored parameters are the filled-in ones, whichever route made
 * the sensor.
 */
const defaulted: SensorType = {
  id: 'test.defaulted',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { mode: { enum: ['gauge', 'counter'], default: 'counter' } },
  },
  channels: (params) => [
    {
      key: 'value',
      name: 'Value',
      isPrimary: true,
      ...(params['mode'] === 'counter' ? { counter: { bits: 64 as const } } : {}),
    },
    ...(params['mode'] === 'counter' ? [{ key: 'wraps', name: 'Wraps' }] : []),
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

describe(
  'a tree create declares channels from the parameters it stores (P-304)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let harness: Harness;

    before(async () => {
      scratch = await createScratchDatabase('tree_channels');
      harness = await buildHarness(scratch.db, { types: [defaulted] });
    });

    after(async () => {
      await scratch.drop();
    });

    it('gives a sensor the channels a single create gives it, defaults filled', async () => {
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'router',
        host: '192.0.2.31',
      });
      const single = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'single',
        sensorType: 'test.defaulted',
        params: {},
      });
      const tree = await harness.service.createTree(testActor, {
        parentId: probe.id,
        nodes: [
          { kind: 'device', name: 'switch', host: '192.0.2.32', ref: 'd' },
          {
            kind: 'sensor',
            name: 'from a tree',
            parentRef: 'd',
            sensorType: 'test.defaulted',
            params: {},
          },
        ],
      });
      const fromTree = tree.objects[1]?.id ?? assert.fail('no sensor in the tree');

      const shape = (sensorId: number) =>
        scratch.db.query<{ key: string; counter_bits: number | null }>(
          'SELECT key, counter_bits FROM channel WHERE sensor_id = $1 ORDER BY key',
          [sensorId],
        );
      const expected = [
        { key: 'value', counter_bits: 64 },
        { key: 'wraps', counter_bits: null },
      ];
      assert.deepEqual(await shape(single.id), expected);
      assert.deepEqual(await shape(fromTree), expected);
      // And what is stored is what was asked about: the default, on both.
      for (const id of [single.id, fromTree]) {
        const stored = await harness.service.get(id);
        assert.deepEqual(stored.kind === 'sensor' ? stored.params : null, { mode: 'counter' });
      }
    });
  },
);
