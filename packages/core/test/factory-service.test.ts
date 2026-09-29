import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
import { FactoryReach, UNREACHED_MESSAGE } from '../src/factory/reach.js';
import { FactoryService } from '../src/factory/service.js';
import { FactorySweep } from '../src/factory/sweep.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';
import { everyVoucherHolds, nothingFollowsReach } from './support/vouching.js';

/**
 * The Sensor Factory evaluator (`T-21`), against a real tree and real readings.
 *
 * The formula language has its own file. What is here is everything the language cannot see: how
 * a sensor's channels reach it, what happens when a source stopped reporting an hour ago, which
 * sensor fails when three of them form a ring, and whether a factory over a factory sees this
 * sweep's value or the last one's.
 */

const available = await databaseAvailable();

describe('sensor factory', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let deviceId = 0;
  let ingested: CheckResult[] = [];
  let factory: FactoryService;

  before(async () => {
    scratch = await createScratchDatabase('factory');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    ingested = [];

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'router',
      host: '192.0.2.1',
    });
    deviceId = device.id;

    factory = new FactoryService({
      vouching: everyVoucherHolds,
      reach: nothingFollowsReach,
      db,
      logger: silentLogger,
      ingest: (results) => {
        ingested.push(...results);
        return Promise.resolve();
      },
    });
  });

  /** A plain sensor with one channel holding one reading, `ageSeconds` old. */
  async function source(
    name: string,
    channelKey: string,
    value: number,
    options: { ageSeconds?: number; state?: string } = {},
  ): Promise<number> {
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name,
      sensorType: 'icmp.ping',
    });
    // Upserted: creating a sensor already creates the channels its type declares, so `rtt` is
    // there before this runs.
    const [channel] = await db.query<{ id: string }>(
      `INSERT INTO channel (sensor_id, key, name, unit) VALUES ($1, $2, $2, '')
       ON CONFLICT (sensor_id, key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [sensor.id, channelKey],
    );
    await db.query(
      `INSERT INTO sample (channel_id, time, value)
       VALUES ($1, now() - ($2 || ' seconds')::interval, $3)`,
      [Number(channel?.id), String(options.ageSeconds ?? 0), value],
    );
    if (options.state !== undefined) {
      // The *current* state lives here (`M-02`); `sensor_state` is the history uptime comes from.
      await db.query(
        `UPDATE sensor_runtime SET state = $2::sensor_state_kind WHERE object_id = $1`,
        [sensor.id, options.state],
      );
    }
    return sensor.id;
  }

  /** Deletes a sensor a factory was written against, the way an operator would. */
  async function removed(id: number): Promise<void> {
    await harness.service.delete(testActor, id, { kind: 'leafOnly' }, { kind: 'none' });
  }

  async function makeFactory(
    name: string,
    channels: { key: string; formula: string; name?: string }[],
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name,
      sensorType: 'core.factory',
      params: { channels, ...params },
    });
    return sensor.id;
  }

  const resultFor = (sensorId: number): CheckResult | undefined =>
    ingested.find((one) => one.sensorId === sensorId);

  const valueOf = (sensorId: number, key: string): number | undefined =>
    resultFor(sensorId)?.channels.find((channel) => channel.key === key)?.value;

  it('adds two sensors’ channels together, which is what it is for', async () => {
    const a = await source('uplink-a', 'traffic.in', 100);
    const b = await source('uplink-b', 'traffic.in', 250);
    const total = await makeFactory('Total inbound', [
      {
        key: 'total',
        name: 'Total inbound',
        formula: `channel(${String(a)}, 'traffic.in') + channel(${String(b)}, 'traffic.in')`,
      },
    ]);

    await factory.sweep();
    assert.equal(resultFor(total)?.outcome, 'ok');
    assert.equal(valueOf(total, 'total'), 350);
  });

  it('counts how many of a cluster are up', async () => {
    // The other thing a factory is for: one sensor to alarm on instead of three.
    const a = await source('node-a', 'rtt', 1, { state: 'up' });
    const b = await source('node-b', 'rtt', 1, { state: 'up' });
    const c = await source('node-c', 'rtt', 1, { state: 'down' });
    const alive = await makeFactory('Members up', [
      {
        key: 'up',
        formula: `status(${String(a)}) + status(${String(b)}) + status(${String(c)})`,
      },
    ]);

    await factory.sweep();
    assert.equal(valueOf(alive, 'up'), 2);
  });

  it('gaps a channel whose source is missing, rather than reporting a smaller total', async () => {
    // The failure mode a factory is most likely to produce: a total that quietly lost a term is
    // a number that looks like data and is wrong.
    const a = await source('uplink-a', 'traffic.in', 100);
    const b = await source('uplink-b', 'traffic.in', 50);
    const total = await makeFactory('Total inbound', [
      { key: 'known', formula: `channel(${String(a)}, 'traffic.in')` },
      {
        key: 'total',
        formula: `channel(${String(a)}, 'traffic.in') + channel(${String(b)}, 'traffic.in')`,
      },
    ]);
    // Deleted after the factory was written: a formula cannot name a sensor that does not exist
    // yet (`A-29`), so this is how a source goes missing.
    await removed(b);

    await factory.sweep();
    assert.equal(resultFor(total)?.outcome, 'ok');
    assert.equal(valueOf(total, 'known'), 100);
    assert.equal(valueOf(total, 'total'), undefined, 'the gap is the data');
    assert.match(resultFor(total)?.message ?? '', /total had nothing to compute from/);
  });

  it('treats a stale reading as absent rather than as still true', async () => {
    // A source that stopped reporting leaves its last value behind for ever, and arithmetic over
    // something that stopped being true an hour ago is worse than no number at all.
    const stale = await source('stopped', 'v', 42, { ageSeconds: 4_000 });
    const fresh = await source('reporting', 'v', 7);
    const both = await makeFactory(
      'Both',
      [
        { key: 'fresh', formula: `channel(${String(fresh)}, 'v')` },
        { key: 'stale', formula: `channel(${String(stale)}, 'v')` },
      ],
      { maxAgeSeconds: 600 },
    );

    await factory.sweep();
    assert.equal(valueOf(both, 'fresh'), 7);
    assert.equal(valueOf(both, 'stale'), undefined);
  });

  /**
   * `P-59`: the cut-off used to be one `Math.max` over every factory sensor in the installation,
   * floored at 600. Every row below therefore runs with a neighbouring factory set to a day — it
   * is the *neighbour* that exposes the collapse. With a single factory configured, the two
   * readings of the code agree, which is exactly why the test above passed throughout.
   */
  const CUTOFFS = [
    { what: 'a fresh reading under a tight cut-off', cutOff: 60, ageSeconds: 10, reads: true },
    { what: 'a stale reading under a tight cut-off', cutOff: 60, ageSeconds: 3_000, reads: false },
    {
      what: 'a reading under a cut-off below the old floor',
      cutOff: 30,
      ageSeconds: 300,
      reads: false,
    },
    {
      what: 'an old reading the sensor asked to accept',
      cutOff: 86_400,
      ageSeconds: 3_000,
      reads: true,
    },
  ] as const;

  for (const row of CUTOFFS) {
    it(`${row.reads ? 'reads' : 'gaps'} ${row.what}`, async () => {
      const measured = await source('measured', 'v', 42, { ageSeconds: row.ageSeconds });
      const formula = [{ key: 'v', formula: `channel(${String(measured)}, 'v')` }];
      const subject = await makeFactory('Subject', formula, { maxAgeSeconds: row.cutOff });
      // Exists only to be relaxed. Under the old code its cut-off silently became everyone's.
      await makeFactory('Neighbour', formula, { maxAgeSeconds: 86_400 });

      await factory.sweep();
      assert.equal(valueOf(subject, 'v'), row.reads ? 42 : undefined);
    });
  }

  it('names the cut-off it actually applied when everything it reads is too old', async () => {
    // The message read the per-sensor setting while the query used the installation-wide one, so
    // it could report “older than 60 s” about a reading it had just accepted at 24 hours.
    const measured = await source('measured', 'v', 42, { ageSeconds: 3_000 });
    const formula = [{ key: 'v', formula: `channel(${String(measured)}, 'v')` }];
    const subject = await makeFactory('Subject', formula, { maxAgeSeconds: 60 });
    await makeFactory('Neighbour', formula, { maxAgeSeconds: 86_400 });

    await factory.sweep();
    assert.equal(resultFor(subject)?.outcome, 'error');
    assert.match(resultFor(subject)?.message ?? '', /older than 60 s/);
  });

  it('does not age a factory’s own output on the way to the factory above it', async () => {
    // The write-back that lets a factory read a factory within one sweep hands over a value with
    // no sample behind it. It is this sweep's, so it is new — a tight cut-off upstairs must not
    // turn the whole stack into gaps.
    const measured = await source('measured', 'v', 10, { ageSeconds: 5 });
    const lower = await makeFactory(
      'Lower',
      [{ key: 'v', formula: `channel(${String(measured)}, 'v') * 2` }],
      { maxAgeSeconds: 86_400 },
    );
    const upper = await makeFactory(
      'Upper',
      [{ key: 'v', formula: `channel(${String(lower)}, 'v') + 1` }],
      { maxAgeSeconds: 30 },
    );

    await factory.sweep();
    assert.equal(valueOf(lower, 'v'), 20);
    assert.equal(valueOf(upper, 'v'), 21);
  });

  it('falls back to the default when a stored cut-off is not a usable number', async () => {
    // Params are whatever is in the row. `Math.max(0, NaN)` is `NaN`, so the query's interval
    // parameter becomes the string `"NaN"` and PostgreSQL answers `invalid input syntax for type
    // interval` — throwing the one query the whole sweep depends on, so a single unparseable row
    // stops every factory in the installation. This guards the fix rather than the original
    // defect.
    const measured = await source('measured', 'v', 42, { ageSeconds: 3_000 });
    const formula = [{ key: 'v', formula: `channel(${String(measured)}, 'v')` }];
    const broken = await makeFactory('Broken', formula, { maxAgeSeconds: 60 });
    const strict = await makeFactory('Strict', formula, { maxAgeSeconds: 60 });
    await db.query(
      `UPDATE sensor_config SET params = jsonb_set(params, '{maxAgeSeconds}', '"whenever"')
       WHERE object_id = $1`,
      [broken],
    );

    await factory.sweep();
    assert.equal(valueOf(broken, 'v'), undefined, 'the default, not no cut-off at all');
    assert.equal(valueOf(strict, 'v'), undefined, 'and the neighbour is untouched');
  });

  it('propagates a gap up a factory stack instead of last sweep’s number', async () => {
    // `P-69`. `#readInputs` loads the latest stored sample for every referenced channel, and a
    // factory read by another factory has samples of its own — real ingestion writes them. So
    // when the lower one gaps, its *previous* reading is sitting in the shared map and the upper
    // one computes from it, which is exactly what the dependency ordering exists to prevent:
    // "this sweep's value rather than last sweep's" has to mean a gap when this sweep produced
    // nothing.
    //
    // The stored row is written by hand because this harness's `ingest` collects results rather
    // than storing them — which is also why nothing here noticed.
    const measured = await source('measured', 'v', 10);
    const lower = await makeFactory('Lower', [
      { key: 'v', formula: `channel(${String(measured)}, 'v') * 2` },
    ]);
    const upper = await makeFactory('Upper', [
      { key: 'v', formula: `channel(${String(lower)}, 'v') + 1` },
    ]);

    await factory.sweep();
    assert.equal(valueOf(lower, 'v'), 20);
    assert.equal(valueOf(upper, 'v'), 21);

    // What ingestion would have written for `lower` on that sweep: the channel its result names,
    // and a row in it. Creating a factory declares a channel called `value`; the keys its
    // formulas actually report under only exist once something has ingested them, which is why
    // this has to be done by hand in a harness whose `ingest` collects rather than stores.
    const [lowerChannel] = await db.query<{ id: string }>(
      `INSERT INTO channel (sensor_id, key, name, unit) VALUES ($1, 'v', 'v', '')
       ON CONFLICT (sensor_id, key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [lower],
    );
    await db.query(`INSERT INTO sample (channel_id, time, value) VALUES ($1, now(), 20)`, [
      Number(lowerChannel?.id),
    ]);
    // Now take away only what `lower` reads. Its own stored 20 stays exactly where real
    // ingestion left it.
    await db.query(
      `DELETE FROM sample WHERE channel_id IN (SELECT id FROM channel WHERE sensor_id = $1)`,
      [measured],
    );
    ingested = [];
    await factory.sweep();

    assert.equal(valueOf(lower, 'v'), undefined, 'its own source is gone');
    assert.equal(
      valueOf(upper, 'v'),
      undefined,
      'and the gap reaches the factory above, rather than the 20 it stored a moment ago',
    );
  });

  it('fails rather than reporting nothing when every channel gapped', async () => {
    // Not a reading of none: every source this sensor is built on is missing, which is a fault
    // of its own rather than a quiet period.
    const x = await source('decommissioned-x', 'x', 1);
    const y = await source('decommissioned-y', 'y', 2);
    const gone = await makeFactory('All missing', [
      { key: 'a', formula: `channel(${String(x)}, 'x')` },
      { key: 'b', formula: `channel(${String(y)}, 'y')` },
    ]);
    await removed(x);
    await removed(y);

    await factory.sweep();
    assert.equal(resultFor(gone)?.outcome, 'error');
    assert.deepEqual(resultFor(gone)?.channels, []);
    assert.match(resultFor(gone)?.message ?? '', /none of this Sensor Factory’s formulas/);
  });

  it('fails the sensor with a broken formula, not the whole sweep', async () => {
    // A typo in one factory must not stop every other factory in the installation reporting.
    const a = await source('uplink-a', 'traffic.in', 100);
    const broken = await makeFactory('Broken', [{ key: 'x', formula: 'sqrt(4)' }]);
    const fine = await makeFactory('Fine', [
      { key: 'x', formula: `channel(${String(a)}, 'traffic.in')` },
    ]);

    await factory.sweep();
    assert.equal(resultFor(broken)?.outcome, 'error');
    assert.match(resultFor(broken)?.message ?? '', /no function called "sqrt"/);
    assert.equal(resultFor(fine)?.outcome, 'ok');
    assert.equal(valueOf(fine, 'x'), 100);
  });

  it('refuses a factory that reads itself, naming the loop', async () => {
    const self = await makeFactory('Ouroboros', [{ key: 'x', formula: '1' }]);
    // The formula has to name the sensor's own id, which is only known after it exists.
    await db.query(
      `UPDATE sensor_config SET params = jsonb_set(params, '{channels,0,formula}', $2::jsonb)
       WHERE object_id = $1`,
      [self, JSON.stringify(`channel(${String(self)}, 'x')`)],
    );

    await factory.sweep();
    assert.equal(resultFor(self)?.outcome, 'error');
    assert.match(resultFor(self)?.message ?? '', /part of a loop/);
    assert.equal(factory.stats().cycles, 1);
  });

  it('refuses a ring of three, and every member of it', async () => {
    const a = await makeFactory('A', [{ key: 'x', formula: '1' }]);
    const b = await makeFactory('B', [{ key: 'x', formula: '1' }]);
    const c = await makeFactory('C', [{ key: 'x', formula: '1' }]);
    const ring: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [from, to] of ring) {
      await db.query(
        `UPDATE sensor_config SET params = jsonb_set(params, '{channels,0,formula}', $2::jsonb)
         WHERE object_id = $1`,
        [from, JSON.stringify(`channel(${String(to)}, 'x')`)],
      );
    }

    await factory.sweep();
    for (const id of [a, b, c]) {
      assert.equal(resultFor(id)?.outcome, 'error', `sensor ${String(id)}`);
      assert.match(resultFor(id)?.message ?? '', /part of a loop/);
    }
  });

  it('lets a factory read a factory, in this sweep rather than the last', async () => {
    // A layer of staleness per level would be a whole scan interval each; on a three-layer stack
    // that is minutes of lag for no reason.
    const a = await source('uplink-a', 'traffic.in', 100);
    const first = await makeFactory('Doubled', [
      { key: 'x', formula: `channel(${String(a)}, 'traffic.in') * 2` },
    ]);
    const second = await makeFactory('Doubled again', [
      { key: 'x', formula: `channel(${String(first)}, 'x') * 2` },
    ]);

    await factory.sweep();
    assert.equal(valueOf(first, 'x'), 200);
    assert.equal(valueOf(second, 'x'), 400, 'it saw this sweep’s value, not last sweep’s');
  });

  it('leaves a paused factory alone', async () => {
    const a = await source('uplink-a', 'traffic.in', 100);
    const paused = await makeFactory('Paused', [
      { key: 'x', formula: `channel(${String(a)}, 'traffic.in')` },
    ]);
    await db.query('UPDATE sensor_runtime SET paused_manually = true WHERE object_id = $1', [
      paused,
    ]);

    await factory.sweep();
    assert.equal(resultFor(paused), undefined);
  });

  it('does nothing at all when there are no factory sensors', async () => {
    assert.equal(await factory.sweep(), 0);
    assert.equal(ingested.length, 0);
  });

  it('holds a factory over a lost probe’s sensor, and one built on it, instead of failing them (M-26)', async () => {
    // Its inputs record nothing, so once its maximum age ran out every channel gapped and it
    // reported an error: Down, and a page beside the probe's own alarm.
    const far = await source('far', 'rtt', 5, { ageSeconds: 3_600, state: 'unknown' });
    await db.query(`UPDATE sensor_runtime SET cause = 'probe' WHERE object_id = $1`, [far]);
    const hidden = await source('hidden', 'rtt', 7, { ageSeconds: 3_600 });
    const live = await source('near', 'rtt', 9);

    const over = await makeFactory('Over far', [
      { key: 'v', formula: `channel(${String(far)}, 'rtt')` },
    ]);
    const above = await makeFactory('Over that', [
      { key: 'v', formula: `channel(${String(over)}, 'v') * 2` },
    ]);
    // Partly on the lost probe and partly withheld is still not measured, and the probe's.
    const both = await makeFactory('Far and hidden', [
      { key: 'v', formula: `channel(${String(far)}, 'rtt') + channel(${String(hidden)}, 'rtt')` },
    ]);
    // One that can compute a channel computes it.
    const mixed = await makeFactory('Far and near', [
      { key: 'far', formula: `channel(${String(far)}, 'rtt')` },
      { key: 'near', formula: `channel(${String(live)}, 'rtt')` },
    ]);
    // And one missing something that is simply missing is its own fault, as it always was.
    const partly = await makeFactory('Far and nothing', [
      { key: 'far', formula: `channel(${String(far)}, 'rtt')` },
      { key: 'none', formula: `channel(${String(live)}, 'never-recorded')` },
    ]);

    const settled: ReadonlyMap<number, readonly number[]>[] = [];
    factory = new FactoryService({
      vouching: { ...everyVoucherHolds, withheld: () => new Map([[hidden, 'withheld']]) },
      reach: {
        settle: (next) => {
          settled.push(next);
          return Promise.resolve(0);
        },
      },
      db,
      logger: silentLogger,
      ingest: (results) => {
        ingested.push(...results);
        return Promise.resolve();
      },
    });
    await factory.sweep();

    assert.deepEqual(
      [...(settled.at(-1) ?? new Map()).entries()].sort(([a], [b]) => a - b),
      [
        [over, [far]],
        [above, [far]],
        [both, [far]],
      ].sort(([a], [b]) => Number(a) - Number(b)),
      'each held with the sensors it lacks on the probe that is away, through the factory between',
    );
    for (const id of [over, above, both]) {
      assert.equal(resultFor(id), undefined, `nothing recorded for ${String(id)}: a gap`);
    }
    assert.equal(resultFor(mixed)?.outcome, 'ok');
    assert.equal(valueOf(mixed, 'near'), 9);
    assert.equal(resultFor(partly)?.outcome, 'error');
    assert.equal(factory.stats().unreached, 3);

    // Back: measured again, and everything computes, held by nothing.
    await db.query(
      `INSERT INTO sample (channel_id, time, value)
       SELECT id, now(), 6 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
      [far],
    );
    await db.query(
      `UPDATE sensor_runtime SET state = 'up', cause = 'scan', last_result_at = now()
       WHERE object_id = $1`,
      [far],
    );
    ingested = [];
    await factory.sweep();
    assert.equal(settled.at(-1)?.size, 0);
    assert.equal(valueOf(above, 'v'), 12);
  });

  it('keeps a factory held once its input’s probe is back, until the input reports, for no longer than its maximum age (M-26)', async () => {
    // A sensor on a probe that has come back reads its last reading at once, and nothing is
    // measured until its first result: a spool replays oldest first. Failing the factory in
    // that interval would page Down beside the probe's return, for the outage's readings.
    const lost = async (name: string): Promise<number> => {
      const id = await source(name, 'rtt', 5, { ageSeconds: 3_600, state: 'unknown' });
      await db.query(
        `UPDATE sensor_runtime SET cause = 'probe', last_result_at = now() - interval '1 hour'
         WHERE object_id = $1`,
        [id],
      );
      return id;
    };
    const slow = await lost('slow');
    const quick = await lost('quick');
    const rested = await lost('rested');
    const waits = await makeFactory('Waits', [
      { key: 'v', formula: `channel(${String(slow)}, 'rtt')` },
    ]);
    const answered = await makeFactory('Answered', [
      { key: 'v', formula: `channel(${String(quick)}, 'rtt')` },
    ]);
    const paused = await makeFactory('Paused', [
      { key: 'v', formula: `channel(${String(rested)}, 'rtt')` },
    ]);
    // Over the same input as the first, and waiting a minute where that one waits ten.
    const brief = await makeFactory(
      'Brief',
      [{ key: 'v', formula: `channel(${String(slow)}, 'rtt')` }],
      { maxAgeSeconds: 60 },
    );

    let clock = Date.now();
    const settled: ReadonlyMap<number, readonly number[]>[] = [];
    factory = new FactoryService({
      vouching: everyVoucherHolds,
      reach: {
        settle: (next) => {
          settled.push(next);
          return Promise.resolve(0);
        },
      },
      db,
      logger: silentLogger,
      ingest: (results) => {
        ingested.push(...results);
        return Promise.resolve();
      },
      now: () => new Date(clock),
    });
    const heldNow = (): number[] => [...(settled.at(-1)?.keys() ?? [])].sort((a, b) => a - b);
    await factory.sweep();
    assert.deepEqual(
      heldNow(),
      [waits, answered, paused, brief].sort((a, b) => a - b),
    );

    // Back: each reads its last reading. One has reported since, a Down result that recorded
    // nothing, and one has been paused; the third has done neither.
    await db.query(
      `UPDATE sensor_runtime SET state = 'up', cause = 'scan' WHERE object_id = ANY($1::int[])`,
      [[slow, quick, rested]],
    );
    await db.query(
      `UPDATE sensor_runtime SET state = 'down', last_result_at = now() WHERE object_id = $1`,
      [quick],
    );
    await db.query(
      `UPDATE sensor_runtime SET state = 'paused', cause = 'user' WHERE object_id = $1`,
      [rested],
    );
    clock += 90_000;
    ingested = [];
    await factory.sweep();
    assert.deepEqual(heldNow(), [waits], 'the one still waiting for its input stays held');
    assert.equal(resultFor(waits), undefined, 'a gap, and not an error');
    assert.equal(resultFor(answered)?.outcome, 'error', 'reported, and still nothing: its own');
    assert.equal(resultFor(paused)?.outcome, 'error', 'paused is not the outage’s');
    assert.equal(resultFor(brief)?.outcome, 'error', 'past its own maximum age of waiting');

    // Nothing inside its own maximum age of being seen away: the outage is no longer the reason.
    clock += 511_000;
    ingested = [];
    await factory.sweep();
    assert.deepEqual(heldNow(), []);
    assert.equal(resultFor(waits)?.outcome, 'error');
  });
});

describe('the factory sweep', () => {
  it('skips an overlapping tick rather than queueing it, and counts it', async () => {
    // The same rule the probe's pool follows for a sensor: two overlapping sweeps would write
    // two results for the same second and race each other's state transitions.
    let running = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const service = {
      sweep: async (): Promise<number> => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running -= 1;
        return 0;
      },
    } as unknown as FactoryService;

    const sweep = new FactorySweep({ service, logger: silentLogger, intervalMs: 60_000 });
    const first = sweep.tick();
    await sweep.tick();
    assert.equal(sweep.skipped, 1);
    release?.();
    await first;
    assert.equal(peak, 1);
  });

  it('survives a sweep that throws, so the next one still runs', async () => {
    let calls = 0;
    const service = {
      sweep: (): Promise<number> => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('the database went away'))
          : Promise.resolve(0);
      },
    } as unknown as FactoryService;

    const sweep = new FactorySweep({ service, logger: silentLogger, intervalMs: 60_000 });
    await sweep.tick();
    await sweep.tick();
    assert.equal(calls, 2);
  });
});

describe('the factories held for their inputs’ probe (`M-26`)', () => {
  function reachOver(fails = false) {
    const calls: string[] = [];
    const reach = new FactoryReach({
      db: { tx: (fn) => fn({} as never) },
      logger: silentLogger,
      states: {
        reevaluate: (_q, ids, _at, cause) => {
          calls.push(`reevaluate ${ids.join(',')} ${cause.sources?.join(',') ?? ''}`);
          assert.equal(cause.message, UNREACHED_MESSAGE);
          return fails ? Promise.reject(new Error('could not serialize')) : Promise.resolve(1);
        },
      },
      dependencies: {
        holdWithheld: (_q, ids) => {
          calls.push(`hold ${ids.join(',')}`);
          return Promise.resolve();
        },
        returnWithheld: (_q, ids) => {
          calls.push(`return ${ids.join(',')}`);
          return Promise.resolve();
        },
        recompute: () => {
          calls.push('recompute');
          return Promise.resolve({ moved: 0 });
        },
      },
    });
    return { reach, calls };
  }

  it('re-decides only what crossed, as cause probe, keeping a Down master holding', async () => {
    const { reach, calls } = reachOver();
    await reach.settle(new Map([[1, [9]]]));
    assert.deepEqual(calls, ['hold 1', 'reevaluate 1 probe', 'return ', 'recompute']);
    assert.deepEqual([...reach.unreached()], [1]);
    assert.deepEqual(reach.inputsOf(1), [9]);

    calls.length = 0;
    await reach.settle(new Map([[1, [8]]]));
    assert.deepEqual(calls, [], 'nothing crossed');
    assert.deepEqual(reach.inputsOf(1), [8], 'but what it lacks is kept current');

    await reach.settle(new Map());
    assert.deepEqual(calls, ['hold ', 'reevaluate 1 probe', 'return 1', 'recompute']);
    assert.equal(reach.unreached().size, 0);
  });

  it('takes the set back when the write fails, so the next sweep tries again', async () => {
    const { reach } = reachOver(true);
    assert.equal(await reach.settle(new Map([[1, [9]]])), 0);
    assert.equal(reach.unreached().size, 0);
    assert.equal(reach.inputsOf(1), undefined);
  });
});
