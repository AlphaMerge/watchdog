/**
 * The shapes this UI reads, mirrored from the core's response schemas.
 *
 * Hand-written rather than generated: the core already publishes OpenAPI at
 * `/api/v1/openapi.json`, and generating from it is worth doing once the surface stops moving.
 * Until then a generator would be one more thing to run before every change, and these are the
 * six shapes the whole app uses.
 */

export type ObjectKind = 'root' | 'probe' | 'group' | 'device' | 'sensor';

/**
 * The six v1 states of `WORKFLOW.MD` §4, plus the two `[V2]` ones the type must accommodate.
 *
 * Spelled exactly as the database enum and the wire spell them. A hyphenated variant here would
 * mean a translation on every read, and the failure mode of a missed translation is a state
 * that silently matches nothing.
 */
export type SensorState =
  | 'up'
  | 'warning'
  | 'down'
  | 'down_acknowledged'
  | 'paused'
  | 'unknown'
  | 'unusual'
  | 'down_partial';

export interface ObjectSummary {
  id: number;
  parentId: number | null;
  kind: ObjectKind;
  name: string;
  tags: string[];
  priority: number;
  version: number;
  hasChildren: boolean;
  depth?: number;
  host?: string;
  sensorType?: string;
  /** A sensor's current state (`M-02`). Absent on other kinds, and before the first result. */
  state?: SensorState;
  /** True when this object is itself manually paused (`M-08`), not when an ancestor is. */
  paused?: boolean;
}

export interface ObjectDetail extends ObjectSummary {
  comments: string;
  /**
   * Whether triggers defined above this object reach it (`N-16`).
   *
   * Worth surfacing because switching it off is silent otherwise: the triggers tab would simply
   * show fewer rows, with nothing saying why.
   */
  inheritsTriggers: boolean;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  ipVersion?: string;
  params?: Record<string, unknown>;
  /** Names of `writeOnly` parameters that hold a value. Never the values (P-05). */
  redactedParams?: string[];
}

export interface TreePage {
  items: ObjectSummary[];
  truncated: boolean;
}

export interface ObjectPage {
  items: ObjectSummary[];
  nextCursor: string | null;
}

export interface SensorTypeSummary {
  id: string;
  category: string;
  costHint: 'light' | 'medium' | 'heavy';
  paramsSchema: Record<string, unknown>;
}

export interface ChannelRecord {
  id: number;
  key: string;
  name: string;
  unit: string;
  isPrimary: boolean;
  limits: ChannelLimits;
  /** `numeric` columns: strings on the wire, so a factor round-trips exactly as typed. */
  scaleMul: string;
  scaleDiv: string;
  /** `null` is automatic: as many digits as the value needs, no trailing zeros. */
  decimals: number | null;
  spikeMin: number | null;
  spikeMax: number | null;
  /**
   * The lookup that decides this channel's state (`M-06`), or `null`.
   *
   * The id, not the definition. Whether this installation has it is a separate question, and
   * `GET /lookups` answers it — a channel naming one nobody loaded is a situation an operator
   * has to be able to see.
   */
  lookupId: string | null;
}

/** One entry in `GET /lookups`. */
export interface LookupSummary {
  id: string;
  name: string;
  type: 'singleInt' | 'range';
  undefinedState: SensorState;
  entryCount: number;
  overridesBuiltIn?: boolean;
  source: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  objectId: number;
  objectKind: ObjectKind | null;
  actor: { kind: string; label?: string };
  summary: Record<string, unknown>;
  diff: { field: string; before: unknown; after: unknown }[];
}

export interface AuditPage {
  items: AuditEntry[];
  nextBefore: string | null;
}

/** A dense series. `null` is a gap and must stay one — never draw it as zero (CLAUDE.md). */
export interface HistoryChannel {
  id: number;
  key: string;
  name: string;
  unit: string;
  /** Display precision, or `null` for automatic — the chart axis and the table honour it. */
  decimals: number | null;
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  count: (number | null)[];
}

/** What the query rules changed about the request, and why (`S-08`). */
export interface QueryAdjustment {
  kind: 'range-shortened' | 'resolution-coarsened';
  reason: string;
}

export interface HistorySeries {
  sensorId: number;
  from: string;
  to: string;
  resolutionSeconds: number;
  bucketCount: number;
  /** Which table served the bulk of the range. */
  source: string;
  buckets: string[];
  channels: HistoryChannel[];
  /** More than one entry means a rollup was behind and the tail came from below it. */
  segments: { table: string; from: string; to: string }[];
  /**
   * Shown, not swallowed. A 365-day range silently averaged over an hour looks like a sensor
   * that stopped fluctuating, and an operator has no way to tell that from the picture.
   */
  adjustments: QueryAdjustment[];
}

/** `GET /objects/:id/pause` — why an object is paused, and whether this is the one to resume. */
export interface PauseView {
  objectId: number;
  paused: boolean;
  /**
   * Whether *this* object can be resumed. A sensor under a paused device is paused and not
   * resumable, and offering the button anyway would be offering something that does not work.
   */
  resumable: boolean;
  source: 'manual' | 'parent' | null;
  pausedAt: string | null;
  /** `null` while paused indefinitely — until a person says otherwise. */
  pausedUntil: string | null;
  message: string;
  actor: { kind: string; label: string | null } | null;
  inheritedFrom: { objectId: number; name: string } | null;
}

/** `GET /sensors/:id/state` — the whole answer for one sensor (`M-02`). */
/**
 * One inheritable setting, resolved (`S-04`).
 *
 * `source` is the half that matters in a UI: "60 seconds" is not the same fact as "60 seconds,
 * because the group two levels up says so", and an operator changing the wrong object is what
 * happens when only the value is shown.
 */
export interface SettingView {
  key: string;
  description: string;
  effective: {
    value: unknown;
    source:
      | { kind: 'own'; objectId: number }
      | { kind: 'inherited'; objectId: number; depth: number }
      | { kind: 'default' };
  };
  own: { value: unknown } | null;
}

/** A channel's thresholds (`M-04`). `null` in a threshold means it is not set. */
export interface ChannelLimits {
  enabled: boolean;
  upperError: number | null;
  upperWarning: number | null;
  lowerWarning: number | null;
  lowerError: number | null;
  errorMessage: string;
  warningMessage: string;
}

export interface SensorStateView {
  sensorId: number;
  state: SensorState;
  cause: string;
  message: string;
  since: string;
  lastResultAt: string | null;
  consecutiveFailures: number;
  /**
   * Every pause source holding this sensor, not only the one `cause` names. The four are an
   * independent set: clearing the reported one does not necessarily resume it.
   */
  pausedBy: ('parent' | 'dependency' | 'schedule' | 'manual')[];
  acknowledged: boolean;
  acknowledgedUntil?: string | null;
  simulatedError: boolean;
}

/** `GET /sensors/:id/values` — what each channel reads *now* (`U-04`). */
export interface ChannelValue {
  id: number;
  key: string;
  name: string;
  unit: string;
  decimals: number | null;
  /**
   * `null` is "nothing recent", and it is not a zero.
   *
   * The core withholds a reading older than three scan intervals rather than dressing it as
   * current, so this null carries real information: the channel has stopped reporting.
   */
  value: number | null;
  at: string | null;
}

export interface SensorValues {
  sensorId: number;
  readAt: string;
  notBefore: string;
  /** The interval the window was derived from, so "no recent reading" can say how recent. */
  intervalSeconds: number;
  channels: ChannelValue[];
}

/**
 * One trigger in effect on an object (`N-01`).
 *
 * `inherited` and `definedOn` are the two halves a UI has to show together: a trigger can only
 * be edited where it is defined, and an inherited one does *not* displace a nearer one — both
 * fire. That is the opposite of how an inherited setting behaves, so saying which is which is
 * not decoration.
 */
export interface TriggerView {
  id: number;
  kind: string;
  kindName: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  summary: string;
  inherited: boolean;
  definedOn: { objectId: number; name: string };
  createdAt: string;
  updatedAt: string;
}

/** One state transition (`M-15`). */
export interface StateLogEntry {
  at: string;
  sensorId: number;
  sensorName: string;
  state: SensorState;
  previousState: SensorState | null;
  cause: string;
  message: string;
  /** How long the *previous* state lasted. `null` on the newest entry — it has not ended. */
  durationMs: number | null;
}

export interface StateLogPage {
  items: StateLogEntry[];
  nextBefore: string | null;
}

/** `GET /objects/:id/ancestors` — root first, the object's parent last. */
export interface AncestorsView {
  items: { id: number; kind: ObjectKind; name: string }[];
}
