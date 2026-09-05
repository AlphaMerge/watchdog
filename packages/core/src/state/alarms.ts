import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { SensorState, SensorStateCause } from './tables.js';

/**
 * The states the alarms view is about (`WORKFLOW.MD §7`).
 *
 * Named exactly, not derived as "everything that is not Up". Two states are deliberately absent
 * and each absence is a decision:
 *
 * - **Paused is not an alarm.** Somebody switched it off on purpose. A list that reports
 *   deliberate silence as a problem is the list an operator learns to scroll past, which is how
 *   the real alarm underneath it gets missed.
 * - **Unknown is not an alarm either.** It means "nothing has scanned this yet" — true of every
 *   sensor in a fresh installation and of every sensor for one interval after a resume. It is a
 *   gap in coverage rather than a fault, and `CAPABILITIES.MD` lists it separately for that
 *   reason. It is still reachable through the tree and the state log.
 */
export const ALARM_STATES: readonly SensorState[] = [
  'down',
  'down_partial',
  'down_acknowledged',
  'warning',
  'unusual',
];

const ALARM_STATE_SET = new Set<string>(ALARM_STATES);

export interface Alarm {
  readonly sensorId: number;
  readonly sensorName: string;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  /** When the sensor entered this state, ISO-8601. The duration is `now - since`. */
  readonly since: string;
  /** 1 (lowest) to 5 (highest), from the sensor's own row. */
  readonly priority: number;
  /**
   * Root first, sensor last — ids and names in step.
   *
   * Both, because an alarm without its place is unactionable: "Ping is down" on an installation
   * with forty devices names nothing. The ids make each step a link.
   */
  readonly path: readonly number[];
  readonly pathNames: readonly string[];
  readonly acknowledged: boolean;
  /** `null` while acknowledged indefinitely, absent when not acknowledged at all. */
  readonly acknowledgedUntil: string | null;
  readonly consecutiveFailures: number;
}

export interface AlarmQuery {
  /** Scope to one object and everything beneath it. Absent means the whole installation. */
  readonly objectId?: number;
  /** Which of `ALARM_STATES` to include. Absent means all of them. */
  readonly states?: readonly SensorState[];
  /** Sensors at or above this priority. 5 is the highest. */
  readonly priorityMin?: number;
  /** Whether to include alarms somebody has already acknowledged. Defaults to true. */
  readonly includeAcknowledged?: boolean;
  readonly sort?: AlarmSort;
  readonly limit: number;
}

/**
 * `priority` is `WORKFLOW.MD`'s "priority then duration" and the default; `duration` is oldest
 * first regardless of priority, for the question "what has been broken longest".
 */
export type AlarmSort = 'priority' | 'duration';

export interface AlarmPage {
  readonly items: readonly Alarm[];
  /** How many matched before `limit`, so a truncated list can say what it is not showing. */
  readonly total: number;
  /** Counts per state across the whole scope, ignoring the state filter — the filter's own chips. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface AlarmServiceOptions {
  db: Database;
  logger: Logger;
}

/**
 * What is wrong right now (`U-06`, `CAPABILITIES.MD §8`).
 *
 * **Read from `sensor_runtime`, not from the state log.** The log answers "what happened"; this
 * answers "what is true", and the two are different questions with different indexes.
 * Migration 008 created `sensor_runtime_not_up_idx` — a partial index on the states that are not
 * Up — naming this task, because in a healthy installation the answer is a handful of rows out
 * of thousands and a full scan to find them would be the one query that got slower as the
 * product succeeded.
 *
 * **The ancestry walk goes up, from the alarms, not down from the root.** Scoping to a branch
 * and naming each alarm's place are the same question — is this object in the chain, and what
 * are the chain's names — and walking up from a few dozen alarming sensors touches a few dozen
 * chains. Walking down from the root to find them would touch every object in the installation
 * on every refresh, and this view refreshes whenever anything changes state.
 */
export class AlarmService {
  readonly #db: Database;
  readonly #logger: Logger;

  constructor(options: AlarmServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'alarms' });
  }

  async list(query: AlarmQuery): Promise<AlarmPage> {
    return this.#db.tx((q) => this.read(q, query));
  }

  /** The query itself, so a caller inside a transaction can use it too. */
  async read(q: Queryable, query: AlarmQuery): Promise<AlarmPage> {
    const states = (query.states ?? ALARM_STATES).filter((state) => ALARM_STATE_SET.has(state));
    if (states.length === 0) return { items: [], total: 0, counts: {} };

    // Every alarm state goes into the scan; the requested subset filters *after* the scope is
    // established. That ordering is what lets the severity chips keep counting a kind the reader
    // has currently filtered out — a chip that hides its own subject is a chip that lies.
    const values: unknown[] = [ALARM_STATES, query.objectId ?? null];
    const where: string[] = [`state = ANY($${String(values.push(states))}::sensor_state_kind[])`];
    if (query.priorityMin !== undefined) {
      where.push(`priority >= $${String(values.push(query.priorityMin))}`);
    }
    if (query.includeAcknowledged === false) where.push('NOT acknowledged');
    const limit = `$${String(values.push(query.limit))}`;

    const order =
      query.sort === 'duration'
        ? // Oldest first: the question is "what has been broken longest".
          'since ASC, sensor_id ASC'
        : // WORKFLOW.MD §7: priority then duration. Highest priority first, and within a
          // priority the one that has been wrong longest.
          'priority DESC, since ASC, sensor_id ASC';

    const rows = await q.query<{
      sensor_id: string;
      name: string;
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      since: Date;
      priority: number;
      path: string[];
      path_names: string[];
      acknowledged: boolean;
      acknowledged_until: Date | null;
      consecutive_failures: number;
      total: string;
      counts: Record<string, number>;
    }>(
      `
      WITH RECURSIVE alarming AS (
        -- The partial index answers this. Everything below walks a few dozen rows, not the tree.
        SELECT r.object_id AS sensor_id, r.state, r.cause, r.message,
               -- **How long it has been wrong, from the state history** (P-142). This read
               -- sensor_runtime.since, which is when the sensor entered its *current state* --
               -- and acknowledging a Down is a state change, so the moment an operator said "I
               -- am on it" the duration column reset to zero and the sensor moved to the bottom
               -- of a list sorted by "what has been broken longest". The acknowledgement lapsing
               -- reset it a second time. CLAUDE.md already says where durations come from:
               -- uptime is computed from state history, not from the runtime row.
               --
               -- The outage began at the earliest transition after the last one that was not an
               -- alarm state. COALESCE back to the runtime row for a sensor whose history has
               -- been dropped by retention, which is honest -- an outage older than the history
               -- cannot be dated more precisely than "at least this long".
               COALESCE(
                 (SELECT min(h.time) FROM sensor_state h
                   WHERE h.sensor_id = r.object_id
                     AND h.state = ANY($1::sensor_state_kind[])
                     AND h.time > COALESCE(
                       (SELECT max(h2.time) FROM sensor_state h2
                         WHERE h2.sensor_id = r.object_id
                           AND NOT (h2.state = ANY($1::sensor_state_kind[]))),
                       '-infinity'::timestamptz)),
                 r.since) AS since,
               r.acknowledged_at, r.acknowledged_until, r.consecutive_failures
        FROM sensor_runtime r
        WHERE r.state = ANY($1::sensor_state_kind[])
      ),
      chain AS (
        SELECT a.sensor_id, o.id, o.parent_id, o.name, o.priority, 0 AS depth
        FROM alarming a
        JOIN object o ON o.id = a.sensor_id
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id, p.name, chain.priority, chain.depth + 1
        FROM chain
        JOIN object p ON p.id = chain.parent_id
      ),
      placed AS (
        SELECT sensor_id,
               max(priority) AS priority,
               array_agg(id ORDER BY depth DESC) AS path,
               array_agg(name ORDER BY depth DESC) AS path_names
        FROM chain
        GROUP BY sensor_id
      ),
      scoped AS (
        SELECT a.sensor_id, p.path, p.path_names, p.priority,
               a.state, a.cause, a.message, a.since, a.consecutive_failures,
               a.acknowledged_at IS NOT NULL AS acknowledged,
               a.acknowledged_until
        FROM alarming a
        JOIN placed p ON p.sensor_id = a.sensor_id
        -- Branch scoping is "is this object anywhere in the chain", which is the same array the
        -- names came from. No second query, and no separate notion of "beneath".
        WHERE $2::bigint IS NULL OR $2::bigint = ANY(p.path)
      ),
      filtered AS (
        SELECT * FROM scoped WHERE ${where.join(' AND ')}
      )
      SELECT f.sensor_id::text AS sensor_id,
             f.path_names[array_length(f.path_names, 1)] AS name,
             f.state, f.cause, f.message, f.since, f.priority,
             f.path::text[] AS path, f.path_names,
             f.acknowledged, f.acknowledged_until, f.consecutive_failures,
             (SELECT count(*) FROM filtered)::text AS total,
             -- Counts come from "scoped", before the state and priority filters, so the chips
             -- keep saying how many there are of a kind the reader has currently filtered out.
             (SELECT coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
                FROM (SELECT state, count(*) AS n FROM scoped GROUP BY state) AS s) AS counts
      FROM filtered f
      ORDER BY ${order}
      LIMIT ${limit}
      `,
      values,
    );

    const first = rows[0];
    if (first === undefined) {
      // No rows means no counts either — but the scope may still hold alarms the state filter
      // excluded, so the chips are read separately rather than reported as zero.
      return { items: [], total: 0, counts: await this.#counts(q, query.objectId ?? null) };
    }

    return {
      items: rows.map((row) => ({
        sensorId: Number(row.sensor_id),
        sensorName: row.name,
        state: row.state,
        cause: row.cause,
        message: row.message,
        since: row.since.toISOString(),
        priority: row.priority,
        path: row.path.map(Number),
        pathNames: row.path_names,
        acknowledged: row.acknowledged,
        acknowledgedUntil: row.acknowledged_until?.toISOString() ?? null,
        consecutiveFailures: row.consecutive_failures,
      })),
      total: Number(first.total),
      counts: first.counts,
    };
  }

  /** The per-state chips when the filtered list came back empty. */
  async #counts(q: Queryable, objectId: number | null): Promise<Record<string, number>> {
    const rows = await q.query<{ state: string; n: string }>(
      `
      WITH RECURSIVE alarming AS (
        SELECT r.object_id AS sensor_id, r.state
        FROM sensor_runtime r
        WHERE r.state = ANY($1::sensor_state_kind[])
      ),
      chain AS (
        SELECT a.sensor_id, o.id, o.parent_id FROM alarming a JOIN object o ON o.id = a.sensor_id
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id
        FROM chain JOIN object p ON p.id = chain.parent_id
      )
      SELECT a.state, count(*)::text AS n
      FROM alarming a
      WHERE $2::bigint IS NULL
         OR EXISTS (SELECT 1 FROM chain c WHERE c.sensor_id = a.sensor_id AND c.id = $2::bigint)
      GROUP BY a.state
      `,
      [ALARM_STATES, objectId],
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = Number(row.n);
    return counts;
  }

  /** For Core Health, once `P-12` reads it. */
  get logger(): Logger {
    return this.#logger;
  }
}
