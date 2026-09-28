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
   * Lets the rest of this transaction write into compacted storage however much that unpacks
   * (`P-226`).
   *
   * **Only for writes the caller has already bounded.** TimescaleDB refuses a statement that
   * would decompress more than a configured number of rows, 100,000 by default, and rolls the
   * transaction back. That limit protects a database from one careless `UPDATE`. It also refuses
   * a backfill, a reap and a replayed spool, which reach into old chunks because that is their
   * job, and a refused backfill is retried for ever with nothing learnt. Each caller that uses
   * this bounds its own transaction: the backfill by a day and a batch of channels, the reap by
   * its channels, ingestion by its batch. An engine with no such limit does nothing here.
   */
  allowDecompression(q: Queryable): Promise<void>;

  /**
   * Chunks of `table` lying wholly before `before` that are not compacted, or not wholly.
   *
   * "Wholly before": a chunk is only past a horizon once its whole span is, or the newest chunk
   * would be compacted while it is still being written to.
   *
   * "Not wholly" is a compacted chunk that has been written to since (`P-226`). A replayed spool
   * or a backfill writes into old chunks, and on TimescaleDB those rows sit beside the compressed
   * ones, uncompressed, until the chunk is compressed again. Leaving them out would keep every
   * replay's rows uncompressed for as long as the chunk is kept.
   */
  compactableChunks(q: Queryable, table: string, before: Date, limit: number): Promise<string[]>;

  compact(q: Queryable, chunk: string): Promise<void>;

  /** Drops whole chunks older than `olderThan`, returning the names of those that went. */
  dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]>;
}

/**
 * The oldest TimescaleDB this build runs against (`P-226`).
 *
 * **2.14.0, for two things it made unconditional**, each cited from that release's changelog:
 * - `#6566`, "Limit tuple decompression during DML operations". A write into compressed chunks
 *   that unpacks more than 100,000 rows is refused unless the transaction lifts the limit, and
 *   `allowDecompression` lifts it by setting a parameter that only exists from this release on.
 *   Before it there was no limit to lift and no parameter to set, so supporting an older engine
 *   would mean asking which one this is before every backfill.
 * - `#6579` and `#6609`: `compress_chunk` became idempotent and "works on both uncompressed and
 *   partially compressed chunks". Before it, a chunk written to after compression needed
 *   `recompress_chunk`, a procedure that cannot run inside a transaction.
 *
 * `#6575`, "Fix compressed chunk not found during upserts", is in the same release, and an
 * upsert into a compressed chunk is exactly what a backfill does.
 *
 * Refused at start-up rather than discovered by the first backfill, which on an installation
 * with no late data might be months later.
 */
export const MINIMUM_TIMESCALEDB = '2.14.0';

/**
 * Whether `found` is at least `minimum`, both `major.minor.patch` with anything after ignored.
 *
 * Compared as numbers, because as strings `2.9.0` sorts after `2.14.0`. A version this cannot
 * read at all is refused: a build string nobody anticipated is not evidence of a new enough one.
 */
export function atLeast(found: string, minimum: string): boolean {
  const parse = (version: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const have = parse(found);
  const need = parse(minimum);
  if (have === null || need === null) return false;
  for (let part = 0; part < 3; part += 1) {
    const a = have[part] ?? 0;
    const b = need[part] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
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
    if (!atLeast(version, MINIMUM_TIMESCALEDB)) {
      throw new EngineError(
        `TimescaleDB ${version} is older than ${MINIMUM_TIMESCALEDB}, the oldest this build ` +
          `supports; upgrade the timescaledb package, restart PostgreSQL, then run ` +
          `ALTER EXTENSION timescaledb UPDATE in this database`,
        { found: version, minimum: MINIMUM_TIMESCALEDB },
      );
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

  async allowDecompression(q: Queryable): Promise<void> {
    // `set_config` with `is_local` is `SET LOCAL`: it ends with the transaction, so the limit is
    // back for whatever runs next on this connection. Zero means no limit (`#6566`).
    await q.query(
      "SELECT set_config('timescaledb.max_tuples_decompressed_per_dml_transaction', '0', true)",
    );
  }

  async compactableChunks(
    q: Queryable,
    table: string,
    before: Date,
    limit: number,
  ): Promise<string[]> {
    // `is_compressed` is the compressed bit alone, so it is still true of a chunk written to
    // since. The status carries the rest: 2 is unordered and 8 is partial, the two states
    // `compress_chunk` recompresses from 2.14.0 on. Through the function rather than the
    // catalogue table, whose columns changed between 2.14 and 2.29.
    const rows = await q.query<{ chunk: string }>(
      `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
       FROM timescaledb_information.chunks
       WHERE hypertable_name = $1
         AND range_end <= $2
         AND (NOT is_compressed
              OR _timescaledb_functions.chunk_status(
                   format('%I.%I', chunk_schema, chunk_name)::regclass) & 10 <> 0)
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
