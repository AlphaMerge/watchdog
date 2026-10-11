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
import { sessionsWait } from './support/waits-for-lock.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/**
 * Client 1's side of a race: `holds` settles once its work has run inside the tree lock, and the
 * transaction stays open until `release`. `holds` rejects if the work fails before then, rather
 * than leaving the test waiting for a signal that will not come.
 */
function heldOpen<T>(run: (work: () => Promise<void>) => Promise<T>): {
  holds: Promise<void>;
  done: Promise<T>;
  release: () => void;
} {
  let held = (): void => undefined;
  let release = (): void => undefined;
  const holds = new Promise<void>((resolve) => {
    held = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = run(async () => {
    held();
    await released;
  });
  return { holds: Promise.race([holds, done.then(() => undefined)]), done, release };
}

/** How long client 2 is given to reach the tree lock, and client 1 to take it. */
const REACHED_MS = 10_000;

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

      // Client 1 takes the exclusive lock, moves A under B, and holds the transaction open.
      const client1 = heldOpen((holdOpen) =>
        h.service.batch('exclusive', async (q, repo) => {
          await repo.reparent(q, a, b, { kind: 'none' });
          await holdOpen();
          return 'committed';
        }),
      );

      // Client 2 attempts the mirror move once client 1 holds the lock (`P-396`: a 100 ms sleep
      // stood in for that). Without the lock its cycle pre-check reads the pre-move tree, sees
      // nothing wrong, and commits — leaving A and B pointing at each other, unreachable from
      // the root and impossible to delete.
      let client2: Promise<unknown> = Promise.resolve();
      try {
        await within(REACHED_MS, 'client 1 to hold the tree lock', client1.holds);
        client2 = h.service.move(testActor, b, a, { kind: 'none' });
        // Waiting on the tree lock itself, not merely not finished yet.
        await sessionsWait(
          scratch.db,
          1,
          'client 2 to block on the tree lock, not race past its pre-check',
          { ms: REACHED_MS, event: 'advisory' },
        );
      } finally {
        client1.release();
      }
      await within(REACHED_MS, 'client 1 to commit', client1.done);

      const error = await within(
        REACHED_MS,
        'client 2 to be answered',
        client2.then(
          () => null,
          (e: unknown) => e,
        ),
      );
      assert.ok(error instanceof ObjectError, String(error));
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

      // Client 1 creates a sensor inside the target subtree and holds it open, under the
      // shared lock that `create` takes.
      const client1 = heldOpen((holdOpen) =>
        h.service.batch('shared', async (q, repo) => {
          await repo.insert(q, {
            kind: 'sensor',
            parentId: d,
            name: 'Late arrival',
            sensorType: 'icmp.ping',
          });
          await holdOpen();
          return 'committed';
        }),
      );

      // The operator counted 1 descendant. Without the shared/exclusive pairing, the delete
      // enumerates before the sensor commits, destroys it via the FK cascade anyway, and hands
      // back a receipt that never mentions it. It would block then too, on the device row the
      // sensor's foreign key holds: so the wait asked for is on the tree lock (`P-396`).
      let client2: Promise<unknown> = Promise.resolve();
      try {
        await within(REACHED_MS, 'client 1 to hold the tree lock', client1.holds);
        client2 = h.service.delete(
          testActor,
          g,
          { kind: 'exact', descendants: 1 },
          { kind: 'none' },
        );
        await sessionsWait(
          scratch.db,
          1,
          'the delete to wait for in-flight creates rather than enumerate around them',
          { ms: REACHED_MS, event: 'advisory' },
        );
      } finally {
        client1.release();
      }
      await within(REACHED_MS, 'client 1 to commit', client1.done);

      const error = await within(
        REACHED_MS,
        'the delete to be answered',
        client2.then(
          () => null,
          (e: unknown) => e,
        ),
      );
      assert.ok(error instanceof ObjectError, String(error));
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
