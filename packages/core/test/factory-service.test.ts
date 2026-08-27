import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
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
    const total = await makeFactory('Total inbound', [
      { key: 'known', formula: `channel(${String(a)}, 'traffic.in')` },
      { key: 'total', formula: `channel(${String(a)}, 'traffic.in') + channel(99999, 'x')` },
    ]);

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

  it('fails rather than reporting nothing when every channel gapped', async () => {
    // Not a reading of none: every source this sensor is built on is missing, which is a fault
    // of its own rather than a quiet period.
    const gone = await makeFactory('All missing', [
      { key: 'a', formula: "channel(99999, 'x')" },
      { key: 'b', formula: "channel(99998, 'y')" },
    ]);

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
    const self = await makeFactory('Ouroboros', [{ key: 'x', formula: "channel(0, 'x')" }]);
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
