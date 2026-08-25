import type { Logger } from '@ms/shared';
import { changedParamKeys } from '../audit/diff.js';
import type { Database, Queryable } from '../db/pool.js';
import type { InheritanceResolver, ResolvedCredential } from '../settings/inheritance.js';
import { settingRegistry, SCHEDULE_ID } from '../settings/registry.js';
import { mergeLimits, validateLimits, type ChannelLimitsPatch } from '../state/limits.js';
import { validateTransform } from '../ingestion/scaling.js';
import { refuseResume, resolvePause, type PauseRequest } from '../state/pause.js';
import { isActiveAt, nextChangeAfter, type ScheduleDefinition } from '../schedules/definition.js';
import { PauseRepository } from './pause-repository.js';
import type { Actor, AuditSink, Mutation } from './audit.js';
import { ObjectError, notFound, parentNotFound } from './errors.js';
import { reorderSiblings } from './ordering.js';
import { versionConflict } from './repository.js';
import type { ObjectRepository } from './repository.js';
import type { SensorTypeGate } from './sensor-type-gate.js';
import type {
  ChannelProcessing,
  ChannelRecord,
  PauseView,
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
  /**
   * What re-decides a sensor's state when a pause changes (`M-08`).
   *
   * Optional so a test about the tree need not build one. Absent, a pause is still written and
   * still stops the probe scanning — the states simply do not move until the next result, which
   * is not a system anyone should run.
   */
  states?: StateReevaluator;
  /**
   * What the pause view asks "is a schedule holding this object" (`M-09`).
   *
   * Read-only and optional: a schedule pauses through `sensor_runtime`, not through
   * `object_pause`, so without this the view would report a sensor as unpaused while its state
   * says Paused. Nothing here writes; `ScheduleSync` owns that.
   */
  schedules?: ScheduleLookup;
  /** Refuses a clone larger than this. Protects the request, not the database. */
  maxCloneObjects?: number;
}

/** Just enough of `ScheduleRepository` for the pause view to name the schedule. */
export interface ScheduleLookup {
  effectiveFor(
    q: Queryable,
    objectId: ObjectId,
  ): Promise<{ scheduleId: number; definedOn: ObjectId } | null>;
  get(
    q: Queryable,
    id: number,
  ): Promise<{ id: number; name: string; definition: ScheduleDefinition } | null>;
}

/** Just enough of `SensorStateService` for a pause to take effect now. */
export interface StateReevaluator {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    cause: { message: string },
  ): Promise<number>;
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
  readonly #pauses = new PauseRepository();
  readonly #states: StateReevaluator | undefined;
  readonly #schedules: ScheduleLookup | undefined;
  readonly #maxCloneObjects: number;

  constructor(options: ObjectServiceOptions) {
    this.#db = options.db;
    this.#repo = options.repository;
    this.#resolver = options.resolver;
    this.#audit = options.audit;
    this.#sensorTypes = options.sensorTypes;
    this.#logger = options.logger.child({ component: 'objects' });
    this.#states = options.states;
    this.#schedules = options.schedules;
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

  /**
   * Changes how a channel is judged: its limits (`M-04`), its lookup (`M-06`), or both.
   *
   * Limits are a patch, not a replacement: `null` clears one threshold and an absent field
   * leaves it alone, so "set the upper error limit" does not silently wipe the warning limit
   * somebody else configured. The merge happens here, against the row read in this transaction,
   * and the result is validated as a whole — a warning limit above an error limit is only
   * nonsense in combination, which is exactly what a field-by-field schema cannot see.
   *
   * The lookup is a replacement, because it is one value: `null` means "judged by limits or by
   * nothing", and a string is an id this installation may or may not have. Whether it does is
   * deliberately **not** checked here — a sensor type can ship ahead of its lookup file, and
   * refusing the configuration would leave the operator unable to write down what they mean.
   * The unresolved id is reported instead, everywhere it shows.
   *
   * `processing` (`M-07`) is a patch again. Changing a scale factor does not rewrite the
   * readings already stored, so a graph steps at the moment of the change — true of every
   * monitoring system, and the alternative is two representations of one measurement.
   */
  async patchChannel(
    actor: Actor,
    id: ObjectId,
    key: string,
    patch: {
      limits?: ChannelLimitsPatch;
      lookupId?: string | null;
      processing?: Partial<ChannelProcessing>;
    },
    pre: Precondition = { kind: 'none' },
  ): Promise<ChannelRecord> {
    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (object.kind !== 'sensor') {
        throw new ObjectError(
          'OBJECT_KIND_MISMATCH',
          `only a sensor has channels; object ${String(id)} is a ${object.kind}`,
          { context: { objectId: id, phase: 'channels' }, details: { storedKind: object.kind } },
        );
      }
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const channel = await this.#repo.channel(q, id, key);
      if (channel === null) {
        throw new ObjectError('OBJECT_NOT_FOUND', `sensor ${String(id)} has no channel "${key}"`, {
          context: { objectId: id, phase: 'channels' },
          details: { channelKey: key },
        });
      }

      const mutations: Mutation[] = [];

      if (patch.limits !== undefined) {
        const before = channel.limits;
        const after = mergeLimits(before, patch.limits);
        const problems = validateLimits(after);
        if (problems.length > 0) {
          throw new ObjectError('OBJECT_INVALID', `these limits contradict each other`, {
            context: { objectId: id, phase: 'channels' },
            details: { channelKey: key, problems },
          });
        }
        await this.#repo.setChannelLimits(q, id, key, after);
        mutations.push({
          action: 'channel.limits.set',
          objectId: id,
          kind: object.kind,
          channelKey: key,
          before,
          after,
        });
      }

      if (patch.processing !== undefined) {
        const before: ChannelProcessing = {
          scaleMul: channel.scaleMul,
          scaleDiv: channel.scaleDiv,
          decimals: channel.decimals,
          spikeMin: channel.spikeMin,
          spikeMax: channel.spikeMax,
        };
        // A patch, like the limits: absent leaves a field alone, `null` clears a bound. The
        // factors have no null — "no scaling" is 1, and the column refuses zero.
        const after: ChannelProcessing = {
          scaleMul: patch.processing.scaleMul ?? before.scaleMul,
          scaleDiv: patch.processing.scaleDiv ?? before.scaleDiv,
          decimals:
            patch.processing.decimals === undefined ? before.decimals : patch.processing.decimals,
          spikeMin:
            patch.processing.spikeMin === undefined ? before.spikeMin : patch.processing.spikeMin,
          spikeMax:
            patch.processing.spikeMax === undefined ? before.spikeMax : patch.processing.spikeMax,
        };
        const problems = validateTransform(
          {
            scaleMul: Number(after.scaleMul),
            scaleDiv: Number(after.scaleDiv),
            spikeMin: after.spikeMin,
            spikeMax: after.spikeMax,
          },
          after.decimals,
        );
        if (problems.length > 0) {
          throw new ObjectError('OBJECT_INVALID', 'these processing settings cannot be applied', {
            context: { objectId: id, phase: 'channels' },
            details: { channelKey: key, problems },
          });
        }
        await this.#repo.setChannelProcessing(q, id, key, after);
        mutations.push({
          action: 'channel.processing.set',
          objectId: id,
          kind: object.kind,
          channelKey: key,
          before,
          after,
        });
      }

      if (patch.lookupId !== undefined && patch.lookupId !== channel.lookupId) {
        await this.#repo.setChannelLookup(q, id, key, patch.lookupId);
        mutations.push({
          action: 'channel.lookup.set',
          objectId: id,
          kind: object.kind,
          channelKey: key,
          before: channel.lookupId,
          after: patch.lookupId,
        });
      }

      if (mutations.length > 0) await this.#audit.record(q, actor, mutations, new Date());

      // Re-read: the channel write fired the trigger that bumps the sensor's version, so the
      // record read before it carries an ETag that is already stale (the trap S-16 documented).
      const updated = await this.#repo.channel(q, id, key);
      if (updated === null) throw notFound(id);
      return updated;
    });
  }

  // ── pause (M-08) ─────────────────────────────────────────────────────────────────────────

  /**
   * Pauses an object and everything beneath it.
   *
   * One transaction does four things, and the order matters: write the pause, recompute the
   * per-sensor flags from it, re-evaluate the sensors whose flags moved, and record the
   * mutation. The audit sink is what tells the probes (`R-04`) and clears the ingestion caches
   * (`M-04`), and it runs inside this transaction too — so a paused sensor's probe stops
   * scanning it and its state says Paused, or neither happens.
   *
   * **Immediately, not at the next scan.** `M-03` could defer a policy change because a policy
   * is a rule about results; a pause is not. An operator pausing a device for maintenance means
   * now, and a sensor that alarmed thirty seconds into a planned outage is the exact failure
   * pausing exists to prevent.
   */
  async pause(
    actor: Actor,
    id: ObjectId,
    request: PauseRequest,
    message = '',
    pre: Precondition = { kind: 'none' },
  ): Promise<PauseView> {
    const now = new Date();
    const resolved = resolvePause(request, message, now);
    if ('problems' in resolved) {
      throw new ObjectError('OBJECT_INVALID', 'this pause cannot be applied', {
        context: { objectId: id, phase: 'pause' },
        details: { problems: resolved.problems },
      });
    }

    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }
      if (object.kind === 'root') {
        // Pausing the root is pausing the installation. It would work, and it is the kind of
        // thing somebody does by accident with a wildcard and cannot explain afterwards.
        throw new ObjectError('OBJECT_NOT_MOVABLE', 'the root cannot be paused', {
          context: { objectId: id, phase: 'pause' },
        });
      }

      await this.#pauses.pause(q, id, resolved.pause, actor);
      const affected = await this.#pauses.recompute(q, id, now);
      const changed = await this.#states?.reevaluate(q, affected, now, { message });

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.paused',
            objectId: id,
            kind: object.kind,
            until: resolved.pause.pausedUntil,
            message,
            sensorsAffected: changed ?? affected.length,
          },
        ],
        now,
      );

      return this.#pauseView(q, id, now);
    });
  }

  /**
   * Resumes an object.
   *
   * Only the object that was *directly* paused can be resumed (`WORKFLOW.MD §5`). A sensor
   * paused because its device is paused has nothing of its own to clear, and a resume that
   * quietly did nothing would leave an operator believing monitoring is back when it is not —
   * so it is refused, and the refusal names the object to resume instead.
   */
  async resume(
    actor: Actor,
    id: ObjectId,
    pre: Precondition = { kind: 'none' },
  ): Promise<PauseView> {
    const now = new Date();
    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const effective = await this.#pauses.effective(q, id, now);
      const refusal = refuseResume(effective.own !== null, effective.inherited);
      if (refusal !== null) {
        throw new ObjectError('OBJECT_NOT_PAUSED', refusal.reason, {
          context: { objectId: id, phase: 'pause' },
          details: refusal.details,
        });
      }

      await this.#pauses.resume(q, id);
      const affected = await this.#pauses.recompute(q, id, now);
      const changed = await this.#states?.reevaluate(q, affected, now, { message: '' });

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.resumed',
            objectId: id,
            kind: object.kind,
            sensorsAffected: changed ?? affected.length,
          },
        ],
        now,
      );

      return this.#pauseView(q, id, now);
    });
  }

  /**
   * Clears the pauses whose deadline has passed (`M-08`).
   *
   * A timed pause has to be *noticed* by something. Whether it is still in force is computed
   * from the clock, so every read is already correct — but the transition to Unknown, the entry
   * in the log, and the configuration that tells a probe to start scanning again are all writes,
   * and nothing writes itself. Hence a sweep.
   *
   * Deliberately not a timer per pause: a process holding five thousand timers loses all of them
   * on a restart, and a pause that outlives the core is the normal case rather than the
   * exception. One periodic query over an index of the pauses that have a deadline at all costs
   * nothing and cannot drift.
   */
  async expirePauses(limit = 200): Promise<{ expired: ObjectId[]; sensorsAffected: number }> {
    const now = new Date();
    const actor: Actor = { kind: 'system', component: 'pause-expiry' };

    return this.#db.tx(async (q) => {
      const due = await this.#pauses.expired(q, now, limit);
      if (due.length === 0) return { expired: [], sensorsAffected: 0 };

      const expired: ObjectId[] = [];
      const mutations: Mutation[] = [];
      let sensorsAffected = 0;

      for (const pause of due) {
        const object = await this.#repo.get(q, pause.objectId);
        // Deleted between the read and here. The row went with it, by cascade.
        if (object === null) continue;

        await this.#pauses.resume(q, pause.objectId);
        // Recomputed after the delete, so a sensor still held by another pause stays paused —
        // the whole reason the flags are derived rather than toggled.
        const affected = await this.#pauses.recompute(q, pause.objectId, now);
        sensorsAffected += (await this.#states?.reevaluate(q, affected, now, { message: '' })) ?? 0;

        expired.push(pause.objectId);
        mutations.push({
          action: 'object.resumed',
          objectId: pause.objectId,
          kind: object.kind,
          sensorsAffected: affected.length,
        });
      }

      if (mutations.length > 0) await this.#audit.record(q, actor, mutations, now);
      return { expired, sensorsAffected };
    });
  }

  /** Why this object is paused, and whether this is the one to resume. */
  async pauseState(id: ObjectId): Promise<PauseView> {
    const now = new Date();
    const object = await this.#repo.get(this.#db, id);
    if (object === null) throw notFound(id);
    return this.#pauseView(this.#db, id, now);
  }

  async #pauseView(q: Queryable, id: ObjectId, now: Date): Promise<PauseView> {
    const effective = await this.#pauses.effective(q, id, now);
    const own = effective.own;
    const schedule = await this.#scheduleView(q, id, now);
    const scheduleHolds = schedule !== null && !schedule.active;
    return {
      objectId: id,
      paused: own !== null || effective.inherited !== null || scheduleHolds,
      // Only an own pause can be lifted here; everything else points at the object that can.
      resumable: own !== null,
      // In the order §5 evaluates the sources — parent, dependency, schedule, manual — not in
      // the order they are convenient to test. Reporting the manual pause on an object whose
      // parent is also paused would name the one source a resume cannot lift.
      source:
        effective.inherited !== null
          ? 'parent'
          : scheduleHolds
            ? 'schedule'
            : own !== null
              ? 'manual'
              : null,
      pausedAt: own?.pausedAt.toISOString() ?? null,
      pausedUntil: own?.pausedUntil?.toISOString() ?? null,
      // The reason, wherever it lives: an operator looking at a cascaded sensor is asking why,
      // and the answer is on the object holding it.
      message: own?.message ?? effective.inherited?.message ?? '',
      actor: own === null ? null : { kind: own.actor.kind, label: own.actor.label },
      inheritedFrom:
        effective.inherited === null
          ? null
          : { objectId: effective.inherited.objectId, name: effective.inherited.name },
      schedule,
    };
  }

  /** The schedule in effect on an object, evaluated against the same clock as the pause. */
  async #scheduleView(q: Queryable, id: ObjectId, now: Date): Promise<PauseView['schedule']> {
    if (this.#schedules === undefined) return null;
    const assignment = await this.#schedules.effectiveFor(q, id);
    if (assignment === null) return null;
    const schedule = await this.#schedules.get(q, assignment.scheduleId);
    // An assignment pointing at a deleted schedule. The delete path refuses while anything
    // references it, so this is a hand-edited row — reported as no schedule rather than as a
    // crash, because the sensors under it are not paused either.
    if (schedule === null) return null;
    return {
      id: schedule.id,
      name: schedule.name,
      active: isActiveAt(schedule.definition, now),
      nextChangeAt: nextChangeAfter(schedule.definition, now)?.toISOString() ?? null,
      definedOn: assignment.definedOn,
    };
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

      // A schedule id is the one setting whose value names a row in another table, and jsonb
      // carries no foreign key. An id that resolves to nothing is a silent "never paused" —
      // the assignment looks set, the UI shows a schedule, and monitoring never stops — so it
      // is refused here rather than discovered when a maintenance window does not happen.
      if (key === SCHEDULE_ID.key && typeof value === 'number' && this.#schedules !== undefined) {
        if ((await this.#schedules.get(q, value)) === null) {
          throw new ObjectError('OBJECT_INVALID', `no schedule ${String(value)}`, {
            context: { objectId: id, phase: 'settings' },
            details: { key, scheduleId: value },
          });
        }
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

      // A sensor created under a paused device is paused from its first moment (M-08). Without
      // this it would scan, alarm and record readings inside a maintenance window nobody
      // reopened — and the operator who paused the device did so before it existed.
      //
      // Guarded, because provisioning is a hot path and this is not: `recompute` is two
      // recursive CTEs whose *planning* is not free even for a subtree of one new object, and
      // paying it five thousand times is what `P-04`'s budget notices. If nothing anywhere is
      // paused, nothing can cascade, and `anyActive` is a LIMIT 1 over a table that is empty in
      // almost every installation.
      const now = new Date();
      if (await this.#pauses.anyActive(q, now)) {
        const affected = await this.#pauses.recompute(q, created.id, now);
        await this.#states?.reevaluate(q, affected, now, {
          message: 'created under a paused parent',
        });
      }

      const safe = this.#redact(created);
      await this.#audit.record(
        q,
        actor,
        [{ action: 'object.created', objectId: safe.id, kind: safe.kind, after: safe }],
        now,
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

      // The subtree hangs somewhere else now, so which pauses reach it has changed: out from
      // under a paused group, or into one. Recomputed for the whole moved subtree, because a
      // move is the one operation that changes the answer without touching any pause.
      // Guarded by the same reasoning as the create path.
      const movedAt = new Date();
      if (await this.#pauses.anyActive(q, movedAt)) {
        const affected = await this.#pauses.recompute(q, id, movedAt);
        await this.#states?.reevaluate(q, affected, movedAt, {
          message: 'moved under a paused parent',
        });
      }

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

      // S-03: a clone arrives manually paused. It carries its source's configuration and none
      // of its credentials, so scanning immediately would mean a burst of authentication
      // failures on a device an operator has not finished setting up — and the message says
      // which object to compare it against.
      const clonedAt = new Date();
      await this.#pauses.pause(
        q,
        cloneRoot.id,
        {
          pausedAt: clonedAt,
          pausedUntil: null,
          message: `cloned from #${String(id)}`,
        },
        actor,
      );
      const clonedSensors = await this.#pauses.recompute(q, cloneRoot.id, clonedAt);
      await this.#states?.reevaluate(q, clonedSensors, clonedAt, {
        message: `cloned from #${String(id)}`,
      });

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
