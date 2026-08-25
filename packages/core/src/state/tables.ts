/**
 * The state and pause-precedence tables, as data (`M-01`).
 *
 * `docs/state-machine.md` is the specification; this is the same thing in a form `M-02` can
 * implement against and a test can check. There is deliberately **no state machine here** —
 * `M-01` is the tables, written before the code, because `PLAN.md` names precedence bugs between
 * the four pause sources as Phase 3's principal risk and a table nobody can execute is a table
 * nobody checks.
 *
 * The values mirror the `sensor_state_kind` and `sensor_state_cause` enums from migration `003`;
 * a test asserts they still match the database rather than trusting that they do.
 */

export const SENSOR_STATES = [
  'unknown',
  'up',
  'warning',
  'down',
  'down_acknowledged',
  'down_partial',
  'unusual',
  'paused',
] as const;

export type SensorState = (typeof SENSOR_STATES)[number];

export const SENSOR_STATE_CAUSES = [
  'scan',
  'limit',
  'lookup',
  'user',
  'schedule',
  'dependency',
  'parent',
  'probe',
  'simulated',
] as const;

export type SensorStateCause = (typeof SENSOR_STATE_CAUSES)[number];

/** The six states v1 can produce. */
export const V1_STATES = [
  'unknown',
  'up',
  'warning',
  'down',
  'down_acknowledged',
  'paused',
] as const satisfies readonly SensorState[];

/**
 * Reachable only in `[V2]`.
 *
 * The type accommodates them so the column never has to change, and a test asserts no v1
 * transition produces either — an aspiration in a comment is not a constraint.
 */
export const V2_STATES = ['unusual', 'down_partial'] as const satisfies readonly SensorState[];

/**
 * Severity for the multi-channel rollup (`M-05`): the sensor is the worst of its channels.
 *
 * Only the three states a scan with readings can produce. `unknown` is not "better than up" and
 * is decided a layer earlier; ranking it here would let a channel with no reading outvote one
 * that is genuinely down.
 */
export const ROLLUP_SEVERITY = { up: 0, warning: 1, down: 2 } as const;

export type RollupState = keyof typeof ROLLUP_SEVERITY;

/**
 * The four pause sources, in the order they are evaluated (`WORKFLOW.MD §5`).
 *
 * Order decides which cause is *reported*, never whether the sensor is paused: the sources are
 * an independent set, and a sensor is paused while any of them is set. That distinction is the
 * whole risk this task exists to remove — as a priority chain, resuming the highest-precedence
 * source would resume a sensor another source still holds.
 */
export const PAUSE_SOURCES = ['parent', 'dependency', 'schedule', 'manual'] as const;

export type PauseSource = (typeof PAUSE_SOURCES)[number];

export const PAUSE_CAUSE = {
  parent: 'parent',
  dependency: 'dependency',
  schedule: 'schedule',
  manual: 'user',
} as const satisfies Record<PauseSource, SensorStateCause>;

/**
 * Every combination of the four sources and the cause each reports.
 *
 * Written out rather than computed, and then checked against the rule in a test. Two independent
 * derivations that must agree catches a mistake in either; one derivation checked against itself
 * catches nothing.
 */
export interface PauseCase {
  readonly active: readonly PauseSource[];
  readonly paused: boolean;
  readonly cause: SensorStateCause | null;
}

export const PAUSE_PRECEDENCE: readonly PauseCase[] = [
  { active: [], paused: false, cause: null },
  { active: ['manual'], paused: true, cause: 'user' },
  { active: ['schedule'], paused: true, cause: 'schedule' },
  { active: ['schedule', 'manual'], paused: true, cause: 'schedule' },
  { active: ['dependency'], paused: true, cause: 'dependency' },
  { active: ['dependency', 'manual'], paused: true, cause: 'dependency' },
  { active: ['dependency', 'schedule'], paused: true, cause: 'dependency' },
  { active: ['dependency', 'schedule', 'manual'], paused: true, cause: 'dependency' },
  { active: ['parent'], paused: true, cause: 'parent' },
  { active: ['parent', 'manual'], paused: true, cause: 'parent' },
  { active: ['parent', 'schedule'], paused: true, cause: 'parent' },
  { active: ['parent', 'schedule', 'manual'], paused: true, cause: 'parent' },
  { active: ['parent', 'dependency'], paused: true, cause: 'parent' },
  { active: ['parent', 'dependency', 'manual'], paused: true, cause: 'parent' },
  { active: ['parent', 'dependency', 'schedule'], paused: true, cause: 'parent' },
  { active: ['parent', 'dependency', 'schedule', 'manual'], paused: true, cause: 'parent' },
];

/**
 * Every transition v1 may make, and why.
 *
 * `M-02` asserts the machine makes no move that is not here. A state change the tables did not
 * anticipate is either a bug or a specification gap, and both are worth stopping for.
 */
export interface Transition {
  readonly from: SensorState | 'created';
  readonly to: SensorState;
  readonly causes: readonly SensorStateCause[];
  readonly trigger: string;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'created', to: 'unknown', causes: ['scan'], trigger: 'sensor created' },
  { from: 'unknown', to: 'up', causes: ['scan'], trigger: 'first successful scan, limits clear' },
  {
    from: 'unknown',
    to: 'warning',
    causes: ['scan', 'limit', 'lookup'],
    trigger: 'first scan failed, or the first reading breached a warning limit',
  },
  {
    from: 'unknown',
    to: 'down',
    causes: ['limit', 'lookup', 'scan'],
    trigger: 'first reading breached an error limit, or the immediate-down policy',
  },
  {
    from: 'up',
    to: 'warning',
    causes: ['scan', 'limit', 'lookup'],
    trigger: 'scan failed (first), or a warning limit breached',
  },
  {
    from: 'up',
    to: 'down',
    causes: ['limit', 'lookup', 'scan'],
    trigger: 'an error limit breached, or the immediate-down policy',
  },
  {
    from: 'warning',
    to: 'down',
    causes: ['scan', 'limit', 'lookup'],
    trigger: 'failure policy exhausted, or an error limit breached',
  },
  { from: 'warning', to: 'up', causes: ['scan'], trigger: 'successful scan, limits clear' },
  {
    from: 'down',
    to: 'warning',
    causes: ['limit', 'lookup'],
    trigger: 'recovered to a warning limit',
  },
  { from: 'down', to: 'up', causes: ['scan'], trigger: 'successful scan, limits clear' },
  { from: 'down', to: 'down_acknowledged', causes: ['user'], trigger: 'operator acknowledged' },
  {
    from: 'down_acknowledged',
    to: 'down',
    causes: ['user'],
    trigger: 'acknowledgement expired while still failing',
  },
  {
    from: 'down_acknowledged',
    to: 'up',
    causes: ['scan'],
    trigger: 'recovered, which clears the acknowledgement',
  },
  {
    from: 'down_acknowledged',
    to: 'warning',
    causes: ['scan', 'limit', 'lookup'],
    trigger: 'recovered to a warning, which clears the acknowledgement',
  },
  { from: 'paused', to: 'unknown', causes: ['scan'], trigger: 'the last pause source cleared' },
  // Re-entry with a different cause. Not a change of state, but a change an operator has to
  // see — Warning because the scan failed and Warning because a limit was breached are two
  // different problems — and §5 invariant 10 requires it to be recorded. Added by `M-02`,
  // whose conformance test drove the machine into it and found the table silent.
  ...(['up', 'warning', 'down'] as const).map((state): Transition => ({
    from: state,
    to: state,
    causes: ['scan', 'limit', 'lookup'],
    trigger: 'the reason changed, not the state',
  })),
  // Reachable from every state, including itself when the reported cause changes.
  ...V1_STATES.map((from): Transition => ({
    from,
    to: 'paused',
    causes: ['parent', 'dependency', 'schedule', 'user'],
    trigger: 'a pause source became active',
  })),
  ...V1_STATES.filter((from) => from !== 'paused').map((from): Transition => ({
    from,
    to: 'unknown',
    causes: ['probe'],
    trigger: 'the owning probe became unreachable',
  })),
  ...V1_STATES.filter((from) => from !== 'paused').map((from): Transition => ({
    from,
    to: 'down',
    causes: ['simulated'],
    trigger: 'an operator set a simulated error',
  })),
];
