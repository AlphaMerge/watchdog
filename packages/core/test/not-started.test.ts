import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckFailure, CheckResult } from '@ms/shared';
import { pino } from 'pino';
import type { Mutation } from '../src/objects/audit.js';
import { ClockFreezeSync } from '../src/probes/clock-freeze-sync.js';
import {
  MOVED_OFF_MESSAGE,
  NotStarted,
  type NotStartedOptions,
} from '../src/probes/not-started.js';
import { testActor } from './support/tree.js';

/**
 * The sensors whose checks their probe could not start (`P-265`), over a stand-in database: what
 * is held, what lets it go, and that a write that does not land claims nothing. What it does to
 * alarms is `probe-episode-scenario.test.ts`, through the real pieces.
 */

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

const GAVE_UP = 'the probe took 10012 ms to start the check and gave up';
const POOL = 'the worker pool has given up and cannot run checks';

const STARTUP: CheckFailure = { phase: 'startup' };
const POOL_DISABLED: CheckFailure = { phase: 'pool-disabled' };

function unstarted(
  sensorId: number,
  seconds: number,
  message = GAVE_UP,
  failure?: CheckFailure,
): CheckResult {
  return {
    sensorId,
    at: at(seconds),
    outcome: 'error',
    message,
    durationMs: 10_012,
    channels: [],
    notStarted: true,
    ...(failure === undefined ? {} : { failure }),
  };
}

function ran(sensorId: number, seconds: number): CheckResult {
  return {
    sensorId,
    at: at(seconds),
    outcome: 'ok',
    message: 'reply',
    durationMs: 12,
    channels: [],
  };
}

interface World {
  /** When each sensor last took a result, as `sensor_runtime` has it. */
  readonly last: Map<number, number>;
  /** The sensors still under each probe, as the tree has it. */
  readonly under: Map<number, number[]>;
  readonly reevaluated: {
    ids: number[];
    message: string;
    sources: readonly string[];
    /** Where the check stopped, when the caller passed one (`P-407`). */
    failure?: CheckFailure | null;
  }[];
  recomputes: number;
  /** Each call to drop what the state service cached, with its sensors (`P-409`). */
  readonly forgotten: number[][];
  /** Transactions opened (`P-410`). */
  transactions: number;
  /** What it logged, as written (`P-410`). */
  readonly logs: { level: number; msg: string; held?: number; reworded?: number }[];
  /** Refuses every write while true. */
  failing: boolean;
}

function world(): World {
  return {
    last: new Map(),
    under: new Map(),
    reevaluated: [],
    recomputes: 0,
    forgotten: [],
    transactions: 0,
    logs: [],
    failing: false,
  };
}

function holder(w: World, alarms: readonly number[] = []): NotStarted {
  const query = (sql: string, values: readonly unknown[]): Promise<unknown[]> => {
    if (sql.includes('last_result_at')) {
      const ids = values[0] as number[];
      return Promise.resolve(
        ids
          .filter((id) => w.last.has(id))
          .map((id) => ({ id: String(id), last_result_at: new Date(T0 + (w.last.get(id) ?? 0)) })),
      );
    }
    const probe = Number(values[0]);
    const asked = (values[1] as number[]).map(Number);
    const still = w.under.get(probe) ?? [];
    return Promise.resolve(
      asked.filter((id) => still.includes(id)).map((id) => ({ id: String(id) })),
    );
  };
  const q = { query };
  return new NotStarted({
    db: {
      query,
      tx: <T>(fn: (inner: unknown) => Promise<T>) => {
        w.transactions += 1;
        return fn(q);
      },
    } as unknown as NotStartedOptions['db'],
    logger: pino(
      { level: 'debug' },
      {
        write: (line: string) => {
          w.logs.push(JSON.parse(line) as World['logs'][number]);
        },
      },
    ),
    states: {
      reevaluate: (_q, ids, _at, cause) => {
        if (w.failing) return Promise.reject(new Error('the transaction is aborted'));
        w.reevaluated.push({
          ids: [...ids],
          message: cause.message,
          sources: [...cause.sources],
          ...(cause.failure === undefined ? {} : { failure: cause.failure }),
        });
        return Promise.resolve(ids.length);
      },
      forgetSensors: (ids) => {
        w.forgotten.push([...ids]);
      },
    },
    dependencies: {
      recompute: () => {
        w.recomputes += 1;
        return Promise.resolve({ moved: 0 });
      },
    },
    probeAlarms: () => alarms,
    now: () => new Date(T0 + 3_600_000),
  });
}

describe('what a probe that could not start a check holds (`P-265`)', () => {
  it('takes those results out, holds their sensors with the probe’s words, and leaves the rest in order', async () => {
    const w = world();
    const held = holder(w, [99]);
    const batch = [ran(1, 0), unstarted(2, 1), ran(3, 2), unstarted(4, 3, POOL)];
    const out = await held.hold(9, batch);
    assert.deepEqual(out.results, [ran(1, 0), ran(3, 2)]);
    assert.equal(out.held, 2);
    assert.equal(out.dropped, 0);
    assert.deepEqual([...held.heldSensors()].sort(), [2, 4]);
    assert.equal(held.heldOn(9), 2);
    assert.equal(held.carrierOf(2), 9);
    assert.equal(held.carrierOf(1), undefined);
    assert.deepEqual(held.heldBy(9)?.sensorIds, new Set([2, 4]));
    assert.deepEqual(w.reevaluated, [
      { ids: [2], message: GAVE_UP, sources: ['probe'], failure: null },
      { ids: [4], message: POOL, sources: ['probe'], failure: null },
      { ids: [99], message: '', sources: ['probe'] },
    ]);
    assert.equal(w.recomputes, 1, 'a master that is Unknown releases what it held');
  });

  it('holds each sensor with where its check stopped, one re-decision per sentence and place (P-407)', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [
      unstarted(1, 0, GAVE_UP, STARTUP),
      unstarted(2, 0, GAVE_UP, STARTUP),
      // The same words from a probe below protocol 35, which names nowhere.
      unstarted(3, 0, GAVE_UP),
      unstarted(4, 0, POOL, POOL_DISABLED),
    ]);
    assert.deepEqual(w.reevaluated, [
      { ids: [1, 2], message: GAVE_UP, sources: ['probe'], failure: STARTUP },
      { ids: [3], message: GAVE_UP, sources: ['probe'], failure: null },
      { ids: [4], message: POOL, sources: ['probe'], failure: POOL_DISABLED },
    ]);
  });

  it('passes a batch with nothing marked straight through, reading nothing', async () => {
    const w = world();
    const held = holder(w);
    const batch = [ran(1, 0), ran(2, 1)];
    const out = await held.hold(9, batch);
    assert.equal(out.results, batch, 'the same array');
    assert.equal(w.reevaluated.length, 0);
  });

  const ORDER: readonly {
    readonly name: string;
    readonly batch: readonly CheckResult[];
    readonly held: boolean;
  }[] = [
    { name: 'could not start, then ran', batch: [unstarted(1, 0), ran(1, 5)], held: false },
    { name: 'ran, then could not start', batch: [ran(1, 0), unstarted(1, 5)], held: true },
    { name: 'the same instant: it ran', batch: [unstarted(1, 5), ran(1, 5)], held: false },
    {
      name: 'out of order in the batch: the later decides',
      batch: [unstarted(1, 9), ran(1, 5)],
      held: true,
    },
  ];
  for (const row of ORDER) {
    it(`lets the sensor’s last word in the batch decide: ${row.name}`, async () => {
      const held = holder(world());
      await held.hold(9, row.batch);
      assert.equal(held.heldSensors().has(1), row.held);
    });
  }

  it('drops and counts what is no later than the sensor’s last result: a resend', async () => {
    const w = world();
    w.last.set(1, 10_000);
    const held = holder(w);
    const out = await held.hold(9, [unstarted(1, 5), unstarted(1, 10), unstarted(2, 5)]);
    assert.equal(out.held, 1, 'only sensor 2, which had no result after it');
    assert.equal(out.dropped, 2);
    assert.equal(held.heldSensors().has(1), false);
    assert.deepEqual(out.results, []);
  });

  it('moves a hold forward on a later one in the same words, without re-deciding it', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0)]);
    const before = w.reevaluated.length;
    const out = await held.hold(9, [unstarted(1, 30)]);
    assert.equal(out.held, 1);
    assert.equal(w.reevaluated.length, before, 'nothing new to say');
    // A result between the two is older than the hold now, so lets nothing go.
    assert.equal(held.release(9, [ran(1, 20)]).released, 0);
    assert.equal(held.heldSensors().has(1), true);
    // New words are re-decided.
    await held.hold(9, [unstarted(1, 40, POOL)]);
    assert.deepEqual(w.reevaluated.at(-1)?.ids, [1]);
    assert.equal(w.reevaluated.at(-1)?.message, POOL);
  });

  it('takes the sets back and throws when the hold cannot be written, so the batch is refused', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0)]);
    w.failing = true;
    await assert.rejects(held.hold(9, [unstarted(2, 0), unstarted(1, 5, POOL)]));
    assert.deepEqual([...held.heldSensors()], [1], 'sensor 2 was never held');
    assert.equal(held.heldOn(9), 1);
    assert.equal(held.carrierOf(2), undefined);
    assert.equal(held.carrierOf(1), 9);
    // And sensor 1's hold is the one it had: a result after it lets it go.
    assert.equal(held.release(9, [ran(1, 3)]).released, 1);
  });
});

describe('a sensor held again in other words (`P-410`)', () => {
  const WARN = 40;
  const warned = (w: World): World['logs'] => w.logs.filter((one) => one.level === WARN);

  it('rewords it alone: no alarm moved, no recompute, no warning, one transaction', async () => {
    const w = world();
    const held = holder(w, [99]);
    await held.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    assert.deepEqual(w.reevaluated, [
      { ids: [1], message: GAVE_UP, sources: ['probe'], failure: STARTUP },
      { ids: [99], message: '', sources: ['probe'] },
    ]);
    assert.equal(w.recomputes, 1);
    assert.equal(w.transactions, 1);
    assert.equal(warned(w).length, 1);

    // The pool gave up: other words, another place. Said, and nothing else moves.
    await held.hold(9, [unstarted(1, 10, POOL, POOL_DISABLED)]);
    assert.deepEqual(w.reevaluated.slice(2), [
      { ids: [1], message: POOL, sources: ['probe'], failure: POOL_DISABLED },
    ]);
    assert.equal(w.recomputes, 1, 'who holds it did not change');
    assert.equal(w.transactions, 2);
    assert.equal(warned(w).length, 1, 'said once, when it was held');
    assert.equal(w.logs.at(-1)?.reworded, 1);
    assert.deepEqual(held.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });

    // The same words in the same place open nothing.
    await held.hold(9, [unstarted(1, 20, POOL, POOL_DISABLED)]);
    assert.equal(w.transactions, 2);
    assert.equal(w.reevaluated.length, 3);

    // The same words in another place are said: the place is read beside them.
    await held.hold(9, [unstarted(1, 30, POOL, STARTUP)]);
    assert.equal(w.transactions, 3);
    assert.deepEqual(w.reevaluated.at(-1), {
      ids: [1],
      message: POOL,
      sources: ['probe'],
      failure: STARTUP,
    });
  });

  it('moves the alarm once for a batch that holds one sensor and rewords another', async () => {
    const w = world();
    const held = holder(w, [99]);
    await held.hold(9, [unstarted(1, 0)]);
    const recomputes = w.recomputes;
    await held.hold(9, [unstarted(2, 10), unstarted(1, 10, POOL)]);
    assert.equal(w.reevaluated.filter((one) => one.ids.includes(99)).length, 2, 'once a hold');
    assert.equal(w.recomputes, recomputes + 1);
    assert.equal(warned(w).at(-1)?.held, 1, 'the one it held, not the one it reworded');
  });

  it('gives each sensor its carrier’s words, through a hand-off and a put-back', async () => {
    const held = holder(world());
    await held.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    await held.hold(8, [unstarted(1, 5, POOL, POOL_DISABLED)]);
    assert.equal(held.carrierOf(1), 8);
    assert.deepEqual(held.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });
    assert.equal(held.heldWords().size, 1);

    // Probe 8 lets it go: probe 9 still holds it, in its own words.
    const gone = held.release(8, [ran(1, 10)]);
    assert.equal(held.carrierOf(1), 9);
    assert.deepEqual(held.heldWords().get(1), { message: GAVE_UP, failure: STARTUP });
    gone.stored(false);
    assert.deepEqual(held.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });
    assert.equal(held.heldWords().has(2), false);
    assert.equal(held.heldWords().get(2), undefined);
  });

  it('never puts a sensor back under a carrier that has let it go since', async () => {
    const held = holder(world());
    await held.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    await held.hold(8, [unstarted(1, 5, POOL, POOL_DISABLED)]);
    // 9 lets it go while 8 carries it, then 8 lets it go for good, then 9's batch is not stored:
    // 9 holds it again, and 8, which no longer does, cannot be the one whose words it says.
    const nine = held.release(9, [ran(1, 10)]);
    assert.equal(held.carrierOf(1), 8);
    held.release(8, [ran(1, 10)]).stored(true);
    assert.equal(held.heldSensors().has(1), false);
    nine.stored(false);
    assert.equal(held.carrierOf(1), 9);
    assert.deepEqual(held.heldWords().get(1), { message: GAVE_UP, failure: STARTUP });
  });

  it('keeps the carrier through a put-back when that carrier still holds the sensor', async () => {
    const held = holder(world());
    await held.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    await held.hold(8, [unstarted(1, 5, POOL, POOL_DISABLED)]);
    const nine = held.release(9, [ran(1, 10)]);
    assert.equal(held.carrierOf(1), 8);
    nine.stored(false);
    assert.equal(held.heldOn(9), 1, 'and 9 holds it again');
    assert.equal(held.carrierOf(1), 8, 'under 8, which held it last');
    assert.deepEqual(held.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });
  });

  it('never takes the carrier from a hold made since the release', async () => {
    // 9 lets go of its only hold, 8 holds the sensor before 9's batch is known not stored.
    const alone = holder(world());
    await alone.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    const nine = alone.release(9, [ran(1, 10)]);
    assert.equal(alone.heldSensors().has(1), false);
    await alone.hold(8, [unstarted(1, 15, POOL, POOL_DISABLED)]);
    nine.stored(false);
    assert.equal(alone.heldOn(9), 1);
    assert.equal(alone.carrierOf(1), 8);
    assert.deepEqual(alone.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });

    // 9's release hands the sensor to 8, which holds it again in other words before 9's batch is
    // known not stored: the hand-off was this release's, the rewording is since.
    const handed = holder(world());
    await handed.hold(8, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    await handed.hold(9, [unstarted(1, 5, GAVE_UP, STARTUP)]);
    const again = handed.release(9, [ran(1, 10)]);
    assert.equal(handed.carrierOf(1), 8);
    await handed.hold(8, [unstarted(1, 15, POOL, POOL_DISABLED)]);
    again.stored(false);
    assert.equal(handed.carrierOf(1), 8);
    assert.deepEqual(handed.heldWords().get(1), { message: POOL, failure: POOL_DISABLED });
  });

  it('compares a round with what the sensor says, which is its carrier’s words', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0, GAVE_UP, STARTUP)]);
    await held.hold(8, [unstarted(1, 5, POOL, POOL_DISABLED)]);
    assert.equal(w.transactions, 2);
    // 9's own words again, which are not what the sensor says: 8's are.
    await held.hold(9, [unstarted(1, 10, GAVE_UP, STARTUP)]);
    assert.equal(held.carrierOf(1), 9);
    assert.equal(w.transactions, 3);
    assert.deepEqual(w.reevaluated.at(-1), {
      ids: [1],
      message: GAVE_UP,
      sources: ['probe'],
      failure: STARTUP,
    });
    // 8 again in what the sensor now says opens nothing, though they are not 8's last words.
    await held.hold(8, [unstarted(1, 15, GAVE_UP, STARTUP)]);
    assert.equal(held.carrierOf(1), 8);
    assert.equal(w.transactions, 3);
  });

  it('keeps the words it had when the rewording cannot be written, and says the new ones when sent again', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0)]);
    w.failing = true;
    await assert.rejects(held.hold(9, [unstarted(1, 5, POOL)]));
    assert.deepEqual(held.heldWords().get(1), { message: GAVE_UP, failure: null });
    w.failing = false;
    await held.hold(9, [unstarted(1, 5, POOL)]);
    assert.deepEqual(w.reevaluated.at(-1)?.ids, [1]);
    assert.equal(w.reevaluated.at(-1)?.message, POOL);
  });
});

describe('what lets a held sensor go (`P-265`)', () => {
  it('a later result that ran, without re-deciding it: the result does that, in one step', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0), unstarted(2, 0)]);
    const before = w.reevaluated.length;
    const released = held.release(9, [ran(1, 5), ran(2, 0), unstarted(1, 9)]);
    assert.equal(released.released, 1, 'only the one later than its hold');
    released.stored(true);
    assert.deepEqual([...held.heldSensors()], [2]);
    assert.equal(held.carrierOf(1), undefined);
    assert.equal(w.reevaluated.length, before, 'no re-evaluation');
  });

  it('puts the sensor back when the batch is not stored, as the probe sends it again', async () => {
    const held = holder(world());
    await held.hold(9, [unstarted(1, 0)]);
    const released = held.release(9, [ran(1, 5)]);
    assert.equal(held.heldSensors().has(1), false, 'out while the result is decided');
    released.stored(false);
    assert.equal(held.heldSensors().has(1), true);
    assert.equal(held.carrierOf(1), 9);
    assert.equal(held.heldOn(9), 1);
    assert.ok(held.heldBy(9) !== undefined, 'and the episode is still there (`M-22`)');
  });

  it('drops what was cached about each sensor it lets go, and again when it puts one back (P-409)', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0), unstarted(2, 0), unstarted(3, 0)]);
    assert.deepEqual(w.forgotten, [], 'a hold re-decides what it holds, which drops it there');
    const released = held.release(9, [ran(1, 5), ran(3, 5), ran(2, 0)]);
    assert.deepEqual(w.forgotten, [[1, 3]], 'only the ones it lets go');
    released.stored(false);
    assert.deepEqual(w.forgotten, [
      [1, 3],
      [1, 3],
    ]);
    held.release(9, [ran(2, 0)]).stored(false);
    assert.equal(w.forgotten.length, 2, 'nothing let go, nothing dropped');
  });

  it('ends the probe’s episode with its last sensor', async () => {
    const held = holder(world());
    await held.hold(9, [unstarted(1, 0)]);
    held.release(9, [ran(1, 5)]).stored(true);
    assert.equal(held.heldBy(9), undefined);
    assert.equal(held.heldOn(9), 0);
  });

  it('is nothing for a probe that holds nothing', () => {
    const held = holder(world());
    const released = held.release(9, [ran(1, 5)]);
    assert.equal(released.released, 0);
    released.stored(false);
    assert.equal(held.heldSensors().size, 0);
  });
});

describe('kept in step with the tree (`P-265`, as `P-239`)', () => {
  it('lets go and re-decides a sensor moved off the probe that held it, and only that one', async () => {
    const w = world();
    const held = holder(w, [99]);
    await held.hold(9, [unstarted(1, 0), unstarted(2, 0)]);
    w.reevaluated.length = 0;
    w.under.set(9, [2]);
    const moved = await held.resync({ query: () => Promise.resolve([{ id: '2' }]) } as never);
    assert.equal(moved, 1);
    assert.deepEqual([...held.heldSensors()], [2]);
    assert.deepEqual(w.reevaluated, [
      { ids: [1], message: MOVED_OFF_MESSAGE, sources: ['probe'] },
      { ids: [99], message: '', sources: ['probe'] },
    ]);
  });

  it('reads nothing when nothing is held', async () => {
    let read = 0;
    const held = holder(world());
    await held.resync({
      query: () => {
        read += 1;
        return Promise.resolve([]);
      },
    } as never);
    assert.equal(read, 0);
  });

  it('takes its sets back, and fails the mutation, when the release cannot be written', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0)]);
    w.failing = true;
    await assert.rejects(held.resync({ query: () => Promise.resolve([]) } as never));
    assert.equal(held.heldSensors().has(1), true);
    assert.equal(held.carrierOf(1), 9);
    assert.equal(held.heldOn(9), 1);
  });

  it('is run by the clock-freeze sink, on the mutations that move sensors', async () => {
    const w = world();
    const held = holder(w);
    await held.hold(9, [unstarted(1, 0)]);
    const sync = new ClockFreezeSync({ clockFreeze: () => undefined, notStarted: () => held });
    const q = { query: () => Promise.resolve([]) } as never;
    const edit = { action: 'object.updated' } as unknown as Mutation;
    await sync.record(q, testActor, [edit], new Date());
    assert.equal(held.heldSensors().has(1), true, 'an edit moves nothing');
    const move = { action: 'object.moved' } as unknown as Mutation;
    await sync.record(q, testActor, [move], new Date());
    assert.equal(held.heldSensors().has(1), false);
  });
});
