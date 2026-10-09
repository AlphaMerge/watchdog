import { strict as assert } from 'node:assert';
import { after, before, describe, it, mock } from 'node:test';
import { Ajv } from 'ajv';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEVICE_KINDS,
  DISCOVERY_LEVEL_IDS,
  DISCOVERY_LEVELS,
  describeSkew,
  explainSkew,
  MIN_PROTOCOL_VERSION,
} from '@ms/shared';
import { credentialKindIds } from '@ms/sensors';
import { alarmRoutes, ALARM_SCHEMAS } from '../src/api/routes/alarms.js';
import { auditRoutes } from '../src/api/routes/audit.js';
import { deviceTemplateRoutes } from '../src/api/routes/device-templates.js';
import { discoveryRoutes } from '../src/api/routes/discovery.js';
import { historyRoutes } from '../src/api/routes/history.js';
import { lookupRoutes } from '../src/api/routes/lookups.js';
import { mapRoutes } from '../src/api/routes/maps.js';
import { probeRoutes } from '../src/api/routes/probes.js';
import { LOOKUP_SCHEMAS } from '../src/api/schemas/lookups.js';
import { ACCOUNT_ROLES, type AccountRole } from '../src/auth/accounts.js';
import type { LookupCatalogue } from '../src/lookups/catalogue.js';
import { IMAGE_MEDIA_TYPES, type ImageMediaType } from '../src/maps/images.js';
import type { MapBackground } from '../src/maps/repository.js';
import type { MapService } from '../src/maps/service.js';
import type { ProbeRegistry } from '../src/probes/registry.js';
import type { HistoryService, SensorHistory } from '../src/timeseries/history.js';
import { ROLLUP_TIERS } from '../src/timeseries/tiers.js';
import { objectRoutes } from '../src/api/routes/objects.js';
import { API_VALIDATOR_OPTIONS } from '../src/api/server.js';
import { reportRoutes, type ReportRouteOptions } from '../src/api/routes/reports.js';
import { stateRoutes } from '../src/api/routes/state.js';
import { AUDIT_SCHEMAS, auditActorSchema } from '../src/api/schemas/audit.js';
import { HISTORY_SCHEMAS } from '../src/api/schemas/history.js';
import { SHARED_SCHEMAS } from '../src/api/schemas/objects.js';
import { PAUSE_SCHEMAS } from '../src/api/schemas/pause.js';
import { STATE_SCHEMAS } from '../src/api/schemas/state.js';
import { DatabaseAuditSink, type AuditEntry, type AuditRepository } from '../src/audit/store.js';
import type { DeviceTemplateCatalogue } from '../src/device-templates/catalogue.js';
import { readFingerprint } from '../src/discovery/fingerprint.js';
import { NOTIFICATION_SCHEMAS, notificationRoutes } from '../src/api/routes/notifications.js';
import { TEMPLATE_SCHEMAS, templateRoutes } from '../src/api/routes/templates.js';
import { TRIGGER_SCHEMAS, triggerRoutes } from '../src/api/routes/triggers.js';
import { Visibility } from '../src/auth/access.js';
import { TemplateRepository, type TemplateService } from '../src/notifications/templates.js';
import { triggerKinds } from '../src/triggers/definition.js';
import type { EffectiveTrigger, TriggerRepository } from '../src/triggers/repository.js';
import { TriggerService } from '../src/triggers/service.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { Migrator } from '../src/db/migrator.js';
import type { DeliveryHealthReader } from '../src/notifications/health.js';
import {
  NOTIFICATION_STATUSES,
  type NotificationLogEntry,
  type NotificationLogReader,
} from '../src/notifications/log.js';
import {
  DISCOVERY_RUN_STATUSES,
  type DiscoveryRunRow,
  type DiscoveryService,
} from '../src/discovery/service.js';
import { describeRun, SUMMARY_KINDS, type KindCount } from '../src/discovery/summary.js';
import { NOTIFICATION_REASONS } from '../src/notifications/chain.js';
import { REQUEST_DISPOSITIONS } from '../src/notifications/summarisation.js';
import {
  ACTOR_KINDS,
  type Actor,
  type ActorKind,
  type AuditSink,
  type MapBackgroundAudit,
  type Mutation,
} from '../src/objects/audit.js';
import type { BulkService } from '../src/objects/bulk.js';
import { flattenActor } from '../src/objects/pause-repository.js';
import type { ObjectService } from '../src/objects/service.js';
import {
  OBJECT_KINDS,
  WRITABLE_KINDS,
  type CredentialView,
  type ObjectKind,
  type PauseView,
  type UnboundedCredential,
} from '../src/objects/types.js';
import type { ReportSubject } from '../src/reports/context.js';
import { DEFAULT_OUTPUTS } from '../src/reports/outputs.js';
import type { ReportRow } from '../src/reports/repository.js';
import { CREDENTIAL_SET_KINDS, type CredentialKind } from '../src/settings/inheritance.js';
import type { Alarm, AlarmPage, AlarmService } from '../src/state/alarms.js';
import { SENSOR_STATE_CAUSES, SENSOR_STATES, type SensorState } from '../src/state/tables.js';
import {
  QUERY_ADJUSTMENT_KINDS,
  SERIES_SOURCES,
  sourceFor,
  type SeriesSource,
} from '../src/timeseries/query.js';
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
 *
 * `P-351` added the actor kinds (a pause's, an acknowledgement's), a dependency's `masterState`,
 * the object kinds (audit entries, the unbounded credential list, report subjects, a delete's
 * receipt), the credential kinds (`ms:credentialView`, the unbounded list, a credential delete),
 * a report span's adjustment kinds and the discovery plan's device kinds. The adjustments' and the
 * skew's `reason` are sentences, and stay free text.
 *
 * `P-352` left every served trigger kind open, with a test saying why, and derived the log
 * entry's `status` type from `NOTIFICATION_STATUSES`. `P-361` added a history's and a report
 * span's series source, a history segment's table, a report's `runAs.role` and a map
 * background's `mediaType`; the skew's `missing[]` and the lookups' and device templates'
 * `source` stay open, and a test pins each. `P-370` typed the audit log's record of a background's
 * `mediaType` from the same list, and pins the diff value that serves it open.
 */

/**
 * Asked before any test is declared. node:test starts the suites above a top-level `await` while
 * the module is still waiting on it, and building the object routes' validators a few dozen times
 * held the event loop past the connection's timeout, so the database read as absent.
 */
const available = await databaseAvailable();

/** `true` only when the two types are the same, both ways round. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface Served {
  readonly body: Record<string, unknown>;
  /** Null when the body is valid against the route's 200 schema, else Ajv's errors. */
  readonly invalid: (body: unknown) => string | null;
}

async function serve(
  route: string,
  url: string,
  register: (app: FastifyInstance) => void | Promise<void>,
  method: 'GET' | 'DELETE' | 'POST' = 'GET',
  upload?: { readonly body: Buffer; readonly contentType: string },
): Promise<Served> {
  let declared: unknown;
  // Validated as the server validates (`P-363`), which also keeps this file from printing a
  // strict-mode warning for `tag` and `effective` each time it builds the object routes.
  const app = Fastify({ ajv: { customOptions: { ...API_VALIDATOR_OPTIONS } } });
  app.addHook('onRoute', (one) => {
    if (one.url === route && one.method === method) declared = one.schema?.response;
  });
  try {
    await register(app);
    await app.ready();
    const response = await app.inject(
      upload === undefined
        ? { method, url }
        : { method, url, payload: upload.body, headers: { 'content-type': upload.contentType } },
    );
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

/**
 * A trigger's kind is open wherever it is served, on purpose (`P-352`). A kind is a registry
 * entry, not a schema change: `notification_trigger.kind` has no CHECK, so a trigger saved by a
 * newer build is listed after a downgrade and can be deleted (`P-139`). A CHECK would make every
 * new kind a migration whose `down` deletes the operator's triggers, and an enum would be served
 * the newer kind anyway and say it could not occur (`P-313`).
 */
describe('a trigger’s kind', () => {
  /** A trigger defined on object 7, as the repository's `effectiveFor` reads one. */
  const stored = (
    id: number,
    kind: string,
    settings: Record<string, unknown>,
  ): EffectiveTrigger => ({
    id,
    objectId: 7,
    kind,
    settings,
    enabled: true,
    createdAt: new Date('2026-10-09T08:00:00.000Z'),
    updatedAt: new Date('2026-10-09T08:00:00.000Z'),
    inherited: false,
    depth: 0,
    definedOn: { objectId: 7, name: 'London' },
  });
  /** Valid settings for each kind this build has, each naming template 1. */
  const SETTINGS: Readonly<Record<string, Record<string, unknown>>> = {
    state: { state: 'down', initialTemplateId: 1 },
    threshold: { channelKey: 'loss', condition: 'above', value: 5, triggerTemplateId: 1 },
  };
  const rows = [
    ...triggerKinds.ids.map((kind, index) =>
      stored(10 + index, kind, triggerKinds.validate(kind, SETTINGS[kind] ?? {})),
    ),
    stored(20, 'forecast', { horizonHours: 4, templateId: 1 }),
  ];

  it('has settings here for every kind this build has', () => {
    assert.deepEqual(Object.keys(SETTINGS).sort(), [...triggerKinds.ids].sort());
  });

  it('in ms:trigger: serves every kind and one this build does not know', async () => {
    // The service's own reading, which is where an unknown kind is tolerated (`P-139`).
    const repository = {
      effectiveFor: () => Promise.resolve(rows),
    } as unknown as TriggerRepository;
    const triggers = new TriggerService({
      db: {} as Database,
      audit: {} as AuditSink,
      logger: silentLogger,
      repository,
    });
    const answer = await serve('/objects/:id/triggers', '/objects/7/triggers', (app) => {
      for (const schema of TRIGGER_SCHEMAS) app.addSchema(schema);
      triggerRoutes(app, { triggers });
    });
    assert.deepEqual(valuesOf(answer.body, 'kind'), [...triggerKinds.ids, 'forecast']);
    assert.equal(answer.invalid(answer.body), null, 'an unknown kind is listed, as P-139 has it');
  });

  it('in used-by: lists only the kinds this build can read, and allows any', async () => {
    const q = { query: () => Promise.resolve(rows.map(asRow)) } as unknown as Queryable;
    const repository = new TemplateRepository();
    const templates = {
      usedBy: (id: number) => repository.usedBy(q, id, Visibility.EVERYTHING),
    } as unknown as TemplateService;
    const answer = await serve('/templates/:id/used-by', '/templates/1/used-by', (app) => {
      for (const schema of TEMPLATE_SCHEMAS) app.addSchema(schema);
      templateRoutes(app, { templates });
    });
    // The unknown kind's settings cannot be read for template references, so it is left out.
    assert.deepEqual(valuesOf(answer.body, 'triggerKind'), [...triggerKinds.ids]);
    assert.equal(answer.invalid(answer.body), null);
    const items = answer.body['items'] as Record<string, unknown>[];
    const forged = { ...answer.body, items: [{ ...items[0], triggerKind: 'forecast' }] };
    assert.equal(answer.invalid(forged), null, 'a string, as everywhere a trigger kind is served');
  });

  /** `usedBy`'s SELECT row for one stored trigger. */
  function asRow(row: EffectiveTrigger): Record<string, unknown> {
    return {
      id: String(row.id),
      kind: row.kind,
      settings: row.settings,
      object_id: String(row.objectId),
      object_name: 'London',
    };
  }
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

/** Every shared schema the routes below `$ref`, added as the server adds them. */
const addSharedSchemas = (app: FastifyInstance): void => {
  for (const schema of [
    ...SHARED_SCHEMAS,
    ...HISTORY_SCHEMAS,
    ...AUDIT_SCHEMAS,
    ...STATE_SCHEMAS,
    ...PAUSE_SCHEMAS,
  ])
    app.addSchema(schema);
};

/** The object routes over a service that answers only what a test hands it. */
const withObjects =
  (service: Partial<Record<keyof ObjectService, unknown>>) =>
  async (app: FastifyInstance): Promise<void> => {
    addSharedSchemas(app);
    await app.register(objectRoutes, {
      service: service as unknown as ObjectService,
      bulk: {} as BulkService,
      validatorSalt: 'fixed-value-fields',
    });
  };

const ALICE: Actor = { kind: 'user', userId: 4, login: 'alice' };

/** One actor of every kind, as a write hands one over. */
const ACTORS: readonly Actor[] = [
  ALICE,
  { kind: 'token', tokenId: 9 },
  { kind: 'system', component: 'pause-sweep' },
  { kind: 'anonymous', remoteAddress: '192.0.2.7' },
];

describe('actor kinds', () => {
  it('are what every writer flattens an actor to, one per kind, in order', () => {
    // The pause's and the acknowledgement's copies of the kind have no CHECK of their own, so
    // the writers are what hold them to the list: `flattenActor` (a pause) and `actor.kind` (an
    // acknowledgement, `StateService.acknowledge`).
    assert.deepEqual(
      ACTORS.map((actor) => flattenActor(actor).kind),
      [...ACTOR_KINDS],
    );
    assert.deepEqual(
      ACTORS.map((actor) => actor.kind),
      [...ACTOR_KINDS],
    );
  });

  it('are the audit actor’s variants, one each, in order', () => {
    assert.deepEqual(
      auditActorSchema.oneOf.map((variant) => variant.properties.kind.const),
      [...ACTOR_KINDS],
    );
  });
});

describe('ms:pauseView', () => {
  const DEPENDENCY = {
    masterId: 3,
    masterName: 'Core switch ping',
    masterState: 'up',
    holding: false,
    releasesAt: null,
    definedOn: 1,
  } as const;
  const view = (over: Partial<PauseView> = {}): PauseView => ({
    objectId: 7,
    paused: true,
    pending: false,
    resumable: true,
    source: 'manual',
    pausedAt: '2026-10-09T08:00:00.000Z',
    startsAt: '2026-10-09T08:00:00.000Z',
    pausedUntil: null,
    message: 'replacing the switch',
    actor: { kind: 'user', label: 'alice' },
    inheritedFrom: null,
    schedule: null,
    dependency: DEPENDENCY,
    ...over,
  });
  const served = (one: PauseView): Promise<Served> =>
    serve(
      '/objects/:id/pause',
      '/objects/7/pause',
      withObjects({
        pauseState: () => Promise.resolve(one),
        pauseSeenBy: (seen: PauseView) => Promise.resolve(seen),
      }),
    );

  describe('actor.kind', () => {
    for (const kind of ACTOR_KINDS) {
      it(`serves ${kind}, and the route’s own schema allows it`, async () => {
        const answer = await served(view({ actor: { kind, label: null } }));
        assert.equal((answer.body['actor'] as { kind: string }).kind, kind);
        assert.equal(answer.invalid(answer.body), null);
      });
    }

    it('is an enum: a kind the audit log cannot hold is refused', async () => {
      const answer = await served(view());
      const forged = { ...answer.body, actor: { kind: 'probe', label: null } };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  });

  describe('dependency.masterState', () => {
    const states: readonly (SensorState | null)[] = [...SENSOR_STATES, null];
    for (const masterState of states) {
      it(`serves ${String(masterState)}, and the route’s own schema allows it`, async () => {
        const dependency = { ...DEPENDENCY, masterState };
        const answer = await served(view({ dependency }));
        assert.equal(
          (answer.body['dependency'] as { masterState: unknown }).masterState,
          masterState,
        );
        assert.equal(answer.invalid(answer.body), null);
      });
    }

    it('is an enum: `recovering`, a filter value and never a state, is refused', async () => {
      const answer = await served(view());
      const dependency = answer.body['dependency'] as Record<string, unknown>;
      const forged = { ...answer.body, dependency: { ...dependency, masterState: 'recovering' } };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  });
});

describe('acknowledgedBy.kind in ms:sensorState', () => {
  /** `sensor_runtime` as `readSensorState` selects it, acknowledged by an actor of this kind. */
  const row = (kind: ActorKind): Record<string, unknown> => ({
    object_id: '7',
    state: 'down_acknowledged',
    cause: 'scan',
    message: 'timed out',
    since: new Date('2026-10-09T08:00:00.000Z'),
    consecutive_failures: 3,
    last_result_at: new Date('2026-10-09T08:05:00.000Z'),
    paused_by_parent: false,
    paused_by_dependency: false,
    paused_by_schedule: false,
    paused_manually: false,
    acknowledged_at: new Date('2026-10-09T08:06:00.000Z'),
    acknowledged_until: null,
    acknowledged_by_kind: kind,
    acknowledged_by_label: null,
    simulated_error: false,
    channel_state: null,
    channel_cause: null,
    resumed_at: null,
  });
  const served = (kind: ActorKind): Promise<Served> =>
    serve('/sensors/:id/state', '/sensors/7/state', (app) => {
      addSharedSchemas(app);
      const db = { query: () => Promise.resolve([row(kind)]) } as unknown as Database;
      stateRoutes(app, { db });
    });

  for (const kind of ACTOR_KINDS) {
    it(`serves ${kind}, and the route’s own schema allows it`, async () => {
      const answer = await served(kind);
      assert.equal((answer.body['acknowledgedBy'] as { kind: string }).kind, kind);
      assert.equal(answer.invalid(answer.body), null);
    });
  }

  it('is an enum: a kind the audit log cannot hold is refused', async () => {
    const answer = await served('user');
    const forged = { ...answer.body, acknowledgedBy: { kind: 'probe', label: null } };
    assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
  });
});

describe('objectKind in ms:auditEntry', () => {
  const entry = (id: number, objectKind: ObjectKind | null, actor: Actor): AuditEntry => ({
    id: String(id),
    at: '2026-10-09T08:00:00.000Z',
    action: 'object.updated',
    objectId: objectKind === null ? null : id,
    objectKind,
    actor,
    summary: {},
    diff: [],
  });
  const served = (entries: readonly AuditEntry[]): Promise<Served> =>
    serve('/audit', '/audit', async (app) => {
      addSharedSchemas(app);
      const db = { tx: (work: (q: unknown) => unknown) => work({}) } as unknown as Database;
      const audit = { list: () => Promise.resolve(entries) } as unknown as AuditRepository;
      await app.register(auditRoutes, { db, audit });
    });
  const kinds: readonly (ObjectKind | null)[] = [...OBJECT_KINDS, null];

  it('serves every object kind and none, and the route’s own schema allows each', async () => {
    const answer = await served(kinds.map((kind, index) => entry(90 - index, kind, ALICE)));
    assert.deepEqual(valuesOf(answer.body, 'objectKind'), kinds);
    assert.equal(answer.invalid(answer.body), null);
  });

  it('serves every actor kind, and the route’s own schema allows each', async () => {
    const answer = await served(ACTORS.map((actor, index) => entry(80 - index, 'device', actor)));
    const actors = valuesOf(answer.body, 'actor') as { kind: string }[];
    assert.deepEqual(
      actors.map((one) => one.kind),
      [...ACTOR_KINDS],
    );
    assert.equal(answer.invalid(answer.body), null);
  });

  it('is an enum: a kind `object_kind` cannot hold is refused', async () => {
    const answer = await served([entry(90, 'device', ALICE)]);
    const items = answer.body['items'] as Record<string, unknown>[];
    const forged = { ...answer.body, items: [{ ...items[0], objectKind: 'node' }] };
    assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
  });
});

describe('the credential kinds', () => {
  it('include every kind this build can use', () => {
    // The registry is the subset with a transport behind it; one it adds without the database's
    // enum (and this list) is a kind that is stored and served while the schema refuses it.
    for (const kind of credentialKindIds()) {
      assert.ok((CREDENTIAL_SET_KINDS as readonly string[]).includes(kind), kind);
    }
  });

  describe('in GET /objects/{id}/credentials', () => {
    const view = (kind: CredentialKind): CredentialView => ({
      kind,
      publicParams: {},
      source: { kind: 'own', objectId: 7 },
      updatedAt: '2026-10-09T08:00:00.000Z',
      bounded: true,
    });

    it('serves every kind, `mail` included, and the route’s own schema allows each', async () => {
      const answer = await serve(
        '/objects/:id/credentials',
        '/objects/7/credentials',
        withObjects({ credentials: () => Promise.resolve(CREDENTIAL_SET_KINDS.map(view)) }),
      );
      assert.deepEqual(valuesOf(answer.body, 'kind'), [...CREDENTIAL_SET_KINDS]);
      assert.equal(answer.invalid(answer.body), null);
    });
  });

  describe('in GET /credentials/unbounded', () => {
    const unbounded = (objectKind: ObjectKind, kind: CredentialKind): UnboundedCredential => ({
      objectId: 7,
      objectKind,
      objectName: 'London',
      kind,
      updatedAt: '2026-10-09T08:00:00.000Z',
    });
    const served = (items: readonly UnboundedCredential[]): Promise<Served> =>
      serve(
        '/credentials/unbounded',
        '/credentials/unbounded',
        withObjects({ unboundedCredentials: () => Promise.resolve(items) }),
      );

    it('serves every credential kind, and the route’s own schema allows each', async () => {
      const answer = await served(CREDENTIAL_SET_KINDS.map((kind) => unbounded('group', kind)));
      assert.deepEqual(valuesOf(answer.body, 'kind'), [...CREDENTIAL_SET_KINDS]);
      assert.equal(answer.invalid(answer.body), null);
    });

    it('serves every object kind, and the route’s own schema allows each', async () => {
      const answer = await served(OBJECT_KINDS.map((kind) => unbounded(kind, 'snmp')));
      assert.deepEqual(valuesOf(answer.body, 'objectKind'), [...OBJECT_KINDS]);
      assert.equal(answer.invalid(answer.body), null);
    });

    it('is an enum: a kind the database cannot hold is refused, of either', async () => {
      const answer = await served([unbounded('group', 'snmp')]);
      const items = answer.body['items'] as Record<string, unknown>[];
      for (const forged of [{ kind: 'telnet' }, { objectKind: 'node' }]) {
        const body = { ...answer.body, items: [{ ...items[0], ...forged }] };
        assert.notEqual(answer.invalid(body), null, JSON.stringify(forged));
      }
    });
  });

  describe('in DELETE /objects/{id}/credentials/{kind}', () => {
    const served = (kind: string): Promise<Served> =>
      serve(
        '/objects/:id/credentials/:kind',
        `/objects/7/credentials/${kind}`,
        withObjects({
          clearCredential: () => Promise.resolve({ removed: true, sensors: 2, nowInherited: null }),
        }),
        'DELETE',
      );

    // Every kind the vault lets through: it refuses any other before the route answers.
    for (const kind of credentialKindIds()) {
      it(`serves ${kind}, and the route’s own schema allows it`, async () => {
        const answer = await served(kind);
        assert.equal(answer.body['kind'], kind);
        assert.equal(answer.invalid(answer.body), null);
      });
    }

    it('is an enum: a kind the database cannot hold is refused', async () => {
      const answer = await served('snmp');
      assert.notEqual(answer.invalid({ ...answer.body, kind: 'telnet' }), null);
    });
  });
});

describe('kind in DELETE /objects/{id}', () => {
  const served = (kind: ObjectKind): Promise<Served> =>
    serve(
      '/objects/:id',
      '/objects/7',
      withObjects({
        delete: () =>
          Promise.resolve({ id: 7, kind, name: 'London', deleted: { [kind]: 1 }, destroyed: [] }),
      }),
      'DELETE',
    );

  for (const kind of WRITABLE_KINDS) {
    it(`serves ${kind}, and the route’s own schema allows it`, async () => {
      const answer = await served(kind);
      assert.equal(answer.body['kind'], kind);
      assert.equal(answer.invalid(answer.body), null);
    });
  }

  it('is an enum: `root`, which the service refuses to delete, is refused', async () => {
    const answer = await served('device');
    assert.notEqual(answer.invalid({ ...answer.body, kind: 'root' }), null);
  });
});

describe('the reports', () => {
  /** A report whose span the rules both shorten and coarsen: six years, at one minute. */
  const report: ReportRow = {
    id: 5,
    name: 'Six years',
    description: '',
    kind: 'table_only',
    subjects: { objectIds: [7] },
    span: {
      kind: 'custom',
      from: '2020-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      timezone: 'UTC',
      resolutionSeconds: 60,
    },
    outputs: DEFAULT_OUTPUTS,
    schedule: { kind: 'manual' },
    runAsUserId: 1,
    runAsLogin: 'alice',
    runAsDisabled: false,
    version: 1,
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: new Date('2026-10-09T08:00:00.000Z'),
    updatedAt: new Date('2026-10-09T08:00:00.000Z'),
  };
  const withReports =
    (
      visible: readonly ReportSubject[] = [],
      over: Partial<ReportRow> = {},
      runAsRole: AccountRole = 'admin',
    ) =>
    (app: FastifyInstance): void => {
      app.addHook('onRequest', async (request) => {
        (request as unknown as { principal: unknown }).principal = { userId: 1, role: 'admin' };
        await Promise.resolve();
      });
      const options = {
        reports: { get: () => Promise.resolve({ ...report, ...over }) },
        context: {
          subjectsFor: () =>
            Promise.resolve({
              principal: { login: 'alice', role: runAsRole },
              visible,
              unavailable: [],
            }),
        },
      } as unknown as ReportRouteOptions;
      reportRoutes(app, options);
    };

  describe('resolved.adjustments[]', () => {
    it('serves every kind, and the route’s own schema allows each', async () => {
      const answer = await serve('/reports/:id', '/reports/5', withReports());
      const resolved = answer.body['resolved'] as { adjustments: { kind: string }[] };
      assert.deepEqual(
        resolved.adjustments.map((one) => one.kind),
        [...QUERY_ADJUSTMENT_KINDS],
      );
      assert.equal(answer.invalid(answer.body), null);
    });

    it('is an enum: a kind no rule makes is refused', async () => {
      const answer = await serve('/reports/:id', '/reports/5', withReports());
      const resolved = answer.body['resolved'] as { adjustments: Record<string, unknown>[] };
      const adjustments = [{ ...resolved.adjustments[0], kind: 'clipped' }];
      const forged = { ...answer.body, resolved: { ...resolved, adjustments } };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });

    /** Not an enum, deliberately: a sentence built from the rule's numbers, for a person. */
    it('allows any reason, which is free text', async () => {
      const answer = await serve('/reports/:id', '/reports/5', withReports());
      const resolved = answer.body['resolved'] as { adjustments: Record<string, unknown>[] };
      const adjustments = [
        { ...resolved.adjustments[0], reason: 'a sentence this build never wrote' },
      ];
      assert.equal(
        answer.invalid({ ...answer.body, resolved: { ...resolved, adjustments } }),
        null,
      );
    });
  });

  describe('visible[].kind in GET /reports/{id}/subjects', () => {
    const visible = OBJECT_KINDS.map((kind, index) => ({ id: 10 + index, kind, name: kind }));

    it('serves every object kind, and the route’s own schema allows each', async () => {
      const answer = await serve(
        '/reports/:id/subjects',
        '/reports/5/subjects',
        withReports(visible),
      );
      const served = answer.body['visible'] as { kind: string }[];
      assert.deepEqual(
        served.map((one) => one.kind),
        [...OBJECT_KINDS],
      );
      assert.equal(answer.invalid(answer.body), null);
    });

    it('is an enum: a kind `object_kind` cannot hold is refused', async () => {
      const answer = await serve(
        '/reports/:id/subjects',
        '/reports/5/subjects',
        withReports(visible),
      );
      const forged = { ...answer.body, visible: [{ id: 10, kind: 'node', name: 'x' }] };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  });

  describe('runAs.role in GET /reports/{id}/subjects', () => {
    for (const role of ACCOUNT_ROLES) {
      it(`serves ${role}, and the route’s own schema allows it`, async () => {
        const answer = await serve(
          '/reports/:id/subjects',
          '/reports/5/subjects',
          withReports([], {}, role),
        );
        assert.equal((answer.body['runAs'] as { role: string }).role, role);
        assert.equal(answer.invalid(answer.body), null);
      });
    }

    it('is an enum: a role `user_account` cannot hold is refused', async () => {
      const answer = await serve('/reports/:id/subjects', '/reports/5/subjects', withReports());
      const forged = { ...answer.body, runAs: { login: 'alice', role: 'operator' } };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  });

  describe('resolved.source', () => {
    /**
     * One day at each resolution whose buckets a source composes exactly, coarsest first, so
     * `planReportSpan` itself, the writer, picks each source in `SERIES_SOURCES`' order.
     */
    const RESOLUTIONS = [86_400, 3_600, 300, 60] as const;
    const oneDayAt = (resolutionSeconds: number): Partial<ReportRow> => ({
      span: {
        kind: 'custom',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        timezone: 'UTC',
        resolutionSeconds,
      },
    });

    it('is each source for some span, in order, and the route’s own schema allows each', async () => {
      const sources: unknown[] = [];
      for (const resolution of RESOLUTIONS) {
        const answer = await serve(
          '/reports/:id',
          '/reports/5',
          withReports([], oneDayAt(resolution)),
        );
        sources.push((answer.body['resolved'] as { source: unknown }).source);
        assert.equal(answer.invalid(answer.body), null, String(resolution));
      }
      assert.deepEqual(sources, [...SERIES_SOURCES]);
    });

    it('is an enum: a table no rule reads from is refused', async () => {
      const answer = await serve('/reports/:id', '/reports/5', withReports([], oneDayAt(60)));
      const resolved = answer.body['resolved'] as Record<string, unknown>;
      const forged = { ...answer.body, resolved: { ...resolved, source: 'sample_15m' } };
      assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
    });
  });
});

describe('source and segments[].table in GET /sensors/{id}/history', () => {
  it('are the rollup tiers and raw, each what the planner picks for some resolution', () => {
    assert.deepEqual(
      [...SERIES_SOURCES].sort(),
      [...ROLLUP_TIERS.map((tier) => tier.id), 'sample'].sort(),
    );
    assert.deepEqual(
      [86_400, 3_600, 300, 60].map((seconds) => sourceFor(seconds)),
      [...SERIES_SOURCES],
    );
  });

  const history = (source: SeriesSource): SensorHistory => ({
    sensorId: 7,
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    resolutionSeconds: 60,
    bucketCount: 0,
    source,
    segments: SERIES_SOURCES.map((table) => ({
      table,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    })),
    adjustments: [],
    buckets: [],
    channels: [],
  });
  const served = (source: SeriesSource): Promise<Served> =>
    serve('/sensors/:id/history', '/sensors/7/history', async (app) => {
      addSharedSchemas(app);
      const service = {
        forSensor: () => Promise.resolve(history(source)),
      } as unknown as HistoryService;
      // `/values` only (`U-38`); this route never asks it.
      const objects = { channels: () => Promise.resolve([]) };
      await app.register(historyRoutes, { history: service, objects });
    });

  for (const source of SERIES_SOURCES) {
    it(`serves ${source}, and the route’s own schema allows it as both`, async () => {
      const answer = await served(source);
      assert.equal(answer.body['source'], source);
      assert.deepEqual(
        (answer.body['segments'] as { table: string }[]).map((one) => one.table),
        [...SERIES_SOURCES],
      );
      assert.equal(answer.invalid(answer.body), null);
    });
  }

  it('is an enum, both: a table no rule reads from is refused', async () => {
    const answer = await served('sample');
    assert.notEqual(answer.invalid({ ...answer.body, source: 'sample_15m' }), null, 'source');
    const segments = [{ table: 'sample_15m', from: 'x', to: 'y' }];
    assert.notEqual(answer.invalid({ ...answer.body, segments }), null, 'segments[].table');
  });
});

describe('mediaType in POST /maps/{id}/background', () => {
  const background = (mediaType: ImageMediaType): MapBackground => ({
    mediaType,
    digest: 'a'.repeat(64),
    width: 640,
    height: 480,
    bytes: 1_024,
    uploadedAt: new Date('2026-10-09T08:00:00.000Z'),
    uploadedBy: 'alice',
  });
  const served = (mediaType: ImageMediaType): Promise<Served> =>
    serve(
      '/maps/:id/background',
      '/maps/7/background',
      (app) => {
        app.addHook('onRequest', async (request) => {
          (request as unknown as { principal: unknown }).principal = { userId: 1, role: 'admin' };
          await Promise.resolve();
        });
        const maps = {
          setBackground: () => Promise.resolve(background(mediaType)),
        } as unknown as MapService;
        mapRoutes(app, { maps });
      },
      'POST',
      { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'application/octet-stream' },
    );

  for (const mediaType of IMAGE_MEDIA_TYPES) {
    it(`serves ${mediaType}, and the route’s own schema allows it`, async () => {
      const answer = await served(mediaType);
      assert.equal(answer.body['mediaType'], mediaType);
      assert.equal(answer.invalid(answer.body), null);
    });
  }

  it('is an enum: SVG, which the sniffer refuses, is refused', async () => {
    const answer = await served('image/png');
    assert.notEqual(answer.invalid({ ...answer.body, mediaType: 'image/svg+xml' }), null);
  });
});

/**
 * A background's `mediaType` in the audit log (`P-370`). Typed from `IMAGE_MEDIA_TYPES` where it
 * is written, and served as a diff value, which is open for every field on purpose: an entry is
 * history, kept past the build that wrote it, so the schema does not promise what a later build's
 * list is. The type holds the writer; the test holds what the reader is served.
 */
describe('map.background.mediaType in ms:auditEntry', () => {
  // Fails to compile, rather than to run, if the audit record's field is widened to a string.
  const typed: Same<MapBackgroundAudit['mediaType'], ImageMediaType> = true;
  void typed;

  const backgroundAudit = (mediaType: ImageMediaType): MapBackgroundAudit => ({
    mediaType,
    digest: 'b'.repeat(64),
    width: 640,
    height: 480,
    bytes: 2_048,
  });

  /** The diff `DatabaseAuditSink` writes for a background set, read back off its INSERT. */
  const written = async (mutation: Mutation): Promise<AuditEntry['diff']> => {
    let diffs: unknown;
    const q = {
      query: (_sql: string, params: unknown[]) => {
        diffs = params[8];
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as Queryable;
    await new DatabaseAuditSink().record(q, ALICE, [mutation], new Date('2026-10-09T08:00:00Z'));
    const [diff] = diffs as string[];
    return JSON.parse(diff ?? '[]') as AuditEntry['diff'];
  };

  const served = (diff: AuditEntry['diff']): Promise<Served> =>
    serve('/audit', '/audit', async (app) => {
      addSharedSchemas(app);
      const entry: AuditEntry = {
        id: '70',
        at: '2026-10-09T08:00:00.000Z',
        action: 'map.background.set',
        objectId: null,
        objectKind: null,
        actor: ALICE,
        summary: { mapId: 7 },
        diff,
      };
      const db = { tx: (work: (q: unknown) => unknown) => work({}) } as unknown as Database;
      const audit = { list: () => Promise.resolve([entry]) } as unknown as AuditRepository;
      await app.register(auditRoutes, { db, audit });
    });

  const mediaTypeIn = (body: Record<string, unknown>): unknown => {
    const [item] = body['items'] as { diff: { field: string; after: unknown }[] }[];
    return item?.diff.find((change) => change.field === 'map.background.mediaType')?.after;
  };

  for (const mediaType of IMAGE_MEDIA_TYPES) {
    it(`is written as ${mediaType}, served, and the route’s own schema allows it`, async () => {
      const diff = await written({
        action: 'map.background.set',
        objectId: null,
        mapId: 7,
        before: null,
        after: backgroundAudit(mediaType),
      });
      const answer = await served(diff);
      assert.equal(mediaTypeIn(answer.body), mediaType);
      assert.equal(answer.invalid(answer.body), null);
    });
  }

  it('stays open: a type another build wrote is served as it was recorded', async () => {
    const answer = await served([
      { field: 'map.background.mediaType', before: 'image/png', after: 'image/gif' },
    ]);
    assert.equal(mediaTypeIn(answer.body), 'image/gif');
    assert.equal(answer.invalid(answer.body), null);
  });
});

/**
 * Open on purpose, each with a description saying why (`P-361`). A test pins each, so a later
 * enum has to argue with it.
 */
describe('fields left open', () => {
  it('skew.missing[] in GET /probes: phrases for a person, so any phrase validates', async () => {
    const skew = describeSkew(MIN_PROTOCOL_VERSION);
    assert.equal(skew.kind, 'outdated', 'the oldest compatible version lacks something');
    const probe = {
      gid: 'probe-1',
      status: 'approved',
      displayName: 'Remote probe',
      protocolVersion: MIN_PROTOCOL_VERSION,
      protocolAcceptedAt: '2026-10-09T08:00:00.000Z',
      protocolRefusedAt: null,
      firstSeenAt: '2026-10-09T08:00:00.000Z',
      skew: { ...skew, explanation: explainSkew(skew) },
    };
    const answer = await serve('/probes', '/probes', (app) => {
      const registry = { list: () => Promise.resolve([probe]) } as unknown as ProbeRegistry;
      probeRoutes(app, { registry });
    });
    assert.equal(answer.invalid(answer.body), null);
    const items = answer.body['items'] as Record<string, unknown>[];
    const skewServed = items[0]?.['skew'] as { missing?: unknown };
    assert.ok(Array.isArray(skewServed.missing) && skewServed.missing.length > 0);
    const missing = ['do something this build never said'];
    const forged = { ...answer.body, items: [{ ...items[0], skew: { ...skewServed, missing } }] };
    assert.equal(answer.invalid(forged), null);
  });

  it('source in GET /lookups: `built-in` or a path, so any path validates', async () => {
    const summary = (source: string): Record<string, unknown> => ({
      id: 'prtg.standardlookups.yesno',
      name: 'Yes/No',
      description: '',
      type: 'singleInt',
      undefinedState: 'warning',
      entryCount: 2,
      source,
    });
    const answer = await serve('/lookups', '/lookups', (app) => {
      for (const schema of LOOKUP_SCHEMAS) app.addSchema(schema);
      const lookups = {
        summaries: () => [summary('built-in'), summary('/var/lib/ms/lookups/yesno.json')],
        problems: () => [{ id: 'x', source: '/var/lib/ms/lookups/x.json', problems: ['bad'] }],
      } as unknown as LookupCatalogue;
      lookupRoutes(app, { lookups });
    });
    assert.deepEqual(valuesOf(answer.body, 'source'), [
      'built-in',
      '/var/lib/ms/lookups/yesno.json',
    ]);
    assert.equal(answer.invalid(answer.body), null);
  });

  it('source in GET /device-templates: `built-in` or a path, so any path validates', async () => {
    const answer = await serve('/device-templates', '/device-templates', (app) => {
      const templates = {
        summaries: () => [
          { id: 'linux', name: 'Linux', description: '', sensorCount: 3, source: 'built-in' },
          { id: 'nas', name: 'NAS', description: '', sensorCount: 2, source: '/etc/ms/nas.json' },
        ],
        problems: () => [{ id: 'bad', source: '/etc/ms/bad.json', problems: ['no sensors'] }],
      } as unknown as DeviceTemplateCatalogue;
      deviceTemplateRoutes(app, {
        templates,
        discovery: {} as DiscoveryService,
        credentialKindsFor: () => [],
      });
    });
    assert.deepEqual(valuesOf(answer.body, 'source'), ['built-in', '/etc/ms/nas.json']);
    assert.equal(answer.invalid(answer.body), null);
  });
});

describe('items[].kind in GET /discovery/{id}/plan', () => {
  /**
   * What the database can hand over, read as `DiscoveryService.hosts` reads it: a fingerprint of
   * every kind, a host never identified, and one stored with a kind this build does not know,
   * which `readFingerprint` refuses so that it gets the generic plan, as the unidentified one does.
   */
  const stored: unknown[] = [
    ...DEVICE_KINDS.map((kind) => ({ address: '10.0.0.1', kind, confidence: 90, ports: [] })),
    null,
    { address: '10.0.0.2', kind: 'toaster', confidence: 90, ports: [] },
  ];
  const served = (): Promise<Served> =>
    serve('/discovery/:id/plan', '/discovery/7/plan', (app) => {
      const hosts = stored.map((fingerprint, index) => ({
        address: `10.0.0.${String(index + 1)}`,
        rttMs: 1,
        fingerprint: readFingerprint(fingerprint),
      }));
      const discovery = {
        get: () => Promise.resolve(RUN),
        hosts: () => Promise.resolve(hosts),
      } as unknown as DiscoveryService;
      const templates = {
        plan: () => ({ templates: [], sensors: [] }),
      } as unknown as DeviceTemplateCatalogue;
      deviceTemplateRoutes(app, { templates, discovery, credentialKindsFor: () => [] });
    });

  it('serves every kind, and the route’s own schema allows each', async () => {
    const answer = await served();
    assert.deepEqual(valuesOf(answer.body, 'kind'), [...DEVICE_KINDS, 'unknown', 'unknown']);
    assert.equal(answer.invalid(answer.body), null);
  });

  it('is an enum: a kind the classifier does not name is refused', async () => {
    const answer = await served();
    const items = answer.body['items'] as Record<string, unknown>[];
    const forged = { ...answer.body, items: [{ ...items[0], kind: 'toaster' }] };
    assert.notEqual(answer.invalid(forged), null, 'a plain string would allow it');
  });
});

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

    /** An enum type's values, in their order. */
    async function labels(type: string): Promise<string[]> {
      const rows = await scratch.db.query<{ value: string }>(
        `SELECT e.enumlabel AS value
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = $1 ORDER BY e.enumsortorder`,
        [type],
      );
      return rows.map((row) => row.value);
    }

    it('allows exactly the actor kinds the schemas name', async () => {
      assert.deepEqual(
        (await allowed('audit_log_actor_kind_check')).sort(),
        [...ACTOR_KINDS].sort(),
      );
    });

    it('holds exactly the object kinds the schemas name', async () => {
      assert.deepEqual(await labels('object_kind'), [...OBJECT_KINDS]);
    });

    it('holds exactly the credential kinds the schemas name, `mail` included', async () => {
      assert.deepEqual(await labels('credential_kind'), [...CREDENTIAL_SET_KINDS]);
    });

    it('allows exactly the account roles the schemas name', async () => {
      assert.deepEqual(
        (await allowed('user_account_role_check')).sort(),
        [...ACCOUNT_ROLES].sort(),
      );
    });

    it('allows exactly the background media types the schema names', async () => {
      assert.deepEqual(
        (await allowed('map_background_media_type_check')).sort(),
        [...IMAGE_MEDIA_TYPES].sort(),
      );
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

/**
 * Building the object routes printed Ajv's "strict mode: use allowUnionTypes" for `tag` and
 * `effective` (`P-363`), each `type: ['string', 'array']`, in every test that built them on a
 * bare Fastify. Ajv writes it to `console.warn`, its default logger, when it compiles the
 * querystring, so that is where this listens.
 */
describe('building the object routes', () => {
  const strictWarnings = async (customOptions: Record<string, unknown>): Promise<string[]> => {
    const warn = mock.method(console, 'warn', () => undefined);
    const app = Fastify({ ajv: { customOptions } });
    try {
      await withObjects({})(app);
      await app.ready();
      return warn.mock.calls
        .map((call) => call.arguments.map(String).join(' '))
        .filter((line) => line.includes('strict mode'));
    } finally {
      warn.mock.restore();
      await app.close();
    }
  };

  it('prints no strict-mode warning with the options the server validates with', async () => {
    assert.deepEqual(await strictWarnings({ ...API_VALIDATOR_OPTIONS }), []);
  });

  it('would print one for each union type without allowUnionTypes, so the listening works', async () => {
    // The control: the same build with only that option off is heard, so the empty list above
    // is the option's doing and not a capture that hears nothing.
    const heard = await strictWarnings({ ...API_VALIDATOR_OPTIONS, allowUnionTypes: false });
    assert.ok(
      heard.some((line) => line.includes('allowUnionTypes') && line.includes('#/properties/tag')),
      heard.join('\n'),
    );
    assert.ok(
      heard.some((line) => line.includes('#/properties/effective')),
      heard.join('\n'),
    );
  });
});
