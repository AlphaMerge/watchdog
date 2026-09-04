import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { PROBE_HEALTH_CHANNELS, PROBE_HEALTH_COUNTERS } from '@ms/sensors';
import { PROTOCOL_VERSION, type CheckResult, type ProbeHealthReport } from '@ms/shared';
import { ProbeHealthService, readingsFrom } from '../src/health/probe-health.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

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
};

describe('the Probe Health sensor', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let probeId = 0;
  let sensorId = 0;
  let orphanId = 0;

  before(async () => {
    scratch = await createScratchDatabase('probehealth');
    db = scratch.db;
    const harness = await buildHarness(db);

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
    protocolVersion: PROTOCOL_VERSION,
    connectedAt: new Date('2026-08-28T00:00:00Z'),
    lastHeartbeatAt: new Date('2026-08-28T00:00:20Z'),
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 100,
    cadenceSeconds: 60,
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

    it('gaps a listener a probe does not run, rather than reading it as silent', () => {
      const { trapReceived: _a, trapRejected: _b, trapMalformed: _c, ...noTrap } = FULL;
      const { reading } = build(() => connected({ health: noTrap })).read(probeId);
      assert.equal(reading['trapReceived'], null);
      assert.equal(reading['syslogReceived'], 40_000, 'the other one is unaffected');
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
        protocolVersion: 3,
        connectedAt: new Date('2026-08-28T00:00:00Z'),
        lastHeartbeatAt: new Date('2026-08-28T00:00:20Z'),
        approved: true,
        agentVersion: '0.4.0',
        assignedSensors: 12,
        cadenceSeconds: 60,
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

    it('calls a version newer than this build incompatible rather than guessing', () => {
      const { reading } = build(() => connected({ protocolVersion: PROTOCOL_VERSION + 1 })).read(
        probeId,
      );
      assert.equal(reading['protocol'], 2);
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

    it('does nothing at all when no such sensor exists', async () => {
      let ingested = 0;
      const service = new ProbeHealthService({
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
