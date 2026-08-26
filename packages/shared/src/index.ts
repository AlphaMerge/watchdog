export { AppError, ConfigError, describeError } from './errors/app-error.js';
export type { ErrorContext } from './errors/app-error.js';

export { loadConfig } from './config/load.js';
export type { ConfigSources, LoadConfigOptions, LoadedConfig } from './config/load.js';
export { coreConfigSchema, probeConfigSchema } from './config/schema.js';
export type {
  CoreConfig,
  DatabaseConfig,
  HousekeepingConfig,
  IngestionConfig,
  LogLevel,
  ProbeConfig,
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
  ProbeToCoreMessage,
  ProtocolMessage,
  RejectCode,
  SensorAssignment,
} from './protocol/messages.js';
export { loadTlsMaterial } from './protocol/tls-files.js';
export type { LoadedTlsMaterial } from './protocol/tls-files.js';
