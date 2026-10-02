import { isRestricted, restrictionOf } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { changedParamKeys } from '../audit/diff.js';
import type { Database, Queryable } from '../db/pool.js';
import type { Reach, Visibility } from '../auth/access.js';
import { AuthError } from '../auth/errors.js';
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
import { assertDeviceHost } from './device-host.js';
import { ObjectError, notFound, parentNotFound } from './errors.js';
import { reorderAmong } from './ordering.js';
import { planTree, type TreeNodeInput, type TreePlanInput } from './tree-plan.js';
import { versionConflict } from './repository.js';
import type { ObjectRepository } from './repository.js';
import type { CredentialVault } from '../vault/service.js';
import type { ChannelDraft, SensorTypeGate } from './sensor-type-gate.js';
import {
  boundsBeneath,
  type WithheldReason,
  sensorsUsing,
  vouch as vouchForCredentials,
} from './credential-vouching.js';
import {
  actorOf,
  assertMayName,
  voucherOf,
  type InstallationBar,
  type NamedObject,
  type Writer,
} from './sensor-reads.js';
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
  UnboundedCredential,
  DeleteExpectation,
  DeleteReport,
  ListExpansions,
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

/**
 * What a *move* owns, which is less (`P-174`).
 *
 * A move applies no manual pause: the only flag it can change is `paused_by_parent`, so `parent`
 * is the only cause whose words are its to write. Declaring the pause API's set here let a move
 * overwrite an operator's own reason — a sensor paused by hand for "disk replacement", under a
 * paused group, moved out of it, reports cause `user` and the message "moved under a paused
 * parent". `P-140`'s defect exactly, reintroduced by the fix for it.
 */
const PAUSE_CAUSES_A_MOVE_OWNS = ['parent'] as const;

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
  ): Promise<{
    sensorId: number;
    state: string;
    clearAt: Date | null;
    untilEvaluated: boolean;
  } | null>;
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

  /**
   * The object's parent, or null when there is no such object or it is the root.
   *
   * For the clone route's guard, which has to ask for `write` on where a clone made in place
   * lands before the handler runs (`A-35`).
   */
  async parentOf(id: ObjectId): Promise<ObjectId | null> {
    const object = await this.#repo.get(this.#db, id);
    return object?.parentId ?? null;
  }

  async getRoot(): Promise<ObjectDetail> {
    return this.#redact(await this.#repo.getRoot(this.#db));
  }

  /**
   * Effective values are resolved for the whole page in one query per key. A route that looped
   * the single-object resolver would issue `rows × keys` round trips; `resolveForObjects`
   * exists for exactly this. Paths are the same bargain: one walk for the page (`P-214`).
   *
   * **Every method that returns more than the object it was asked about takes a `Visibility`,
   * and it is not optional** (`A-12`). The routes pass the caller's; an internal caller that
   * really means the whole tree passes `Visibility.EVERYTHING` and says so.
   */
  async list(
    filter: ObjectFilter,
    page: PageRequest,
    visibility: Visibility,
    expand: ListExpansions = {},
  ): Promise<Page<ObjectSummary>> {
    const result = await this.#repo.list(this.#db, filter, page, visibility);
    if (result.items.length === 0) return result;
    let items = result.items;
    const effectiveKeys = expand.effective ?? [];
    if (effectiveKeys.length > 0) items = await this.#attachEffective(items, effectiveKeys);
    if (expand.path === true) items = await this.#attachPaths(items, visibility);
    return items === result.items ? result : { ...result, items };
  }

  async subtree(
    id: ObjectId,
    options: SubtreeOptions,
    visibility: Visibility,
    effectiveKeys: readonly string[] = [],
  ): Promise<SubtreeResult> {
    await this.get(id);
    const result = await this.#repo.subtree(this.#db, id, options, visibility);
    if (effectiveKeys.length === 0 || result.items.length === 0) return result;
    return { ...result, items: await this.#attachEffective(result.items, effectiveKeys) };
  }

  /**
   * What `subtree` would have counted, without the rows and without the cap (`U-14`).
   *
   * A caller that wants totals asks for totals. Reading a page of the tree and counting it is
   * how an overview came to claim 930 sensors on a system running five thousand.
   */
  async counts(id: ObjectId, visibility: Visibility): Promise<SubtreeCounts> {
    await this.get(id);
    return this.#repo.subtreeCounts(this.#db, id, visibility);
  }

  /**
   * Totals over everything the reader can see (`A-12`) — the overview's numbers.
   *
   * Counted from the root with the reader's visibility rather than summed over its tops, because
   * tops nest: a grant re-opened inside a hole is a top of its own *and* inside its branch's
   * subtree, and a sum would count it twice.
   */
  async visibleCounts(visibility: Visibility): Promise<SubtreeCounts> {
    const root = await this.#repo.getRoot(this.#db);
    return this.#repo.subtreeCounts(this.#db, root.id, visibility);
  }

  async ancestors(id: ObjectId, visibility: Visibility): Promise<ObjectRef[]> {
    await this.get(id);
    return this.#repo.ancestors(this.#db, id, visibility);
  }

  /** How many of this object's children the reader can see (`A-12`). */
  async visibleChildCount(id: ObjectId, visibility: Visibility): Promise<number> {
    return this.#repo.visibleChildCount(this.#db, id, visibility);
  }

  /** Where the reader's tree starts: the root, or the tops of the branches it was granted. */
  async tops(visibility: Visibility): Promise<ObjectSummary[]> {
    return this.#repo.tops(this.#db, visibility);
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
    visibility: Visibility,
    reach: Reach,
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

      // What the caller can see beneath it (`A-24`) — and so the "no sensors here" refusal below
      // is the same answer for a hole as for an empty device.
      const seen = object.kind === 'sensor' ? [id] : await sensorsIn(q, id, visibility);
      if (seen.length === 0) {
        throw new ObjectError('OBJECT_INVALID', 'there are no sensors here to force', {
          context: { objectId: id, phase: 'simulate' },
        });
      }
      // Then only what naming each sensor would allow (`A-31`): `write` on a device is not
      // `write` on a sensor granted only `read` beneath it, which is left as it is and reported.
      // A pause reaches that sensor, and is no precedent for this — see `Reach`.
      const { reached: targets, skipped } = await reach.split(q, seen);
      if (targets.length === 0) {
        throw new AuthError(
          'AUTH_FORBIDDEN',
          `this account may not ${simulated ? 'force' : 'release'} any sensor here`,
          { objectId: id, needed: 'write', skipped: skipped.length },
        );
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
        skipped,
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
    visibility: Visibility,
    reach: Reach,
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
    return this.#applyAcknowledgement(actor, id, resolved.acknowledgement, visibility, reach, now);
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
  async clearAcknowledgement(
    actor: Actor,
    id: ObjectId,
    visibility: Visibility,
    reach: Reach,
  ): Promise<AcknowledgementView> {
    return this.#applyAcknowledgement(actor, id, null, visibility, reach, new Date());
  }

  async #applyAcknowledgement(
    actor: Actor,
    id: ObjectId,
    acknowledgement: ResolvedAcknowledgement | null,
    visibility: Visibility,
    reach: Reach,
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

      // The Down sensors the caller can see beneath it (`A-24`): an acknowledgement is a write,
      // and it must not reach into a hole — nor may its refusal say whether the hole is Down.
      const seen = object.kind === 'sensor' ? [id] : await downSensorsIn(q, id, visibility);
      if (seen.length === 0) {
        throw new ObjectError(
          'OBJECT_NOT_PAUSED',
          acknowledgement === null
            ? 'nothing here has an acknowledgement to clear'
            : 'nothing here is Down to acknowledge',
          { context: { objectId: id, phase: 'acknowledge' } },
        );
      }
      // Then only those the caller could acknowledge by name (`A-31`): `write` on each, or `read`
      // with the account's opt-in. The rest are left as they are and reported.
      const { reached: targets, skipped } = await reach.split(q, seen);
      if (targets.length === 0) {
        throw new AuthError(
          'AUTH_FORBIDDEN',
          acknowledgement === null
            ? 'this account may not clear an acknowledgement on any sensor here'
            : 'this account may not acknowledge any sensor here',
          { objectId: id, needed: 'write', skipped: skipped.length },
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
        skipped,
        acknowledgedAt: acknowledgement?.acknowledgedAt.toISOString() ?? null,
        acknowledgedUntil: acknowledgement?.acknowledgedUntil?.toISOString() ?? null,
        message: acknowledgement?.message ?? '',
      };
    });
  }

  /**
   * A pause view with what belongs to objects the reader cannot see taken out (`A-12`).
   *
   * A sensor's pause can come from a container above the branch it was granted, and its master
   * can sit in a branch it was not. Both are this object's own facts with another object's name in
   * them; the ids stay, as references, and the names and the master's state go.
   */
  async pauseSeenBy(view: PauseView, visibility: Visibility): Promise<PauseView> {
    const named = [view.inheritedFrom?.objectId, view.dependency?.masterId].filter(
      (one): one is ObjectId => one !== undefined,
    );
    const visible = await visibility.visibleAmong(this.#db, named);
    const { inheritedFrom, dependency } = view;
    return {
      ...view,
      inheritedFrom:
        inheritedFrom === null || visible.has(inheritedFrom.objectId)
          ? inheritedFrom
          : { objectId: inheritedFrom.objectId, name: null },
      dependency:
        dependency === null || visible.has(dependency.masterId)
          ? dependency
          : { ...dependency, masterName: null, masterState: null },
    };
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
      // A master never holds itself; that exclusion is what keeps it scanning. One withheld
      // while Down holds with no release time, until it is evaluated again (`M-23`).
      holding:
        assignment.masterId !== id &&
        (master.state === 'down' ||
          master.state === 'down_acknowledged' ||
          master.untilEvaluated ||
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
    const vault = this.#vault;
    return Promise.all(
      visible.map(async (row) => {
        const view = credentialViewOf(row);
        if (vault === undefined || row.source.kind !== 'own') return view;
        // Which secrets the set stored here holds, by name (`U-21`): what its form needs to offer
        // keep, replace and clear. An inherited set is edited on its owner, and says nothing.
        const secretsSet = await vault.secretNames(this.#db, id, row.kind);
        return secretsSet === null ? view : { ...view, secretsSet };
      }),
    );
  }

  /**
   * The credential sets with no bounds, on the objects this reader can see (`U-21`).
   *
   * What Core Health's `credentialsUnbounded` counts, as a list to work through. The count is the
   * installation's and is read with `read` on the root; this is each reader's part of it, so a set
   * on an object outside their view is absent, as the object is from every other list (`A-12`).
   * Empty without a vault, as `credentialKinds` is.
   */
  async unboundedCredentials(visibility: Visibility): Promise<UnboundedCredential[]> {
    const vault = this.#vault;
    if (vault === undefined) return [];
    const sets = await vault.unbounded(this.#db);
    const visible = await visibility.visibleAmong(
      this.#db,
      sets.map((set) => set.objectId),
    );
    return sets
      .filter((set) => visible.has(set.objectId))
      .map((set) => ({
        objectId: set.objectId,
        objectKind: set.objectKind as ObjectKind,
        objectName: set.objectName,
        kind: set.kind as CredentialKind,
        updatedAt: set.updatedAt,
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
    writer: Writer,
    id: ObjectId,
    kind: string,
    values: Readonly<Record<string, unknown>>,
    pre: Precondition = { kind: 'none' },
    options: CredentialWriteOptions = {},
  ): Promise<CredentialWriteAnswer> {
    const vault = this.#requireVault();
    const actor = actorOf(writer);
    const preview = options.preview === true;
    return this.#txOrPreview(preview, async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      // What bounds kept from which sensors beneath, as the write finds it (`A-55`): the set
      // stored here if there is one, an ancestor's if this write stores the first. Read before
      // the write and in its transaction, so that the answer can say what the write changes
      // and not only how things stand after it.
      const before = await boundsBeneath(q, this.#sensorTypes, id, kind);
      const summary = await vault.write(q, id, kind, values, { preview });
      // Whoever may write where a set is stored vouches for everything beneath that it now
      // reaches (`A-41`): the sensors that inherited another set of this kind until now.
      await this.#checkCredentials(q, writer, [id], { sayWhich: true, kinds: [kind] });
      // How many sensors beneath its bounds now keep the set from (`A-41b`). Narrowing a set's
      // targets can take a whole group to Unknown at once, so the write says so, and so does the
      // audit entry, rather than leaving it to be found from the sensors.
      const after = await boundsBeneath(q, this.#sensorTypes, id, kind);
      // Over the sensors this set reaches now, before and after: a sensor beneath with a nearer
      // set of its own is not this write's, and stands the same on both sides of it.
      const withheld = [...after.withheld.keys()].filter((sensor) => after.reached.has(sensor));
      const wasWithheld = [...before.withheld.keys()].filter((sensor) => after.reached.has(sensor));
      const newly = withheld.filter((sensor) => !before.withheld.has(sensor));
      const noLonger = wasWithheld.filter((sensor) => !after.withheld.has(sensor));
      // The audit record keeps the whole numbers: they are what the write did (`A-59`: the
      // sensors it put outside and brought back, beside how many are outside after it). It
      // reaches the installation's log, which whoever reads the service's journal reads. **The
      // history the API serves stores no count for a credential write** (`audit/store.ts`): an
      // object's history is read with `read` on it, by an account that may have a hole beneath,
      // and a whole count there would say how many sensors are inside the hole.
      const withholds = withheld.length;
      const bounded = isRestricted(restrictionOf(kind, summary.publicParams));
      // A preview changes nothing, so it has nothing to put in the history. Skipped rather than
      // left to the rollback: a sink is not obliged to keep its record in this transaction.
      if (!preview) {
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
              ...(summary.secretsCleared.length === 0
                ? {}
                : { secretsCleared: summary.secretsCleared }),
              ...(bounded ? { withholds, newlyWithheld: newly.length } : {}),
              // A write that takes the bounds away brings sensors back and leaves a set that
              // withholds nothing: said for a bounded set, and whenever there are any.
              ...(bounded || noLonger.length > 0 ? { noLongerWithheld: noLonger.length } : {}),
              publicParams: summary.publicParams,
            },
          ],
          new Date(),
        );
      }

      // Through `q`, not the pool: the row was written in this transaction and has not been
      // committed, so a resolver on its own connection cannot see it — and would report the
      // credential as absent immediately after storing it.
      const [view] = (await this.#resolver.withExecutor(q).resolveCredentials(id)).filter(
        (row) => row.kind === kind && row.source.kind === 'own',
      );
      /* c8 ignore next -- the row was just written in this transaction */
      if (view === undefined) throw notFound(id);
      // **Of the sensors this caller can see** (`A-12`), every one of the four. Asked with other
      // targets, a whole number says where the devices in a hole beneath the object are, and a
      // preview asks for nothing and leaves no trace. One question for all four: every sensor in
      // `newly` is in `withheld` and every one in `noLonger` is in `wasWithheld`.
      const seen = await this.#seenOf(q, options.visibility, [...withheld, ...wasWithheld]);
      // **And each for the two reasons a sensor is outside** (`A-59`), over the same sensors
      // the caller sees and from the same answer to the one question: a reason's count is of
      // sensors already counted in its total, so no number here is of a sensor in a hole, and
      // none is worked out from a whole one. Outside after the write, a sensor is counted for
      // the reason that holds after it; outside before, for the one that held then.
      const counts = (reason?: WithheldReason): CredentialWriteCounts => {
        const count = (
          sensors: readonly ObjectId[],
          why: ReadonlyMap<ObjectId, WithheldReason>,
        ): number =>
          sensors.filter(
            (sensor) => seen(sensor) && (reason === undefined || why.get(sensor) === reason),
          ).length;
        return {
          withholds: count(withheld, after.withheld),
          withheldBefore: count(wasWithheld, before.withheld),
          newlyWithheld: count(newly, after.withheld),
          noLongerWithheld: count(noLonger, before.withheld),
        };
      };
      return {
        ...credentialViewOf(view),
        ...counts(),
        byReason: { outside: counts('outside'), unpinnable: counts('unpinnable') },
        secretsCleared: summary.secretsCleared,
      };
    });
  }

  /** Which of these sensors a caller can see, as `#seenAmong` counts them. */
  async #seenOf(
    q: Queryable,
    visibility: Visibility | undefined,
    sensors: readonly ObjectId[],
  ): Promise<(sensor: ObjectId) => boolean> {
    if (visibility === undefined || visibility.everything) return () => true;
    const visible = await visibility.visibleAmong(q, [...new Set(sensors)]);
    return (sensor) => visible.has(sensor);
  }

  /**
   * Runs a write in a transaction, or runs it and takes it back (`U-21`).
   *
   * **A preview is the write itself, rolled back, and not a second calculation of what the write
   * would do.** What a credential write answers — the sensors its bounds now keep it from, the
   * secrets a widening clears, the refusal when its writer cannot vouch — is decided by the vault,
   * the voucher check and the tree as they stand, in that transaction. A separate estimate would
   * be a second place for each of those rules to live, and the one an operator is shown before
   * confirming is the one that must not drift. The answer leaves the transaction as the reason it
   * failed, so nothing in it commits and no after-commit hook runs.
   */
  /**
   * How many of these sensors a caller can see (`U-21`, `A-12`): what a credential write may
   * count for them. A write holds `write` on the object it names, and a `none` carved beneath
   * it is still a hole: its sensors use the set, and their number is not the writer's to learn.
   * No visibility is an internal caller, who sees everything.
   */
  async #seenAmong(
    q: Queryable,
    visibility: Visibility | undefined,
    sensors: readonly ObjectId[],
  ): Promise<number> {
    if (visibility === undefined || visibility.everything) return sensors.length;
    return (await visibility.visibleAmong(q, sensors)).size;
  }

  async #txOrPreview<T>(preview: boolean, work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!preview) return this.#db.tx(work);
    try {
      await this.#db.tx(async (q) => {
        throw new Previewed(await work(q));
      });
    } catch (error) {
      if (error instanceof Previewed) return error.answer as T;
      throw error;
    }
    /* c8 ignore next -- the transaction above always throws */
    throw new Error('a preview committed');
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
    writer: Writer,
    id: ObjectId,
    kind: string,
    pre: Precondition = { kind: 'none' },
    options: CredentialWriteOptions = {},
  ): Promise<{ removed: boolean; sensors: number; nowInherited: CredentialView | null }> {
    const vault = this.#requireVault();
    const actor = actorOf(writer);
    const preview = options.preview === true;
    return this.#txOrPreview(preview, async (q) => {
      const object = await this.#repo.get(q, id);
      if (object === null) throw notFound(id);
      if (pre.kind === 'version' && object.version !== pre.expected) {
        throw versionConflict(id, pre.expected, object.version);
      }

      // Counted while the set is still there to be resolved to (`U-21`): the sensors that lose
      // it, which is what somebody removing it is asked to confirm. Those of them the caller can
      // see, as `withholds` is.
      const sensors = await this.#seenAmong(
        q,
        options.visibility,
        await sensorsUsing(q, this.#sensorTypes, id, kind),
      );
      const removed = await vault.clear(q, id, kind);
      // What an ancestor stores now reaches everything this set did, and the remover has to be
      // able to vouch for sending it there (`A-41`).
      if (removed) {
        await this.#checkCredentials(q, writer, [id], { sayWhich: true, kinds: [kind] });
        if (!preview) {
          await this.#audit.record(
            q,
            actor,
            [{ action: 'credential.deleted', objectId: id, credentialKind: kind }],
            new Date(),
          );
        }
      }

      // Same reason: the delete is not committed yet, so a resolver on the pool would still see
      // the row this transaction removed and report it as the one now in force.
      const inherited =
        (await this.#resolver.withExecutor(q).resolveCredentials(id)).find(
          (row) => row.kind === kind,
        ) ?? null;
      return {
        removed,
        // Zero when there was no set here to remove: nothing resolved to one.
        sensors,
        nowInherited: inherited === null ? null : credentialViewOf(inherited),
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
   * without paying for the resolution work the answer would otherwise require. A restricted
   * `visibility` narrows it to what that reader's answer can show (`A-49`).
   */
  async chainValidator(
    id: ObjectId,
    salt: string,
    visibility?: Visibility,
  ): Promise<string | null> {
    return this.#db.tx((q) => this.#repo.chainValidator(q, id, salt, visibility));
  }

  async create(writer: Writer, input: CreateObjectInput): Promise<ObjectDetail> {
    const actor = actorOf(writer);
    if (input.kind === 'device') assertDeviceHost(input.host, { phase: 'create' });
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
        await this.#checkReads(q, writer, [id], {
          sayWhich: false,
          types: [normalised.sensorType],
        });
        await this.#checkCredentials(q, writer, [id], {
          sayWhich: false,
          types: [normalised.sensorType],
        });
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
    writer: Writer,
    input: TreePlanInput,
  ): Promise<{ count: number; objects: { ref?: string; id: ObjectId; kind: ObjectKind }[] }> {
    const actor = actorOf(writer);
    return this.#db.tx(async (q) => {
      await this.#repo.lockTreeShared(q);

      const parent = await this.#repo.get(q, input.parentId);
      if (parent === null) throw parentNotFound(input.parentId);

      // Refused before a single row is written, and every refusal names the node. A caller
      // sending five thousand of them cannot act on a constraint violation from row 3,417.
      const plan = planTree(input, parent.kind);

      const ids = new Map<number, ObjectId>();
      const drafts: { sensorId: ObjectId; draft: ChannelDraft }[] = [];
      const sensors: ObjectId[] = [];
      const sensorTypes = new Set<string>();

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
          sensors.push(id);
          sensorTypes.add(node.input.sensorType);
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
      await this.#checkReads(q, writer, sensors, { sayWhich: true, types: [...sensorTypes] });
      await this.#checkCredentials(q, writer, sensors, {
        sayWhich: true,
        types: [...sensorTypes],
      });

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

  /**
   * Refuses a write that leaves a sensor naming something its writer could not read, and records
   * the writer as the one the core evaluates it through from then on (`A-29`).
   *
   * **After the write, inside its transaction**, so that every path answers the same question
   * about the same thing: what the tree looks like now. A moved or cloned subtree has its new
   * probe above it, a created tree has its ids, and a refusal rolls the whole write back.
   *
   * `types` is what the caller knows was written, when it knows: a sensor of a type that reads
   * nothing but its target — every sensor a provisioning run creates — costs no query at all.
   */
  async #checkReads(
    q: Queryable,
    writer: Writer,
    under: readonly ObjectId[],
    options: { sayWhich: boolean; types?: readonly string[] },
  ): Promise<void> {
    const reading = this.#sensorTypes.readingTypes();
    const types =
      options.types === undefined
        ? reading
        : options.types.filter((type) => reading.includes(type));
    if (types.length === 0 || under.length === 0) return;

    const sensors = await this.#repo.sensorsOfTypesAtOrUnder(q, under, types);
    const named: NamedObject[] = [];
    const bars: InstallationBar[] = [];
    for (const sensor of sensors) {
      const reads = this.#sensorTypes.reads(sensor.sensorType, sensor.params);
      const sensorName = sensor.name;
      if (reads.requires === 'installation') {
        bars.push({ sensorName, sensorType: sensor.sensorType });
      }
      for (const reference of reads.references) {
        if (reference.kind === 'object') {
          named.push({
            sensorName,
            param: reference.param,
            objectId: reference.objectId,
            expects: reference.expects,
          });
          continue;
        }
        // Not under a probe at all names nothing; the sensor has nothing to report on, and says
        // so when it is evaluated.
        const probe = await this.#repo.nearestProbe(q, sensor.id);
        if (probe !== null) {
          named.push({ sensorName, param: reference.param, objectId: probe.id, expects: 'probe' });
        }
      }
    }
    const voucher = voucherOf(writer);
    await assertMayName(q, voucher, { named, bars, sayWhich: options.sayWhich });
    // And it is this writer the core evaluates them through from now on (`A-29`).
    await this.#repo.recordVoucher(
      q,
      sensors.map((sensor) => sensor.id),
      voucher,
    );
  }

  /**
   * Refuses a write that brings an inherited credential set somewhere new, unless its writer has
   * `write` on where the set is stored, and records who vouched (`A-41`).
   *
   * Beside `#checkReads` and for the same reasons: after the write, in its transaction, so every
   * path asks about the tree as it now is and a refusal takes the write back with it.
   */
  async #checkCredentials(
    q: Queryable,
    writer: Writer,
    under: readonly ObjectId[],
    options: { sayWhich: boolean; types?: readonly string[]; kinds?: readonly string[] },
  ): Promise<void> {
    await vouchForCredentials(q, this.#sensorTypes, writer, under, options);
  }

  /**
   * Where the sensors at or under an object send what their own parameters hold (`A-41`): the
   * probe, and the host of the device they are on. Compared, never read.
   *
   * A group or a device carries its devices' hosts with it, so only the probe can change; a sensor
   * can land on another device.
   */
  async #whereSent(q: Queryable, object: ObjectDetail, probeId: ObjectId | null): Promise<string> {
    const device =
      object.kind === 'device'
        ? object
        : object.kind === 'sensor'
          ? await this.#repo.get(q, object.parentId)
          : null;
    return JSON.stringify([
      probeId,
      device?.kind === 'device' ? [device.host, device.ipVersion] : null,
    ]);
  }

  /**
   * Clears the secrets held in the parameters of every sensor at or under these objects, because a
   * write has changed where they are sent and could not send them again (`A-41`, by `A-40`'s rule).
   *
   * A device's host is not one of its sensors' parameters, so its sensors cannot bind a community
   * to it the way `A-40` binds one to a port: the write that moves them has to clear it. One audit
   * entry per sensor, naming what it lost. Renumbering a device means entering them again.
   */
  async #clearSecretsSentElsewhere(
    q: Queryable,
    actor: Actor,
    under: readonly ObjectId[],
  ): Promise<void> {
    const sensors = await this.#repo.sensorsOfTypesAtOrUnder(
      q,
      under,
      this.#sensorTypes.secretTypes(),
    );
    const entries: Mutation[] = [];
    for (const sensor of sensors) {
      const { params, redacted } = this.#sensorTypes.redact(sensor.sensorType, sensor.params);
      if (redacted.length === 0) continue;
      const before = await this.#repo.get(q, sensor.id);
      /* c8 ignore next -- listed by the query above, in this transaction */
      if (before === null) continue;
      const after = await this.#repo.update(
        q,
        sensor.id,
        { kind: 'sensor', params },
        { kind: 'none' },
      );
      entries.push({
        action: 'object.updated',
        objectId: sensor.id,
        kind: 'sensor',
        before: this.#redact(before),
        after: this.#redact(after),
        changedParams: changedParamKeys(before, after),
        secretsCleared: redacted,
      });
    }
    if (entries.length === 0) return;
    await this.#audit.record(q, actor, entries, new Date());
    this.#logger.info(
      { under, sensors: entries.length },
      'a write changed where these sensors send their secrets; cleared',
    );
  }

  /** A node's input as `create` would have normalised it, with its parent id filled in. */
  #normalisedFor(node: TreeNodeInput, parentId: ObjectId): CreateObjectInput {
    const withParent = { ...node, parentId } as CreateObjectInput;
    if (withParent.kind === 'device') assertDeviceHost(withParent.host, { phase: 'createTree' });
    return withParent.kind === 'sensor'
      ? {
          ...withParent,
          params: this.#sensorTypes.normalise(withParent.sensorType, withParent.params ?? {}),
        }
      : withParent;
  }

  async update(
    writer: Writer,
    id: ObjectId,
    patch: UpdateObjectInput,
    pre: Precondition,
  ): Promise<ObjectDetail> {
    const actor = actorOf(writer);
    if (patch.kind === 'device' && patch.host !== undefined) {
      assertDeviceHost(patch.host, { phase: 'update', objectId: id });
    }
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

      // Worked out before the carry below, which drops them: the audit entry says which secrets
      // an edit left behind by changing where they are sent (`A-40`).
      const secretsCleared =
        patch.kind === 'sensor' && patch.params !== undefined && before.kind === 'sensor'
          ? this.#sensorTypes.secretsLeftBehind(before.sensorType, patch.params, before.params)
          : [];
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

      // Writing the parameters vouches for all of them, not just the ones that changed: the
      // writer is the one standing behind the sensor from here on (`A-29`). A rename does not.
      if (after.kind === 'sensor' && patch.kind === 'sensor' && patch.params !== undefined) {
        await this.#checkReads(q, writer, [id], { sayWhich: false, types: [after.sensorType] });
        // And for where it sends its inherited credentials, which a parameter can choose — and
        // saving it is how a sensor withheld for its voucher's lost grant is vouched for again.
        await this.#checkCredentials(q, writer, [id], {
          sayWhich: false,
          types: [after.sensorType],
        });
      }

      // A device pointed somewhere else takes every sensor's credentials with it (`A-41`).
      const repointed =
        before.kind === 'device' &&
        after.kind === 'device' &&
        (before.host !== after.host || before.ipVersion !== after.ipVersion);
      if (repointed) await this.#checkCredentials(q, writer, [id], { sayWhich: true });

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
            ...(secretsCleared.length === 0 ? {} : { secretsCleared }),
          },
        ],
        new Date(),
      );
      if (secretsCleared.length > 0) {
        this.#logger.info(
          { objectId: id, secretsCleared },
          'an edit changed where these secrets are sent without sending them again; cleared',
        );
      }
      // After the device's own entry, so its history reads in the order it happened.
      if (repointed) await this.#clearSecretsSentElsewhere(q, actor, [id]);

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
   *
   * **Among the siblings `visibility` shows** (`A-46`). Every other sibling keeps its index and
   * nothing its owners hold goes stale: "up" passes the nearest visible sibling, and the top the
   * caller can see is the top, whatever sits above it. The entry records positions among every
   * sibling, and the history leaves them out for a reader who cannot see them all.
   */
  async reorder(
    actor: Actor,
    id: ObjectId,
    move: SiblingMove,
    pre: Precondition,
    visibility: Visibility,
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
      const seen = visibility.everything ? null : await visibility.visibleAmong(q, siblings);
      const change = reorderAmong(siblings, seen, id, move);
      if (change === null) return this.#redact(object);

      await this.#repo.writeSiblingOrder(
        q,
        object.parentId,
        change.next,
        new Set(seen === null ? [] : siblings.filter((one) => !seen.has(one))),
      );

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
    writer: Writer,
    id: ObjectId,
    targetParentId: ObjectId,
    pre: Precondition,
  ): Promise<MoveResult> {
    const actor = actorOf(writer);
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
      const sentFrom = await this.#whereSent(q, object, fromProbe?.id ?? null);

      const fromParentId = object.parentId;
      await this.#repo.reparent(q, id, targetParentId, pre);

      // The moved sensors have a new audience, and a Probe Health sensor with no `probeId` may
      // have a new probe, so the mover vouches for what every one of them reads (`A-29`).
      await this.#checkReads(q, writer, [id], { sayWhich: object.kind !== 'sensor' });
      // And for where their inherited credentials now go: another probe, another device, or
      // another ancestor's set (`A-41`).
      await this.#checkCredentials(q, writer, [id], { sayWhich: object.kind !== 'sensor' });

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
          // and `P-140` both exist to remove. `parent` alone, because a move applies no manual
          // pause and so owns no `user` words either (`P-174`).
          sources: PAUSE_CAUSES_A_MOVE_OWNS,
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
      if (sentFrom !== (await this.#whereSent(q, moved, toProbe?.id ?? null))) {
        await this.#clearSecretsSentElsewhere(q, actor, [id]);
      }

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

  /**
   * Copies an object and what `visibility` sees beneath it (`A-35`).
   *
   * The copy carries its source's configuration, its triggers and its grants, and none of what
   * the caller cannot see: a hole beneath the source is left out, and the answer counts only
   * what was copied. The route passes the caller's visibility; a caller that means the whole
   * tree passes `Visibility.EVERYTHING` and says so.
   */
  async clone(
    writer: Writer,
    id: ObjectId,
    input: CloneInput,
    visibility: Visibility,
  ): Promise<CloneResult> {
    const actor = actorOf(writer);
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
        visibility,
      );

      const cloneRoot = await this.#repo.get(q, copied.cloneRootId);
      if (cloneRoot === null) throw notFound(copied.cloneRootId);

      // A copy names what its source named, now in front of whoever reads where it landed.
      await this.#checkReads(q, writer, [cloneRoot.id], { sayWhich: source.kind !== 'sensor' });
      // And is sent the credentials of wherever it landed (`A-41`).
      await this.#checkCredentials(q, writer, [cloneRoot.id], {
        sayWhich: source.kind !== 'sensor',
      });

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
        // A clone *does* apply its own manual pause — that is the line above — so `user` is
        // genuinely its to describe, and `parent` comes with the subtree it lands in (`G12`).
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
          // One entry per carried grant, as a grant made by hand writes (`A-17`), so each copy's
          // history says who can see it and "who gave that group this?" is answered by the clone.
          ...copied.grants.map((grant): Mutation => ({
            action: 'grant.set',
            objectId: grant.objectId,
            subject: { kind: 'object', id: grant.objectId },
            groupId: grant.groupId,
            groupName: grant.groupName,
            before: null,
            after: grant.right,
          })),
        ],
        new Date(),
      );
      // The copy's own secrets stay only where the source's were being sent.
      const sentFrom = await this.#whereSent(
        q,
        source,
        (await this.#repo.nearestProbe(q, id))?.id ?? null,
      );
      const sentTo = await this.#whereSent(
        q,
        cloneRoot,
        (await this.#repo.nearestProbe(q, cloneRoot.id))?.id ?? null,
      );
      if (sentFrom !== sentTo) await this.#clearSecretsSentElsewhere(q, actor, [cloneRoot.id]);

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

  /**
   * A second statement rather than a column of the listing's own, as `#attachEffective` is: the
   * listing's keyset query stays the one query it was, and a row whose object went between the
   * two reads simply carries no path rather than a wrong one.
   */
  async #attachPaths(
    items: readonly ObjectSummary[],
    visibility: Visibility,
  ): Promise<ObjectSummary[]> {
    const paths = await this.#repo.paths(
      this.#db,
      items.map((item) => item.id),
      visibility,
    );
    return items.map((item) => {
      const path = paths.get(item.id);
      return path === undefined ? item : { ...item, path };
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

/** How a credential write is asked for (`U-21`). */
/**
 * What storing a set answers (`A-41b`, `A-55`): the set as a read shows it, and what the write
 * did to where it goes. Every count is of the sensors the caller can see, among those that
 * resolve to this set once it is written.
 */
export interface CredentialWriteAnswer extends CredentialView, CredentialWriteCounts {
  /**
   * The same four counts for each reason a sensor is outside (`A-59`), over the same sensors.
   * Each of the four is the sum of its two parts.
   */
  readonly byReason: Readonly<Record<WithheldReason, CredentialWriteCounts>>;
  readonly secretsCleared: readonly string[];
}

/** What a credential write did to which sensors its set's bounds keep it from. */
export interface CredentialWriteCounts {
  /** Sensors the set's bounds keep it from after the write. */
  readonly withholds: number;
  /**
   * Of the same sensors, those a set's bounds kept it from before the write: this set's as it
   * was, or an ancestor's where this write stores the first set here.
   */
  readonly withheldBefore: number;
  /** Sensors the write put outside: withheld after it and not before. */
  readonly newlyWithheld: number;
  /** Sensors the write brought back inside: withheld before it and not after. */
  readonly noLongerWithheld: number;
}

export interface CredentialWriteOptions {
  /** Run it whole and roll it back: the answer, with nothing stored and nothing in the history. */
  readonly preview?: boolean;
  /** What the caller can see, which is what the answer's counts are over. Absent sees everything. */
  readonly visibility?: Visibility;
}

/** What a preview's transaction is failed with: the answer it worked out (`U-21`). */
class Previewed extends Error {
  readonly answer: unknown;

  constructor(answer: unknown) {
    super('a previewed write, rolled back');
    this.name = 'Previewed';
    this.answer = answer;
  }
}

/**
 * A resolved set as a read shows it. One place, so that every answer carrying a set says whether
 * it is bounded by the same rule the delivery and Core Health's count use (`A-41b`).
 */
function credentialViewOf(row: ResolvedCredential): CredentialView {
  return {
    kind: row.kind,
    publicParams: row.publicParams,
    source: row.source,
    updatedAt: row.updatedAt,
    bounded: isRestricted(restrictionOf(row.kind, row.publicParams)),
  };
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
