import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
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
    let scratch: ScratchDatabase;
    let db: Database;
    let server: ApiServer;
    let base: string;
    let rootId: number;

    before(async () => {
      scratch = await createScratchDatabase('treebuild');
      db = scratch.db;
      const harness = await buildHarness(db);
      rootId = harness.rootId;

      // The production wiring, audit sinks included: an install that writes no audit entries is
      // not the install anyone runs, and the write is inside every mutation's transaction.
      const service = new ObjectService({
        db,
        repository: new ObjectRepository(),
        resolver: new InheritanceResolver({ db, logger: silent }),
        audit: new CompositeAuditSink([new DatabaseAuditSink(), new LoggingAuditSink(silent)]),
        sensorTypes: testSensorTypes(),
        logger: silent,
      });

      server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', service);
      const address = await server.start();
      base = `http://127.0.0.1:${String(address.port)}/api/v1`;
    });

    after(async () => {
      await server.stop();
      await scratch.drop();
    });

    async function create(body: Record<string, unknown>, parentId: number): Promise<number> {
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
    async function build(label: string, concurrency: number): Promise<number> {
      const ids = new Map<string, number>();
      const probeId = await create({ kind: 'probe', name: `probe-${label}` }, rootId);
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
              return [item.key, await create(item.body, parentId)] as const;
            }),
          );
          for (const [key, id] of created) ids.set(key, id);
        }
      }

      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    }

    it('creates a 5,000-object tree through the API inside its budget', async () => {
      // Serial first, because that is what a provisioning script written the obvious way does,
      // and the criterion should be met without anyone having to be clever.
      const serialMs = await build('serial', 1);

      const built = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM object
         WHERE id IN (
           WITH RECURSIVE t AS (
             SELECT id FROM object WHERE name = 'probe-serial'
             UNION ALL SELECT c.id FROM object c JOIN t ON c.parent_id = t.id
           ) SELECT id FROM t
         )`,
      );
      assert.equal(Number(built[0]?.count), TARGET_OBJECTS, 'the tree is the size claimed');

      // And then the way a client that knows about the shared tree lock would do it.
      const concurrentMs = await build('concurrent', 8);

      const rate = (ms: number): string =>
        `${Math.round((TARGET_OBJECTS / ms) * 1_000).toLocaleString('en-GB')} objects/s`;

      const headroom = (ms: number): string =>
        `${Math.round(((BUDGET_MS - ms) / BUDGET_MS) * 100).toString()}% spare`;

      process.stdout.write(
        `\n    measured, ${TARGET_OBJECTS.toLocaleString('en-GB')} objects over HTTP ` +
          `(1 probe, 100 groups, 1,300 devices, the rest sensors), budget ` +
          `${String(BUDGET_MS / 1_000)} s:\n` +
          `      serial          ${(serialMs / 1_000).toFixed(1).padStart(5)} s  ` +
          `${rate(serialMs).padStart(18)}  ${headroom(serialMs).padStart(10)}\n` +
          `      8 in flight     ${(concurrentMs / 1_000).toFixed(1).padStart(5)} s  ` +
          `${rate(concurrentMs).padStart(18)}  ${headroom(concurrentMs).padStart(10)}\n` +
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
