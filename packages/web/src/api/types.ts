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
  /** Ancestors, root first — only from a listing asked for `include=path` (`P-214`). */
  path?: ObjectRef[];
}

/** An object named rather than described: an ancestor, a breadcrumb step. */
export interface ObjectRef {
  id: number;
  kind: ObjectKind;
  name: string;
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
  /**
   * A device's own addresses its probe may connect to although its target policy refuses them
   * (`A-64`). Absent when it has none, and on everything but a device.
   */
  targetPolicyException?: string[];
  /**
   * On an edit's reply only (`U-36`): the channels whose lookup the edit left as it was, because
   * the sensor's type could not say what its stored parameters declared (`P-311`). Absent when
   * there were none, and on every read.
   */
  lookupsKept?: string[];
}

export interface TreePage {
  items: ObjectSummary[];
  truncated: boolean;
}

/**
 * Exact totals for a subtree, from `GET /objects/{id}/counts`.
 *
 * Not derivable from a `TreePage`: that one is capped, and counting a capped read is how the
 * overview came to report 930 sensors on a system running five thousand. Anything that renders
 * a number rather than rows asks for this instead.
 */
export interface SubtreeCounts {
  objects: {
    probe: number;
    group: number;
    device: number;
    sensor: number;
    /** Every object in the subtree, the one asked about included — so the root counts itself. */
    total: number;
  };
  /** Every state, zeros included; the values sum to `objects.sensor`. */
  sensorStates: Record<SensorState, number>;
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
  /**
   * Whether this type can dry-run its parameters' paths against a pasted response (`U-13`).
   *
   * Read rather than matched on the id: `if (type === 'rest.custom')` here would mean editing
   * this file for every type with a mapping language added after it.
   */
  hasPreview: boolean;
  /** The probe listener that feeds this type, where one does (`B-08`). */
  listener?: string;
}

/**
 * `GET /probes/:id/health` — Probe Health's channels, read live.
 *
 * A `null` is a gap, never a zero: a probe that is not connected has one in every channel but
 * `connected`, and a listener that is off has one in each of its counters.
 */
export interface ProbeHealthView {
  at: string;
  probeId: number;
  message: string;
  /**
   * Why the probe's own numbers are gaps, or `null` when it reported them (`P-255`).
   *
   * Only `protocol` is about versions; a probe that has connected and not yet sent a heartbeat is
   * `no-heartbeat`, whatever it speaks.
   */
  numbersUnavailable:
    | { reason: 'not-connected' }
    | { reason: 'protocol'; protocolVersion: number; requiredVersion: number }
    | { reason: 'no-heartbeat'; connectedSeconds: number }
    | { reason: 'not-reported' }
    | null;
  /**
   * The protocol version the probe speaks on its current connection, or `null` when it is not
   * connected (`U-30`). A probe that reports, below the version a listener's counters arrived in,
   * leaves them out whether the listener runs or not.
   */
  protocolVersion: number | null;
  /**
   * The protocol version the probe declared at the last handshake the core recorded, kept after
   * it disconnects (`U-31`): the version `GET /probes` shows an administrator. `null` when none is
   * recorded, or when the core could not read it. Said of the last connection, not of the probe
   * now: it may have been upgraded since.
   */
  lastProtocolVersion: number | null;
  /**
   * When a handshake the core accepted spoke `lastProtocolVersion`, as ISO 8601 (`U-32`). Not
   * when the probe was last seen: a refused hello moves that too. `null` whenever
   * `lastProtocolVersion` is, beside a version a hello was refused over, and for one recorded
   * before the core kept the time. Beside a version this build refuses, that is the refusal, and
   * the form says so rather than "when it last connected" (`U-33`).
   */
  lastProtocolVersionAt: string | null;
  /**
   * When a hello was last refused over `lastProtocolVersion`, as ISO 8601 (`U-35`): the probe has
   * not connected since. Never beside `lastProtocolVersionAt`; `null` beside an accepted version,
   * for one recorded before the core kept the time, and whenever `lastProtocolVersion` is. A
   * `lastProtocolVersion` of 0 comes only with it: a 0 without it is nothing recorded, and is
   * served as `null`.
   */
  lastProtocolRefusedAt: string | null;
  channels: Record<string, number | null>;
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
  /**
   * The lookup the sensor's type declares for this channel (`U-82`), or `null`. The channel table
   * offers it first when a lookup is set: a channel created before its type declared one, or one
   * somebody cleared, has none.
   */
  declaredLookup: string | null;
  /**
   * Nothing will read this channel again (`P-310`): an edit took its key out of the sensor's
   * parameters, and its type reports no channel it does not declare. History kept. `false` also
   * where the core cannot say, so never read it as "being read".
   */
  retired: boolean;
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

/**
 * Who did it — the same discriminated union the API sends, field for field.
 *
 * **Typed as the union rather than flattened to `{ kind, label }`**, which is what this was before
 * `A-08`. The flat shape had no `label` on the wire at all, so every entry in the UI was attributed
 * to "user" or "anonymous" — the login and the address were both in the response and both thrown
 * away. A union cannot be read wrongly in that silent way: the field that names the actor differs
 * per kind, so the compiler makes you say which kind you are looking at.
 */
export type AuditActor =
  | { kind: 'user'; userId: number; login: string }
  | { kind: 'token'; tokenId: number }
  | { kind: 'system'; component: string }
  | { kind: 'anonymous'; remoteAddress: string };

export interface AuditEntry {
  /**
   * `bigint`, so a string on the wire — a JS number stops being exact at 2^53, and this is also
   * the paging cursor, so a rounded one would page to the wrong place.
   */
  id: string;
  at: string;
  action: string;
  /**
   * `null` on an entry about something that was never an object — a schedule, a template.
   *
   * Not null merely because the object was deleted: the audit log has no foreign key precisely
   * so a deletion's own entry survives its subject (`S-10`), and that entry keeps the id.
   */
  objectId: number | null;
  objectKind: ObjectKind | null;
  actor: AuditActor;
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

/**
 * A credential set in force for an object (`A-05`, `U-21`).
 *
 * **There is no field a secret could occupy.** `publicParams` is the half its kind does not mark
 * `writeOnly`, and `secretsSet` is names. The core returns a secret to nobody, so nothing here
 * could show one if it tried.
 */
export interface CredentialView {
  kind: string;
  publicParams: Record<string, unknown>;
  /** Where it is stored: this object, or an ancestor. Never `default`. */
  source: SettingSource;
  updatedAt: string;
  /**
   * Whether allowed targets, or an SSH set's host keys, bound where it goes (`A-41b`). The core
   * says so rather than this UI working it out: the rule has an exception and lives in one place.
   */
  bounded: boolean;
  /** Names of the secrets that hold a value. Only on a set stored on the object asked about. */
  secretsSet?: string[];
}

/** The four counts a credential write answers, whole or for one reason (`A-55`, `A-59`). */
export interface CredentialWriteCounts {
  /** Sensors beneath that are outside its bounds now: not sent it, and read Unknown. */
  withholds: number;
  /** Of the sensors the set reaches now, those a set's bounds kept it from before the write. */
  withheldBefore: number;
  /** Sensors this write puts outside: outside after it and not before (`A-55`). */
  newlyWithheld: number;
  /** Sensors this write brings back inside: outside before it and not after. */
  noLongerWithheld: number;
}

/** What storing a set answers (`A-41b`), and what `?dryRun=true` answers without storing it. */
export interface CredentialWrite extends CredentialView, CredentialWriteCounts {
  /**
   * The same four, for each of the two reasons a sensor is outside (`A-59`), and each adding up
   * to its total: `outside` is a device whose address or name the targets do not cover, and
   * `unpinnable` a device entered by name, facing targets that are addresses, whose sensor type
   * cannot be held to an address its probe checked. Like the totals, over the sensors the
   * caller can see.
   */
  byReason: { outside: CredentialWriteCounts; unpinnable: CredentialWriteCounts };
  /** Secrets the write cleared because it widened where the set may go and did not send them. */
  secretsCleared: string[];
}

/** What removing a set answers, and what `?dryRun=true` answers with the set left in place. */
export interface CredentialRemoval {
  kind: string;
  removed: boolean;
  /** Sensors at or beneath the object that were using the set removed. */
  sensors: number;
  /** The ancestor's set that comes into force, or null when nothing above defines one. */
  nowInherited: CredentialView | null;
}

/** One kind from `GET /credential-kinds`: its name, and the schema its form is generated from. */
export interface CredentialKindSummary {
  id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** One row of `GET /credentials/unbounded`: a set with no bounds, and the object it is on. */
export interface UnboundedCredential {
  objectId: number;
  objectKind: ObjectKind;
  objectName: string;
  kind: string;
  updatedAt: string;
}

/** One row of `GET /channels/without-lookup` (`P-308`). */
export interface ChannelWithoutLookup {
  sensorId: number;
  sensorName: string;
  sensorType: string;
  key: string;
  channelName: string;
  declaredLookup: string;
}

/** `GET /channels/without-lookup`: the first thousand, every one counted, and the unjudged. */
export interface ChannelsWithoutLookup {
  items: ChannelWithoutLookup[];
  total: number;
  unanswered: number;
}

/** As much of `GET /objects/:id/access/effective` as a view reads: what this account may do. */
export interface EffectiveAccess {
  right: 'none' | 'read' | 'write' | 'full';
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
  /** `name` is null when this account cannot see the object the pause comes from (`A-12`). */
  inheritedFrom: { objectId: number; name: string | null } | null;
}

/** `GET /sensors/:id/state` — the whole answer for one sensor (`M-02`). */
/**
 * One inheritable setting, resolved (`S-04`).
 *
 * `source` is the half that matters in a UI: "60 seconds" is not the same fact as "60 seconds,
 * because the group two levels up says so", and an operator changing the wrong object is what
 * happens when only the value is shown.
 */
export type SettingSource =
  | { kind: 'own'; objectId: number }
  | { kind: 'inherited'; objectId: number; depth: number }
  | { kind: 'default' };

export interface SettingView {
  key: string;
  description: string;
  /** The setting's own JSON Schema, which is what its control is generated from (`U-08`). */
  schema: Record<string, unknown>;
  effective: { value: unknown; source: SettingSource };
  /**
   * What this setting would resolve to with the local override discarded (`U-09`).
   *
   * Equal to `effective` when there is no override, and different exactly when there is — which
   * is what lets the toggle say what reverting will do without doing it.
   */
  inherited: { value: unknown; source: SettingSource };
  /**
   * `null` means no override. Distinct from `{ value: 60 }` meaning "overridden to the same
   * value the parent happens to have" — the toggle is on in one case and off in the other.
   */
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

/**
 * Where a failed check failed, as the probe named it (`P-285`): a phase, and the plain host it was
 * acting on when it named one. `null` beside it wherever nothing was named, or where the state is
 * not the check's to explain.
 */
export interface CheckFailure {
  readonly phase: string;
  readonly target?: string;
}

export interface SensorStateView {
  sensorId: number;
  state: SensorState;
  cause: string;
  message: string;
  failure: CheckFailure | null;
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
  /** The channel list's `retired` (`ChannelRecord.retired`), from the same derivation (`U-38`). */
  retired: boolean;
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
  /** `name` is null when this account cannot see the object it is defined on (`A-12`). */
  definedOn: { objectId: number; name: string | null };
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
  /** Where the check behind this transition failed (`P-285`), or `null`. */
  failure: CheckFailure | null;
  /** How long the *previous* state lasted. `null` on the newest entry — it has not ended. */
  durationMs: number | null;
  /**
   * True on a row retention wrote to carry a state past its horizon, not on a transition
   * (`S-15`). Nothing changed at this instant — it is the floor of the history rather than its
   * beginning.
   */
  carried: boolean;
}

export interface StateLogPage {
  items: StateLogEntry[];
  nextBefore: string | null;
}

/** `GET /objects/:id/ancestors` — root first, the object's parent last. */
export interface AncestorsView {
  items: ObjectRef[];
}

/**
 * One sensor in an alarm state (`U-06`).
 *
 * The five states `WORKFLOW.MD §7` names, and only those: paused is deliberate silence and
 * unknown is a gap in coverage, and reporting either as a fault is how a list becomes one an
 * operator scrolls past.
 */
export interface Alarm {
  sensorId: number;
  sensorName: string;
  state: SensorState;
  cause: string;
  message: string;
  /** When the sensor entered this state. The duration is `now - since`. */
  since: string;
  /** 1 (lowest) to 5 (highest). */
  priority: number;
  /** Root first, sensor last — ids and names in step, so each step can be a link. */
  path: number[];
  pathNames: string[];
  acknowledged: boolean;
  acknowledgedUntil: string | null;
  consecutiveFailures: number;
  /**
   * The return its alarm is holding (`M-18`), or `null`. A sensor that is back and listed for this
   * alone is Up; one back only as far as Warning is listed as Warning with this beside it.
   */
  recovering: HeldReturn | null;
}

/** A return to Up that has not yet lasted its hold (`M-18`). */
export interface HeldReturn {
  since: string;
  /** When the alarm is over if the sensor does not fail again, on the core's clock. */
  confirmsAt: string | null;
}

/** What the list's chips sort rows into: the alarm states, and a held return (`M-18`). */
export type AlarmKind = SensorState | 'recovering';

export interface AlarmPage {
  items: Alarm[];
  /** How many matched before the limit, so a truncated list can say what it is not showing. */
  total: number;
  /** Per kind across the whole scope, ignoring the state filter — the chips' own numbers. */
  counts: Partial<Record<AlarmKind, number>>;
  /** The core's clock when the page was read — what a held return's `confirmsAt` is measured on. */
  now: string;
}

/** One notification the dispatcher handled (`N-13`), for the Logs view's system-events third. */
export interface NotificationRequestView {
  id: number;
  at: string;
  sensorId: number;
  sensorName: string | null;
  templateId: number | null;
  templateName: string | null;
  method: string | null;
  triggerKind: string | null;
  reason: string | null;
  state: SensorState | null;
  message: string;
  /**
   * `failed` is an alarm nobody received; `discarded` is one nobody was meant to receive any
   * more — thrown away by an activation schedule (`N-12`), or a recovery or clear a newer
   * delivered alarm overtook (`N-22`). Not the same thing, and a log that conflated them would
   * hide the first.
   */
  status: string;
  disposition: string | null;
  attempts: number;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Who a sent message named and did not reach, and why; empty when it reached everybody. */
  skippedRecipients: string;
}

export interface NotificationRequestPage {
  items: NotificationRequestView[];
  nextBefore: number | null;
}

// ── notifications (U-10) ────────────────────────────────────────────────────────────────────

export interface NotificationMethod {
  id: string;
  name: string;
  description: string;
  /** The JSON Schema the settings form is generated from, `writeOnly` marking the secrets. */
  settingsSchema: Record<string, unknown>;
  /** False for a method that addresses itself — a webhook has a URL, not a recipient list. */
  usesRecipients: boolean;
  /** False for a method a digest makes no sense for. */
  summarisable: boolean;
}

export interface TemplateRecipient {
  kind: 'address' | 'user' | 'userGroup';
  /** An address, or for a user or a group its id as decimal digits (`M-19`). */
  value: string;
}

/** One account as `GET /accounts` lists it for choosing (`M-20`): nothing a picker does not need. */
export interface AccountChoice {
  id: number;
  login: string;
  displayName: string;
  /** Skipped when a notification is sent. */
  disabled: boolean;
  /** Whether a message to this account has anywhere to go. */
  hasAddress: boolean;
}

/** One user group as `GET /groups` lists it. */
export interface UserGroupView {
  id: number;
  name: string;
  description: string;
  isAdmin: boolean;
  isDefault: boolean;
  isBuiltin: boolean;
  memberCount: number;
}

export interface TemplateView {
  id: number;
  name: string;
  description: string;
  method: string;
  methodName: string;
  /** Minus anything `writeOnly` — the API never returns those (`N-05`). */
  settings: Record<string, unknown>;
  redactedSettings: string[];
  subject: string;
  body: string;
  recipients: TemplateRecipient[];
  priority: number;
  enabled: boolean;
  summary: string;
  summarisable: boolean;
  summarisation: string;
  summaryWindowSeconds: number;
  scheduleId: number | null;
  scheduleName: string | null;
  whenInactive: string;
  createdAt: string;
  updatedAt: string;
}

/** What a template is written as. A secret it does not carry is kept; `null` clears one. */
export interface TemplateInput {
  name: string;
  description?: string;
  method: string;
  settings: Record<string, unknown>;
  subject?: string;
  body?: string;
  recipients?: TemplateRecipient[];
  priority?: number;
  enabled?: boolean;
  summarisation?: string;
  summaryWindowSeconds?: number;
  scheduleId?: number | null;
  whenInactive?: string;
}

export interface TemplatePreview {
  /** `null` for a draft that has never been saved. */
  templateId: number | null;
  sensorId: number;
  subject: string;
  body: string;
  unknown: string[];
}

export interface TemplateTestResult {
  templateId: number;
  templateName: string;
  method: string;
  methodName: string;
  sensorId: number | null;
  sensorName: string;
  subject: string;
  body: string;
  recipients: TemplateRecipient[];
  unknownPlaceholders: string[];
  delivered: boolean;
  detail: string;
  error: string | null;
  retryable: boolean;
  durationMs: number;
  /**
   * What a green test does not prove.
   *
   * `N-14` collects these deliberately: a template that is switched off, outside its activation
   * schedule, or summarised into a digest can deliver a test and still never deliver an alarm.
   */
  notes: string[];
}

export interface PlaceholderInfo {
  name: string;
  description: string;
}

export interface SummarisationMode {
  id: string;
  description: string;
}

export interface ScheduleSummary {
  id: number;
  name: string;
  description: string;
}

/** One trigger kind this build understands (`N-01`). */
export interface TriggerKind {
  id: string;
  name: string;
  description: string;
  settingsSchema: Record<string, unknown>;
}

// ── Discovery (`D-01` … `D-10`) ───────────────────────────────────────────────────────────────

export type DiscoveryLevel = 'ping' | 'standard' | 'detailed';

export type DiscoveryStatus =
  'queued' | 'running' | 'identifying' | 'done' | 'cancelled' | 'failed';

/** One level, and what it would cost on the range that was previewed (`D-06`). */
export interface DiscoveryLevelEstimate {
  id: DiscoveryLevel;
  name: string;
  description: string;
  /**
   * The bracket, not a guess.
   *
   * The two halves of a run pull in opposite directions — an address that answers nothing costs
   * a full sweep timeout, one that answers costs almost nothing there and then has to be
   * identified — so the cost is linear in the fraction alive and these two endpoints contain
   * every possible outcome. Showing one number would mean picking a hit rate nobody knows.
   */
  minSeconds: number;
  maxSeconds: number;
  ports: number;
}

export interface DiscoveryPreview {
  range: string;
  total: number;
  levels: DiscoveryLevelEstimate[];
}

export interface DiscoveryRun {
  id: number;
  groupId: number;
  /** Absent for a reader who cannot see the probe (`A-80`). */
  probeId?: number;
  range: string;
  total: number;
  cursor: number;
  found: number;
  failed: number;
  status: DiscoveryStatus;
  level: DiscoveryLevel;
  templates: string[];
  identified: number;
  identifyCursor: number;
  scheduleId: number | null;
  snmpCommunity: string;
  devicesCreated: number;
  devicesMatched: number;
  sensorsCreated: number;
  provisionedAt: string | null;
  message: string;
  timeoutMs: number;
  concurrency: number;
  ratePerSecond: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What a run did, in one object (`D-08`). */
export interface DiscoverySummary {
  runId: number;
  groupId: number;
  /** Absent for a reader who cannot see the probe (`A-80`). */
  probeId?: number;
  scheduleId: number | null;
  range: string;
  level: DiscoveryLevel;
  status: DiscoveryStatus;
  headline: string;
  scanned: {
    addresses: number;
    swept: number;
    alive: number;
    unreachable: number;
    failed: number;
    identified: number;
    complete: boolean;
  };
  found: {
    byKind: { kind: string; count: number }[];
    byVendor: { vendor: string; count: number }[];
  };
  created: {
    devices: number;
    matched: number;
    sensors: number;
    provisionedAt: string | null;
  };
  errors: { address: string; problem: string }[];
  timing: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    addressesPerSecond: number | null;
  };
}

export type RediscoveryCadence = 'hourly' | 'daily' | 'weekly';

/**
 * A rediscovery rule (`D-07`, `D-11`): a stencil for runs, fired on a cadence.
 *
 * No `snmpCommunity`: it is a credential, and the core never returns one (`P-55`). An edit
 * that leaves it out keeps the stored one.
 */
export interface RediscoveryRule {
  id: number;
  groupId: number;
  /** Absent for a reader who cannot see the probe (`A-80`). */
  probeId?: number;
  name: string;
  enabled: boolean;
  range: string;
  level: DiscoveryLevel;
  templates: string[];
  timeoutMs: number;
  concurrency: number;
  ratePerSecond: number;
  cadence: RediscoveryCadence;
  /** Past the hour for `hourly`, past midnight otherwise. */
  cadenceMinute: number;
  /** 0 is Monday. Read only for `weekly`. */
  cadenceWeekday: number;
  timezone: string | null;
  autoProvision: boolean;
  /** An `M-09` schedule used as a permission window, or null. */
  scheduleId: number | null;
  lastRunAt: string | null;
  lastRunId: number | null;
  /** Why the last firing started nothing, or empty (`A-28`). */
  lastProblem: string;
  nextRunAt: string | null;
  /** `every Sunday at 03:00`, in the core's words. */
  description: string;
  /** What `If-Match` carries back on an edit. */
  version: number;
}

export interface DeviceTemplateSummary {
  id: string;
  name: string;
  description: string;
  sensorCount: number;
  overridesBuiltIn?: boolean;
  /** `built-in`, or the file an operator's own template came from (`D-03`). */
  source: string;
}

/** A template that would not load. Reported rather than hidden — see `D-03`. */
export interface DeviceTemplateProblem {
  id: string;
  source: string;
  problems: string[];
}

/** A map, as `GET /maps` and `GET /maps/:id` return it (`G-01`). */
export interface MapSummary {
  id: number;
  name: string;
  description: string;
  priority: number;
  /** The canvas document. Read with `readCanvas` — it is `jsonb` and only the core validates it. */
  layout: Record<string, unknown>;
  /**
   * What `If-Match` has to carry on the next save.
   *
   * A designer is a thing two people open at once, and the core refuses a `PATCH` without it
   * rather than letting the second save quietly discard the first (`G-01`).
   */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A widget with its data filled in, from `GET /maps/:id/view` (`G-02`, `G-10`). */
export type ResolvedWidget = {
  id: string;
  kind: 'status' | 'sensor-list' | 'table' | 'graph' | 'html';
  box: { x: number; y: number; w: number; h: number };
  /** Present when the widget is placed on the ground rather than on the grid (`G-08`). */
  at?: { lat: number; lon: number };
  title: string;
} & (
  | { state: 'ok'; data: ResolvedWidgetData }
  | {
      /**
       * **And not why, to anybody.** "Deleted" against "you may not see it" says whether an id is
       * still alive; it was told to a map's `full` holders, and every map's creator is one, so it
       * answered that for any id anybody chose (`A-15`).
       */
      state: 'unavailable';
    }
  | { state: 'invalid'; problem: string }
);

export interface ResolvedChannel {
  key: string;
  name: string;
  unit: string;
  /** `null` is a gap, never a zero — the sensor recorded nothing inside its staleness window. */
  value: number | null;
}

export type ResolvedWidgetData =
  | {
      kind: 'status';
      objectId: number;
      name: string;
      sensorState: string;
      message: string;
      since: string;
    }
  | {
      kind: 'sensor-list';
      objectId: number;
      name: string;
      sensors: { id: number; name: string; sensorState: string; message: string }[];
    }
  | { kind: 'table'; objectId: number; name: string; channels: ResolvedChannel[] }
  | {
      kind: 'graph';
      objectId: number;
      name: string;
      sensorState: string;
      rangeMinutes: number;
      channels: ResolvedChannel[];
    }
  /** Markup an operator typed, rendered in a sandboxed frame and nowhere else (`G-07`). */
  | { kind: 'html'; html: string };

/** A line between two widgets on a map (`G-05`). Endpoints are widget ids, not object ids. */
export interface ResolvedConnector {
  id: string;
  from: string;
  to: string;
}

/**
 * A map's geographical block: where it opens, and whether a share link may draw tiles (`G-08`).
 *
 * **Not the same type as the renderer's `GeoView`**, which is a viewport — a place and a zoom.
 * This is the document, and `publicTiles` is a property of the map rather than of where somebody
 * is looking; conflating them is how a pan ends up deciding what a stranger can see.
 */
export interface MapGeo {
  lat: number;
  lon: number;
  zoom: number;
  publicTiles: boolean;
}

/** What an operator configured, or `null` when nothing is (`ADR-004` Decision 1). */
export interface TileSource {
  urlTemplate: string;
  attribution: string;
}

export interface ResolvedMap {
  map: MapSummary;
  widgets: ResolvedWidget[];
  connectors: ResolvedConnector[];
  geo: MapGeo | null;
  tiles: TileSource | null;
  /** Widgets whose document could not be read at all, kept rather than dropped. */
  problems: { id: string; problem: string }[];
}

/** A public share link on a map (`G-06`). The token is not here and cannot be. */
export interface MapShare {
  id: number;
  label: string;
  /** The first characters of the token, so a list is readable. Never enough to use. */
  prefix: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string;
}

/** What `GET /public/maps/:token` answers — no map id, no version, no access rules. */
export interface SharedMap {
  name: string;
  description?: string;
  widgets: ResolvedWidget[];
  connectors: ResolvedConnector[];
  geo: MapGeo | null;
  /** Null unless this map's author opted in to tiles for strangers (`ADR-004` Decision 4). */
  tiles: TileSource | null;
  problems: { id: string; problem: string }[];
  hasBackground: boolean;
}

/* ------------------------------------------------------------------------- reports */

/** The seven templates `§6` lists, as migration 047 spells them (`E-01`). */
export type ReportKind =
  | 'graph_and_table'
  | 'table_only'
  | 'graph_only'
  | 'sensor_list'
  | 'installation'
  | 'top_values'
  | 'top_uptime';

export type ReportFrequency =
  'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface ReportSpan {
  kind: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
  offset?: number;
  timezone?: string;
  from?: string;
  to?: string;
  resolutionSeconds?: number;
}

export interface ReportSchedule {
  kind: ReportFrequency;
  minute?: number;
  weekday?: number;
  dayOfMonth?: number;
  month?: number;
  timezone?: string;
  scheduleId?: number;
}

export interface ReportOutputs {
  formats: ('html' | 'csv' | 'xml' | 'pdf')[];
  delivery: 'store' | 'store-and-email' | 'email';
  recipients: string[];
  zip: boolean;
}

/**
 * What a report's span works out to right now (`E-02`).
 *
 * Computed per request rather than stored, because "last month" is a different fortnight every
 * month. Absent when the span cannot resolve at all — see `unresolvable`.
 */
export interface ResolvedSpan {
  from: string;
  to: string;
  label: string;
  timezone: string;
  bucketSeconds: number;
  /** Which rollup tier will answer — the visible consequence of the averaging rule. */
  source: string;
  adjustments: { kind: string; reason: string }[];
}

export interface ReportSummary {
  id: number;
  name: string;
  description: string;
  kind: ReportKind;
  subjects: { objectIds: number[] };
  span: ReportSpan;
  resolved?: ResolvedSpan;
  /** Set instead of `resolved` when the span names a period that has not started (`E-02`). */
  unresolvable?: { code: string; message: string };
  outputs: ReportOutputs;
  schedule: ReportSchedule;
  /** `every Monday at 03:00`, generated beside the code that acts on it (`E-08`). */
  scheduleSummary: string;
  /** **Null is not an error** — it means the report does not run on its own. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  /**
   * The account this renders through, and whether it still can (`E-03`).
   *
   * `available` is false once that account has been deleted *or disabled*, either of which stops
   * the report rather than widening it.
   */
  runAs: { login: string; available: boolean };
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportOutputFile {
  format: 'html' | 'csv' | 'xml' | 'pdf' | 'zip';
  filename: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface ReportRun {
  id: number;
  reportId: number;
  trigger: 'manual' | 'scheduled';
  requestedBy: string;
  state: 'running' | 'succeeded' | 'failed';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** The period it covered, as the report labelled it — "do we have August" is the question. */
  spanLabel: string;
  sections: number | null;
  unavailable: number | null;
  cells: number | null;
  errorCode: string;
  errorMessage: string;
  delivery: {
    state: 'none' | 'pending' | 'sent' | 'failed';
    attempts: number;
    error: string;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
  };
  outputs: ReportOutputFile[];
}

/** What `GET /reports/:id/subjects` answers (`E-03`). */
export interface ReportSubjects {
  runAs: { login: string; role: string };
  visible: { id: number; kind: string; name: string }[];
  /**
   * Ids this report will not render.
   *
   * Deliberately not told apart: a `write` holder on a report needs no access to the object tree,
   * so saying which are deleted and which are out of scope would be an existence oracle.
   */
  unavailable: number[];
}
