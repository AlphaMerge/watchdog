import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccessService, type AccessRight } from '../src/auth/access.js';
import { AccountService, type AccountRole } from '../src/auth/accounts.js';
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
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * `PLAN.md` Phase 9's exit criteria, as tests (`A-10`).
 *
 *   1. **An access-control test matrix passes for every combination of role, group and tree
 *      position.** `A-03` proves the resolver; this proves the same combinations *over HTTP*,
 *      which is where a route that forgot to ask would show up.
 *   2. **A read-only user cannot retrieve any credential by any route, including historic-data
 *      and export endpoints.**
 *
 * **The second one is swept rather than sampled**, and that is the design of this file. A list of
 * "routes that might leak a credential", maintained by hand, goes stale on the day somebody adds
 * a route — which is precisely the day it was supposed to catch something. So a real secret is
 * planted in a sensor and *every registered route* is called as a read-only account, with the
 * assertion that the secret appears in none of the responses.
 */

const available = await databaseAvailable();

/** The secret planted in a sensor's `writeOnly` parameter. Distinctive so a match is unambiguous. */
const PLANTED_SECRET = 'zzz-planted-community-string-zzz';

describe('the access-control matrix', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let server: ApiServer;
  let access: AccessService;
  let groups: GroupService;
  let harness: Harness;
  let discovery: DiscoveryService;
  let triggers: TriggerService;
  let rediscovery: RediscoveryService;

  let probeId = 0;
  let deviceId = 0;
  let sensorId = 0;
  let groupId = 0;
  let teamId = 0;
  /** Real rows for the routes addressed by something that belongs to an object (`R07`). */
  let triggerId = 0;
  let runId = 0;
  let scheduleId = 0;

  /** login → cookie, for each account in the matrix. */
  const cookies = new Map<string, string>();
  const userIds = new Map<string, number>();

  before(async () => {
    scratch = await createScratchDatabase('accessmatrix');
    db = scratch.db;
    harness = await buildHarness(db);

    const accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const throttle = new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() });
    access = new AccessService({ db, logger: silent });
    groups = new GroupService({ db, logger: silent });

    discovery = new DiscoveryService({
      db,
      logger: silent,
      dispatch: () => ({ kind: 'sent' }),
    });
    const probeQueries = new ProbeQueryService({
      logger: silent,
      sender: { sendQuery: () => ({ kind: 'offline' as const }) },
    });
    triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });
    rediscovery = new RediscoveryService({
      db,
      logger: silent,
      discovery,
      windowFor: () => Promise.resolve(null),
      provision: () => Promise.resolve(),
    });
    const messageContexts = new MessageContextLoader({
      settings: harness.resolver,
      publicUrl: 'https://monitoring.example.test',
      siteName: 'matrix',
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
      history: new HistoryService({ db, logger: silent }),
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      // **The library services are registered here on purpose** (`A-11`). Without them the
      // mutating sweep below covers only the object routes, and "no write is open to a
      // read-only account" would be a claim about a third of the API — which is how a build
      // where a read-only account could delete every trigger passed this file for a fortnight.
      triggers,
      templates: new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: messageContexts,
      }),
      schedules: new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent }),
      // **And every other module that registers a route** (`R07`). `ApiServer` registers each
      // group behind an `if (this.#X !== undefined)`, so a service the harness does not pass is
      // a set of routes `server.routes` never lists and the sweeps below never call. Thirteen
      // mutating routes were invisible that way — including `POST /templates/:id/test`, the
      // route the ticket singles out by name as the one that "really sent for anybody with a
      // session". A sweep that cannot see the route it is cited for is not evidence.
      discovery,
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
      rediscovery,
      deviceTemplates: new DeviceTemplateCatalogue(() => true),
      probeRegistry: new ProbeRegistry({ db, logger: silent, enrolmentKeys: ['matrix-key'] }),
      queries: probeQueries,
      probeConfig: new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
      }),
      tester: new NotificationTester({
        db,
        logger: silent,
        contexts: messageContexts,
        // No transport at all: the point of registering the tester is that the *route* exists to
        // be swept. A send that reached this far would fail for want of a transport, which is a
        // 400 — and this file only ever asserts that the guard answered first.
        transports: [],
        audit: new DatabaseAuditSink(),
      }),
      auth: {
        accounts,
        sessions,
        throttle,
        groups,
        access,
        tokens: new TokenService({ db, logger: silent }),
        totp: new TotpService({ db, logger: silent }),
        required: true,
      },
    });
    await server.build('9.9.9', harness.service);
    app = server.app;

    // probe → device → sensor, with a real secret in the sensor.
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: 'matrix-probe',
    });
    probeId = probe.id;
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'web01',
      host: '127.0.0.1',
    });
    deviceId = device.id;
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: device.id,
      name: 'Traffic',
      sensorType: 'snmp.traffic',
      params: { community: PLANTED_SECRET, port: 161 },
    });
    sensorId = sensor.id;
    const group = await harness.service.create(testActor, {
      kind: 'group',
      parentId: probe.id,
      name: 'matrix-group',
    });
    groupId = group.id;

    // **Real rows, so the derived guards are actually exercised** (`R07`). A route addressed by
    // a trigger, a run or a rediscovery schedule resolves its object by looking the row up, and
    // a row that does not exist is deliberately allowed through for the handler's own 404 — so
    // sweeping these with a made-up id proves nothing about the guard. These are the ids the
    // sweep fills in.
    triggerId = (
      await triggers.create(testActor, sensorId, {
        kind: 'state',
        settings: { state: 'down' },
        enabled: true,
      })
    ).id;
    runId = (await discovery.start({ groupId, probeId, range: '10.9.9.0/30' })).id;
    scheduleId = (
      await rediscovery.create({
        groupId,
        probeId,
        name: 'matrix-rediscovery',
        range: '10.9.9.0/30',
        cadence: 'daily',
      })
    ).id;

    teamId = (await groups.create({ name: 'Team' })).id;

    // One account per role, all in the same group, so the only variable in the matrix is the
    // role and the grant.
    for (const role of ['admin', 'readwrite', 'readonly'] as const) {
      const account = await accounts.create({
        login: role,
        password: 'correct-horse-battery',
        role,
      });
      userIds.set(role, account.id);
      // The administrator goes in the admin group; the others in the ordinary one. A read-only
      // account cannot be in an admin group at all (`A-04`).
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
        payload: { login: role, password: 'correct-horse-battery' },
      });
      assert.equal(response.statusCode, 200, `${role} could not log in`);
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      cookies.set(role, header.split(';')[0] ?? '');
    }
  });

  after(async () => {
    await scratch.drop();
  });

  const asRole = (role: string) => ({ cookie: cookies.get(role) ?? '' });

  describe('every combination of role, group and tree position', () => {
    interface Case {
      role: AccountRole;
      grant: AccessRight | 'none-at-all';
      /** Where the grant sits, when there is one. */
      at: 'probe' | 'device' | 'sensor';
      /** What the account should resolve on the sensor. */
      expect: AccessRight;
    }

    const CASES: Case[] = [
      // An administrator holds everything regardless of grants or position.
      { role: 'admin', grant: 'none-at-all', at: 'probe', expect: 'full' },
      { role: 'admin', grant: 'none', at: 'sensor', expect: 'full' },

      // A read-write account gets exactly what it was granted, wherever it was granted.
      { role: 'readwrite', grant: 'none-at-all', at: 'probe', expect: 'none' },
      { role: 'readwrite', grant: 'read', at: 'probe', expect: 'read' },
      { role: 'readwrite', grant: 'write', at: 'device', expect: 'write' },
      { role: 'readwrite', grant: 'full', at: 'sensor', expect: 'full' },
      { role: 'readwrite', grant: 'none', at: 'device', expect: 'none' },

      // A read-only account is capped at read however much it is granted (`A-04`).
      { role: 'readonly', grant: 'none-at-all', at: 'probe', expect: 'none' },
      { role: 'readonly', grant: 'read', at: 'probe', expect: 'read' },
      { role: 'readonly', grant: 'write', at: 'device', expect: 'read' },
      { role: 'readonly', grant: 'full', at: 'sensor', expect: 'read' },
      { role: 'readonly', grant: 'none', at: 'device', expect: 'none' },
    ];

    for (const testCase of CASES) {
      const where =
        testCase.grant === 'none-at-all'
          ? 'nothing granted'
          : `${testCase.grant} on the ${testCase.at}`;
      it(`${testCase.role} with ${where} resolves ${testCase.expect}`, async () => {
        await db.query('DELETE FROM object_access');
        if (testCase.grant !== 'none-at-all') {
          const objectId = { probe: probeId, device: deviceId, sensor: sensorId }[testCase.at];
          await access.grant(objectId, teamId, testCase.grant, 'matrix');
        }

        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/access/effective`,
          headers: asRole(testCase.role),
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json<{ right: AccessRight }>().right, testCase.expect);
      });
    }
  });

  describe('no route that changes anything is open to an account that may not', () => {
    /**
     * The half `A-10` never had, and the reason `A-11` exists.
     *
     * The sweep above filters to `GET`. A sweep of reads cannot notice that *no write in the
     * installation was guarded* — which is what it could not notice for the whole of Phase 9:
     * `AccessService` was called by one route, and that route only reported the answer. Every
     * mutating route was open to any authenticated principal, and the matrix passed throughout
     * because it asserted the resolver against itself.
     *
     * So this asks two different questions, and neither of them consults a list:
     *
     *   1. **Does every mutating route declare a bar above `read`?** Read off the route's own
     *      declaration, so a new `POST` that declares `READS` fails here on the day it is
     *      written rather than on the day somebody notices.
     *   2. **Is that bar actually enforced?** Every one of them is called as a read-only
     *      account, which must be refused by all of them.
     */
    /**
     * What `:id` means on this route.
     *
     * **A derived guard is only proved by a row that exists** (`R07`). `/triggers/:id` and the
     * discovery routes resolve their object by looking the id up, and a lookup that finds
     * nothing is allowed through on purpose so the handler can answer its own 404 — which is
     * indistinguishable, from outside, from a route with no guard at all. Filling these with
     * the real rows created above is what makes the refusal the first answer.
     */
    const idFor = (url: string): number => {
      // `server.routes` records the registered url, prefix and all, so this matches on the path
      // below `/api/v1` rather than on the whole thing.
      const path = url.replace('/api/v1', '');
      if (path.startsWith('/triggers/')) return triggerId;
      if (path.startsWith('/discovery/schedules/')) return scheduleId;
      if (path.startsWith('/discovery/:id')) return runId;
      return sensorId;
    };

    const fillWrite = (url: string): string =>
      url
        .replaceAll(':id', String(idFor(url)))
        .replaceAll(':sensorId', String(sensorId))
        .replaceAll(':objectId', String(sensorId))
        .replaceAll(':kind', 'snmp')
        .replaceAll(':key', 'scan.intervalSeconds')
        .replaceAll(':groupId', String(teamId))
        .replaceAll(':userId', String(userIds.get('readonly') ?? 0))
        .replaceAll(':templateId', '1')
        .replaceAll(':gid', 'none')
        .replaceAll('*', '');

    /**
     * Routes that change something the caller owns rather than the monitored estate.
     *
     * **Named by prefix, and the list is two entries long on purpose.** Logging in, changing
     * your own password and enrolling in MFA must work for a read-only account — refusing them
     * would make the role unusable — so they are the one place a mutating route may sit below
     * `write`. They declare `self` or `public`, which is what this filter reads.
     */
    const isSelfService = (route: { access: { kind: string } }): boolean =>
      route.access.kind === 'self' || route.access.kind === 'public';

    /**
     * A `POST` that computes and stores nothing — a preview over a pasted document, a plan over
     * a fingerprint. Declared `changes: false` in the route's own source rather than listed
     * here, so the exception is reviewed where it is made and this test never needs updating.
     */
    const isCompute = (route: { changes: boolean }): boolean => !route.changes;

    /**
     * Routes whose subject is not in the object tree, so there is no per-object right to hold.
     *
     * **Three entries, each for a stated reason, and the list is the whole point.** The
     * grantless sweep below asks "was this refused to an account holding nothing", and the
     * answer for a route about a *library* object is legitimately no: a notification template
     * and a schedule belong to the installation, not to a probe or a device, and `write` is the
     * bar their own tickets set. `POST /objects/bulk` is the third: it answers 200 and reports
     * the refusals per id in its body, which is what `D-09` requires of it and what the
     * dedicated test two below asserts.
     *
     * Anything else appearing here is a route that names an object and does not resolve a right
     * on it — which is exactly what this sweep exists to find, so the exemption is by url and
     * never by "it was failing".
     */
    const isRoleGoverned = (route: { url: string }): boolean =>
      /^\/api\/v1\/(templates|schedules)(\/|$)/.test(route.url) ||
      route.url === '/api/v1/objects/bulk';

    const mutating = (): {
      method: string;
      url: string;
      access: { kind: string };
      changes: boolean;
    }[] =>
      server.routes.filter(
        (route) => route.method !== 'GET' && !isSelfService(route) && !isCompute(route),
      );

    /**
     * A body that names an object for the routes whose subject is in the body.
     *
     * `POST /objects` asks for `write` on the *parent* it names, so a request that names no
     * parent has no object to be refused about and answers 400 — honest, and unsweepable. Naming
     * one the account can see turns the answer into the 403 this is trying to prove. The extra
     * fields cost nothing: authorisation now runs before validation, so a body only has to be
     * parseable to reach the guard.
     */
    const payload = {
      parentId: sensorId,
      sensorId,
      objectId: sensorId,
      ids: [sensorId],
      // A discovery run and a rediscovery schedule name the group they provision into, and that
      // group is the object the guard resolves (`G05`). Without it the answer is the honest
      // 400 for a request that names no object, which proves nothing either way.
      groupId,
    };

    it('has mutating routes to sweep, so a silent zero is not a pass', () => {
      // **The floor is close to the real number on purpose** (`R07`). At 25 it could not
      // notice that nine route modules were missing from the harness — thirteen mutating
      // routes, including the one the ticket cites by name. A floor far below the truth is a
      // guard against nothing.
      const found = mutating().length;
      assert.ok(found > 45, `only ${String(found)} mutating routes found`);

      // **And the routes an absent module takes with it, by name.** A count is the wrong guard
      // for this: nine modules were missing and the sweep still counted twenty-nine routes,
      // comfortably over its floor. The absence is in *this file's* wiring rather than in any
      // route's source, so nothing in the source can declare it and a list is the honest
      // answer — one entry per optional service `ApiServer` registers behind an `if`.
      // Against every registered route, not only the mutating ones: `as-template` and the
      // check-now query declare `changes: false`, and their module going missing is exactly
      // what this is watching for.
      const swept = new Set(server.routes.map((route) => `${route.method} ${route.url}`));
      const missing = [
        'POST /api/v1/templates/:id/test',
        'POST /api/v1/discovery',
        'POST /api/v1/discovery/:id/provision',
        'POST /api/v1/discovery/schedules',
        'POST /api/v1/objects/:id/as-template',
        'POST /api/v1/sensors/:id/check',
        'POST /api/v1/probes/:gid/approve',
        'PUT /api/v1/triggers/:id',
        'POST /api/v1/schedules',
      ].filter((route) => !swept.has(route));
      assert.deepEqual(missing, [], 'these routes are not being swept — is a service unwired?');
    });

    it('every one of them declares a bar above read', () => {
      const weak = mutating()
        .filter((route) => !isCompute(route))
        .filter((route) => {
          const access = route.access as { kind: string; needed?: AccessRight };
          if (access.kind === 'read') return true;
          if (access.kind === 'object') return access.needed === 'read';
          return false;
        })
        .map((route) => `${route.method} ${route.url}`);
      assert.deepEqual(weak, [], 'these routes change something but ask only for read');
    });

    it('refuses every one of them to a read-only account', async () => {
      // Granted `read` on the whole branch first: the refusal has to come from the *bar*, not
      // from the account having no grant at all. Without this the sweep would pass on a system
      // where object rights were the only check and the role ceiling did nothing.
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'read', 'matrix');

      const allowed: string[] = [];
      for (const route of mutating()) {
        const response = await app.inject({
          method: route.method as 'POST',
          url: fillWrite(route.url),
          headers: asRole('readonly'),
          payload,
        });
        // **401 or 403, and nothing else counts.** Accepting any 4xx is how this sweep passed a
        // mutation that let a read-only account write everything: the empty payload failed
        // schema validation first and answered 400, so the guard was never exercised. That is
        // also why authorisation moved to `preValidation` — refusing before validating makes
        // the refusal the *first* answer, which is the only version a sweep can prove.
        if (response.statusCode !== 401 && response.statusCode !== 403) {
          allowed.push(`${route.method} ${route.url} -> ${String(response.statusCode)}`);
        }
      }
      assert.deepEqual(allowed, [], 'a read-only account was not refused by these');
    });

    it('refuses every one of them to a readwrite account that was granted nothing', async () => {
      // **The pass both existing sweeps were structurally blind to** (`R08`, `R09`, `G05`).
      // A read-only account and a read-scoped token are both stopped at the role/scope gate,
      // which every mutating route clears by declaring `write` — so a bar that is *too coarse*
      // answers 403 to them and looks identical to a correct one. `readwrite` with no
      // `object_access` row anywhere is the principal that tells them apart: it passes the role
      // gate and holds `none` on every object, so anything it gets through was never guarded on
      // an object at all.
      //
      // What it found the day it was written: `POST /objects/tree` created a subtree under any
      // parent, `POST /objects/:id/move` and `/clone` relocated into any destination, `PUT` and
      // `DELETE /triggers/:id` edited every trigger in the installation, and `POST /discovery`
      // provisioned devices into any group.
      await db.query('DELETE FROM object_access');

      const allowed: string[] = [];
      for (const route of mutating()) {
        if (isRoleGoverned(route)) continue;
        const response = await app.inject({
          method: route.method as 'POST',
          url: fillWrite(route.url),
          headers: asRole('readwrite'),
          payload,
        });
        if (response.statusCode !== 401 && response.statusCode !== 403) {
          allowed.push(`${route.method} ${route.url} -> ${String(response.statusCode)}`);
        }
      }
      assert.deepEqual(
        allowed,
        [],
        'these routes were open to an account holding no right on any object',
      );
    });

    it('refuses them to a read-only account that may acknowledge, except acknowledging', async () => {
      // `may_acknowledge` is the one documented exception (`A-04`, migration 034). It was stored,
      // defaulted to false and read by nothing: every principal could acknowledge, and no
      // principal needed the flag. Both halves are asserted here — the flag opens exactly one
      // door, and opens no others.
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'read', 'matrix');
      const id = userIds.get('readonly') ?? 0;
      const acknowledge = async (): Promise<number> =>
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/objects/${String(sensorId)}/acknowledge`,
            headers: asRole('readonly'),
            payload: {},
          })
        ).statusCode;

      // **Both halves, in one test.** "It is not 403 with the flag set" passes on a build where
      // nothing checks the flag at all — which is the build this was written against. The pair
      // is what carries the claim: refused without it, allowed with it.
      await db.query('UPDATE user_account SET may_acknowledge = false WHERE id = $1', [id]);
      assert.equal(await acknowledge(), 403, 'a read-only account acknowledged without the opt-in');
      await db.query('UPDATE user_account SET may_acknowledge = true WHERE id = $1', [id]);
      assert.notEqual(await acknowledge(), 403, 'the acknowledge opt-in did not open its own door');

      const allowed: string[] = [];
      for (const route of mutating()) {
        if (route.access.kind === 'acknowledge') continue;
        const response = await app.inject({
          method: route.method as 'POST',
          url: fillWrite(route.url),
          headers: asRole('readonly'),
          payload,
        });
        if (response.statusCode !== 401 && response.statusCode !== 403) {
          allowed.push(`${route.method} ${route.url} -> ${String(response.statusCode)}`);
        }
      }
      assert.deepEqual(allowed, [], 'may_acknowledge opened doors other than acknowledging');
      await db.query('UPDATE user_account SET may_acknowledge = false WHERE id = $1', [id]);
    });

    it('refuses only the ids in a bulk selection the account may not change', async () => {
      // **A bulk request names its objects in the body, so one bar for the whole request cannot
      // express it.** The route asks for `write`, which a read-write account has as a role — and
      // before `A-11` that was the entire check, so an account with no grant anywhere could
      // select the tree and delete it. The ids are partitioned instead, and the refused ones come
      // back as ordinary failed outcomes: a selection made in a tree view routinely includes
      // something the operator cannot touch, and failing the whole request would be unusable.
      await db.query('DELETE FROM object_access');
      await access.grant(deviceId, teamId, 'write', 'matrix');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/objects/bulk',
        headers: asRole('readwrite'),
        payload: { ids: [sensorId, probeId], operation: 'pause', minutes: 5 },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{
        requested: number;
        failed: number;
        outcomes: { objectId: number; ok: boolean; code?: string }[];
      }>();
      assert.equal(body.requested, 2, 'both ids should be reported, not only the allowed one');
      const probe = body.outcomes.find((one) => one.objectId === probeId);
      const sensor = body.outcomes.find((one) => one.objectId === sensorId);
      assert.ok(probe, 'the refused id should still be reported');
      assert.ok(sensor, 'the allowed id should be reported');
      assert.equal(probe.ok, false, 'the probe is above the grant and should have been refused');
      assert.equal(probe.code, 'AUTH_FORBIDDEN');
      assert.equal(sensor.ok, true, 'the sensor inherits write from the device and should apply');
    });

    it('collapses a repeated id the same way whether or not the account may write it', async () => {
      // **The report must not depend on the caller's rights** (`G07`). The service collapses the
      // ids it is handed, so collapsing only on the allowed side made the same selection answer
      // `duplicates: 1` with one outcome row for an object the account may write, and
      // `duplicates: 0` with two identical failure rows for one it may not. The route's own
      // description promises "repeated ids are collapsed and counted" without qualification.
      await db.query('DELETE FROM object_access');
      await access.grant(deviceId, teamId, 'write', 'matrix');

      const send = async (id: number) =>
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/objects/bulk',
            headers: asRole('readwrite'),
            payload: { ids: [id, id], operation: 'pause', minutes: 5 },
          })
        ).json<{ requested: number; duplicates: number; outcomes: unknown[] }>();

      const mayWrite = await send(sensorId);
      const mayNot = await send(probeId);
      assert.deepEqual(
        {
          requested: mayNot.requested,
          duplicates: mayNot.duplicates,
          rows: mayNot.outcomes.length,
        },
        {
          requested: mayWrite.requested,
          duplicates: mayWrite.duplicates,
          rows: mayWrite.outcomes.length,
        },
        'the refused half reported the duplicate differently from the allowed half',
      );
      assert.equal(mayNot.duplicates, 1);
      assert.equal(mayNot.outcomes.length, 1, 'one object should be one outcome row');
    });

    it('will not build a device template out of a device the account may not read', async () => {
      // **A read of one device, priced as one** (`R12`). `POST /objects/:id/as-template` returns
      // every sensor on the named device — names, types and the parameters an operator set — as
      // a template document. It stores nothing, so it is rightly `changes: false` and the
      // mutating sweeps skip it; it was also declared `WRITES`, a role check, while every other
      // route that reads one object's contents was given `onObject('read')` in the same commit.
      await db.query('DELETE FROM object_access');

      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(deviceId)}/as-template`,
        headers: asRole('readwrite'),
        payload: { id: 'matrix-template', name: 'Matrix' },
      });
      assert.equal(refused.statusCode, 403, 'a device it may not read was served as a template');
      assert.ok(
        !refused.body.includes(PLANTED_SECRET),
        'and the refusal must not carry the secret either',
      );

      await access.grant(deviceId, teamId, 'read', 'matrix');
      const allowed = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(deviceId)}/as-template`,
        headers: asRole('readwrite'),
        payload: { id: 'matrix-template', name: 'Matrix' },
      });
      assert.equal(allowed.statusCode, 200, 'read on the device should be enough to describe it');
    });

    it('refuses a clone into a parent the account may not write, not only a source it may', async () => {
      // **Both ends of a relocation** (`G06`). `write` on the source was the whole check, so an
      // operator holding one device could clone it — and everything it goes on to alarm about —
      // into a branch they were explicitly denied, or move it out of the branch whose owners
      // could see it.
      await db.query('DELETE FROM object_access');
      await access.grant(deviceId, teamId, 'write', 'matrix');

      for (const operation of ['clone', 'move'] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(sensorId)}/${operation}`,
          headers: asRole('readwrite'),
          payload: { targetParentId: groupId },
        });
        assert.equal(
          response.statusCode,
          403,
          `${operation} into a group outside the grant should be refused`,
        );
      }

      // And the destination it *may* write is still allowed, so the bar is the destination and
      // not a blanket refusal.
      const allowed = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(sensorId)}/clone`,
        headers: asRole('readwrite'),
        payload: { targetParentId: deviceId },
      });
      assert.equal(allowed.statusCode, 201, 'a clone inside the grant should still work');
    });

    it('applies a bulk selection normally when the authorisation layer is switched off', async () => {
      // **The one check that does not live in the hook, and so did not stand down with it**
      // (`R10`). Every other bar in `A-11` is the `preValidation` hook, which returns early when
      // `auth.required` is false. The bulk partition is a call in a handler, and it was gated
      // only on whether an `AccessService` was passed — which it always is. `AccessService`
      // treats a role as a ceiling and never as a grant, so on an installation with the layer
      // off, an ordinary `readwrite` account in the built-in `Users` group had every single id
      // in a selection refused, while `POST /objects/:id/pause` on any one of those ids
      // succeeded. Forty sensors selected, forty refusals, and nothing anywhere saying why.
      await db.query('DELETE FROM object_access');
      const open = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: false,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        auth: {
          accounts: new AccountService({ db, logger: silent }),
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ db, logger: silent }),
          totp: new TotpService({ db, logger: silent }),
          required: false,
        },
      });
      await open.build('9.9.9', harness.service);
      try {
        const login = await open.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: 'readwrite', password: 'correct-horse-battery' },
        });
        assert.equal(login.statusCode, 200);
        const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';

        const response = await open.app.inject({
          method: 'POST',
          url: '/api/v1/objects/bulk',
          headers: { cookie },
          payload: { ids: [sensorId], operation: 'pause', minutes: 5 },
        });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ succeeded: number; outcomes: { ok: boolean }[] }>();
        assert.equal(
          body.succeeded,
          1,
          'the bulk route refused an id every other route in this installation allows',
        );
        assert.equal(body.outcomes[0]?.ok, true);
      } finally {
        await open.app.close();
      }
    });

    it('refuses the same routes to a read-scoped token held by an administrator', async () => {
      // **The token scope, which was captured and never enforced** (`A-06`). It was threaded
      // into `resolveFor` — correctly — and `resolveFor` was called by no route, so a token
      // scoped to `read` performed every write in the installation. Held by an administrator
      // here on purpose: the account's own role must not be what refuses this.
      const tokens = new TokenService({ db, logger: silent });
      const issued = await tokens.issue(
        { userId: userIds.get('admin') ?? 0, role: 'admin' },
        { name: 'sweep-read', scope: 'read' },
      );
      const headers = { authorization: `Bearer ${issued.secret}` };

      const allowed: string[] = [];
      for (const route of mutating()) {
        const response = await app.inject({
          method: route.method as 'POST',
          url: fillWrite(route.url),
          headers,
          payload,
        });
        if (response.statusCode !== 401 && response.statusCode !== 403) {
          allowed.push(`${route.method} ${route.url} -> ${String(response.statusCode)}`);
        }
      }
      assert.deepEqual(allowed, [], 'a read-scoped token was not refused by these');
    });
  });

  describe('no route leaks a credential to a read-only user', () => {
    /**
     * Fills a route template with ids that exist, so the request reaches a handler rather than a
     * 404. A route this cannot fill is still called — an unfilled `:id` answers 400 or 404, and
     * a 400 cannot carry a credential either.
     */
    const fill = (url: string): string =>
      url
        .replaceAll(':id', String(sensorId))
        .replaceAll(':sensorId', String(sensorId))
        .replaceAll(':objectId', String(sensorId))
        .replaceAll(':kind', 'snmp')
        .replaceAll(':groupId', String(teamId))
        .replaceAll(':userId', String(userIds.get('readonly') ?? 0))
        .replaceAll(':gid', 'none')
        .replaceAll('*', '');

    it('has routes to sweep, so a silent zero is not a pass', async () => {
      // A sweep over an empty list passes vacuously, which is the worst kind of green.
      assert.ok(server.routes.length > 50, `only ${String(server.routes.length)} routes found`);
      await Promise.resolve();
    });

    it('never returns the planted secret, on any GET route', async () => {
      // Swept rather than listed: a hand-maintained list of "routes that might leak" goes stale
      // the day somebody adds a route, which is the day it was meant to catch something.
      const readonly = asRole('readonly');
      // **The matrix above leaves an explicit `none` on the device.** Without clearing it this
      // account resolves `none` on the sensor, every object route answers 403, and the sweep
      // passes because a refusal carries no secret — which is a vacuous green of exactly the
      // kind the count below now refuses.
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'read', 'matrix');

      const leaked: string[] = [];
      let answered = 0;
      for (const route of server.routes) {
        if (route.method !== 'GET') continue;
        const response = await app.inject({
          method: 'GET',
          url: fill(route.url),
          headers: readonly,
        });
        if (response.statusCode === 200) answered += 1;
        if (response.body.includes(PLANTED_SECRET)) leaked.push(`${route.method} ${route.url}`);
      }

      assert.ok(
        answered > 20,
        `only ${String(answered)} GET routes answered 200; a sweep of refusals proves nothing`,
      );
      assert.deepEqual(leaked, [], 'these routes returned a credential to a read-only account');
    });

    it('never returns it to a read-write account either, or to an administrator', async () => {
      // **The stronger claim, and the one this system actually makes**: credentials are
      // write-only *to everyone*, redacted at `ObjectService.#redact`, so being an administrator
      // does not help. A test that only checked the read-only case would pass on a system where
      // the answer was a role check rather than a boundary.
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'full', 'matrix');

      for (const role of ['readwrite', 'admin']) {
        const leaked: string[] = [];
        for (const route of server.routes) {
          if (route.method !== 'GET') continue;
          const response = await app.inject({
            method: 'GET',
            url: fill(route.url),
            headers: asRole(role),
          });
          if (response.body.includes(PLANTED_SECRET)) leaked.push(`${route.method} ${route.url}`);
        }
        assert.deepEqual(leaked, [], `${role} was given a credential`);
      }
    });

    it('says the parameter is set without saying what it is', async () => {
      // Redacted, not omitted. An operator has to be able to see that a community string *is*
      // configured — a form that cannot distinguish "unset" from "set and hidden" makes somebody
      // retype a secret they did not need to.
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'read', 'matrix');
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(sensorId)}`,
        headers: asRole('readonly'),
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ redactedParams: string[]; params: Record<string, unknown> }>();
      assert.deepEqual(body.redactedParams, ['community']);
      assert.equal('community' in body.params, false);
    });

    it('does not leak it through the history routes the criterion names', async () => {
      await db.query('DELETE FROM object_access');
      await access.grant(probeId, teamId, 'read', 'matrix');
      for (const url of [
        `/api/v1/sensors/${String(sensorId)}/history?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`,
        `/api/v1/sensors/${String(sensorId)}/values`,
        `/api/v1/objects/${String(sensorId)}/audit`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: asRole('readonly') });
        assert.equal(response.body.includes(PLANTED_SECRET), false, `${url} leaked it`);
      }
    });

    it('does not leak it into the audit log when the sensor is changed', async () => {
      // The audit sink is handed redacted details; a diff of what it can see reports the *name*
      // of a rotated parameter and never its value.
      const rows = await db.query<{ summary: string; diff: string }>(
        `SELECT summary::text AS summary, diff::text AS diff FROM audit_log`,
      );
      for (const row of rows) {
        assert.equal(row.summary.includes(PLANTED_SECRET), false);
        assert.equal(row.diff.includes(PLANTED_SECRET), false);
      }
    });
  });
});
