import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PROTOCOL_VERSION, type CheckResult } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { NO_LIMITS, rollUp } from '../src/state/limits.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { shippedUnit, startLimitOf } from './support/units.js';

const available = await databaseAvailable();

const T0 = new Date('2026-09-28T18:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** The core's Probe Health sweep interval (`packages/core/src/main.ts`). */
const SWEEP_MS = 30_000;

/** Any id: the scheduler writes the obligation, and delivery is not what is being counted. */
const TEMPLATE = 401;

const PROBE_LINK = BUILT_IN_LOOKUPS.find((lookup) => lookup.id === 'ms.probe.link');

const HOUR = 3_600_000;

const notifications = (n: number): string => `${String(n)} notification${n === 1 ? '' : 's'}`;

/** systemd's start limit. */
interface StartLimit {
  readonly burst: number;
  readonly intervalMs: number;
}

/** Read from `deploy/systemd/ms-probe.service`, so editing the unit re-runs this arithmetic (`P-222`). */
const SHIPPED_LIMIT: StartLimit = startLimitOf(shippedUnit('ms-probe'));

/**
 * A probe being killed and restarted, as the link to it looks from the core.
 *
 * Each round starts at a kill and lasts the next of `roundsMs`, cycled. The probe is down for
 * `upFromMs` of it — `RestartSec`, its own start, the connection — and connected for the rest.
 * With a `limit`, a round is refused once `burst` starts have already happened inside
 * `intervalMs`, and the link stays down from then on: the unit is `failed`.
 *
 * **A sequence of rounds rather than one period, because one period aliases against the sweep.**
 * At a constant ten seconds the thirty-second sweep lands on the same phase of every third round
 * for ever and sees nothing, or everything; at 11.3 s it saw 42 outages an hour and at 14 s, 18.
 * Replaying the measured rounds, which jitter, gives 36–45 whatever the phase.
 */
interface RestartLoop {
  readonly roundsMs: readonly number[];
  readonly upFromMs: number;
  readonly limit?: StartLimit;
}

/**
 * The measured loop: kill to kill 12.9, 11.3, 10.7, 9.9 and 14.4 s, with `RestartSec=5s`
 * (`docs/findings/2026-09-28-memory-ceiling.md`, via `P-213`). Down for the first 6.5 s of each —
 * the five seconds systemd waits, and a start — then connected until the kill: an assumption, and
 * the one that makes this the dangerous case. A probe whose working set is too large for its
 * ceiling gets far enough to connect, is sent its sensors, and grows past it.
 */
const MEASURED_ROUNDS_MS: readonly number[] = [12_900, 11_300, 10_700, 9_900, 14_400];
const DOWN_MS = 6_500;
const MEASURED: RestartLoop = { roundsMs: MEASURED_ROUNDS_MS, upFromMs: DOWN_MS };

/**
 * A loop whose probe stays connected for `connectedMs` a round before the ceiling takes it, with
 * the measured rounds' jitter. The measured loop is the fast end — its ceiling was 132 MiB — and
 * a probe that does not fit in the stock 6 GiB lasts longer: `P-206` measured 171 MiB/s early in
 * start-up and a peak of 2.5–3.5 GiB.
 */
function connectedFor(connectedMs: number): RestartLoop {
  const median = 11_300;
  return {
    roundsMs: MEASURED_ROUNDS_MS.map((round) =>
      Math.round(((DOWN_MS + connectedMs) * round) / median),
    ),
    upFromMs: DOWN_MS,
  };
}

/** When each round the unit is allowed begins, up to `horizonMs`. */
function startsOf(loop: RestartLoop, horizonMs: number): number[] {
  const starts: number[] = [];
  let at = 0;
  for (let round = 0; at < horizonMs; round += 1) {
    const { limit } = loop;
    if (limit !== undefined) {
      const recent = starts.filter((start) => start > at - limit.intervalMs).length;
      if (recent >= limit.burst) break;
    }
    starts.push(at);
    at += loop.roundsMs[round % loop.roundsMs.length] ?? 1;
  }
  return starts;
}

function linkUpAt(loop: RestartLoop, starts: readonly number[], ms: number): boolean {
  if (ms < 0) return true; // Healthy until the loop begins.
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? start + (loop.roundsMs[index % loop.roundsMs.length] ?? 1);
    if (ms >= start && ms < end) return ms - start >= loop.upFromMs;
  }
  return false; // Past the last start the unit allowed: `failed`, and the link stays down.
}

/** When the core sweeps: one healthy sweep before the first kill, then every thirty seconds. */
function sweepTimes(durationMs: number, offsetMs: number): number[] {
  const times = [offsetMs - SWEEP_MS];
  for (let ms = offsetMs; ms < durationMs; ms += SWEEP_MS) times.push(ms);
  return times;
}

/**
 * How many outages the sweep *sees*: every Up it observed followed by a Down.
 *
 * Pure arithmetic over the timeline, kept apart from the system under test so the pipeline test
 * below is a claim about the pipeline — that it turns each observed outage into exactly one
 * notification, collapsing none and adding none — rather than the pipeline checked against itself.
 */
function observedOutages(loop: RestartLoop, durationMs: number, offsetMs: number): number {
  const starts = startsOf(loop, durationMs + 60_000);
  let outages = 0;
  let wasUp = true;
  for (const ms of sweepTimes(durationMs, offsetMs)) {
    const up = linkUpAt(loop, starts, ms);
    if (wasUp && !up) outages += 1;
    wasUp = up;
  }
  return outages;
}

/** The loop begun at each of its rounds, and the sweep at every second of its thirty. */
function everyPhase(
  loop: RestartLoop,
  durationMs: number,
): { least: number; most: number; twoOrMore: number } {
  const counts: number[] = [];
  for (let first = 0; first < loop.roundsMs.length; first += 1) {
    const rotated = {
      ...loop,
      roundsMs: [...loop.roundsMs.slice(first), ...loop.roundsMs.slice(0, first)],
    };
    for (let offset = 0; offset < SWEEP_MS; offset += 1_000) {
      counts.push(observedOutages(rotated, durationMs, offset));
    }
  }
  return {
    least: Math.min(...counts),
    most: Math.max(...counts),
    twoOrMore: counts.filter((count) => count >= 2).length / counts.length,
  };
}

/**
 * `P-215`, in arithmetic: the worst case over every phase, not the phase one run happened to get.
 *
 * **Why this exists separately.** The first version of this scenario ran one phase through the
 * pipeline, got 1, and asserted `<= 2`. Over every phase, the same loop and limit raise two alarms
 * 41% of the time. A single phase is a sample; the claim in `docs/TASKS.md` is a bound, and a
 * bound is only asserted by looking at all of them.
 *
 * **What it shows, and does not.** A start limit turns an unbounded storm into a bounded one. It
 * does **not** give one alarm: `CLAUDE.md`'s *one outage, one alarm* is not met at the unit level,
 * and `M-18` — flap suppression in the alarm engine — is where it is to be met.
 */
describe('how many alarms a restart loop can raise, over every phase', () => {
  it('raises dozens an hour when nothing stops it', () => {
    const { least, most } = everyPhase(MEASURED, HOUR);
    assert.ok(least >= 30, `expected a storm at every phase, the quietest raised ${String(least)}`);
    assert.ok(most <= 50, String(most));
  });

  it('raises one or two once the shipped start limit stops it — not always one', () => {
    const { least, most, twoOrMore } = everyPhase({ ...MEASURED, limit: SHIPPED_LIMIT }, HOUR);
    assert.equal(least, 1);
    assert.equal(most, 2);
    // Pinned so that nobody reads the bound as "one" and tightens an assertion to match a lucky
    // run. `M-18` is what would make this zero.
    assert.ok(twoOrMore > 0.3, `two alarms at ${(twoOrMore * 100).toFixed(0)}% of phases`);
  });

  it('stops a probe that lasts a minute before the ceiling takes it, which five minutes would not', () => {
    const slow = connectedFor(60_000);
    // systemd refuses the sixth start inside the window, which takes five whole rounds: under
    // five minutes, rounds of about 66 s never fit, and the loop runs for ever.
    const fiveMinutes = everyPhase({ ...slow, limit: { burst: 5, intervalMs: 300_000 } }, HOUR);
    assert.ok(
      fiveMinutes.least >= 9,
      `a five-minute window let through ${String(fiveMinutes.least)}`,
    );
    const shipped = everyPhase({ ...slow, limit: SHIPPED_LIMIT }, HOUR);
    assert.ok(shipped.most <= 4, `the ten-minute window let through ${String(shipped.most)}`);
  });

  it('bounds every loop shape up to two minutes a round', () => {
    for (const connectedMs of [5_000, 15_000, 30_000, 60_000]) {
      const { most } = everyPhase({ ...connectedFor(connectedMs), limit: SHIPPED_LIMIT }, HOUR);
      assert.ok(most <= 4, `connected ${String(connectedMs / 1000)} s a round: ${String(most)}`);
    }
  });
});

/**
 * `P-215`: a probe killed at its memory ceiling and restarted, and the alarms that makes.
 *
 * `P-213` made both units' ceiling kill rather than throttle, and nothing in either unit ever
 * stops restarting: `RestartSec=5s` keeps five starts from fitting in systemd's default ten-second
 * window, so the default start limit can never trip. **One outage, one alarm** (`CLAUDE.md`) is
 * then a question of what the loop looks like from the core, and this counts it.
 *
 * **The link is judged by a lookup, so it is immediate** (`docs/state-machine.md` §2.2): no
 * two-step rule softens it, and a probe that is connected at one sweep and not at the next is Up
 * and then Down. State triggers default `initialLatencySeconds` to 0, so nothing downstream
 * softens it either. What decides the count is the phase between the loop and the sweep.
 *
 * Driven through the real sweep, the real `ms.probe.link` lookup, the real state machine, trigger
 * engine and scheduler. Only ingestion's batching is skipped: it moves results, it does not judge
 * them, and the judgement — `rollUp` over the lookup — is the same function ingestion calls.
 */
describe(
  'a probe restarted at its memory ceiling, and how many alarms it raises',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let triggers: TriggerService;
    let probeId: number;
    let sensorId: number;

    before(async () => {
      assert.ok(PROBE_LINK !== undefined, 'the built-in ms.probe.link lookup is missing');
      scratch = await createScratchDatabase('proberestart');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent, alarms: new AlarmRepository() });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
    });

    after(async () => {
      scheduler.stop();
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'probe-box',
        host: '127.0.0.1',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;

      // What an installation has unless somebody changed it: tell me when it goes Down, at once.
      await triggers.create(testActor, probeId, {
        kind: 'state',
        settings: { state: 'down', initialLatencySeconds: 0, initialTemplateId: TEMPLATE },
      });
    });

    function link(up: boolean, now: Date): ProbeLink {
      if (!up) return { connected: false };
      return {
        connected: true,
        protocolVersion: PROTOCOL_VERSION,
        connectedAt: now,
        lastHeartbeatAt: now,
        approved: true,
        agentVersion: '1.0.0',
        assignedSensors: 100,
        cadenceSeconds: 60,
        connectedForMs: 1_000,
        sinceResultsMs: 0,
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: now,
        configSentAt: now,
      };
    }

    /** What ingestion does with a Probe Health result, for the one channel that decides it. */
    async function ingest(results: readonly CheckResult[], now: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined && PROBE_LINK !== undefined);
      const decided: SensorResult[] = results.map((result) => {
        const connected = result.channels.find((channel) => channel.key === 'connected');
        return {
          sensorId: result.sensorId,
          at: now,
          outcome: result.outcome,
          message: result.message,
          channels:
            connected === undefined
              ? null
              : rollUp([
                  {
                    key: 'connected',
                    name: 'Link to the core',
                    unit: '',
                    value: connected.value,
                    decimals: null,
                    limits: NO_LIMITS,
                    lookupId: PROBE_LINK.id,
                    lookup: PROBE_LINK,
                  },
                ]),
        };
      });
      const decisions = await states.decide(decided);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(
          q,
          decided.map((one) => one.sensorId),
          now,
        );
      });
    }

    /** Plays the loop past the core's sweep, and returns how many notifications it asked for. */
    async function play(loop: RestartLoop, durationMs: number, offsetMs: number): Promise<number> {
      const starts = startsOf(loop, durationMs + 60_000);
      for (const ms of sweepTimes(durationMs, offsetMs)) {
        const now = at(ms);
        const up = linkUpAt(loop, starts, ms);
        const service = new ProbeHealthService({
          db,
          logger: silent,
          sources: { link: () => link(up, now) },
          ingest: (results) => ingest(results, now),
          now: () => now,
        });
        await service.sweep();
        await scheduler.sweep(now);
      }
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      return Number(rows[0]?.n ?? 0);
    }

    async function stateNow(): Promise<string | undefined> {
      const rows = await db.query<{ state: string }>(
        'SELECT state FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      return rows[0]?.state;
    }

    it('raises one alarm when the restarted probe never gets as far as connecting', async () => {
      // Every start dies before the link comes up — the loop `P-213` measured with the ceiling
      // below the probe's baseline. Quiet, and uninformative: the reason is on the probe's box.
      const notified = await play({ ...MEASURED, upFromMs: 60_000 }, 10 * 60_000, 15_000);
      assert.equal(notified, 1);
      assert.equal(await stateNow(), 'down');
    });

    // **Fidelity, not the bound.** The bound is the pure suite above, over every phase. What only a
    // database can show is that the real pipeline turns each outage the sweep saw into exactly one
    // notification — collapsing none and adding none — so the arithmetic's count is the count an
    // operator would get. Two phases each, one of them a phase that raises two with the limit.

    for (const offsetMs of [15_000, 3_000]) {
      it(`raises one notification per outage the sweep sees, unbounded (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        const notified = await play(MEASURED, HOUR, offsetMs);
        assert.equal(notified, observedOutages(MEASURED, HOUR, offsetMs));
        assert.ok(notified > 30, `expected a storm, got ${String(notified)} in an hour`);
        t.diagnostic(`an hour of the measured loop, never stopped: ${notifications(notified)}`);
      });

      it(`raises one notification per outage the sweep sees, with the start limit (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        const limited: RestartLoop = { ...MEASURED, limit: SHIPPED_LIMIT };
        const notified = await play(limited, HOUR, offsetMs);
        assert.equal(notified, observedOutages(limited, HOUR, offsetMs));
        assert.equal(await stateNow(), 'down', 'and it stays Down, where an operator will see it');
        t.diagnostic(`the same loop, stopped by the start limit: ${notifications(notified)}`);
      });
    }
  },
);
