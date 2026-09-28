import type { Logger } from '@ms/shared';
import type { Visibility } from '../auth/access.js';
import type { Database } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { ObjectError } from '../objects/errors.js';
import type { ObjectId } from '../objects/types.js';
import { triggerKinds, TriggerError } from './definition.js';
import { TriggerRepository, type TriggerWrite } from './repository.js';

export interface TriggerServiceOptions {
  db: Database;
  audit: AuditSink;
  logger: Logger;
  repository?: TriggerRepository;
}

/** What a client sends. `enabled` defaults to on, because a trigger nobody wants is deleted. */
export interface TriggerInput {
  readonly kind: string;
  readonly settings: Record<string, unknown>;
  readonly enabled?: boolean;
}

/** A trigger as the API serves it, with the sentence an operator reads on the tab. */
export interface TriggerView {
  readonly id: number;
  readonly kind: string;
  readonly kindName: string;
  readonly settings: Record<string, unknown>;
  readonly enabled: boolean;
  readonly summary: string;
  readonly inherited: boolean;
  readonly definedOn: { readonly objectId: ObjectId; readonly name: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Creating, editing and reading notification triggers (`N-01`).
 *
 * Nothing here fires anything: `N-02` and `N-03` are the engine, `N-04` the timers, `N-05` the
 * templates. This is the storage, the validation boundary and the inheritance — the parts every
 * one of those depends on and none of them should reimplement.
 */
export class TriggerService {
  readonly #db: Database;
  readonly #repo: TriggerRepository;
  readonly #audit: AuditSink;
  readonly #logger: Logger;

  constructor(options: TriggerServiceOptions) {
    this.#db = options.db;
    this.#repo = options.repository ?? new TriggerRepository();
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'triggers' });
  }

  /**
   * Every trigger in effect on an object, its own first.
   *
   * `CAPABILITIES.MD §5.1`: the tab shows own *and* inherited, with the source named. Naming the
   * source is the whole point — a trigger an operator cannot find is one they cannot turn off,
   * and the object it is defined on is the only place they can.
   */
  async effectiveFor(objectId: ObjectId, visibility: Visibility): Promise<TriggerView[]> {
    const triggers = await this.#repo.effectiveFor(this.#db, objectId);
    const visible = await visibility.visibleAmong(
      this.#db,
      triggers.map((trigger) => trigger.definedOn.objectId),
    );
    return triggers.map((trigger) =>
      this.#view(trigger, trigger.inherited, {
        objectId: trigger.definedOn.objectId,
        name: visible.has(trigger.definedOn.objectId) ? trigger.definedOn.name : null,
      }),
    );
  }

  /**
   * The object a trigger is defined on, or null if there is no such trigger (`P-154`).
   *
   * Exists for the authorisation guard: `/triggers/:id` is addressed by the trigger, and the
   * right that decides whether a caller may replace or delete it is the one on the object whose
   * alarms it governs. Null rather than a throw, because "no such trigger" is the handler's 404
   * and a guard that answered 403 to it would be an existence oracle.
   */
  async objectOf(id: number): Promise<ObjectId | null> {
    return (await this.#repo.get(this.#db, id))?.objectId ?? null;
  }

  async create(actor: Actor, objectId: ObjectId, input: TriggerInput): Promise<TriggerView> {
    const write = this.#parse(input);
    const now = new Date();
    return this.#db.tx(async (q) => {
      const id = await this.#repo.create(q, objectId, write);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'trigger.created',
            objectId,
            triggerId: id,
            triggerKind: write.kind,
            summary: triggerKinds.get(write.kind).describe(write.settings),
          },
        ],
        now,
      );
      return this.#loaded(q, id);
    });
  }

  /**
   * Replaces a trigger.
   *
   * Whole-document, like a schedule and for the same reason: the settings of one kind are a
   * single coherent statement — a latency without the notification it delays is not half a
   * trigger, it is a broken one — and the editor holds all of them anyway.
   */
  async update(actor: Actor, id: number, input: TriggerInput): Promise<TriggerView> {
    const write = this.#parse(input);
    const now = new Date();
    return this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      await this.#repo.update(q, id, write);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'trigger.updated',
            objectId: before.objectId,
            triggerId: id,
            triggerKind: write.kind,
            summary: triggerKinds.get(write.kind).describe(write.settings),
            previousSummary: triggerKinds.get(before.kind).describe(before.settings),
          },
        ],
        now,
      );
      return this.#loaded(q, id);
    });
  }

  async delete(actor: Actor, id: number): Promise<void> {
    const now = new Date();
    await this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      await this.#repo.delete(q, id);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'trigger.deleted',
            objectId: before.objectId,
            triggerId: id,
            triggerKind: before.kind,
            // Not through `get`, which throws for a kind this build does not know — and deleting
            // it is the one action that clears the row (`P-139`).
            summary:
              triggerKinds.tryGet(before.kind)?.describe(before.settings) ??
              `a trigger of the unknown kind "${before.kind}"`,
          },
        ],
        now,
      );
      this.#logger.info({ triggerId: id, objectId: before.objectId }, 'trigger deleted');
    });
  }

  /** Validates settings against their kind and fills the schema's defaults in. */
  #parse(input: TriggerInput): TriggerWrite {
    const kind = triggerKinds.get(input.kind);
    return {
      kind: kind.id,
      settings: triggerKinds.validate(kind.id, input.settings),
      enabled: input.enabled ?? true,
    };
  }

  async #loaded(q: Parameters<TriggerRepository['get']>[0], id: number): Promise<TriggerView> {
    const stored = await this.#repo.get(q, id);
    if (stored === null) throw notFound(id);
    const owner = await q.query<{ name: string }>('SELECT name FROM object WHERE id = $1', [
      stored.objectId,
    ]);
    return this.#view(stored, false, {
      objectId: stored.objectId,
      name: owner[0]?.name ?? '',
    });
  }

  #view(
    stored: {
      id: number;
      kind: string;
      settings: Record<string, unknown>;
      enabled: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    inherited: boolean,
    definedOn: { objectId: ObjectId; name: string | null },
  ): TriggerView {
    // **Readable even when this build does not know the kind** (`P-139`). One row of an
    // unrecognised kind used to make the whole list throw, so an operator could not see any of
    // their triggers — and the row that caused it was the one they needed to find.
    const kind = triggerKinds.tryGet(stored.kind);
    return {
      id: stored.id,
      kind: stored.kind,
      kindName: kind?.name ?? stored.kind,
      settings: stored.settings,
      enabled: stored.enabled,
      summary:
        kind === undefined
          ? `this build does not know the trigger kind "${stored.kind}"`
          : kind.describe(stored.settings),
      inherited,
      definedOn,
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}

function notFound(id: number): ObjectError {
  return new ObjectError('OBJECT_NOT_FOUND', `no trigger ${String(id)}`, {
    context: { phase: 'triggers' },
    details: { triggerId: id },
  });
}

export { TriggerError };
