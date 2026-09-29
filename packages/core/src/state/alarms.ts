import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Visibility } from '../auth/access.js';
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

/**
 * A sensor that is back, while the alarm it raised is not yet over (`M-18`).
 *
 * Not a state: the sensor is Up, and says so everywhere else. It is listed here because the alarm
 * still stands — a relapse inside the hold resumes it rather than raising a second — and a list
 * of what is not over that left it out would show nothing while the notification that it has
 * recovered is still to come.
 */
export const RECOVERING = 'recovering';

/** What the list sorts rows into: the alarm states, and a held return. */
export type AlarmKind = SensorState | typeof RECOVERING;

/** The kinds, alarm states first, as the chips show them. */
export const ALARM_KINDS: readonly AlarmKind[] = [...ALARM_STATES, RECOVERING];

const ALARM_KIND_SET = new Set<string>(ALARM_KINDS);

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
   *
   * **Only the steps the reader can see** (`A-12`). The containers above a granted branch are
   * outside it, so a customer's alarm reads from their own group down.
   */
  readonly path: readonly number[];
  readonly pathNames: readonly string[];
  readonly acknowledged: boolean;
  /** `null` while acknowledged indefinitely, absent when not acknowledged at all. */
  readonly acknowledgedUntil: string | null;
  readonly consecutiveFailures: number;
  /**
   * The return its alarm is holding, or `null` when none is (`M-18`).
   *
   * Set on a sensor that is back and listed for that alone, and also on one that is back from
   * Down only as far as Warning, whose Down alarm is still waiting to see the return last.
   */
  readonly recovering: HeldReturn | null;
}

/** A return to Up that has not yet lasted its hold (`M-18`). */
export interface HeldReturn {
  /** When the sensor came back, ISO-8601. */
  readonly since: string;
  /**
   * When the alarm is over if it does not fail again, ISO-8601 — the last of its alarms' holds to
   * end, since the row goes when that one does. `null` only if nothing is due, which the engine
   * never leaves a held return in.
   */
  readonly confirmsAt: string | null;
}

export interface AlarmQuery {
  /**
   * Whose alarms these are (`A-12`). An alarm on a sensor the reader cannot see is absent, and
   * absent from `total` and `counts` too — a chip saying "3 down" over a list of two is the hole
   * announcing itself.
   */
  readonly visibility: Visibility;
  /** Scope to one object and everything beneath it. Absent means the whole installation. */
  readonly objectId?: number;
  /** Which of `ALARM_KINDS` to include. Absent means all of them. */
  readonly states?: readonly AlarmKind[];
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
  /**
   * The core's clock when the page was read, ISO-8601.
   *
   * For the one timer a reader needs (`M-18`): a held return's end is not a state change, so the
   * list asks again at `confirmsAt`. Measured against this rather than the browser's clock, which
   * can be minutes out, and a list waiting on it would reload long before the hold ended or long
   * after.
   */
  readonly now: string;
  /** How many matched before `limit`, so a truncated list can say what it is not showing. */
  readonly total: number;
  /** Counts per kind across the whole scope, ignoring the state filter — the filter's own chips. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface AlarmServiceOptions {
  db: Database;
  logger: Logger;
}

/**
 * The returns being held (`M-18`), one row per sensor, for the scans below. `$1` is `ALARM_STATES`.
 *
 * **Every held alarm on the sensor, summed up.** Each trigger holds its own alarm, and a trigger
 * may set its own hold, so the row is over when the last of them is: its return began at the
 * earliest and it confirms at the latest. `notification_alarm` only has rows for alarms that
 * stand, so reading all of it is reading a few dozen rows.
 */
const HELD = `held AS (
        SELECT sensor_id, min(recovering_since) AS since, max(next_due_at) AS confirms_at
        FROM notification_alarm
        WHERE recovering_since IS NOT NULL
        GROUP BY sensor_id
      )`;

/**
 * Which sensors a scan starts from: those in an alarm state, and those whose return is held.
 *
 * A union rather than an `OR` in one `WHERE`, so the first half is still the partial index's to
 * answer and the second half adds only the held few.
 */
const LISTED = `
          SELECT object_id FROM sensor_runtime WHERE state = ANY($1::sensor_state_kind[])
          UNION
          SELECT sensor_id FROM held`;

/**
 * A row's kind: its state when that is an alarm state, and otherwise a held return. A sensor back
 * from Down as far as Warning is listed as Warning, with the hold beside it.
 */
const KIND = `CASE WHEN r.state = ANY($1::sensor_state_kind[]) THEN r.state::text
                    ELSE '${RECOVERING}' END`;

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
 *
 * **A held return is listed until its alarm is over** (`M-18`). The sensor is Up, but its alarm
 * still stands and will either recover or resume. It is listed apart, as `recovering`, below
 * everything still happening. It is read from `notification_alarm` beside the runtime rows, and
 * seen through the same visibility, so a return the reader cannot see is neither listed nor
 * counted (`A-12`).
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
    const now = new Date().toISOString();
    const kinds = (query.states ?? ALARM_KINDS).filter((kind) => ALARM_KIND_SET.has(kind));
    if (kinds.length === 0) return { items: [], total: 0, counts: {}, now };

    // Every alarm state goes into the scan; the requested subset filters *after* the scope is
    // established. That ordering is what lets the severity chips keep counting a kind the reader
    // has currently filtered out — a chip that hides its own subject is a chip that lies.
    const values: unknown[] = [ALARM_STATES, query.objectId ?? null];
    const bind = (value: unknown): string => `$${String(values.push(value))}`;
    // Part of the scan, so it is part of the scope: what the reader cannot see is neither listed
    // nor counted (`A-12`). That includes a held return, which enters through the same scan.
    const visibleSensor = query.visibility.where('r.object_id', bind);
    const visibleStep = query.visibility.where('chain.id', bind);
    const where: string[] = [`kind = ANY($${String(values.push(kinds))}::text[])`];
    if (query.priorityMin !== undefined) {
      where.push(`priority >= $${String(values.push(query.priorityMin))}`);
    }
    if (query.includeAcknowledged === false) where.push('NOT acknowledged');
    const limit = `$${String(values.push(query.limit))}`;

    // A held return comes after every alarm that is still happening, whatever its priority
    // (`M-18`): the sensor is back, and a priority-5 Probe Health waiting out its hold above a
    // priority-3 Down would put the one thing nobody can act on at the top of the list.
    const order =
      query.sort === 'duration'
        ? // Oldest first: the question is "what has been broken longest".
          `kind = '${RECOVERING}', since ASC, sensor_id ASC`
        : // WORKFLOW.MD §7: priority then duration. Highest priority first, and within a
          // priority the one that has been wrong longest.
          `kind = '${RECOVERING}', priority DESC, since ASC, sensor_id ASC`;

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
      recovering_since: Date | null;
      confirms_at: Date | null;
      total: string;
      counts: Record<string, number>;
    }>(
      `
      WITH RECURSIVE ${HELD},
      alarming AS (
        -- The partial index answers this. Everything below walks a few dozen rows, not the tree.
        SELECT r.object_id AS sensor_id, r.state, r.cause, r.message,
               ${KIND} AS kind,
               held.since AS recovering_since, held.confirms_at,
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
        LEFT JOIN held ON held.sensor_id = r.object_id
        WHERE r.object_id IN (${LISTED})
          AND ${visibleSensor}
      ),
      chain AS (
        SELECT a.sensor_id, o.id, o.parent_id, o.name, o.priority, 0 AS depth
        FROM alarming a
        JOIN object o ON o.id = a.sensor_id
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id, p.name, chain.priority, chain.depth + 1
        FROM chain
        JOIN object p ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      ),
      -- Each step marked once, so the ids and the names are trimmed by the same answer.
      sighted AS (
        SELECT chain.*, ${visibleStep} AS visible FROM chain
      ),
      placed AS (
        SELECT sensor_id,
               max(priority) AS priority,
               -- The whole chain, for scoping; the visible steps, for showing (A-12).
               array_agg(id ORDER BY depth DESC) AS chain_ids,
               array_agg(id ORDER BY depth DESC) FILTER (WHERE visible) AS path,
               array_agg(name ORDER BY depth DESC) FILTER (WHERE visible) AS path_names,
               min(name) FILTER (WHERE depth = 0) AS name
        FROM sighted
        GROUP BY sensor_id
      ),
      scoped AS (
        SELECT a.sensor_id, p.name, p.path, p.path_names, p.priority,
               a.state, a.kind, a.cause, a.message, a.since, a.consecutive_failures,
               a.recovering_since, a.confirms_at,
               a.acknowledged_at IS NOT NULL AS acknowledged,
               a.acknowledged_until
        FROM alarming a
        JOIN placed p ON p.sensor_id = a.sensor_id
        -- Branch scoping is "is this object anywhere in the chain", which is the same walk the
        -- names came from. No second query, and no separate notion of "beneath".
        WHERE $2::bigint IS NULL OR $2::bigint = ANY(p.chain_ids)
      ),
      filtered AS (
        SELECT * FROM scoped WHERE ${where.join(' AND ')}
      )
      SELECT f.sensor_id::text AS sensor_id,
             f.name,
             f.state, f.cause, f.message, f.since, f.priority,
             f.path::text[] AS path, f.path_names,
             f.acknowledged, f.acknowledged_until, f.consecutive_failures,
             f.recovering_since, f.confirms_at,
             (SELECT count(*) FROM filtered)::text AS total,
             -- Counts come from "scoped", before the state and priority filters, so the chips
             -- keep saying how many there are of a kind the reader has currently filtered out.
             (SELECT coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
                FROM (SELECT kind, count(*) AS n FROM scoped GROUP BY kind) AS s) AS counts
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
      return {
        items: [],
        total: 0,
        counts: await this.#counts(q, query.objectId ?? null, query.visibility),
        now,
      };
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
        recovering:
          row.recovering_since === null
            ? null
            : {
                since: row.recovering_since.toISOString(),
                confirmsAt: row.confirms_at?.toISOString() ?? null,
              },
      })),
      total: Number(first.total),
      counts: first.counts,
      now,
    };
  }

  /** The per-kind chips when the filtered list came back empty. */
  async #counts(
    q: Queryable,
    objectId: number | null,
    visibility: Visibility,
  ): Promise<Record<string, number>> {
    const values: unknown[] = [ALARM_STATES, objectId];
    const visibleSensor = visibility.where(
      'r.object_id',
      (value) => `$${String(values.push(value))}`,
    );
    const rows = await q.query<{ kind: string; n: string }>(
      `
      WITH RECURSIVE ${HELD},
      alarming AS (
        SELECT r.object_id AS sensor_id, ${KIND} AS kind
        FROM sensor_runtime r
        LEFT JOIN held ON held.sensor_id = r.object_id
        WHERE r.object_id IN (${LISTED})
          AND ${visibleSensor}
      ),
      chain AS (
        SELECT a.sensor_id, o.id, o.parent_id, 0 AS depth
        FROM alarming a JOIN object o ON o.id = a.sensor_id
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id, chain.depth + 1
        FROM chain JOIN object p ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT a.kind, count(*)::text AS n
      FROM alarming a
      WHERE $2::bigint IS NULL
         OR EXISTS (SELECT 1 FROM chain c WHERE c.sensor_id = a.sensor_id AND c.id = $2::bigint)
      GROUP BY a.kind
      `,
      values,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.kind] = Number(row.n);
    return counts;
  }

  /** For Core Health, once `P-12` reads it. */
  get logger(): Logger {
    return this.#logger;
  }
}
