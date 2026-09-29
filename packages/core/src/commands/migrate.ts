import { describeError, type CoreConfig, type Logger } from '@ms/shared';
import { Database } from '../db/pool.js';
import { Migrator } from '../db/migrator.js';
import { MIGRATIONS } from '../db/migrations/index.js';

export type MigrateAction = 'up' | 'down' | 'status';

export interface MigrateOptions {
  action: MigrateAction;
  /** How many migrations `down` reverts. Deliberately one by default. */
  steps: number;
  /** Only the database section is read, so a test can pass one without a whole core's config. */
  config: Pick<CoreConfig, 'database'>;
  logger: Logger;
  write: (line: string) => void;
}

/**
 * `ms-core migrate up|down|status`.
 *
 * Operators need to run migrations deliberately — before a maintenance window, or when
 * `autoMigrate` is off — and to see what is pending without applying anything.
 */
export async function runMigrateCommand(options: MigrateOptions): Promise<number> {
  const { action, config, logger, write } = options;
  const db = new Database({ config: config.database, logger });

  try {
    const migrator = new Migrator({ db, logger, migrations: MIGRATIONS });

    if (action === 'status') {
      const status = await migrator.status();
      write(`database: ${db.description}`);
      write(`applied:  ${String(status.applied.length)}`);
      for (const row of status.applied) {
        write(
          `  [x] ${String(row.id).padStart(4, '0')} ${row.name}  ${row.appliedAt.toISOString()}`,
        );
      }
      write(`pending:  ${String(status.pending.length)}`);
      for (const migration of status.pending) {
        write(`  [ ] ${String(migration.id).padStart(4, '0')} ${migration.name}`);
      }

      if (status.drifted.length > 0) {
        write('');
        write('DRIFT: these applied migrations have been edited since they were applied:');
        // Both checksums, so the version that was applied can be told from this build's (`P-238`).
        for (const row of status.drifted) {
          write(`  !!! ${String(row.id).padStart(4, '0')} ${row.name}`);
          write(`        applied:    ${row.appliedChecksum}`);
          write(`        this build: ${row.currentChecksum}`);
        }
        return 1;
      }
      if (status.unknown.length > 0) {
        write('');
        write('The database has migrations this build does not define — it is newer than ms-core:');
        for (const row of status.unknown) {
          write(`  ??? ${String(row.id).padStart(4, '0')} ${row.name}`);
        }
        return 1;
      }
      return 0;
    }

    if (action === 'up') {
      const { applied } = await migrator.up();
      if (applied.length === 0) {
        write('schema is already up to date');
        return 0;
      }
      for (const migration of applied) {
        write(`applied ${String(migration.id).padStart(4, '0')} ${migration.name}`);
      }
      return 0;
    }

    const { reverted } = await migrator.down(options.steps);
    if (reverted.length === 0) {
      write('nothing to roll back');
      return 0;
    }
    for (const migration of reverted) {
      write(`reverted ${String(migration.id).padStart(4, '0')} ${migration.name}`);
    }
    return 0;
  } catch (error) {
    const described = describeError(error);
    write(`migration command failed: ${described.message}`);
    logger.error({ err: described }, 'migration command failed');
    return 1;
  } finally {
    await db.close();
  }
}
