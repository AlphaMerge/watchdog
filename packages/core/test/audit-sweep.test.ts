import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccessService } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { TriggerService } from '../src/triggers/service.js';
import { TemplateService } from '../src/notifications/templates.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { ScheduleService } from '../src/schedules/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import { DeviceTemplateCatalogue } from '../src/device-templates/catalogue.js';
import { ProbeRegistry } from '../src/probes/registry.js';
import { ProbeQueryService } from '../src/probes/queries.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { NotificationTester } from '../src/notifications/test-send.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapResolver } from '../src/maps/resolver.js';
import { MapService } from '../src/maps/service.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService } from '../src/reports/service.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRunner, ReportRunRepository } from '../src/reports/runs.js';
import { ReportOutputRepository } from '../src/reports/delivery.js';
import { ReportFormatter } from '../src/reports/formatter.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
import type { Actor } from '../src/objects/audit.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * Every change the API makes is in the audit log, or says in its own source why not (`A-17`).
 *
 * **Derived, the way `A-10`'s sweep is derived.** The routes come from `server.routes`, not from a
 * list in this file, so a mutating route added tomorrow is in the sweep by existing. What this
 * file does hold is one *fixture* per route — how to call it so that it succeeds — because no
 * derivation can invent a valid map id or a sensor in the Down state. A route with no fixture
 * fails here by name, so the table cannot fall behind: the route that nobody wrote a fixture for
 * is the route nobody proved audits anything.
 *
 * **A route answers for itself when it writes nothing**, beside its handler: `notAudited` for
 * what is not configuration (a session, a test send), `auditGap` for what should be audited and
 * is not yet, owned by a ticket that removes the declaration. Those are read back here and held
 * to having a reason — and are the only way out of the sweep.
 *
 * **Redaction is swept too.** A secret is planted through the credentials route, and no row this
 * file causes may contain it (`S-10`, `A-10`).
 */

const available = await databaseAvailable();

const PLANTED_SECRET = 'sweep-planted-community-7f3a';

/** A request that should succeed and leave at least one audit row. */
interface Call {
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

/** The ids and helpers a fixture draws on. Each fixture makes what it will change, fresh. */
interface Kit {
  readonly probeId: number;
  readonly groupId: number;
  readonly teamId: number;
  readonly cookie: string;
  readonly name: (prefix: string) => string;
  readonly group: (parentId?: number) => Promise<number>;
  readonly pingSensor: () => Promise<number>;
  readonly downSensor: () => Promise<number>;
  readonly post: (url: string, payload: unknown) => Promise<{ id: number; version: number }>;
}

type Fixture = (kit: Kit) => Promise<Call>;

/** A 24-byte PNG header: all `readImage` reads, and all a background needs. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const id = (value: number): string => String(value);

/**
 * How to make each audited route succeed, keyed as `server.routes` spells it.
 *
 * Grouped by module. Each one makes its own subject rather than sharing one, so a delete here
 * cannot take away what a later fixture was counting on.
 */
const FIXTURES: Record<string, Fixture> = {
  // ------------------------------------------------------------------------------- objects
  'POST /api/v1/objects': (k) =>
    Promise.resolve({
      url: '/api/v1/objects',
      payload: { kind: 'group', parentId: k.probeId, name: k.name('created') },
    }),
  'POST /api/v1/objects/tree': (k) =>
    Promise.resolve({
      url: '/api/v1/objects/tree',
      payload: { parentId: k.probeId, nodes: [{ kind: 'group', name: k.name('tree') }] },
    }),
  'PATCH /api/v1/objects/:id': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}`,
    headers: { 'if-match': 'W/"1"' },
    payload: { kind: 'group', name: k.name('renamed') },
  }),
  'DELETE /api/v1/objects/:id': async (k) => ({ url: `/api/v1/objects/${id(await k.group())}` }),
  'POST /api/v1/objects/:id/order': async (k) => {
    const parent = await k.group();
    const first = await k.group(parent);
    await k.group(parent);
    return { url: `/api/v1/objects/${id(first)}/order`, payload: { move: 'down' } };
  },
  'POST /api/v1/objects/:id/move': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/move`,
    payload: { targetParentId: await k.group() },
  }),
  'POST /api/v1/objects/:id/clone': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/clone`,
    payload: { targetParentId: k.probeId, name: k.name('clone') },
  }),
  'POST /api/v1/objects/bulk': async (k) => ({
    url: '/api/v1/objects/bulk',
    payload: { ids: [await k.group()], operation: 'pause', minutes: 5 },
  }),
  'PATCH /api/v1/objects/:id/channels/:key': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/channels/rtt`,
    payload: { limits: { upperError: 500 } },
  }),
  'POST /api/v1/objects/:id/pause': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/pause`,
    payload: { minutes: 5 },
  }),
  'DELETE /api/v1/objects/:id/pause': async (k) => {
    const target = await k.group();
    await k.post(`/api/v1/objects/${id(target)}/pause`, { minutes: 5 });
    return { url: `/api/v1/objects/${id(target)}/pause` };
  },
  'POST /api/v1/objects/:id/acknowledge': async (k) => ({
    url: `/api/v1/objects/${id(await k.downSensor())}/acknowledge`,
    payload: { message: 'looking into it' },
  }),
  'DELETE /api/v1/objects/:id/acknowledge': async (k) => {
    const sensor = await k.downSensor();
    await k.post(`/api/v1/objects/${id(sensor)}/acknowledge`, { message: 'looking' });
    return { url: `/api/v1/objects/${id(sensor)}/acknowledge` };
  },
  'POST /api/v1/objects/:id/simulate-error': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/simulate-error`,
    payload: { message: 'drill' },
  }),
  'DELETE /api/v1/objects/:id/simulate-error': async (k) => {
    const sensor = await k.pingSensor();
    await k.post(`/api/v1/objects/${id(sensor)}/simulate-error`, { message: 'drill' });
    return { url: `/api/v1/objects/${id(sensor)}/simulate-error` };
  },
  'PUT /api/v1/objects/:id/dependency': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/dependency`,
    payload: { mode: 'none' },
  }),
  'PUT /api/v1/objects/:id/settings/:key': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/settings/scan.intervalSeconds`,
    payload: { value: 300 },
  }),
  'DELETE /api/v1/objects/:id/settings/:key': async (k) => {
    const target = await k.group();
    const url = `/api/v1/objects/${id(target)}/settings/scan.intervalSeconds`;
    await k.post(url, { value: 300 }).catch(() => undefined);
    return { url };
  },
  'PUT /api/v1/objects/:id/credentials/:kind': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/credentials/snmp`,
    payload: { values: { community: PLANTED_SECRET } },
  }),
  'DELETE /api/v1/objects/:id/credentials/:kind': async (k) => {
    const target = await k.group();
    const url = `/api/v1/objects/${id(target)}/credentials/snmp`;
    await k.post(url, { values: { community: PLANTED_SECRET } }).catch(() => undefined);
    return { url };
  },

  // -------------------------------------------------------------------------------- grants
  'PUT /api/v1/objects/:id/access/:groupId': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/objects/:id/access/:groupId': async (k) => {
    const url = `/api/v1/objects/${id(await k.group())}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ---------------------------------------------------------------------------------- maps
  'POST /api/v1/maps': (k) =>
    Promise.resolve({ url: '/api/v1/maps', payload: { name: k.name('map') } }),
  'PATCH /api/v1/maps/:id': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    return {
      url: `/api/v1/maps/${id(map.id)}`,
      headers: { 'if-match': String(map.version) },
      payload: { priority: 5 },
    };
  },
  'DELETE /api/v1/maps/:id': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}`,
  }),
  'POST /api/v1/maps/:id/shares': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/shares`,
    payload: { label: 'wall', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  }),
  'DELETE /api/v1/maps/:id/shares/:shareId': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    const made = (await k.post(`/api/v1/maps/${id(map.id)}/shares`, {
      label: 'wall',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })) as unknown as { share: { id: number } };
    return { url: `/api/v1/maps/${id(map.id)}/shares/${id(made.share.id)}` };
  },
  'POST /api/v1/maps/:id/background': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/background`,
    headers: { 'content-type': 'image/png' },
    payload: png(64, 48),
  }),
  'DELETE /api/v1/maps/:id/background': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    await k.post(`/api/v1/maps/${id(map.id)}/background`, png(64, 48));
    return { url: `/api/v1/maps/${id(map.id)}/background` };
  },
  'PUT /api/v1/maps/:id/access/:groupId': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/maps/:id/access/:groupId': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    const url = `/api/v1/maps/${id(map.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ------------------------------------------------------------------------------- reports
  'POST /api/v1/reports': (k) =>
    Promise.resolve({
      url: '/api/v1/reports',
      payload: { name: k.name('report'), kind: 'table_only' },
    }),
  'PATCH /api/v1/reports/:id': async (k) => {
    const report = await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' });
    return {
      url: `/api/v1/reports/${id(report.id)}`,
      headers: { 'if-match': String(report.version) },
      payload: { description: 'edited' },
    };
  },
  'DELETE /api/v1/reports/:id': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}`,
  }),
  'POST /api/v1/reports/:id/runs': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}/runs`,
    payload: {},
  }),
  'PUT /api/v1/reports/:id/access/:groupId': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/reports/:id/access/:groupId': async (k) => {
    const report = await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' });
    const url = `/api/v1/reports/${id(report.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ----------------------------------------------------------------------------- libraries
  'POST /api/v1/libraries': (k) =>
    Promise.resolve({
      url: '/api/v1/libraries',
      payload: { name: k.name('library') },
    }),
  'PATCH /api/v1/libraries/:id': async (k) => {
    const library = await k.post('/api/v1/libraries', { name: k.name('library') });
    return {
      url: `/api/v1/libraries/${id(library.id)}`,
      headers: { 'if-match': String(library.version) },
      payload: { priority: 5 },
    };
  },
  'DELETE /api/v1/libraries/:id': async (k) => ({
    url: `/api/v1/libraries/${id((await k.post('/api/v1/libraries', { name: k.name('library') })).id)}`,
  }),
  'PUT /api/v1/libraries/:id/access/:groupId': async (k) => ({
    url: `/api/v1/libraries/${id((await k.post('/api/v1/libraries', { name: k.name('library') })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/libraries/:id/access/:groupId': async (k) => {
    const library = await k.post('/api/v1/libraries', { name: k.name('library') });
    const url = `/api/v1/libraries/${id(library.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ----------------------------------------------------------------------------- schedules
  'POST /api/v1/schedules': (k) =>
    Promise.resolve({
      url: '/api/v1/schedules',
      payload: { name: k.name('schedule'), periods: 'mo:09:00-mo:17:00' },
    }),
  'PUT /api/v1/schedules/:id': async (k) => {
    const schedule = await k.post('/api/v1/schedules', {
      name: k.name('schedule'),
      periods: 'mo:09:00-mo:17:00',
    });
    return {
      url: `/api/v1/schedules/${id(schedule.id)}`,
      payload: { name: k.name('schedule'), periods: 'tu:09:00-tu:17:00' },
    };
  },
  'DELETE /api/v1/schedules/:id': async (k) => ({
    url: `/api/v1/schedules/${id((await k.post('/api/v1/schedules', { name: k.name('schedule'), periods: 'mo:09:00-mo:17:00' })).id)}`,
  }),

  // -------------------------------------------------------------------- triggers, templates
  'POST /api/v1/objects/:id/triggers': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/triggers`,
    payload: { kind: 'state', settings: { state: 'down' }, enabled: true },
  }),
  'PUT /api/v1/triggers/:id': async (k) => {
    const trigger = await k.post(`/api/v1/objects/${id(await k.pingSensor())}/triggers`, {
      kind: 'state',
      settings: { state: 'down' },
      enabled: true,
    });
    return {
      url: `/api/v1/triggers/${id(trigger.id)}`,
      payload: { kind: 'state', settings: { state: 'down' }, enabled: false },
    };
  },
  'DELETE /api/v1/triggers/:id': async (k) => {
    const trigger = await k.post(`/api/v1/objects/${id(await k.pingSensor())}/triggers`, {
      kind: 'state',
      settings: { state: 'down' },
      enabled: true,
    });
    return { url: `/api/v1/triggers/${id(trigger.id)}` };
  },
  'POST /api/v1/templates': (k) =>
    Promise.resolve({
      url: '/api/v1/templates',
      payload: { name: k.name('template'), method: 'email', settings: {} },
    }),
  'PUT /api/v1/templates/:id': async (k) => {
    const template = await k.post('/api/v1/templates', {
      name: k.name('template'),
      method: 'email',
      settings: {},
    });
    return {
      url: `/api/v1/templates/${id(template.id)}`,
      payload: { name: k.name('template'), method: 'email', settings: {}, enabled: false },
    };
  },
  'DELETE /api/v1/templates/:id': async (k) => ({
    url: `/api/v1/templates/${id((await k.post('/api/v1/templates', { name: k.name('template'), method: 'email', settings: {} })).id)}`,
  }),

  // ----------------------------------------------------------------------------- discovery
  // Provisioning creates objects, and objects are audited as they are created. The stub below
  // creates one through the object service with the actor the route handed it — the property
  // this sweep is about is that the route passes the caller through, not the planner.
  'POST /api/v1/discovery/:id/provision': async (k) => {
    const run = await k.post('/api/v1/discovery', {
      groupId: k.groupId,
      probeId: k.probeId,
      range: '10.9.9.0/30',
    });
    return { url: `/api/v1/discovery/${id(run.id)}/provision`, payload: {} };
  },
};

describe(
  'every change is audited, or says why not',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let app: FastifyInstance;
    let server: ApiServer;
    let harness: Harness;
    let formatter: ReportFormatter;
    let kit: Kit;

    before(async () => {
      scratch = await createScratchDatabase('auditsweep');
      db = scratch.db;
      harness = await buildHarness(db, { states: true });
      const states = harness.states;
      assert.ok(states !== undefined);
      // The harness captures the object service's entries in memory; the sweep counts rows, so
      // they go to the table as well, through the transaction they were recorded in.
      harness.audit.also = new DatabaseAuditSink();

      const accounts = new AccountService({ db, logger: silent });
      const access = new AccessService({ db, audit: harness.audit, logger: silent });
      const groups = new GroupService({ db, logger: silent });
      const discovery = new DiscoveryService({
        db,
        logger: silent,
        dispatch: () => ({ kind: 'sent' }),
      });
      const history = new HistoryService({ db, logger: silent });
      const reportRepository = new ReportRepository();
      const reportContext = new ReportContext({
        db,
        repository: reportRepository,
        access,
        logger: silent,
      });
      const reportRenderer = new ReportRenderer({
        context: reportContext,
        history,
        logger: silent,
      });
      const reportRuns = new ReportRunRepository();
      const audit = new DatabaseAuditSink();
      formatter = new ReportFormatter({ logger: silent });
      const messageContexts = new MessageContextLoader({
        settings: harness.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'sweep',
      });

      server = new ApiServer({
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
        history,
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        maps: new MapService({ db, repository: new MapRepository(), audit, logger: silent }),
        mapResolver: new MapResolver({ db, access, history }),
        libraries: new LibraryService({
          db,
          repository: new LibraryRepository(),
          audit,
          logger: silent,
        }),
        reports: {
          service: new ReportService({ db, repository: reportRepository, audit, logger: silent }),
          context: reportContext,
          renderer: reportRenderer,
          runner: new ReportRunner({
            db,
            reports: reportRepository,
            runs: reportRuns,
            renderer: reportRenderer,
            logger: silent,
            // As `main()` wires it: the run is the auditable act (`E-08`).
            audit: async (event) => {
              await audit.record(
                db,
                { kind: 'user', userId: 0, login: event.requestedBy },
                [
                  {
                    action: 'report.ran',
                    objectId: null,
                    reportId: event.reportId,
                    runId: event.runId,
                    reportName: event.reportName,
                    trigger: event.trigger,
                    requestedBy: event.requestedBy,
                    runAs: event.runAs,
                    spanLabel: event.spanLabel,
                    outcome: event.outcome,
                    errorCode: event.errorCode,
                  },
                ],
                new Date(),
              );
            },
          }),
          runs: reportRuns,
          outputStore: new ReportOutputRepository(),
          formatter,
        },
        triggers: new TriggerService({ db, audit, logger: silent }),
        templates: new TemplateService({ db, audit, logger: silent, contexts: messageContexts }),
        schedules: new ScheduleService({ db, audit, logger: silent }),
        discovery,
        provision: async (_runId: number, actor: Actor) => {
          await harness.service.create(actor, {
            kind: 'group',
            parentId: kit.groupId,
            name: kit.name('provisioned'),
          });
          return {
            devicesCreated: 1,
            matched: 0,
            sensorsCreated: 0,
            sensorsSkipped: 0,
            mastersSet: 0,
            problems: [],
            devices: [],
          };
        },
        rediscovery: new RediscoveryService({
          db,
          logger: silent,
          discovery,
          windowFor: () => Promise.resolve(null),
          provision: () => Promise.resolve(),
        }),
        deviceTemplates: new DeviceTemplateCatalogue(() => true),
        probeRegistry: new ProbeRegistry({ db, logger: silent, enrolmentKeys: ['sweep-key'] }),
        queries: new ProbeQueryService({
          logger: silent,
          sender: { sendQuery: () => ({ kind: 'offline' as const }) },
        }),
        probeConfig: new ProbeConfigService({
          db,
          resolver: new InheritanceResolver({ db, logger: silent }),
        }),
        tester: new NotificationTester({
          db,
          logger: silent,
          contexts: messageContexts,
          transports: [],
          audit,
        }),
        auth: {
          accounts,
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ db, logger: silent }),
          totp: new TotpService({ db, logger: silent }),
          required: true,
        },
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'sweep-probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'sweep-device',
        host: '127.0.0.1',
      });
      const group = await harness.service.create(testActor, {
        kind: 'group',
        parentId: probe.id,
        name: 'sweep-group',
      });
      const team = await groups.create({ name: 'Sweep team' });

      // An administrator: the sweep is about whether a change that *happens* is recorded, so the
      // caller must be one every route lets through.
      const account = await accounts.create({
        login: 'sweeper',
        password: 'correct-horse-battery',
        role: 'admin',
      });
      const admins = (await groups.list()).find((one) => one.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, account.id);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'sweeper', password: 'correct-horse-battery' },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = login.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')).split(
        ';',
      )[0];
      assert.ok(cookie !== undefined && cookie !== '');

      let seq = 0;
      const name = (prefix: string): string => {
        seq += 1;
        return `${prefix}-${String(seq)}`;
      };
      const pingSensor = async (): Promise<number> =>
        (
          await harness.service.create(testActor, {
            kind: 'sensor',
            parentId: device.id,
            name: name('ping'),
            sensorType: 'icmp.ping',
          })
        ).id;

      kit = {
        probeId: probe.id,
        groupId: group.id,
        teamId: team.id,
        cookie,
        name,
        group: async (parentId = group.id) =>
          (await harness.service.create(testActor, { kind: 'group', parentId, name: name('g') }))
            .id,
        pingSensor,
        // Down through the state machine rather than by writing the column: two failures, because
        // the default policy warns for one interval first.
        downSensor: async () => {
          const sensorId = await pingSensor();
          const at = new Date();
          for (const [index, when] of [at, new Date(at.getTime() + 60_000)].entries()) {
            const decisions = await states.decide([
              { sensorId, at: when, outcome: 'error', message: `failure ${String(index + 1)}` },
            ]);
            await db.tx(async (q) => {
              await writeStateHistory(q, decisions.transitions);
              await writeRuntimes(q, decisions.runtimes);
            });
          }
          return sensorId;
        },
        post: async (url, payload) => {
          const isBytes = Buffer.isBuffer(payload);
          const response = await app.inject({
            method:
              url.includes('/access/') ||
              url.includes('/credentials/') ||
              url.includes('/settings/')
                ? 'PUT'
                : 'POST',
            url,
            headers: {
              cookie,
              ...(isBytes ? { 'content-type': 'image/png' } : {}),
            },
            payload: payload as never,
          });
          assert.ok(
            response.statusCode < 300,
            `arranging ${url} answered ${String(response.statusCode)}: ${response.body}`,
          );
          return response.body === ''
            ? { id: 0, version: 0 }
            : response.json<{ id: number; version: number }>();
        },
      };
    });

    after(async () => {
      await formatter.close();
      await scratch.drop();
    });

    const changing = () => server.routes.filter((route) => route.method !== 'GET' && route.changes);

    it('has changes to sweep, so a silent zero is not a pass', () => {
      assert.ok(changing().length > 60, `only ${String(changing().length)} changing routes found`);
    });

    it('holds every route that writes nothing to a reason, in its own source', () => {
      const unexplained = changing()
        .filter((route) => route.audit !== undefined)
        .filter((route) =>
          route.audit?.kind === 'gap'
            ? !/^[A-Z]-\d+$/.test(route.audit.ticket)
            : route.audit?.kind === 'exempt' && route.audit.why.trim().length < 10,
        )
        .map((route) => `${route.method} ${route.url}`);
      assert.deepEqual(unexplained, [], 'a declaration with no ticket or no reason');
    });

    it('has no fixture for a route that is not in the sweep', () => {
      // A fixture left behind by a route that was removed, or that learnt to declare itself, is a
      // table drifting from the code; better to say so than to carry it.
      const swept = new Set(
        changing()
          .filter((route) => route.audit === undefined)
          .map((route) => `${route.method} ${route.url}`),
      );
      const stale = Object.keys(FIXTURES).filter((key) => !swept.has(key));
      assert.deepEqual(stale, [], 'fixtures for routes the sweep does not call');
    });

    it('records an audit entry for every change that does not say why not', async () => {
      const problems: string[] = [];
      const count = async (): Promise<number> =>
        Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log'))[0]?.n);

      for (const route of changing()) {
        if (route.audit !== undefined) continue;
        const key = `${route.method} ${route.url}`;
        const fixture = FIXTURES[key];
        if (fixture === undefined) {
          problems.push(`${key}: no fixture — write one, or declare why it is not audited`);
          continue;
        }
        let call: Call;
        try {
          call = await fixture(kit);
        } catch (error) {
          problems.push(`${key}: the fixture could not arrange it — ${String(error)}`);
          continue;
        }
        const before = await count();
        const response = await app.inject({
          method: route.method as 'POST',
          url: call.url,
          headers: { cookie: kit.cookie, ...call.headers },
          ...(call.payload === undefined ? {} : { payload: call.payload as never }),
        });
        if (response.statusCode >= 300) {
          problems.push(
            `${key}: answered ${String(response.statusCode)} — ${response.body.slice(0, 200)}`,
          );
          continue;
        }
        if ((await count()) <= before) problems.push(`${key}: succeeded and wrote no audit entry`);
      }
      assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`);
    });

    it('never records the secret it was handed', async () => {
      // Every row this file caused, including the credential it planted, as text.
      const leaked = await db.query<{ action: string }>(
        `SELECT action FROM audit_log
       WHERE summary::text LIKE '%' || $1 || '%' OR diff::text LIKE '%' || $1 || '%'`,
        [PLANTED_SECRET],
      );
      assert.deepEqual(leaked, []);
      // And the plant happened, so the absence above means something.
      const planted = await db.query(`SELECT 1 FROM audit_log WHERE action = 'credential.set'`);
      assert.ok(planted.length > 0, 'no credential was set, so the redaction check proved nothing');
    });
  },
);
