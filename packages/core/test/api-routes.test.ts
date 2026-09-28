import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AuditRepository } from '../src/audit/store.js';
import { ApiServer, sensorsOfDevice } from '../src/api/server.js';
import { HistoryService } from '../src/timeseries/history.js';
import { SHARED_SCHEMAS } from '../src/api/schemas/objects.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** A recognisable byte string, so a leak is unmistakable wherever it turns up. */
const CANARY = 'SECRET-CANARY-3f9a2b';

/**
 * `credential_set.secret` is `bytea`, and `pg` hands a `Buffer` back. `JSON.stringify` renders
 * a Buffer as `{"type":"Buffer","data":[83,69,...]}` — so a route that leaked the column would
 * NOT contain the ASCII canary anywhere in its body, and a substring check on the text alone
 * would pass while the secret went out over the wire. Every leak check tests both renderings.
 */
const CANARY_BYTES = JSON.stringify([...Buffer.from(CANARY)]).slice(1, -1);

function assertNoLeak(body: string, where: string): void {
  assert.ok(!body.includes(CANARY), `the secret leaked from ${where} as text`);
  assert.ok(!body.includes(CANARY_BYTES), `the secret leaked from ${where} as a byte array`);
  assert.ok(
    !body.includes(Buffer.from(CANARY).toString('base64')),
    `the secret leaked from ${where} as base64`,
  );
  assert.ok(
    !body.includes(Buffer.from(CANARY).toString('hex')),
    `the secret leaked from ${where} as hex`,
  );
}

describe(
  'HTTP API',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let server: ApiServer;
    let app: FastifyInstance;
    let probeId: number;

    before(async () => {
      scratch = await createScratchDatabase('api');
      h = await buildHarness(scratch.db);
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
        service: h.service,
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await server.stop();
      await scratch.drop();
    });

    beforeEach(async () => {
      await scratch.db.query("DELETE FROM object WHERE kind <> 'root'");
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        payload: { kind: 'probe', parentId: h.rootId, name: 'Local probe' },
      });
      probeId = created.json<{ id: number }>().id;
    });

    // `inject` is overloaded (promise or chain); annotating the return keeps TypeScript on
    // the promise-returning one.
    const post = (
      url: string,
      payload: Record<string, unknown> = {},
    ): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url, payload });

    const get = (url: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'GET', url });

    const createGroup = async (parentId: number, name: string): Promise<number> => {
      const res = await post('/api/v1/objects', { kind: 'group', parentId, name });
      assert.equal(res.statusCode, 201, res.body);
      return res.json<{ id: number }>().id;
    };

    const createDevice = async (parentId: number, name: string, host = '10.0.0.1') => {
      const res = await post('/api/v1/objects', { kind: 'device', parentId, name, host });
      assert.equal(res.statusCode, 201, res.body);
      return res.json<{ id: number; version: number }>();
    };

    // ── shape and validation ──────────────────────────────────────────────────────────────

    it('creates an object and returns Location and ETag', async () => {
      const res = await post('/api/v1/objects', {
        kind: 'group',
        parentId: probeId,
        name: 'Datacentre',
      });

      assert.equal(res.statusCode, 201);
      const body = res.json<{ id: number; version: number; kind: string }>();
      assert.equal(body.kind, 'group');
      assert.equal(res.headers['location'], `/api/v1/objects/${String(body.id)}`);
      assert.equal(res.headers['etag'], `W/"${String(body.version)}"`);
    });

    it('rejects a body that does not match the schema, with the same envelope', async () => {
      const res = await post('/api/v1/objects', { kind: 'device', parentId: probeId, name: 'x' });

      assert.equal(res.statusCode, 400);
      const body = res.json<{
        error: {
          code: string;
          message: string;
          context: Record<string, unknown>;
          details: Record<string, unknown>;
        };
      }>();
      assert.equal(body.error.code, 'OBJECT_INVALID');
      assert.ok(Object.keys(body.error.details).length > 0, 'the failure says what was wrong');
    });

    it('rejects a group carrying a device-only field', async () => {
      const res = await post('/api/v1/objects', {
        kind: 'group',
        parentId: probeId,
        name: 'Confused',
        host: '10.0.0.1',
      });
      assert.equal(res.statusCode, 400);
    });

    it('refuses to reparent through PATCH', async () => {
      const g = await createGroup(probeId, 'Group');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(g)}`,
        headers: { 'if-match': 'W/"1"' },
        payload: { kind: 'group', parentId: probeId },
      });

      // parentId is absent from the patch schema, so this is a schema failure rather than a
      // hand-written special case in a handler.
      assert.equal(res.statusCode, 400);
    });

    it('rejects a non-integer id with 400 rather than looking up NaN', async () => {
      const res = await get('/api/v1/objects/not-a-number');
      assert.equal(res.statusCode, 400);
    });

    // ── preconditions ─────────────────────────────────────────────────────────────────────

    it('requires If-Match on PATCH and answers 428 without it', async () => {
      const g = await createGroup(probeId, 'Group');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(g)}`,
        payload: { kind: 'group', name: 'Renamed' },
      });

      assert.equal(res.statusCode, 428);
      assert.equal(
        res.json<{
          error: {
            code: string;
            message: string;
            context: Record<string, unknown>;
            details: Record<string, unknown>;
          };
        }>().error.code,
        'OBJECT_PRECONDITION_REQUIRED',
      );
    });

    it('answers 412 for a stale If-Match and leaves the object alone', async () => {
      const g = await createGroup(probeId, 'Group');
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(g)}`,
        headers: { 'if-match': 'W/"1"' },
        payload: { kind: 'group', name: 'First' },
      });
      assert.equal(ok.statusCode, 200);

      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/v1/objects/${String(g)}`,
        headers: { 'if-match': 'W/"1"' },
        payload: { kind: 'group', name: 'Second' },
      });

      assert.equal(stale.statusCode, 412);
      const body = stale.json<{
        error: {
          code: string;
          message: string;
          context: Record<string, unknown>;
          details: Record<string, unknown>;
        };
      }>();
      assert.equal(body.error.code, 'OBJECT_VERSION_CONFLICT');
      assert.equal(body.error.details['expected'], 1);
      assert.equal(body.error.details['actual'], 2);

      const after = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(g)}` });
      assert.equal(after.json<{ name: string }>().name, 'First');
    });

    it('answers 304 when If-None-Match matches', async () => {
      const g = await createGroup(probeId, 'Group');
      const first = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(g)}` });
      const etag = first.headers['etag'];

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(g)}`,
        headers: { 'if-none-match': String(etag) },
      });
      assert.equal(second.statusCode, 304);
    });

    // ── pagination ────────────────────────────────────────────────────────────────────────

    it('pages through siblings with a keyset cursor, returning each exactly once', async () => {
      for (let i = 0; i < 25; i += 1) {
        await createGroup(probeId, `group-${String(i).padStart(3, '0')}`);
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const url: string =
          `/api/v1/objects?parentId=${String(probeId)}&limit=10` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const res = await get(url);
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json<{ items: { id: number }[]; nextCursor: string | null }>();
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      assert.equal(seen.length, 25);
      assert.equal(new Set(seen).size, 25, 'no object appears twice');
    });

    it('pages correctly when sibling names are not unique', async () => {
      for (let i = 0; i < 12; i += 1) await createGroup(probeId, 'switch');

      const first = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(probeId)}&limit=5`,
      });
      const firstBody = first.json<{ items: { id: number }[]; nextCursor: string }>();
      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(probeId)}&limit=5&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      });
      const secondBody = second.json<{ items: { id: number }[] }>();

      const ids = [...firstBody.items, ...secondBody.items].map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, 'the id tiebreaker keeps the scan honest');
    });

    it('refuses a cursor minted for a different sort order', async () => {
      for (let i = 0; i < 5; i += 1) await createGroup(probeId, `g-${String(i)}`);
      const first = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(probeId)}&limit=2`,
      });
      const cursor = first.json<{ nextCursor: string }>().nextCursor;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(probeId)}&sort=id&cursor=${encodeURIComponent(cursor)}`,
      });

      // Silently restarting the scan is how a bulk operation quietly skips half the tree.
      assert.equal(res.statusCode, 400);
      assert.equal(
        res.json<{
          error: {
            code: string;
            message: string;
            context: Record<string, unknown>;
            details: Record<string, unknown>;
          };
        }>().error.code,
        'CURSOR_SORT_MISMATCH',
      );
    });

    it('is stable under concurrent inserts when paging by id', async () => {
      for (let i = 0; i < 20; i += 1) await createGroup(probeId, `stable-${String(i)}`);

      const before = await app.inject({
        method: 'GET',
        url: `/api/v1/objects?parentId=${String(probeId)}&sort=id&limit=10`,
      });
      const beforeBody = before.json<{ items: { id: number }[]; nextCursor: string }>();

      // Insert names that sort before, within and after the current cursor position.
      for (const name of ['aaa-early', 'stable-005b', 'zzz-late']) {
        await createGroup(probeId, name);
      }

      const seen = beforeBody.items.map((i) => i.id);
      let cursor: string | null = beforeBody.nextCursor;
      while (cursor !== null) {
        const res = await get(
          `/api/v1/objects?parentId=${String(probeId)}&sort=id&limit=10&cursor=${encodeURIComponent(cursor)}`,
        );
        const body = res.json<{ items: { id: number }[]; nextCursor: string | null }>();
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
      }

      assert.equal(new Set(seen).size, seen.length, 'sort=id never duplicates a row');
      assert.ok(seen.length >= 20, 'and never loses one that existed when the scan started');
    });

    // ── delete ────────────────────────────────────────────────────────────────────────────

    it('refuses a populated delete with the preview in the error body', async () => {
      const g = await createGroup(probeId, 'Berlin DC');
      const d = await createDevice(g, 'switch-01');
      await post('/api/v1/objects', {
        kind: 'sensor',
        parentId: d.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
      });

      const res = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${String(g)}` });

      assert.equal(res.statusCode, 409);
      const body = res.json<{
        error: {
          code: string;
          message: string;
          context: Record<string, unknown>;
          details: Record<string, unknown>;
        };
      }>();
      assert.equal(body.error.code, 'OBJECT_NOT_EMPTY');
      const deleted = body.error.details['deleted'] as Record<string, number>;
      assert.equal(deleted['total'], 3);
      assert.match(String(body.error.details['retryWith']), /expectedDescendants=2/);

      const retry = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(g)}?expectedDescendants=2`,
      });
      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json<{ deleted: { total: number } }>().deleted.total, 3);
    });

    // ── move ──────────────────────────────────────────────────────────────────────────────

    it('previews a move without performing it', async () => {
      const fast = await createGroup(probeId, 'Fast');
      const slow = await createGroup(probeId, 'Slow');
      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(fast)}/settings/scan.intervalSeconds`,
        payload: { value: 30 },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(slow)}/settings/scan.intervalSeconds`,
        payload: { value: 600 },
      });
      const d = await createDevice(fast, 'switch-01');

      const preview = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(d.id)}/settings?asChildOf=${String(slow)}`,
      });

      assert.equal(preview.statusCode, 200);
      const body = preview.json<{
        asChildOf: number;
        settings: { key: string; effective: { value: number } }[];
      }>();
      assert.equal(body.asChildOf, slow);
      const interval = body.settings.find((s) => s.key === 'scan.intervalSeconds');
      assert.equal(interval?.effective.value, 600, 'what it would resolve to after the move');

      // ...and the device has not moved.
      const actual = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(d.id)}` });
      assert.equal(actual.json<{ parentId: number }>().parentId, fast);
    });

    it('reports a cycle with a readable path', async () => {
      const a = await createGroup(probeId, 'Datacentre A');
      const b = await createGroup(a, 'Floor 2');

      const res = await post(`/api/v1/objects/${String(a)}/move`, { targetParentId: b });

      assert.equal(res.statusCode, 409);
      const body = res.json<{
        error: {
          code: string;
          message: string;
          context: Record<string, unknown>;
          details: Record<string, unknown>;
        };
      }>();
      assert.equal(body.error.code, 'OBJECT_CYCLE');
      const path = body.error.details['path'] as string[];
      assert.ok(path.includes('Datacentre A'));
    });

    // ── settings ──────────────────────────────────────────────────────────────────────────

    it('sets and reverts a setting, and says what is effective afterwards', async () => {
      const g = await createGroup(probeId, 'Group');
      const d = await createDevice(g, 'switch-01');

      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 300 },
      });
      const set = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(d.id)}/settings/scan.intervalSeconds`,
        payload: { value: 30 },
      });
      assert.equal(set.statusCode, 200);
      assert.deepEqual(set.json<{ own: { value: number } }>().own, { value: 30 });

      const reverted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(d.id)}/settings/scan.intervalSeconds`,
      });

      assert.equal(reverted.statusCode, 200);
      const body = reverted.json<{
        reverted: boolean;
        own: null;
        effective: { value: number; source: { kind: string } };
      }>();
      assert.equal(body.reverted, true);
      assert.equal(body.own, null, 'the local value is discarded, not remembered');
      assert.equal(body.effective.value, 300);
      assert.equal(body.effective.source.kind, 'inherited');
    });

    it('says what a revert would restore, without needing one to find out (U-09)', async () => {
      // The override toggle's whole job. A view that carried only the effective value could show
      // an operator what reverting does only by doing it.
      const g = await createGroup(probeId, 'Group');
      const d = await createDevice(g, 'switch-02');

      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 300 },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(d.id)}/settings/scan.intervalSeconds`,
        payload: { value: 30 },
      });

      const view = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(d.id)}/settings`,
      });
      const interval = view
        .json<{
          settings: {
            key: string;
            effective: { value: number; source: { kind: string } };
            inherited: { value: number; source: { kind: string; objectId?: number } };
            own: { value: number } | null;
          }[];
        }>()
        .settings.find((setting) => setting.key === 'scan.intervalSeconds');

      assert.ok(interval);
      assert.equal(interval.effective.value, 30, 'the override is what is in force');
      assert.equal(interval.effective.source.kind, 'own');
      assert.equal(interval.inherited.value, 300, 'and 300 is what reverting would restore');
      assert.equal(interval.inherited.source.objectId, g, 'named, so the UI can link to it');
      assert.deepEqual(interval.own, { value: 30 });
    });

    it('reports the registry default as what a revert restores at the root', async () => {
      const view = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(h.rootId)}/settings`,
      });
      assert.equal(view.statusCode, 200);
      const interval = view
        .json<{
          settings: { key: string; inherited: { value: number; source: { kind: string } } }[];
        }>()
        .settings.find((setting) => setting.key === 'scan.intervalSeconds');
      assert.ok(interval);
      // The root has no parent to inherit from, and falling through to the default is the honest
      // answer rather than repeating the root's own value back at it.
      assert.equal(interval.inherited.source.kind, 'default');
      assert.equal(interval.inherited.value, 60);
    });

    it('keeps an override pinned to the same value the parent has as an override', async () => {
      // The state that must not collapse: `own: { value: 300 }` under a parent that also says
      // 300 is a deliberate pin, and when the parent moves to 30 this object stays at 300.
      // Comparing values instead of reading `own` would turn it silently into a follower.
      const g = await createGroup(probeId, 'Group');
      const d = await createDevice(g, 'switch-03');
      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 300 },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(d.id)}/settings/scan.intervalSeconds`,
        payload: { value: 300 },
      });

      const read = async () => {
        const view = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(d.id)}/settings`,
        });
        const found = view
          .json<{
            settings: {
              key: string;
              effective: { value: number };
              inherited: { value: number };
              own: { value: number } | null;
            }[];
          }>()
          .settings.find((setting) => setting.key === 'scan.intervalSeconds');
        assert.ok(found);
        return found;
      };

      const pinned = await read();
      assert.deepEqual(pinned.own, { value: 300 }, 'an override, even at the same number');
      assert.equal(pinned.inherited.value, 300);

      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 30 },
      });
      const after = await read();
      assert.equal(after.effective.value, 300, 'the pin held when the parent moved');
      assert.equal(after.inherited.value, 30, 'and reverting would now restore 30');
    });

    it('rejects a value that fails the setting schema', async () => {
      const g = await createGroup(probeId, 'Group');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 0 },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects an unknown setting key', async () => {
      const g = await createGroup(probeId, 'Group');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSecond`,
        payload: { value: 60 },
      });
      assert.equal(res.statusCode, 400);
    });

    // ── credentials ───────────────────────────────────────────────────────────────────────

    describe('credential non-disclosure', () => {
      it('no response schema declares a field a secret could occupy', () => {
        const forbidden = [
          'secret',
          'password',
          'passhash',
          'privKey',
          'privateKey',
          'community',
          'keyId',
          'passphrase',
        ];
        const walk = (node: unknown, path: string): void => {
          if (Array.isArray(node)) {
            node.forEach((item, i) => {
              walk(item, `${path}[${String(i)}]`);
            });
            return;
          }
          if (typeof node !== 'object' || node === null) return;
          for (const [key, value] of Object.entries(node)) {
            assert.ok(
              !forbidden.includes(key),
              `schema ${path} declares a forbidden property "${key}"`,
            );
            walk(value, `${path}.${key}`);
          }
        };
        // Walk the whole schema, not just `properties`: ms:settingSource is a bare `oneOf`
        // with no top-level properties at all, so a properties-only walk never looked at it.
        for (const schema of SHARED_SCHEMAS) {
          walk(schema, (schema as { $id: string }).$id);
        }
      });

      it('returns credential metadata but never the secret, on every read path', async () => {
        const g = await createGroup(probeId, 'Group');
        const d = await createDevice(g, 'switch-01');
        const s = await post('/api/v1/objects', {
          kind: 'sensor',
          parentId: d.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        });
        const sensorId = s.json<{ id: number }>().id;

        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{"version":"v2c"}'::jsonb, $2, 'key-1')`,
          [g, Buffer.from(CANARY)],
        );

        const urls = [
          '/api/v1/objects',
          '/api/v1/objects/root',
          `/api/v1/objects/${String(g)}`,
          `/api/v1/objects/${String(g)}?include=settings,channels,credentials,ancestors`,
          `/api/v1/objects/${String(d.id)}?include=credentials`,
          `/api/v1/objects/${String(sensorId)}?include=channels,credentials`,
          `/api/v1/objects/${String(g)}/tree`,
          `/api/v1/objects/${String(g)}/counts`,
          `/api/v1/objects/${String(d.id)}/ancestors`,
          `/api/v1/objects/${String(sensorId)}/channels`,
          `/api/v1/objects/${String(d.id)}/settings`,
          `/api/v1/objects/${String(d.id)}/credentials`,
          `/api/v1/objects/${String(d.id)}/credentials?effective=false`,
          '/api/v1/setting-definitions',
          '/api/v1/openapi.json',
        ];

        let sawPublicParams = false;
        for (const url of urls) {
          const res = await app.inject({ method: 'GET', url });
          assertNoLeak(res.body, url);
          if (res.body.includes('"v2c"')) sawPublicParams = true;
        }

        // ...and the test is not passing vacuously: the public half does come back.
        assert.ok(sawPublicParams, 'publicParams should be visible, or this test proves nothing');

        // Mutation responses and error bodies too.
        const cloned = await post(`/api/v1/objects/${String(g)}/clone`, {});
        assertNoLeak(cloned.body, 'POST /clone');
        const moved = await post(`/api/v1/objects/${String(d.id)}/move`, {
          targetParentId: probeId,
        });
        assertNoLeak(moved.body, 'POST /move');
        const failed = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${String(g)}` });
        assertNoLeak(failed.body, 'the 409 delete-refusal body');
      });

      /**
       * A device template must not carry a secret out (`P-56`).
       *
       * `POST /objects/:id/as-template` is built from `sensorsOfDevice`, which reads
       * `sensor_config.params` with raw SQL to get the *stored* settings a template has to carry
       * forward — deliberately going around `ObjectService.#redact`. Its comment justified that by
       * asserting credentials never appear in `params`. Two shipped types disprove it:
       * `exe.script`'s `secret`, and every SNMP type's `community`, `authKey` and `privKey`, are
       * `writeOnly` entries in their own `paramsSchema` and live in that column.
       *
       * The route's response schema is `additionalProperties: true`, so the serialiser filtered
       * nothing either, and the sweep above never covered it because that sweep is a
       * hand-maintained list of URLs.
       */
      it('builds a device template without the writeOnly parameters', async () => {
        const g = await createGroup(probeId, 'Group');
        const d = await createDevice(g, 'switch-01');
        const sensor = await post('/api/v1/objects', {
          kind: 'sensor',
          parentId: d.id,
          name: 'Traffic',
          sensorType: 'snmp.traffic',
          params: { community: CANARY, port: 161 },
        });
        assert.equal(sensor.statusCode, 201, sensor.body);

        const sensors = await sensorsOfDevice(scratch.db, testCatalogue(), d.id);
        assert.equal(sensors.length, 1, 'the sensor is in the template');

        const body = JSON.stringify(sensors);
        assertNoLeak(body, 'sensorsOfDevice, which feeds POST /objects/:id/as-template');

        // ...and not by returning nothing: a template with no settings carries nothing forward,
        // which would pass a leak check while making the feature useless.
        assert.equal(sensors[0]?.params['port'], 161, 'the public settings still travel');
      });

      it('reports where a credential is inherited from, without its value', async () => {
        const g = await createGroup(probeId, 'Group');
        const d = await createDevice(g, 'switch-01');
        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{"version":"v2c"}'::jsonb, $2, 'key-1')`,
          [g, Buffer.from(CANARY)],
        );

        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(d.id)}/credentials`,
        });

        assert.equal(res.statusCode, 200);
        const body = res.json<{
          items: { kind: string; publicParams: Record<string, string>; source: { kind: string } }[];
        }>();
        assert.equal(body.items.length, 1);
        const credential = body.items[0];
        assert.ok(credential !== undefined);
        assert.equal(credential.kind, 'snmp');
        assert.equal(credential.publicParams['version'], 'v2c');
        assert.equal(credential.source.kind, 'inherited');
      });
    });

    // ── OpenAPI ───────────────────────────────────────────────────────────────────────────

    it('generates an OpenAPI document covering every route', async () => {
      const res = await get('/api/v1/openapi.json');
      assert.equal(res.statusCode, 200);

      const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
      assert.match(doc.openapi, /^3\./);
      for (const path of [
        '/api/v1/objects',
        '/api/v1/objects/{id}',
        '/api/v1/objects/{id}/move',
        '/api/v1/objects/{id}/clone',
        '/api/v1/objects/{id}/tree',
        '/api/v1/objects/{id}/counts',
        '/api/v1/objects/{id}/settings',
        '/api/v1/objects/{id}/credentials',
        '/api/v1/setting-definitions',
      ]) {
        assert.ok(path in doc.paths, `${path} is missing from the OpenAPI document`);
      }
    });

    it('documents the pagination caveat that D-09 depends on', async () => {
      const res = await get('/api/v1/openapi.json');
      const doc = res.json<{ paths: Record<string, { get?: { description?: string } }> }>();
      const description = doc.paths['/api/v1/objects']?.get?.description ?? '';
      assert.match(description, /sort=id/, 'anything that must be exact has to be told to use it');
    });

    it('refuses to serve a route that declares no response schema', async () => {
      // The guard is the structural half of the credential defence: an undeclared 2xx body is
      // not filtered by fast-json-stringify, so it returns whatever the handler produced. A
      // guard that has never been seen to fire is not a guard.
      const rogue = new ApiServer({
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
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      rogue.app.get('/leaky', () => ({ secret: 'anything at all' }));

      await assert.rejects(
        () => rogue.build('9.9.9', h.service),
        /no response schema/,
        'a route with no response schema must stop the server from starting',
      );
    });

    it('answers a malformed JSON body with 400, not 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        headers: { 'content-type': 'application/json' },
        payload: '{"kind":"group",',
      });

      assert.equal(res.statusCode, 400);
      const body = res.json<{ error: { code: string } }>();
      assert.notEqual(body.error.code, 'INTERNAL_ERROR');
    });

    it('does not put the database DSN or the failing statement in an error body', async () => {
      // DatabaseError.context carries the statement and host:port/database. That is
      // reconnaissance for anyone who can reach the API, so a 500 says only that it failed.
      const res = await get('/api/v1/objects?parentId=999999999');
      assert.equal(res.statusCode, 200, 'a missing parent is an empty page, not an error');

      const notFound = await get('/api/v1/objects/999999999');
      assert.equal(notFound.statusCode, 404);
      assert.ok(!notFound.body.includes('postgres'), 'no host in the body');
      assert.ok(!notFound.body.includes('SELECT'), 'no SQL in the body');
    });

    it('rejects an id beyond the safe integer range with 400', async () => {
      const res = await get('/api/v1/objects/99999999999999999999');
      assert.equal(res.statusCode, 400);
      assert.ok(!res.body.includes('SELECT'));
    });

    it('rejects an unknown kind filter with 400 rather than a database cast failure', async () => {
      const res = await get('/api/v1/objects?kind=widget');
      assert.equal(res.statusCode, 400);
      const body = res.json<{ error: { code: string } }>();
      assert.equal(body.error.code, 'OBJECT_INVALID');
    });

    it('takes a repeated kind filter, which the handler has always expected', async () => {
      // The schema used to put an `enum` beside `items`, and an enum is checked against the
      // *whole* value — so the array Fastify builds from two occurrences failed validation and
      // `?kind=a&kind=b` was a 400, while the service behind it had a passing test for exactly
      // that filter. Found while building `M-15`'s state and cause filters.
      const one = await get('/api/v1/objects?kind=device&limit=5');
      assert.equal(one.statusCode, 200);
      const several = await get('/api/v1/objects?kind=device&kind=sensor&limit=5');
      assert.equal(several.statusCode, 200, several.body);
      const kinds = new Set(
        several.json<{ items: { kind: string }[] }>().items.map((item) => item.kind),
      );
      assert.ok([...kinds].every((kind) => kind === 'device' || kind === 'sensor'));

      // And one bad value in a repeat is still refused.
      const bad = await get('/api/v1/objects?kind=device&kind=widget');
      assert.equal(bad.statusCode, 400);
    });

    it('finds a device by a fragment of its host through ?q=, as the tree search asks', async () => {
      // `P-212`. `TreeView`'s search box says "Search names and hosts" and sends `q` and nothing
      // else, with `limit=200` — so this is its request, and `q` used to match names alone.
      const g = await createGroup(probeId, 'Edge');
      const router = await createDevice(g, 'core-router', 'rtr1.Berlin.example.net');
      const access = await createDevice(g, 'access-switch', '10.20.30.40');

      const ids = async (url: string): Promise<number[]> => {
        const res = await get(url);
        assert.equal(res.statusCode, 200, res.body);
        return res.json<{ items: { id: number }[] }>().items.map((item) => item.id);
      };

      // A hostname fragment in the other case from the stored one.
      assert.deepEqual(await ids('/api/v1/objects?q=berlin.EXAMPLE&limit=200'), [router.id]);
      // An address fragment, which is what somebody looking for a device usually has.
      assert.deepEqual(await ids('/api/v1/objects?q=20.30&limit=200'), [access.id]);
      // Names still match, as they always did.
      assert.deepEqual(await ids('/api/v1/objects?q=ROUTER&limit=200'), [router.id]);

      // `host` stays the exact lookup it was: a fragment is not a host.
      assert.deepEqual(await ids('/api/v1/objects?host=20.30'), []);
      assert.deepEqual(await ids('/api/v1/objects?host=10.20.30.40'), [access.id]);
    });

    it('gives each search result its path through ?include=path, as the tree search asks', async () => {
      // `P-214`. `TreeView` sends `include=path` and writes each match's path under it, so two
      // sensors both called `Ping` say which device each is on. Through the route rather than
      // the service, because `ms:objectSummary` is `additionalProperties: false`: a path the
      // schema did not declare would be dropped by the serialiser with a 200.
      const berlin = await createGroup(probeId, 'Berlin DC');
      const munich = await createGroup(probeId, 'Munich DC');
      const inBerlin = await createDevice(berlin, 'switch-01');
      const inMunich = await createDevice(munich, 'switch-02');
      for (const parentId of [inBerlin.id, inMunich.id]) {
        const res = await post('/api/v1/objects', {
          kind: 'sensor',
          parentId,
          name: 'Ping',
          sensorType: 'icmp.ping',
        });
        assert.equal(res.statusCode, 201, res.body);
      }

      const res = await get('/api/v1/objects?q=Ping&kind=sensor&limit=200&include=path');
      assert.equal(res.statusCode, 200, res.body);
      const items = res.json<{
        items: { name: string; path?: { id: number; kind: string; name: string }[] }[];
      }>().items;

      assert.deepEqual(
        items.map((item) => item.path?.map((ancestor) => ancestor.name)).sort(),
        [
          ['Root', 'Local probe', 'Berlin DC', 'switch-01'],
          ['Root', 'Local probe', 'Munich DC', 'switch-02'],
        ].sort(),
      );
      assert.deepEqual(
        items[0]?.path?.slice(0, 2),
        [
          { id: h.rootId, kind: 'root', name: 'Root' },
          { id: probeId, kind: 'probe', name: 'Local probe' },
        ],
        'each step is a reference the UI can link, not just a name',
      );

      // Opt-in: without it, the listing is the listing it always was.
      const plain = await get('/api/v1/objects?q=Ping&kind=sensor&limit=200');
      assert.equal(plain.statusCode, 200);
      assert.ok(
        plain.json<{ items: Record<string, unknown>[] }>().items.every((item) => !('path' in item)),
      );
    });

    it('refuses an include token the listing does not have', async () => {
      // `ancestors` is the detail route's word for the same chain. Taking it here as well would
      // make two names for one thing on one resource, so a listing that asks for it is told.
      const res = await get('/api/v1/objects?include=ancestors');
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'OBJECT_INVALID');
    });

    it('rejects a cursor whose id is not a usable position', async () => {
      const hostile = Buffer.from(
        JSON.stringify({ v: 1, sort: 'name', name: 'x', id: 1e308 }),
        'utf8',
      ).toString('base64url');

      const res = await get(`/api/v1/objects?cursor=${encodeURIComponent(hostile)}`);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'CURSOR_INVALID');
    });

    it('does not answer 304 for a response that carries inherited content', async () => {
      // The ETag is this object's version, but ?include=settings renders values inherited from
      // ancestors, whose changes do not bump it. A 304 there would hide a changed scan interval
      // — or a revoked credential — from a client doing exactly what the protocol says.
      const g = await createGroup(probeId, 'Parent');
      const d = await createDevice(g, 'switch-01');

      const first = await get(`/api/v1/objects/${String(d.id)}?include=settings`);
      const etag = String(first.headers['etag']);

      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 300 },
      });

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(d.id)}?include=settings`,
        headers: { 'if-none-match': etag },
      });

      assert.equal(second.statusCode, 200, 'the inherited value changed, so this is not a 304');
      const body = second.json<{ settings: { key: string; effective: { value: number } }[] }>();
      const interval = body.settings.find((x) => x.key === 'scan.intervalSeconds');
      assert.equal(interval?.effective.value, 300);
    });

    // ── end to end ────────────────────────────────────────────────────────────────────────

    it('walks the whole operator journey', async () => {
      const g = await createGroup(probeId, 'Berlin DC');
      const d = await createDevice(g, 'switch-01');
      const sensorRes = await post('/api/v1/objects', {
        kind: 'sensor',
        parentId: d.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
      });
      assert.equal(sensorRes.statusCode, 201);

      const tree = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(g)}/tree?maxDepth=5`,
      });
      assert.equal(tree.json<{ items: unknown[] }>().items.length, 3);

      await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(g)}/settings/scan.intervalSeconds`,
        payload: { value: 120 },
      });

      const other = await createGroup(probeId, 'Munich DC');
      const moved = await post(`/api/v1/objects/${String(d.id)}/move`, { targetParentId: other });
      assert.equal(moved.statusCode, 200);
      const moveBody = moved.json<{ settingsChanged: { key: string }[]; movedCount: number }>();
      assert.equal(moveBody.movedCount, 2);
      assert.equal(moveBody.settingsChanged[0]?.key, 'scan.intervalSeconds');

      const clone = await post(`/api/v1/objects/${String(other)}/clone`, {});
      assert.equal(clone.statusCode, 201);
      const cloneId = clone.json<{ object: { id: number } }>().object.id;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(cloneId)}?expectedDescendants=2`,
      });
      assert.equal(del.statusCode, 200);
    });
  },
);
