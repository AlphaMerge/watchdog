import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { SensorType } from '@ms/sensors';
import { coreConfigSchema, loadConfig, type CoreConfig } from '@ms/shared';
import { SESSION_COOKIE } from '../../src/api/authentication.js';
import { ApiServer } from '../../src/api/server.js';
import { AuditRepository, DatabaseAuditSink } from '../../src/audit/store.js';
import { AccessService } from '../../src/auth/access.js';
import { AccountService } from '../../src/auth/accounts.js';
import { GroupService } from '../../src/auth/groups.js';
import { SessionService } from '../../src/auth/sessions.js';
import { LoginThrottle } from '../../src/auth/throttle.js';
import { TokenService } from '../../src/auth/tokens.js';
import { TotpService } from '../../src/auth/totp.js';
import type { Database, Queryable } from '../../src/db/pool.js';
import { catalogueSensorTypeGate } from '../../src/objects/sensor-type-gate.js';
import { HistoryService } from '../../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  testDatabaseConfig,
  type ScratchDatabase,
} from '../support/database.js';
import { testCatalogue } from '../support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * What a poll of `/values` costs at the v1 target, and how much of it `U-38`'s two reads are
 * (`P-374`).
 *
 * A sensor page's channel table asks `GET /sensors/:id/values` every fifteen seconds for as long
 * as it is open. `U-38` made the answer carry each channel's `retired`, from the channel list's
 * own derivation, so every poll now also reads the whole object (`ObjectRepository.get`: five
 * joins and a count of the children) and then the channels again with their retirement
 * (`channelsWithRetirement`). `U-38` timed that with a throwaway loop against the dev database,
 * whose widest sensor has two channels, while another agent's runs shared the VM. This times it
 * at 5,000 sensors through the app, as production assembles the route, and each of the two reads
 * alone through the functions the route calls — beside a read of only what `channels` uses — so
 * the finding can say whether a path reading `sensor_type` and `params` alone is worth having.
 *
 * **The fixture.** 5,000 sensors under one probe, fifty groups and five hundred devices, three
 * channels each as the v1 target has them (`CAPABILITIES.MD §13`), except the forty polled, which
 * have eight: about as wide as an interface sensor, and four times `U-38`'s widest. Twenty of
 * those declare every key they have, the common case, in which the retirement check is never
 * evaluated (`c.key = ANY(...)` answers first). The other twenty had two keys taken out by an
 * edit thirty days ago, so the check runs for two channels and may reach back across a month of
 * chunks. Raw readings for the default retention in day chunks, those past the default
 * compression age compressed as housekeeping leaves them: one reading a channel a day, every
 * minute for the last half hour, and every minute for three days before the edit for the channels
 * it retired, since those are the rows the check reads. A day's chunk at the v1 target holds 21.6
 * million rows, not fifteen thousand; an index probe costs its depth, which that adds a level to
 * at most, and the latest-value read reaches only the newest chunk.
 *
 * **Two callers.** No authentication, as `conditional-get-performance` builds its server, and a
 * read-only account's session with `read` at the root, which is what an operator's browser
 * sends: the session is resolved and extended by an `UPDATE` on every request, and the right is
 * walked from the sensor to the root.
 *
 * Times depend on the machine and are printed for `docs/findings/`. The budgets are an
 * operator's, and say why where they are asserted.
 */
const GROUPS = 50;
const DEVICES_PER_GROUP = 10;
const SENSORS_PER_DEVICE = 10;
const SENSORS = GROUPS * DEVICES_PER_GROUP * SENSORS_PER_DEVICE;

/** The open page: twenty sensors, each polled every fifteen seconds. */
const DASHBOARD = 20;
const POLL_SECONDS = 15;
/** Twenty that declare every key, twenty with keys an edit retired. */
const POLLED = 2 * DASHBOARD;
/** The v1 target's channels a sensor. */
const NARROW = 3;
/** The polled sensors' channels. */
const WIDE = 8;
/** What a retired sensor's parameters still name, after the edit. */
const LIVE = 6;
const RETIRED_KEYS: readonly string[] = Array.from(
  { length: WIDE - LIVE },
  (_, at) => `c${String(LIVE + 1 + at)}`,
);
const CHANNELS = (SENSORS - POLLED) * NARROW + POLLED * WIDE;

/** The shipped housekeeping and pool, read from the schema so the fixture cannot drift. */
const SHIPPED = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config;
const RAW_DAYS = SHIPPED.housekeeping.retention.rawDays;
const COMPRESS_AFTER_DAYS = SHIPPED.housekeeping.compression.rawAfterDays;
const EDITED_DAYS_AGO = 30;
const RECENT_MINUTES = 30;
const BEFORE_EDIT_MINUTES = 3 * 1_440;

/**
 * How often the polled sensors get a reading while this runs, as a probe would keep sending them.
 * Well inside the three-interval window `/values` calls current (three minutes at 60 s), so every
 * timed poll answers with values rather than gaps.
 */
const FRESH_EVERY_MS = 30_000;

const WARMUP_ROUNDS = 2;
/** Twenty rounds over twenty sensors: 400 timed calls of each thing, for each shape. */
const ROUNDS = 20;
/** Fifty rounds of the whole page at once: 1,000 polls a caller. */
const THROUGHPUT_ROUNDS = 50;

/**
 * **The budgets are the operator's, not the machine's.** A poll is every fifteen seconds and the
 * table it refreshes is read by a person: a median inside 50 ms and a 95th percentile inside
 * 150 ms are far under anything someone watching it would notice, and an order of magnitude over
 * the few milliseconds `U-38` measured on a busy VM, so a quiet run clears them with room to spare
 * and one that does not has found something.
 */
const BUDGET_MS = { median: 50, p95: 150 } as const;

/**
 * **The floor on throughput**: thirty accounts, PRTG's own guidance for one installation
 * (`CAPABILITIES.MD §13`), each with a page of twenty sensors open. Forty polls a second.
 */
const ACCOUNTS = 30;
const FLOOR_POLLS_PER_SECOND = (ACCOUNTS * DASHBOARD) / POLL_SECONDS;

/**
 * Far above anything this file sends in a window (`A-39`). It polls as one account thousands of
 * times a minute, past the default of 1,200, and it measures what a poll costs, not how many one
 * account may make.
 */
const RAISED_LIMIT = 1_000_000;

const TYPE_ID = 'perf.columns';

/**
 * What a path reading only what `channels` uses would send (`P-374`): whether the object is a
 * sensor, its type and its stored parameters. Held here, as `state-latest-plan` holds the forms
 * it compares, because nothing in the source sends it yet.
 */
const SLIM_READ = `SELECT o.kind, sc.type AS sensor_type, sc.params
                   FROM object o
                   LEFT JOIN sensor_config sc ON sc.object_id = o.id
                   WHERE o.id = $1`;

/**
 * `snmp.table`'s shape without SNMP, as `retired-channels.test.ts` has it: each column a channel,
 * and a promise that no reading names a key the columns do not, which is what makes a channel the
 * parameters stopped naming retired.
 */
const columns: SensorType = {
  id: TYPE_ID,
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
    const named = Array.isArray(params['columns']) ? (params['columns'] as { key: string }[]) : [];
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    return named.map((column, at) => ({
      key: column.key,
      name: `Column ${column.key}`,
      ...(at === 0 ? { isPrimary: true } : {}),
    }));
  },
  execute: () => Promise.resolve({ channels: [] }),
};

const SHAPES = ['declared', 'retired'] as const;
type Shape = (typeof SHAPES)[number];
const SHAPE_LABEL: Readonly<Record<Shape, string>> = {
  declared: `${String(WIDE)} channels, every key declared`,
  retired:
    `${String(WIDE)} channels, ${String(WIDE - LIVE)} retired by an edit ` +
    `${String(EDITED_DAYS_AGO)} days ago`,
};

/** Everything timed per poll, in the order each iteration runs them. */
const PARTS = [
  'route, no auth',
  'route, signed in',
  'latestForSensor',
  'channels()',
  'object read',
  'channel read',
  'slim read',
  'round trip',
] as const;
type Part = (typeof PARTS)[number];

/** A sensor's stored type and parameters, as the object read returns them. */
interface StoredSensor {
  readonly sensorType: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Fixture {
  readonly db: Database;
  readonly harness: Harness;
  readonly history: HistoryService;
  readonly open: FastifyInstance;
  readonly signedIn: FastifyInstance;
  /** One session a slot of the page, so twenty polls in flight are not twenty on one row. */
  readonly cookies: readonly string[];
  readonly declared: readonly number[];
  readonly retired: readonly number[];
  readonly retiredChannels: readonly number[];
  readonly stored: ReadonlyMap<number, StoredSensor>;
  readonly readings: number;
  readonly chunks: number;
  readonly compressed: number;
}

interface ValuesAnswer {
  channels: { key: string; value: number | null; retired: boolean }[];
}

interface Spread {
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

function spread(ms: readonly number[]): Spread {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}

const valuesUrl = (id: number): string => `/api/v1/sensors/${String(id)}/values`;

/** One poll, as the channel table sends it. The body is not parsed: that is the browser's work. */
async function poll(
  app: FastifyInstance,
  id: number,
  headers: Record<string, string>,
): Promise<void> {
  const response = await app.inject({ method: 'GET', url: valuesUrl(id), headers });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
}

async function answer(app: FastifyInstance, id: number): Promise<ValuesAnswer> {
  const response = await app.inject({ method: 'GET', url: valuesUrl(id) });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
  return response.json<ValuesAnswer>();
}

/**
 * How many statements `run` sends through `db`, and in how many transactions: on the pool, and
 * inside `db.tx`, which is where the values are read. Each transaction is a `BEGIN` and a
 * `COMMIT` more, which this does not count. `visibility-performance`'s recorder, counting.
 */
async function recorded(
  db: Database,
  run: () => Promise<unknown>,
): Promise<{ statements: number; transactions: number }> {
  let statements = 0;
  let transactions = 0;
  const recording = (q: Queryable): void => {
    const query = q.query.bind(q);
    q.query = <T extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<T[]> => {
      statements += 1;
      return query<T>(text, values);
    };
  };
  const tx = db.tx.bind(db);
  recording(db);
  db.tx = <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
    transactions += 1;
    return tx((q) => {
      recording(q);
      return fn(q);
    });
  };
  try {
    await run();
  } finally {
    delete (db as { query?: unknown }).query;
    delete (db as { tx?: unknown }).tx;
  }
  return { statements, transactions };
}

let freshAt: number | undefined;

/** A reading now for every live channel of the polled sensors, at most every `FRESH_EVERY_MS`. */
async function fresh(f: Fixture): Promise<void> {
  if (freshAt !== undefined && performance.now() - freshAt < FRESH_EVERY_MS) return;
  await f.db.query(
    `INSERT INTO sample (time, channel_id, value)
     SELECT now(), c.id, 50 + c.id % 40
     FROM channel c
     WHERE c.sensor_id = ANY($1::bigint[]) AND c.id <> ALL($2::int[])
     ON CONFLICT DO NOTHING`,
    [[...f.declared, ...f.retired], f.retiredChannels],
  );
  freshAt = performance.now();
}

/**
 * That the polls measured answered what the fixture says: every channel current on a sensor that
 * declares them all, and on the others the two keys the edit took out retired and the rest
 * current. Not vacuous: a fixture whose readings had aged out of the window would time a cheaper
 * answer, all gaps.
 */
async function checkAnswers(f: Fixture, when: string): Promise<void> {
  for (const id of f.declared) {
    const { channels } = await answer(f.open, id);
    assert.equal(channels.length, WIDE, `${when}: sensor ${String(id)} answers every channel`);
    assert.deepEqual(
      channels.filter((one) => one.value === null || one.retired).map((one) => one.key),
      [],
      `${when}: sensor ${String(id)} declares every key, so every channel is current and live`,
    );
  }
  for (const id of f.retired) {
    const { channels } = await answer(f.open, id);
    assert.equal(channels.length, WIDE, `${when}: sensor ${String(id)} answers every channel`);
    assert.deepEqual(
      channels
        .filter((one) => one.retired)
        .map((one) => one.key)
        .sort((a, b) => a.localeCompare(b)),
      [...RETIRED_KEYS],
      `${when}: sensor ${String(id)} has the keys the edit took out retired`,
    );
    assert.deepEqual(
      channels.filter((one) => !one.retired && one.value === null).map((one) => one.key),
      [],
      `${when}: sensor ${String(id)} has the rest current`,
    );
  }
}

describe(
  `polling /values at ${SENSORS.toLocaleString('en')} sensors (P-374)`,
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase | undefined;
    let fixture: Fixture | undefined;

    before(async () => {
      scratch = await createScratchDatabase('valuespoll');
      const db = scratch.db;
      const harness = await buildHarness(db, { types: [columns] });
      const history = new HistoryService({ db, logger: silent });

      // ── the tree, a level per statement ──────────────────────────────────────────────────
      const [probe] = await db.query<{ id: string }>(
        `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'perf-probe')
         RETURNING id`,
        [harness.rootId],
      );
      assert.ok(probe !== undefined);
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT $1::bigint, 'group', 'group-' || g FROM generate_series(1, $2::int) g`,
        [probe.id, GROUPS],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'device', o.name || '-device-' || d
         FROM object o, generate_series(1, $1::int) d
         WHERE o.kind = 'group'`,
        [DEVICES_PER_GROUP],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'sensor', o.name || '-sensor-' || s
         FROM object o, generate_series(1, $1::int) s
         WHERE o.kind = 'device'
         ORDER BY o.id, s`,
        [SENSORS_PER_DEVICE],
      );
      const sensors = (
        await db.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'sensor' ORDER BY id`)
      ).map((row) => Number(row.id));
      assert.equal(sensors.length, SENSORS);

      // The polled sensors spread over the tree, every 125th, and the two shapes alternating.
      const polled = sensors.filter((_, index) => index % (SENSORS / POLLED) === 0);
      const declared = polled.filter((_, index) => index % 2 === 0);
      const retired = polled.filter((_, index) => index % 2 === 1);
      assert.equal(declared.length, DASHBOARD);
      assert.equal(retired.length, DASHBOARD);

      // ── the sensors' parameters and channels ─────────────────────────────────────────────
      // Every sensor's parameters last changed at the edit. Only the retired shape's check
      // reads it; the declared shape's keys all answer `c.key = ANY(...)` first. Inserted rather
      // than updated: `sensor_config_params_changed` (`P-340`) moves the column only on an
      // update, and stamps it with the time of that update.
      const [edit] = await db.query<{ at: Date }>(
        'SELECT now() - make_interval(days => $1::int) AS at',
        [EDITED_DAYS_AGO],
      );
      assert.ok(edit !== undefined);
      await db.query(
        `INSERT INTO sensor_config (object_id, type, params, params_changed_at)
         SELECT o.id, $1::text,
                jsonb_build_object('columns', (
                  SELECT jsonb_agg(jsonb_build_object('key', 'c' || k) ORDER BY k)
                  FROM generate_series(1, CASE WHEN o.id = ANY($2::bigint[]) THEN $4::int
                                               WHEN o.id = ANY($3::bigint[]) THEN $5::int
                                               ELSE $6::int END) k
                )),
                $7::timestamptz
         FROM object o
         WHERE o.kind = 'sensor'`,
        [TYPE_ID, declared, retired, WIDE, LIVE, NARROW, edit.at],
      );
      // A retired sensor keeps the rows of the keys its edit took out (`P-303`), so it has as
      // many channels as a declared one.
      await db.query(
        `INSERT INTO channel (sensor_id, key, name, is_primary)
         SELECT o.id, 'c' || k, 'Column c' || k, k = 1
         FROM object o,
              generate_series(1, CASE WHEN o.id = ANY($1::bigint[]) THEN $2::int
                                      ELSE $3::int END) k
         WHERE o.kind = 'sensor'`,
        [polled, WIDE, NARROW],
      );
      const [counted] = await db.query<{ channels: number }>(
        'SELECT count(*)::int AS channels FROM channel',
      );
      assert.equal(counted?.channels, CHANNELS);
      const retiredChannels = (
        await db.query<{ id: number }>(
          `SELECT c.id FROM channel c
           WHERE c.sensor_id = ANY($1::bigint[]) AND c.key = ANY($2::text[])`,
          [retired, RETIRED_KEYS],
        )
      ).map((row) => row.id);
      assert.equal(retiredChannels.length, DASHBOARD * RETIRED_KEYS.length);

      // ── the readings ─────────────────────────────────────────────────────────────────────
      // One a channel a day across the retention, so the hypertable has its full count of
      // chunks and every channel a segment in each; none after the edit for what it retired.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT r.at, r.id, r.value
         FROM (
           SELECT now() - n * interval '1 day' - (c.id % 3600) * interval '1 second' AS at,
                  c.id, 50 + c.id % 40 AS value
           FROM channel c, generate_series(1, $1::int) n
         ) r
         WHERE r.id <> ALL($2::int[]) OR r.at < $3::timestamptz
         ON CONFLICT DO NOTHING`,
        [RAW_DAYS, retiredChannels, edit.at],
      );
      // The retired channels every minute for three days before the edit: what the check would
      // have to read past if it looked before the edit.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT $1::timestamptz - m * interval '1 minute', c.id, 50 + (c.id + m) % 40
         FROM unnest($2::int[]) AS c(id), generate_series(1, $3::int) m
         ON CONFLICT DO NOTHING`,
        [edit.at, retiredChannels, BEFORE_EDIT_MINUTES],
      );
      // Every live channel every minute for the last half hour: the window `/values` reads.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT now() - m * interval '1 minute' - (c.id % 60) * interval '1 second',
                c.id, 50 + (c.id + m) % 40
         FROM channel c, generate_series(0, $1::int - 1) m
         WHERE c.id <> ALL($2::int[])
         ON CONFLICT DO NOTHING`,
        [RECENT_MINUTES, retiredChannels],
      );
      const [readings] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sample');
      // Compressed past the shipped age, as the housekeeping pass leaves raw chunks.
      const compressed = await db.query<{ chunk: string }>(
        `SELECT compress_chunk(c)::text AS chunk
         FROM show_chunks('sample', older_than => now() - make_interval(days => $1::int)) c`,
        [COMPRESS_AFTER_DAYS],
      );
      const [chunks] = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM show_chunks('sample') c`,
      );
      assert.ok((chunks?.n ?? 0) >= RAW_DAYS, 'a chunk for every day of the retention');
      assert.ok(
        compressed.length >= RAW_DAYS - COMPRESS_AFTER_DAYS - 1,
        'every chunk past the compression age compressed',
      );
      // Vacuumed as well as analysed: autovacuum would otherwise find a million fresh rows and
      // set to work in the middle of the timing, and a vacuumed table is the steady state.
      await db.query('VACUUM (ANALYZE)');

      // ── the callers ──────────────────────────────────────────────────────────────────────
      const audit = new DatabaseAuditSink();
      const accounts = new AccountService({ audit, db, logger: silent });
      const groups = new GroupService({ audit, db, logger: silent });
      const access = new AccessService({ db, audit, logger: silent });
      const sessions = new SessionService({ db, logger: silent });
      const viewer = await accounts.create(
        { login: 'viewer', password: 'correct-horse-battery', role: 'readonly' },
        testActor,
      );
      const team = await groups.create({ name: 'Viewers' }, testActor);
      await groups.addMember(team.id, viewer.id, testActor);
      await access.grant(harness.rootId, team.id, 'read', testActor);
      const cookies: string[] = [];
      for (let slot = 0; slot < DASHBOARD; slot += 1) {
        const { token } = await sessions.start(viewer, {
          remoteAddress: '192.0.2.10',
          userAgent: 'values-poll-performance',
        });
        cookies.push(`${SESSION_COOKIE}=${encodeURIComponent(token)}`);
      }

      const listener = {
        host: '127.0.0.1',
        port: 0,
        webRoot: '',
        allowedOrigins: [],
        requireAuthentication: true,
      };
      const openServer = new ApiServer({
        config: listener,
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history,
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue([columns]),
      });
      await openServer.build('9.9.9', harness.service);
      const guardedServer = new ApiServer({
        config: { ...listener, rateLimitPerMinute: RAISED_LIMIT },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history,
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue([columns]),
        auth: {
          accounts,
          sessions,
          throttle: new LoginThrottle({ db, logger: silent }),
          groups,
          access,
          tokens: new TokenService({ audit, db, logger: silent }),
          totp: new TotpService({ audit, db, logger: silent }),
          required: true,
        },
      });
      await guardedServer.build('9.9.9', harness.service);

      const stored = new Map<number, StoredSensor>();
      for (const id of polled) {
        const object = await harness.repository.get(db, id);
        if (object === null || object.kind !== 'sensor') {
          throw new Error(`object ${String(id)} does not read as a sensor`);
        }
        stored.set(id, { sensorType: object.sensorType, params: object.params });
      }

      fixture = {
        db,
        harness,
        history,
        open: openServer.app,
        signedIn: guardedServer.app,
        cookies,
        declared,
        retired,
        retiredChannels,
        stored,
        readings: readings?.n ?? 0,
        chunks: chunks?.n ?? 0,
        compressed: compressed.length,
      };
    });

    after(async () => {
      await fixture?.open.close();
      await fixture?.signedIn.close();
      await scratch?.drop();
    });

    it('answers a poll well inside an operator’s budget, and says what U-38’s two reads cost', async () => {
      const f = fixture;
      assert.ok(f !== undefined, 'the fixture was built');
      const { db, harness, history } = f;
      // The gate the service was built with is the harness's own; this is the same derivation
      // over the same catalogue, for timing the channel read on its own.
      const gate = catalogueSensorTypeGate(testCatalogue([columns]));
      const signedIn = { cookie: f.cookies[0] ?? '' };

      // Each part through the function the route reaches it by: `history.latestForSensor` for
      // the values, `ObjectService.channels` for `U-38`'s two reads together, and the
      // repository's `get` and `channelsWithRetirement` for each of them alone.
      const run: Readonly<Record<Part, (id: number) => Promise<unknown>>> = {
        'route, no auth': (id) => poll(f.open, id, {}),
        'route, signed in': (id) => poll(f.signedIn, id, signedIn),
        latestForSensor: (id) => history.latestForSensor(id),
        'channels()': (id) => harness.service.channels(id),
        'object read': (id) => harness.repository.get(db, id),
        'channel read': (id) => {
          const stored = f.stored.get(id);
          assert.ok(stored !== undefined);
          return harness.repository.channelsWithRetirement(
            db,
            id,
            gate.reportableKeys(stored.sensorType, stored.params),
          );
        },
        'slim read': (id) => db.query(SLIM_READ, [id]),
        'round trip': () => db.query('SELECT 1'),
      };
      const sensorsOf = (shape: Shape): readonly number[] =>
        shape === 'declared' ? f.declared : f.retired;

      await fresh(f);
      await checkAnswers(f, 'before');

      // **Interleaved**: every part once for a sensor, then the next sensor, so drift over the
      // run — a warming cache, a checkpoint, a neighbour — lands on every part alike rather than
      // on whichever ran last. After the warm-up every row read is in shared buffers, so the
      // order inside an iteration only decides which part meets a stall.
      const timings = new Map<string, number[]>();
      for (let round = -WARMUP_ROUNDS; round < ROUNDS; round += 1) {
        await fresh(f);
        for (const shape of SHAPES) {
          for (const id of sensorsOf(shape)) {
            for (const part of PARTS) {
              const started = process.hrtime.bigint();
              await run[part](id);
              const ms = Number(process.hrtime.bigint() - started) / 1e6;
              if (round < 0) continue;
              const key = `${shape}|${part}`;
              const list = timings.get(key) ?? [];
              list.push(ms);
              timings.set(key, list);
            }
          }
        }
      }
      // No reading added first: the last one the loop added is what the polls above were read
      // against, so this says they all answered with values.
      await checkAnswers(f, 'after');

      const sensor = f.declared[0];
      assert.ok(sensor !== undefined);
      const counts = {
        open: await recorded(db, () => poll(f.open, sensor, {})),
        signedIn: await recorded(db, () => poll(f.signedIn, sensor, signedIn)),
        channels: await recorded(db, () => harness.service.channels(sensor)),
      };
      assert.ok(counts.channels.statements > 0, 'the recorder saw channels() read');
      assert.ok(
        counts.open.statements > counts.channels.statements,
        'and saw the poll read its values besides',
      );

      const of = (shape: Shape, part: Part): Spread =>
        spread(timings.get(`${shape}|${part}`) ?? []);
      const pct = (fraction: number): string => `${(fraction * 100).toFixed(0)}%`.padStart(4);
      const row = (label: string, s: Spread, note = ''): string =>
        `        ${label.padEnd(18)} median ${s.median.toFixed(2).padStart(6)} ms` +
        `  p95 ${s.p95.toFixed(2).padStart(6)} ms  max ${s.max.toFixed(1).padStart(6)} ms` +
        (note === '' ? '' : `  ${note}`);

      const lines: string[] = [];
      for (const shape of SHAPES) {
        const open = of(shape, 'route, no auth');
        const signed = of(shape, 'route, signed in');
        const share = (s: Spread): string =>
          `${pct(s.median / open.median)} / ${pct(s.median / signed.median)}`;
        const objectRead = of(shape, 'object read');
        const slimRead = of(shape, 'slim read');
        lines.push(
          `      ${SHAPE_LABEL[shape]}; share of a poll's median, no auth / signed in:`,
          row('route, no auth', open),
          row(
            'route, signed in',
            signed,
            `+${(signed.median - open.median).toFixed(2)} ms for the session and the right`,
          ),
          row(
            'latestForSensor',
            of(shape, 'latestForSensor'),
            `${share(of(shape, 'latestForSensor'))}  the values, as before U-38`,
          ),
          row(
            'channels()',
            of(shape, 'channels()'),
            `${share(of(shape, 'channels()'))}  U-38's two reads, as the route makes them`,
          ),
          row('  object read', objectRead, share(objectRead)),
          row('  channel read', of(shape, 'channel read'), share(of(shape, 'channel read'))),
          row(
            '  slim read',
            slimRead,
            `${share(slimRead)}  in place of the object read, saves ` +
              `${(objectRead.median - slimRead.median).toFixed(2)} ms a poll`,
          ),
          row('round trip', of(shape, 'round trip'), `${share(of(shape, 'round trip'))}  SELECT 1`),
        );
      }

      process.stdout.write(
        `\n    measured (P-374), GET /sensors/:id/values through the app at ` +
          `${SENSORS.toLocaleString('en')} sensors and ` +
          `${CHANNELS.toLocaleString('en')} channels,\n` +
          `    ${String(f.chunks)} raw day chunks (${String(f.compressed)} compressed) holding ` +
          `${f.readings.toLocaleString('en')} readings; ` +
          `${String(ROUNDS * DASHBOARD)} timed calls ` +
          `of each part for each shape, over its ${String(DASHBOARD)} sensors:\n` +
          `${lines.join('\n')}\n` +
          `      a poll sends ${String(counts.open.statements)} statements in ` +
          `${String(counts.open.transactions)} transactions with no auth and ` +
          `${String(counts.signedIn.statements)} in ${String(counts.signedIn.transactions)} ` +
          `signed in (each transaction a BEGIN and\n` +
          `      a COMMIT more); channels() is ${String(counts.channels.statements)} of them, ` +
          `in ${String(counts.channels.transactions)}. Budget: median under ` +
          `${String(BUDGET_MS.median)} ms, p95 under ${String(BUDGET_MS.p95)} ms.\n`,
      );

      const over: string[] = [];
      for (const shape of SHAPES) {
        for (const part of ['route, no auth', 'route, signed in'] as const) {
          const s = of(shape, part);
          // Written as "not under", so a NaN from an empty list fails as well.
          if (!(s.median < BUDGET_MS.median)) {
            over.push(`${shape} ${part}: median ${s.median.toFixed(1)} ms`);
          }
          if (!(s.p95 < BUDGET_MS.p95)) over.push(`${shape} ${part}: p95 ${s.p95.toFixed(1)} ms`);
        }
      }
      assert.deepEqual(over, [], 'a poll over its budget');
    });

    it('sustains thirty accounts’ pages of twenty sensors, and says how many one core could', async () => {
      const f = fixture;
      assert.ok(f !== undefined, 'the fixture was built');

      // **The whole page at once**, as twenty tables whose timers have lined up, which is the
      // worst moment a page has; many pages open is many of these overlapping. A slot is a
      // session of its own, as twenty browsers' would be. The CPU is this process's alone: the
      // route's own work and the client side of every statement, not PostgreSQL's.
      const callers: readonly {
        label: string;
        app: FastifyInstance;
        headers: (slot: number) => Record<string, string>;
      }[] = [
        { label: 'no auth', app: f.open, headers: () => ({}) },
        {
          label: 'signed in',
          app: f.signedIn,
          headers: (slot) => ({ cookie: f.cookies[slot] ?? '' }),
        },
      ];

      const results: { label: string; perSecond: number; cpuMs: number }[] = [];
      for (const { label, app, headers } of callers) {
        const page = (): Promise<unknown[]> =>
          Promise.all(f.declared.map((id, slot) => poll(app, id, headers(slot))));
        await fresh(f);
        for (let round = 0; round < WARMUP_ROUNDS; round += 1) await page();

        const cpu = process.cpuUsage();
        const started = process.hrtime.bigint();
        for (let round = 0; round < THROUGHPUT_ROUNDS; round += 1) await page();
        const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
        const used = process.cpuUsage(cpu);
        const polls = THROUGHPUT_ROUNDS * f.declared.length;
        results.push({
          label,
          perSecond: (polls / wallMs) * 1_000,
          cpuMs: (used.user + used.system) / 1_000 / polls,
        });
      }

      const pagePolls = DASHBOARD / POLL_SECONDS;
      process.stdout.write(
        `\n    measured (P-374), the ${String(DASHBOARD)} declared sensors polled at once, ` +
          `${String(THROUGHPUT_ROUNDS)} rounds, a pool of ` +
          `${String(testDatabaseConfig().poolSize)} ` +
          `connections (the shipped default is ${String(SHIPPED.database.poolSize)}):\n` +
          results
            .map((one) => {
              const ceiling = 1_000 / one.cpuMs;
              return (
                `      ${one.label.padEnd(10)} ` +
                `${Math.round(one.perSecond).toLocaleString('en').padStart(6)} polls/s` +
                `   CPU ${one.cpuMs.toFixed(2)} ms a poll -> one core ` +
                `${Math.round(ceiling).toLocaleString('en')} polls/s, ` +
                `${Math.round(ceiling / pagePolls).toLocaleString('en')} pages of ` +
                `${String(DASHBOARD)} at ${String(POLL_SECONDS)} s`
              );
            })
            .join('\n') +
          `\n      the floor is ${String(FLOOR_POLLS_PER_SECOND)} polls/s signed in: ` +
          `${String(ACCOUNTS)} accounts, each with a page of ${String(DASHBOARD)} open.\n` +
          `      inject skips the socket, HTTP parsing and TLS, so a core serving browsers ` +
          `spends more a poll than this.\n`,
      );

      const signed = results.find((one) => one.label === 'signed in');
      assert.ok(signed !== undefined);
      assert.ok(
        signed.perSecond >= FLOOR_POLLS_PER_SECOND,
        `signed in, sustained ${signed.perSecond.toFixed(0)} polls/s against a floor of ` +
          String(FLOOR_POLLS_PER_SECOND),
      );
    });
  },
);
