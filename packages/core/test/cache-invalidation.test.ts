import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
import type { Queryable } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { SensorOwnership } from '../src/ingestion/ownership.js';
import type { Mutation } from '../src/objects/audit.js';
import { silent, testActor } from './support/tree.js';

/**
 * When the result path's caches are cleared the second time (`P-240`).
 *
 * The first clear runs inside the mutation's transaction, and a read between it and the commit
 * sees the old tree. The second clear used to be a timer 250 ms later, which a slow move
 * outlasts. These run against stubs, because the question is the order of three events — a
 * clear, a read, a commit — and a database cannot be made to put them in a chosen order.
 */

/** Only `action` and `objectId` are read; the rest of each mutation's shape is the audit log's. */
const moved = { action: 'object.moved', objectId: 11 } as unknown as Mutation;
const deleted = { action: 'object.deleted', objectId: 12 } as unknown as Mutation;
const settingSet = { action: 'setting.set', objectId: 13 } as unknown as Mutation;
const limitsSet = { action: 'channel.limits.set', objectId: 14 } as unknown as Mutation;

/** A transaction whose commit the test decides, collecting what waits for it. */
function transaction(query: Queryable['query'] = () => Promise.resolve([])): {
  q: Queryable;
  commit: () => void;
  pending: () => number;
} {
  const hooks: (() => void)[] = [];
  return {
    q: {
      query,
      afterCommit: (fn) => {
        hooks.push(fn);
      },
    },
    commit: () => {
      for (const hook of hooks.splice(0)) hook();
    },
    pending: () => hooks.length,
  };
}

/** Caches that count what they were told to forget. */
function counting(): {
  counts: {
    forget: number;
    clearChannels: number;
    policies: number;
    sensors: number;
    owners: number;
  };
  invalidator: (settleMs?: number) => ResultCacheInvalidator;
} {
  const counts = { forget: 0, clearChannels: 0, policies: 0, sensors: 0, owners: 0 };
  return {
    counts,
    invalidator: (settleMs) =>
      new ResultCacheInvalidator({
        channels: {
          forget: () => {
            counts.forget += 1;
            return 0;
          },
          clear: () => {
            counts.clearChannels += 1;
          },
        },
        sensors: {
          clear: () => {
            counts.sensors += 1;
          },
          forgetPolicies: () => {
            counts.policies += 1;
          },
        },
        owners: {
          clear: () => {
            counts.owners += 1;
          },
        },
        logger: silent,
        ...(settleMs === undefined ? {} : { settleMs }),
      }),
  };
}

describe('the result caches, cleared again once the change commits (`P-240`)', () => {
  it('clears each cache now, and again at the commit rather than on a timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { counts, invalidator } = counting();
    const cleared = invalidator();
    const tx = transaction();

    await cleared.record(tx.q, testActor, [moved, settingSet, limitsSet, deleted], new Date());
    assert.deepEqual(counts, { forget: 1, clearChannels: 1, policies: 2, sensors: 1, owners: 2 });

    // A move whose sinks take a second: the old timer would have fired, and nothing may.
    t.mock.timers.tick(1_000);
    assert.deepEqual(counts, { forget: 1, clearChannels: 1, policies: 2, sensors: 1, owners: 2 });

    tx.commit();
    assert.deepEqual(counts, { forget: 2, clearChannels: 2, policies: 4, sensors: 2, owners: 4 });
  });

  it('clears nothing a second time for a transaction that rolled back', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { counts, invalidator } = counting();
    const tx = transaction();
    await invalidator().record(tx.q, testActor, [moved], new Date());
    // Rolled back: its hooks are simply never run, which is `tx`'s contract.
    t.mock.timers.tick(60_000);
    assert.equal(counts.owners, 1);
    assert.equal(counts.policies, 1);
    // A move clears the owners and the policies: both wait on a commit that never comes.
    assert.equal(tx.pending(), 2);
  });

  it('falls back to the timer for a caller with no transaction to wait for', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { counts, invalidator } = counting();
    const plain: Queryable = { query: () => Promise.resolve([]) };
    await invalidator(250).record(plain, testActor, [moved], new Date());
    assert.equal(counts.owners, 1);
    t.mock.timers.tick(249);
    assert.equal(counts.owners, 1);
    t.mock.timers.tick(1);
    assert.equal(counts.owners, 2);
  });

  it('runs no second pass after it is stopped', async () => {
    const { counts, invalidator } = counting();
    const cleared = invalidator();
    const tx = transaction();
    await cleared.record(tx.q, testActor, [moved], new Date());
    cleared.stop();
    tx.commit();
    assert.equal(counts.owners, 1);
  });

  it('admits the new probe after a move that committed long after the old timer', async (t) => {
    // The finding's own sequence. Probe A (1) owned sensor 100; the move gives it to B (2). A
    // batch from A lands between the old timer and the commit, reads the committed, pre-move
    // tree, and caches A. Before the fix, B was then refused as `moved` until the next move
    // anywhere.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let committedOwner = 1;
    const owners: Queryable = {
      query: <T>(text: string): Promise<T[]> =>
        Promise.resolve(
          (text.includes('probe_of')
            ? [{ sensor_id: '100', sensor_type: 'ping', probe_id: String(committedOwner) }]
            : []) as T[],
        ),
    };
    const ownership = new SensorOwnership();
    const invalidator = new ResultCacheInvalidator({
      channels: new ChannelResolver({ logger: silent }),
      owners: ownership,
      logger: silent,
    });
    const result = { sensorId: 100 } as unknown as CheckResult;

    const tx = transaction();
    await invalidator.record(tx.q, testActor, [moved], new Date());
    t.mock.timers.tick(1_000);
    const fromA = await ownership.admit(owners, 1, [result]);
    assert.equal(fromA.results.length, 1, 'A still owns it until the move commits');
    assert.equal(ownership.cached, 1, 'and that answer is cached, as the finding describes');

    committedOwner = 2;
    tx.commit();
    const fromB = await ownership.admit(owners, 2, [result]);
    assert.equal(fromB.results.length, 1, 'the probe it was moved to was refused');
    assert.equal(fromB.refused.moved.length, 0);
  });
});

describe('a channel read that a forget overtook is not cached (`P-240`)', () => {
  /** A channel query that answers only when the test says so. */
  function heldQuery(): { query: Queryable['query']; release: () => void; asked: Promise<void> } {
    let release = (): void => undefined;
    let asked = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const askedPromise = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const row = {
      id: 7,
      sensor_id: '100',
      key: 'rtt',
      name: 'rtt',
      unit: 'ms',
      decimals: null,
      limits: { upperError: 100 },
      lookup_id: null,
      counter_bits: null,
      scale_mul: '1',
      scale_div: '1',
      spike_min: null,
      spike_max: null,
    };
    return {
      query: async <T>(text: string): Promise<T[]> => {
        if (!text.includes('FROM channel c')) return [];
        asked();
        await held;
        return [row] as T[];
      },
      release,
      asked: askedPromise,
    };
  }

  const reading = {
    sensorId: 100,
    channels: [{ key: 'rtt', value: 1 }],
  } as unknown as CheckResult;

  it('returns what it read for this batch, and keeps it only if nothing was forgotten meanwhile', async () => {
    const channels = new ChannelResolver({ logger: silent });
    const overtaken = heldQuery();
    const inFlight = channels.resolve({ query: overtaken.query }, [reading]);
    await overtaken.asked;
    // The limit edit commits, and its second forget runs, while the read is in flight.
    channels.forget(100);
    overtaken.release();
    const resolved = await inFlight;
    assert.equal(resolved.ids.get('100:rtt')?.id, 7, 'the batch lost its channel');
    assert.equal(channels.cached, 0, 'a read a forget overtook put the old limits back');

    const undisturbed = heldQuery();
    const next = channels.resolve({ query: undisturbed.query }, [reading]);
    await undisturbed.asked;
    undisturbed.release();
    await next;
    assert.equal(channels.cached, 1, 'a read nothing overtook is cached as before');
  });

  it('counts a clear as well as a forget', async () => {
    const channels = new ChannelResolver({ logger: silent });
    const overtaken = heldQuery();
    const inFlight = channels.resolve({ query: overtaken.query }, [reading]);
    await overtaken.asked;
    channels.clear();
    overtaken.release();
    await inFlight;
    assert.equal(channels.cached, 0);
  });
});
