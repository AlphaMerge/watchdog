import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
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
  readingsFrom,
  type ProbeHealthSources,
} from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { loadLookups } from '../src/lookups/loader.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { SensorStateService } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
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
};

describe('the Probe Health sensor', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let probeId = 0;
  let sensorId = 0;
  let orphanId = 0;
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

  describe('a probe that is not answering', () => {
    it('reports the link down and every other channel as a gap', () => {
      // **The reading this sensor exists for.** The probe's numbers are not zero, they are
      // unknown — and a scheduler lag of 0 ms from a probe that is gone would be the most
      // confidently wrong number this system could store.
      const { reading, message } = build(() => ({ connected: false })).read(probeId);
      assert.equal(reading['connected'], 0);
      assert.equal(message, 'not connected to the core');
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

    it('warns on a clock a minute out either way, and on any sensor it froze (`P-232`)', async () => {
      // Two warnings for two cases. The offset catches a probe behind or ahead; the frozen count
      // catches NTP correcting a clock that was fast, which leaves the offset near zero and the
      // sensors frozen for as long as it was fast.
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
      assert.equal(stuck.state, 'warning', 'one frozen sensor is enough');
      assert.match(stuck.message, /cannot accept results until its clock passes/u);

      frozen = 0;
      offsetMs = null;
      assert.equal((await sweep()).state, 'up', 'a gap is not a reading, and clears nothing');
    });
  });

  describe('the sweep', () => {
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
