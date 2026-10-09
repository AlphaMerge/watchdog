import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Ajv } from 'ajv';
import Fastify, { type FastifyInstance } from 'fastify';
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
import { describeRun } from '../src/discovery/summary.js';
import type { Alarm, AlarmPage, AlarmService } from '../src/state/alarms.js';
import { SENSOR_STATES } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

/**
 * State fields with a fixed set of values say which values (`P-335`).
 *
 * `ms:alarm.state`, `ms:notificationRequest.status` and `status` in `GET /discovery/{id}/summary`
 * were plain strings, so the OpenAPI document and the reference told a client nothing about what
 * it would be sent. They are enums now, and an enum is the `P-313` trap: `fast-json-stringify`
 * does not check one, so a value the code writes and the enum lacks is served anyway and nothing
 * fails. So every value is served through the route as Fastify registered it, and the answer is
 * validated with Ajv against the route's own 200 schema, read off the route by `onRoute`.
 *
 * The lists themselves are checked against what the database lets the code write: the two
 * statuses against their CHECK constraints below, the sensor states against the
 * `sensor_state_kind` enum in `state-tables.test.ts`.
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

describe('ms:notificationRequest.status', () => {
  const entry = (status: string, id: number): NotificationLogEntry => ({
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
    status,
    disposition: 'immediate',
    attempts: 1,
    deliveredAt: null,
    nextAttemptAt: null,
    lastError: null,
    skippedRecipients: '',
  });
  const log = {
    list: () =>
      Promise.resolve(NOTIFICATION_STATUSES.map((status, index) => entry(status, 50 - index))),
  } as unknown as NotificationLogReader;
  const register = async (app: FastifyInstance): Promise<void> => {
    for (const schema of NOTIFICATION_SCHEMAS) app.addSchema(schema);
    await app.register(notificationRoutes, {
      db: {} as Database,
      health: {} as DeliveryHealthReader,
      log,
    });
  };

  it('serves every status, and the route’s own schema allows each', async () => {
    const served = await serve('/notification-requests', '/notification-requests', register);
    assert.deepEqual(valuesOf(served.body, 'status'), [...NOTIFICATION_STATUSES]);
    assert.equal(served.invalid(served.body), null);
  });

  it('is an enum: a status the table cannot hold is refused', async () => {
    const served = await serve('/notification-requests', '/notification-requests', register);
    const items = served.body['items'] as Record<string, unknown>[];
    const forged = { ...served.body, items: [{ ...items[0], status: 'retrying' }] };
    assert.notEqual(served.invalid(forged), null, 'a plain string would allow it');
  });
});

describe('status in GET /discovery/{id}/summary', () => {
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
  const register =
    (status: DiscoveryRunRow['status']) =>
    (app: FastifyInstance): void => {
      const run = { ...RUN, status };
      const discovery = {
        get: () => Promise.resolve(run),
        summary: () => Promise.resolve(describeRun(run, [], [], [])),
      } as unknown as DiscoveryService;
      discoveryRoutes(app, { db: {} as Queryable, discovery });
    };

  for (const status of DISCOVERY_RUN_STATUSES) {
    it(`serves ${status}, and the route’s own schema allows it`, async () => {
      const served = await serve(
        '/discovery/:id/summary',
        '/discovery/7/summary',
        register(status),
      );
      assert.equal(served.body['status'], status);
      assert.equal(served.invalid(served.body), null);
    });
  }

  it('is an enum: a status the table cannot hold is refused', async () => {
    const served = await serve('/discovery/:id/summary', '/discovery/7/summary', register('done'));
    assert.notEqual(
      served.invalid({ ...served.body, status: 'provisioning' }),
      null,
      'a plain string would allow it',
    );
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

    /** The quoted values in a CHECK constraint's `status IN (…)`, as Postgres prints it back. */
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
  },
);
