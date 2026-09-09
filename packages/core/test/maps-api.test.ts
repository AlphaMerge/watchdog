import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapResolver } from '../src/maps/resolver.js';
import { MapService } from '../src/maps/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * The maps API over the wire (`G-01`, `G-10`).
 *
 * **These routes had no HTTP test at all, and for most of their life no server either** — the
 * service was an option nothing passed, so every route `G-01` shipped answered 404 in the binary
 * that ships. `G-03` mounted them; this is the coverage that says so and keeps saying so.
 *
 * The claims here are the ones that only exist on the wire: that the view route resolves widgets,
 * that *who is asking* decides whether a broken tile explains itself, and that a map the caller
 * may not read is absent rather than forbidden on this route too.
 */

const available = await databaseAvailable();

describe('the maps API', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let built: ApiServer;
  let author = '';
  let reader = '';
  let sensorId: number;
  let deletedId: number;
  let readerGroupId: number;

  before(async () => {
    scratch = await createScratchDatabase('mapsapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    const accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const groups = new GroupService({ db, logger: silent });
    const access = new AccessService({ db, logger: silent });
    const history = new HistoryService({ db, logger: silent });

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
      service: harness.service,
      history,
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      maps: new MapService({ db, repository: new MapRepository(), logger: silent }),
      mapResolver: new MapResolver({ db, access, history }),
      auth: {
        accounts,
        sessions,
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
    built = server;

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'api-probe',
      parentId: harness.rootId,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      name: 'api-device',
      parentId: probe.id,
      host: '10.0.0.2',
    });
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      name: 'api-sensor',
      parentId: device.id,
      sensorType: 'icmp.ping',
    });
    sensorId = sensor.id;

    // A sensor that will be gone by the time the map is read — the widget has to survive it.
    const doomed = await harness.service.create(testActor, {
      kind: 'sensor',
      name: 'api-doomed',
      parentId: device.id,
      sensorType: 'icmp.ping',
    });
    deletedId = doomed.id;
    // Removed in SQL rather than through the service: `delete` wants an expectation and a
    // precondition that are a whole other ticket's rules, and what this fixture needs is simply
    // an id the object table no longer has.
    await db.query('DELETE FROM object WHERE id = $1', [deletedId]);

    // Two accounts in two groups. Both `readwrite`, because an administrator short-circuits
    // every grant and would make the access half of this file assert nothing.
    await accounts.create({
      login: 'author',
      password: 'correct-horse-battery',
      role: 'readwrite',
    });
    await accounts.create({
      login: 'reader',
      password: 'correct-horse-battery',
      role: 'readwrite',
    });
    const authorGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('authors') RETURNING id`,
    );
    const readerGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('readers') RETURNING id`,
    );
    readerGroupId = Number(readerGroup[0]?.id);
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login = 'author'`,
      [Number(authorGroup[0]?.id)],
    );
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login = 'reader'`,
      [readerGroupId],
    );
    // Both may see the tree; the *map's* access is what these cases are about, and a widget
    // that resolved to `unavailable` because nobody could see the sensor would say nothing
    // about the map rules at all.
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_)
       VALUES ($1, $2, 'read'), ($1, $3, 'read')`,
      [harness.rootId, readerGroupId, Number(authorGroup[0]?.id)],
    );

    author = await sessionFor('author');
    reader = await sessionFor('reader');
  });

  after(async () => {
    await scratch.drop();
  });

  const sessionFor = async (login: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: 'correct-horse-battery' },
    });
    assert.equal(response.statusCode, 200, `${login} could not log in`);
    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    return header.split(';')[0] ?? '';
  };

  const as = (cookie: string) => ({ cookie });

  const makeMap = async (name: string, widgets: unknown[]): Promise<number> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: as(author),
      payload: { name, layout: { widgets } },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: number }>().id;
  };

  const view = async (id: number, cookie: string) =>
    app.inject({ method: 'GET', url: `/api/v1/maps/${String(id)}/view`, headers: as(cookie) });

  it('serves the routes at all, which is the thing that was missing', async () => {
    const id = await makeMap('mounted', []);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/maps', headers: as(author) });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json<{ items: { id: number }[] }>().items.some((one) => one.id === id));
  });

  it('fills the widgets in rather than handing back the document', async () => {
    const id = await makeMap('filled', [
      { id: 'w1', kind: 'status', objectId: sensorId, title: 'The sensor' },
    ]);
    const response = await view(id, author);
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json<{
      map: { id: number; version: number };
      widgets: { id: string; state: string; data?: { kind: string; name: string } }[];
      problems: unknown[];
    }>();
    assert.equal(body.map.id, id);
    assert.equal(body.widgets.length, 1);
    const drawn = body.widgets[0];
    assert.ok(drawn);
    assert.equal(drawn.state, 'ok');
    // The resolved name, which is nowhere in the document the author saved.
    assert.equal(drawn.data?.name, 'api-sensor');
  });

  it('keeps a widget whose object is gone, and tells the author why', async () => {
    const id = await makeMap('broken', [
      { id: 'w1', kind: 'status', objectId: deletedId, title: 'Was a sensor' },
    ]);
    const body = (await view(id, author)).json<{
      widgets: { state: string; title: string; reason?: string }[];
    }>();
    const tile = body.widgets[0];
    assert.ok(tile);
    assert.equal(tile.state, 'unavailable');
    assert.equal(tile.title, 'Was a sensor', 'still where the author put it');
    assert.equal(tile.reason, 'object-deleted');
  });

  it('tells a reader the tile is unavailable and not why', async () => {
    // **The rule this route exists to enforce, and it only exists on the wire**: `holdsFull`
    // comes from the caller's right on *this map*, so the same document answers two people
    // differently. "Deleted" against "you may not see it" is an oracle for which ids are live.
    const id = await makeMap('shared', [
      { id: 'w1', kind: 'status', objectId: deletedId, title: 'Was a sensor' },
    ]);
    const granted = await app.inject({
      method: 'PUT',
      url: `/api/v1/maps/${String(id)}/access/${String(readerGroupId)}`,
      headers: as(author),
      payload: { right: 'read' },
    });
    assert.equal(granted.statusCode, 204, granted.body);

    const body = (await view(id, reader)).json<{ widgets: { state: string; reason?: string }[] }>();
    const tile = body.widgets[0];
    assert.ok(tile);
    assert.equal(tile.state, 'unavailable');
    assert.equal(tile.reason, undefined);
  });

  it('answers 404 for a map this account cannot read, on the view route too', async () => {
    // Not 403. The whole point of `invisible` is that the error says nothing about existence,
    // and a second route that answered differently would give the oracle back.
    const id = await makeMap('private', []);
    const response = await view(id, reader);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'MAP_NOT_FOUND');
  });

  it('answers 404 for a map that does not exist, in the same words', async () => {
    const response = await view(999_999, author);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'MAP_NOT_FOUND');
  });

  describe('the background image', () => {
    /** A 24-byte PNG header, which is all `readImage` reads and all this needs to store. */
    const png = (width: number, height: number): Buffer => {
      const bytes = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
      bytes.writeUInt32BE(13, 8);
      bytes.write('IHDR', 12, 'latin1');
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      return bytes;
    };

    const upload = async (id: number, body: Buffer, cookie = author, type = 'image/png') =>
      app.inject({
        method: 'POST',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: { ...as(cookie), 'content-type': type },
        payload: body,
      });

    it('stores one, and answers with what it decided the file is', async () => {
      const id = await makeMap('with-a-plan', []);
      const response = await upload(id, png(1200, 800));
      assert.equal(response.statusCode, 200, response.body);

      const stored = response.json<{
        mediaType: string;
        width: number;
        height: number;
        digest: string;
        bytes: number;
      }>();
      assert.equal(stored.mediaType, 'image/png');
      assert.equal(stored.width, 1200);
      assert.equal(stored.height, 800);
      assert.match(stored.digest, /^[0-9a-f]{64}$/);
      assert.equal(stored.bytes, 24);
    });

    it('does not believe the content type it was given', async () => {
      // **The whole point of sniffing.** This body is a PNG and the header says JPEG; what comes
      // back says PNG, because nothing downstream ever reads the claim.
      const id = await makeMap('mislabelled', []);
      const response = await upload(id, png(64, 64), author, 'image/jpeg');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ mediaType: string }>().mediaType, 'image/png');
    });

    it('serves the bytes back with a strong ETag and a 304 next time', async () => {
      const id = await makeMap('cached', []);
      const bytes = png(320, 240);
      await upload(id, bytes);

      const first = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: as(author),
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.headers['content-type'], 'image/png');
      assert.deepEqual(first.rawPayload, bytes);

      // Defence in depth for a file an operator supplied (`ADR-003` Decision 3).
      assert.equal(first.headers['x-content-type-options'], 'nosniff');
      assert.equal(first.headers['content-security-policy'], "default-src 'none'");

      const etag = first.headers['etag'];
      assert.ok(typeof etag === 'string' && etag.length > 2);
      const again = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: { ...as(author), 'if-none-match': etag },
      });
      assert.equal(again.statusCode, 304);
      assert.equal(again.rawPayload.length, 0, 'a 304 carries no image');
    });

    it('refuses an SVG, and says why rather than "unsupported"', async () => {
      const id = await makeMap('svg-attempt', []);
      const response = await upload(
        id,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        author,
        'image/png',
      );
      assert.equal(response.statusCode, 400);
      const error = response.json<{ error: { code: string; message: string } }>().error;
      assert.equal(error.code, 'MAP_INVALID');
      assert.match(error.message, /SVG is not accepted/);
    });

    it('needs write, not read', async () => {
      // A background is editing the canvas. Deciding who else sees the map is what `full` is for,
      // and a reader holds neither.
      const id = await makeMap('read-only-for-them', []);
      await app.inject({
        method: 'PUT',
        url: `/api/v1/maps/${String(id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });
      await upload(id, png(100, 100));

      const refused = await upload(id, png(200, 200), reader);
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'MAP_FORBIDDEN');

      // And they may still look at it, which is the half that has to keep working.
      const seen = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: as(reader),
      });
      assert.equal(seen.statusCode, 200);
    });

    it('answers 404 for a map with no background', async () => {
      const id = await makeMap('bare', []);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 404);
    });

    it('takes one off again', async () => {
      const id = await makeMap('removable', []);
      await upload(id, png(50, 50));
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: as(author),
      });
      assert.equal(removed.statusCode, 204);

      const gone = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: as(author),
      });
      assert.equal(gone.statusCode, 404);
    });

    it('refuses a body past the ceiling before it is buffered', async () => {
      // Fastify's own limit, set from the same constant the service checks. Two enforcements of
      // one number, because a limit in a single place is a limit that moves when a second caller
      // appears.
      const id = await makeMap('too-big', []);
      const response = await upload(id, Buffer.alloc(2 * 1024 * 1024 + 1));
      assert.equal(response.statusCode, 413);
    });

    it('is the only route exempt from the response-schema rule', () => {
      // The guard that would otherwise be quietly widened: `mapBackgroundRoute` is registered on
      // its own so the exemption covers the one route that answers bytes, not the eight beside it.
      assert.deepEqual(built.unfilteredRoutes, ['GET /api/v1/maps/:id/background']);
    });
  });
});
