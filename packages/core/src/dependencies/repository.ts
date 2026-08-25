import type { Queryable } from '../db/pool.js';
import type { ObjectId } from '../objects/types.js';
import { DEPENDENCY_MASTER_ID } from '../settings/registry.js';

const MAX_WALK_DEPTH = 1000;

/** One sensor whose dependency flag moved, and which master moved it. */
export interface DependencyFlagChange {
  readonly sensorId: number;
  readonly masterId: number | null;
  readonly paused: boolean;
}

/** A master, as the reactor needs to see it. */
export interface MasterState {
  readonly sensorId: number;
  readonly state: string;
  readonly clearAt: Date | null;
}

/**
 * Everything the dependency graph does in SQL (`M-11`).
 *
 * The relationship itself is nowhere in here: it lives in `object_setting` as an ordinary
 * inheritable value, exactly as `M-09`'s schedule does. What this owns is the *derivation* —
 * which sensors a master currently holds, and the recovery deadline that keeps holding them for
 * a moment after it comes back.
 */
export class DependencyRepository {
  /**
   * Which of these sensors is the master of anything.
   *
   * The first question asked on every batch that changed a state, and the reason an installation
   * with no dependencies pays one indexed lookup per batch rather than a recompute. An empty
   * answer ends the work.
   */
  async mastersAmong(q: Queryable, sensorIds: readonly number[]): Promise<number[]> {
    if (sensorIds.length === 0) return [];
    const rows = await q.query<{ master_id: string }>(
      `SELECT DISTINCT (value #>> '{}') AS master_id
       FROM object_setting
       WHERE key = $1 AND (value #>> '{}') = ANY($2::text[])`,
      [DEPENDENCY_MASTER_ID.key, sensorIds.map((id) => String(id))],
    );
    return rows.map((row) => Number(row.master_id));
  }

  /**
   * Whether there is anything for a recompute to do.
   *
   * **Two questions, not one.** "Nothing names a master" is not "nothing to do": clearing the
   * *last* dependency leaves the flags it set standing, and nothing else would ever clear them.
   * `M-09` learned the same lesson from its own test, and this is the same shape — both halves
   * are indexed, and the `LIMIT 1` short-circuits, so asking both is still one round trip.
   */
  async anyWork(q: Queryable): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM object_setting
       WHERE key = $1 AND jsonb_typeof(value) = 'number'
       UNION ALL
       SELECT 1 AS one FROM sensor_runtime WHERE paused_by_dependency
       LIMIT 1`,
      [DEPENDENCY_MASTER_ID.key],
    );
    return rows.length > 0;
  }

  /**
   * Starts and stops the recovery delay on the masters that just changed state.
   *
   * `WORKFLOW.MD §5`'s delay after dependency ends, and `docs/state-machine.md §6`'s question
   * about what restarts it when a master flaps: a fresh failure clears the deadline, a fresh
   * recovery writes a new one. Nothing accumulates, and nothing has to remember what the last
   * one was.
   *
   * Set only for a master that recovered *from Down*. A dependent further down a chain being
   * released is not a recovery, and giving each link its own delay would multiply one outage's
   * settling time by the length of the chain.
   */
  async markRecoveries(
    q: Queryable,
    recovered: readonly { sensorId: number; delaySeconds: number }[],
    failed: readonly number[],
    now: Date,
  ): Promise<void> {
    if (failed.length > 0) {
      // Down again. The deadline from its last recovery is meaningless now, and leaving it would
      // keep the dependents paused for an extra delay after the *next* recovery.
      await q.query(
        `UPDATE sensor_runtime SET dependency_clear_at = NULL
         WHERE object_id = ANY($1::bigint[]) AND dependency_clear_at IS NOT NULL`,
        [failed],
      );
    }
    const delayed = recovered.filter((entry) => entry.delaySeconds > 0);
    if (delayed.length > 0) {
      await q.query(
        `UPDATE sensor_runtime r
         SET dependency_clear_at = $2::timestamptz + (want.seconds || ' seconds')::interval
         FROM (SELECT * FROM unnest($1::bigint[], $3::int[]) AS t(sensor_id, seconds)) want
         WHERE r.object_id = want.sensor_id`,
        [delayed.map((e) => e.sensorId), now, delayed.map((e) => e.delaySeconds)],
      );
    }
  }

  /** Masters whose recovery delay has run out. What the sweep releases. */
  async delaysElapsed(q: Queryable, now: Date, limit: number): Promise<number[]> {
    const rows = await q.query<{ object_id: string }>(
      `SELECT object_id::text AS object_id FROM sensor_runtime
       WHERE dependency_clear_at IS NOT NULL AND dependency_clear_at <= $1
       ORDER BY dependency_clear_at
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => Number(row.object_id));
  }

  /** Clears the deadline on masters whose delay has elapsed, so it is asked once. */
  async clearDelays(q: Queryable, sensorIds: readonly number[]): Promise<void> {
    if (sensorIds.length === 0) return;
    await q.query(
      'UPDATE sensor_runtime SET dependency_clear_at = NULL WHERE object_id = ANY($1::bigint[])',
      [sensorIds],
    );
  }

  /**
   * Sets `paused_by_dependency` for every sensor, from the masters that are holding right now.
   *
   * Resolved downward from each assignment, the same way `M-09` resolves schedules and for the
   * same reason: an installation has a handful of dependency assignments and five thousand
   * sensors, so walking from the assignments is the cheap direction. A test asserts it agrees
   * with what the resolver says when walked the other way.
   *
   * **A master never depends on itself.** That one exclusion is what keeps a master scanning
   * while its dependents are paused — the bug PRTG carried until v19.1. Setting a device's
   * master to one of its own sensors, which is what "master object for parent device" does, means
   * every sensor under the device inherits that master including the master itself; without the
   * exclusion the master would pause the instant it went Down and nothing would ever notice it
   * recover.
   */
  async applyPauses(q: Queryable, now: Date): Promise<DependencyFlagChange[]> {
    const rows = await q.query<{ object_id: string; paused: boolean; master_id: string | null }>(
      `
      WITH RECURSIVE assigned AS (
        SELECT s.object_id AS node,
               CASE WHEN jsonb_typeof(s.value) = 'number'
                    THEN (s.value #>> '{}')::bigint END AS master_id,
               0 AS depth
        FROM object_setting s
        WHERE s.key = $2

        UNION ALL

        SELECT c.id, a.master_id, a.depth + 1
        FROM object c
        JOIN assigned a ON c.parent_id = a.node
        WHERE a.depth < ${String(MAX_WALK_DEPTH)}
          AND NOT EXISTS (
            SELECT 1 FROM object_setting s2
            WHERE s2.object_id = c.id AND s2.key = $2
          )
      ),
      holding AS (
        SELECT m.object_id AS master_id
        FROM sensor_runtime m
        -- A genuine outage, an acknowledged one (an acknowledgement is a statement about
        -- notifications, not about the target), a master held by its own master -- which is what
        -- makes the cascade recursive -- or a recovery still inside its delay.
        WHERE m.state IN ('down', 'down_acknowledged')
           OR m.paused_by_dependency
           OR (m.dependency_clear_at IS NOT NULL AND m.dependency_clear_at > $1)
      ),
      want AS (
        SELECT o.id AS sensor_id,
               a.master_id,
               (a.master_id IS NOT NULL
                AND a.master_id <> o.id
                AND a.master_id IN (SELECT master_id FROM holding)) AS paused
        FROM object o
        LEFT JOIN assigned a ON a.node = o.id
        WHERE o.kind = 'sensor'
      )
      UPDATE sensor_runtime r
      SET paused_by_dependency = want.paused
      FROM want
      WHERE r.object_id = want.sensor_id
        AND r.paused_by_dependency IS DISTINCT FROM want.paused
      RETURNING r.object_id::text AS object_id, want.paused,
                want.master_id::text AS master_id
      `,
      [now, DEPENDENCY_MASTER_ID.key],
    );
    return rows.map((row) => ({
      sensorId: Number(row.object_id),
      masterId: row.master_id === null ? null : Number(row.master_id),
      paused: row.paused,
    }));
  }

  /** The names of some masters, for a message an operator can act on. */
  async namesOf(q: Queryable, sensorIds: readonly number[]): Promise<Map<number, string>> {
    if (sensorIds.length === 0) return new Map();
    const rows = await q.query<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM object WHERE id = ANY($1::bigint[])',
      [sensorIds],
    );
    return new Map(rows.map((row) => [Number(row.id), row.name]));
  }

  /**
   * The master in effect for one object, and where it is defined.
   *
   * Walked up rather than down, because this is the single-object question the pause view asks.
   */
  async effectiveFor(
    q: Queryable,
    objectId: ObjectId,
  ): Promise<{ masterId: number; definedOn: ObjectId } | null> {
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
      [objectId, DEPENDENCY_MASTER_ID.key],
    );
    const row = rows[0];
    if (row === undefined || typeof row.value !== 'number') return null;
    return { masterId: row.value, definedOn: Number(row.object_id) };
  }

  /**
   * Whether depending on `masterId` would close a loop back to `objectId` (`M-11`).
   *
   * Walked at the moment somebody sets it, because a cycle is not merely wrong — it deadlocks.
   * If A's master is B and B's master is A, the first of them to go Down pauses the other, the
   * paused one stops scanning, and neither can ever recover: a permanent outage produced by a
   * configuration mistake, with nothing in the system able to notice.
   *
   * The walk follows *effective* masters, so it sees the loop an operator would actually create
   * by pointing a device at a sensor whose own device points back. Anything at or beneath the
   * object being configured counts as reaching it, since those inherit what is being set.
   */
  async wouldCycle(
    q: Queryable,
    objectId: ObjectId,
    masterId: ObjectId,
    maxDepth = 32,
  ): Promise<{ path: number[] } | null> {
    const path: number[] = [masterId];
    const seen = new Set<number>([masterId]);
    let current: number | null = await this.#nextMaster(q, masterId);

    for (let depth = 0; depth < maxDepth && current !== null; depth += 1) {
      // Reaching a sensor inside the configured subtree closes the loop: that sensor would
      // inherit the master being set, and the master's own chain leads back to it.
      //
      // The master itself is exempt, and that exemption is the whole of "master object for
      // parent device". Pointing a device at one of its own sensors puts that sensor inside the
      // subtree it now governs — which looks like a loop and is not, because a master never
      // depends on itself and so has nothing to lead back through.
      if (await this.#isWithin(q, current, objectId)) return { path: [...path, current] };
      path.push(current);
      // A loop that does not pass through the object being configured is somebody else's
      // problem — already refused when it was made — and following it for ever is not this
      // call's job.
      if (seen.has(current)) return null;
      seen.add(current);
      current = await this.#nextMaster(q, current);
    }
    return null;
  }

  /** One hop along the master chain, with the self-exclusion the evaluator applies. */
  async #nextMaster(q: Queryable, sensorId: number): Promise<number | null> {
    const next = await this.effectiveFor(q, sensorId);
    if (next === null || next.masterId === sensorId) return null;
    return next.masterId;
  }

  /** Whether `candidate` is `ancestor` or sits beneath it, and so inherits what it defines. */
  async #isWithin(q: Queryable, candidate: number, ancestor: number): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id, o.parent_id, 0 AS depth FROM object o WHERE o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT 1 AS one FROM chain WHERE id = $2 LIMIT 1
      `,
      [candidate, ancestor],
    );
    return rows.length > 0;
  }

  /** One master's state, for the pause view and for the cycle check. */
  async stateOf(q: Queryable, sensorId: number, now: Date): Promise<MasterState | null> {
    const rows = await q.query<{ state: string; clear_at: Date | null }>(
      `SELECT state, dependency_clear_at AS clear_at FROM sensor_runtime WHERE object_id = $1`,
      [sensorId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    void now;
    return { sensorId, state: row.state, clearAt: row.clear_at };
  }
}
