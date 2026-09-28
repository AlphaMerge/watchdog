import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CORE_HEALTH_CHANNELS, CORE_HEALTH_COUNTERS } from '@ms/sensors';
import type { AvailableMemoryLow, CheckResult } from '@ms/shared';
import {
  CoreHealthService,
  readingsFrom,
  type CoreHealthReading,
  type CoreHealthSources,
} from '../src/health/core-health.js';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * The core watching itself (`P-12`).
 *
 * `CLAUDE.md` makes this a rule: any subsystem with a queue, a pool or a connection reports on
 * Core Health. The tests that matter here are the ones about *not lying* — a rate that has not
 * been measured yet is a gap and not 0%, a daily rollup tier is not 86,400 seconds behind for
 * being a daily tier, and a read that fails records no channel values at all rather than a row
 * of zeros that a graph would draw as a healthy floor.
 */

const available = await databaseAvailable();

/** Numbers a test can move one at a time. */
function sources(
  overrides: Partial<{
    queuedRows: number;
    refusedRows: number;
    dependencyPauses: number;
    deferredReactions: number;
    p95: number;
    overflowed: number;
    severed: number;
    signedOut: { ended: number; expired: number; revoked: number; disabled: number };
    credentialCheckFailures: number;
    probesDown: number;
    probesSilent: number;
    pending: number;
    failed: number;
    oldestPendingAgeMs: number;
    deliveryThrows: boolean;
    alarmsFired: number;
    nextWakeAt: Date | null;
    queriesRefused: number;
    reportsDeferred: number;
    reportsFailed: number;
    reportsUndelivered: number;
    reportFormatsWaiting: number;
    reportFormatsRefused: number;
    resultsFutureDated: number;
    disk: { freePercent: number; freeBytes: number; databaseBytes: number } | null;
    evictedChunks: number;
    machineMemory: AvailableMemoryLow | null;
    limitMemory: AvailableMemoryLow | null;
  }> = {},
): CoreHealthSources {
  return {
    // Null by default, which is a core that cannot speak for a disk (`S-17`) — the case every
    // other test in this file is in, and the one whose channels must be gaps rather than zeros.
    disk: () => overrides.disk ?? null,
    evictedChunks: () => overrides.evictedChunks ?? 0,
    // Null by default too: a platform that cannot say, whose two channels must gap (`P-208`).
    machineMemory: () => overrides.machineMemory ?? null,
    // And no ceiling: a core outside any cgroup limit, whose two channels must gap (`P-210`).
    limitMemory: () => overrides.limitMemory ?? null,
    ingestion: () => ({
      queuedRows: overrides.queuedRows ?? 0,
      refusedRows: overrides.refusedRows ?? 0,
      dependencyPauses: overrides.dependencyPauses ?? 0,
      deferredReactions: overrides.deferredReactions ?? 0,
      writeMs: { p95: overrides.p95 ?? 0 },
    }),
    stream: () => ({
      overflowed: overrides.overflowed ?? 0,
      severed: overrides.severed ?? 0,
      signedOut: overrides.signedOut ?? { ended: 0, expired: 0, revoked: 0, disabled: 0 },
      credentialCheckFailures: overrides.credentialCheckFailures ?? 0,
    }),
    alarms: () => ({
      fired: overrides.alarmsFired ?? 0,
      nextWakeAt: overrides.nextWakeAt ?? null,
    }),
    reports: () => ({
      deferred: overrides.reportsDeferred ?? 0,
      failed: overrides.reportsFailed ?? 0,
      undelivered: overrides.reportsUndelivered ?? 0,
      formatsWaiting: overrides.reportFormatsWaiting ?? 0,
      formatsRefused: overrides.reportFormatsRefused ?? 0,
    }),
    queries: () => ({ refused: overrides.queriesRefused ?? 0 }),
    ingestionDiscards: () => ({ discardedFutureTime: overrides.resultsFutureDated ?? 0 }),
    probes: () => ({
      probesDown: overrides.probesDown ?? 0,
      probesSilent: overrides.probesSilent ?? 0,
    }),
    delivery: () => {
      if (overrides.deliveryThrows === true) {
        return Promise.reject(new Error('the notification queue would not answer'));
      }
      return Promise.resolve({
        pending: overrides.pending ?? 0,
        failed: overrides.failed ?? 0,
        oldestPendingAgeMs: overrides.oldestPendingAgeMs ?? 0,
      });
    },
  };
}

/** A clock and a CPU meter a test drives, so nothing here measures the test runner. */
function fakeProcess(script: {
  cpuUs: number[];
  elapsedNs: number[];
  rss?: number;
  heapUsed?: number;
  uptime?: number;
}): NonNullable<ConstructorParameters<typeof CoreHealthService>[0]['process']> {
  let cpuCall = 0;
  let clockCall = 0;
  let cpu = 0;
  let clock = 0n;
  return {
    cpuUsage: () => {
      cpu += script.cpuUs[cpuCall] ?? 0;
      cpuCall += 1;
      // Split across user and system on purpose: the percentage is the sum of both, and a
      // reading that only counted user time would under-report a core busy in the kernel.
      return { user: Math.floor(cpu / 2), system: cpu - Math.floor(cpu / 2) };
    },
    memoryUsage: () => ({ rss: script.rss ?? 0, heapUsed: script.heapUsed ?? 0 }),
    uptime: () => script.uptime ?? 0,
    hrtime: () => {
      clock += BigInt(script.elapsedNs[clockCall] ?? 0);
      clockCall += 1;
      return clock;
    },
  };
}

describe('the Core Health sensor', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let rootId = 0;
  let deviceId = 0;

  before(async () => {
    scratch = await createScratchDatabase('corehealth');
    db = scratch.db;
    const harness = await buildHarness(db);
    rootId = harness.rootId;
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: rootId,
      name: 'health-probe',
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'core',
      host: '127.0.0.1',
    });
    deviceId = device.id;
    // Two sensors of the type, because "read once, report to all of them" is a claim.
    for (const name of ['Core Health', 'Core Health (second)']) {
      await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name,
        sensorType: 'ms.core.health',
        params: {},
      });
    }
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM rollup_watermark');
    await db.query('DELETE FROM rollup_backfill');
    await db.query('DELETE FROM channel_reap');
  });

  const build = (
    overrides: Parameters<typeof sources>[0] = {},
    script: Parameters<typeof fakeProcess>[0] = { cpuUs: [], elapsedNs: [] },
    ingest: (results: readonly CheckResult[]) => Promise<void> = () => Promise.resolve(),
    now?: () => Date,
  ): CoreHealthService =>
    new CoreHealthService({
      db,
      logger: silent,
      sources: sources(overrides),
      ingest,
      process: fakeProcess(script),
      ...(now === undefined ? {} : { now }),
    });

  describe('reading the numbers', () => {
    it('produces every channel the type declares', async () => {
      // The defect this catches is a channel added to the sensor type and never sourced: it
      // would be declared, drawn in the legend, and never carry a reading, which looks exactly
      // like a subsystem that has stopped reporting.
      const service = build({}, { cpuUs: [0, 1_000], elapsedNs: [0, 1_000_000] });
      await service.read();
      const reading = await service.read();
      for (const key of CORE_HEALTH_CHANNELS) {
        assert.ok(key in reading, `${key} was declared and never read`);
      }
      assert.equal(Object.keys(reading).length, CORE_HEALTH_CHANNELS.length);
    });

    it('reports CPU as a gap the first time and a rate afterwards', async () => {
      // A rate needs two samples. Reporting 0% for the first would say the core is idle, which
      // is a claim about the machine rather than about the measurement — `CLAUDE.md`'s no-data
      // rule applied to something that is not a device reading.
      const service = build({}, { cpuUs: [0, 500_000], elapsedNs: [0, 1_000_000_000] });
      assert.equal((await service.read())['cpu'], null);
      assert.equal((await service.read())['cpu'], 50);
    });

    it('measures CPU against the interval, not against uptime', async () => {
      // Lifetime CPU over lifetime wall clock converges on a flat line and never rises during an
      // incident, which is the one moment the number is worth having.
      const service = build(
        {},
        { cpuUs: [0, 100_000, 900_000], elapsedNs: [0, 1_000_000_000, 1_000_000_000] },
      );
      await service.read();
      assert.equal((await service.read())['cpu'], 10);
      assert.equal(
        (await service.read())['cpu'],
        90,
        'the second interval, not the average of both',
      );
    });

    it('lets CPU past 100, because a saturated event loop is the thing worth seeing', async () => {
      // Normalising by core count would report a core saturating one thread as 12% busy on a
      // sixteen-core box.
      const service = build({}, { cpuUs: [0, 2_400_000], elapsedNs: [0, 1_000_000_000] });
      await service.read();
      assert.equal((await service.read())['cpu'], 240);
    });

    it('keeps the sweep’s CPU baseline separate from the route’s', async () => {
      // A dashboard polling `/core-health` every two seconds would otherwise turn the *recorded*
      // channel into a two-second sample: every reading honest, the history noisier for being
      // watched, and a burst that happened between two polls attributed to whichever second the
      // last poll landed in.
      //
      // Five one-second intervals, with 0.9 s of CPU burned in the third. The sweep spans all
      // four intervals since its own last reading and should report 25%; a meter shared with the
      // route would hand it the last one-second interval alone and report 10%.
      const batches: CheckResult[][] = [];
      const service = build(
        {},
        { cpuUs: [0, 0, 900_000, 0, 100_000], elapsedNs: Array<number>(5).fill(1_000_000_000) },
        (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
      );
      await service.sweep();
      assert.equal((await service.read())['cpu'], null, 'the route’s own first reading is a gap');
      assert.equal((await service.read())['cpu'], 90, 'the route sees the burst');
      assert.equal((await service.read())['cpu'], 0);

      await service.sweep();
      const channels = batches[1]?.[0]?.channels ?? [];
      const cpu = channels.find((channel) => channel.key === 'cpu');
      assert.equal(cpu?.value, 25, 'the sweep spans its own interval, not the route’s last one');
    });

    it('reports memory in megabytes, resident and heap separately', async () => {
      // Separate because they move apart: a JavaScript leak shows in the heap while the resident
      // set is flat, and the two diverging is the shape of a native one.
      const service = build(
        {},
        { cpuUs: [], elapsedNs: [], rss: 268_435_456, heapUsed: 67_108_864 },
      );
      const reading = await service.read();
      assert.equal(reading['memory'], 256);
      assert.equal(reading['heap'], 64);
    });

    it('reports what the machine has left, and gaps where the platform cannot say', async () => {
      // `P-208`: the machine's memory rather than the core's, so a core beside a database that has
      // taken the rest is visible before the kernel picks something to kill.
      const measured = await build({
        machineMemory: {
          availablePercent: 8.5,
          availableBytes: 675 * 1024 * 1024,
          totalBytes: 7_936 * 1024 * 1024,
        },
      }).read();
      assert.equal(measured['memoryAvailable'], 8.5);
      assert.equal(measured['memoryAvailableBytes'], 675);

      // A zero on this channel is its error limit, so an unknown must be a gap and never a zero.
      const unknown = await build({ machineMemory: null }).read();
      assert.equal(unknown['memoryAvailable'], null);
      assert.equal(unknown['memoryAvailableBytes'], null);
    });

    it('reports how close the core is to its own ceiling, and gaps where it has none', async () => {
      // `P-210`: 2 GiB left under the stock unit's 8 GiB MemoryMax is 75% used.
      const limited = await build({
        limitMemory: {
          availablePercent: 25,
          availableBytes: 2_048 * 1024 * 1024,
          totalBytes: 8_192 * 1024 * 1024,
        },
      }).read();
      assert.equal(limited['memoryLimitUsage'], 75);
      assert.equal(limited['memoryLimit'], 8_192);

      const unlimited = await build({ limitMemory: null }).read();
      assert.equal(unlimited['memoryLimitUsage'], null);
      assert.equal(unlimited['memoryLimit'], null);
    });

    it('passes each subsystem’s own number through unchanged', async () => {
      const service = build({
        queuedRows: 41,
        refusedRows: 7,
        dependencyPauses: 3,
        p95: 12.5,
        overflowed: 2,
        probesDown: 1,
        pending: 9,
        failed: 4,
        oldestPendingAgeMs: 125_000,
      });
      const reading = await service.read();
      assert.equal(reading['ingestQueue'], 41);
      assert.equal(reading['ingestRefused'], 7);
      assert.equal(reading['dependencyPauses'], 3);
      assert.equal(reading['writeLatency'], 12.5);
      assert.equal(reading['streamCutoffs'], 2);
      // And a socket the route closed outright is one more client the core stopped serving (`A-30`).
      const closedToo = await build({ overflowed: 2, severed: 3 }).read();
      assert.equal(closedToo['streamCutoffs'], 5);
      // Signed out, one channel per reason, and the checks that could not say — which are not
      // cut-offs: a signed-out socket is one the core stopped serving *on purpose* (`A-34`).
      const signedOut = await build({
        signedOut: { ended: 4, expired: 3, revoked: 2, disabled: 1 },
        credentialCheckFailures: 6,
      }).read();
      assert.equal(signedOut['streamEnded'], 4);
      assert.equal(signedOut['streamExpired'], 3);
      assert.equal(signedOut['streamRevoked'], 2);
      assert.equal(signedOut['streamDisabled'], 1);
      assert.equal(signedOut['streamCheckFailures'], 6);
      assert.equal(signedOut['streamCutoffs'], 0);
      assert.equal(reading['probesDown'], 1);
      assert.equal(reading['notifyPending'], 9);
      assert.equal(reading['notifyFailed'], 4);
      assert.equal(reading['notifyOldest'], 125, 'milliseconds in, seconds out');
    });

    it('carries each of the reports’ own numbers to its own channel', async () => {
      // Five numbers from one source, all small integers: a test with them all zero cannot tell one
      // channel from another, nor a channel from a constant. Distinct values can.
      const reading = await build({
        reportsDeferred: 2,
        reportsFailed: 3,
        reportsUndelivered: 5,
        reportFormatsWaiting: 7,
        reportFormatsRefused: 11,
      }).read();
      assert.equal(reading['reportsDeferred'], 2);
      assert.equal(reading['reportsFailed'], 3);
      assert.equal(reading['reportsUndelivered'], 5);
      assert.equal(reading['reportFormatsWaiting'], 7);
      assert.equal(reading['reportFormatsRefused'], 11);
    });

    it('gaps the reports’ channels in a build that has no reporting (`H-12`)', async () => {
      // The v1 profile constructs no reporting, so there is no source. A zero would say nothing
      // failed, which is a claim about a subsystem that is not running.
      const { reports: _reports, ...withoutReports } = sources();
      const reading = await new CoreHealthService({
        db,
        logger: silent,
        sources: withoutReports,
        ingest: () => Promise.resolve(),
        process: fakeProcess({ cpuUs: [], elapsedNs: [] }),
      }).read();
      for (const key of [
        'reportsDeferred',
        'reportsFailed',
        'reportsUndelivered',
        'reportFormatsWaiting',
        'reportFormatsRefused',
      ]) {
        assert.ok(key in reading, `${key} should still be a channel`);
        assert.equal(reading[key], null, `${key} should be a gap`);
      }
      // And only those: everything else still reads.
      assert.equal(reading['ingestQueue'], 0);
    });

    it('reports the alarm sweep as overdue only once it actually is', async () => {
      // `P-22`. Zero is the answer almost always — a scheduler asleep with a wake ahead of it is
      // on time, and so is one that has never armed anything. Reporting "minus forty seconds" or
      // a gap for either would make the channel noise, and a channel that is noisy when nothing
      // is wrong is a channel nobody looks at when something is.
      const NOW = new Date('2026-08-29T10:00:00.000Z');
      const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
      const overdue = async (nextWakeAt: Date | null): Promise<number | null | undefined> =>
        (await build({ nextWakeAt }, undefined, undefined, () => NOW).read())['alarmOverdue'];

      assert.equal(await overdue(null), 0, 'nothing armed is not the same as stuck');
      assert.equal(await overdue(at(30_000)), 0, 'a wake still ahead is on time');
      assert.equal(await overdue(at(-1)), 0, 'a millisecond late is on time');
      assert.equal(await overdue(at(-40_000)), 40);
      assert.equal(await overdue(at(-3_600_000)), 3_600);
    });

    it('passes the alarm scheduler’s fired count through as a counter', async () => {
      // A counter rather than a gauge, so the counter path turns it into alarms per minute —
      // which is the shape an alarm storm has. It only ever climbs within one process.
      const reading = await build({ alarmsFired: 217 }).read();
      assert.equal(reading['alarmsFired'], 217);
    });

    it('carries the on-demand checks that were turned away', async () => {
      // `R-09` bounds how many run at once, and `CLAUDE.md` requires that bound to be visible:
      // a rising line here is a limit somebody has to raise, where the alternative is operators
      // quietly retrying a button that keeps refusing.
      const reading = await build({ queriesRefused: 5 }).read();
      assert.equal(reading['queriesRefused'], 5);
    });

    it('carries the alarm reactions a catch-up is holding', async () => {
      // **`P-157`.** `P-146` skipped the alarm reaction for a batch a probe is replaying, and
      // dropped it; deferring it instead is what stops an outage that began during a drain going
      // unalarmed. `CLAUDE.md`: nothing is deferred silently. A gauge rather than a counter,
      // because the shape is the message — it rises during a drain and comes back to zero, and
      // one that stays up is a probe whose sensors have no armed alarms.
      const reading = await build({ deferredReactions: 12 }).read();
      assert.equal(reading['reactionsDeferred'], 12);
    });

    it('carries the results refused for an implausible clock', async () => {
      // **`P-99`.** One result stamped years ahead used to freeze a sensor's history for ever,
      // because `last_result_at` is a high-water mark and everything genuine after it read as
      // stale. Refusing it fixes the freeze; this channel is what stops the refusal being the
      // new silence — `CLAUDE.md`: never drop without counting, and never count without
      // somewhere to see it.
      //
      // Zero on every healthy installation, so any movement is one probe host with a wrong
      // clock and names a fix an operator can carry out.
      const reading = await build({ resultsFutureDated: 3 }).read();
      assert.equal(reading['resultsFutureDated'], 3);
    });

    it('counts what is actually queued in the housekeeping tables', async () => {
      await db.query(
        `INSERT INTO rollup_backfill (from_time, to_time, reason)
         VALUES (now() - interval '1 hour', now(), 'test'), (now() - interval '2 hours', now(), 'test')`,
      );
      const channel = await db.query<{ id: number }>(
        `INSERT INTO channel (sensor_id, key, name, unit)
         SELECT object_id, 'reaped', 'Reaped', '' FROM sensor_config LIMIT 1 RETURNING id`,
      );
      await db.query('INSERT INTO channel_reap (channel_id) VALUES ($1)', [channel[0]?.id ?? 0]);

      const reading = await build().read();
      assert.equal(reading['backfillQueue'], 2);
      assert.equal(reading['reapQueue'], 1);
    });
  });

  describe('rollup lag', () => {
    it('is a gap when no tier has ever run, not an infinite lag', async () => {
      // A core that started a minute ago has not fallen behind. Reporting the age of the epoch
      // would page somebody on every fresh installation.
      assert.equal((await build().read())['rollupLag'], null);
    });

    it('subtracts each tier’s own bucket width, so a healthy daily tier reads zero', async () => {
      // **The subtraction is the whole point.** A one-day tier can only ever be materialised to
      // the last complete day, so `now - watermark` is up to 24 hours on a perfectly healthy
      // installation — and a channel carrying that would rank a healthy 1d tier as far worse
      // than a broken 5m one.
      await db.query(
        `INSERT INTO rollup_watermark (tier, watermark) VALUES
           ('sample_5m', now() - interval '5 minutes'),
           ('sample_1h', now() - interval '1 hour'),
           ('sample_1d', now() - interval '1 day')`,
      );
      const lag: number | null = (await build().read())['rollupLag'] ?? null;
      assert.ok(lag !== null && lag <= 2, `every tier is at its floor, got ${String(lag)}`);
    });

    it('reports the worst tier’s excess', async () => {
      await db.query(
        `INSERT INTO rollup_watermark (tier, watermark) VALUES
           ('sample_5m', now() - interval '5 minutes'),
           ('sample_1h', now() - interval '3 hours'),
           ('sample_1d', now() - interval '1 day')`,
      );
      const lag: number | null = (await build().read())['rollupLag'] ?? null;
      // Two hours beyond the hourly tier's own floor.
      assert.ok(lag !== null && lag >= 7_190 && lag <= 7_210, `got ${String(lag)}`);
    });

    it('ignores a tier that has no row rather than treating it as behind', async () => {
      await db.query(
        `INSERT INTO rollup_watermark (tier, watermark)
         VALUES ('sample_5m', now() - interval '5 minutes')`,
      );
      const lag: number | null = (await build().read())['rollupLag'] ?? null;
      assert.ok(lag !== null && lag <= 2, `got ${String(lag)}`);
    });
  });

  describe('turning a reading into channel readings', () => {
    it('leaves a gap out rather than sending it as zero', () => {
      // The rule this file exists to defend. A CPU channel reading 0% because nothing has been
      // measured is indistinguishable, on a graph and to a limit, from an idle core.
      const readings = readingsFrom({ ingestQueue: 3, cpu: null });
      assert.deepEqual(
        readings.map((reading) => reading.key),
        ['ingestQueue'],
      );
    });

    it('sends the declared counters as counter text, so the core makes them rates', () => {
      const readings = readingsFrom({
        ingestRefused: 12,
        streamCutoffs: 1,
        streamEnded: 8,
        streamExpired: 7,
        streamRevoked: 2,
        streamDisabled: 1,
        streamCheckFailures: 3,
        dependencyPauses: 4,
        alarmsFired: 217,
        queriesRefused: 5,
        ingestQueue: 0,
      });
      for (const reading of readings) {
        if (CORE_HEALTH_COUNTERS.has(reading.key)) {
          assert.equal(reading.counter, String(reading.value), reading.key);
          assert.equal(reading.counterBits, 64, reading.key);
        } else {
          assert.equal(reading.counter, undefined, reading.key);
        }
      }
      assert.equal(readings.length, 11);

      // Named rather than left to the loop above, which agrees with whatever the declaration
      // says and would go on passing if a channel quietly stopped being a counter. These
      // only ever climb, and a monotonic number sent as a gauge is a graph of a running total
      // where somebody wanted a rate.
      assert.deepEqual(
        readings.filter((reading) => reading.counter !== undefined).map((reading) => reading.key),
        [
          'ingestRefused',
          'streamCutoffs',
          'streamEnded',
          'streamExpired',
          'streamRevoked',
          'streamDisabled',
          'streamCheckFailures',
          'dependencyPauses',
          'alarmsFired',
          'queriesRefused',
        ],
      );
    });

    it('drops a value that is not finite', () => {
      const readings = readingsFrom({ ingestQueue: Number.NaN, cpu: 5 });
      assert.deepEqual(
        readings.map((reading) => reading.key),
        ['cpu'],
      );
    });

    it('keeps the declaration order, so a chart legend is stable', () => {
      const reading = Object.fromEntries(
        CORE_HEALTH_CHANNELS.map((key) => [key, 1]),
      ) as CoreHealthReading;
      assert.deepEqual(
        readingsFrom(reading).map((one) => one.key),
        [...CORE_HEALTH_CHANNELS],
      );
    });
  });

  describe('the route', () => {
    const serve = async (
      coreHealth: () => CoreHealthService | undefined,
    ): Promise<FastifyInstance> => {
      const harness = await buildHarness(db);
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        coreHealth,
      });
      await server.build('9.9.9', harness.service);
      return server.app;
    };

    it('serves every channel, whether or not a sensor exists', async () => {
      // The reason there is a route at all. An operator must be able to ask how the core is on a
      // fresh installation, and — the half that matters — a sensor's reading is a *row*, so the
      // one failure `WORKFLOW.MD §13` names, an unavailable database, is exactly when a sensor
      // cannot answer.
      const app = await serve(() => build({ queuedRows: 3 }));
      const response = await app.inject({ method: 'GET', url: '/api/v1/core-health' });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ at: string; channels: Record<string, number | null> }>();
      assert.ok(Date.parse(body.at) > 0);
      for (const key of CORE_HEALTH_CHANNELS) {
        assert.ok(key in body.channels, `${key} was not served`);
      }
      assert.equal(body.channels['ingestQueue'], 3);
      await app.close();
    });

    it('keeps a gap a gap through the response schema', async () => {
      // `additionalProperties: false` strips a field the schema does not declare, and a `number`
      // schema would turn a null into a stripped field or a zero. Either would be the sensor
      // telling the operator the core is idle when it means it has not measured yet.
      const app = await serve(() => build());
      const body = (await app.inject({ method: 'GET', url: '/api/v1/core-health' })).json<{
        channels: Record<string, number | null>;
      }>();
      assert.equal(body.channels['cpu'], null, 'the first reading has no interval to measure');
      await app.close();
    });

    it('says the core is starting rather than answering with zeros', async () => {
      // "Starting" and "every number is zero" are different facts, and a monitoring system may
      // not confuse them about itself.
      const app = await serve(() => undefined);
      const response = await app.inject({ method: 'GET', url: '/api/v1/core-health' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'CORE_STARTING');
      await app.close();
    });
  });

  describe('the sweep', () => {
    it('reports to every Core Health sensor there is, from one reading', async () => {
      const batches: CheckResult[][] = [];
      const service = build({ queuedRows: 5 }, { cpuUs: [], elapsedNs: [] }, (results) => {
        batches.push([...results]);
        return Promise.resolve();
      });
      const reported = await service.sweep();

      assert.equal(reported, 2);
      assert.equal(batches.length, 1, 'one batch, not one per sensor');
      const results = batches[0] ?? [];
      assert.equal(results.length, 2);
      assert.equal(new Set(results.map((result) => result.sensorId)).size, 2);
      // The same numbers on both: two sensors reading a millisecond apart would differ for no
      // reason an operator could act on.
      assert.deepEqual(results[0]?.channels, results[1]?.channels);
      assert.equal(results[0]?.outcome, 'ok');
    });

    it('does nothing at all when no such sensor exists', async () => {
      let called = 0;
      const service = new CoreHealthService({
        db: {
          query: () => Promise.resolve([]),
          tx: () => {
            called += 1;
            return Promise.resolve({});
          },
        } as unknown as Database,
        logger: silent,
        sources: sources(),
        ingest: () => Promise.resolve(),
      });
      assert.equal(await service.sweep(), 0);
      assert.equal(called, 0, 'the queries a reading costs are not run for nobody');
    });

    it('fails the sensor with a message and no channel values when it cannot read', async () => {
      // Not a row of zeros. A Core Health sensor whose numbers are unavailable must gap, because
      // zeros are what a perfectly idle, perfectly healthy core looks like.
      const batches: CheckResult[][] = [];
      const service = build({ deliveryThrows: true }, { cpuUs: [], elapsedNs: [] }, (results) => {
        batches.push([...results]);
        return Promise.resolve();
      });
      await service.sweep();

      const results = batches[0] ?? [];
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.outcome, 'error');
        assert.deepEqual(result.channels, []);
        assert.match(result.message, /could not read its own numbers/);
        assert.match(result.message, /notification queue would not answer/);
      }
      assert.equal(service.stats().failed, 2);
    });

    it('answers the route with gaps rather than nothing when the database is unreachable', async () => {
      // **`P-126`.** The sweep above is right to fail the sensor — a row of zeros is what a
      // perfectly idle, perfectly healthy core looks like. `GET /core-health` is the other case:
      // an operator asking how the core is, at the moment it is least well, was answered 500,
      // which loses the CPU, the memory and the ingest queue too — none of which need a database.
      const service = build(
        { deliveryThrows: true, queuedRows: 12 },
        {
          cpuUs: [],
          elapsedNs: [],
        },
      );

      const channels = await service.read(undefined, true);
      assert.equal(channels['ingestQueue'], 12, 'what needs no database is still answered');
      assert.equal(channels['notifyPending'], null, 'and what does is a gap, not a zero');
      assert.equal(channels['notifyOldest'], null);
      assert.equal(channels['notifyFailed'], null);
      assert.equal(channels['backfillQueue'], null);
      assert.equal(channels['backfillParked'], null);
    });

    it('still throws for the sweep, which must not write a row of zeros', async () => {
      const service = build({ deliveryThrows: true }, { cpuUs: [], elapsedNs: [] });
      await assert.rejects(service.read());
    });

    it('says what is not zero, and stays quiet about what is', async () => {
      const batches: CheckResult[][] = [];
      const service = build(
        { queuedRows: 12, p95: 4.213, pending: 3, probesDown: 1 },
        { cpuUs: [], elapsedNs: [] },
        (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
      );
      await service.sweep();
      const message = batches[0]?.[0]?.message ?? '';
      assert.match(message, /12 queued/);
      // Rounded in the sentence, not in the channel: "writes 4.213 ms" is precision nobody reads.
      assert.match(message, /writes 4 ms/);
      assert.match(message, /3 notifications undelivered/);
      assert.match(message, /1 probes down/);
      assert.equal(/rollup/.test(message), false, 'a tier that is not behind is not mentioned');
      assert.equal(/alarm sweep/.test(message), false, 'a scheduler on time is not mentioned');
    });

    it('says so when the alarm sweep is overdue, because nothing else would', async () => {
      // The failure this describes is silence: the scheduler stops, no notification goes out,
      // and every other number on this sensor stays exactly as healthy as it was.
      const NOW = new Date('2026-08-29T10:00:00.000Z');
      const batches: CheckResult[][] = [];
      const service = build(
        { nextWakeAt: new Date(NOW.getTime() - 90_000) },
        { cpuUs: [], elapsedNs: [] },
        (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
        () => NOW,
      );
      await service.sweep();
      assert.match(batches[0]?.[0]?.message ?? '', /alarm sweep 90 s overdue/);
    });

    it('names a parked backfill, and the error it keeps failing with (`P-226`)', async () => {
      // A parked backfill has failed three times and is retried hourly, then daily. The channel's
      // limit makes it a warning, but a limit's message is fixed; what failed is in the entry,
      // and the sensor's own message is where it can be read.
      await db.query(
        `INSERT INTO rollup_backfill
           (from_time, to_time, reason, attempts, last_error, failed_at, retry_at)
         VALUES (now() - interval '3 hours', now() - interval '2 hours', 'test', 4,
                 'an older failure', now() - interval '2 hours', now() + interval '22 hours'),
                (now() - interval '3 hours', now() - interval '2 hours', 'test', 3,
                 'could not extend file: No space left on device', now(), now() + interval '1 hour'),
                (now() - interval '2 hours', now() - interval '1 hour', 'test', 0, NULL, NULL, NULL)`,
      );
      const batches: CheckResult[][] = [];
      const service = build({}, { cpuUs: [], elapsedNs: [] }, (results) => {
        batches.push([...results]);
        return Promise.resolve();
      });
      const reading = await service.read();
      assert.equal(reading['backfillQueue'], 3, 'the queue counts them');
      assert.equal(reading['backfillParked'], 2, 'and this counts only them');

      await service.sweep();
      assert.match(
        batches[0]?.[0]?.message ?? '',
        /2 rollup backfills parked, the last failing with: could not extend file: No space left/,
      );
    });

    it('counts its sweeps whether or not there was anything to report', async () => {
      const service = build();
      await service.sweep();
      await service.sweep();
      assert.equal(service.stats().sweeps, 2);
      assert.equal(service.stats().evaluated, 4);
    });
  });
});
