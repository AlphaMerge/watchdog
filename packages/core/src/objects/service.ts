import type { Logger } from '@ms/shared';
import { changedParamKeys } from '../audit/diff.js';
import type { Database, Queryable } from '../db/pool.js';
import type { InheritanceResolver, ResolvedCredential } from '../settings/inheritance.js';
import {
  settingRegistry,
  DEPENDENCY_DELAY_SECONDS,
  DEPENDENCY_MASTER_ID,
  SCHEDULE_ID,
} from '../settings/registry.js';
import { resolveDependencyMode, type DependencyMode } from '../dependencies/mode.js';
import { mergeLimits, validateLimits, type ChannelLimitsPatch } from '../state/limits.js';
import { validateTransform } from '../ingestion/scaling.js';
import { refuseResume, resolvePause, type PauseRequest } from '../state/pause.js';
import {
  resolveAcknowledgement,
  type AcknowledgeRequest,
  type ResolvedAcknowledgement,
} from '../state/acknowledgement.js';
import { downSensorsIn, sensorsIn } from '../state/runtime.js';
import { isActiveAt, nextChangeAfter, type ScheduleDefinition } from '../schedules/definition.js';
import { PauseRepository, flattenActor, type PauseCursor } from './pause-repository.js';
import type { Actor, AuditSink, Mutation } from './audit.js';
import { ObjectError, notFound, parentNotFound } from './errors.js';
import { reorderSiblings } from './ordering.js';
import { planTree, type TreeNodeInput, type TreePlanInput } from './tree-plan.js';
import { versionConflict } from './repository.js';
import type { ObjectRepository } from './repository.js';
import type { CredentialVault } from '../vault/service.js';
import type { ChannelDraft, SensorTypeGate } from './sensor-type-gate.js';
import type { SensorStateCause } from '../state/tables.js';
import type {
  AcknowledgementView,
  SimulatedErrorView,
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
  ObjectKind,
  ObjectRef,
  ObjectSummary,
  Page,
  PageRequest,
  Precondition,
  SettingChange,
  SettingView,
  SiblingMove,
  SubtreeCounts,
  SubtreeOptions,
  SubtreeResult,
  UpdateObjectInput,
} from './types.js';

/**
 * The causes the pause API is entitled to speak for (`P-140`).
 *
 * `P-94` gave `reevaluate` a `sources` parameter — which causes a caller may supply words for —
 * and taught the schedule sweep to use it. The pause API, the other operator-facing caller, was
 * never given one, and an absent `sources` means *every* cause: so an operator's words could be
 * written as the reason for a schedule's or a dependency's pause.
 *
 * Both `user` and `parent`, because one call produces both: pausing a group reports `parent` on
 * every sensor beneath it, and the group's message is exactly the right thing to show there.
 *
 * **Stated plainly: this is a fix by symmetry, and it ships without a test that fails without
 * it.** Every sequence tried reaches the higher-precedence pause *through* a re-evaluation that
 * already sets the state, so the later manual pause decides the same state and cause and writes
 * nothing at all. The asymmetry with `P-94` is real and the parameter costs nothing; a scenario
 * that distinguishes the two is not one this exercise could construct, and inventing a test that
 * passes either way would be worse than saying so.
 */
const PAUSE_CAUSES_THIS_API_OWNS = ['user', 'parent'] as const;

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
  /**
   * What the pause view asks "is a master holding this object", and what refuses an assignment
   * that would close a loop (`M-11`).
   */
  dependencies?: DependencyLookup;
  /** What releases a dependency's recovery delay when it runs out (`M-11`). */
  dependencyDelays?: ReleasesDependencyDelays;
  /**
   * The credential vault (`A-05`).
   *
   * Optional so a test about the tree need not build a keyring. Absent, the credential *read*
   * still works — it has only ever returned metadata — and a write is refused with a sentence
   * rather than silently storing a secret in the clear.
   */
  vault?: CredentialVault;
  /** Refuses a clone larger than this. Protects the request, not the database. */
  maxCloneObjects?: number;
}

/** Just enough of `DependencyPauses` for the pause sweep to release an elapsed delay. */
export interface ReleasesDependencyDelays {
  releaseElapsed(q: Queryable, now: Date, limit?: number): Promise<{ moved: number }>;
}

/** Just enough of `DependencyRepository` for the object service's two questions. */
export interface DependencyLookup {
  effectiveFor(
    q: Queryable,
    objectId: ObjectId,
  ): Promise<{ masterId: number; definedOn: ObjectId } | null>;
  stateOf(
    q: Queryable,
    sensorId: number,
    now: Date,
  ): Promise<{ sensorId: number; state: string; clearAt: Date | null } | null>;
  wouldCycle(
    q: Queryable,
    objectId: ObjectId,
    masterId: ObjectId,
  ): Promise<{ path: number[] } | null>;
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

/** Just enough of `SensorStateService` for a pause or an acknowledgement to take effect now. */
export interface StateReevaluator {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    /**
     * `sources` names the causes this caller may supply words for (`P-94`, `P-140`). Absent means
     * "every cause", which is what let a manual pause write its message under a schedule's.
     */
    cause: { message: string; sources?: readonly SensorStateCause[] },
  ): Promise<number>;
  acknowledge(
    q: Queryable,
    sensorIds: readonly number[],
    acknowledgement: ResolvedAcknowledgement | null,
    actor: { kind: string; label: string | null },
    at: Date,
  ): Promise<{ acknowledged: number[]; refused: number[]; transitions: number }>;
  simulate(
    q: Queryable,
    sensorIds: readonly number[],
    simulated: boolean,
    message: string,
    at: Date,
  ): Promise<{ changed: number[]; transitions: number }>;
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
  readonly #dependencies: DependencyLookup | undefined;
  readonly #dependencyDelays: ReleasesDependencyDelays | undefined;
  readonly #vault: CredentialVault | undefined;
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
    this.#dependencies = options.dependencies;
    this.#dependencyDelays = options.dependencyDelays;
    this.#vault = options.vault;
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

  /**
   * What `subtree` would have counted, without the rows and without the cap (`U-14`).
   *
   * A caller that wants totals asks for totals. Reading a page of the tree and counting it is
   * how an overview came to claim 930 sensors on a system running five thousand.
   */
  async counts(id: ObjectId): Promise<SubtreeCounts> {
    await this.get(id);
    return this.#repo.subtreeCounts(this.#db, id);
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
      // **`sources`, or these words are written under somebody else's cause** (`P-140`).
      // `P-94` gave the re-evaluation this parameter and taught the schedule sweep to use it;
      // the pause API, which is the other operator-facing caller, was never given it. Without it
      // this caller speaks for every cause — so pausing a sensor a *schedule* was already holding
      // recorded "replacing the PSU" as the reason it was outside its window, on a sensor whose
      // reported cause was `schedule`. The pause and the words disagreed, in the state history,
      // for ever.
      const changed = await this.#states?.reevaluate(q, affected, now, {
        message,
        sources: PAUSE_CAUSES_THIS_API_OWNS,
      });

      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'object.paused',
            objectId: id,
            kind: object.kind,
            from: resolved.pause.startsAt,
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
      // The refusal names whichever source is actually holding it, not just the ones that are
      // rows in `object_pause` — an object held by a schedule or a dependency told "this object
      // is not paused" is both wrong and the least useful thing to say (`M-12`).
      const schedule = await this.#scheduleView(q, id, now);
      const dependency = await this.#dependencyView(q, id, now);
      const refusal = refuseResume(effective.own !== null, effective.inherited, {
        schedule:
          schedule === null || schedule.active
            ? null
            : {
                scheduleId: schedule.id,
                name: schedule.name,
                nextChangeAt: schedule.nextChangeAt,
                definedOn: schedule.definedOn,
              },
        dependency:
          dependency === null || !dependency.holding
            ? null
            : {
                masterId: dependency.masterId,
                masterName: dependency.masterName,
                definedOn: dependency.definedOn,
              },
      });
      if (refusal !== null) {
        throw new ObjectError('OBJECT_NOT_PAUSED', refusal.reason, {
          context: { objectId: id, phase: 'pause' },
          details: refusal.details,
        });
      }

      await this.#pauses.resume(q, id);
      const affected = await this.#pauses.recompute(q, id, now);
      // An empty message belongs to the manual pause that has just gone; another source still
      // holding this sensor keeps its own words (`P-140`).
      const changed = await this.#states?.reevaluate(q, affected, now, {
        message: '',
        sources: PAUSE_CAUSES_THIS_API_OWNS,
      });

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
   * Opens the maintenance windows that have come round and clears the pauses that have run out
   * (`M-08`, `M-10`).
   *
   * A pause with a time on it has to be *noticed* by something. Whether it is in force is
   * computed from the clock, so every read is already correct — but the transition, the entry in
   * the log, and the configuration that tells a probe to start or stop scanning are all writes,
   * and nothing writes itself. Hence a sweep, at both ends.
   *
   * Deliberately not a timer per pause: a process holding five thousand timers loses all of them
   * on a restart, and a pause that outlives the core is the normal case rather than the
   * exception. Two indexed queries over the rows that have a boundary at all cost nothing and
   * cannot drift.
   *
   * `since` is the previous sweep. Passing the epoch — which the sweep does on its first pass
   * after a restart — reconciles every window that opened while the core was down, without a
   * "have I applied this yet" column that could disagree with the rows it describes.
   */
  async sweepPauses(
    since: PauseCursor,
    limit = 200,
  ): Promise<{
    expired: ObjectId[];
    started: ObjectId[];
    released: number;
    sensorsAffected: number;
    /**
     * How far the caller may advance its watermark (`P-95`).
     *
     * Null when the opening page was not full, meaning everything up to `now` was seen. When it
     * *was* full there is more beyond the limit, and the caller must resume from inside the
     * window rather than skipping to now — `started` cannot answer this, because it holds only
     * the windows that actually moved a flag.
     */
    startedThrough: PauseCursor | null;
  }> {
    const now = new Date();
    const actor: Actor = { kind: 'system', component: 'pause-sweep' };

    return this.#db.tx(async (q) => {
      const due = await this.#pauses.expired(q, now, limit);
      const page = await this.#pauses.startedIn(q, since, now, limit);
      const opening = page.pauses;
      // A dependency's recovery delay is a deadline like any other, so it is swept here rather
      // than by a third timer. A delay of zero never reaches this: it is released in the
      // transaction that recorded the master's recovery (`M-11`).
      const released = (await this.#dependencyDelays?.releaseElapsed(q, now, limit))?.moved ?? 0;
      // A full page means the limit truncated it, so the caller resumes from where this one
      // stopped rather than skipping past everything it did not see. `started` cannot answer
      // this — it holds only the windows that actually moved a flag — and the cursor is the
      // keyset `startedIn` orders by, so nothing sharing the boundary instant is lost.
      const startedThrough = opening.length < limit ? null : page.last;

      if (due.length === 0 && opening.length === 0) {
        return { expired: [], started: [], released, sensorsAffected: 0, startedThrough };
      }

      const expired: ObjectId[] = [];
      const started: ObjectId[] = [];
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
        sensorsAffected +=
          (await this.#states?.reevaluate(q, affected, now, {
            message: '',
            sources: PAUSE_CAUSES_THIS_API_OWNS,
          })) ?? 0;

        expired.push(pause.objectId);
        mutations.push({
          action: 'object.resumed',
          objectId: pause.objectId,
          kind: object.kind,
          sensorsAffected: affected.length,
        });
      }

      for (const pause of opening) {
        const object = await this.#repo.get(q, pause.objectId);
        if (object === null) continue;

        // One recompute per window rather than one for the whole tree, so the state history
        // carries *this* window's message. "Quarterly patching" is what an operator reads on
        // the sensor; a batched recompute could only have said nothing.
        const affected = await this.#pauses.recompute(q, pause.objectId, now);
        if (affected.length === 0) continue;
        const changed =
          (await this.#states?.reevaluate(q, affected, now, {
            message: pause.message,
            sources: PAUSE_CAUSES_THIS_API_OWNS,
          })) ?? 0;
        sensorsAffected += changed;

        started.push(pause.objectId);
        mutations.push({
          action: 'object.paused',
          objectId: pause.objectId,
          kind: object.kind,
          from: pause.startsAt,
          until: pause.pausedUntil,
          message: pause.message,
          sensorsAffected: changed,
        });
      }

      if (mutations.length > 0) await this.#audit.record(q, actor, mutations, now);
      return { expired, started, released, sensorsAffected, startedThrough };
    });
  }

  /**
   * Sets an object's dependency in one call (`M-11`).
   *
   * The three modes of `WORKFLOW.MD §5` are three places to write one setting, and *master
   * object for parent device* writes it on a different object from the one the request names —
   * which the generic settings endpoint cannot express. Everything else goes through
   * `setSetting`, so the validation, the audit entry and the recompute are the same ones.
   */
  async setDependency(
    actor: Actor,
    id: ObjectId,
    mode: DependencyMode,
    masterId: ObjectId | undefined,
    delaySeconds: number | undefined,
    pre: Precondition = { kind: 'none' },
  ): Promise<PauseView> {
    const subject = await this.#repo.get(this.#db, id);
    if (subject === null) throw notFound(id);
    const parent =
      subject.parentId === null ? null : await this.#repo.get(this.#db, subject.parentId);

    const resolved = resolveDependencyMode(
      mode,
      {
        id,
        kind: subject.kind,
        parentId: subject.parentId,
        parentKind: parent?.kind ?? null,
      },
      masterId,
    );
    if ('problems' in resolved) {
      throw new ObjectError('OBJECT_INVALID', 'this dependency cannot be set', {
        context: { objectId: id, phase: 'dependency' },
        details: { problems: resolved.problems },
      });
    }

    // Leaving "master object for parent device" has to undo what entering it did, or the mode
    // is a one-way door: the setting lives on the device, so clearing the sensor's own value
    // would leave it master of a device it no longer claims to be. A single dropdown that
    // cannot be changed back is worse than not offering the mode.
    // A sensor's parent is always a device; the hierarchy trigger enforces it, and the type
    // knows, so there is nothing to check for null here.
    if (mode !== 'device' && subject.kind === 'sensor') {
      const parentOwn = await this.#resolver.own(subject.parentId);
      if (parentOwn[DEPENDENCY_MASTER_ID.key] === id) {
        await this.clearSetting(actor, subject.parentId, DEPENDENCY_MASTER_ID.key);
      }
    }

    const { targetId, masterId: value } = resolved.write;
    if (value === undefined) {
      await this.clearSetting(actor, targetId, DEPENDENCY_MASTER_ID.key, pre);
    } else {
      await this.setSetting(actor, targetId, DEPENDENCY_MASTER_ID.key, value, pre);
    }
    if (delaySeconds !== undefined) {
      // On the object that carries the dependency, not the one the request named — otherwise a
      // delay set alongside "master object for parent device" would land on the sensor and be
      // inherited by nothing.
      await this.setSetting(actor, targetId, DEPENDENCY_DELAY_SECONDS.key, delaySeconds);
    }
    return this.pauseState(id);
  }

  // ── simulated error (M-14) ───────────────────────────────────────────────────────────────

  /**
   * Forces sensors Down to test a notification chain end to end (`M-14`).
   *
   * **This pages real people.** That is the point — a chain nobody has ever seen fire is a chain
   * nobody knows works — but it is also why it is audited, why the message becomes the sensor's
   * last message, and why the state reads with cause `simulated` rather than `scan`: a forced
   * Down must never be mistakable for a real one, in the UI or in the log.
   *
   * On a sensor, or on anything above one, in which case **every** sensor beneath it is forced —
   * not only those that are Down, because forcing a Down is not a statement about the current
   * state. `M-17`'s alarm-storm scenario is what wants the subtree form.
   *
   * Deliberately without a deadline, unlike a pause or an acknowledgement. Those need one
   * because a forgotten pause looks exactly like a healthy sensor; a forgotten simulated error
   * looks like a screaming one, with `simulated` written on it in three places. The thing that
   * makes it safe is that it is loud, not that it expires.
   */
  async simulateError(
    actor: Actor,
    id: ObjectId,
    simulated: boolean,
    message = '',
  ): Promise<SimulatedErrorView> {
    const now = new Date();
    const states = this.#states;
    if (states === undefined) {
      throw new ObjectError('OBJECT_INVALID', 'this installation decides no sensor states', {
        context: { objectId: id, phase: 'simulate' },
      });
    }

    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);

      const targets = object.kind === 'sensor' ? [id] : await sensorsIn(q, id);
      if (targets.length === 0) {
        throw new ObjectError('OBJECT_INVALID', 'there are no sensors here to force', {
          context: { objectId: id, phase: 'simulate' },
        });
      }

      const result = await states.simulate(q, targets, simulated, message, now);
      if (result.changed.length > 0) {
        await this.#audit.record(
          q,
          actor,
          [
            {
              action: 'sensor.simulatedError',
              objectId: id,
              kind: object.kind,
              simulated,
              message,
              sensorsAffected: result.changed.length,
            },
          ],
          now,
        );
        this.#logger.warn(
          { objectId: id, simulated, sensors: result.changed.length },
          simulated
            ? 'sensors forced Down to test a notification chain'
            : 'simulated errors cleared',
        );
      }

      return {
        objectId: id,
        simulated,
        sensors: result.changed,
        message,
      };
    });
  }

  // ── acknowledgement (M-13) ───────────────────────────────────────────────────────────────

  /**
   * Acknowledges an alarm, suppressing its notifications without touching its monitoring.
   *
   * **On a sensor, or on anything above one.** Nobody wants to acknowledge forty alarms one at a
   * time when a switch fails, so acknowledging a device or a group covers every sensor beneath
   * it that is Down *at that moment*. A snapshot rather than a rule: a sensor that fails an hour
   * later is a new alarm nobody has looked at, and silencing it would be the opposite of what
   * was meant.
   *
   * Refused when nothing under the object is Down. §2.4 applies the layer only to `down`, so an
   * acknowledgement written anywhere else would sit silently and suppress the next outage.
   */
  async acknowledge(
    actor: Actor,
    id: ObjectId,
    request: AcknowledgeRequest,
    message = '',
  ): Promise<AcknowledgementView> {
    const now = new Date();
    const resolved = resolveAcknowledgement(request, message, now);
    if ('problems' in resolved) {
      throw new ObjectError('OBJECT_INVALID', 'this acknowledgement cannot be applied', {
        context: { objectId: id, phase: 'acknowledge' },
        details: { problems: resolved.problems },
      });
    }
    return this.#applyAcknowledgement(actor, id, resolved.acknowledgement, now);
  }

  /**
   * Withdraws an acknowledgement.
   *
   * Not in `CAPABILITIES.MD §5.3`, which lists only the three things that clear one on their own
   * — recovery, expiry and pause-then-resume. None of those is "I acknowledged the wrong
   * sensor", and pause-then-resume as the only undo costs the sensor its failure count and
   * leaves it Unknown, which is a worse outcome than the mistake. One call, the same write path,
   * and the audit log records both halves.
   */
  async clearAcknowledgement(actor: Actor, id: ObjectId): Promise<AcknowledgementView> {
    return this.#applyAcknowledgement(actor, id, null, new Date());
  }

  async #applyAcknowledgement(
    actor: Actor,
    id: ObjectId,
    acknowledgement: ResolvedAcknowledgement | null,
    now: Date,
  ): Promise<AcknowledgementView> {
    const states = this.#states;
    if (states === undefined) {
      throw new ObjectError('OBJECT_INVALID', 'this installation decides no sensor states', {
        context: { objectId: id, phase: 'acknowledge' },
      });
    }

    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);

      const targets = object.kind === 'sensor' ? [id] : await downSensorsIn(q, id);
      if (targets.length === 0) {
        throw new ObjectError(
          'OBJECT_NOT_PAUSED',
          acknowledgement === null
            ? 'nothing here has an acknowledgement to clear'
            : 'nothing here is Down to acknowledge',
          { context: { objectId: id, phase: 'acknowledge' } },
        );
      }

      const who = flattenActor(actor);
      const result = await states.acknowledge(q, targets, acknowledgement, who, now);
      if (result.acknowledged.length === 0) {
        throw new ObjectError(
          'OBJECT_NOT_PAUSED',
          'only a Down sensor can be acknowledged; this one is not',
          {
            context: { objectId: id, phase: 'acknowledge' },
            details: { refused: result.refused },
          },
        );
      }

      await this.#audit.record(
        q,
        actor,
        [
          acknowledgement === null
            ? {
                action: 'sensor.acknowledgementCleared',
                objectId: id,
                kind: object.kind,
                sensorsAffected: result.acknowledged.length,
              }
            : {
                action: 'sensor.acknowledged',
                objectId: id,
                kind: object.kind,
                until: acknowledgement.acknowledgedUntil,
                message: acknowledgement.message,
                sensorsAffected: result.acknowledged.length,
              },
        ],
        now,
      );

      return {
        objectId: id,
        acknowledged: result.acknowledged,
        refused: result.refused,
        acknowledgedAt: acknowledgement?.acknowledgedAt.toISOString() ?? null,
        acknowledgedUntil: acknowledgement?.acknowledgedUntil?.toISOString() ?? null,
        message: acknowledgement?.message ?? '',
      };
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
    const dependency = await this.#dependencyView(q, id, now);
    const dependencyHolds = dependency !== null && dependency.holding;
    return {
      objectId: id,
      paused:
        effective.ownActive || effective.inherited !== null || scheduleHolds || dependencyHolds,
      // A scheduled maintenance window counts: cancelling one before it starts is the same
      // action as ending one that has, and an operator who picked the wrong weekend should not
      // have to wait for it to begin (`M-10`).
      pending: own !== null && !effective.ownActive,
      // Only an own pause can be lifted here; everything else points at the object that can.
      resumable: own !== null,
      // In the order §5 evaluates the sources — parent, dependency, schedule, manual — not in
      // the order they are convenient to test. Reporting the manual pause on an object whose
      // parent is also paused would name the one source a resume cannot lift.
      source:
        effective.inherited !== null
          ? 'parent'
          : dependencyHolds
            ? 'dependency'
            : scheduleHolds
              ? 'schedule'
              : effective.ownActive
                ? 'manual'
                : null,
      pausedAt: own?.pausedAt.toISOString() ?? null,
      startsAt: own?.startsAt.toISOString() ?? null,
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
      dependency,
    };
  }

  /** The master in effect on an object, and whether it is holding it right now. */
  async #dependencyView(q: Queryable, id: ObjectId, now: Date): Promise<PauseView['dependency']> {
    if (this.#dependencies === undefined) return null;
    const assignment = await this.#dependencies.effectiveFor(q, id);
    if (assignment === null) return null;
    const master = await this.#dependencies.stateOf(q, assignment.masterId, now);
    // An assignment pointing at something with no runtime row: deleted, or never a sensor. The
    // dependents are not paused either, so reporting no dependency is the honest answer.
    if (master === null) return null;
    const names = await this.#repo.get(q, assignment.masterId);
    return {
      masterId: assignment.masterId,
      masterName: names?.name ?? '',
      masterState: master.state,
      // A master never holds itself; that exclusion is what keeps it scanning.
      holding:
        assignment.masterId !== id &&
        (master.state === 'down' ||
          master.state === 'down_acknowledged' ||
          (master.clearAt !== null && master.clearAt.getTime() > now.getTime())),
      releasesAt: master.clearAt?.toISOString() ?? null,
      definedOn: assignment.definedOn,
    };
  }

  /**
   * Refuses a master that does not exist, is not a sensor, or would close a loop (`M-11`).
   *
   * The loop is the one that matters. If A's master is B and B's master is A, whichever goes
   * Down first pauses the other; the paused one stops scanning, so it can never recover, and
   * neither can the first. That is a permanent outage produced by two dropdown selections, with
   * nothing in the system able to notice it — so it is refused where it is made rather than
   * detected where it bites.
   */
  async #assertUsableMaster(q: Queryable, id: ObjectId, masterId: number): Promise<void> {
    if (masterId === id) {
      throw new ObjectError('OBJECT_INVALID', 'an object cannot depend on itself', {
        context: { objectId: id, phase: 'settings' },
        details: { key: DEPENDENCY_MASTER_ID.key },
      });
    }
    const master = await this.#repo.get(q, masterId);
    if (master === null) {
      throw new ObjectError('OBJECT_INVALID', `no object ${String(masterId)} to depend on`, {
        context: { objectId: id, phase: 'settings' },
        details: { key: DEPENDENCY_MASTER_ID.key, masterId },
      });
    }
    if (master.kind !== 'sensor') {
      // Devices and groups have no state of their own — M-02 put state on sensors — so "the
      // device is Down" is not a fact anything could read yet. Refusing is honest; accepting
      // would create a dependency that silently never fires.
      throw new ObjectError(
        'OBJECT_INVALID',
        `a master must be a sensor; #${String(masterId)} is a ${master.kind}`,
        {
          context: { objectId: id, phase: 'settings' },
          details: { key: DEPENDENCY_MASTER_ID.key, masterId, masterKind: master.kind },
        },
      );
    }
    const cycle = await this.#dependencies?.wouldCycle(q, id, masterId);
    if (cycle != null) {
      throw new ObjectError(
        'OBJECT_CYCLE',
        'that dependency would form a loop, and a loop of masters can never recover',
        {
          context: { objectId: id, phase: 'settings' },
          details: { key: DEPENDENCY_MASTER_ID.key, masterId, path: cycle.path },
        },
      );
    }
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

    // What a revert would restore: resolved at the parent, because inheritance is
    // nearest-ancestor and discarding the local value removes this object from the walk. The
    // root has no parent and falls through to the registry default. One extra resolve, and only
    // when there is a parent to resolve at — a UI cannot compute this from `effective` alone,
    // and asking it to would mean telling an operator what reverting does by doing it.
    const from = asChildOf ?? object.parentId;
    const above = from === null ? {} : await this.#resolver.resolveAll(from);

    return settingRegistry.definitions().map((definition) => {
      const resolved = effective[definition.key];
      const parent = above[definition.key];
      return {
        key: definition.key,
        description: definition.description,
        schema: definition.schema,
        effective: {
          value: resolved?.value ?? definition.default,
          source: resolved?.source ?? { kind: 'default' },
        },
        inherited: {
          value: parent?.value ?? definition.default,
          source: parent?.source ?? { kind: 'default' },
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

  /**
   * The credential kinds this build can store, with the schema a form is built from.
   *
   * Empty without a vault, rather than a refusal: a UI asking what it can offer should be told
   * "nothing" and hide the section, not shown an error on a page about something else.
   */
  credentialKinds(): readonly { id: string; name: string; description: string; schema: unknown }[] {
    return this.#vault?.kinds() ?? [];
  }

  // ── credential writes (`A-05`) ───────────────────────────────────────────────────────────

  /**
   * Stores or replaces a credential set on one object.
   *
   * **The response says what changed, never what it changed to.** The summary carries the field
   * *names* that were set and the public parameters; there is no shape in it a secret could
   * occupy, which is the same reason `CredentialView` has none. That holds for the audit entry
   * too — `credential.set` records that a community string was replaced and by whom, and an
   * entry that recorded the value would be a permanent plaintext copy of every credential this
   * installation has ever held, readable through the history API.
   */
  async setCredential(
    actor: Actor,
    id: ObjectId,
    kind: string,
    values: Readonly<Record<string, unknown>>,
    pre: Precondition = { kind: 'none' },
  ): Promise<CredentialView> {
    const vault = this.#requireVault();
    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const summary = await vault.write(q, id, kind, values);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'credential.set',
            objectId: id,
            credentialKind: kind,
            created: summary.created,
            secretsSet: summary.secretsSet,
            secretsKept: summary.secretsKept,
            publicParams: summary.publicParams,
          },
        ],
        new Date(),
      );

      // Through `q`, not the pool: the row was written in this transaction and has not been
      // committed, so a resolver on its own connection cannot see it — and would report the
      // credential as absent immediately after storing it.
      const [view] = (await this.#resolver.withExecutor(q).resolveCredentials(id)).filter(
        (row) => row.kind === kind && row.source.kind === 'own',
      );
      /* c8 ignore next -- the row was just written in this transaction */
      if (view === undefined) throw notFound(id);
      return {
        kind: view.kind,
        publicParams: view.publicParams,
        source: view.source,
        updatedAt: view.updatedAt,
      };
    });
  }

  /**
   * Removes the credential set defined on this object.
   *
   * Removing an override *reveals* whatever an ancestor defines, exactly as reverting a setting
   * does — it does not leave the object without credentials. The 200 says which, so an operator
   * deleting a device-level community string is told the group's one is now in force rather than
   * finding out from a sensor that kept working.
   */
  async clearCredential(
    actor: Actor,
    id: ObjectId,
    kind: string,
    pre: Precondition = { kind: 'none' },
  ): Promise<{ removed: boolean; nowInherited: CredentialView | null }> {
    const vault = this.#requireVault();
    return this.#db.tx(async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      const removed = await vault.clear(q, id, kind);
      if (removed) {
        await this.#audit.record(
          q,
          actor,
          [{ action: 'credential.deleted', objectId: id, credentialKind: kind }],
          new Date(),
        );
      }

      // Same reason: the delete is not committed yet, so a resolver on the pool would still see
      // the row this transaction removed and report it as the one now in force.
      const inherited =
        (await this.#resolver.withExecutor(q).resolveCredentials(id)).find(
          (row) => row.kind === kind,
        ) ?? null;
      return {
        removed,
        nowInherited:
          inherited === null
            ? null
            : {
                kind: inherited.kind,
                publicParams: inherited.publicParams,
                source: inherited.source,
                updatedAt: inherited.updatedAt,
              },
      };
    });
  }

  #requireVault(): CredentialVault {
    if (this.#vault === undefined) {
      throw new ObjectError(
        'CREDENTIAL_VAULT_UNAVAILABLE',
        'this core has no credential vault configured, so a credential cannot be stored — ' +
          'writing one in the clear instead is not an option',
        { context: { phase: 'credentials' } },
      );
    }
    return this.#vault;
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

      if (key === DEPENDENCY_MASTER_ID.key && typeof value === 'number') {
        await this.#assertUsableMaster(q, id, value);
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

      const id = await this.#repo.insert(q, normalised);

      if (normalised.kind === 'sensor') {
        await this.#repo.createChannels(
          q,
          id,
          this.#sensorTypes.channelsFor(normalised.sensorType, normalised.params ?? {}),
        );
      }

      // **Read once, after the object is finished** (`P-29`). Declaring channels bumps the
      // sensor's version by trigger, so a read taken before them is a version behind — and
      // handing that back would give the caller an ETag that 412s on its own first write. This
      // used to be a read before the channels plus a second read of just the version to patch
      // it; one read here is the same answer for one round trip fewer, on a path that is
      // round-trip bound and gets walked five thousand times by a provisioning run.
      const created = await this.#repo.get(q, id);
      if (created === null) throw notFound(id);

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
          sources: PAUSE_CAUSES_THIS_API_OWNS,
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

  /**
   * Creates a whole subtree in one transaction (`P-19`).
   *
   * **What this stops paying, rather than what it does differently.** Every object still goes
   * through the same validation, the same hierarchy trigger, the same channel declaration and
   * the same audit sink — the tree that comes out is the tree five thousand `create` calls would
   * have made. What it does not pay is five thousand HTTP requests, five thousand transactions,
   * five thousand tree locks and five thousand pause checks: those are per-*request* costs that
   * a caller building a subtree was paying per *object*.
   *
   * **One transaction is the point and also the constraint.** The whole subtree appears at once
   * or none of it does, which is what a discovery run wants — a half-provisioned device is worse
   * than a failed one, because nothing says which half. It is also why the node count is bounded:
   * the tree lock is shared, but a transaction that runs for a minute is still a minute in which
   * nothing can restructure the tree.
   *
   * **The pause cascade runs once, at the root.** `create` guards it with `anyActive` because
   * paying it per object is what `P-04`'s budget noticed; here it is one recompute over the
   * subtree that was just written, which is the same answer for a fraction of the work.
   */
  async createTree(
    actor: Actor,
    input: TreePlanInput,
  ): Promise<{ count: number; objects: { ref?: string; id: ObjectId; kind: ObjectKind }[] }> {
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeShared(q);

      const parent = await this.#repo.get(q, input.parentId);
      if (parent === null) throw parentNotFound(input.parentId);

      // Refused before a single row is written, and every refusal names the node. A caller
      // sending five thousand of them cannot act on a constraint violation from row 3,417.
      const plan = planTree(input, parent.kind);

      const ids = new Map<number, ObjectId>();
      const drafts: { sensorId: ObjectId; draft: ChannelDraft }[] = [];

      for (const level of plan.levels) {
        const written = await this.#repo.createLevel(
          q,
          level.map((node) => ({
            // Resolved here rather than in the planner because only this point knows the ids:
            // the planner works in indices, which is what makes it testable without a database.
            parentId: node.parentId ?? ids.get(node.parentIndex ?? -1) ?? input.parentId,
            input: this.#normalisedFor(node.input, input.parentId),
          })),
        );
        level.forEach((node, at) => {
          const id = written[at];
          /* c8 ignore next -- createLevel returns one id per node or throws */
          if (id === undefined) return;
          ids.set(node.index, id);
          if (node.input.kind !== 'sensor') return;
          for (const draft of this.#sensorTypes.channelsFor(
            node.input.sensorType,
            node.input.params ?? {},
          )) {
            drafts.push({ sensorId: id, draft });
          }
        });
      }

      // Every sensor's channels in one statement, after every level — they depend only on the
      // sensor ids, so there is nothing to gain from doing it level by level and a statement per
      // level to lose.
      await this.#repo.createChannelsFor(q, drafts);

      const now = new Date();
      if (await this.#pauses.anyActive(q, now)) {
        const affected = await this.#pauses.recompute(q, input.parentId, now);
        await this.#states?.reevaluate(q, affected, now, {
          message: 'created under a paused parent',
          sources: PAUSE_CAUSES_THIS_API_OWNS,
        });
      }

      // **In the caller's own order**, which is neither the order the rows were written in nor
      // the order the levels produced. A caller matching answers to requests by position would
      // otherwise attach the wrong id to the wrong node.
      const objects = input.nodes.map((node, index) => ({
        ...(node.ref === undefined ? {} : { ref: node.ref }),
        id: ids.get(index) ?? 0,
        kind: node.kind,
      }));

      // One audit entry per object, in one write, and each carrying what the serial path records
      // — the log has to be able to answer "what was this object when it was created", and an
      // entry saying "5,000 objects were created" answers nothing. Read back in one statement
      // rather than assembled from the inputs, so what is logged is what is stored: defaults the
      // schema filled in, the version the triggers landed on, and the redaction every read goes
      // through.
      const details = await this.#repo.getMany(q, [...ids.values()]);
      await this.#audit.record(
        q,
        actor,
        details.map((detail) => {
          const safe = this.#redact(detail);
          return {
            action: 'object.created' as const,
            objectId: safe.id,
            kind: safe.kind,
            after: safe,
          };
        }),
        now,
      );

      return { count: plan.count, objects };
    });
  }

  /** A node's input as `create` would have normalised it, with its parent id filled in. */
  #normalisedFor(node: TreeNodeInput, parentId: ObjectId): CreateObjectInput {
    const withParent = { ...node, parentId } as CreateObjectInput;
    return withParent.kind === 'sensor'
      ? {
          ...withParent,
          params: this.#sensorTypes.normalise(withParent.sensorType, withParent.params ?? {}),
        }
      : withParent;
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
                // Secrets the patch does not mention come from what is stored. `params` is
                // replaced wholesale below, and a read never returns a credential — so without
                // this, anything that reads a sensor and writes it back would delete every
                // secret it holds on the first save. Here rather than in the caller for the same
                // reason redaction is at one boundary: a new client cannot forget it.
                this.#sensorTypes.carryWriteOnly(
                  before.kind === 'sensor' ? before.sensorType : '',
                  patch.params,
                  before.kind === 'sensor' ? before.params : {},
                ),
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
          // **The seventh caller `P-140` missed, and the only one that can actually write the
          // wrong words** (`G12`). Moving a subtree out from under a paused group flips
          // `paused_by_parent` true→false, and a sensor still held by a maintenance window or a
          // dependency then changes its reported cause from `parent` to `schedule` — a real
          // transition, with a foreign cause, carrying "moved under a paused parent" as its
          // message for a sensor that was moved *out* from under one. Without `sources`,
          // `reevaluate` reads the caller as owning every cause, which is the condition `P-94`
          // and `P-140` both exist to remove.
          sources: PAUSE_CAUSES_THIS_API_OWNS,
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
          // A clone is paused from the moment it exists, not from a moment somebody picked.
          startsAt: clonedAt,
          pausedUntil: null,
          message: `cloned from #${String(id)}`,
        },
        actor,
      );
      const clonedSensors = await this.#pauses.recompute(q, cloneRoot.id, clonedAt);
      await this.#states?.reevaluate(q, clonedSensors, clonedAt, {
        message: `cloned from #${String(id)}`,
        // Benign today — a freshly cloned sensor's schedule and dependency flags are false, so
        // the decided cause is always one this API owns — and declared anyway, because "it
        // happens to be unreachable" is not a property a later change preserves (`G12`).
        sources: PAUSE_CAUSES_THIS_API_OWNS,
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

      if (object.kind === 'probe') {
        // **The local probe cannot be deleted** (`R-01`), matching PRTG. Deleting it leaves a
        // core whose own host is unmonitored and no obvious route back: the probe process is
        // still running and still connecting, but the branch it was approved onto is gone, so
        // it enrols again as a stranger and every sensor that lived under it has been destroyed
        // with the subtree.
        const local = await q.query<{ is_local: boolean }>(
          'SELECT is_local FROM probe_config WHERE object_id = $1',
          [id],
        );
        if (local[0]?.is_local === true) {
          throw new ObjectError(
            'OBJECT_NOT_DELETABLE',
            `"${object.name}" is this installation's local probe and cannot be deleted`,
            { context: { objectId: id, phase: 'delete' } },
          );
        }
      }

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

      // **After the delete, and still inside the transaction** (`P-88`).
      //
      // Inside, because an audit entry must never exist for a rolled-back delete, and because
      // there is no recycle bin: `object`, `counts` and `refs` were captured above, so the
      // entry records exactly the same enumeration it always did — the only reconstruction path
      // a mistaken delete has — regardless of when it is written.
      //
      // After, because `CompositeAuditSink.record` fans out synchronously into this
      // transaction, and one of those sinks is `DependencySync`, which exists precisely so a
      // deleted master does not "pause them for ever with no object left to point at". Running
      // it while the master's rows were still present meant `applyPauses`' `holding` CTE still
      // named it, nothing moved, and the dependents kept `paused_by_dependency` — out of the
      // probe configuration, unscannable, and reported as not paused by the pause API, so they
      // could not even be resumed. The sink has to see the tree it is reacting to.
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
