import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../../src/db/pool.js';
import { SCHEDULE_ID } from '../../src/settings/registry.js';
import { ScheduleRepository } from '../../src/schedules/repository.js';
import { ScheduleService } from '../../src/schedules/service.js';
import { SchedulePauses } from '../../src/schedules/pauses.js';
import { ScheduleSweep } from '../../src/schedules/sweep.js';
import {
  formatPeriods,
  MINUTES_PER_WEEK,
  weekMinuteOf,
  type WeekInterval,
} from '../../src/schedules/definition.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement for the one periodic loop that had none (`P-186`).
 *
 * **`ScheduleSweep` runs once a minute, for ever, in every installation with a schedule**, and
 * nothing measured it. Everything else on a minute-by-minute clock in this system has a budget;
 * this walked every sensor in the installation and nobody knew what that cost.
 *
 * Three numbers, because they are three different questions:
 *
 * - **The floor** — no schedule assigned anywhere. `recompute` opens with a `LIMIT 1` that
 *   returns nothing, so an installation that does not use the feature should pay approximately
 *   zero for it. This is the common case and the one a budget must not quietly regress.
 * - **An ordinary minute** — a schedule assigned, nothing at an edge. The recursive walk runs and
 *   updates nothing, 1,438 times a day. This is the cost that is always being paid.
 * - **An edge** — the window has just closed and every sensor moves. Twice a day per schedule,
 *   and it is the term that bounds how long the pause view and the probe's configuration can
 *   disagree (`P-185`), so it is the one with an operator-visible consequence.
 *
 * The budgets are stated as fractions of the period rather than round numbers: a loop that runs
 * every sixty seconds should not spend one percent of its period on an ordinary pass, and an edge
 * an operator can perceive is one that lasts longer than a second.
 */
const SENSORS = 5_000;
const GROUPS = 50;
const DEVICES_PER_GROUP = 5;
const SENSORS_PER_DEVICE = 20;

/** 1% of the minute it runs on. */
const STEADY_BUDGET_MS = 600;
/** Under a second, because past that the `P-185` disagreement stops being imperceptible. */
const EDGE_BUDGET_MS = 1_000;
/** An installation that does not use schedules should not be able to tell this exists. */
const FLOOR_BUDGET_MS = 50;

describe(
  'the schedule sweep at five thousand sensors',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let sweep: ScheduleSweep;
    let probeId: number;
    let closedScheduleId: number;

    before(async () => {
      scratch = await createScratchDatabase('sweepperf');
      db = scratch.db;
      h = await buildHarness(db, { states: true });

      const repository = new ScheduleRepository();
      assert.ok(h.states !== undefined);
      const pauses = new SchedulePauses({ logger: silent, states: h.states, repository });
      const dependencies = h.dependencies;
      assert.ok(dependencies !== undefined);
      sweep = new ScheduleSweep({
        db,
        pauses,
        dependencies,
        logger: silent,
        // Never armed: every pass here is called by hand, so the timer would only add noise.
        intervalMs: 60 * 60_000,
      });

      // **Through the service, not through SQL.** The sweep's cost is a recursive walk over the
      // real `object` tree and a join onto `sensor_runtime`, so a tree assembled by hand would be
      // measuring a shape production does not have. Slow, and it is setup rather than the
      // measurement.
      const started = Date.now();
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: 1,
        name: 'Sweep probe',
      });
      probeId = probe.id;

      for (let g = 0; g < GROUPS; g += 1) {
        const group = await h.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: `group-${String(g)}`,
        });
        for (let d = 0; d < DEVICES_PER_GROUP; d += 1) {
          const device = await h.service.create(testActor, {
            kind: 'device',
            parentId: group.id,
            name: `device-${String(g)}-${String(d)}`,
            host: `10.${String(g % 256)}.${String(d)}.1`,
          });
          for (let s = 0; s < SENSORS_PER_DEVICE; s += 1) {
            await h.service.create(testActor, {
              kind: 'sensor',
              parentId: device.id,
              name: `sensor-${String(g)}-${String(d)}-${String(s)}`,
              sensorType: 'icmp.ping',
            });
          }
        }
      }
      process.stdout.write(
        `\n    built ${SENSORS.toLocaleString('en-GB')} sensors in ` +
          `${((Date.now() - started) / 1_000).toFixed(1)} s (setup, not measured)\n`,
      );

      const schedules = new ScheduleService({
        db,
        repository,
        audit: h.audit,
        logger: silent,
      });
      // A window a long way from now, on both sides — so it is closed whatever hour this runs at
      // (`P-184`).
      const minute = weekMinuteOf(new Date(), 'UTC');
      const away = (minute + MINUTES_PER_WEEK / 2) % MINUTES_PER_WEEK;
      const interval: WeekInterval = {
        start: Math.max(0, away - 60),
        end: Math.min(MINUTES_PER_WEEK, away + 60),
      };
      closedScheduleId = (
        await schedules.create(testActor, {
          name: 'sweep-perf',
          periods: formatPeriods([interval]),
        })
      ).id;
    });

    after(async () => {
      sweep.stop();
      await scratch.drop();
    });

    const sensorCount = async (): Promise<number> => {
      const rows = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM object WHERE kind = 'sensor'`,
      );
      return Number(rows[0]?.count ?? 0);
    };

    const paused = async (): Promise<number> => {
      const rows = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM sensor_runtime WHERE paused_by_schedule`,
      );
      return Number(rows[0]?.count ?? 0);
    };

    /**
     * Three passes, reported as median and range.
     *
     * **A single sample is not a measurement on a machine somebody else is also using.** The
     * first pass also pays for cold buffers and an unplanned query, which is a real cost once per
     * process start and not the cost this budget is about — reporting all three lets a reader see
     * which it was rather than taking the median on trust.
     */
    const SAMPLES = 3;

    const sample = async (
      before: () => Promise<void>,
      pass: () => Promise<number>,
    ): Promise<{ ms: number[]; moved: number }> => {
      const ms: number[] = [];
      let moved = 0;
      for (let run = 0; run < SAMPLES; run += 1) {
        await before();
        const started = process.hrtime.bigint();
        moved = await pass();
        ms.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      return { ms, moved };
    };

    const median = (ms: readonly number[]): number =>
      [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 0;

    const report = (label: string, ms: readonly number[], budget: number, moved: number): void => {
      const mid = median(ms);
      process.stdout.write(
        `      ${label.padEnd(22)}${mid.toFixed(1).padStart(7)} ms  ` +
          `${`${moved.toLocaleString('en-GB')} moved`.padStart(14)}  ` +
          `${`${Math.round(((budget - mid) / budget) * 100).toString()}% spare`.padStart(12)}  ` +
          `[${ms.map((one) => one.toFixed(1)).join(', ')}]\n`,
      );
    };

    it('measures a sweep at every scale the loop actually meets', async () => {
      assert.equal(await sensorCount(), SENSORS, 'the tree is the size the budget is about');
      process.stdout.write('\n    measured (P-186):\n');

      // ── the floor: nothing assigned ────────────────────────────────────────────────────────
      // `anyWork` is a `LIMIT 1` that returns nothing, so this is what an installation with no
      // schedules pays every minute for a feature it does not use.
      const floor = await sample(
        () => Promise.resolve(),
        () => sweep.sweep(),
      );
      report('no schedule at all', floor.ms, FLOOR_BUDGET_MS, floor.moved);
      assert.equal(floor.moved, 0);

      // ── an edge: the window has just closed on every sensor ───────────────────────────────
      await h.service.setSetting(testActor, probeId, SCHEDULE_ID.key, closedScheduleId);
      const edge = await sample(
        async () => {
          // Assigning is itself a mutation and `ScheduleSync` recomputes inside it, so the flags
          // are already moved by the time a sweep would see them. Cleared before each pass so the
          // sweep does the work this case is about rather than finding it done.
          await db.query(`UPDATE sensor_runtime SET paused_by_schedule = false`);
          assert.equal(await paused(), 0);
        },
        () => sweep.sweep(),
      );
      report('a window closing', edge.ms, EDGE_BUDGET_MS, edge.moved);
      assert.equal(edge.moved, SENSORS, 'every sensor moved, which is what makes it the edge');
      assert.equal(await paused(), SENSORS);

      // ── an ordinary minute: assigned, nothing at an edge ──────────────────────────────────
      // The walk runs and updates nothing. 1,438 of the 1,440 passes in a day look like this.
      const steady = await sample(
        () => Promise.resolve(),
        () => sweep.sweep(),
      );
      report('an ordinary minute', steady.ms, STEADY_BUDGET_MS, steady.moved);
      assert.equal(steady.moved, 0, 'nothing moves when nothing is at an edge');

      const floorMs = median(floor.ms);
      const edgeMs = median(edge.ms);
      const steadyMs = median(steady.ms);
      assert.ok(
        floorMs < FLOOR_BUDGET_MS,
        `an unscheduled installation paid ${floorMs.toFixed(1)} ms against ${String(FLOOR_BUDGET_MS)} ms`,
      );
      assert.ok(
        edgeMs < EDGE_BUDGET_MS,
        `a window edge took ${edgeMs.toFixed(1)} ms against ${String(EDGE_BUDGET_MS)} ms`,
      );
      assert.ok(
        steadyMs < STEADY_BUDGET_MS,
        `an ordinary minute took ${steadyMs.toFixed(1)} ms against ${String(STEADY_BUDGET_MS)} ms`,
      );
    });
  },
);
