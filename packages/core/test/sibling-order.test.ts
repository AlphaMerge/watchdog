import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { reorderAmong, reorderSiblings } from '../src/objects/ordering.js';
import { ObjectRepository } from '../src/objects/repository.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** The off-by-ones, without a database in the way. */
describe('sibling reordering', () => {
  const list = [1, 2, 3, 4, 5];

  it('moves an item one place up or down', () => {
    assert.deepEqual(reorderSiblings(list, 3, 'up')?.next, [1, 3, 2, 4, 5]);
    assert.deepEqual(reorderSiblings(list, 3, 'down')?.next, [1, 2, 4, 3, 5]);
  });

  it('moves an item to either end', () => {
    assert.deepEqual(reorderSiblings(list, 4, 'first')?.next, [4, 1, 2, 3, 5]);
    assert.deepEqual(reorderSiblings(list, 2, 'last')?.next, [1, 3, 4, 5, 2]);
  });

  it('reports the positions it moved between', () => {
    const change = reorderSiblings(list, 2, 'last');
    assert.ok(change);
    assert.equal(change.from, 1);
    assert.equal(change.to, 4);
  });

  it('does nothing at the ends, rather than failing', () => {
    // Someone holding the up arrow on the first item is not making a mistake, and an error here
    // would turn a UI's optimistic update into a spurious failure.
    assert.equal(reorderSiblings(list, 1, 'up'), null);
    assert.equal(reorderSiblings(list, 5, 'down'), null);
    assert.equal(reorderSiblings(list, 1, 'first'), null);
    assert.equal(reorderSiblings(list, 5, 'last'), null);
  });

  it('does nothing for an object that is not among them', () => {
    assert.equal(reorderSiblings(list, 99, 'up'), null);
  });

  it('moves among only the siblings it is shown, leaving every other at its index (A-46)', () => {
    const seen = new Set([1, 3, 5]);
    // "Up" passes the nearest one shown; 2 and 4 keep their places.
    assert.deepEqual(reorderAmong(list, seen, 5, 'up'), { next: [1, 2, 5, 4, 3], from: 4, to: 2 });
    assert.deepEqual(reorderAmong(list, seen, 1, 'down')?.next, [3, 2, 1, 4, 5]);
    assert.deepEqual(reorderAmong(list, seen, 5, 'first')?.next, [5, 2, 1, 4, 3]);
    assert.deepEqual(reorderAmong(list, seen, 1, 'last')?.next, [3, 2, 5, 4, 1]);
  });

  it('stops at the first and last places it is shown, whatever is beyond them (A-46)', () => {
    const seen = new Set([2, 3, 4]);
    assert.equal(reorderAmong(list, seen, 2, 'up'), null);
    assert.equal(reorderAmong(list, seen, 2, 'first'), null);
    assert.equal(reorderAmong(list, seen, 4, 'down'), null);
    assert.equal(reorderAmong(list, seen, 4, 'last'), null);
    // Nor does it move one it is not shown.
    assert.equal(reorderAmong(list, seen, 1, 'down'), null);
  });

  it('is the plain move for a caller shown them all', () => {
    for (const move of ['up', 'down', 'first', 'last'] as const) {
      assert.deepEqual(reorderAmong(list, null, 3, move), reorderSiblings(list, 3, move));
      assert.deepEqual(reorderAmong(list, new Set(list), 3, move), reorderSiblings(list, 3, move));
    }
  });
});

describe(
  'manual sibling order',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let groupId: number;
    let ids: Record<string, number>;

    before(async () => {
      scratch = await createScratchDatabase('siblings');
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

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probe.id,
        name: 'ordered-group',
      });
      groupId = group.id;

      ids = {};
      for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
        const child = await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name,
          host: `192.0.2.${String(Object.keys(ids).length + 1)}`,
        });
        ids[name] = child.id;
      }
      // The harness captures mutations rather than writing them; each test wants a clean slate.
      h.audit.recorded.length = 0;
    });

    async function children(sort = 'manual', limit = 100): Promise<string[]> {
      const names: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/objects',
          query: {
            parentId: String(groupId),
            sort,
            limit: String(limit),
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json<{ items: { name: string }[]; nextCursor: string | null }>();
        names.push(...page.items.map((item) => item.name));
        if (page.nextCursor === null) return names;
        cursor = page.nextCursor;
      }
    }

    async function reorder(name: string, move: string, headers: Record<string, string> = {}) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(ids[name] ?? 0)}/order`,
        headers,
        payload: { move },
      });
    }

    // ---------------------------------------------------------------------------------------
    // Before anyone arranges anything.
    // ---------------------------------------------------------------------------------------

    it('reads exactly as it did before the column existed', async () => {
      assert.deepEqual(await children(), ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    });

    // ---------------------------------------------------------------------------------------
    // Arranging.
    // ---------------------------------------------------------------------------------------

    it('moves a child up, down and to either end', async () => {
      assert.equal((await reorder('delta', 'first')).statusCode, 200);
      assert.deepEqual(await children(), ['delta', 'alpha', 'bravo', 'charlie', 'echo']);

      assert.equal((await reorder('alpha', 'last')).statusCode, 200);
      assert.deepEqual(await children(), ['delta', 'bravo', 'charlie', 'echo', 'alpha']);

      assert.equal((await reorder('echo', 'up')).statusCode, 200);
      assert.deepEqual(await children(), ['delta', 'bravo', 'echo', 'charlie', 'alpha']);

      assert.equal((await reorder('delta', 'down')).statusCode, 200);
      assert.deepEqual(await children(), ['bravo', 'delta', 'echo', 'charlie', 'alpha']);
    });

    it('leaves name order alone', async () => {
      await reorder('echo', 'first');
      assert.deepEqual(
        await children('name'),
        ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
        'the other sorts are not opinions about the arrangement',
      );
    });

    it('shows the arrangement in the tree, which is what an operator looks at', async () => {
      await reorder('echo', 'first');
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(groupId)}/tree`,
        query: { maxDepth: '1' },
      });
      assert.equal(response.statusCode, 200);
      const items = response.json<{ items: { name: string; depth: number }[] }>().items;
      assert.deepEqual(
        items.filter((item) => item.depth === 1).map((item) => item.name),
        ['echo', 'alpha', 'bravo', 'charlie', 'delta'],
      );
    });

    // ---------------------------------------------------------------------------------------
    // The cursor branch.
    // ---------------------------------------------------------------------------------------

    it('pages across the boundary between arranged and unarranged siblings', async () => {
      // A child created after an arrangement has no position of its own — which is the only way
      // a parent ends up with both kinds, and the case the keyset predicate has a branch for.
      await reorder('charlie', 'first');
      const late = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'foxtrot',
        host: '192.0.2.99',
      });
      ids['foxtrot'] = late.id;

      const expected = ['charlie', 'alpha', 'bravo', 'delta', 'echo', 'foxtrot'];
      assert.deepEqual(await children('manual', 100), expected);
      // Two at a time, so every page boundary falls somewhere different — including on the
      // null boundary itself.
      assert.deepEqual(await children('manual', 2), expected, 'and paging changes nothing');
      assert.deepEqual(await children('manual', 1), expected);
    });

    it('refuses a manual sort with no parent to be manual within', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/objects',
        query: { sort: 'manual', limit: '10' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'OBJECT_INVALID');
    });

    it('refuses a cursor minted for a different sort', async () => {
      const first = await app.inject({
        method: 'GET',
        url: '/api/v1/objects',
        query: { parentId: String(groupId), sort: 'name', limit: '2' },
      });
      const cursor = first.json<{ nextCursor: string }>().nextCursor;

      const second = await app.inject({
        method: 'GET',
        url: '/api/v1/objects',
        query: { parentId: String(groupId), sort: 'manual', limit: '2', cursor },
      });
      assert.equal(second.statusCode, 400);
      assert.equal(second.json<{ error: { code: string } }>().error.code, 'CURSOR_SORT_MISMATCH');
    });

    // ---------------------------------------------------------------------------------------
    // Edges.
    // ---------------------------------------------------------------------------------------

    it('treats a move that changes nothing as a no-op', async () => {
      const before = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(ids['alpha'] ?? 0)}`,
      });
      const version = before.json<{ version: number }>().version;

      const response = await reorder('alpha', 'up');
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<{ version: number }>().version, version, 'no version bump');

      assert.deepEqual(h.audit.recorded, [], 'and nothing to read in the history tab');
    });

    it('refuses to order the root, which has no siblings', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(h.rootId)}/order`,
        payload: { move: 'up' },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'OBJECT_NOT_MOVABLE');
    });

    it('honours If-Match', async () => {
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(ids['delta'] ?? 0)}`,
      });
      const etag = read.headers['etag'] as string;

      await h.service.update(
        testActor,
        ids['delta'] ?? 0,
        { kind: 'device', name: 'delta-renamed' },
        { kind: 'none' },
      );

      const stale = await reorder('delta', 'first', { 'if-match': etag });
      assert.equal(stale.statusCode, 412);
    });

    it('bumps only the siblings that actually moved', async () => {
      const versions = async (): Promise<Record<string, number>> => {
        const rows = await db.query<{ name: string; version: number }>(
          'SELECT name, version FROM object WHERE parent_id = $1',
          [groupId],
        );
        return Object.fromEntries(rows.map((row) => [row.name, row.version]));
      };

      // The first arrangement in a group legitimately touches every child: each goes from "no
      // opinion" to a position. It is the second one that should be cheap.
      await reorder('alpha', 'last');
      const before = await versions();

      // Swapping the last two touches two rows. Rewriting all five positions would bump three
      // versions for nothing, and each of those is a cache someone has to refill.
      await reorder('alpha', 'up');
      const afterwards = await versions();

      const changed = Object.keys(before)
        .filter((name) => before[name] !== afterwards[name])
        .sort();
      assert.deepEqual(changed, ['alpha', 'echo']);
    });

    it('records the move, with the positions it moved between', async () => {
      await reorder('echo', 'first');
      assert.deepEqual(h.audit.recorded, [
        {
          action: 'object.reordered',
          objectId: ids['echo'],
          kind: 'device',
          parentId: groupId,
          move: 'first',
          fromIndex: 4,
          toIndex: 0,
        },
      ]);
    });

    interface Place {
      version: number;
      sort_order: number | null;
      updated_at: Date;
    }
    const placeOf = async (q: Queryable, name: string): Promise<Place> => {
      const [row] = await q.query<Place>(
        'SELECT version, sort_order, updated_at FROM object WHERE id = $1',
        [ids[name] ?? 0],
      );
      return row ?? assert.fail(`no ${name}`);
    };

    it('writes a sibling’s place quietly when told it is unseen, and bumps whatever comes after (A-46)', async () => {
      // Nobody has arranged the group: every place is NULL.
      const repository = new ObjectRepository();
      const order = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name) => ids[name] ?? 0);
      const bravo = await placeOf(db, 'bravo');
      const alpha = await placeOf(db, 'alpha');
      await db.tx(async (q) => {
        await repository.writeSiblingOrder(q, groupId, order, new Set([ids['bravo'] ?? 0]));
        const quiet = await placeOf(q, 'bravo');
        assert.equal(quiet.sort_order, 1);
        assert.equal(quiet.version, bravo.version);
        assert.deepEqual(quiet.updated_at, bravo.updated_at);
        // The others are written after it, in the same transaction, and bumped.
        assert.equal((await placeOf(q, 'alpha')).version, alpha.version + 1);

        // **Cleared straight after**: a write later in the same transaction bumps, even of the
        // row that was spared and even when it is only a place.
        await q.query('UPDATE object SET sort_order = 7 WHERE id = $1', [ids['bravo'] ?? 0]);
        assert.equal((await placeOf(q, 'bravo')).version, bravo.version + 1);
      });
    });

    it('spares a change of place and nothing else, and only in the transaction that asks (A-46)', async () => {
      const bravo = ids['bravo'] ?? 0;
      /** How far one UPDATE moved bravo's version. */
      const step = async (q: Queryable, set: string): Promise<number> => {
        const before = await placeOf(q, 'bravo');
        await q.query(`UPDATE object SET ${set} WHERE id = $1`, [bravo]);
        return (await placeOf(q, 'bravo')).version - before.version;
      };
      await db.tx(async (q) => {
        await q.query(`SELECT set_config('ms.sibling_order_only', 'on', true)`);
        const before = await placeOf(q, 'bravo');
        assert.equal(await step(q, 'sort_order = 4'), 0);
        assert.equal(await step(q, 'sort_order = NULL'), 0, 'back to no place');
        assert.deepEqual((await placeOf(q, 'bravo')).updated_at, before.updated_at, 'its time');
        assert.equal(await step(q, `sort_order = 5, name = 'bravo-2'`), 1, 'a rename with it');
        assert.equal(await step(q, `name = 'bravo-3'`), 1, 'a rename alone');
        assert.equal(await step(q, 'sort_order = sort_order'), 1, 'no change at all');
      });
      // Transaction-local: the next one has not asked.
      assert.equal(await step(db, 'sort_order = 6'), 1);
    });
  },
);
