import type { JSONSchemaType } from 'ajv';
import type { BuildStamp } from '../build/identity.js';
import { loadConfig, type ConfigSources } from '../config/load.js';
import type { ServiceConfig } from '../config/schema.js';
import { ConfigError, describeError } from '../errors/app-error.js';
import { createLogger, type Logger } from '../logging/logger.js';
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
    const described = describeError(error);
    process.stderr.write(
      `${error instanceof ConfigError ? 'Configuration error' : 'Startup failed'}: ${described.message}\n`,
    );
    process.exit(78); // EX_CONFIG
  }

  const logger = createLogger({
    name: config.service.name,
    level: config.service.logLevel,
    pretty: config.service.logPretty,
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

  return { config, logger, lifecycle, sources };
}
