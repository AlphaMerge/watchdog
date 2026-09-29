import type { JSONSchemaType } from 'ajv';
import type { BuildStamp } from '../build/identity.js';
import { loadConfig, type ConfigSources } from '../config/load.js';
import type { ServiceConfig } from '../config/schema.js';
import { ConfigError, describeError } from '../errors/app-error.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { LogOutput } from '../logging/output.js';
import { EX_CONFIG, exitWithLine } from './exit.js';
import { Lifecycle } from './lifecycle.js';

export interface BootstrapOptions<T> {
  schema: JSONSchemaType<T>;
  envPrefix?: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  version: string;
  /**
   * Logged with the version, so the first line of a journal says which code wrote it (`H-11`)
   * and what that build contains (`H-12`).
   */
  build?: BuildStamp;
}

export interface BootstrappedService<T> {
  config: T;
  logger: Logger;
  lifecycle: Lifecycle;
  sources: ConfigSources;
  /**
   * Where the logger writes, for Core Health and Probe Health to read what it dropped and holds
   * (`P-216` part 3). Absent under `logPretty`, which is development's and goes through pino's
   * own transport.
   */
  logOutput: LogOutput | undefined;
}

/**
 * The first thirty lines of every service: read the configuration, fail loudly if it is wrong,
 * stand up structured logging, and arm the shutdown path before anything can allocate a socket
 * or a file handle.
 */
export function bootstrap<T extends { service: ServiceConfig }>(
  options: BootstrapOptions<T>,
): BootstrappedService<T> {
  let config: T;
  let sources: ConfigSources;

  try {
    const loaded = loadConfig<T>({
      schema: options.schema,
      ...(options.envPrefix === undefined ? {} : { envPrefix: options.envPrefix }),
      ...(options.argv === undefined ? {} : { argv: options.argv }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    config = loaded.config;
    sources = loaded.sources;
  } catch (error) {
    // No logger yet — this is the one place a service writes to stderr directly, because a
    // configuration failure must be readable in `journalctl` before logging is configured.
    // Written synchronously and waited for (`P-216` part 3): `process.stderr.write` on a stalled
    // journal queues the line, and the exit discards it.
    const described = describeError(error);
    exitWithLine(
      EX_CONFIG,
      `${error instanceof ConfigError ? 'Configuration error' : 'Startup failed'}: ${described.message}\n`,
    );
  }

  // Before the logger, so the first line it writes is already bounded and flushed on exit.
  const logOutput = config.service.logPretty ? undefined : new LogOutput();
  logOutput?.flushOnExit();
  const logger = createLogger({
    name: config.service.name,
    level: config.service.logLevel,
    pretty: config.service.logPretty,
    ...(logOutput === undefined ? {} : { destination: logOutput }),
  });

  const lifecycle = new Lifecycle({
    logger,
    shutdownTimeoutMs: config.service.shutdownTimeoutMs,
  });
  lifecycle.install();

  logger.info(
    {
      version: options.version,
      ...(options.build === undefined
        ? {}
        : {
            commit: options.build.commit,
            uncommittedChanges: options.build.dirty,
            profile: options.build.profile,
          }),
      node: process.version,
      configFile: sources.file,
      envOverrides: sources.envOverrides,
      ...(sources.ignoredEnv.length === 0 ? {} : { ignoredEnv: sources.ignoredEnv }),
      dataDir: config.service.dataDir,
    },
    'starting',
  );

  return { config, logger, lifecycle, sources, logOutput };
}
