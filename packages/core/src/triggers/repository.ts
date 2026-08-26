import type { Queryable } from '../db/pool.js';
import type { ObjectId } from '../objects/types.js';

const MAX_WALK_DEPTH = 1000;

/** A stored trigger, and where it lives. */
export interface StoredTrigger {
  readonly id: number;
  readonly objectId: ObjectId;
  readonly kind: string;
  readonly settings: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A trigger as it applies to one object, with the answer to "where did this come from". */
export interface EffectiveTrigger extends StoredTrigger {
  /** False when the trigger is defined on this object itself. */
  readonly inherited: boolean;
  /** How far up the chain it was found. Zero is the object's own. */
  readonly depth: number;
  readonly definedOn: { readonly objectId: ObjectId; readonly name: string };
}

export interface TriggerWrite {
  readonly kind: string;
  readonly settings: Record<string, unknown>;
  readonly enabled: boolean;
}

interface TriggerRow {
  id: string;
  object_id: string;
  kind: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toStored(row: TriggerRow): StoredTrigger {
  return {
    id: Number(row.id),
    objectId: Number(row.object_id),
    kind: row.kind,
    settings: row.settings,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `
  t.id::text AS id, t.object_id::text AS object_id, t.kind, t.settings, t.enabled,
  t.created_at, t.updated_at
`;

/**
 * Where triggers live and how they are inherited (`N-01`).
 *
 * **The walk accumulates rather than choosing.** `InheritanceResolver` answers "what does this
 * object inherit" by taking the nearest ancestor that defines a key; a trigger set is the union
 * of everything defined along the chain, because `CAPABILITIES.MD §5.1` says a child shows its
 * own *and* every inherited trigger. A trigger on the root and one on a device both fire.
 *
 * Ordered nearest-first, so a UI can render "this object" above "inherited from London" without
 * sorting, and so the engine sees the most specific rule first.
 *
 * **`object.inherits_triggers` is where a walk stops** (`N-16`). Both directions honour it and
 * both must, because they answer the same question from opposite ends: the tab walks up from a
 * sensor and the engine walks down from a trigger, and a fence one of them ignored would put a
 * notification on a page that says no notification applies.
 */
export class TriggerRepository {
  async get(q: Queryable, id: number): Promise<StoredTrigger | null> {
    const rows = await q.query<TriggerRow>(
      `SELECT ${COLUMNS} FROM notification_trigger t WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toStored(row);
  }

  /** The triggers defined on one object, ignoring inheritance. What a delete or an edit sees. */
  async own(q: Queryable, objectId: ObjectId): Promise<StoredTrigger[]> {
    const rows = await q.query<TriggerRow>(
      `SELECT ${COLUMNS} FROM notification_trigger t WHERE t.object_id = $1 ORDER BY t.id`,
      [objectId],
    );
    return rows.map(toStored);
  }

  /**
   * Every trigger in effect on one object: its own, then each ancestor's, nearest first.
   *
   * One query rather than a walk in TypeScript, so the tab and the engine cannot disagree about
   * what applies — and so the answer arrives in one round trip on a page that renders it beside
   * everything else about the object.
   */
  async effectiveFor(q: Queryable, objectId: ObjectId): Promise<EffectiveTrigger[]> {
    return (await this.effectiveForMany(q, [objectId])).get(objectId) ?? [];
  }

  /**
   * The same walk for several objects at once, which is what the engine asks per batch (`N-02`).
   *
   * Upward, unlike `effectiveForSensors` below, and the choice is pure cardinality. An ingestion
   * batch touches a few hundred sensors and each has a chain five objects long, so walking up
   * reads a few hundred rows. Walking down from a trigger on the root would expand every one of
   * five thousand sensors and then discard all but the batch — the right direction for a sweep
   * over everything, the wrong one for a batch.
   */
  async effectiveForMany(
    q: Queryable,
    objectIds: readonly ObjectId[],
  ): Promise<Map<ObjectId, EffectiveTrigger[]>> {
    const out = new Map<ObjectId, EffectiveTrigger[]>();
    if (objectIds.length === 0) return out;

    const rows = await q.query<TriggerRow & { origin: string; depth: number; owner_name: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS origin, o.id, o.parent_id, o.name, o.inherits_triggers, 0 AS depth
        FROM object o WHERE o.id = ANY($1::bigint[])
        UNION ALL
        SELECT chain.origin, p.id, p.parent_id, p.name, p.inherits_triggers, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        -- The fence (N-16): a node that does not inherit is still visited, so its own triggers
        -- count, and the climb stops there rather than reaching its parent.
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)} AND chain.inherits_triggers
      )
      SELECT ${COLUMNS}, chain.origin::text AS origin, chain.depth, chain.name AS owner_name
      FROM chain
      JOIN notification_trigger t ON t.object_id = chain.id
      ORDER BY chain.origin, chain.depth, t.id
      `,
      [objectIds],
    );

    for (const row of rows) {
      const origin = Number(row.origin);
      const effective: EffectiveTrigger = {
        ...toStored(row),
        inherited: row.depth > 0,
        depth: row.depth,
        definedOn: { objectId: Number(row.object_id), name: row.owner_name },
      };
      const existing = out.get(origin);
      if (existing === undefined) out.set(origin, [effective]);
      else existing.push(effective);
    }
    return out;
  }

  /**
   * The same question for many sensors at once, which is what the engine asks (`N-02`).
   *
   * Resolved **downward** from each trigger to the objects beneath it, the way `M-09` and `M-11`
   * resolve theirs and for the same reason: an installation has a handful of triggers and five
   * thousand sensors, so walking from the triggers is the cheap direction. Unlike those two, a
   * nearer trigger adds to the set rather than replacing it — the only thing that stops the
   * descent is `N-16`'s fence.
   */
  async effectiveForSensors(
    q: Queryable,
    sensorIds: readonly number[],
  ): Promise<Map<number, StoredTrigger[]>> {
    const out = new Map<number, StoredTrigger[]>();
    if (sensorIds.length === 0) return out;

    const rows = await q.query<TriggerRow & { sensor_id: string; depth: number }>(
      `
      WITH RECURSIVE covered AS (
        SELECT t.id AS trigger_id, t.object_id AS node, 0 AS depth
        FROM notification_trigger t
        WHERE t.enabled

        UNION ALL

        SELECT covered.trigger_id, c.id, covered.depth + 1
        FROM object c JOIN covered ON c.parent_id = covered.node
        -- The same fence, from the other end: a child that does not inherit is not covered, and
        -- neither is anything below it, because the descent never reaches it.
        WHERE covered.depth < ${String(MAX_WALK_DEPTH)} AND c.inherits_triggers
      )
      SELECT ${COLUMNS}, covered.node::text AS sensor_id, covered.depth
      FROM covered
      JOIN notification_trigger t ON t.id = covered.trigger_id
      WHERE covered.node = ANY($1::bigint[])
      ORDER BY covered.node, covered.depth, t.id
      `,
      [sensorIds],
    );

    for (const row of rows) {
      const sensorId = Number(row.sensor_id);
      const existing = out.get(sensorId);
      if (existing === undefined) out.set(sensorId, [toStored(row)]);
      else existing.push(toStored(row));
    }
    return out;
  }

  /**
   * Whether this installation has any trigger at all.
   *
   * The guard the engine will put in front of everything: a `LIMIT 1` on every batch that
   * changed a state, and nothing else, for an installation that notifies nobody. The same shape
   * `M-09` and `M-11` use, and the same reason.
   */
  async anyDefined(q: Queryable): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      'SELECT 1 AS one FROM notification_trigger WHERE enabled LIMIT 1',
    );
    return rows.length > 0;
  }

  async create(q: Queryable, objectId: ObjectId, write: TriggerWrite): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO notification_trigger (object_id, kind, settings, enabled)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id::text AS id`,
      [objectId, write.kind, JSON.stringify(write.settings), write.enabled],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async update(q: Queryable, id: number, write: TriggerWrite): Promise<void> {
    await q.query(
      `UPDATE notification_trigger
       SET kind = $2, settings = $3::jsonb, enabled = $4
       WHERE id = $1`,
      [id, write.kind, JSON.stringify(write.settings), write.enabled],
    );
  }

  async delete(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      'DELETE FROM notification_trigger WHERE id = $1 RETURNING id::text AS id',
      [id],
    );
    return rows.length > 0;
  }
}
