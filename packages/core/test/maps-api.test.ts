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
});
