import { strict as assert } from 'node:assert';
import type { QueryResultRow } from 'pg';
import { DatabaseAuditSink } from '../../src/audit/store.js';
import { after, before, describe, it } from 'node:test';
import { AccessService, type AccessPrincipal } from '../../src/auth/access.js';
import { AccountService } from '../../src/auth/accounts.js';
import { GroupService } from '../../src/auth/groups.js';
import type { Database, Queryable } from '../../src/db/pool.js';
import { AlarmService } from '../../src/state/alarms.js';
import { StateBroadcaster } from '../../src/state/stream.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { actorNamed, buildHarness, silent, type Harness, testActor } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * What object visibility costs on the read paths, at the v1 target (`A-12`).
 *
 * **20,000 sensors**, the size the stream's snapshot is bounded at: four probes, a hundred
 * customer groups, twenty devices in each and ten sensors on each device. One sensor in twenty is
 * Down, so the alarm list has a thousand rows to page and count.
 *
 * Every read path is timed for seven principals, chosen for the shapes the predicate has to
 * handle:
 *
 * - **an administrator** — the short circuit, and the baseline every other row is read against;
 * - **the root, with ten customers carved out** — the `NOT IN` form, over 2,000 hidden sensors;
 * - **the root, with four hundred devices carved out** — the `NOT IN` form walked from four
 *   hundred boundaries, forty of them re-opened by a grant on a sensor inside (`A-33`);
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

/** The principal `A-33` measures: several hundred carve-outs, some of them re-opened. */
const CARVED = 'root, 400 carved out';

/** One node of `EXPLAIN (FORMAT JSON)`, with only the fields read here named. */
interface PlanNode {
  readonly 'Subplan Name'?: string;
  readonly 'CTE Name'?: string;
  readonly Plans?: readonly PlanNode[];
  readonly [field: string]: unknown;
}

function* nodesOf(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* nodesOf(child);
}

/**
 * How each `NOT IN` over the visibility walk was planned: hashed once, or read again for every
 * row it filters (`A-33`).
 *
 * A walk is a subplan whose nodes scan the `exception` CTE. How it is used is printed where it
 * is referenced — `(hashed SubPlan 2)` or `(SubPlan 2)`, in PostgreSQL 16's form and in 17's
 * `ANY (x = (hashed SubPlan 2).col1)` — in a filter or a condition, or, for a walk in a select
 * list such as the alarm list's marking of each step, in the output a `VERBOSE` plan prints and
 * no other does. So the plan read here is a `VERBOSE` one, and a walk found referenced nowhere
 * is `unseen` rather than passed.
 */
function notInPlans(root: PlanNode): {
  walks: number;
  hashed: number;
  rescanned: number;
  unseen: number;
} {
  const walks = new Map<string, { hashed: boolean; rescanned: boolean }>();
  const references: string[] = [];
  for (const node of nodesOf(root)) {
    const name = /^SubPlan (\d+)$/.exec(node['Subplan Name'] ?? '')?.[1];
    if (name !== undefined && [...nodesOf(node)].some((one) => one['CTE Name'] === 'exception')) {
      walks.set(name, { hashed: false, rescanned: false });
    }
    for (const [field, value] of Object.entries(node)) {
      if (!/Filter|Cond|Output/.test(field)) continue;
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text === 'string') references.push(text);
      }
    }
  }
  for (const text of references) {
    for (const match of text.matchAll(/(hashed )?SubPlan (\d+)(?!\d)/g)) {
      const walk = walks.get(match[2] ?? '');
      if (walk === undefined) continue;
      if (match[1] === undefined) walk.rescanned = true;
      else walk.hashed = true;
    }
  }
  const all = [...walks.values()];
  return {
    walks: all.length,
    hashed: all.filter((walk) => walk.hashed && !walk.rescanned).length,
    rescanned: all.filter((walk) => walk.rescanned).length,
    unseen: all.filter((walk) => !walk.hashed && !walk.rescanned).length,
  };
}

/** How many walks of the carve-outs a statement's text holds. */
function walksIn(text: string): number {
  return [...text.matchAll(/NOT IN \(\s*WITH RECURSIVE exception/g)].length;
}

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
      const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });

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
        const account = await accounts.create(
          {
            login,
            password: 'correct-horse-battery',
            role: admin ? 'admin' : 'readonly',
          },
          testActor,
        );
        const group = admin
          ? (await groups.list()).find((one) => one.isAdmin)
          : await groups.create({ name: `${login} team` }, testActor);
        assert.ok(group !== undefined);
        await groups.addMember(group.id, account.id, testActor);
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
      // Every fifth device carved out, and the first sensor of every tenth of those re-opened:
      // four hundred holes spread over every customer, forty of them with a grant inside.
      const deviceIds = (
        await db.query<{ id: string }>(
          `SELECT id::text AS id FROM object WHERE kind = 'device' ORDER BY object.id`,
        )
      ).map((row) => Number(row.id));
      const carved = deviceIds.filter((_, index) => index % 5 === 0);
      const reopened = (
        await db.query<{ id: string }>(
          `SELECT DISTINCT ON (parent_id) id::text AS id FROM object
           WHERE parent_id = ANY($1::bigint[]) ORDER BY parent_id, object.id`,
          [carved.filter((_, index) => index % 10 === 0)],
        )
      ).map((row) => Number(row.id));
      assert.equal(carved.length, 400);
      assert.equal(reopened.length, 40);
      await principal(CARVED, [
        [harness.rootId, 'read'],
        ...carved.map((id) => [id, 'none'] as const),
        ...reopened.map((id) => [id, 'read'] as const),
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

    /**
     * The statements `run` sends through `db`, with their parameters, in order: on the pool, and
     * inside `db.tx`, which is where the alarm list reads.
     */
    async function recorded(
      run: () => Promise<unknown>,
    ): Promise<(readonly [string, readonly unknown[]])[]> {
      const statements: (readonly [string, readonly unknown[]])[] = [];
      const recording = (q: Queryable): void => {
        const query = q.query.bind(q);
        q.query = <T extends QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<T[]> => {
          statements.push([text, values ?? []]);
          return query<T>(text, values);
        };
      };
      const tx = db.tx.bind(db);
      recording(db);
      db.tx = <T>(fn: (q: Queryable) => Promise<T>): Promise<T> =>
        tx((q) => {
          recording(q);
          return fn(q);
        });
      try {
        await run();
      } finally {
        delete (db as { query?: unknown }).query;
        delete (db as { tx?: unknown }).tx;
      }
      return statements;
    }

    it('keeps every read path inside an operator’s budget, for every shape of grant', async () => {
      const rows: string[] = [];
      const over: string[] = [];
      const baseline = new Map<string, number>();

      for (const [name, principal] of principals) {
        const visibility = await access.visibilityFor(principal);
        const { snapshot } = await stream.snapshot(db, null, visibility);
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

    it('hashes the NOT IN of several hundred carve-outs on every read path (A-33)', async () => {
      // **The plan, not only the time.** PostgreSQL never turns `NOT IN` into an anti-join,
      // because of what it does with a null. It either hashes the subquery once, or, when it
      // expects the rows not to fit in `work_mem`, reads them again for every row it filters, which
      // is quadratic in the size of the tree. The table above would show that only as a time
      // that grew; this names it. `NOT EXISTS` would plan as an anti-join, and would read a null
      // column as visible where `NOT IN` reads it as hidden. The one nullable column the condition
      // is applied to, `tops`' `parent_id`, tests for null itself, so a switch would be safe, and
      // this is what says whether one is needed.
      const principal = principals.get(CARVED);
      assert.ok(principal !== undefined);
      const visibility = await access.visibilityFor(principal);
      const paths: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          'list',
          () =>
            harness.service.list(
              { kinds: ['sensor'] },
              { limit: 100, sort: 'name', cursor: null },
              visibility,
            ),
        ],
        ['alarms', () => alarms.list({ limit: 100, visibility })],
        ['counts', () => harness.service.visibleCounts(visibility)],
        ['snapshot', () => stream.snapshot(db, null, visibility)],
      ];
      // Each path by name, so that one path sending two statements cannot stand in for another
      // that sent none.
      const walked: (readonly [string, string, readonly unknown[]])[] = [];
      const silentPaths: string[] = [];
      for (const [name, run] of paths) {
        const own = (await recorded(run)).filter(([text]) => walksIn(text) > 0);
        if (own.length === 0) silentPaths.push(name);
        for (const [text, values] of own) walked.push([name, text, values]);
      }
      assert.deepEqual(silentPaths, [], 'a read path that sent no walk of the carve-outs');

      const rows: string[] = [];
      const unhashed: string[] = [];
      for (const [name, text, values] of walked) {
        const explained = await db.query<{
          'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[];
        }>(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${text}`, values);
        const result = explained[0]?.['QUERY PLAN'][0];
        assert.ok(result !== undefined);
        const { walks, hashed, rescanned, unseen } = notInPlans(result.Plan);
        rows.push(
          `    ${name.padEnd(10)}  walks ${String(walks)}  hashed ${String(hashed)}` +
            `  re-read ${String(rescanned)}  unseen ${String(unseen)}` +
            `  ${result['Execution Time'].toFixed(1).padStart(7)} ms`,
        );
        // Every walk the text holds is found in the plan, and every one found is hashed. Found
        // can be more than the text holds: a walk in an inlined CTE's select list is copied to
        // each place that reads the column, as the alarm list's step marking is to both of its
        // `FILTER (WHERE visible)`s.
        if (walks < walksIn(text) || hashed !== walks) unhashed.push(name);
      }
      process.stdout.write(`\n    the NOT IN plans (A-33), ${CARVED}:\n${rows.join('\n')}\n`);
      assert.deepEqual(unhashed, [], 'a NOT IN over the carve-outs that is not hashed');

      // Not vacuous: each statement, planned with too little memory to hash, is caught re-reading
      // at every walk — the alarm list's walk in its select list with the rest.
      const missed: string[] = [];
      for (const [name, text, values] of walked) {
        const starved = await db.transaction(async (client) => {
          await client.query(`SET LOCAL work_mem = '64kB'`);
          const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
            `EXPLAIN (VERBOSE, FORMAT JSON) ${text}`,
            [...values],
          );
          return result.rows[0]?.['QUERY PLAN'][0]?.Plan;
        });
        assert.ok(starved !== undefined);
        const { walks, rescanned } = notInPlans(starved);
        if (walks < walksIn(text) || rescanned !== walks) missed.push(name);
      }
      assert.deepEqual(missed, [], 'a starved plan not seen re-reading at every walk');
    });
  },
);
