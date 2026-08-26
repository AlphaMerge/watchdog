import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { ChannelLimits } from '../state/limits.js';
import type { ChannelProcessing } from './types.js';
import type {
  CloneCounts,
  CountsByKind,
  CredentialKind,
  ObjectDetail,
  ObjectId,
  ObjectKind,
  ObjectRef,
  SiblingMove,
} from './types.js';

/**
 * Who made a change. Anonymous until accounts exist (A-01); the shape is already right so
 * A-01 fills it in at one place rather than threading a user through every service method.
 */
export type Actor =
  | { kind: 'user'; userId: number; login: string }
  | { kind: 'token'; tokenId: number }
  | { kind: 'system'; component: string }
  | { kind: 'anonymous'; remoteAddress: string };

/**
 * What changed, as a typed union rather than `Record<string, unknown>`.
 *
 * Nothing here can carry a plaintext secret: credential changes are recorded by *kind*, and
 * the ciphertext is never read in the first place.
 */
export type Mutation =
  | { action: 'object.created'; objectId: ObjectId; kind: ObjectKind; after: ObjectDetail }
  | {
      action: 'object.updated';
      objectId: ObjectId;
      kind: ObjectKind;
      /** Redacted, like everything the sink is handed. */
      before: ObjectDetail;
      after: ObjectDetail;
      /**
       * Which sensor parameters changed, computed by the service from the *unredacted* values.
       *
       * Without this, rotating a `writeOnly` parameter would be invisible: both sides redact to
       * the same absence, so a diff of what the sink can see reports no change at all. The name
       * is the auditable fact; the value is the thing that must not be here.
       */
      changedParams: readonly string[];
    }
  | {
      action: 'object.moved';
      objectId: ObjectId;
      kind: ObjectKind;
      fromParentId: ObjectId;
      toParentId: ObjectId;
      movedCount: number;
      /** R-04 diffs a probe's configuration subtree on exactly this. */
      fromProbeId: ObjectId | null;
      toProbeId: ObjectId | null;
    }
  | {
      action: 'object.reordered';
      objectId: ObjectId;
      kind: ObjectKind;
      parentId: ObjectId;
      move: SiblingMove;
      fromIndex: number;
      toIndex: number;
    }
  | {
      action: 'object.cloned';
      objectId: ObjectId;
      kind: ObjectKind;
      sourceId: ObjectId;
      clonedCount: CloneCounts;
      droppedCredentialKinds: readonly CredentialKind[];
    }
  | {
      action: 'object.deleted';
      objectId: ObjectId;
      kind: ObjectKind;
      before: ObjectDetail;
      deleted: CountsByKind;
      /** Every destroyed object. WORKFLOW.MD §12 wants a diff, and there is no recycle bin. */
      destroyed: readonly ObjectRef[];
    }
  | {
      /**
       * A channel's thresholds changed (`M-04`).
       *
       * Audited because a limit is what decides an alarm: a sensor that went Down with cause
       * `limit` is answerable only if the log says who set the limit and to what. Nothing here
       * can carry a secret — four numbers and two operator-written notes.
       */
      action: 'channel.limits.set';
      /** The sensor. Channels have no identity of their own in the object tree. */
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: ChannelLimits;
      after: ChannelLimits;
    }
  | {
      /**
       * A channel was pointed at a different lookup, or at none (`M-06`).
       *
       * Its own action rather than a field inside `channel.limits.set`: they are the two
       * different ways a channel's state is decided, and "who changed what this channel is
       * judged by" is a question with two distinct answers.
       */
      action: 'channel.lookup.set';
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: string | null;
      after: string | null;
    }
  | {
      /**
       * A channel's scaling, spike filter or decimal places changed (`M-07`).
       *
       * Everything that happens to a reading between arriving and being judged or shown. Its
       * own action beside `channel.limits.set` and `channel.lookup.set`, because a graph that
       * suddenly reads eight times higher is answered by knowing who changed the factor — and
       * a diff that named only "the channel" would not answer it.
       */
      action: 'channel.processing.set';
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: ChannelProcessing;
      after: ChannelProcessing;
    }
  | {
      /**
       * An object was paused (`M-08`).
       *
       * `sensorsAffected` is the count that makes the entry answerable: "somebody paused the
       * London group" is a different event from "somebody paused the London group and four
       * thousand sensors stopped being monitored", and only the number distinguishes them.
       */
      action: 'object.paused';
      objectId: ObjectId;
      kind: ObjectKind;
      /**
       * When it takes effect (`M-10`).
       *
       * Later than the entry's own timestamp for a maintenance window, and the reason the entry
       * is worth keeping separately from the one the sweep writes when the window opens: one
       * records who scheduled the outage and when they did it, the other that it happened.
       */
      from: Date;
      /** `null` is indefinite. */
      until: Date | null;
      message: string;
      sensorsAffected: number;
    }
  | {
      action: 'object.resumed';
      objectId: ObjectId;
      kind: ObjectKind;
      sensorsAffected: number;
    }
  | {
      /**
       * An operator acknowledged an alarm (`M-13`).
       *
       * Audited because it is the one action that makes a system deliberately stop telling
       * anybody about an outage. "Who silenced this, when, for how long, and what did they say
       * they were doing about it" is the whole reason the entry exists.
       *
       * `objectId` is what the operator clicked — a sensor, or a device whose Down sensors were
       * acknowledged together — and `sensorsAffected` is how many alarms that turned out to be.
       */
      action: 'sensor.acknowledged';
      objectId: ObjectId;
      kind: ObjectKind;
      /** `null` is indefinite: until it recovers, or somebody clears it. */
      until: Date | null;
      message: string;
      sensorsAffected: number;
    }
  | {
      action: 'sensor.acknowledgementCleared';
      objectId: ObjectId;
      kind: ObjectKind;
      sensorsAffected: number;
    }
  | { action: 'setting.set'; objectId: ObjectId; key: string; before: unknown; after: unknown }
  | { action: 'setting.reverted'; objectId: ObjectId; key: string; before: unknown }
  | {
      /**
       * A schedule was created, changed or removed (`M-09`).
       *
       * `objectId` is null because a schedule is not in the object tree: it is a library object
       * that many objects reference and none contains. The audit column is nullable for exactly
       * this, and the schedule's own id travels in the summary.
       *
       * Auditable because editing a schedule silently changes when several thousand sensors are
       * watched — a wider blast radius than most single-object edits, and one nobody would
       * think to look for after the fact.
       */
      action: 'schedule.created';
      objectId: null;
      scheduleId: number;
      after: ScheduleAudit;
    }
  | {
      action: 'schedule.updated';
      objectId: null;
      scheduleId: number;
      before: ScheduleAudit;
      after: ScheduleAudit;
    }
  | {
      action: 'schedule.deleted';
      objectId: null;
      scheduleId: number;
      before: ScheduleAudit;
    };

/**
 * A schedule as the audit log records it.
 *
 * The periods in their text form rather than as intervals: a diff is read by a person, and
 * `fr:19:00-mo:06:00` is a change somebody can recognise where `[{"start":6900,...}]` is not.
 */
export interface ScheduleAudit {
  readonly name: string;
  readonly description: string;
  readonly polarity: 'active' | 'inactive';
  readonly timezone: string | null;
  readonly periods: string;
}

export interface AuditSink {
  /**
   * Called **inside** the mutation's transaction, so an audit entry can never exist for a
   * change that rolled back, nor a change exist without its entry. That property is what makes
   * S-10 a sink swap rather than a rewrite.
   */
  record(q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date): Promise<void>;
}

/** The default until S-10 ships a table. Structured, correlated, and never a secret. */
export class LoggingAuditSink implements AuditSink {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'audit' });
  }

  record(_q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date): Promise<void> {
    for (const mutation of mutations) {
      this.#logger.info(
        { actor, at: at.toISOString(), ...summarise(mutation) },
        `audit ${mutation.action}`,
      );
    }
    return Promise.resolve();
  }
}

/** Log lines stay bounded: a subtree delete enumerates thousands of objects. */
function summarise(mutation: Mutation): Record<string, unknown> {
  switch (mutation.action) {
    case 'object.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        deleted: mutation.deleted,
        destroyedCount: mutation.destroyed.length,
      };
    case 'object.created':
      return { action: mutation.action, objectId: mutation.objectId, kind: mutation.kind };
    case 'object.updated':
      return { action: mutation.action, objectId: mutation.objectId, kind: mutation.kind };
    case 'object.moved':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        fromParentId: mutation.fromParentId,
        toParentId: mutation.toParentId,
        movedCount: mutation.movedCount,
      };
    case 'object.reordered':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        parentId: mutation.parentId,
        move: mutation.move,
        fromIndex: mutation.fromIndex,
        toIndex: mutation.toIndex,
      };
    case 'object.cloned':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        sourceId: mutation.sourceId,
        clonedCount: mutation.clonedCount,
      };
    case 'channel.limits.set':
    case 'channel.lookup.set':
    case 'channel.processing.set':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        channelKey: mutation.channelKey,
      };
    case 'object.paused':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        from: mutation.from.toISOString(),
        until: mutation.until?.toISOString() ?? null,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'object.resumed':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'setting.set':
    case 'setting.reverted':
      return { action: mutation.action, objectId: mutation.objectId, key: mutation.key };
    case 'sensor.acknowledged':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        until: mutation.until?.toISOString() ?? null,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'sensor.acknowledgementCleared':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'schedule.created':
    case 'schedule.deleted':
      return {
        action: mutation.action,
        scheduleId: mutation.scheduleId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'schedule.updated':
      return {
        action: mutation.action,
        scheduleId: mutation.scheduleId,
        name: mutation.after.name,
      };
  }
}
