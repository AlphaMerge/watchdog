import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { reorderSiblings } from '../src/objects/ordering.js';
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
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
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
  },
);
