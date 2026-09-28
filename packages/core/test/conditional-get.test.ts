import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { BuildIdentity } from '@ms/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

interface Detail {
  id: number;
  version: number;
  settings?: { key: string; effective: { value: unknown } }[];
  credentials?: { kind: string }[];
}

/**
 * A conditional GET has to be safe for what the response *contains*, not for what the object is
 * (S-13). Inherited settings and credentials come from ancestors, and an ancestor's change does
 * not move this object's version — so the interesting cases here are all about something
 * changing somewhere else.
 */
describe(
  'conditional GET',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;

    before(async () => {
      scratch = await createScratchDatabase('condget');
      db = scratch.db;
      h = await buildHarness(db);

      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    let probeId: number;
    let groupId: number;
    let deviceId: number;

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'group',
      });
      groupId = group.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'device',
        host: '192.0.2.70',
      });
      deviceId = device.id;
    });

    async function get(
      id: number,
      options: { include?: string | undefined; ifNoneMatch?: string | undefined } = {},
    ): Promise<{ status: number; etag: string | undefined; body: Detail }> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}`,
        ...(options.include === undefined ? {} : { query: { include: options.include } }),
        ...(options.ifNoneMatch === undefined
          ? {}
          : { headers: { 'if-none-match': options.ifNoneMatch } }),
      });
      return {
        status: response.statusCode,
        etag: response.headers['etag'],
        body: response.statusCode === 304 ? ({} as Detail) : response.json<Detail>(),
      };
    }

    const interval = (body: Detail): unknown =>
      body.settings?.find((s) => s.key === 'scan.intervalSeconds')?.effective.value;

    // ---------------------------------------------------------------------------------------
    // The plain case, which already worked.
    // ---------------------------------------------------------------------------------------

    it('serves 304 for an unchanged object with no inherited content', async () => {
      const first = await get(deviceId);
      assert.equal(first.status, 200);
      assert.ok(first.etag);

      const second = await get(deviceId, { ifNoneMatch: first.etag });
      assert.equal(second.status, 304);
      assert.equal(second.etag, first.etag);
    });

    // ---------------------------------------------------------------------------------------
    // The case S-13 exists for.
    // ---------------------------------------------------------------------------------------

    it('serves 304 for inherited settings when nothing anywhere has changed', async () => {
      const first = await get(deviceId, { include: 'settings' });
      assert.equal(first.status, 200);
      assert.ok(first.etag?.includes('-'), 'the tag carries a chain digest as well as a version');

      const second = await get(deviceId, { include: 'settings', ifNoneMatch: first.etag });
      assert.equal(second.status, 304, 'the common UI read is conditional again');
    });

    it('does not serve 304 after an ancestor changes a setting this object inherits', async () => {
      const first = await get(deviceId, { include: 'settings' });
      assert.equal(interval(first.body), 60, 'the registry default, to begin with');

      // Two levels up, and the device's own version does not move.
      await h.service.setSetting(testActor, probeId, 'scan.intervalSeconds', 900, {
        kind: 'none',
      });

      const second = await get(deviceId, { include: 'settings', ifNoneMatch: first.etag });
      assert.equal(second.status, 200, 'a 304 here would hide the change entirely');
      assert.equal(interval(second.body), 900);
      assert.equal(second.body.version, first.body.version, 'and it was never this object');
    });

    it('does not serve 304 after a credential appears on an ancestor', async () => {
      const first = await get(deviceId, { include: 'credentials' });
      assert.equal(first.body.credentials?.length, 0);

      await db.query(
        `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
         VALUES ($1, 'snmp', '{"community":"public"}'::jsonb, '\\x00'::bytea, 'k1')`,
        [groupId],
      );

      // The security-relevant direction: a stale 304 on credentials means a client keeps acting
      // on a credential set that has been changed or revoked.
      const second = await get(deviceId, { include: 'credentials', ifNoneMatch: first.etag });
      assert.equal(second.status, 200);
      assert.equal(second.body.credentials?.length, 1);
    });

    it('does not serve 304 after a credential is revoked', async () => {
      // **`P-92`, and the direction the case above does not cover.** The trigger that bumps the
      // owner's version fired on INSERT and UPDATE only, so a revocation moved no version and
      // the chain digest was unchanged. A client holding the previous ETag got a 304 and went on
      // rendering — and acting on — a credential that had been taken away. Which is exactly what
      // the route's comment says the chain digest is for.
      await db.query(
        `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
         VALUES ($1, 'snmp', '{"community":"public"}'::jsonb, '\\x00'::bytea, 'k1')`,
        [groupId],
      );
      const first = await get(deviceId, { include: 'credentials' });
      assert.equal(first.body.credentials?.length, 1, 'inherited from the group');

      await db.query("DELETE FROM credential_set WHERE object_id = $1 AND kind = 'snmp'", [
        groupId,
      ]);

      const second = await get(deviceId, { include: 'credentials', ifNoneMatch: first.etag });
      assert.equal(second.status, 200, 'a revocation is a change the client has to see');
      assert.equal(second.body.credentials?.length, 0);
    });

    it('does not serve 304 after an ancestor is re-parented, even with no version any higher', async () => {
      // The case that rules out "the maximum version along the chain" as a validator. Versions
      // are per-object counters, so a move can change every inherited value while leaving the
      // maximum exactly where it was.
      const sibling = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'sibling',
      });
      await h.service.setSetting(testActor, sibling.id, 'scan.intervalSeconds', 111, {
        kind: 'none',
      });

      // Push the device's own version well clear of everything above it.
      for (let index = 0; index < 10; index += 1) {
        await h.service.update(
          testActor,
          deviceId,
          { kind: 'device', name: `device-${String(index)}` },
          { kind: 'none' },
        );
      }

      const chainVersions = async (): Promise<number[]> =>
        Promise.all(
          [deviceId, groupId, sibling.id, probeId, h.rootId].map(async (id) => {
            const body = await get(id);
            return body.body.version;
          }),
        );

      const first = await get(deviceId, { include: 'settings' });
      assert.equal(interval(first.body), 60);
      const before = Math.max(...(await chainVersions()));

      // Move the *group*, not the device: the device's own version never moves.
      await h.service.move(testActor, groupId, sibling.id, { kind: 'none' });

      const afterwards = Math.max(...(await chainVersions()));
      assert.equal(afterwards, before, 'the highest version in play is exactly where it was');

      const second = await get(deviceId, { include: 'settings', ifNoneMatch: first.etag });
      assert.equal(second.status, 200, 'but everything it inherits now comes from somewhere else');
      assert.equal(interval(second.body), 111);
    });

    // ---------------------------------------------------------------------------------------
    // The other half of the tag.
    // ---------------------------------------------------------------------------------------

    it('accepts a compound tag as If-Match, reading the version out of it', async () => {
      const read = await get(deviceId, { include: 'settings' });
      assert.ok(read.etag?.includes('-'));

      // An edit to this object is an edit to this object. Refusing it because an ancestor moved
      // would be an optimistic-lock failure with no conflict behind it.
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: { 'if-match': read.etag ?? '' },
        payload: { kind: 'device', name: 'renamed-through-a-compound-tag' },
      });
      assert.equal(patched.statusCode, 200);
    });

    it('still refuses a compound tag whose version half is stale', async () => {
      const read = await get(deviceId, { include: 'settings' });
      await h.service.update(
        testActor,
        deviceId,
        { kind: 'device', name: 'changed-underneath' },
        { kind: 'none' },
      );

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(deviceId)}`,
        headers: { 'if-match': read.etag ?? '' },
        payload: { kind: 'device', name: 'too-late' },
      });
      assert.equal(patched.statusCode, 412);
    });

    // ---------------------------------------------------------------------------------------
    // The input that is not in the database.
    // ---------------------------------------------------------------------------------------

    /**
     * Another core over the same database — which is what an upgrade, or a restart, looks like to
     * a client holding a validator the previous one issued.
     */
    async function core(version: string, build?: BuildIdentity): Promise<FastifyInstance> {
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version,
        ...(build === undefined ? {} : { build }),
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build(version, h.service);
      return server.app;
    }

    const settingsOf = (on: FastifyInstance, etag?: string): Promise<LightMyRequestResponse> =>
      on.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(deviceId)}`,
        query: { include: 'settings' },
        ...(etag === undefined ? {} : { headers: { 'if-none-match': etag } }),
      });

    it('invalidates across an upgrade, because a resolved default lives in code', async () => {
      const first = await get(deviceId, { include: 'settings' });

      const response = await settingsOf(await core('9.9.10'), first.etag ?? '');

      // Nothing in the database changed. The value of an unset setting still might have, because
      // it comes from the registry — and the registry is code.
      assert.equal(response.statusCode, 200);
      assert.notEqual(response.headers['etag'], first.etag);
    });

    // `H-11`. The case above is an upgrade that moves the version, and until `H-11` no upgrade
    // ever did: every build said `0.1.0`, so the one validator input that lives in code was the
    // same string on every build there has ever been.
    const COMMIT_A = 'a'.repeat(40);
    const COMMIT_B = 'b'.repeat(40);

    it('invalidates across an upgrade that keeps the version, because the commit is the code', async () => {
      const before = await core('0.1.0', { version: '0.1.0', commit: COMMIT_A, dirty: false });
      const first = await settingsOf(before);
      assert.equal(first.statusCode, 200);

      const upgraded = await core('0.1.0', { version: '0.1.0', commit: COMMIT_B, dirty: false });
      const response = await settingsOf(upgraded, String(first.headers['etag']));

      // A 304 here serves the old build's rendering of every default the new one changed.
      assert.equal(response.statusCode, 200);
      assert.notEqual(response.headers['etag'], first.headers['etag']);
    });

    it('keeps a validator across a restart of the same build, or nothing could be cached', async () => {
      // The other side of the comparison. A salt that changed on every start would pass the case
      // above and throw away every client's cache on every restart — correct, and pointless.
      const exact = { version: '0.1.0', commit: COMMIT_A, dirty: false };
      const first = await settingsOf(await core('0.1.0', exact));
      const response = await settingsOf(await core('0.1.0', exact), String(first.headers['etag']));
      assert.equal(response.statusCode, 304);
    });

    it('keeps none across a restart of a build that cannot say what it is', async () => {
      // No commit, or uncommitted changes on top of one: the same identity can be two bodies of
      // code, so the only safe validator is one that dies with the process that issued it.
      for (const build of [
        { version: '0.1.0', commit: null, dirty: false },
        { version: '0.1.0', commit: COMMIT_A, dirty: true },
      ]) {
        const first = await settingsOf(await core('0.1.0', build));
        const response = await settingsOf(
          await core('0.1.0', build),
          String(first.headers['etag']),
        );
        assert.equal(response.statusCode, 200, JSON.stringify(build));
      }
    });

    it('says which build is serving', async () => {
      const serving = await core('0.1.0', { version: '0.1.0', commit: COMMIT_A, dirty: true });
      const response = await serving.inject({ method: 'GET', url: '/api/v1/build' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { version: '0.1.0', commit: COMMIT_A, dirty: true });

      // A server nobody told reports the version it was given and no commit — not a guess.
      const untold = await (await core('9.9.9')).inject({ method: 'GET', url: '/api/v1/build' });
      assert.deepEqual(untold.json(), { version: '9.9.9', commit: null, dirty: false });
    });
  },
);
