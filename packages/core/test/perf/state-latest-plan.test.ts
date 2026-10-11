import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../../src/db/migrator.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import type { Database } from '../../src/db/pool.js';
import { NEWEST_STATES } from '../../src/state/runtime.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from '../support/database.js';

const available = await databaseAvailable();

/**
 * Each sensor's newest state row, keyed by the text alias or by the column (`P-388`).
 *
 * `orderedAfterLast` (`state/runtime.ts`) and `stateAtHorizon` (`timeseries/store.ts`) wrote
 * `DISTINCT ON (sensor_id) sensor_id::text AS sensor_id … ORDER BY sensor_id, time DESC`. A bare
 * name in `DISTINCT ON` and `ORDER BY` is the output column first, so both sorted the text: the
 * answer is the same, since a text id and a number are one to one, but nothing about
 * `(sensor_id::text, time)` is an index PostgreSQL has. Each is asked here in both forms, at the
 * v1 target of 5,000 sensors, and the plans and times are printed for `docs/findings/`.
 *
 * `orderedAfterLast` is now the third form, `lateral`: each sensor's newest row read backwards from
 * the index on its own, rather than every row of every sensor asked about and then the newest of
 * each. `stateAtHorizon` is still the first form: qualified, it skips its sort, but it read over a
 * hundred times the blocks, in the chunks a retention pass is about to drop
 * (`docs/findings/2026-10-11-state-latest-plan.md`).
 *
 * The SQL is held here rather than called through the two functions, so the forms replaced can
 * still be measured beside what replaced them.
 */
const SENSORS = 5_000;
/** Transitions per sensor, three days apart: 120 days, about eighteen weekly chunks. */
const ROWS_PER_SENSOR = 40;
const RUNS = 7;
/** The lateral form's reads for one sensor: the newest chunk's index and heap, measured as 3. */
const BLOCKS_PER_SENSOR = 4;
const NOW = new Date('2026-10-01T00:00:00.000Z');

const LATEST = {
  alias: `SELECT DISTINCT ON (sensor_id) sensor_id::text AS sensor_id, time, state, cause
          FROM sensor_state WHERE sensor_id = ANY($1::bigint[])
          ORDER BY sensor_id, time DESC`,
  column: `SELECT DISTINCT ON (sensor_state.sensor_id) sensor_id::text AS sensor_id, time, state,
                  cause
           FROM sensor_state WHERE sensor_id = ANY($1::bigint[])
           ORDER BY sensor_state.sensor_id, time DESC`,
  // What `orderedAfterLast` runs, imported rather than copied.
  lateral: NEWEST_STATES,
};

const AT_HORIZON = {
  alias: `SELECT DISTINCT ON (sensor_id) sensor_id::text AS sensor_id, state::text AS state,
                 cause::text AS cause
          FROM sensor_state
          WHERE time < $1
          ORDER BY sensor_id, time DESC`,
  column: `SELECT DISTINCT ON (sensor_state.sensor_id) sensor_id::text AS sensor_id,
                  state::text AS state, cause::text AS cause
           FROM sensor_state
           WHERE time < $1
           ORDER BY sensor_state.sensor_id, time DESC`,
};

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Sort Method'?: string;
  'Sort Key'?: string[];
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

interface Explained {
  Plan: PlanNode;
  'Execution Time': number;
}

/** The plan's nodes, depth first, as `Type(index)` or `Sort[key; method]`, children deduplicated. */
function shape(node: PlanNode): string {
  const own =
    node['Node Type'] === 'Sort'
      ? `Sort[${(node['Sort Key'] ?? []).join(', ')}; ${node['Sort Method'] ?? '?'}]`
      : node['Index Name'] === undefined
        ? node['Node Type']
        : `${node['Node Type']}(${node['Index Name'].replace(/^_hyper_\d+_\d+_chunk_/, '')})`;
  const children = [...new Set((node.Plans ?? []).map(shape))];
  if (children.length === 0) return own;
  const many = (node.Plans ?? []).length;
  return `${own} > ${many > 1 ? `${String(many)}× ` : ''}${children.join(' | ')}`;
}

function sorts(node: PlanNode): number {
  return (
    (node['Node Type'] === 'Sort' ? 1 : 0) +
    (node.Plans ?? []).reduce((sum, child) => sum + sorts(child), 0)
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe(
  'each sensor’s newest state, by the text alias or by the column (P-388)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('statelatest');
      db = scratch.db;
      await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
      await db.query(
        `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
         SELECT $1::timestamptz - n * interval '3 days' - s * interval '1 second',
                s,
                (CASE WHEN n % 2 = 0 THEN 'up' ELSE 'down' END)::sensor_state_kind,
                (CASE WHEN n % 2 = 0 THEN 'down' ELSE 'up' END)::sensor_state_kind,
                'scan',
                ''
         FROM generate_series(1, $2::int) AS s, generate_series(0, $3::int - 1) AS n`,
        [NOW, SENSORS, ROWS_PER_SENSOR],
      );
      await db.query('ANALYZE sensor_state');
    });

    after(async () => {
      await scratch.drop();
    });

    async function measure(
      label: string,
      forms: Readonly<Record<string, string>>,
      values: unknown[],
    ): Promise<Map<string, { sorts: number; blocks: number }>> {
      const answers = new Map<string, string>();
      const seen = new Map<string, { sorts: number; blocks: number }>();
      const lines: string[] = [];
      for (const [form, sql] of Object.entries(forms)) {
        const rows = await db.query<{ sensor_id: string; state: string }>(sql, values);
        answers.set(
          form,
          JSON.stringify(
            rows
              .map((row) => [row.sensor_id, row.state])
              .sort((a, b) => Number(a[0]) - Number(b[0])),
          ),
        );
        const times: number[] = [];
        let last: Explained | undefined;
        for (let run = 0; run < RUNS; run += 1) {
          const explained = await db.query<{ 'QUERY PLAN': Explained[] }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
            values,
          );
          last = explained[0]?.['QUERY PLAN'][0];
          assert.ok(last !== undefined, 'EXPLAIN answered nothing');
          times.push(last['Execution Time']);
        }
        assert.ok(last !== undefined);
        const blocks =
          (last.Plan['Shared Hit Blocks'] ?? 0) + (last.Plan['Shared Read Blocks'] ?? 0);
        seen.set(form, { sorts: sorts(last.Plan), blocks });
        lines.push(
          `  ${form.padEnd(7)} ${median(times).toFixed(2).padStart(9)} ms median of ` +
            `${String(RUNS)} (${Math.min(...times).toFixed(2)}–${Math.max(...times).toFixed(2)}), ` +
            `${String(blocks)} blocks, ${String(rows.length)} rows, ${String(sorts(last.Plan))} sort(s)\n` +
            `         ${shape(last.Plan)}\n`,
        );
      }
      for (const [form, answer] of answers) {
        assert.equal(answer, answers.get('alias'), `${label}: ${form} gives the same answer`);
      }
      process.stdout.write(`\n${label}\n${lines.join('')}`);
      return seen;
    }

    it('orderedAfterLast for one sensor, fifty, and all five thousand', async () => {
      const ids = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
      for (const count of [1, 50, SENSORS]) {
        const seen = await measure(
          `orderedAfterLast, ${String(count)} sensor${count === 1 ? '' : 's'}`,
          LATEST,
          [ids(count)],
        );
        // What the code runs now: no sort, and a few blocks for each sensor asked about, however
        // long its history. Plan shapes and block counts, not times, so a loaded machine cannot
        // fail it. Not "fewer than the form it replaced": at 5,000 sensors that form's
        // sequential scan read fewer blocks, and then sorted every row it read.
        const now = seen.get('lateral');
        assert.ok(now !== undefined);
        assert.equal(now.sorts, 0, `${String(count)}: the lateral form sorted`);
        assert.ok(
          now.blocks <= BLOCKS_PER_SENSOR * count,
          `${String(count)}: ${String(now.blocks)} blocks, more than ` +
            `${String(BLOCKS_PER_SENSOR)} for each sensor`,
        );
      }
    });

    it('stateAtHorizon at ninety days, which reaches every sensor', async () => {
      const horizon = new Date(NOW.getTime() - 90 * 86_400_000);
      await measure('stateAtHorizon, 90 days', AT_HORIZON, [horizon]);
    });
  },
);
