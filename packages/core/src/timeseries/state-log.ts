import type { CheckFailure, Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Visibility } from '../auth/access.js';
import { failureOf } from '../state/runtime.js';
import {
  SENSOR_STATE_CAUSES,
  SENSOR_STATES,
  type SensorState,
  type SensorStateCause,
} from '../state/tables.js';

/** One transition, as an operator reads it. */
export interface StateLogEntry {
  readonly at: string;
  readonly sensorId: number;
  readonly sensorName: string;
  readonly state: SensorState;
  /** `null` only on a sensor's very first transition. */
  readonly previousState: SensorState | null;
  readonly cause: SensorStateCause;
  readonly message: string;
  /** Where the check behind it failed, when its words are the check's (`P-285`). */
  readonly failure: CheckFailure | null;
  /**
   * How long the sensor stayed in `state`, in milliseconds.
   *
   * `null` on a sensor's latest transition, which is the state it is still in — a duration
   * there would be a number that changes every time it is read, and a client that wants "for
   * the last 40 minutes" can compute it from `at`. Never null merely because the next
   * transition fell on the other side of a page boundary.
   */
  readonly durationMs: number | null;
  /**
   * True on a row retention wrote to carry a state past its horizon, not on a transition
   * (`S-15`).
   *
   * Reported rather than hidden. Nothing changed at this instant — the row exists so the sensor
   * still has a known state after the chunk holding its last real transition was dropped — and an
   * operator scrolling to the oldest thing the log still holds deserves to be told that this is
   * the floor rather than the beginning.
   */
  readonly carried: boolean;
}

export interface StateLogQuery {
  /**
   * Whose log this is (`A-12`). A transition of a sensor the reader cannot see is absent — and so
   * is every transition of a sensor that has been deleted, unless the reader sees everything:
   * nothing records which branch it was in, so nothing can say who else may read it.
   */
  readonly visibility: Visibility;
  /** Scope to one object and everything beneath it. Absent means the whole installation. */
  readonly objectId?: number;
  readonly from?: Date;
  readonly to?: Date;
  readonly states?: readonly SensorState[];
  readonly causes?: readonly SensorStateCause[];
  /** Keyset cursor: `"<epochMillis>:<sensorId>"` from the previous page's `nextBefore`. */
  readonly before?: string;
  readonly limit: number;
}

/** The cursor's shape, checked before it reaches SQL. */
const CURSOR = /^(?<millis>\d{1,15}):(?<sensorId>\d{1,19})$/;

export interface StateLogServiceOptions {
  db: Database;
  logger: Logger;
}

/**
 * The state-change log (`M-15`).
 *
 * `M-02` has written every transition to `sensor_state` since it landed — with the previous
 * state, the cause and the message — because `CLAUDE.md` computes uptime from state history
 * rather than from samples, so the rows have to exist whether or not anybody reads them. What
 * was missing is the reading: `CAPABILITIES.MD §8`'s Logs view, and the sensor detail page's log
 * tab, both want the same query.
 *
 * **Duration is computed here, not stored.** A transition's row cannot know how long the state
 * lasted, because the answer arrives with the *next* transition; storing it would mean going
 * back to update a row in an append-only hypertable. A window function over the page gives it
 * for nothing, and the newest transition per sensor honestly has no duration at all — it is the
 * one still running.
 *
 * **Newest first, keyset-paged.** An operator opening a log wants what just happened, and
 * `(time, sensor_id)` is the hypertable's own ordering, so paging costs an index seek rather
 * than an offset scan through a year of history.
 */
export class StateLogService {
  readonly #db: Database;
  readonly #logger: Logger;

  constructor(options: StateLogServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'state-log' });
  }

  async list(query: StateLogQuery): Promise<{ items: StateLogEntry[]; nextBefore: string | null }> {
    const items = await this.#query(this.#db, query);
    return {
      items,
      // A short page is the last page. Equal-length pages carry a cursor even when the next one
      // turns out to be empty, which costs one request and never hides an entry.
      nextBefore: items.length < query.limit ? null : cursorOf(items.at(-1)),
    };
  }

  async #query(q: Queryable, query: StateLogQuery): Promise<StateLogEntry[]> {
    const values: unknown[] = [];
    const where: string[] = [];

    // Inside the page query, so a page of 100 is 100 of the reader's and the cursor runs over
    // what they can see (`A-12`).
    if (!query.visibility.everything) {
      where.push(
        query.visibility.where('s.sensor_id', (value) => `$${String(values.push(value))}`, {
          mayBeDeleted: true,
        }),
      );
    }
    if (query.objectId !== undefined) {
      // The subtree, not the object: "what happened under the London group" is the question the
      // Logs view asks, and a sensor is only ever a leaf of it.
      where.push(`s.sensor_id IN (
        WITH RECURSIVE subtree AS (
          SELECT o.id, 0 AS depth FROM object o WHERE o.id = $${String(values.push(query.objectId))}
          UNION ALL
          SELECT c.id, subtree.depth + 1
          FROM object c JOIN subtree ON c.parent_id = subtree.id
          WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
        )
        SELECT id FROM subtree
      )`);
    }
    if (query.from !== undefined) where.push(`s.time >= $${String(values.push(query.from))}`);
    if (query.to !== undefined) where.push(`s.time <= $${String(values.push(query.to))}`);
    if (query.states !== undefined && query.states.length > 0) {
      where.push(`s.state = ANY($${String(values.push(query.states))}::sensor_state_kind[])`);
    }
    if (query.causes !== undefined && query.causes.length > 0) {
      where.push(`s.cause = ANY($${String(values.push(query.causes))}::sensor_state_cause[])`);
    }
    if (query.before !== undefined) {
      const cursor = CURSOR.exec(query.before)?.groups;
      if (cursor === undefined) {
        // Refused rather than ignored: silently serving page one again is how a client ends up
        // in a loop that looks like the log repeating itself.
        throw new StateLogError(`"${query.before}" is not a page cursor`);
      }
      const at = new Date(Number(cursor['millis']));
      where.push(
        `(s.time, s.sensor_id) < ($${String(values.push(at))}, $${String(
          values.push(Number(cursor['sensorId'])),
        )}::bigint)`,
      );
    }

    const filter = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    const limit = `$${String(values.push(query.limit))}`;

    const rows = await q.query<{
      at: Date;
      sensor_id: string;
      sensor_name: string;
      state: SensorState;
      previous_state: SensorState | null;
      cause: SensorStateCause;
      message: string;
      failure_phase: string | null;
      failure_target: string | null;
      carried: boolean;
      duration_ms: string | null;
    }>(
      `
      WITH page AS (
        SELECT s.time, s.sensor_id, s.state, s.previous_state, s.cause, s.message,
               s.failure_phase, s.failure_target, s.carried
        FROM sensor_state s
        ${filter}
        ORDER BY s.time DESC, s.sensor_id DESC
        LIMIT ${limit}
      )
      SELECT page.time AS at,
             page.sensor_id::text AS sensor_id,
             coalesce(o.name, '') AS sensor_name,
             page.state, page.previous_state, page.cause, page.message,
             page.failure_phase, page.failure_target, page.carried,
             (EXTRACT(EPOCH FROM (next.time - page.time)) * 1000)::bigint::text AS duration_ms
      FROM page
      -- Left, on purpose: the transition most worth reading may be the last one a deleted
      -- sensor made, and dropping it would hide exactly what somebody came to find.
      LEFT JOIN object o ON o.id = page.sensor_id
      -- The next transition of the same sensor in the *table*, not merely in this page. A
      -- window function over the page would be free, and would make a state's duration depend
      -- on where the page boundary happened to fall — the same transition reading "4 minutes"
      -- or "still running" according to how the client paged. One index seek per row on
      -- (sensor_id, time), bounded by the page size.
      LEFT JOIN LATERAL (
        SELECT n.time FROM sensor_state n
        WHERE n.sensor_id = page.sensor_id AND n.time > page.time
        ORDER BY n.time
        LIMIT 1
      ) next ON true
      ORDER BY page.time DESC, page.sensor_id DESC
      `,
      values,
    );

    return rows.map((row) => ({
      at: row.at.toISOString(),
      sensorId: Number(row.sensor_id),
      sensorName: row.sensor_name,
      state: row.state,
      previousState: row.previous_state,
      cause: row.cause,
      message: row.message,
      failure: failureOf(row),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      carried: row.carried,
    }));
  }

  /** What the log covers, so a UI can say "no records before" rather than "nothing happened". */
  async horizon(): Promise<string | null> {
    const rows = await this.#db.query<{ oldest: Date | null }>(
      'SELECT min(time) AS oldest FROM sensor_state',
    );
    const oldest = rows[0]?.oldest ?? null;
    this.#logger.debug({ oldest }, 'state log horizon');
    return oldest?.toISOString() ?? null;
  }
}

function cursorOf(entry: StateLogEntry | undefined): string | null {
  if (entry === undefined) return null;
  return `${String(Date.parse(entry.at))}:${String(entry.sensorId)}`;
}

export class StateLogError extends Error {
  readonly code = 'CURSOR_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StateLogError';
  }
}

/** The filter values the API accepts, so the route and the query cannot drift apart. */
export const STATE_LOG_STATES = SENSOR_STATES;
export const STATE_LOG_CAUSES = SENSOR_STATE_CAUSES;
