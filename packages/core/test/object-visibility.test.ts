import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
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
import { DeliveryHealthReader } from '../src/notifications/health.js';
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
import { MapService } from '../src/maps/service.js';
import { MapResolver } from '../src/maps/resolver.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import { StateBroadcaster } from '../src/state/stream.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * `A-12`'s exit criterion, as a sweep: **an account granted one branch, with `none` everywhere
 * else, learns nothing outside it through any route that returns many objects.**
 *
 * Shaped like `A-10`'s credential sweep in `access-matrix.test.ts`, and for the same reason: a
 * list of "routes that might leak an object" goes stale on the day somebody adds a route, which is
 * the day it was supposed to catch something. So every object outside the branch carries a
 * marker in its name — and the hidden sensors carry one in their failure messages — and *every
 * registered `GET`* is called as the branch account, with every id the account can see, bare and
 * with each query parameter a listing takes. No answer may contain the marker. The stream is
 * swept the same way, over a real WebSocket.
 *
 * **Outside means the containers above the branch too.** The root and the probe the branch hangs
 * under carry the marker, because their names are exactly what a breadcrumb, an alarm's path or
 * a scrape would hand over if the rule stopped at siblings.
 *
 * **The fixture is adversarial on purpose**: a hole carved inside the branch, a grant re-opening
 * the hole one level down, a device whose only child is carved out, a trigger defined on the
 * hidden probe and inherited by a visible sensor, a pause inherited from a hidden device, a
 * dependency on a hidden master, a template used by a hidden trigger, a rediscovery schedule and
 * a discovery run in a hidden group, a map naming both sides. Each is a way a hidden object's name
 * has reached a visible one somewhere in this codebase.
 *
 * Reports are the one module not registered, and it is stated rather than forgotten: a report
 * renders through its `runAs` account by design (`administration.md`), so what it shows is that
 * account's view and not the caller's. `A-13` is the hole in how that account is chosen.
 */

const available = await databaseAvailable();

/** In the name of every object the branch account must not learn about. */
const MARK = 'zzz-outside';

describe('what a branch account can see', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let server: ApiServer;
  let access: AccessService;
  let groups: GroupService;
  let harness: Harness;
  let stream: StateBroadcaster;

  let teamId = 0;
  let probeId = 0;
  let branchId = 0;
  let deviceId = 0;
  let pingId = 0;
  let heldId = 0;
  let carvedSensorId = 0;
  let carvedDeviceId = 0;
  let underCarveId = 0;
  let regrantedId = 0;
  let lonelyDeviceId = 0;
  let lonelySensorId = 0;
  let otherGroupId = 0;
  let otherDeviceId = 0;
  let otherSensorId = 0;
  let templateId = 0;
  let mapId = 0;
  let libraryId = 0;
  let shareToken = 'none';
  let hiddenLibraryId = 0;
  let visibleRunId = 0;
  let hiddenRunId = 0;

  const cookies = new Map<string, string>();

  /** The visible objects, by name, so an answer can be checked for what it *should* contain. */
  const VISIBLE = ['Customer A', 'a-web01', 'a-ping', 'a-held', 'a-regranted', 'a-lonely'];

  before(async () => {
    scratch = await createScratchDatabase('visibility');
    db = scratch.db;
    harness = await buildHarness(db, { states: true });

    const accounts = new AccountService({ db, logger: silent });
    access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
    groups = new GroupService({ db, logger: silent });
    stream = new StateBroadcaster({ logger: silent });

    const discovery = new DiscoveryService({
      db,
      logger: silent,
      dispatch: () => ({ kind: 'sent' }),
    });
    const triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });
    const rediscovery = new RediscoveryService({
      db,
      logger: silent,
      discovery,
      windowFor: () => Promise.resolve(null),
      provision: () => Promise.resolve(),
    });
    const contexts = new MessageContextLoader({
      settings: harness.resolver,
      publicUrl: 'https://monitoring.example.test',
      siteName: 'visibility',
    });
    const templates = new TemplateService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silent,
      contexts,
    });
    const history = new HistoryService({ db, logger: silent });
    const maps = new MapService({
      db,
      repository: new MapRepository(),
      audit: new DatabaseAuditSink(),
      logger: silent,
    });
    const libraries = new LibraryService({
      db,
      repository: new LibraryRepository(),
      audit: new DatabaseAuditSink(),
      logger: silent,
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
      // **Every module that registers a `GET`**, because a route whose module is missing here is
      // a route this sweep never calls — the lesson `R07` wrote into the access matrix.
      triggers,
      templates,
      schedules: new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent }),
      discovery,
      rediscovery,
      provision: () =>
        Promise.resolve({
          devicesCreated: 0,
          matched: 0,
          sensorsCreated: 0,
          sensorsSkipped: 0,
          mastersSet: 0,
          problems: [],
          devices: [],
        }),
      deviceTemplates: new DeviceTemplateCatalogue(() => true),
      probeRegistry: new ProbeRegistry({ db, logger: silent, enrolmentKeys: ['visibility-key'] }),
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
        contexts,
        transports: [],
        audit: new DatabaseAuditSink(),
      }),
      maps,
      mapResolver: new MapResolver({ db, access, history }),
      libraries,
      stream,
      deliveryHealth: new DeliveryHealthReader(),
      // Registered so the routes exist and are swept; an absent service answers 503, which is
      // after the bar and so still proves the bar.
      coreHealth: () => undefined,
      probeHealth: () => undefined,
      metrics: () => undefined,
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

    // ── the tree ────────────────────────────────────────────────────────────────────────────
    await db.query('UPDATE object SET name = $1 WHERE parent_id IS NULL', [`${MARK}-root`]);
    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await harness.service.create(testActor, input as never)).id;

    probeId = await create({ kind: 'probe', parentId: harness.rootId, name: `${MARK}-probe` });
    branchId = await create({ kind: 'group', parentId: probeId, name: 'Customer A' });
    deviceId = await create({
      kind: 'device',
      parentId: branchId,
      name: 'a-web01',
      host: '10.0.0.1',
    });
    pingId = await create({
      kind: 'sensor',
      parentId: deviceId,
      name: 'a-ping',
      sensorType: 'icmp.ping',
    });
    heldId = await create({
      kind: 'sensor',
      parentId: deviceId,
      name: 'a-held',
      sensorType: 'icmp.ping',
    });
    carvedSensorId = await create({
      kind: 'sensor',
      parentId: deviceId,
      name: `${MARK}-carved-sensor`,
      sensorType: 'icmp.ping',
    });
    carvedDeviceId = await create({
      kind: 'device',
      parentId: branchId,
      name: `${MARK}-carved-device`,
      host: '10.0.0.2',
      tags: [`${MARK}-tag`],
    });
    underCarveId = await create({
      kind: 'sensor',
      parentId: carvedDeviceId,
      name: `${MARK}-under-carve`,
      sensorType: 'icmp.ping',
    });
    regrantedId = await create({
      kind: 'sensor',
      parentId: carvedDeviceId,
      name: 'a-regranted',
      sensorType: 'icmp.ping',
    });
    lonelyDeviceId = await create({
      kind: 'device',
      parentId: branchId,
      name: 'a-lonely',
      host: '10.0.0.3',
    });
    lonelySensorId = await create({
      kind: 'sensor',
      parentId: lonelyDeviceId,
      name: `${MARK}-lonely-sensor`,
      sensorType: 'icmp.ping',
    });
    otherGroupId = await create({ kind: 'group', parentId: probeId, name: `${MARK}-customer-b` });
    otherDeviceId = await create({
      kind: 'device',
      parentId: otherGroupId,
      name: `${MARK}-b-device`,
      host: '10.9.0.1',
    });
    otherSensorId = await create({
      kind: 'sensor',
      parentId: otherDeviceId,
      name: `${MARK}-b-sensor`,
      sensorType: 'icmp.ping',
    });

    // ── what hidden objects lend to visible ones ─────────────────────────────────────────────
    templateId = (
      await templates.create(testActor, {
        name: 'On-call',
        method: 'email',
        settings: {},
        subject: '%sensor on %device is %status',
        // `%probe` names the container above the branch: a preview against a visible sensor
        // renders it, which is the preview route's own leak to find.
        body: '%lastmessage, via %probe in %group',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
      })
    ).id;
    // On the hidden probe, so every visible sensor inherits it and the template is used by it.
    await triggers.create(testActor, probeId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: templateId },
      enabled: true,
    });
    // A visible trigger too, so `used-by` has something it should list.
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: templateId },
      enabled: true,
    });
    // A visible sensor whose master is hidden: held while the master is Down, and neither the
    // pause view nor the state history it writes may say what the master is called.
    await harness.service.setDependency(testActor, heldId, 'object', otherSensorId, undefined);

    visibleRunId = (await discovery.start({ groupId: branchId, probeId, range: '10.0.0.0/30' })).id;
    hiddenRunId = (await discovery.start({ groupId: otherGroupId, probeId, range: '10.9.0.0/30' }))
      .id;
    await rediscovery.create({
      groupId: otherGroupId,
      probeId,
      name: `${MARK}-rediscovery`,
      range: '10.9.0.0/30',
      cadence: 'daily',
    });

    // ── the account, and exactly one branch granted to it ────────────────────────────────────
    teamId = (await groups.create({ name: 'Customer A team' })).id;
    for (const [login, role] of [
      ['branch', 'readonly'],
      // The same grants as `branch`, for the tests after the sweep: the limit is per account,
      // and the sweep spends most of a window's worth on its own.
      ['watcher', 'readonly'],
      ['operator', 'readwrite'],
      ['admin', 'admin'],
    ] as const) {
      const account = await accounts.create({ login, password: 'correct-horse-battery', role });
      if (role === 'admin') {
        const admins = (await groups.list()).find((g) => g.isAdmin);
        assert.ok(admins);
        await groups.addMember(admins.id, account.id);
      } else {
        await groups.addMember(teamId, account.id);
      }
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login, password: 'correct-horse-battery' },
      });
      assert.equal(response.statusCode, 200, `${login} could not log in`);
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      cookies.set(login, header.split(';')[0] ?? '');
    }

    // A map naming both sides, made by the team's operator — a read-only account may not create
    // one (`A-14`) — and so granted to the team, which is how the branch account reads it.
    const operator = (await accounts.list()).find((account) => account.login === 'operator');
    assert.ok(operator);
    mapId = (
      await maps.create(
        { userId: operator.id, role: 'readwrite' },
        { name: 'Customer A wall' },
        actorNamed('operator'),
      )
    ).id;
    // **Its tiles written straight into the row**, one on the branch and one on a hidden sensor:
    // the way a map saved before `A-22` holds them. Saving the second through the service is
    // refused now (and the grants that let the first through are `beforeEach`'s, not yet made);
    // the views still have to hide it, the signed-in one and the public one alike.
    await db.query(`UPDATE map SET layout = $2::jsonb WHERE id = $1`, [
      mapId,
      JSON.stringify({
        widgets: [
          {
            id: 'list',
            kind: 'sensor-list',
            objectId: branchId,
            title: 'Everything of ours',
            box: { x: 0, y: 0, w: 4, h: 3 },
          },
          {
            id: 'theirs',
            kind: 'status',
            objectId: otherSensorId,
            title: 'Somebody else',
            box: { x: 4, y: 0, w: 4, h: 3 },
          },
        ],
      }),
    ]);
    // And shared, by the operator who holds `full` on it: the public view is the operator's view
    // (`A-22`), so it may name the branch and nothing outside it.
    shareToken = (
      await maps.createShare(
        { userId: operator.id, role: 'readwrite' },
        mapId,
        { label: 'wall', expiresAt: new Date(Date.now() + 86_400_000) },
        actorNamed('operator'),
      )
    ).token;

    // Two libraries (`L-01`): the team's, which the operator's primary group is granted by making
    // it, and an administrator's the team was never given — marked, so the sweep sees it if any
    // listing or refusal hands it over.
    const rule = (roots: number[]) => ({ roots, types: [], tags: [], states: [] });
    libraryId = (
      await libraries.create({ userId: operator.id, role: 'readwrite' }, testActor, {
        name: 'Customer A library',
        nodes: [{ id: 'ours', name: 'Ours', rule: rule([branchId]), children: [] }],
      })
    ).id;
    const admin = (await accounts.list()).find((account) => account.login === 'admin');
    assert.ok(admin);
    hiddenLibraryId = (
      await libraries.create({ userId: admin.id, role: 'admin' }, testActor, {
        name: `${MARK}-library`,
        nodes: [{ id: 'theirs', name: `${MARK}-node`, rule: rule([otherGroupId]), children: [] }],
      })
    ).id;
  });

  after(async () => {
    await app.close();
    await scratch.drop();
  });

  /**
   * One branch granted, one hole carved in it, one grant re-opening the hole below — and `write`
   * on one device inside it, which is a boundary with a visible parent: not where a tree starts,
   * and what lets the operator's dependency request reach the check on the master.
   */
  beforeEach(async () => {
    await db.query('DELETE FROM object_access');
    await access.grant(branchId, teamId, 'read', actorNamed('visibility'));
    await access.grant(deviceId, teamId, 'write', actorNamed('visibility'));
    await access.grant(carvedSensorId, teamId, 'none', actorNamed('visibility'));
    await access.grant(carvedDeviceId, teamId, 'none', actorNamed('visibility'));
    await access.grant(regrantedId, teamId, 'read', actorNamed('visibility'));
    await access.grant(lonelySensorId, teamId, 'none', actorNamed('visibility'));
  });

  const as = (login: string) => ({ cookie: cookies.get(login) ?? '' });

  // ── state, written the way ingestion writes it, published after the commit ────────────────
  const publishing: Promise<unknown>[] = [];
  let clock = 0;

  const HIDDEN_SENSORS = (): number[] => [
    carvedSensorId,
    underCarveId,
    lonelySensorId,
    otherSensorId,
  ];

  /** One check result per sensor, through the state machine, published after it commits. */
  async function report(sensors: readonly number[], ok: boolean): Promise<void> {
    const states = harness.states;
    assert.ok(states !== undefined);
    // Always later than the last, and never behind the wall clock: a pause or a resume is stamped
    // with now, and a result stamped before it would be a result about the past.
    clock = Math.max(clock + 1_000, Date.now());
    const at = new Date(clock);
    const decisions = await states.decide(
      sensors.map((sensorId) => ({
        sensorId,
        at,
        outcome: ok ? ('ok' as const) : ('error' as const),
        // The marker only in the hidden sensors' messages: a visible sensor's message is its own.
        message: ok
          ? 'reachable'
          : `failure of ${String(sensorId)} ${HIDDEN_SENSORS().includes(sensorId) ? MARK : 'a-visible'}`,
        channels: null,
      })),
    );
    await db.tx(async (q) => {
      await writeStateHistory(q, decisions.transitions, (committed) => {
        publishing.push(stream.publish(db, committed));
      });
      await writeRuntimes(q, decisions.runtimes);
    });
    await Promise.all(publishing.splice(0));
  }

  /** Two failures, because one is a Warning under the default policy (`M-03`). */
  async function scan(sensors: readonly number[], ok: boolean): Promise<void> {
    await report(sensors, ok);
    if (!ok) await report(sensors, ok);
  }

  async function queueNotification(sensorId: number, message: string): Promise<void> {
    await db.query(
      `INSERT INTO notification_request
         (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message)
       VALUES (now(), $1, NULL, 'state', $2, 'initial', 'down', $3)`,
      [sensorId, templateId, message],
    );
  }

  describe('the sweep', () => {
    before(async () => {
      // Everything down, the hidden ones with the marker in their messages, and a notification
      // about each — so the alarms, the state log, the notification log, the snapshot and the
      // map all have a hidden row to leak.
      await report([heldId], true);
      await scan(
        [pingId, carvedSensorId, underCarveId, regrantedId, lonelySensorId, otherSensorId],
        false,
      );
      // The master is Down, so its dependent is held — which writes the dependent's history.
      const dependencies = harness.dependencies;
      assert.ok(dependencies !== undefined);
      await db.tx((q) => dependencies.recompute(q, new Date()));
      for (const id of [pingId, carvedSensorId, underCarveId, otherSensorId]) {
        await queueNotification(id, id === pingId ? 'a-visible' : `${MARK}-notified`);
      }
      // A pause on the hidden device, inherited by the sensor re-granted beneath it — so the
      // visible sensor's pause view has a hidden object to name as where its pause came from.
      //
      // **Its message is not marked, deliberately.** A pause's message is copied into the state of
      // every sensor it pauses and becomes that sensor's own history; it was written for the
      // people whose sensors it paused. What is outside the branch is the *object* it was set
      // on, and that is what the pause view must not name.
      await harness.service.pause(
        testActor,
        carvedDeviceId,
        { kind: 'indefinite' },
        'maintenance on the rack',
      );
    });

    after(async () => {
      await harness.service.resume(testActor, carvedDeviceId);
    });

    /** Every id this account can see, for whatever `:id` means on a route. */
    function idsFor(url: string): string[] {
      const path = url.replace('/api/v1', '');
      // A run in the hidden group too: that one has to be refused, and a refusal carries no name.
      if (path.startsWith('/discovery/:id')) return [String(visibleRunId), String(hiddenRunId)];
      if (path.startsWith('/templates/')) return [String(templateId)];
      if (path.startsWith('/maps/')) return [String(mapId)];
      // A library the team was given and one it was not; the second answers 404, and nothing else.
      if (path.startsWith('/libraries/')) return [String(libraryId), String(hiddenLibraryId)];
      if (path.startsWith('/schedules/')) return ['1'];
      if (path.startsWith('/lookups/')) return ['ms.sensor.state'];
      if (path.startsWith('/probes/')) return [String(probeId)];
      return [branchId, deviceId, pingId, heldId, regrantedId, lonelyDeviceId].map(String);
    }

    /**
     * The values to try for each query parameter a route declares.
     *
     * **Hidden ids as well as visible ones.** A scope naming an object outside the branch has to
     * be refused, and a projection under one (`asChildOf`) has to be too — so the sweep asks with
     * both, and neither answer may carry the marker.
     */
    function queryValues(name: string): string[] {
      const visible = [branchId, deviceId, pingId, heldId, regrantedId, lonelyDeviceId];
      const hidden = [harness.rootId, probeId, carvedDeviceId, carvedSensorId, otherGroupId];
      const ids = [...visible, ...hidden, otherSensorId].map(String);
      switch (name) {
        case 'objectId':
        case 'parentId':
        case 'asChildOf':
          return ids;
        case 'sensorId':
          return [pingId, regrantedId, carvedSensorId, otherSensorId].map(String);
        case 'groupId':
          return [branchId, otherGroupId, probeId].map(String);
        case 'include':
          // The detail routes' tokens, and the listing's: each refuses the other's as unknown.
          return ['ancestors,settings,credentials,channels', 'path'];
        case 'effective':
          // One key — a list is `effective=` repeated — and the one whose value is an object.
          return ['dependency.masterId'];
        case 'limit':
          return ['500'];
        case 'maxDepth':
          return ['20'];
        default:
          return [];
      }
    }

    /**
     * Every URL to call for one registered route: bare, and once per value of each query parameter
     * its schema declares — read from the OpenAPI document, so a parameter added tomorrow is swept
     * tomorrow, and a route is never sent one it would refuse as unknown.
     */
    function urlsFor(url: string, openapi: OpenApi): string[] {
      const declared = (openapi.paths[url.replace(/:([A-Za-z]+)/g, '{$1}')]?.get?.parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name);
      const queries = [
        '',
        ...declared.flatMap((name) => queryValues(name).map((v) => `?${name}=${v}`)),
      ];
      const filled = idsFor(url).map((id) =>
        url
          .replaceAll(':id', id)
          .replaceAll(':templateId', 'ms.linux')
          .replaceAll(':token', shareToken),
      );
      return [...new Set(filled)].flatMap((one) => queries.map((query) => `${one}${query}`));
    }

    it('has every module that lists registered, so a silent zero is not a pass', () => {
      const swept = new Set(server.routes.map((route) => `${route.method} ${route.url}`));
      const missing = [
        'GET /api/v1/objects',
        'GET /api/v1/objects/tops',
        'GET /api/v1/objects/:id/tree',
        'GET /api/v1/objects/:id/counts',
        'GET /api/v1/objects/:id/ancestors',
        'GET /api/v1/alarms',
        'GET /api/v1/state-log',
        'GET /api/v1/stream',
        'GET /api/v1/notification-requests',
        'GET /api/v1/templates/:id/used-by',
        'GET /api/v1/maps/:id/view',
        'GET /api/v1/public/maps/:token',
        'GET /api/v1/libraries',
        'GET /api/v1/discovery/schedules',
        'GET /api/v1/probes',
        'GET /metrics',
      ].filter((route) => !swept.has(route));
      assert.deepEqual(missing, [], 'these routes are not being swept — is a module unwired?');
    });

    it('never names an object outside the branch, on any GET route', async () => {
      const openapi = app.swagger() as unknown as OpenApi;
      const leaked: string[] = [];
      const throttled: string[] = [];
      const answered = new Set<string>();
      let bodies = '';
      let calls = 0;
      for (const route of server.routes) {
        if (route.method !== 'GET' || route.url.endsWith('/stream')) continue;
        for (const url of urlsFor(route.url, openapi)) {
          const response = await app.inject({ method: 'GET', url, headers: as('branch') });
          calls += 1;
          if (response.statusCode === 429) throttled.push(url);
          if (response.statusCode === 200) {
            answered.add(route.url);
            bodies += response.body;
          }
          const at = response.body.indexOf(MARK);
          // One per route, with what surrounds the marker: which field carried it is the
          // diagnosis, and forty variants of one URL are not forty findings.
          if (at >= 0 && !leaked.some((one) => one.startsWith(`${route.url} `))) {
            leaked.push(
              `${route.url} (${url}): ${response.body.slice(Math.max(0, at - 120), at + 40)}`,
            );
          }
        }
      }

      assert.deepEqual(leaked, [], 'these answers told a branch account about objects outside it');
      // A throttled request answered nothing, so it proved nothing: the sweep has to fit inside
      // the per-account limit (`hardening.ts`), or it is quietly skipping its own tail.
      assert.deepEqual(
        throttled.slice(0, 5),
        [],
        `${String(throttled.length)} of ${String(calls)} throttled`,
      );
      // **Not a sweep of refusals.** The routes that list must have answered, and between them
      // named every object the account can see — otherwise a build that refused everything, or
      // filtered everything away, would pass.
      assert.ok(answered.size > 25, `only ${String(answered.size)} GET routes answered 200`);
      for (const name of VISIBLE) assert.ok(bodies.includes(name), `nothing ever named ${name}`);
      assert.ok(bodies.includes('Customer A library'), 'the team’s own library was never listed');
    });

    it('publishes through a share link only what the link’s maker can see (A-22)', async () => {
      // The sweep above reads the operator's link to a map that names a hidden sensor — written
      // into the row as a map from before `A-22` would hold it — and finds nothing outside the
      // branch. The control: an administrator's link to the very same map does name it, so the
      // difference is whose link it is, not what the map says.
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const shared = await app.inject({
        method: 'POST',
        url: `/api/v1/maps/${String(mapId)}/shares`,
        headers: as('admin'),
        payload: { label: 'the admin’s wall', expiresAt },
      });
      assert.equal(shared.statusCode, 201, shared.body);
      const publicView = (token: string) =>
        app.inject({ method: 'GET', url: `/api/v1/public/maps/${token}` });
      const theirs = await publicView(shared.json<{ token: string }>().token);
      assert.equal(theirs.statusCode, 200);
      assert.ok(theirs.body.includes(MARK), 'an administrator’s link names the hidden sensor');
      const ours = await publicView(shareToken);
      assert.equal(ours.statusCode, 200);
      assert.ok(!ours.body.includes(MARK), 'the operator’s link names the hidden sensor');
      assert.ok(ours.body.includes('a-ping'), 'and it still shows the branch');

      // **On save**, a widget the layout adds must be on an object the saver can read — refused
      // in the same words for a hidden object and for an id never issued, so a save is not the
      // existence oracle `A-15` closed on the view.
      const tile = (objectId: number) => ({
        id: `on-${String(objectId)}`,
        kind: 'status',
        objectId,
        title: 'A tile',
        box: { x: 0, y: 4, w: 4, h: 3 },
      });
      const current = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(mapId)}`,
        headers: as('operator'),
      });
      const map = current.json<{ version: number; layout: { widgets: unknown[] } }>();
      const save = (widgets: unknown[], version = map.version) =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/maps/${String(mapId)}`,
          headers: { ...as('operator'), 'if-match': String(version) },
          payload: { layout: { widgets } },
        });
      // Hidden ids the map does not name yet — `otherSensorId` is already on it, so it is not one
      // the layout adds — and an id never issued.
      const refusals = [];
      for (const objectId of [lonelySensorId, carvedSensorId, 2_000_000_000]) {
        const refused = await save([...map.layout.widgets, tile(objectId)]);
        assert.equal(refused.statusCode, 403, `a tile on ${String(objectId)} was saved`);
        refusals.push(refused.json<{ error: { message: string } }>().error.message);
      }
      assert.equal(new Set(refusals).size, 1, 'a hidden object and a missing one read differently');
      // A new tile on something the operator can see is saved, and the hidden tile already on
      // the map is kept: a map with a stale tile has to stay saveable.
      const saved = await save([...map.layout.widgets, tile(pingId)]);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.ok(saved.body.includes(String(otherSensorId)), 'the stored tile was dropped');
    });

    it('acknowledges and forces only what the caller can see beneath it (A-24)', async () => {
      // The operator holds `write` on the device, and a sensor beneath it is carved `none`. An
      // acknowledgement or a simulated error on the device used to reach that sensor too: a
      // write into a branch the operator was never shown, and an answer about what is in it.
      const runtimeOf = async (sensorId: number) =>
        (
          await db.query<{ state: string; simulated: boolean }>(
            `SELECT state::text AS state, simulated_error AS simulated
             FROM sensor_runtime WHERE object_id = $1`,
            [sensorId],
          )
        )[0];
      assert.equal((await runtimeOf(carvedSensorId))?.state, 'down', 'the fixture’s hole is Down');
      assert.equal((await runtimeOf(pingId))?.state, 'down');

      const device = `/api/v1/objects/${String(deviceId)}`;
      const acknowledged = await app.inject({
        method: 'POST',
        url: `${device}/acknowledge`,
        headers: as('operator'),
        payload: { message: 'on it' },
      });
      assert.equal(acknowledged.statusCode, 200, acknowledged.body);
      const view = acknowledged.json<{ acknowledged: number[]; refused: number[] }>();
      assert.deepEqual(view.acknowledged, [pingId]);
      assert.deepEqual(view.refused, []);
      assert.equal((await runtimeOf(carvedSensorId))?.state, 'down', 'the hole was acknowledged');
      const cleared = await app.inject({
        method: 'DELETE',
        url: `${device}/acknowledge`,
        headers: as('operator'),
      });
      assert.equal(cleared.statusCode, 200, cleared.body);

      const forced = await app.inject({
        method: 'POST',
        url: `${device}/simulate-error`,
        headers: as('operator'),
        payload: { message: 'drill' },
      });
      assert.equal(forced.statusCode, 200, forced.body);
      assert.ok(!forced.json<{ sensors: number[] }>().sensors.includes(carvedSensorId));
      assert.equal((await runtimeOf(carvedSensorId))?.simulated, false, 'the hole was forced');
      const unforced = await app.inject({
        method: 'DELETE',
        url: `${device}/simulate-error`,
        headers: as('operator'),
      });
      assert.equal(unforced.statusCode, 200, unforced.body);

      // **The refusal is not an oracle either.** A device whose only Down sensor is hidden reads
      // exactly as one with nothing Down — the operator is given `write` on it for this, so that
      // it is the hole and not the right that decides.
      await access.grant(lonelyDeviceId, teamId, 'write', actorNamed('visibility'));
      const lonely = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(lonelyDeviceId)}/acknowledge`,
        headers: as('operator'),
        payload: { message: 'on it' },
      });
      assert.notEqual(lonely.statusCode, 200, 'the hidden sensor was acknowledged');
      assert.equal(
        lonely.json<{ error: { message: string } }>().error.message,
        'nothing here is Down to acknowledge',
      );
      assert.equal((await runtimeOf(lonelySensorId))?.state, 'down');
    });

    it('shows an administrator everything, so the markers are reachable', async () => {
      // The control: the same routes, as somebody who may see it all, do name the hidden objects.
      // Without this the sweep above would pass on a fixture whose markers nothing returns.
      for (const url of [
        '/api/v1/objects?limit=500',
        '/api/v1/alarms',
        '/api/v1/state-log',
        '/api/v1/notification-requests',
        `/api/v1/objects/${String(pingId)}/ancestors`,
        `/api/v1/objects/${String(pingId)}/triggers`,
        `/api/v1/objects/${String(heldId)}/pause`,
        `/api/v1/objects/${String(regrantedId)}/pause`,
        `/api/v1/templates/${String(templateId)}/preview?sensorId=${String(pingId)}`,
        `/api/v1/templates/${String(templateId)}/used-by`,
        `/api/v1/maps/${String(mapId)}/view`,
        '/api/v1/libraries',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: as('admin') });
        assert.equal(response.statusCode, 200, url);
        assert.ok(response.body.includes(MARK), `${url} named nothing hidden even to an admin`);
      }

      // The hold really happened, and what it wrote in the dependent's history is the master's id.
      const held = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(heldId)}/state`,
        headers: as('admin'),
      });
      const state = held.json<{ state: string; cause: string; message: string }>();
      assert.deepEqual(
        { state: state.state, cause: state.cause, message: state.message },
        {
          state: 'paused',
          cause: 'dependency',
          message: `master #${String(otherSensorId)} is Down`,
        },
      );
    });

    it('streams nothing outside the branch, in the snapshot or live', async () => {
      const socket = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      const frames: string[] = [];
      socket.on('message', (raw: Buffer) => {
        frames.push(raw.toString('utf8'));
      });
      try {
        const next = (type: string, from = 0): Promise<Record<string, unknown>> =>
          waitFor(socket, frames, type, from);

        socket.send(JSON.stringify({ subscribe: {} }));
        const snapshot = await next('snapshot');
        const entries = snapshot['entries'] as { sensorId: number; path: number[] }[];
        assert.deepEqual(
          entries.map((entry) => entry.sensorId).sort((a, b) => a - b),
          [pingId, heldId, regrantedId].sort((a, b) => a - b),
          'the snapshot is the three sensors the account can see',
        );
        for (const entry of entries) {
          assert.ok(!entry.path.includes(probeId), 'a path named the hidden probe');
          assert.ok(!entry.path.includes(harness.rootId), 'a path named the hidden root');
        }

        // Live: every sensor recovers, hidden and visible together, in one committed batch.
        const mark = frames.length;
        await scan([otherSensorId, carvedSensorId, underCarveId, lonelySensorId, pingId], true);
        await next('state', mark);

        // A subscription to an object it cannot see is refused, not served partially.
        const refusedAt = frames.length;
        socket.send(JSON.stringify({ subscribe: { objectId: probeId } }));
        const refused = await next('problem', refusedAt);
        assert.match(String(refused['reason']), /may not read/);
        // And in the words an id that names nothing gets, so the refusal is not a way to learn
        // which ids exist outside the branch.
        const absentAt = frames.length;
        socket.send(JSON.stringify({ subscribe: { objectId: 2_000_000_000 } }));
        assert.deepEqual(await next('problem', absentAt), refused);

        const leaked = frames.filter((frame) => frame.includes(MARK));
        assert.deepEqual(leaked, [], 'the stream carried something outside the branch');
        const states = frames
          .slice(mark)
          .map((frame) => JSON.parse(frame) as Record<string, unknown>)
          .filter((frame) => frame['type'] === 'state');
        assert.deepEqual(
          states.map((frame) => frame['sensorId']),
          [pingId],
          'only the visible sensor’s change was streamed',
        );
      } finally {
        socket.terminate();
      }
    });

    it('numbers only what it sends, so a change it hides leaves no gap (A-21)', async () => {
      // The branch account and an administrator watch the same window: a visible change, three
      // hidden ones, the visible sensor again. A process-wide counter put the hidden three in the
      // branch socket's sequence as a gap — how many changes, and when, outside its branch.
      const watch = async (login: string) => {
        const frames: Record<string, unknown>[] = [];
        // Listening from before the upgrade, or `hello` is gone before anybody hears it.
        const socket = await app.injectWS(
          '/api/v1/stream',
          { headers: as(login) },
          {
            onInit: (ws) => {
              ws.on('message', (raw: Buffer) => {
                frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
              });
            },
          },
        );
        socket.send(JSON.stringify({ subscribe: {} }));
        const states = () => frames.filter((frame) => frame['type'] === 'state');
        return { socket, frames, states };
      };
      const until = async (done: () => boolean): Promise<void> => {
        for (let i = 0; i < 300 && !done(); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(done(), 'the stream did not deliver in time');
      };
      const hidden = [otherSensorId, carvedSensorId, lonelySensorId];
      const branch = await watch('watcher');
      const admin = await watch('admin');
      try {
        const snapshotOf = (frames: Record<string, unknown>[]) =>
          frames.find((frame) => frame['type'] === 'snapshot');
        await until(() => snapshotOf(branch.frames) !== undefined);
        await until(() => snapshotOf(admin.frames) !== undefined);
        for (const { frames } of [branch, admin]) {
          assert.deepEqual(frames[0], { type: 'hello', seq: 0, protocol: 1 });
          assert.equal(snapshotOf(frames)?.['seq'], 0, 'nothing was sent before the snapshot');
        }

        await scan([pingId], false);
        await scan(hidden, false);
        await scan([pingId], true);
        const recovered = (frames: Record<string, unknown>[]) =>
          frames.some((frame) => frame['sensorId'] === pingId && frame['state'] === 'up');
        await until(() => recovered(branch.frames) && recovered(admin.frames));

        const seqs = (states: Record<string, unknown>[]) => states.map((frame) => frame['seq']);
        const counted = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
        const mine = branch.states();
        assert.ok(mine.every((frame) => frame['sensorId'] === pingId));
        assert.deepEqual(seqs(mine), counted(mine.length), 'the branch socket’s count has a gap');
        // The control: the hidden changes did happen in that window, and were numbered — on the
        // one socket allowed to see them.
        const all = admin.states();
        assert.ok(all.some((frame) => hidden.includes(frame['sensorId'] as number)));
        assert.deepEqual(seqs(all), counted(all.length));
        assert.ok(all.length > mine.length);

        // Across a second subscription the count carries on rather than starting again, so a
        // client never sees a number twice on one socket.
        const before = mine.length;
        branch.socket.send(JSON.stringify({ subscribe: {} }));
        await until(() => branch.frames.filter((frame) => frame['type'] === 'snapshot').length > 1);
        assert.equal(branch.frames.at(-1)?.['seq'], before);
        await scan([pingId], false);
        await until(() => branch.states().length > before);
        assert.equal(branch.states()[before]?.['seq'], before + 1);
      } finally {
        await scan([...hidden, pingId], true);
        branch.socket.terminate();
        admin.socket.terminate();
      }
    });
  });

  describe('absent, not counted', () => {
    it('pages the object list over what the account can see, with no short page mid-way', async () => {
      // Filtering after the query is the failure the ticket names: 37 rows for `limit=100` and a
      // cursor that skips. Two at a time over the whole visible set, every page but the last full.
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects?limit=2&sort=id${query}`,
          headers: as('watcher'),
        });
        assert.equal(response.statusCode, 200);
        const page = response.json<{ items: { id: number }[]; nextCursor: string | null }>();
        cursor = page.nextCursor;
        if (cursor !== null) assert.equal(page.items.length, 2, 'a short page before the end');
        seen.push(...page.items.map((item) => item.id));
        pages += 1;
      } while (cursor !== null && pages < 20);

      assert.deepEqual(
        seen.sort((a, b) => a - b),
        [branchId, deviceId, pingId, heldId, regrantedId, lonelyDeviceId].sort((a, b) => a - b),
      );
    });

    it('counts a subtree without its holes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(branchId)}/counts`,
        headers: as('watcher'),
      });
      assert.equal(response.statusCode, 200);
      const counts = response.json<{ objects: { device: number; sensor: number } }>();
      assert.deepEqual(
        { devices: counts.objects.device, sensors: counts.objects.sensor },
        { devices: 2, sensors: 3 },
        'a-web01 and a-lonely; a-ping, a-held and a-regranted — nothing carved out',
      );

      // And the overview's totals, over everything the account can see: the same five, with the
      // re-granted sensor counted once although it is both a top and inside the branch.
      const everything = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/counts',
        headers: as('watcher'),
      });
      assert.equal(everything.statusCode, 200);
      const totals = everything.json<{ objects: Record<string, number> }>().objects;
      assert.deepEqual(
        { groups: totals['group'], devices: totals['device'], sensors: totals['sensor'] },
        { groups: 1, devices: 2, sensors: 3 },
      );
      assert.equal(totals['probe'], 0, 'the probe above the branch is not counted');
    });

    it('says an object with only hidden children has none', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(branchId)}`,
        headers: as('watcher'),
      });
      const lonely = list
        .json<{ items: { id: number; hasChildren: boolean }[] }>()
        .items.find((item) => item.id === lonelyDeviceId);
      assert.equal(lonely?.hasChildren, false, 'a disclosure triangle onto a hole');

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: as('watcher'),
      });
      assert.equal(
        detail.json<{ childCount: number }>().childCount,
        2,
        'a-ping and a-held, not their carved sibling',
      );
    });

    it('totals and counts only the alarms the account can see', async () => {
      await scan([pingId, carvedSensorId, otherSensorId, regrantedId], false);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/alarms',
        headers: as('watcher'),
      });
      const page = response.json<{
        items: { sensorId: number; pathNames: string[] }[];
        total: number;
        counts: Record<string, number>;
      }>();
      assert.deepEqual(
        page.items.map((item) => item.sensorId).sort((a, b) => a - b),
        [pingId, regrantedId].sort((a, b) => a - b),
      );
      assert.equal(page.total, 2);
      assert.equal(page.counts['down'], 2);
      // The path starts at the branch: the probe and the root above it are outside.
      const ping = page.items.find((item) => item.sensorId === pingId);
      assert.deepEqual(ping?.pathNames, ['Customer A', 'a-web01', 'a-ping']);
      // A hole in the middle of a path: the re-granted sensor's device is hidden, and skipped.
      const regranted = page.items.find((item) => item.sensorId === regrantedId);
      assert.deepEqual(regranted?.pathNames, ['Customer A', 'a-regranted']);
    });

    it('refuses a scope naming an object outside the branch', async () => {
      for (const url of [
        `/api/v1/alarms?objectId=${String(probeId)}`,
        `/api/v1/state-log?objectId=${String(probeId)}`,
        `/api/v1/objects?parentId=${String(probeId)}`,
        `/api/v1/notification-requests?sensorId=${String(otherSensorId)}`,
        `/api/v1/discovery/schedules?groupId=${String(otherGroupId)}`,
        `/api/v1/discovery/${String(hiddenRunId)}`,
        `/api/v1/objects/${String(pingId)}/settings?asChildOf=${String(probeId)}`,
        `/api/v1/templates/${String(templateId)}/preview?sensorId=${String(otherSensorId)}`,
        '/api/v1/objects/root',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: as('watcher') });
        assert.equal(response.statusCode, 403, url);
      }

      // And a write that would read one through a visible object: depending on a hidden master
      // would report its outages, by pausing the dependent, to somebody refused sight of it.
      const depend = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(pingId)}/dependency`,
        headers: { ...as('operator'), 'content-type': 'application/json' },
        payload: { mode: 'object', masterId: otherSensorId },
      });
      assert.equal(depend.statusCode, 403, depend.body);
    });

    it('starts the account’s tree at the branch', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/tops',
        headers: as('watcher'),
      });
      assert.deepEqual(
        response
          .json<{ items: { id: number }[] }>()
          .items.map((item) => item.id)
          .sort((a, b) => a - b),
        [branchId, regrantedId].sort((a, b) => a - b),
        'the branch, and the sensor re-granted inside a hole whose container is hidden — not a-web01, ' +
          'granted on its own but under a visible parent',
      );

      const admin = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/tops',
        headers: as('admin'),
      });
      assert.deepEqual(
        admin.json<{ items: { id: number }[] }>().items.map((item) => item.id),
        [harness.rootId],
      );
    });
  });

  describe('grants change while sockets stay open', () => {
    it('sends a socket back to the start when its view changes, and not otherwise', async () => {
      const branch = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      const admin = await app.injectWS('/api/v1/stream', { headers: as('admin') });
      const branchFrames: string[] = [];
      const adminFrames: string[] = [];
      branch.on('message', (raw: Buffer) => branchFrames.push(raw.toString('utf8')));
      admin.on('message', (raw: Buffer) => adminFrames.push(raw.toString('utf8')));
      try {
        branch.send(JSON.stringify({ subscribe: {} }));
        admin.send(JSON.stringify({ subscribe: {} }));
        await waitFor(branch, branchFrames, 'snapshot');
        await waitFor(admin, adminFrames, 'snapshot');

        // The branch is taken away while the socket is open, and then something in it changes.
        await access.grant(branchId, teamId, 'none', actorNamed('visibility'));
        const mark = branchFrames.length;
        await scan([pingId], true);

        const overflow = await waitFor(branch, branchFrames, 'overflow', mark);
        assert.match(String(overflow['reason']), /may see has changed/);
        assert.equal(
          branchFrames.slice(mark).some((frame) => frame.includes('"type":"state"')),
          false,
          'a change was streamed to a socket that may no longer see it',
        );

        // Subscribing again is the resync, and it takes a snapshot of the new view.
        const again = branchFrames.length;
        branch.send(JSON.stringify({ subscribe: {} }));
        const fresh = await waitFor(branch, branchFrames, 'snapshot', again);
        assert.deepEqual(
          (fresh['entries'] as { sensorId: number }[])
            .map((entry) => entry.sensorId)
            .sort((a, b) => a - b),
          [pingId, heldId, regrantedId].sort((a, b) => a - b),
          'only what was granted on its own survives the branch being taken away: a-web01 and a-regranted',
        );

        // The administrator's view did not change, so it was not disturbed.
        assert.equal(
          adminFrames.some((frame) => frame.includes('"type":"overflow"')),
          false,
          'a socket whose view did not change was sent back to the start',
        );
        assert.ok(stream.stats.resynced >= 1);
      } finally {
        branch.terminate();
        admin.terminate();
      }
    });
  });
});

/** As much of an OpenAPI document as the sweep reads: each path's declared query parameters. */
interface OpenApi {
  paths: Record<string, { get?: { parameters?: { in: string; name: string }[] } } | undefined>;
}

/** The first frame of this type at or after index `from`, however long it takes to arrive. */
function waitFor(
  socket: WebSocket,
  frames: readonly string[],
  type: string,
  from = 0,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      for (const frame of frames.slice(from)) {
        const parsed = JSON.parse(frame) as Record<string, unknown>;
        if (parsed['type'] === type) {
          resolve(parsed);
          return true;
        }
      }
      return false;
    };
    if (check()) return;
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`no ${type} frame; saw ${frames.slice(from).join(' | ')}`));
    }, 10_000);
    const onMessage = (): void => {
      // After the recorder pushed it: listeners run in registration order.
      setImmediate(() => {
        if (check()) {
          clearTimeout(timer);
          socket.off('message', onMessage);
        }
      });
    };
    socket.on('message', onMessage);
  });
}
