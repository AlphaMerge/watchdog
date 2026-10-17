import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '@ms/shared';
import type { Database } from '../../src/db/pool.js';
import { ClockFreeze, FROZEN_UNDER_SQL } from '../../src/probes/clock-freeze.js';
import type { HeldWordsLookup } from '../../src/state/runtime.js';
import type { ProbeLink } from '../../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * The probe clock sweep at five thousand sensors (`P-232`).
 *
 * `ClockFreeze.sweep` runs every thirty seconds for every connected probe: one recursive walk of
 * the probe's branch joined to `sensor_config` and `sensor_runtime`. Two numbers:
 *
 * - **An ordinary pass** — the clock is fine and nothing is frozen, so the walk returns no rows
 *   and nothing moves. This is the cost that is always being paid, so its budget is 1% of the
 *   period it runs on.
 * - **An edge** — a clock steps back an hour and every sensor freezes, then it is put right and
 *   every one thaws. Each moves five thousand states through `reevaluate`, which is what a lost
 *   probe costs, and it is printed rather than budgeted: it is the lost path's number.
 *
 * The plan is printed too, so the findings carry it.
 */
const GROUPS = 50;
const DEVICES_PER_GROUP = 5;
const SENSORS_PER_DEVICE = 20;
const SENSORS = GROUPS * DEVICES_PER_GROUP * SENSORS_PER_DEVICE;
const PASSES = 20;
/** 1% of the thirty seconds it runs on. */
const STEADY_BUDGET_MS = 300;

function link(clockOffsetMs: number): ProbeLink {
  const now = new Date();
  return {
    connected: true,
    gid: 'probe-gid',
    protocolVersion: PROTOCOL_VERSION,
    connectedAt: now,
    lastHeartbeatAt: now,
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: SENSORS,
    cadenceSeconds: 60,
    connectedForMs: 0,
    sinceResultsMs: 0,
    sinceConfigMs: 0,
    configured: true,
    configurable: true,
    lastResultsAt: now,
    configSentAt: now,
    clockOffsetMs,
  };
}

describe(
  'the probe clock sweep at five thousand sensors',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let probeId = 0;
    let offset = 0;
    let made: ClockFreeze | undefined;
    const freeze = (): ClockFreeze => {
      assert.ok(made !== undefined);
      return made;
    };
    const none: HeldWordsLookup = new Map();

    before(async () => {
      scratch = await createScratchDatabase('clockperf');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        clockFrozenSensors: () => made?.heldWords() ?? none,
      });

      // Through the service, one group at a time: the walk's cost is the real tree's shape.
      const started = Date.now();
      probeId = (
        await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name: 'clock' })
      ).id;
      for (let g = 0; g < GROUPS; g += 1) {
        const nodes: Record<string, unknown>[] = [
          { kind: 'group', name: `group-${String(g)}`, ref: 'g' },
        ];
        for (let d = 0; d < DEVICES_PER_GROUP; d += 1) {
          nodes.push({
            kind: 'device',
            name: `device-${String(g)}-${String(d)}`,
            host: `10.${String(g % 256)}.${String(d)}.1`,
            ref: `d${String(d)}`,
            parentRef: 'g',
          });
          for (let s = 0; s < SENSORS_PER_DEVICE; s += 1) {
            nodes.push({
              kind: 'sensor',
              name: `sensor-${String(g)}-${String(d)}-${String(s)}`,
              sensorType: 'icmp.ping',
              parentRef: `d${String(d)}`,
            });
          }
        }
        await h.service.createTree(testActor, { parentId: probeId, nodes } as never);
      }
      // Every sensor measured a minute ago, as on a probe that is scanning.
      await db.query(
        `UPDATE sensor_runtime SET last_result_at = now() - interval '1 minute'
         WHERE object_id IN (SELECT object_id FROM sensor_config)`,
      );
      await db.query('ANALYZE');
      process.stdout.write(
        `\n    built ${SENSORS.toLocaleString('en-GB')} sensors in ` +
          `${((Date.now() - started) / 1_000).toFixed(1)} s (setup, not measured)\n`,
      );

      assert.ok(h.states !== undefined && h.dependencies !== undefined);
      made = new ClockFreeze({
        db,
        logger: silent,
        states: h.states,
        dependencies: h.dependencies,
        links: { connectedProbeIds: () => [probeId], linkFor: () => link(offset) },
        coreEvaluatedTypes: ['ms.probe.health', 'ms.core.health', 'core.factory'],
      });
    });

    after(async () => {
      await scratch.drop();
    });

    it('costs an ordinary pass almost nothing, and says what the plan is', async () => {
      offset = 0;
      const times: number[] = [];
      for (let pass = 0; pass < PASSES; pass += 1) {
        const started = process.hrtime.bigint();
        const moved = await freeze().sweep();
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.equal(moved, 0);
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(PASSES / 2)] ?? Number.NaN;
      const worst = times.at(-1) ?? Number.NaN;

      const threshold = new Date(Date.now() + 60_000);
      const plan = await db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${FROZEN_UNDER_SQL}`,
        [probeId, ['ms.probe.health', 'ms.core.health', 'core.factory'], threshold],
      );
      process.stdout.write(
        `\n    measured, the clock sweep over ${SENSORS.toLocaleString('en-GB')} sensors:\n` +
          `      ordinary pass  median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms ` +
          `of ${String(PASSES)}\n` +
          `      plan (nothing frozen):\n` +
          plan.map((row) => `        ${row['QUERY PLAN']}`).join('\n') +
          '\n',
      );
      assert.ok(
        median < STEADY_BUDGET_MS,
        `an ordinary pass took ${median.toFixed(1)} ms; the budget is ${String(STEADY_BUDGET_MS)}`,
      );
    });

    it('moves every sensor at an edge, at what a lost probe costs', async () => {
      offset = 3_600_000;
      let started = process.hrtime.bigint();
      const frozen = await freeze().sweep();
      const freezeMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(freeze().frozenOn(probeId), SENSORS);

      offset = 0;
      started = process.hrtime.bigint();
      const thawed = await freeze().sweep();
      const thawMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(freeze().frozenOn(probeId), 0);

      process.stdout.write(
        `      edge           froze ${String(frozen)} in ${freezeMs.toFixed(0)} ms, ` +
          `thawed ${String(thawed)} in ${thawMs.toFixed(0)} ms\n`,
      );
    });
  },
);
