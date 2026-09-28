import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../../src/audit/store.js';
import { after, before, describe, it } from 'node:test';
import { AccessService, type AccessPrincipal } from '../../src/auth/access.js';
import { AccountService } from '../../src/auth/accounts.js';
import { GroupService } from '../../src/auth/groups.js';
import type { Database } from '../../src/db/pool.js';
import { AlarmService } from '../../src/state/alarms.js';
import { StateBroadcaster } from '../../src/state/stream.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { actorNamed, buildHarness, silent, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * What object visibility costs on the read paths, at the v1 target (`A-12`).
 *
 * **20,000 sensors**, the size the stream's snapshot is bounded at: four probes, a hundred
 * customer groups, twenty devices in each and ten sensors on each device. One sensor in twenty is
 * Down, so the alarm list has a thousand rows to page and count.
 *
 * Every read path is timed for six principals, chosen for the shapes the predicate has to
 * handle:
 *
 * - **an administrator** — the short circuit, and the baseline every other row is read against;
 * - **the root, with ten customers carved out** — the `NOT IN` form, over 2,000 hidden sensors;
 * - **one customer** — the `IN` form at its smallest, 200 sensors;
 * - **one probe** — the `IN` form over a quarter of the installation;
 * - **fifty customers**, granted one by one — the `IN` form seeded from fifty boundaries, which is
 *   where a walk started from a long list would show what it costs;
 * - **every probe** — the worst case there is: everything but the root, every object of it reached
 *   by walking, because the grants that make it visible are not on the root.
 *
 * The budgets are an operator's, not the machine's: a page of the tree or of the alarms, the
 * overview's totals and a resolution each well inside a quarter of a second, a full snapshot
 * inside two. The ratio to the administrator's time is what `docs/findings/` quotes.
 */
const PROBES = 4;
const GROUPS_PER_PROBE = 25;
const DEVICES_PER_GROUP = 20;
const SENSORS_PER_DEVICE = 10;
const SENSORS = PROBES * GROUPS_PER_PROBE * DEVICES_PER_GROUP * SENSORS_PER_DEVICE;

const WARMUP = 3;
const RUNS = 15;

const BUDGET_MS = { resolve: 50, list: 250, alarms: 250, counts: 250, snapshot: 2_000 } as const;

describe(
  `object visibility at ${SENSORS.toLocaleString('en')} sensors`,
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let access: AccessService;
    let alarms: AlarmService;
    let stream: StateBroadcaster;

    /** In the order they are reported; the administrator first, as the baseline. */
    const principals = new Map<string, AccessPrincipal>();

    before(async () => {
      scratch = await createScratchDatabase('visibility_perf');
      db = scratch.db;
      harness = await buildHarness(db);
      access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      alarms = new AlarmService({ db, logger: silent });
      stream = new StateBroadcaster({ logger: silent });
      const accounts = new AccountService({ db, logger: silent });
      const groups = new GroupService({ db, logger: silent });

      // ── the tree, a level per statement ──────────────────────────────────────────────────
      const probes = await db.query<{ id: string }>(
        `INSERT INTO object (parent_id, kind, name)
         SELECT $1, 'probe', 'probe-' || p FROM generate_series(1, $2) p
         RETURNING id::text AS id`,
        [harness.rootId, PROBES],
      );
      const customers = await db.query<{ id: string }>(
        `INSERT INTO object (parent_id, kind, name)
         SELECT pr.id, 'group', 'customer-' || pr.n || '-' || g
         FROM unnest($1::bigint[]) WITH ORDINALITY AS pr(id, n), generate_series(1, $2) g
         ORDER BY pr.n, g
         RETURNING id::text AS id`,
        [probes.map((row) => row.id), GROUPS_PER_PROBE],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'device', o.name || '-device-' || d
         FROM object o, generate_series(1, $1) d
         WHERE o.kind = 'group'`,
        [DEVICES_PER_GROUP],
      );
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT o.id, 'sensor', o.name || '-sensor-' || s
         FROM object o, generate_series(1, $1) s
         WHERE o.kind = 'device'`,
        [SENSORS_PER_DEVICE],
      );
      await db.query(
        `INSERT INTO sensor_config (object_id, type)
         SELECT id, 'icmp.ping' FROM object WHERE kind = 'sensor'`,
      );
      await db.query(
        `INSERT INTO sensor_runtime (object_id, state, message, since)
         SELECT id,
                (CASE WHEN id % 20 = 0 THEN 'down' ELSE 'up' END)::sensor_state_kind,
                CASE WHEN id % 20 = 0 THEN 'ETIMEDOUT after 4000 ms' ELSE 'OK' END,
                now() - (id % 600) * interval '1 minute'
         FROM object WHERE kind = 'sensor'
         -- A sensor's runtime row is created with the sensor; this gives each one a state.
         ON CONFLICT (object_id) DO UPDATE
           SET state = EXCLUDED.state, message = EXCLUDED.message, since = EXCLUDED.since`,
      );
      await db.query('ANALYZE');
      const counted = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM object WHERE kind = 'sensor'`,
      );
      assert.equal(counted[0]?.n, SENSORS);

      const probeIds = probes.map((row) => Number(row.id));
      const groupIds = customers.map((row) => Number(row.id));

      // ── the principals ───────────────────────────────────────────────────────────────────
      const principal = async (
        name: string,
        grants: readonly (readonly [number, 'read' | 'none'])[],
        admin = false,
      ): Promise<void> => {
        const login = name.replace(/[^a-z]+/g, '-');
        const account = await accounts.create({
          login,
          password: 'correct-horse-battery',
          role: admin ? 'admin' : 'readonly',
        });
        const group = admin
          ? (await groups.list()).find((one) => one.isAdmin)
          : await groups.create({ name: `${login} team` });
        assert.ok(group !== undefined);
        await groups.addMember(group.id, account.id);
        for (const [objectId, right] of grants) {
          await access.grant(objectId, group.id, right, actorNamed('perf'));
        }
        principals.set(name, { userId: account.id, role: admin ? 'admin' : 'readonly' });
      };

      await principal('administrator', [], true);
      await principal('root, ten carved out', [
        [harness.rootId, 'read'],
        ...groupIds.slice(0, 10).map((id) => [id, 'none'] as const),
      ]);
      await principal('one customer', [[groupIds[0] ?? 0, 'read']]);
      await principal('one probe', [[probeIds[0] ?? 0, 'read']]);
      await principal(
        'fifty customers',
        groupIds.slice(0, 50).map((id) => [id, 'read'] as const),
      );
      await principal(
        'every probe',
        probeIds.map((id) => [id, 'read'] as const),
      );
    });

    after(async () => {
      await scratch.drop();
    });

    /** Median and 90th percentile of `RUNS` timed calls, after `WARMUP` untimed ones. */
    async function time(run: () => Promise<unknown>): Promise<{ median: number; p90: number }> {
      for (let i = 0; i < WARMUP; i += 1) await run();
      const ms: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const started = process.hrtime.bigint();
        await run();
        ms.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      ms.sort((a, b) => a - b);
      return {
        median: ms[Math.floor(ms.length / 2)] ?? 0,
        p90: ms[Math.floor(ms.length * 0.9)] ?? 0,
      };
    }

    it('keeps every read path inside an operator’s budget, for every shape of grant', async () => {
      const rows: string[] = [];
      const over: string[] = [];
      const baseline = new Map<string, number>();

      for (const [name, principal] of principals) {
        const visibility = await access.visibilityFor(principal);
        const snapshot = await stream.snapshot(db, null, visibility);
        const page = await alarms.list({ limit: 100, visibility });
        const counts = await harness.service.visibleCounts(visibility);

        const measured: [string, { median: number; p90: number }, number, string][] = [
          ['resolve', await time(() => access.visibilityFor(principal)), BUDGET_MS.resolve, ''],
          [
            'list',
            // The tree's search: a first page of sensors by name, with `hasChildren` on each.
            await time(() =>
              harness.service.list(
                { kinds: ['sensor'] },
                { limit: 100, sort: 'name', cursor: null },
                visibility,
              ),
            ),
            BUDGET_MS.list,
            '',
          ],
          [
            'alarms',
            await time(() => alarms.list({ limit: 100, visibility })),
            BUDGET_MS.alarms,
            `${String(page.total)} alarms`,
          ],
          [
            'counts',
            await time(() => harness.service.visibleCounts(visibility)),
            BUDGET_MS.counts,
            `${String(counts.objects.sensor)} sensors`,
          ],
          [
            'snapshot',
            await time(() => stream.snapshot(db, null, visibility)),
            BUDGET_MS.snapshot,
            `${String(snapshot.entries.length)} sensors`,
          ],
        ];

        for (const [what, result, budget, note] of measured) {
          if (!baseline.has(what)) baseline.set(what, result.median);
          const ratio = result.median / Math.max(0.01, baseline.get(what) ?? result.median);
          rows.push(
            `    ${name.padEnd(21)} ${what.padEnd(8)}` +
              ` median ${result.median.toFixed(1).padStart(7)} ms` +
              `  p90 ${result.p90.toFixed(1).padStart(7)} ms` +
              `  ×${ratio.toFixed(2).padStart(5)} of admin` +
              (note === '' ? '' : `  (${note})`),
          );
          if (result.median > budget) {
            over.push(`${name} ${what}: ${result.median.toFixed(1)} ms > ${String(budget)} ms`);
          }
        }
      }

      process.stdout.write(`\n    measured (A-12), ${SENSORS.toLocaleString('en')} sensors:\n`);
      process.stdout.write(`${rows.join('\n')}\n`);
      assert.deepEqual(over, [], 'over budget');
    });
  },
);
