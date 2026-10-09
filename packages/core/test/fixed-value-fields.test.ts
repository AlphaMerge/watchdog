import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Ajv } from 'ajv';
import Fastify, { type FastifyInstance } from 'fastify';
import { DEVICE_KINDS, DISCOVERY_LEVEL_IDS, DISCOVERY_LEVELS } from '@ms/shared';
import { alarmRoutes, ALARM_SCHEMAS } from '../src/api/routes/alarms.js';
import { discoveryRoutes } from '../src/api/routes/discovery.js';
import {
  NOTIFICATION_SCHEMAS,
  NOTIFICATION_STATUSES,
  notificationRoutes,
} from '../src/api/routes/notifications.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { Migrator } from '../src/db/migrator.js';
import type { DeliveryHealthReader } from '../src/notifications/health.js';
import type { NotificationLogEntry, NotificationLogReader } from '../src/notifications/log.js';
import {
  DISCOVERY_RUN_STATUSES,
  type DiscoveryRunRow,
  type DiscoveryService,
} from '../src/discovery/service.js';
import { describeRun, SUMMARY_KINDS, type KindCount } from '../src/discovery/summary.js';
import { NOTIFICATION_REASONS } from '../src/notifications/chain.js';
import { REQUEST_DISPOSITIONS } from '../src/notifications/summarisation.js';
import type { Alarm, AlarmPage, AlarmService } from '../src/state/alarms.js';
import { SENSOR_STATE_CAUSES, SENSOR_STATES } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

/**
 * Fields with a fixed set of values say which values (`P-335`, `P-342`).
 *
 * `ms:alarm.state`, `ms:notificationRequest.status` and `status` in `GET /discovery/{id}/summary`
 * were plain strings, so the OpenAPI document and the reference told a client nothing about what
 * it would be sent. They are enums now, and an enum is the `P-313` trap: `fast-json-stringify`
 * does not check one, so a value the code writes and the enum lacks is served anyway and nothing
 * fails. So every value is served through the route as Fastify registered it, and the answer is
 * validated with Ajv against the route's own 200 schema, read off the route by `onRoute`.
 *
 * The lists themselves are checked against what the database lets the code write: the statuses,
 * reasons, dispositions and levels against their CHECK constraints below, the sensor states and
 * causes against the `sensor_state_kind` and `sensor_state_cause` enums in `state-tables.test.ts`.
 *
 * `P-342` added `ms:alarm.cause`, the discovery summary's `level` and `found.byKind[].kind`, and
 * `ms:notificationRequest`'s `reason`, `state` and `disposition`. Its `triggerKind` stays a string
 * on purpose, and a test below says why.
 */

interface Served {
  readonly body: Record<string, unknown>;
  /** Null when the body is valid against the route's 200 schema, else Ajv's errors. */
  readonly invalid: (body: unknown) => string | null;
}

async function serve(
  route: string,
  url: string,
  register: (app: FastifyInstance) => void | Promise<void>,
): Promise<Served> {
  let declared: unknown;
  const app = Fastify();
  app.addHook('onRoute', (one) => {
    if (one.url === route && one.method === 'GET') declared = one.schema?.response;
  });
  try {
    await register(app);
    await app.ready();
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, response.body);

    const schema = (declared as Record<string, object> | undefined)?.['200'];
    assert.ok(schema !== undefined, `${route} declares its 200`);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const shared of Object.values(app.getSchemas())) ajv.addSchema(shared as object);
    const validate = ajv.compile(schema);
    return {
      body: response.json<Record<string, unknown>>(),
      invalid: (body) => (validate(body) ? null : JSON.stringify(validate.errors)),
    };
  } finally {
    await app.close();
  }
}

/** Every item's `field`, in order. */
const valuesOf = (body: Record<string, unknown>, field: string): unknown[] =>
  (body['items'] as Record<string, unknown>[]).map((item) => item[field]);

describe('ms:alarm.state', () => {
  const alarm = (state: Alarm['state'], sensorId: number): Alarm => ({
    sensorId,
    sensorName: `sensor ${String(sensorId)}`,
    state,
    cause: 'scan',
    message: '',
    since: '2026-10-09T08:00:00.000Z',
    priority: 3,
    path: [1, sensorId],
    pathNames: ['Root', `sensor ${String(sensorId)}`],
    acknowledged: false,
    acknowledgedUntil: null,
    consecutiveFailures: 0,
    recovering: null,
  });
  const page: AlarmPage = {
    items: SENSOR_STATES.map((state, index) => alarm(state, 100 + index)),
    total: SENSOR_STATES.length,
    counts: {},
    now: '2026-10-09T09:00:00.000Z',
  };
  const alarms = { list: () => Promise.resolve(page) } as unknown as AlarmService;
  const register = (app: FastifyInstance): void => {
    for (const schema of ALARM_SCHEMAS) app.addSchema(schema);
    alarmRoutes(app, { alarms });
  };

  it('serves every sensor state, and the route’s own schema allows each', async () => {
    const served = await serve('/alarms', '/alarms', register);
    assert.deepEqual(valuesOf(served.body, 'state'), [...SENSOR_STATES]);
    assert.equal(served.invalid(served.body), null);
  });

  it('is an enum: `recovering`, a filter value and never a state, is refused', async () => {
    const served = await serve('/alarms', '/alarms', register);
    const items = served.body['items'] as Record<string, unknown>[];
    const forged = { ...served.body, items: [{ ...items[0], state: 'recovering' }] };
    assert.notEqual(served.invalid(forged), null, 'a plain string would allow it');
  });
});

describe('ms:alarm.cause', () => {
  const alarm = (cause: Alarm['cause'], sensorId: number): Alarm => ({
    sensorId,
    sensorName: `sensor ${String(sensorId)}`,
    state: 'down',
    cause,
    message: '',
    since: '2026-10-09T08:00:00.000Z',
    priority: 3,
    path: [1, sensorId],
    pathNames: ['Root', `sensor ${String(sensorId)}`],
    acknowledged: false,
    acknowledgedUntil: null,
    consecutiveFailures: 0,
    recovering: null,
  });
  const register = (app: FastifyInstance): void => {
    const items = SENSOR_STATE_CAUSES.map((cause, index) => alarm(cause, 200 + index));
    const page: AlarmPage = { items, total: items.length, counts: {}, now: '2026-10-09T09:00Z' };
    const alarms = { list: () => Promise.resolve(page) } as unknown as AlarmService;
    for (const schema of ALARM_SCHEMAS) app.addSchema(schema);
    alarmRoutes(app, { alarms });
  };

  it('serves every cause, and the route’s own schema allows each', async () => {
    const served = await serve('/alarms', '/alarms', register);
    assert.deepEqual(valuesOf(served.body, 'cause'), [...SENSOR_STATE_CAUSES]);
    assert.equal(served.invalid(served.body), null);
  });

  it('is an enum: a cause `sensor_state_cause` cannot hold is refused', async () => {
    const served = await serve('/alarms', '/alarms', register);
    const items = served.body['items'] as Record<string, unknown>[];
    const forged = { ...served.body, items: [{ ...items[0], cause: 'flap' }] };
    assert.notEqual(served.invalid(forged), null, 'a plain string would allow it');
  });
});

describe('ms:notificationRequest', () => {
  const entry = (id: number, over: Partial<NotificationLogEntry> = {}): NotificationLogEntry => ({
    id,
    at: new Date('2026-10-09T08:00:00.000Z'),
    sensorId: 7,
    sensorName: 'Ping',
    templateId: 1,
    templateName: 'Email the team',
    method: 'email',
    triggerKind: 'state',
    reason: 'initial',
    state: 'down',
    message: 'Ping is down',
    status: 'pending',
    disposition: 'immediate',
    attempts: 1,
    deliveredAt: null,
    nextAttemptAt: null,
    lastError: null,
    skippedRecipients: '',
    ...over,
  });
  const register =
    (entries: readonly NotificationLogEntry[]) =>
    async (app: FastifyInstance): Promise<void> => {
      const log = { list: () => Promise.resolve(entries) } as unknown as NotificationLogReader;
      for (const schema of NOTIFICATION_SCHEMAS) app.addSchema(schema);
      await app.register(notificationRoutes, {
        db: {} as Database,
        health: {} as DeliveryHealthReader,
        log,
      });
    };
  const served = (entries: readonly NotificationLogEntry[]): Promise<Served> =>
    serve('/notification-requests', '/notification-requests', register(entries));

  /** One entry per value of `field`, served, with each value back as sent and the answer valid. */
  const everyValue = <K extends keyof NotificationLogEntry>(
    field: K,
    values: readonly NotificationLogEntry[K][],
  ): void => {
    it(`serves every ${field}, and the route’s own schema allows each`, async () => {
      const answer = await served(
        values.map((value, index) => entry(50 - index, { [field]: value })),
      );
      assert.deepEqual(valuesOf(answer.body, field), [...values]);
      assert.equal(answer.invalid(answer.body), null);
    });
  };

  /** A value outside the list, which a plain string would let through. */
  const refuses = (field: string, value: unknown, why: string): void => {
    it(`is an enum: ${why}`, async () => {
      const answer = await served([entry(50)]);
      const items = answer.body['items'] as Record<string, unknown>[];
      const forged = { ...answer.body, items: [{ ...items[0], [field]: value }] };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  };

  describe('status', () => {
    everyValue('status', NOTIFICATION_STATUSES);
    refuses('status', 'retrying', 'a status the table cannot hold is refused');
  });

  describe('reason', () => {
    everyValue('reason', NOTIFICATION_REASONS);
    refuses('reason', 'snooze', 'a reason the table cannot hold is refused');
  });

  describe('state', () => {
    everyValue('state', SENSOR_STATES);
    refuses('state', 'recovering', 'a state `sensor_state_kind` cannot hold is refused');
    refuses('state', null, 'null is refused, because the column is NOT NULL');
  });

  describe('disposition', () => {
    everyValue('disposition', REQUEST_DISPOSITIONS);
    refuses('disposition', 'digest', 'a disposition the table cannot hold is refused');
  });

  /**
   * Not an enum, deliberately. The code writes `state` and `threshold`, but the column has no
   * CHECK and a trigger kind is a registry entry: a row queued by a newer build is listed after a
   * downgrade (`P-139`), and an enum that row broke would be served regardless (`P-313`).
   */
  describe('triggerKind', () => {
    it('allows a kind this version does not know, as the table does', async () => {
      const answer = await served([entry(50, { triggerKind: 'forecast' })]);
      assert.deepEqual(valuesOf(answer.body, 'triggerKind'), ['forecast']);
      assert.equal(answer.invalid(answer.body), null);
    });
  });
});

/** A finished run, which every discovery summary test below serves with one field changed. */
const RUN: DiscoveryRunRow = {
  id: 7,
  groupId: 95,
  probeId: 2,
  range: '10.0.0.0/24',
  total: 254,
  cursor: 254,
  found: 18,
  failed: 0,
  status: 'done',
  level: 'standard',
  templates: [],
  identified: 18,
  identifyCursor: 18,
  scheduleId: null,
  createdBy: null,
  snmpCommunity: '',
  devicesCreated: 11,
  devicesMatched: 7,
  sensorsCreated: 20,
  provisionedAt: '2026-08-27T16:29:00.000Z',
  message: '',
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  createdAt: '2026-08-27T16:20:00.000Z',
  startedAt: '2026-08-27T16:20:01.000Z',
  finishedAt: '2026-08-27T16:28:01.000Z',
};
/** Registers the discovery routes over a service that answers `RUN`, changed, with these kinds. */
const withRun =
  (
    status: DiscoveryRunRow['status'],
    over: Partial<DiscoveryRunRow> = {},
    kinds: KindCount[] = [],
  ) =>
  (app: FastifyInstance): void => {
    const run = { ...RUN, ...over, status };
    const discovery = {
      get: () => Promise.resolve(run),
      summary: () => Promise.resolve(describeRun(run, kinds, [], [])),
    } as unknown as DiscoveryService;
    discoveryRoutes(app, { db: {} as Queryable, discovery });
  };

describe('status in GET /discovery/{id}/summary', () => {
  for (const status of DISCOVERY_RUN_STATUSES) {
    it(`serves ${status}, and the route’s own schema allows it`, async () => {
      const served = await serve('/discovery/:id/summary', '/discovery/7/summary', withRun(status));
      assert.equal(served.body['status'], status);
      assert.equal(served.invalid(served.body), null);
    });
  }

  it('is an enum: a status the table cannot hold is refused', async () => {
    const served = await serve('/discovery/:id/summary', '/discovery/7/summary', withRun('done'));
    assert.notEqual(
      served.invalid({ ...served.body, status: 'provisioning' }),
      null,
      'a plain string would allow it',
    );
  });
});

describe('level in GET /discovery/{id}/summary', () => {
  it('is the level table’s ids, in its order', () => {
    assert.deepEqual(
      DISCOVERY_LEVELS.map((one) => one.id),
      [...DISCOVERY_LEVEL_IDS],
    );
  });

  for (const level of DISCOVERY_LEVEL_IDS) {
    it(`serves ${level}, and the route’s own schema allows it`, async () => {
      const served = await serve(
        '/discovery/:id/summary',
        '/discovery/7/summary',
        withRun('done', { level }),
      );
      assert.equal(served.body['level'], level);
      assert.equal(served.invalid(served.body), null);
    });
  }

  it('is an enum: `identify`, the level migration 028 retired, is refused', async () => {
    const served = await serve('/discovery/:id/summary', '/discovery/7/summary', withRun('done'));
    assert.notEqual(
      served.invalid({ ...served.body, level: 'identify' }),
      null,
      'a plain string would allow it',
    );
  });
});

describe('found.byKind[].kind in GET /discovery/{id}/summary', () => {
  /**
   * What the database can hand over: every classifier kind, a host never identified (a null
   * kind), and one the classifier of this version does not know, which `kindOf` folds into
   * `unidentified` rather than serving as it is.
   */
  const kinds: KindCount[] = [
    ...DEVICE_KINDS.map((kind, index) => ({ kind, count: 20 - index })),
    { kind: null, count: 3 },
    { kind: 'toaster', count: 1 },
  ];

  it('serves every kind, and the route’s own schema allows each', async () => {
    const served = await serve(
      '/discovery/:id/summary',
      '/discovery/7/summary',
      withRun('done', {}, kinds),
    );
    const found = served.body['found'] as { byKind: { kind: string }[] };
    assert.deepEqual(
      found.byKind.map((one) => one.kind),
      [...DEVICE_KINDS, 'unidentified', 'unidentified'],
    );
    assert.deepEqual(
      [...new Set(found.byKind.map((one) => one.kind))].sort(),
      [...SUMMARY_KINDS].sort(),
    );
    assert.equal(served.invalid(served.body), null);
  });

  it('is an enum: a kind the classifier does not name is refused', async () => {
    const served = await serve('/discovery/:id/summary', '/discovery/7/summary', withRun('done'));
    const forged = {
      ...served.body,
      found: { byKind: [{ kind: 'toaster', count: 1 }], byVendor: [] },
    };
    assert.notEqual(served.invalid(forged), null, 'a plain string would allow it');
  });
});

const available = await databaseAvailable();

/**
 * The lists are what the database lets the code write. A status a writer can store and the enum
 * lacks is the `P-313` failure; one the enum names and the table refuses is a promise the API
 * cannot keep. Read from the constraints themselves, after every migration.
 */
describe(
  'the database agrees',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('fixedvalues');
      await new Migrator({ db: scratch.db, logger: silentLogger, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    /** The quoted values in a CHECK constraint's `column IN (…)`, as Postgres prints it back. */
    async function allowed(constraint: string): Promise<string[]> {
      const rows = await scratch.db.query<{ definition: string }>(
        'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1',
        [constraint],
      );
      assert.equal(rows.length, 1, `${constraint} exists`);
      return [...(rows[0]?.definition ?? '').matchAll(/'([^']+)'::/gu)].map(
        ([, value]) => value ?? '',
      );
    }

    it('allows exactly the notification statuses the schema names', async () => {
      assert.deepEqual(
        (await allowed('notification_request_status_check')).sort(),
        [...NOTIFICATION_STATUSES].sort(),
      );
    });

    it('allows exactly the discovery run statuses the schema names', async () => {
      assert.deepEqual(
        (await allowed('discovery_run_status_check')).sort(),
        [...DISCOVERY_RUN_STATUSES].sort(),
      );
    });

    it('allows exactly the notification reasons the schema names', async () => {
      assert.deepEqual(
        (await allowed('notification_request_reason_check')).sort(),
        [...NOTIFICATION_REASONS].sort(),
      );
    });

    it('allows exactly the notification dispositions the schema names', async () => {
      assert.deepEqual(
        (await allowed('notification_request_disposition_check')).sort(),
        [...REQUEST_DISPOSITIONS].sort(),
      );
    });

    it('allows exactly the discovery levels the schemas name, on runs and on schedules', async () => {
      for (const constraint of ['discovery_run_level_check', 'discovery_schedule_level_check']) {
        assert.deepEqual(
          (await allowed(constraint)).sort(),
          [...DISCOVERY_LEVEL_IDS].sort(),
          constraint,
        );
      }
    });

    it('holds a notification’s state as a sensor state, never null', async () => {
      const rows = await scratch.db.query<{ is_nullable: string; udt_name: string }>(
        `SELECT is_nullable, udt_name FROM information_schema.columns
         WHERE table_name = 'notification_request' AND column_name = 'state'`,
      );
      assert.deepEqual(rows, [{ is_nullable: 'NO', udt_name: 'sensor_state_kind' }]);
    });
  },
);
