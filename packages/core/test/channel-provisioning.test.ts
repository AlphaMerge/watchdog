import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { pino } from 'pino';
import { SensorCatalogue, standardCatalogue, type SensorType } from '@ms/sensors';
import { encodedForms, type CheckResult, type IngestionConfig } from '@ms/shared';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import {
  ChannelResolver,
  DECLARATION_SETTLE_MS,
  type ResolvedChannels,
} from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { IngestionService } from '../src/ingestion/service.js';
import type { Actor, AuditSink } from '../src/objects/audit.js';
import { declaredChannelLookup, declaredLimitsLookup } from '../src/state/declared-limits.js';
import type { Database, Queryable } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { within } from './support/within.js';

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
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
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

/** `test.columns` without its answer to `declaresEveryChannel`, for a type that gives the other. */
const { channelsFromWhatItReads: _unflagged, ...columnsShape } = columns;

/**
 * `test.columns` with `snmp.table`'s promise (`P-310`): every key it reports is one its
 * parameters declare. A column named `broken` makes `channels()` throw, as parameters an older
 * build stored might.
 */
const promised: SensorType = {
  ...columnsShape,
  id: 'test.promised',
  declaresEveryChannel: true,
  channels: (params) => {
    const named = Array.isArray(params['columns']) ? (params['columns'] as { key: string }[]) : [];
    if (named.some((column) => column.key === 'broken')) throw new TypeError('no such column');
    return columns.channels(params);
  },
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
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
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
      harness = await buildHarness(db, { types: [columns, brittle, promised] });
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

    // `P-306` on `P-303`'s resolver: rows that exist are read first and only the rest are
    // created, but a key another batch creates between that read and this INSERT conflicts, and
    // was not made from this sensor's fallback here. Only the rows the INSERT returned count.
    it('counts only the channels its own INSERT created, not one another batch made first', async () => {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'raced-broken',
        sensorType: 'test.brittle',
        params: { mode: 'fine' },
      });
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        sensor.id,
        JSON.stringify({ mode: 'typeError', label: 'east' }),
      ]);
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensor.id]);

      const catalogue = testCatalogue([columns, brittle]);
      const resolver = new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
      });
      let raced = 0;
      const resolved = await db.tx((q) => {
        // The other batch, in the one place it can land: after the read of what exists and
        // before this INSERT. In this transaction, so it holds no lock this one waits for.
        const racing: Queryable = {
          query: async (text, values) => {
            if (text.includes('INSERT INTO channel') && raced === 0) {
              raced += 1;
              await q.query(
                "INSERT INTO channel (sensor_id, key, name, unit) VALUES ($1, 'raced', 'raced', '')",
                [sensor.id],
              );
            }
            return q.query(text, values);
          },
        };
        return resolver.resolve(racing, [
          {
            sensorId: sensor.id,
            at: new Date('2026-10-08T12:00:00.000Z').toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [
              { key: 'raced', value: 1 },
              { key: 'fresh', value: 1 },
            ],
          },
        ]);
      });
      assert.equal(raced, 1, 'the other batch landed');
      assert.equal(resolved.ids.size, 2, 'both channels resolved');
      assert.equal(resolved.created, 1, 'one created here');
      assert.equal(resolved.createdUndeclared, 1, 'and only that one counted');
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

    // `P-321`: `declaresEveryChannel` is the promise a channel's `retired` rests on (`P-310`), and
    // nothing checked it. It is checked where the declaration is already in hand, when a reading
    // creates a channel: a key outside it is kept, counted for Core Health and said once, naming
    // the sensor, the type and the key. Once, because the row is created once; a cached channel
    // and a restart's re-read create nothing. **Only from a reading taken under the stored
    // parameters** (`P-321` review): one from before their last change, or from the minute after
    // it, may have run under parameters that named the key.
    const outsideCases: readonly {
      name: string;
      type: string;
      /** What the sensor is created with; column `a` alone when absent. */
      params?: Record<string, unknown>;
      /** Written after the create, as an edit or an older build would leave them. */
      stored?: Record<string, unknown>;
      key: string;
      /** When the reading was taken, from the stored configuration's last change. */
      afterChangeMs: number;
      outside: boolean;
      undeclared: boolean;
    }[] = [
      {
        name: 'a key a promising type declares',
        type: 'test.promised',
        key: 'a',
        afterChangeMs: 2 * DECLARATION_SETTLE_MS,
        outside: false,
        undeclared: false,
      },
      {
        name: 'a key a promising type does not declare (a probe on another build, or a broken promise)',
        type: 'test.promised',
        key: 'newer',
        afterChangeMs: 2 * DECLARATION_SETTLE_MS,
        outside: true,
        undeclared: false,
      },
      {
        name: 'a spooled reading of a key an edit has since taken out, taken before that edit',
        type: 'test.promised',
        params: { columns: [{ key: 'a' }, { key: 'x' }] },
        stored: { columns: [{ key: 'a' }] },
        key: 'x',
        afterChangeMs: -1_000,
        outside: false,
        undeclared: false,
      },
      {
        name: 'a reading of a key an edit has just taken out, before its probe heard of the edit',
        type: 'test.promised',
        params: { columns: [{ key: 'a' }, { key: 'x' }] },
        stored: { columns: [{ key: 'a' }] },
        key: 'x',
        afterChangeMs: DECLARATION_SETTLE_MS / 2,
        outside: false,
        undeclared: false,
      },
      {
        name: 'a key a type making no promise does not declare (a script’s printed key)',
        type: 'test.columns',
        key: 'printed',
        afterChangeMs: 2 * DECLARATION_SETTLE_MS,
        outside: false,
        undeclared: false,
      },
      {
        name: 'a key a promising type cannot answer for, which is `P-306`’s instead',
        type: 'test.promised',
        stored: { columns: [{ key: 'a' }, { key: 'broken' }] },
        key: 'newer',
        afterChangeMs: 2 * DECLARATION_SETTLE_MS,
        outside: false,
        undeclared: true,
      },
    ];
    for (const one of outsideCases) {
      it(`counts and says once a channel created outside its declaration: ${one.name}`, async () => {
        const sensor = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `outside-${one.key}-${String(process.hrtime.bigint())}`,
          sensorType: one.type,
          params: one.params ?? { columns: [{ key: 'a' }] },
        });
        if (one.stored !== undefined) {
          await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
            sensor.id,
            JSON.stringify(one.stored),
          ]);
        }
        await db.query('DELETE FROM channel WHERE sensor_id = $1 AND key = $2', [
          sensor.id,
          one.key,
        ]);
        const changed = await db.query<{ at: Date }>(
          'SELECT updated_at AS at FROM sensor_config WHERE object_id = $1',
          [sensor.id],
        );
        const changedAt = changed[0]?.at;
        assert.ok(changedAt !== undefined);

        const lines: string[] = [];
        const catalogue = testCatalogue([columns, brittle, promised]);
        const resolver = (): ChannelResolver =>
          new ChannelResolver({
            logger: pino(
              { level: 'info', base: null },
              { write: (line: string) => lines.push(line) },
            ),
            declaredLimits: declaredLimitsLookup(catalogue),
            declaredShape: declaredChannelLookup(catalogue),
          });
        const reading: CheckResult = {
          sensorId: sensor.id,
          at: new Date(changedAt.getTime() + one.afterChangeMs).toISOString(),
          outcome: 'ok',
          message: '',
          durationMs: 1,
          channels: [{ key: one.key, value: 1 }],
        };
        const said = (): { sensorId: number; sensorType: string; channelKey: string }[] =>
          lines
            .map(
              (line) =>
                JSON.parse(line) as {
                  level: number;
                  phase?: string;
                  sensorId: number;
                  sensorType: string;
                  channelKey: string;
                },
            )
            .filter((entry) => entry.phase === 'create-channel' && entry.level === 40)
            .map(({ sensorId, sensorType, channelKey }) => ({ sensorId, sensorType, channelKey }));

        const first = resolver();
        const created = await db.tx((q) => first.resolve(q, [reading]));
        assert.equal(created.created, 1, 'the channel is created: the reading is kept');
        assert.equal(created.droppedReadings, 0);
        assert.equal(created.createdOutsideDeclaration, one.outside ? 1 : 0);
        assert.equal(created.createdUndeclared, one.undeclared ? 1 : 0);
        assert.deepEqual(
          said(),
          one.outside ? [{ sensorId: sensor.id, sensorType: one.type, channelKey: one.key }] : [],
        );

        // Cached, then a restart over the row that now exists: nothing created, counted or said.
        const cached = await db.tx((q) => first.resolve(q, [reading]));
        const restarted = await db.tx((q) => resolver().resolve(q, [reading]));
        for (const again of [cached, restarted]) {
          assert.equal(again.created, 0);
          assert.equal(again.createdOutsideDeclaration, 0);
        }
        assert.equal(said().length, one.outside ? 1 : 0, 'said once a channel');
      });
    }

    // `P-339`: a key created from a reading inside the minute after an edit is created uncounted,
    // since that reading may have run under the parameters before it. Its first reading after the
    // minute is evidence, and counts it, once. Not when an edit came between (`forget`), which
    // may have declared it, and not across a restart, which forgets what was waiting.
    const laterCases: readonly {
      name: string;
      type: string;
      params?: Record<string, unknown>;
      stored?: Record<string, unknown>;
      key: string;
      /** When the reading that creates the channel was taken, from the last change. */
      createdAtMs: number;
      /** What happens between the create and the later readings. */
      between?: 'edit' | 'restart';
      /** The later readings, from the last change, and how many each counts. */
      later: readonly { atMs: number; counts: number }[];
    }[] = [
      {
        name: 'a key a promising type does not declare, first read in the minute after a change',
        type: 'test.promised',
        key: 'newer',
        createdAtMs: DECLARATION_SETTLE_MS / 2,
        later: [
          { atMs: DECLARATION_SETTLE_MS - 1_000, counts: 0 },
          { atMs: 2 * DECLARATION_SETTLE_MS, counts: 1 },
          { atMs: 3 * DECLARATION_SETTLE_MS, counts: 0 },
        ],
      },
      {
        name: 'a key an edit took out, created from a spooled reading taken before the edit',
        type: 'test.promised',
        params: { columns: [{ key: 'a' }, { key: 'x' }] },
        stored: { columns: [{ key: 'a' }] },
        key: 'x',
        createdAtMs: -1_000,
        later: [{ atMs: 2 * DECLARATION_SETTLE_MS, counts: 1 }],
      },
      {
        name: 'the same, with an edit between that may have declared it',
        type: 'test.promised',
        key: 'newer',
        createdAtMs: DECLARATION_SETTLE_MS / 2,
        between: 'edit',
        later: [{ atMs: 2 * DECLARATION_SETTLE_MS, counts: 0 }],
      },
      {
        name: 'the same, with a restart between, which forgets what was waiting',
        type: 'test.promised',
        key: 'newer',
        createdAtMs: DECLARATION_SETTLE_MS / 2,
        between: 'restart',
        later: [{ atMs: 2 * DECLARATION_SETTLE_MS, counts: 0 }],
      },
      {
        name: 'a key a promising type declares, first read in the minute',
        type: 'test.promised',
        key: 'a',
        createdAtMs: DECLARATION_SETTLE_MS / 2,
        later: [{ atMs: 2 * DECLARATION_SETTLE_MS, counts: 0 }],
      },
      {
        name: 'a key a type making no promise does not declare, first read in the minute',
        type: 'test.columns',
        key: 'printed',
        createdAtMs: DECLARATION_SETTLE_MS / 2,
        later: [{ atMs: 2 * DECLARATION_SETTLE_MS, counts: 0 }],
      },
    ];
    for (const one of laterCases) {
      it(`counts a channel created in the minute after a change at its first reading after it (P-339): ${one.name}`, async () => {
        const sensor = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `later-${one.key}-${String(process.hrtime.bigint())}`,
          sensorType: one.type,
          params: one.params ?? { columns: [{ key: 'a' }] },
        });
        if (one.stored !== undefined) {
          await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
            sensor.id,
            JSON.stringify(one.stored),
          ]);
        }
        await db.query('DELETE FROM channel WHERE sensor_id = $1 AND key = $2', [
          sensor.id,
          one.key,
        ]);
        const changed = await db.query<{ at: Date }>(
          'SELECT updated_at AS at FROM sensor_config WHERE object_id = $1',
          [sensor.id],
        );
        const changedAt = changed[0]?.at;
        assert.ok(changedAt !== undefined);

        const lines: string[] = [];
        const catalogue = testCatalogue([columns, brittle, promised]);
        const resolver = (): ChannelResolver =>
          new ChannelResolver({
            logger: pino(
              { level: 'info', base: null },
              { write: (line: string) => lines.push(line) },
            ),
            declaredLimits: declaredLimitsLookup(catalogue),
            declaredShape: declaredChannelLookup(catalogue),
          });
        const readingAt = (ms: number): CheckResult => ({
          sensorId: sensor.id,
          at: new Date(changedAt.getTime() + ms).toISOString(),
          outcome: 'ok',
          message: '',
          durationMs: 1,
          channels: [{ key: one.key, value: 1 }],
        });
        const said = (): { sensorId: number; sensorType: string; channelKey: string }[] =>
          lines
            .map(
              (line) =>
                JSON.parse(line) as {
                  level: number;
                  phase?: string;
                  sensorId: number;
                  sensorType: string;
                  channelKey: string;
                },
            )
            .filter((entry) => entry.phase === 'read-channel' && entry.level === 40)
            .map(({ sensorId, sensorType, channelKey }) => ({ sensorId, sensorType, channelKey }));

        let current = resolver();
        const created = await db.tx((q) => current.resolve(q, [readingAt(one.createdAtMs)]));
        assert.equal(created.created, 1, 'the channel is created: the reading is kept');
        assert.equal(created.createdOutsideDeclaration, 0, 'and not counted from that reading');

        if (one.between === 'edit') current.forget(sensor.id);
        if (one.between === 'restart') current = resolver();

        let counted = 0;
        for (const later of one.later) {
          const again = await db.tx((q) => current.resolve(q, [readingAt(later.atMs)]));
          assert.equal(again.created, 0);
          assert.equal(
            again.createdOutsideDeclaration,
            later.counts,
            `a reading ${String(later.atMs)} ms after the change`,
          );
          counted += later.counts;
        }
        assert.deepEqual(
          said(),
          Array.from({ length: counted }, () => ({
            sensorId: sensor.id,
            sensorType: one.type,
            channelKey: one.key,
          })),
          'said once, with the sensor, its type and the key',
        );
      });
    }

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
    /** The key the sensor's own answer makes primary (`P-314`). */
    primary: string;
  }[] = [
    {
      name: 'snmp.custom in counter mode is a counter',
      type: 'snmp.custom',
      params: { oid: '1.3.6.1.2.1.1.3.0', mode: 'counter' },
      key: 'value',
      shape: { lookup: null, counterBits: 64 },
      bare: { lookup: null, counterBits: null },
      primary: 'value',
    },
    {
      name: 'snmp.custom.string carries the lookup its parameters name',
      type: 'snmp.custom.string',
      params: { oid: '1.3.6.1.2.1.1.1.0', lookup: 'ms.snmp.if-oper-status' },
      key: 'value',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: { lookup: null, counterBits: null },
      primary: 'value',
    },
    {
      name: 'an snmp.table counter column',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'col10',
      shape: { lookup: null, counterBits: 64 },
      bare: undefined,
      primary: 'col10',
    },
    {
      name: 'an snmp.table lookup column',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'col8',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: undefined,
      primary: 'col10',
    },
    {
      name: 'snmp.table’s placeholder, which no sensor with columns declares',
      type: 'snmp.table',
      params: { tableOid: ifTable, columns: twoColumns },
      key: 'value',
      shape: undefined,
      bare: { lookup: null, counterBits: null },
      primary: 'col10',
    },
    {
      name: 'snmp.traffic forced to 32 bits',
      type: 'snmp.traffic',
      params: { counterWidth: '32' },
      key: 'in',
      shape: { lookup: null, counterBits: 32 },
      bare: { lookup: null, counterBits: 64 },
      primary: 'in',
    },
    {
      name: 'snmp.traffic’s status lookup, which no parameter changes',
      type: 'snmp.traffic',
      params: { counterWidth: 'auto' },
      key: 'status',
      shape: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      bare: { lookup: 'ms.snmp.if-oper-status', counterBits: null },
      primary: 'in',
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
      assert.equal(answer.primary, one.primary, 'its primary (`P-314`)');
      assert.equal(
        answer.everyKey,
        catalogue.declaration(one.type).declaresEveryChannel === true,
        'whether it promises every key (`P-321`)',
      );
      assert.deepEqual(shipped(one.type, {}, 1).shapes.get(one.key), one.bare, '`{}`');
    });
  }

  it('answers nothing for a type this build does not register', () => {
    const answer = shipped('gone.type', { anything: 1 }, 1);
    assert.equal(answer.shapes.size, 0);
    // Nothing to fall back from, and the same row a fallback makes: counted and marked as one,
    // for a build that registers the type to repair (`P-312`).
    assert.equal(answer.undeclared, true);
    assert.equal(answer.primary, null, 'and no primary to move to (`P-314`)');
    assert.equal(answer.everyKey, false, 'and no promise to hold it to (`P-321`)');
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
    // A fallback's primary is a placeholder's, so it names none (`P-314`); `{}` itself does.
    assert.equal(broken.primary, null);
    assert.equal(limited.primary, null);
    assert.equal(shapes('test.fragile', {}, 1).primary, 'total');
    // With no `{}` answer to fall back on it answers nothing, rather than throwing into ingestion,
    // and that is a fallback too.
    const nothing = shapes('test.unanswerable', {}, 1);
    assert.equal(nothing.shapes.size, 0);
    assert.equal(nothing.undeclared, true);
    assert.equal(nothing.primary, null);
    const answered = shapes('test.unanswerable', { columns: [] }, 1);
    assert.deepEqual(answered.shapes.get('one'), bare);
    assert.equal(answered.undeclared, false);
    assert.equal(answered.primary, 'one');
  });

  it('holds only a type that promises every key to its answer for the stored parameters (`P-321`)', () => {
    // `snmp.table` promises (`P-310`); its sensor's answer is what a key is checked against.
    const table = shipped(
      'snmp.table',
      { tableOid: ifTable, rowIndex: '1', columns: twoColumns },
      1,
    );
    assert.equal(table.everyKey, true);
    assert.deepEqual([...table.shapes.keys()].sort(), ['col10', 'col8']);
    // A script's keys come from what it printed: no promise, nothing to hold it to.
    assert.equal(shipped('exe.script.advanced', { primaryChannel: 'x' }, 1).everyKey, false);
    // A fallback is not the type's answer for the sensor, so it holds nothing to it either.
    const promising = new SensorCatalogue();
    promising.register({
      ...columnsShape,
      id: 'test.promising',
      declaresEveryChannel: true,
      channels: (params) => {
        if (params['broken'] === true) throw new Error('cannot read these parameters');
        return [{ key: 'one', name: 'One', isPrimary: true }];
      },
    });
    const promised = declaredChannelLookup(promising.seal());
    assert.equal(promised('test.promising', {}, 1).everyKey, true);
    const fallback = promised('test.promising', { broken: true }, 1);
    assert.equal(fallback.undeclared, true);
    assert.equal(fallback.everyKey, false);
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
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
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

/** A type that declares two channels and no primary, so a reading can move nothing (`P-314`). */
const unranked: SensorType = {
  id: 'test.unranked',
  category: 'Custom',
  costHint: 'light',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  channels: () => [
    { key: 'a', name: 'A' },
    { key: 'b', name: 'B' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/** What a resolver recorded: who, and which channel's `isPrimary` went which way. */
interface Recorded {
  actor: Actor;
  moves: { sensorId: number | null; key: string; from: boolean; to: boolean }[];
}

/**
 * The first reading of a channel its type declares primary (`P-314`).
 *
 * An edit that declares a primary with no row keeps the current one, since it creates no channels
 * (`P-309`), and ingestion then created that row without `is_primary`, so it became primary only
 * on the next edit that changed the declaration. Now the reading that creates it moves the
 * primary to it, in its own transaction, demoting first.
 */
describe(
  'the primary a reading creates (P-314)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let deviceId: number;
    const types = [columns, brittle, unranked];

    before(async () => {
      scratch = await createScratchDatabase('reading_primary');
      db = scratch.db;
      harness = await buildHarness(db, { types });
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
      await scratch.drop();
    });

    /** A resolver as `main.ts` builds it, recording what it audits (and writing it, when asked). */
    const declaring = (recorded: Recorded[], also?: AuditSink): ChannelResolver => {
      const audit: AuditSink = {
        record: async (q, actor, mutations, at) => {
          recorded.push({
            actor,
            moves: mutations.map((one) =>
              one.action === 'channel.redeclared'
                ? {
                    sensorId: one.objectId,
                    key: one.channelKey,
                    from: one.before.isPrimary,
                    to: one.after.isPrimary,
                  }
                : assert.fail(`audited ${one.action}`),
            ),
          });
          await also?.record(q, actor, mutations, at);
        },
      };
      const catalogue = testCatalogue(types);
      return new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
        audit,
      });
    };

    const primaryOf = async (sensorId: number): Promise<string[]> =>
      (
        await db.query<{ key: string }>(
          'SELECT key FROM channel WHERE sensor_id = $1 AND is_primary ORDER BY key',
          [sensorId],
        )
      ).map((one) => one.key);

    const reading = (sensorId: number, keys: readonly string[]): CheckResult => ({
      sensorId,
      at: new Date('2026-10-08T12:00:00.000Z').toISOString(),
      outcome: 'ok',
      message: '',
      durationMs: 1,
      channels: keys.map((key) => ({ key, value: 1 })),
    });

    /**
     * A sensor of `type` whose rows are exactly `rows` (the one marked `true` primary) and whose
     * stored parameters are `stored`, written behind the type's back as an edit or an earlier
     * build would have left them.
     */
    const sensorWith = async (
      type: string,
      created: Record<string, unknown>,
      stored: Record<string, unknown>,
      rows: readonly (readonly [string, boolean])[],
    ): Promise<number> => {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `${type}-${String(process.hrtime.bigint())}`,
        sensorType: type,
        params: created,
      });
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensor.id]);
      for (const [key, primary] of rows) {
        await db.query(
          "INSERT INTO channel (sensor_id, key, name, unit, is_primary) VALUES ($1, $2, $2, '', $3)",
          [sensor.id, key, primary],
        );
      }
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        sensor.id,
        JSON.stringify(stored),
      ]);
      return sensor.id;
    };

    const cols = (...keys: string[]): Record<string, unknown> => ({
      columns: keys.map((key) => ({ key })),
    });

    const cases: readonly {
      name: string;
      type: string;
      created: Record<string, unknown>;
      stored: Record<string, unknown>;
      rows: readonly (readonly [string, boolean])[];
      reported: readonly string[];
      primary: readonly string[];
      /** `[key, from, to]` for each channel whose `isPrimary` was audited as moved. */
      moves: readonly (readonly [string, boolean, boolean])[];
    }[] = [
      {
        name: 'moved to the column an edit put first, when its first reading creates it',
        type: 'test.columns',
        created: cols('used', 'free'),
        stored: cols('fresh', 'used', 'free'),
        rows: [
          ['used', true],
          ['free', false],
        ],
        reported: ['fresh', 'used', 'free'],
        primary: ['fresh'],
        moves: [
          ['used', true, false],
          ['fresh', false, true],
        ],
      },
      {
        name: 'given to a sensor with none, as a create of these parameters would',
        type: 'test.columns',
        created: cols('used'),
        stored: cols('fresh', 'used'),
        rows: [['used', false]],
        reported: ['fresh'],
        primary: ['fresh'],
        moves: [['fresh', false, true]],
      },
      {
        name: 'moved off a removed column that still holds it',
        type: 'test.columns',
        created: cols('gone', 'kept'),
        stored: cols('fresh', 'kept'),
        rows: [
          ['gone', true],
          ['kept', false],
        ],
        reported: ['fresh', 'kept'],
        primary: ['fresh'],
        moves: [
          ['gone', true, false],
          ['fresh', false, true],
        ],
      },
      {
        name: 'left, when the channel created is not the declared primary',
        type: 'test.columns',
        created: cols('used'),
        stored: cols('used', 'extra'),
        rows: [['used', true]],
        reported: ['used', 'extra'],
        primary: ['used'],
        moves: [],
      },
      {
        name: 'left, when the declared primary has a row already: an edit’s to move (P-309)',
        type: 'test.columns',
        created: cols('used', 'free'),
        stored: cols('free', 'used', 'new'),
        rows: [
          ['used', true],
          ['free', false],
        ],
        reported: ['free', 'used', 'new'],
        primary: ['used'],
        moves: [],
      },
      {
        name: 'left, when the shape came from the fallback: `{}`’s primary is a placeholder’s',
        type: 'test.brittle',
        created: { mode: 'fine' },
        stored: { mode: 'typeError', label: 'east' },
        rows: [['kept', true]],
        reported: ['value'],
        primary: ['kept'],
        moves: [],
      },
      {
        name: 'left, when the type declares no primary',
        type: 'test.unranked',
        created: {},
        stored: {},
        rows: [['a', true]],
        reported: ['b'],
        primary: ['a'],
        moves: [],
      },
    ];

    for (const one of cases) {
      it(one.name, async () => {
        const id = await sensorWith(one.type, one.created, one.stored, one.rows);
        const recorded: Recorded[] = [];
        const resolved = await db.tx((q) =>
          declaring(recorded).resolve(q, [reading(id, one.reported)]),
        );
        assert.equal(resolved.ids.size, one.reported.length, 'every reading resolved');

        assert.deepEqual(await primaryOf(id), one.primary);
        assert.deepEqual(
          recorded.flatMap((entry) => entry.moves.map((move) => [move.key, move.from, move.to])),
          one.moves,
          'audited: demoted first, then promoted',
        );
        for (const entry of recorded) {
          assert.deepEqual(entry.actor, { kind: 'system', component: 'ingestion' });
          for (const move of entry.moves) assert.equal(move.sensorId, id);
        }
        // And never twice: the same readings again, uncached, create nothing and move nothing.
        await db.tx((q) => declaring(recorded).resolve(q, [reading(id, one.reported)]));
        assert.deepEqual(await primaryOf(id), one.primary, 'stable');
        assert.equal(recorded.length, one.moves.length === 0 ? 0 : 1);
      });
    }

    it('moves each sensor’s own primary in a batch of several, and only theirs', async () => {
      const moving = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['used', true],
      ]);
      const staying = await sensorWith('test.columns', cols('used'), cols('used', 'extra'), [
        ['used', true],
      ]);
      const recorded: Recorded[] = [];
      await db.tx((q) =>
        declaring(recorded).resolve(q, [reading(staying, ['extra']), reading(moving, ['fresh'])]),
      );
      assert.deepEqual(await primaryOf(moving), ['fresh']);
      assert.deepEqual(await primaryOf(staying), ['used']);
      assert.deepEqual(
        recorded.flatMap((entry) => entry.moves.map((move) => [move.sensorId, move.key])),
        [
          [moving, 'used'],
          [moving, 'fresh'],
        ],
      );
    });

    // ── at the same time as something else ───────────────────────────────────────────────────

    /**
     * A resolve that stops once it holds its sensors, until `release` is called: the window in
     * which anything else touching those sensors has to wait for it.
     */
    const holding = (
      resolver: ChannelResolver,
      results: readonly CheckResult[],
    ): { done: Promise<ResolvedChannels>; locked: Promise<void>; release: () => void } => {
      let locked: () => void = () => undefined;
      const lockedNow = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = db.tx((q) => {
        const held: Queryable = {
          query: async <T extends QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<T[]> => {
            const rows = await q.query<T>(text, values);
            if (text.includes('FOR NO KEY UPDATE')) {
              locked();
              await released;
            }
            return rows;
          },
        };
        return resolver.resolve(held, results);
      });
      return {
        done,
        locked: lockedNow,
        release: () => {
          release();
        },
      };
    };

    it('moves it once when two batches create the declared primary at once', async () => {
      // Two sensors, named in opposite orders by the two batches: the rows are taken in id
      // order, so neither batch can hold one while waiting for the other's.
      const first = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['used', true],
      ]);
      const second = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['used', true],
      ]);
      const recorded: Recorded[] = [];
      const one = holding(declaring(recorded), [
        reading(first, ['fresh']),
        reading(second, ['fresh']),
      ]);
      try {
        await within(10_000, 'the first batch holding its sensors', one.locked);
        const other = db.tx((q) =>
          declaring(recorded).resolve(q, [reading(second, ['fresh']), reading(first, ['fresh'])]),
        );
        await somebodyWaits(db, 'the second batch waiting for the first');
        one.release();
        const [a, b] = await within(10_000, 'both batches', Promise.all([one.done, other]));
        assert.deepEqual([a.created, b.created], [2, 0], 'each fresh channel created once');
        assert.equal(b.ids.size, 2, 'and the second batch resolved them');
      } finally {
        one.release();
      }
      assert.deepEqual(await primaryOf(first), ['fresh']);
      assert.deepEqual(await primaryOf(second), ['fresh']);
      // Moved by the batch that created the rows, and not again by the one that found them.
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.moves.length, 4);
    });

    it('reads the parameters an edit committed while it waited, and moves to their primary', async () => {
      // The edit puts `fresh` first while `fresh` has no row, so it keeps `used` (`P-309`). The
      // first reading of `fresh` arrives while the edit is open: it waits for the sensor, then
      // reads the edit's parameters and makes `fresh` primary. Read unlocked, it would have seen
      // the old ones, which do not name `fresh`, and left the primary where the edit left it.
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'edited-while-read',
        sensorType: 'test.columns',
        params: cols('used', 'free'),
      });
      const recorded: Recorded[] = [];
      const resolver = declaring(recorded);
      const was = harness.audit.also;
      let creating: Promise<unknown> | undefined;
      harness.audit.also = {
        record: async (_q, _actor, mutations) => {
          if (!mutations.some((one) => one.action === 'object.updated')) return;
          creating = db.tx((q) => resolver.resolve(q, [reading(sensor.id, ['fresh'])]));
          await somebodyWaits(db, 'the first reading of fresh waiting for the edit');
        },
      };
      try {
        await harness.service.update(
          testActor,
          sensor.id,
          { kind: 'sensor', params: cols('fresh', 'used', 'free') },
          { kind: 'none' },
        );
      } finally {
        harness.audit.also = was;
      }
      assert.ok(creating !== undefined, 'the edit never reached its audit entry');
      await within(10_000, 'the first reading of fresh', creating);
      assert.deepEqual(await primaryOf(sensor.id), ['fresh']);
    });

    it('lets an edit that waited for the reading move the primary on from there', async () => {
      // The other order: the reading holds the sensor, creates `fresh` and makes it primary; the
      // edit that puts `used` back first waits, then finds both rows and moves it back.
      const id = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['used', true],
      ]);
      const recorded: Recorded[] = [];
      const resolver = declaring(recorded);
      let editing: Promise<unknown> | undefined;
      await db.tx(async (q) => {
        await resolver.resolve(q, [reading(id, ['fresh'])]);
        editing = harness.service.update(
          testActor,
          id,
          { kind: 'sensor', params: cols('used', 'fresh') },
          { kind: 'none' },
        );
        await somebodyWaits(db, 'the edit waiting for the reading');
      });
      assert.ok(editing !== undefined);
      await within(10_000, 'the edit', editing);
      assert.deepEqual(await primaryOf(id), ['used']);
      assert.equal(recorded.length, 1, 'the reading moved it once');
    });

    it('does not deadlock with a channel edit on the primary it demotes', async () => {
      // A channel PATCH used to write the channel row first and the sensor (by trigger) after,
      // the opposite of this path: holding `used` and waiting for the sensor, while the reading
      // held the sensor and waited for `used` to demote it. Both sides now take the sensor first.
      const id = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['used', true],
      ]);
      const recorded: Recorded[] = [];
      const one = holding(declaring(recorded), [reading(id, ['fresh'])]);
      try {
        await within(10_000, 'the reading holding its sensor', one.locked);
        const patched = harness.service.patchChannel(testActor, id, 'used', {
          limits: { upperError: 5 },
        });
        await somebodyWaits(db, 'the channel edit waiting for the reading');
        one.release();
        const settled = await within(
          10_000,
          'the reading and the channel edit',
          Promise.allSettled([one.done, patched]),
        );
        assert.deepEqual(
          settled.map((outcome) =>
            outcome.status === 'fulfilled' ? 'fulfilled' : String(outcome.reason),
          ),
          ['fulfilled', 'fulfilled'],
        );
      } finally {
        one.release();
      }
      assert.deepEqual(await primaryOf(id), ['fresh']);
      const limits = await db.query<{ limits: { upperError?: number } }>(
        "SELECT limits FROM channel WHERE sensor_id = $1 AND key = 'used'",
        [id],
      );
      assert.equal(limits[0]?.limits.upperError, 5);
    });

    it('moves it through ingestion, audited by the system, with the readings stored on it', async () => {
      // End to end: an edit puts a new column first, the real result path creates it from its
      // first reading, and the move reaches the audit log and the result cache as an edit's does.
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'through-ingestion',
        sensorType: 'test.columns',
        params: cols('used', 'free'),
      });
      await harness.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: cols('fresh', 'used', 'free') },
        { kind: 'none' },
      );
      assert.deepEqual(await primaryOf(sensor.id), ['used'], 'the edit kept it (P-309)');

      // Behind the database sink and the real invalidator, as `ingestionAuditSinks` puts it; the
      // invalidator reaches the resolver through a handle, since each needs the other.
      const forgot: number[] = [];
      const handle: { resolver: ChannelResolver | null } = { resolver: null };
      const invalidator = new ResultCacheInvalidator({
        channels: {
          forget: (sensorId) => {
            forgot.push(sensorId);
            return handle.resolver?.forget(sensorId) ?? 0;
          },
          clear: () => {
            handle.resolver?.clear();
          },
        },
        logger: silent,
      });
      const recorded: Recorded[] = [];
      const resolver = declaring(
        recorded,
        new CompositeAuditSink([new DatabaseAuditSink(), invalidator]),
      );
      handle.resolver = resolver;
      const config: IngestionConfig = {
        queueMaxRows: 200_000,
        batchMaxRows: 5_000,
        batchMaxDelayMs: 5,
        slowDownAtPercent: 50,
        retryAfterMs: 1_000,
        replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
      };
      const ingestor = new Ingestor({ db, logger: silent, config });
      const service = new IngestionService({ db, logger: silent, ingestor, resolver });
      // Recent, so ingestion's clock checks take every result.
      const since = Date.now() - 600_000;
      const batch = (minute: number): Parameters<IngestionService['acceptResults']>[1] => ({
        type: 'results',
        batchId: `primary-${String(minute)}`,
        results: [
          {
            sensorId: sensor.id,
            at: new Date(since + minute * 60_000).toISOString(),
            outcome: 'ok' as const,
            message: '',
            durationMs: 1,
            channels: [
              { key: 'used', value: minute },
              { key: 'free', value: minute },
              { key: 'fresh', value: 40 + minute },
            ],
          },
        ],
      });
      try {
        assert.equal((await service.acceptResults('probe-1', batch(1))).type, 'results-ack');
        assert.equal((await service.acceptResults('probe-1', batch(2))).type, 'results-ack');
      } finally {
        await ingestor.stop();
        invalidator.stop();
      }

      assert.deepEqual(await primaryOf(sensor.id), ['fresh']);
      const stored = await db.query<{ value: number }>(
        `SELECT s.value FROM sample s JOIN channel c ON c.id = s.channel_id
         WHERE c.sensor_id = $1 AND c.is_primary ORDER BY s.time`,
        [sensor.id],
      );
      assert.deepEqual(
        stored.map((row) => row.value),
        [41, 42],
        'both readings, on the new primary',
      );

      const entries = (
        await new AuditRepository().list(db, {
          objectId: sensor.id,
          categories: ['channel'],
          limit: 50,
        })
      ).filter((entry) => entry.action === 'channel.redeclared');
      assert.deepEqual(
        entries
          .map((entry) => ({
            actor: entry.actor,
            channelKey: entry.summary['channelKey'],
            diff: entry.diff.map((change) => ({ ...change })),
          }))
          .sort((a, b) => String(a.channelKey).localeCompare(String(b.channelKey))),
        [
          {
            actor: { kind: 'system', component: 'ingestion' },
            channelKey: 'fresh',
            diff: [{ field: 'channel.fresh.isPrimary', before: false, after: true }],
          },
          {
            actor: { kind: 'system', component: 'ingestion' },
            channelKey: 'used',
            diff: [{ field: 'channel.used.isPrimary', before: true, after: false }],
          },
        ],
        'once, by the batch that created it',
      );
      assert.ok(forgot.includes(sensor.id), 'the move made ingestion forget the sensor (M-04)');
    });
  },
);
