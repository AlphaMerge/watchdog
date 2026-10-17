import { strict as assert } from 'node:assert';
import { loadavg } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { coreConfigSchema, loadConfig, type CheckResult, type CoreConfig } from '@ms/shared';
import { DatabaseAuditSink } from '../../src/audit/store.js';
import type { Database } from '../../src/db/pool.js';
import { ChannelResolver } from '../../src/ingestion/channels.js';
import { Ingestor } from '../../src/ingestion/ingestor.js';
import { SensorOwnership } from '../../src/ingestion/ownership.js';
import { IngestionService } from '../../src/ingestion/service.js';
import type { TreeNodeInput } from '../../src/objects/tree-plan.js';
import type { ProbeOrigin } from '../../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor, type Harness } from '../support/tree.js';
import { within } from '../support/within.js';

const available = await databaseAvailable();

/**
 * What a channel `PATCH`'s lock on its sensor costs the results written for that sensor
 * (`P-324`).
 *
 * `P-314` made `patchChannel` take its sensor's `object` row `FOR UPDATE` before anything else
 * (`lockForUpdate`, `A-64`'s helper). It had written the channel row first and the sensor after,
 * through `channel_touch_owner`, while a reading moving the primary off that channel held the
 * sensor and waited for the channel: a deadlock. `FOR UPDATE` is the strongest row lock there is.
 * Beyond what the trigger's own UPDATE takes anyway (`FOR NO KEY UPDATE`), it also shuts out
 * `FOR KEY SHARE` — the lock a foreign key's check takes on the row it references — for the whole
 * of the PATCH's transaction. So the questions are which results transactions take that lock on
 * their sensor, and how long they wait for it.
 *
 * **What the code says, which this measures rather than assumes.** The ordinary results
 * transaction (`Ingestor.#writeOne`) takes no lock on the sensor's `object` row at all: `sample`
 * has no foreign key (`S-03`), nor has `sensor_state`; the `sensor_runtime` UPDATE leaves its key
 * alone, so PostgreSQL skips that key's check; and a counter's baseline references the channel,
 * whose row the PATCH's own UPDATE holds only `FOR NO KEY UPDATE`. What does take `FOR KEY SHARE`
 * on the sensor is an INSERT of a row that references it, in the same transaction: an alarm armed
 * by the reaction (`notification_alarm`, `N-02`), or a channel a reading creates — and that path
 * takes the sensor `FOR NO KEY UPDATE` first (`ChannelResolver.#create`), so it waits for any
 * PATCH whatever the PATCH's mode. The check is timed here as PostgreSQL issues it, the one
 * statement this file writes by hand: arming an alarm on every run would take the sensor Down and
 * back each time, and what is wanted is the lock's wait, not the arm's work.
 *
 * Seven rows, each `RUNS` runs after `WARMUP`:
 *
 * - **a results batch for the sensor, alone**: one probe's batch through `acceptProbeResults` to
 *   its acknowledgement, which is what a probe waits for, and the `Ingestor`'s own transaction
 *   from its stats, which is what every batch queued behind it waits for;
 * - **the same, while a loop PATCHes that sensor's `rtt` limits back to back**;
 * - **the same, while the loop PATCHes its sibling's instead**: the same load on the database and
 *   on this process's event loop, on rows the results never touch, so the difference between this
 *   row and the last is the lock and nothing else;
 * - **the PATCH alone**, which is the most one waiter can wait for one PATCH;
 * - **the foreign key check, alone**, then beside the same two loops.
 *
 * A `FOR NO KEY UPDATE` helper would admit the check and still shut out every other writer of the
 * row: every UPDATE of it takes at least that mode, an edit's versioned one included, and
 * `#create` takes that mode by name. So the check's wait beside the loop on its sensor is exactly
 * what such a helper would save, and the results rows say whether the ordinary write would notice
 * the difference at all.
 *
 * **At the v1 target**, 5,000 sensors under one probe, built as `ingestion-performance.test.ts`'s
 * ownership case builds them: ten branches of ten groups of ten devices of five pings, through
 * `createTree`. A row lock is one row's, so the size is not what is under test; it is there so the
 * PATCH and the write each read the indexes of an installation of the size v1 promises.
 */
const BRANCHES = 10;
const GROUPS_PER_BRANCH = 10;
const DEVICES_PER_GROUP = 10;
const SENSORS_PER_DEVICE = 5;
const SENSORS = BRANCHES * GROUPS_PER_BRANCH * DEVICES_PER_GROUP * SENSORS_PER_DEVICE;

const WARMUP = 50;
const RUNS = 400;

/**
 * The budgets, generous on purpose: a quiet run should clear each by an order of magnitude or
 * more. They are there to catch a wait that is not one PATCH long, not a millisecond's regression;
 * the printed numbers are the finding.
 *
 * - **A results batch's p95 under 100 ms, in every row**: Phase 1's criterion for a write
 *   (`PLAN.md`, a p99 under 100 ms), the number `ingestion-performance.test.ts` holds the pipeline
 *   to. A batch that waited for one PATCH has waited a few milliseconds.
 * - **The foreign key check's p95 under the same 100 ms**, since when it is an alarm being armed
 *   it is a statement inside a results transaction.
 * - **The PATCH's p95 under 250 ms**: an operator's quarter second, the budget `A-12` gives a page
 *   of the tree (`visibility-performance.test.ts`).
 */
const RESULTS_P95_BUDGET_MS = 100;
const KEY_SHARE_P95_BUDGET_MS = 100;
const PATCH_P95_BUDGET_MS = 250;

/**
 * A contended row is only a measurement of contention if a PATCH was in flight for most of it.
 * Back to back, the loop should be in flight nearly all the time; under half means it was not.
 */
const MIN_IN_FLIGHT = 0.5;

/** Each phase's own bound (`within`): the database is the far end, and a lock can wait for ever. */
const PHASE_BOUND_MS = 60_000;

/** The ingestion settings we ship, read from the schema so the two cannot drift apart. */
const SHIPPED = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config
  .ingestion;

/** One PATCH, from the call to its answer, in `process.hrtime.bigint()` nanoseconds. */
type Span = readonly [from: bigint, to: bigint];

interface Spread {
  median: number;
  p95: number;
  max: number;
}

/** What the PATCH loop did inside a measured window. */
interface Contention {
  patches: number;
  /** The median PATCH among them, while the other side ran. */
  median: number;
  /** The share of the window a PATCH was in flight, 0 to 1. */
  inFlight: number;
}

interface Measured {
  label: string;
  ms: Spread;
  /** The `Ingestor`'s transaction, for a results row; null for the others. */
  write: Spread | null;
  /** The PATCH loop beside it; null for a row measured alone. */
  loop: Contention | null;
}

/** The `floor(fraction × n)`th of the sorted values, as `Ingestor.stats()` reads its own. */
function spread(ms: readonly number[]): Spread {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? Number.NaN };
}

function msSince(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** The PATCHes that overlapped `[from, to]`, and for how much of it one was in flight. */
function contention(spans: readonly Span[], from: bigint, to: bigint): Contention {
  let held = 0n;
  const inside: number[] = [];
  for (const [start, end] of spans) {
    const a = start > from ? start : from;
    const b = end < to ? end : to;
    if (b <= a) continue;
    held += b - a;
    inside.push(Number(end - start) / 1e6);
  }
  return {
    patches: inside.length,
    median: spread(inside).median,
    inFlight: Number(held) / Number(to - from),
  };
}

describe(
  `a channel PATCH’s lock on its sensor at ${SENSORS.toLocaleString('en')} sensors (P-324)`,
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let origin: ProbeOrigin;
    /** The sensor whose results are written, and whose `rtt` channel is PATCHed. */
    let measured: number;
    /** Its sibling on the same device: the same PATCHes, on rows the results never touch. */
    let sibling: number;
    let conditions = '';

    before(async () => {
      scratch = await createScratchDatabase('channel_lock_perf');
      db = scratch.db;
      // With the state machine and the dependency reactor, which the results path writes through.
      harness = await buildHarness(db, { states: true });

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Lock probe',
      });
      origin = { gid: 'lock-probe', probeObjectId: probe.id };

      const sensors: number[] = [];
      for (let branch = 0; branch < BRANCHES; branch += 1) {
        const at = String(branch);
        const nodes: TreeNodeInput[] = [{ kind: 'group', name: `branch-${at}`, ref: 'top' }];
        for (let group = 0; group < GROUPS_PER_BRANCH; group += 1) {
          const g = `${at}-${String(group)}`;
          nodes.push({ kind: 'group', name: `group-${g}`, parentRef: 'top', ref: `g${g}` });
          for (let device = 0; device < DEVICES_PER_GROUP; device += 1) {
            const d = `${g}-${String(device)}`;
            nodes.push({
              kind: 'device',
              name: `device-${d}`,
              host: `10.${at}.${String(group)}.${String(device + 1)}`,
              parentRef: `g${g}`,
              ref: `d${d}`,
            });
            for (let sensor = 0; sensor < SENSORS_PER_DEVICE; sensor += 1) {
              nodes.push({
                kind: 'sensor',
                name: `ping-${d}-${String(sensor)}`,
                sensorType: 'icmp.ping',
                parentRef: `d${d}`,
              });
            }
          }
        }
        const made = await harness.service.createTree(testActor, { parentId: probe.id, nodes });
        sensors.push(...made.objects.filter((one) => one.kind === 'sensor').map((one) => one.id));
      }
      assert.equal(sensors.length, SENSORS);

      const first = sensors[0];
      assert.ok(first !== undefined);
      measured = first;
      const [next] = await db.query<{ id: string }>(
        `SELECT s.id::text AS id
         FROM object m
         JOIN object s ON s.parent_id = m.parent_id AND s.kind = 'sensor' AND s.id <> m.id
         WHERE m.id = $1
         ORDER BY s.id
         LIMIT 1`,
        [measured],
      );
      assert.ok(next !== undefined, 'the measured sensor has a sibling on its device');
      sibling = Number(next.id);
      // Both carry the channel the PATCHes write, declared with the sensor (`P-05`).
      const channels = await db.query<{ sensor_id: string }>(
        `SELECT sensor_id::text AS sensor_id FROM channel
         WHERE sensor_id = ANY($1::bigint[]) AND key = 'rtt'`,
        [[measured, sibling]],
      );
      assert.equal(channels.length, 2, 'both sensors have an rtt channel');

      // **Each PATCH writes its audit entry in its own transaction**, as production's sink does,
      // so the sensor is held for as long as an operator's PATCH holds it. Set after the build, so
      // the five thousand creates are not what the log is full of. Not the result-cache
      // invalidator: it makes the next batch re-read the sensor's channels and runtime, a real
      // cost of an edit but not a lock's, which would land in the row beside the loop on the
      // measured sensor and not in the sibling's, and be read as a wait.
      harness.audit.also = new DatabaseAuditSink();
      await db.query('ANALYZE');

      const [others] = await db.query<{ active: string; total: string }>(
        `SELECT count(*) FILTER (WHERE state <> 'idle')::text AS active, count(*)::text AS total
         FROM pg_stat_activity
         WHERE datname IS NOT NULL AND datname <> current_database()`,
      );
      conditions =
        `conditions: load ${loadavg()
          .map((one) => one.toFixed(2))
          .join(' / ')}, ${others?.total ?? '?'} client(s) of other databases, ` +
        `${others?.active ?? '?'} of them active`;
    });

    after(async () => {
      await scratch.drop();
    });

    it('measures what results and a foreign key check on a sensor wait for a channel PATCH of it', async () => {
      const states = harness.states;
      const dependencies = harness.dependencies;
      assert.ok(states !== undefined && dependencies !== undefined, 'built with states');

      // **Shared by every pipeline**, as one service holds them in production, so every phase
      // starts warm; **a new `Ingestor` per phase**, so its write timings are that phase's alone.
      // The resolver without the declared shapes production gives it: those are read only to
      // create a channel, and every channel here exists.
      const resolver = new ChannelResolver({ logger: silent });
      const ownership = new SensorOwnership();
      const pipeline = (): { service: IngestionService; ingestor: Ingestor } => {
        const ingestor = new Ingestor({
          db,
          logger: silent,
          // One row a write, so a batch is written as soon as it is offered: at the shipped size a
          // lone batch waits `batchMaxDelayMs` for company, and the flush timer is not under test.
          config: { ...SHIPPED, batchMaxRows: 1 },
          // As `main.ts` wires them (`M-11`, `P-415`). No alarm engine: no trigger exists, and an
          // armed alarm's lock is what the foreign key rows model. No housekeeper: a live write
          // reaches no compressed chunk and queues no backfill.
          dependencies,
          holds: states,
        });
        return {
          ingestor,
          service: new IngestionService({
            db,
            logger: silent,
            ingestor,
            resolver,
            ownership,
            states,
          }),
        };
      };

      // **Stamped now and sent now**, so every batch is live (`P-169`) and its write does all a
      // live one does; a millisecond apart at least, so no two readings share an instant.
      let offered = 0;
      let lastAt = Date.now();
      const offer = async (service: IngestionService): Promise<number> => {
        lastAt = Math.max(Date.now(), lastAt + 1);
        const at = new Date(lastAt).toISOString();
        offered += 1;
        const result: CheckResult = {
          sensorId: measured,
          at,
          outcome: 'ok',
          message: '',
          durationMs: 2,
          channels: [
            { key: 'rtt', value: 4 + (offered % 7) },
            { key: 'loss', value: 0 },
          ],
        };
        const started = process.hrtime.bigint();
        const reply = await service.acceptProbeResults(origin, {
          type: 'results',
          batchId: `lock-${String(offered)}`,
          sentAt: at,
          results: [result],
        });
        const ms = msSince(started);
        assert.equal(reply.type, 'results-ack', `batch ${String(offered)} was acknowledged`);
        return ms;
      };

      // The upper error limit flips between two values far above any reading, so every PATCH
      // changes the row, writes its entry and fires the trigger, and no reading is judged
      // differently for it.
      let flip = 0;
      const patch = async (sensorId: number): Promise<void> => {
        flip = 1 - flip;
        await harness.service.patchChannel(testActor, sensorId, 'rtt', {
          limits: { upperError: 1_000 + flip },
        });
      };

      /** PATCHes one sensor back to back until stopped; what each took, by when it ran. */
      const patching = (sensorId: number): { stop: () => Promise<readonly Span[]> } => {
        const spans: Span[] = [];
        // An object, so the loop reads what `stop` writes: a local the lint reads as always true.
        const state = { running: true };
        let failure: unknown;
        const loop = (async (): Promise<void> => {
          while (state.running) {
            const from = process.hrtime.bigint();
            await patch(sensorId);
            spans.push([from, process.hrtime.bigint()]);
          }
        })().catch((error: unknown) => {
          failure = error;
        });
        let stopped: Promise<readonly Span[]> | undefined;
        return {
          stop: () => {
            stopped ??= (async (): Promise<readonly Span[]> => {
              state.running = false;
              await within(PHASE_BOUND_MS, `the PATCH loop on sensor ${String(sensorId)}`, loop);
              if (failure !== undefined) {
                throw new Error('a channel PATCH in the loop failed', { cause: failure });
              }
              return spans;
            })();
            return stopped;
          },
        };
      };

      /** `work`, with the PATCH loop running on `against` throughout, or with nothing beside it. */
      const alongside = async <T>(
        against: number | null,
        work: () => Promise<T>,
      ): Promise<{ value: T; spans: readonly Span[] }> => {
        const loop = against === null ? null : patching(against);
        try {
          const value = await work();
          return { value, spans: loop === null ? [] : await loop.stop() };
        } finally {
          // Stopped on the way out whatever `work` did: a loop left running would go on writing
          // into the database `after` drops, and keep the file's process alive.
          if (loop !== null) await loop.stop();
        }
      };

      const results = async (label: string, against: number | null): Promise<Measured> => {
        const { value, spans } = await alongside(against, () =>
          within(
            PHASE_BOUND_MS,
            `the results row "${label}"`,
            (async () => {
              // Warmed through a pipeline of its own, so the `Ingestor` timed below counts the
              // measured writes and nothing else, and the loop is steady before the first of them.
              const warm = pipeline();
              for (let run = 0; run < WARMUP; run += 1) await offer(warm.service);
              await warm.ingestor.stop();
              const timed = pipeline();
              const ms: number[] = [];
              const from = process.hrtime.bigint();
              for (let run = 0; run < RUNS; run += 1) ms.push(await offer(timed.service));
              const to = process.hrtime.bigint();
              await timed.ingestor.stop();
              return { ms, from, to, stats: timed.ingestor.stats() };
            })(),
          ),
        );
        assert.equal(value.stats.writes, RUNS, `${label}: one write a batch`);
        assert.equal(value.stats.failedBatches, 0, `${label}: no write failed`);
        const tx = value.stats.writeMs;
        return {
          label,
          ms: spread(value.ms),
          write: { median: tx.p50, p95: tx.p95, max: tx.max },
          loop: against === null ? null : contention(spans, value.from, value.to),
        };
      };

      /**
       * The statement PostgreSQL's foreign key check runs on the row an INSERT references, in a
       * transaction of its own: what arming an alarm on the sensor, or creating a row of anything
       * else that references it, waits for.
       */
      const keyShare = async (label: string, against: number | null): Promise<Measured> => {
        const once = async (): Promise<number> => {
          const started = process.hrtime.bigint();
          await db.tx(async (q) => {
            await q.query('SELECT 1 FROM ONLY object x WHERE id = $1 FOR KEY SHARE OF x', [
              measured,
            ]);
          });
          return msSince(started);
        };
        const { value, spans } = await alongside(against, () =>
          within(
            PHASE_BOUND_MS,
            `the foreign key row "${label}"`,
            (async () => {
              for (let run = 0; run < WARMUP; run += 1) await once();
              const ms: number[] = [];
              const from = process.hrtime.bigint();
              for (let run = 0; run < RUNS; run += 1) ms.push(await once());
              return { ms, from, to: process.hrtime.bigint() };
            })(),
          ),
        );
        return {
          label,
          ms: spread(value.ms),
          write: null,
          loop: against === null ? null : contention(spans, value.from, value.to),
        };
      };

      // The first batch makes the sensor Up and fills every cache — channels, owner, state — so
      // what follows is the steady state, not the first minute after a restart.
      const first = pipeline();
      await offer(first.service);
      await first.ingestor.stop();

      const resultsAlone = await results('results, alone', null);
      const resultsBeside = await results('results, PATCH loop on it', measured);
      const resultsSibling = await results('results, PATCH loop on a sibling', sibling);

      const patchMs = await within(
        PHASE_BOUND_MS,
        'the channel PATCH alone',
        (async () => {
          for (let run = 0; run < WARMUP; run += 1) await patch(measured);
          const ms: number[] = [];
          for (let run = 0; run < RUNS; run += 1) {
            const started = process.hrtime.bigint();
            await patch(measured);
            ms.push(msSince(started));
          }
          return ms;
        })(),
      );
      const patchAlone: Measured = {
        label: 'channel PATCH, alone',
        ms: spread(patchMs),
        write: null,
        loop: null,
      };

      const keyAlone = await keyShare('FK check, alone', null);
      const keyBeside = await keyShare('FK check, PATCH loop on it', measured);
      const keySibling = await keyShare('FK check, PATCH loop on a sibling', sibling);

      const rows = [
        resultsAlone,
        resultsBeside,
        resultsSibling,
        patchAlone,
        keyAlone,
        keyBeside,
        keySibling,
      ];
      const cell = (ms: number): string => `${ms.toFixed(2).padStart(8)} ms`;
      const line = (row: Measured): string =>
        `      ${row.label.padEnd(34)}${cell(row.ms.median)}${cell(row.ms.p95)}${cell(row.ms.max)}` +
        (row.write === null
          ? ''
          : `   tx ${row.write.median.toFixed(2)} / ${row.write.p95.toFixed(2)} / ` +
            `${row.write.max.toFixed(2)} ms`) +
        (row.loop === null
          ? ''
          : `   ${String(row.loop.patches)} PATCHes, median ${row.loop.median.toFixed(2)} ms, ` +
            `in flight ${(row.loop.inFlight * 100).toFixed(0)}%`);
      const delta = (a: number, b: number): string =>
        `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(2)} ms`;
      process.stdout.write(
        `\n    measured, one sensor’s results and a foreign key check on it beside channel ` +
          `PATCHes of it, ${SENSORS.toLocaleString('en')} sensors, ${String(RUNS)} runs a row ` +
          `after ${String(WARMUP)} to warm:\n` +
          `      ${conditions}\n` +
          `      ${''.padEnd(34)}${'median'.padStart(11)}${'p95'.padStart(11)}` +
          `${'max'.padStart(11)}\n` +
          rows.map(line).join('\n') +
          `\n      waited on the lock (beside the loop on it, less beside the loop on a sibling):` +
          `\n        results   median ` +
          `${delta(resultsBeside.ms.median, resultsSibling.ms.median)}, ` +
          `p95 ${delta(resultsBeside.ms.p95, resultsSibling.ms.p95)}; ` +
          `its transaction median ${delta(
            resultsBeside.write?.median ?? Number.NaN,
            resultsSibling.write?.median ?? Number.NaN,
          )}, p95 ${delta(
            resultsBeside.write?.p95 ?? Number.NaN,
            resultsSibling.write?.p95 ?? Number.NaN,
          )}` +
          `\n        FK check  median ${delta(keyBeside.ms.median, keySibling.ms.median)}, ` +
          `p95 ${delta(keyBeside.ms.p95, keySibling.ms.p95)}  ` +
          `(what a FOR NO KEY UPDATE helper would save it; one PATCH alone takes ` +
          `${patchAlone.ms.median.toFixed(2)} ms median)\n`,
      );

      // **The readings landed**: every batch offered, one rtt reading each, is in the table. A
      // row whose writes were refused or dropped would be timing something cheaper than a write.
      const [stored] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sample
         WHERE channel_id = (SELECT id FROM channel WHERE sensor_id = $1 AND key = 'rtt')`,
        [measured],
      );
      assert.equal(Number(stored?.n), offered, 'every batch’s reading is in the table');

      // **And the contended rows were contended.** A loop that had stopped, or never started,
      // would leave them measuring the uncontended path under another name.
      for (const row of [resultsBeside, resultsSibling, keyBeside, keySibling]) {
        assert.ok(row.loop !== null, `${row.label}: the loop ran`);
        assert.ok(
          row.loop.inFlight >= MIN_IN_FLIGHT,
          `${row.label}: a PATCH was in flight for ${(row.loop.inFlight * 100).toFixed(0)}% of ` +
            `the window, under ${String(MIN_IN_FLIGHT * 100)}% is not a contended measurement`,
        );
      }

      for (const row of [resultsAlone, resultsBeside, resultsSibling]) {
        assert.ok(
          row.ms.p95 < RESULTS_P95_BUDGET_MS,
          `${row.label}: p95 ${row.ms.p95.toFixed(2)} ms, budget ` +
            `${String(RESULTS_P95_BUDGET_MS)} ms`,
        );
      }
      for (const row of [keyAlone, keyBeside, keySibling]) {
        assert.ok(
          row.ms.p95 < KEY_SHARE_P95_BUDGET_MS,
          `${row.label}: p95 ${row.ms.p95.toFixed(2)} ms, budget ` +
            `${String(KEY_SHARE_P95_BUDGET_MS)} ms`,
        );
      }
      assert.ok(
        patchAlone.ms.p95 < PATCH_P95_BUDGET_MS,
        `the channel PATCH: p95 ${patchAlone.ms.p95.toFixed(2)} ms, budget ` +
          `${String(PATCH_P95_BUDGET_MS)} ms`,
      );
    });
  },
);
