import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { HousekeepingConfig } from '@ms/shared';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import { StateLogService } from '../src/timeseries/state-log.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

/**
 * State-history retention that cannot lose current state (`S-15`).
 *
 * **The bug this exists to prevent, in one sentence:** a sensor that has sat Up for three years
 * has exactly one row in `sensor_state`, three years old — and `drop_chunks` would take it,
 * leaving the sensor with no known state at all. `CLAUDE.md` computes uptime and SLA from this
 * table rather than from samples, so that is not a gap in a graph, it is a sensor that has never
 * been anything.
 */

const available = await databaseAvailable();

const DAY_MS = 86_400_000;

function housekeeping(stateDays: number): HousekeepingConfig {
  return {
    enabled: false,
    intervalSeconds: 300,
    rollupLagSeconds: 0,
    retention: {
      rawDays: 40,
      fiveMinuteDays: 365,
      hourlyDays: 730,
      dailyDays: 3_650,
      auditDays: 730,
      stateDays,
      reportDays: 90,
      reportRunDays: 730,
    },
    compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
    disk: { path: '', evictBelowPercent: 10, recoverAbovePercent: 15, minimumRetainedHours: 48 },
  };
}

describe('state-history retention', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let quietId = 0;
  let busyId = 0;

  before(async () => {
    scratch = await createScratchDatabase('stateretention');
    db = scratch.db;
    const harness = await buildHarness(db);
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: 'retention-probe',
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'box',
      host: '127.0.0.1',
    });
    for (const name of ['Quiet', 'Busy']) {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name,
        sensorType: 'icmp.ping',
        params: {},
      });
      if (name === 'Quiet') quietId = sensor.id;
      else busyId = sensor.id;
    }
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM sensor_state');
  });

  /** Places a transition at a chosen age, which is the whole point of these tests. */
  const place = async (
    sensorId: number,
    daysAgo: number,
    state = 'up',
    cause = 'scan',
  ): Promise<void> => {
    await db.query(
      `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
       VALUES (now() - make_interval(days => $1::int), $2, $3::sensor_state_kind, NULL,
               $4::sensor_state_cause, 'placed by a test')`,
      [daysAgo, sensorId, state, cause],
    );
  };

  const rows = async (sensorId: number) =>
    db.query<{ state: string; cause: string; carried: boolean; time: Date }>(
      `SELECT state::text AS state, cause::text AS cause, carried, time
       FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
      [sensorId],
    );

  const sweep = (stateDays: number): Promise<{ anchoredSensors: number }> =>
    new Housekeeper({ db, logger: silent, config: housekeeping(stateDays) }).runOnce();

  it('carries a quiet sensor’s state past the horizon rather than losing it', async () => {
    // The ticket's own test: age a sensor that has not changed state in years past the horizon
    // and assert its state survives.
    await place(quietId, 900, 'up', 'scan');
    const report = await sweep(365);

    assert.equal(report.anchoredSensors, 1);
    const kept = await rows(quietId);
    assert.equal(kept.length, 1, 'exactly one row: the anchor');
    const anchor = kept[0];
    assert.ok(anchor !== undefined);
    assert.equal(anchor.state, 'up', 'and it is the state the sensor was actually in');
    assert.equal(anchor.cause, 'scan', 'with the cause it was in that state for');
    assert.equal(anchor.carried, true, 'marked, so nobody reads it as a transition');
  });

  it('places the anchor at the horizon, not at the row it replaced', async () => {
    // At the horizon because that is the oldest instant the retained history covers. Placing it
    // where the original row was would put it back inside the range about to be dropped.
    await place(quietId, 900);
    await sweep(365);

    const kept = await rows(quietId);
    const age = (Date.now() - (kept[0]?.time.getTime() ?? 0)) / DAY_MS;
    assert.ok(age > 364 && age < 366, `the anchor sits at the horizon, not at ${String(age)} days`);
  });

  it('leaves a sensor with newer history alone', async () => {
    // Its state is known from the row that survives, and that row's `previousState` still says
    // what came before. Anchoring it too would write a row per sensor per pass for nothing.
    await place(busyId, 900, 'down');
    await place(busyId, 10, 'up');
    const report = await sweep(365);

    assert.equal(report.anchoredSensors, 0);
    const kept = await rows(busyId);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.carried, false, 'the survivor is the real transition');
  });

  it('anchors once and then stops, however many passes run', async () => {
    // **The property that makes this affordable.** The condition is "this sensor now has no rows
    // at all", which is exact: after the first anchor the sensor has one, so a pass every five
    // minutes writes nothing. Anchoring *before* the drop instead would have written a row on
    // every pass for as long as the sensor stayed quiet.
    await place(quietId, 900);
    assert.equal((await sweep(365)).anchoredSensors, 1);
    assert.equal((await sweep(365)).anchoredSensors, 0);
    assert.equal((await sweep(365)).anchoredSensors, 0);
    assert.equal((await rows(quietId)).length, 1);
  });

  it('does nothing at all when there is no history older than the horizon', async () => {
    await place(busyId, 10);
    const report = await sweep(365);
    assert.equal(report.anchoredSensors, 0);
    assert.equal((await rows(busyId)).length, 1);
  });

  it('does not resurrect a sensor that no longer exists', async () => {
    // Its history is on its way out with it. Anchoring it would keep a deleted sensor's state
    // alive for ever, one pass at a time.
    await db.query(
      `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
       VALUES (now() - interval '900 days', 999999, 'up', NULL, 'scan', 'a sensor long gone')`,
    );
    const report = await sweep(365);
    assert.equal(report.anchoredSensors, 0);
    const left = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = 999999',
    );
    assert.equal(left[0]?.n, '0');
  });

  it('carries the state each sensor was actually in, not one state for all of them', async () => {
    await place(quietId, 900, 'up', 'scan');
    await place(busyId, 900, 'down', 'limit');
    const report = await sweep(365);

    assert.equal(report.anchoredSensors, 2);
    assert.equal((await rows(quietId))[0]?.state, 'up');
    assert.equal((await rows(busyId))[0]?.state, 'down');
    assert.equal((await rows(busyId))[0]?.cause, 'limit');
  });

  it('carries the newest state, not the oldest', async () => {
    // A sensor that went Down and then back Up, both before the horizon, is Up.
    await place(quietId, 900, 'down');
    await place(quietId, 700, 'up');
    await sweep(365);

    const kept = await rows(quietId);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.state, 'up');
  });

  it('shows the anchor in the state log as carried rather than as a transition', async () => {
    // An operator scrolling to the oldest thing the log still holds deserves to be told that
    // this is the floor of the history rather than its beginning.
    await place(quietId, 900, 'warning', 'lookup');
    await sweep(365);

    const log = new StateLogService({ db, logger: silent });
    const page = await log.list({ objectId: quietId, limit: 10 });
    assert.equal(page.items.length, 1);
    const entry = page.items[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.carried, true);
    assert.equal(entry.state, 'warning');
    assert.equal(entry.durationMs, null, 'it is the state the sensor is still in');
  });

  it('leaves the state a real transition writes unmarked', async () => {
    await place(busyId, 1);
    const log = new StateLogService({ db, logger: silent });
    const page = await log.list({ objectId: busyId, limit: 10 });
    assert.equal(page.items[0]?.carried, false);
  });
});
