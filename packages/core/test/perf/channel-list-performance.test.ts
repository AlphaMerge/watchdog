import { strict as assert } from 'node:assert';
import { loadavg } from 'node:os';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Client, type QueryResultRow } from 'pg';
import type { SensorType } from '@ms/sensors';
import { coreConfigSchema, loadConfig, type CoreConfig } from '@ms/shared';
import { ApiServer } from '../../src/api/server.js';
import { AuditRepository } from '../../src/audit/store.js';
import type { Database } from '../../src/db/pool.js';
import { catalogueSensorTypeGate } from '../../src/objects/sensor-type-gate.js';
import { HistoryService } from '../../src/timeseries/history.js';
import { SqlTimeSeriesStore } from '../../src/timeseries/store.js';
import {
  createScratchDatabase,
  databaseAvailable,
  testDatabaseConfig,
  type ScratchDatabase,
} from '../support/database.js';
import { testCatalogue } from '../support/sensor-types.js';
import { buildHarness, silent, type Harness } from '../support/tree.js';
import { within } from '../support/within.js';

const available = await databaseAvailable();

/**
 * What a sensor's channel list costs now that it asks `sample` (`P-341`), at the v1 target.
 *
 * `P-322` made `retired` need no reading since the sensor's parameters last changed, asked in the
 * statement that reads a sensor's channels (`ObjectRepository.channelsWithRetirement`): a `CASE`
 * whose `ELSE` is a `NOT EXISTS` over `sample`. The subquery **runs** only for a key the type's
 * declaration does not name, but it is **planned** for every sensor of a type that promises its
 * keys (`declaresEveryChannel`), every key declared or not, and planning it plans a scan of every
 * chunk of `sample`: the bound that excludes most of them, `params_changed_at`, is known only per
 * row, so the exclusion happens at run time. `P-322` measured about 0.9 ms of warm planning and
 * 13 ms cold on the dev database's eleven chunks. The v1 target keeps the shipped raw retention
 * in one-day chunks (migration 003), so about forty-one. And `P-322`'s review put the same
 * statement on the conditional path of `GET /objects/:id?include=channels`, which until then
 * answered a 304 from the version and the chain alone.
 *
 * Measured here, so that `docs/findings/` can say whether dropping the subquery when nothing needs
 * it is worth doing:
 *
 * - **the channel list**, `GET /objects/:id/channels`, which the sensor page reads on every open
 *   (`ObjectDetailView`) and `GET /sensors/:id/values` asks again for `retired`: warm, through the
 *   routes, for a type that cannot say, a type with every key declared (`P-341`'s case), two keys
 *   an edit took out just now, two taken out a month ago with one of them read since, and a
 *   different sensor each call;
 * - **the statement alone**, as `P-322` shipped it and with the subquery taken out and nothing
 *   else changed, warm and as a new connection's first statement, with the planner's own planning
 *   and execution times beside the round trip;
 * - **a conditional GET answering 304**, with `?include=channels`, with `?include=ancestors` (the
 *   same chain walk without the channels), and with nothing included.
 *
 * **The fixture is the v1 target's shape where the cost depends on it**: 5,000 sensors with three
 * channels each (CAPABILITIES.MD §13), and `sample` holding the shipped raw retention in daily
 * chunks, those older than the shipped `compression.rawAfterDays` compressed by the store the
 * housekeeper uses (`SqlTimeSeriesStore.compact`). **Not its density**: every channel is read
 * every six hours rather than every minute, about 2.4 million rows where the target holds 864
 * million. The statement's cost is planning a scan of every chunk and, for an undeclared key, one
 * probe of each chunk's `(channel_id, time)` index past the change; neither depends on how full a
 * chunk is beyond a level of that index, and filling forty days at the target's rate is not a
 * coffee break.
 *
 * The SQL is held here rather than called through the repository, as `state-latest-plan` holds
 * its forms, so the form `P-322` shipped can still be measured beside whatever replaces it; the
 * fixture checks that the held form answers exactly as the route does.
 */
const GROUPS = 50;
const DEVICES_PER_GROUP = 10;
const SENSORS_PER_DEVICE = 10;
const SENSORS = GROUPS * DEVICES_PER_GROUP * SENSORS_PER_DEVICE;
/** A table's three columns, the first primary: `snmp.table`'s shape. */
const KEYS = ['in', 'out', 'errors'] as const;
const CHANNELS = SENSORS * KEYS.length;
/** How often each channel is read in the fixture: see the file comment. */
const EVERY_HOURS = 6;
/** How long ago the older edit took its two columns out: most of the chunks are past it. */
const EDITED_DAYS_AGO = 30;

/** The shipped housekeeping defaults, read from the schema so the fixture cannot drift. */
const HOUSEKEEPING = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config
  .housekeeping;
const RAW_DAYS = HOUSEKEEPING.retention.rawDays;
const COMPRESS_AFTER_DAYS = HOUSEKEEPING.compression.rawAfterDays;

const WARMUP = 30;
/** Calls timed per variant through the routes, interleaved: a call of each variant a round. */
const ROUNDS = 300;
/** The statement alone is cheaper to ask, so more of it. */
const STATEMENT_ROUNDS = 400;
const EXPLAINS = 200;
/** Each a new connection, which costs more than the statement does, so fewer. */
const COLD_ROUNDS = 120;
/** The bound on any one wait on a new connection's far end (`within`, rule 22 of CLAUDE.md). */
const BOUND_MS = 30_000;

/**
 * An operator's budgets, not the machine's, and wide on purpose: this file is a measurement for
 * `docs/findings/`, and what it asserts is only that nothing has gone badly wrong. A sensor page
 * makes half a dozen reads when it opens, and `visibility-performance` holds a page of the tree
 * to a quarter of a second; one of those reads is held to 50 ms at the median and 150 ms at the
 * p95. `P-322` measured the statement at about a millisecond on eleven chunks, so four times the
 * chunks still leaves an order of magnitude. A new connection's first statement also loads the
 * catalogue entries of every chunk it plans (`P-341`'s 13 ms on eleven), and pg's pool, which
 * `Database` leaves at its default, closes a client idle for ten seconds: 300 ms at the median
 * there would make the first click after a pause visibly slow.
 */
const BUDGET_MS = { warmMedian: 50, warmP95: 150, coldMedian: 300 } as const;

interface Column {
  key: string;
}

/**
 * `snmp.table`'s shape without SNMP, as `retired-channels.test.ts` has it: each column a channel,
 * and the promise that makes the core ask `sample` about a key the columns do not name. The types
 * in `support/sensor-types.ts` make no promise, so with them alone the list never reaches the
 * subquery at all.
 */
const columns: SensorType = {
  id: 'perf.columns',
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
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    return named.map((column, at) => ({
      key: column.key,
      name: `Column ${column.key}`,
      ...(at === 0 ? { isPrimary: true } : {}),
    }));
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/** Every column the sensor has a channel for: nothing for the subquery to be asked about. */
const EVERY_KEY = { columns: KEYS.map((key) => ({ key })) };
/** An edit that took the last two columns out. */
const FIRST_KEY = { columns: [{ key: KEYS[0] }] };

const CHANNEL_COLUMNS = `c.id, c.sensor_id, c.key, c.name, c.unit, c.is_primary, c.scale_mul,
              c.scale_div, c.decimals, c.limits, c.spike_min, c.spike_max, c.show_in_graph,
              c.show_in_table, c.lookup_id`;

const FORMS = {
  /** `ObjectRepository.#channelRows` as `P-322` and `P-340` left it. */
  shipped: `SELECT ${CHANNEL_COLUMNS},
              CASE
                WHEN $2::text[] IS NULL OR c.key = ANY($2::text[]) THEN false
                ELSE NOT EXISTS (
                  SELECT 1 FROM sample s
                  WHERE s.channel_id = c.id AND s.time > sc.params_changed_at
                )
              END AS retired
       FROM channel c
       LEFT JOIN sensor_config sc ON sc.object_id = c.sensor_id
       WHERE c.sensor_id = $1
       ORDER BY c.is_primary DESC, c.key`,
  /** The same with the subquery taken out and nothing else: the difference is the subquery's. */
  dropped: `SELECT ${CHANNEL_COLUMNS}, false AS retired
       FROM channel c
       LEFT JOIN sensor_config sc ON sc.object_id = c.sensor_id
       WHERE c.sensor_id = $1
       ORDER BY c.is_primary DESC, c.key`,
} as const;

/** One sensor the list is read for, and what its answer must say. */
interface Subject {
  readonly label: string;
  readonly id: number;
  /** What the service hands the statement: `SensorTypeGate.reportableKeys`, as an array. */
  readonly reportable: string[] | null;
  /** The keys that must come back retired, sorted. */
  readonly retired: readonly string[];
}

interface Spread {
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}

function row(label: string, spread: Spread, note = ''): string {
  return (
    `      ${label.padEnd(50)} median ${spread.median.toFixed(2).padStart(7)} ms` +
    `  p95 ${spread.p95.toFixed(2).padStart(7)} ms  max ${spread.max.toFixed(2).padStart(7)} ms` +
    (note === '' ? '' : `  ${note}`)
  );
}

/** Adds to `over` what is outside its budget. A NaN is outside every budget. */
function judge(over: string[], label: string, spread: Spread, median: number, p95?: number): void {
  if (!(spread.median <= median)) {
    over.push(`${label}: median ${spread.median.toFixed(2)} ms > ${String(median)} ms`);
  }
  if (p95 !== undefined && !(spread.p95 <= p95)) {
    over.push(`${label}: p95 ${spread.p95.toFixed(2)} ms > ${String(p95)} ms`);
  }
}

/**
 * Each variant `rounds` times after `warmup` untimed, interleaved: a call of every variant each
 * round, the order rotated, so that a drift in the machine lands on all of them alike and no
 * variant always runs straight after the same neighbour.
 */
async function interleaved(
  variants: readonly (readonly [string, () => Promise<void>])[],
  warmup: number,
  rounds: number,
): Promise<Map<string, Spread>> {
  for (let round = 0; round < warmup; round += 1) {
    for (const [, run] of variants) await run();
  }
  const times = new Map<string, number[]>(variants.map(([label]) => [label, []]));
  for (let round = 0; round < rounds; round += 1) {
    for (let at = 0; at < variants.length; at += 1) {
      const variant = variants[(at + round) % variants.length];
      assert.ok(variant !== undefined);
      const [label, run] = variant;
      const started = process.hrtime.bigint();
      await run();
      times.get(label)?.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
  return new Map([...times].map(([label, ms]) => [label, spreadOf(ms)]));
}

/** One node of `EXPLAIN (FORMAT JSON)`, with only the fields read here named. */
interface PlanNode {
  readonly 'Relation Name'?: string;
  readonly Plans?: readonly PlanNode[];
  readonly [field: string]: unknown;
}

interface Explained {
  readonly Plan: PlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
}

function* nodesOf(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* nodesOf(child);
}

/**
 * How many of `sample`'s chunk relations the plan holds. A compressed chunk can be two, the chunk
 * and its compressed table, so this is read beside the fixture's own chunk counts, never alone.
 */
function chunkRelations(plan: PlanNode): number {
  const names = new Set<string>();
  for (const node of nodesOf(plan)) {
    const name = node['Relation Name'];
    if (name !== undefined && /hyper_\d+_\d+_chunk$/.test(name)) names.add(name);
  }
  return names.size;
}

describe(
  `the channel list at ${SENSORS.toLocaleString('en')} sensors (P-341)`,
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    const store = new SqlTimeSeriesStore();
    const gate = catalogueSensorTypeGate(testCatalogue([columns]));
    const subjects: Subject[] = [];
    /** Sensors with every key declared, for the variant that reads a different one each call. */
    let rotation: number[] = [];
    let declaredId = 0;
    let editedLongAgoId = 0;
    let declaredKeys: string[] = [];

    const channelsUrl = (id: number): string => `/api/v1/objects/${String(id)}/channels`;
    const objectUrl = (id: number): string => `/api/v1/objects/${String(id)}`;

    const reportable = (type: string, params: Record<string, unknown>): string[] | null => {
      const keys = gate.reportableKeys(type, params);
      return keys === null ? null : [...keys];
    };

    /** The statements `run` sends through `db.query`, in order (`visibility-performance`'s way). */
    async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
      const texts: string[] = [];
      const query = db.query.bind(db);
      db.query = <T extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<T[]> => {
        texts.push(text);
        return query<T>(text, values);
      };
      try {
        await run();
      } finally {
        delete (db as { query?: unknown }).query;
      }
      return texts;
    }

    before(async () => {
      const building = process.hrtime.bigint();
      scratch = await createScratchDatabase('chanlistperf');
      db = scratch.db;
      harness = await buildHarness(db, { types: [columns] });
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
        catalogue: testCatalogue([columns]),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      // ── the tree, a level per statement ──────────────────────────────────────────────────
      const [probe] = await db.query<{ id: string }>(
        `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'perf-probe')
         RETURNING id::text AS id`,
        [harness.rootId],
      );
      assert.ok(probe !== undefined);
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT $1, 'group', 'group-' || g FROM generate_series(1, $2) g`,
        [probe.id, GROUPS],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'device', o.name || '-device-' || d
         FROM object o, generate_series(1, $1) d
         WHERE o.kind = 'group'`,
        [DEVICES_PER_GROUP],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'sensor', o.name || '-sensor-' || s
         FROM object o, generate_series(1, $1) s
         WHERE o.kind = 'device'
         ORDER BY o.id, s`,
        [SENSORS_PER_DEVICE],
      );
      await db.query(
        `INSERT INTO sensor_config (object_id, type, params)
         SELECT id, $1, $2::jsonb FROM object WHERE kind = 'sensor'`,
        [columns.id, JSON.stringify(EVERY_KEY)],
      );
      await db.query(
        `INSERT INTO channel (sensor_id, key, name, is_primary)
         SELECT sc.object_id, k.key, 'Column ' || k.key, k.at = 1
         FROM sensor_config sc, unnest($1::text[]) WITH ORDINALITY AS k(key, at)`,
        [[...KEYS]],
      );

      // ── the readings: the shipped raw retention, a reading of every channel every six hours ──
      const [span] = await db.query<{ starts: Date; ends: Date }>(
        `SELECT time_bucket('1 day', now()) - make_interval(days => $1::int) AS starts,
                now() - make_interval(hours => $2::int) AS ends`,
        [RAW_DAYS, EVERY_HOURS],
      );
      assert.ok(span !== undefined);
      // Each channel at its own minute within the six hours, so a chunk is not one instant; the
      // offset is under six hours and the last slot six hours back, so nothing is in the future.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT t.at + (c.id % $3::int) * interval '1 minute', c.id, (c.id % 97)::double precision
         FROM channel c,
              generate_series($1::timestamptz, $2::timestamptz,
                              make_interval(hours => $4::int)) AS t(at)`,
        [span.starts, span.ends, EVERY_HOURS * 60, EVERY_HOURS],
      );

      // ── the sensors measured ─────────────────────────────────────────────────────────────
      const sensorIds = (
        await db.query<{ id: string }>(
          `SELECT object_id::text AS id FROM sensor_config ORDER BY object_id`,
        )
      ).map((one) => Number(one.id));
      assert.equal(sensorIds.length, SENSORS);
      const pick = (at: number): number => {
        const id = sensorIds[at];
        assert.ok(id !== undefined);
        return id;
      };
      declaredId = pick(0);
      const editedNowId = pick(SENSORS / 4);
      editedLongAgoId = pick(SENSORS / 2);
      const unflaggedId = pick((3 * SENSORS) / 4);

      // Two columns taken out just now, after every reading: nothing has read them since, so both
      // are retired, and the probe that says so finds only today's chunk past the change.
      await db.query(`UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1`, [
        editedNowId,
        JSON.stringify(FIRST_KEY),
      ]);
      // Two taken out a month ago. `params_changed_at` is the trigger's to set (`P-340`), so it is
      // held off for the one statement that dates the edit. `out` has no reading since, as an
      // edit leaves it (`P-303`): retired, its probe finding nothing in every chunk past the
      // change. `errors` keeps its readings, as from a probe newer than the core (`P-322`): live,
      // its probe stopping at the first.
      const [edit] = await db.query<{ at: Date }>(
        `SELECT now() - make_interval(days => $1::int) AS at`,
        [EDITED_DAYS_AGO],
      );
      assert.ok(edit !== undefined);
      await db.tx(async (q) => {
        await q.query('ALTER TABLE sensor_config DISABLE TRIGGER sensor_config_params_changed');
        await q.query(
          `UPDATE sensor_config SET params = $2::jsonb, params_changed_at = $3
           WHERE object_id = $1`,
          [editedLongAgoId, JSON.stringify(FIRST_KEY), edit.at],
        );
        await q.query('ALTER TABLE sensor_config ENABLE TRIGGER sensor_config_params_changed');
      });
      await db.query(
        `DELETE FROM sample s USING channel c
         WHERE c.sensor_id = $1 AND c.key = $2 AND s.channel_id = c.id AND s.time > $3`,
        [editedLongAgoId, KEYS[1], edit.at],
      );
      // A type that cannot say which keys it reports: the statement is handed null for it.
      await db.query(
        `UPDATE sensor_config SET type = 'icmp.ping', params = '{}'::jsonb WHERE object_id = $1`,
        [unflaggedId],
      );

      // Counted before compression, which a count would otherwise have to read back through.
      const [filled] = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM sample');
      const readings = Number(filled?.n);

      // ── compressed as the housekeeper compresses, where the licence allows it ────────────
      // After the month-old edit's readings are taken out, not before: a delete from a
      // compressed chunk leaves it partly compressed, a shape a quiet installation's chunks are
      // not in.
      const [licence] = await db.query<{ granted: string | null }>(
        `SELECT current_setting('timescaledb.license', true) AS granted`,
      );
      if (licence?.granted === 'timescale') {
        const [cutoff] = await db.query<{ at: Date }>(
          `SELECT now() - make_interval(days => $1::int) AS at`,
          [COMPRESS_AFTER_DAYS],
        );
        assert.ok(cutoff !== undefined);
        for (const chunk of await store.compactableChunks(db, 'sample', cutoff.at, 1_000)) {
          await store.compact(db, chunk);
        }
      }
      await db.query('ANALYZE');

      const [counts] = await db.query<{ sensors: number; channels: number }>(
        `SELECT (SELECT count(*) FROM sensor_config)::int AS sensors,
                (SELECT count(*) FROM channel)::int AS channels`,
      );
      assert.ok(counts !== undefined);
      assert.equal(counts.sensors, SENSORS);
      assert.equal(counts.channels, CHANNELS);
      const [chunks] = await db.query<{ total: number; compressed: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_compressed)::int AS compressed
         FROM timescaledb_information.chunks WHERE hypertable_name = 'sample'`,
      );
      assert.ok(chunks !== undefined);
      assert.ok(chunks.total >= RAW_DAYS, `${String(chunks.total)} chunks of sample`);

      // ── what each variant's label says, checked before anything is timed ────────────────
      declaredKeys = reportable(columns.id, EVERY_KEY) ?? [];
      assert.deepEqual([...declaredKeys].sort(), [...KEYS].sort(), 'every key declared');
      assert.equal(reportable('icmp.ping', {}), null, 'a type that cannot say');
      subjects.push(
        {
          label: 'a type that cannot say (icmp.ping)',
          id: unflaggedId,
          reportable: null,
          retired: [],
        },
        {
          label: 'every key declared (P-341’s case)',
          id: declaredId,
          reportable: declaredKeys,
          retired: [],
        },
        {
          label: 'two keys an edit took out just now',
          id: editedNowId,
          reportable: reportable(columns.id, FIRST_KEY),
          retired: ['errors', 'out'],
        },
        {
          label: `two taken out ${String(EDITED_DAYS_AGO)} days ago, one read since`,
          id: editedLongAgoId,
          reportable: reportable(columns.id, FIRST_KEY),
          retired: ['out'],
        },
      );
      for (const subject of subjects) {
        const response = await app.inject({ method: 'GET', url: channelsUrl(subject.id) });
        assert.equal(response.statusCode, 200, response.body);
        const items = (JSON.parse(response.body) as { items: { key: string; retired: boolean }[] })
          .items;
        assert.deepEqual(
          items.map((one) => one.key).sort(),
          [...KEYS].sort(),
          `${subject.label}: its three channels`,
        );
        assert.deepEqual(
          items
            .filter((one) => one.retired)
            .map((one) => one.key)
            .sort(),
          [...subject.retired],
          `${subject.label}: what is retired`,
        );
        // The held form answers as the route does, so what is timed below is what it runs.
        const held = await db.query<{ key: string; retired: boolean }>(FORMS.shipped, [
          subject.id,
          subject.reportable,
        ]);
        assert.deepEqual(
          held.map((one) => [one.key, one.retired]),
          items.map((one) => [one.key, one.retired]),
          `${subject.label}: the held statement agrees with the route`,
        );
      }
      const measured = new Set([editedNowId, editedLongAgoId, unflaggedId]);
      rotation = sensorIds.filter((id) => !measured.has(id));

      // Whether the route still sends a statement that asks `sample`, said beside the numbers so
      // that a run after a fix reads as one.
      const sent = await statementsOf(() =>
        app.inject({ method: 'GET', url: channelsUrl(declaredId) }),
      );
      assert.ok(sent.length > 0, 'the route read through this database');
      const asksSample = sent.some((text) => /\bFROM sample\b/.test(text));

      const [others] = await db.query<{ active: string; total: string }>(
        `SELECT count(*) FILTER (WHERE state <> 'idle')::text AS active, count(*)::text AS total
         FROM pg_stat_activity
         WHERE datname IS NOT NULL AND datname <> current_database()`,
      );
      const builtMs = Number(process.hrtime.bigint() - building) / 1e6;
      process.stdout.write(
        `\n    fixture (P-341): ${SENSORS.toLocaleString('en')} sensors, ` +
          `${CHANNELS.toLocaleString('en')} channels; sample ${String(chunks.total)} daily ` +
          `chunks, ${String(chunks.compressed)} compressed, ${readings.toLocaleString('en')} ` +
          `readings; built in ${(builtMs / 1_000).toFixed(1)} s\n` +
          `    conditions: load ${loadavg()
            .map((one) => one.toFixed(2))
            .join(' / ')}, ${others?.total ?? '?'} client(s) of other databases, ` +
          `${others?.active ?? '?'} of them active\n` +
          `    the route’s channel list asks sample: ${asksSample ? 'yes' : 'no'}\n`,
      );
    });

    after(async () => {
      try {
        await app.close();
      } finally {
        await scratch.drop();
      }
    });

    it('lists a sensor’s channels inside an operator’s budget, warm, by the route', async () => {
      const listOf = (id: number) => async (): Promise<void> => {
        const response = await app.inject({ method: 'GET', url: channelsUrl(id) });
        assert.equal(response.statusCode, 200);
      };
      // A sensor not read before on every timed call: the plan's catalogue entries are warm, the
      // sensor's own rows and index pages need not be.
      let next = 0;
      const elsewhere = async (): Promise<void> => {
        const id = rotation[next % rotation.length];
        next += 1;
        assert.ok(id !== undefined);
        await listOf(id)();
      };
      const ELSEWHERE = 'every key declared, a different sensor each call';
      const variants: (readonly [string, () => Promise<void>])[] = [
        ...subjects.map((subject) => [subject.label, listOf(subject.id)] as const),
        [ELSEWHERE, elsewhere],
      ];
      const measured = await interleaved(variants, WARMUP, ROUNDS);

      const rows: string[] = [];
      const over: string[] = [];
      for (const [label, spread] of measured) {
        rows.push(row(label, spread));
        judge(over, label, spread, BUDGET_MS.warmMedian, BUDGET_MS.warmP95);
      }
      process.stdout.write(
        `\n    GET /objects/:id/channels, warm, ${String(ROUNDS)} calls each:\n` +
          `${rows.join('\n')}\n`,
      );
      assert.deepEqual(over, [], 'over budget');
    });

    it('costs the statement the planning of a subquery it never runs', async () => {
      // One sensor, every key declared, so the three differ only in what is planned: the
      // subquery as shipped; the subquery handed null, as a type that cannot say hands it, which
      // a custom plan may fold away before the subquery is planned (the chunk count says whether
      // it did); and no subquery at all.
      const forms: readonly { label: string; sql: string; values: unknown[] }[] = [
        {
          label: 'as shipped, every key declared',
          sql: FORMS.shipped,
          values: [declaredId, declaredKeys],
        },
        {
          label: 'as shipped, handed null (a type that cannot say)',
          sql: FORMS.shipped,
          values: [declaredId, null],
        },
        { label: 'without the subquery', sql: FORMS.dropped, values: [declaredId] },
      ];
      const measured = await interleaved(
        forms.map(
          (form) =>
            [
              form.label,
              async (): Promise<void> => {
                const rows = await db.query(form.sql, form.values);
                assert.equal(rows.length, KEYS.length);
              },
            ] as const,
        ),
        WARMUP,
        STATEMENT_ROUNDS,
      );

      // The planner's own account, interleaved the same way: where the round trip goes.
      const planning = new Map<string, number[]>(forms.map((form) => [form.label, []]));
      const execution = new Map<string, number[]>(forms.map((form) => [form.label, []]));
      const relations = new Map<string, number>();
      for (let round = 0; round < EXPLAINS; round += 1) {
        for (let at = 0; at < forms.length; at += 1) {
          const form = forms[(at + round) % forms.length];
          assert.ok(form !== undefined);
          const [explained] = await db.query<{ 'QUERY PLAN': Explained[] }>(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${form.sql}`,
            form.values,
          );
          const result = explained?.['QUERY PLAN'][0];
          assert.ok(result !== undefined, 'EXPLAIN answered nothing');
          planning.get(form.label)?.push(result['Planning Time']);
          execution.get(form.label)?.push(result['Execution Time']);
          relations.set(form.label, chunkRelations(result.Plan));
        }
      }

      const rows: string[] = [];
      const over: string[] = [];
      for (const form of forms) {
        const spread = measured.get(form.label);
        assert.ok(spread !== undefined);
        const planned = spreadOf(planning.get(form.label) ?? []);
        const executed = spreadOf(execution.get(form.label) ?? []);
        rows.push(
          row(
            form.label,
            spread,
            `planning ${planned.median.toFixed(2)} ms, execution ${executed.median.toFixed(2)} ms` +
              ` (medians of ${String(EXPLAINS)}), ${String(relations.get(form.label) ?? 0)}` +
              ` chunk relations planned`,
          ),
        );
        judge(over, form.label, spread, BUDGET_MS.warmMedian, BUDGET_MS.warmP95);
      }
      const shipped = measured.get(forms[0]?.label ?? '');
      const dropped = measured.get(forms[2]?.label ?? '');
      assert.ok(shipped !== undefined && dropped !== undefined);
      process.stdout.write(
        `\n    the statement alone, warm, ${String(STATEMENT_ROUNDS)} each, one sensor:\n` +
          `${rows.join('\n')}\n` +
          `      the subquery, never run, adds ` +
          `${(shipped.median - dropped.median).toFixed(2)} ms ` +
          `at the median\n`,
      );
      assert.deepEqual(over, [], 'over budget');
    });

    it('answers a conditional GET with ?include=channels inside the same budget', async () => {
      const queryOf = (include: string | undefined): { query?: Record<string, string> } =>
        include === undefined ? {} : { query: { include } };
      const tagOf = async (id: number, include: string | undefined): Promise<string> => {
        const response = await app.inject({
          method: 'GET',
          url: objectUrl(id),
          ...queryOf(include),
        });
        assert.equal(response.statusCode, 200, response.body);
        const tag = response.headers['etag'];
        assert.ok(typeof tag === 'string', 'the answer carries a tag');
        return tag;
      };
      const revalidate = async (
        id: number,
        include: string | undefined,
      ): Promise<() => Promise<void>> => {
        const tag = await tagOf(id, include);
        return async (): Promise<void> => {
          const response = await app.inject({
            method: 'GET',
            url: objectUrl(id),
            headers: { 'if-none-match': tag },
            ...queryOf(include),
          });
          assert.equal(response.statusCode, 304);
        };
      };
      const render = async (): Promise<void> => {
        const response = await app.inject({
          method: 'GET',
          url: objectUrl(declaredId),
          query: { include: 'channels' },
        });
        assert.equal(response.statusCode, 200);
      };

      const variants: (readonly [string, () => Promise<void>])[] = [
        ['304, nothing included', await revalidate(declaredId, undefined)],
        [
          '304, ?include=ancestors (the chain, no channels)',
          await revalidate(declaredId, 'ancestors'),
        ],
        ['304, ?include=channels, every key declared', await revalidate(declaredId, 'channels')],
        [
          `304, ?include=channels, taken out ${String(EDITED_DAYS_AGO)} days ago`,
          await revalidate(editedLongAgoId, 'channels'),
        ],
        ['200, ?include=channels rendered, for scale', render],
      ];
      const measured = await interleaved(variants, WARMUP, ROUNDS);

      const rows: string[] = [];
      const over: string[] = [];
      for (const [label, spread] of measured) {
        rows.push(row(label, spread));
        judge(over, label, spread, BUDGET_MS.warmMedian, BUDGET_MS.warmP95);
      }
      process.stdout.write(
        `\n    GET /objects/:id with If-None-Match, warm, ${String(ROUNDS)} calls each:\n` +
          `${rows.join('\n')}\n`,
      );
      assert.deepEqual(over, [], 'over budget');
    });

    it('pays for planning every chunk again on a new connection', async () => {
      // A backend's first plan of `sample` loads the catalogue entries of every chunk it plans,
      // which is `P-341`'s cold figure. Each call below is a connection of its own, opened and
      // closed outside the time; the statement is its first.
      const config = testDatabaseConfig();
      const onNewConnection = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
        const client = new Client({
          host: config.host,
          port: config.port,
          database: scratch.name,
          user: config.user,
          password: config.password,
          connectionTimeoutMillis: config.connectTimeoutMs,
        });
        await within(BOUND_MS, 'a new connection to the scratch database', client.connect());
        try {
          return await work(client);
        } finally {
          await within(BOUND_MS, 'a new connection to close', client.end());
        }
      };

      const forms: readonly { label: string; sql: string; values: unknown[] }[] = [
        {
          label: 'as shipped, every key declared',
          sql: FORMS.shipped,
          values: [declaredId, declaredKeys],
        },
        { label: 'without the subquery', sql: FORMS.dropped, values: [declaredId] },
      ];
      const trips = new Map<string, number[]>(forms.map((form) => [form.label, []]));
      const planning = new Map<string, number[]>(forms.map((form) => [form.label, []]));
      const execution = new Map<string, number[]>(forms.map((form) => [form.label, []]));
      for (let round = 0; round < COLD_ROUNDS; round += 1) {
        for (let at = 0; at < forms.length; at += 1) {
          const form = forms[(at + round) % forms.length];
          assert.ok(form !== undefined);
          const ms = await onNewConnection(async (client) => {
            const started = process.hrtime.bigint();
            const result = await within(
              BOUND_MS,
              'the first statement on a new connection',
              client.query<{ key: string; retired: boolean }>(form.sql, form.values),
            );
            const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
            assert.equal(result.rows.length, KEYS.length);
            return elapsed;
          });
          trips.get(form.label)?.push(ms);
          // A connection of its own again: the plan below must be its first, not this one's
          // second.
          const result = await onNewConnection(async (client) => {
            const explained = await within(
              BOUND_MS,
              'the first EXPLAIN on a new connection',
              client.query<{ 'QUERY PLAN': Explained[] }>(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${form.sql}`,
                form.values,
              ),
            );
            return explained.rows[0]?.['QUERY PLAN'][0];
          });
          assert.ok(result !== undefined, 'EXPLAIN answered nothing');
          planning.get(form.label)?.push(result['Planning Time']);
          execution.get(form.label)?.push(result['Execution Time']);
        }
      }

      const rows: string[] = [];
      const over: string[] = [];
      const medians: number[] = [];
      for (const form of forms) {
        const spread = spreadOf(trips.get(form.label) ?? []);
        const planned = spreadOf(planning.get(form.label) ?? []);
        const executed = spreadOf(execution.get(form.label) ?? []);
        medians.push(spread.median);
        rows.push(
          row(
            form.label,
            spread,
            `planning median ${planned.median.toFixed(2)} ms (p95 ${planned.p95.toFixed(2)}),` +
              ` execution median ${executed.median.toFixed(2)} ms`,
          ),
        );
        judge(over, `new connection, ${form.label}`, spread, BUDGET_MS.coldMedian);
      }
      process.stdout.write(
        `\n    a new connection’s first statement, ${String(COLD_ROUNDS)} connections each:\n` +
          `${rows.join('\n')}\n` +
          `      the subquery, never run, adds ` +
          ((medians[0] ?? 0) - (medians[1] ?? 0)).toFixed(2) +
          ` ms at the median\n`,
      );
      assert.deepEqual(over, [], 'over budget');
    });
  },
);
