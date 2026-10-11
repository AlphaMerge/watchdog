import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION } from '@ms/shared';
import type { WebSocket } from 'ws';
import { ApiServer } from '../src/api/server.js';
import { AccessService, Visibility } from '../src/auth/access.js';
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
import {
  existingInGroup,
  NO_WRITE_ON_GROUP,
  ProvisionService,
  provisionRun,
  scheduledSight,
  type ProvisionReport,
  type ProvisionSight,
} from '../src/discovery/provision.js';
import { DeviceTemplateCatalogue } from '../src/device-templates/catalogue.js';
import { BUILT_IN_DEVICE_TEMPLATES } from '../src/device-templates/built-in.js';
import { LookupCatalogue } from '../src/lookups/catalogue.js';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
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
import { MetricsExporter } from '../src/metrics/exporter.js';
import { StateBroadcaster, type SnapshotRead } from '../src/state/stream.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import type { Actor } from '../src/objects/audit.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';
import { connectedLink, fixedCoreHealth, probeHealthOver } from './support/health.js';
import { pollWithin } from './support/within.js';

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
 * **Not a sweep of refusals, and not a sweep of empty rooms** (`A-31`). Every `GET` route must
 * answer the branch account at least once or be named in `NEVER_ANSWERS_THE_BRANCH`, and an
 * administrator swept the same way must be shown the marker on every route that answered the
 * branch, or the route is named in `NO_MARKER_TO_REACH`. A route whose answer is a count or an id
 * carries no marker to find, so its bar is asserted by status in a test of its own.
 *
 * **Outside means the containers above the branch too.** The root and the probe the branch hangs
 * under carry the marker, because their names are exactly what a breadcrumb, an alarm's path or
 * a scrape would hand over if the rule stopped at siblings.
 *
 * **The fixture is adversarial on purpose**: a hole carved inside the branch, a grant re-opening
 * the hole one level down, a device whose only child is carved out, a trigger defined on the
 * hidden probe and inherited by a visible sensor, a pause inherited from a hidden device, a
 * dependency on a hidden master, a template used by a hidden trigger, a rediscovery schedule and
 * a discovery run in a hidden group, a host that run found, a second hidden probe, a map naming
 * both sides. Each is a way a hidden object's name has reached a visible one somewhere in this
 * codebase.
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
  /** A group that reads the root with a hole over `probeId`, when a test grants it that. */
  let rootReadersId = 0;
  let probeId = 0;
  /** Beside `probeId`, so a scrape through a hole over one probe has another to show. */
  let secondProbeId = 0;
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
  let hiddenMapId = 0;
  let sweptScheduleId = 0;
  let visibleRunId = 0;
  let hiddenRunId = 0;
  /** The team's read-write account, which starts a run for `A-77`'s provisioning test. */
  let operatorUserId = 0;
  let discovery: DiscoveryService;
  let rediscovery: RediscoveryService;
  /** A provisioning pass as `main.ts` wires one, for the scheduled pass (`A-82`). */
  let provisionPass: (
    runId: number,
    actor: Actor,
    sight: ProvisionSight,
  ) => Promise<ProvisionReport>;

  const cookies = new Map<string, string>();

  /** Two visible, four hidden: what `?invalidParams=true` narrows to (`P-375`). */
  const failingParams = (): number[] =>
    [pingId, regrantedId, carvedSensorId, underCarveId, lonelySensorId, otherSensorId].sort(
      (a, b) => a - b,
    );

  before(async () => {
    scratch = await createScratchDatabase('visibility');
    db = scratch.db;
    harness = await buildHarness(db, { states: true });

    const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
    access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
    groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
    // The sweep an hour away: the one test that needs a sweep runs it by hand (`U-24`), and a
    // tick landing inside its bounded wait would be the frame it asserts is absent.
    stream = new StateBroadcaster({
      logger: silent,
      credentialSweepMs: 3_600_000,
      accessEpoch: async () => {
        const rows = await db.query<{ value: string }>(
          'SELECT value::text AS value FROM access_epoch',
        );
        return Number(rows[0]?.value);
      },
    });

    discovery = new DiscoveryService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silent,
      dispatch: () => ({ kind: 'sent' }),
    });
    const triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });
    const schedules = new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent });
    rediscovery = new RediscoveryService({
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
    const deviceTemplates = (() => {
      const catalogue = new DeviceTemplateCatalogue(() => true);
      for (const template of BUILT_IN_DEVICE_TEMPLATES) catalogue.register(template, 'built-in');
      return catalogue.seal();
    })();
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
    const coreHealth = fixedCoreHealth(db);
    const probeHealth = probeHealthOver(db, connectedLink);
    const metrics = new MetricsExporter({
      db,
      logger: silent,
      coreHealth: () => coreHealth,
      probeHealth: () => probeHealth,
    });

    // **The real thing, as `main.ts` wires it** (`A-77`): what a pass matches, reports and
    // writes under is the caller's, and a stub could not show it.
    provisionPass = (runId, actor, sight) =>
      provisionRun(
        {
          discovery,
          provisioner: new ProvisionService({
            db,
            objects: harness.service,
            templates: deviceTemplates,
            logger: silent,
            credentialsFor: () => Promise.resolve(new Set<string>()),
            recordDevice: (run, address, device) => discovery.recordDevice(run, address, device),
          }),
          existing: (groupId) => existingInGroup(db, groupId),
          vouchers: {
            authRequired: true,
            ruleWriter: (ruleId) => rediscovery.writerOf(ruleId),
            rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
          },
        },
        runId,
        actor,
        sight,
      );

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
      schedules,
      discovery,
      rediscovery,
      provision: (runId, actor, sight) => provisionPass(runId, actor, sight),
      // The built-in ones, so `/device-templates/:templateId` and `/lookups/:id` have one to
      // answer with.
      deviceTemplates,
      lookups: (() => {
        const catalogue = new LookupCatalogue();
        for (const lookup of BUILT_IN_LOOKUPS) catalogue.register(lookup, 'built-in', true);
        return catalogue.seal();
      })(),
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
      // **Answering, not 503** (`A-31`). Each was `() => undefined`, which answered 503 whoever
      // asked, so a route that lost its bar answered exactly what a guarded one did. Their bodies
      // are numbers and ids, which carry no marker, so the refusals are asserted by status.
      coreHealth: () => coreHealth,
      probeHealth: () => probeHealth,
      metrics: () => metrics,
      // Sensors whose stored parameters fail, on both sides of the branch (`P-375`): the filter
      // selects by something a hidden sensor has, so it is swept like `q` and `tag`.
      invalidParams: {
        failing: () => ({ kind: 'known', ids: failingParams() }),
      },
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
    secondProbeId = await create({
      kind: 'probe',
      parentId: harness.rootId,
      name: `${MARK}-second-probe`,
    });
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
    // A host each run found, identified, a problem provisioning it, and a message on the run —
    // so each route about a run has something to say, and the hidden run's says the marker,
    // which no answer to the branch account may carry (`A-31`). A kind the reader knows: an
    // unknown one reads back as no fingerprint at all, and then nothing is named.
    const found = (address: string, name: string, vendor: string) =>
      JSON.stringify({
        address,
        reverseName: name,
        sysName: name,
        vendor,
        ports: [],
        kind: 'linux',
        confidence: 80,
        evidence: [`answered as ${name}`],
      });
    await db.query(
      `INSERT INTO discovery_host (run_id, address, fingerprint)
       VALUES ($1, '10.0.0.2', $2::jsonb), ($3, '10.9.0.2', $4::jsonb)`,
      [
        visibleRunId,
        found('10.0.0.2', 'a-found-host', 'a-found-vendor'),
        hiddenRunId,
        found('10.9.0.2', MARK, `${MARK}-vendor`),
      ],
    );
    await db.query(
      `INSERT INTO discovery_problem (run_id, address, problem)
       VALUES ($1, '10.0.0.2', 'a-found-problem'), ($2, '10.9.0.2', $3)`,
      [visibleRunId, hiddenRunId, `${MARK}-problem`],
    );
    await db.query(
      `UPDATE discovery_run SET message = CASE WHEN id = $1 THEN 'a-found-run' ELSE $3 END
       WHERE id IN ($1, $2)`,
      [visibleRunId, hiddenRunId, `${MARK}-run`],
    );
    sweptScheduleId = (
      await schedules.create(testActor, {
        name: 'a-swept schedule',
        grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true)),
      })
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
    rootReadersId = (await groups.create({ name: 'Root readers' }, testActor)).id;
    for (const [login, role] of [
      ['branch', 'readonly'],
      // The same grants as `branch`, for the tests after the sweep: the limit is per account,
      // and the sweep spends most of a window's worth on its own.
      ['watcher', 'readonly'],
      ['operator', 'readwrite'],
      ['admin', 'admin'],
      // An administrator of its own for the control sweep, which spends a window as `branch`'s
      // does (`A-31`).
      ['overseer', 'admin'],
      // In `Root readers`, which holds nothing until a test grants it the root.
      ['rooted', 'readonly'],
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
        await groups.addMember(login === 'rooted' ? rootReadersId : teamId, account.id, testActor);
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
    operatorUserId = operator.id;
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
    // And a map of an administrator's the team was never granted (`A-14`), marked the same way.
    hiddenMapId = (
      await maps.create(
        { userId: admin.id, role: 'admin' },
        { name: `${MARK}-map` },
        actorNamed('admin'),
      )
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
      // Credential sets with no bounds, inside the branch and outside it (`U-21`): the list of
      // them names the object each is stored on, so the hidden probe and the hidden group are
      // there for it to leak and the branch's own is there for it to show.
      for (const owner of [probeId, otherGroupId, branchId]) {
        await harness.service.setCredential(testActor, owner, 'snmp', { community: 'swept' });
      }
    });

    after(async () => {
      await harness.service.resume(testActor, carvedDeviceId, Visibility.EVERYTHING);
      for (const owner of [probeId, otherGroupId, branchId]) {
        await harness.service.clearCredential(testActor, owner, 'snmp');
      }
    });

    /** Every id this account can see, for whatever `:id` means on a route. */
    function idsFor(url: string): string[] {
      const path = url.replace('/api/v1', '');
      // A run in the hidden group too: that one has to be refused, and a refusal carries no name.
      if (path.startsWith('/discovery/:id')) return [String(visibleRunId), String(hiddenRunId)];
      if (path.startsWith('/templates/')) return [String(templateId)];
      // The team's map and an administrator's it was not given, which answers as an unused id.
      if (path.startsWith('/maps/')) return [String(mapId), String(hiddenMapId)];
      // A library the team was given and one it was not; the second answers 404, and nothing else.
      if (path.startsWith('/libraries/')) return [String(libraryId), String(hiddenLibraryId)];
      if (path.startsWith('/schedules/')) return [String(sweptScheduleId)];
      if (path.startsWith('/lookups/')) return ['ms.probe.link'];
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
        // The sensors whose stored parameters fail, four of them hidden (`P-375`).
        case 'invalidParams':
          return ['true'];
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
        'GET /api/v1/credentials/unbounded',
        'GET /api/v1/probes',
        'GET /metrics',
        // Each is its own option to `ApiServer`, so leaving one out loses its routes without a
        // sound (`A-31`).
        'GET /api/v1/objects/:id/triggers',
        'GET /api/v1/schedules/:id',
        'GET /api/v1/device-templates',
        'GET /api/v1/discovery/:id/plan',
        'GET /api/v1/core-health',
        'GET /api/v1/probes/:id/health',
        'GET /api/v1/notification-health',
      ].filter((route) => !swept.has(route));
      assert.deepEqual(missing, [], 'these routes are not being swept — is a module unwired?');
    });

    /** What one account was answered, across every `GET` route and every URL `urlsFor` builds. */
    interface Swept {
      /** Route → every body it answered 200 with, joined. */
      readonly bodies: ReadonlyMap<string, string>;
      /** Route → the first answer carrying the marker, with what surrounds it. */
      readonly marked: ReadonlyMap<string, string>;
      readonly throttled: readonly string[];
      readonly calls: number;
    }

    async function sweepAs(login: string): Promise<Swept> {
      const openapi = app.swagger() as unknown as OpenApi;
      const bodies = new Map<string, string>();
      const marked = new Map<string, string>();
      const throttled: string[] = [];
      let calls = 0;
      for (const route of server.routes) {
        if (route.method !== 'GET' || route.url.endsWith('/stream')) continue;
        for (const url of urlsFor(route.url, openapi)) {
          const response = await app.inject({ method: 'GET', url, headers: as(login) });
          calls += 1;
          if (response.statusCode === 429) throttled.push(url);
          if (response.statusCode === 200) {
            bodies.set(route.url, (bodies.get(route.url) ?? '') + response.body);
          }
          const at = response.body.indexOf(MARK);
          // One per route, with what surrounds the marker: which field carried it is the
          // diagnosis, and forty variants of one URL are not forty findings.
          if (at >= 0 && !marked.has(route.url)) {
            marked.set(route.url, `${url}: ${response.body.slice(Math.max(0, at - 120), at + 40)}`);
          }
        }
      }
      // A throttled request answered nothing, so it proved nothing: a sweep has to fit inside
      // the per-account limit (`hardening.ts`), or it is quietly skipping its own tail.
      assert.deepEqual(
        throttled.slice(0, 5),
        [],
        `${login}: ${String(throttled.length)} of ${String(calls)} throttled`,
      );
      return { bodies, marked, throttled, calls };
    }

    /** Filled by the branch sweep, for the administrator's control below to be judged against. */
    let branchSwept: Swept | undefined;

    it('never names an object outside the branch, on any GET route', async () => {
      const swept = await sweepAs('branch');
      branchSwept = swept;
      assert.deepEqual(
        [...swept.marked.entries()].map(([route, at]) => `${route} (${at})`),
        [],
        'these answers told a branch account about objects outside it',
      );

      // **Not a sweep of refusals** (`A-31`). Every `GET` route answers this account at least
      // once, or is named with the reason it cannot: a floor of "more than 25" passed with
      // forty routes refusing everything, and would have passed with forty-five.
      const silent = server.routes
        .filter((route) => route.method === 'GET' && !route.url.endsWith('/stream'))
        .map((route) => route.url)
        .filter((url) => !swept.bodies.has(url))
        .sort();
      assert.deepEqual(
        silent,
        NEVER_ANSWERS_THE_BRANCH,
        'a route stopped answering the branch account, or a new one never does; name it in ' +
          'NEVER_ANSWERS_THE_BRANCH with the reason',
      );

      // And the routes that list, each naming what the account can see — not every body pooled,
      // where one route's answer would stand in for another's refusal.
      for (const [name, route] of NAMED_BY) {
        assert.ok((swept.bodies.get(route) ?? '').includes(name), `${route} never named ${name}`);
      }
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
          // A fingerprint as a run records one: with templates loaded, an empty one is a 500.
          return [
            { fingerprint: { address: '10.0.0.2', kind: 'linux', ports: [], confidence: 80 } },
          ];
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

    const runtimeOf = async (sensorId: number) =>
      (
        await db.query<{ state: string; simulated: boolean }>(
          `SELECT state::text AS state, simulated_error AS simulated
           FROM sensor_runtime WHERE object_id = $1`,
          [sensorId],
        )
      )[0];

    it('acknowledges and forces only what the caller can see beneath it (A-24)', async () => {
      // The operator holds `write` on the device, and a sensor beneath it is carved `none`. An
      // acknowledgement or a simulated error on the device used to reach that sensor too: a
      // write into a branch the operator was never shown, and an answer about what is in it.
      assert.equal((await runtimeOf(carvedSensorId))?.state, 'down', 'the fixture’s hole is Down');
      assert.equal((await runtimeOf(pingId))?.state, 'down');

      // **An administrator's acknowledgement and drill on the hole first** (`A-31`). With nothing
      // set on it, a clear or a release that walked into the hole changed nothing there, and the
      // halves below could not fail: now either would undo the administrator's, and name the
      // sensor in its answer.
      const hole = `/api/v1/objects/${String(carvedSensorId)}`;
      const drill = await app.inject({
        method: 'POST',
        url: `${hole}/simulate-error`,
        headers: as('admin'),
        payload: { message: 'the administrator’s drill' },
      });
      assert.equal(drill.statusCode, 200, drill.body);
      const theirs = await app.inject({
        method: 'POST',
        url: `${hole}/acknowledge`,
        headers: as('admin'),
        payload: { message: 'the administrator’s' },
      });
      assert.equal(theirs.statusCode, 200, theirs.body);
      const holeAsTheAdministratorLeftIt = async (): Promise<void> => {
        const runtime = await runtimeOf(carvedSensorId);
        assert.deepEqual(runtime, { state: 'down_acknowledged', simulated: true });
      };
      await holeAsTheAdministratorLeftIt();

      try {
        const device = `/api/v1/objects/${String(deviceId)}`;
        const acknowledged = await app.inject({
          method: 'POST',
          url: `${device}/acknowledge`,
          headers: as('operator'),
          payload: { message: 'on it' },
        });
        assert.equal(acknowledged.statusCode, 200, acknowledged.body);
        const view = acknowledged.json<{
          acknowledged: number[];
          refused: number[];
          skipped: number[];
        }>();
        assert.deepEqual(view.acknowledged, [pingId]);
        assert.deepEqual(view.refused, []);
        // What it left for want of a right names only what the operator can see (`A-31`).
        assert.deepEqual(view.skipped, [], 'the hole was reported as skipped');
        const cleared = await app.inject({
          method: 'DELETE',
          url: `${device}/acknowledge`,
          headers: as('operator'),
        });
        assert.equal(cleared.statusCode, 200, cleared.body);
        const clearedView = cleared.json<{ acknowledged: number[]; skipped: number[] }>();
        assert.deepEqual(clearedView.acknowledged, [pingId]);
        assert.deepEqual(clearedView.skipped, [], 'the hole was reported as skipped');
        await holeAsTheAdministratorLeftIt();

        const forced = await app.inject({
          method: 'POST',
          url: `${device}/simulate-error`,
          headers: as('operator'),
          payload: { message: 'drill' },
        });
        assert.equal(forced.statusCode, 200, forced.body);
        const drilled = forced.json<{ sensors: number[]; skipped: number[] }>();
        assert.ok(!drilled.sensors.includes(carvedSensorId));
        assert.deepEqual(drilled.skipped, [], 'the hole was reported as skipped');
        const unforced = await app.inject({
          method: 'DELETE',
          url: `${device}/simulate-error`,
          headers: as('operator'),
        });
        assert.equal(unforced.statusCode, 200, unforced.body);
        const releasedView = unforced.json<{ sensors: number[]; skipped: number[] }>();
        const released = releasedView.sensors;
        assert.ok(released.includes(pingId), 'the release reached nothing it was meant to');
        assert.ok(!released.includes(carvedSensorId), 'the release named the hidden sensor');
        assert.deepEqual(releasedView.skipped, [], 'the hole was reported as skipped');
        await holeAsTheAdministratorLeftIt();
      } finally {
        for (const undo of ['acknowledge', 'simulate-error']) {
          const response = await app.inject({
            method: 'DELETE',
            url: `${hole}/${undo}`,
            headers: as('admin'),
          });
          assert.equal(response.statusCode, 200, response.body);
        }
        // Down on its own account again, as the fixture had it for the tests after this one.
        await scan([carvedSensorId], false);
      }
      assert.deepEqual(await runtimeOf(carvedSensorId), { state: 'down', simulated: false });

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

    it('does nothing through a device that naming the sensor would refuse (A-31)', async () => {
      // `write` on the device and only `read` on a-ping beneath it. An acknowledgement or a
      // drill is written onto each sensor it reaches, so `A-35`'s rule holds: through the device
      // it may not do to a-ping what naming a-ping would not, and it says what it left.
      await access.grant(pingId, teamId, 'read', actorNamed('visibility'));
      const device = `/api/v1/objects/${String(deviceId)}`;
      const post = (url: string, payload: object) =>
        app.inject({ method: 'POST', url, headers: as('operator'), payload });
      const remove = (url: string) =>
        app.inject({ method: 'DELETE', url, headers: as('operator') });
      type Acted = { acknowledged: number[]; skipped: number[] };
      type Forced = { sensors: number[]; skipped: number[] };

      try {
        const byName = await post(`/api/v1/objects/${String(pingId)}/acknowledge`, {});
        assert.equal(byName.statusCode, 403, 'the control: naming a-ping is refused');

        // a-ping is the only sensor Down here that the operator can see, so nothing is left.
        const acknowledged = await post(`${device}/acknowledge`, { message: 'on it' });
        assert.equal(acknowledged.statusCode, 403, acknowledged.body);
        assert.equal(
          acknowledged.json<{ error: { message: string } }>().error.message,
          'this account may not acknowledge any sensor here',
        );
        assert.deepEqual(await runtimeOf(pingId), { state: 'down', simulated: false });

        // A drill forces a-held, which the operator may write, and leaves a-ping.
        const forced = await post(`${device}/simulate-error`, { message: 'drill' });
        assert.equal(forced.statusCode, 200, forced.body);
        assert.deepEqual(
          { sensors: forced.json<Forced>().sensors, skipped: forced.json<Forced>().skipped },
          { sensors: [heldId], skipped: [pingId] },
        );
        assert.deepEqual(await runtimeOf(pingId), { state: 'down', simulated: false });
        const released = await remove(`${device}/simulate-error`);
        assert.equal(released.statusCode, 200, released.body);
        assert.deepEqual(
          { sensors: released.json<Forced>().sensors, skipped: released.json<Forced>().skipped },
          { sensors: [heldId], skipped: [pingId] },
        );

        // With the account's opt-in, `read` is enough to acknowledge (`M-13`): by name, and so
        // through the device. The opt-in is for acknowledging, and a drill still leaves a-ping.
        await db.query(`UPDATE user_account SET may_acknowledge = true WHERE login = 'operator'`);
        const opted = await post(`${device}/acknowledge`, { message: 'on it' });
        assert.equal(opted.statusCode, 200, opted.body);
        assert.deepEqual(
          { acknowledged: opted.json<Acted>().acknowledged, skipped: opted.json<Acted>().skipped },
          { acknowledged: [pingId], skipped: [] },
        );
        assert.equal((await runtimeOf(pingId))?.state, 'down_acknowledged');
        const cleared = await remove(`${device}/acknowledge`);
        assert.equal(cleared.statusCode, 200, cleared.body);
        assert.deepEqual(cleared.json<Acted>().acknowledged, [pingId]);
        assert.equal((await runtimeOf(pingId))?.state, 'down');

        const drilled = await post(`${device}/simulate-error`, { message: 'drill' });
        assert.equal(drilled.statusCode, 200, drilled.body);
        assert.deepEqual(drilled.json<Forced>().skipped, [pingId]);
        assert.equal((await remove(`${device}/simulate-error`)).statusCode, 200);
      } finally {
        // Left as the fixture had it, whichever assertion failed: a drill left standing on a-ping
        // would change what every later test is streamed.
        await db.query(`UPDATE user_account SET may_acknowledge = false WHERE login = 'operator'`);
        for (const undo of ['acknowledge', 'simulate-error']) {
          await app.inject({ method: 'DELETE', url: `${device}/${undo}`, headers: as('admin') });
        }
      }
      assert.deepEqual(await runtimeOf(pingId), { state: 'down', simulated: false });
    });

    it('shows an administrator the marker on every route that answered the branch', async () => {
      // **The control, route by route** (`A-31`). A route that answered the branch account
      // without the marker proves something only if the marker was there to leave out. Twelve
      // hand-picked URLs said so for twelve routes; this is the same sweep, as an administrator
      // who sees everything, and every route the branch was answered by has to show the marker
      // to them or be named with the reason it cannot.
      assert.ok(branchSwept !== undefined, 'the branch sweep runs first');
      const swept = await sweepAs('overseer');
      const unreached = [...branchSwept.bodies.keys()]
        .filter((route) => !swept.marked.has(route))
        .sort();
      assert.deepEqual(
        unreached,
        NO_MARKER_TO_REACH,
        'the marker is not reachable on these routes even for an administrator, so the branch ' +
          'sweep proves nothing there; plant something they can name, or say why in ' +
          'NO_MARKER_TO_REACH',
      );

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
          waitFor(frames, type, from);

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
      const until = (done: () => boolean): Promise<void> =>
        pollWithin(3_000, 'the stream to deliver', done, 10);
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

    it('lists only the sensors it can see among those whose parameters fail (P-375)', async () => {
      const listed = async (login: string): Promise<number[]> => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/objects?invalidParams=true&sort=id',
          headers: as(login),
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.body.includes(MARK), login === 'overseer');
        return response.json<{ items: { id: number }[] }>().items.map((item) => item.id);
      };
      assert.deepEqual(
        await listed('watcher'),
        [pingId, regrantedId].sort((a, b) => a - b),
        'the carved, the hidden and the other branch’s are not the branch account’s',
      );
      assert.deepEqual(await listed('overseer'), failingParams(), 'an administrator sees all six');
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
        items: { sensorId: number; path: number[]; pathNames: string[] }[];
        total: number;
        counts: Record<string, number>;
      }>();
      assert.deepEqual(
        page.items.map((item) => item.sensorId).sort((a, b) => a - b),
        [pingId, regrantedId].sort((a, b) => a - b),
      );
      assert.equal(page.total, 2);
      assert.equal(page.counts['down'], 2);
      // The path starts at the branch: the probe and the root above it are outside. The ids as
      // well as the names, since an id is how a client would find the container it may not see.
      const ping = page.items.find((item) => item.sensorId === pingId);
      assert.deepEqual(ping?.pathNames, ['Customer A', 'a-web01', 'a-ping']);
      assert.deepEqual(ping.path, [branchId, deviceId, pingId]);
      // A hole in the middle of a path: the re-granted sensor's device is hidden, and skipped.
      const regranted = page.items.find((item) => item.sensorId === regrantedId);
      assert.deepEqual(regranted?.pathNames, ['Customer A', 'a-regranted']);
      assert.deepEqual(regranted.path, [branchId, regrantedId]);
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

        // And read, one schedule and the list, which the sweep calls and cannot judge: a count
        // carries no marker (`A-31`).
        const read = async (login: string): Promise<number[]> => {
          const one = await app.inject({
            method: 'GET',
            url: `/api/v1/schedules/${String(scheduleId)}`,
            headers: as(login),
          });
          assert.equal(one.statusCode, 200, one.body);
          const all = await app.inject({
            method: 'GET',
            url: '/api/v1/schedules',
            headers: as(login),
          });
          assert.equal(all.statusCode, 200, all.body);
          const listed = all
            .json<{ items: { id: number; usedBy: number }[] }>()
            .items.find((item) => item.id === scheduleId);
          return [one.json<{ usedBy: number }>().usedBy, listed?.usedBy ?? -1];
        };
        assert.deepEqual(await read('watcher'), [1, 1]);
        assert.deepEqual(await read('admin'), [2, 2]);
      } finally {
        await db.query(
          `DELETE FROM object_setting WHERE key = 'schedule.id' AND object_id = ANY($1::bigint[])`,
          [users],
        );
      }
    });

    /** An error answer, as a caller could compare two: the id they sent taken out. */
    const answerFor = (response: { statusCode: number; body: string }, id: number): string => {
      const { error } = JSON.parse(response.body) as { error: Record<string, unknown> };
      return (
        `${String(response.statusCode)} ${String(error['code'])} ` +
        String(error['message']).replace(String(id), '<id>')
      );
    };

    it('answers a hidden rediscovery rule as an id nobody used, on every route that takes one', async () => {
      // `D-11`. A writer on the branch, so a 403 from the guard, naming the rule's group, is
      // what a hidden rule got before `A-37`, and an unused id gets the route's 404.
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
          answers.push(answerFor(response, id));
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

    it('answers a hidden discovery run as an id nobody used, on every route that takes one (A-37)', async () => {
      // The guard answered 403 with the run's group in it, where an unused id got the route's
      // 404, and the problems and plan routes answered an unused id with an empty list.
      const routes: ['GET' | 'POST', string][] = [
        ['GET', ''],
        ['GET', '/summary'],
        ['GET', '/hosts'],
        ['GET', '/problems'],
        ['GET', '/plan'],
        ['POST', '/cancel'],
      ];
      for (const [method, suffix] of routes) {
        const answers = [];
        for (const id of [hiddenRunId, 999_999]) {
          const response = await app.inject({
            method,
            url: `/api/v1/discovery/${String(id)}${suffix}`,
            headers: as('operator'),
          });
          answers.push(answerFor(response, id));
        }
        assert.equal(answers[0], answers[1], `${method} ${suffix}`);
        assert.equal(
          answers[0],
          '404 DISCOVERY_RUN_NOT_FOUND there is no discovery run <id>',
          `${method} ${suffix}`,
        );
      }
      const run = await db.query<{ status: string }>(
        `SELECT status FROM discovery_run WHERE id = $1`,
        [hiddenRunId],
      );
      assert.notEqual(run[0]?.status, 'cancelled', 'and the run was not stopped');
    });

    it('answers a library the team was not given as an id nobody used (A-31)', async () => {
      // `A-12` said so, and only the marker's absence was ever asserted.
      const answers = [];
      for (const id of [hiddenLibraryId, 999_999]) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/libraries/${String(id)}`,
          headers: as('watcher'),
        });
        answers.push(answerFor(response, id));
      }
      assert.equal(answers[0], answers[1]);
      assert.match(answers[0] ?? '', /^404 /);
    });

    it('refuses a scope naming an object outside the branch', async () => {
      for (const url of [
        `/api/v1/alarms?objectId=${String(probeId)}`,
        `/api/v1/state-log?objectId=${String(probeId)}`,
        `/api/v1/objects?parentId=${String(probeId)}`,
        `/api/v1/notification-requests?sensorId=${String(otherSensorId)}`,
        `/api/v1/discovery/schedules?groupId=${String(otherGroupId)}`,
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

    it('serves the installation’s own health to nobody who cannot read the root (A-31)', async () => {
      // Numbers and ids, so no marker to find: the refusal is the assertion, and an
      // administrator's answer is what shows the route would have said something.
      for (const url of [
        '/api/v1/core-health',
        '/api/v1/notification-health',
        '/api/v1/probes',
        `/api/v1/probes/${String(probeId)}/health`,
        '/metrics',
      ]) {
        const refused = await app.inject({ method: 'GET', url, headers: as('watcher') });
        assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`);
        const control = await app.inject({ method: 'GET', url, headers: as('admin') });
        assert.equal(control.statusCode, 200, `${url}, as an administrator: ${control.body}`);
      }
    });

    it('answers the runbook’s check from outside 200 for a read-only token, and nothing else (H-18)', async () => {
      // `administration.md` gives an operator a cron line: `GET /core-health` with a read-only
      // API token, anything but a 200 is down. Every half of that sentence is asserted here, on
      // the least an account can be: read-only, holding `read` on the root and nothing more.
      await access.grant(harness.rootId, rootReadersId, 'read', actorNamed('visibility'));
      const issued = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/tokens',
        headers: as('rooted'),
        payload: { name: 'outside check', scope: 'read' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const { secret, token } = issued.json<{ secret: string; token: { id: number } }>();
      const check = (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: '/api/v1/core-health', headers });

      const up = await check({ authorization: `Bearer ${secret}` });
      assert.equal(up.statusCode, 200, up.body);
      assert.ok('ingestQueue' in up.json<{ channels: Record<string, unknown> }>().channels);

      // Not a 200 for anybody who is not that token: so a 200 is the core, and not a login page
      // or a proxy's welcome.
      assert.equal((await check({})).statusCode, 401);
      assert.equal((await check({ authorization: `Bearer ${secret}x` })).statusCode, 401);
      assert.equal((await check({ authorization: 'Bearer mst_never-issued' })).statusCode, 401);

      // And the token is read-only in fact: the same secret changes nothing.
      const write = await app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        payload: { kind: 'group', parentId: probeId, name: 'made by the check' },
      });
      assert.equal(write.statusCode, 403, write.body);

      // Revoked, it stops answering, so a token that leaked from a crontab can be ended.
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/tokens/${String(token.id)}`,
        headers: as('rooted'),
      });
      assert.equal(revoked.statusCode, 204, revoked.body);
      assert.equal((await check({ authorization: `Bearer ${secret}` })).statusCode, 401);
    });

    it('does not answer that check 200 while the database a token is checked against is gone (H-18)', async () => {
      // The route itself answers without a database (`P-126`): its numbers degrade to gaps. What
      // makes the check from outside cover the database is the token, which is looked up there —
      // so this is a second server whose tokens are read from a database that refuses.
      const gone = {
        query: () =>
          Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
              code: 'ECONNREFUSED',
            }),
          ),
      } as unknown as Database;
      const coreHealth = fixedCoreHealth(db);
      const audit = new DatabaseAuditSink();
      const outside = new ApiServer({
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
        catalogue: testCatalogue(),
        coreHealth: () => coreHealth,
        auth: {
          accounts: new AccountService({ audit, db, logger: silent }),
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ audit, db: gone, logger: silent }),
          totp: new TotpService({ audit, db, logger: silent }),
          required: true,
        },
      });
      await outside.build('9.9.9', harness.service);
      try {
        const down = await outside.app.inject({
          method: 'GET',
          url: '/api/v1/core-health',
          headers: { authorization: 'Bearer mst_any-token-at-all' },
        });
        assert.equal(down.statusCode, 500, down.body);
        // The control: the same server answers the same route to a session, which this database
        // can still check. So the refusal above is the token's lookup and nothing else.
        const control = await outside.app.inject({
          method: 'GET',
          url: '/api/v1/core-health',
          headers: as('admin'),
        });
        assert.equal(control.statusCode, 200, control.body);
      } finally {
        await outside.app.close();
      }
    });

    it('scrapes without the probes a root reader was carved out of (A-31)', async () => {
      // `#withoutHiddenProbes` ran in no test: it needs an account that clears the root bar and
      // still has a probe hidden from it.
      await access.grant(harness.rootId, rootReadersId, 'read', actorNamed('visibility'));
      await access.grant(probeId, rootReadersId, 'none', actorNamed('visibility'));
      const series = (body: string, probe: number): number =>
        body.split('\n').filter((line) => line.includes(`probe="${String(probe)}"`)).length;

      const all = await app.inject({ method: 'GET', url: '/metrics', headers: as('admin') });
      assert.equal(all.statusCode, 200, all.body);
      assert.ok(series(all.body, probeId) > 0, 'the control: the scrape has the hidden probe');
      assert.ok(series(all.body, secondProbeId) > 0);

      const rooted = await app.inject({ method: 'GET', url: '/metrics', headers: as('rooted') });
      assert.equal(rooted.statusCode, 200, rooted.body);
      assert.equal(series(rooted.body, probeId), 0, 'a series of the hidden probe was scraped');
      assert.equal(series(rooted.body, secondProbeId), series(all.body, secondProbeId));
      assert.ok(!rooted.body.includes(`${MARK}-probe"`), 'the hidden probe was named');
    });

    it('refuses a sensor naming what its writer cannot read, as it refuses one naming nothing (A-29)', async () => {
      const write = (sensorType: string, params: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/objects',
          headers: { ...as('operator'), 'content-type': 'application/json' },
          payload: { kind: 'sensor', parentId: deviceId, name: 'a-sum', sensorType, params },
        });
      const naming = (id: number) => ({
        channels: [{ key: 'x', formula: `channel(${String(id)}, 'rtt')` }],
      });
      /** The body a caller sees, with the one thing it supplied itself taken out. */
      const said = (body: string, id: number): Record<string, unknown> => {
        const { error } = JSON.parse(body) as {
          error: { message: string; context: Record<string, unknown>; correlationId: string };
        };
        const { correlationId: _, message, context, ...rest } = error;
        assert.equal(context['objectId'], id);
        return {
          ...rest,
          message: message.replaceAll(String(id), 'N'),
          context: { ...context, objectId: 'N' },
        };
      };

      // A formula naming a hidden sensor would republish its readings inside the branch.
      const hidden = await write('core.factory', naming(otherSensorId));
      assert.equal(hidden.statusCode, 403, hidden.body);
      assert.ok(!hidden.body.includes(MARK), hidden.body);
      const neverIssued = otherSensorId + 1_000_000;
      const missing = await write('core.factory', naming(neverIssued));
      assert.equal(missing.statusCode, 403, missing.body);
      assert.deepEqual(said(hidden.body, otherSensorId), said(missing.body, neverIssued));

      // Probe Health with no `probeId` names the probe above the device, which is outside the
      // branch; Core Health reports on the whole installation.
      const probeHealth = await write('ms.probe.health', {});
      assert.equal(probeHealth.statusCode, 403, probeHealth.body);
      assert.ok(!probeHealth.body.includes(MARK), probeHealth.body);
      const coreHealth = await write('ms.core.health', {});
      assert.equal(coreHealth.statusCode, 403, coreHealth.body);

      // What the account can read, it can build on.
      const fine = await write('core.factory', naming(pingId));
      assert.equal(fine.statusCode, 201, fine.body);
      await harness.service.delete(
        testActor,
        fine.json<{ id: number }>().id,
        { kind: 'leafOnly' },
        { kind: 'none' },
      );
    });

    it('asks what a writer can see only for a write that names something, on its own connection (P-235)', async (t) => {
      // Resolving the sight up front cost a query on every authenticated write, and only a
      // sensor of a type that reads another object's data ever looked at the answer.
      const asked: { onThePool: boolean }[] = [];
      const visibilityFor = access.visibilityFor.bind(access);
      access.visibilityFor = (principal, q) => {
        asked.push({ onThePool: q === undefined || q === db });
        return visibilityFor(principal, q);
      };
      t.after(() => {
        Reflect.deleteProperty(access, 'visibilityFor');
      });
      // Write on the branch for this test, so the operator can put a group and a device in it;
      // `beforeEach` puts read back.
      await access.grant(branchId, teamId, 'write', actorNamed('visibility'));
      const create = (payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/objects',
          headers: { ...as('operator'), 'content-type': 'application/json' },
          payload,
        });

      const group = await create({ kind: 'group', parentId: branchId, name: 'p235-group' });
      assert.equal(group.statusCode, 201, group.body);
      const device = await create({
        kind: 'device',
        parentId: branchId,
        name: 'p235-device',
        host: '192.0.2.235',
      });
      assert.equal(device.statusCode, 201, device.body);
      const ping = await create({
        kind: 'sensor',
        parentId: deviceId,
        name: 'p235-ping',
        sensorType: 'icmp.ping',
      });
      assert.equal(ping.statusCode, 201, ping.body);
      assert.deepEqual(asked, [], 'a write that names nothing never asked');

      const factory = await create({
        kind: 'sensor',
        parentId: deviceId,
        name: 'p235-sum',
        sensorType: 'core.factory',
        params: { channels: [{ key: 'x', formula: `channel(${String(pingId)}, 'rtt')` }] },
      });
      assert.equal(factory.statusCode, 201, factory.body);
      assert.deepEqual(asked, [{ onThePool: false }], 'once, inside the write’s transaction');

      for (const made of [factory, ping, device, group]) {
        await harness.service.delete(
          testActor,
          made.json<{ id: number }>().id,
          { kind: 'leafOnly' },
          { kind: 'none' },
        );
      }
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

  describe('an object’s answer is the caller’s own (A-32)', () => {
    /**
     * A restricted caller's answer about one object holds what their grants decide, and neither
     * the object's version nor its chain moves with a grant. Each case here was a 304 before
     * `A-32`: a tag the caller already held, served back over an answer that had changed.
     */
    const PRIVATE = 'private, max-age=0, must-revalidate';
    const detail = (login: string, id: number, tag?: string, include?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}${include === undefined ? '' : `?include=${include}`}`,
        headers: { ...as(login), ...(tag === undefined ? {} : { 'if-none-match': tag }) },
      });
    const tagOf = (response: { headers: Record<string, unknown> }): string =>
      String(response.headers['etag']);

    it('stops answering 304 once a hole changes what it counts', async () => {
      const first = await detail('watcher', deviceId);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.headers['cache-control'], PRIVATE);
      assert.equal(first.json<{ childCount: number }>().childCount, 2, 'a-ping and a-held');
      const unchanged = await detail('watcher', deviceId, tagOf(first));
      assert.equal(unchanged.statusCode, 304, 'nothing has changed yet');
      assert.equal(unchanged.headers['cache-control'], PRIVATE);

      await access.grant(heldId, teamId, 'none', actorNamed('visibility'));
      try {
        const carved = await detail('watcher', deviceId, tagOf(first));
        assert.equal(carved.statusCode, 200, 'a 304 would keep counting a-held');
        assert.equal(carved.json<{ childCount: number }>().childCount, 1);
      } finally {
        await access.revoke(heldId, teamId, actorNamed('visibility'));
      }
    });

    it('stops answering 304 once a grant lengthens the path it shows', async () => {
      const ancestorsOf = (response: { body: string }): number[] =>
        (JSON.parse(response.body) as { ancestors: { id: number }[] }).ancestors.map(
          (one) => one.id,
        );
      const first = await detail('watcher', pingId, undefined, 'ancestors');
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(ancestorsOf(first), [branchId, deviceId], 'trimmed to the branch');

      await access.grant(probeId, teamId, 'read', actorNamed('visibility'));
      try {
        const granted = await detail('watcher', pingId, tagOf(first), 'ancestors');
        assert.equal(granted.statusCode, 200, 'a 304 would keep a path without the probe');
        assert.deepEqual(ancestorsOf(granted), [probeId, branchId, deviceId]);
      } finally {
        await access.revoke(probeId, teamId, actorNamed('visibility'));
      }
    });

    it('stops answering 304 once a child it can see is added, which moves no grant', async () => {
      const first = await detail('watcher', deviceId);
      const added = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'a-added',
        sensorType: 'icmp.ping',
      });
      try {
        const grown = await detail('watcher', deviceId, tagOf(first));
        assert.equal(grown.statusCode, 200, 'a 304 would keep the count at two');
        assert.equal(grown.json<{ childCount: number }>().childCount, 3);
      } finally {
        await harness.service.delete(testActor, added.id, { kind: 'leafOnly' }, { kind: 'none' });
      }
    });

    it('never answers one account with a tag rendered for another', async () => {
      // The same team and the same view: only the principal tells the two tags apart.
      const watcher = await detail('watcher', deviceId);
      const operator = await detail('operator', deviceId, tagOf(watcher));
      assert.equal(operator.statusCode, 200);
      assert.notEqual(tagOf(operator), tagOf(watcher));
    });

    it('gives an administrator a tag that covers the count, and takes either as If-Match', async () => {
      // `W/"<version>"` until `A-49`, which let a child created under the object answer 304.
      const admin = await detail('admin', deviceId);
      assert.match(tagOf(admin), /^W\/"\d+-[0-9a-f]{32}"$/);
      const byAdmin = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: { ...as('admin'), 'if-match': tagOf(admin) },
        payload: { kind: 'device', comments: 'edited from an administrator’s tag (A-49)' },
      });
      assert.equal(byAdmin.statusCode, 200, byAdmin.body);
      const operator = await detail('operator', deviceId);
      assert.match(tagOf(operator), /^W\/"\d+-[0-9a-f]{32}"$/);
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: { ...as('operator'), 'if-match': tagOf(operator) },
        payload: { kind: 'device', comments: 'edited from a restricted tag (A-32)' },
      });
      assert.equal(patched.statusCode, 200, patched.body);
    });
  });

  describe('four answers that told what the reader cannot see (A-49)', () => {
    const detail = (login: string, id: number, tag?: string, include?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}${include === undefined ? '' : `?include=${include}`}`,
        headers: { ...as(login), ...(tag === undefined ? {} : { 'if-none-match': tag }) },
      });
    const tagOf = (response: { headers: Record<string, unknown> }): string =>
      String(response.headers['etag']);
    const comment = (id: number, kind: 'probe' | 'group', comments: string) =>
      harness.service.update(testActor, id, { kind, comments }, { kind: 'none' });

    it('answers 304 when only an ancestor it cannot see changed, and 200 for one it can', async () => {
      const first = await detail('watcher', pingId, undefined, 'ancestors');
      assert.equal(first.statusCode, 200, first.body);

      // The probe above the branch: a changed tag on an unchanged body would tell of this edit.
      await comment(probeId, 'probe', 'edited out of the watcher’s sight (A-49)');
      const hidden = await detail('watcher', pingId, tagOf(first), 'ancestors');
      assert.equal(hidden.statusCode, 304, 'the tag moved for an ancestor the path leaves out');

      await comment(branchId, 'group', 'edited in the watcher’s sight (A-49)');
      const seen = await detail('watcher', pingId, tagOf(first), 'ancestors');
      assert.equal(seen.statusCode, 200, 'a step of the path it shows is still covered');
    });

    it('covers every ancestor when the answer carries what they hand down', async () => {
      // Inherited settings and credentials come from hidden ancestors by design, so a change to
      // one of those is a change to the answer.
      for (const [login, include] of [
        ['watcher', 'settings'],
        ['operator', 'credentials'],
      ] as const) {
        const first = await detail(login, pingId, undefined, include);
        assert.equal(first.statusCode, 200, first.body);
        await comment(probeId, 'probe', `changed under ?include=${include} (A-49)`);
        const after = await detail(login, pingId, tagOf(first), include);
        assert.equal(after.statusCode, 200, `${include}: a hidden ancestor's change was 304`);
      }
    });

    it('answers an administrator 200 once a child is added, deleted or moved out', async () => {
      const countOf = (response: { body: string }): number =>
        (JSON.parse(response.body) as { childCount: number }).childCount;
      const first = await detail('admin', deviceId);
      const before = countOf(first);

      const added = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'a-counted',
        sensorType: 'icmp.ping',
      });
      const grown = await detail('admin', deviceId, tagOf(first));
      assert.equal(grown.statusCode, 200, 'a 304 would keep the old count');
      assert.equal(countOf(grown), before + 1);

      await harness.service.move(testActor, added.id, lonelyDeviceId, { kind: 'none' });
      const movedOut = await detail('admin', deviceId, tagOf(grown));
      assert.equal(movedOut.statusCode, 200, 'moved out, and the count kept');
      assert.equal(countOf(movedOut), before);

      await harness.service.move(testActor, added.id, deviceId, { kind: 'none' });
      const back = await detail('admin', deviceId);
      await harness.service.delete(testActor, added.id, { kind: 'leafOnly' }, { kind: 'none' });
      const deleted = await detail('admin', deviceId, tagOf(back));
      assert.equal(deleted.statusCode, 200, 'deleted, and the count kept');
      assert.equal(countOf(deleted), before);

      const unchanged = await detail('admin', deviceId, tagOf(deleted));
      assert.equal(unchanged.statusCode, 304, 'and nothing changed since answers 304');
    });

    it('tells a non-administrator a hidden object’s access as it tells an unused id', async () => {
      const effective = (login: string, id: number, userId?: number) =>
        app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(id)}/access/effective${
            userId === undefined ? '' : `?userId=${String(userId)}`
          }`,
          headers: as(login),
        });
      const nothing = {
        right: 'none',
        sourceObjectId: null,
        sourceGroupId: null,
        inherited: false,
        viaAdminGroup: false,
      };
      // The carved device, a sensor under it, and an id nothing has.
      for (const id of [carvedDeviceId, underCarveId, 2 ** 31 - 1]) {
        const response = await effective('watcher', id);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), nothing, String(id));
        assert.doesNotMatch(response.body, /\d/, 'no id of the hole, nor of anything in it');
      }
      const visible = await effective('watcher', pingId);
      assert.equal(visible.json<{ right: string }>().right, 'read', 'the control');

      // An administrator asking about the account is still told where the `none` came from.
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: as('watcher'),
      });
      const watcherId = me.json<{ userId: number }>().userId;
      const debugged = await effective('admin', underCarveId, watcherId);
      assert.equal(debugged.statusCode, 200, debugged.body);
      assert.deepEqual(
        {
          right: debugged.json<{ right: string }>().right,
          source: debugged.json<{ sourceObjectId: number }>().sourceObjectId,
          inherited: debugged.json<{ inherited: boolean }>().inherited,
        },
        { right: 'none', source: carvedDeviceId, inherited: true },
      );
    });

    it('hides a hidden device’s address with its name, drafted or saved', async () => {
      const template = {
        name: 'Addresses (A-49)',
        method: 'email',
        settings: {},
        subject: '%device|%host',
        body: '%device|%host',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
      };
      const draft = (login: string, sensorId: number) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/templates/preview',
          headers: as(login),
          payload: { template, sensorId },
        });

      const hidden = await draft('watcher', regrantedId);
      assert.equal(hidden.statusCode, 200, hidden.body);
      assert.ok(!hidden.body.includes('10.0.0.2'), 'the carved device’s address was rendered');
      assert.ok(hidden.body.includes('(outside your view)|(outside your view)'), hidden.body);
      assert.ok((await draft('admin', regrantedId)).body.includes('10.0.0.2'), 'the control');
      assert.ok((await draft('watcher', pingId)).body.includes('10.0.0.1'), 'a visible device');

      const saved = await app.inject({
        method: 'POST',
        url: '/api/v1/templates',
        headers: as('admin'),
        payload: template,
      });
      assert.equal(saved.statusCode, 201, saved.body);
      const id = saved.json<{ id: number }>().id;
      try {
        const previewed = await app.inject({
          method: 'GET',
          url: `/api/v1/templates/${String(id)}/preview?sensorId=${String(regrantedId)}`,
          headers: as('watcher'),
        });
        assert.equal(previewed.statusCode, 200, previewed.body);
        assert.ok(!previewed.body.includes('10.0.0.2'), 'the saved preview rendered the address');
      } finally {
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/templates/${String(id)}`,
          headers: as('admin'),
        });
      }
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
        await waitFor(branchFrames, 'snapshot');
        await waitFor(adminFrames, 'snapshot');

        // The branch is taken away while the socket is open, and then something in it changes.
        await access.grant(branchId, teamId, 'none', actorNamed('visibility'));
        const mark = branchFrames.length;
        await scan([pingId], true);

        const overflow = await waitFor(branchFrames, 'overflow', mark);
        assert.match(String(overflow['reason']), /may see has changed/);
        assert.equal(
          branchFrames.slice(mark).some((frame) => frame.includes('"type":"state"')),
          false,
          'a change was streamed to a socket that may no longer see it',
        );

        // Subscribing again is the resync, and it takes a snapshot of the new view.
        const again = branchFrames.length;
        branch.send(JSON.stringify({ subscribe: {} }));
        const fresh = await waitFor(branchFrames, 'snapshot', again);
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

    it('says a probe changed to a reader of that probe and to nobody else (U-24)', async () => {
      // The branch account has sensors of its own under this probe and cannot see the probe —
      // the reader `GET /probes/{id}/health` refuses, and who must be told nothing here either.
      const branch = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      const admin = await app.injectWS('/api/v1/stream', { headers: as('admin') });
      const branchFrames: string[] = [];
      const adminFrames: string[] = [];
      branch.on('message', (raw: Buffer) => branchFrames.push(raw.toString('utf8')));
      admin.on('message', (raw: Buffer) => adminFrames.push(raw.toString('utf8')));
      const watch = (socket: WebSocket, id: number): void => {
        socket.send(JSON.stringify({ subscribe: { probeId: id } }));
      };
      const about = (frames: readonly string[], from: number): Record<string, unknown>[] =>
        frames
          .slice(from)
          .map((frame) => JSON.parse(frame) as Record<string, unknown>)
          .filter((frame) => frame['type'] === 'probe' || frame['type'] === 'watching');
      try {
        // Refused, and in one answer whatever the id is: a probe out of view, an id nobody used,
        // and an object it can read that is not a probe.
        watch(branch, probeId);
        const refused = await waitFor(branchFrames, 'problem');
        assert.match(String(refused['reason']), /may not read a probe with that id/);
        for (const id of [2_000_000_000, deviceId]) {
          const at = branchFrames.length;
          watch(branch, id);
          assert.deepEqual(await waitFor(branchFrames, 'problem', at), refused);
        }

        watch(admin, probeId);
        assert.deepEqual(await waitFor(adminFrames, 'watching'), {
          type: 'watching',
          probeId,
        });

        // The probe's link moves, three times. The administrator is told each time, in a frame
        // that is the id and nothing else.
        for (let edge = 0; edge < 3; edge += 1) {
          const at = adminFrames.length;
          await stream.publishProbe(db, probeId);
          assert.deepEqual(await waitFor(adminFrames, 'probe', at), {
            type: 'probe',
            probeId,
          });
        }
        // The branch account is not, and a frame it can be waited on proves it had the chance.
        const barrier = branchFrames.length;
        branch.send(JSON.stringify({ subscribe: {} }));
        await waitFor(branchFrames, 'snapshot', barrier);
        assert.deepEqual(about(branchFrames, 0), [], 'a reader who cannot see the probe was told');
        // Nor is a subscription to sensors a watch: the administrator's other probe says nothing
        // to a socket watching this one.
        const quiet = adminFrames.length;
        await stream.publishProbe(db, secondProbeId);

        // Access is granted: the watch is allowed, and the next change is sent.
        await access.grant(probeId, teamId, 'read', actorNamed('visibility'));
        const granted = branchFrames.length;
        watch(branch, probeId);
        assert.deepEqual(await waitFor(branchFrames, 'watching', granted), {
          type: 'watching',
          probeId,
        });
        await stream.publishProbe(db, probeId);
        assert.deepEqual(await waitFor(branchFrames, 'probe', granted), {
          type: 'probe',
          probeId,
        });
        await waitFor(adminFrames, 'probe', quiet);
        assert.deepEqual(
          about(adminFrames, quiet).map((frame) => frame['probeId']),
          [probeId],
          'a watch on one probe was told about another',
        );

        // And taken away while the socket is open. Nothing but watches are attached — no tree
        // subscriber — and the probe's link then moves three times. The administrator hears
        // each edge; the reader who lost the probe is sent **nothing** at any of them: not the
        // frame, and not an `overflow` either, whose arrival would say when a probe it can no
        // longer see connected or dropped.
        await access.grant(probeId, teamId, 'none', actorNamed('visibility'));
        assert.equal(stream.watching, false);
        const revoked = branchFrames.length;
        for (let edge = 0; edge < 3; edge += 1) {
          const at = adminFrames.length;
          await stream.publishProbe(db, probeId);
          await waitFor(adminFrames, 'probe', at);
        }
        // A frame the socket can be waited on, sent after the edges, bounds the wait: anything
        // the edges sent it would have arrived first.
        branch.send('not a subscription');
        await waitFor(branchFrames, 'problem', revoked);
        assert.deepEqual(
          branchFrames.slice(revoked).map((frame) => (JSON.parse(frame) as { type: string }).type),
          ['problem'],
          'a reader whose access to the probe was taken away was told something at its edges',
        );

        // The sweep's tick, run by hand, is what sends it back to the start.
        const tick = branchFrames.length;
        await stream.sweep();
        const overflow = await waitFor(branchFrames, 'overflow', tick);
        assert.match(String(overflow['reason']), /may see has changed/);
        // Watching again is refused as it was at first, and later edges and ticks say nothing.
        const again = branchFrames.length;
        watch(branch, probeId);
        assert.deepEqual(await waitFor(branchFrames, 'problem', again), refused);
        const after = branchFrames.length;
        await stream.publishProbe(db, probeId);
        await stream.sweep();
        branch.send('not a subscription');
        await waitFor(branchFrames, 'problem', after);
        assert.equal(branchFrames.length, after + 1, 'something followed the refusal');
        assert.deepEqual(
          about(branchFrames, revoked),
          [],
          'a frame went to a reader whose access to the probe was taken away',
        );

        // The administrator's view never changed, so it was never disturbed.
        assert.equal(
          adminFrames.some((frame) => frame.includes('"type":"overflow"')),
          false,
        );
        assert.equal(
          branchFrames.some((frame) => frame.includes(MARK)),
          false,
          'the stream carried something outside the branch',
        );

        // A subtree and a probe are two subscriptions, and a socket has one.
        const both = adminFrames.length;
        admin.send(JSON.stringify({ subscribe: { objectId: probeId, probeId } }));
        const problem = await waitFor(adminFrames, 'problem', both);
        assert.match(String(problem['reason']), /the only message this stream takes/);
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
        await waitFor(frames, 'snapshot');
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

        const overflow = await waitFor(frames, 'overflow', mark);
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
        const snapshot = await waitFor(frames, 'snapshot');
        const entries = snapshot['entries'] as { sensorId: number; state: string }[];
        assert.equal(entries.find((entry) => entry.sensorId === pingId)?.state, 'up');

        const at = frames.findIndex((frame) => frame.includes('"type":"snapshot"'));
        const change = await waitFor(frames, 'state', at + 1);
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
        const overflow = await waitFor(frames, 'overflow');
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
        const replacement = await waitFor(frames, 'snapshot');
        assert.equal(replacement['objectId'], null);

        release();
        await first;
        // A change after it, so whatever the replaced read would send has gone out before this.
        const mark = frames.length;
        await scan([pingId], false);
        await waitFor(frames, 'state', mark);
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
        await waitFor(frames, 'snapshot');

        release();
        await first;
        const mark = frames.length;
        await scan([pingId], false);
        const change = await waitFor(frames, 'state', mark);
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
      // And another group's `write` on the box itself: a grant, which only an administrator may
      // make, so the operator's copy leaves it behind and says so (`A-76`).
      await access.grant(boxId, auditorsId, 'write', actorNamed('visibility'));
      const auditorsOn = async (id: number): Promise<string[]> =>
        (
          await db.query<{ right_: string }>(
            `SELECT right_::text AS right_ FROM object_access WHERE object_id = $1 AND group_id = $2`,
            [id, auditorsId],
          )
        ).map((row) => row.right_);

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
        grantsNotCarried: number;
      }>();
      // The box and the two sensors the operator can see; the hole is neither copied nor counted.
      assert.deepEqual([result.clonedCount.total, result.clonedCount.sensor], [3, 2]);
      assert.equal(result.grantsNotCarried, 1, 'the Auditors’ write on the box');
      assert.deepEqual(await auditorsOn(result.object.id), []);
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

      // Each carried grant is in the audit log as a grant made by the cloner, beside the clone,
      // and the one left behind beside them (`A-76`).
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
          ['grant.notCarried', 'operator'],
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
      const inPlaceCopy = inPlace.json<{ object: { id: number }; grantsNotCarried: number }>();
      assert.deepEqual(await childrenOf(inPlaceCopy.object.id), ['a-box-ping', 'a-box-read-only']);
      assert.equal(inPlaceCopy.grantsNotCarried, 1);
      assert.deepEqual(await auditorsOn(inPlaceCopy.object.id), []);
      const bulk = await app.inject({
        method: 'POST',
        url: '/api/v1/objects/bulk',
        headers: as('operator'),
        payload: { ids: [boxId], operation: 'clone', targetParentId: spareId },
      });
      assert.equal(bulk.statusCode, 200, bulk.body);
      const bulkOutcome = bulk.json<{
        outcomes: { createdId?: number; grantsNotCarried?: number }[];
      }>().outcomes[0];
      const createdId = bulkOutcome?.createdId;
      assert.ok(createdId !== undefined, bulk.body);
      assert.deepEqual(await childrenOf(createdId), ['a-box-ping', 'a-box-read-only']);
      assert.equal(bulkOutcome?.grantsNotCarried, 1, bulk.body);
      assert.deepEqual(await auditorsOn(createdId), []);

      // The control: an administrator's clone copies the hole, grant and all.
      const whole = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(boxId)}/clone`,
        headers: as('admin'),
        payload: { targetParentId: spareId },
      });
      assert.equal(whole.statusCode, 201, whole.body);
      const wholeId = whole.json<{ object: { id: number } }>().object.id;
      // Every grant, the Auditors' `write` included, and none left behind (`A-76`).
      assert.equal(whole.json<{ grantsNotCarried: number }>().grantsNotCarried, 0);
      assert.deepEqual(await auditorsOn(wholeId), ['write']);
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

    it('refuses one beside a parent the caller cannot see without naming the parent (A-37)', async () => {
      // `a-regranted` hangs in the carved-out device. Given `write` on the sensor, the caller
      // may take it, and may not see where a copy made in place would land.
      await access.grant(regrantedId, teamId, 'write', actorNamed('visibility'));
      try {
        const inPlace = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(regrantedId)}/clone`,
          headers: as('operator'),
        });
        assert.equal(inPlace.statusCode, 403, inPlace.body);
        const { error } = inPlace.json<{
          error: { message: string; context: Record<string, unknown> };
        }>();
        assert.equal(
          error.message,
          'a clone made in place goes beside its source, and this account may not write there',
        );
        assert.deepEqual(error.context, {
          objectId: regrantedId,
          needed: 'write',
          via: 'a clone made in place',
        });
        assert.ok(!inPlace.body.includes(MARK), inPlace.body);
        assert.doesNotMatch(inPlace.body, new RegExp(`\\b${String(carvedDeviceId)}\\b`, 'u'));
      } finally {
        await access.grant(regrantedId, teamId, 'read', actorNamed('visibility'));
      }
    });
  });

  /**
   * `A-16`: the answers to writes. Each is an answer to a caller holding `write` on what it names,
   * which is why `A-12`'s sweep of reads did not reach them, and each named, counted or rendered
   * something outside the caller's branch. The operator here is the fixture's: `write` on one
   * device, `read` on the branch, and nothing above it.
   */
  describe('answers to writes name nothing outside the branch (A-16)', () => {
    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await harness.service.create(testActor, input as never)).id;
    const grant = (id: number, right: 'none' | 'read' | 'write'): Promise<unknown> =>
      access.grant(id, teamId, right, actorNamed('visibility'));

    interface Refusal {
      readonly status: number;
      readonly body: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
    const call = async (
      login: string,
      method: 'DELETE' | 'POST' | 'PATCH',
      url: string,
      payload?: object,
    ): Promise<Refusal> => {
      // An edit is made against what its caller last read.
      const read =
        method === 'PATCH'
          ? await app.inject({ method: 'GET', url: `/api/v1/${url}`, headers: as(login) })
          : undefined;
      const response = await app.inject({
        method,
        url: `/api/v1/${url}`,
        headers: {
          ...as(login),
          ...(read === undefined ? {} : { 'if-match': String(read.headers.etag) }),
        },
        ...(payload === undefined ? {} : { payload }),
      });
      const parsed = JSON.parse(response.body) as {
        error?: { message?: string; details?: Record<string, unknown> };
      };
      return {
        status: response.statusCode,
        body: response.body,
        message: parsed.error?.message ?? '',
        details: parsed.error?.details ?? {},
      };
    };
    /** What a refusal tells its caller, without the correlation id every answer has its own of. */
    const told = (refusal: Refusal): string =>
      JSON.stringify([refusal.status, refusal.message, refusal.details]);

    it('names what holds a resume only where the resumer can see it', async () => {
      // A master in the other branch, Down: `a-held` is held by it, and the operator may write it.
      await scan([otherSensorId], false);
      const dependencies = harness.dependencies;
      assert.ok(dependencies !== undefined);
      await db.tx((q) => dependencies.recompute(q, new Date()));

      const held = await call('operator', 'DELETE', `objects/${String(heldId)}/pause`);
      assert.equal(held.status, 409, held.body);
      assert.ok(!held.body.includes(MARK), held.body);
      assert.equal(held.details['masterId'], otherSensorId);
      assert.equal(held.details['masterName'], null);
      assert.match(held.message, new RegExp(`master #${String(otherSensorId)} is Down`));
      // The control: an administrator is told what to fix.
      const adminHeld = await call('admin', 'DELETE', `objects/${String(heldId)}/pause`);
      assert.equal(adminHeld.status, 409, adminHeld.body);
      assert.equal(adminHeld.details['masterName'], `${MARK}-b-sensor`);

      // A pause on the probe above the branch, inherited by every sensor in it.
      await harness.service.pause(testActor, probeId, { kind: 'indefinite' }, 'probe swap');
      try {
        const inherited = await call('operator', 'DELETE', `objects/${String(pingId)}/pause`);
        assert.equal(inherited.status, 409, inherited.body);
        assert.ok(!inherited.body.includes(MARK), inherited.body);
        assert.deepEqual(
          [inherited.details['pausedBy'], inherited.details['pausedByName']],
          [probeId, null],
        );
        assert.equal(
          inherited.message,
          `this object is paused because #${String(probeId)} is paused; resume that instead`,
        );
        const named = await call('admin', 'DELETE', `objects/${String(pingId)}/pause`);
        assert.equal(named.details['pausedByName'], `${MARK}-probe`, named.body);

        // In bulk, where the refusal is the outcome's `problem`.
        const bulk = await call('operator', 'POST', 'objects/bulk', {
          ids: [pingId, heldId],
          operation: 'resume',
        });
        assert.equal(bulk.status, 200, bulk.body);
        assert.ok(!bulk.body.includes(MARK), bulk.body);
        const problems = (
          JSON.parse(bulk.body) as { outcomes: { problem?: string }[] }
        ).outcomes.map((outcome) => outcome.problem ?? '');
        assert.equal(problems.length, 2, bulk.body);
        assert.ok(
          problems.every((problem) => problem.includes(`#${String(probeId)}`)),
          bulk.body,
        );
        const bulkAdmin = await call('admin', 'POST', 'objects/bulk', {
          ids: [pingId],
          operation: 'resume',
        });
        assert.ok(bulkAdmin.body.includes(`${MARK}-probe`), bulkAdmin.body);
      } finally {
        await harness.service.resume(testActor, probeId, Visibility.EVERYTHING);
      }
    });

    it('echoes a test send as its sender may read it', async () => {
      interface Report {
        subject: string;
        body: string;
        notes: string[];
      }
      const test = async (login: string, sensorId: number): Promise<Report> => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/templates/${String(templateId)}/test`,
          headers: as(login),
          payload: { sensorId },
        });
        assert.equal(response.statusCode, 200, `${login}: ${response.body}`);
        return response.json<Report>();
      };
      const NOTE =
        'Containers outside your view read "(outside your view)" here. The message sent names them.';

      // `a-ping`: its device and group are the branch's, and `%probe` is above it.
      const ping = await test('operator', pingId);
      assert.ok(!JSON.stringify(ping).includes(MARK), JSON.stringify(ping));
      assert.match(ping.subject, /^a-ping on a-web01 is /);
      assert.match(ping.body, /via \(outside your view\) in Customer A$/);
      assert.ok(ping.notes.includes(NOTE), ping.notes.join(' | '));
      // `a-regranted`: re-granted inside a carved-out device, which `%device` would name.
      const regranted = await test('operator', regrantedId);
      assert.ok(!JSON.stringify(regranted).includes(MARK), JSON.stringify(regranted));
      assert.match(regranted.subject, /^a-regranted on \(outside your view\) is /);

      // The control: an administrator sees what was rendered, and is told nothing was hidden.
      const whole = await test('admin', pingId);
      assert.match(whole.body, new RegExp(`via ${MARK}-probe in Customer A$`));
      assert.ok(!whole.notes.includes(NOTE), whole.notes.join(' | '));
    });

    it('refuses a template’s delete with the triggers its caller can see, and says if there are others', async () => {
      const refused = await call('operator', 'DELETE', `templates/${String(templateId)}`);
      assert.equal(refused.status, 409, refused.body);
      assert.ok(!refused.body.includes(MARK), refused.body);
      // The trigger on the device, and on any copy of it an earlier test made in the branch; not
      // the one on the probe.
      const listed = (refused.details['usedBy'] as { objectId: number }[]).map((u) => u.objectId);
      assert.ok(listed.includes(deviceId), refused.body);
      assert.ok(!listed.includes(probeId), refused.body);
      assert.equal(refused.details['outsideView'], true);
      assert.equal(
        refused.message,
        `"On-call" is still used by ${String(listed.length)} trigger(s) you can see, and by ` +
          'others outside your view',
      );

      // **Some, not how many.** A second hidden trigger changes nothing the operator is told.
      const added = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(otherGroupId)}/triggers`,
        headers: as('admin'),
        payload: {
          kind: 'state',
          settings: { state: 'down', initialTemplateId: templateId },
          enabled: true,
        },
      });
      assert.equal(added.statusCode, 201, added.body);
      try {
        const again = await call('operator', 'DELETE', `templates/${String(templateId)}`);
        assert.equal(told(again), told(refused));

        // The control: an administrator is shown every one, the two hidden ones by name.
        const all = listed.length + 2;
        const whole = await call('admin', 'DELETE', `templates/${String(templateId)}`);
        assert.equal(whole.status, 409, whole.body);
        assert.equal((whole.details['usedBy'] as unknown[]).length, all, whole.body);
        assert.equal(whole.details['outsideView'], false);
        assert.ok(whole.body.includes(`${MARK}-probe`), whole.body);
        assert.equal(whole.message, `"On-call" is still used by ${String(all)} trigger(s)`);
      } finally {
        const removed = await app.inject({
          method: 'DELETE',
          url: `/api/v1/triggers/${String(added.json<{ id: number }>().id)}`,
          headers: as('admin'),
        });
        assert.equal(removed.statusCode, 200, removed.body);
      }
    });

    it('refuses a schedule’s delete with the users its caller can see, and says if there are others', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        headers: as('operator'),
        payload: {
          name: 'a-doomed schedule',
          grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true)),
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const scheduleId = created.json<{ id: number }>().id;
      const assign = (ids: number[]) =>
        db.query(
          `INSERT INTO object_setting (object_id, key, value)
           SELECT unnest($1::bigint[]), 'schedule.id', to_jsonb($2::bigint)`,
          [ids, scheduleId],
        );
      const unassign = () =>
        db.query(
          `DELETE FROM object_setting WHERE key = 'schedule.id' AND value = to_jsonb($1::bigint)`,
          [scheduleId],
        );
      const url = `schedules/${String(scheduleId)}`;
      const rule = await db.query<{ schedule_id: string | null }>(
        'SELECT schedule_id::text AS schedule_id FROM discovery_schedule WHERE id = $1',
        [hiddenRuleId],
      );
      try {
        await assign([pingId, otherSensorId]);
        const refused = await call('operator', 'DELETE', url);
        assert.equal(refused.status, 409, refused.body);
        assert.ok(!refused.body.includes(MARK), refused.body);
        assert.deepEqual(refused.details['usedBy'], [{ objectId: pingId, name: 'a-ping' }]);
        assert.equal(refused.details['usedByTotal'], 1);
        assert.equal(refused.details['outsideView'], true);
        assert.equal(
          refused.message,
          '"a-doomed schedule" is still assigned to 1 object(s) you can see, and to others ' +
            'outside your view; clear the assignment first',
        );
        // Some, not how many.
        await assign([otherDeviceId]);
        assert.equal(told(await call('operator', 'DELETE', url)), told(refused));
        const whole = await call('admin', 'DELETE', url);
        assert.equal(whole.details['usedByTotal'], 3, whole.body);
        assert.equal(whole.details['outsideView'], false);
        assert.ok(whole.body.includes(`${MARK}-b-sensor`), whole.body);

        // Only hidden users: nothing to name, and still refused.
        await unassign();
        await assign([otherSensorId]);
        const hidden = await call('operator', 'DELETE', url);
        assert.equal(hidden.status, 409, hidden.body);
        assert.deepEqual([hidden.details['usedBy'], hidden.details['usedByTotal']], [[], 0]);
        assert.equal(
          hidden.message,
          '"a-doomed schedule" is still assigned to objects outside your view; clear the ' +
            'assignment first',
        );

        // A rediscovery rule in the other branch whose window it is.
        await unassign();
        await db.query('UPDATE discovery_schedule SET schedule_id = $2 WHERE id = $1', [
          hiddenRuleId,
          scheduleId,
        ]);
        const ruled = await call('operator', 'DELETE', url);
        assert.equal(ruled.status, 409, ruled.body);
        assert.ok(!ruled.body.includes(MARK), ruled.body);
        assert.deepEqual(
          [ruled.details['usedByRediscovery'], ruled.details['outsideView']],
          [[], true],
        );
        const ruledWhole = await call('admin', 'DELETE', url);
        assert.ok(ruledWhole.body.includes(`${MARK}-rediscovery`), ruledWhole.body);

        // Fifty more in the operator's branch: a page of fifty each way, and one past them
        // hidden. Counted, the refusal still says some are outside their view.
        await db.query(
          `INSERT INTO discovery_schedule (group_id, probe_id, name, range_text, cadence, schedule_id)
           SELECT $1, $2, 'a-rule-' || lpad(n::text, 2, '0'), '10.8.0.0/30', 'daily', $3
           FROM generate_series(1, 50) AS n`,
          [branchId, probeId, scheduleId],
        );
        const paged = await call('operator', 'DELETE', url);
        assert.equal(paged.status, 409, paged.body);
        assert.ok(!paged.body.includes(MARK), paged.body);
        assert.equal(
          paged.message,
          '"a-doomed schedule" is still the permitted window of 50 rediscovery rule(s) you can ' +
            'see, and of others outside your view',
        );
        assert.deepEqual(
          [
            (paged.details['usedByRediscovery'] as unknown[]).length,
            paged.details['usedByRediscoveryTotal'],
            paged.details['outsideView'],
          ],
          [50, 50, true],
        );
        const pagedWhole = await call('admin', 'DELETE', url);
        assert.equal(
          pagedWhole.message,
          '"a-doomed schedule" is still the permitted window of 51 rediscovery rule(s)',
        );
        assert.deepEqual(
          [pagedWhole.details['usedByRediscoveryTotal'], pagedWhole.details['outsideView']],
          [51, false],
        );
      } finally {
        await db.query(`DELETE FROM discovery_schedule WHERE name LIKE 'a-rule-%'`);
        await unassign();
        await db.query('UPDATE discovery_schedule SET schedule_id = $2 WHERE id = $1', [
          hiddenRuleId,
          rule[0]?.schedule_id ?? null,
        ]);
      }
      // With nothing in the way, the operator deletes it.
      assert.equal((await call('operator', 'DELETE', url)).status, 200);
    });

    it('names a credential set’s owner, and a sensor it would reach, only to a writer who sees them', async () => {
      // The probe above the branch holds an SNMP set every sensor in the branch inherits. The
      // operator may write a device whose first sensor is carved out of their view; a new address
      // for the device would take the set somewhere new, which needs `write` on the probe.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-cred-room' });
      const device = await create({
        kind: 'device',
        parentId: room,
        name: 'a-cred-device',
        host: '10.0.5.1',
      });
      const hiddenSensor = await create({
        kind: 'sensor',
        parentId: device,
        name: `${MARK}-cred-sensor`,
        sensorType: 'snmp.traffic',
        params: {},
      });
      await create({
        kind: 'sensor',
        parentId: device,
        name: 'a-cred-sensor',
        sensorType: 'snmp.traffic',
        params: {},
      });
      await grant(room, 'write');
      await grant(hiddenSensor, 'none');
      await harness.service.setCredential(testActor, probeId, 'snmp', { community: 'cred-test' });
      try {
        const patch = { kind: 'device', host: '10.0.5.2' };
        const refused = await call('operator', 'PATCH', `objects/${String(device)}`, patch);
        assert.equal(refused.status, 403, refused.body);
        assert.ok(!refused.body.includes(MARK), refused.body);
        assert.equal(
          refused.message,
          `bringing the snmp credentials on #${String(probeId)} to a sensor outside your view ` +
            'needs write on that object',
        );

        // The control, one fact at a time: each is named once the operator can see it.
        await grant(hiddenSensor, 'read');
        const sensorSeen = await call('operator', 'PATCH', `objects/${String(device)}`, patch);
        assert.equal(sensorSeen.status, 403, sensorSeen.body);
        assert.match(
          sensorSeen.message,
          new RegExp(
            `^sensor "${MARK}-cred-sensor": bringing the snmp credentials on #${String(probeId)} ` +
              'to 10\\.0\\.5\\.2 \\(port \\w+\\) needs write on that object$',
          ),
        );
        await grant(probeId, 'read');
        const ownerSeen = await call('operator', 'PATCH', `objects/${String(device)}`, patch);
        assert.equal(ownerSeen.status, 403, ownerSeen.body);
        assert.match(
          ownerSeen.message,
          new RegExp(
            `on probe "${MARK}-probe" \\(#${String(probeId)}\\) to 10\\.0\\.5\\.2 \\(port \\w+\\) ` +
              'needs write on that probe$',
          ),
        );
      } finally {
        await harness.service.clearCredential(testActor, probeId, 'snmp');
      }
    });

    it('names the address a credential set would reach only to a writer who sees its device', async () => {
      // `none` on the device and `write` given back on one sensor inside it: the operator may
      // move that sensor's port, and the refusal is about the sensor they can see — but the
      // address is the device's, which they cannot.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-port-room' });
      const device = await create({
        kind: 'device',
        parentId: room,
        name: `${MARK}-port-device`,
        host: '10.0.7.1',
      });
      const sensor = await create({
        kind: 'sensor',
        parentId: device,
        name: 'a-port-sensor',
        sensorType: 'snmp.traffic',
        params: {},
      });
      await grant(device, 'none');
      await grant(sensor, 'write');
      await harness.service.setCredential(testActor, probeId, 'snmp', { community: 'port-test' });
      try {
        const patch = { kind: 'sensor', params: { port: 1161 } };
        const refused = await call('operator', 'PATCH', `objects/${String(sensor)}`, patch);
        assert.equal(refused.status, 403, refused.body);
        assert.ok(!refused.body.includes(MARK), refused.body);
        assert.ok(!refused.body.includes('10.0.7.1'), refused.body);
        assert.match(
          refused.message,
          new RegExp(
            `^bringing the snmp credentials on #${String(probeId)} to a ` +
              'device outside your view \\(port \\d+\\) needs write on that object$',
          ),
        );

        // The control: a reader of the device is told its address.
        await grant(device, 'read');
        const seen = await call('operator', 'PATCH', `objects/${String(sensor)}`, patch);
        assert.equal(seen.status, 403, seen.body);
        assert.match(
          seen.message,
          new RegExp(
            `on #${String(probeId)} to 10\\.0\\.7\\.1 \\(port \\d+\\) needs write on that object$`,
          ),
        );
      } finally {
        await harness.service.clearCredential(testActor, probeId, 'snmp');
      }
    });

    it('names the probes a move changed only to a mover who sees them', async () => {
      // `write` on a group under each probe: the device goes from one to the other.
      const from = await create({ kind: 'group', parentId: branchId, name: 'a-move-from' });
      const to = await create({ kind: 'group', parentId: secondProbeId, name: 'a-move-to' });
      const mover = await create({
        kind: 'device',
        parentId: from,
        name: 'a-mover',
        host: '10.0.6.1',
      });
      await grant(from, 'write');
      await grant(to, 'write');

      interface Moved {
        probeChanged: {
          from: { id: number; name: string | null };
          to: { id: number; name: string | null };
        };
      }
      const move = async (login: string, targetParentId: number): Promise<Moved> => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(mover)}/move`,
          headers: as(login),
          payload: { targetParentId },
        });
        assert.equal(response.statusCode, 200, `${login}: ${response.body}`);
        assert.equal(response.body.includes(MARK), login === 'admin', response.body);
        return response.json<Moved>();
      };
      const there = await move('operator', to);
      assert.deepEqual(there.probeChanged, {
        from: { id: probeId, kind: 'probe', name: null },
        to: { id: secondProbeId, kind: 'probe', name: null },
      });
      // The control: an administrator moving it back is told both.
      const back = await move('admin', from);
      assert.deepEqual(
        [back.probeChanged.from.name, back.probeChanged.to.name],
        [`${MARK}-second-probe`, `${MARK}-probe`],
      );
    });
  });

  /**
   * `A-77`, four more answers to writes that told their caller about what they cannot see. Each
   * is asked as the team's operator and then as an administrator for the control: the operator's
   * answer carries no marker and no hidden id, and the administrator's still says what to fix.
   */
  describe('four more answers to writes name nothing outside the branch (A-77)', () => {
    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await harness.service.create(testActor, input as never)).id;
    const grant = (id: number, right: 'none' | 'read' | 'write'): Promise<unknown> =>
      access.grant(id, teamId, right, actorNamed('visibility'));
    /** Never issued: what a hidden id has to be answered as. */
    const NEVER_ISSUED = 9_000_000;

    interface Answer {
      readonly status: number;
      readonly body: string;
      readonly json: Record<string, unknown>;
    }
    const call = async (
      login: string,
      method: 'POST' | 'PUT' | 'PATCH',
      url: string,
      payload: object,
      ifMatch?: string,
    ): Promise<Answer> => {
      const response = await app.inject({
        method,
        url: `/api/v1/${url}`,
        headers: { ...as(login), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload,
      });
      return {
        status: response.statusCode,
        body: response.body,
        json: JSON.parse(response.body) as Record<string, unknown>,
      };
    };
    /** A refusal without the correlation id every answer has its own of. */
    const told = (answer: Answer): string => {
      const error = answer.json['error'] as Record<string, unknown> | undefined;
      return JSON.stringify([
        answer.status,
        error?.['code'],
        error?.['message'],
        error?.['context'],
        error?.['details'],
      ]);
    };
    const errorOf = (answer: Answer): { message: string; details: Record<string, unknown> } => {
      const error = answer.json['error'] as
        { message?: string; details?: Record<string, unknown> } | undefined;
      return { message: error?.message ?? '', details: error?.details ?? {} };
    };

    it('provisions a run into only what its caller can see and write', async () => {
      // A room the operator writes, holding a device carved out of their view, one they may only
      // read, one with a hidden Ping, and one with a Ping they can see.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-provision-room' });
      const readOnly = await create({
        kind: 'device',
        parentId: room,
        name: 'a-read-only',
        host: '10.0.9.1',
      });
      const hidden = await create({
        kind: 'device',
        parentId: room,
        name: `${MARK}-provision-hidden`,
        host: '10.0.9.2',
      });
      await create({
        kind: 'sensor',
        parentId: hidden,
        name: `${MARK}-provision-hidden-ping`,
        sensorType: 'icmp.ping',
      });
      const holey = await create({
        kind: 'device',
        parentId: room,
        name: 'a-holey',
        host: '10.0.9.3',
      });
      const hiddenPing = await create({
        kind: 'sensor',
        parentId: holey,
        name: `${MARK}-holey-ping`,
        sensorType: 'icmp.ping',
      });
      const plain = await create({
        kind: 'device',
        parentId: room,
        name: 'a-plain',
        host: '10.0.9.5',
      });
      await create({
        kind: 'sensor',
        parentId: plain,
        name: 'a-plain-ping',
        sensorType: 'icmp.ping',
      });
      await grant(room, 'write');
      await grant(readOnly, 'read');
      await grant(hidden, 'none');
      await grant(hiddenPing, 'none');

      // Started by the operator, who vouches for where it sends credentials (`A-41`); its hosts
      // are the four devices' addresses and one new one, none of them identified.
      const run = await discovery.start(
        { groupId: room, probeId, range: '10.0.9.0/29' },
        { kind: 'user', userId: operatorUserId, login: 'operator' },
      );
      await db.query(
        `INSERT INTO discovery_host (run_id, address)
         SELECT $1, unnest($2::inet[])`,
        [run.id, ['10.0.9.1', '10.0.9.2', '10.0.9.3', '10.0.9.4', '10.0.9.5']],
      );
      const beneath = async (id: number): Promise<number> =>
        Number(
          (
            await db.query<{ n: string }>(
              'SELECT count(*)::text AS n FROM object WHERE parent_id = $1',
              [id],
            )
          )[0]?.n,
        );

      interface Report {
        matched: number;
        devicesCreated: number;
        sensorsCreated: number;
        sensorsSkipped: number;
        problems: { address: string; problem: string }[];
        devices: { address: string; deviceId: number; created: boolean; sensors?: string[] }[];
      }
      const provision = async (login: string): Promise<Report> => {
        const answer = await call(login, 'POST', `discovery/${String(run.id)}/provision`, {});
        assert.equal(answer.status, 200, `${login}: ${answer.body}`);
        return answer.json as unknown as Report;
      };
      const problemAt = (report: Report, address: string): string[] =>
        report.problems.filter((one) => one.address === address).map((one) => one.problem);

      const mine = await provision('operator');
      const said = JSON.stringify(mine);
      assert.ok(!said.includes(MARK), said);
      assert.ok(!mine.devices.some((one) => one.deviceId === hidden), said);
      assert.ok(!mine.devices.some((one) => one.address === '10.0.9.2'), said);
      assert.deepEqual(problemAt(mine, '10.0.9.2'), [
        'a device outside your view already has this address',
      ]);
      assert.equal(await beneath(hidden), 1, 'nothing made under the hidden device');
      // The hidden Ping stops a duplicate and is not counted as one the operator can see.
      assert.deepEqual(problemAt(mine, '10.0.9.3'), [
        'icmp.ping: a sensor outside your view is already there',
      ]);
      assert.equal(await beneath(holey), 1, 'no second Ping beside the hidden one');
      // Read, not written: named, and left as it was.
      assert.deepEqual(problemAt(mine, '10.0.9.1'), [
        `nothing was added to device ${String(readOnly)}: adding a sensor to it needs write on it`,
      ]);
      assert.equal(await beneath(readOnly), 0);
      assert.deepEqual(
        [mine.matched, mine.devicesCreated, mine.sensorsCreated, mine.sensorsSkipped],
        [3, 1, 1, 1],
        said,
      );
      assert.deepEqual(
        mine.devices.map((one) => [one.address, one.deviceId === holey || one.deviceId === plain]),
        [
          ['10.0.9.1', false],
          ['10.0.9.3', true],
          ['10.0.9.4', false],
          ['10.0.9.5', true],
        ],
        said,
      );

      // The control: an administrator matches every device, the hidden one by id, and is told
      // nothing is outside their view.
      const whole = await provision('admin');
      const wholeSaid = JSON.stringify(whole);
      assert.ok(
        whole.devices.some((one) => one.address === '10.0.9.2' && one.deviceId === hidden),
        wholeSaid,
      );
      assert.ok(!wholeSaid.includes('outside your view'), wholeSaid);
      assert.equal(whole.matched, 5, wholeSaid);
    });

    it('answers a scheduled pass as its rule’s writer, and its problems only to a writer of the group (A-82)', async () => {
      // A room the operator writes, holding a device carved out of their view. The operator
      // writes a rediscovery rule for it; the schedule fires a run and provisions it with nobody
      // asking. Before `A-82` the pass saw the installation: it matched the hidden device by id
      // and stored nothing that said so, and any reader of the room read what it did store.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-scheduled-room' });
      const hidden = await create({
        kind: 'device',
        parentId: room,
        name: `${MARK}-scheduled-hidden`,
        host: '10.0.10.2',
      });
      await grant(room, 'write');
      await grant(hidden, 'none');
      const rule = await rediscovery.create(
        {
          groupId: room,
          probeId,
          name: 'a-scheduled-rule',
          range: '10.0.10.0/29',
          cadence: 'daily',
        },
        { kind: 'user', userId: operatorUserId, login: 'operator' },
      );
      const nobody: Actor = { kind: 'anonymous', remoteAddress: 'scheduled-rediscovery' };

      /** A run the schedule started, provisioned as `main.ts` provisions it. */
      const scheduled = async (
        addresses: readonly string[],
      ): Promise<{ runId: number; report: ProvisionReport }> => {
        const run = await discovery.start(
          { groupId: room, probeId, range: '10.0.10.0/29', scheduleId: rule.id },
          nobody,
        );
        await db.query(
          `INSERT INTO discovery_host (run_id, address) SELECT $1, unnest($2::inet[])`,
          [run.id, [...addresses]],
        );
        const sight = await scheduledSight(run.scheduleId, {
          authRequired: true,
          ruleWriter: (ruleId) => rediscovery.writerOf(ruleId),
          db,
          visibilityFor: (principal) => access.visibilityFor(principal),
          rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
        });
        return { runId: run.id, report: await provisionPass(run.id, nobody, sight) };
      };
      const problems = async (
        login: string,
        runId: number,
      ): Promise<{ status: number; body: string }> => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/discovery/${String(runId)}/problems`,
          headers: as(login),
        });
        return { status: response.statusCode, body: response.body };
      };

      const { runId, report } = await scheduled(['10.0.10.2', '10.0.10.3']);
      const said = JSON.stringify(report);
      assert.ok(!said.includes(MARK), said);
      assert.ok(!report.devices.some((one) => one.deviceId === hidden), said);
      assert.deepEqual(report.problems, [
        { address: '10.0.10.2', problem: 'a device outside your view already has this address' },
      ]);
      assert.equal(report.devicesCreated, 1, 'the new host, in a group the writer writes');

      // Stored in the writer's words, and read only with the bar the writer cleared.
      const theirs = await problems('operator', runId);
      assert.equal(theirs.status, 200, theirs.body);
      assert.ok(theirs.body.includes('a device outside your view'), theirs.body);
      const reader = await problems('branch', runId);
      assert.equal(reader.status, 403, reader.body);
      assert.ok(!reader.body.includes('outside your view'), reader.body);
      assert.equal((await problems('admin', runId)).status, 200);

      // The writer has lost write on the room since writing the rule: the pass creates nothing.
      await grant(room, 'read');
      try {
        const lost = await scheduled(['10.0.10.4']);
        assert.deepEqual(lost.report.problems, [
          { address: '10.0.10.4', problem: NO_WRITE_ON_GROUP },
        ]);
        assert.equal(lost.report.devicesCreated, 0);
      } finally {
        await grant(room, 'write');
      }
    });

    it('holds a master named through a setting or in bulk to the dependency route’s read bar', async () => {
      // `a-ping` is the operator's to write. A hidden master, a hidden device and an id never
      // issued are one answer on every route that can name a master.
      const routes: {
        name: string;
        send: (login: string, masterId: number) => Promise<string>;
      }[] = [
        {
          name: 'the dependency route',
          send: async (login, masterId) =>
            told(
              await call(login, 'PUT', `objects/${String(pingId)}/dependency`, {
                mode: 'object',
                masterId,
              }),
            ),
        },
        {
          name: 'the settings route',
          send: async (login, masterId) =>
            told(
              await call(login, 'PUT', `objects/${String(pingId)}/settings/dependency.masterId`, {
                value: masterId,
              }),
            ),
        },
        {
          name: 'a bulk setting',
          send: async (login, masterId) => {
            const answer = await call(login, 'POST', 'objects/bulk', {
              ids: [pingId],
              operation: 'setting',
              key: 'dependency.masterId',
              value: masterId,
            });
            assert.equal(answer.status, 200, answer.body);
            const [outcome] = (answer.json['outcomes'] ?? []) as {
              ok: boolean;
              problem?: string;
              code?: string;
            }[];
            return JSON.stringify([outcome?.ok, outcome?.code, outcome?.problem]);
          },
        },
      ];
      const before = await harness.service.settings(pingId);
      // Only the id differs between the answers, and the caller sent that.
      const unnamed = (answer: string, id: number): string => answer.replaceAll(String(id), 'N');
      for (const route of routes) {
        const hiddenSensor = await route.send('operator', otherSensorId);
        const hiddenDevice = await route.send('operator', otherDeviceId);
        const missing = await route.send('operator', NEVER_ISSUED);
        for (const answer of [hiddenSensor, hiddenDevice, missing]) {
          assert.ok(!answer.includes(MARK), `${route.name}: ${answer}`);
          assert.ok(!answer.includes('is a device'), `${route.name}: ${answer}`);
          assert.match(answer, /does not exist or you cannot read it/, route.name);
        }
        assert.equal(
          unnamed(hiddenSensor, otherSensorId),
          unnamed(missing, NEVER_ISSUED),
          route.name,
        );
        assert.equal(
          unnamed(hiddenDevice, otherDeviceId),
          unnamed(missing, NEVER_ISSUED),
          route.name,
        );

        // The control: an administrator is told what each one is.
        assert.match(
          await route.send('admin', otherDeviceId),
          new RegExp(`a master must be a sensor; #${String(otherDeviceId)} is a device`),
          route.name,
        );
        assert.match(
          await route.send('admin', NEVER_ISSUED),
          new RegExp(`no object ${String(NEVER_ISSUED)} to depend on`),
          route.name,
        );
      }
      assert.deepEqual(await harness.service.settings(pingId), before, 'nothing was written');

      // **Refused, and nothing written** (`A-77`). Leaving "master for parent device" clears the
      // device's setting first, and every refusal of the new master — hidden, not a sensor, a
      // loop — must leave that undone, for an administrator as for anybody.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-master-room' });
      const device = await create({
        kind: 'device',
        parentId: room,
        name: 'a-master-device',
        host: '10.0.13.1',
      });
      const master = await create({
        kind: 'sensor',
        parentId: device,
        name: 'a-device-master',
        sensorType: 'icmp.ping',
      });
      // On a second device, a sensor whose own master is that one: depending on it is a loop.
      const beside = await create({
        kind: 'device',
        parentId: room,
        name: 'a-master-beside',
        host: '10.0.13.2',
      });
      const follower = await create({
        kind: 'sensor',
        parentId: beside,
        name: 'a-master-follower',
        sensorType: 'icmp.ping',
      });
      await harness.service.setDependency(testActor, master, 'device', undefined, undefined);
      await harness.service.setDependency(testActor, follower, 'object', master, undefined);
      await grant(room, 'write');
      for (const [login, masterId, status, code] of [
        ['operator', otherSensorId, 403, 'AUTH_FORBIDDEN'],
        ['operator', beside, 400, 'OBJECT_INVALID'],
        ['admin', beside, 400, 'OBJECT_INVALID'],
        ['operator', follower, 409, 'OBJECT_CYCLE'],
        ['admin', follower, 409, 'OBJECT_CYCLE'],
      ] as const) {
        const away = await call(login, 'PUT', `objects/${String(master)}/dependency`, {
          mode: 'object',
          masterId,
        });
        assert.equal(away.status, status, `${login}, ${String(masterId)}: ${away.body}`);
        assert.match(away.body, new RegExp(`"code":"${code}"`), away.body);
        assert.equal(
          (await harness.resolver.own(device))['dependency.masterId'],
          master,
          `${login}, ${code}: the device still names its master`,
        );
      }
    });

    it('asks the same queries about a hidden master as about one never issued (A-77)', async () => {
      // A missing master answered a round trip sooner than a hidden one, so the time a refusal
      // took said which ids exist. Counted rather than timed: both make the same reads.
      const repository = harness.repository;
      const read = repository.get.bind(repository);
      // From the prototype's own property, so it is called with whichever `this` asked.
      const asked = Object.getOwnPropertyDescriptor(Visibility.prototype, 'visibleAmong')
        ?.value as (
        this: Visibility,
        ...args: Parameters<Visibility['visibleAmong']>
      ) => ReturnType<Visibility['visibleAmong']>;
      let reads = 0;
      let visibility = 0;
      repository.get = (...args) => {
        reads += 1;
        return read(...args);
      };
      Visibility.prototype.visibleAmong = function (this: Visibility, ...args) {
        visibility += 1;
        return asked.apply(this, args);
      };
      const cost = async (masterId: number): Promise<[number, number]> => {
        reads = 0;
        visibility = 0;
        const refused = await call(
          'operator',
          'PUT',
          `objects/${String(pingId)}/settings/dependency.masterId`,
          { value: masterId },
        );
        assert.equal(refused.status, 403, refused.body);
        return [reads, visibility];
      };
      try {
        const hidden = await cost(otherSensorId);
        assert.deepEqual(await cost(NEVER_ISSUED), hidden);
        assert.ok(hidden[1] >= 1, 'the visibility of the master was asked');
      } finally {
        repository.get = read;
        Visibility.prototype.visibleAmong = asked;
      }
    });

    it('lists a refused loop’s steps only where its writer can see them', async () => {
      // A <- B <- H <- A: `a-loop-a` would depend on `a-loop-b`, whose master is a sensor carved
      // out of the operator's view, whose master is `a-loop-a`.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-loop-room' });
      const device = await create({
        kind: 'device',
        parentId: room,
        name: 'a-loop-device',
        host: '10.0.10.1',
      });
      const sensorIn = (name: string): Promise<number> =>
        create({ kind: 'sensor', parentId: device, name, sensorType: 'icmp.ping' });
      const a = await sensorIn('a-loop-a');
      const b = await sensorIn('a-loop-b');
      const h = await sensorIn(`${MARK}-loop-h`);
      await harness.service.setDependency(testActor, b, 'object', h, undefined);
      await harness.service.setDependency(testActor, h, 'object', a, undefined);
      await grant(room, 'write');
      await grant(h, 'none');

      const loop = async (login: string): Promise<{ body: string; path: unknown }> => {
        const answer = await call(login, 'PUT', `objects/${String(a)}/dependency`, {
          mode: 'object',
          masterId: b,
        });
        assert.equal(answer.status, 409, answer.body);
        assert.equal((answer.json['error'] as { code?: string }).code, 'OBJECT_CYCLE', answer.body);
        return { body: answer.body, path: errorOf(answer).details['path'] };
      };
      const mine = await loop('operator');
      assert.deepEqual(mine.path, [b, null, a], mine.body);
      assert.ok(!mine.body.includes(MARK), mine.body);
      // The control: an administrator is shown every step.
      assert.deepEqual((await loop('admin')).path, [b, h, a]);
    });

    it('answers a hidden probe as an id nobody used, when a discovery or a rule names one', async () => {
      await grant(branchId, 'write');
      const start = (login: string, probe: number): Promise<Answer> =>
        call(login, 'POST', 'discovery', {
          groupId: branchId,
          probeId: probe,
          range: '10.0.11.0/30',
        });
      const rule = (login: string, probe: number): Promise<Answer> =>
        call(login, 'POST', 'discovery/schedules', {
          groupId: branchId,
          probeId: probe,
          name: 'a-probe-oracle',
          range: '10.0.11.0/30',
          cadence: 'daily',
        });
      let ruleId = 0;
      let ruleTag = '';
      try {
        for (const [name, send] of [
          ['a run', start],
          ['a rule', rule],
        ] as const) {
          // The group's own probe, which the operator cannot see, reads as a wrong one and as one
          // never issued: guessing ids no longer finds it.
          const own = await send('operator', probeId);
          assert.equal(own.status, 400, `${name}: ${own.body}`);
          assert.match(own.body, /"code":"DISCOVERY_PROBE_INVALID"/, name);
          assert.equal(told(own), told(await send('operator', NEVER_ISSUED)), name);
          assert.equal(told(own), told(await send('operator', secondProbeId)), name);
          // The control: an administrator starts it from the group's probe, and only that one.
          const admitted = await send('admin', probeId);
          assert.equal(admitted.status, 201, `${name}: ${admitted.body}`);
          assert.equal(told(await send('admin', secondProbeId)), told(own), name);
          if (send === rule) {
            ruleId = admitted.json['id'] as number;
            ruleTag = `W/"${String(admitted.json['version'])}"`;
          }
        }

        // Left out, the probe is the group's own: how a writer below a probe they cannot see
        // starts one.
        const left = await call('operator', 'POST', 'discovery', {
          groupId: branchId,
          range: '10.0.11.0/30',
        });
        assert.equal(left.status, 201, left.body);

        // A rule's probe changed by an edit: one answer for a hidden probe and one never issued.
        const url = `discovery/schedules/${String(ruleId)}`;
        const edit = (body: object): Promise<Answer> =>
          call('operator', 'PATCH', url, body, ruleTag);
        const hiddenEdit = await edit({ probeId: secondProbeId });
        assert.equal(hiddenEdit.status, 400, hiddenEdit.body);
        assert.match(hiddenEdit.body, /"code":"DISCOVERY_PROBE_INVALID"/);
        assert.equal(told(hiddenEdit), told(await edit({ probeId: NEVER_ISSUED })));
        // Its own probe, unchanged, is asked about too (`A-80`): the operator's reads leave it
        // out, so accepting it would confirm a guess. An edit that names no probe is accepted.
        const own = await edit({ probeId, name: 'a-kept' });
        assert.equal(told(own), told(hiddenEdit));
        const kept = await edit({ name: 'a-kept' });
        assert.equal(kept.status, 200, kept.body);
        assert.equal('probeId' in kept.json, false, kept.body);
      } finally {
        await db.query(`DELETE FROM discovery_schedule WHERE name IN ('a-probe-oracle', 'a-kept')`);
      }
    });

    it('reads a run and a rule without a probe its reader cannot see (A-80)', async () => {
      await grant(branchId, 'write');
      const get = async (login: string, url: string): Promise<Answer> => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/${url}`,
          headers: as(login),
        });
        return {
          status: response.statusCode,
          body: response.body,
          json: JSON.parse(response.body) as Record<string, unknown>,
        };
      };
      /** Every probe id an answer carries, at any depth: none may be the hidden probe's. */
      const probeIdsIn = (answer: Answer): unknown[] => {
        const found: unknown[] = [];
        JSON.stringify(answer.json, (key, value: unknown) => {
          if (key === 'probeId') found.push(value);
          return value;
        });
        return found;
      };
      try {
        // Started with the probe left out: its own reply does not name the group's probe.
        const started = await call('operator', 'POST', 'discovery', {
          groupId: branchId,
          range: '10.0.12.0/30',
        });
        assert.equal(started.status, 201, started.body);
        assert.deepEqual(probeIdsIn(started), [], started.body);
        const runId = started.json['id'] as number;
        const rule = await call('operator', 'POST', 'discovery/schedules', {
          groupId: branchId,
          name: 'a-probe-read',
          range: '10.0.12.0/30',
          cadence: 'daily',
        });
        assert.equal(rule.status, 201, rule.body);
        assert.deepEqual(probeIdsIn(rule), [], rule.body);
        const ruleId = rule.json['id'] as number;
        const toggled = await call(
          'operator',
          'POST',
          `discovery/schedules/${String(ruleId)}/enabled`,
          {
            enabled: false,
          },
        );
        assert.equal(toggled.status, 200, toggled.body);
        assert.deepEqual(probeIdsIn(toggled), [], toggled.body);

        const reads = [
          `discovery/${String(runId)}`,
          `discovery/${String(runId)}/summary`,
          `objects/${String(branchId)}/discovery`,
          `discovery/schedules?groupId=${String(branchId)}`,
        ];
        for (const url of reads) {
          const operator = await get('operator', url);
          assert.equal(operator.status, 200, `${url}: ${operator.body}`);
          assert.deepEqual(probeIdsIn(operator), [], `${url}: ${operator.body}`);
          // The control: an administrator is told the probe, as before.
          const admin = await get('admin', url);
          assert.ok(probeIdsIn(admin).includes(probeId), `${url}: ${admin.body}`);
        }

        // Once the operator can see the probe, they are told it (`beforeEach` takes it back).
        await grant(probeId, 'read');
        for (const url of reads) {
          const operator = await get('operator', url);
          assert.ok(probeIdsIn(operator).includes(probeId), `${url}: ${operator.body}`);
        }
      } finally {
        await db.query(`DELETE FROM discovery_schedule WHERE name = 'a-probe-read'`);
      }
    });

    it('names the probe a check failed on only to a caller who can see it', async () => {
      // Nobody is on the line in this harness, so every check is answered 503 `offline`.
      const check = async (login: string): Promise<Record<string, unknown>> => {
        const answer = await call(login, 'POST', `sensors/${String(pingId)}/check`, {});
        assert.equal(answer.status, 503, answer.body);
        return (answer.json['error'] as { context: Record<string, unknown> }).context;
      };
      assert.deepEqual(await check('operator'), { objectId: pingId });
      // The control, and then a reader of the probe: its id.
      assert.deepEqual(await check('admin'), { objectId: pingId, probeObjectId: probeId });
      await grant(probeId, 'read');
      await grant(branchId, 'read');
      await grant(deviceId, 'write');
      assert.deepEqual(await check('operator'), { objectId: pingId, probeObjectId: probeId });
    });

    it('refuses a move without the id of a probe above it the mover cannot see', async () => {
      // A Probe Health sensor with no `probeId` reports on the probe above it, which a move
      // re-checks (`A-29`); the refusal said which object that is.
      const from = await create({ kind: 'group', parentId: branchId, name: 'a-health-from' });
      const to = await create({ kind: 'group', parentId: branchId, name: 'a-health-to' });
      const device = await create({
        kind: 'device',
        parentId: from,
        name: 'a-health-device',
        host: '10.0.12.1',
      });
      await create({
        kind: 'sensor',
        parentId: device,
        name: 'a-probe-health',
        sensorType: 'ms.probe.health',
        params: {},
      });
      await grant(from, 'write');
      await grant(to, 'write');
      const refused = await call('operator', 'POST', `objects/${String(device)}/move`, {
        targetParentId: to,
      });
      assert.equal(refused.status, 403, refused.body);
      assert.ok(!refused.body.includes(MARK), refused.body);
      assert.equal(
        errorOf(refused).message,
        'sensor "a-probe-health": probeId is not set, so it reports on the probe above it, ' +
          'which you cannot read',
      );
      const context = (refused.json['error'] as { context?: Record<string, unknown> }).context;
      assert.ok(!Object.values(context ?? {}).includes(probeId), refused.body);

      // The control: an administrator moves it.
      const moved = await call('admin', 'POST', `objects/${String(device)}/move`, {
        targetParentId: to,
      });
      assert.equal(moved.status, 200, moved.body);
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

  describe('what a reorder, a probe’s trust and a count tell a reader with holes (A-46)', () => {
    before(() => {
      // The harness only captures; the history is read from what is stored.
      harness.audit.also = new DatabaseAuditSink();
    });

    after(() => {
      harness.audit.also = undefined;
    });

    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await harness.service.create(testActor, input as never)).id;
    const grant = (id: number, right: 'none' | 'read' | 'write'): Promise<unknown> =>
      access.grant(id, teamId, right, actorNamed('visibility'));

    /** A parent's children, in the order everybody who sees them all is shown them. */
    const orderOf = async (parentId: number): Promise<string[]> =>
      (
        await db.query<{ name: string }>(
          'SELECT name FROM object WHERE parent_id = $1 ORDER BY sort_order NULLS LAST, name, id',
          [parentId],
        )
      ).map((row) => row.name);

    interface Row {
      version: number;
      sort_order: number | null;
      updated_at: Date;
    }
    const rowOf = async (id: number): Promise<Row> => {
      const rows = await db.query<Row>(
        'SELECT version, sort_order, updated_at FROM object WHERE id = $1',
        [id],
      );
      assert.ok(rows[0] !== undefined, `no object ${String(id)}`);
      return rows[0];
    };

    /** What an administrator's client holds for it, which a write it cannot see must not move. */
    const adminTag = async (id: number): Promise<unknown> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}`,
        headers: as('admin'),
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.headers.etag;
    };

    const reorder = async (id: number, move: string, login = 'operator'): Promise<number> => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(id)}/order`,
        headers: as(login),
        payload: { move },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ childCount: number }>().childCount;
    };

    interface Entry {
      action: string;
      summary: Record<string, unknown>;
      diff: unknown[];
    }
    const historyOf = async (id: number, headers: Record<string, string>): Promise<Entry[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}/audit`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ items: Entry[] }>().items;
    };
    const positionsIn = async (id: number, login: string): Promise<unknown[]> =>
      (await historyOf(id, as(login)))
        .filter((entry) => entry.action === 'object.reordered')
        .map((entry) => entry.diff);

    /** Unchanged, as its owners' clients hold it: its version, its time and its tag. */
    async function untouched(id: number, before: Row, tag: unknown, what: string): Promise<void> {
      const after = await rowOf(id);
      assert.equal(after.version, before.version, `${what}: its version moved`);
      assert.deepEqual(after.updated_at, before.updated_at, `${what}: its time moved`);
      assert.equal(await adminTag(id), tag, `${what}: its tag moved`);
    }

    it('moves an object among the siblings its mover can see, on a parent nobody arranged', async () => {
      // Every place is NULL, so the order is by name, and the hidden sibling sits second.
      const shelf = await create({ kind: 'group', parentId: branchId, name: 'a-shelf' });
      const first = await create({ kind: 'group', parentId: shelf, name: 'a-1' });
      const hidden = await create({ kind: 'group', parentId: shelf, name: 'a-2' });
      const moved = await create({ kind: 'group', parentId: shelf, name: 'a-3' });
      await create({ kind: 'group', parentId: shelf, name: 'a-4' });
      await create({ kind: 'group', parentId: moved, name: 'a-3-kept' });
      const hole = await create({ kind: 'group', parentId: moved, name: `${MARK}-3-hole` });
      await grant(shelf, 'write');
      await grant(hidden, 'none');
      await grant(hole, 'none');

      const hiddenBefore = await rowOf(hidden);
      const hiddenTag = await adminTag(hidden);
      const movedBefore = await rowOf(moved);
      const firstBefore = await rowOf(first);

      // And the answer counts the children its caller can see, as a read of it does (`A-12`).
      assert.equal(await reorder(moved, 'up'), 1);

      // "Up" passed the nearest sibling the operator can see and nothing else moved: the hidden
      // one kept its place, and the place written into its row is the one the name order gave it.
      assert.deepEqual(await orderOf(shelf), ['a-3', 'a-2', 'a-1', 'a-4']);
      assert.equal((await rowOf(hidden)).sort_order, 1);
      await untouched(hidden, hiddenBefore, hiddenTag, 'the hidden sibling');
      // Written after the hidden row, in the same transaction, and bumped as ever: the setting
      // that spared the hidden row was cleared straight after it.
      assert.equal((await rowOf(moved)).version, movedBefore.version + 1);
      assert.equal((await rowOf(first)).version, firstBefore.version + 1);

      // The history. An administrator reads the positions among every sibling; a reader with a
      // hidden sibling reads none, since they count it — whoever moved it.
      const moveUp = [{ field: 'siblingPosition', before: 2, after: 0 }];
      assert.deepEqual(await positionsIn(moved, 'admin'), [moveUp]);
      assert.deepEqual(await positionsIn(moved, 'operator'), [[]]);
      // ...and a reader who can see every sibling reads them, from the same entry.
      await grant(hidden, 'read');
      assert.deepEqual(await positionsIn(moved, 'operator'), [moveUp]);
    });

    it('moves an object among the siblings its mover can see, on a parent arranged in part', async () => {
      const rack = await create({ kind: 'group', parentId: branchId, name: 'a-rack' });
      const ids = new Map<string, number>();
      for (const name of ['b-1', 'b-2', 'b-3', 'b-4', 'b-5']) {
        ids.set(name, await create({ kind: 'group', parentId: rack, name }));
      }
      const id = (name: string): number => ids.get(name) ?? 0;
      // Two placed by hand and three never: b-4, b-1, then the rest by name.
      await db.query('UPDATE object SET sort_order = 0 WHERE id = $1', [id('b-4')]);
      await db.query('UPDATE object SET sort_order = 1 WHERE id = $1', [id('b-1')]);
      assert.deepEqual(await orderOf(rack), ['b-4', 'b-1', 'b-2', 'b-3', 'b-5']);
      await grant(rack, 'write');
      await grant(id('b-2'), 'none');

      let hiddenBefore = await rowOf(id('b-2'));
      let hiddenTag = await adminTag(id('b-2'));
      const placed = await rowOf(id('b-4'));

      await reorder(id('b-5'), 'up');
      assert.deepEqual(await orderOf(rack), ['b-4', 'b-1', 'b-2', 'b-5', 'b-3']);
      assert.equal((await rowOf(id('b-2'))).sort_order, 2);
      await untouched(id('b-2'), hiddenBefore, hiddenTag, 'b-2 on "up"');
      // A place already written down is not written again.
      assert.equal((await rowOf(id('b-4'))).version, placed.version);

      // "First" and "last" are the first and last places the operator can see.
      await reorder(id('b-3'), 'first');
      assert.deepEqual(await orderOf(rack), ['b-3', 'b-4', 'b-2', 'b-1', 'b-5']);
      await reorder(id('b-4'), 'last');
      assert.deepEqual(await orderOf(rack), ['b-3', 'b-1', 'b-2', 'b-5', 'b-4']);
      await untouched(id('b-2'), hiddenBefore, hiddenTag, 'b-2 on "first" and "last"');

      // With the hidden sibling on top, the top the operator can see is where "up" and "first"
      // stop — which is also what they do with nothing above it, so neither tells.
      await reorder(id('b-2'), 'first', 'admin');
      assert.deepEqual(await orderOf(rack), ['b-2', 'b-3', 'b-1', 'b-5', 'b-4']);
      hiddenBefore = await rowOf(id('b-2'));
      hiddenTag = await adminTag(id('b-2'));
      const top = await rowOf(id('b-3'));
      await reorder(id('b-3'), 'up');
      await reorder(id('b-3'), 'first');
      assert.deepEqual(await orderOf(rack), ['b-2', 'b-3', 'b-1', 'b-5', 'b-4']);
      assert.equal((await rowOf(id('b-3'))).version, top.version, 'a no-op was written');
      await untouched(id('b-2'), hiddenBefore, hiddenTag, 'b-2 under a no-op');

      // The history of a sibling the operator moved: positions for an administrator, none for
      // the operator, who cannot see b-2.
      assert.deepEqual(await positionsIn(id('b-4'), 'admin'), [
        [{ field: 'siblingPosition', before: 1, after: 4 }],
      ]);
      assert.deepEqual(await positionsIn(id('b-4'), 'operator'), [[]]);
    });

    it('keeps a probe’s trust entries for an administrator, as its grants are', async () => {
      const site = await create({ kind: 'probe', parentId: harness.rootId, name: 'a-site-probe' });
      const registry = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        enrolmentKeys: ['visibility-key'],
      });
      const gid = 'a46-site';
      await registry.admit({
        gid,
        displayName: 'a-site',
        agentVersion: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        accessKey: 'visibility-key',
        remoteAddress: '192.0.2.44',
      });
      await registry.approve(gid, site, actorNamed('visibility'));
      await registry.setAllowFrom(gid, ['192.0.2.0/24'], actorNamed('visibility'));
      await harness.service.setSetting(testActor, site, 'scan.intervalSeconds', 300);
      // How a customer is handed their own site's probe.
      await grant(site, 'read');

      const actions = async (headers: Record<string, string>): Promise<string[]> =>
        (await historyOf(site, headers)).map((entry) => entry.action);
      const trust = (list: readonly string[]): string[] =>
        list.filter((action) => action.startsWith('probe.'));

      // The address it called from, where it may call from and the notes on it are what
      // `GET /probes` keeps `ADMIN`: nobody else reads them here, and the rest is still read.
      for (const login of ['watcher', 'operator']) {
        const seen = await actions(as(login));
        assert.deepEqual(trust(seen), [], `${login} read a trust entry`);
        assert.deepEqual(seen, ['setting.set', 'object.created'], login);
      }
      assert.deepEqual(trust(await actions(as('admin'))), [
        'probe.allowFrom.set',
        'probe.approved',
      ]);

      // The bar is `ADMIN`'s, role and scope both, as for grants (`A-26`).
      const issued = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/tokens',
        headers: as('admin'),
        payload: { name: 'trust history', scope: 'read' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const bearer = { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` };
      assert.deepEqual(trust(await actions(bearer)), [], 'a read token read a trust entry');
    });

    it('leaves out a count of what is beneath an object for a reader with a hole there', async () => {
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-room' });
      const box = await create({
        kind: 'device',
        parentId: room,
        name: 'a-counted',
        host: '10.0.3.1',
      });
      const shown = [
        await create({ kind: 'sensor', parentId: box, name: 'a-c1', sensorType: 'icmp.ping' }),
        await create({ kind: 'sensor', parentId: box, name: 'a-c2', sensorType: 'icmp.ping' }),
      ];
      const hole = await create({
        kind: 'sensor',
        parentId: box,
        name: `${MARK}-c-hole`,
        sensorType: 'icmp.ping',
      });
      await grant(hole, 'none');
      await scan([...shown, hole], false);

      // An administrator's actions, each over all three sensors — two levels down, from the room.
      const act = async (
        method: 'POST' | 'DELETE',
        url: string,
        payload?: object,
      ): Promise<void> => {
        const response = await app.inject({
          method,
          url: `/api/v1/objects/${url}`,
          headers: as('admin'),
          ...(payload === undefined ? {} : { payload }),
        });
        assert.ok(response.statusCode < 300, `${method} ${url}: ${response.body}`);
      };
      await act('POST', `${String(box)}/acknowledge`, { message: 'on it' });
      await act('DELETE', `${String(box)}/acknowledge`);
      await act('POST', `${String(box)}/simulate-error`, { message: 'drill' });
      await act('DELETE', `${String(box)}/simulate-error`);
      await act('POST', `${String(room)}/pause`, { message: 'moving racks' });
      await act('DELETE', `${String(room)}/pause`);
      await act('POST', `${String(box)}/move`, { targetParentId: branchId });
      await act('POST', `${String(box)}/move`, { targetParentId: room });
      const cloned = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(box)}/clone`,
        headers: as('admin'),
        // Beside the room, not in it: the copy carries the hole's grant (`A-35`), and would be
        // a hole beneath the room of its own once the original is filled in below.
        payload: { targetParentId: branchId },
      });
      assert.equal(cloned.statusCode, 201, cloned.body);
      const copy = cloned.json<{ object: { id: number } }>().object.id;
      // One of the sensors paused on its own, with nothing beneath it to hide.
      await act('POST', `${String(shown[0] ?? 0)}/pause`, { message: 'just this one' });

      const COUNTS = ['sensorsAffected', 'movedCount', 'clonedCount'];
      const countsIn = async (id: number, login: string): Promise<string[]> =>
        (await historyOf(id, as(login))).flatMap((entry) =>
          COUNTS.filter((key) => key in entry.summary).map(
            (key) => `${entry.action} ${key} ${JSON.stringify(entry.summary[key])}`,
          ),
        );

      // The control: an administrator reads every count, and each counts the hole.
      const box3 = await countsIn(box, 'admin');
      assert.deepEqual(
        box3.map((line) => line.split(' ').slice(0, 2).join(' ')),
        [
          'object.moved movedCount',
          'object.moved movedCount',
          'sensor.simulatedError sensorsAffected',
          'sensor.simulatedError sensorsAffected',
          'sensor.acknowledgementCleared sensorsAffected',
          'sensor.acknowledged sensorsAffected',
        ],
      );
      assert.deepEqual(await countsIn(room, 'admin'), [
        'object.resumed sensorsAffected 3',
        'object.paused sensorsAffected 3',
      ]);
      assert.equal((await countsIn(copy, 'admin')).length, 1);

      // A reader with the hole beneath: the entries, without their counts.
      for (const id of [room, box, copy]) {
        assert.deepEqual(await countsIn(id, 'watcher'), [], `object ${String(id)}`);
      }
      assert.deepEqual(
        (await historyOf(room, as('watcher'))).map((entry) => entry.action),
        (await historyOf(room, as('admin'))).map((entry) => entry.action),
        'an entry went with its count',
      );
      // Nothing beneath the sensor, so nothing to leave out.
      assert.deepEqual(await countsIn(shown[0] ?? 0, 'watcher'), [
        'object.paused sensorsAffected 1',
      ]);
      // And once the hole is filled, the same entries read with their counts.
      await grant(hole, 'read');
      assert.deepEqual(await countsIn(room, 'watcher'), await countsIn(room, 'admin'));
      assert.deepEqual(await countsIn(box, 'watcher'), box3);

      await act('DELETE', `${String(shown[0] ?? 0)}/pause`);
    });

    it('counts for a credential write only the sensors its writer can see (U-21)', async () => {
      // `write` on a group, one device in it the team sees, and one carved `none` with two
      // sensors. All three sensors use the group's SNMP set.
      const room = await create({ kind: 'group', parentId: branchId, name: 'a-vault-room' });
      const seen = await create({
        kind: 'device',
        parentId: room,
        name: 'a-vault-seen',
        host: '10.0.4.1',
      });
      const carved = await create({
        kind: 'device',
        parentId: room,
        name: `${MARK}-vault-hole`,
        host: '10.0.4.2',
      });
      const snmp = (parentId: number, name: string): Promise<number> =>
        create({ kind: 'sensor', parentId, name, sensorType: 'snmp.traffic', params: {} });
      await snmp(seen, 'a-vault-s1');
      await snmp(carved, `${MARK}-vault-s2`);
      await snmp(carved, `${MARK}-vault-s3`);
      await grant(carved, 'none');
      // And one device of each, entered by name (`A-59`): against targets that are addresses
      // their sensors are outside for another reason, which is counted apart.
      const seenNamed = await create({
        kind: 'device',
        parentId: room,
        name: 'a-vault-named',
        host: 'seen.vault.test',
      });
      const carvedNamed = await create({
        kind: 'device',
        parentId: room,
        name: `${MARK}-vault-named`,
        host: `${MARK}.vault.test`,
      });
      await snmp(seenNamed, 'a-vault-s4');
      await snmp(carvedNamed, `${MARK}-vault-s5`);
      await grant(carvedNamed, 'none');

      const url = `/api/v1/objects/${String(room)}/credentials/snmp`;
      // Bounds every device here is outside, so the set is kept from every sensor.
      const payload = {
        values: { community: 'a-vault-community', allowedTargets: ['192.0.2.0/24'] },
      };
      /**
       * The write's four counts (`A-55`): outside after, outside before, put there, brought back.
       * Whole, and for each of the two reasons a sensor is outside (`A-59`).
       */
      interface Counted {
        all: number[];
        outside: number[];
        unpinnable: number[];
      }
      const put = async (login: string, dryRun: boolean): Promise<Counted> => {
        const response = await app.inject({
          method: 'PUT',
          url: `${url}${dryRun ? '?dryRun=true' : ''}`,
          headers: as(login),
          payload,
        });
        assert.equal(response.statusCode, 200, response.body);
        type Four = Record<string, number | undefined>;
        const body = response.json<Four & { byReason?: Record<string, Four | undefined> }>();
        const four = (counts: Four | undefined): number[] =>
          ['withholds', 'withheldBefore', 'newlyWithheld', 'noLongerWithheld'].map(
            (key) => counts?.[key] ?? Number.NaN,
          );
        return {
          all: four(body),
          outside: four(body.byReason?.['outside']),
          unpinnable: four(body.byReason?.['unpinnable']),
        };
      };
      const remove = async (login: string, dryRun: boolean): Promise<number> => {
        const response = await app.inject({
          method: 'DELETE',
          url: `${url}${dryRun ? '?dryRun=true' : ''}`,
          headers: as(login),
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<{ removed: boolean; sensors: number }>();
        assert.equal(body.removed, true);
        return body.sensors;
      };

      // Without `write`, a preview is refused as the write is, before anything is counted.
      const refusedTo = async (login: string): Promise<void> => {
        for (const method of ['PUT', 'DELETE'] as const) {
          for (const query of ['?dryRun=true', '']) {
            const refused = await app.inject({
              method,
              url: `${url}${query}`,
              headers: as(login),
              ...(method === 'PUT' ? { payload } : {}),
            });
            assert.equal(refused.statusCode, 403, `${login} ${method} ${query}: ${refused.body}`);
            const body = refused.json<Record<string, unknown>>();
            assert.equal('withholds' in body, false, `${login} ${method} ${query}`);
            assert.equal('byReason' in body, false, `${login} ${method} ${query}`);
            assert.equal('sensors' in body, false, `${login} ${method} ${query}`);
            assert.equal(/\d+ sensors?/.test(refused.body), false, refused.body);
          }
        }
      };
      // An account whose role may write, holding `read` here and no more; and one whose role
      // may not, whatever it is granted.
      await refusedTo('operator');
      await grant(room, 'write');
      await refusedTo('watcher');
      assert.deepEqual(await harness.service.credentials(room, false), []);

      // The writer with the holes: two sensors, previewed and written, one for each reason.
      // The administrator: five, three on devices the targets do not cover and two on named
      // ones. The set every sensor here used until now has no bounds, so none was outside
      // before and the first write puts them all there; the second finds them there. Each
      // count, whole and by reason, is of what its caller sees, on both.
      const mine: Counted = { all: [2, 0, 2, 0], outside: [1, 0, 1, 0], unpinnable: [1, 0, 1, 0] };
      const everybodys: Counted = {
        all: [5, 0, 5, 0],
        outside: [3, 0, 3, 0],
        unpinnable: [2, 0, 2, 0],
      };
      assert.deepEqual(await put('operator', true), mine);
      assert.deepEqual(await put('admin', true), everybodys);
      assert.deepEqual(await harness.service.credentials(room, false), [], 'a preview stored');
      assert.deepEqual(await put('operator', false), mine);
      assert.deepEqual(await put('operator', true), {
        all: [2, 2, 0, 0],
        outside: [1, 1, 0, 0],
        unpinnable: [1, 1, 0, 0],
      });
      assert.deepEqual(await put('admin', false), {
        all: [5, 5, 0, 0],
        outside: [3, 3, 0, 0],
        unpinnable: [2, 2, 0, 0],
      });

      // The history the API serves has the two writes and no count, for anybody: there is no
      // second place to read a number from, whole or by reason.
      for (const login of ['admin', 'operator']) {
        const sets = (await historyOf(room, as(login))).filter(
          (entry) => entry.action === 'credential.set',
        );
        assert.equal(sets.length, 2, login);
        assert.equal(
          /withholds|withheld|byReason|unpinnable/iu.test(JSON.stringify(sets)),
          false,
          login,
        );
      }
      // What was recorded says what each write did, whoever made it: outside after it, put
      // there by it, brought back by it (`A-59`), every sensor counted.
      assert.deepEqual(
        harness.audit.recorded.flatMap((entry) =>
          entry.action === 'credential.set' && entry.objectId === room
            ? [[entry.withholds, entry.newlyWithheld, entry.noLongerWithheld]]
            : [],
        ),
        [
          [5, 5, 0],
          [5, 0, 0],
        ],
      );

      assert.equal(await remove('operator', true), 2);
      assert.equal(await remove('admin', true), 5);
      assert.equal((await harness.service.credentials(room, false)).length, 1, 'a preview removed');
      assert.equal(await remove('operator', false), 2);
      // Stored again, so that the administrator has one to remove.
      assert.deepEqual(await put('admin', false), everybodys);
      assert.equal(await remove('admin', false), 5);

      // One hole filled: the writer counts its sensors too, and still not the other's.
      await grant(carved, 'read');
      assert.deepEqual(await put('operator', true), {
        all: [4, 0, 4, 0],
        outside: [3, 0, 3, 0],
        unpinnable: [1, 0, 1, 0],
      });
      // And with both filled, the writer counts what the administrator counts.
      await grant(carvedNamed, 'read');
      assert.deepEqual(await put('operator', true), everybodys);
    });

    it('writes only a container’s own row for a setting on it, one at a time or in bulk', async () => {
      // `write` on the device, and a sensor beneath it carved `none` (the fixture's). A setting
      // set on the device is inherited by the sensor, which is what inheritance is; its row is
      // not written, and nothing its owners hold goes stale.
      const hidden = await rowOf(carvedSensorId);
      const tag = await adminTag(carvedSensorId);
      const device = await rowOf(deviceId);
      const call = async (
        method: 'PUT' | 'DELETE' | 'POST' | 'PATCH',
        url: string,
        payload?: object,
        headers: Record<string, string> = {},
      ): Promise<{ childCount?: number }> => {
        const response = await app.inject({
          method,
          url: `/api/v1/${url}`,
          headers: { ...as('operator'), ...headers },
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
        return response.json<{ childCount?: number }>();
      };
      const setting = `objects/${String(deviceId)}/settings/scan.intervalSeconds`;
      await call('PUT', setting, { value: 120 });
      await call('DELETE', setting);
      const bulk = { ids: [deviceId], key: 'scan.intervalSeconds' };
      await call('POST', 'objects/bulk', { ...bulk, operation: 'setting', value: 180 });
      await call('POST', 'objects/bulk', { ...bulk, operation: 'revertSetting' });
      await untouched(carvedSensorId, hidden, tag, 'the hidden sensor');
      assert.equal((await rowOf(deviceId)).version, device.version + 4, 'one step per write');

      // And an edit of the device answers with the children its writer can see, as a read of
      // it does (`A-12`): a-held and a-ping, and not the hole.
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: as('operator'),
      });
      const edited = await call(
        'PATCH',
        `objects/${String(deviceId)}`,
        { kind: 'device', tags: ['a-edited'] },
        { 'if-match': String(read.headers.etag) },
      );
      assert.equal(edited.childCount, 2);
      assert.equal(read.json<{ childCount: number }>().childCount, 2);
    });
  });

  describe('the ids an object’s history names (A-51)', () => {
    before(() => {
      // The harness only captures; the history is read from what is stored.
      harness.audit.also = new DatabaseAuditSink();
    });

    after(() => {
      harness.audit.also = undefined;
    });

    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await harness.service.create(testActor, input as never)).id;
    const grant = (id: number, right: 'none' | 'read'): Promise<unknown> =>
      access.grant(id, teamId, right, actorNamed('visibility'));

    interface Entry {
      action: string;
      summary: Record<string, unknown>;
      diff: { field: string; before: unknown; after: unknown }[];
    }
    /** One action's entries in an object's history, newest first, by what `pick` reads of each. */
    const named = async (
      id: number,
      login: string,
      action: string,
      pick: (entry: Entry) => unknown,
    ): Promise<unknown[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}/audit`,
        headers: as(login),
      });
      assert.equal(response.statusCode, 200, response.body);
      return response
        .json<{ items: Entry[] }>()
        .items.filter((entry) => entry.action === action)
        .map(pick);
    };
    const change = (entry: Entry, field: string): unknown[] => {
      const found = entry.diff.find((one) => one.field === field);
      return [found?.before, found?.after];
    };

    it('reads an id naming what the reader cannot see as null, wherever one is named', async () => {
      const elsewhere = await create({ kind: 'group', parentId: branchId, name: `${MARK}-away` });
      const somewhere = await create({ kind: 'group', parentId: branchId, name: 'a-somewhere' });
      const mover = await create({
        kind: 'device',
        parentId: branchId,
        name: 'a-mover',
        host: '10.0.4.1',
      });
      await create({ kind: 'device', parentId: elsewhere, name: 'a-neighbour', host: '10.0.4.2' });
      const source = await create({
        kind: 'device',
        parentId: elsewhere,
        name: 'a-source',
        host: '10.0.4.3',
      });
      const dependent = await create({
        kind: 'sensor',
        parentId: mover,
        name: 'a-dependent',
        sensorType: 'icmp.ping',
      });
      await grant(elsewhere, 'none');
      // Granted on its own, so the reader sees it wherever it goes.
      await grant(mover, 'read');

      const act = async (url: string, payload: object): Promise<unknown> => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${url}`,
          headers: as('admin'),
          payload,
        });
        assert.ok(response.statusCode < 300, `${url}: ${response.body}`);
        return response.json();
      };
      // Into the hidden group, arranged among what is there, out again, and on through a group
      // the reader can see.
      await act(`${String(mover)}/move`, { targetParentId: elsewhere });
      await act(`${String(mover)}/order`, { move: 'last' });
      await act(`${String(mover)}/move`, { targetParentId: branchId });
      await act(`${String(mover)}/move`, { targetParentId: somewhere });
      // A hidden device copied to where the reader can see the copy.
      const copied = (await act(`${String(source)}/clone`, {
        targetParentId: somewhere,
        name: 'a-copied',
      })) as { object: { id: number } };
      // A master the reader cannot see, and taken away again.
      await harness.service.setDependency(
        testActor,
        dependent,
        'object',
        carvedSensorId,
        undefined,
      );
      await harness.service.setDependency(testActor, dependent, 'parent', undefined, undefined);

      const moves = (login: string): Promise<unknown[]> =>
        named(mover, login, 'object.moved', (entry) => [
          ...change(entry, 'parentId'),
          entry.summary['fromProbeId'],
          entry.summary['toProbeId'],
        ]);
      // The probe is above the branch, so hidden from it too.
      assert.deepEqual(await moves('admin'), [
        [branchId, somewhere, probeId, probeId],
        [elsewhere, branchId, probeId, probeId],
        [branchId, elsewhere, probeId, probeId],
      ]);
      assert.deepEqual(await moves('watcher'), [
        [branchId, somewhere, null, null],
        [null, branchId, null, null],
        [branchId, null, null, null],
      ]);

      const parents = (login: string): Promise<unknown[]> =>
        named(mover, login, 'object.reordered', (entry) => entry.summary['parentId']);
      assert.deepEqual(await parents('admin'), [elsewhere]);
      assert.deepEqual(await parents('watcher'), [null]);

      const sources = (login: string): Promise<unknown[]> =>
        named(copied.object.id, login, 'object.cloned', (entry) => entry.summary['sourceId']);
      assert.deepEqual(await sources('admin'), [source]);
      assert.deepEqual(await sources('watcher'), [null]);

      const masters = async (login: string): Promise<unknown[]> => [
        ...(await named(dependent, login, 'setting.set', (entry) =>
          change(entry, 'setting.dependency.masterId'),
        )),
        ...(await named(dependent, login, 'setting.reverted', (entry) =>
          change(entry, 'setting.dependency.masterId'),
        )),
      ];
      assert.deepEqual(await masters('admin'), [
        [null, carvedSensorId],
        [carvedSensorId, null],
      ]);
      assert.deepEqual(await masters('watcher'), [
        [null, null],
        [null, null],
      ]);

      // A master the reader can see reads as it is.
      await harness.service.setDependency(testActor, dependent, 'object', pingId, undefined);
      assert.deepEqual(
        (await masters('watcher'))[0],
        [null, pingId],
        'a visible master was hidden',
      );
      await harness.service.setDependency(testActor, dependent, 'parent', undefined, undefined);
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

/**
 * Each object the branch account can see, and a listing route that must name it (`A-31`).
 *
 * Checked route by route, not across every body at once: pooled, one route's answer stood in for
 * another's refusal.
 */
const NAMED_BY: readonly (readonly [name: string, route: string])[] = [
  ['Customer A', '/api/v1/objects/tops'],
  ['a-web01', '/api/v1/objects'],
  ['a-ping', '/api/v1/objects'],
  ['a-held', '/api/v1/objects'],
  ['a-regranted', '/api/v1/objects'],
  ['a-lonely', '/api/v1/objects'],
  ['a-found-run', '/api/v1/discovery/:id'],
  ['a-found-host', '/api/v1/discovery/:id/hosts'],
  // Not '/api/v1/discovery/:id/problems': write on the group since `A-82`, which this account lacks.
  ['a-found-vendor', '/api/v1/discovery/:id/summary'],
  ['Customer A library', '/api/v1/libraries'],
  ['Customer A wall', '/api/v1/maps'],
  // The branch's own set without bounds, in a list that also holds the hidden probe's (`U-21`).
  ['Customer A', '/api/v1/credentials/unbounded'],
];

/**
 * The `GET` routes that answer the branch account nothing but refusals, and why (`A-31`).
 *
 * Every other route must answer it at least once, so a route that starts refusing everything is
 * noticed. It replaces a floor of "more than 25 routes answered", which held with forty refusing.
 */
const NEVER_ANSWERS_THE_BRANCH: readonly string[] = [
  // An administrator's: every account, group, object grant and probe, and the audit log.
  '/api/v1/accounts',
  '/api/v1/accounts/:id/groups',
  '/api/v1/audit',
  '/api/v1/groups',
  '/api/v1/groups/:id/members',
  '/api/v1/objects/:id/access',
  '/api/v1/probes',
  // Who else may see a map or a library, and a map's links: `full` on it, and a read-only
  // account's role caps it below that.
  '/api/v1/libraries/:id/access',
  '/api/v1/maps/:id/access',
  '/api/v1/maps/:id/shares',
  // The installation's own numbers, behind read on the root, which a branch account does not
  // hold. Asserted to refuse it, and to answer an administrator, by the health test below.
  '/api/v1/core-health',
  '/api/v1/notification-health',
  '/api/v1/objects/root',
  '/metrics',
  // Read on the probe, which is above the branch.
  '/api/v1/probes/:id/health',
  // Write on the run's group (`A-82`): a pass's problems are worded for the account it answered,
  // and the branch account is read-only. The A-82 test above covers who it answers.
  '/api/v1/discovery/:id/problems',
  // The fixture's map has no background, for anybody. `maps-api.test.ts` covers both routes.
  '/api/v1/maps/:id/background',
  '/api/v1/public/maps/:token/background',
].sort();

/**
 * The routes that answered the branch account, where not even an administrator's answer carries
 * the marker, and why (`A-31`). On these the branch sweep's silence proves nothing, so each is
 * covered, where it is covered, by a test of its own.
 */
const NO_MARKER_TO_REACH: readonly string[] = [
  // A catalogue, or the caller's own session: nothing in them is an object in the tree.
  '/api/v1/auth/me',
  '/api/v1/auth/mfa',
  '/api/v1/auth/session',
  '/api/v1/auth/tokens',
  '/api/v1/build',
  '/api/v1/credential-kinds',
  '/api/v1/device-templates',
  '/api/v1/device-templates/:templateId',
  '/api/v1/lookups',
  '/api/v1/lookups/:id',
  '/api/v1/notification-methods',
  '/api/v1/notification-placeholders',
  '/api/v1/openapi.json',
  '/api/v1/sensor-types',
  '/api/v1/setting-definitions',
  '/api/v1/summarisation-modes',
  '/api/v1/templates',
  '/api/v1/templates/:id',
  '/api/v1/trigger-kinds',
  // Counts, which carry no marker. Each is asserted by number: the object counts in `absent,
  // not counted`, and a schedule's users in the `A-25` test.
  '/api/v1/objects/counts',
  '/api/v1/objects/:id/counts',
  '/api/v1/schedules',
  '/api/v1/schedules/:id',
  // Ids and a right, with no name to find. A hidden id answers as an unused one, which the `A-49`
  // test asserts by value: the route has no `onObject`, since "nothing" is an answer it gives.
  '/api/v1/objects/:id/access/effective',
  // About the object asked and nothing beneath it, and the sweep asks about visible objects
  // only. A hidden id is refused by each route's own `onObject`, which the access matrix
  // sweeps route by route.
  '/api/v1/objects/:id/audit',
  '/api/v1/objects/:id/channels',
  '/api/v1/objects/:id/credentials',
  '/api/v1/objects/:id/discovery',
  '/api/v1/objects/:id/settings',
  '/api/v1/sensors/:id/history',
  '/api/v1/sensors/:id/state',
  '/api/v1/sensors/:id/values',
  // A host's address and the ids of the templates it matched, never a name. The hidden run's
  // plan is answered as an unused id by the `A-37` test.
  '/api/v1/discovery/:id/plan',
  // Answered as the link's maker, whoever asks, so an administrator is shown the operator's
  // view. The share tests assert what that view leaves out.
  '/api/v1/public/maps/:token',
].sort();

/** As much of an OpenAPI document as the sweep reads: each path's declared query parameters. */
interface OpenApi {
  paths: Record<string, { get?: { parameters?: { in: string; name: string }[] } } | undefined>;
}

/**
 * The first frame of this type at or after index `from`, or a failure at 10 s that lists every
 * frame from `from` on, as they stood then (`P-356`).
 */
async function waitFor(
  frames: readonly string[],
  type: string,
  from = 0,
): Promise<Record<string, unknown>> {
  const first = (): Record<string, unknown> | undefined =>
    frames
      .slice(from)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((parsed) => parsed['type'] === type);
  await pollWithin(
    10_000,
    () => `a ${type} frame; saw ${frames.slice(from).join(' | ') || 'none'}`,
    () => first() !== undefined,
    10,
  );
  const frame = first();
  assert.ok(frame !== undefined, `a ${type} frame was seen and then was not`);
  return frame;
}
