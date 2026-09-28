import type { Queryable } from '../db/pool.js';
import type {
  AccountAudit,
  Actor,
  AuditSink,
  GroupAudit,
  LibraryAudit,
  MapAudit,
  MapBackgroundAudit,
  Mutation,
  ProbeIdentity,
  ProbeTrustAudit,
  RediscoveryScheduleAudit,
  ReportAudit,
  ScheduleAudit,
} from '../objects/audit.js';
import type { ChannelLimits } from '../state/limits.js';
import type { ChannelProcessing } from '../objects/types.js';
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
  /**
   * One object, exactly — never a subtree.
   *
   * A subtree scope would have to walk `object` to find the descendants, and the entry most
   * worth reading is the one recording a *deletion*, written about an object that no longer has
   * a parent to be found through. Scoping by walking the tree would silently drop exactly those.
   * `U-07` filters by category instead, which works the same whether the subject still exists.
   */
  objectId?: number;
  /**
   * The first segment of an action — `object`, `setting`, `channel`, `trigger`, `template`,
   * `schedule`, `sensor`. Twenty-six actions is too many to put in front of an operator; seven
   * is a row of chips.
   */
  categories?: readonly string[];
  actorKinds?: readonly string[];
  /**
   * One specific actor — a user id, a token id, a component name (`A-08`).
   *
   * **"Everything this person did" is the question an audit log is opened for**, and `actorKinds`
   * cannot answer it: it narrows to *all* users, which during an incident is everybody. Paired
   * with `actorKinds`, because `actor_ref` is only unique within a kind — user 4 and token 4 are
   * different actors — and because `audit_log_actor_idx` leads with the kind.
   */
  actorRef?: string;
  from?: Date;
  to?: Date;
  /** Entries older than this id, for paging backwards through history. */
  before?: string;
  limit: number;
}

/** The action prefixes `categories` filters on, in the order a UI shows them. */
export const AUDIT_CATEGORIES = [
  'object',
  'setting',
  'credential',
  'channel',
  'trigger',
  'template',
  'schedule',
  'sensor',
  'report',
  'library',
  'map',
  'grant',
  'probe',
  'discovery',
  'account',
  'group',
  'token',
] as const;

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
    if (query.categories !== undefined && query.categories.length > 0) {
      // split_part rather than LIKE ANY: the category is the first segment, and a prefix match
      // would make "object" also select a hypothetical "objectgroup.created".
      where.push(
        `split_part(action, '.', 1) = ANY($${String(values.push([...query.categories]))})`,
      );
    }
    if (query.actorKinds !== undefined && query.actorKinds.length > 0) {
      where.push(`actor_kind = ANY($${String(values.push([...query.actorKinds]))})`);
    }
    if (query.actorRef !== undefined && query.actorRef !== '') {
      where.push(`actor_ref = $${String(values.push(query.actorRef))}`);
    }
    if (query.from !== undefined) where.push(`at >= $${String(values.push(query.from))}`);
    if (query.to !== undefined) where.push(`at < $${String(values.push(query.to))}`);
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
      // ORDER BY is qualified, and it has to be. An unqualified name in ORDER BY resolves
      // against the *output* columns first, and this select list casts `id` to text — so
      // `ORDER BY id DESC` sorted lexicographically, putting entry 9 above entry 253 and
      // breaking the keyset cursor, which compares numerically. Silent until the ids crossed a
      // digit boundary, and then wrong for ever after.
      `SELECT audit_log.id::text AS id, at, action, object_id::text AS object_id, object_kind,
              actor_kind, actor_ref, actor_label, summary, diff
       FROM audit_log
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY audit_log.id DESC
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

    case 'trigger.created':
    case 'trigger.updated':
    case 'trigger.deleted':
      return {
        ...base,
        objectKind: null,
        summary: {
          triggerId: mutation.triggerId,
          triggerKind: mutation.triggerKind,
          trigger: mutation.summary,
        },
        diff: [
          {
            field: `trigger.${String(mutation.triggerId)}`,
            before:
              mutation.action === 'trigger.created'
                ? null
                : (mutation.previousSummary ?? mutation.summary),
            after: mutation.action === 'trigger.deleted' ? null : mutation.summary,
          },
        ],
      };

    case 'template.created':
    case 'template.updated':
    case 'template.deleted':
      return {
        ...base,
        objectKind: null,
        // The name and the method, and nothing else. The settings carry webhook URLs and secret
        // headers, and an audit log is the wrong place to keep a copy of a credential no API
        // will return — a log is read by more people, kept for longer, and exported.
        summary: {
          templateId: mutation.templateId,
          name: mutation.name,
          method: mutation.method,
        },
        diff: [
          {
            field: `template.${String(mutation.templateId)}`,
            before: mutation.action === 'template.created' ? null : mutation.name,
            after: mutation.action === 'template.deleted' ? null : mutation.name,
          },
        ],
      };

    case 'template.tested':
      return {
        ...base,
        objectKind: null,
        summary: {
          templateId: mutation.templateId,
          name: mutation.name,
          method: mutation.method,
          delivered: mutation.delivered,
        },
        // No diff, because nothing changed. The entry exists to say who sent it and whether it
        // arrived, which is the whole of what a test send is.
        diff: [],
      };

    case 'report.ran':
      return {
        ...base,
        objectKind: null,
        summary: {
          reportId: mutation.reportId,
          runId: mutation.runId,
          name: mutation.reportName,
          trigger: mutation.trigger,
          // **Both accounts, always.** Who asked and whose visibility it used are different
          // questions, and a row recording only the first would say nothing about what the
          // report was allowed to contain.
          requestedBy: mutation.requestedBy,
          runAs: mutation.runAs,
          span: mutation.spanLabel,
          outcome: mutation.outcome,
          ...(mutation.errorCode === '' ? {} : { errorCode: mutation.errorCode }),
        },
        diff: [],
      };

    case 'schedule.created':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.after.name },
        diff: SCHEDULE_FIELDS.map((field) => ({
          field: `schedule.${field}`,
          before: null,
          after: mutation.after[field],
        })),
      };

    case 'schedule.updated':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.after.name },
        // Only what moved. Editing a schedule's periods and editing its description are very
        // different events, and a diff that listed all five every time would not say which.
        diff: SCHEDULE_FIELDS.filter(
          (field) => mutation.before[field] !== mutation.after[field],
        ).map((field) => ({
          field: `schedule.${field}`,
          before: mutation.before[field],
          after: mutation.after[field],
        })),
      };

    case 'schedule.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.before.name },
        diff: SCHEDULE_FIELDS.map((field) => ({
          field: `schedule.${field}`,
          before: mutation.before[field],
          after: null,
        })),
      };

    case 'library.created':
      return {
        ...base,
        objectKind: null,
        summary: { libraryId: mutation.libraryId, name: mutation.after.name },
        diff: LIBRARY_FIELDS.map((field) => ({
          field: `library.${field}`,
          before: null,
          after: mutation.after[field],
        })),
      };

    case 'library.updated':
      return {
        ...base,
        objectKind: null,
        summary: { libraryId: mutation.libraryId, name: mutation.after.name },
        // Only what moved, for the reason a schedule's diff gives: renaming a library and
        // narrowing what it shows are different events.
        diff: LIBRARY_FIELDS.filter(
          (field) => mutation.before[field] !== mutation.after[field],
        ).map((field) => ({
          field: `library.${field}`,
          before: mutation.before[field],
          after: mutation.after[field],
        })),
      };

    case 'library.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { libraryId: mutation.libraryId, name: mutation.before.name },
        diff: LIBRARY_FIELDS.map((field) => ({
          field: `library.${field}`,
          before: mutation.before[field],
          after: null,
        })),
      };

    case 'grant.set':
      return {
        ...base,
        objectKind: null,
        summary: {
          subject: mutation.subject.kind,
          subjectId: mutation.subject.id,
          groupId: mutation.groupId,
          group: mutation.groupName,
        },
        diff: [{ field: 'grant.right', before: mutation.before, after: mutation.after }],
      };

    case 'grant.revoked':
      return {
        ...base,
        objectKind: null,
        summary: {
          subject: mutation.subject.kind,
          subjectId: mutation.subject.id,
          groupId: mutation.groupId,
          group: mutation.groupName,
        },
        // `after: null`, not `none`: a revoke restores what the group inherits, which `none`
        // would override. The two are different grants, and the diff must not make them look
        // alike.
        diff: [{ field: 'grant.right', before: mutation.before, after: null }],
      };

    case 'map.created':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId, name: mutation.after.name },
        diff: created(MAP_FIELDS, mutation.after, 'map'),
      };

    case 'map.updated':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId, name: mutation.after.name },
        diff: changed(MAP_FIELDS, mutation.before, mutation.after, 'map'),
      };

    case 'map.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId, name: mutation.before.name },
        diff: deleted(MAP_FIELDS, mutation.before, 'map'),
      };

    case 'map.background.set':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId },
        diff:
          mutation.before === null
            ? created(BACKGROUND_FIELDS, mutation.after, 'map.background')
            : changed(BACKGROUND_FIELDS, mutation.before, mutation.after, 'map.background'),
      };

    case 'map.background.removed':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId },
        diff: deleted(BACKGROUND_FIELDS, mutation.before, 'map.background'),
      };

    case 'map.share.created':
      return {
        ...base,
        objectKind: null,
        // The label, the prefix and the expiry — never the token, which exists only in the
        // response that minted it (`G-06`).
        summary: {
          mapId: mutation.mapId,
          shareId: mutation.shareId,
          label: mutation.label,
          prefix: mutation.prefix,
          expiresAt: mutation.expiresAt.toISOString(),
        },
        diff: [],
      };

    case 'map.share.revoked':
      return {
        ...base,
        objectKind: null,
        summary: { mapId: mutation.mapId, shareId: mutation.shareId },
        diff: [],
      };

    case 'report.created':
      return {
        ...base,
        objectKind: null,
        summary: { reportId: mutation.reportId, name: mutation.after.name },
        diff: created(REPORT_FIELDS, mutation.after, 'report'),
      };

    case 'report.updated':
      return {
        ...base,
        objectKind: null,
        summary: { reportId: mutation.reportId, name: mutation.after.name },
        diff: changed(REPORT_FIELDS, mutation.before, mutation.after, 'report'),
      };

    case 'report.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { reportId: mutation.reportId, name: mutation.before.name },
        diff: deleted(REPORT_FIELDS, mutation.before, 'report'),
      };

    case 'probe.approved':
      return {
        ...base,
        objectKind: null,
        summary: { ...probeSummary(mutation.probe), local: mutation.local },
        diff: changed(PROBE_FIELDS, mutation.before, mutation.after, 'probe'),
      };

    case 'probe.revoked':
    case 'probe.allowFrom.set':
      return {
        ...base,
        objectKind: null,
        summary: probeSummary(mutation.probe),
        diff: changed(PROBE_FIELDS, mutation.before, mutation.after, 'probe'),
      };

    case 'probe.deleted':
      return {
        ...base,
        objectKind: null,
        summary: probeSummary(mutation.probe),
        diff: deleted(PROBE_FIELDS, mutation.before, 'probe'),
      };

    case 'discovery.started':
      return {
        ...base,
        objectKind: null,
        summary: {
          runId: mutation.runId,
          probeId: mutation.probeId,
          range: mutation.range,
          level: mutation.level,
          templates: mutation.templates,
          community: mutation.community,
          scheduleId: mutation.scheduleId,
        },
        diff: [],
      };

    case 'discovery.cancelled':
      return {
        ...base,
        objectKind: null,
        summary: { runId: mutation.runId, range: mutation.range },
        diff: [],
      };

    case 'discovery.schedule.created':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.after.name },
        diff: created(REDISCOVERY_FIELDS, mutation.after, 'discovery.schedule'),
      };

    case 'discovery.schedule.updated':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.after.name },
        diff: [
          ...changed(REDISCOVERY_FIELDS, mutation.before, mutation.after, 'discovery.schedule'),
          ...(mutation.communityReplaced === true
            ? [{ field: 'discovery.schedule.community', before: 'set', after: 'replaced' }]
            : []),
        ],
      };

    case 'discovery.schedule.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { scheduleId: mutation.scheduleId, name: mutation.before.name },
        diff: deleted(REDISCOVERY_FIELDS, mutation.before, 'discovery.schedule'),
      };

    case 'account.created':
      return {
        ...base,
        objectKind: null,
        summary: { accountId: mutation.accountId, login: mutation.after.login },
        diff: created(ACCOUNT_FIELDS, mutation.after, 'account'),
      };

    case 'account.updated':
      return {
        ...base,
        objectKind: null,
        summary: { accountId: mutation.accountId, login: mutation.after.login },
        diff: changed(ACCOUNT_FIELDS, mutation.before, mutation.after, 'account'),
      };

    case 'account.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { accountId: mutation.accountId, login: mutation.before.login },
        diff: deleted(ACCOUNT_FIELDS, mutation.before, 'account'),
      };

    case 'account.passwordChanged':
      return {
        ...base,
        objectKind: null,
        // That it happened, by whom and to whom. Nothing about the password: see the mutation.
        summary: { accountId: mutation.accountId, login: mutation.login, reset: mutation.reset },
        diff: [],
      };

    case 'account.mfaEnabled':
      return {
        ...base,
        objectKind: null,
        summary: {
          accountId: mutation.accountId,
          login: mutation.login,
          recoveryCodes: mutation.recoveryCodes,
        },
        diff: [{ field: 'account.mfa', before: false, after: true }],
      };

    case 'account.mfaDisabled':
      return {
        ...base,
        objectKind: null,
        summary: { accountId: mutation.accountId, login: mutation.login },
        diff: [{ field: 'account.mfa', before: true, after: false }],
      };

    case 'account.recoveryCodesRegenerated':
      return {
        ...base,
        objectKind: null,
        summary: {
          accountId: mutation.accountId,
          login: mutation.login,
          recoveryCodes: mutation.recoveryCodes,
        },
        diff: [],
      };

    case 'group.created':
      return {
        ...base,
        objectKind: null,
        summary: { groupId: mutation.groupId, name: mutation.after.name },
        diff: created(GROUP_FIELDS, mutation.after, 'group'),
      };

    case 'group.updated':
      return {
        ...base,
        objectKind: null,
        summary: { groupId: mutation.groupId, name: mutation.after.name },
        diff: changed(GROUP_FIELDS, mutation.before, mutation.after, 'group'),
      };

    case 'group.deleted':
      return {
        ...base,
        objectKind: null,
        summary: {
          groupId: mutation.groupId,
          name: mutation.before.name,
          members: [...mutation.members],
        },
        diff: deleted(GROUP_FIELDS, mutation.before, 'group'),
      };

    case 'group.memberAdded':
      return {
        ...base,
        objectKind: null,
        summary: {
          groupId: mutation.groupId,
          group: mutation.groupName,
          administers: mutation.administers,
          accountId: mutation.accountId,
          login: mutation.login,
          primary: mutation.primary,
        },
        diff: [{ field: 'group.member', before: null, after: mutation.login }],
      };

    case 'group.memberRemoved':
      return {
        ...base,
        objectKind: null,
        summary: {
          groupId: mutation.groupId,
          group: mutation.groupName,
          administers: mutation.administers,
          accountId: mutation.accountId,
          login: mutation.login,
          wasPrimary: mutation.wasPrimary,
        },
        diff: [{ field: 'group.member', before: mutation.login, after: null }],
      };

    case 'group.primarySet':
      return {
        ...base,
        objectKind: null,
        summary: {
          accountId: mutation.accountId,
          login: mutation.login,
          groupId: mutation.after.groupId,
        },
        diff: [
          {
            field: 'account.primaryGroup',
            before: mutation.before?.groupName ?? null,
            after: mutation.after.groupName,
          },
        ],
      };

    case 'token.issued':
      return {
        ...base,
        objectKind: null,
        // The prefix, never the token (`A-18`), as a share link's entry carries its prefix.
        summary: {
          tokenId: mutation.tokenId,
          accountId: mutation.accountId,
          login: mutation.login,
          name: mutation.name,
          prefix: mutation.prefix,
          scope: mutation.scope,
          expiresAt: mutation.expiresAt === null ? null : mutation.expiresAt.toISOString(),
        },
        diff: [],
      };

    case 'token.revoked':
      return {
        ...base,
        objectKind: null,
        summary: {
          tokenId: mutation.tokenId,
          accountId: mutation.accountId,
          login: mutation.login,
          name: mutation.name,
          prefix: mutation.prefix,
        },
        diff: [],
      };

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

    case 'credential.set':
      return {
        ...base,
        objectKind: null,
        summary: {
          credentialKind: mutation.credentialKind,
          created: mutation.created,
          secretsSet: [...mutation.secretsSet],
          secretsKept: [...mutation.secretsKept],
        },
        // The public half only, and only as an "after". There is deliberately no before: it
        // would be the previous public parameters beside a `secretsSet` list, which invites the
        // next person to add the values to match — and a diff of credentials is a permanent,
        // API-readable copy of them.
        diff: [
          {
            field: `credential.${mutation.credentialKind}`,
            before: null,
            after: mutation.publicParams,
          },
        ],
      };

    case 'credential.deleted':
      return {
        ...base,
        objectKind: null,
        summary: { credentialKind: mutation.credentialKind },
        diff: [{ field: `credential.${mutation.credentialKind}`, before: null, after: null }],
      };

    case 'object.paused':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: {
          // A window's start is what distinguishes "paused it" from "scheduled an outage for
          // Saturday", and the two are the same action taken for very different reasons.
          from: mutation.from.toISOString(),
          until: mutation.until?.toISOString() ?? null,
          message: mutation.message,
          sensorsAffected: mutation.sensorsAffected,
        },
        diff: [{ field: 'paused', before: false, after: true }],
      };

    case 'object.resumed':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { sensorsAffected: mutation.sensorsAffected },
        diff: [{ field: 'paused', before: true, after: false }],
      };

    case 'sensor.acknowledged':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: {
          until: mutation.until?.toISOString() ?? null,
          message: mutation.message,
          sensorsAffected: mutation.sensorsAffected,
        },
        diff: [{ field: 'acknowledged', before: false, after: true }],
      };

    case 'sensor.acknowledgementCleared':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { sensorsAffected: mutation.sensorsAffected },
        diff: [{ field: 'acknowledged', before: true, after: false }],
      };

    case 'sensor.simulatedError':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { message: mutation.message, sensorsAffected: mutation.sensorsAffected },
        diff: [
          {
            field: 'simulatedError',
            before: !mutation.simulated,
            after: mutation.simulated,
          },
        ],
      };

    case 'channel.processing.set':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { channelKey: mutation.channelKey },
        // Only what moved. A graph that suddenly reads eight times higher is answered by one
        // line saying scaleMul went from 1 to 8, not by five lines of unchanged settings.
        diff: PROCESSING_FIELDS.filter(
          (field) => mutation.before[field] !== mutation.after[field],
        ).map((field) => ({
          field: `channel.${mutation.channelKey}.${field}`,
          before: mutation.before[field],
          after: mutation.after[field],
        })),
      };

    case 'channel.lookup.set':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { channelKey: mutation.channelKey },
        diff: [
          {
            field: `channel.${mutation.channelKey}.lookup`,
            before: mutation.before,
            after: mutation.after,
          },
        ],
      };

    case 'channel.limits.set':
      return {
        ...base,
        objectKind: mutation.kind,
        summary: { channelKey: mutation.channelKey },
        // Only the fields that moved, named the way the operator sees them. A diff listing all
        // seven every time would bury the one threshold somebody changed.
        diff: LIMIT_FIELDS.filter((field) => mutation.before[field] !== mutation.after[field]).map(
          (field) => ({
            field: `channel.${mutation.channelKey}.${field}`,
            before: mutation.before[field],
            after: mutation.after[field],
          }),
        ),
      };
  }
}

const PROCESSING_FIELDS = [
  'scaleMul',
  'scaleDiv',
  'decimals',
  'spikeMin',
  'spikeMax',
] as const satisfies readonly (keyof ChannelProcessing)[];

const SCHEDULE_FIELDS = [
  'name',
  'description',
  'polarity',
  'timezone',
  'periods',
] as const satisfies readonly (keyof ScheduleAudit)[];

const LIBRARY_FIELDS = [
  'name',
  'description',
  'priority',
  'nodes',
] as const satisfies readonly (keyof LibraryAudit)[];

const MAP_FIELDS = [
  'name',
  'description',
  'priority',
  'layout',
] as const satisfies readonly (keyof MapAudit)[];

const BACKGROUND_FIELDS = [
  'mediaType',
  'digest',
  'width',
  'height',
  'bytes',
] as const satisfies readonly (keyof MapBackgroundAudit)[];

const REPORT_FIELDS = [
  'name',
  'description',
  'kind',
  'subjects',
  'span',
  'outputs',
  'schedule',
  'runAs',
] as const satisfies readonly (keyof ReportAudit)[];

const PROBE_FIELDS = [
  'status',
  'objectId',
  'allowFrom',
  'note',
] as const satisfies readonly (keyof ProbeTrustAudit)[];

const REDISCOVERY_FIELDS = [
  'name',
  'probeId',
  'range',
  'level',
  'templates',
  'community',
  'cadence',
  'timezone',
  'window',
  'autoProvision',
  'enabled',
  'timeoutMs',
  'concurrency',
  'ratePerSecond',
] as const satisfies readonly (keyof RediscoveryScheduleAudit)[];

/** Which probe, by the facts somebody decided on — never by anything it authenticates with. */
function probeSummary(probe: ProbeIdentity): Record<string, unknown> {
  return { gid: probe.gid, name: probe.name, address: probe.address };
}

/** Everything an administrator sets on an account, in the order a person reads them (`A-18`). */
const ACCOUNT_FIELDS = [
  'login',
  'displayName',
  'email',
  'role',
  'disabled',
  'mayAcknowledge',
  'mustChangePassword',
] as const satisfies readonly (keyof AccountAudit)[];

const GROUP_FIELDS = [
  'name',
  'description',
  'isAdmin',
] as const satisfies readonly (keyof GroupAudit)[];

/**
 * The diff of a flat entity, in the three shapes every one of them has (`A-17`).
 *
 * The schedule and library cases above spell these out by hand, and were written before a third
 * and fourth entity arrived; these are that pattern named once. Every field on a create and a
 * delete, and only what moved on an update, because an update listing all eight fields of a
 * report would not say which one somebody changed.
 */
function created<T extends object>(
  fields: readonly (keyof T & string)[],
  after: T,
  prefix: string,
): FieldChange[] {
  return fields.map((field) => ({
    field: `${prefix}.${field}`,
    before: null,
    after: after[field],
  }));
}

function changed<T extends object>(
  fields: readonly (keyof T & string)[],
  before: T,
  after: T,
  prefix: string,
): FieldChange[] {
  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field: `${prefix}.${field}`, before: before[field], after: after[field] }));
}

function deleted<T extends object>(
  fields: readonly (keyof T & string)[],
  before: T,
  prefix: string,
): FieldChange[] {
  return fields.map((field) => ({
    field: `${prefix}.${field}`,
    before: before[field],
    after: null,
  }));
}

const LIMIT_FIELDS = [
  'enabled',
  'upperError',
  'upperWarning',
  'lowerWarning',
  'lowerError',
  'errorMessage',
  'warningMessage',
] as const satisfies readonly (keyof ChannelLimits)[];

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
