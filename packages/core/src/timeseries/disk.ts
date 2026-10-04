import { statfs } from 'node:fs/promises';
import type { Logger } from '@ms/shared';
import { savepoint, type Queryable } from '../db/pool.js';

/**
 * How full the disk the readings are on is (`S-17`, `WORKFLOW.MD §13` row 7).
 *
 * **The hard part is not the measurement, it is being sure it is the right disk.** `statfs` is one
 * call. But the readings live on PostgreSQL's volume, and this process lives on its own; on a
 * single-host install those are the same filesystem and on a split one they are not. Watching the
 * core's disk and calling it the database's would be worse than not watching at all — a healthy
 * number on a screen, in front of a volume that is about to fill.
 *
 * So this establishes three things and reports which one it has:
 *
 * - **A local database.** `inet_server_addr()` is null (a unix socket) or a loopback address.
 *   The path being watched is on this machine and so is the database, so the reading means what
 *   it says.
 * - **A configured path.** The operator named a filesystem. Believed without argument: they know
 *   where their database is and this cannot.
 * - **A remote database and no configured path.** No reading at all — a gap, not a zero
 *   (`CLAUDE.md`) — and eviction is off, because evicting the oldest readings on the strength of
 *   an unrelated disk's fullness is the worst outcome available.
 */

export interface DiskReading {
  /** The filesystem this is about, so a message can name it. */
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  /** Free space as a percentage of the total, to one decimal. */
  readonly freePercent: number;
  /** What this installation's database occupies, which is the part retention can act on. */
  readonly databaseBytes: number;
}

export interface DiskWatcherOptions {
  readonly logger: Logger;
  /** The filesystem to watch. Empty falls back to `dataDir`, subject to the checks above. */
  readonly path: string;
  readonly dataDir: string;
  /** Injectable so a test does not have to fill a disk. */
  readonly measure?: (path: string) => Promise<{ totalBytes: number; freeBytes: number }>;
}

export class DiskWatcher {
  readonly #logger: Logger;
  readonly #configured: string;
  readonly #dataDir: string;
  readonly #measure: (path: string) => Promise<{ totalBytes: number; freeBytes: number }>;

  /** Decided once, on the first read: it cannot change without the process restarting. */
  #watched: string | null | undefined;
  #warned = false;

  constructor(options: DiskWatcherOptions) {
    this.#logger = options.logger.child({ component: 'disk' });
    this.#configured = options.path.trim();
    this.#dataDir = options.dataDir;
    this.#measure = options.measure ?? defaultMeasure;
  }

  /** The filesystem being watched, or null where there is nothing this core can honestly watch. */
  get watching(): string | null | undefined {
    return this.#watched;
  }

  /**
   * A reading, or null when there is no disk this core can speak for.
   *
   * Null rather than a zero or a guess: every caller treats it as a gap, and a channel that
   * reported 0% free because it could not measure would raise the alarm this exists to make
   * meaningful.
   */
  async read(q: Queryable): Promise<DiskReading | null> {
    const path = await this.#resolve(q);
    if (path === null) return null;

    let space: { totalBytes: number; freeBytes: number };
    try {
      space = await this.#measure(path);
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true;
        this.#logger.warn(
          { path, err: error instanceof Error ? error.message : String(error) },
          'cannot read free space; disk guarding is off until this is fixed',
        );
      }
      return null;
    }

    const databaseBytes = await currentDatabaseBytes(q);
    // A filesystem reporting no blocks at all is not a full disk, it is a filesystem this cannot
    // measure — some virtual and network mounts do exactly that. Dividing by it would produce a
    // NaN that reads as a gap by accident rather than on purpose.
    if (space.totalBytes <= 0) return null;

    return {
      path,
      totalBytes: space.totalBytes,
      freeBytes: space.freeBytes,
      freePercent: Math.round((space.freeBytes / space.totalBytes) * 1_000) / 10,
      databaseBytes,
    };
  }

  async #resolve(q: Queryable): Promise<string | null> {
    if (this.#watched !== undefined) return this.#watched;

    if (this.#configured !== '') {
      this.#watched = this.#configured;
      this.#logger.info({ path: this.#watched }, 'watching the configured filesystem');
      return this.#watched;
    }

    const local = await databaseIsLocal(q);
    if (local) {
      this.#watched = this.#dataDir;
      this.#logger.info(
        { path: this.#watched },
        'watching the filesystem holding the data directory; the database is on this host',
      );
      return this.#watched;
    }

    this.#watched = null;
    this.#logger.warn(
      'the database is on another host, so this core cannot see the disk the readings are on — ' +
        'disk guarding is off. Set housekeeping.disk.path if that volume is reachable from here.',
    );
    return null;
  }
}

async function defaultMeasure(path: string): Promise<{ totalBytes: number; freeBytes: number }> {
  const stats = await statfs(path);
  // `bavail` rather than `bfree`: the difference is the reserve only root may use, and a
  // monitoring service that counted it would think it had room it cannot have.
  return {
    totalBytes: stats.blocks * stats.bsize,
    freeBytes: stats.bavail * stats.bsize,
  };
}

/**
 * Whether the database is on this machine.
 *
 * `inet_server_addr()` is null over a unix socket, which is local by definition. Otherwise it is
 * the address the server is listening on as seen from here, and only loopback proves locality —
 * a private address might be this machine or the one in the next rack, and this cannot tell.
 * Unknown counts as remote: the cost of being wrong the other way is evicting real data because
 * an unrelated disk filled.
 *
 * **Both reads here catch inside the caller's transaction, so both are in a savepoint**
 * (`P-249`). The housekeeper reads the disk in a transaction, and a failed statement caught
 * without one aborts it: whatever else it wrote would be rolled back at its COMMIT.
 */
async function databaseIsLocal(q: Queryable): Promise<boolean> {
  try {
    const rows = await savepoint(q, (inner) =>
      inner.query<{ addr: string | null }>('SELECT host(inet_server_addr()) AS addr'),
    );
    const addr = rows[0]?.addr ?? null;
    return addr === null || addr === '127.0.0.1' || addr === '::1';
  } catch {
    return false;
  }
}

async function currentDatabaseBytes(q: Queryable): Promise<number> {
  try {
    const rows = await savepoint(q, (inner) =>
      inner.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes'),
    );
    return Number(rows[0]?.bytes ?? 0);
  } catch {
    return 0;
  }
}
