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
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
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
  /** A read-only account, and a read-scoped token `author` holds (`A-14`). */
  let watcher = '';
  let authorReadToken = '';
  let sensorId: number;
  let deletedId: number;
  /** A sensor that exists and that `author`'s group is explicitly denied (`A-15`). */
  let hiddenId: number;
  let readerGroupId: number;

  before(async () => {
    scratch = await createScratchDatabase('mapsapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
    const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
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
      maps: new MapService({
        db,
        repository: new MapRepository(),
        audit: new DatabaseAuditSink(),
        logger: silent,
      }),
      mapResolver: new MapResolver({ db, access, history }),
      // An installation that has a tile source, so the geo cases can tell "not configured" apart
      // from "configured and deliberately withheld" (`ADR-004` Decisions 1 and 4).
      mapTiles: { urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '© Somebody' },
      auth: {
        accounts,
        sessions,
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
    await accounts.create(
      {
        login: 'author',
        password: 'correct-horse-battery',
        role: 'readwrite',
      },
      testActor,
    );
    await accounts.create(
      {
        login: 'reader',
        password: 'correct-horse-battery',
        role: 'readwrite',
      },
      testActor,
    );
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
    // **A device the author may not see**, carved out with `none` (`A-15`): the other half of the
    // oracle. Without it every unavailable tile in this file is a deleted one, and a resolver that
    // told the author "deleted" on every tile would look exactly like one that told nobody.
    const walled = await harness.service.create(testActor, {
      kind: 'device',
      name: 'api-walled',
      parentId: probe.id,
      host: '10.0.0.3',
    });
    hiddenId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'api-hidden',
        parentId: walled.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'none')`,
      [walled.id, Number(authorGroup[0]?.id)],
    );

    // **A role and a token that may look and never change** (`A-14`). The token is `author`'s,
    // so the account's own role cannot be what refuses it.
    await accounts.create(
      {
        login: 'watcher',
        password: 'correct-horse-battery',
        role: 'readonly',
      },
      testActor,
    );
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login = 'watcher'`,
      [readerGroupId],
    );
    const authorId = await db.query<{ id: string }>(
      `SELECT id FROM user_account WHERE login = 'author'`,
    );
    authorReadToken = (
      await new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }).issue(
        { userId: Number(authorId[0]?.id), role: 'readwrite' },
        { name: 'maps-read', scope: 'read' },
        testActor,
      )
    ).secret;

    author = await sessionFor('author');
    reader = await sessionFor('reader');
    watcher = await sessionFor('watcher');
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

  /**
   * A map holding tiles its author could not save today (`A-22`): on an object deleted since it
   * was saved, or on one hidden from its author and stored before the save check existed. Written
   * into the row, because the service refuses both now — and the view still has to cope.
   */
  const storedMap = async (name: string, widgets: unknown[]): Promise<number> => {
    const id = await makeMap(name, []);
    await db.query(`UPDATE map SET layout = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify({ widgets }),
    ]);
    return id;
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

  it('keeps a widget whose object is gone, and does not say why — even to its author', async () => {
    const id = await storedMap('broken', [
      { id: 'w1', kind: 'status', objectId: deletedId, title: 'Was a sensor' },
    ]);
    const body = (await view(id, author)).json<{
      widgets: { state: string; title: string; reason?: string }[];
    }>();
    const tile = body.widgets[0];
    assert.ok(tile);
    assert.equal(tile.state, 'unavailable');
    assert.equal(tile.title, 'Was a sensor', 'still where the author put it');
    assert.equal(tile.reason, undefined, 'the author holds full, and full is anybody (A-15)');
  });

  it('tells the author of a map nothing that separates a deleted id from a hidden one', async () => {
    // **`A-15`'s attack, as the ticket wrote it.** `G-02` told a broken tile's reason to whoever
    // held `full` on the map, on the premise that such a person is trusted — but `full` is what a
    // map's creator gets, and anybody who may write can create one. So: put widgets on ids you
    // are curious about, open the view, and read which are deleted and which merely hidden from
    // you. Three ids here — gone, walled off, never issued — and every tile must be the same
    // document apart from its own id.
    //
    // **Since `A-22` the save refuses all three**, in the same words — so the attack now fails at
    // the first step, and asking which of the three a save refused is the oracle again unless the
    // answers agree.
    const probes = [
      { id: 'gone', kind: 'status', objectId: deletedId, title: 'probe' },
      { id: 'walled', kind: 'status', objectId: hiddenId, title: 'probe' },
      { id: 'never', kind: 'status', objectId: 9_999_999, title: 'probe' },
    ];
    const refusals: string[] = [];
    for (const widget of probes) {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/maps',
        headers: as(author),
        payload: { name: `oracle-${widget.id}`, layout: { widgets: [widget] } },
      });
      assert.equal(refused.statusCode, 403, refused.body);
      const { error } = refused.json<{ error: { code: string; message: string } }>();
      refusals.push(`${error.code}: ${error.message}`);
    }
    assert.equal(new Set(refusals).size, 1, `the refusals differ: ${refusals.join(' | ')}`);

    // **And the view still hides what a stored map names** — a map saved before the check, whose
    // tiles are all three. The save is the first line; this is the one a row from before it
    // meets.
    const id = await storedMap('oracle', probes);
    const response = await view(id, author);
    assert.equal(response.statusCode, 200, response.body);
    const tiles = response.json<{ widgets: Record<string, unknown>[] }>().widgets;
    assert.equal(tiles.length, 3);
    const shapes = tiles.map(({ id: _id, ...rest }) => JSON.stringify(rest));
    assert.equal(new Set(shapes).size, 1, `the tiles differ: ${shapes.join(' | ')}`);
    assert.equal(tiles[0]?.['state'], 'unavailable');
  });

  it('tells a reader the tile is unavailable and not why', async () => {
    // "Deleted" against "you may not see it" is an oracle for which ids are live. This case was
    // about a reader being told less than the author; since `A-15` nobody is told, and the one
    // above asserts it for the author.
    const id = await storedMap('shared', [
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

  describe('who may change a map at all (A-14)', () => {
    it('refuses a read-only account and a read-scoped token, and creates nothing', async () => {
      // **Creating had no right to check and so checked nothing.** Every other change to a map is
      // gated on a right *on that map*, and that right is capped by the role and the token; a new
      // map has no right to cap. So a read-only account — which "may look, never change" — made
      // maps, and was handed `full` on each one.
      for (const [who, headers] of [
        ['readonly', as(watcher)],
        ['read-token', { authorization: `Bearer ${authorReadToken}` }],
      ] as const) {
        const name = `not-yours-to-make-${who}`;
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/maps',
          headers,
          payload: { name },
        });
        assert.equal(response.statusCode, 403, `${who}: ${response.body}`);
        const rows = await db.query(`SELECT 1 FROM map WHERE name = $1`, [name]);
        assert.equal(rows.length, 0, `${who} created a map anyway`);
      }
    });

    it('answers 428 for an edit that carries no version, as the object API does', async () => {
      // It answered 401 `AUTH_REQUIRED` — "log in first" — to a caller who was logged in and had
      // left out a header, which is also a status the mutating sweep counts as a refusal.
      const id = await makeMap('unversioned', []);
      const missing = await app.inject({
        method: 'PATCH',
        url: `/api/v1/maps/${String(id)}`,
        headers: as(author),
        payload: { description: 'no header' },
      });
      assert.equal(missing.statusCode, 428, missing.body);
      assert.equal(
        missing.json<{ error: { code: string } }>().error.code,
        'MAP_PRECONDITION_REQUIRED',
      );

      const garbled = await app.inject({
        method: 'PATCH',
        url: `/api/v1/maps/${String(id)}`,
        headers: { ...as(author), 'if-match': 'W/"soon"' },
        payload: { description: 'bad header' },
      });
      assert.equal(garbled.statusCode, 400, garbled.body);
      assert.equal(garbled.json<{ error: { code: string } }>().error.code, 'MAP_INVALID');
    });
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

    it('shares the response-schema exemption with nothing but the other image route', () => {
      // **The guard that would otherwise be quietly widened.** Each byte-serving route is
      // registered on its own so the exemption covers it and not the routes beside it — and this
      // list is the only place that stays honest about how many there are. Two, both images.
      assert.deepEqual(built.unfilteredRoutes, [
        'GET /api/v1/maps/:id/background',
        'GET /api/v1/public/maps/:token/background',
      ]);
    });
  });

  describe('public share links', () => {
    const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

    const makeShare = async (id: number, label: string, expiresAt = inDays(7), cookie = author) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(cookie),
        payload: { label, expiresAt },
      });

    /** The whole point: no cookie, no header, nothing. */
    const open = async (token: string) =>
      app.inject({ method: 'GET', url: `/api/v1/public/maps/${token}` });

    it('opens the map for somebody with no session at all', async () => {
      const id = await makeMap('shared-publicly', [
        { id: 'w1', kind: 'status', objectId: sensorId, title: 'The sensor' },
      ]);
      const made = await makeShare(id, 'NOC wall display');
      assert.equal(made.statusCode, 201, made.body);
      const token = made.json<{ token: string }>().token;

      const response = await open(token);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{
        name: string;
        widgets: { state: string; data?: { name: string } }[];
        hasBackground: boolean;
      }>();
      assert.equal(body.name, 'shared-publicly');
      const drawn = body.widgets[0];
      assert.ok(drawn);
      assert.equal(drawn.state, 'ok');
      assert.equal(drawn.data?.name, 'api-sensor');
      assert.equal(body.hasBackground, false);
    });

    it('hands over the token once and never again', async () => {
      // Only the hash is stored, so this is a property rather than a policy: there is nothing to
      // show. It is also what keeps a database backup from being a set of working links.
      const id = await makeMap('once-only', []);
      const token = (await makeShare(id, 'once')).json<{ token: string }>().token;

      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(author),
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.body.includes(token), false, 'the token is not in the listing');
      const items = listed.json<{ items: { label: string; prefix: string }[] }>().items;
      const only = items[0];
      assert.ok(only);
      assert.equal(only.label, 'once');
      assert.ok(token.startsWith(only.prefix), 'the prefix is only a prefix');
    });

    it('records that a link has been used, so somebody can decide about it', async () => {
      // The question a person asks before revoking one is "is anything still using this?", and a
      // list of links with no answer to it is a list nobody can act on.
      const id = await makeMap('used-once', []);
      const token = (await makeShare(id, 'watched')).json<{ token: string }>().token;

      const before = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(author),
      });
      assert.equal(
        before.json<{ items: { lastUsedAt: string | null }[] }>().items[0]?.lastUsedAt,
        null,
      );

      assert.equal((await open(token)).statusCode, 200);

      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(author),
      });
      assert.notEqual(
        after.json<{ items: { lastUsedAt: string | null }[] }>().items[0]?.lastUsedAt,
        null,
      );
    });

    it('stops working the moment it is revoked', async () => {
      const id = await makeMap('revocable', []);
      const token = (await makeShare(id, 'temporary')).json<{ token: string }>().token;
      assert.equal((await open(token)).statusCode, 200);

      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(author),
      });
      const shareId = listed.json<{ items: { id: number }[] }>().items[0]?.id ?? 0;
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/maps/${String(id)}/shares/${String(shareId)}`,
        headers: as(author),
      });
      assert.equal(revoked.statusCode, 204);
      assert.equal((await open(token)).statusCode, 404);
    });

    it('refuses an expired link, in the same words as one that never existed', async () => {
      // **Deliberately indistinguishable.** Telling "expired" from "never existed" tells a
      // guesser which of their attempts was once a real link, which is the only useful signal
      // this route could give them.
      const id = await makeMap('expiring', []);
      const token = (await makeShare(id, 'brief')).json<{ token: string }>().token;
      await db.query(`UPDATE map_share SET expires_at = now() - interval '1 hour'`);

      const expired = await open(token);
      const invented = await open('this-token-was-never-issued-and-is-long-enough');
      assert.equal(expired.statusCode, 404);
      assert.equal(invented.statusCode, 404);
      assert.equal(
        expired.json<{ error: { message: string } }>().error.message,
        invented.json<{ error: { message: string } }>().error.message,
      );
    });

    it('refuses an expiry in the past, and one a lifetime away', async () => {
      const id = await makeMap('bad-expiries', []);
      const past = await makeShare(id, 'yesterday', inDays(-1));
      assert.equal(past.statusCode, 400);
      assert.match(past.json<{ error: { message: string } }>().error.message, /in the past/);

      const forever = await makeShare(id, 'forever', inDays(400));
      assert.equal(forever.statusCode, 400);
      assert.match(forever.json<{ error: { message: string } }>().error.message, /at most a year/);
    });

    it('needs full access, not write', async () => {
      // A share link is a grant to everybody, and `full` is the right that decides a map's
      // audience. Somebody who may move a widget may not publish the map to the world.
      const id = await makeMap('write-is-not-enough', []);
      await app.inject({
        method: 'PUT',
        url: `/api/v1/maps/${String(id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'write' },
      });

      const refused = await makeShare(id, 'not allowed', inDays(1), reader);
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'MAP_FORBIDDEN');

      const listing = await app.inject({
        method: 'GET',
        url: `/api/v1/maps/${String(id)}/shares`,
        headers: as(reader),
      });
      assert.equal(listing.statusCode, 403);
    });

    it('serves the background behind a shared map, and nothing else', async () => {
      const id = await makeMap('shared-with-a-plan', []);
      const png = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
      png.writeUInt32BE(13, 8);
      png.write('IHDR', 12, 'latin1');
      png.writeUInt32BE(300, 16);
      png.writeUInt32BE(200, 20);
      await app.inject({
        method: 'POST',
        url: `/api/v1/maps/${String(id)}/background`,
        headers: { ...as(author), 'content-type': 'image/png' },
        payload: png,
      });
      const token = (await makeShare(id, 'with plan')).json<{ token: string }>().token;

      assert.equal((await open(token)).json<{ hasBackground: boolean }>().hasBackground, true);
      const image = await app.inject({
        method: 'GET',
        url: `/api/v1/public/maps/${token}/background`,
      });
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.equal(image.headers['content-security-policy'], "default-src 'none'");
      assert.deepEqual(image.rawPayload, png);
    });

    it('bounds how much one link may ask for', async () => {
      // `ADR-002`'s fourth consequence. The address is bounded globally; this is the bucket that
      // notices a link posted somewhere public and hit from a thousand addresses.
      const id = await makeMap('rate-limited', []);
      const token = (await makeShare(id, 'busy')).json<{ token: string }>().token;

      let refusedAt = 0;
      for (let i = 1; i <= 70 && refusedAt === 0; i += 1) {
        if ((await open(token)).statusCode !== 200) refusedAt = i;
      }
      assert.ok(refusedAt > 0, 'the limit is reached');
      assert.ok(refusedAt <= 61, `refused at ${String(refusedAt)}, which is past the window`);
    });

    it('leaves every other route needing a session', async () => {
      // The public prefix is a namespace, not a hole: nothing outside it became reachable.
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/maps' });
      assert.equal(anonymous.statusCode, 401);
      const object = await app.inject({ method: 'GET', url: '/api/v1/objects/root' });
      assert.equal(object.statusCode, 401);
    });
  });

  /**
   * Geographical maps over the wire (`G-08`, `ADR-004`).
   *
   * The projection is arithmetic and lives in the browser; what only exists here is which of the
   * two things a viewer is handed — the map's home view, and whether this installation's tile
   * source is named to them at all.
   */
  describe('a geographical map', () => {
    const makeGeoMap = async (name: string, layout: unknown): Promise<number> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/maps',
        headers: as(author),
        payload: { name, layout },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: number }>().id;
    };

    const BERLIN = { lat: 52.52, lon: 13.405, zoom: 6 };

    it("carries the home view and the operator's tile source", async () => {
      const id = await makeGeoMap('geographical', {
        geo: BERLIN,
        widgets: [{ id: 'w1', kind: 'status', objectId: sensorId, at: { lat: 52.5, lon: 13.4 } }],
      });
      const response = await view(id, author);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{
        geo: { lat: number; lon: number; zoom: number; publicTiles: boolean } | null;
        tiles: { urlTemplate: string; attribution: string } | null;
        widgets: { at?: { lat: number; lon: number } }[];
      }>();
      assert.deepEqual(body.geo, { ...BERLIN, publicTiles: false });
      assert.equal(body.tiles?.urlTemplate, 'https://tiles.example/{z}/{x}/{y}.png');
      // The widget's own coordinate reaches the renderer, or every pin lands in the same place.
      assert.deepEqual(body.widgets[0]?.at, { lat: 52.5, lon: 13.4 });
    });

    it('is a plain canvas when the document has no `geo` at all', async () => {
      const id = await makeGeoMap('flat', { widgets: [] });
      const body = (await view(id, author)).json<{ geo: unknown; tiles: unknown }>();
      assert.equal(body.geo, null);
      // No home view, so nothing to draw tiles under — naming the provider here would be an
      // origin in the content policy and a request nobody asked for.
      assert.equal(body.tiles, null);
    });

    it('refuses a centre that is not a coordinate, rather than opening at the pole', async () => {
      // The designer treats such a document as a plain canvas, and the two readers have to agree
      // about what a document *is* — a map that is flat in the editor must not be geographical
      // in the viewer.
      const id = await makeGeoMap('typo', { geo: { lat: 200, lon: 0, zoom: 4 }, widgets: [] });
      assert.equal((await view(id, author)).json<{ geo: unknown }>().geo, null);
    });

    it('keeps the tile source off a share link until the author opts in', async () => {
      // `ADR-004` Decision 4. A stranger's browser fetching tiles tells the provider that this
      // installation exists and which places it watches, and the person who made the link cannot
      // see that happen — so the default is the quiet one.
      const quiet = await makeGeoMap('quiet', { geo: BERLIN, widgets: [] });
      const loud = await makeGeoMap('loud', {
        geo: { ...BERLIN, publicTiles: true },
        widgets: [],
      });

      const tokenFor = async (id: number): Promise<string> => {
        const made = await app.inject({
          method: 'POST',
          url: `/api/v1/maps/${String(id)}/shares`,
          headers: as(author),
          payload: {
            label: 'wall',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        });
        assert.equal(made.statusCode, 201, made.body);
        return made.json<{ token: string }>().token;
      };

      const shared = async (token: string) =>
        (await app.inject({ method: 'GET', url: `/api/v1/public/maps/${token}` })).json<{
          geo: { publicTiles: boolean } | null;
          tiles: unknown;
        }>();

      const off = await shared(await tokenFor(quiet));
      assert.equal(off.geo?.publicTiles, false, 'the map is still geographical');
      assert.equal(off.tiles, null, 'and the provider is not named to a stranger');

      const on = await shared(await tokenFor(loud));
      assert.equal(on.tiles !== null, true, 'the opt-in is what turns it on');
    });
  });
});
