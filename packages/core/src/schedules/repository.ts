import type { Queryable } from '../db/pool.js';
import type { Visibility } from '../auth/access.js';
import type { ObjectId } from '../objects/types.js';
import { SCHEDULE_ID } from '../settings/registry.js';
import {
  normaliseIntervals,
  type ScheduleAuthoring,
  type ScheduleDefinition,
  type SchedulePolarity,
  type WeekInterval,
} from './definition.js';

const MAX_WALK_DEPTH = 1000;

/** A stored schedule: what it is called, and what it means. */
export interface StoredSchedule {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly authoredAs: ScheduleAuthoring;
  /** `null` for one an operator created. */
  readonly builtInId: string | null;
  readonly definition: ScheduleDefinition;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a schedule is being changed to. Every field, because a partial update is an upsert. */
export interface ScheduleWrite {
  readonly name: string;
  readonly description: string;
  readonly authoredAs: ScheduleAuthoring;
  readonly definition: ScheduleDefinition;
}

/** One sensor whose schedule flag moved, and which schedule moved it. */
export interface ScheduleFlagChange {
  readonly sensorId: number;
  readonly scheduleId: number | null;
  readonly paused: boolean;
}

interface ScheduleRow {
  id: string;
  name: string;
  description: string;
  periods: unknown;
  polarity: string;
  authored_as: string;
  timezone: string | null;
  built_in_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toStored(row: ScheduleRow): StoredSchedule {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    authoredAs: row.authored_as as ScheduleAuthoring,
    builtInId: row.built_in_id,
    definition: {
      // Normalised on the way out as well as in. The column is jsonb, so a hand-written row is
      // possible, and an evaluator that assumed sorted disjoint intervals would answer wrongly
      // rather than loudly.
      periods: normaliseIntervals(readPeriods(row.periods)),
      polarity: row.polarity as SchedulePolarity,
      timezone: row.timezone,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readPeriods(value: unknown): WeekInterval[] {
  if (!Array.isArray(value)) return [];
  const periods: WeekInterval[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const start = record['start'];
    const end = record['end'];
    if (typeof start === 'number' && typeof end === 'number') periods.push({ start, end });
  }
  return periods;
}

/**
 * Everything `schedule` does, plus the derivation of `sensor_runtime.paused_by_schedule` from
 * it (`M-09`).
 *
 * Beside `PauseRepository` rather than inside it: the two derive the same column family from
 * completely different facts — one from rows an operator wrote, one from the clock — and the
 * only thing they share is the table they write to.
 */
export class ScheduleRepository {
  async list(q: Queryable): Promise<StoredSchedule[]> {
    const rows = await q.query<ScheduleRow>(
      `SELECT id::text AS id, name, description, periods, polarity, authored_as, timezone,
              built_in_id, created_at, updated_at
       FROM schedule ORDER BY name`,
    );
    return rows.map(toStored);
  }

  async get(q: Queryable, id: number): Promise<StoredSchedule | null> {
    const rows = await q.query<ScheduleRow>(
      `SELECT id::text AS id, name, description, periods, polarity, authored_as, timezone,
              built_in_id, created_at, updated_at
       FROM schedule WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toStored(row);
  }

  async create(q: Queryable, write: ScheduleWrite, builtInId: string | null): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO schedule (name, description, periods, polarity, authored_as, timezone,
                             built_in_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        write.name,
        write.description,
        JSON.stringify(write.definition.periods),
        write.definition.polarity,
        write.authoredAs,
        write.definition.timezone,
        builtInId,
      ],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async update(q: Queryable, id: number, write: ScheduleWrite): Promise<void> {
    await q.query(
      `UPDATE schedule
       SET name = $2, description = $3, periods = $4::jsonb, polarity = $5, authored_as = $6,
           timezone = $7
       WHERE id = $1`,
      [
        id,
        write.name,
        write.description,
        JSON.stringify(write.definition.periods),
        write.definition.polarity,
        write.authoredAs,
        write.definition.timezone,
      ],
    );
  }

  async delete(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      'DELETE FROM schedule WHERE id = $1 RETURNING id::text AS id',
      [id],
    );
    return rows.length > 0;
  }

  /** Insert-if-absent, by built-in id. What startup seeding calls. */
  async seed(q: Queryable, write: ScheduleWrite, builtInId: string): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO schedule (name, description, periods, polarity, authored_as, timezone,
                             built_in_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (built_in_id) DO NOTHING
       RETURNING id::text AS id`,
      [
        write.name,
        write.description,
        JSON.stringify(write.definition.periods),
        write.definition.polarity,
        write.authoredAs,
        write.definition.timezone,
        builtInId,
      ],
    );
    return rows.length > 0;
  }

  /**
   * The objects that name this schedule directly.
   *
   * `object_setting.value` is jsonb, so the reference cannot be a foreign key and a delete has
   * to look for itself. Returned as objects rather than counted, because "3 objects still use
   * this" is a refusal an operator cannot act on and "the London group, the Berlin group and
   * db-01" is one they can.
   */
  async usedBy(
    q: Queryable,
    id: number,
    visibility: Visibility,
    limit = 50,
  ): Promise<{ objectId: ObjectId; name: string }[]> {
    // Among the objects the reader can see (`A-16`), as `usageCounts` counts them.
    const values: unknown[] = [SCHEDULE_ID.key, id, limit];
    const visible = visibility.where('s.object_id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ object_id: string; name: string }>(
      `SELECT s.object_id::text AS object_id, o.name
       FROM object_setting s JOIN object o ON o.id = s.object_id
       WHERE s.key = $1 AND s.value = to_jsonb($2::bigint) AND ${visible}
       ORDER BY o.name, o.id
       LIMIT $3`,
      values,
    );
    return rows.map((row) => ({ objectId: Number(row.object_id), name: row.name }));
  }

  /**
   * Notification templates active only during this schedule (`N-12`).
   *
   * A real foreign key, unlike the object assignment, and `ON DELETE RESTRICT` — so the database
   * would refuse the delete on its own. This exists to refuse it with names instead of with a
   * constraint violation, the same way `usedBy` does for objects.
   */
  async templatesUsing(
    q: Queryable,
    id: number,
    limit = 50,
  ): Promise<{ templateId: number; name: string }[]> {
    const rows = await q.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM notification_template
       WHERE schedule_id = $1 ORDER BY name LIMIT $2`,
      [id, limit],
    );
    return rows.map((row) => ({ templateId: Number(row.id), name: row.name }));
  }

  /**
   * How many objects name this schedule, which is not how many the page above returned.
   *
   * **`P-129`.** `usedBy` is a page — fifty rows — and the refusal was built from its length, so
   * a schedule assigned to two hundred objects told the operator it was assigned to fifty. They
   * clear fifty, try again, and are told fifty again.
   */
  async usedByCount(q: Queryable, id: number, visibility: Visibility): Promise<number> {
    const values: unknown[] = [SCHEDULE_ID.key, id];
    const visible = visibility.where('object_id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM object_setting
       WHERE key = $1 AND value = to_jsonb($2::bigint) AND ${visible}`,
      values,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Rediscovery rules whose permitted window is this schedule (`D-07`).
   *
   * **A real foreign key with `ON DELETE RESTRICT`, and nothing was checking it** (`P-130`). The
   * other two users of a schedule are refused by name; this one reached the delete and came back
   * as a raw constraint violation — a 500 with a constraint name in it, for an operator doing
   * something perfectly ordinary and correctable.
   */
  async rediscoveryUsing(
    q: Queryable,
    id: number,
    visibility: Visibility,
    limit = 50,
  ): Promise<{ ruleId: number; name: string }[]> {
    // A rule belongs to the group it sweeps, and is listed only to a reader of it (`A-16`).
    const values: unknown[] = [id, limit];
    const visible = visibility.where('group_id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ id: string; name: string }>(
      // The table's id, not this SELECT's text one, which sorts 1000 before 999 (P-385 review).
      `SELECT id::text AS id, name FROM discovery_schedule
       WHERE schedule_id = $1 AND ${visible} ORDER BY name, discovery_schedule.id LIMIT $2`,
      values,
    );
    return rows.map((row) => ({ ruleId: Number(row.id), name: row.name }));
  }

  /**
   * How many rediscovery rules name this schedule, among those `visibility` reads. A count, not
   * the length of the page above: two pages of fifty agree however many rules lie past them.
   */
  async rediscoveryCount(q: Queryable, id: number, visibility: Visibility): Promise<number> {
    const values: unknown[] = [id];
    const visible = visibility.where('group_id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM discovery_schedule
       WHERE schedule_id = $1 AND ${visible}`,
      values,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * How many objects name each schedule. One query for a list that shows usage per row.
   *
   * **Among the objects the reader can see** (`A-12`): a schedule belongs to the installation,
   * but the objects using it belong to branches, and a count of them would say how busy a branch
   * the reader was not given is. A delete is still refused by every use, and counts for its
   * caller only the ones they can see (`A-16`).
   */
  async usageCounts(q: Queryable, visibility: Visibility): Promise<Map<number, number>> {
    const values: unknown[] = [SCHEDULE_ID.key];
    const visible = visibility.where('object_id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ schedule_id: string; uses: string }>(
      `SELECT (value #>> '{}') AS schedule_id, count(*)::text AS uses
       FROM object_setting
       WHERE key = $1 AND jsonb_typeof(value) = 'number' AND ${visible}
       GROUP BY 1`,
      values,
    );
    return new Map(rows.map((row) => [Number(row.schedule_id), Number(row.uses)]));
  }

  /**
   * Whether there is anything for a recompute to do.
   *
   * The guard in front of everything below, and the reason an installation that uses no
   * schedules pays a `LIMIT 1` a minute for the feature rather than a scan of every sensor —
   * the same lesson `PauseRepository.anyActive` came from.
   *
   * **Two questions, not one**, and the second is the one a test found missing: "nothing is
   * assigned" does not mean "nothing to do", because clearing the *last* assignment leaves the
   * flags it set standing and nothing else would ever clear them. Both halves are indexed and
   * the `LIMIT 1` short-circuits, so asking both still costs one round trip.
   */
  async anyWork(q: Queryable): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM object_setting
       WHERE key = $1 AND jsonb_typeof(value) = 'number'
       UNION ALL
       SELECT 1 AS one FROM sensor_runtime WHERE paused_by_schedule
       LIMIT 1`,
      [SCHEDULE_ID.key],
    );
    return rows.length > 0;
  }

  /**
   * Sets `paused_by_schedule` for every sensor, from the set of schedules that are inactive now.
   *
   * **Resolved downward, not upward.** `resolveForObjects` answers "what does this object
   * inherit" by walking from each of five thousand sensors to the root; this walks from each
   * *assignment* — of which an installation has a handful — down to the sensors it covers,
   * stopping wherever a nearer assignment takes over. Same rule, same result, opposite
   * direction, and a test asserts the two agree rather than trusting that they do.
   *
   * Returns only the sensors whose flag actually moved, because those are the ones with a state
   * change to record. A window closing over four thousand sensors writes four thousand
   * transitions; the next minute's sweep writes none.
   */
  async applyPauses(
    q: Queryable,
    inactiveScheduleIds: readonly number[],
    only?: readonly number[],
  ): Promise<ScheduleFlagChange[]> {
    const rows = await q.query<{ object_id: string; paused: boolean; schedule_id: string | null }>(
      `
      WITH RECURSIVE assigned AS (
        SELECT s.object_id AS node,
               CASE WHEN jsonb_typeof(s.value) = 'number'
                    THEN (s.value #>> '{}')::bigint END AS schedule_id,
               0 AS depth
        FROM object_setting s
        WHERE s.key = $2

        UNION ALL

        SELECT c.id, a.schedule_id, a.depth + 1
        FROM object c
        JOIN assigned a ON c.parent_id = a.node
        WHERE a.depth < ${String(MAX_WALK_DEPTH)}
          -- An object that assigns its own schedule ends the inheritance here, exactly as the
          -- resolver's "nearest ancestor wins" does when read from the other end.
          AND NOT EXISTS (
            SELECT 1 FROM object_setting s2
            WHERE s2.object_id = c.id AND s2.key = $2
          )
      ),
      want AS (
        SELECT o.id AS sensor_id,
               a.schedule_id,
               coalesce(a.schedule_id = ANY($1::bigint[]), false) AS paused
        FROM object o
        LEFT JOIN assigned a ON a.node = o.id
        WHERE o.kind = 'sensor'
          -- Restricted to a named set when the caller has one (P-109): a create knows which
          -- sensors it made, and discovery makes them in thousands, so answering for those is
          -- one indexed lookup rather than a walk over every sensor in the installation.
          AND ($3::bigint[] IS NULL OR o.id = ANY($3::bigint[]))
      )
      UPDATE sensor_runtime r
      SET paused_by_schedule = want.paused
      FROM want
      WHERE r.object_id = want.sensor_id
        AND r.paused_by_schedule IS DISTINCT FROM want.paused
      RETURNING r.object_id::text AS object_id, want.paused,
                want.schedule_id::text AS schedule_id
      `,
      [inactiveScheduleIds, SCHEDULE_ID.key, only === undefined ? null : [...only]],
    );
    return rows.map((row) => ({
      sensorId: Number(row.object_id),
      scheduleId: row.schedule_id === null ? null : Number(row.schedule_id),
      paused: row.paused,
    }));
  }

  /**
   * The schedule in effect for one object, resolved downward like `applyPauses`.
   *
   * What the pause view calls to answer "why is this sensor paused" when the answer is not a
   * row in `object_pause`. One object, so the walk is up rather than down — the resolver's own
   * query — but the assignment may be defined above the object and the id has to come back with
   * whose it is.
   */
  async effectiveFor(
    q: Queryable,
    objectId: ObjectId,
  ): Promise<{ scheduleId: number; definedOn: ObjectId } | null> {
    const rows = await q.query<{ value: unknown; object_id: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id, o.parent_id, 0 AS depth FROM object o WHERE o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT s.value, s.object_id::text AS object_id
      FROM chain
      JOIN object_setting s ON s.object_id = chain.id AND s.key = $2
      ORDER BY chain.depth
      LIMIT 1
      `,
      [objectId, SCHEDULE_ID.key],
    );
    const row = rows[0];
    if (row === undefined || typeof row.value !== 'number') return null;
    return { scheduleId: row.value, definedOn: Number(row.object_id) };
  }
}
