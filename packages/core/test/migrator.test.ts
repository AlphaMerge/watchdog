import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client, type QueryResultRow } from 'pg';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { MIGRATION_LOCK_KEY, Migrator, MigrationError, type LockWait } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  LEGIBLE_CANDIDATE,
  rewriteDeliveryErrors,
} from '../src/db/migrations/071-legible-delivery-errors.js';
import { refuseSchema } from '../src/db/schema-gate.js';
import type { Migration } from '../src/db/migrations/types.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { legible } from '../src/notifications/legible.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { pollWithin } from './support/within.js';

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

    it('refuses drift before applying anything pending, so the gate diagnoses it first (P-248)', async () => {
      // `refuseSchema` used to answer this shape with "run migrate up", and here is migrate up.
      const edited: Migration = { ...trivial, up: 'CREATE TABLE trivial_thing (id bigint)' };
      const third: Migration = {
        id: 9004,
        name: 'third',
        up: 'CREATE TABLE third_thing (id int PRIMARY KEY)',
        down: 'DROP TABLE third_thing',
      };
      const m = migrator(scratch.db, [edited, second, third]);
      const status = await m.status();
      assert.deepEqual(
        [status.drifted.map((d) => d.id), status.pending.map((p) => p.id)],
        [[9001], [9004]],
        'the control: both at once',
      );

      await assert.rejects(
        () => m.up(),
        (error: unknown) =>
          error instanceof MigrationError && /has been edited/u.test(error.message),
      );
      assert.equal(await tableExists(scratch.db, 'third_thing'), false, 'nothing applied');
      const refusal = refuseSchema(status) ?? '';
      assert.match(refusal, /9001 trivial \(applied /u);
      assert.doesNotMatch(refusal, /migrate up/u);
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

    it('marks the credentials in use as not yet vouched for, and asks the audit log who wrote each rule (060, 061)', async () => {
      // `A-41` records who vouched for sending each sensor its inherited credentials. SQL cannot
      // ask the catalogue which types use which kinds, so 060 records nothing and marks the
      // installation for the core's boot step instead; 061 names each rediscovery rule's last
      // writer, who vouches for what its runs provision.
      const fresh = await createScratchDatabase('credential_voucher');
      try {
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id < 60),
        ).up();
        const since = MIGRATIONS.filter((one) => one.id >= 60);
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
        const group = await insert('group', 'group', probe);
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
        const rule = async (name: string): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            `INSERT INTO discovery_schedule (group_id, probe_id, name, range_text, cadence)
             VALUES ($1, $2, $3, '192.0.2.0/28', 'daily') RETURNING id::text`,
            [group, probe, name],
          );
          return row?.id ?? assert.fail('no rule');
        };
        const audit = async (
          id: string,
          seconds: number,
          action: string,
          actor: { kind: string; ref: string },
        ): Promise<void> => {
          await q.query(
            `INSERT INTO audit_log (at, action, object_id, object_kind, actor_kind, actor_ref, summary)
             VALUES (now() - make_interval(secs => $1), $2, $3, NULL, $4, $5, $6)`,
            [
              1_000 - seconds,
              action,
              group,
              actor.kind,
              actor.ref,
              JSON.stringify({ scheduleId: Number(id), name: 'rule' }),
            ],
          );
        };
        const theOperator = { kind: 'user', ref: operator };
        const theSystem = { kind: 'system', ref: 'discovery' };

        const written = await rule('written by an account');
        const edited = await rule('created by the system, edited by an account');
        const reclaimed = await rule('created by an account, edited by the system');
        const system = await rule('created by the system');
        const gone = await rule('created by an account since deleted');
        const scripted = await rule('created through a token');
        const unrecorded = await rule('with no audit entry at all');
        await audit(written, 1, 'discovery.schedule.created', theOperator);
        await audit(edited, 1, 'discovery.schedule.created', theSystem);
        await audit(edited, 2, 'discovery.schedule.updated', theOperator);
        await audit(reclaimed, 1, 'discovery.schedule.created', theOperator);
        await audit(reclaimed, 2, 'discovery.schedule.updated', theSystem);
        await audit(system, 1, 'discovery.schedule.created', theSystem);
        await audit(gone, 1, 'discovery.schedule.created', { kind: 'user', ref: '9000000' });
        await audit(scripted, 1, 'discovery.schedule.created', { kind: 'token', ref: token });

        const all = migrator(fresh.db, MIGRATIONS);
        await all.up();

        const writers = await q.query<{ id: string; by: string; account: string | null }>(
          `SELECT id::text AS id, written_by AS by, written_by_user::text AS account
           FROM discovery_schedule ORDER BY discovery_schedule.id`,
        );
        assert.deepEqual(
          writers.map(({ id, by, account }) => [id, by, account]),
          [
            [written, 'account', operator],
            [edited, 'account', operator],
            // The last word is the system's, which is the installation's.
            [reclaimed, 'installation', null],
            [system, 'installation', null],
            [gone, 'installation', null],
            // A token writes as its owner, and vouches as its owner.
            [scripted, 'account', operator],
            [unrecorded, 'installation', null],
          ],
        );
        await assert.rejects(
          q.query(`UPDATE discovery_schedule SET written_by_user = $2 WHERE id = $1`, [
            system,
            operator,
          ]),
          /discovery_schedule_writer_is_an_account/,
          'the installation is nobody in particular',
        );

        // Nothing recorded, and the mark set, for the boot step to act on.
        assert.deepEqual(
          await q.query('SELECT count(*)::int AS n FROM sensor_credential_voucher'),
          [{ n: 0 }],
        );
        assert.deepEqual(await q.query('SELECT pending, recipe FROM credential_voucher_adoption'), [
          { pending: true, recipe: '' },
        ]);
        await assert.rejects(
          q.query(
            'INSERT INTO credential_voucher_adoption (only_row, pending) VALUES (false, true)',
          ),
          /check/i,
          'one row, and only one',
        );

        // An account deleted since goes NULL, and the rule stays an account's: it vouches for
        // nothing.
        await q.query('DELETE FROM user_account WHERE id = $1', [operator]);
        assert.deepEqual(
          await q.query(
            `SELECT written_by AS by, written_by_user AS account FROM discovery_schedule
             WHERE id = $1`,
            [written],
          ),
          [{ by: 'account', account: null }],
        );

        await all.down(since.length);
        assert.equal(await tableExists(q, 'sensor_credential_voucher'), false);
        assert.equal(await tableExists(q, 'credential_voucher_adoption'), false);
        // The recipe goes with its table: a downgrade and a later upgrade compares against the
        // empty one again, and carries nothing over it cannot show is where it was.
        assert.deepEqual(
          await q.query(
            `SELECT column_name AS name FROM information_schema.columns
             WHERE column_name = 'recipe' AND table_schema = current_schema()`,
          ),
          [],
        );
        assert.deepEqual(
          await q.query(
            `SELECT column_name AS name FROM information_schema.columns
             WHERE table_name = 'discovery_schedule' AND column_name LIKE 'written%'`,
          ),
          [],
        );

        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          since.map((one) => one.id),
        );
      } finally {
        await fresh.drop();
      }
    });

    it('keys login attempts by what their address counts as, leaving older rows uncounted (062)', async () => {
      // `A-47`: an IPv6 client is its /64. Rows from before the upgrade keep a NULL key, which
      // nothing counts; the column and its index go on the way back down.
      const fresh = await createScratchDatabase('login_address_key');
      try {
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id < 62),
        ).up();
        const q = fresh.db;
        await q.query(
          `INSERT INTO login_attempt (login, remote_address, succeeded)
           VALUES ('ops', '2001:db8::1', false), ('ops', 'not an address', true)`,
        );
        const since = MIGRATIONS.filter((one) => one.id >= 62);
        const all = migrator(fresh.db, MIGRATIONS);
        await all.up();
        assert.deepEqual(
          await q.query('SELECT remote_address, address_key FROM login_attempt ORDER BY id'),
          [
            { remote_address: '2001:db8::1', address_key: null },
            { remote_address: 'not an address', address_key: null },
          ],
          'an upgrade over a row that is not an address does not fail',
        );
        await assert.rejects(
          q.query(
            `INSERT INTO login_attempt (login, remote_address, address_key, succeeded)
             VALUES ('ops', '', repeat('a', 65), false)`,
          ),
          /check/i,
        );
        const index = async (): Promise<unknown[]> =>
          q.query(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'login_attempt' AND indexname = 'login_attempt_address_key_idx'`,
          );
        assert.equal((await index()).length, 1);

        await all.down(since.length);
        assert.deepEqual(
          await q.query(
            `SELECT column_name AS name FROM information_schema.columns
             WHERE table_name = 'login_attempt' AND column_name = 'address_key'
               AND table_schema = current_schema()`,
          ),
          [],
        );
        assert.deepEqual(await index(), []);
        assert.equal(
          (await q.query('SELECT id FROM login_attempt')).length,
          2,
          'and the attempts themselves stay',
        );

        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          since.map((one) => one.id),
        );
      } finally {
        await fresh.drop();
      }
    });

    it('adds when a held return began, and drops what it is holding on the way back (063)', async () => {
      // `M-18` holds a return to Up before a state alarm is over. The column is a state alarm's
      // alone, and the rollback deletes the rows being held: a build without it would stand them
      // down silently at the end of the hold anyway, and says nothing either way.
      const fresh = await createScratchDatabase('alarm_recovering');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 63),
        );
        await all.up();
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
        const sensor = await insert('sensor', 'sensor', await insert('device', 'device', probe));
        const trigger = async (): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            `INSERT INTO notification_trigger (object_id, kind, settings)
             VALUES ($1, 'state', '{"state":"down"}'::jsonb) RETURNING id::text`,
            [sensor],
          );
          return row?.id ?? assert.fail('no trigger');
        };
        const [held, standing, threshold] = [await trigger(), await trigger(), await trigger()];
        for (const [id, returnedAt] of [
          [held, new Date()],
          [standing, null],
        ] as const) {
          await q.query(
            `INSERT INTO notification_alarm
               (sensor_id, trigger_id, state, since, phase, next_due_at, recovering_since)
             VALUES ($1, $2, 'down', now() - interval '1 hour', 'notified',
                     now() + interval '5 minutes', $3)`,
            [sensor, id, returnedAt],
          );
        }
        await assert.rejects(
          q.query(
            `INSERT INTO notification_alarm
               (sensor_id, trigger_id, kind, state, channel_key, observed, since, phase,
                recovering_since)
             VALUES ($1, $2, 'threshold', NULL, 'latency', 42, now(), 'notified', now())`,
            [sensor, threshold],
          ),
          /notification_alarm_recovering_is_a_state_alarm/,
        );

        await all.down(1);
        const left = await q.query<{ trigger: string }>(
          'SELECT trigger_id::text AS trigger FROM notification_alarm ORDER BY 1',
        );
        assert.deepEqual(
          left.map((one) => one.trigger),
          [standing],
        );
        const columns = await q.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_name = 'notification_alarm' AND column_name = 'recovering_since'`,
        );
        assert.deepEqual(columns, []);

        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [63],
        );
      } finally {
        await fresh.drop();
      }
    });

    it('lets two maps, reports and libraries share a name, and renames all but one on the way back (064)', async () => {
      // `L-06`: a name is unique among what the caller can read, so the database stops insisting
      // on it everywhere. The way back restores the unique indexes, which a database holding two
      // of one name cannot have: every duplicate but the oldest is suffixed with its id, cut to
      // fit the hundred characters a name may have, and moves on a version.
      const fresh = await createScratchDatabase('flatnames');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 64),
        );
        await all.up();
        const unique = async (): Promise<Record<string, boolean>> =>
          Object.fromEntries(
            (
              await fresh.db.query<{ name: string; unique: boolean }>(
                `SELECT c.relname AS name, i.indisunique AS unique
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                 WHERE c.relname IN ('map_name_idx', 'report_name_idx', 'library_name_idx')`,
              )
            ).map((row) => [row.name, row.unique]),
          );
        assert.deepEqual(await unique(), {
          map_name_idx: false,
          report_name_idx: false,
          library_name_idx: false,
        });

        const long = 'x'.repeat(100);
        const ids = { map: [] as number[], report: [] as number[], library: [] as number[] };
        for (const table of ['map', 'report', 'library'] as const) {
          for (const name of ['Core Network', 'core network', 'Edge', long, long.toUpperCase()]) {
            const rows = await fresh.db.query<{ id: string }>(
              table === 'report'
                ? `INSERT INTO report (name, kind) VALUES ($1, 'table_only') RETURNING id`
                : `INSERT INTO ${table} (name) VALUES ($1) RETURNING id`,
              [name],
            );
            ids[table].push(Number(rows[0]?.id));
          }
        }

        await all.down(1);
        assert.deepEqual(await unique(), {
          map_name_idx: true,
          report_name_idx: true,
          library_name_idx: true,
        });
        for (const table of ['map', 'report', 'library'] as const) {
          const [first, second, edge, third, fourth] = ids[table];
          const rows = await fresh.db.query<{ id: string; name: string; version: string }>(
            `SELECT id, name, version FROM ${table} ORDER BY id`,
          );
          const suffix = (id: number | undefined): string => ` (#${String(id)})`;
          assert.deepEqual(
            rows.map((row) => [Number(row.id), row.name, Number(row.version)]),
            [
              [first, 'Core Network', 1],
              [second, `core network${suffix(second)}`, 2],
              [edge, 'Edge', 1],
              [third, long, 1],
              [fourth, `${'X'.repeat(100 - suffix(fourth).length)}${suffix(fourth)}`, 2],
            ],
            table,
          );
        }
      } finally {
        await fresh.drop();
      }
    });

    it('counts who a message missed, and takes the names out of its error and back (065)', async () => {
      // `A-44`: the log shows a reader who may not list accounts how many were missed and why,
      // and never who. A failure's names move from the error to the column that holds them, and
      // the way back returns them to the error, as the build before wrote them. What it cannot
      // return is the part of a list that ran past the column's 2,000 characters.
      const fresh = await createScratchDatabase('skipped_counts');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 65),
        );
        await all.up();
        await all.down(1);
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
        const sensor = await insert('sensor', 'sensor', await insert('device', 'device', probe));
        const request = async (
          status: string,
          lastError: string | null,
          skipped = '',
        ): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            `INSERT INTO notification_request
               (at, sensor_id, trigger_kind, reason, state, status, last_error, skipped_recipients)
             VALUES (now(), $1, 'state', 'initial', 'down', $2, $3, $4) RETURNING id::text`,
            [sensor, status, lastError, skipped],
          );
          return row?.id ?? assert.fail('no request');
        };

        // Brackets in a group's name, and a reason in brackets inside one: counted only where a
        // clause ends, so neither is taken for a reason.
        const names =
          '"bob" in group "NOC (east)" (disabled), user "carol" (may not see this sensor), ' +
          '"dan" in group "NOC (east)" (disabled), ' +
          '"eve" in group "Old (disabled) staff" (no email address)';
        const clauses = Array.from(
          { length: 60 },
          (_, i) => `"member-${String(i)}" in group "Everyone" (no email address)`,
        );
        const everyone = clauses.join(', ');
        assert.ok(everyone.length > 2_000, 'the long list runs past the column');
        // The clauses that end inside the first 2,000 characters: those the old rows' counts see.
        let whole = 0;
        let end = 0;
        for (const clause of clauses) {
          end += (whole === 0 ? 0 : 2) + clause.length;
          if (end > 2_000) break;
          whole += 1;
        }

        const failed = await request('failed', `nobody to send to: ${names}`);
        const tooMany = await request('failed', `nobody to send to: ${everyone}`);
        const partial = await request('sent', null, 'user "erin" (no email address)');
        const refused = await request('failed', 'relay refused the message: 550 no such mailbox');
        const nameless = await request('failed', 'nobody to send to: ');

        await all.up();
        const rows = async (): Promise<Map<string, unknown[]>> =>
          new Map(
            (
              await q.query<{
                id: string;
                last_error: string | null;
                skipped_recipients: string;
                skipped_counts?: unknown;
              }>(`SELECT * FROM notification_request ORDER BY id`)
            ).map((row) => [
              row.id,
              [
                row.last_error,
                row.skipped_recipients,
                ...('skipped_counts' in row ? [row.skipped_counts] : []),
              ],
            ]),
          );
        const upgraded = await rows();
        assert.deepEqual(upgraded.get(failed), [
          'nobody to send to',
          names,
          { disabled: 2, 'may not see this sensor': 1, 'no email address': 1 },
        ]);
        assert.deepEqual(upgraded.get(tooMany), [
          'nobody to send to',
          everyone.slice(0, 2_000),
          { 'no email address': whole },
        ]);
        assert.deepEqual(upgraded.get(partial), [
          null,
          'user "erin" (no email address)',
          { 'no email address': 1 },
        ]);
        assert.deepEqual(upgraded.get(refused), [
          'relay refused the message: 550 no such mailbox',
          '',
          {},
        ]);
        assert.deepEqual(upgraded.get(nameless), ['nobody to send to: ', '', {}]);
        await assert.rejects(
          q.query(`UPDATE notification_request SET skipped_counts = '[]'::jsonb`),
          /check/i,
        );

        await all.down(1);
        const restored = await rows();
        assert.deepEqual(
          restored.get(failed),
          [`nobody to send to: ${names}`, ''],
          'the names are back in the error, whole',
        );
        assert.deepEqual(
          restored.get(tooMany),
          [`nobody to send to: ${everyone.slice(0, 2_000)}`, ''],
          'and a list past the column comes back as far as the column held it, and no further',
        );
        assert.deepEqual(restored.get(partial), [null, 'user "erin" (no email address)']);
        assert.deepEqual(restored.get(refused), [
          'relay refused the message: 550 no such mailbox',
          '',
        ]);
        assert.deepEqual(restored.get(nameless), ['nobody to send to: ', '']);
      } finally {
        await fresh.drop();
      }
    });

    it('spares a change of place only while asked, and gives every bump back on the way down (066)', async () => {
      // `A-46` writes a hidden sibling's place without bumping its version. Only a transaction
      // that asks, only for `sort_order`, and 066's rollback puts back the body it replaced.
      const fresh = await createScratchDatabase('sibling_order_only');
      try {
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id < 66),
        ).up();
        const q = fresh.db;
        const body = async (): Promise<string> => {
          const [row] = await q.query<{ body: string }>(
            `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname = 'object_touch'`,
          );
          return row?.body ?? assert.fail('no object_touch');
        };
        const replaced = await body();
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const [probe] = await q.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'probe') RETURNING id::text`,
          [root?.id],
        );
        /** How far one UPDATE moved the probe's version, asked or not. */
        const bumpOf = async (set: string, asked: boolean): Promise<number> =>
          q.tx(async (t) => {
            if (asked) await t.query(`SELECT set_config('ms.sibling_order_only', 'on', true)`);
            const [before] = await t.query<{ version: number }>(
              'SELECT version FROM object WHERE id = $1',
              [probe?.id],
            );
            const [after] = await t.query<{ version: number }>(
              `UPDATE object SET ${set} WHERE id = $1 RETURNING version`,
              [probe?.id],
            );
            return (after?.version ?? 0) - (before?.version ?? 0);
          });

        const since = MIGRATIONS.filter((one) => one.id >= 66);
        const all = migrator(fresh.db, MIGRATIONS);
        await all.up();
        assert.equal(await bumpOf('sort_order = 1', true), 0);
        assert.equal(await bumpOf('sort_order = 2', false), 1, 'not asked');

        await all.down(since.length);
        assert.equal(await body(), replaced, 'not the body 066 replaced');
        assert.equal(await bumpOf('sort_order = 3', true), 1, 'asked, after the rollback');

        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          since.map((one) => one.id),
        );
        assert.equal(await bumpOf('sort_order = 4', true), 0);
      } finally {
        await fresh.drop();
      }
    });

    it('keeps which sensors a configuration stopped leaving to a probe, and lets a row go with its sensor or its probe (067)', async () => {
      // `A-61`: the record a core reads at start, so that a late refusal is still late after a
      // restart. One row a pair, a time that is a moment, and no row outliving what it is about.
      const fresh = await createScratchDatabase('late_refusal_grace');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 67),
        );
        await all.up();
        const q = fresh.db;
        assert.equal(await tableExists(q, 'late_refusal_grace'), true);
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const insert = async (kind: string, name: string, parent: string): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id::text',
            [parent, kind, name],
          );
          return row?.id ?? assert.fail('no row');
        };
        const probe = await insert('probe', 'probe', root?.id ?? '');
        const other = await insert('probe', 'other', root?.id ?? '');
        const device = await insert('device', 'device', probe);
        const first = await insert('sensor', 'first', device);
        const second = await insert('sensor', 'second', device);
        const stop = (probeId: string, sensorId: string, at = 'now()'): Promise<unknown> =>
          q.query(
            `INSERT INTO late_refusal_grace (probe_id, sensor_id, stopped_at) VALUES ($1, $2, ${at})`,
            [probeId, sensorId],
          );
        const pairs = async (): Promise<string[]> =>
          (
            await q.query<{ pair: string }>(
              `SELECT probe_id::text || ':' || sensor_id::text AS pair
               FROM late_refusal_grace ORDER BY probe_id, sensor_id`,
            )
          ).map((row) => row.pair);

        await stop(probe, first);
        await stop(probe, second);
        await stop(other, first);
        await stop(other, second);
        await assert.rejects(stop(probe, first), /late_refusal_grace_pkey/);
        // A time nothing can be counted from is not stored at all.
        await q.query('DELETE FROM late_refusal_grace WHERE probe_id = $1 AND sensor_id = $2', [
          other,
          second,
        ]);
        await assert.rejects(
          stop(other, second, `'infinity'`),
          /late_refusal_grace_stopped_at_check/,
        );
        await assert.rejects(
          stop(other, second, `'-infinity'`),
          /late_refusal_grace_stopped_at_check/,
        );
        await assert.rejects(stop(other, second, 'NULL'), /null value in column "stopped_at"/);
        await assert.rejects(stop('999999', second), /foreign key/);
        await assert.rejects(stop(other, '999999'), /foreign key/);
        await stop(other, second);

        // A deleted sensor takes its rows, under every probe; a deleted probe takes its own.
        await q.query('DELETE FROM object WHERE id = $1', [first]);
        assert.deepEqual(await pairs(), [`${probe}:${second}`, `${other}:${second}`]);
        await q.query('DELETE FROM object WHERE id = $1', [other]);
        assert.deepEqual(await pairs(), [`${probe}:${second}`]);

        await all.down(1);
        assert.equal(await tableExists(q, 'late_refusal_grace'), false);
        assert.equal(await tableExists(q, 'object'), true, 'and nothing else');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [67],
        );
        assert.deepEqual(await pairs(), [], 'the record does not come back with the table');
      } finally {
        await fresh.drop();
      }
    });

    it('says what each probe was last left beside when a window began, and rolls back to the rows 067 would have written (068)', async () => {
      // `A-68`: a row may say the probe is left the sensor (and under which version), when the
      // sensor's last window began, or both, and never neither.
      const fresh = await createScratchDatabase('late_refusal_left');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 68),
        );
        await all.up();
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
        const sensors: string[] = [];
        for (const name of ['left', 'stopped', 'both', 'neither']) {
          sensors.push(await insert('sensor', name, device));
        }
        const [left, stopped, both, neither] = sensors as [string, string, string, string];
        const put = (sensorId: string, at: string, version: string): Promise<unknown> =>
          q.query(
            `INSERT INTO late_refusal_grace (probe_id, sensor_id, stopped_at, left_version)
             VALUES ($1, $2, ${at}, ${version})`,
            [probe, sensorId],
          );
        const rows = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT o.name || ':' || (g.stopped_at IS NOT NULL)::text AS line
               FROM late_refusal_grace g JOIN object o ON o.id = g.sensor_id
               ORDER BY o.name`,
            )
          ).map((row) => row.line);

        await put(left, 'NULL', '24');
        await put(stopped, 'now()', 'NULL');
        await put(both, `now() - interval '20 minutes'`, '24');
        await assert.rejects(put(neither, 'NULL', 'NULL'), /late_refusal_grace_says_something/);
        await assert.rejects(put(neither, 'NULL', '0'), /late_refusal_grace_left_version_check/);
        await assert.rejects(put(neither, 'NULL', '-3'), /late_refusal_grace_left_version_check/);
        // 067's own check still holds for a time that is given.
        await assert.rejects(
          put(neither, `'infinity'`, '24'),
          /late_refusal_grace_stopped_at_check/,
        );
        assert.deepEqual(await rows(), ['both:true', 'left:false', 'stopped:true']);
        const [version] = await q.query<{ v: number | null }>(
          'SELECT left_version AS v FROM late_refusal_grace WHERE sensor_id = $1',
          [both],
        );
        assert.equal(version?.v, 24);

        // Back: only what 067's build reads as "no longer left" is kept, with its time, and
        // the column is as it was, so that build's insert works and a NULL time is refused.
        await all.down(1);
        assert.deepEqual(await rows(), ['stopped:true']);
        await assert.rejects(
          q.query('SELECT left_version FROM late_refusal_grace'),
          /column "left_version" does not exist/,
        );
        await assert.rejects(
          q.query(
            'INSERT INTO late_refusal_grace (probe_id, sensor_id, stopped_at) VALUES ($1, $2, NULL)',
            [probe, left],
          ),
          /null value in column "stopped_at"/,
        );
        await q.query(
          'INSERT INTO late_refusal_grace (probe_id, sensor_id, stopped_at) VALUES ($1, $2, now())',
          [probe, left],
        );

        // And forward again over rows 067's build wrote: each is a window and nothing else.
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [68],
        );
        assert.deepEqual(await rows(), ['left:true', 'stopped:true']);
        const versions = await q.query<{ v: number | null }>(
          'SELECT left_version AS v FROM late_refusal_grace',
        );
        assert.deepEqual(
          versions.map((row) => row.v),
          [null, null],
        );
      } finally {
        await fresh.drop();
      }
    });

    it('keeps what each probe’s protocol version has done, one row a probe that goes with it, and rolls back to nothing (069)', async () => {
      // `A-72`: the version a probe's last configuration was built for, the run of changes that
      // ended in it, and from its second change the floor the configurations are judged at.
      const fresh = await createScratchDatabase('probe_protocol_flap');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 69),
        );
        await all.up();
        const q = fresh.db;
        assert.equal(await tableExists(q, 'probe_protocol_flap'), true);
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const insert = async (kind: string, name: string, parent: string): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id::text',
            [parent, kind, name],
          );
          return row?.id ?? assert.fail('no row');
        };
        const probe = await insert('probe', 'probe', root?.id ?? '');
        const other = await insert('probe', 'other', root?.id ?? '');
        const put = (probeId: string, values: string): Promise<unknown> =>
          q.query(
            `INSERT INTO probe_protocol_flap
               (probe_id, version, changed_at, run_since, run_changes, flap_floor)
             VALUES ($1, ${values})`,
            [probeId],
          );
        const probes = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT probe_id::text || ':' || version::text || ':' || run_changes::text AS line
               FROM probe_protocol_flap ORDER BY probe_id`,
            )
          ).map((row) => row.line);

        // A version with no run; a first change; a flap.
        await put(probe, '24, NULL, NULL, 0, NULL');
        await q.query('DELETE FROM probe_protocol_flap');
        await put(probe, `23, now(), now(), 1, NULL`);
        await q.query('DELETE FROM probe_protocol_flap');
        await put(probe, `24, now(), now() - interval '3 minutes', 2, 23`);
        await put(other, '27, NULL, NULL, 0, NULL');
        assert.deepEqual(await probes(), [`${probe}:24:2`, `${other}:27:0`]);
        await assert.rejects(put(probe, '24, NULL, NULL, 0, NULL'), /probe_protocol_flap_pkey/);

        const refused: [string, RegExp][] = [
          ['0, NULL, NULL, 0, NULL', /probe_protocol_flap_version_check/],
          ['24, now(), NULL, 1, NULL', /probe_protocol_flap_run/],
          ['24, NULL, NULL, 1, NULL', /probe_protocol_flap_run/],
          ['24, now(), now(), 0, NULL', /probe_protocol_flap_run/],
          [`24, now() - interval '1 minute', now(), 1, NULL`, /probe_protocol_flap_run/],
          ['24, now(), now(), 2, NULL', /probe_protocol_flap_floor/],
          ['24, now(), now(), 1, 23', /probe_protocol_flap_floor/],
          ['24, now(), now(), 2, 25', /probe_protocol_flap_floor/],
          ['24, now(), now(), 2, 0', /probe_protocol_flap_flap_floor_check/],
          ['24, now(), now(), -1, NULL', /probe_protocol_flap_run_changes_check/],
          [`24, 'infinity', now(), 1, NULL`, /probe_protocol_flap_changed_at_check/],
          [`24, now(), '-infinity', 1, NULL`, /probe_protocol_flap_run_since_check/],
        ];
        const third = await insert('probe', 'third', root?.id ?? '');
        for (const [values, why] of refused) {
          await assert.rejects(put(third, values), why, values);
        }
        await assert.rejects(put('999999', '24, NULL, NULL, 0, NULL'), /foreign key/);

        // A deleted probe takes its row.
        await q.query('DELETE FROM object WHERE id = $1', [other]);
        assert.deepEqual(await probes(), [`${probe}:24:2`]);

        await all.down(1);
        assert.equal(await tableExists(q, 'probe_protocol_flap'), false);
        assert.equal(await tableExists(q, 'late_refusal_grace'), true, 'and nothing else');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [69],
        );
        assert.deepEqual(await probes(), [], 'the record does not come back with the table');
      } finally {
        await fresh.drop();
      }
    });

    it('gives a device an exception to its probe’s target policy, bounded, and rolls back to none (070)', async () => {
      // `A-64`: on `device_config`, as the host is, so that nothing inherits it.
      const fresh = await createScratchDatabase('target_policy_exception');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 70),
        );
        await all.up();
        const q = fresh.db;
        const column = async (): Promise<boolean> =>
          (
            await q.query(
              `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'device_config' AND column_name = 'target_policy_exception'`,
            )
          ).length === 1;
        assert.equal(await column(), true);
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const [probe] = await q.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'probe')
           RETURNING id::text`,
          [root?.id],
        );
        const [device] = await q.query<{ id: string; version: number }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'device', 'bmc')
           RETURNING id::text, version`,
          [probe?.id],
        );
        const deviceId = device?.id ?? assert.fail('no device');
        // A device written as every existing write writes one has none.
        await q.query(`INSERT INTO device_config (object_id, host) VALUES ($1, '169.254.10.5')`, [
          deviceId,
        ]);
        const list = async (): Promise<string[]> =>
          (
            await q.query<{ list: string[] }>(
              'SELECT target_policy_exception AS list FROM device_config WHERE object_id = $1',
              [deviceId],
            )
          )[0]?.list ?? assert.fail('no row');
        assert.deepEqual(await list(), []);
        const version = async (): Promise<number> =>
          (
            await q.query<{ version: number }>('SELECT version FROM object WHERE id = $1', [
              deviceId,
            ])
          )[0]?.version ?? 0;
        const before = await version();
        const set = (value: string[] | null): Promise<unknown> =>
          q.query('UPDATE device_config SET target_policy_exception = $2 WHERE object_id = $1', [
            deviceId,
            value,
          ]);
        await set(['169.254.10.5', 'fe80::5']);
        assert.deepEqual(await list(), ['169.254.10.5', 'fe80::5']);
        assert.equal(await version(), before + 1, 'a change to it is a change to the device');

        await set(Array.from({ length: 16 }, (_, at) => `169.254.10.${String(at + 1)}`));
        await assert.rejects(
          set(Array.from({ length: 17 }, (_, at) => `169.254.10.${String(at + 1)}`)),
          /device_config_target_policy_exception_bounded/,
        );
        await assert.rejects(
          q.query(
            `UPDATE device_config SET target_policy_exception = ARRAY['169.254.10.5', NULL]
             WHERE object_id = $1`,
            [deviceId],
          ),
          /device_config_target_policy_exception_bounded/,
        );
        await assert.rejects(set(['']), /device_config_target_policy_exception_bounded/);
        await assert.rejects(set(null), /null value/);

        await all.down(1);
        assert.equal(await column(), false);
        assert.equal(await tableExists(q, 'probe_protocol_flap'), true, 'and nothing else');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [70],
        );
        assert.deepEqual(await list(), [], 'an exception does not come back with the column');
      } finally {
        await fresh.drop();
      }
    });

    it('keeps when a probe’s recorded version was accepted, never without a version, and rolls back to none (072)', async () => {
      // `U-32`: beside `protocol_version`, so the form can say when a probe that is down last
      // connected. `last_seen_at` moves on refused hellos too.
      const fresh = await createScratchDatabase('probe_protocol_accepted_at');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 72),
        );
        // A row from before, carried over: it has no time, and is not given `last_seen_at`'s.
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 70),
        ).up();
        const q = fresh.db;
        await q.query(
          `INSERT INTO probe_registration (gid, protocol_version, last_seen_at)
           VALUES ('before', 12, now()), ('never', 0, NULL)`,
        );
        await all.up();
        const column = async (): Promise<boolean> =>
          (
            await q.query(
              `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'probe_registration' AND column_name = 'protocol_accepted_at'`,
            )
          ).length === 1;
        assert.equal(await column(), true);
        const times = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT gid || ':' || coalesce(
                        to_char(protocol_accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'),
                        'null') AS line
               FROM probe_registration ORDER BY gid`,
            )
          ).map((row) => row.line);
        assert.deepEqual(await times(), ['before:null', 'never:null']);

        const set = (gid: string, at: string | null, version?: number): Promise<unknown> =>
          q.query(
            `UPDATE probe_registration
             SET protocol_accepted_at = $2::timestamptz,
                 protocol_version = coalesce($3::integer, protocol_version)
             WHERE gid = $1`,
            [gid, at, version ?? null],
          );
        await set('before', '2026-10-01T08:30:00Z');
        assert.deepEqual(await times(), ['before:2026-10-01 08:30', 'never:null']);
        // The refusal over the version writes both at once: a version with no time.
        await set('before', null, 0);
        await set('before', '2026-10-01T08:30:00Z', 12);

        const refused: [string, string | null, number | undefined][] = [
          ['never', '2026-10-01T08:30:00Z', undefined],
          ['before', '2026-10-01T08:30:00Z', 0],
          ['before', 'infinity', undefined],
          ['before', '-infinity', undefined],
        ];
        for (const [gid, at, version] of refused) {
          await assert.rejects(
            set(gid, at, version),
            /probe_registration_protocol_accepted_at_check/,
            `${gid} ${String(at)} ${String(version)}`,
          );
        }

        await all.down(1);
        assert.equal(await column(), false);
        assert.equal(
          await tableExists(q, 'probe_protocol_flap'),
          true,
          'and nothing else: 069 stays',
        );
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [72],
        );
        assert.deepEqual(
          await times(),
          ['before:null', 'never:null'],
          'a time does not come back with the column',
        );
      } finally {
        await fresh.drop();
      }
    });

    it('keeps when a probe’s recorded version was refused, never beside an accepted time, and rolls back to none (074)', async () => {
      // `U-35`: a refusal at 0 read as the `R-01` upgrade's "nothing recorded". The refusal's time
      // beside the version tells them apart, and is never beside the accepted one.
      const fresh = await createScratchDatabase('probe_protocol_refused_at');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 74),
        );
        // Rows from before: a refusal at 0 and an upgrade's 0 look alike, so neither is guessed.
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 73),
        ).up();
        const q = fresh.db;
        await q.query(
          `INSERT INTO probe_registration
             (gid, protocol_version, last_seen_at, protocol_accepted_at)
           VALUES ('accepted', 12, now(), now()), ('zero', 0, now(), NULL), ('never', 0, NULL, NULL)`,
        );
        await all.up();
        const column = async (): Promise<boolean> =>
          (
            await q.query(
              `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'probe_registration' AND column_name = 'protocol_refused_at'`,
            )
          ).length === 1;
        assert.equal(await column(), true);
        const times = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT gid || ':' || coalesce(
                        to_char(protocol_refused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'),
                        'null') AS line
               FROM probe_registration ORDER BY gid`,
            )
          ).map((row) => row.line);
        assert.deepEqual(await times(), ['accepted:null', 'never:null', 'zero:null']);

        const set = (gid: string, at: string | null, accepted?: string | null): Promise<unknown> =>
          q.query(
            `UPDATE probe_registration
             SET protocol_refused_at = $2::timestamptz,
                 protocol_accepted_at = CASE WHEN $3::boolean THEN $4::timestamptz
                                             ELSE protocol_accepted_at END
             WHERE gid = $1`,
            [gid, at, accepted !== undefined, accepted ?? null],
          );
        // Beside version 0: the case it exists for.
        await set('zero', '2026-10-07T06:00:00Z');
        // The refusal over a version writes all three at once: no accepted time beside it.
        await set('accepted', '2026-10-07T06:00:00Z', null);
        assert.deepEqual(await times(), [
          'accepted:2026-10-07 06:00',
          'never:null',
          'zero:2026-10-07 06:00',
        ]);
        // And an acceptance clears it as it writes its own.
        await q.query(
          `UPDATE probe_registration
           SET protocol_refused_at = NULL, protocol_accepted_at = '2026-10-07T07:00:00Z'
           WHERE gid = 'accepted'`,
        );

        const refused: [string, string, string | null | undefined][] = [
          ['accepted', '2026-10-07T06:00:00Z', undefined],
          ['zero', 'infinity', undefined],
          ['zero', '-infinity', undefined],
        ];
        for (const [gid, at, accepted] of refused) {
          await assert.rejects(
            set(gid, at, accepted),
            /probe_registration_protocol_refused_at_check/,
            `${gid} ${at}`,
          );
        }
        // An accepted time cannot be written beside a refusal either.
        await assert.rejects(
          q.query(
            `UPDATE probe_registration SET protocol_version = 12, protocol_accepted_at = now()
             WHERE gid = 'zero'`,
          ),
          /probe_registration_protocol_refused_at_check/,
        );

        await all.down(1);
        assert.equal(await column(), false);
        const accepted = await q.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM probe_registration
           WHERE protocol_accepted_at IS NOT NULL`,
        );
        assert.equal(accepted[0]?.n, 1, 'and nothing else: 072 stays');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [74],
        );
        assert.deepEqual(
          await times(),
          ['accepted:null', 'never:null', 'zero:null'],
          'a refusal does not come back with the column',
        );
      } finally {
        await fresh.drop();
      }
    });

    it('keeps one local probe of two, the approved one, and rolls back to the index gone (075)', async () => {
      // `P-382`: an approval only ever raised `is_local`, so an installation can hold two, and
      // Core Health's local-probe log read whichever came first.
      const fresh = await createScratchDatabase('one_local_probe');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 75),
        );
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 74),
        ).up();
        const q = fresh.db;
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const probes = new Map<string, string>();
        for (const name of ['seen', 'live', 'never', 'remote']) {
          const [probe] = await q.query<{ id: string }>(
            `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', $2) RETURNING id::text`,
            [root?.id, name],
          );
          probes.set(probe?.id ?? assert.fail('no probe'), name);
        }
        const idOf = (name: string): string =>
          [...probes].find(([, each]) => each === name)?.[0] ?? assert.fail(name);
        /** Each probe: its gid, whether it is local, and when it was last seen. */
        const lay = async (
          rows: [string, string | null, boolean, string | null][],
        ): Promise<void> => {
          for (const [name, gid, local, seen] of rows) {
            await q.query(
              `INSERT INTO probe_config (object_id, gid, is_local, last_seen_at)
               VALUES ($1, $2, $3, $4::timestamptz)
               ON CONFLICT (object_id) DO UPDATE
                 SET gid = EXCLUDED.gid, is_local = EXCLUDED.is_local,
                     last_seen_at = EXCLUDED.last_seen_at`,
              [idOf(name), gid, local, seen],
            );
          }
        };
        const local = async (): Promise<string[]> =>
          (
            await q.query<{ object_id: string }>(
              `SELECT object_id::text AS object_id FROM probe_config
               WHERE is_local ORDER BY probe_config.object_id`,
            )
          ).map((row) => probes.get(row.object_id) ?? row.object_id);

        // Three local: one seen last with nothing approved onto it, one approved and seen
        // earlier, one never seen. The approved one is the probe the core is talking to.
        await q.query(
          `INSERT INTO probe_registration (gid, status, object_id) VALUES ('live-gid', 'approved', $1)`,
          [idOf('live')],
        );
        await lay([
          ['seen', null, true, '2026-10-09T08:00:00Z'],
          ['live', 'live-gid', true, '2026-10-09T07:00:00Z'],
          ['never', null, true, null],
          ['remote', null, false, '2026-10-09T09:00:00Z'],
        ]);
        await all.up();
        assert.deepEqual(await local(), ['live']);
        await assert.rejects(
          q.query('UPDATE probe_config SET is_local = true WHERE object_id = $1', [idOf('seen')]),
          /probe_config_one_local/,
        );

        await all.down(1);
        assert.deepEqual(await local(), ['live'], 'what was cleared stays cleared');
        // Two again, and none approved now: the one seen last, then the lowest id.
        await q.query(`UPDATE probe_registration SET status = 'revoked'`);
        await lay([
          ['seen', null, true, '2026-10-09T08:00:00Z'],
          ['live', null, true, '2026-10-09T07:00:00Z'],
          ['never', null, true, null],
        ]);
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [75],
        );
        assert.deepEqual(await local(), ['seen']);

        await all.down(1);
        await lay([
          ['seen', null, true, null],
          ['live', null, true, null],
          ['never', null, false, null],
        ]);
        await all.up();
        assert.deepEqual(await local(), ['seen'], 'the lowest id, when nothing tells them apart');
      } finally {
        await fresh.drop();
      }
    });

    it('binds a probe to one certificate fingerprint, with its time, and rolls back to none (078)', async () => {
      // `P-326`: the SHA-256 of the client certificate a probe enrolled with, upper-case colon hex
      // as Node's `fingerprint256` writes it, and the time it was bound — both or neither.
      const fresh = await createScratchDatabase('probe_certificate');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 78),
        );
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 77),
        ).up();
        const q = fresh.db;
        await q.query(`INSERT INTO probe_registration (gid) VALUES ('before')`);
        await all.up();
        const columns = async (): Promise<string[]> =>
          (
            await q.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns
               WHERE table_name = 'probe_registration' AND column_name LIKE 'cert%' ORDER BY 1`,
            )
          ).map((row) => row.name);
        assert.deepEqual(await columns(), ['cert_bound_at', 'cert_fingerprint']);
        const bound = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT gid || ':' || coalesce(cert_fingerprint, 'null') || ':' ||
                      (cert_bound_at IS NOT NULL)::text AS line
               FROM probe_registration ORDER BY gid`,
            )
          ).map((row) => row.line);
        assert.deepEqual(await bound(), ['before:null:false'], 'a row from before is unbound');

        const fingerprint = Array.from({ length: 32 }, (_, i) =>
          (i * 7).toString(16).padStart(2, '0').toUpperCase(),
        ).join(':');
        const set = (value: string | null, at: string | null): Promise<unknown> =>
          q.query(
            `UPDATE probe_registration SET cert_fingerprint = $1, cert_bound_at = $2::timestamptz
             WHERE gid = 'before'`,
            [value, at],
          );
        await set(fingerprint, '2026-10-12T06:00:00Z');
        assert.deepEqual(await bound(), [`before:${fingerprint}:true`]);

        const refused: [string | null, string | null, RegExp][] = [
          [fingerprint.toLowerCase(), '2026-10-12T06:00:00Z', /cert_fingerprint_check/],
          [fingerprint.replaceAll(':', ''), '2026-10-12T06:00:00Z', /cert_fingerprint_check/],
          [fingerprint.slice(3), '2026-10-12T06:00:00Z', /cert_fingerprint_check/],
          [fingerprint, null, /cert_bound_at_check/],
          [null, '2026-10-12T06:00:00Z', /cert_bound_at_check/],
        ];
        for (const [value, at, why] of refused) {
          await assert.rejects(set(value, at), why, `${value ?? 'null'} ${at ?? 'null'}`);
        }
        await set(null, null);
        assert.deepEqual(await bound(), ['before:null:false'], 'and cleared, both go');

        await set(fingerprint, '2026-10-12T06:00:00Z');
        await all.down(1);
        assert.deepEqual(await columns(), []);
        assert.equal(await tableExists(q, 'startup_pass'), true, 'and nothing else: 077 stays');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [78],
        );
        assert.deepEqual(
          await bound(),
          ['before:null:false'],
          'a binding does not come back with the columns',
        );
      } finally {
        await fresh.drop();
      }
    });

    it('marks no channel that exists, indexes only the marked, and rolls back to no mark (079)', async () => {
      // `P-312`: which rows a fallback wrote was never recorded, so a row from before is unmarked.
      const fresh = await createScratchDatabase('channel_undeclared');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 79),
        );
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 78),
        ).up();
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
        const sensorId = await insert('sensor', 'sensor', device);
        await q.query(
          `INSERT INTO channel (sensor_id, key, name) VALUES ($1, 'before', 'Before')`,
          [sensorId],
        );
        await all.up();
        const marks = async (): Promise<string[]> =>
          (
            await q.query<{ line: string }>(
              `SELECT key || ':' || undeclared::text AS line FROM channel ORDER BY key`,
            )
          ).map((row) => row.line);
        assert.deepEqual(await marks(), ['before:false']);
        await q.query(
          `INSERT INTO channel (sensor_id, key, name, undeclared) VALUES ($1, 'after', 'After', true)`,
          [sensorId],
        );
        assert.deepEqual(await marks(), ['after:true', 'before:false']);
        await assert.rejects(
          q.query(`UPDATE channel SET undeclared = NULL WHERE key = 'after'`),
          /null value/,
        );
        const index = async (): Promise<string[]> =>
          (
            await q.query<{ def: string }>(
              `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'channel_undeclared_idx'`,
            )
          ).map((row) => row.def);
        const [def] = await index();
        assert.match(def ?? '', /\(sensor_id\) WHERE undeclared/);

        await all.down(1);
        assert.deepEqual(await index(), []);
        const column = await q.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'channel' AND column_name = 'undeclared'`,
        );
        assert.equal(column.length, 0);
        assert.deepEqual(await marks().catch(() => 'gone'), 'gone', 'the column went with it');
        assert.equal(await tableExists(q, 'probe_registration'), true, 'and nothing else');
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [79],
        );
        assert.deepEqual(await marks(), ['after:false', 'before:false'], 'no mark comes back');
      } finally {
        await fresh.drop();
      }
    });

    it('dates a sensor’s parameters apart from its other writes, from its last change, and rolls back to none (080)', async () => {
      // `P-340`: `updated_at` moved on a voucher write, and `retired` and `P-321`’s minute read it.
      const fresh = await createScratchDatabase('sensor_params_changed_at');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 80),
        );
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 79),
        ).up();
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
        const sensor = await insert('sensor', 'sensor', device);
        await q.query(
          `INSERT INTO sensor_config (object_id, type, params, updated_at)
           VALUES ($1, 'ping', '{"count": 3}', '2026-10-01T06:00:00Z')`,
          [sensor],
        );
        const versionBefore = await q.query<{ version: number }>(
          'SELECT version FROM object WHERE id = $1',
          [sensor],
        );
        await all.up();

        const times = async (): Promise<{ updated: string; changed: string }> => {
          const [row] = await q.query<{ updated: string; changed: string }>(
            `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS updated,
                    to_char(params_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS changed
             FROM sensor_config WHERE object_id = $1`,
            [sensor],
          );
          return row ?? assert.fail('no sensor_config');
        };
        // Backfilled from `updated_at`, which the backfill itself did not move, nor the version.
        assert.deepEqual(await times(), {
          updated: '2026-10-01 06:00:00.000000',
          changed: '2026-10-01 06:00:00.000000',
        });
        assert.deepEqual(
          await q.query('SELECT version FROM object WHERE id = $1', [sensor]),
          versionBefore,
          'no open form is refused for the migration',
        );

        // A write that changes no parameter: `updated_at` moves, the new column does not, even
        // when the write names it.
        // A voucher that really changes, as an account's edit records one over the installation's.
        await q.query(`UPDATE sensor_config SET vouched_by = 'account' WHERE object_id = $1`, [
          sensor,
        ]);
        assert.equal(
          (await times()).changed,
          '2026-10-01 06:00:00.000000',
          'a voucher is no change',
        );
        // And the row's own triggers are back on after the backfill: the write moved the version.
        const [moved] = await q.query<{ version: number }>(
          'SELECT version FROM object WHERE id = $1',
          [sensor],
        );
        assert.ok((moved?.version ?? 0) > (versionBefore[0]?.version ?? 0), 'the ETag still moves');
        assert.deepEqual(
          await q.query(
            `SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
             WHERE tgrelid = 'sensor_config'::regclass
               AND tgname IN ('sensor_config_set_updated_at', 'sensor_config_touch_owner')
             ORDER BY tgname`,
          ),
          [
            { name: 'sensor_config_set_updated_at', enabled: 'O' },
            { name: 'sensor_config_touch_owner', enabled: 'O' },
          ],
        );
        await q.query(
          `UPDATE sensor_config SET params = '{"count": 3}'::jsonb,
                                    params_changed_at = '2030-01-01T00:00:00Z'
           WHERE object_id = $1`,
          [sensor],
        );
        const unchanged = await times();
        assert.notEqual(unchanged.updated, '2026-10-01 06:00:00.000000');
        assert.equal(unchanged.changed, '2026-10-01 06:00:00.000000');

        // A change of parameters, or of type, moves it to the change's time.
        for (const write of [
          `UPDATE sensor_config SET params = '{"count": 4}'::jsonb WHERE object_id = $1`,
          `UPDATE sensor_config SET type = 'ping.renamed' WHERE object_id = $1`,
        ]) {
          // The database's clock past the last change, so a new time is a different one.
          await q.query('SELECT pg_sleep(0.002)');
          const before = (await times()).changed;
          await q.query(write, [sensor]);
          const after = await times();
          assert.notEqual(after.changed, before, write);
          assert.equal(after.changed, after.updated, write);
        }
        // A new row is dated by its insert.
        const second = await insert('sensor', 'second', device);
        await q.query(`INSERT INTO sensor_config (object_id, type) VALUES ($1, 'ping')`, [second]);
        const [inserted] = await q.query<{ same: boolean }>(
          'SELECT params_changed_at = created_at AS same FROM sensor_config WHERE object_id = $1',
          [second],
        );
        assert.equal(inserted?.same, true);

        await all.down(1);
        const column = await q.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'sensor_config' AND column_name = 'params_changed_at'`,
        );
        assert.equal(column.length, 0);
        const fn = await q.query(
          `SELECT 1 FROM pg_proc WHERE proname = 'sensor_config_params_changed'`,
        );
        assert.equal(fn.length, 0);
        assert.equal(
          (await q.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'channel_undeclared_idx'`))
            .length,
          1,
          'and nothing else: 079 stays',
        );
        await q.query(
          `UPDATE sensor_config SET params = '{"count": 5}'::jsonb WHERE object_id = $1`,
          [sensor],
        );
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [80],
        );
        const back = await times();
        assert.equal(back.changed, back.updated, 'backfilled again from the last write');
      } finally {
        await fresh.drop();
      }
    });

    it('keeps where a check failed beside its message, both or neither, and rolls back to none (081)', async () => {
      // `P-285`: a failed check's phase and host, as fields on the current state and on each
      // transition. Nullable, never backfilled from the prose, and a target never alone.
      const fresh = await createScratchDatabase('failure_phase');
      try {
        const all = migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 81),
        );
        await migrator(
          fresh.db,
          MIGRATIONS.filter((one) => one.id <= 80),
        ).up();
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
        const sensor = await insert('sensor', 'sensor', device);
        await q.query(`INSERT INTO sensor_config (object_id, type) VALUES ($1, 'ssh.load')`, [
          sensor,
        ]);
        await q.query(
          `UPDATE sensor_runtime SET state = 'down', message = 'the connection was lost while running uptime'
           WHERE object_id = $1`,
          [sensor],
        );
        await q.query(
          `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
           VALUES ('2026-10-17T08:00:00Z', $1, 'down', 'up', 'scan', 'the connection was lost')`,
          [sensor],
        );
        await all.up();

        const stored = async (): Promise<unknown[]> => [
          ...(await q.query(
            'SELECT failure_phase, failure_target FROM sensor_runtime WHERE object_id = $1',
            [sensor],
          )),
          ...(await q.query(
            'SELECT failure_phase, failure_target FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
            [sensor],
          )),
        ];
        // Not named, on every row before it: nothing is read back out of the prose.
        assert.deepEqual(await stored(), [
          { failure_phase: null, failure_target: null },
          { failure_phase: null, failure_target: null },
        ]);

        await q.query(
          `UPDATE sensor_runtime SET failure_phase = 'exec', failure_target = '192.0.2.7:22'
           WHERE object_id = $1`,
          [sensor],
        );
        await q.query(
          `INSERT INTO sensor_state
             (time, sensor_id, state, previous_state, cause, message, failure_phase)
           VALUES ('2026-10-17T08:05:00Z', $1, 'warning', 'down', 'scan', 'timed out', 'timeout')`,
          [sensor],
        );
        assert.deepEqual(await stored(), [
          { failure_phase: 'exec', failure_target: '192.0.2.7:22' },
          { failure_phase: null, failure_target: null },
          { failure_phase: 'timeout', failure_target: null },
        ]);

        // Refused by both tables: a target with no phase, and either past the wire's bounds.
        for (const [phase, target] of [
          [null, '192.0.2.7'],
          ['', null],
          ['p'.repeat(33), null],
          ['exec', ''],
          ['exec', 't'.repeat(256)],
        ] as const) {
          await assert.rejects(
            q.query(
              'UPDATE sensor_runtime SET failure_phase = $2, failure_target = $3 WHERE object_id = $1',
              [sensor, phase, target],
            ),
            /violates check constraint "sensor_runtime_failure_ck"/,
            `${String(phase)} / ${String(target)}`,
          );
          await assert.rejects(
            q.query(
              `INSERT INTO sensor_state
                 (time, sensor_id, state, cause, message, failure_phase, failure_target)
               VALUES ('2026-10-17T09:00:00Z', $1, 'down', 'scan', '', $2, $3)`,
              [sensor, phase, target],
            ),
            /violates check constraint "sensor_state_failure_ck"/,
            `${String(phase)} / ${String(target)}`,
          );
        }

        await all.down(1);
        const columns = await q.query(
          `SELECT table_name, column_name FROM information_schema.columns
           WHERE table_name IN ('sensor_runtime', 'sensor_state')
             AND column_name IN ('failure_phase', 'failure_target')`,
        );
        assert.deepEqual(columns, []);
        const checks = await q.query(
          `SELECT conname FROM pg_constraint
           WHERE conname IN ('sensor_runtime_failure_ck', 'sensor_state_failure_ck')`,
        );
        assert.deepEqual(checks, []);
        assert.equal(
          (
            await q.query(
              `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'sensor_config' AND column_name = 'params_changed_at'`,
            )
          ).length,
          1,
          'and nothing else: 080 stays',
        );
        // The rows stay, with their messages: the prose still says it.
        assert.deepEqual(
          await q.query('SELECT message FROM sensor_state WHERE sensor_id = $1 ORDER BY time', [
            sensor,
          ]),
          [{ message: 'the connection was lost' }, { message: 'timed out' }],
        );
        const again = await all.up();
        assert.deepEqual(
          again.applied.map((one) => one.id),
          [81],
        );
        assert.deepEqual(await stored(), [
          { failure_phase: null, failure_target: null },
          { failure_phase: null, failure_target: null },
          { failure_phase: null, failure_target: null },
        ]);
      } finally {
        await fresh.drop();
      }
    });

    it('runs a data step after `up` and before the record, and runs both again after the step fails (N-28)', async () => {
      const fresh = await createScratchDatabase('data_step');
      try {
        let calls = 0;
        let fail = true;
        const step: Migration = {
          id: 9003,
          name: 'data-step',
          transactional: false,
          up: 'CREATE TABLE IF NOT EXISTS data_thing (id int PRIMARY KEY, done boolean NOT NULL)',
          data: async ({ db }) => {
            calls += 1;
            // Into the table `up` made, so the step ran after it.
            await db.query('INSERT INTO data_thing VALUES (1, false) ON CONFLICT DO NOTHING');
            if (fail) throw new Error('half way through');
            await db.query('UPDATE data_thing SET done = true');
          },
          down: 'DROP TABLE data_thing',
        };
        const m = migrator(fresh.db, [step]);
        await assert.rejects(
          m.up(),
          (error: unknown) =>
            error instanceof MigrationError &&
            /migration 9003 \(data-step\) failed: half way through/u.test(error.message),
        );
        const status = await m.status();
        assert.deepEqual(
          status.pending.map((one) => one.id),
          [9003],
          'a step that fails leaves its migration unrecorded',
        );
        const rows = (): Promise<{ done: boolean }[]> =>
          fresh.db.query<{ done: boolean }>('SELECT done FROM data_thing');
        assert.deepEqual(await rows(), [{ done: false }], 'and what it committed stays');

        fail = false;
        const { applied } = await m.up();
        assert.deepEqual(
          applied.map((one) => one.id),
          [9003],
        );
        assert.equal(calls, 2);
        assert.deepEqual(await rows(), [{ done: true }]);
        assert.deepEqual((await m.up()).applied, [], 'and once recorded, it is not run again');
        assert.equal(calls, 2);

        await m.down(1);
        assert.equal(await tableExists(fresh.db, 'data_thing'), false);
      } finally {
        await fresh.drop();
      }
    });

    it('refuses a data step on a migration that runs in one transaction (N-28)', () => {
      assert.throws(
        () =>
          migrator(scratch.db, [
            {
              id: 9004,
              name: 'data-in-a-transaction',
              up: 'SELECT 1',
              down: null,
              data: () => Promise.resolve(),
            },
          ]),
        (error: unknown) =>
          error instanceof MigrationError && /must not be transactional/u.test(error.message),
      );
    });

    it('rewrites every delivery error as legible() writes it, window by window, and leaves the rows as they are on the way back (071)', async () => {
      // `N-28`: rows written before `N-24` kept the far end's controls, overrides and invisible
      // characters, and nothing deletes them. The rewrite calls `legible()` itself.
      const fresh = await createScratchDatabase('legible_errors');
      try {
        const q = fresh.db;
        const all = migrator(
          q,
          MIGRATIONS.filter((one) => one.id <= 71),
        );
        await migrator(
          q,
          MIGRATIONS.filter((one) => one.id <= 70),
        ).up();
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const insert = async (kind: string, name: string, parent: string): Promise<string> => {
          const [row] = await q.query<{ id: string }>(
            'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id::text',
            [parent, kind, name],
          );
          return row?.id ?? assert.fail('no row');
        };
        const probe = await insert('probe', 'probe', root?.id ?? '');
        const sensor = await insert('sensor', 'sensor', await insert('device', 'device', probe));

        // Ids far apart, so that the rewrite has to walk windows with nothing in them to reach
        // the rows beyond, and the first and last ids of a window.
        const stored: readonly (readonly [number, string | null])[] = [
          [1, '\u{1b}[2J\u{1b}[31mrefused'],
          [2, 'relay refused the message: 550 no such mailbox'],
          [3, null],
          [10_000, 'a\u{85}b\u{9b}c'],
          [10_001, 'all good\rFAILED\r\nnext line'],
          [25_000, 'invoice\u{202e}txt.exe and \u{2066}isolated\u{2069}'],
          [40_000, 're\u{200b}fused \u{feff}503 ok\u{e0041}\u{e007f}'],
          [40_001, 'line one\n\tline two'],
          [55_555, 'down \u{2764}\u{fe0f} \u{1f468}\u{200d}\u{1f469} می\u{200c}خواهم'],
          [70_000, 'ok\u{e0168}\u{e0165}\u{e016c} r\u{fe0f}'],
          [70_001, 'bad\\u0000request, escaped already'],
          [99_999, 'ad\u{200d}min \u{115f}x'],
        ];
        for (const [id, lastError] of stored) {
          await q.query(
            `INSERT INTO notification_request
               (id, at, sensor_id, trigger_kind, reason, state, status, last_error)
             VALUES ($1, now(), $2, 'state', 'initial', 'down', 'failed', $3)`,
            [id, sensor, lastError],
          );
        }
        const read = async (): Promise<Map<number, { text: string | null; xmin: string }>> =>
          new Map(
            (
              await q.query<{ id: string; last_error: string | null; xmin: string }>(
                'SELECT id::text AS id, last_error, xmin::text AS xmin FROM notification_request',
              )
            ).map((row) => [Number(row.id), { text: row.last_error, xmin: row.xmin }]),
          );
        const written = await read();

        assert.deepEqual(
          (await all.up()).applied.map((one) => one.id),
          [71],
        );
        const rewritten = await read();
        let changed = 0;
        for (const [id, original] of stored) {
          const now = rewritten.get(id) ?? assert.fail(`row ${String(id)} gone`);
          const expected = original === null ? null : legible(original);
          assert.equal(now.text, expected, `row ${String(id)}`);
          if (expected === original) {
            assert.equal(now.xmin, written.get(id)?.xmin, `row ${String(id)} is not written`);
          } else {
            changed += 1;
            assert.notEqual(now.xmin, written.get(id)?.xmin);
          }
        }
        // Presence: the rows that needed it, in every window they are in, the last one too.
        assert.equal(changed, 7);
        assert.equal(rewritten.get(99_999)?.text, 'ad\\u200dmin \\u115fx');
        assert.equal(
          rewritten.get(55_555)?.text,
          stored[8]?.[1],
          'an emoji with its VS16, a family and a Persian joiner are left as they are',
        );
        const comment = async (): Promise<string | null> =>
          (
            await q.query<{ comment: string | null }>(
              `SELECT col_description('notification_request'::regclass, attnum) AS comment
                 FROM pg_attribute
                WHERE attrelid = 'notification_request'::regclass AND attname = 'last_error'`,
            )
          )[0]?.comment ?? null;
        assert.match((await comment()) ?? '', /migration 071/u);

        // The way back cannot restore what was replaced, and leaves the rows as they are.
        assert.deepEqual(
          (await all.down(1)).reverted.map((one) => one.id),
          [71],
        );
        assert.equal(await comment(), null);
        assert.deepEqual(await read(), rewritten);
        // And forward again rewrites nothing: legible text is what `legible()` leaves alone.
        await all.up();
        assert.deepEqual(await read(), rewritten);
      } finally {
        await fresh.drop();
      }
    });

    it('keeps a delivery error written between its read and its rewrite (071)', async () => {
      const fresh = await createScratchDatabase('legible_race');
      try {
        const q = fresh.db;
        await migrator(
          q,
          MIGRATIONS.filter((one) => one.id <= 71),
        ).up();
        const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
        const [probe] = await q.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'p') RETURNING id::text`,
          [root?.id],
        );
        const [device] = await q.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'device', 'd') RETURNING id::text`,
          [probe?.id],
        );
        const [sensor] = await q.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'sensor', 's') RETURNING id::text`,
          [device?.id],
        );
        for (const id of [1, 2, 3, 4, 5]) {
          await q.query(
            `INSERT INTO notification_request
               (id, at, sensor_id, trigger_kind, reason, state, status, last_error)
             VALUES ($1, now(), $2, 'state', 'initial', 'down', 'failed', $3)`,
            [id, sensor?.id, `refused\u{1b}[31m ${String(id)}`],
          );
        }
        // The dispatcher writes row 2 again just before its window's update.
        let raced = false;
        const racing: Queryable = {
          query: async <T extends QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<T[]> => {
            if (!raced && text.includes('UPDATE notification_request')) {
              raced = true;
              await q.query(`UPDATE notification_request SET last_error = 'newer' WHERE id = 2`);
            }
            return q.query<T>(text, values);
          },
        };
        // Windows of two: 1–2, 3–4, 5.
        assert.equal(await rewriteDeliveryErrors(racing, 2), 4);
        const rows = await q.query<{ id: string; last_error: string }>(
          'SELECT id::text AS id, last_error FROM notification_request ORDER BY id',
        );
        assert.deepEqual(
          rows.map((row) => [row.id, row.last_error]),
          [
            ['1', 'refused\\u001b[31m 1'],
            ['2', 'newer'],
            ['3', 'refused\\u001b[31m 3'],
            ['4', 'refused\\u001b[31m 4'],
            ['5', 'refused\\u001b[31m 5'],
          ],
        );
      } finally {
        await fresh.drop();
      }
    });

    it('sends the rewrite every row outside printable ASCII, and only those (071)', async () => {
      // The candidate filter is exact only if PostgreSQL ranges by code point, and `legible()`
      // leaves printable ASCII alone: both, over every code point a text can hold.
      const [row] = await scratch.db.query<{ wrong: number; ascii: number }>(
        `SELECT count(*) FILTER (WHERE (c BETWEEN 32 AND 126) = (chr(c) ~ $1))::int AS wrong,
                count(*) FILTER (WHERE NOT chr(c) ~ $1)::int AS ascii
           FROM generate_series(1, 1114111) AS c
          WHERE c < 55296 OR c > 57343`,
        [LEGIBLE_CANDIDATE],
      );
      assert.deepEqual(row, { wrong: 0, ascii: 95 });
      const printable = Array.from({ length: 95 }, (_, at) => String.fromCharCode(32 + at)).join(
        '',
      );
      assert.equal(legible(printable), printable);
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
        await pollWithin(
          10_000,
          () => `three reports, one at once and one on every interval; got ${String(waits.length)}`,
          () => waits.length >= 3,
          25,
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
