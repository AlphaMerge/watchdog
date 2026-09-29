import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { standardCatalogue } from '@ms/sensors';
import { PROTOCOL_VERSION, type CheckResult, type IngestionConfig } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { Reach, Visibility } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import { ProbeHealthService, ProbeHealthTargets } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { IN_PROCESS_SOURCE } from '../src/ingestion/sources.js';
import { loadLookups } from '../src/lookups/loader.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { AlarmEngine, holdsFrom } from '../src/notifications/engine.js';
import type { ProbeEpisodes } from '../src/notifications/episodes.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import { ClockFreeze } from '../src/probes/clock-freeze.js';
import { ProbeDeliveryWatch } from '../src/probes/delivery-watch.js';
import { ProbeEpisodeIndex } from '../src/probes/episodes.js';
import { ProbeReachability } from '../src/probes/reachability.js';
import { ReachabilitySync } from '../src/probes/reachability-sync.js';
import { AlarmService, type Alarm } from '../src/state/alarms.js';
import { readSensorState, writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { SensorState } from '../src/state/tables.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TRIGGERABLE_STATES } from '../src/triggers/definition.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';

const available = await databaseAvailable();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PINGS = 150;
/** Every fifth ping is Down, and has been notified, before anything happens to its probe. */
const DOWN_PINGS = PINGS / 5;

const CORE_EVALUATED = ((): string[] => {
  const catalogue = testCatalogue();
  return catalogue.ids().filter((id) => catalogue.declaration(id).evaluatedBy === 'core');
})();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/** What was queued, by method, the trigger's state, the reason and the state notified. */
type Counts = Record<string, number>;

/**
 * **One outage, one alarm, per trigger** (`M-22`).
 *
 * A probe that is lost, or whose clock steps back, leaves every sensor it carries Unknown with
 * cause `probe`. Each case below is one kind of trigger, on its own probe, through the real
 * pieces: `ProbeReachability`, `ClockFreeze`, the Probe Health sweep through ingestion, the alarm
 * engine and its scheduler. What is counted is `notification_request` rows, which is what every
 * delivery method sends from. Each case also runs an email and a webhook template, so the answer
 * does not depend on summarisation.
 *
 * The guarantee, readable from the names: a trigger that covers the probe's live Probe Health
 * hears about the probe once, from that sensor, and not once per sensor it carries. A trigger that
 * does not cover it, or a probe that has none, notifies per sensor, as before. Holding never takes
 * the last route away from any trigger.
 */
describe(
  'a lost or frozen probe is one alarm per trigger (`M-22`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let scheduler: AlarmScheduler;
    let channels: ChannelResolver;
    let triggerSync: TriggerSync;
    /**
     * Whether Probe Health holds a return (`M-18`). The cases written before the hold run
     * without one, which is what a trigger with `recoveryHoldSeconds: 0` gets, and `M-18`'s run
     * with the hold Probe Health ships with.
     */
    let holding = false;
    const holds = holdsFrom(standardCatalogue());

    /** The world: each probe's link, which outlives a core restart. */
    const links = new Map<number, { connected: boolean; offsetMs: number | null }>();

    function linkOf(probeObjectId: number): ProbeLink {
      const state = links.get(probeObjectId);
      if (state?.connected !== true) return { connected: false };
      const now = new Date();
      return {
        connected: true,
        gid: `probe-${String(probeObjectId)}`,
        protocolVersion: PROTOCOL_VERSION,
        connectedAt: now,
        lastHeartbeatAt: now,
        approved: true,
        agentVersion: '1.0.0',
        assignedSensors: PINGS,
        cadenceSeconds: 60,
        connectedForMs: 0,
        sinceResultsMs: 0,
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: now,
        configSentAt: now,
        clockOffsetMs: state.offsetMs,
      };
    }

    /** One core's live facts. A restart replaces every one of them. */
    interface Core {
      readonly reachability: ProbeReachability;
      readonly freeze: ClockFreeze;
      readonly targets: ProbeHealthTargets;
      readonly index: ProbeEpisodeIndex;
      readonly health: ProbeHealthService;
      uptimeMs: number;
      readonly watch: ProbeDeliveryWatch;
    }
    let core: Core | undefined;
    const now = (): Core => {
      assert.ok(core !== undefined);
      return core;
    };
    /** The engine outlives a restart only as code: everything it reads comes from `core`. */
    const episodes: ProbeEpisodes = {
      carrierOf: (id) => now().index.carrierOf(id),
      alarmsFor: (probe) => now().index.alarmsFor(probe),
      episodeOf: (id) => now().index.episodeOf(id),
      endedEpisodeOf: (id) => now().index.endedEpisodeOf(id),
      heldFor: (id) => now().index.heldFor(id),
    };
    const none: ReadonlySet<number> = new Set();

    let batch = 0;
    /** Probe Health results through ingestion, the way the core's own sweep sends them. */
    async function ingestHealth(results: readonly CheckResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        states,
        resolver: channels,
      });
      batch += 1;
      await ingestion.acceptResults(IN_PROCESS_SOURCE.probeHealth, {
        type: 'results',
        batchId: `probe-health-${String(batch)}`,
        results: [...results],
      });
      await ingestor.stop();
    }

    /** A core starting: nothing lost, nothing frozen, no Probe Health resolved yet. */
    function boot(): Core {
      const states = h.states;
      const dependencies = h.dependencies;
      assert.ok(states !== undefined && dependencies !== undefined);
      const targets = new ProbeHealthTargets();
      const probeAlarms = (probe: number): readonly number[] => targets.reportingOn(probe);
      const reachability = new ProbeReachability({
        db,
        logger: silent,
        states,
        dependencies,
        coreEvaluatedTypes: CORE_EVALUATED,
        probeAlarms,
      });
      const freeze = new ClockFreeze({
        db,
        logger: silent,
        states,
        dependencies,
        links: {
          connectedProbeIds: () =>
            [...links].filter(([, link]) => link.connected).map(([probe]) => probe),
          linkFor: linkOf,
        },
        coreEvaluatedTypes: CORE_EVALUATED,
        probeAlarms,
      });
      const index = new ProbeEpisodeIndex({
        lost: () => reachability,
        frozen: () => freeze,
        alarms: () => targets,
      });
      const watch = new ProbeDeliveryWatch({
        db,
        logger: silent,
        reachability,
        linkFor: linkOf,
        uptimeMs: () => booted.uptimeMs,
      });
      const health = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        targets,
        sources: { link: linkOf, frozenSensors: (probe) => freeze.frozenOn(probe) },
        delivery: watch,
        ingest: ingestHealth,
      });
      const booted: Core = { reachability, freeze, targets, index, health, uptimeMs: 0, watch };
      return booted;
    }

    /** Pings as ingestion writes them: decide, write, react (`M-11`). */
    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      if (results.length === 0) return;
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          results[0]?.at ?? new Date(),
        );
      });
    }

    interface Made {
      readonly probe: number;
      readonly name: string;
      readonly site: number;
      readonly pings: readonly number[];
      /** Undefined for a probe with no Probe Health. */
      readonly health: number | undefined;
    }

    /**
     * A probe with a box carrying its Probe Health, and a site group of pings, all Up but every
     * fifth, which is Down. Measured a minute ago, and settled: whatever that notified is done.
     */
    async function probeWith(name: string, options: { health: boolean }): Promise<Made> {
      const probe = (await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name }))
        .id;
      links.set(probe, { connected: true, offsetMs: 0 });
      const made = await h.service.createTree(testActor, {
        parentId: probe,
        nodes: [
          { kind: 'device', name: `${name}-box`, host: '192.0.2.1', ref: 'box' },
          ...(options.health
            ? [
                {
                  kind: 'sensor' as const,
                  name: `${name}-health`,
                  sensorType: 'ms.probe.health',
                  params: {},
                  parentRef: 'box',
                  ref: 'health',
                },
              ]
            : []),
          { kind: 'group', name: `${name}-site`, ref: 'site' },
          {
            kind: 'device',
            name: `${name}-site-box`,
            host: '192.0.2.2',
            ref: 'd',
            parentRef: 'site',
          },
          ...Array.from({ length: PINGS }, (_, at) => ({
            kind: 'sensor' as const,
            name: `${name}-ping-${String(at).padStart(3, '0')}`,
            sensorType: 'icmp.ping',
            parentRef: 'd',
            ref: `s${String(at)}`,
          })),
        ],
      } as never);
      const pings = made.objects
        .filter((one) => one.kind === 'sensor' && one.ref?.startsWith('s') === true)
        .map((one) => one.id);
      const site = made.objects.find((one) => one.ref === 'site')?.id;
      assert.ok(site !== undefined);
      return {
        probe,
        name,
        site,
        pings,
        health: made.objects.find((one) => one.ref === 'health')?.id,
      };
    }

    /** Measures the pings and sweeps Probe Health, so everything stands where it will start. */
    async function settle(made: Made): Promise<void> {
      const t0 = Date.now() - 3 * MINUTE;
      await ingest(
        made.pings.map((sensorId) => ({
          sensorId,
          at: new Date(t0),
          outcome: 'ok' as const,
          message: 'reply',
        })),
      );
      const failing = made.pings.filter((_, at) => at % 5 === 0);
      for (const step of [1, 2]) {
        await ingest(
          failing.map((sensorId) => ({
            sensorId,
            at: new Date(t0 + step * MINUTE),
            outcome: 'error' as const,
            message: 'no reply',
          })),
        );
      }
      await healthSweep();
      await fire();
    }

    async function healthSweep(): Promise<void> {
      await now().health.sweep();
    }

    async function fire(): Promise<void> {
      await scheduler.sweep(new Date(Date.now() + MINUTE));
    }

    async function trigger(
      objectId: number,
      state: SensorState,
      method: 'email' | 'webhook',
      latencySeconds = 0,
      chain: { escalationLatencySeconds?: number; repeatMinutes?: number } = {},
    ): Promise<void> {
      const template = await templates.create(testActor, {
        name: `${state} ${method} ${String(process.hrtime.bigint())}`,
        method,
        settings:
          method === 'email'
            ? {}
            : { url: 'http://sink.test:9/alarms', verb: 'POST', contentType: 'application/json' },
        subject: '%sensor is %status',
        body: '%lastmessage',
        recipients: method === 'email' ? [{ kind: 'address', value: 'noc@example.test' }] : [],
        ...(method === 'email' ? { summaryWindowSeconds: 60 } : {}),
      });
      await triggers.create(testActor, objectId, {
        kind: 'state',
        settings: {
          state,
          initialLatencySeconds: latencySeconds,
          initialTemplateId: template.id,
          recoveryTemplateId: template.id,
          ...chain,
          ...(chain.escalationLatencySeconds === undefined
            ? {}
            : { escalationTemplateId: template.id }),
        },
      });
    }

    /** A probe carrying nothing but its Probe Health, which is core-evaluated and never held. */
    async function bareProbe(name: string): Promise<{ probe: number; health: number }> {
      const probe = (await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name }))
        .id;
      links.set(probe, { connected: true, offsetMs: 0 });
      const made = await h.service.createTree(testActor, {
        parentId: probe,
        nodes: [
          { kind: 'device', name: `${name}-box`, host: '192.0.2.1', ref: 'box' },
          {
            kind: 'sensor' as const,
            name: `${name}-health`,
            sensorType: 'ms.probe.health',
            params: {},
            parentRef: 'box',
            ref: 'health',
          },
        ],
      } as never);
      const health = made.objects.find((one) => one.ref === 'health')?.id;
      assert.ok(health !== undefined);
      return { probe, health };
    }

    /**
     * A tree change with `ReachabilitySync` in its transaction, as production composes it: the
     * lost set follows the tree before the triggers are reconciled (`P-103`, `P-111`).
     */
    async function withTreeSync<T>(change: () => Promise<T>): Promise<T> {
      const previous = h.audit.also;
      h.audit.also = new CompositeAuditSink([
        new ReachabilitySync({ reachability: () => core?.reachability, logger: silent }),
        triggerSync,
      ]);
      try {
        return await change();
      } finally {
        h.audit.also = previous;
      }
    }

    /** The alarm rows standing on these sensors, as the sweep would find them. */
    async function alarmsOn(
      sensors: readonly number[],
    ): Promise<{ suppressed: boolean; phase: string }[]> {
      return db.query<{ suppressed: boolean; phase: string }>(
        `SELECT suppressed, phase::text AS phase FROM notification_alarm
         WHERE sensor_id = ANY($1::bigint[]) ORDER BY id`,
        [sensors],
      );
    }

    async function mark(): Promise<number> {
      const [row] = await db.query<{ id: string | null }>(
        'SELECT max(id)::text AS id FROM notification_request',
      );
      return Number(row?.id ?? 0);
    }

    async function queued(after: number, sensors: readonly number[]): Promise<Counts> {
      const rows = await db.query<{ key: string; n: string }>(
        `SELECT tm.method || ':' || (t.settings->>'state') || ':' || r.reason AS key,
                count(*)::text AS n
         FROM notification_request r
         JOIN notification_trigger t ON t.id = r.trigger_id
         JOIN notification_template tm ON tm.id = r.template_id
         WHERE r.id > $1 AND r.sensor_id = ANY($2::bigint[])
         GROUP BY 1 ORDER BY 1`,
        [after, sensors],
      );
      return Object.fromEntries(rows.map((row) => [row.key, Number(row.n)]));
    }

    async function messages(after: number, sensorId: number): Promise<string[]> {
      const rows = await db.query<{ message: string }>(
        `SELECT message FROM notification_request WHERE id > $1 AND sensor_id = $2 ORDER BY id`,
        [after, sensorId],
      );
      return rows.map((row) => row.message);
    }

    /** Probe Health's row on the alarms list, scoped to its own probe (`M-18`). */
    async function listed(made: Made): Promise<Alarm | undefined> {
      const page = await new AlarmService({ db, logger: silent }).list({
        visibility: Visibility.EVERYTHING,
        objectId: made.probe,
        limit: 500,
      });
      return page.items.find((item) => item.sensorId === healthOf(made));
    }

    const healthOf = (made: Made): number => {
      assert.ok(made.health !== undefined);
      return made.health;
    };

    async function lose(made: Made): Promise<void> {
      links.set(made.probe, { connected: false, offsetMs: null });
      await now().reachability.lost(made.probe);
      await healthSweep();
      await fire();
    }

    async function find(made: Made): Promise<void> {
      links.set(made.probe, { connected: true, offsetMs: 0 });
      await now().reachability.found(made.probe);
      await healthSweep();
      await fire();
    }

    before(async () => {
      scratch = await createScratchDatabase('episodes');
      db = scratch.db;
      engine = new AlarmEngine({
        logger: silent,
        episodes,
        recoveryHolds: (type) => (holding ? holds(type) : 0),
      });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        unreachableSensors: () => core?.reachability.unreachableSensors() ?? none,
        clockFrozenSensors: () => core?.freeze.frozenSensors() ?? none,
      });
      triggerSync = new TriggerSync({ engine, logger: silent });
      h.audit.also = triggerSync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), triggerSync]),
        logger: silent,
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: new MessageContextLoader({
          settings: h.resolver,
          publicUrl: 'https://monitoring.example.test',
          siteName: 'Episodes',
        }),
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
      channels = new ChannelResolver({
        logger: silent,
        lookups: await loadLookups({ logger: silent }),
      });
      core = boot();
    });

    after(async () => {
      await scratch.drop();
    });

    it('a Down trigger that covers the probe’s Probe Health: the one Probe Health alarm and nothing else', async () => {
      const made = await probeWith('down-only', { health: true });
      await trigger(made.probe, 'down', 'email');
      await trigger(made.probe, 'down', 'webhook');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, made.pings), {}, 'nothing for the sensors it carries');
      assert.deepEqual(await queued(step, [health]), {
        'email:down:initial': 1,
        'webhook:down:initial': 1,
      });

      const lift = await mark();
      await find(made);
      assert.deepEqual(
        await queued(lift, made.pings),
        {},
        `no second wave: the ${String(DOWN_PINGS)} Down pings resume where they were`,
      );
      assert.deepEqual(await queued(lift, [health]), {
        'email:down:recovery': 1,
        'webhook:down:recovery': 1,
      });
    });

    it('an Unknown-only trigger that covers it: one notification that says which probe and how many, then one recovery', async () => {
      // The trigger that paged once per sensor before, and would have gone silent had the hold
      // been per sensor: Probe Health reads Down, so it is the view that gives this trigger the
      // probe's alarm.
      const made = await probeWith('unknown-only', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await trigger(made.probe, 'unknown', 'webhook');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, made.pings), {});
      assert.deepEqual(await queued(step, [health]), {
        'email:unknown:initial': 1,
        'webhook:unknown:initial': 1,
      });
      assert.deepEqual(await messages(step, health), [
        `probe unknown-only is lost: the ${String(PINGS)} sensors it carries are Unknown, held as this one alarm`,
        `probe unknown-only is lost: the ${String(PINGS)} sensors it carries are Unknown, held as this one alarm`,
      ]);

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {});
      assert.deepEqual(await queued(lift, [health]), {
        'email:unknown:recovery': 1,
        'webhook:unknown:recovery': 1,
      });
      assert.deepEqual(await messages(lift, health), [
        'probe unknown-only is answering again: its sensors are no longer held',
        'probe unknown-only is answering again: its sensors are no longer held',
      ]);

      // Later, Probe Health is Unknown for a reason of its own: resumed, and awaiting its first
      // reading. That alarm and its recovery are Probe Health's, and neither says the probe came
      // back. What tells them apart is the alarm's start, which is not the episode's.
      const later = await mark();
      await h.service.pause(testActor, health, { kind: 'indefinite' }, 'maintenance');
      await h.service.resume(testActor, health);
      await fire();
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(later, [health]), {
        'email:unknown:initial': 1,
        'email:unknown:recovery': 1,
        'webhook:unknown:initial': 1,
        'webhook:unknown:recovery': 1,
      });
      const own = await messages(later, health);
      assert.ok(!own.some((message) => message.includes('probe unknown-only')), own.join(' | '));
    });

    it('an Up trigger that covers it: one Up when the probe is back, not one per sensor', async () => {
      const made = await probeWith('up-only', { health: true });
      await trigger(made.probe, 'up', 'email');
      await trigger(made.probe, 'up', 'webhook');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [...made.pings, health]), {});

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {}, 'no wave of Ups');
      assert.deepEqual(await queued(lift, [health]), {
        'email:up:initial': 1,
        'webhook:up:initial': 1,
      });
    });

    it('an Unknown trigger on a group below the probe: still one per sensor, as before, beside a probe trigger that is held', async () => {
      // It cannot see the probe's Probe Health, so the probe's alarm is no route for it, and
      // holding its sensors would be silence. The Down trigger on the probe can, on the same
      // sensors at the same moment: held is decided per trigger, not per sensor.
      const made = await probeWith('site-team', { health: true });
      await trigger(made.site, 'unknown', 'email');
      await trigger(made.site, 'unknown', 'webhook');
      await trigger(made.probe, 'down', 'email');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, made.pings), {
        'email:unknown:initial': PINGS,
        'webhook:unknown:initial': PINGS,
      });
      assert.deepEqual(await queued(step, [health]), { 'email:down:initial': 1 });

      const lift = await mark();
      await find(made);
      // A recovery for each ping that came back Up. The Down ones are still Down, and their
      // Unknown alarm is suspended rather than recovered, which is `P-105`. Their Down alarm,
      // held meanwhile, resumes without a second page.
      assert.deepEqual(await queued(lift, made.pings), {
        'email:unknown:recovery': PINGS - DOWN_PINGS,
        'webhook:unknown:recovery': PINGS - DOWN_PINGS,
      });
      assert.deepEqual(await queued(lift, [health]), { 'email:down:recovery': 1 });
    });

    it('a probe with no Probe Health: one per sensor, as before', async () => {
      const made = await probeWith('unwatched', { health: false });
      await trigger(made.probe, 'unknown', 'email');
      await trigger(made.probe, 'up', 'webhook');
      await settle(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, made.pings), { 'email:unknown:initial': PINGS });

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {
        'email:unknown:recovery': PINGS - DOWN_PINGS,
        'webhook:up:initial': PINGS - DOWN_PINGS,
      });
    });

    it('a paused Probe Health: one per sensor, as before', async () => {
      // Paused, it is not the probe's alarm: it notifies nobody, so holding the sensors behind it
      // would be silence. The same goes for one withheld for want of a voucher (`A-29`).
      const made = await probeWith('paused-health', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);
      const health = healthOf(made);
      await h.service.pause(testActor, health, { kind: 'indefinite' }, 'maintenance');

      const step = await mark();
      links.set(made.probe, { connected: false, offsetMs: null });
      await now().reachability.lost(made.probe);
      // Asked before the sweep, which would stand a stale alarm down silently and hide one.
      const [armed] = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_alarm WHERE sensor_id = $1',
        [health],
      );
      assert.equal(Number(armed?.n), 0, 'a paused Probe Health stands for no episode');
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(step, made.pings), { 'email:unknown:initial': PINGS });
      assert.deepEqual(await queued(step, [health]), {});

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {
        'email:unknown:recovery': PINGS - DOWN_PINGS,
      });
    });

    it('a Probe Health resumed during a loss: the alarms already armed per sensor are parked when they fall due, not sent', async () => {
      // Resuming re-decides Probe Health alone, so nothing reconciles the sensors it now stands
      // for, and their alarms, armed while it was paused, are still waiting. The sweep is the
      // last thing between them and a page per sensor, which is why it checks the hold itself.
      const made = await probeWith('resumed-health', { health: true });
      await trigger(made.probe, 'unknown', 'email', 600);
      await settle(made);
      const health = healthOf(made);
      await h.service.pause(testActor, health, { kind: 'indefinite' }, 'maintenance');

      const step = await mark();
      await lose(made);
      const [armed] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notification_alarm
         WHERE sensor_id = ANY($1::bigint[]) AND next_due_at IS NOT NULL`,
        [made.pings],
      );
      assert.equal(Number(armed?.n), PINGS, 'one alarm waiting per sensor while nothing held them');

      await h.service.resume(testActor, health);
      await healthSweep();
      await scheduler.sweep(new Date(Date.now() + 11 * MINUTE));
      assert.deepEqual(await queued(step, made.pings), {});
      assert.deepEqual(await queued(step, [health]), { 'email:unknown:initial': 1 });

      const lift = await mark();
      await find(made);
      await scheduler.sweep(new Date(Date.now() + 11 * MINUTE));
      assert.deepEqual(await queued(lift, made.pings), {}, 'nothing was sent, so nothing recovers');
      assert.deepEqual(await queued(lift, [health]), { 'email:unknown:recovery': 1 });
    });

    it('a frozen probe: the same one alarm per trigger, in its own words', async () => {
      const made = await probeWith('frozen', { health: true });
      await trigger(made.probe, 'down', 'email');
      await trigger(made.probe, 'unknown', 'webhook');
      await trigger(made.probe, 'up', 'email');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      links.set(made.probe, { connected: true, offsetMs: HOUR });
      await now().freeze.sweep();
      assert.equal(now().freeze.frozenOn(made.probe), PINGS);
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(step, made.pings), {});
      assert.deepEqual(await queued(step, [health]), {
        'email:down:initial': 1,
        'webhook:unknown:initial': 1,
      });
      const said = await messages(step, health);
      assert.ok(
        said.includes(
          `probe frozen's clock reads earlier than results it already sent: ${String(PINGS)} ` +
            'sensors are Unknown until it catches up, held as this one alarm',
        ),
        said.join(' | '),
      );
      assert.ok(
        said.some((message) => /cannot accept results until its clock passes/u.test(message)),
        said.join(' | '),
      );

      const lift = await mark();
      links.set(made.probe, { connected: true, offsetMs: 0 });
      await now().freeze.sweep();
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(lift, made.pings), {});
      assert.deepEqual(await queued(lift, [health]), {
        'email:down:recovery': 1,
        'email:up:initial': 1,
        'webhook:unknown:recovery': 1,
      });
      assert.ok(
        (await messages(lift, health)).includes(
          "probe frozen's clock has caught up: its sensors are no longer held",
        ),
      );
    });

    it('shows the view to the Unknown trigger and to nothing else', async () => {
      // Guard 1. Two probes, one with a trigger on Unknown over its Probe Health and one with no
      // trigger at all, taken through the same loss together. Their Probe Health state history
      // and what the object read returns for it are the same. The view reached the notification
      // and went no further.
      const seen = await probeWith('viewed', { health: true });
      const unseen = await probeWith('unviewed', { health: true });
      await trigger(seen.probe, 'unknown', 'email');
      await settle(seen);
      await settle(unseen);

      const step = await mark();
      const [from] = await db.query<{ at: Date }>('SELECT now() AS at');
      for (const made of [seen, unseen]) {
        links.set(made.probe, { connected: false, offsetMs: null });
        await now().reachability.lost(made.probe);
      }
      await healthSweep();
      await fire();
      // What `GET /sensors/:id/state` answers, read while the probes are away.
      const during = await Promise.all(
        [seen, unseen].map(async (made) => {
          const runtime = await readSensorState(db, healthOf(made));
          assert.ok(runtime !== null);
          return { state: runtime.state, cause: runtime.cause, message: runtime.message };
        }),
      );
      for (const made of [seen, unseen]) {
        links.set(made.probe, { connected: true, offsetMs: 0 });
        await now().reachability.found(made.probe);
      }
      await healthSweep();
      await fire();

      assert.deepEqual(await queued(step, [healthOf(seen)]), {
        'email:unknown:initial': 1,
        'email:unknown:recovery': 1,
      });
      const history = async (sensorId: number): Promise<string[]> =>
        (
          await db.query<{ row: string }>(
            `SELECT state::text || '/' || coalesce(cause::text, '-') || '/' || message AS row
             FROM sensor_state WHERE sensor_id = $1 AND time >= $2 ORDER BY time`,
            [sensorId, from?.at],
          )
        ).map((one) => one.row);
      const seenHistory = await history(healthOf(seen));
      assert.deepEqual(seenHistory, await history(healthOf(unseen)));
      assert.ok(seenHistory.length >= 2, `a Down and an Up: ${seenHistory.join(', ')}`);
      assert.ok(!seenHistory.some((row) => row.startsWith('unknown/')), seenHistory.join(', '));

      assert.deepEqual(during[0], during[1]);
      assert.equal(during[0]?.state, 'down', 'Probe Health reads Down to everything but a trigger');
    });

    it('a core restart where every probe reconnects within the grace sends nothing, on any trigger', async () => {
      const made = await probeWith('restarted', { health: true });
      for (const state of TRIGGERABLE_STATES) await trigger(made.probe, state, 'email');
      await settle(made);
      const step = await mark();

      // The core goes away, and comes back knowing nothing. The probe takes a minute to redial:
      // a Probe Health sweep and the alarm sweep both run before it does, well inside the grace.
      links.set(made.probe, { connected: false, offsetMs: null });
      core = boot();
      await now().targets.refresh(db);
      await db.tx((q) => engine.reconcileSubtree(q, h.rootId, new Date(), { armFrom: 'now' }));
      now().uptimeMs = 30_000;
      await now().watch.settle();
      await healthSweep();
      await fire();
      assert.deepEqual(
        await queued(step, [...made.pings, healthOf(made)]),
        {},
        'before it redials',
      );

      now().uptimeMs = 60_000;
      links.set(made.probe, { connected: true, offsetMs: null });
      await now().reachability.found(made.probe);
      await now().watch.settle();
      now().uptimeMs = 90_000;
      await now().freeze.sweep();
      await healthSweep();
      await fire();

      assert.deepEqual(await queued(step, [...made.pings, healthOf(made)]), {});
      assert.equal(now().index.episodeOf(healthOf(made)), undefined, 'no episode opened');
      assert.equal(now().index.endedEpisodeOf(healthOf(made)), undefined, 'and none closed');
    });

    it('a core restart where a probe never comes back: one Down per Down trigger once the grace ends, and one episode alarm per Unknown trigger', async () => {
      const made = await probeWith('never-back', { health: true });
      await trigger(made.probe, 'down', 'email');
      await trigger(made.probe, 'down', 'webhook');
      await trigger(made.probe, 'unknown', 'email');
      await trigger(made.probe, 'unknown', 'webhook');
      await settle(made);
      const health = healthOf(made);
      const step = await mark();

      links.set(made.probe, { connected: false, offsetMs: null });
      core = boot();
      await now().targets.refresh(db);
      await db.tx((q) => engine.reconcileSubtree(q, h.rootId, new Date(), { armFrom: 'now' }));
      for (const uptimeMs of [30_000, 60_000, 90_000]) {
        now().uptimeMs = uptimeMs;
        await now().watch.settle();
        await healthSweep();
        await fire();
      }
      assert.deepEqual(await queued(step, [...made.pings, health]), {}, 'inside the grace');

      // The grace runs out: the watch marks the probe lost, and Probe Health reads it gone.
      now().uptimeMs = 2 * MINUTE + 30_000;
      await now().watch.settle();
      assert.equal(now().reachability.offlineReason(made.probe), 'link');
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(step, made.pings), {});
      assert.deepEqual(await queued(step, [health]), {
        'email:down:initial': 1,
        'email:unknown:initial': 1,
        'webhook:down:initial': 1,
        'webhook:unknown:initial': 1,
      });
      assert.ok(
        (await messages(step, health)).includes(
          `probe never-back is lost: the ${String(PINGS)} sensors it carries are Unknown, held as this one alarm`,
        ),
      );

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {});
      assert.deepEqual(await queued(lift, [health]), {
        'email:down:recovery': 1,
        'email:unknown:recovery': 1,
        'webhook:down:recovery': 1,
        'webhook:unknown:recovery': 1,
      });
    });

    it('a core restart during a real loss sends no second Unknown for the same probe', async () => {
      const made = await probeWith('still-lost', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await trigger(made.probe, 'down', 'email');
      await trigger(made.probe, 'up', 'email');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [...made.pings, health]), {
        'email:down:initial': 1,
        'email:unknown:initial': 1,
      });

      // The core restarts while the probe is still away. Its sensors still read Unknown/`probe`
      // in the table, and nothing in memory says why until the grace has run out.
      const restart = await mark();
      core = boot();
      await now().targets.refresh(db);
      await db.tx((q) => engine.reconcileSubtree(q, h.rootId, new Date(), { armFrom: 'now' }));
      await fire();
      assert.deepEqual(await queued(restart, [...made.pings, health]), {}, 'the boot pass');

      await healthSweep();
      now().uptimeMs = 5 * MINUTE;
      await now().watch.settle();
      assert.equal(now().reachability.offlineReason(made.probe), 'link', 'marked lost again');
      await fire();
      assert.deepEqual(await queued(restart, [...made.pings, health]), {}, 'the loss re-marked');

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {});
      assert.deepEqual(await queued(lift, [health]), {
        'email:down:recovery': 1,
        'email:unknown:recovery': 1,
        'email:up:initial': 1,
      });
    });

    it('sensors moved under a probe lost while it carried nothing: one episode alarm, not silence (`M-24`)', async () => {
      // Lost with nothing held, so no episode began and nothing re-decided its Probe Health. The
      // sensors that arrived were held behind that alarm, which was never armed: a trigger on
      // Unknown heard nothing for the whole outage, and nothing when it ended.
      const bare = await bareProbe('bare-site');
      await trigger(bare.probe, 'unknown', 'email');
      await healthSweep();
      links.set(bare.probe, { connected: false, offsetMs: null });
      assert.equal(await now().reachability.lost(bare.probe), 0, 'nothing held');
      await healthSweep();
      await fire();
      assert.deepEqual(await alarmsOn([bare.health]), [], 'no episode, so no alarm yet');

      const donor = await probeWith('donor-site', { health: false });
      await settle(donor);
      const step = await mark();
      await withTreeSync(() => h.service.move(testActor, donor.site, bare.probe, { kind: 'none' }));
      assert.equal((await alarmsOn([bare.health])).length, 1, 'the episode alarm is armed');
      await fire();
      assert.deepEqual(await queued(step, donor.pings), {}, 'held behind the probe’s alarm');
      assert.deepEqual(await queued(step, [bare.health]), { 'email:unknown:initial': 1 });
      assert.deepEqual(await messages(step, bare.health), [
        `probe bare-site is lost: the ${String(PINGS)} sensors it carries are Unknown, held as this one alarm`,
      ]);

      const lift = await mark();
      links.set(bare.probe, { connected: true, offsetMs: 0 });
      await now().reachability.found(bare.probe);
      await healthSweep();
      await fire();
      assert.deepEqual(await queued(lift, [bare.health]), { 'email:unknown:recovery': 1 });
    });

    it('a lost probe whose sensors are all moved away: its episode alarm recovers, in words that say why (`M-24`)', async () => {
      // The remedy for a dead probe is to move its devices to a live one. That ends the episode
      // while the probe is still lost and Probe Health still Down, which the view no longer
      // covers, and the alarm was suspended and later stood down silently: its recipients were
      // told the sensors were held and never told they were not.
      const made = await probeWith('emptied', { health: true });
      await trigger(made.probe, 'unknown', 'email', 0, { repeatMinutes: 30 });
      await settle(made);
      const health = healthOf(made);
      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [health]), { 'email:unknown:initial': 1 });
      assert.equal((await alarmsOn([health])).length, 1, 'the episode alarm stands');

      const live = (
        await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name: 'emptied-to' })
      ).id;
      links.set(live, { connected: true, offsetMs: 0 });
      const moved = await mark();
      await withTreeSync(() => h.service.move(testActor, made.site, live, { kind: 'none' }));
      // At the move, not at the next repeat, so nothing that happens to the probe afterwards,
      // deleting it included, can take the all-clear away with it.
      assert.deepEqual(await alarmsOn([health]), [], 'recovered by the move, so gone');
      await fire();
      assert.deepEqual(await queued(moved, [health]), { 'email:unknown:recovery': 1 });
      assert.deepEqual(await messages(moved, health), [
        'probe emptied is still lost, but none of its sensors are held now: they were moved off it or deleted',
      ]);
      await scheduler.sweep(new Date(Date.now() + 31 * MINUTE));
      assert.deepEqual(await queued(moved, [health]), { 'email:unknown:recovery': 1 }, 'once');
      assert.deepEqual(await queued(moved, made.pings), {}, 'nothing was sent for them');
    });

    it('an acknowledged Probe Health stops the episode alarm’s escalation and repeats, and its lapse resumes them (`M-24`)', async () => {
      const made = await probeWith('acknowledged', { health: true });
      await trigger(made.probe, 'unknown', 'email', 0, {
        escalationLatencySeconds: 1800,
        repeatMinutes: 15,
      });
      await settle(made);
      const health = healthOf(made);
      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [health]), { 'email:unknown:initial': 1 });
      assert.deepEqual(await alarmsOn([health]), [{ suppressed: false, phase: 'notified' }]);

      await h.service.acknowledge(
        testActor,
        health,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'on it',
      );
      assert.deepEqual(await alarmsOn([health]), [{ suppressed: true, phase: 'notified' }]);
      const quiet = await mark();
      await healthSweep();
      await scheduler.sweep(new Date(Date.now() + 61 * MINUTE));
      assert.deepEqual(await queued(quiet, [health]), {}, 'no escalation and no repeat');

      await h.service.clearAcknowledgement(
        testActor,
        health,
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
      );
      assert.deepEqual(await alarmsOn([health]), [{ suppressed: false, phase: 'notified' }]);
      const resumed = await mark();
      await scheduler.sweep(new Date(Date.now() + 61 * MINUTE));
      assert.deepEqual(
        await queued(resumed, [health]),
        { 'email:unknown:escalation': 1 },
        'the escalation it was putting off',
      );
    });

    it('a Probe Health paused during a loss: the sensors it held notify one by one, as a pause before the loss does (`M-24`)', async () => {
      // The pause cancels the episode alarm, as a pause cancels any alarm, and the sensors held
      // behind it are re-decided with it, unheld. Which came first, the pause or the loss, no
      // longer decides whether the trigger hears anything.
      const made = await probeWith('paused-mid-loss', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);
      const health = healthOf(made);
      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [health]), { 'email:unknown:initial': 1 });
      assert.deepEqual(await queued(step, made.pings), {});
      assert.equal((await alarmsOn([health])).length, 1, 'the episode alarm stands');

      const paused = await mark();
      await h.service.pause(testActor, health, { kind: 'indefinite' }, 'maintenance');
      assert.deepEqual(await alarmsOn([health]), [], 'the pause cancelled it');
      assert.equal((await alarmsOn(made.pings)).length, PINGS, 'one alarm armed per sensor');
      await fire();
      assert.deepEqual(await queued(paused, made.pings), { 'email:unknown:initial': PINGS });
      assert.deepEqual(await queued(paused, [health]), {}, 'a pause says nothing');

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {
        'email:unknown:recovery': PINGS - DOWN_PINGS,
      });
    });

    /** Deletes one sensor as an operator would, with the tree's sinks in the transaction. */
    async function deleteSensor(sensorId: number): Promise<void> {
      await withTreeSync(() =>
        h.service.delete(testActor, sensorId, { kind: 'exact', descendants: 0 }, { kind: 'none' }),
      );
    }

    it('a Probe Health deleted during a loss: the sensors it held notify one by one, as for a pause (`M-25`)', async () => {
      // A deleted Probe Health has no row, so nothing re-decided anything for it: the sensors
      // held behind it stayed held, with no alarm, until the probe came back and there was
      // nothing left to say.
      const made = await probeWith('deleted-mid-loss', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);
      const health = healthOf(made);
      const step = await mark();
      await lose(made);
      assert.deepEqual(await queued(step, [health]), { 'email:unknown:initial': 1 });
      assert.equal((await alarmsOn([health])).length, 1, 'the episode alarm stands');
      assert.deepEqual(await alarmsOn(made.pings), [], 'and holds its sensors');

      const deleted = await mark();
      await deleteSensor(health);
      assert.equal((await alarmsOn(made.pings)).length, PINGS, 'one alarm armed per sensor');
      await fire();
      assert.deepEqual(await queued(deleted, made.pings), { 'email:unknown:initial': PINGS });

      const lift = await mark();
      await find(made);
      assert.deepEqual(await queued(lift, made.pings), {
        'email:unknown:recovery': PINGS - DOWN_PINGS,
      });
    });

    it('one of two Probe Healths deleted during a loss: the other still holds its sensors (`M-25`)', async () => {
      const made = await probeWith('two-healths', { health: true });
      const first = healthOf(made);
      const box = (await h.repository.get(db, first))?.parentId;
      assert.ok(box !== undefined && box !== null);
      const second = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box,
          name: 'two-healths-health-2',
          sensorType: 'ms.probe.health',
          params: {},
        } as never)
      ).id;
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);
      await healthSweep();
      await lose(made);
      assert.equal((await alarmsOn([second])).length, 1, 'the other’s episode alarm stands');
      assert.deepEqual(await alarmsOn(made.pings), [], 'and the sensors are held');

      const deleted = await mark();
      await deleteSensor(first);
      await fire();
      assert.deepEqual(await alarmsOn(made.pings), [], 'still held, behind the other');
      assert.deepEqual(await queued(deleted, made.pings), {});
      assert.equal((await alarmsOn([second])).length, 1, 'which still stands for them');
    });

    it('a probe killed and restarted every few seconds: one alarm on Down and one on Unknown, and one recovery each once it stays back (`M-18`)', async (t) => {
      // `P-215`'s loop as the core lives it: every kill closes the socket and opens an episode,
      // every reconnect ends it, and the sweep reads the link Down and Up in turn. Without the
      // hold that was an alarm per kill on Unknown and one per observed outage on Down.
      holding = true;
      t.after(() => {
        holding = false;
      });
      const made = await probeWith('restarting', { health: true });
      await trigger(made.probe, 'down', 'email');
      await trigger(made.probe, 'unknown', 'webhook');
      await settle(made);
      const health = healthOf(made);

      const step = await mark();
      for (let kill = 0; kill < 6; kill += 1) {
        await lose(made);
        await find(made);
      }
      assert.deepEqual(await queued(step, made.pings), {});
      assert.deepEqual(await queued(step, [health]), {
        'email:down:initial': 1,
        'webhook:unknown:initial': 1,
      });

      // Back, and held: nothing inside the hold, and both recoveries once it has lasted.
      const back = await mark();
      await scheduler.sweep(new Date(Date.now() + 4 * MINUTE));
      assert.deepEqual(await queued(back, [health]), {}, 'inside the hold');
      await scheduler.sweep(new Date(Date.now() + 6 * MINUTE));
      assert.deepEqual(await queued(back, [health]), {
        'email:down:recovery': 1,
        'webhook:unknown:recovery': 1,
      });
      assert.ok(
        (await messages(back, health)).includes(
          'probe restarting is answering again: its sensors are no longer held',
        ),
        'the episode recovery keeps its words across six episodes',
      );
      assert.deepEqual(await alarmsOn([health]), []);

      // Genuine: a loss after a return that lasted is a second outage, and a second alarm.
      const second = await mark();
      await lose(made);
      assert.deepEqual(await queued(second, [health]), {
        'email:down:initial': 1,
        'webhook:unknown:initial': 1,
      });
    });

    it('a lost probe whose sensors are all moved away recovers at once, hold or not (`M-18`)', async (t) => {
      // An emptied episode is not a return: the probe is still lost and nothing flaps, so its
      // recipients are told at the move, as `M-24` has it.
      holding = true;
      t.after(() => {
        holding = false;
      });
      const made = await probeWith('emptied-held', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);
      const health = healthOf(made);
      await lose(made);
      const live = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'emptied-held-to',
        })
      ).id;
      links.set(live, { connected: true, offsetMs: 0 });
      const moved = await mark();
      await withTreeSync(() => h.service.move(testActor, made.site, live, { kind: 'none' }));
      assert.deepEqual(await alarmsOn([health]), [], 'recovered by the move, not held');
      assert.deepEqual(await queued(moved, [health]), { 'email:unknown:recovery': 1 });
      // And the list says what is true: the probe is still lost, and nothing is held.
      const row = await listed(made);
      assert.equal(row?.state, 'down');
      assert.equal(row.recovering, null);
    });

    it('lists a return held through an episode’s end as recovering, a relapse as Down, and nothing once it has lasted (`M-18`)', async (t) => {
      // The alarm list's side of the loop. The one alarm an Unknown trigger holds for the probe
      // stands on Probe Health, whose own state is Up while that alarm waits to see the return
      // last: the list is the one place that says the alarm is not over.
      holding = true;
      t.after(() => {
        holding = false;
      });
      const made = await probeWith('listed-held', { health: true });
      await trigger(made.probe, 'unknown', 'email');
      await settle(made);

      await lose(made);
      const lost = await listed(made);
      assert.equal(lost?.state, 'down');
      assert.equal(lost.recovering, null);

      const found = Date.now();
      await find(made);
      const held = await listed(made);
      assert.equal(held?.state, 'up', 'Probe Health is back, and says so');
      assert.ok(held.recovering !== null, 'and its episode alarm is held');
      const confirmsAt = Date.parse(held.recovering.confirmsAt ?? '');
      assert.ok(
        confirmsAt >= found + 5 * MINUTE && confirmsAt <= Date.now() + 5 * MINUTE,
        `over five minutes after the reconnect: ${held.recovering.confirmsAt ?? 'null'}`,
      );

      // A relapse is a state change the stream carries, and the same alarm resumed: Down, and
      // nothing held.
      await lose(made);
      const relapsed = await listed(made);
      assert.equal(relapsed?.state, 'down');
      assert.equal(relapsed.recovering, null);

      await find(made);
      assert.notEqual((await listed(made))?.recovering ?? null, null, 'held again');
      await scheduler.sweep(new Date(Date.now() + 6 * MINUTE));
      assert.equal(await listed(made), undefined, 'over, and off the list');
    });
  },
);
