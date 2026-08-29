import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
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
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
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

    it('invalidates across an upgrade, because a resolved default lives in code', async () => {
      const first = await get(deviceId, { include: 'settings' });

      const upgraded = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.10',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await upgraded.build('9.9.10', h.service);

      const response = await upgraded.app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(deviceId)}`,
        query: { include: 'settings' },
        headers: { 'if-none-match': first.etag ?? '' },
      });

      // Nothing in the database changed. The value of an unset setting still might have, because
      // it comes from the registry — and the registry is code.
      assert.equal(response.statusCode, 200);
      assert.notEqual(response.headers['etag'], first.etag);
    });
  },
);
