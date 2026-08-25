export {
  applyResult,
  clearedByResume,
  evaluate,
  isPaused,
  pauseCause,
  queryState,
  reevaluate,
  CHANNELS_CLEAR,
  DEFAULT_FAILURE_POLICY,
  INITIAL_FACTS,
  INITIAL_SENSOR_FACTS,
  NO_PAUSE,
} from './machine.js';
export type {
  ChannelVerdict,
  Decision,
  FailurePolicy,
  PauseFlags,
  ResultFacts,
  ScanFacts,
  SensorFacts,
  StateFacts,
  Verdict,
} from './machine.js';
export { loadRuntimes, readSensorState, writeRuntimes, writeStateHistory } from './runtime.js';
export type { RuntimeWrite, SensorRuntime, StateDecisions, StateTransition } from './runtime.js';
export { SensorStateService } from './service.js';
export type { SensorResult, SensorStateServiceOptions, StateStats } from './service.js';
export {
  PAUSE_CAUSE,
  PAUSE_PRECEDENCE,
  PAUSE_SOURCES,
  ROLLUP_SEVERITY,
  SENSOR_STATES,
  SENSOR_STATE_CAUSES,
  TRANSITIONS,
  V1_STATES,
  V2_STATES,
} from './tables.js';
export type {
  PauseCase,
  PauseSource,
  RollupState,
  SensorState,
  SensorStateCause,
  Transition,
} from './tables.js';
