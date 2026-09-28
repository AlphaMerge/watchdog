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
  // `A-29`: the account that vouched for the sensor may no longer read what it names.
  'access',
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
  {
    // Reachable only by editing the policy: while a sensor is failing the count only rises, and
    // a success takes it straight to Up. Added by `M-03`, whose conformance test drove it and
    // found the table silent — the same way `M-02` found the missing same-state cause changes.
    from: 'down',
    to: 'warning',
    causes: ['scan'],
    trigger: 'the failure policy was relaxed past the current failure count',
  },
  { from: 'down', to: 'up', causes: ['scan'], trigger: 'successful scan, limits clear' },
  { from: 'down', to: 'down_acknowledged', causes: ['user'], trigger: 'operator acknowledged' },
  {
    // Not only by acknowledging. A sensor that was Down (Acknowledged), lost its probe and got
    // it back returns to Down (Acknowledged): the outage never ended, the acknowledgement never
    // lapsed, and the layer that was hiding both was lifted. Lifting a simulated error does the
    // same thing. Reachable from `unknown` and nowhere else — a resume clears the
    // acknowledgement, and a recovery to Up or Warning clears it too, so no other state can
    // arrive here still carrying one. Found by `M-16`'s deeper sweep.
    from: 'unknown',
    to: 'down_acknowledged',
    causes: ['user'],
    trigger: 'the layer that was hiding the outage was lifted, and the acknowledgement stands',
  },
  {
    // `user` when the acknowledgement lapsed — the change an operator has to see is that the
    // suppression ended, not that the target is still down. The reading's own cause when it was
    // *withdrawn* (`M-13`), because then nothing about the outage changed and naming `user`
    // would claim the operator caused the Down rather than un-silenced it. `simulated` when the
    // withdrawal happened while a forced error was standing (`N-17`): the sensor is Down for
    // that reason and for no other, and `M-14` promises a forced outage says so.
    from: 'down_acknowledged',
    to: 'down',
    causes: ['user', 'scan', 'limit', 'lookup', 'simulated'],
    trigger: 'the acknowledgement expired or was withdrawn while the sensor was still failing',
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
  // Layers 3, 3a and 4 of §2 are the only things that produce Unknown, and any can take over
  // from *any* state the moment the layer above it is lifted: a resume, a simulated error
  // cleared, a probe returning. The first version of this table enumerated the `from` states by
  // hand and excluded `paused` from both, on the reasoning that pause outranks them — which is
  // true while it is paused and beside the point at the instant it resumes. `M-16`'s property
  // tests reached `paused -> unknown : probe` and then `down -> unknown : scan`, neither of
  // which was here; deriving the entries from the layers rather than listing them is what stops
  // a third one turning up. `access` is layer 3a's (`A-29`), and arrived by the same derivation.
  ...V1_STATES.map((from): Transition => ({
    from,
    to: 'unknown',
    causes: ['scan', 'probe', 'access'],
    trigger: 'whatever was deciding the state was lifted, and there is no current reading',
  })),
  ...V1_STATES.map((from): Transition => ({
    from,
    to: 'down',
    causes: ['simulated'],
    trigger: 'an operator set a simulated error, or the last pause cleared while one was set',
  })),
];
