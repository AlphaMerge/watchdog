import type { Logger } from '@ms/shared';
import { changedParamKeys } from '../audit/diff.js';
import type { Database, Queryable } from '../db/pool.js';
import type { InheritanceResolver, ResolvedCredential } from '../settings/inheritance.js';
import { settingRegistry } from '../settings/registry.js';
import type { Actor, AuditSink } from './audit.js';
import { ObjectError, notFound, parentNotFound } from './errors.js';
import { reorderSiblings } from './ordering.js';
import { versionConflict } from './repository.js';
import type { ObjectRepository } from './repository.js';
import type { SensorTypeGate } from './sensor-type-gate.js';
import type {
  ChannelRecord,
  CloneInput,
  CloneResult,
  CreateObjectInput,
  CredentialChange,
  CredentialKind,
  CredentialView,
  DeleteExpectation,
  DeleteReport,
  MoveResult,
  ObjectDetail,
  ObjectFilter,
  ObjectId,
  ObjectRef,
  ObjectSummary,
  Page,
  PageRequest,
  Precondition,
  SettingChange,
  SettingView,
  SiblingMove,
  SubtreeOptions,
  SubtreeResult,
  UpdateObjectInput,
} from './types.js';

export interface ObjectServiceOptions {
  db: Database;
  repository: ObjectRepository;
  resolver: InheritanceResolver;
  audit: AuditSink;
  sensorTypes: SensorTypeGate;
  logger: Logger;
  /** Refuses a clone larger than this. Protects the request, not the database. */
  maxCloneObjects?: number;
}

/**
 * Every mutation to the object tree.
 *
 * The service owns transactions, advisory locks and audit; the repository owns SQL. That split
 * is what lets several operations compose into one atomic unit — which bulk operations (D-09)
 * and discovery provisioning (D-04) both need — and gives per-object access rights (A-03) a
 * single chokepoint rather than one per route handler.
 */
export class ObjectService {
  readonly #db: Database;
  readonly #repo: ObjectRepository;
  readonly #resolver: InheritanceResolver;
  readonly #audit: AuditSink;
  readonly #sensorTypes: SensorTypeGate;
  readonly #logger: Logger;
  readonly #maxCloneObjects: number;

  constructor(options: ObjectServiceOptions) {
    this.#db = options.db;
    this.#repo = options.repository;
    this.#resolver = options.resolver;
    this.#audit = options.audit;
    this.#sensorTypes = options.sensorTypes;
    this.#logger = options.logger.child({ component: 'objects' });
    this.#maxCloneObjects = options.maxCloneObjects ?? 5_000;
  }

  /**
   * The write-only boundary (CLAUDE.md: credentials are never returned by any API route, to
   * anyone). Every `ObjectDetail` this service hands out goes through here — to a route, to the
   * audit sink, to any caller. Only the repository sees a stored secret, and only the probe
   * config push reads it from there.
   *
   * Redacting here rather than in the route means a new endpoint cannot forget to.
   */
  #redact(detail: ObjectDetail): ObjectDetail {
    if (detail.kind !== 'sensor') return detail;
    const { params, redacted } = this.#sensorTypes.redact(detail.sensorType, {
      ...detail.params,
    });
    return { ...detail, params, redactedParams: redacted };
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────

  async get(id: ObjectId): Promise<ObjectDetail> {
    const object = await this.#repo.get(this.#db, id);
    if (object === null) throw notFound(id);
    return this.#redact(object);
  }

  async getRoot(): Promise<ObjectDetail> {
    return this.#redact(await this.#repo.getRoot(this.#db));
  }

  /**
   * Effective values are resolved for the whole page in one query per key. A route that looped
   * the single-object resolver would issue `rows × keys` round trips; `resolveForObjects`
   * exists for exactly this.
   */
  async list(
    filter: ObjectFilter,
    page: PageRequest,
    effectiveKeys: readonly string[] = [],
  ): Promise<Page<ObjectSummary>> {
    const result = await this.#repo.list(this.#db, filter, page);
    if (effectiveKeys.length === 0 || result.items.length === 0) return result;
    return { ...result, items: await this.#attachEffective(result.items, effectiveKeys) };
  }

  async subtree(
    id: ObjectId,
    options: SubtreeOptions,
    effectiveKeys: readonly string[] = [],
  ): Promise<SubtreeResult> {
    await this.get(id);
    const result = await this.#repo.subtree(this.#db, id, options);
    if (effectiveKeys.length === 0 || result.items.length === 0) return result;
    return { ...result, items: await this.#attachEffective(result.items, effectiveKeys) };
  }

  async ancestors(id: ObjectId): Promise<ObjectRef[]> {
    await this.get(id);
    return this.#repo.ancestors(this.#db, id);
  }

  async channels(id: ObjectId): Promise<ChannelRecord[]> {
    const object = await this.get(id);
    if (object.kind !== 'sensor') {
      throw new ObjectError(
        'OBJECT_KIND_MISMATCH',
        `only a sensor has channels; object ${String(id)} is a ${object.kind}`,
        { context: { objectId: id, phase: 'channels' }, details: { storedKind: object.kind } },
      );
    }
    return this.#repo.channels(this.#db, id);
  }

  /** Effective and own together — exactly one render of an inheritance-aware settings form. */
  async settings(id: ObjectId, asChildOf?: ObjectId): Promise<SettingView[]> {
    const object = await this.get(id);

    if (asChildOf !== undefined) {
      const parent = await this.#repo.get(this.#db, asChildOf);
      if (parent === null) throw parentNotFound(asChildOf);
      if (!(await this.#repo.isValidParentKind(this.#db, object.kind, parent.kind))) {
        throw parentKindInvalid(object.kind, parent.kind);
      }
    }

    const effective =
      asChildOf === undefined
        ? await this.#resolver.resolveAll(id)
        : await this.#resolver.resolveAllAsChildOf(id, asChildOf);
    const own = await this.#resolver.own(id);

    return settingRegistry.definitions().map((definition) => {
      const resolved = effective[definition.key];
      return {
        key: definition.key,
        description: definition.description,
        schema: definition.schema,
        effective: {
          value: resolved?.value ?? definition.default,
          source: resolved?.source ?? { kind: 'default' },
        },
        own: definition.key in own ? { value: own[definition.key] } : null,
      };
    });
  }

  async credentials(id: ObjectId, includeInherited: boolean): Promise<CredentialView[]> {
    await this.get(id);
    const resolved = await this.#resolver.resolveCredentials(id);
    const visible = includeInherited
      ? resolved
      : resolved.filter((row) => row.source.kind === 'own');
    return visible.map((row) => ({
      kind: row.kind,
      publicParams: row.publicParams,
      source: row.source,
      updatedAt: row.updatedAt,
    }));
  }

  // ── settings writes ──────────────────────────────────────────────────────────────────────

  /**
   * Overrides a setting on one object.
   *
   * In a transaction with its audit entry, like every other mutation: the sink's contract is
   * that an entry cannot exist for a change that rolled back, nor a change without its entry.
   *
   * `If-Match` is optional here — requiring a precondition per toggle would double a settings
   * form's request count — but it is honoured when sent, because silently ignoring a
   * precondition a client bothered to compute is worse than not accepting one at all.
   */
  async setSetting(
    actor: Actor,
    id: ObjectId,
    key: string,
    value: unknown,
    pre: Precondition = { kind: 'none' },
  ): Promise<void> {
    await this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const bound = this.#resolver.withExecutor(q);
      const before = (await bound.own(id))[key] ?? null;
      await bound.set(id, key, value);
      await this.#audit.record(
        q,
        actor,
        [{ action: 'setting.set', objectId: id, key, before, after: value }],
        new Date(),
      );
    });
  }

  /** Reverts to inherited, discarding the local value. Transactional for the same reason. */
  async clearSetting(
    actor: Actor,
    id: ObjectId,
    key: string,
    pre: Precondition = { kind: 'none' },
  ): Promise<boolean> {
    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const bound = this.#resolver.withExecutor(q);
      const before = (await bound.own(id))[key] ?? null;
      const reverted = await bound.clear(id, key);
      if (reverted) {
        await this.#audit.record(
          q,
          actor,
          [{ action: 'setting.reverted', objectId: id, key, before }],
          new Date(),
        );
      }
      return reverted;
    });
  }

  // ── mutations ────────────────────────────────────────────────────────────────────────────

  /**
   * The cache validator for a response that carries inherited content (S-13).
   *
   * Read-only and deliberately outside `get`: the point is to answer "has anything changed"
   * without paying for the resolution work the answer would otherwise require.
   */
  async chainValidator(id: ObjectId, salt: string): Promise<string | null> {
    return this.#db.tx((q) => this.#repo.chainValidator(q, id, salt));
  }

  async create(actor: Actor, input: CreateObjectInput): Promise<ObjectDetail> {
    // Validation fills in the defaults the type declares, and what gets stored is the filled-in
    // version — so a sensor's row is complete rather than depending on which form created it.
    const normalised: CreateObjectInput =
      input.kind === 'sensor'
        ? { ...input, params: this.#sensorTypes.normalise(input.sensorType, input.params ?? {}) }
        : input;

    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeShared(q);

      // Two values, one read: the parent's kind and whether it accepts this child (S-16).
      const parent = await this.#repo.getParentFor(q, normalised.parentId, normalised.kind);
      if (parent === null) throw parentNotFound(normalised.parentId);
      if (!parent.accepts) throw parentKindInvalid(normalised.kind, parent.kind);

      let created = await this.#repo.create(q, normalised);

      if (normalised.kind === 'sensor') {
        const { ownerVersion } = await this.#repo.createChannels(
          q,
          created.id,
          this.#sensorTypes.channelsFor(normalised.sensorType, normalised.params ?? {}),
        );
        // Declaring channels bumps the sensor's version by trigger, so the detail the insert
        // returned is already a version behind. Handing that back would give the caller an ETag
        // that 412s on its own first write.
        if (ownerVersion !== null) created = { ...created, version: ownerVersion };
      }

      const safe = this.#redact(created);
      await this.#audit.record(
        q,
        actor,
        [{ action: 'object.created', objectId: safe.id, kind: safe.kind, after: safe }],
        new Date(),
      );

      return safe;
    });
  }

  async update(
    actor: Actor,
    id: ObjectId,
    patch: UpdateObjectInput,
    pre: Precondition,
  ): Promise<ObjectDetail> {
    return this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      if (before.kind !== patch.kind) {
        throw new ObjectError(
          'OBJECT_KIND_MISMATCH',
          `object ${String(id)} is a ${before.kind}, not a ${patch.kind}`,
          {
            context: { objectId: id, phase: 'update' },
            details: { bodyKind: patch.kind, storedKind: before.kind },
          },
        );
      }

      const applied: UpdateObjectInput =
        patch.kind === 'sensor' && patch.params !== undefined
          ? {
              ...patch,
              params: this.#sensorTypes.normalise(
                before.kind === 'sensor' ? before.sensorType : '',
                patch.params,
              ),
            }
          : patch;

      const after = await this.#repo.update(q, id, applied, pre);

      // Computed on the real values, because a rotated secret redacts to the same absence on
      // both sides and would otherwise look like no change at all.
      const changedParams = changedParamKeys(before, after);

      // Both sides redacted before they are diffed: the audit log outlives the object and has
      // its own retention, so a secret reaching it is permanent in a way a read is not.
      const safeBefore = this.#redact(before);
      const safeAfter = this.#redact(after);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.updated',
            objectId: id,
            kind: safeAfter.kind,
            before: safeBefore,
            after: safeAfter,
            changedParams,
          },
        ],
        new Date(),
      );

      return safeAfter;
    });
  }

  /**
   * Reparents an object and everything beneath it.
   *
   * The adjacency model earns its keep here: moving a group of 5,000 sensors is one row
   * update, and every descendant's ETag stays valid because no descendant row changes.
   */
  /**
   * Moves an object up, down, first or last among its siblings (S-14).
   *
   * Under the exclusive tree lock, because it reads the current arrangement and writes a
   * permutation of it back: two operators dragging in the same group would otherwise interleave
   * into an order neither of them chose.
   *
   * A move that changes nothing — up at the top, down at the bottom — is a no-op that returns
   * the object unchanged, with no version bump and no audit entry. Someone holding the up arrow
   * on the first item is not making a mistake.
   */
  async reorder(
    actor: Actor,
    id: ObjectId,
    move: SiblingMove,
    pre: Precondition,
  ): Promise<ObjectDetail> {
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeExclusive(q);

      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (object.parentId === null) {
        throw new ObjectError('OBJECT_NOT_MOVABLE', 'the root object has no siblings', {
          context: { objectId: id, phase: 'reorder' },
        });
      }
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const siblings = await this.#repo.siblingOrder(q, object.parentId);
      const change = reorderSiblings(siblings, id, move);
      if (change === null) return this.#redact(object);

      await this.#repo.writeSiblingOrder(q, object.parentId, change.next);

      const after = await this.#repo.get(q, id);
      if (after === null) throw notFound(id);

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.reordered',
            objectId: id,
            kind: object.kind,
            parentId: object.parentId,
            move,
            fromIndex: change.from,
            toIndex: change.to,
          },
        ],
        new Date(),
      );

      return this.#redact(after);
    });
  }

  async move(
    actor: Actor,
    id: ObjectId,
    targetParentId: ObjectId,
    pre: Precondition,
  ): Promise<MoveResult> {
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeExclusive(q);

      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);

      if (object.kind === 'root') {
        throw new ObjectError('OBJECT_NOT_MOVABLE', 'the root object cannot be moved', {
          context: { objectId: id, phase: 'move' },
        });
      }
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const target = await this.#repo.get(q, targetParentId);
      if (target === null) throw parentNotFound(targetParentId);

      if (!(await this.#repo.isValidParentKind(q, object.kind, target.kind))) {
        throw parentKindInvalid(object.kind, target.kind);
      }

      const cyclePath = await this.#repo.wouldCycle(q, id, targetParentId);
      if (cyclePath !== null) {
        throw new ObjectError(
          'OBJECT_CYCLE',
          `moving "${object.name}" under "${target.name}" would place it inside its own subtree`,
          {
            context: { objectId: id, parentId: targetParentId, phase: 'move' },
            details: { path: [...cyclePath.map((ref) => ref.name).reverse(), object.name] },
          },
        );
      }

      // Idempotent: a no-op move gets a 200 with empty diffs, no version bump and no audit
      // entry, so a bulk move can be retried safely.
      if (object.parentId === targetParentId) {
        return {
          object,
          fromParentId: targetParentId,
          toParentId: targetParentId,
          movedCount: await this.#repo.countSubtree(q, id),
          probeChanged: null,
          settingsChanged: [],
          credentialsChanged: [],
        };
      }

      const bound = this.#resolver.withExecutor(q);
      const beforeSettings = await bound.resolveAll(id);
      const beforeCredentials = await bound.resolveCredentials(id);
      const fromProbe = await this.#repo.nearestProbe(q, id);

      const fromParentId = object.parentId;
      await this.#repo.reparent(q, id, targetParentId, pre);

      // The resolver is bound to this transaction, so it sees the uncommitted parent. Through
      // the pool it would read the pre-move chain and report that nothing changed.
      const afterSettings = await bound.resolveAll(id);
      const afterCredentials = await bound.resolveCredentials(id);
      const toProbe = await this.#repo.nearestProbe(q, id);

      const moved = await this.#repo.get(q, id);
      if (moved === null) throw notFound(id);

      const movedCount = await this.#repo.countSubtree(q, id);

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.moved',
            objectId: id,
            kind: object.kind,
            fromParentId,
            toParentId: targetParentId,
            movedCount,
            fromProbeId: fromProbe?.id ?? null,
            toProbeId: toProbe?.id ?? null,
          },
        ],
        new Date(),
      );

      return {
        object: this.#redact(moved),
        fromParentId,
        toParentId: targetParentId,
        movedCount,
        probeChanged: fromProbe?.id === toProbe?.id ? null : { from: fromProbe, to: toProbe },
        settingsChanged: diffSettings(beforeSettings, afterSettings),
        credentialsChanged: diffCredentials(beforeCredentials, afterCredentials),
      };
    });
  }

  async clone(actor: Actor, id: ObjectId, input: CloneInput): Promise<CloneResult> {
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeShared(q);

      const source = await this.#repo.get(q, id);
      if (source === null) throw notFound(id);

      if (source.kind === 'root' || source.kind === 'probe') {
        // A probe object binds to a probe installation's GID and access key, so a cloned
        // probe is either a duplicate identity or a placeholder no installation can claim.
        throw new ObjectError('OBJECT_NOT_CLONEABLE', `a ${source.kind} cannot be cloned`, {
          context: { objectId: id, phase: 'clone' },
          details: { kind: source.kind },
        });
      }

      const targetParentId = input.targetParentId ?? source.parentId;
      const target = await this.#repo.get(q, targetParentId);
      if (target === null) throw parentNotFound(targetParentId);
      if (!(await this.#repo.isValidParentKind(q, source.kind, target.kind))) {
        throw parentKindInvalid(source.kind, target.kind);
      }

      const rootName = input.name ?? `Clone of ${source.name}`;
      const copied = await this.#repo.copySubtree(
        q,
        id,
        targetParentId,
        rootName,
        this.#maxCloneObjects,
      );

      const cloneRoot = await this.#repo.get(q, copied.cloneRootId);
      if (cloneRoot === null) throw notFound(copied.cloneRootId);

      const bound = this.#resolver.withExecutor(q);
      const settingsChanged =
        targetParentId === source.parentId
          ? []
          : diffSettings(await bound.resolveAll(id), await bound.resolveAll(cloneRoot.id));

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.cloned',
            objectId: cloneRoot.id,
            kind: cloneRoot.kind,
            sourceId: id,
            clonedCount: copied.counts,
            droppedCredentialKinds: copied.droppedCredentialKinds as CredentialKind[],
          },
        ],
        new Date(),
      );

      return {
        object: this.#redact(cloneRoot),
        clonedCount: copied.counts,
        droppedCredentialKinds: copied.droppedCredentialKinds as CredentialKind[],
        settingsChanged,
      };
    });
  }

  /**
   * Deletes an object, and on a counted confirmation its whole subtree.
   *
   * The exclusive lock is what makes the receipt true: with create and clone holding the
   * shared lock, no object can appear anywhere in the tree between the enumeration and the
   * delete, so nothing is destroyed that the report does not name.
   */
  async delete(
    actor: Actor,
    id: ObjectId,
    expectation: DeleteExpectation,
    pre: Precondition,
  ): Promise<DeleteReport> {
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeExclusive(q);

      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);

      if (object.kind === 'root') {
        throw new ObjectError('OBJECT_NOT_DELETABLE', 'the root object cannot be deleted', {
          context: { objectId: id, phase: 'delete' },
        });
      }
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const { refs, counts } = await this.#repo.enumerateSubtree(q, id);
      const descendants = counts.total - 1;

      if (expectation.kind === 'leafOnly' && descendants > 0) {
        throw new ObjectError(
          'OBJECT_NOT_EMPTY',
          `${object.kind} "${object.name}" contains ${String(descendants)} other objects`,
          {
            context: { objectId: id, kind: object.kind, phase: 'delete' },
            details: {
              deleted: counts,
              retryWith: `DELETE /api/v1/objects/${String(id)}?expectedDescendants=${String(descendants)}`,
            },
          },
        );
      }

      if (expectation.kind === 'exact' && expectation.descendants !== descendants) {
        throw new ObjectError(
          'OBJECT_SUBTREE_CHANGED',
          `the subtree under ${String(id)} now holds ${String(descendants)} other objects, not ${String(expectation.descendants)}`,
          {
            context: { objectId: id, phase: 'delete' },
            details: { expected: expectation.descendants, actual: descendants, deleted: counts },
          },
        );
      }

      // Recorded before the delete and inside the transaction: an audit entry can never exist
      // for a rolled-back delete, and there is no recycle bin, so this enumeration is the only
      // reconstruction path a mistaken delete has.
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.deleted',
            objectId: id,
            kind: object.kind,
            before: this.#redact(object),
            deleted: counts,
            destroyed: refs,
          },
        ],
        new Date(),
      );

      const destroyed = await this.#repo.deleteIds(
        q,
        refs.map((ref) => ref.id),
      );
      if (destroyed.length !== refs.length) {
        // Belt and braces: a mismatch means the enumeration and the delete disagreed, which
        // the lock should make impossible. Roll back rather than return a wrong receipt.
        throw new ObjectError(
          'OBJECT_SUBTREE_CHANGED',
          'the subtree changed while it was being deleted',
          {
            context: { objectId: id, phase: 'delete' },
            details: { expected: refs.length, actual: destroyed.length },
          },
        );
      }

      this.#logger.info({ objectId: id, deleted: counts }, 'subtree deleted');
      return { id, kind: object.kind, name: object.name, deleted: counts, destroyed: refs };
    });
  }

  /**
   * Runs several operations in one transaction under one lock. D-09's contract, proven now so
   * bulk operations become a loop rather than an API redesign.
   */
  async batch<T>(
    mode: 'shared' | 'exclusive',
    fn: (q: Queryable, repo: ObjectRepository) => Promise<T>,
  ): Promise<T> {
    return this.#db.tx(async (q) => {
      if (mode === 'exclusive') await this.#repo.lockTreeExclusive(q);
      else await this.#repo.lockTreeShared(q);
      return fn(q, this.#repo);
    });
  }

  async #attachEffective(
    items: readonly ObjectSummary[],
    keys: readonly string[],
  ): Promise<ObjectSummary[]> {
    const ids = items.map((item) => item.id);
    const byKey = new Map<string, Awaited<ReturnType<InheritanceResolver['resolveForObjects']>>>();
    for (const key of keys) {
      byKey.set(key, await this.#resolver.resolveForObjects(ids, key));
    }

    return items.map((item) => {
      const effective: Record<string, unknown> = {};
      for (const [key, resolved] of byKey) {
        const value = resolved.get(item.id);
        if (value !== undefined) effective[key] = value;
      }
      return { ...item, effective } as ObjectSummary;
    });
  }
}

function parentKindInvalid(childKind: string, parentKind: string): ObjectError {
  return new ObjectError(
    'OBJECT_PARENT_INVALID',
    `a ${childKind} may not be a child of a ${parentKind}`,
    {
      context: { phase: 'validate-hierarchy' },
      details: { childKind, parentKind },
    },
  );
}

function diffSettings(
  before: Record<string, { key: string; value: unknown; source: unknown }>,
  after: Record<string, { key: string; value: unknown; source: unknown }>,
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const [key, beforeValue] of Object.entries(before)) {
    const afterValue = after[key];
    if (afterValue === undefined) continue;
    if (JSON.stringify(beforeValue.value) !== JSON.stringify(afterValue.value)) {
      changes.push({
        key,
        before: beforeValue as SettingChange['before'],
        after: afterValue as SettingChange['after'],
      });
    }
  }
  return changes;
}

/**
 * Credentials are inherited (CAPABILITIES.MD §10), so moving a device out of the group that
 * held its SNMP community silently breaks it. That is the classic support ticket, and the API
 * must not be quiet about it.
 */
function diffCredentials(
  before: readonly ResolvedCredential[],
  after: readonly ResolvedCredential[],
): CredentialChange[] {
  const state = (rows: readonly ResolvedCredential[], kind: CredentialKind) => {
    const row = rows.find((candidate) => candidate.kind === kind);
    if (row === undefined) return 'none' as const;
    return row.source.kind === 'own' ? ('own' as const) : ('inherited' as const);
  };

  const kinds = new Set<CredentialKind>([
    ...before.map((row) => row.kind),
    ...after.map((row) => row.kind),
  ]);

  const changes: CredentialChange[] = [];
  for (const kind of kinds) {
    const from = state(before, kind);
    const to = state(after, kind);
    if (from !== to) changes.push({ kind, before: from, after: to });
  }
  return changes;
}
