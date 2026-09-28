import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
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
import { StateBroadcaster, type SnapshotRead } from '../src/state/stream.js';
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
 * with each query parameter that can name an object — the others are named, as a limit, in
 * `UNSWEPT_QUERY_PARAMETERS`. Every route that computes rather than changes is called too, with a
 * body, since `A-23`. No answer may contain the marker. The stream is swept the same way, over a
 * real WebSocket.
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
  let hiddenRuleId = 0;
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

    const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
    access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
    groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
    stream = new StateBroadcaster({ logger: silent });

    const discovery = new DiscoveryService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silent,
      dispatch: () => ({ kind: 'sent' }),
    });
    const triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });
    const rediscovery = new RediscoveryService({
      db,
      audit: new DatabaseAuditSink(),
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
      probeRegistry: new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        enrolmentKeys: ['visibility-key'],
      }),
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
        tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
        totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
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
      // Unlike its visible siblings, so a template drafted from the device cannot fold it into
      // theirs as a duplicate and hide the leak `A-23` found.
      params: { count: 7 },
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

    visibleRunId = (
      await discovery.start({ groupId: branchId, probeId, range: '10.0.0.0/30' }, testActor)
    ).id;
    hiddenRunId = (
      await discovery.start({ groupId: otherGroupId, probeId, range: '10.9.0.0/30' }, testActor)
    ).id;
    hiddenRuleId = (
      await rediscovery.create(
        {
          groupId: otherGroupId,
          probeId,
          name: `${MARK}-rediscovery`,
          range: '10.9.0.0/30',
          cadence: 'daily',
        },
        testActor,
      )
    ).id;

    // ── the account, and exactly one branch granted to it ────────────────────────────────────
    teamId = (await groups.create({ name: 'Customer A team' }, testActor)).id;
    for (const [login, role] of [
      ['branch', 'readonly'],
      // The same grants as `branch`, for the tests after the sweep: the limit is per account,
      // and the sweep spends most of a window's worth on its own.
      ['watcher', 'readonly'],
      ['operator', 'readwrite'],
      ['admin', 'admin'],
    ] as const) {
      const account = await accounts.create(
        { login, password: 'correct-horse-battery', role },
        testActor,
      );
      if (role === 'admin') {
        const admins = (await groups.list()).find((g) => g.isAdmin);
        assert.ok(admins);
        await groups.addMember(admins.id, account.id, testActor);
      } else {
        await groups.addMember(teamId, account.id, testActor);
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
        // Not ids, but each selects by something a hidden object has — its name, its tag, its
        // address — so a filter applied beside the visibility condition rather than under it
        // would hand that object back (`A-23`).
        case 'q':
          return [MARK];
        case 'tag':
          return [`${MARK}-tag`];
        case 'host':
          return ['10.0.0.2', '10.9.0.1'];
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

    it('names the query parameters it calls with no value, as a limit and not a claim (A-23)', () => {
      // Every declared query parameter that `queryValues` has nothing for: the routes that declare
      // them are called bare and with the parameters it does know, and never with these.
      const openapi = app.swagger() as unknown as OpenApi;
      const declared = new Set<string>();
      for (const route of server.routes) {
        if (route.method !== 'GET') continue;
        for (const parameter of openapi.paths[route.url.replace(/:([A-Za-z]+)/g, '{$1}')]?.get
          ?.parameters ?? []) {
          if (parameter.in === 'query') declared.add(parameter.name);
        }
      }
      const unswept = [...declared].filter((name) => queryValues(name).length === 0).sort();
      assert.deepEqual(
        unswept,
        UNSWEPT_QUERY_PARAMETERS,
        'give a new parameter values in queryValues, or name it in UNSWEPT_QUERY_PARAMETERS ' +
          'with the reason it cannot name an object',
      );
    });

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

    /**
     * The bodies to send a route that computes rather than changes, or `undefined` for one the
     * sweep does not know how to call.
     *
     * **A `COMPUTES` route is a read with its question in the body** (`A-23`), so it can name an
     * object as readily as a `GET` — and `A-12`'s sweep called only `GET`s, which is how
     * `POST /objects/:id/as-template` kept a hole's sensor in its answer. Hidden sensors as well as
     * visible ones where the body names one, for `queryValues`'s reason.
     */
    function computesBodies(route: string): Record<string, unknown>[] | undefined {
      switch (route) {
        case 'POST /api/v1/device-templates/plan':
          return [{ fingerprint: {} }];
        case 'POST /api/v1/discovery/preview':
          return [{ range: '10.0.0.0/30' }];
        case 'POST /api/v1/objects/:id/as-template':
          return [{ id: 'swept.template', name: 'Swept' }];
        case 'POST /api/v1/sensor-types/:id/preview':
          return [{ document: '{}', params: {} }];
        case 'POST /api/v1/templates/preview':
          return [pingId, regrantedId, carvedSensorId, otherSensorId].map((sensorId) => ({
            template: {
              name: 'Swept draft',
              method: 'email',
              settings: {},
              subject: '%sensor on %device is %status',
              body: '%lastmessage, via %probe in %group',
              recipients: [{ kind: 'address', value: 'ops@example.test' }],
            },
            sensorId,
          }));
        default:
          return undefined;
      }
    }

    it('never names an object outside the branch, on any route that computes (A-23)', async () => {
      const computing = server.routes.filter((route) => route.method !== 'GET' && !route.changes);
      const keys = computing.map((route) => `${route.method} ${route.url}`);
      // A route added tomorrow fails here until the sweep can call it: found by the sweep, not by
      // somebody reading, which is how this one was found.
      assert.deepEqual(
        keys.filter((key) => computesBodies(key) === undefined),
        [],
        'the sweep has no body for these, so it cannot call them',
      );
      assert.ok(keys.includes('POST /api/v1/objects/:id/as-template'), 'is a module unwired?');

      const leaked: string[] = [];
      const answered = new Set<string>();
      for (const route of computing) {
        const key = `${route.method} ${route.url}`;
        const ids = route.url.includes('/sensor-types/') ? ['icmp.ping'] : idsFor(route.url);
        const urls = [...new Set(ids.map((id) => route.url.replaceAll(':id', id)))];
        for (const url of urls) {
          for (const payload of computesBodies(key) ?? []) {
            const response = await app.inject({
              method: 'POST',
              url,
              // Not `branch`: the `GET` sweep spends most of that account's window.
              headers: { ...as('watcher'), 'content-type': 'application/json' },
              payload,
            });
            assert.notEqual(response.statusCode, 429, `${url} was throttled, and proved nothing`);
            if (response.statusCode === 200) answered.add(key);
            const at = response.body.indexOf(MARK);
            if (at >= 0) {
              leaked.push(`${url}: ${response.body.slice(Math.max(0, at - 120), at + 40)}`);
            }
          }
        }
      }

      assert.deepEqual(leaked, [], 'these answers told a branch account about objects outside it');
      // Every one computed something for somebody: a sweep of refusals proves nothing. Except the
      // preview of a pasted document, which reads nothing from the tree and has nothing to leak:
      // the test catalogue has no type that previews, so a 404 is all it can say here.
      assert.deepEqual(
        keys.filter((key) => !answered.has(key) && key !== 'POST /api/v1/sensor-types/:id/preview'),
        [],
        'these never answered 200',
      );
    });

    it('drafts a template from only the sensors its caller can see (A-23)', async () => {
      const draft = async (login: string, objectId: number) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(objectId)}/as-template`,
          headers: { ...as(login), 'content-type': 'application/json' },
          payload: { id: 'drafted.template', name: 'Drafted' },
        });
      const names = (body: string): string[] =>
        (JSON.parse(body) as { sensors: { name: string }[] }).sensors.map((sensor) => sensor.name);

      // The control: the device's own three, a-held folded into a-ping as its duplicate.
      const admin = await draft('admin', deviceId);
      assert.equal(admin.statusCode, 200, admin.body);
      assert.deepEqual(names(admin.body), ['a-ping', `${MARK}-carved-sensor`]);

      const watcher = await draft('watcher', deviceId);
      assert.equal(watcher.statusCode, 200, watcher.body);
      assert.deepEqual(
        names(watcher.body),
        ['a-ping'],
        'the carved sensor, or its count, came back',
      );
      assert.match(watcher.body, /with 1 sensors/);

      // A device whose only sensor is hidden has nothing to save — the answer an empty one gets.
      const lonely = await draft('watcher', lonelyDeviceId);
      assert.equal(lonely.statusCode, 400, lonely.body);
      assert.match(lonely.body, /has no sensors to save/);
      assert.equal(lonely.body.includes(MARK), false, lonely.body);
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

    it('counts a schedule’s users among what the editor can see (A-25)', async () => {
      // Every hour marked, so assigning it pauses nothing the later tests scan.
      const input = {
        name: 'a-visible schedule',
        grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true)),
      };
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        headers: { ...as('operator'), 'content-type': 'application/json' },
        payload: input,
      });
      assert.equal(created.statusCode, 201, created.body);
      const scheduleId = created.json<{ id: number }>().id;
      const users = [pingId, otherSensorId];
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         SELECT unnest($1::bigint[]), 'schedule.id', to_jsonb($2::bigint)`,
        [users, scheduleId],
      );
      try {
        const usedBy = async (login: string): Promise<number> => {
          const response = await app.inject({
            method: 'PUT',
            url: `/api/v1/schedules/${String(scheduleId)}`,
            headers: { ...as(login), 'content-type': 'application/json' },
            payload: input,
          });
          assert.equal(response.statusCode, 200, response.body);
          return response.json<{ usedBy: number }>().usedBy;
        };
        assert.equal(await usedBy('operator'), 1, 'a-ping, and not the sensor in the other branch');
        assert.equal(await usedBy('admin'), 2, 'the control: both are there to be counted');
      } finally {
        await db.query(
          `DELETE FROM object_setting WHERE key = 'schedule.id' AND object_id = ANY($1::bigint[])`,
          [users],
        );
      }
    });

    it('answers a hidden rediscovery rule as an id nobody used, on every route that takes one', async () => {
      // `D-11`. A writer on the branch, so the guard's 403 — which names the object — is what a
      // hidden rule would get if it were found, and an unused id gets the handler's 404.
      const routes: [string, 'POST' | 'PATCH' | 'DELETE', string, unknown][] = [
        ['switch', 'POST', '/enabled', { enabled: true }],
        ['edit', 'PATCH', '', { name: 'taken over' }],
        ['delete', 'DELETE', '', undefined],
      ];
      for (const [what, method, suffix, payload] of routes) {
        const answers = [];
        for (const id of [hiddenRuleId, 999_999]) {
          const response = await app.inject({
            method,
            url: `/api/v1/discovery/schedules/${String(id)}${suffix}`,
            headers: { ...as('operator'), 'if-match': 'W/"1"' },
            ...(payload === undefined ? {} : { payload: payload as never }),
          });
          const error = response.json<{ error: Record<string, unknown> }>().error;
          answers.push(
            `${String(response.statusCode)} ${String(error['code'])} ` +
              String(error['message']).replace(String(id), '<id>'),
          );
        }
        assert.equal(answers[0], answers[1], what);
        assert.match(answers[0] ?? '', /^404 /, what);
      }
      const rows = await db.query<{ name: string }>(
        `SELECT name FROM discovery_schedule WHERE id = $1`,
        [hiddenRuleId],
      );
      assert.equal(rows[0]?.name, `${MARK}-rediscovery`, 'and the rule is as it was');
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

    it('notices a counter that went backwards, the way a restore puts it (A-25)', async () => {
      // A known state before subscribing, so that the failure below is a change to publish.
      await scan([pingId], true);
      const branch = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      const frames: string[] = [];
      branch.on('message', (raw: Buffer) => frames.push(raw.toString('utf8')));
      try {
        branch.send(JSON.stringify({ subscribe: {} }));
        await waitFor(branch, frames, 'snapshot');
        const [counter] = await db.query<{ value: string }>(
          'SELECT value::text AS value FROM access_epoch',
        );
        const resolvedAt = Number(counter?.value);
        assert.ok(resolvedAt > 0, 'the fixture’s grants have moved the counter');

        // A restore from a backup taken before the branch was granted: the grant is gone, and the
        // counter is back below the number the socket was resolved at. Older-than would never
        // look at this socket again until the counter climbed past it.
        await access.grant(branchId, teamId, 'none', actorNamed('visibility'));
        await db.query('UPDATE access_epoch SET value = $1', [resolvedAt - 1]);
        const mark = frames.length;
        await scan([pingId], false);

        const overflow = await waitFor(branch, frames, 'overflow', mark);
        assert.match(String(overflow['reason']), /may see has changed/);
        assert.equal(
          frames.slice(mark).some((frame) => frame.includes('"type":"state"')),
          false,
          'a change was streamed to a socket that may no longer see it',
        );
      } finally {
        branch.terminate();
      }
    });
  });

  describe('while a subscription’s snapshot is being read (A-30)', () => {
    /**
     * Puts `around` between the stream route and the snapshot it reads, so a test can commit a
     * change, revoke a grant or hold the read at exactly the moment the races need. Restored
     * with the test.
     */
    function aroundSnapshot(
      t: TestContext,
      around: (read: () => Promise<SnapshotRead>, call: number) => Promise<SnapshotRead>,
    ): void {
      const read = stream.snapshot.bind(stream);
      let calls = 0;
      t.mock.method(stream, 'snapshot', (...args: Parameters<StateBroadcaster['snapshot']>) => {
        calls += 1;
        return around(() => read(...args), calls);
      });
    }

    async function watching(): Promise<{ socket: WebSocket; frames: string[] }> {
      const socket = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      const frames: string[] = [];
      socket.on('message', (raw: Buffer) => frames.push(raw.toString('utf8')));
      return { socket, frames };
    }

    const typed = (frames: readonly string[], type: string): Record<string, unknown>[] =>
      frames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame['type'] === type);

    it('sends a change committed during the read after the snapshot, not before it', async (t) => {
      // Up, so that the failure committed below is a change to publish.
      await scan([pingId], true);
      aroundSnapshot(t, async (read) => {
        const rows = await read();
        // Committed after the rows were read and before the frame goes out: the snapshot says Up.
        await scan([pingId], false);
        return rows;
      });
      const { socket, frames } = await watching();
      try {
        socket.send(JSON.stringify({ subscribe: {} }));
        const snapshot = await waitFor(socket, frames, 'snapshot');
        const entries = snapshot['entries'] as { sensorId: number; state: string }[];
        assert.equal(entries.find((entry) => entry.sensorId === pingId)?.state, 'up');

        const at = frames.findIndex((frame) => frame.includes('"type":"snapshot"'));
        const change = await waitFor(socket, frames, 'state', at + 1);
        assert.equal(change['sensorId'], pingId);
        assert.equal(
          frames.slice(0, at).some((frame) => frame.includes('"type":"state"')),
          false,
          'a change was sent before the snapshot that paints over it',
        );
        // Numbered after the snapshot, which counts none of them.
        assert.equal(snapshot['seq'], 0);
        assert.equal(change['seq'], 1);
      } finally {
        socket.terminate();
      }
    });

    it('does not send a snapshot read through a view revoked while it was read', async (t) => {
      aroundSnapshot(t, async (read) => {
        // After the view was resolved and before the rows are read: a-web01 is taken away, and
        // a-ping and a-held with it.
        await access.grant(deviceId, teamId, 'none', actorNamed('visibility'));
        return read();
      });
      const { socket, frames } = await watching();
      try {
        socket.send(JSON.stringify({ subscribe: {} }));
        const overflow = await waitFor(socket, frames, 'overflow');
        assert.match(String(overflow['reason']), /may see has changed/);
        assert.deepEqual(typed(frames, 'snapshot'), [], 'a snapshot of the old view was sent');
        assert.equal(frames.join('').includes('a-ping'), false);
      } finally {
        socket.terminate();
      }
    });

    it('never sends a replaced subscription’s snapshot after its replacement’s', async (t) => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first: Promise<SnapshotRead> | undefined;
      let reading = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reading = resolve;
      });
      aroundSnapshot(t, (read, call) => {
        if (call !== 1) return read();
        reading();
        first = gate.then(read);
        return first;
      });
      await scan([pingId], true);
      const { socket, frames } = await watching();
      try {
        // The device first, slowly; then everything, which replaces it before it has been read.
        socket.send(JSON.stringify({ subscribe: { objectId: deviceId } }));
        // Replaced once its read has begun, not before: earlier, it never reaches the read at all.
        await reached;
        socket.send(JSON.stringify({ subscribe: {} }));
        const replacement = await waitFor(socket, frames, 'snapshot');
        assert.equal(replacement['objectId'], null);

        release();
        await first;
        // A change after it, so whatever the replaced read would send has gone out before this.
        const mark = frames.length;
        await scan([pingId], false);
        await waitFor(socket, frames, 'state', mark);
        assert.deepEqual(
          typed(frames, 'snapshot').map((frame) => frame['objectId']),
          [null],
          'the replaced subscription’s snapshot arrived after its replacement’s',
        );
      } finally {
        socket.terminate();
      }
    });

    it('leaves a replacement alone when the subscription it replaced fails', async (t) => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first: Promise<unknown> | undefined;
      let reading = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reading = resolve;
      });
      aroundSnapshot(t, (read, call) => {
        if (call !== 1) return read();
        reading();
        const failing = gate.then(() => Promise.reject(new Error('the first read failed')));
        first = failing.catch(() => undefined);
        return failing;
      });
      await scan([pingId], true);
      const { socket, frames } = await watching();
      try {
        socket.send(JSON.stringify({ subscribe: { objectId: deviceId } }));
        // Replaced once its read has begun, not before: earlier, it never reaches the read at all.
        await reached;
        socket.send(JSON.stringify({ subscribe: {} }));
        await waitFor(socket, frames, 'snapshot');

        release();
        await first;
        const mark = frames.length;
        await scan([pingId], false);
        const change = await waitFor(socket, frames, 'state', mark);
        assert.equal(change['sensorId'], pingId, 'the replacement was detached by the failure');
        assert.deepEqual(typed(frames, 'problem'), [], 'the client was told to resubscribe');
      } finally {
        socket.terminate();
      }
    });
  });

  /**
   * `A-35`: a delete destroys a subtree, a move carries it and a clone copies it, and each of
   * them used to take a hole with it. `write` on a device whose sensor is carved `none` was a way
   * to destroy that sensor, to count what the hole holds, and to make a readable copy of it.
   */
  describe('changes that take a subtree with them (A-35)', () => {
    let tenancyId = 0;
    let boxId = 0;
    let boxPingId = 0;
    let boxHoleId = 0;
    let boxReadOnlyId = 0;
    let spareId = 0;
    let auditorsId = 0;
    let operatorId = 0;

    before(async () => {
      const create = async (input: Record<string, unknown>): Promise<number> =>
        (await harness.service.create(testActor, input as never)).id;
      tenancyId = await create({ kind: 'group', parentId: branchId, name: 'a-tenancy' });
      boxId = await create({
        kind: 'device',
        parentId: tenancyId,
        name: 'a-box',
        host: '10.0.1.1',
      });
      boxPingId = await create({
        kind: 'sensor',
        parentId: boxId,
        name: 'a-box-ping',
        sensorType: 'icmp.ping',
      });
      boxHoleId = await create({
        kind: 'sensor',
        parentId: boxId,
        name: `${MARK}-box-hole`,
        sensorType: 'icmp.ping',
      });
      boxReadOnlyId = await create({
        kind: 'sensor',
        parentId: boxId,
        name: 'a-box-read-only',
        sensorType: 'icmp.ping',
      });
      spareId = await create({ kind: 'group', parentId: branchId, name: 'a-spare' });
      auditorsId = (await groups.create({ name: 'Auditors' }, testActor)).id;
      const operator = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM user_account WHERE login = 'operator'`,
      );
      operatorId = Number(operator[0]?.id);
      // The harness only captures; the audit assertion reads the entries as they are stored.
      harness.audit.also = new DatabaseAuditSink();
    });

    after(() => {
      harness.audit.also = undefined;
    });

    /** `write` on the tenancy and on a spare group beside it, and the box's hole carved `none`. */
    async function carve(hole: 'none' | 'read' = 'none'): Promise<void> {
      await access.grant(tenancyId, teamId, 'write', actorNamed('visibility'));
      await access.grant(spareId, teamId, 'write', actorNamed('visibility'));
      await access.grant(boxHoleId, teamId, hole, actorNamed('visibility'));
    }

    const exists = async (id: number): Promise<boolean> =>
      (await db.query('SELECT 1 FROM object WHERE id = $1', [id])).length === 1;

    const childrenOf = async (id: number): Promise<string[]> =>
      (
        await db.query<{ name: string }>(
          'SELECT name FROM object WHERE parent_id = $1 ORDER BY name',
          [id],
        )
      ).map((row) => row.name);

    it('refuses to delete or move an object with anything beneath it the caller may not change', async () => {
      // `read` as well as `none`: a delete destroys a read-only sensor as surely as a hidden one,
      // and a move changes what it inherits.
      for (const hole of ['none', 'read'] as const) {
        await carve(hole);
        const direct = await app.inject({
          method: 'DELETE',
          url: `/api/v1/objects/${String(boxHoleId)}`,
          headers: as('operator'),
        });
        assert.equal(direct.statusCode, 403, `${hole}: the hole itself is refused`);

        // The whole subtree, from the device and from the group above it — and naming the true
        // count, which is what the refusal used to hand over, unlocks nothing.
        for (const url of [
          `/api/v1/objects/${String(boxId)}`,
          `/api/v1/objects/${String(boxId)}?expectedDescendants=3`,
          `/api/v1/objects/${String(tenancyId)}?expectedDescendants=4`,
        ]) {
          const refused = await app.inject({ method: 'DELETE', url, headers: as('operator') });
          assert.equal(refused.statusCode, 403, `${hole}: ${url}: ${refused.body}`);
          const error = refused.json<{
            error: { code: string; details: Record<string, unknown> };
          }>().error;
          assert.equal(error.code, 'AUTH_FORBIDDEN');
          // **Not an oracle** (`A-16`): no count, no name, no right, nothing to retry with.
          assert.deepEqual(error.details, {}, refused.body);
          assert.doesNotMatch(refused.body, new RegExp(MARK));
          assert.doesNotMatch(refused.body, /\b[34]\b.*other objects|retryWith|"held"/);
        }

        const moved = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(boxId)}/move`,
          headers: as('operator'),
          payload: { targetParentId: spareId },
        });
        assert.equal(moved.statusCode, 403, `${hole}: ${moved.body}`);

        // The bulk route, which read the count out of the refusal and retried with it.
        for (const payload of [
          { ids: [boxId, tenancyId], operation: 'delete', cascade: true },
          { ids: [boxId], operation: 'move', targetParentId: spareId },
        ]) {
          const bulk = await app.inject({
            method: 'POST',
            url: '/api/v1/objects/bulk',
            headers: as('operator'),
            payload,
          });
          assert.equal(bulk.statusCode, 200, bulk.body);
          const report = bulk.json<{
            succeeded: number;
            outcomes: { objectId: number; ok: boolean; problem?: string; deleted?: number }[];
          }>();
          assert.equal(report.succeeded, 0, `${hole}: ${payload.operation}: ${bulk.body}`);
          for (const outcome of report.outcomes) {
            assert.equal(
              outcome.problem,
              'this account may not change everything beneath that object',
            );
            assert.equal(outcome.deleted, undefined);
          }
        }

        for (const id of [tenancyId, boxId, boxPingId, boxHoleId, boxReadOnlyId]) {
          assert.ok(await exists(id), `${hole}: ${String(id)} was destroyed`);
        }
        assert.deepEqual(await childrenOf(tenancyId), ['a-box'], `${hole}: the box was moved`);
      }

      // The control: with the hole granted back, the same move is allowed, and a subtree with
      // nothing beneath it the operator may not change is deleted as it always was.
      await carve();
      await access.grant(boxHoleId, teamId, 'write', actorNamed('visibility'));
      for (const targetParentId of [spareId, tenancyId]) {
        const moved = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(boxId)}/move`,
          headers: as('operator'),
          payload: { targetParentId },
        });
        assert.equal(moved.statusCode, 200, moved.body);
      }
      const doomed = (
        await harness.service.create(testActor, {
          kind: 'device',
          parentId: tenancyId,
          name: 'a-doomed',
          host: '10.0.1.9',
        } as never)
      ).id;
      await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: doomed,
        name: 'a-doomed-ping',
        sensorType: 'icmp.ping',
      } as never);
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(doomed)}?expectedDescendants=1`,
        headers: as('operator'),
      });
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(deleted.json<{ deleted: { total: number } }>().deleted.total, 2);
    });

    it('clones only what the caller can see, and the copy keeps its source’s grants', async () => {
      await carve();
      // Another group's carve-out on something the operator *can* see, and the operator's own
      // `read` on another: both are the source's exceptions, and a copy without them was open to
      // everyone who can read where it lands.
      await access.grant(branchId, auditorsId, 'read', actorNamed('visibility'));
      await access.grant(boxPingId, auditorsId, 'none', actorNamed('visibility'));
      await access.grant(boxReadOnlyId, teamId, 'read', actorNamed('visibility'));

      const cloned = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(boxId)}/clone`,
        headers: as('operator'),
        payload: { targetParentId: spareId },
      });
      assert.equal(cloned.statusCode, 201, cloned.body);
      assert.doesNotMatch(cloned.body, new RegExp(MARK));
      const result = cloned.json<{
        object: { id: number };
        clonedCount: { total: number; sensor: number };
      }>();
      // The box and the two sensors the operator can see; the hole is neither copied nor counted.
      assert.deepEqual([result.clonedCount.total, result.clonedCount.sensor], [3, 2]);
      assert.deepEqual(await childrenOf(result.object.id), ['a-box-ping', 'a-box-read-only']);

      const copies = await db.query<{ name: string; group_name: string; right_: string }>(
        `SELECT o.name, g.name AS group_name, a.right_::text AS right_
         FROM object o
         JOIN object_access a ON a.object_id = o.id
         JOIN user_group g ON g.id = a.group_id
         WHERE o.parent_id = $1
         ORDER BY o.name, g.name`,
        [result.object.id],
      );
      assert.deepEqual(
        copies.map((row) => [row.name, row.group_name, row.right_]),
        [
          ['a-box-ping', 'Auditors', 'none'],
          ['a-box-read-only', 'Customer A team', 'read'],
        ],
      );
      const readOnlyCopy = (
        await db.query<{ id: string }>(
          `SELECT id::text AS id FROM object WHERE parent_id = $1 AND name = 'a-box-read-only'`,
          [result.object.id],
        )
      )[0];
      assert.ok(readOnlyCopy);
      const held = await access.resolveFor(
        { userId: operatorId, role: 'readwrite' },
        Number(readOnlyCopy.id),
      );
      assert.equal(held.right, 'read', 'the copy inherited write from where it landed');

      // Each carried grant is in the audit log as a grant made by the cloner, beside the clone.
      const entries = await db.query<{ action: string; actor_label: string; object_id: string }>(
        `SELECT action, actor_label, object_id::text AS object_id FROM audit_log
         WHERE object_id IN (SELECT id FROM object WHERE parent_id = $1 OR id = $1)
         ORDER BY id`,
        [result.object.id],
      );
      assert.deepEqual(
        entries.map((entry) => [entry.action, entry.actor_label]),
        [
          ['object.cloned', 'operator'],
          ['grant.set', 'operator'],
          ['grant.set', 'operator'],
        ],
      );

      // In place, and in bulk: the same walk, so the same answer.
      const inPlace = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(boxId)}/clone`,
        headers: as('operator'),
        payload: {},
      });
      assert.equal(inPlace.statusCode, 201, inPlace.body);
      assert.deepEqual(await childrenOf(inPlace.json<{ object: { id: number } }>().object.id), [
        'a-box-ping',
        'a-box-read-only',
      ]);
      const bulk = await app.inject({
        method: 'POST',
        url: '/api/v1/objects/bulk',
        headers: as('operator'),
        payload: { ids: [boxId], operation: 'clone', targetParentId: spareId },
      });
      assert.equal(bulk.statusCode, 200, bulk.body);
      const createdId = bulk.json<{ outcomes: { createdId?: number }[] }>().outcomes[0]?.createdId;
      assert.ok(createdId !== undefined, bulk.body);
      assert.deepEqual(await childrenOf(createdId), ['a-box-ping', 'a-box-read-only']);

      // The control: an administrator's clone copies the hole, grant and all.
      const whole = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(boxId)}/clone`,
        headers: as('admin'),
        payload: { targetParentId: spareId },
      });
      assert.equal(whole.statusCode, 201, whole.body);
      const wholeId = whole.json<{ object: { id: number } }>().object.id;
      assert.deepEqual(await childrenOf(wholeId), [
        'a-box-ping',
        'a-box-read-only',
        `${MARK}-box-hole`,
      ]);
      const holeCopy = await db.query<{ right_: string }>(
        `SELECT a.right_::text AS right_ FROM object o JOIN object_access a ON a.object_id = o.id
         WHERE o.parent_id = $1 AND o.name = $2 AND a.group_id = $3`,
        [wholeId, `${MARK}-box-hole`, teamId],
      );
      assert.deepEqual(
        holeCopy.map((row) => row.right_),
        ['none'],
        'the copied hole is still a hole to the team',
      );
    });

    it('refuses a clone made in place where the caller may not write (A-35)', async () => {
      // The fixture's own shape: `write` granted on the device, and only `read` on the branch
      // it hangs in. Naming the branch as the destination was refused (`G06`); leaving the
      // destination out put the copy there all the same.
      const named = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(deviceId)}/clone`,
        headers: as('operator'),
        payload: { targetParentId: branchId },
      });
      assert.equal(named.statusCode, 403, named.body);
      for (const payload of [undefined, {}, { name: 'a-web01 again' }]) {
        const inPlace = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/clone`,
          headers: as('operator'),
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(inPlace.statusCode, 403, inPlace.body);
        assert.equal(
          inPlace.json<{ error: { message: string } }>().error.message,
          'this action needs write on the object that a clone made in place belongs to',
        );
      }
      assert.deepEqual(
        (await childrenOf(branchId)).filter((name) => name.includes('a-web01')),
        ['a-web01'],
        'a copy landed in the branch',
      );

      // The control: `write` on the branch, and the same request is allowed.
      await access.grant(branchId, teamId, 'write', actorNamed('visibility'));
      const allowed = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(deviceId)}/clone`,
        headers: as('operator'),
        payload: { name: 'a-web01 again' },
      });
      assert.equal(allowed.statusCode, 201, allowed.body);
    });
  });

  /**
   * `A-26`: an object's history is readable with `read` on it, and its grant entries say who else
   * may see it and who decided so — which the grants themselves tell only an administrator.
   */
  describe('what an object’s history says about its grants (A-26)', () => {
    before(() => {
      // The harness only captures; the history is read from what is stored.
      harness.audit.also = new DatabaseAuditSink();
    });

    after(() => {
      harness.audit.also = undefined;
    });

    const historyOf = async (headers: Record<string, string>, limit = 100): Promise<string[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(deviceId)}/audit?limit=${String(limit)}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ items: { action: string }[] }>().items.map((item) => item.action);
    };

    it('shows the grant entries to an administrator, and to nobody else', async () => {
      // A setting set, a grant, and the setting reverted, in that order: the grant sits between
      // two entries everybody may read, so a filter applied after the page was cut would answer
      // a page of two with one.
      await harness.service.setSetting(testActor, deviceId, 'scan.intervalSeconds', 120);
      await access.grant(deviceId, teamId, 'full', actorNamed('visibility'));
      await harness.service.clearSetting(testActor, deviceId, 'scan.intervalSeconds');

      const operator = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM user_account WHERE login = 'operator'`,
      );
      assert.equal(
        (await access.resolveFor({ userId: Number(operator[0]?.id), role: 'readwrite' }, deviceId))
          .right,
        'full',
        'the operator is meant to hold full here',
      );

      // `watcher` holds read on the device, and `operator` full: neither reads its grants.
      for (const login of ['watcher', 'operator']) {
        const actions = await historyOf(as(login));
        assert.deepEqual(
          actions.filter((action) => action.startsWith('grant.')),
          [],
          `${login} read a grant entry`,
        );
        assert.deepEqual(actions.slice(0, 2), ['setting.reverted', 'setting.set'], login);
        assert.deepEqual(
          await historyOf(as(login), 2),
          ['setting.reverted', 'setting.set'],
          `${login}: a page of two was short`,
        );
      }

      // The control: an administrator reads them where they happened.
      assert.deepEqual((await historyOf(as('admin'))).slice(0, 3), [
        'setting.reverted',
        'grant.set',
        'setting.set',
      ]);

      // And the bar is `ADMIN`'s, role and scope both: an administrator's read token reads what a
      // read-only account does.
      const issued = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/tokens',
        headers: as('admin'),
        payload: { name: 'history', scope: 'read' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const bearer = { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` };
      const throughToken = await historyOf(bearer);
      assert.deepEqual(throughToken.slice(0, 2), ['setting.reverted', 'setting.set']);
      assert.deepEqual(
        throughToken.filter((action) => action.startsWith('grant.')),
        [],
        'a read token read a grant entry',
      );
    });
  });
});

/**
 * The query parameters the sweep never gives a value (`A-23`).
 *
 * **A known limit, named rather than claimed away.** `A-12`'s entry said the sweep tried every
 * query parameter; it tries the ones `queryValues` has values for, and calls the routes declaring
 * these only without them. None of these names an object in the tree or selects by anything one
 * has: they are times and cursors, enumerations and flags, and the ids of things that are not in
 * the tree — an account, a notification template, an audit actor. Each narrows, orders or pages
 * rows the bare call already reads through the same condition. A parameter that does name or
 * select an object belongs in `queryValues`, with hidden values among its own — and a new one
 * fails the sweep until it is in one list or the other.
 */
const UNSWEPT_QUERY_PARAMETERS: readonly string[] = [
  // Times, cursors and pages.
  'before',
  'cursor',
  'from',
  'resolutionSeconds',
  'to',
  // Enumerations, flags and orderings.
  'category',
  'cause',
  'credentials',
  'includeAcknowledged',
  'includeRevoked',
  'kind',
  'priorityMin',
  'sort',
  'state',
  'status',
  // Ids of things outside the tree.
  'actorKind',
  'actorRef',
  'templateId',
  'userId',
].sort();

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
