import { strict as assert } from 'node:assert';
import { loadavg } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { DatabaseAuditSink } from '../../src/audit/store.js';
import type { Database } from '../../src/db/pool.js';
import { coreCatalogue } from '../../src/profile.js';
import { declaredChannelLookup } from '../../src/state/declared-limits.js';
import {
  repairDeclaredPrimaries,
  type DeclaredPrimaryRepairReport,
} from '../../src/state/declared-primary.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * What the declared-primary repair (`P-323`) costs a start, at the v1 target (`P-332`).
 *
 * The pass runs on every start, not awaited, and reads every sensor: a page of 500 `sensor_config`
 * rows, each sensor's type run on its stored parameters for its declared primary, and one query
 * for the rows that would move. Only a page with something to move takes a transaction. So the
 * per-start cost of an installation that has been repaired once is the read-only sweep, measured
 * here, and the first start after an upgrade adds the moves, measured with a tenth of the
 * sensors' primaries left where an earlier build put them. The two halves of a page, the type's
 * code and the SQL, are timed apart, so the finding can say where the time goes.
 *
 * 5,000 sensors and 15,000 channels: a thousand each of five shipped types whose declarations
 * hold 1 to 5 channels, so 3 a sensor, with every declared channel's row. Times depend on the
 * machine and are printed for `docs/findings/`; what is asserted is what the pass did.
 */
const TYPES = ['port.tcp', 'icmp.ping', 'snmp.cpu', 'snmp.traffic', 'http.request'] as const;
const PER_TYPE = 1_000;
const SENSORS = TYPES.length * PER_TYPE;
const CHANNELS = 15_000;
const DEVICES = 50;
/** One sensor in this many has its primary on another channel, as before `P-314`. */
const STALE_EVERY = 10;
const RUNS = 5;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function range(values: readonly number[]): string {
  return `${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)}`;
}

describe(
  `the declared-primary repair at ${SENSORS.toLocaleString('en')} sensors (P-332)`,
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    const catalogue = coreCatalogue('v1');
    const declared = declaredChannelLookup(catalogue);
    const lines: string[] = [];

    const repair = (): Promise<DeclaredPrimaryRepairReport> =>
      repairDeclaredPrimaries({
        db,
        logger: silentLogger,
        catalogue,
        audit: new DatabaseAuditSink(),
      });

    /** Sensors whose primary is not the one their type declares, or who have none. */
    async function misplaced(): Promise<number> {
      const rows = await db.query<{ type: string; key: string | null }>(
        `SELECT sc.type, c.key
         FROM sensor_config sc
         LEFT JOIN channel c ON c.sensor_id = sc.object_id AND c.is_primary`,
      );
      return rows.filter((row) => row.key !== declared(row.type, {}, 0).primary).length;
    }

    before(async () => {
      scratch = await createScratchDatabase('primary_perf');
      db = scratch.db;
      const harness = await buildHarness(db, { catalogue });

      const [probe] = await db.query<{ id: string }>(
        `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'probe')
         RETURNING id::text AS id`,
        [harness.rootId],
      );
      assert.ok(probe !== undefined);
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT $1, 'device', 'device-' || d FROM generate_series(1, $2) d`,
        [probe.id, DEVICES],
      );
      // The types in turn down the devices, so every page of 500 holds all five.
      await db.query(
        `INSERT INTO object (parent_id, kind, name)
         SELECT d.id, 'sensor', d.name || '-sensor-' || s
         FROM object d, generate_series(1, $1) s
         WHERE d.kind = 'device'
         ORDER BY d.id, s`,
        [SENSORS / DEVICES],
      );
      await db.query(
        `INSERT INTO sensor_config (object_id, type, params)
         SELECT id, ($1::text[])[1 + (row_number() OVER (ORDER BY id) - 1) % $2], '{}'::jsonb
         FROM object WHERE kind = 'sensor'`,
        [TYPES, TYPES.length],
      );

      // Every channel each type declares, the declared primary primary: a repaired installation.
      const types: string[] = [];
      const keys: string[] = [];
      const primaries: boolean[] = [];
      for (const type of TYPES) {
        const answer = declared(type, {}, 0);
        assert.ok(answer.primary !== null, `${type} declares a primary for {}`);
        for (const key of answer.shapes.keys()) {
          types.push(type);
          keys.push(key);
          primaries.push(key === answer.primary);
        }
      }
      await db.query(
        `INSERT INTO channel (sensor_id, key, name, is_primary)
         SELECT sc.object_id, d.key, d.key, d.is_primary
         FROM sensor_config sc
         JOIN unnest($1::text[], $2::text[], $3::boolean[]) AS d(type, key, is_primary)
           ON d.type = sc.type`,
        [types, keys, primaries],
      );
      const [counts] = await db.query<{ sensors: string; channels: string }>(
        `SELECT (SELECT count(*) FROM sensor_config)::text AS sensors,
                (SELECT count(*) FROM channel)::text AS channels`,
      );
      assert.equal(Number(counts?.sensors), SENSORS);
      assert.equal(Number(counts?.channels), CHANNELS);
      await db.query('ANALYZE object, sensor_config, channel');

      const [others] = await db.query<{ active: string; total: string }>(
        `SELECT count(*) FILTER (WHERE state <> 'idle')::text AS active, count(*)::text AS total
         FROM pg_stat_activity
         WHERE datname IS NOT NULL AND datname <> current_database()`,
      );
      lines.push(
        `conditions: load ${loadavg()
          .map((one) => one.toFixed(2))
          .join(' / ')}, ${others?.total ?? '?'} client(s) of other databases, ` +
          `${others?.active ?? '?'} of them active`,
      );
    });

    after(async () => {
      process.stdout.write(`\n${lines.join('\n')}\n`);
      await scratch.drop();
    });

    it('moves a tenth of the primaries on the first start after an upgrade', async () => {
      // As a build before `P-314` left them: the primary on another of the sensor's channels, or
      // on none where the type declares only one.
      await db.query(
        `UPDATE channel SET is_primary = false
         WHERE is_primary AND sensor_id % $1 = 0`,
        [STALE_EVERY],
      );
      await db.query(
        `UPDATE channel c SET is_primary = true
         FROM (SELECT DISTINCT ON (sensor_id) id FROM channel
               WHERE sensor_id % $1 = 0 AND NOT is_primary
                 AND key <> ALL($2::text[])
               ORDER BY sensor_id, key) other
         WHERE c.id = other.id`,
        [
          STALE_EVERY,
          TYPES.map((type) => declared(type, {}, 0).primary).filter((key) => key !== null),
        ],
      );
      const stale = await misplaced();
      assert.equal(stale, SENSORS / STALE_EVERY, 'a tenth start misplaced');

      const started = process.hrtime.bigint();
      const report = await repair();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;

      assert.equal(report.sensors, SENSORS);
      assert.equal(report.moved, stale);
      assert.equal(report.skipped, 0);
      assert.equal(report.failedPages, 0);
      assert.equal(report.complete, true);
      assert.equal(await misplaced(), 0, 'and every primary is the declared one after');
      const [audited] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
         WHERE actor_kind = 'system' AND actor_ref = 'declared-primary-startup-repair'`,
      );
      lines.push(
        `first start, ${String(stale)} of ${String(SENSORS)} sensors to move: ${ms.toFixed(0)} ms, ` +
          `${String(report.moved)} moved, ${audited?.n ?? '?'} audit entries`,
      );
    });

    it('costs every later start one read-only sweep, and moves nothing', async () => {
      const times: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = process.hrtime.bigint();
        const report = await repair();
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.equal(report.sensors, SENSORS);
        assert.equal(report.moved, 0, 'an idempotent pass moves nothing the second time');
        assert.equal(report.complete, true);
      }
      lines.push(
        `every later start: ${median(times).toFixed(0)} ms median of ${String(RUNS)} ` +
          `(${range(times)}) for ${String(SENSORS)} sensors, ${String(SENSORS / 500)} pages`,
      );
    });

    it('spends it on the SQL and the types’ code, timed apart', async () => {
      // The two halves of a page, done as the pass does them, without the pass around them.
      const sql: number[] = [];
      const code: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        let after = '0';
        let sqlMs = 0;
        let codeMs = 0;
        for (;;) {
          let at = process.hrtime.bigint();
          const page = await db.query<{ id: string; type: string; params: unknown }>(
            `SELECT object_id::text AS id, type, params FROM sensor_config
             WHERE object_id > $1::bigint ORDER BY object_id LIMIT 500`,
            [after],
          );
          sqlMs += Number(process.hrtime.bigint() - at) / 1e6;
          const last = page.at(-1);
          if (last === undefined) break;
          after = last.id;

          at = process.hrtime.bigint();
          const wanted = page.flatMap((row) => {
            const primary = declared(
              row.type,
              (row.params ?? {}) as Record<string, unknown>,
              Number(row.id),
            ).primary;
            return primary === null ? [] : [{ id: row.id, key: primary }];
          });
          codeMs += Number(process.hrtime.bigint() - at) / 1e6;

          at = process.hrtime.bigint();
          await db.query(
            `SELECT c.sensor_id::text AS sensor_id, c.key
             FROM channel c
             JOIN unnest($1::bigint[], $2::text[]) AS w(sensor_id, key)
               ON w.sensor_id = c.sensor_id AND w.key = c.key
             WHERE NOT c.is_primary
             ORDER BY c.sensor_id`,
            [wanted.map((one) => one.id), wanted.map((one) => one.key)],
          );
          sqlMs += Number(process.hrtime.bigint() - at) / 1e6;
        }
        sql.push(sqlMs);
        code.push(codeMs);
      }
      lines.push(
        `of which, per sweep: SQL ${median(sql).toFixed(0)} ms (${range(sql)}), ` +
          `the types' declarations ${median(code).toFixed(0)} ms (${range(code)})`,
      );
      assert.ok(sql.every(Number.isFinite) && code.every(Number.isFinite));
    });
  },
);
