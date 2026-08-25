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
