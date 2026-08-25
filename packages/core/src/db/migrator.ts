import { createHash } from 'node:crypto';
import { AppError, describeError, type Logger } from '@ms/shared';
import type { Database } from './pool.js';
import type { Migration } from './migrations/types.js';

export class MigrationError extends AppError {
  constructor(
    message: string,
    options: { context?: Record<string, string | number>; cause?: unknown },
  ) {
    // "migration 3 (timeseries) failed" tells an operator nothing they can act on. The reason
    // — a missing extension, a constraint, a syntax error — is in the cause, and PostgreSQL's
    // HINT is often the whole answer, so both travel with the message.
    const detail = describeCause(options.cause);
    super('MIGRATION_FAILED', `${message}${detail}`, {
      context: options.context ?? {},
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'MigrationError';
  }
}

function describeCause(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const pg = cause as { message?: string; hint?: string; detail?: string };
  if (typeof pg.message !== 'string') return '';
  const hint = typeof pg.hint === 'string' && pg.hint !== '' ? `\n  hint: ${pg.hint}` : '';
  const detail =
    typeof pg.detail === 'string' && pg.detail !== '' ? `\n  detail: ${pg.detail}` : '';
  return `: ${pg.message}${detail}${hint}`;
}

export interface AppliedMigration {
  id: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
  /** Applied migrations whose definition has since changed — always a mistake. */
  drifted: { id: number; name: string; appliedChecksum: string; currentChecksum: string }[];
  /** Applied migrations this build knows nothing about — the binary is older than the schema. */
  unknown: AppliedMigration[];
}

const LOCK_KEY = 4_919_201_5; // arbitrary but fixed: advisory lock namespace for schema changes

function checksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${String(migration.id)}\n${migration.name}\n${migration.up}`)
    .digest('hex');
}

/**
 * Forward and backward schema migrations.
 *
 * Two properties matter more than features. First, **one writer**: an advisory lock means two
 * cores starting at once cannot both migrate. Second, **no silent drift**: an applied migration
 * whose text has changed is reported rather than ignored, because the schema on disk and the
 * schema in the repository disagreeing is how upgrades corrupt data.
 */
export class Migrator {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #migrations: readonly Migration[];

  constructor(options: { db: Database; logger: Logger; migrations: readonly Migration[] }) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'migrator' });
    this.#migrations = [...options.migrations].sort((a, b) => a.id - b.id);

    const seen = new Set<number>();
    for (const migration of this.#migrations) {
      if (seen.has(migration.id)) {
        throw new MigrationError('duplicate migration id', { context: { id: migration.id } });
      }
      seen.add(migration.id);
    }
  }

  async ensureBookkeeping(): Promise<void> {
    await this.#db.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        id          integer     PRIMARY KEY,
        name        text        NOT NULL,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async status(): Promise<MigrationStatus> {
    await this.ensureBookkeeping();

    const rows = await this.#db.query<{
      id: number;
      name: string;
      checksum: string;
      applied_at: Date;
    }>('SELECT id, name, checksum, applied_at FROM schema_migration ORDER BY id');

    const applied: AppliedMigration[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
    const appliedById = new Map(applied.map((row) => [row.id, row]));
    const knownIds = new Set(this.#migrations.map((m) => m.id));

    const drifted: MigrationStatus['drifted'] = [];
    for (const migration of this.#migrations) {
      const record = appliedById.get(migration.id);
      if (record === undefined) continue;
      const current = checksum(migration);
      if (record.checksum !== current) {
        drifted.push({
          id: migration.id,
          name: migration.name,
          appliedChecksum: record.checksum,
          currentChecksum: current,
        });
      }
    }

    return {
      applied,
      pending: this.#migrations.filter((m) => !appliedById.has(m.id)),
      drifted,
      unknown: applied.filter((row) => !knownIds.has(row.id)),
    };
  }

  /** Applies every pending migration, in order, under an advisory lock. */
  async up(): Promise<{ applied: Migration[] }> {
    return this.#withLock(async () => {
      const status = await this.status();
      this.#refuseOnDrift(status);

      if (status.unknown.length > 0) {
        // The database has been migrated by a newer build. Going forward is not our call.
        throw new MigrationError(
          'the database schema is newer than this build; upgrade ms-core or restore a matching backup',
          {
            context: {
              unknownIds: status.unknown.map((row) => row.id).join(','),
              buildKnows: this.#migrations.length,
            },
          },
        );
      }

      if (status.pending.length === 0) {
        this.#logger.debug({ applied: status.applied.length }, 'schema is up to date');
        return { applied: [] };
      }

      const applied: Migration[] = [];
      for (const migration of status.pending) {
        await this.#apply(migration);
        applied.push(migration);
      }
      this.#logger.info(
        { count: applied.length, throughId: applied.at(-1)?.id ?? null },
        'schema migrations applied',
      );
      return { applied };
    });
  }

  /** Rolls back the most recently applied migrations, newest first. */
  async down(count = 1): Promise<{ reverted: Migration[] }> {
    return this.#withLock(async () => {
      const status = await this.status();
      this.#refuseOnDrift(status);

      const appliedDescending = [...status.applied].sort((a, b) => b.id - a.id);
      const reverted: Migration[] = [];

      for (const record of appliedDescending.slice(0, count)) {
        const migration = this.#migrations.find((m) => m.id === record.id);
        if (migration === undefined) {
          throw new MigrationError('cannot roll back a migration this build does not define', {
            context: { id: record.id, name: record.name },
          });
        }
        if (migration.down === null) {
          throw new MigrationError('migration is marked irreversible', {
            context: { id: migration.id, name: migration.name },
          });
        }
        await this.#revert(migration);
        reverted.push(migration);
      }

      return { reverted };
    });
  }

  #refuseOnDrift(status: MigrationStatus): void {
    if (status.drifted.length === 0) return;
    throw new MigrationError(
      'an already-applied migration has been edited; the database and this build disagree about the schema',
      {
        context: {
          ids: status.drifted.map((d) => d.id).join(','),
          names: status.drifted.map((d) => d.name).join(','),
        },
      },
    );
  }

  async #apply(migration: Migration): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const record = `INSERT INTO schema_migration (id, name, checksum) VALUES ($1, $2, $3)`;
    const values = [migration.id, migration.name, checksum(migration)];

    try {
      if (migration.transactional === false) {
        await this.#db.query(migration.up);
        await this.#db.query(record, values);
      } else {
        await this.#db.transaction(async (client) => {
          await client.query(migration.up);
          await client.query(record, values);
        });
      }
    } catch (cause) {
      throw new MigrationError(`migration ${String(migration.id)} (${migration.name}) failed`, {
        context: { id: migration.id, name: migration.name, direction: 'up' },
        cause,
      });
    }

    this.#logger.info(
      {
        id: migration.id,
        name: migration.name,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      },
      'migration applied',
    );
  }

  async #revert(migration: Migration): Promise<void> {
    const down = migration.down;
    if (down === null) return;

    try {
      if (migration.transactional === false) {
        await this.#db.query(down);
        await this.#db.query('DELETE FROM schema_migration WHERE id = $1', [migration.id]);
      } else {
        await this.#db.transaction(async (client) => {
          await client.query(down);
          await client.query('DELETE FROM schema_migration WHERE id = $1', [migration.id]);
        });
      }
    } catch (cause) {
      throw new MigrationError(
        `rollback of migration ${String(migration.id)} (${migration.name}) failed`,
        { context: { id: migration.id, name: migration.name, direction: 'down' }, cause },
      );
    }

    this.#logger.info({ id: migration.id, name: migration.name }, 'migration reverted');
  }

  /**
   * A session-level advisory lock. Two cores starting simultaneously — which happens on every
   * upgrade and every fast service restart — must not both run the same migration.
   *
   * The lock is held on its own client and the migrations run on others. An *transaction*-level
   * lock would mean holding a client open around work that checks out more clients, which
   * deadlocks the moment the pool is small.
   */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#db.withClient(async (client) => {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      try {
        return await fn();
      } catch (error) {
        this.#logger.debug({ err: describeError(error) }, 'migration run failed under the lock');
        throw error;
      } finally {
        // Session locks outlive the statement, so releasing is not optional. A client returned
        // to the pool still holding this lock would block every later migration run.
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    });
  }
}
