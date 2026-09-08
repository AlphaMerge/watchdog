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
    async function build(base: string, rootId: number, concurrency: number): Promise<number> {
      const label = 'probe';
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
    function bulkBody(probeId: number): Record<string, unknown> {
      const nodes = plan('probe-probe').map((item) => ({
        ...item.body,
        ref: item.key,
        // The probe is the request's own `parentId`; everything else names a node in the body.
        ...(item.parentKey === 'probe-probe' ? {} : { parentRef: item.parentKey }),
      }));
      return { parentId: probeId, nodes };
    }

    /** How many objects hang off the probe this build made. */
    async function treeSize(db: Database): Promise<number> {
      const rows = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM object
         WHERE id IN (
           WITH RECURSIVE t AS (
             SELECT id FROM object WHERE name = 'probe-probe'
             UNION ALL SELECT c.id FROM object c JOIN t ON c.parent_id = t.id
           ) SELECT id FROM t
         )`,
      );
      return Number(rows[0]?.count);
    }

    async function oneBulk(): Promise<{ ms: number; objects: number; channels: number }> {
      const f = await fixture();
      try {
        const probeId = await create(f.base, { kind: 'probe', name: 'probe-probe' }, f.rootId);
        const body = bulkBody(probeId);

        const startedAt = process.hrtime.bigint();
        const response = await fetch(`${f.base}/objects/tree`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        assert.equal(response.status, 201, text.slice(0, 500));

        const result = JSON.parse(text) as { count: number };
        assert.equal(result.count, TARGET_OBJECTS - 1, 'every node but the probe');

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
          `      (M-02) and a guard against a paused ancestor (M-08) — see P-19\n`,
      );

      assert.ok(
        serialMs < BUDGET_MS,
        `a serial build took ${(serialMs / 1_000).toFixed(1)} s against a ${String(BUDGET_MS / 1_000)} s budget`,
      );
    });
  },
);
