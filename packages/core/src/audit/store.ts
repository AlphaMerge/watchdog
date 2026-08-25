import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ObjectKind } from '../objects/types.js';
import type { ObjectDetail } from '../objects/types.js';
import { describeCreated, describeDeleted, diffObjects, type FieldChange } from './diff.js';

export interface AuditEntry {
  /** bigint, so a string on the wire — a JS number would lose precision eventually. */
  id: string;
  at: string;
  action: string;
  objectId: number | null;
  objectKind: ObjectKind | null;
  actor: Actor;
  summary: Record<string, unknown>;
  diff: FieldChange[];
}

export interface AuditQuery {
  objectId?: number;
  /** Entries older than this id, for paging backwards through history. */
  before?: string;
  limit: number;
}

/**
 * How many destroyed objects a single delete entry lists by name.
 *
 * A subtree delete can destroy thousands, and there is no recycle bin, so the list is the only
 * record of what went — worth keeping, but not worth an unbounded jsonb blob. Past the cap the
 * entry says how many it did not list rather than silently stopping.
 */
const MAX_DESTROYED_RECORDED = 1_000;

interface AuditRow {
  at: Date;
  action: string;
  objectId: number | null;
  objectKind: ObjectKind | null;
  actorKind: Actor['kind'];
  actorRef: string;
  actorLabel: string;
  summary: Record<string, unknown>;
  diff: FieldChange[];
}

/** Reads and prunes the audit log. Writing is the sink's job. */
export class AuditRepository {
  async list(q: Queryable, query: AuditQuery): Promise<AuditEntry[]> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.objectId !== undefined) {
      where.push(`object_id = $${String(values.push(query.objectId))}`);
    }
    if (query.before !== undefined) {
      where.push(`id < $${String(values.push(query.before))}::bigint`);
    }
    const limit = `$${String(values.push(query.limit))}`;

    const rows = await q.query<{
      id: string;
      at: Date;
      action: string;
      object_id: string | null;
      object_kind: ObjectKind | null;
      actor_kind: Actor['kind'];
      actor_ref: string;
      actor_label: string;
      summary: Record<string, unknown>;
      diff: FieldChange[];
    }>(
      `SELECT id::text, at, action, object_id::text, object_kind,
              actor_kind, actor_ref, actor_label, summary, diff
       FROM audit_log
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT ${limit}`,
      values,
    );

    return rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      action: row.action,
      objectId: row.object_id === null ? null : Number(row.object_id),
      objectKind: row.object_kind,
      actor: toActor(row.actor_kind, row.actor_ref, row.actor_label),
      summary: row.summary,
      diff: row.diff,
    }));
  }

  /**
   * Deletes entries past the horizon, up to `limit` of them.
   *
   * Bounded because the first sweep after a retention change could otherwise be a single DELETE
   * over years of history, holding locks while it ran. The housekeeping loop calls this until it
   * comes back short.
   */
  async prune(q: Queryable, olderThan: Date, limit: number): Promise<number> {
    const rows = await q.query<{ count: string }>(
      `WITH gone AS (
         DELETE FROM audit_log
         WHERE id IN (SELECT id FROM audit_log WHERE at < $1 ORDER BY id LIMIT $2)
         RETURNING 1
       )
       SELECT count(*) AS count FROM gone`,
      [olderThan, limit],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

/**
 * Writes the audit log to the database (S-10).
 *
 * The contract that matters is inherited from `AuditSink`: this runs **inside** the mutation's
 * transaction. An entry cannot survive a rolled-back change, and a committed change cannot lose
 * its entry — which is the only way an audit log is worth reading.
 */
export class DatabaseAuditSink implements AuditSink {
  async record(
    q: Queryable,
    actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    if (mutations.length === 0) return;
    const rows = mutations.map((mutation) => toRow(mutation, actor, at));

    await q.query(
      `INSERT INTO audit_log
         (at, action, object_id, object_kind, actor_kind, actor_ref, actor_label, summary, diff)
       SELECT * FROM unnest(
         $1::timestamptz[], $2::text[], $3::bigint[], $4::object_kind[],
         $5::text[], $6::text[], $7::text[], $8::jsonb[], $9::jsonb[]
       )`,
      [
        rows.map((row) => row.at),
        rows.map((row) => row.action),
        rows.map((row) => row.objectId),
        rows.map((row) => row.objectKind),
        rows.map((row) => row.actorKind),
        rows.map((row) => row.actorRef),
        rows.map((row) => row.actorLabel),
        rows.map((row) => JSON.stringify(row.summary)),
        rows.map((row) => JSON.stringify(row.diff)),
      ],
    );
  }
}

/**
 * Fans one audit event out to several sinks.
 *
 * The table is the queryable record; the log is the plain-text audit component
 * `CAPABILITIES.MD` §9 lists, and it is the copy that survives someone dropping the database.
 * Both, in the mutation's transaction, in order.
 */
export class CompositeAuditSink implements AuditSink {
  readonly #sinks: readonly AuditSink[];

  constructor(sinks: readonly AuditSink[]) {
    this.#sinks = sinks;
  }

  async record(
    q: Queryable,
    actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    for (const sink of this.#sinks) {
      await sink.record(q, actor, mutations, at);
    }
  }
}

function toRow(mutation: Mutation, actor: Actor, at: Date): AuditRow {
  const base = {
    at,
    action: mutation.action,
    objectId: mutation.objectId,
    ...fromActor(actor),
  };

  switch (mutation.action) {
    case 'object.created':
      return {
        ...base,
        objectKind: mutation.kind,
        // Every parameter is new on a create, so the comparison that works for an update would
        // report none of them.
        summary: paramsSummary(paramKeysOf(mutation.after)),
        diff: describeCreated(mutation.after),
      };

    case 'object.updated':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: paramsSummary(mutation.changedParams),
        diff: diffObjects(mutation.before, mutation.after),
      };

    case 'object.moved':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: {
          movedCount: mutation.movedCount,
          fromProbeId: mutation.fromProbeId,
          toProbeId: mutation.toProbeId,
        },
        diff: [{ field: 'parentId', before: mutation.fromParentId, after: mutation.toParentId }],
      };

    case 'object.reordered':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { parentId: mutation.parentId, move: mutation.move },
        // Positions rather than names: the diff answers "where did it go", and the sibling that
        // was displaced is a different object with its own history.
        diff: [{ field: 'siblingPosition', before: mutation.fromIndex, after: mutation.toIndex }],
      };

    case 'object.cloned':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: {
          sourceId: mutation.sourceId,
          clonedCount: mutation.clonedCount,
          droppedCredentialKinds: [...mutation.droppedCredentialKinds],
        },
        diff: [],
      };

    case 'object.deleted': {
      const recorded = mutation.destroyed.slice(0, MAX_DESTROYED_RECORDED);
      return {
        ...base,
        objectKind: mutation.kind,
        summary: {
          deleted: mutation.deleted,
          ...paramsSummary(paramKeysOf(mutation.before)),
          destroyedCount: mutation.destroyed.length,
          destroyed: recorded,
          // Never a silent truncation: the count above is always the real one.
          destroyedTruncated: recorded.length < mutation.destroyed.length,
        },
        diff: describeDeleted(mutation.before),
      };
    }

    case 'setting.set':
      return {
        ...base,
        objectKind: null,
        summary: { key: mutation.key },
        diff: [
          { field: `setting.${mutation.key}`, before: mutation.before, after: mutation.after },
        ],
      };

    case 'setting.reverted':
      return {
        ...base,
        objectKind: null,
        summary: { key: mutation.key },
        // Reverting means "inherit again", so there is no after value — the effective one now
        // comes from an ancestor, and which ancestor is a question for the resolver.
        diff: [{ field: `setting.${mutation.key}`, before: mutation.before, after: null }],
      };
  }
}

function paramsSummary(changed: readonly string[]): Record<string, unknown> {
  return changed.length === 0 ? {} : { paramsChanged: [...changed] };
}

/**
 * Every parameter name a sensor has, including the ones whose values were redacted away.
 *
 * `redactedParams` is the only trace a `writeOnly` parameter leaves on a redacted detail, so
 * without it a create would record "no parameters" for a sensor configured entirely with
 * secrets.
 */
function paramKeysOf(object: ObjectDetail): string[] {
  if (object.kind !== 'sensor') return [];
  return [...new Set([...Object.keys(object.params), ...object.redactedParams])].sort();
}

function fromActor(actor: Actor): {
  actorKind: Actor['kind'];
  actorRef: string;
  actorLabel: string;
} {
  switch (actor.kind) {
    case 'user':
      return { actorKind: 'user', actorRef: String(actor.userId), actorLabel: actor.login };
    case 'token':
      return { actorKind: 'token', actorRef: String(actor.tokenId), actorLabel: '' };
    case 'system':
      return { actorKind: 'system', actorRef: actor.component, actorLabel: '' };
    case 'anonymous':
      return { actorKind: 'anonymous', actorRef: actor.remoteAddress, actorLabel: '' };
  }
}

function toActor(kind: Actor['kind'], ref: string, label: string): Actor {
  switch (kind) {
    case 'user':
      return { kind: 'user', userId: Number(ref), login: label };
    case 'token':
      return { kind: 'token', tokenId: Number(ref) };
    case 'system':
      return { kind: 'system', component: ref };
    case 'anonymous':
      return { kind: 'anonymous', remoteAddress: ref };
  }
}
