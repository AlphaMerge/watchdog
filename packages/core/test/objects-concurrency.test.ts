import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { ObjectError } from '../src/objects/errors.js';
import type { ObjectId } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** Resolves only when the test says so, so one transaction can be held open deliberately. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** True when `promise` has not settled within `ms` — i.e. it is genuinely blocked. */
async function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('pending');
  const timer = new Promise<typeof marker>((resolve) => {
    setTimeout(() => {
      resolve(marker);
    }, ms).unref();
  });
  return (
    (await Promise.race([
      promise.then(
        () => null,
        () => null,
      ),
      timer,
    ])) === marker
  );
}

/**
 * The advisory lock, under test.
 *
 * Both of these pass trivially if you only look at single-threaded behaviour, and both fail if
 * the lock is removed — which is the point. Migration 001's cycle trigger is not sufficient on
 * its own: under READ COMMITTED it cannot see another transaction's uncommitted `parent_id`.
 */
describe(
  'structural concurrency',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let probeId: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('objconc');
      h = await buildHarness(scratch.db);
    });

    after(async () => {
      await scratch.drop();
    });

    const freshProbe = async (): Promise<ObjectId> => {
      await scratch.db.query("DELETE FROM object WHERE kind <> 'root'");
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      return probe.id;
    };

    it('serialises two moves that would together create a cycle', async () => {
      probeId = await freshProbe();
      const a = (await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'A' }))
        .id;
      const b = (await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'B' }))
        .id;

      const gate = deferred();

      // Client 1 takes the exclusive lock, moves A under B, and holds the transaction open.
      const client1 = h.service.batch('exclusive', async (q, repo) => {
        await repo.reparent(q, a, b, { kind: 'none' });
        await gate.promise;
        return 'committed';
      });

      // Give client 1 time to take the lock before client 2 tries.
      await new Promise<void>((resolve) => setTimeout(resolve, 100).unref());

      // Client 2 attempts the mirror move. Without the lock its cycle pre-check reads the
      // pre-move tree, sees nothing wrong, and commits — leaving A and B pointing at each
      // other, unreachable from the root and impossible to delete.
      const client2 = h.service.move(testActor, b, a, { kind: 'none' });

      assert.equal(
        await stillPending(client2, 300),
        true,
        'client 2 must block on the tree lock, not race past its pre-check',
      );

      gate.release();
      await client1;

      const error = await client2.then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(error instanceof ObjectError);
      assert.equal(error.code, 'OBJECT_CYCLE');

      // And the tree is still walkable: every object reaches the root.
      const orphans = await scratch.db.query<{ count: string }>(`
        WITH RECURSIVE reachable AS (
          SELECT id FROM object WHERE kind = 'root'
          UNION ALL
          SELECT c.id FROM object c JOIN reachable ON c.parent_id = reachable.id
        )
        SELECT count(*) AS count FROM object WHERE id NOT IN (SELECT id FROM reachable)
      `);
      assert.equal(orphans[0]?.count, '0', 'no unreachable subtree was created');
    });

    it('never returns a delete receipt that undercounts what it destroyed', async () => {
      probeId = await freshProbe();
      const g = (
        await h.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'Berlin DC',
        })
      ).id;
      const d = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: g,
          name: 'switch-01',
          host: '10.0.0.1',
        })
      ).id;

      const gate = deferred();

      // Client 1 creates a sensor inside the target subtree and holds it open, under the
      // shared lock that `create` takes.
      const client1 = h.service.batch('shared', async (q, repo) => {
        await repo.insert(q, {
          kind: 'sensor',
          parentId: d,
          name: 'Late arrival',
          sensorType: 'icmp.ping',
        });
        await gate.promise;
        return 'committed';
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100).unref());

      // The operator counted 1 descendant. Without the shared/exclusive pairing, the delete
      // enumerates before the sensor commits, destroys it via the FK cascade anyway, and hands
      // back a receipt that never mentions it.
      const client2 = h.service.delete(
        testActor,
        g,
        { kind: 'exact', descendants: 1 },
        { kind: 'none' },
      );

      assert.equal(
        await stillPending(client2, 300),
        true,
        'the delete must wait for in-flight creates rather than enumerate around them',
      );

      gate.release();
      await client1;

      const error = await client2.then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(error instanceof ObjectError);
      assert.equal(
        error.code,
        'OBJECT_SUBTREE_CHANGED',
        'the count moved, so the delete refuses rather than issuing a wrong receipt',
      );
      assert.equal(error.details['expected'], 1);
      assert.equal(error.details['actual'], 2);

      // Nothing was destroyed.
      assert.equal((await h.service.get(g)).id, g);
    });
  },
);
