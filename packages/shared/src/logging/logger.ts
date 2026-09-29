import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { currentCorrelation } from './correlation.js';
import type { LogLevel } from '../config/schema.js';

export type { Logger } from 'pino';

export interface LoggerFactoryOptions {
  name: string;
  level: LogLevel;
  /** Development only. Production logs are structured JSON on stdout, collected by the unit. */
  pretty?: boolean;
  /**
   * Where lines go. A service passes its `LogOutput` (`P-216` part 3); left out, pino's own, which
   * is what a test or a one-off command wants.
   */
  destination?: DestinationStream;
}

/**
 * Paths redacted from every log line. Monitored-device credentials never reach a log file,
 * the same way they never reach an API response.
 */
const REDACTED = [
  'password',
  '*.password',
  '*.*.password',
  'accessKey',
  '*.accessKey',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'credentials',
  '*.credentials',
  'privateKey',
  '*.privateKey',
  'community',
  '*.community',
];

export function createLogger(options: LoggerFactoryOptions): Logger {
  const base: LoggerOptions = {
    name: options.name,
    level: options.level,
    base: { service: options.name, pid: process.pid },
    redact: { paths: REDACTED, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Every line inherits whatever correlation context is active.
    mixin: () => ({ ...currentCorrelation() }),
  };

  if (options.pretty === true) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,service' },
      },
    });
  }

  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}
