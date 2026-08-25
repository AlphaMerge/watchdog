import type { Queryable } from '../db/pool.js';
import type { ResolvedPause } from '../state/pause.js';
import type { Actor } from './audit.js';
import type { ObjectId } from './types.js';

/** A pause as stored, plus whose it is. */
export interface StoredPause {
  readonly objectId: ObjectId;
  readonly pausedAt: Date;
  readonly pausedUntil: Date | null;
  readonly message: string;
  readonly actor: { kind: string; ref: string | null; label: string | null };
}

/** Why an object is paused: its own pause, or an ancestor's. */
export interface EffectivePause {
  /** The object's own pause, if it has one. Only this one can be resumed. */
  readonly own: StoredPause | null;
  /** The nearest paused ancestor, if any. What a refused resume points at. */
  readonly inherited: {
    objectId: ObjectId;
    name: string;
    pausedUntil: Date | null;
    /** Why *that* object is paused. The question an operator is asking is rarely local. */
    message: string;
  } | null;
}

const MAX_WALK_DEPTH = 1000;

interface PauseRow {
  object_id: string;
  paused_at: Date;
  paused_until: Date | null;
  message: string;
  actor_kind: string;
  actor_ref: string | null;
  actor_label: string | null;
}

function toStored(row: PauseRow): StoredPause {
  return {
    objectId: Number(row.object_id),
    pausedAt: row.paused_at,
    pausedUntil: row.paused_until,
    message: row.message,
    actor: { kind: row.actor_kind, ref: row.actor_ref, label: row.actor_label },
  };
}

/**
 * Everything `object_pause` does, and the derivation of `sensor_runtime`'s flags from it
 * (`M-08`).
 *
 * Separate from `ObjectRepository` because it is a different subject — that one is the tree and
 * its side tables, this one is a fact *about* a subtree — and because the recompute below is the
 * only recursive write in the system and deserves to be findable.
 */
export class PauseRepository {
  /** Writes or replaces an object's pause. Replacing is extending a maintenance window. */
  async pause(q: Queryable, objectId: ObjectId, pause: ResolvedPause, actor: Actor): Promise<void> {
    const who = flatten(actor);
    await q.query(
      `INSERT INTO object_pause
         (object_id, paused_at, paused_until, message, actor_kind, actor_ref, actor_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (object_id) DO UPDATE SET
         paused_at = EXCLUDED.paused_at,
         paused_until = EXCLUDED.paused_until,
         message = EXCLUDED.message,
         actor_kind = EXCLUDED.actor_kind,
         actor_ref = EXCLUDED.actor_ref,
         actor_label = EXCLUDED.actor_label`,
      [objectId, pause.pausedAt, pause.pausedUntil, pause.message, who.kind, who.ref, who.label],
    );
  }

  /** Clears an object's own pause. Returns false if it had none. */
  async resume(q: Queryable, objectId: ObjectId): Promise<boolean> {
    const rows = await q.query<{ object_id: string }>(
      'DELETE FROM object_pause WHERE object_id = $1 RETURNING object_id::text AS object_id',
      [objectId],
    );
    return rows.length > 0;
  }

  /**
   * An object's own pause and the nearest paused ancestor.
   *
   * One walk up the chain, ordered by depth, so the answer to "can I resume this" and the answer
   * to "then what do I resume" come from the same query and cannot disagree.
   */
  async effective(q: Queryable, objectId: ObjectId, now: Date): Promise<EffectivePause> {
    const rows = await q.query<PauseRow & { depth: number; name: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id, o.parent_id, o.name, 0 AS depth
        FROM object o WHERE o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, p.name, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT op.object_id::text AS object_id, op.paused_at, op.paused_until, op.message,
             op.actor_kind, op.actor_ref, op.actor_label, chain.depth, chain.name
      FROM chain
      JOIN object_pause op ON op.object_id = chain.id
      WHERE op.paused_until IS NULL OR op.paused_until > $2
      ORDER BY chain.depth
      `,
      [objectId, now],
    );

    const own = rows.find((row) => row.depth === 0);
    const nearest = rows.find((row) => row.depth > 0);
    return {
      own: own === undefined ? null : toStored(own),
      inherited:
        nearest === undefined
          ? null
          : {
              objectId: Number(nearest.object_id),
              name: nearest.name,
              pausedUntil: nearest.paused_until,
              message: nearest.message,
            },
    };
  }

  /**
   * Recomputes `paused_by_parent` and `paused_manually` for every sensor in a subtree.
   *
   * From scratch, not incrementally. Clearing one pause does not mean a sensor is unpaused —
   * another ancestor may still hold it — and an incremental update would have to know that,
   * which means walking the chain anyway. Recomputing is one statement that cannot be wrong,
   * and it runs on a pause, a resume, a move and a create, never on a scan.
   *
   * Returns the sensors whose flags actually moved, because those are the ones whose state has
   * to be re-evaluated and no others. A pause of a group with 4,000 healthy sensors and one
   * already-paused sensor should write 4,000 transitions, not 4,001.
   */
  async recompute(q: Queryable, rootId: ObjectId, now: Date): Promise<number[]> {
    const rows = await q.query<{ object_id: string }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT o.id, 0 AS depth FROM object o WHERE o.id = $1
        UNION ALL
        SELECT c.id, subtree.depth + 1
        FROM object c JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      ),
      -- Every sensor in the subtree, walked back up to the root of the whole tree: a sensor
      -- inside the subtree may be held by a pause *above* it, and a resume must not lift that.
      chain AS (
        SELECT s.id AS sensor_id, s.id AS node, s.parent_id, 0 AS depth
        FROM object s
        JOIN subtree ON subtree.id = s.id
        WHERE s.kind = 'sensor'
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      ),
      resolved AS (
        SELECT chain.sensor_id,
               bool_or(op.object_id IS NOT NULL AND chain.depth = 0) AS own,
               bool_or(op.object_id IS NOT NULL AND chain.depth > 0) AS ancestor
        FROM chain
        LEFT JOIN object_pause op
          ON op.object_id = chain.node
         AND (op.paused_until IS NULL OR op.paused_until > $2)
        GROUP BY chain.sensor_id
      )
      UPDATE sensor_runtime r
      SET paused_manually = resolved.own,
          paused_by_parent = resolved.ancestor
      FROM resolved
      WHERE r.object_id = resolved.sensor_id
        -- Only what changed. The returning set is what gets re-evaluated, and a sensor whose
        -- flags did not move has no transition to record.
        AND (r.paused_manually IS DISTINCT FROM resolved.own
             OR r.paused_by_parent IS DISTINCT FROM resolved.ancestor)
      RETURNING r.object_id::text AS object_id
      `,
      [rootId, now],
    );
    return rows.map((row) => Number(row.object_id));
  }

  /**
   * Whether anything in the installation is paused at all.
   *
   * The guard in front of `recompute`. That query is two recursive CTEs and an `UPDATE … FROM`,
   * and planning it is not free even when the subtree is one new object — measured at roughly
   * 2.8 ms a create, which turned a 5,000-object tree build from 21 s into 35 s and broke
   * `P-04`'s budget. This is a `LIMIT 1` over a table that is empty in almost every
   * installation and never large in any of them.
   *
   * It answers the only question that matters on the create and move paths: if nothing is
   * paused, nothing can cascade, and there is no work to do.
   */
  async anyActive(q: Queryable, now: Date): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM object_pause
       WHERE paused_until IS NULL OR paused_until > $1
       LIMIT 1`,
      [now],
    );
    return rows.length > 0;
  }

  /** Every pause whose deadline has passed. What the expiry sweep acts on. */
  async expired(q: Queryable, now: Date, limit: number): Promise<StoredPause[]> {
    const rows = await q.query<PauseRow>(
      `SELECT object_id::text AS object_id, paused_at, paused_until, message,
              actor_kind, actor_ref, actor_label
       FROM object_pause
       WHERE paused_until IS NOT NULL AND paused_until <= $1
       ORDER BY paused_until
       LIMIT $2`,
      [now, limit],
    );
    return rows.map(toStored);
  }
}

function flatten(actor: Actor): { kind: string; ref: string | null; label: string | null } {
  switch (actor.kind) {
    case 'user':
      return { kind: 'user', ref: String(actor.userId), label: actor.login };
    case 'token':
      return { kind: 'token', ref: String(actor.tokenId), label: null };
    case 'system':
      return { kind: 'system', ref: actor.component, label: null };
    case 'anonymous':
      return { kind: 'anonymous', ref: actor.remoteAddress, label: null };
  }
}
