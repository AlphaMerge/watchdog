export { AppError, ConfigError, describeError } from './errors/app-error.js';
export type { ErrorContext } from './errors/app-error.js';

export { loadConfig } from './config/load.js';
export { runConfigCheck, type ConfigCheckOptions } from './config/check.js';
export type { ConfigSources, LoadConfigOptions, LoadedConfig } from './config/load.js';
export {
  allowedHostProblem,
  coreConfigSchema,
  probeConfigSchema,
  trustedProxyProblem,
} from './config/schema.js';
export type {
  CoreConfig,
  DatabaseConfig,
  DeliveryRetryConfig,
  HousekeepingConfig,
  IngestionConfig,
  LogLevel,
  ProbeConfig,
  ProgramConfig,
  ReportFontConfig,
  ServiceConfig,
  SmtpConfig,
  SmtpRelay,
  TlsConfig,
  WebhookConfig,
} from './config/schema.js';

export { createLogger } from './logging/logger.js';
export type { Logger, LoggerFactoryOptions } from './logging/logger.js';
export {
  LOG_BACKLOG_MAX_BYTES,
  LOG_EXIT_FLUSH_MS,
  LogOutput,
  PROCESS_LOG_OUTPUT,
  writeLineSync,
} from './logging/output.js';
export type { LogOutputOptions, LogOutputStats } from './logging/output.js';
export { currentCorrelation, newCorrelationId, withCorrelation } from './logging/correlation.js';
export type { CorrelationContext } from './logging/correlation.js';

export { Lifecycle } from './lifecycle/lifecycle.js';
export type { LifecycleOptions, ShutdownHook, ShutdownReason } from './lifecycle/lifecycle.js';
export { bootstrap } from './lifecycle/bootstrap.js';
export type { BootstrapOptions, BootstrappedService } from './lifecycle/bootstrap.js';
export { createServiceNotifier, watchdogIntervalMs } from './lifecycle/systemd.js';
export { EX_CONFIG, exitWithLine, startFailure } from './lifecycle/exit.js';
export { ADDRESS_WAIT_MS, waitForLocalAddress } from './lifecycle/address-wait.js';
export type { AddressWaitOptions } from './lifecycle/address-wait.js';
export type { ServiceNotifier } from './lifecycle/systemd.js';

export {
  BUILD_MANIFEST,
  BUILD_PROFILES,
  DEVELOPMENT_PROFILE,
  DEVELOPMENT_VERSION,
  describeBuild,
  isExactBuild,
  parseBuildManifest,
  readBuildStamp,
} from './build/identity.js';
export type { BuildIdentity, BuildProfile, BuildStamp } from './build/identity.js';

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
  healthForPeer,
  missingCapabilities,
  versionFor,
} from './protocol/capabilities.js';
export type { ProbeCapabilities, ProtocolSkew } from './protocol/capabilities.js';
export {
  isProtocolCompatible,
  negotiatedVersion,
  MIN_PROTOCOL_VERSION,
  parseCoreToProbe,
  parseProbeToCore,
  PROTOCOL_VERSION,
  ProtocolError,
  rejectionStopsMonitoring,
} from './protocol/messages.js';
export type {
  ChannelReading,
  CheckResult,
  CoreToProbeMessage,
  NackReason,
  ProbeHealthReport,
  ProbeQuery,
  ParseProbeToCoreOptions,
  ProbeToCoreMessage,
  ProtocolMessage,
  QueryFailure,
  RejectCode,
  SensorAssignment,
  WithdrawnCode,
  IdentifyJob,
  SweepEnding,
  SweepHost,
  SweepJob,
  UnusableHealthField,
} from './protocol/messages.js';
export { CpuMeter } from './process/cpu-meter.js';
export { DeltaMeter } from './process/delta-meter.js';
export { parseMeminfo, readMachineMemory } from './process/machine-memory.js';
export type { MachineMemory, MachineMemorySources } from './process/machine-memory.js';
export { readLimitMemory } from './process/limit-memory.js';
export { memoryReserveBytes } from './process/memory-reserve.js';
export type { LimitMemorySources } from './process/limit-memory.js';
export { AvailableMemoryWatch } from './process/memory-watch.js';
export { MEMORY_SAMPLE_INTERVAL_MS, MemorySampler } from './process/memory-sampler.js';
export type { MemorySamplerOptions } from './process/memory-sampler.js';
export type {
  AvailableMemory,
  AvailableMemoryLow,
  AvailableMemoryWatchOptions,
} from './process/memory-watch.js';
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
