import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { MIGRATION_LOCK_KEY, Migrator, MigrationError, type LockWait } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import type { Migration } from '../src/db/migrations/types.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';

const available = await databaseAvailable();

const trivial: Migration = {
  id: 9001,
  name: 'trivial',
  up: 'CREATE TABLE trivial_thing (id int PRIMARY KEY)',
  down: 'DROP TABLE trivial_thing',
};

const second: Migration = {
  id: 9002,
  name: 'second',
  up: 'CREATE TABLE second_thing (id int PRIMARY KEY)',
  down: 'DROP TABLE second_thing',
};

function migrator(db: Database, migrations: readonly Migration[]): Migrator {
  return new Migrator({ db, logger: silentLogger, migrations });
}

async function tableExists(db: Database, name: string): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [
    name,
  ]);
  return rows[0]?.exists ?? false;
}

describe(
  'Migrator',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('migrator');
    });

    after(async () => {
      await scratch.drop();
    });

    it('reports everything pending on an empty database', async () => {
      const status = await migrator(scratch.db, [trivial, second]).status();

      assert.equal(status.applied.length, 0);
      assert.deepEqual(
        status.pending.map((m) => m.id),
        [9001, 9002],
      );
      assert.deepEqual(status.drifted, []);
      assert.deepEqual(status.unknown, []);
    });

    it('applies pending migrations in order and records them', async () => {
      const m = migrator(scratch.db, [trivial, second]);
      const { applied } = await m.up();

      assert.deepEqual(
        applied.map((x) => x.id),
        [9001, 9002],
      );
      assert.equal(await tableExists(scratch.db, 'trivial_thing'), true);
      assert.equal(await tableExists(scratch.db, 'second_thing'), true);

      const status = await m.status();
      assert.equal(status.pending.length, 0);
      assert.equal(status.applied.length, 2);
      assert.ok(status.applied[0]?.appliedAt instanceof Date);
    });

    it('is idempotent — a second run applies nothing', async () => {
      const { applied } = await migrator(scratch.db, [trivial, second]).up();
      assert.deepEqual(applied, []);
    });

    it('rolls back the most recent migration', async () => {
      const m = migrator(scratch.db, [trivial, second]);
      const { reverted } = await m.down();

      assert.deepEqual(
        reverted.map((x) => x.id),
        [9002],
        'rollback goes newest first',
      );
      assert.equal(await tableExists(scratch.db, 'second_thing'), false);
      assert.equal(await tableExists(scratch.db, 'trivial_thing'), true, 'and stops there');

      await m.up();
    });

    it('refuses to run when an applied migration has been edited', async () => {
      const edited: Migration = { ...trivial, up: 'CREATE TABLE trivial_thing (id bigint)' };
      const m = migrator(scratch.db, [edited, second]);

      const status = await m.status();
      assert.equal(status.drifted.length, 1);
      assert.equal(status.drifted[0]?.id, 9001);

      await assert.rejects(() => m.up(), MigrationError);
      await assert.rejects(() => m.down(), MigrationError);
    });

    it('names the edited migration and both checksums, in the refusal and the log (P-238)', async () => {
      // A refused start prints the message and nothing else. Without the name, a development core
      // restarted about 470 times before anyone could say which migration it meant.
      const lines: Record<string, unknown>[] = [];
      const logger = pino(
        { level: 'info' },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      ) as unknown as Logger;
      const edited: Migration = { ...trivial, up: 'CREATE TABLE trivial_thing (id bigint)' };
      const m = new Migrator({ db: scratch.db, logger, migrations: [edited, second] });
      const [drift] = (await m.status()).drifted;
      assert.ok(drift !== undefined);
      assert.notEqual(drift.appliedChecksum, drift.currentChecksum);
      const named = `9001 trivial (applied ${drift.appliedChecksum}, this build ${drift.currentChecksum})`;

      for (const run of [() => m.up(), () => m.down()]) {
        await assert.rejects(
          run,
          (error: unknown) =>
            error instanceof MigrationError &&
            error.refusal &&
            error.message.endsWith(`disagree about the schema: ${named}`),
        );
      }
      const logged = lines.filter((line) => line['level'] === 50);
      assert.equal(logged.length, 2, 'one error line per refusal');
      assert.deepEqual(logged[0]?.['drifted'], [
        {
          id: 9001,
          name: 'trivial',
          appliedChecksum: drift.appliedChecksum,
          currentChecksum: drift.currentChecksum,
        },
      ]);
    });

    it('refuses to migrate a database that is newer than this build', async () => {
      // The operator downgraded ms-core, or a newer core in a pair started first.
      const olderBuild = migrator(scratch.db, [trivial]);

      const status = await olderBuild.status();
      assert.deepEqual(
        status.unknown.map((row) => row.id),
        [9002],
      );

      await assert.rejects(
        () => olderBuild.up(),
        (error: unknown) =>
          error instanceof MigrationError &&
          /newer than this build/.test(error.message) &&
          // Which, as `refuseSchema` says it with `autoMigrate` off (`P-238`).
          error.message.includes('1 migration(s) this build does not define (newest: 9002 second)'),
      );
    });

    it('reports which migration failed, with context', async () => {
      const broken: Migration = {
        id: 9003,
        name: 'broken',
        up: 'CREATE TABLE nonsense (id int) WITH (this_option_does_not_exist = 1)',
        down: 'DROP TABLE nonsense',
      };

      await assert.rejects(
        () => migrator(scratch.db, [trivial, second, broken]).up(),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError);
          assert.match(error.message, /9003/);
          assert.equal(error.context['name'], 'broken');
          assert.equal(error.context['direction'], 'up');
          return true;
        },
      );

      // The failed migration must not be recorded as applied.
      const status = await migrator(scratch.db, [trivial, second, broken]).status();
      assert.deepEqual(
        status.pending.map((m) => m.id),
        [9003],
      );
    });

    it('rejects duplicate migration ids at construction', () => {
      assert.throws(() => migrator(scratch.db, [trivial, { ...second, id: 9001 }]), MigrationError);
    });

    it('refuses to roll back a migration marked irreversible', async () => {
      const irreversible: Migration = {
        id: 9004,
        name: 'irreversible',
        up: 'CREATE TABLE one_way (id int)',
        down: null,
      };
      const m = migrator(scratch.db, [trivial, second, irreversible]);
      await m.up();

      await assert.rejects(
        () => m.down(),
        (error: unknown) => error instanceof MigrationError && /irreversible/.test(error.message),
      );
    });

    it('serialises concurrent migrators rather than racing them', async () => {
      const fresh = await createScratchDatabase('lock');
      try {
        const results = await Promise.all([
          migrator(fresh.db, [trivial, second]).up(),
          migrator(fresh.db, [trivial, second]).up(),
        ]);

        const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
        assert.equal(totalApplied, 2, 'each migration is applied exactly once across both runs');
        assert.equal(await tableExists(fresh.db, 'trivial_thing'), true);
        assert.equal(await tableExists(fresh.db, 'second_thing'), true);
      } finally {
        await fresh.drop();
      }
    });

    it('takes an enum value back out, and says what that costs (050, 051)', async () => {
      // **The half a round trip cannot see.** Rolling 050 back over an empty database proves the
      // SQL parses; the interesting case is a database that holds a stored XML report, because
      // PostgreSQL has no DROP VALUE and the column cannot be cast to a type without the label.
      // The migration deletes those documents on the way, deliberately, and this is where that
      // claim is checked rather than only written down.
      const fresh = await createScratchDatabase('enumdown');
      try {
        // **The set that ends at 051, not the whole list.** `down(2)` takes back the two newest,
        // and this test is about two particular migrations: built from every migration, it broke
        // the day 053 was appended (`L-01`), because 053 had become one of the two.
        const m = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 51),
        );
        await m.up();

        // Where the value sits in the type, which is the order PostgreSQL sorts the column by:
        // the renderings together, the container that wraps them last. `ADD VALUE` appends by
        // default, and appending would have put `xml` after `zip`.
        const order = async (): Promise<string[]> =>
          (
            await fresh.db.query<{ label: string }>(
              `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'report_output_format' ORDER BY e.enumsortorder`,
            )
          ).map((one) => one.label);
        assert.deepEqual(await order(), ['html', 'csv', 'xml', 'pdf', 'zip']);

        const report = await fresh.db.query<{ id: string }>(
          "INSERT INTO report (name, kind) VALUES ('rolled back', 'table_only') RETURNING id",
        );
        const run = await fresh.db.query<{ id: string }>(
          "INSERT INTO report_run (report_id, trigger) VALUES ($1, 'manual') RETURNING id",
          [report[0]?.id],
        );
        for (const format of ['xml', 'pdf']) {
          await fresh.db.query(
            `INSERT INTO report_output (run_id, format, filename, byte_size, sha256, body)
             VALUES ($1, $2::report_output_format, 'a.out', 3, repeat('a', 64), '\\x616263'::bytea)`,
            [run[0]?.id, format],
          );
        }

        // Both, in one go: 051 admitted `pdf` under the same reasoning 050 admitted `xml`, and
        // each rollback has to survive a database that holds documents in the format it removes.
        const { reverted } = await m.down(2);
        assert.deepEqual(
          reverted.map((one) => one.id),
          [51, 50],
        );

        assert.deepEqual(await order(), ['html', 'csv', 'zip']);
        // The document is gone and the run that produced it is not, which is the same thing
        // `E-10`'s expiry does to a run whose outputs have aged out.
        const left = await fresh.db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM report_output',
        );
        assert.equal(left[0]?.n, '0');
        const runs = await fresh.db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM report_run',
        );
        assert.equal(runs[0]?.n, '1');

        // And forward again, which is what an operator who rolled back to look at something does.
        const again = await m.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [50, 51],
        );
      } finally {
        await fresh.drop();
      }
    });

    it('names each share link’s maker, and leaves a link nobody can vouch for dark (054)', async () => {
      // `A-22` resolves a public map through the account that made the link. Links made before
      // it carry only a login, so 054 matches it — folded, as the login index compares — and a
      // login that matches nobody leaves the link with no maker, which publishes nothing.
      const fresh = await createScratchDatabase('sharemaker');
      try {
        const before = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 53),
        );
        await before.up();
        const user = await fresh.db.query<{ id: string }>(
          `INSERT INTO user_account (login, password_hash, role)
           VALUES ('Operator', 'x', 'readwrite') RETURNING id`,
        );
        const map = await fresh.db.query<{ id: string }>(
          `INSERT INTO map (name) VALUES ('wall') RETURNING id`,
        );
        for (const [label, by] of [
          ['theirs', 'operator'],
          ['renamed', 'somebody-since-renamed'],
          ['anonymous', ''],
        ] as const) {
          await fresh.db.query(
            `INSERT INTO map_share (map_id, label, token_hash, prefix, expires_at, created_by)
             VALUES ($1, $2, repeat($3, 64), 'p', now() + interval '1 day', $4)`,
            [map[0]?.id, label, label.slice(0, 1), by],
          );
        }

        const all = migrator(fresh.db, MIGRATIONS);
        await all.up();
        const makers = await fresh.db.query<{ label: string; maker: string | null }>(
          `SELECT label, created_by_user::text AS maker FROM map_share ORDER BY label`,
        );
        assert.deepEqual(makers, [
          { label: 'anonymous', maker: null },
          { label: 'renamed', maker: null },
          { label: 'theirs', maker: user[0]?.id },
        ]);

        // Back, and the column goes with it; the login the link was made under stays.
        await all.down(MIGRATIONS.length - 53);
        const columns = await fresh.db.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_name = 'map_share' AND column_name LIKE 'created_by%' ORDER BY 1`,
        );
        assert.deepEqual(
          columns.map((one) => one.name),
          ['created_by'],
        );
      } finally {
        await fresh.drop();
      }
    });

    it('adds and takes back a backfill’s channels and failures (058)', async () => {
      // `P-226`. An entry queued before 058 knows no channels, so it must come through as NULL,
      // which re-rolls every channel as before. The rollback is checked on its own: rolling back
      // the whole list drops the table at 004 and would hide a column 058 left behind.
      const fresh = await createScratchDatabase('backfillcols');
      try {
        const shape = async (): Promise<string[]> => {
          const rows = await fresh.db.query<{ item: string }>(
            `SELECT 'column ' || column_name AS item FROM information_schema.columns
             WHERE table_name = 'rollup_backfill'
             UNION ALL
             SELECT 'constraint ' || conname FROM pg_constraint
             WHERE conrelid = 'rollup_backfill'::regclass
             ORDER BY 1`,
          );
          return rows.map((row) => row.item);
        };
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 57),
        ).up();
        const before = await shape();
        await fresh.db.query(
          `INSERT INTO rollup_backfill (from_time, to_time, reason)
           VALUES (now() - interval '1 day', now(), 'queued before 058')`,
        );

        const through = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 58),
        );
        await through.up();
        const old = await fresh.db.query<{ channel_ids: number[] | null; attempts: number }>(
          'SELECT channel_ids, attempts FROM rollup_backfill',
        );
        assert.deepEqual(old, [{ channel_ids: null, attempts: 0 }]);
        await fresh.db.query(
          `INSERT INTO rollup_backfill
             (from_time, to_time, reason, channel_ids, attempts, last_error, failed_at, retry_at)
           VALUES (now() - interval '1 day', now(), 'parked', '{7}', 3, 'full', now(),
                   now() + interval '1 hour')`,
        );

        await through.down(1);
        assert.deepEqual(await shape(), before, 'exactly the table 057 left');
        const kept = await fresh.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM rollup_backfill',
        );
        assert.equal(kept[0]?.n, 2, 'and every entry, which the previous build re-rolls whole');
        await through.up();
      } finally {
        await fresh.drop();
      }
    });

    it('adds and takes back a rule’s last problem and a message’s missed recipients (055, 056)', async () => {
      // `A-28` keeps why a rediscovery firing was refused on the rule; `M-19` keeps who a sent
      // message did not reach on the request. Both are text with an empty default, so a row
      // written before either reads as "nothing to say" rather than as null.
      const fresh = await createScratchDatabase('lastproblem');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 56),
        );
        await all.up();
        const columns = async (): Promise<string[]> =>
          (
            await fresh.db.query<{ name: string }>(
              `SELECT table_name || '.' || column_name || ' ' || column_default AS name
               FROM information_schema.columns
               WHERE (table_name, column_name) IN
                 (('discovery_schedule', 'last_problem'),
                  ('notification_request', 'skipped_recipients'))
               ORDER BY 1`,
            )
          ).map((one) => one.name);
        assert.deepEqual(await columns(), [
          "discovery_schedule.last_problem ''::text",
          "notification_request.skipped_recipients ''::text",
        ]);

        await all.down(2);
        assert.deepEqual(await columns(), []);
      } finally {
        await fresh.drop();
      }
    });

    it('adds and takes back a rule’s version, starting every existing rule at 1 (057)', async () => {
      // `D-11`: an edit says which version it was made against. A rule written before this has
      // never been edited, so it starts where a new one does.
      const fresh = await createScratchDatabase('ruleversion');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 57),
        );
        await all.up();
        const column = async (): Promise<string[]> =>
          (
            await fresh.db.query<{ name: string }>(
              `SELECT data_type || ' ' || is_nullable || ' ' || column_default AS name
               FROM information_schema.columns
               WHERE table_name = 'discovery_schedule' AND column_name = 'version'`,
            )
          ).map((one) => one.name);
        assert.deepEqual(await column(), ['bigint NO 1']);

        await all.down(1);
        assert.deepEqual(await column(), []);
      } finally {
        await fresh.drop();
      }
    });

    it('asks the audit log who vouched for each sensor, and takes `access` back out (059)', async () => {
      // `A-29` re-checks a sensor's voucher every sweep, and was found in sensors that already
      // existed — so the backfill has to name the account that last wrote each one's
      // parameters, and fall back to the installation for anything else.
      const fresh = await createScratchDatabase('voucher');
      try {
        const earlier = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id < 59),
        );
        await earlier.up();
        // 059 and whatever lands after it, so this is still about 059 the day 060 is appended.
        const since = MIGRATIONS.filter((one) => one.id >= 59);
        const q = fresh.db;
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const insert = async (kind: string, name: string, parent: string): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id::text',
            [parent, kind, name],
          );
          return row?.id ?? assert.fail('no row');
        };
        const probe = await insert('probe', 'probe', root?.id ?? '');
        const device = await insert('device', 'device', probe);
        const sensor = async (name: string): Promise<string> => {
          const id = await insert('sensor', name, device);
          await q.query(`INSERT INTO sensor_config (object_id, type) VALUES ($1, 'core.factory')`, [
            id,
          ]);
          return id;
        };
        const [person] = await q.query<{ id: string }>(
          `INSERT INTO user_account (login, password_hash, role)
           VALUES ('operator', 'x', 'readwrite') RETURNING id::text`,
        );
        const operator = person?.id ?? assert.fail('no account');
        const [issued] = await q.query<{ id: string }>(
          `INSERT INTO api_token (user_id, name, token_hash, prefix)
           VALUES ($1, 'script', repeat('a', 64), 'ms_') RETURNING id::text`,
          [operator],
        );
        const token = issued?.id ?? assert.fail('no token');

        const written = await sensor('written by an account');
        const edited = await sensor('created by the system, edited by an account');
        const renamed = await sensor('created by an account, renamed by the system');
        const system = await sensor('created by the system');
        const gone = await sensor('created by an account since deleted');
        const orphan = await sensor('inside a clone, with no row of its own');
        const scripted = await sensor('created through a token');
        const audit = async (
          id: string,
          seconds: number,
          action: string,
          actor: { kind: string; ref: string },
          summary: Record<string, unknown> = {},
        ): Promise<void> => {
          await q.query(
            `INSERT INTO audit_log (at, action, object_id, object_kind, actor_kind, actor_ref, summary)
             VALUES (now() - make_interval(secs => $2), $3, $1, 'sensor', $4, $5, $6)`,
            [id, 1_000 - seconds, action, actor.kind, actor.ref, JSON.stringify(summary)],
          );
        };
        const theOperator = { kind: 'user', ref: operator };
        const theSystem = { kind: 'system', ref: 'discovery' };
        await audit(written, 1, 'object.created', theOperator);
        await audit(edited, 1, 'object.created', theSystem);
        await audit(edited, 2, 'object.updated', theOperator, { paramsChanged: ['channels'] });
        await audit(renamed, 1, 'object.created', theOperator);
        await audit(renamed, 2, 'object.updated', theSystem, {});
        await audit(system, 1, 'object.created', theSystem);
        await audit(gone, 1, 'object.created', { kind: 'user', ref: '9000000' });
        await audit(scripted, 1, 'object.created', { kind: 'token', ref: token });

        const all = migrator(fresh.db, MIGRATIONS);
        await all.up();
        const vouchers = await q.query<{ id: string; by: string; account: string | null }>(
          `SELECT object_id::text AS id, vouched_by AS by, vouched_by_user::text AS account
           FROM sensor_config ORDER BY object_id`,
        );
        assert.deepEqual(
          vouchers.map(({ id, by, account }) => [id, by, account]),
          [
            [written, 'account', operator],
            [edited, 'account', operator],
            // A rename writes no parameters, so the create is still the last word on them.
            [renamed, 'account', operator],
            [system, 'installation', null],
            // Nobody to vouch: the installation, the permissive reading the migration states.
            [gone, 'installation', null],
            [orphan, 'installation', null],
            // A token writes as its owner, and vouches as its owner.
            [scripted, 'account', operator],
          ],
        );

        // An account deleted since goes NULL, and the sensor stays an account's — withheld.
        await q.query('DELETE FROM user_account WHERE id = $1', [operator]);
        const [deleted] = await q.query<{ by: string; account: string | null }>(
          `SELECT vouched_by AS by, vouched_by_user::text AS account
           FROM sensor_config WHERE object_id = $1`,
          [written],
        );
        assert.deepEqual(deleted, { by: 'account', account: null });

        // Back: a row that says `access` survives as `scan`, with its state and its message.
        await q.query(
          `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
           VALUES (now(), $1, 'unknown', 'up', 'access', 'withheld')`,
          [written],
        );
        await q.query(
          `UPDATE sensor_runtime SET state = 'unknown', cause = 'access', message = 'withheld'
           WHERE object_id = $1`,
          [written],
        );
        await all.down(since.length);
        const [history] = await q.query<{ cause: string; message: string }>(
          `SELECT cause::text AS cause, message FROM sensor_state WHERE sensor_id = $1`,
          [written],
        );
        assert.deepEqual(history, { cause: 'scan', message: 'withheld' });
        const [runtime] = await q.query<{ cause: string; message: string; initial: string }>(
          `SELECT cause::text AS cause, message,
                  (SELECT column_default FROM information_schema.columns
                   WHERE table_name = 'sensor_runtime' AND column_name = 'cause') AS initial
           FROM sensor_runtime WHERE object_id = $1`,
          [written],
        );
        assert.deepEqual(runtime, {
          cause: 'scan',
          message: 'withheld',
          initial: "'scan'::sensor_state_cause",
        });
        const labels = await q.query<{ label: string }>(
          `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = 'sensor_state_cause' ORDER BY e.enumsortorder`,
        );
        assert.ok(!labels.some((one) => one.label === 'access'));
        const columns = await q.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_name = 'sensor_config' AND column_name LIKE 'vouched%'`,
        );
        assert.deepEqual(columns, []);

        // And forward again.
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          since.map((one) => one.id),
        );
      } finally {
        await fresh.drop();
      }
    });

    it('applies the real migration set forward and all the way back', async () => {
      const fresh = await createScratchDatabase('roundtrip');
      try {
        const m = migrator(fresh.db, MIGRATIONS);

        const { applied } = await m.up();
        assert.equal(applied.length, MIGRATIONS.length);
        assert.equal(await tableExists(fresh.db, 'object'), true);

        // Every schema change ships with a tested rollback (CLAUDE.md).
        const { reverted } = await m.down(MIGRATIONS.length);
        assert.equal(reverted.length, MIGRATIONS.length);
        assert.equal(await tableExists(fresh.db, 'object'), false);
        assert.equal(await tableExists(fresh.db, 'channel'), false);
        assert.equal(await tableExists(fresh.db, 'credential_set'), false);

        // And forward again, proving down left nothing behind that up would collide with.
        const again = await m.up();
        assert.equal(again.applied.length, MIGRATIONS.length);
      } finally {
        await fresh.drop();
      }
    });
  },
);

/**
 * `P-215`: a migration at start-up is a start the supervisor can kill, so it reports progress for
 * as long as it runs. A fixed slice per migration would only have moved the deadline.
 */
describe(
  'a migration that runs long',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('migratorprogress');
      db = scratch.db;
    });

    after(async () => {
      await scratch.drop();
    });

    it('reports as it starts and then on every interval until it ends, and never after', async () => {
      const slow: Migration = {
        id: 9101,
        name: 'slow',
        up: 'SELECT pg_sleep(0.45); CREATE TABLE slow_thing (id int PRIMARY KEY)',
        down: 'DROP TABLE slow_thing',
      };
      const reports: { id: number; elapsedMs: number }[] = [];
      const subject = new Migrator({
        db,
        logger: silentLogger,
        migrations: [slow],
        progressIntervalMs: 100,
        onProgress: ({ migration, elapsedMs }) => {
          reports.push({ id: migration.id, elapsedMs });
        },
      });

      await subject.up();
      const atEnd = reports.length;

      assert.deepEqual(reports[0], { id: 9101, elapsedMs: 0 }, 'one report before any work');
      // 450 ms of work at a 100 ms interval: at least three more, however busy the database is.
      assert.ok(atEnd >= 4, `expected reports throughout, got ${String(atEnd)}`);
      const elapsed = reports.map((report) => report.elapsedMs);
      assert.deepEqual(
        elapsed,
        [...elapsed].sort((a, b) => a - b),
        'elapsed time only goes forward',
      );

      // And the timer is gone: a report after the migration ended would keep extending a start
      // that is no longer migrating.
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(reports.length, atEnd);
      assert.ok(await tableExists(db, 'slow_thing'));
    });

    it('stops reporting when a migration fails, too', async () => {
      const broken: Migration = {
        id: 9102,
        name: 'broken',
        up: 'SELECT pg_sleep(0.25); SELECT * FROM no_such_table',
        down: null,
      };
      let reports = 0;
      const subject = new Migrator({
        db,
        logger: silentLogger,
        migrations: [broken],
        progressIntervalMs: 50,
        onProgress: () => {
          reports += 1;
        },
      });

      await assert.rejects(subject.up(), MigrationError);
      const atFailure = reports;
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(reports, atFailure);
    });
  },
);

/**
 * `P-222`: the lock every migration run takes comes before any migration, so a core waiting on it
 * reported nothing, was killed at `TimeoutStartSec` five times and ended `failed`. And `down`
 * reverted by number, which is not "the most recent" on a database that applied out of order.
 */
describe(
  'the migration lock, and the order migrations were applied in (P-222)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('migratorlock');
    });

    after(async () => {
      await scratch.drop();
    });

    it('says who holds the lock for as long as it waits, and migrates the moment it is free', async () => {
      const config = testDatabaseConfig();
      const holder = new Client({
        host: config.host,
        port: config.port,
        database: scratch.name,
        user: config.user,
        password: config.password,
        application_name: 'p222-lock-holder',
      });
      await holder.connect();
      try {
        const [row] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

        const waits: LockWait[] = [];
        const subject = new Migrator({
          db: scratch.db,
          logger: silentLogger,
          migrations: [trivial],
          progressIntervalMs: 100,
          lockPollMs: 20,
          onLockWait: (wait) => waits.push(wait),
        });
        const running = subject.up();
        // Until three reports, however slow the machine: the count is the claim, not the timing.
        const deadline = Date.now() + 10_000;
        while (waits.length < 3 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        assert.ok(
          waits.length >= 3,
          `expected a report at once and on every interval, got ${String(waits.length)}`,
        );
        assert.ok(
          (waits[0]?.elapsedMs ?? Infinity) < 100,
          'the first report comes at the first refusal',
        );
        assert.equal(
          waits[0]?.holder?.pid,
          row?.pid,
          'the holder is named, so an operator can end it',
        );
        assert.equal(waits[0]?.holder?.application, 'p222-lock-holder');
        assert.equal(
          await tableExists(scratch.db, 'trivial_thing'),
          false,
          'nothing ran under the wait',
        );

        await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
        const { applied } = await running;
        assert.deepEqual(
          applied.map((m) => m.id),
          [9001],
        );
        const reportedAtEnd = waits.length;
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(waits.length, reportedAtEnd, 'no report once the lock is held');
      } finally {
        await holder.end();
      }
    });

    it('applies a gap below the newest migration, and rolls back what was applied last first', async () => {
      // 9001 is applied by the test above; 9003 goes on next, and then 9002 arrives late, the way
      // 052 did after 053 on 2026-09-28.
      const third: Migration = {
        id: 9003,
        name: 'third',
        up: 'CREATE TABLE third_thing (id int PRIMARY KEY)',
        down: 'DROP TABLE third_thing',
      };
      await migrator(scratch.db, [trivial, third]).up();
      const late = migrator(scratch.db, [trivial, second, third]);
      const { applied } = await late.up();
      assert.deepEqual(
        applied.map((m) => m.id),
        [9002],
      );

      const first = await late.down();
      assert.deepEqual(
        first.reverted.map((m) => m.id),
        [9002],
        'the migration applied last goes first, not the highest number',
      );
      assert.equal(await tableExists(scratch.db, 'third_thing'), true, "9003's table is untouched");

      const next = await late.down();
      assert.deepEqual(
        next.reverted.map((m) => m.id),
        [9003],
      );
    });

    it('marks a schema this build will not run against as a refusal, not a failure', async () => {
      // 9003 was reverted above and 9001 is applied; a build that knows only 9002 finds an
      // applied migration it does not define.
      await assert.rejects(migrator(scratch.db, [second]).up(), (error) => {
        assert.ok(error instanceof MigrationError);
        assert.equal(error.refusal, true);
        return true;
      });
    });
  },
);

describe(
  'ms-core migrate status (P-238)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('migrate_status');
      await new Migrator({ db: scratch.db, logger: silentLogger, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    it('lists an edited migration with the checksum it was applied under and this build’s', async () => {
      const first = MIGRATIONS[0];
      assert.ok(first !== undefined);
      // The record says one version of the migration was applied, and this build carries another.
      await scratch.db.query(
        `UPDATE schema_migration SET checksum = 'applied-elsewhere' WHERE id = $1`,
        [first.id],
      );
      const lines: string[] = [];
      const code = await runMigrateCommand({
        action: 'status',
        steps: 1,
        config: { database: { ...testDatabaseConfig(), database: scratch.name } },
        logger: silentLogger,
        write: (line) => lines.push(line),
      });
      assert.equal(code, 1);
      const at = lines.findIndex((line) =>
        line.startsWith(`  !!! ${String(first.id).padStart(4, '0')} `),
      );
      assert.ok(at >= 0, 'the edited migration is listed');
      assert.equal(lines[at + 1], '        applied:    applied-elsewhere');
      assert.match(lines[at + 2] ?? '', /^ {8}this build: [0-9a-f]{64}$/u);
    });
  },
);
