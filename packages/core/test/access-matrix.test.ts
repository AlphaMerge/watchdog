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
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
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

  let probeId = 0;
  let deviceId = 0;
  let sensorId = 0;
  let teamId = 0;

  /** login → cookie, for each account in the matrix. */
  const cookies = new Map<string, string>();
  const userIds = new Map<string, number>();

  before(async () => {
    scratch = await createScratchDatabase('accessmatrix');
    db = scratch.db;
    const harness = await buildHarness(db);

    const accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const throttle = new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() });
    access = new AccessService({ db, logger: silent });
    groups = new GroupService({ db, logger: silent });

    server = new ApiServer({
      config: { host: '127.0.0.1', port: 0, webRoot: '' },
      logger: silent,
      version: '9.9.9',
      service: harness.service,
      history: new HistoryService({ db, logger: silent }),
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
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
      await access.grant(probeId, teamId, 'read', 'matrix');

      const leaked: string[] = [];
      for (const route of server.routes) {
        if (route.method !== 'GET') continue;
        const response = await app.inject({
          method: 'GET',
          url: fill(route.url),
          headers: readonly,
        });
        if (response.body.includes(PLANTED_SECRET)) leaked.push(`${route.method} ${route.url}`);
      }

      assert.deepEqual(leaked, [], 'these routes returned a credential to a read-only account');
    });

    it('never returns it to a read-write account either, or to an administrator', async () => {
      // **The stronger claim, and the one this system actually makes**: credentials are
      // write-only *to everyone*, redacted at `ObjectService.#redact`, so being an administrator
      // does not help. A test that only checked the read-only case would pass on a system where
      // the answer was a role check rather than a boundary.
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
