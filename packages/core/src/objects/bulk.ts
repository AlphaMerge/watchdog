import { describeError, type Logger } from '@ms/shared';
import { ObjectError } from './errors.js';
import type { ObjectService } from './service.js';
import type { Actor } from './audit.js';
import type { ObjectId } from './types.js';
import type { PauseRequest } from '../state/pause.js';

/**
 * Bulk operations over a selection (`D-09`).
 *
 * **A loop over the single-object methods, and that is the design rather than a shortcut.**
 * Every rule this system has about changing an object — hierarchy validation, write-only
 * redaction, audit, version bookkeeping, dependency and inheritance recomputation — lives inside
 * `ObjectService`'s per-object methods. Reaching past them to the repository, which is what one
 * transaction for the whole selection would require, would be a second way to update an object:
 * the exact thing `CLAUDE.md` forbids, and the kind of thing that is correct on the day it is
 * written and diverges quietly afterwards.
 *
 * **This contradicts the note `S-03` left on `D-09`**, which expected `ObjectService.batch` to
 * put the whole selection in one transaction under one lock. Said out loud rather than quietly
 * diverged from. Two reasons it is not used here:
 *
 * 1. `batch` hands out `(q, repo)` — the *repository*. Composing repository calls is safe for
 *    the operations `S-03` had in mind and unsafe for these, because the service methods do far
 *    more than call the repository.
 * 2. One transaction over a selection holds the **exclusive tree lock** for the length of the
 *    whole batch. `ObjectService.delete` already worries about this for a single subtree; five
 *    hundred of them would block every write in the installation for as long as it took, which
 *    is a self-inflicted outage in the thing that is supposed to notice outages.
 *
 * `batch` remains the right tool for a set of repository operations that genuinely must be
 * atomic. A selection of independent objects is not that.
 *
 * **So each object is atomic and the batch is best-effort**, with a per-object outcome. That is
 * the honest behaviour rather than the convenient one: an operator who selects forty sensors and
 * pauses them, one of which a colleague deleted a moment ago, wants thirty-nine paused and a
 * line naming the fortieth. All-or-nothing would give them nothing and an error they cannot map
 * back to a row. It is also what `D-04` chose per host, for the same reason.
 */

/** The most a single request may name. */
export const MAX_BULK = 500;

export type BulkOperation =
  | { kind: 'pause'; request: PauseRequest; message: string }
  | { kind: 'resume' }
  | { kind: 'move'; targetParentId: ObjectId }
  | { kind: 'clone'; targetParentId: ObjectId }
  | {
      kind: 'delete';
      /**
       * Whether an object with children may be deleted.
       *
       * False refuses one, which is the safe default and the one a UI should offer first: a
       * selection of six groups is six subtrees, and nobody counted them.
       */
      cascade: boolean;
    }
  | { kind: 'setting'; key: string; value: unknown }
  /**
   * Reverts a setting to whatever the object inherits.
   *
   * Its own operation rather than `setting` with a null value, because that is the shape the
   * single-object API already has — `PUT` sets and `DELETE` reverts — and a bulk route where
   * null meant "revert" would be a second grammar for the same idea. It would also be a trap:
   * `null` is a legitimate value for a setting whose schema allows it, and a route that read it
   * as an instruction could never store one. **Found live**: the first version did exactly that
   * and reverting failed on every object, because a null reached the setting's own schema.
   */
  | { kind: 'revertSetting'; key: string };

export interface BulkOutcome {
  objectId: ObjectId;
  ok: boolean;
  /** The single-object error's own sentence. Absent when it worked. */
  problem?: string;
  code?: string;
  /** What a clone made. */
  createdId?: number;
  /** How many objects a delete took with it, including the object itself. */
  deleted?: number;
}

export interface BulkReport {
  /** Ids as asked for, after duplicates are collapsed. */
  requested: number;
  succeeded: number;
  failed: number;
  /** How many repeated ids were collapsed. Reported rather than silently dropped. */
  duplicates: number;
  outcomes: BulkOutcome[];
}

export interface BulkServiceOptions {
  objects: ObjectService;
  logger: Logger;
}

export class BulkService {
  readonly #objects: ObjectService;
  readonly #logger: Logger;

  constructor(options: BulkServiceOptions) {
    this.#objects = options.objects;
    this.#logger = options.logger.child({ component: 'bulk' });
  }

  async apply(
    actor: Actor,
    ids: readonly ObjectId[],
    operation: BulkOperation,
  ): Promise<BulkReport> {
    // Collapsed rather than refused: a tree UI can hand the same id over twice — a row selected
    // and its ancestor's "select all" — and applying an operation twice is at best wasted work
    // and at worst a second audit entry for a change that happened once.
    const unique = [...new Set(ids)];
    const duplicates = ids.length - unique.length;

    if (unique.length > MAX_BULK) {
      throw new ObjectError(
        'OBJECT_INVALID',
        `a bulk operation may name at most ${String(MAX_BULK)} objects, and this one names ${String(unique.length)}`,
        {
          context: { phase: 'validate-request' },
          details: { limit: MAX_BULK, requested: unique.length },
        },
      );
    }

    // Ids an earlier delete in this same batch already destroyed, so the object that follows
    // them reads as "removed with its parent" rather than "does not exist". The difference
    // matters: one is the operator's own selection doing what they asked, the other looks like
    // somebody else changed the tree underneath them.
    const alreadyGone = new Set<ObjectId>();
    const outcomes: BulkOutcome[] = [];

    for (const id of unique) {
      try {
        outcomes.push({ objectId: id, ok: true, ...(await this.#one(actor, id, operation, alreadyGone)) });
      } catch (error) {
        outcomes.push({
          objectId: id,
          ok: false,
          problem: reasonFor(error, id, alreadyGone),
          code: error instanceof ObjectError ? error.code : 'INTERNAL_ERROR',
        });
      }
    }

    const succeeded = outcomes.filter((one) => one.ok).length;
    const report: BulkReport = {
      requested: unique.length,
      succeeded,
      failed: outcomes.length - succeeded,
      duplicates,
      outcomes,
    };
    this.#logger.info(
      { operation: operation.kind, requested: report.requested, succeeded, failed: report.failed },
      'a bulk operation finished',
    );
    return report;
  }

  /** One object, through the one place that knows how to change it. */
  async #one(
    actor: Actor,
    id: ObjectId,
    operation: BulkOperation,
    alreadyGone: Set<ObjectId>,
  ): Promise<Partial<BulkOutcome>> {
    switch (operation.kind) {
      case 'pause':
        await this.#objects.pause(actor, id, operation.request, operation.message);
        return {};
      case 'resume':
        await this.#objects.resume(actor, id);
        return {};
      case 'move':
        await this.#objects.move(actor, id, operation.targetParentId, { kind: 'none' });
        return {};
      case 'clone': {
        const result = await this.#objects.clone(actor, id, {
          targetParentId: operation.targetParentId,
        });
        return { createdId: result.object.id };
      }
      case 'setting':
        await this.#objects.setSetting(actor, id, operation.key, operation.value);
        return {};
      case 'revertSetting':
        await this.#objects.clearSetting(actor, id, operation.key);
        return {};
      case 'delete': {
        const report = await this.#deleteOne(actor, id, operation.cascade);
        for (const ref of report.destroyed) alreadyGone.add(ref.id);
        return { deleted: report.deleted.total };
      }
    }
  }

  /**
   * A delete that may or may not be allowed to take children with it.
   *
   * **Cascade goes through the guard rather than around it.** `delete` refuses a non-empty
   * subtree unless it is told exactly how many descendants to expect, which is what stops a
   * client that thought it was deleting one object from deleting five thousand. A bulk cascade
   * cannot know that number in advance, so it asks for the safe delete first and reads the count
   * out of the refusal — and the retry's `exact` check then catches a subtree that changed
   * between the two attempts, which is the race the guard exists for. Counting separately and
   * passing the answer straight to `exact` would have the same shape and none of the protection.
   */
  async #deleteOne(
    actor: Actor,
    id: ObjectId,
    cascade: boolean,
  ): Promise<Awaited<ReturnType<ObjectService['delete']>>> {
    try {
      return await this.#objects.delete(actor, id, { kind: 'leafOnly' }, { kind: 'none' });
    } catch (error) {
      if (!cascade || !(error instanceof ObjectError) || error.code !== 'OBJECT_NOT_EMPTY') throw error;
      const counts = error.details['deleted'];
      const total = typeof counts === 'object' && counts !== null ? (counts as { total?: unknown }).total : undefined;
      if (typeof total !== 'number') throw error;
      return await this.#objects.delete(
        actor,
        id,
        { kind: 'exact', descendants: total - 1 },
        { kind: 'none' },
      );
    }
  }
}

/**
 * Why one object did not change.
 *
 * A missing object that this batch itself destroyed is reported as such. "object 812 does not
 * exist" is true and useless when the operator deleted its parent two rows ago; it reads as
 * somebody else changing the tree underneath them, and sends them looking for a problem that is
 * not there.
 */
function reasonFor(error: unknown, id: ObjectId, alreadyGone: Set<ObjectId>): string {
  if (error instanceof ObjectError && error.code === 'OBJECT_NOT_FOUND' && alreadyGone.has(id)) {
    return 'it was removed with an object deleted earlier in this batch';
  }
  return describeError(error).message;
}
