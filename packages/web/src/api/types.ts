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
}

export interface ObjectDetail extends ObjectSummary {
  comments: string;
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
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  count: (number | null)[];
}

export interface HistorySeries {
  from: string;
  to: string;
  resolutionSeconds: number;
  bucketCount: number;
  buckets: string[];
  channels: HistoryChannel[];
  segments: { table: string; from: string; to: string }[];
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
