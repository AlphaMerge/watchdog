import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { ApiServer } from '../../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../../src/audit/store.js';
import type { Database } from '../../src/db/pool.js';
import { LoggingAuditSink } from '../../src/objects/audit.js';
import { ObjectRepository } from '../../src/objects/repository.js';
import { testCatalogue, testSensorTypes } from '../support/sensor-types.js';
import { ObjectService } from '../../src/objects/service.js';
import { InheritanceResolver } from '../../src/settings/inheritance.js';
import { HistoryService } from '../../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per CLAUDE.md, and the last unmeasured Phase 1 exit criterion:
 * **create a 5,000-object tree via the API in under 30 seconds** (`PLAN.md`).
 *
 * Over real HTTP against a listening server, not `inject`: "via the API" includes the socket, the
 * connection pooling and the JSON on the wire, and a measurement that quietly skipped those would
 * be answering an easier question than the one the criterion asks. Every write goes through the
 * routes, the service, the audit sink and the database exactly as production assembles them.
 */
const TARGET_OBJECTS = 5_000;
const BUDGET_MS = 30_000;

interface Create {
  kind: 'group' | 'device' | 'sensor';
  parentKey: string;
  key: string;
  body: Record<string, unknown>;
}

/**
 * A shape like a real installation's: a probe, a hundred groups, a few devices in each, three
 * sensors on each device. Truncated to exactly the target so the number in the criterion is the
 * number measured.
 */
function plan(probeKey: string): Create[] {
  const work: Create[] = [];
  const groups = 100;
  const devicesPerGroup = 13;
  const sensorsPerDevice = 3;

  for (let g = 0; g < groups; g += 1) {
    work.push({
      kind: 'group',
      parentKey: probeKey,
      key: `g${String(g)}`,
      body: { kind: 'group', name: `group-${String(g)}` },
    });
  }
  for (let g = 0; g < groups; g += 1) {
    for (let d = 0; d < devicesPerGroup; d += 1) {
      work.push({
        kind: 'device',
        parentKey: `g${String(g)}`,
        key: `d${String(g)}-${String(d)}`,
        body: {
          kind: 'device',
          name: `device-${String(g)}-${String(d)}`,
          host: `10.${String(g % 256)}.${String(d)}.1`,
        },
      });
    }
  }
  for (let g = 0; g < groups; g += 1) {
    for (let d = 0; d < devicesPerGroup; d += 1) {
      for (let s = 0; s < sensorsPerDevice; s += 1) {
        work.push({
          kind: 'sensor',
          parentKey: `d${String(g)}-${String(d)}`,
          key: `s${String(g)}-${String(d)}-${String(s)}`,
          body: {
            kind: 'sensor',
            name: `sensor-${String(g)}-${String(d)}-${String(s)}`,
            sensorType: 'icmp.ping',
          },
        });
      }
    }
  }

  // The probe itself is one of the five thousand.
  return work.slice(0, TARGET_OBJECTS - 1);
}

describe(
  'tree build performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    /**
     * Three samples, reported as median and range — `P-186`'s shape, for `P-193`'s reason.
     *
     * This case reported one number per variant, so its run-to-run variance had never been
     * measured, and three quiet runs reading 25.2 s, 26.0 s and 27.9 s could not be told apart
     * from a trend that means something. A budget with 7% of headroom left cannot be watched
     * with an unreplicated number.
     */
    const SAMPLES = 3;

    /**
     * **Each variant is built into its own empty database.** It used not to be: all three ran in
     * one scratch database in declaration order, so bulk built into an empty tree, serial into
     * one already holding 5,000 objects, and the concurrent pass into 10,000. That offset was the
     * same in every run, so it never produced the drift — but it did make the variants
     * incomparable *with each other*, which is exactly the comparison the numbers get used for.
     */
    interface Sample {
      bulkMs: number;
      serialMs: number;
      concurrentMs: number;
      objects: number;
      bulkObjects: number;
      channels: number;
    }

    interface Fixture {
      base: string;
      rootId: number;
      db: Database;
      close: () => Promise<void>;
    }

    /** A database, its migrations, the production wiring and a listening server. */
    async function fixture(): Promise<Fixture> {
      const scratch: ScratchDatabase = await createScratchDatabase('treebuild');
      const harness = await buildHarness(scratch.db);

      // The production wiring, audit sinks included: an install that writes no audit entries is
      // not the install anyone runs, and the write is inside every mutation's transaction.
      const service = new ObjectService({
        db: scratch.db,
        repository: new ObjectRepository(),
        resolver: new InheritanceResolver({ db: scratch.db, logger: silent }),
        audit: new CompositeAuditSink([new DatabaseAuditSink(), new LoggingAuditSink(silent)]),
        sensorTypes: testSensorTypes(),
        logger: silent,
      });

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
        service,
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', service);
      const address = await server.start();

      return {
        base: `http://127.0.0.1:${String(address.port)}/api/v1`,
        rootId: harness.rootId,
        db: scratch.db,
        close: async () => {
          await server.stop();
          await scratch.drop();
        },
      };
    }

    async function create(
      base: string,
      body: Record<string, unknown>,
      parentId: number,
    ): Promise<number> {
      const response = await fetch(`${base}/objects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, parentId }),
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      return (JSON.parse(text) as { id: number }).id;
    }

    /** Builds the plan level by level; within a level the requests are independent. */
    async function build(
      base: string,
      rootId: number,
      concurrency: number,
      label = 'probe',
    ): Promise<number> {
      const ids = new Map<string, number>();
      const probeId = await create(base, { kind: 'probe', name: `probe-${label}` }, rootId);
      ids.set(`probe-${label}`, probeId);

      const work = plan(`probe-${label}`);
      const startedAt = process.hrtime.bigint();

      for (const kind of ['group', 'device', 'sensor'] as const) {
        const level = work.filter((item) => item.kind === kind);
        for (let offset = 0; offset < level.length; offset += concurrency) {
          const slice = level.slice(offset, offset + concurrency);
          const created = await Promise.all(
            slice.map(async (item) => {
              const parentId = ids.get(item.parentKey);
              assert.ok(parentId, `no parent for ${item.key}`);
              return [item.key, await create(base, item.body, parentId)] as const;
            }),
          );
          for (const [key, id] of created) ids.set(key, id);
        }
      }

      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    }

    /** The same plan, as one `POST /objects/tree` body. */
    function bulkBody(probeId: number, label = 'probe'): Record<string, unknown> {
      const nodes = plan(`probe-${label}`).map((item) => ({
        ...item.body,
        ref: item.key,
        // The probe is the request's own `parentId`; everything else names a node in the body.
        ...(item.parentKey === `probe-${label}` ? {} : { parentRef: item.parentKey }),
      }));
      return { parentId: probeId, nodes };
    }

    /** One `POST /objects/tree` of 5,000 objects, timed. */
    async function bulkBuild(base: string, rootId: number, label = 'probe'): Promise<number> {
      const probeId = await create(base, { kind: 'probe', name: `probe-${label}` }, rootId);
      const body = bulkBody(probeId, label);

      const startedAt = process.hrtime.bigint();
      const response = await fetch(`${base}/objects/tree`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      assert.equal(response.status, 201, text.slice(0, 500));
      assert.equal(
        (JSON.parse(text) as { count: number }).count,
        TARGET_OBJECTS - 1,
        'every node but the probe',
      );
      return ms;
    }

    /** How many objects hang off the probe this build made. */
    async function treeSize(db: Database, label = 'probe'): Promise<number> {
      const rows = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM object
         WHERE id IN (
           WITH RECURSIVE t AS (
             SELECT id FROM object WHERE name = $1
             UNION ALL SELECT c.id FROM object c JOIN t ON c.parent_id = t.id
           ) SELECT id FROM t
         )`,
        [`probe-${label}`],
      );
      return Number(rows[0]?.count);
    }

    async function oneBulk(): Promise<{ ms: number; objects: number; channels: number }> {
      const f = await fixture();
      try {
        const ms = await bulkBuild(f.base, f.rootId);

        // The channels too: a bulk path that wrote the objects and forgot what makes a sensor
        // useful would be faster and worthless.
        const channels = await f.db.query<{ count: string }>(
          `SELECT count(*) AS count FROM channel c
           JOIN object o ON o.id = c.sensor_id WHERE o.name LIKE 'sensor-%'`,
        );
        return { ms, objects: await treeSize(f.db), channels: Number(channels[0]?.count) };
      } finally {
        await f.close();
      }
    }

    async function oneSerial(concurrency: number): Promise<{ ms: number; objects: number }> {
      const f = await fixture();
      try {
        const ms = await build(f.base, f.rootId, concurrency);
        return { ms, objects: await treeSize(f.db) };
      } finally {
        await f.close();
      }
    }

    const samples: Sample[] = [];

    before(async () => {
      for (let run = 0; run < SAMPLES; run += 1) {
        const bulk = await oneBulk();
        const serial = await oneSerial(1);
        const concurrent = await oneSerial(8);
        samples.push({
          bulkMs: bulk.ms,
          serialMs: serial.ms,
          concurrentMs: concurrent.ms,
          objects: serial.objects,
          bulkObjects: bulk.objects,
          channels: bulk.channels,
        });
      }
    });

    const median = (ms: readonly number[]): number =>
      [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 0;

    const report = (label: string, ms: readonly number[]): number => {
      const mid = median(ms);
      const spread = Math.max(...ms) - Math.min(...ms);
      process.stdout.write(
        `      ${label.padEnd(15)}${(mid / 1_000).toFixed(1).padStart(5)} s  ` +
          `${`${Math.round((TARGET_OBJECTS / mid) * 1_000).toLocaleString('en-GB')} objects/s`.padStart(18)}  ` +
          `${`${Math.round(((BUDGET_MS - mid) / BUDGET_MS) * 100).toString()}% spare`.padStart(10)}  ` +
          `[${ms.map((one) => (one / 1_000).toFixed(1)).join(', ')}] spread ` +
          `${(spread / 1_000).toFixed(1)} s\n`,
      );
      return mid;
    };

    it('creates the same tree in one request, which is what P-19 is for', () => {
      // **The measurement the ticket exists for**, over the same HTTP, against the same wiring,
      // building the same 5,000 objects. What changes is not how the tree is described but what
      // is paid to write it: one request, one transaction and one tree lock instead of five
      // thousand of each.
      for (const sample of samples) {
        assert.equal(sample.bulkObjects, TARGET_OBJECTS, 'the tree is the size claimed');
        assert.ok(sample.channels > 0, 'the sensors have channels');
      }

      process.stdout.write(
        `\n    measured, the same ${TARGET_OBJECTS.toLocaleString('en-GB')} objects in ` +
          `**one** request (P-19), ${String(SAMPLES)} samples:\n`,
      );
      const bulkMs = report(
        'bulk',
        samples.map((one) => one.bulkMs),
      );

      assert.ok(
        bulkMs < BUDGET_MS,
        `one request took ${(bulkMs / 1_000).toFixed(1)} s against a ${String(BUDGET_MS / 1_000)} s budget`,
      );
    });

    it('creates a 5,000-object tree through the API inside its budget', () => {
      for (const sample of samples) {
        assert.equal(sample.objects, TARGET_OBJECTS, 'the tree is the size claimed');
      }

      process.stdout.write(
        `\n    measured, ${TARGET_OBJECTS.toLocaleString('en-GB')} objects over HTTP ` +
          `(1 probe, 100 groups, 1,300 devices, the rest sensors), budget ` +
          `${String(BUDGET_MS / 1_000)} s, ${String(SAMPLES)} samples each into its own\n` +
          `    empty database (P-193 — they used to share one, so only bulk started from empty):\n`,
      );

      // Serial first, because that is what a provisioning script written the obvious way does,
      // and the criterion should be met without anyone having to be clever.
      const serialMs = report(
        'serial',
        samples.map((one) => one.serialMs),
      );
      // And then the way a client that knows about the shared tree lock would do it.
      report(
        '8 in flight',
        samples.map((one) => one.concurrentMs),
      );
      process.stdout.write(
        `      baseline after S-16 was 21.0 s; Phase 3 costs each create a sensor_runtime row\n` +
          `      (M-02) and a guard against a paused ancestor (M-08) — see P-19\n` +
          `      The spread above is WITHIN one run and understates the uncertainty. Four quiet\n` +
          `      runs on 2026-09-08 put the serial median at 20.9, 22.0, 23.2 and 25.7 s — a\n` +
          `      fifth of the number — while bulk moved 0.1 s and eight-in-flight 0.7 s. The\n` +
          `      noise scales with the round-trips, so only serial has much (P-194). Do not read\n` +
          `      a change smaller than a couple of seconds here as a change in the code.\n`,
      );

      assert.ok(
        serialMs < BUDGET_MS,
        `a serial build took ${(serialMs / 1_000).toFixed(1)} s against a ${String(BUDGET_MS / 1_000)} s budget`,
      );
    });

    /**
     * `P-194`: creating objects gets slower as the installation fills up, and the shape of that
     * was unknown — two points from two different runs.
     *
     * **The question this settles is which cost it is.** Both paths write the same 5,000 rows;
     * only one of them pays 5,000 requests, 5,000 transactions and 5,000 tree locks to do it. If
     * bulk slows down at the same rate as serial, the cost is per row — indexes, audit rows, dead
     * tuples, the planner — and the request path is innocent. If bulk stays flat while serial
     * climbs, it is per request.
     *
     * One sample per point rather than three: `P-193` measured the spread of these builds at
     * 0.6 s on 20.9 s, which is far below the third-of-a-build effect being looked for, and four
     * fill levels times two paths is already three minutes.
     */
    it('measures how the cost grows as the installation fills up (P-194)', async (t) => {
      // Off by default: three minutes, and the answer only changes when the write path does.
      if (process.env['MS_BENCH_FILL'] !== '1') {
        t.skip('set MS_BENCH_FILL=1 to run the fill-level sweep');
        return;
      }

      /** Trees of 5,000 already in the database before the measured build starts. */
      const FILLS = [0, 1, 2, 4];

      const measure = async (
        trees: number,
        run: (base: string, rootId: number) => Promise<number>,
      ): Promise<number> => {
        const f = await fixture();
        try {
          // Filled through the bulk path because it is ten times faster and `P-19` asserts the
          // rows it writes are the rows the serial path writes — the fill is state, not a
          // measurement, and how it got there must not matter.
          for (let tree = 0; tree < trees; tree += 1) {
            await bulkBuild(f.base, f.rootId, `fill${String(tree)}`);
          }
          return await run(f.base, f.rootId);
        } finally {
          await f.close();
        }
      };

      process.stdout.write(
        '\n    measured (P-194), the same 5,000-object build into a database already holding,\n' +
          '    ascending then descending so warm-up and fill can be told apart:\n' +
          `      ${'already there'.padEnd(16)}${'bulk up'.padStart(9)}${'bulk down'.padStart(11)}` +
          `${'serial up'.padStart(11)}${'serial down'.padStart(13)}\n`,
      );

      // Every point twice, once on the way up and once on the way down. Warm-up is monotonic in
      // *time*; a fill effect is monotonic in *fill*. Measuring each fill at two very different
      // points in the run is what separates them — the first attempt at this swept upwards only,
      // and produced a curve that went the wrong way because later is simply faster.
      const up = new Map<number, { bulk: number; serial: number }>();
      const down = new Map<number, { bulk: number; serial: number }>();

      for (const [pass, into] of [
        [FILLS, up],
        [[...FILLS].reverse(), down],
      ] as const) {
        for (const trees of pass) {
          const bulk = await measure(trees, (base, rootId) => bulkBuild(base, rootId));
          const serial = await measure(trees, (base, rootId) => build(base, rootId, 1));
          into.set(trees, { bulk, serial });
        }
      }

      const secs = (ms: number | undefined, width: number): string =>
        `${((ms ?? 0) / 1_000).toFixed(1)} s`.padStart(width);

      for (const trees of FILLS) {
        process.stdout.write(
          `      ${`${(trees * TARGET_OBJECTS).toLocaleString('en-GB')} objects`.padEnd(16)}` +
            secs(up.get(trees)?.bulk, 9) +
            secs(down.get(trees)?.bulk, 11) +
            secs(up.get(trees)?.serial, 11) +
            secs(down.get(trees)?.serial, 13) +
            '\n',
        );
      }

      process.stdout.write(
        '      A fill effect is a trend down each column that both columns agree on.\n' +
          '      Warm-up is "down" beating "up" at every fill, whatever the fill.\n',
      );
    });
  },
);
