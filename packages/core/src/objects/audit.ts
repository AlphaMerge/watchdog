import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
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
  | { action: 'setting.set'; objectId: ObjectId; key: string; before: unknown; after: unknown }
  | { action: 'setting.reverted'; objectId: ObjectId; key: string; before: unknown };

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
    case 'setting.set':
    case 'setting.reverted':
      return { action: mutation.action, objectId: mutation.objectId, key: mutation.key };
  }
}
