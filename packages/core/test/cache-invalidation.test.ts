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

/**
 * Caches that count what they were told to forget. `forget` counts passes over the channel cache,
 * and `forgotten` holds the sensors each pass was given, sorted.
 */
function counting(): {
  counts: {
    forget: number;
    clearChannels: number;
    policies: number;
    sensors: number;
    owners: number;
  };
  forgotten: number[][];
  invalidator: (settleMs?: number) => ResultCacheInvalidator;
} {
  const counts = { forget: 0, clearChannels: 0, policies: 0, sensors: 0, owners: 0 };
  const forgotten: number[][] = [];
  return {
    counts,
    forgotten,
    invalidator: (settleMs) =>
      new ResultCacheInvalidator({
        channels: {
          forgetMany: (sensorIds) => {
            counts.forget += 1;
            forgotten.push([...sensorIds].sort((a, b) => a - b));
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

  it('forgets a sensor whose parameters an edit changed, and not one an edit only renamed (P-403)', async () => {
    // What the sensor's type declares follows its parameters, and the resolver keeps what it
    // decided from a declaration: an emptied `primaryName` must reach it without a restart.
    const { counts, forgotten, invalidator } = counting();
    const tx = transaction();
    const edited = {
      action: 'object.updated',
      objectId: 15,
      changedParams: ['primaryName'],
    } as unknown as Mutation;
    const renamed = {
      action: 'object.updated',
      objectId: 16,
      changedParams: [],
    } as unknown as Mutation;
    await invalidator().record(tx.q, testActor, [edited, renamed], new Date());
    assert.equal(counts.forget, 1);
    tx.commit();
    assert.equal(counts.forget, 2, 'and again once it commits');
    assert.deepEqual(
      { clearChannels: counts.clearChannels, policies: counts.policies, owners: counts.owners },
      { clearChannels: 0, policies: 0, owners: 0 },
    );
    assert.deepEqual(forgotten, [[15], [15]]);
  });

  it('forgets every sensor of one call in one pass, now and once at the commit (P-403 review)', async () => {
    // A move that clears 5,000 sensors' own secrets records an `object.updated` for each in one
    // call. A pass over the channel cache each, inside the move's transaction and again after
    // it, blocked the event loop for seconds.
    const { counts, forgotten, invalidator } = counting();
    const tx = transaction();
    const cleared = Array.from(
      { length: 5_000 },
      (_, i) =>
        ({
          action: 'object.updated',
          objectId: 1_000 + i,
          changedParams: ['password'],
        }) as unknown as Mutation,
    );
    await invalidator().record(tx.q, testActor, [...cleared, limitsSet], new Date());
    assert.equal(counts.forget, 1, 'one pass, not one a sensor');
    assert.equal(forgotten[0]?.length, 5_001, 'every sensor, and the channel entry’s');
    assert.equal(tx.pending(), 1, 'and one hook for the commit');
    tx.commit();
    assert.equal(counts.forget, 2);
    assert.deepEqual(forgotten[1], forgotten[0]);
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

describe('forgetting many sensors in one pass (`P-403` review)', () => {
  /** Answers the resolver's channel read with an `rtt` row for each sensor it asks about. */
  const rows: Queryable['query'] = <T>(text: string, values?: readonly unknown[]) => {
    if (!text.includes('FROM channel c')) return Promise.resolve([] as T[]);
    const sensors = (values?.[0] ?? []) as number[];
    return Promise.resolve(
      sensors.map((sensorId) => ({
        id: sensorId,
        sensor_id: String(sensorId),
        key: 'rtt',
        name: 'rtt',
        unit: 'ms',
        decimals: null,
        limits: {},
        lookup_id: null,
        counter_bits: null,
        scale_mul: '1',
        scale_div: '1',
        spike_min: null,
        spike_max: null,
        is_primary: false,
      })) as unknown as T[],
    );
  };
  const reading = (sensorId: number): CheckResult =>
    ({ sensorId, channels: [{ key: 'rtt', value: 1 }] }) as unknown as CheckResult;

  it('drops the named sensors’ channels and keeps the rest', async () => {
    const channels = new ChannelResolver({ logger: silent });
    // Sensor 10 and sensor 100 share a prefix: only the whole id names a sensor.
    await channels.resolve({ query: rows }, [reading(10), reading(100), reading(101)]);
    assert.equal(channels.cached, 3);
    assert.equal(channels.forgetMany(new Set([100, 7])), 1);
    assert.equal(channels.cached, 2);
    let asked: number[] = [];
    await channels.resolve(
      {
        query: (text, values) => {
          if (text.includes('FROM channel c')) asked = [...((values?.[0] ?? []) as number[])];
          return rows(text, values);
        },
      },
      [reading(10), reading(100), reading(101)],
    );
    assert.deepEqual(asked, [100], 'only the forgotten sensor is read again');
  });
});
