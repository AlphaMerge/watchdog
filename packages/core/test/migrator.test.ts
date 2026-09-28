import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator, MigrationError } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import type { Migration } from '../src/db/migrations/types.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
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
          error instanceof MigrationError && /newer than this build/.test(error.message),
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
