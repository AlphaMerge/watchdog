import { AppError } from '@ms/shared';
import type { Queryable } from '../db/pool.js';

export interface EngineCapabilities {
  /** Identifies the engine in logs and on Core Health. */
  engine: string;
  version: string | null;
  /**
   * Whether `compact` actually reduces storage. False on an engine without columnar storage,
   * where the housekeeping loop skips compaction rather than performing an expensive no-op.
   */
  compaction: boolean;
}

export class EngineError extends AppError {
  constructor(message: string, context: Record<string, string> = {}) {
    super('STORAGE_ENGINE_UNAVAILABLE', message, { context });
    this.name = 'EngineError';
  }
}

/**
 * Everything the time-series store needs that plain PostgreSQL does not provide (S-12).
 *
 * This is the whole of the TimescaleDB dependency, deliberately reduced to its smallest honest
 * form. `ADR-001` Decision 4 promised a repository interface "so a plain-Postgres fallback is
 * contained", and `S-11` may yet need one if TimescaleDB turns out to be unusable on Windows.
 * Containing it means knowing exactly what a second implementation owes, and it is four things:
 *
 *   1. **Bucketing.** `time_bucket` is Apache-licensed, and `date_bin` (PostgreSQL 14+) is an
 *      exact substitute for the widths we use — measured in `storage-engine.test.ts`, not
 *      assumed.
 *   2. **Finding aged chunks**, and 3. **compacting them**. Compression is the one
 *      Timescale-License feature we accept (`CLAUDE.md` constraint 4). An engine without it
 *      reports `compaction: false` and the loop stops asking.
 *   4. **Dropping whole chunks.** `drop_chunks` is Apache-licensed; declarative partitioning's
 *      `DROP TABLE` on a partition is the substitute.
 *
 * What is *not* here, and cannot be: the schema. `create_hypertable` lives in migration 003 and
 * the compression settings in 004, and migrations are checksummed to detect drift — so they
 * cannot be parameterised by engine without making the checksum depend on it. A fallback needs
 * its own migration list, chosen at startup. See
 * `docs/findings/2026-08-25-storage-engine-boundary.md`.
 */
export interface StorageEngine {
  readonly name: string;

  /**
   * A SQL expression bucketing `at` to the interval bound at `intervalParam`.
   *
   * Returns SQL text rather than doing the work, because bucketing happens inside the aggregate
   * that reads the rows — there is no round trip to interpose. Both arguments are composed by
   * the store from its own constants and placeholders, never from a request.
   */
  bucket(intervalParam: string, at: string): string;

  /** Confirms the engine is usable, or throws saying what to install. */
  check(q: Queryable): Promise<EngineCapabilities>;

  /**
   * Chunks of `table` lying wholly before `before` that have not been compacted yet.
   *
   * "Wholly before": a chunk is only past a horizon once its whole span is, or the newest chunk
   * would be compacted while it is still being written to.
   */
  compactableChunks(q: Queryable, table: string, before: Date, limit: number): Promise<string[]>;

  compact(q: Queryable, chunk: string): Promise<void>;

  /** Drops whole chunks older than `olderThan`, returning the names of those that went. */
  dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]>;
}

/** The engine we ship: hypertables, native compression, `drop_chunks`. */
export class TimescaleEngine implements StorageEngine {
  readonly name = 'timescaledb';

  bucket(intervalParam: string, at: string): string {
    return `time_bucket(${intervalParam}::interval, ${at})`;
  }

  async check(q: Queryable): Promise<EngineCapabilities> {
    const rows = await q.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
    );
    const version = rows[0]?.extversion;
    if (version === undefined) {
      throw new EngineError('the TimescaleDB extension is not installed in this database', {
        fix: 'install the timescaledb package, add it to shared_preload_libraries, restart PostgreSQL, then CREATE EXTENSION timescaledb',
      });
    }

    // Compression is Timescale License, and the licence is a start-up parameter. Reporting it
    // rather than assuming it means a database started under the Apache licence degrades to "no
    // compaction" instead of failing a housekeeping pass every five minutes.
    const licence = await q.query<{ granted: string | null }>(
      "SELECT current_setting('timescaledb.license', true) AS granted",
    );
    return {
      engine: this.name,
      version,
      compaction: licence[0]?.granted === 'timescale',
    };
  }

  async compactableChunks(
    q: Queryable,
    table: string,
    before: Date,
    limit: number,
  ): Promise<string[]> {
    const rows = await q.query<{ chunk: string }>(
      `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
       FROM timescaledb_information.chunks
       WHERE hypertable_name = $1 AND NOT is_compressed AND range_end <= $2
       ORDER BY range_end
       LIMIT $3`,
      [table, before, limit],
    );
    return rows.map((row) => row.chunk);
  }

  async compact(q: Queryable, chunk: string): Promise<void> {
    await q.query('SELECT compress_chunk($1::regclass)', [chunk]);
  }

  async dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]> {
    const rows = await q.query<{ chunk: string }>(
      'SELECT drop_chunks($1::regclass, older_than => $2::timestamptz) AS chunk',
      [table, olderThan],
    );
    return rows.map((row) => row.chunk);
  }
}
