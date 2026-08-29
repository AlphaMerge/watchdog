export { AppError, ConfigError, describeError } from './errors/app-error.js';
export type { ErrorContext } from './errors/app-error.js';

export { loadConfig } from './config/load.js';
export { runConfigCheck, type ConfigCheckOptions } from './config/check.js';
export type { ConfigSources, LoadConfigOptions, LoadedConfig } from './config/load.js';
export { coreConfigSchema, probeConfigSchema } from './config/schema.js';
export type {
  CoreConfig,
  DatabaseConfig,
  DeliveryRetryConfig,
  HousekeepingConfig,
  IngestionConfig,
  LogLevel,
  ProbeConfig,
  ProgramConfig,
  ServiceConfig,
  SmtpConfig,
  SmtpRelay,
  TlsConfig,
  WebhookConfig,
} from './config/schema.js';

export { createLogger } from './logging/logger.js';
export type { Logger, LoggerFactoryOptions } from './logging/logger.js';
export { currentCorrelation, newCorrelationId, withCorrelation } from './logging/correlation.js';
export type { CorrelationContext } from './logging/correlation.js';

export { Lifecycle } from './lifecycle/lifecycle.js';
export type { LifecycleOptions, ShutdownHook, ShutdownReason } from './lifecycle/lifecycle.js';
export { bootstrap } from './lifecycle/bootstrap.js';
export type { BootstrapOptions, BootstrappedService } from './lifecycle/bootstrap.js';
export { createServiceNotifier, watchdogIntervalMs } from './lifecycle/systemd.js';
export type { ServiceNotifier } from './lifecycle/systemd.js';

export {
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  FrameError,
} from './protocol/frame.js';
export { MessageConnection } from './protocol/connection.js';
export type {
  CloseCause,
  ConnectionClose,
  MessageConnectionOptions,
} from './protocol/connection.js';
export {
  capabilitiesFor,
  describeSkew,
  explainSkew,
  missingCapabilities,
  versionFor,
} from './protocol/capabilities.js';
export type { ProbeCapabilities, ProtocolSkew } from './protocol/capabilities.js';
export {
  isProtocolCompatible,
  MIN_PROTOCOL_VERSION,
  parseCoreToProbe,
  parseProbeToCore,
  PROTOCOL_VERSION,
  ProtocolError,
} from './protocol/messages.js';
export type {
  ChannelReading,
  CheckResult,
  CoreToProbeMessage,
  NackReason,
  ProbeHealthReport,
  ProbeQuery,
  ProbeToCoreMessage,
  ProtocolMessage,
  QueryFailure,
  RejectCode,
  SensorAssignment,
  IdentifyJob,
  SweepEnding,
  SweepHost,
  SweepJob,
} from './protocol/messages.js';
export { CpuMeter } from './process/cpu-meter.js';
export { runProgram } from './process/run.js';
export type { ProgramRun, ProgramRunOptions } from './process/run.js';

export {
  isLinkLocal,
  isPrivate,
  refuses,
  refusedAddresses,
  sameOrigin,
  schemeAllowed,
} from './net/target-policy.js';
export type { TargetPolicy, TargetRefusal } from './net/target-policy.js';
export { loadTlsMaterial } from './protocol/tls-files.js';
export type { LoadedTlsMaterial } from './protocol/tls-files.js';

export {
  addressAt,
  contains,
  addressAllowed,
  IpRangeError,
  MAX_ADDRESSES,
  parseAddressFilter,
  parseIpRange,
  toNumber,
  toText,
} from './net/ip-range.js';
export type { IpRange, IpSpan } from './net/ip-range.js';
export { classify, enterpriseOf, IDENTIFY_PORTS } from './net/fingerprint.js';
export type { DeviceKind, Evidence, Fingerprint, OpenPort } from './net/fingerprint.js';
export { DISCOVERY_LEVELS, estimateSeconds, levelDefinition } from './net/discovery-levels.js';
export type { DiscoveryLevel, EstimateInput, LevelDefinition } from './net/discovery-levels.js';
