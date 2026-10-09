import type { Queryable } from '../db/pool.js';
import type { ResolvedPause } from '../state/pause.js';
import type { Actor, ActorKind } from './audit.js';
import type { ObjectId } from './types.js';

/** A pause as stored, plus whose it is. */
export interface StoredPause {
  readonly objectId: ObjectId;
  readonly pausedAt: Date;
  /** When it takes effect. Later than `pausedAt` only for a maintenance window (`M-10`). */
  readonly startsAt: Date;
  readonly pausedUntil: Date | null;
  readonly message: string;
  readonly actor: { kind: ActorKind; ref: string | null; label: string | null };
}

/** Why an object is paused: its own pause, or an ancestor's. */
export interface EffectivePause {
  /**
   * The object's own pause, if it has one — **whether or not it is in force yet**.
   *
   * A maintenance window scheduled for Saturday is here all week, because the question this
   * field answers is "does this object have a pause of its own to cancel", and the answer is
   * yes from the moment it is scheduled. `ownActive` is the separate question of whether it is
   * pausing anything at this instant.
   */
  readonly own: StoredPause | null;
  readonly ownActive: boolean;
  /** The nearest ancestor whose pause is *in force*. What a refused resume points at. */
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
  starts_at: Date;
  paused_until: Date | null;
  message: string;
  actor_kind: ActorKind;
  actor_ref: string | null;
  actor_label: string | null;
}

function toStored(row: PauseRow): StoredPause {
  return {
    objectId: Number(row.object_id),
    pausedAt: row.paused_at,
    startsAt: row.starts_at,
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
/**
 * Where a paged walk of `startedIn` stopped (`P-95`).
 *
 * `startsAt` is Postgres's own text form rather than a `Date`, because the column holds
 * microseconds and a `Date` holds milliseconds: truncating puts the cursor *before* the row it
 * was taken from, so the next page returns that row again and the walk never advances.
 * `objectId` breaks ties, which a bulk pause written in one transaction produces.
 */
export interface PauseCursor {
  readonly startsAt: string;
  readonly objectId: ObjectId;
}

/** The beginning of time, which is where a restarted sweep starts looking. */
export const PAUSE_CURSOR_START: PauseCursor = { startsAt: '-infinity', objectId: 0 };

export class PauseRepository {
  /** Writes or replaces an object's pause. Replacing is extending a maintenance window. */
  async pause(q: Queryable, objectId: ObjectId, pause: ResolvedPause, actor: Actor): Promise<void> {
    const who = flattenActor(actor);
    await q.query(
      `INSERT INTO object_pause
         (object_id, paused_at, starts_at, paused_until, message,
          actor_kind, actor_ref, actor_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (object_id) DO UPDATE SET
         paused_at = EXCLUDED.paused_at,
         starts_at = EXCLUDED.starts_at,
         paused_until = EXCLUDED.paused_until,
         message = EXCLUDED.message,
         actor_kind = EXCLUDED.actor_kind,
         actor_ref = EXCLUDED.actor_ref,
         actor_label = EXCLUDED.actor_label`,
      [
        objectId,
        pause.pausedAt,
        pause.startsAt,
        pause.pausedUntil,
        pause.message,
        who.kind,
        who.ref,
        who.label,
      ],
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
      SELECT op.object_id::text AS object_id, op.paused_at, op.starts_at, op.paused_until,
             op.message, op.actor_kind, op.actor_ref, op.actor_label, chain.depth, chain.name
      FROM chain
      JOIN object_pause op ON op.object_id = chain.id
      -- Expired rows are excluded here rather than left to the caller: a pause whose deadline
      -- has passed is not a pause, and the sweep that deletes the row runs on its own clock.
      -- A window that has not *started* is kept, because the object still owns it (M-10) --
      -- only an ancestor's has to be in force to hold anything.
      WHERE (op.paused_until IS NULL OR op.paused_until > $2)
        AND (chain.depth = 0 OR op.starts_at <= $2)
      ORDER BY chain.depth
      `,
      [objectId, now],
    );

    const own = rows.find((row) => row.depth === 0);
    const nearest = rows.find((row) => row.depth > 0);
    return {
      own: own === undefined ? null : toStored(own),
      ownActive: own !== undefined && own.starts_at.getTime() <= now.getTime(),
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
         -- In force, both ends: a maintenance window scheduled for Saturday sets no flag
         -- until Saturday (M-10).
         AND op.starts_at <= $2
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
   * The words behind each sensor's manual or inherited pause (P-94).
   *
   * The nearest in-force pause up each sensor's chain, own first — the same ordering
   * `effective` uses for one object, asked for a set. It exists because the message a sensor
   * shows has to describe the cause it *reports*, and only this table knows what an operator
   * typed. Before this, whichever subsystem happened to trigger the re-evaluation supplied the
   * message, so a schedule window opening on a hand-paused sensor wrote the schedule's name as
   * the reason it was still paused — at the moment that schedule had stopped being a reason for
   * anything.
   */
  async messagesFor(
    q: Queryable,
    sensorIds: readonly number[],
    now: Date,
  ): Promise<Map<number, string>> {
    if (sensorIds.length === 0) return new Map();
    const rows = await q.query<{ sensor_id: string; message: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT s.id AS sensor_id, s.id AS node, s.parent_id, 0 AS depth
        FROM object s WHERE s.id = ANY($1::bigint[])
        UNION ALL
        SELECT chain.sensor_id, p.id, p.parent_id, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT ON (chain.sensor_id)
             chain.sensor_id::text AS sensor_id, op.message
      FROM chain
      JOIN object_pause op ON op.object_id = chain.node
      WHERE op.starts_at <= $2
        AND (op.paused_until IS NULL OR op.paused_until > $2)
      ORDER BY chain.sensor_id, chain.depth
      `,
      [[...sensorIds], now],
    );
    return new Map(rows.map((row) => [Number(row.sensor_id), row.message]));
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
       WHERE starts_at <= $1 AND (paused_until IS NULL OR paused_until > $1)
       LIMIT 1`,
      [now],
    );
    return rows.length > 0;
  }

  /**
   * Whether any pause began or ended in `(since, now]` (`M-10`).
   *
   * The guard in front of the sweep's reconcile pass. Two boundaries a sweep can cross and a
   * `LIMIT 1` over an index for each: a window opening, and a timed pause running out. An
   * installation where nothing is paused pays that and nothing else.
   *
   * `since` is the previous sweep, or the epoch on the first pass after a restart — which is
   * what makes the first sweep reconcile every window that opened while the core was down,
   * without a "have I applied this" column that could disagree with the rows.
   */
  async boundaryCrossed(q: Queryable, since: Date, now: Date): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM object_pause
       WHERE (starts_at > $1 AND starts_at <= $2)
          OR (paused_until IS NOT NULL AND paused_until > $1 AND paused_until <= $2)
       LIMIT 1`,
      [since, now],
    );
    return rows.length > 0;
  }

  /** Every pause whose deadline has passed. What the expiry sweep acts on. */
  async expired(q: Queryable, now: Date, limit: number): Promise<StoredPause[]> {
    const rows = await q.query<PauseRow>(
      `SELECT object_id::text AS object_id, paused_at, starts_at, paused_until, message,
              actor_kind, actor_ref, actor_label
       FROM object_pause
       WHERE paused_until IS NOT NULL AND paused_until <= $1
       ORDER BY paused_until
       LIMIT $2`,
      [now, limit],
    );
    return rows.map(toStored);
  }

  /**
   * The pauses that came into force in `(since, now]` (`M-10`).
   *
   * What the sweep acts on at the other end from `expired`. Each is recomputed under its own
   * object rather than the whole tree at once, so the state history records *this window's*
   * message — "quarterly patching" is what an operator reads, and a batched recompute could
   * only have said nothing.
   *
   * With `since` at the epoch this returns every pause already in force, which is exactly what
   * the first sweep after a restart should reconcile: windows that opened while the core was
   * down, and any drift a crash left behind.
   *
   * **Keyset, not a bare timestamp** (`P-95`). That first pass is also the one most likely to
   * be truncated by the limit — an installation with a few hundred long-standing pauses fills
   * the page with them — so the caller has to be able to resume from where the page stopped.
   * `starts_at` alone cannot express that: advancing to the last row's timestamp re-reads it
   * for ever, and advancing past it silently drops anything sharing that instant, which a bulk
   * pause in one transaction produces. `(starts_at, object_id)` is unique and totally ordered,
   * which is the same reason `object_parent_name_id_idx` carries `id`.
   */
  async startedIn(
    q: Queryable,
    since: PauseCursor,
    now: Date,
    limit: number,
  ): Promise<{ pauses: StoredPause[]; last: PauseCursor | null }> {
    const rows = await q.query<PauseRow & { starts_at_cursor: string }>(
      `SELECT object_id::text AS object_id, paused_at, starts_at, paused_until, message,
              actor_kind, actor_ref, actor_label,
              -- Text, at the column's own precision. A cursor that round-trips through a JS
              -- Date loses the microseconds Postgres stores, lands just *before* the row it
              -- came from, and reads it again for ever (P-95).
              starts_at::text AS starts_at_cursor
       FROM object_pause
       WHERE (starts_at, object_id) > ($1::timestamptz, $2::bigint)
         AND starts_at <= $3
         AND (paused_until IS NULL OR paused_until > $3)
       ORDER BY starts_at, object_id
       LIMIT $4`,
      [since.startsAt, since.objectId, now, limit],
    );
    const last = rows.at(-1);
    return {
      pauses: rows.map(toStored),
      last:
        last === undefined
          ? null
          : { startsAt: last.starts_at_cursor, objectId: Number(last.object_id) },
    };
  }

  /** The root object id, which is where a whole-installation recompute starts. */
  async rootId(q: Queryable): Promise<ObjectId | null> {
    const rows = await q.query<{ id: string }>(
      "SELECT id::text AS id FROM object WHERE kind = 'root' LIMIT 1",
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.id);
  }
}

/**
 * An actor as the storage layer records it: kind, a reference, and something readable.
 *
 * Exported because `M-13` records the same three fields on an acknowledgement, and two
 * flattenings of one union would eventually disagree about what a token's label is.
 */
export function flattenActor(actor: Actor): {
  kind: ActorKind;
  ref: string | null;
  label: string | null;
} {
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
