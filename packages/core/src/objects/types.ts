import type { CredentialKind, ResolvedSetting, SettingSource } from '../settings/inheritance.js';
import type { ChannelLimits } from '../state/limits.js';
import type { SensorState } from '../state/tables.js';

export type { ChannelLimits, CredentialKind, ResolvedSetting, SensorState, SettingSource };

export type ObjectKind = 'root' | 'probe' | 'group' | 'device' | 'sensor';
/** Every kind the API can create. The root is seeded by migration 001 and there is only one. */
export type WritableKind = Exclude<ObjectKind, 'root'>;
export type Priority = 1 | 2 | 3 | 4 | 5;
export type IpVersion = 'auto' | 'v4' | 'v6';

/**
 * `object.id` is `bigint`; `pg` hands it back as a string and the repository narrows at its
 * edge. Safe below 2^53 — at a million objects a day that is roughly 24,000 years.
 */
export type ObjectId = number;

export interface ObjectRef {
  readonly id: ObjectId;
  readonly kind: ObjectKind;
  readonly name: string;
}

interface ObjectBase {
  readonly id: ObjectId;
  readonly name: string;
  readonly tags: readonly string[];
  readonly priority: Priority;
  readonly comments: string;
  /** Monotonic and clock-independent — the ETag validator. Bumped by trigger, never by hand. */
  readonly version: number;
  readonly childCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Discriminated on `kind`. A group has no host, so `host?: string` would be a lie the compiler
 * cannot catch (CLAUDE.md: discriminated unions over optional-field soup).
 */
export type ObjectDetail =
  | (ObjectBase & { readonly kind: 'root'; readonly parentId: null })
  | (ObjectBase & {
      readonly kind: 'probe';
      readonly parentId: ObjectId;
      /**
       * The connected probe that owns this branch, or `null` while it is unclaimed.
       *
       * Not a secret and not an access key: it identifies which installation scans this subtree,
       * which is why R-04 can read it and R-01 can still own how one is issued and revoked.
       */
      readonly gid: string | null;
    })
  | (ObjectBase & { readonly kind: 'group'; readonly parentId: ObjectId })
  | (ObjectBase & {
      readonly kind: 'device';
      readonly parentId: ObjectId;
      readonly host: string;
      readonly ipVersion: IpVersion;
    })
  | (ObjectBase & {
      readonly kind: 'sensor';
      readonly parentId: ObjectId;
      readonly sensorType: string;
      /**
       * Never contains a parameter the type marked `writeOnly`. What leaves the repository is
       * unredacted; the object service is the boundary that strips them (P-05).
       */
      readonly params: Readonly<Record<string, unknown>>;
      /**
       * Names of the `writeOnly` parameters that have a value. The values are never here — a
       * form still has to tell "set, hidden" apart from "not set", and `CredentialView` already
       * established that a secret is absent from a read rather than masked in it.
       */
      readonly redactedParams: readonly string[];
    });

export type ObjectOfKind<K extends ObjectKind> = Extract<ObjectDetail, { kind: K }>;

/** The two-hundred-rows-a-page shape. Deliberately narrower than `ObjectDetail`. */
export interface ObjectSummary {
  readonly id: ObjectId;
  readonly parentId: ObjectId | null;
  readonly kind: ObjectKind;
  readonly name: string;
  readonly tags: readonly string[];
  readonly priority: Priority;
  readonly version: number;
  /** An `EXISTS`, not a count: a disclosure triangle needs a boolean. */
  readonly hasChildren: boolean;
  readonly depth?: number;
  readonly host?: string;
  readonly sensorType?: string;
  /**
   * A sensor's current state (`M-02`). Absent on every other kind, and on a sensor that has
   * never reported.
   *
   * On the summary and not on `ObjectDetail`, deliberately. The detail read is conditional —
   * it carries an ETag whose validator is built from configuration versions — and a fact that
   * changes on every scan would either be served stale behind a 304 or force the validator to
   * move once a minute for every sensor, which would also push a fresh configuration to every
   * probe (`R-04` diffs on exactly those versions). Listings are never conditionally cached,
   * so this is where a live fact belongs.
   */
  readonly state?: SensorState;
  /**
   * True when this object is *itself* manually paused (`M-08`).
   *
   * Its own pause, not the effective one: a listing row is cheap because it joins one side
   * table, and resolving each row's ancestor chain would turn a page of two hundred into two
   * hundred walks. A sensor paused by cascade already reads `state: 'paused'`, which is what
   * colours a tree; this is what puts the badge on the device somebody switched off.
   */
  readonly paused?: boolean;
  readonly effective?: Readonly<Record<string, ResolvedSetting>>;
}

/**
 * Everything that happens to a reading before it is judged or shown (`M-07`).
 *
 * Grouped because they are configured together and audited together: the factors and the spike
 * bounds are all numbers in the channel's own unit, and `decimals` is how many of them to show.
 */
export interface ChannelProcessing {
  /** `numeric` columns. Strings on the wire — a JS number would silently lose precision. */
  readonly scaleMul: string;
  readonly scaleDiv: string;
  /** `null` is automatic: as many digits as the value needs and no trailing zeros. */
  readonly decimals: number | null;
  readonly spikeMin: number | null;
  readonly spikeMax: number | null;
}

/**
 * Why an object is paused, and whether this is the one to resume (`M-08`).
 *
 * `resumable` is the field a UI needs and the one a bare `paused` boolean cannot express: a
 * sensor under a paused device is paused, and pressing resume on it must not appear to be an
 * option. `inheritedFrom` is what the button should point at instead.
 */
export interface PauseView {
  readonly objectId: ObjectId;
  readonly paused: boolean;
  readonly resumable: boolean;
  /**
   * A maintenance window that has been scheduled and has not begun (`M-10`).
   *
   * `paused` is false while it is pending — nothing is paused yet — but `resumable` is true,
   * because cancelling a window before it starts is the same action as ending one that has.
   */
  readonly pending: boolean;
  /**
   * Which source is reported, in the order `WORKFLOW.MD §5` evaluates them.
   *
   * Never which source is the *only* one: the four are an independent set, and a sensor held by
   * a schedule and by an operator is held by both. `resumable` is what says whether this object
   * is the one a resume would act on.
   */
  readonly source: 'manual' | 'parent' | 'schedule' | 'dependency' | null;
  readonly pausedAt: string | null;
  /** When it takes effect. Later than `pausedAt` only for a maintenance window (`M-10`). */
  readonly startsAt: string | null;
  /** `null` while paused indefinitely — until a person says otherwise. */
  readonly pausedUntil: string | null;
  readonly message: string;
  readonly actor: { readonly kind: string; readonly label: string | null } | null;
  readonly inheritedFrom: { readonly objectId: ObjectId; readonly name: string } | null;
  /**
   * The schedule in effect here, if any (`M-09`).
   *
   * On the view rather than left to the caller, because "why is this sensor paused" has four
   * possible answers and a view that could only give two of them sent an operator to the state
   * endpoint to find out which. `active` false is the object being paused right now.
   */
  readonly schedule: {
    readonly id: number;
    readonly name: string;
    readonly active: boolean;
    readonly nextChangeAt: string | null;
    /** The object the assignment is on — the one to change to lift it. */
    readonly definedOn: ObjectId;
  } | null;
  /**
   * The master this object depends on, if any (`M-11`).
   *
   * `holding` is the question an operator is really asking — "is this paused because something
   * else is down, and what" — and `masterName` is what makes the answer actionable. A master
   * never holds itself, which is what keeps it scanning while its dependents wait.
   */
  readonly dependency: {
    readonly masterId: ObjectId;
    readonly masterName: string;
    readonly masterState: string;
    readonly holding: boolean;
    /** When the recovery delay releases the dependents, or `null` if none is running. */
    readonly releasesAt: string | null;
    readonly definedOn: ObjectId;
  } | null;
}

/**
 * What acknowledging one object did (`M-13`).
 *
 * Both lists, because acknowledging a device acts on what is Down beneath it and an operator
 * needs to know how many alarms that turned out to be — and which sensors were not Down, since
 * those are the ones that will still alarm.
 */
export interface AcknowledgementView {
  readonly objectId: ObjectId;
  readonly acknowledged: readonly ObjectId[];
  readonly refused: readonly ObjectId[];
  readonly acknowledgedAt: string | null;
  /** `null` is indefinite: until it recovers, or somebody clears it. */
  readonly acknowledgedUntil: string | null;
  readonly message: string;
}

export interface ChannelRecord {
  readonly id: number;
  readonly sensorId: ObjectId;
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly isPrimary: boolean;
  /** `numeric` columns. Strings on the wire — a JS number would silently lose precision. */
  readonly scaleMul: string;
  readonly scaleDiv: string;
  readonly decimals: number | null;
  /**
   * Always the full shape, never what happens to be in the column (`M-04`).
   *
   * Normalising on read is what lets the response schema be strict: a reader never has to ask
   * whether a missing key means "no limit" or "an older row", and the serialiser can drop
   * anything that is not one of the seven fields rather than passing jsonb through untyped.
   */
  readonly limits: ChannelLimits;
  readonly spikeMin: number | null;
  readonly spikeMax: number | null;
  readonly showInGraph: boolean;
  readonly showInTable: boolean;
  /**
   * The lookup that decides this channel's state (`M-06`), or `null`.
   *
   * The id, not the definition: whether this installation has it is a separate question, and
   * `GET /lookups` is where it is answered. A channel naming a lookup nobody loaded is an
   * ordinary situation an operator has to be able to see, not one to hide by omitting the id.
   */
  readonly lookupId: string | null;
}

/** No secret, no key id, no length, no hash. There is no field a secret could occupy. */
export interface CredentialView {
  readonly kind: CredentialKind;
  readonly publicParams: Readonly<Record<string, unknown>>;
  readonly source: SettingSource;
  readonly updatedAt: string;
}

export interface SettingView {
  readonly key: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly effective: { readonly value: unknown; readonly source: SettingSource };
  /**
   * `null` means no override. Distinct from `{ value: 60 }`, which means "overridden to the
   * same value the parent happens to have" — the override toggle is on in one case and off in
   * the other, so these must not collapse into one another.
   */
  readonly own: { readonly value: unknown } | null;
}

// ── inputs ─────────────────────────────────────────────────────────────────────────────────

export type CreateObjectInput =
  | ({
      kind: 'probe';
      parentId: ObjectId;
      name: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    } & ProbeFields)
  | {
      kind: 'group';
      parentId: ObjectId;
      name: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    }
  | {
      kind: 'device';
      parentId: ObjectId;
      name: string;
      host: string;
      ipVersion?: IpVersion;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    }
  | {
      kind: 'sensor';
      parentId: ObjectId;
      name: string;
      sensorType: string;
      params?: Record<string, unknown>;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    };

/** Fields only a `probe` has. Split out because both create and update carry them. */
export interface ProbeFields {
  /** Binds this branch to a connected probe. R-01 replaces setting it by hand with enrolment. */
  gid?: string | null;
}

/**
 * `kind` is required so the JSON-Schema discriminator can pick a branch, and is checked
 * against the stored kind. `parentId` is absent — reparenting is `move`. `sensorType` is
 * absent — a sensor's type is immutable, because changing it would keep the channel rows and
 * their history while the measurement underneath them changed meaning.
 */
export type UpdateObjectInput =
  | {
      kind: 'root' | 'group';
      name?: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    }
  | ({
      kind: 'probe';
      name?: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
    } & ProbeFields)
  | {
      kind: 'device';
      name?: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
      host?: string;
      ipVersion?: IpVersion;
    }
  | {
      kind: 'sensor';
      name?: string;
      tags?: string[];
      priority?: Priority;
      comments?: string;
      params?: Record<string, unknown>;
    };

export interface CloneInput {
  targetParentId?: ObjectId;
  name?: string;
}

export type Precondition = { kind: 'none' } | { kind: 'version'; expected: number };

export type DeleteExpectation = { kind: 'leafOnly' } | { kind: 'exact'; descendants: number };

export interface ObjectFilter {
  readonly parentId?: ObjectId;
  readonly kinds?: readonly ObjectKind[];
  /** Matched case-folded, per CAPABILITIES.MD §1. */
  readonly tags?: readonly string[];
  readonly q?: string;
  readonly host?: string;
  readonly priorityMin?: Priority;
}

/**
 * `manual` is the operator's own arrangement within a parent (S-14), falling back to name for
 * siblings nobody has arranged. It only means anything inside one parent, so a listing that
 * asks for it has to name the parent.
 */
export type ListSort = 'name' | 'id' | 'manual';

/** Where a reorder puts an object among its siblings. */
export type SiblingMove = 'up' | 'down' | 'first' | 'last';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface DecodedCursor {
  readonly v: 1;
  readonly sort: ListSort;
  readonly name: string | null;
  /**
   * The `sort_order` of the last row on the page, for `sort=manual`. Null both for the other
   * sorts and for a row that has never been arranged — which is a position in the ordering, not
   * a missing value, so the keyset predicate has to handle it as one.
   */
  readonly order: number | null;
  readonly id: ObjectId;
}

export interface PageRequest {
  readonly limit: number;
  readonly sort: ListSort;
  readonly cursor: DecodedCursor | null;
}

export interface SubtreeOptions {
  readonly maxDepth: number;
  readonly limit: number;
  readonly kinds?: readonly ObjectKind[];
}

export interface SubtreeResult {
  readonly items: readonly ObjectSummary[];
  readonly truncated: boolean;
}

// ── reports ────────────────────────────────────────────────────────────────────────────────

export interface CountsByKind {
  readonly probe: number;
  readonly group: number;
  readonly device: number;
  readonly sensor: number;
  readonly total: number;
  readonly channels: number;
  readonly credentialSets: number;
}

export interface DeleteReport {
  readonly id: ObjectId;
  readonly kind: ObjectKind;
  readonly name: string;
  readonly deleted: CountsByKind;
  /** The full pre-delete enumeration, handed to the audit sink. Not in the HTTP response. */
  readonly destroyed: readonly ObjectRef[];
}

export interface SettingChange {
  readonly key: string;
  readonly before: ResolvedSetting;
  readonly after: ResolvedSetting;
}

export interface CredentialChange {
  readonly kind: CredentialKind;
  readonly before: 'own' | 'inherited' | 'none';
  readonly after: 'own' | 'inherited' | 'none';
}

export interface MoveResult {
  readonly object: ObjectDetail;
  readonly fromParentId: ObjectId;
  readonly toParentId: ObjectId;
  readonly movedCount: number;
  readonly probeChanged: { from: ObjectRef | null; to: ObjectRef | null } | null;
  readonly settingsChanged: readonly SettingChange[];
  readonly credentialsChanged: readonly CredentialChange[];
}

export interface CloneCounts {
  readonly group: number;
  readonly device: number;
  readonly sensor: number;
  readonly channel: number;
  readonly setting: number;
  readonly total: number;
}

export interface CloneResult {
  readonly object: ObjectDetail;
  readonly clonedCount: CloneCounts;
  /**
   * Kinds only, never values. Says in the 201 why the clone cannot authenticate yet, instead
   * of leaving it to be discovered as a Down sensor twenty minutes later.
   */
  readonly droppedCredentialKinds: readonly CredentialKind[];
  readonly settingsChanged: readonly SettingChange[];
}
