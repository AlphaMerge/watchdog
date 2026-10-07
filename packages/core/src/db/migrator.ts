import { createHash } from 'node:crypto';
import { AppError, describeError, type Logger } from '@ms/shared';
import type { PoolClient } from 'pg';
import type { Database } from './pool.js';
import type { Migration } from './migrations/types.js';

export class MigrationError extends AppError {
  /**
   * A refusal rather than a failure: the database and this build disagree about the schema (a
   * newer build migrated it, or an applied migration was edited). Nothing about it changes by
   * trying again, so a core starting into it exits 78 rather than being restarted (`P-222`).
   */
  readonly refusal: boolean;

  constructor(
    message: string,
    options: { context?: Record<string, string | number>; cause?: unknown; refusal?: boolean },
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
    this.refusal = options.refusal ?? false;
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

/** Arbitrary but fixed: the advisory lock every migration run takes. Exported for tests. */
export const MIGRATION_LOCK_KEY = 4_919_201_5;
const LOCK_KEY = MIGRATION_LOCK_KEY;

/** How often a running migration says it is still running. */
const PROGRESS_INTERVAL_MS = 15_000;
const LOCK_POLL_MS = 1_000;

/** One migration under way: which, and for how long so far. */
export interface MigrationProgress {
  readonly migration: Migration;
  readonly elapsedMs: number;
}

/** Who holds the migration lock this run is waiting for, as far as PostgreSQL can say. */
export interface LockHolder {
  readonly pid: number;
  readonly application: string;
  /** Null for a unix socket. */
  readonly clientAddress: string | null;
  /** `pg_stat_activity.state`: `idle` for a session whose owner has gone quiet. */
  readonly state: string | null;
  readonly stateForSeconds: number | null;
}

export interface LockWait {
  readonly elapsedMs: number;
  /** Null when the holder ended between the attempt and the question. */
  readonly holder: LockHolder | null;
}

export interface MigratorOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly migrations: readonly Migration[];
  /**
   * Called as each migration starts and then every `progressIntervalMs` until it ends (`P-215`).
   *
   * **A migration at start-up is a start the supervisor can kill.** `autoMigrate` is on by
   * default, so every upgrade migrates inside `TimeoutStartSec`, and a migration longer than that
   * — an index on the samples hypertable of a large installation — was killed mid-way, restarted
   * into the same migration and killed again: an upgrade that could never finish. The core wires
   * this to `Lifecycle.starting`, which keeps systemd waiting and puts the migration's name in
   * `systemctl status`.
   *
   * **Repeated for as long as it runs, not one slice per migration.** A fixed extension per
   * migration only moves the deadline: a migration longer than the slice is killed exactly as
   * before. A migration that is genuinely stuck — waiting on a lock — is then stuck in plain view,
   * named, with its elapsed time, rather than killed half-way and started again.
   */
  readonly onProgress?: (progress: MigrationProgress) => void;
  readonly progressIntervalMs?: number;
  /**
   * Called when the migration lock is held by another session, and then every
   * `progressIntervalMs` until it is free (`P-222`).
   *
   * The lock is taken before any migration starts, so a core that waited on it silently sent
   * systemd nothing, was killed at `TimeoutStartSec` five times and ended `failed`. Its holder is
   * usually another `migrate` run, or a session left behind by a core whose host died mid-upgrade,
   * which PostgreSQL keeps until TCP keepalive notices — about two hours by default. Naming it is
   * what lets an operator end it.
   */
  readonly onLockWait?: (wait: LockWait) => void;
  /** How often the lock is tried while another session holds it. */
  readonly lockPollMs?: number;
}

function checksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${String(migration.id)}\n${migration.name}\n${migration.up}`)
    .digest('hex');
}

/** How many drifted migrations a refusal names before it counts the rest. */
const DRIFT_NAMED = 5;

/**
 * The drifted migrations in words: each id and name, and both checksums in full (`P-238`).
 *
 * **In the message, not only the context**, because the message is all a refused start prints. A
 * core that said "an already-applied migration has been edited" and nothing else restarted about
 * 470 times on a development database before anyone could say which. The checksums are what tells
 * one version of a migration from another, and a record can only be put right by the full value.
 * Past five, the rest are counted: a build that changed every migration's text needs no list.
 */
export function describeDrift(drifted: MigrationStatus['drifted']): string {
  const named = drifted
    .slice(0, DRIFT_NAMED)
    .map(
      (one) =>
        `${String(one.id)} ${one.name} (applied ${one.appliedChecksum}, this build ${one.currentChecksum})`,
    )
    .join('; ');
  const more = drifted.length - DRIFT_NAMED;
  return more > 0 ? `${named}; and ${String(more)} more` : named;
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
  readonly #onProgress: ((progress: MigrationProgress) => void) | undefined;
  readonly #progressIntervalMs: number;
  readonly #onLockWait: ((wait: LockWait) => void) | undefined;
  readonly #lockPollMs: number;

  constructor(options: MigratorOptions) {
    this.#db = options.db;
    this.#onProgress = options.onProgress;
    this.#progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#onLockWait = options.onLockWait;
    this.#lockPollMs = options.lockPollMs ?? LOCK_POLL_MS;
    this.#logger = options.logger.child({ component: 'migrator' });
    this.#migrations = [...options.migrations].sort((a, b) => a.id - b.id);

    const seen = new Set<number>();
    for (const migration of this.#migrations) {
      if (seen.has(migration.id)) {
        throw new MigrationError('duplicate migration id', { context: { id: migration.id } });
      }
      seen.add(migration.id);
      // A data step commits batch by batch, so one transaction around it would be a lie
      // (`N-28`): refused here, before any database is touched.
      if (migration.data !== undefined && migration.transactional !== false) {
        throw new MigrationError('a migration with a data step must not be transactional', {
          context: { id: migration.id, name: migration.name },
        });
      }
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
        const newest = status.unknown[status.unknown.length - 1];
        throw new MigrationError(
          `the database schema is newer than this build: it has ${String(status.unknown.length)} ` +
            `migration(s) this build does not define` +
            (newest === undefined ? '' : ` (newest: ${String(newest.id)} ${newest.name})`) +
            '; upgrade ms-core or restore a matching backup',
          {
            refusal: true,
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

      // **A gap below the newest applied migration is applied, and said so** (`P-222`). It happens
      // only on a database that ran a build between two commits that landed out of order — never
      // from a release, which carries every migration — and the migration then runs against a
      // schema it was not written after. Applying it is what every numbered-migration runner does;
      // a warning is what makes the order findable later, and `down` follows the order applied.
      const newestApplied = Math.max(0, ...status.applied.map((row) => row.id));
      const outOfOrder = status.pending.filter((migration) => migration.id < newestApplied);
      if (outOfOrder.length > 0) {
        this.#logger.warn(
          { ids: outOfOrder.map((m) => m.id).join(','), newestApplied },
          'applying migration(s) numbered below one already applied; `migrate down` will revert them first',
        );
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

  /**
   * Rolls back the most recently applied migrations, last applied first.
   *
   * **By when each was applied, not by its number** (`P-222`). The two agree on every database a
   * release built. Where they do not — a lower migration applied after a higher one — "the most
   * recent" is the one applied last, and reverting by number undid a migration the operator never
   * meant to touch and dropped its tables. Ties, which one transaction's `now()` gives, fall back to
   * the number, which is the order they were applied in.
   */
  async down(count = 1): Promise<{ reverted: Migration[] }> {
    return this.#withLock(async () => {
      const status = await this.status();
      this.#refuseOnDrift(status);

      const appliedDescending = [...status.applied].sort(
        (a, b) => b.appliedAt.getTime() - a.appliedAt.getTime() || b.id - a.id,
      );
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
    const message =
      'an already-applied migration has been edited; the database and this build disagree about ' +
      `the schema: ${describeDrift(status.drifted)}`;
    // Every one of them in the log, where the message counts past five (`P-238`).
    this.#logger.error({ drifted: status.drifted }, message);
    throw new MigrationError(message, {
      refusal: true,
      context: {
        ids: status.drifted.map((d) => d.id).join(','),
        names: status.drifted.map((d) => d.name).join(','),
        appliedChecksums: status.drifted.map((d) => d.appliedChecksum).join(','),
        currentChecksums: status.drifted.map((d) => d.currentChecksum).join(','),
      },
    });
  }

  async #apply(migration: Migration): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const record = `INSERT INTO schema_migration (id, name, checksum) VALUES ($1, $2, $3)`;
    const values = [migration.id, migration.name, checksum(migration)];
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

    this.#logger.info({ id: migration.id, name: migration.name }, 'applying migration');
    this.#onProgress?.({ migration, elapsedMs: 0 });
    const progress = setInterval(() => {
      const elapsed = elapsedMs();
      this.#logger.info(
        { id: migration.id, name: migration.name, elapsedMs: Math.round(elapsed) },
        'migration still running',
      );
      this.#onProgress?.({ migration, elapsedMs: elapsed });
    }, this.#progressIntervalMs);
    // A timer must not be what keeps a process alive whose migration has already thrown.
    progress.unref();

    try {
      if (migration.transactional === false) {
        await this.#db.query(migration.up);
        // Before the record, so that a step that fails leaves the migration to be run again.
        await migration.data?.({
          db: this.#db,
          logger: this.#logger.child({ migration: migration.id }),
        });
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
    } finally {
      clearInterval(progress);
    }

    this.#logger.info(
      { id: migration.id, name: migration.name, elapsedMs: elapsedMs() },
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
   * Takes the migration lock, saying who holds it for as long as somebody else does (`P-222`).
   *
   * Tried rather than waited on: `pg_advisory_lock` blocks inside one statement, and a core blocked
   * there could report nothing. Two cores that start together still cannot both hold it.
   */
  async #acquire(client: PoolClient): Promise<void> {
    const started = Date.now();
    let reported = -Infinity;
    for (;;) {
      const [row] = (
        await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
          LOCK_KEY,
        ])
      ).rows;
      if (row?.locked === true) {
        if (reported !== -Infinity) {
          this.#logger.info({ waitedMs: Date.now() - started }, 'migration lock acquired');
        }
        return;
      }
      const elapsedMs = Date.now() - started;
      if (elapsedMs - reported >= this.#progressIntervalMs) {
        reported = elapsedMs;
        const holder = await this.#holder(client);
        this.#logger.warn(
          { elapsedMs, holder },
          'waiting for the migration lock, which another session holds',
        );
        this.#onLockWait?.({ elapsedMs, holder });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.#lockPollMs);
      });
    }
  }

  async #holder(client: PoolClient): Promise<LockHolder | null> {
    // A single bigint key is stored as classid (high 32 bits), objid (low 32 bits), objsubid 1.
    // Advisory locks belong to one database, and another database's migrator holds the same key.
    const { rows } = await client.query<{
      pid: number;
      application: string;
      client_address: string | null;
      state: string | null;
      state_for: number | null;
    }>(
      `SELECT a.pid, a.application_name AS application, host(a.client_addr) AS client_address,
              a.state, extract(epoch FROM now() - a.state_change)::integer AS state_for
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = ($1::bigint >> 32)::oid AND l.objid = ($1::bigint & 4294967295)::oid
        LIMIT 1`,
      [LOCK_KEY],
    );
    const found = rows[0];
    if (found === undefined) return null;
    return {
      pid: found.pid,
      application: found.application,
      clientAddress: found.client_address,
      state: found.state,
      stateForSeconds: found.state_for,
    };
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
      await this.#acquire(client);
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
