import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PROBE_HEALTH_CHANNELS, PROBE_HEALTH_COUNTERS } from '@ms/sensors';
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type CheckResult,
  type IngestionConfig,
  type ProbeHealthReport,
} from '@ms/shared';
import {
  ProbeHealthService,
  ProbeHealthTargets,
  readingsFrom,
  type ProbeHealthServiceOptions,
  type ProbeHealthSources,
} from '../src/health/probe-health.js';
import { ApiServer } from '../src/api/server.js';
import { AccessService } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { loadLookups } from '../src/lookups/loader.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { SensorStateService } from '../src/state/service.js';
import type { MemoryFold, ProbeLink } from '../src/transport/probe-endpoint.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';
import type { SensorToVouchFor } from '../src/objects/vouching.js';
import { everyVoucherHolds } from './support/vouching.js';

/**
 * Probe Health (`P-13`), and `P-04`'s numbers arriving on it.
 *
 * The claim the whole design rests on: **a probe cannot report its own absence**, so the core
 * evaluates this. Every test below is some version of "does it still say something true when the
 * probe is gone, or old, or silent" — because a sensor that only works while everything works is
 * not a health sensor.
 */

const available = await databaseAvailable();

const FULL: ProbeHealthReport = {
  scheduled: 120,
  schedulerLagMs: { p50: 2, p95: 11, p99: 30, max: 90 },
  skippedTicks: 0,
  clockJumps: 1,
  poolSize: 48,
  poolBusy: 12,
  queued: 3,
  queueWaitMs: { p50: 1, p95: 40, p99: 90, max: 500 },
  deferred: 7,
  refused: 2,
  timedOut: 1,
  discarded: 0,
  poolState: 0,
  checksCompleting: 1,
  checksBehind: 0,
  trapReceived: 900,
  trapRejected: 412,
  trapMalformed: 3,
  syslogReceived: 40_000,
  syslogRejected: 0,
  syslogMalformed: 17,
  workerCrashes: 0,
  childSlots: 4,
  childBusy: 3,
  childQueued: 9,
  childDeferred: 11,
  childRefused: 5,
  childTimedOut: 2,
  childCrashes: 1,
  spoolPending: 500,
  spoolBytes: 2 * 1024 * 1024,
  spoolDropped: 4,
  spoolCorrupt: 0,
  spoolStalledMs: 420_000,
  sessionsOpen: 12,
  sessionOverflows: 3,
  sessionsEvicted: 40,
  sessionsOpened: 55,
  cpuPercent: 18.5,
  memoryMb: 210.4,
  uptimeSeconds: 3_600,
  memoryAvailablePercent: 23.4,
  memoryAvailableMb: 1_860,
  memoryLimitUsagePercent: 55.2,
  memoryLimitMb: 4_096,
  poolCeiling: 64,
  poolMemoryCap: 90,
  poolHeldBack: 0,
};

describe('the Probe Health sensor', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let probeId = 0;
  let sensorId = 0;
  let orphanId = 0;
  /** The probe the orphan sits under, which has no Probe Health of its own. */
  let watcherId = 0;
  let harness: Harness;

  before(async () => {
    scratch = await createScratchDatabase('probehealth');
    db = scratch.db;
    harness = await buildHarness(db);

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: 'remote-probe',
    });
    probeId = probe.id;
    const device = await harness.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'probe-box',
      host: '127.0.0.1',
    });
    const sensor = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: device.id,
      name: 'Probe Health',
      sensorType: 'ms.probe.health',
      params: {},
    });
    sensorId = sensor.id;

    // A second sensor under a *different* probe, naming the first explicitly — the placement an
    // operator uses so that losing a probe does not also lose the view of it.
    const watcher = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: 'local-probe',
    });
    watcherId = watcher.id;
    const watcherDevice = await harness.service.create(testActor, {
      kind: 'device',
      parentId: watcher.id,
      name: 'core-box',
      host: '127.0.0.1',
    });
    const named = await harness.service.create(testActor, {
      kind: 'sensor',
      parentId: watcherDevice.id,
      name: 'Remote probe health',
      sensorType: 'ms.probe.health',
      params: { probeId: probe.id },
    });
    orphanId = named.id;
  });

  after(async () => {
    await scratch.drop();
  });

  const connected = (
    overrides: Partial<Extract<ProbeLink, { connected: true }>> = {},
  ): ProbeLink => ({
    connected: true,
    gid: 'probe-gid',
    clockOffsetMs: null,
    protocolVersion: PROTOCOL_VERSION,
    connectedAt: new Date('2026-08-28T00:00:00Z'),
    lastHeartbeatAt: new Date('2026-08-28T00:00:20Z'),
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 100,
    cadenceSeconds: 60,
    connectedForMs: Number.MAX_SAFE_INTEGER,
    sinceResultsMs: 0,
    sinceConfigMs: 0,
    configured: true,
    configurable: true,
    lastResultsAt: new Date('2026-08-28T00:00:20Z'),
    configSentAt: new Date('2026-08-28T00:00:00Z'),
    health: FULL,
    ...overrides,
  });

  const build = (
    link: (probeObjectId: number) => ProbeLink,
    ingest: (results: readonly CheckResult[]) => Promise<void> = () => Promise.resolve(),
  ): ProbeHealthService =>
    new ProbeHealthService({
      vouching: everyVoucherHolds,
      db,
      logger: silent,
      sources: { link },
      ingest,
      now: () => new Date('2026-08-28T00:00:25Z'),
    });

  describe('a probe that is answering', () => {
    it('produces every channel the type declares', () => {
      const { reading } = build(() => connected()).read(probeId);
      for (const key of PROBE_HEALTH_CHANNELS) {
        assert.ok(key in reading, `${key} was declared and never read`);
      }
      assert.equal(Object.keys(reading).length, PROBE_HEALTH_CHANNELS.length);
    });

    it('reports the link, the heartbeat age and the probe’s own numbers', () => {
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['connected'], 1);
      assert.equal(reading['heartbeatAge'], 5, 'five seconds since the last one');
      assert.equal(reading['protocol'], 0, 'the same version as this build');
      assert.equal(reading['schedulerLag'], 11, 'p95, because a scheduler is late in bursts');
      assert.equal(reading['checkWait'], 40);
      assert.equal(reading['poolUsage'], 25, '12 of 48');
      assert.equal(reading['deferred'], 7);
      assert.equal(reading['refused'], 2);
      assert.equal(reading['spoolDepth'], 500);
      assert.equal(reading['spoolBytes'], 2, 'bytes in, megabytes out');
      assert.equal(reading['spoolDropped'], 4);
      assert.equal(reading['spoolStalled'], 420, 'milliseconds in, seconds out');
      assert.equal(reading['cpu'], 18.5);
    });

    it('carries what the listeners heard and turned away, which nothing else knows', () => {
      // `P-64`. `trapRejected` is the one worth the wire: without it a device sending the wrong
      // community makes the trap sensor read a quiet network rather than a receiver refusing
      // everything it is sent.
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['trapReceived'], 900);
      assert.equal(reading['trapRejected'], 412);
      assert.equal(reading['syslogMalformed'], 17);
    });

    it('carries what each listener’s buffer overwrote unread, and gaps it when the probe sends none', () => {
      // `B-14`. Each from its own field, and a gap, never a zero, for a probe without that
      // listener, an older probe, or a core below 26 on the other end.
      const lossy = build(() =>
        connected({ health: { ...FULL, trapOverwritten: 1_300, syslogOverwritten: 75 } }),
      ).read(probeId).reading;
      assert.equal(lossy['trapOverwritten'], 1_300);
      assert.equal(lossy['syslogOverwritten'], 75);

      const zero = build(() =>
        connected({ health: { ...FULL, trapOverwritten: 0, syslogOverwritten: 0 } }),
      ).read(probeId).reading;
      assert.equal(zero['trapOverwritten'], 0, 'a buffer that lost nothing is a reading');
      assert.equal(zero['syslogOverwritten'], 0);

      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['trapOverwritten'], null);
      assert.equal(reading['syslogOverwritten'], null);
      assert.equal(reading['trapReceived'], 900, 'what the listener did send is unaffected');
    });

    it('carries what the flow collector counted, and gaps all six for a probe without one', () => {
      // `B-07`. Until a probe constructed the collector these five channels gapped on every
      // probe there was, and nothing here said what they read when one did send them.
      const flowing = build(() =>
        connected({
          health: {
            ...FULL,
            flowReceived: 4_812,
            flowRejected: 3,
            flowMalformed: 2,
            flowMissed: 61,
            flowUndecodable: 7,
            flowOverwritten: 250,
          },
        }),
      ).read(probeId).reading;
      assert.equal(flowing['flowReceived'], 4_812);
      assert.equal(flowing['flowRejected'], 3);
      assert.equal(flowing['flowMalformed'], 2);
      assert.equal(flowing['flowMissed'], 61);
      assert.equal(flowing['flowUndecodable'], 7);
      assert.equal(flowing['flowOverwritten'], 250);

      // No collector, an older probe, or a core below 23 on the other end: a gap, never a zero
      // that reads as a collector hearing nothing.
      const { reading } = build(() => connected()).read(probeId);
      for (const key of [
        'flowReceived',
        'flowRejected',
        'flowMalformed',
        'flowMissed',
        'flowUndecodable',
        'flowOverwritten',
      ]) {
        assert.equal(reading[key], null, key);
      }
      assert.equal(reading['trapReceived'], 900, 'the other listeners are unaffected');
    });

    it('carries what the probe’s machine has left, beside what the probe holds', () => {
      // `P-208`: the two numbers `P-206` needed and had one of. The probe was the largest process
      // on its VM when it was killed; what killed it was everything else, and only this says so.
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['memory'], 210.4);
      assert.equal(reading['memoryAvailable'], 23.4);
      assert.equal(reading['memoryAvailableBytes'], 1_860);
    });

    it('carries how close the probe is to its own ceiling, and the ceiling', () => {
      // `P-210`: the number that says a probe on a large host is about to be throttled by its own
      // unit while the machine has memory to spare.
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['memoryLimitUsage'], 55.2);
      assert.equal(reading['memoryLimit'], 4_096);
    });

    it('carries how far memory lets the pool grow, and how much it holds back (P-236)', () => {
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['poolCeiling'], 64);
      assert.equal(reading['poolMemoryCap'], 90);
      assert.equal(reading['poolHeldBack'], 0);
    });

    it('says in the message when memory is what holds the pool back (P-236)', () => {
      // "pool 100% of 50" alone reads as a probe that wants a bigger `workerPoolSize`, and the
      // remedy is memory instead.
      const { message } = build(() =>
        connected({
          health: {
            ...FULL,
            poolSize: 50,
            poolBusy: 50,
            poolCeiling: 50,
            poolMemoryCap: 50,
            poolHeldBack: 14,
          },
        }),
      ).read(probeId);
      assert.match(
        message,
        /pool 100% of 50, memory holds the pool at 50 workers, 14 short of its ceiling/,
      );
    });

    it('gaps the pool’s memory channels for a probe too old to send them, never reading zero', () => {
      const { poolCeiling: _a, poolMemoryCap: _b, poolHeldBack: _c, ...older } = FULL;
      const { reading, message } = build(() => connected({ health: older })).read(probeId);
      assert.equal(reading['poolCeiling'], null);
      assert.equal(reading['poolMemoryCap'], null);
      assert.equal(reading['poolHeldBack'], null);
      assert.doesNotMatch(message, /memory holds/);
    });

    it('leaves the machine to Core Health on the local probe, and keeps its own limit (M-21)', () => {
      // The local probe's machine is the core's: its pair gaps, so one squeeze is one alarm, on
      // Core Health. Its own cgroup is not the machine's and Core Health cannot see it.
      const { reading } = build(() => connected()).read(probeId, { local: true });
      assert.equal(reading['memoryAvailable'], null);
      assert.equal(reading['memoryAvailableBytes'], null);
      assert.equal(reading['memoryLimitUsage'], 55.2);
      assert.equal(reading['memoryLimit'], 4_096);
      assert.equal(reading['poolMemoryCap'], 90);
      assert.equal(reading['poolHeldBack'], 0);
      assert.equal(reading['memory'], 210.4, 'what the probe holds is its own');
    });

    it('names a low machine in words on the local probe, and nothing when it is fine (M-21)', () => {
      const low = build(() => connected({ health: { ...FULL, memoryAvailablePercent: 8 } })).read(
        probeId,
        { local: true },
      );
      assert.match(low.message, /its machine has 8% memory available, which Core Health reports/u);
      const fine = build(() => connected()).read(probeId, { local: true });
      assert.doesNotMatch(fine.message, /its machine has/u);
      const remote = build(() =>
        connected({ health: { ...FULL, memoryAvailablePercent: 8 } }),
      ).read(probeId);
      assert.equal(remote.reading['memoryAvailable'], 8, 'a remote probe still reports its own');
      assert.doesNotMatch(remote.message, /its machine has/u);
    });

    it('gaps the limit for a probe with no ceiling or too old to say, never reading it as zero', () => {
      const { memoryLimitUsagePercent: _a, memoryLimitMb: _b, ...older } = FULL;
      const { reading } = build(() => connected({ health: older })).read(probeId);
      assert.equal(reading['memoryLimitUsage'], null);
      assert.equal(reading['memoryLimit'], null);
      assert.equal(reading['memoryAvailable'], 23.4, 'the machine’s figure is unaffected');
    });

    it('gaps the machine’s memory for a probe that does not send it, never reading it as zero', () => {
      // A probe below protocol 17, or one on a platform that cannot say. A zero here is the error
      // limit, so reading absence as zero would page somebody about a machine with memory to spare.
      const { memoryAvailablePercent: _a, memoryAvailableMb: _b, ...older } = FULL;
      const { reading } = build(() => connected({ health: older })).read(probeId);
      assert.equal(reading['memoryAvailable'], null);
      assert.equal(reading['memoryAvailableBytes'], null);
      assert.equal(reading['memory'], 210.4, 'the probe’s own number is unaffected');
    });

    it('gaps a listener a probe does not run, rather than reading it as silent', () => {
      const { trapReceived: _a, trapRejected: _b, trapMalformed: _c, ...noTrap } = FULL;
      const { reading } = build(() => connected({ health: noTrap })).read(probeId);
      assert.equal(reading['trapReceived'], null);
      assert.equal(reading['syslogReceived'], 40_000, 'the other one is unaffected');
    });

    it('warns when a working probe has sensors that are not being checked', () => {
      // `P-76`, and the reason it is a Warning. The probe is delivering, so `P-74`'s question is
      // answered yes; part of what it carries is not settling. Down would overstate it and would
      // collide with the case that genuinely is one.
      const { reading } = build(() =>
        connected({ health: { ...FULL, checksCompleting: 0, checksBehind: 12 } }),
      ).read(probeId);
      assert.equal(reading['checksCompleting'], 0);
      assert.equal(reading['checksBehind'], 12, 'and how much of the probe is affected');
    });

    it('carries what the core refused from this probe for its timestamps, by its GID', () => {
      // `P-231`. Only the core can see that a probe's clock is wrong, and a total across the
      // fleet cannot say which probe's is, so ingestion counts by the GID a batch arrives under
      // and the link says which GID this probe is.
      const asked: string[] = [];
      const { reading } = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: () => connected({ gid: 'probe-a' }),
          timeRefusals: (gid) => {
            asked.push(gid);
            return { past: 2, future: 7 };
          },
        },
        ingest: () => Promise.resolve(),
      }).read(probeId);
      assert.deepEqual(asked, ['probe-a']);
      assert.equal(reading['resultsFutureDated'], 7);
      assert.equal(reading['resultsPastDated'], 2);
    });

    it('carries the probe clock as the core reads it, and the sensors it froze', () => {
      // `P-232`. Seconds, positive when the probe is behind; the count comes from the sweep that
      // froze them, by probe.
      const asked: number[] = [];
      const { reading } = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: () => connected({ clockOffsetMs: 3_600_049 }),
          frozenSensors: (id) => {
            asked.push(id);
            return 12;
          },
        },
        ingest: () => Promise.resolve(),
      }).read(probeId);
      assert.equal(reading['clockOffset'], 3_600);
      assert.equal(reading['sensorsFrozen'], 12);
      assert.deepEqual(asked, [probeId]);
    });

    it('gaps the clock until the session has sent a time, and never reads it as zero', () => {
      const { reading } = build(() => connected({ clockOffsetMs: null })).read(probeId);
      assert.equal(reading['clockOffset'], null);
      assert.equal(reading['sensorsFrozen'], null, 'and the count, on a core without the sweep');
    });

    it('gaps them on a core that does not count them, rather than reading zero', () => {
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['resultsFutureDated'], null);
      assert.equal(reading['resultsPastDated'], null);
    });

    it('carries what the core refused from this probe, by the probe object it owns', () => {
      // `P-228`. By object rather than GID because that is what ownership is decided against,
      // and what a warning has to name for an operator to find the probe.
      const asked: number[] = [];
      const { reading, message } = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: () => connected(),
          refusals: (probeObjectId) => {
            asked.push(probeObjectId);
            return { refused: 9, foreignRecently: 2 };
          },
        },
        ingest: () => Promise.resolve(),
      }).read(probeId);
      assert.deepEqual(asked, [probeId]);
      assert.equal(reading['reportsRefused'], 9);
      assert.equal(reading['reportsForeign'], 2);
      assert.match(message, /2 reports on work never given to it in the last 5 minutes/u);
    });

    it('says nothing about refusals when none was foreign, however many were refused', () => {
      // A probe draining its spool after a move has thousands refused and nothing wrong with it.
      const { reading, message } = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: () => connected(),
          refusals: () => ({ refused: 5_000, foreignRecently: 0 }),
        },
        ingest: () => Promise.resolve(),
      }).read(probeId);
      assert.equal(reading['reportsForeign'], 0, 'a count, not a gap');
      assert.doesNotMatch(message, /never given/u);
    });

    it('gaps the refusals on a core that does not count them, rather than reading zero', () => {
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['reportsRefused'], null);
      assert.equal(reading['reportsForeign'], null);
      assert.equal(reading['lateRefusals'], null);
    });

    it('carries the refusals that arrived late on a channel of their own, as a counter (`A-56`)', () => {
      // Beside what the core refused from the probe and not inside it: 3 late refusals and 9
      // refused reports are two readings, and the sentence is about neither.
      const asked: number[] = [];
      const service = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: () => connected(),
          refusals: () => ({ refused: 9, foreignRecently: 0 }),
          lateRefusals: (probeObjectId) => {
            asked.push(probeObjectId);
            return 3;
          },
        },
        ingest: () => Promise.resolve(),
      });
      const { reading, message } = service.read(probeId);
      assert.deepEqual(asked, [probeId]);
      assert.equal(reading['lateRefusals'], 3);
      assert.equal(reading['reportsRefused'], 9);
      assert.doesNotMatch(message, /late|refus/iu);
      // Recorded as a counter, so the channel is a rate that returns to nothing.
      assert.deepEqual(
        readingsFrom(reading).find((one) => one.key === 'lateRefusals'),
        { key: 'lateRefusals', value: 3, counter: '3', counterBits: 64 },
      );
    });

    it('reads no late refusals as zero, and for a probe that is not connected as a gap', () => {
      const read = (link: ProbeLink): number | null | undefined =>
        new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: { link: () => link, lateRefusals: () => 0 },
          ingest: () => Promise.resolve(),
        }).read(probeId).reading['lateRefusals'];
      assert.equal(read(connected()), 0);
      assert.equal(read({ connected: false }), null);
    });

    it('carries the results dropped for withheld sensors as a counter of their own, and gaps it where nothing counts them (`A-72`)', () => {
      const asked: number[] = [];
      const read = (sources: Partial<ProbeHealthSources>, link: ProbeLink = connected()) =>
        new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: { link: () => link, ...sources },
          ingest: () => Promise.resolve(),
        }).read(probeId);
      const { reading, message } = read({
        refusals: () => ({ refused: 9, foreignRecently: 0 }),
        lateRefusals: () => 3,
        withheldResults: (probeObjectId) => {
          asked.push(probeObjectId);
          return 4;
        },
      });
      assert.deepEqual(asked, [probeId]);
      assert.deepEqual(
        [reading['resultsWithheld'], reading['lateRefusals'], reading['reportsRefused']],
        [4, 3, 9],
        'three numbers, none inside another',
      );
      assert.doesNotMatch(message, /withheld/iu);
      assert.deepEqual(
        readingsFrom(reading).find((one) => one.key === 'resultsWithheld'),
        { key: 'resultsWithheld', value: 4, counter: '4', counterBits: 64 },
      );
      assert.equal(read({ withheldResults: () => 0 }).reading['resultsWithheld'], 0);
      assert.equal(read({}).reading['resultsWithheld'], null);
      assert.equal(
        read({ withheldResults: () => 4 }, { connected: false }).reading['resultsWithheld'],
        null,
      );
    });

    it('names a protocol version flap, reads 0 for none, and gaps it where nothing knows (`A-72`)', () => {
      const flap = {
        version: 24,
        floor: 23,
        changes: 5,
        sinceMs: 12 * 60_000 + 1,
        remainingMs: 59 * 60_000 + 30_000,
      };
      const read = (protocolFlap?: () => typeof flap | null, link: ProbeLink = connected()) =>
        new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: { link: () => link, ...(protocolFlap === undefined ? {} : { protocolFlap }) },
          ingest: () => Promise.resolve(),
        }).read(probeId);
      const flapping = read(() => flap);
      assert.equal(flapping.reading['protocolFlap'], 5);
      // First after the link, because it is why sensors under the probe stand Unknown.
      assert.ok(
        flapping.message.startsWith(
          'connected, 120 sensors scheduled, its protocol version changed 5 times in 13 minutes ' +
            'and is 24 now, so the ' +
            'sensors its version decides hold where they stood, as at protocol 23, until it has ' +
            'held one version for an hour (60 minutes from now if it holds), scheduler lag',
        ),
        flapping.message,
      );
      // A minute is never said as none.
      assert.match(
        read(() => ({ ...flap, changes: 2, sinceMs: 0, remainingMs: 0 })).message,
        /changed 2 times in 1 minute and .* for an hour \(1 minute from now/u,
      );

      const none = read(() => null);
      assert.equal(none.reading['protocolFlap'], 0, 'no flap is a reading');
      assert.doesNotMatch(none.message, /protocol version changed/u);
      assert.equal(read().reading['protocolFlap'], null, 'nothing that knows: a gap');
      assert.equal(read(() => flap, { connected: false }).reading['protocolFlap'], null);
      assert.doesNotMatch(read(() => flap, { connected: false }).message, /changed/u);
    });

    it('turns the probe Down when its worker pool has given up', () => {
      // **The alarm for a probe that is up and monitoring nothing** (`P-62`). Every other channel
      // reads like a quiet night: the link is connected, `poolUsage` is 0%, nothing is deferred or
      // refused. Meanwhile every sensor under that probe holds its last state for ever, because
      // the core re-evaluates on an arriving result and none arrive.
      const { reading } = build(() =>
        connected({ health: { ...FULL, poolState: 1, discarded: 412 } }),
      ).read(probeId);
      assert.equal(reading['poolState'], 1);
      assert.equal(reading['discarded'], 412, 'and what it cost, for afterwards');
    });

    it('gaps the pool state for a probe too old to report it, rather than reading it as alive', () => {
      // The one mistake this channel exists to prevent: silence from an older probe is not
      // "the pool is running". The lookup's undefinedState makes the gap a warning.
      const { poolState: _omitted, ...older } = FULL;
      const { reading } = build(() => connected({ health: older })).read(probeId);
      assert.equal(reading['poolState'], null);
    });

    it('carries the child-process runner’s counters, which no pool channel covers', () => {
      // `P-61`: EXE and Script checks run in a child process, never in the worker pool, so
      // `deferred` and `refused` above are silent about them entirely. A probe turning away
      // every shell-out reported a calm pool and nothing else.
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['childSlots'], 4);
      assert.equal(reading['childBusy'], 3);
      assert.equal(reading['childQueued'], 9);
      assert.equal(reading['childDeferred'], 11);
      assert.equal(reading['childRefused'], 5);
      assert.equal(reading['childTimedOut'], 2);
      assert.equal(reading['childCrashes'], 1);
    });

    it('gaps the child channels for a probe that runs no child processes', () => {
      // Same rule as the stall below. A probe with no isolated sensor types omits the fields,
      // and zero would be a claim about a runner that never reported — no-data is not zero.
      const {
        childSlots: _a,
        childBusy: _b,
        childQueued: _c,
        childDeferred: _d,
        childRefused: _e,
        childTimedOut: _f,
        childCrashes: _g,
        ...withoutChildren
      } = FULL;
      const { reading } = build(() => connected({ health: withoutChildren })).read(probeId);
      assert.equal(reading['childSlots'], null);
      assert.equal(reading['childRefused'], null);
    });

    it('carries the child checks that never started, and the p95 of a start', () => {
      // `P-260`: a check's timeout runs from its process being ready, so a probe too starved to
      // start one is counted here rather than blamed on the script.
      const { reading } = build(() =>
        connected({
          health: {
            ...FULL,
            childStartupFailed: 6,
            childStartupMs: { p50: 25, p95: 9_400, p99: 14_800, max: 30_000 },
          },
        }),
      ).read(probeId);
      assert.equal(reading['childStartupFailed'], 6);
      assert.equal(reading['childStartup'], 9_400);
      // A probe or a core below 29 sends neither, and both gap rather than read zero.
      const { reading: older } = build(() => connected()).read(probeId);
      assert.equal(older['childStartupFailed'], null);
      assert.equal(older['childStartup'], null);
    });

    it('carries what each listener kept out of a first scan, and gaps for a probe that cannot say', () => {
      // `P-270`. Each from its own field, apart from the overwritten counts it is not part of.
      const { reading } = build(() =>
        connected({
          health: {
            ...FULL,
            trapOverwritten: 1_300,
            trapEarlier: 357,
            syslogEarlier: 1_200,
            flowEarlier: 9_000,
          },
        }),
      ).read(probeId);
      assert.equal(reading['trapEarlier'], 357);
      assert.equal(reading['syslogEarlier'], 1_200);
      assert.equal(reading['flowEarlier'], 9_000);
      assert.equal(reading['trapOverwritten'], 1_300, 'and not added to the loss');
      const zero = build(() =>
        connected({ health: { ...FULL, trapEarlier: 0, syslogEarlier: 0 } }),
      ).read(probeId).reading;
      assert.equal(zero['trapEarlier'], 0, 'nothing kept out is a reading');
      // No listener, an older probe, or a core below 31 on the other end: a gap, never a zero.
      const { reading: older } = build(() => connected()).read(probeId);
      for (const key of ['trapEarlier', 'syslogEarlier', 'flowEarlier']) {
        assert.equal(older[key], null, key);
      }
      assert.equal(older['trapReceived'], 900, 'what the listener did send is unaffected');
    });

    it('carries the script groups a dead check process left open, and gaps for a probe that cannot say', () => {
      // `P-275`. Three counts, each from its own field.
      const { reading } = build(() =>
        connected({
          health: {
            ...FULL,
            scriptGroupsEnded: 8,
            scriptGroupsRefused: 1,
            scriptGroupsRecycled: 3,
          },
        }),
      ).read(probeId);
      assert.equal(reading['scriptGroupsEnded'], 8);
      assert.equal(reading['scriptGroupsRefused'], 1);
      assert.equal(reading['scriptGroupsRecycled'], 3);
      assert.equal(reading['childCrashes'], 1, 'and the crash count is its own');
      // A probe or a core below 31 does not send them: gaps, never a zero that says none refused.
      const { reading: older } = build(() => connected()).read(probeId);
      for (const key of ['scriptGroupsEnded', 'scriptGroupsRefused', 'scriptGroupsRecycled']) {
        assert.equal(older[key], null, key);
      }
    });

    it('carries the readings a probe could not send, and gaps for a probe that cannot say (`P-283`)', () => {
      // Three totals, each from its own field. Distinct values, so two swapped is a failure.
      const { reading } = build(() =>
        connected({
          health: { ...FULL, resultChannelsDropped: 17, spoolRejected: 40, spoolOversized: 2 },
        }),
      ).read(probeId);
      assert.equal(reading['resultChannelsDropped'], 17);
      assert.equal(reading['spoolRejected'], 40);
      assert.equal(reading['spoolOversized'], 2);
      assert.equal(reading['spoolDropped'], 4, 'and the spool’s own evictions are their own');
      // No sweep has taken a five-minute count yet, so that channel is a gap, not a zero.
      assert.equal(reading['resultsDiscarded'], null);
      // A probe or a core below 32 does not send them: gaps, never a zero that says none was lost.
      const { reading: older } = build(() => connected()).read(probeId);
      for (const key of [
        'resultChannelsDropped',
        'spoolRejected',
        'spoolOversized',
        'resultsDiscarded',
        'scriptGroupsRefusedRecently',
      ]) {
        assert.equal(older[key], null, key);
      }
    });

    it('carries the workers the pool could not start, and gaps for a probe that cannot say', () => {
      // `P-263`: a worker still loading at its start-up bound is terminated and replaced.
      const { reading } = build(() =>
        connected({ health: { ...FULL, workerStartupFailed: 4 } }),
      ).read(probeId);
      assert.equal(reading['workerStartupFailed'], 4);
      assert.equal(reading['workerCrashes'], 0, 'and it is not a crash');
      // A probe or a core below 30 does not send it, and it gaps rather than reads zero.
      const { reading: older } = build(() => connected()).read(probeId);
      assert.equal(older['workerStartupFailed'], null);
    });

    /**
     * The stall the probe reports, as a channel an operator can alarm on (`H-01`).
     *
     * `615c9f3` was a spool that would not move with the link up. Depth alone could not have
     * shown it — a spool with thousands of results in it is also what a probe replaying an
     * outage looks like — so the signal has to be the *duration* of no progress, and it has to
     * survive the trip from the probe to a channel.
     */
    it('gaps the stall rather than reading zero when the probe does not report one', () => {
      // An older probe omits the field. Zero would say "not stalled", which is a claim about a
      // probe that never made it — `CLAUDE.md`'s no-data rule, on the channel it matters most.
      const { spoolStalledMs: _omitted, ...withoutStall } = FULL;
      const { reading } = build(() => connected({ health: withoutStall })).read(probeId);
      assert.equal(reading['spoolStalled'], null);
    });

    /**
     * The session pools, as channels an operator can alarm on (`P-36`).
     *
     * Both pools counted `overflowed` — sessions opened past their bound because every existing
     * one was in use — and `stats()` was read by nothing outside their own tests, while the
     * SNMP pool's own comment claimed the counter was what made the overflow visible. These
     * assert the trip from a heartbeat field to a channel, and the absence that must stay an
     * absence.
     */
    it('carries the session counters through to their channels', () => {
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['sessionsOpen'], 12);
      assert.equal(reading['sessionOverflows'], 3);
      assert.equal(reading['sessionsEvicted'], 40);
    });

    it('gaps the session channels when the probe keeps no pools', () => {
      // **The claim `P-36` made and did not test at first.** A probe older than protocol 10
      // omits these, and so does a current one whose registry keeps no session pools at all —
      // and zero open sessions is a claim about a probe that never made one, not an absence.
      const {
        sessionsOpen: _open,
        sessionOverflows: _over,
        sessionsEvicted: _evicted,
        sessionsOpened: _opened,
        ...withoutSessions
      } = FULL;
      const { reading } = build(() => connected({ health: withoutSessions })).read(probeId);
      assert.equal(reading['sessionsOpen'], null);
      assert.equal(reading['sessionOverflows'], null);
      assert.equal(reading['sessionsEvicted'], null);
    });

    it('reads zero overflows as zero, because a pool inside its bound is a measurement', () => {
      // The other half of the pair, and the reason the gap above is not simply "falsy is null":
      // a probe reporting no overflows has said something, and it is the healthy answer.
      const { reading } = build(() => connected({ health: { ...FULL, sessionOverflows: 0 } })).read(
        probeId,
      );
      assert.equal(reading['sessionOverflows'], 0);
    });

    it('reads zero as zero, because a drain that is moving is a measurement', () => {
      const { reading } = build(() => connected({ health: { ...FULL, spoolStalledMs: 0 } })).read(
        probeId,
      );
      assert.equal(reading['spoolStalled'], 0);
    });

    it('says what it is doing, and stays quiet about what is fine', () => {
      const { message } = build(() => connected()).read(probeId);
      assert.match(message, /connected, 120 sensors scheduled/);
      assert.match(message, /scheduler lag 11 ms/);
      // The size as well as the percentage since `P-18`: the pool is no longer a fixed number
      // an operator can be assumed to know, and "pool 25%" is the same sentence for four
      // workers and for forty-eight.
      assert.match(message, /pool 25% of 48/);
      assert.match(message, /500 results spooled/);
      assert.doesNotMatch(message, /memory holds/, 'nothing held back, nothing said');
    });

    it('gaps the pool percentage rather than dividing by a pool of none', () => {
      // 0 busy of 0 slots is not 0% used — it is a pool that does not exist.
      const { reading } = build(() =>
        connected({ health: { ...FULL, poolSize: 0, poolBusy: 0 } }),
      ).read(probeId);
      assert.equal(reading['poolUsage'], null);
    });

    it('gaps a heartbeat that has never arrived rather than calling it zero seconds old', () => {
      const { reading } = build(() => connected({ lastHeartbeatAt: null })).read(probeId);
      assert.equal(reading['heartbeatAge'], null);
    });
  });

  describe('the memory a sweep records (P-219)', () => {
    const MEMORY = ['memoryAvailable', 'memoryAvailableBytes', 'memoryLimitUsage', 'memoryLimit'];
    const FOLD: MemoryFold = {
      memoryAvailablePercent: 8.5,
      memoryAvailableMb: 700,
      memoryLimitUsagePercent: 91,
      memoryLimitMb: 4_096,
    };

    /** One sweep; what it recorded of memory for each sensor, and how often it drained the folds. */
    async function swept(
      link: ProbeLink,
      folds?: ReadonlyMap<number, MemoryFold>,
    ): Promise<{ memory: Map<number, Record<string, number>>; drained: number }> {
      const results: CheckResult[] = [];
      let drained = 0;
      await new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        sources: {
          link: () => link,
          ...(folds === undefined
            ? {}
            : {
                drainMemory: () => {
                  drained += 1;
                  return folds;
                },
              }),
        },
        ingest: (batch) => {
          results.push(...batch);
          return Promise.resolve();
        },
        now: () => new Date('2026-08-28T00:00:25Z'),
      }).sweep();
      const memory = new Map(
        results.map((result) => [
          result.sensorId,
          Object.fromEntries(
            result.channels
              .filter((channel) => MEMORY.includes(channel.key))
              .map((channel) => [channel.key, channel.value]),
          ),
        ]),
      );
      return { memory, drained };
    }

    it('records a protocol-20 probe’s lows since the last record, drained once for all its sensors', async () => {
      // Two sensors report on this probe. The second must not find the fold already emptied.
      const { memory, drained } = await swept(connected(), new Map([[probeId, FOLD]]));
      const expected = {
        memoryAvailable: 8.5,
        memoryAvailableBytes: 700,
        memoryLimitUsage: 91,
        memoryLimit: 4_096,
      };
      assert.deepEqual(memory.get(sensorId), expected);
      assert.deepEqual(memory.get(orphanId), expected, 'the sensor naming it records the same');
      assert.equal(drained, 1, 'drained once in the sweep');
      // What a scrape or the API reads is still the latest report.
      const { reading } = build(() => connected()).read(probeId);
      assert.equal(reading['memoryAvailable'], 23.4);
    });

    it('gaps them when a protocol-20 probe reported nothing since the last record', async () => {
      // At a heartbeat longer than thirty seconds, every other record has no report of its own;
      // repeating the last one would be a reading presented as new that nobody took.
      const { memory } = await swept(connected(), new Map());
      assert.deepEqual(memory.get(sensorId), {});
    });

    it('records a probe below 20 by its latest report, its last thirty seconds, as before', async () => {
      const { memory } = await swept(connected({ protocolVersion: 19 }), new Map());
      assert.deepEqual(memory.get(sensorId), {
        memoryAvailable: 23.4,
        memoryAvailableBytes: 1_860,
        memoryLimitUsage: 55.2,
        memoryLimit: 4_096,
      });
    });

    it('records what a dropped probe reported before it dropped, once', async () => {
      const { memory } = await swept(
        { connected: false },
        new Map([[probeId, { memoryAvailablePercent: 8.5 }]]),
      );
      assert.deepEqual(memory.get(sensorId), { memoryAvailable: 8.5 });
      const after = await swept({ connected: false }, new Map());
      assert.deepEqual(after.memory.get(sensorId), {}, 'and a gap once it has been recorded');
    });

    it('records the latest report on a core wired without the fold', async () => {
      const { memory } = await swept(connected());
      assert.equal(memory.get(sensorId)?.['memoryAvailable'], 23.4);
    });

    it('leaves the local probe’s machine to Core Health, folded or not (M-21)', async () => {
      // `read` gaps the local probe's machine pair; a fold laid over it would give the second
      // alarm for one squeeze back. Its own limit is not the machine's and is folded as anywhere.
      await db.query('UPDATE probe_config SET is_local = true WHERE object_id = $1', [probeId]);
      try {
        const own = { memoryLimitUsage: 91, memoryLimit: 4_096 };
        const { memory } = await swept(connected(), new Map([[probeId, FOLD]]));
        assert.deepEqual(memory.get(sensorId), own);
        const dropped = await swept({ connected: false }, new Map([[probeId, FOLD]]));
        assert.deepEqual(dropped.memory.get(sensorId), own, 'and once it has dropped');
      } finally {
        await db.query('UPDATE probe_config SET is_local = false WHERE object_id = $1', [probeId]);
      }
      const remote = await swept(connected(), new Map([[probeId, FOLD]]));
      assert.equal(remote.memory.get(sensorId)?.['memoryAvailable'], 8.5, 'the control');
    });
  });

  describe('the log lines a record counts (P-216 part 3)', () => {
    /**
     * One service across sweeps, so each record's count is against the one before, with every
     * path by which a sweep records nothing switchable between them (`P-250`).
     */
    function recorder(uptime = 10_000): {
      link: { current: ProbeLink };
      skip: { withhold: boolean; awaiting: boolean; noSensors: boolean };
      connected: { ids: number[] };
      sweep: () => Promise<Map<number, Record<string, number>>>;
    } {
      const link = { current: connected() };
      const skip = { withhold: false, awaiting: false, noSensors: false };
      const connectedIds = { ids: [probeId] };
      const results: CheckResult[] = [];
      // The sweep with no sensors at all: every query it makes finds nothing.
      const maybeEmpty = {
        query: (sql: string, params?: unknown[]) =>
          skip.noSensors ? Promise.resolve([]) : db.query(sql, params),
        tx: db.tx.bind(db),
      } as unknown as Database;
      const service = new ProbeHealthService({
        vouching: {
          refusals: (sensors) =>
            Promise.resolve(
              new Map(
                skip.withhold ? sensors.map((one) => [one.sensorId, 'withheld'] as const) : [],
              ),
            ),
          settle: () => Promise.resolve(0),
        },
        db: maybeEmpty,
        logger: silent,
        sources: {
          link: () => link.current,
          connectedProbeIds: () => (link.current.connected ? connectedIds.ids : []),
        },
        delivery: { verdictFor: () => null, awaitingFirstConnect: () => skip.awaiting },
        ingest: (batch) => {
          results.push(...batch);
          return Promise.resolve();
        },
        now: () => new Date('2026-08-28T00:00:25Z'),
        uptime: () => uptime,
      });
      return {
        link,
        skip,
        connected: connectedIds,
        sweep: async () => {
          results.length = 0;
          await service.sweep();
          return new Map(
            results.map((result) => [
              result.sensorId,
              Object.fromEntries(
                result.channels
                  .filter((channel) => channel.key.startsWith('log'))
                  .map((channel) => [channel.key, channel.value]),
              ),
            ]),
          );
        },
      };
    }

    const reporting = (logDropped: number, uptimeSeconds: number, logBacklogBytes = 0): ProbeLink =>
      connected({ health: { ...FULL, logDropped, logBacklogBytes, uptimeSeconds } });

    it('records the lines dropped since the last record, for every sensor on the probe', async () => {
      // A probe running from before this core: its total may already be on record, so a gap.
      const r = recorder(1_000);
      r.link.current = reporting(400, 5_000, 3 * 1024 * 1024);
      const first = await r.sweep();
      assert.deepEqual(first.get(sensorId), { logBacklog: 3 });
      r.link.current = reporting(460, 5_030);
      const second = await r.sweep();
      assert.equal(second.get(sensorId)?.['logDropped'], 60);
      // Taken once per probe per sweep: the second sensor must not read zero.
      assert.equal(second.get(orphanId)?.['logDropped'], 60);
      r.link.current = reporting(460, 5_060);
      assert.equal((await r.sweep()).get(sensorId)?.['logDropped'], 0, 'and clears');
    });

    it('gaps the first record of a new session, and counts from it (P-250)', async () => {
      // What a probe dropped while it was not connected fell in no sweep's window; counting it at
      // the reconnect would date it now. A restart is a new session too.
      const r = recorder(1_000);
      r.link.current = reporting(400, 5_000);
      await r.sweep();
      r.link.current = reporting(460, 5_030);
      assert.equal((await r.sweep()).get(sensorId)?.['logDropped'], 60);
      r.link.current = { connected: false };
      await r.sweep();
      const again = (total: number, uptimeSeconds: number): ProbeLink =>
        connected({
          connectedAt: new Date('2026-08-28T06:00:00Z'),
          health: { ...FULL, logDropped: total, logBacklogBytes: 0, uptimeSeconds },
        });
      r.link.current = again(3_000, 9_000);
      assert.equal('logDropped' in ((await r.sweep()).get(sensorId) ?? {}), false, 'a gap');
      r.link.current = again(3_004, 9_030);
      assert.equal((await r.sweep()).get(sensorId)?.['logDropped'], 4);
    });

    // **Every path by which a sweep records nothing lets the window go** (`P-250`). Before, the
    // baseline moved only where a record was written, so the first record after any of these
    // counted everything dropped while it lasted, stamped now: a warning for a stall long over.
    const SKIPS: readonly {
      name: string;
      set: (r: ReturnType<typeof recorder>) => Promise<void> | void;
      unset: (r: ReturnType<typeof recorder>) => Promise<void> | void;
    }[] = [
      {
        name: 'no sensors at all',
        set: (r) => {
          r.skip.noSensors = true;
        },
        unset: (r) => {
          r.skip.noSensors = false;
        },
      },
      {
        name: 'every sensor withheld',
        set: (r) => {
          r.skip.withhold = true;
        },
        unset: (r) => {
          r.skip.withhold = false;
        },
      },
      {
        name: 'the boot grace, before the probe is known to be there (M-22)',
        set: (r) => {
          r.skip.awaiting = true;
        },
        unset: (r) => {
          r.skip.awaiting = false;
        },
      },
    ];
    for (const path of SKIPS) {
      it(`lets go of what it dropped during ${path.name} (P-250)`, async () => {
        const r = recorder(1_000);
        r.link.current = reporting(400, 5_000);
        await r.sweep();
        await path.set(r);
        r.link.current = reporting(1_400, 5_030);
        const skipped = await r.sweep();
        assert.equal(skipped.get(sensorId)?.['logDropped'], undefined, 'nothing recorded');
        await path.unset(r);
        r.link.current = reporting(1_410, 5_060);
        assert.equal(
          (await r.sweep()).get(sensorId)?.['logDropped'],
          10,
          'the lines since the last sweep, not the thousand while it lasted',
        );
      });
    }

    it('lets go of what a probe with no Probe Health dropped, until one reports on it (P-250)', async () => {
      // Monday's lines, on a probe nobody watched, are not Thursday's warning.
      const r = recorder(1_000);
      r.connected.ids = [probeId, watcherId];
      r.link.current = reporting(400, 5_000);
      await r.sweep();
      r.link.current = reporting(1_400, 5_030);
      await r.sweep();
      // The orphan stops naming the remote probe and reports on the one it sits under.
      await db.query("UPDATE sensor_config SET params = '{}'::jsonb WHERE object_id = $1", [
        orphanId,
      ]);
      try {
        r.link.current = reporting(1_410, 5_060);
        assert.equal((await r.sweep()).get(orphanId)?.['logDropped'], 10);
      } finally {
        await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
          orphanId,
          JSON.stringify({ probeId }),
        ]);
      }
    });

    it('counts a probe that started after this core did in full on its first record', async () => {
      const r = recorder(10_000);
      r.link.current = reporting(25, 40);
      assert.equal((await r.sweep()).get(sensorId)?.['logDropped'], 25);
    });

    it('gaps a probe too old to report it, and one that is gone', async () => {
      const r = recorder();
      assert.deepEqual((await r.sweep()).get(sensorId), {});
      r.link.current = { connected: false };
      assert.deepEqual((await r.sweep()).get(sensorId), {});
    });

    it('leaves the local probe’s drops to Core Health, and keeps its backlog (M-21)', async () => {
      // One journal on a single host: both services drop at once when it stops reading, and two
      // sensors warning for one stall is the second alarm. Core Health counts these lines.
      await db.query('UPDATE probe_config SET is_local = true WHERE object_id = $1', [probeId]);
      try {
        const r = recorder(10_000);
        r.link.current = reporting(25, 40, 1024 * 1024);
        assert.deepEqual((await r.sweep()).get(sensorId), { logBacklog: 1 });
      } finally {
        await db.query('UPDATE probe_config SET is_local = false WHERE object_id = $1', [probeId]);
      }
    });
  });

  describe('the five-minute counts a sweep takes from running totals (`P-283`, `P-284`)', () => {
    /**
     * One service across sweeps thirty seconds apart on its own monotonic clock, so each count is
     * against the totals before it and the window can be walked out.
     */
    function counter(coreUptime = 1_000): {
      link: { current: ProbeLink };
      sweep: () => Promise<Record<string, number>>;
      /** The sentence the last sweep gave the sensor. */
      message: () => string;
    } {
      const link = { current: connected() };
      const clock = { ms: 0 };
      const results: CheckResult[] = [];
      const service = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        sources: {
          link: () => link.current,
          connectedProbeIds: () => (link.current.connected ? [probeId] : []),
        },
        ingest: (batch) => {
          results.push(...batch);
          return Promise.resolve();
        },
        now: () => new Date('2026-08-28T00:00:25Z'),
        uptime: () => coreUptime,
        monotonicMs: () => clock.ms,
      });
      let said = '';
      return {
        link,
        message: () => said,
        sweep: async () => {
          results.length = 0;
          await service.sweep();
          clock.ms += 30_000;
          said = results.find((result) => result.sensorId === sensorId)?.message ?? '';
          const mine = results.find((result) => result.sensorId === sensorId);
          return Object.fromEntries(
            (mine?.channels ?? [])
              .filter((one) =>
                ['scriptGroupsRefusedRecently', 'resultsDiscarded'].includes(one.key),
              )
              .map((one) => [one.key, one.value]),
          );
        },
      };
    }

    const refusing = (
      scriptGroupsRefused: number,
      uptimeSeconds: number,
      more: Partial<ProbeHealthReport> = {},
    ): ProbeLink => connected({ health: { ...FULL, scriptGroupsRefused, uptimeSeconds, ...more } });
    const refused = async (c: ReturnType<typeof counter>): Promise<number | undefined> =>
      (await c.sweep())['scriptGroupsRefusedRecently'];

    it('counts a refusal in the first record after a probe restart, which a rate cannot', async () => {
      // A probe running from before this core: its total may already have warned under the core
      // before, so it is the baseline, and the record that took it gaps (`P-284` review).
      const c = counter(1_000);
      c.link.current = refusing(3, 5_000);
      assert.equal(await refused(c), undefined, 'a baseline is a gap, not a zero');
      c.link.current = refusing(4, 5_030);
      assert.equal(await refused(c), 1);
      assert.match(c.message(), /1 process group a check process named as its own and was not/u);
      // **The counter reset.** The probe restarted and refused once in its first seconds: its
      // total fell from 4 to 1, and a counter's rate gaps on exactly this record.
      c.link.current = refusing(1, 12);
      assert.equal(await refused(c), 2, 'the one before, and the restarted probe’s whole total');
      // A restart whose new total is no lower than the old: the uptime says it restarted.
      c.link.current = refusing(2, 4);
      assert.equal(await refused(c), 4);
      c.link.current = refusing(2, 34);
      assert.equal(await refused(c), 4, 'nothing new, and nothing counted twice');
    });

    it('counts one made while the link was down on the first record back, however long the gap', async () => {
      const c = counter(1_000);
      c.link.current = refusing(0, 5_000);
      assert.equal(await refused(c), undefined, 'the baseline');
      c.link.current = { connected: false };
      for (let at = 0; at < 4; at += 1) await c.sweep();
      c.link.current = refusing(1, 5_150);
      assert.equal(await refused(c), 1, 'two minutes down');
      // Ten minutes down, longer than the window and than a counter's gap: the one before has
      // gone from the window, and the one made while down is counted on the first record back.
      c.link.current = { connected: false };
      for (let at = 0; at < 20; at += 1) await c.sweep();
      c.link.current = refusing(2, 5_800);
      assert.equal(await refused(c), 1);
    });

    it('lets a refusal go five minutes after the sweep that saw it, and not before', async () => {
      const c = counter(1_000);
      c.link.current = refusing(0, 5_000);
      await c.sweep();
      c.link.current = refusing(1, 5_030);
      assert.equal(await refused(c), 1);
      for (let sweep = 1; sweep <= 9; sweep += 1) {
        c.link.current = refusing(1, 5_030 + 30 * sweep);
        assert.equal(await refused(c), 1, `${String(30 * sweep)} s later`);
      }
      c.link.current = refusing(1, 5_330);
      assert.equal(await refused(c), 0, 'five minutes later');
    });

    it('counts a probe that started after this core did in full, and gaps one already running', async () => {
      const late = counter(10_000);
      late.link.current = refusing(2, 40);
      assert.equal(await refused(late), 2);
      const early = counter(1_000);
      early.link.current = refusing(2, 5_000);
      assert.equal(await refused(early), undefined, 'it cannot know, and says nothing');
      early.link.current = refusing(2, 5_030);
      assert.equal(await refused(early), 0, 'and reads from the next record');
    });

    // **The first report of a session is the baseline** (`P-283`, `P-284` review). A probe cut off
    // across a core restart reconnects with whatever it discarded while cut off already in its
    // first report, and the sweep after reads a later one. Taking the baseline at the sweep
    // absorbed both; a zero then said nothing was lost.
    it('gaps a discard already in the first report after a core restart, rather than reading 0', async () => {
      const c = counter(1_000);
      const report = { ...FULL, spoolRejected: 0, spoolOversized: 1, uptimeSeconds: 5_000 };
      c.link.current = connected({ health: report, firstHealth: report });
      assert.equal((await c.sweep())['resultsDiscarded'], undefined);
    });

    it('counts a discard made after the first report, on the sweep that meets the probe', async () => {
      // The probe sends that report the moment it is welcomed, before its drain sends anything
      // (`core-client.test.ts`), so a discard the drain makes after it is here.
      const c = counter(1_000);
      c.link.current = connected({
        firstHealth: { ...FULL, spoolRejected: 0, spoolOversized: 1, uptimeSeconds: 5_000 },
        health: { ...FULL, spoolRejected: 0, spoolOversized: 3, uptimeSeconds: 5_010 },
      });
      assert.equal((await c.sweep())['resultsDiscarded'], 2);
    });

    // **A restart inside a link gap longer than the old process's uptime** (`P-284` review). It
    // refused 2 at 100 s; an hour later a new process reconnects at 3,000 s. Both the uptime and,
    // in two of these, the total are higher, so only the `instanceId` says it restarted.
    const RESTARTS: readonly {
      name: string;
      total: number;
      instance: string;
      counted: number;
    }[] = [
      { name: 'restarted, the new total equal to the old', total: 2, instance: 'b', counted: 2 },
      { name: 'restarted, the new total below the old', total: 1, instance: 'b', counted: 1 },
      { name: 'restarted, the new total above the old', total: 3, instance: 'b', counted: 3 },
      { name: 'not restarted, and grown', total: 5, instance: 'a', counted: 3 },
      { name: 'not restarted, and not grown', total: 2, instance: 'a', counted: 0 },
    ];
    for (const one of RESTARTS) {
      it(`across an hour's link gap: ${one.name}`, async () => {
        // A probe that started after this core, so it is counted from its first record.
        const c = counter(10_000);
        c.link.current = refusing(0, 70, { instanceId: 'a' });
        assert.equal(await refused(c), 0);
        c.link.current = refusing(2, 100, { instanceId: 'a' });
        assert.equal(await refused(c), 2);
        c.link.current = { connected: false };
        for (let at = 0; at < 120; at += 1) await c.sweep();
        // The uptime is higher either way: 3,700 s for the same process an hour on, 3,000 s for
        // one started in the gap.
        c.link.current = refusing(one.total, one.instance === 'a' ? 3_700 : 3_000, {
          instanceId: one.instance,
        });
        assert.equal(await refused(c), one.counted);
      });
    }

    it('counts what the drain discarded, either way, as one count (`P-283`)', async () => {
      const c = counter(1_000);
      const discarding = (rejected: number, oversized: number, uptime: number): ProbeLink =>
        refusing(0, uptime, { spoolRejected: rejected, spoolOversized: oversized });
      c.link.current = discarding(0, 0, 5_000);
      assert.equal((await c.sweep())['resultsDiscarded'], undefined, 'the baseline');
      c.link.current = discarding(40, 0, 5_030);
      assert.equal((await c.sweep())['resultsDiscarded'], 40);
      assert.match(c.message(), /40 results discarded unsent in the last 5 minutes/u);
      c.link.current = discarding(0, 1, 9);
      const restarted = await c.sweep();
      assert.equal(restarted['resultsDiscarded'], 41, 'a restart, and one too large');
      // Not the refused groups' count, and not theirs in it.
      assert.equal(restarted['scriptGroupsRefusedRecently'], 0);
    });

    it('gaps each for a probe that sends no total, and for one that is gone', async () => {
      const c = counter(1_000);
      c.link.current = connected();
      assert.deepEqual(await c.sweep(), {}, 'a probe below 31 sends neither total');
      c.link.current = refusing(1, 5_000);
      assert.deepEqual(await c.sweep(), {}, 'below 32, one, whose baseline gaps');
      c.link.current = refusing(1, 5_030);
      assert.deepEqual(await c.sweep(), { scriptGroupsRefusedRecently: 0 }, 'below 32, one');
      c.link.current = { connected: false };
      assert.deepEqual(await c.sweep(), {});
    });
  });

  describe('a low no record takes (P-245)', () => {
    /** The endpoint's folds as a sweep sees them: lows folded in by probe, drained whole. */
    class Folds {
      readonly #folds = new Map<number, MemoryFold>();
      drains = 0;
      fold(probe: number, memoryAvailablePercent: number): void {
        const was = this.#folds.get(probe)?.memoryAvailablePercent ?? memoryAvailablePercent;
        this.#folds.set(probe, {
          memoryAvailablePercent: Math.min(was, memoryAvailablePercent),
        });
      }
      readonly drain = (): ReadonlyMap<number, MemoryFold> => {
        this.drains += 1;
        const all = new Map(this.#folds);
        this.#folds.clear();
        return all;
      };
    }

    const sweeper = (
      folds: Folds,
      over: Partial<ProbeHealthServiceOptions> = {},
      link: () => ProbeLink = () => connected(),
    ): ProbeHealthService =>
      new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        ingest: () => Promise.resolve(),
        now: () => new Date('2026-08-28T00:00:25Z'),
        ...over,
        sources: { link, drainMemory: folds.drain },
      });

    const rows = (sensors: readonly Record<string, unknown>[]): Database =>
      ({
        query: () => Promise.resolve(sensors),
        tx: () => Promise.resolve({}),
      }) as unknown as Database;

    /** Each way a sweep can pass a probe by without recording it. */
    const unrecorded: [string, (folds: Folds) => Promise<unknown>][] = [
      ['no Probe Health sensor at all', (folds) => sweeper(folds, { db: rows([]) }).sweep()],
      [
        'sensors, but none on this probe',
        (folds) =>
          sweeper(folds, { db: rows([{ id: '98', params: {}, probe_id: '424242' }]) }).sweep(),
      ],
      [
        'its sensors withheld (A-29)',
        (folds) =>
          sweeper(folds, {
            vouching: {
              refusals: () =>
                Promise.resolve(
                  new Map([
                    [sensorId, 'withheld'],
                    [orphanId, 'withheld'],
                  ]),
                ),
              settle: () => Promise.resolve(0),
            },
          }).sweep(),
      ],
      [
        'a sensor that resolves to no probe',
        (folds) => sweeper(folds, { db: rows([{ id: '99', params: {}, probe_id: null }]) }).sweep(),
      ],
      [
        'the boot grace (M-22)',
        (folds) =>
          sweeper(folds, {
            delivery: { verdictFor: () => null, awaitingFirstConnect: () => true },
          }).sweep(),
      ],
      [
        'a sweep that failed',
        (folds) =>
          assert.rejects(
            sweeper(folds, {
              db: {
                query: () => Promise.reject(new Error('the database went away')),
              } as unknown as Database,
            }).sweep(),
          ),
      ],
    ];

    /** What the next ordinary sweep records for the probe's own sensor. */
    async function recorded(folds: Folds): Promise<number | undefined> {
      const results: CheckResult[] = [];
      await sweeper(folds, {
        ingest: (batch) => {
          results.push(...batch);
          return Promise.resolve();
        },
      }).sweep();
      const mine = results.find((result) => result.sensorId === sensorId);
      return (
        mine?.channels.find((channel) => channel.key === 'memoryAvailable')?.value ?? undefined
      );
    }

    it('the control: a low since the last sweep is recorded, however many reports came after', async () => {
      const folds = new Folds();
      folds.fold(probeId, 4);
      folds.fold(probeId, 60);
      assert.equal(await recorded(folds), 4);
    });

    for (const [name, pass] of unrecorded) {
      it(`lets a low go when the sweep records nothing of its probe: ${name}`, async () => {
        // Monday's 4% under a probe nobody was recording, and Thursday's first record with 60%
        // free. Carried over, it was a fresh Down for a squeeze three days over.
        const folds = new Folds();
        folds.fold(probeId, 4);
        await pass(folds);
        assert.equal(folds.drains, 1, 'drained by the sweep that recorded nothing');
        folds.fold(probeId, 60);
        assert.equal(await recorded(folds), 60);
      });
    }
  });

  describe('a probe that is not answering', () => {
    it('reports the link down and every other channel as a gap', () => {
      // **The reading this sensor exists for.** The probe's numbers are not zero, they are
      // unknown — and a scheduler lag of 0 ms from a probe that is gone would be the most
      // confidently wrong number this system could store.
      const { reading, message } = build(() => ({ connected: false })).read(probeId);
      assert.equal(reading['connected'], 0);
      assert.equal(message, 'not connected to the core');
      assert.deepEqual(build(() => ({ connected: false })).read(probeId).unavailable, {
        reason: 'not-connected',
      });
      for (const key of PROBE_HEALTH_CHANNELS) {
        if (key === 'connected') continue;
        assert.equal(reading[key], null, `${key} should be a gap, not a zero`);
      }
    });

    it('sends exactly one channel reading, so nothing downstream sees a zero', () => {
      const { reading } = build(() => ({ connected: false })).read(probeId);
      assert.deepEqual(
        readingsFrom(reading).map((one) => one.key),
        ['connected'],
      );
    });
  });

  describe('a probe too old to report its own numbers', () => {
    it('still reports what the core knows, and says why the rest is missing', () => {
      // `R-06`'s rule: a probe that connects and quietly does less than it should is the failure
      // worth making visible. Silently absent channels would look like a probe with nothing to
      // report rather than one that cannot report.
      const old: ProbeLink = {
        connected: true,
        gid: 'probe-gid',
        clockOffsetMs: null,
        protocolVersion: 3,
        connectedAt: new Date('2026-08-28T00:00:00Z'),
        lastHeartbeatAt: new Date('2026-08-28T00:00:20Z'),
        approved: true,
        agentVersion: '0.4.0',
        assignedSensors: 12,
        cadenceSeconds: 60,
        connectedForMs: Number.MAX_SAFE_INTEGER,
        sinceResultsMs: 0,
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: new Date('2026-08-28T00:00:20Z'),
        configSentAt: new Date('2026-08-28T00:00:00Z'),
        // No `health` at all: a probe below protocol 7 sends none.
      };
      const { reading, message } = build(() => old).read(probeId);
      assert.equal(reading['connected'], 1);
      assert.equal(reading['heartbeatAge'], 5);
      assert.equal(reading['protocol'], 1, 'outdated');
      assert.equal(reading['schedulerLag'], null);
      assert.match(message, /its own numbers are unavailable/);
      assert.match(message, /speaks protocol 3/);
      assert.deepEqual(build(() => old).read(probeId).unavailable, {
        reason: 'protocol',
        protocolVersion: 3,
        requiredVersion: 7,
      });
    });

    it('calls a version below the minimum incompatible rather than merely old', () => {
      // Down, not Warning: the link is refused, so nothing under that probe is scanned at all.
      const { reading } = build(() => connected({ protocolVersion: 0 })).read(probeId);
      assert.equal(reading['protocol'], 2);
    });

    it('reports a probe newer than this build as a skew, not as incompatible', () => {
      // **`P-178` changed what this means, deliberately.** A newer peer used to be refused at the
      // handshake, so the only honest reading was `incompatible` (2). Both ends negotiate down
      // now — the pair speaks this core's version — so the probe is connected and working, and
      // what an operator needs to know is that upgrading *this end* would unlock more. That is
      // the same fact `outdated` carries, so it shares its code (1): which end is behind is in
      // the explanation, and a fourth code would change a lookup operators have mapped to states.
      const { reading, message } = build(() =>
        connected({ protocolVersion: PROTOCOL_VERSION + 1 }),
      ).read(probeId);
      assert.equal(reading['protocol'], 1);
      assert.match(message, /newer than this build/);
    });

    it('still calls a version below the floor incompatible', () => {
      const { reading } = build(() =>
        connected({ protocolVersion: MIN_PROTOCOL_VERSION - 1 }),
      ).read(probeId);
      assert.equal(reading['protocol'], 2, 'there is no shared language to negotiate down to');
    });
  });

  describe('why a connected probe’s own numbers are missing (`P-255`)', () => {
    // Four seconds after a restart the field test read "its own numbers are unavailable — it
    // speaks protocol 28, the same as this build": the protocol given as the reason when the
    // reason was that no heartbeat had arrived yet, which sent an operator looking at versions.
    // Each case below is one the code tells apart, and only `protocol` may name a version.
    // Connected 4.2 s ago, with no heartbeat and so no numbers yet.
    const fresh = (overrides: Partial<Extract<ProbeLink, { connected: true }>> = {}): ProbeLink => {
      const link = connected({ lastHeartbeatAt: null, connectedForMs: 4_200, ...overrides });
      if (link.connected) delete link.health;
      return link;
    };

    /** The real API, with authentication off: the question here is the shape, not who asks. */
    const serve = async (service: ProbeHealthService): Promise<FastifyInstance> => {
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: false,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        // Declared only so the health routes register; this route never reads it.
        coreHealth: () => undefined,
        probeHealth: () => service,
        auth: {
          accounts: new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups: new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required: false,
        },
      });
      await server.build('9.9.9', harness.service);
      return server.app;
    };

    it('says a probe with no heartbeat yet has none yet, and names no protocol', () => {
      const { reading, message, unavailable } = build(() => fresh()).read(probeId);
      assert.equal(reading['connected'], 1);
      assert.equal(reading['protocol'], 0, 'the same version as this build');
      assert.equal(reading['heartbeatAge'], null);
      assert.equal(reading['schedulerLag'], null);
      assert.deepEqual(unavailable, { reason: 'no-heartbeat', connectedSeconds: 4 });
      assert.equal(
        message,
        'connected; its own numbers are not in yet — no heartbeat has arrived in the 4 s since ' +
          'it connected',
      );
      assert.doesNotMatch(message, /protocol/);
    });

    it('gives a long wait for the first heartbeat in minutes', () => {
      const { message } = build(() => fresh({ connectedForMs: 610_000 })).read(probeId);
      assert.match(message, /no heartbeat has arrived in the 11 minutes since it connected/);
    });

    it('names the protocol when it is older than the numbers need, heartbeat or none', () => {
      // First, because a probe too old to carry its numbers will not carry them on its first
      // heartbeat either: waiting for one is not the answer, upgrading it is.
      const { message, unavailable } = build(() => fresh({ protocolVersion: 6 })).read(probeId);
      assert.deepEqual(unavailable, { reason: 'protocol', protocolVersion: 6, requiredVersion: 7 });
      assert.match(message, /its own numbers are unavailable — it speaks protocol 6, this build/);
      assert.match(message, /report its own scheduler and pool health/);
      assert.doesNotMatch(message, /heartbeat/);
    });

    it('names a protocol below the floor as the reason too', () => {
      const { unavailable, message } = build(() =>
        fresh({ protocolVersion: MIN_PROTOCOL_VERSION - 1 }),
      ).read(probeId);
      assert.equal(unavailable?.reason, 'protocol');
      assert.match(message, /older than the oldest this build understands/);
    });

    it('names a real skew as a skew beside a missing heartbeat, not as its reason', () => {
      // Protocol 7 reports its numbers and lacks later things: the skew is worth a sentence, as
      // it is on a probe that reports, and the reason is still the heartbeat.
      const behind = build(() => fresh({ protocolVersion: 7 })).read(probeId);
      assert.equal(behind.unavailable?.reason, 'no-heartbeat');
      assert.match(behind.message, /^connected; its own numbers are not in yet — no heartbeat/);
      assert.match(behind.message, /; speaks protocol 7, this build speaks /);

      const ahead = build(() => fresh({ protocolVersion: PROTOCOL_VERSION + 1 })).read(probeId);
      assert.equal(ahead.unavailable?.reason, 'no-heartbeat');
      assert.match(ahead.message, /no heartbeat has arrived/);
      assert.match(ahead.message, /newer than this build/);
    });

    it('says heartbeats that carry no numbers do, and names no protocol', () => {
      const { message, unavailable } = build(() =>
        fresh({ lastHeartbeatAt: new Date('2026-08-28T00:00:20Z') }),
      ).read(probeId);
      assert.deepEqual(unavailable, { reason: 'not-reported' });
      assert.equal(
        message,
        'connected; its own numbers are unavailable — its heartbeats arrive without them',
      );
    });

    it('has no reason at all for a probe that reported', () => {
      const { unavailable, message } = build(() => connected()).read(probeId);
      assert.equal(unavailable, null);
      assert.doesNotMatch(message, /unavailable|not in yet/);
    });

    it('serves the reason on the route as a value, beside the sentence', async () => {
      // The schema has `additionalProperties: false`, so a field it does not declare is dropped
      // on the way out without an error: only a request through the route shows it arrives.
      for (const [link, expected] of [
        [fresh(), { reason: 'no-heartbeat', connectedSeconds: 4 }],
        [
          fresh({ protocolVersion: 6 }),
          { reason: 'protocol', protocolVersion: 6, requiredVersion: 7 },
        ],
        [fresh({ lastHeartbeatAt: new Date() }), { reason: 'not-reported' }],
        [{ connected: false }, { reason: 'not-connected' }],
        [connected(), null],
      ] as const) {
        const app = await serve(build(() => link));
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/probes/${String(probeId)}/health`,
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<{ message: string; numbersUnavailable: unknown }>();
        assert.deepEqual(body.numbersUnavailable, expected, body.message);
        await app.close();
      }
    });

    it('serves the version the probe speaks, and null for one not connected (U-30)', async () => {
      // A probe that reports, below the version a listener's counters arrived in, leaves them
      // out whether the listener runs or not: the add-sensor form needs the version to tell that
      // from a listener that is off. Through the route, for the same reason as the case above.
      for (const [link, expected] of [
        [connected({ protocolVersion: 22 }), 22],
        [connected(), PROTOCOL_VERSION],
        [fresh({ protocolVersion: 6 }), 6],
        [{ connected: false }, null],
      ] as const) {
        const service = build(() => link);
        assert.equal(service.read(probeId).protocolVersion, expected);
        const app = await serve(service);
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/probes/${String(probeId)}/health`,
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<{ protocolVersion: unknown }>();
        assert.ok('protocolVersion' in body, response.body);
        assert.equal(body.protocolVersion, expected, response.body);
        await app.close();
      }
    });

    describe('the version a probe last connected with (U-31)', () => {
      // A probe that is down gave the form no version, while the one recorded at its last
      // handshake already said whether it could report a listener. `GET /probes` has it, and is
      // the installation's because the row also holds the probe's address, its filter and its
      // key's hash: only the integer comes here, under the probe's own `read` right.
      const ADDRESS = '203.0.113.77';
      const HASH = 'f'.repeat(64);
      const register = async (
        gid: string,
        objectId: number,
        status: 'approved' | 'revoked',
        protocolVersion: number,
      ): Promise<void> => {
        await db.query(
          `INSERT INTO probe_registration
             (gid, status, display_name, protocol_version, last_address, allow_from,
              access_key_hash, object_id, note)
           VALUES ($1, $2, 'u31-probe', $3, $4, ARRAY['203.0.113.0/24'], $5, $6, 'u31-note')`,
          [gid, status, protocolVersion, ADDRESS, HASH, objectId],
        );
      };
      const ask = async (
        service: ProbeHealthService,
        id: number,
      ): Promise<{ status: number; body: string; json: Record<string, unknown> }> => {
        const app = await serve(service);
        try {
          const response = await app.inject({
            method: 'GET',
            url: `/api/v1/probes/${String(id)}/health`,
          });
          return {
            status: response.statusCode,
            body: response.body,
            json: response.json<Record<string, unknown>>(),
          };
        } finally {
          await app.close();
        }
      };

      before(async () => {
        // A revoked identity beside the live one: it no longer holds the probe, so its version
        // is not the probe's. The watcher has only a revoked one.
        await register('u31-revoked', probeId, 'revoked', 5);
        await register('u31-live', probeId, 'approved', 12);
        await register('u31-watcher-revoked', watcherId, 'revoked', 9);
      });
      after(async () => {
        await db.query("DELETE FROM probe_registration WHERE gid LIKE 'u31-%'");
      });

      it('serves the recorded version for a probe that is not connected, and nothing else of the row', async () => {
        const service = build(() => ({ connected: false }));
        assert.equal((await service.lastProtocol(probeId)).version, 12);
        const answer = await ask(service, probeId);
        assert.equal(answer.status, 200, answer.body);
        assert.equal(answer.json['protocolVersion'], null, 'not connected: no live version');
        assert.equal(answer.json['lastProtocolVersion'], 12, answer.body);
        assert.deepEqual(
          Object.keys(answer.json).sort(),
          [
            'at',
            'channels',
            'lastProtocolRefusedAt',
            'lastProtocolVersion',
            'lastProtocolVersionAt',
            'message',
            'numbersUnavailable',
            'probeId',
            'protocolVersion',
          ],
          answer.body,
        );
        for (const secret of [ADDRESS, '203.0.113.0/24', HASH, 'u31-live', 'u31-note']) {
          assert.ok(!answer.body.includes(secret), `${secret} reached the answer: ${answer.body}`);
        }
      });

      it('serves it beside the live version for a connected probe, each as it is', async () => {
        // The live one decides for a connected probe; the recorded one is the handshake's word.
        const answer = await ask(
          build(() => connected({ protocolVersion: 22 })),
          probeId,
        );
        assert.equal(answer.json['protocolVersion'], 22, answer.body);
        assert.equal(answer.json['lastProtocolVersion'], 12, answer.body);
      });

      it('serves null where nothing is recorded: a revoked identity, or zero', async () => {
        const service = build(() => ({ connected: false }));
        assert.equal((await service.lastProtocol(watcherId)).version, null, 'only a revoked one');
        const watcher = await ask(service, watcherId);
        assert.equal(watcher.status, 200, watcher.body);
        assert.equal(watcher.json['lastProtocolVersion'], null, watcher.body);

        // Zero is what the `R-01` upgrade left for a probe that has not connected since.
        await db.query("UPDATE probe_registration SET protocol_version = 0 WHERE gid = 'u31-live'");
        try {
          assert.equal((await service.lastProtocol(probeId)).version, null);
          assert.equal((await ask(service, probeId)).json['lastProtocolVersion'], null);
        } finally {
          await db.query(
            "UPDATE probe_registration SET protocol_version = 12 WHERE gid = 'u31-live'",
          );
        }
      });

      describe('and when it was accepted (U-32)', () => {
        // The form says a probe that is down was too old "when it last connected", and now says
        // when. `last_seen_at` is moved by every hello, refused ones too, so it is set to another
        // time here to show it is not what is served.
        const ACCEPTED = '2026-10-01T08:30:00.000Z';
        const SEEN = '2026-10-07T23:59:00.000Z';
        const stamp = (gid: string, at: string | null, seen: string | null): Promise<unknown> =>
          db.query(
            `UPDATE probe_registration SET protocol_accepted_at = $2, last_seen_at = $3
             WHERE gid = $1`,
            [gid, at, seen],
          );
        afterEach(async () => {
          await db.query(
            `UPDATE probe_registration SET protocol_accepted_at = NULL, last_seen_at = NULL
             WHERE gid LIKE 'u31-%'`,
          );
        });

        it('serves the time the recorded version was accepted, not when the probe was last seen', async () => {
          await stamp('u31-live', ACCEPTED, SEEN);
          // A revoked identity's time is no more the probe's than its version is.
          await stamp('u31-revoked', '2026-10-06T00:00:00.000Z', SEEN);
          const service = build(() => ({ connected: false }));
          assert.deepEqual(await service.lastProtocol(probeId), {
            version: 12,
            at: ACCEPTED,
            refusedAt: null,
          });

          const answer = await ask(service, probeId);
          assert.equal(answer.status, 200, answer.body);
          assert.equal(answer.json['lastProtocolVersion'], 12, answer.body);
          assert.equal(answer.json['lastProtocolVersionAt'], ACCEPTED, answer.body);
          assert.ok(!answer.body.includes('2026-10-07T23:59'), `last seen served: ${answer.body}`);
          assert.ok(!answer.body.includes('2026-10-06'), `revoked time served: ${answer.body}`);

          // Connected, it is served beside the live version just the same.
          const live = await ask(
            build(() => connected({ protocolVersion: 22 })),
            probeId,
          );
          assert.equal(live.json['lastProtocolVersionAt'], ACCEPTED, live.body);
        });

        it('serves null for the time where the version stands without one, and with none', async () => {
          // A version a hello was refused over, or one recorded before migration 072.
          await stamp('u31-live', null, SEEN);
          const service = build(() => ({ connected: false }));
          assert.deepEqual(await service.lastProtocol(probeId), {
            version: 12,
            at: null,
            refusedAt: null,
          });
          const answer = await ask(service, probeId);
          assert.equal(answer.json['lastProtocolVersion'], 12, answer.body);
          assert.ok('lastProtocolVersionAt' in answer.json, answer.body);
          assert.equal(answer.json['lastProtocolVersionAt'], null, answer.body);

          // Only a revoked identity, however recently it was accepted: neither.
          await stamp('u31-watcher-revoked', ACCEPTED, SEEN);
          assert.deepEqual(await service.lastProtocol(watcherId), {
            version: null,
            at: null,
            refusedAt: null,
          });
          const watcher = await ask(service, watcherId);
          assert.equal(watcher.json['lastProtocolVersionAt'], null, watcher.body);
        });
      });

      describe('and when it was refused (U-35)', () => {
        // A hello refused over its version records the version and when. A refusal at 0 was read
        // as the `R-01` upgrade's "nothing recorded", so the form told a probe that is refused at
        // every hello "This updates when it connects".
        const REFUSED = '2026-10-07T06:00:00.000Z';
        const refuse = (gid: string, version: number, at: string | null): Promise<unknown> =>
          db.query(
            `UPDATE probe_registration
             SET protocol_version = $2, protocol_accepted_at = NULL, protocol_refused_at = $3
             WHERE gid = $1`,
            [gid, version, at],
          );
        afterEach(async () => {
          await db.query(
            `UPDATE probe_registration SET protocol_refused_at = NULL, protocol_accepted_at = NULL
             WHERE gid LIKE 'u31-%'`,
          );
          await refuse('u31-live', 12, null);
        });

        it('serves a refusal at 0 as 0 and its time, not as nothing recorded', async () => {
          await refuse('u31-live', 0, REFUSED);
          const service = build(() => ({ connected: false }));
          assert.deepEqual(await service.lastProtocol(probeId), {
            version: 0,
            at: null,
            refusedAt: REFUSED,
          });
          const answer = await ask(service, probeId);
          assert.equal(answer.status, 200, answer.body);
          assert.equal(answer.json['lastProtocolVersion'], 0, answer.body);
          assert.equal(answer.json['lastProtocolVersionAt'], null, answer.body);
          assert.equal(answer.json['lastProtocolRefusedAt'], REFUSED, answer.body);

          // A 0 with no refusal beside it is still the upgrade's: nothing recorded.
          await refuse('u31-live', 0, null);
          assert.deepEqual(await service.lastProtocol(probeId), {
            version: null,
            at: null,
            refusedAt: null,
          });
          const nothing = await ask(service, probeId);
          assert.equal(nothing.json['lastProtocolVersion'], null, nothing.body);
          assert.equal(nothing.json['lastProtocolRefusedAt'], null, nothing.body);
        });

        it('serves the refusal’s time beside any version, and never a revoked identity’s', async () => {
          await refuse('u31-live', 12, REFUSED);
          await refuse('u31-watcher-revoked', 0, REFUSED);
          const service = build(() => ({ connected: false }));
          const answer = await ask(service, probeId);
          assert.equal(answer.json['lastProtocolVersion'], 12, answer.body);
          assert.equal(answer.json['lastProtocolRefusedAt'], REFUSED, answer.body);

          const watcher = await ask(service, watcherId);
          assert.equal(watcher.json['lastProtocolVersion'], null, watcher.body);
          assert.equal(watcher.json['lastProtocolRefusedAt'], null, watcher.body);
        });

        describe('and the message says so (P-317)', () => {
          // The answer carried the refusal's time while its sentence said only "not connected to
          // the core". The time in the sentence is the wall clock's, as ISO 8601: never "ago".
          const ACCEPTED = '2026-10-01T08:30:00.000Z';
          const said = (version: number, at: string): string =>
            `the last hello refused over its version, at ${at}, spoke protocol ` +
            `${String(version)}; this core accepts protocol ${String(MIN_PROTOCOL_VERSION)} ` +
            'or newer';
          // What `ProbeRegistry.#speaks` writes for an accepted handshake.
          const accept = (version: number, at: string): Promise<unknown> =>
            db.query(
              `UPDATE probe_registration
               SET protocol_version = $1, protocol_accepted_at = $2, protocol_refused_at = NULL
               WHERE gid = 'u31-live'`,
              [version, at],
            );
          afterEach(async () => {
            await refuse('u31-live', 12, null);
          });

          it('names a version refused at a probe’s every hello, and when', async () => {
            await refuse('u31-live', 0, REFUSED);
            const answer = await ask(
              build(() => ({ connected: false })),
              probeId,
            );
            assert.equal(answer.status, 200, answer.body);
            assert.equal(
              answer.json['message'],
              `not connected to the core; ${said(0, REFUSED)}`,
              answer.body,
            );
            assert.doesNotMatch(answer.json['message'], /\bago\b/);
            // Not "its last hello": a later hello refused before it proved it is this probe
            // writes nothing, so the row cannot say what the last hello was (`P-317` review).
            assert.doesNotMatch(answer.json['message'], /its last hello/i);
          });

          it('names a refusal after an earlier accept, by the refusal’s time and not the accept’s', async () => {
            await accept(12, ACCEPTED);
            const service = build(() => ({ connected: false }));
            assert.equal(
              (await ask(service, probeId)).json['message'],
              'not connected to the core',
            );

            // Then refused over its version, which clears the accepted time, as `#speaks` does.
            await refuse('u31-live', 0, REFUSED);
            const answer = await ask(service, probeId);
            assert.equal(
              answer.json['message'],
              `not connected to the core; ${said(0, REFUSED)}`,
              answer.body,
            );
            assert.ok(!answer.json['message'].includes(ACCEPTED), answer.body);

            // A nonzero version refused (by a core whose floor was higher) is named as it is.
            await refuse('u31-live', 12, REFUSED);
            assert.equal(
              (await ask(service, probeId)).json['message'],
              `not connected to the core; ${said(12, REFUSED)}`,
            );

            // Beside a live link it is a hello refused after that link's handshake, from another
            // process speaking for this probe, and is said after what the link says.
            const live = await ask(
              build(() => connected({ protocolVersion: PROTOCOL_VERSION })),
              probeId,
            );
            const message = String(live.json['message']);
            assert.ok(message.startsWith('connected'), live.body);
            assert.ok(message.endsWith(`; ${said(12, REFUSED)}`), live.body);
          });

          it('says nothing of a refusal once a handshake is accepted again', async () => {
            await refuse('u31-live', 0, REFUSED);
            await accept(PROTOCOL_VERSION, '2026-10-08T09:00:00.000Z');
            const service = build(() => ({ connected: false }));
            const answer = await ask(service, probeId);
            assert.equal(answer.json['lastProtocolRefusedAt'], null, answer.body);
            assert.equal(answer.json['message'], 'not connected to the core', answer.body);

            // Nor of a 0 with no refusal beside it, which is nothing recorded (`P-316`).
            await refuse('u31-live', 0, null);
            assert.equal(
              (await ask(service, probeId)).json['message'],
              'not connected to the core',
            );
          });
        });
      });

      it('answers null rather than refusing when the database cannot be asked', async () => {
        // The rest of the answer needs no database (`P-126`); a probe that is down is when this
        // is read.
        const down = new ProbeHealthService({
          vouching: everyVoucherHolds,
          db: {
            query: () => Promise.reject(new Error('connection terminated')),
          } as unknown as Database,
          logger: silent,
          sources: { link: () => ({ connected: false }) },
          ingest: () => Promise.resolve(),
        });
        assert.deepEqual(await down.lastProtocol(probeId), {
          version: null,
          at: null,
          refusedAt: null,
        });
        const answer = await ask(down, probeId);
        assert.equal(answer.status, 200, answer.body);
        assert.equal(answer.json['lastProtocolVersion'], null, answer.body);
        assert.equal(answer.json['lastProtocolVersionAt'], null, answer.body);
        assert.equal(answer.json['lastProtocolRefusedAt'], null, answer.body);
        assert.equal(answer.json['message'], 'not connected to the core');
      });
    });
  });

  describe('turning a reading into channel readings', () => {
    it('leaves a gap out rather than sending it as zero', () => {
      const readings = readingsFrom({ connected: 1, schedulerLag: null });
      assert.deepEqual(
        readings.map((one) => one.key),
        ['connected'],
      );
    });

    it('sends the declared counters as counter text', () => {
      const readings = readingsFrom({ deferred: 7, refused: 2, connected: 1 });
      for (const reading of readings) {
        if (PROBE_HEALTH_COUNTERS.has(reading.key)) {
          assert.equal(reading.counter, String(reading.value), reading.key);
          assert.equal(reading.counterBits, 64, reading.key);
        } else {
          assert.equal(reading.counter, undefined, reading.key);
        }
      }
    });
  });

  describe('a probe whose clock was wrong (`P-231`)', () => {
    const CONFIG: IngestionConfig = {
      queueMaxRows: 200_000,
      batchMaxRows: 5_000,
      batchMaxDelayMs: 5,
      slowDownAtPercent: 50,
      retryAfterMs: 1_000,
      replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
    };

    // Just behind the core's own clock, so that nothing here is a replay held back from reacting
    // (`P-157`) or a result refused for its time. Shared, because both tests below write to the
    // same sensor and a result earlier than its last would be dropped as stale.
    let now = new Date(Date.now() - 5 * 60_000);
    const quiet: ProbeHealthReport = { ...FULL, spoolStalledMs: 0, sessionOverflows: 0 };

    /**
     * A Probe Health sweep that goes the whole way — ingestion, the limit, the state machine —
     * with its sources read at the time of each sweep, thirty seconds apart.
     */
    const sweeper = async (
      sources: (at: Date) => ProbeHealthSources,
    ): Promise<() => Promise<{ state: string; message: string }>> => {
      const lookups = await loadLookups({ logger: silent });
      const states = new SensorStateService({
        db,
        logger: silent,
        settings: harness.resolver,
        pauses: new PauseRepository(),
      });
      const channels = new ChannelResolver({ logger: silent, lookups });
      return async () => {
        const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
        const ingestion = new IngestionService({
          db,
          logger: silent,
          ingestor,
          states,
          resolver: channels,
        });
        await new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: sources(now),
          ingest: async (results) => {
            await ingestion.acceptResults('probe-health', {
              type: 'results',
              batchId: `probe-health-${now.toISOString()}`,
              results: [...results],
            });
          },
          now: () => now,
        }).sweep();
        await ingestor.stop();
        now = new Date(now.getTime() + 30_000);
        const rows = await db.query<{ state: string; message: string }>(
          'SELECT state, message FROM sensor_runtime WHERE object_id = $1',
          [sensorId],
        );
        assert.ok(rows[0]);
        return rows[0];
      };
    };

    it('warns on the first reading that has refusals, and clears once they stop', async () => {
      // **The warning has to see the first batch and clear itself.** A running count only goes
      // up, so a limit on it would warn for ever after one bad batch. A counter's rate clears, but
      // it is a gap on the first reading, and after every core restart, which is when a wrong
      // clock first shows. So the channel is what the core refused in the last five minutes, a
      // gauge. This goes through the whole path — the sweep, ingestion, the limit, the state
      // machine — because each of them is a place that could miss it or latch it.
      let future = 0;
      const sweep = await sweeper((at) => ({
        link: () => connected({ lastHeartbeatAt: at, health: quiet }),
        timeRefusals: () => ({ past: 0, future }),
      }));

      future = 30;
      const refusing = await sweep();
      assert.equal(refusing.state, 'warning', 'on the very first reading this sensor has had');
      assert.match(refusing.message, /clock is ahead of the core/u);

      future = 0;
      const fixed = await sweep();
      assert.equal(fixed.state, 'up', `the window emptied: ${fixed.message}`);

      future = 1;
      const again = await sweep();
      assert.equal(again.state, 'warning', 'one refused result is enough');
    });

    /**
     * A Probe Health service that goes the whole way, as `sweeper` does, but one service across
     * every sweep: the five-minute counts are the service's (`P-283`, `P-284`).
     */
    const lasting = async (
      link: () => ProbeLink,
    ): Promise<() => Promise<{ state: string; message: string }>> => {
      const lookups = await loadLookups({ logger: silent });
      const states = new SensorStateService({
        db,
        logger: silent,
        settings: harness.resolver,
        pauses: new PauseRepository(),
      });
      const channels = new ChannelResolver({ logger: silent, lookups });
      const service = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link,
          timeRefusals: () => ({ past: 0, future: 0 }),
          connectedProbeIds: () => (link().connected ? [probeId] : []),
        },
        ingest: async (results) => {
          const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
          const ingestion = new IngestionService({
            db,
            logger: silent,
            ingestor,
            states,
            resolver: channels,
          });
          await ingestion.acceptResults('probe-health', {
            type: 'results',
            batchId: `probe-health-${now.toISOString()}`,
            results: [...results],
          });
          await ingestor.stop();
        },
        now: () => now,
        // A probe at an uptime above this met the core already running: a baseline.
        uptime: () => 1_000,
        monotonicMs: () => now.getTime(),
      });
      return async () => {
        await service.sweep();
        now = new Date(now.getTime() + 30_000);
        const rows = await db.query<{ state: string; message: string }>(
          'SELECT state, message FROM sensor_runtime WHERE object_id = $1',
          [sensorId],
        );
        assert.ok(rows[0]);
        return rows[0];
      };
    };

    it('warns on a refused script group however it falls, once a burst, and clears (`P-284`)', async () => {
      // `scriptGroupsRefused` is a counter with no limit now; the warning is the five-minute
      // count, which sees the first record after a restart and holds through a burst.
      let current: ProbeLink = { connected: false };
      let uptime = 5_000;
      const sweepWith = await lasting(() => current);
      const sweep = async (
        total: number,
        restarted = false,
      ): Promise<{ state: string; message: string }> => {
        uptime = restarted ? 3 : uptime + 30;
        current = connected({
          lastHeartbeatAt: now,
          health: { ...quiet, scriptGroupsRefused: total, uptimeSeconds: uptime },
        });
        return sweepWith();
      };

      assert.equal((await sweep(0)).state, 'up', 'the baseline');
      // **Across a counter reset**: the probe restarts and refuses in its first record.
      const restarted = await sweep(1, true);
      assert.equal(restarted.state, 'warning', `after a restart: ${restarted.message}`);
      assert.match(restarted.message, /Script groups refused \(5 min\) is 1 groups/u);
      // **One burst, one alarm**: more refusals a minute apart hold the one warning rather than
      // clearing and raising it again, as a rate did between them.
      for (const total of [1, 2, 2, 3]) {
        assert.equal((await sweep(total)).state, 'warning', `at a total of ${String(total)}`);
      }
      // Five minutes after the last refusal it clears, and not before.
      for (let quietSweeps = 1; quietSweeps <= 9; quietSweeps += 1) {
        assert.equal((await sweep(3)).state, 'warning', `${String(30 * quietSweeps)} s on`);
      }
      assert.equal((await sweep(3)).state, 'up', 'five minutes after the last');
      // Across a link gap the count is the same (the counts above); the whole path is not, since
      // a probe that returns is held Down for its recovery hold (`M-18`) whatever it reports.
    });

    it('is Down for five minutes on results the drain discarded, from the first record (`P-283`)', async () => {
      // Readings that exist nowhere, as `spoolDropped`'s are, and seen on the record after a
      // restart, when a replaying drain is likeliest to discard.
      let current: ProbeLink = { connected: false };
      const sweepWith = await lasting(() => current);
      const sweep = async (
        oversized: number,
        uptimeSeconds: number,
      ): Promise<{ state: string; message: string }> => {
        current = connected({
          lastHeartbeatAt: now,
          health: { ...quiet, spoolRejected: 0, spoolOversized: oversized, uptimeSeconds },
        });
        return sweepWith();
      };
      assert.equal((await sweep(0, 5_000)).state, 'up');
      const lost = await sweep(2, 4);
      assert.equal(lost.state, 'down', `a restarted probe discarding: ${lost.message}`);
      assert.match(
        lost.message,
        /Results discarded unsent \(5 min\) is 2 results, above the error limit/u,
      );
      for (let later = 1; later <= 9; later += 1) {
        assert.equal((await sweep(2, 4 + 30 * later)).state, 'down', `${String(30 * later)} s on`);
      }
      assert.equal((await sweep(2, 304)).state, 'up', 'five minutes after');
    });

    it('warns on a clock a minute out either way, and is Down on any sensor it froze (`P-232`)', async () => {
      // Two limits for two cases. The offset catches a probe behind or ahead; the frozen count
      // catches NTP correcting a clock that was fast, which leaves the offset near zero and the
      // sensors frozen for as long as it was fast. The frozen count is an error (`M-22`): the
      // sensors are Unknown exactly as a lost probe's are, and a lost probe reads Down.
      let offsetMs: number | null = 0;
      let frozen = 0;
      const sweep = await sweeper((at) => ({
        link: () => connected({ lastHeartbeatAt: at, health: quiet, clockOffsetMs: offsetMs }),
        timeRefusals: () => ({ past: 0, future: 0 }),
        frozenSensors: () => frozen,
      }));

      assert.equal((await sweep()).state, 'up', 'the clock right and nothing frozen');

      offsetMs = 3_600_000;
      const behind = await sweep();
      assert.equal(behind.state, 'warning', 'an hour behind');
      assert.match(behind.message, /differs from the core's by more than a minute/u);

      offsetMs = -90_000;
      assert.equal((await sweep()).state, 'warning', 'a minute and a half ahead');

      offsetMs = 30_000;
      assert.equal((await sweep()).state, 'up', 'half a minute is inside the limit');

      frozen = 1;
      const stuck = await sweep();
      assert.equal(stuck.state, 'down', 'one frozen sensor is enough');
      assert.match(stuck.message, /cannot accept results until its clock passes/u);

      frozen = 0;
      offsetMs = null;
      assert.equal((await sweep()).state, 'up', 'a gap is not a reading, and clears nothing');
    });
  });

  describe('the sweep', () => {
    it('publishes which probe each sensor reports on, before its results go in (`M-22`)', async () => {
      // The alarm engine holds a lost probe's sensors behind these, and it reacts to the results
      // this sweep sends: published after them, the first reaction would find no probe alarm.
      const targets = new ProbeHealthTargets();
      let atIngest: readonly number[] = [];
      await new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        targets,
        sources: { link: () => connected() },
        ingest: () => {
          atIngest = targets.reportingOn(probeId);
          return Promise.resolve();
        },
      }).sweep();
      assert.deepEqual(
        [...atIngest].sort((a, b) => a - b),
        [sensorId, orphanId].sort((a, b) => a - b),
      );
      assert.equal(targets.reportsOn(orphanId), probeId, 'the probe it names, not the one above');
      assert.equal(targets.reportsOn(sensorId), probeId, 'the probe above it');
    });

    it('sends nothing for a probe the core has not heard from since it started, and still knows it reports on it (`M-22`)', async () => {
      // A gap, not a reading: `connected` 0 for a probe that redials forty seconds after a core
      // upgrade would page every Down trigger over it once per restart.
      const targets = new ProbeHealthTargets();
      let awaiting = true;
      let sent: readonly number[] = [];
      const service = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        targets,
        sources: { link: () => ({ connected: false }) },
        delivery: { verdictFor: () => null, awaitingFirstConnect: () => awaiting },
        ingest: (results) => {
          sent = results.map((result) => result.sensorId);
          return Promise.resolve();
        },
      });

      await service.sweep();
      assert.deepEqual(sent, [], 'nothing about the probe until the grace has run out');
      assert.equal(targets.reportsOn(sensorId), probeId, 'the hold can still find it');

      awaiting = false;
      await service.sweep();
      assert.deepEqual(
        [...sent].sort((a, b) => a - b),
        [sensorId, orphanId].sort((a, b) => a - b),
        'and the reading it would have sent, once it has',
      );
    });

    it('leaves out a sensor it withholds, which raises nothing and so holds nothing (`M-22`)', async () => {
      const targets = new ProbeHealthTargets();
      await new ProbeHealthService({
        vouching: {
          refusals: () => Promise.resolve(new Map([[sensorId, 'revoked']])),
          settle: () => Promise.resolve(0),
        },
        db,
        logger: silent,
        targets,
        sources: { link: () => connected() },
        ingest: () => Promise.resolve(),
      }).sweep();
      assert.equal(targets.reportsOn(sensorId), undefined);
      assert.deepEqual(targets.reportingOn(probeId), [orphanId]);
    });

    it('says which probes a sensor stopped reporting on, each once (`M-27`)', () => {
      const targets = new ProbeHealthTargets();
      assert.deepEqual(
        targets.publish(
          new Map([
            [1, 10],
            [2, 10],
            [3, 20],
            [4, 30],
          ]),
        ),
        [],
        'nothing reported on anything before',
      );
      const lost = targets.publish(
        new Map([
          [1, 11],
          [2, 11],
          [4, 30],
        ]),
      );
      assert.deepEqual(
        [...lost].sort((a, b) => a - b),
        [10, 20],
        'retargeted and gone, and not the one unchanged',
      );
      assert.deepEqual(targets.reportingOn(11), [1, 2]);
      assert.deepEqual(
        targets.publish(
          new Map([
            [1, 11],
            [2, 11],
            [4, 30],
          ]),
        ),
        [],
        'and nothing once it has been said',
      );
    });

    it('tells whoever listens which probes lost a reporter, before its results go in, and asks again when that fails (`M-27`)', async () => {
      const targets = new ProbeHealthTargets();
      // A sensor that reported on another probe last sweep and is gone from this one.
      targets.publish(
        new Map([
          [sensorId, probeId],
          [orphanId, probeId],
          [-1, -2],
        ]),
      );
      // Recorded and asserted after: a throw in here is the failure the sweep logs and survives.
      const told: { probes: number[]; ingested: boolean; moved: boolean }[] = [];
      let failing = true;
      let ingested = false;
      const service = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        targets,
        sources: { link: () => connected() },
        onReportersLost: (probes) => {
          told.push({ probes: [...probes], ingested, moved: targets.reportsOn(-1) === undefined });
          return failing ? Promise.reject(new Error('no database')) : Promise.resolve();
        },
        ingest: () => {
          ingested = true;
          return Promise.resolve();
        },
      });
      await service.sweep();
      assert.deepEqual(
        told,
        [{ probes: [-2], ingested: false, moved: true }],
        'before the results, with the targets already moved',
      );
      assert.equal(ingested, true, 'a failure does not keep the results back');

      ingested = false;
      failing = false;
      await service.sweep();
      assert.deepEqual(
        told.map((one) => one.probes),
        [[-2], [-2]],
        'asked again, though nothing new moved',
      );

      await service.sweep();
      assert.equal(told.length, 2, 'and not once it has been heard');
    });

    it('resolves them from the tree before any sweep has run, for the boot pass (`M-22`)', async () => {
      const targets = new ProbeHealthTargets();
      assert.deepEqual(targets.reportingOn(probeId), []);
      await targets.refresh(db);
      assert.equal(targets.reportsOn(sensorId), probeId);
      assert.equal(targets.reportsOn(orphanId), probeId);
    });

    it('finds the probe a sensor sits under, however deep', async () => {
      const batches: CheckResult[][] = [];
      const seen: number[] = [];
      await build(
        (id) => {
          seen.push(id);
          return connected();
        },
        (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
      ).sweep();

      const results = batches[0] ?? [];
      assert.equal(results.length, 2);
      const under = results.find((one) => one.sensorId === sensorId);
      assert.equal(under?.outcome, 'ok');
      assert.ok(seen.includes(probeId));
    });

    it('honours an explicitly named probe over the one it sits under', async () => {
      // The placement that matters: a sensor watching probe A from under probe B, so that losing
      // A does not also lose the view of it.
      const asked = new Map<number, number>();
      const batches: CheckResult[][] = [];
      await build(
        (id) => {
          asked.set(id, (asked.get(id) ?? 0) + 1);
          return connected();
        },
        (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
      ).sweep();

      const named = (batches[0] ?? []).find((one) => one.sensorId === orphanId);
      assert.equal(named?.outcome, 'ok');
      assert.equal(asked.get(probeId), 2, 'both sensors report on the same probe');
    });

    it('fails a sensor that has no probe to report on, and says how to fix it', async () => {
      // Not a silent gap: an operator who put this sensor somewhere it cannot answer needs to
      // be told, and the sentence says what to do.
      const batches: CheckResult[][] = [];
      const service = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db: {
          query: () => Promise.resolve([{ id: '99', params: {}, probe_id: null }]),
          tx: () => Promise.resolve({}),
        } as unknown as Database,
        logger: silent,
        sources: { link: () => ({ connected: false }) },
        ingest: (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
      });
      await service.sweep();

      const result = batches[0]?.[0];
      assert.ok(result !== undefined);
      assert.equal(result.outcome, 'error');
      assert.deepEqual(result.channels, []);
      assert.match(result.message, /no probe above it and names none/);
      assert.equal(service.stats().unresolved, 1);
    });

    it('reads nothing for a sensor its voucher check withholds, and counts it', async () => {
      // `A-29`: a sensor whose voucher can no longer read the probe it reports on publishes
      // nothing — a gap — and its Unknown is the check's to lay over it, not this sweep's.
      const asked: SensorToVouchFor[] = [];
      const settled: [string, number[]][] = [];
      const batches: CheckResult[][] = [];
      const service = new ProbeHealthService({
        vouching: {
          refusals: (sensors) => {
            asked.push(...sensors);
            return Promise.resolve(new Map([[sensorId, 'withheld']]));
          },
          settle: (owner, refused) => {
            settled.push([owner, [...refused.keys()]]);
            return Promise.resolve(0);
          },
        },
        db,
        logger: silent,
        sources: { link: () => connected() },
        ingest: (results) => {
          batches.push([...results]);
          return Promise.resolve();
        },
        now: () => new Date('2026-08-28T00:00:25Z'),
      });
      await service.sweep();

      const mine = asked.find((one) => one.sensorId === sensorId);
      assert.ok(mine !== undefined);
      assert.equal(mine.sensorType, 'ms.probe.health');
      assert.equal(mine.enclosingProbeId, probeId, 'the probe a sensor naming none reports on');
      assert.deepEqual(mine.voucher, { kind: 'installation' });
      assert.equal(asked.length, 2);
      assert.deepEqual(settled, [['probe-health', [sensorId]]]);
      assert.deepEqual(
        (batches[0] ?? []).map((one) => one.sensorId),
        [orphanId],
      );
      assert.equal(service.stats().withheld, 1);
    });

    it('does nothing at all when no such sensor exists', async () => {
      let ingested = 0;
      const service = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db: {
          query: () => Promise.resolve([]),
          tx: () => Promise.resolve({}),
        } as unknown as Database,
        logger: silent,
        sources: { link: () => ({ connected: false }) },
        ingest: () => {
          ingested += 1;
          return Promise.resolve();
        },
      });
      assert.equal(await service.sweep(), 0);
      assert.equal(ingested, 0);
    });
  });
});
