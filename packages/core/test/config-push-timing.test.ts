import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { ConfigChangeNotifier } from '../src/probes/notifier.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/**
 * When the configuration push is armed (`P-138`).
 *
 * The notifier rides the audit sink, which runs **inside** every mutation's transaction, and it
 * debounces for 250 ms. Any transaction slower than that — a bulk operation, a tree plan, a clone
 * of a large subtree, a busy database — had its push fire against the uncommitted tree: the
 * recomputation produced the fingerprint already in place, decided nothing had moved and pushed
 * nothing, and the timer was spent, so nothing rescheduled it. The probes stayed on the old
 * configuration until something else happened to change something.
 *
 * Asserted on the *ordering* rather than on a stopwatch: what matters is that no push happens
 * while the transaction is still open, and that one happens once it has committed.
 */
describe('arming the configuration push', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;

  before(async () => {
    scratch = await createScratchDatabase('configpush');
    db = scratch.db;
  });

  after(async () => {
    await scratch.drop();
  });

  it('does not push while the transaction that asked for it is still open', async () => {
    const pushes: string[] = [];
    const notifier = new ConfigChangeNotifier({
      logger: silent,
      // Zero, so the timer fires at the first opportunity: this test is about *which* opportunity.
      debounceMs: 0,
      target: {
        pushAllConfigs: () => {
          pushes.push('pushed');
        },
      },
    });

    await db.tx(async (q) => {
      await notifier.record(
        q,
        testActor,
        // Any mutation at all: the notifier does not read them, it only counts them.
        [{ action: 'setting.reverted', objectId: 1, key: 'scan.intervalSeconds', before: 60 }],
        new Date(),
      );
      // Long enough for a zero-delay timer to have fired several times over, which is what a
      // slow transaction is from the push's point of view.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(pushes, [], 'the tree it would read has not been committed yet');
    });

    // And once it has committed, the push happens.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(pushes, ['pushed']);
  });

  it('schedules nothing at all when the transaction rolls back', async () => {
    const pushes: string[] = [];
    const notifier = new ConfigChangeNotifier({
      logger: silent,
      debounceMs: 0,
      target: {
        pushAllConfigs: () => {
          pushes.push('pushed');
        },
      },
    });

    await assert.rejects(
      db.tx(async (q) => {
        await notifier.record(
          q,
          testActor,
          // Any mutation at all: the notifier does not read them, it only counts them.
          [{ action: 'setting.reverted', objectId: 1, key: 'scan.intervalSeconds', before: 60 }],
          new Date(),
        );
        throw new Error('rolled back');
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(pushes, [], 'nothing changed, so there is nothing to tell anybody');
  });
});
