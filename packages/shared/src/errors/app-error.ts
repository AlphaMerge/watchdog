/**
 * Errors carry context. A bare `ETIMEDOUT` is not a diagnosis: every error raised inside
 * `packages/` names the phase it failed in and the object it was acting on.
 */
export interface ErrorContext {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export class AppError extends Error {
  readonly code: string;
  readonly context: ErrorContext;

  constructor(
    code: string,
    message: string,
    options?: { context?: ErrorContext; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.context = options?.context ?? {};
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: { context?: ErrorContext; cause?: unknown }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'ConfigError';
  }
}

/** Normalises an unknown thrown value into something loggable without losing information. */
export function describeError(err: unknown): {
  message: string;
  name: string;
  code?: string;
  stack?: string;
  context?: ErrorContext;
} {
  if (err instanceof AppError) {
    return {
      message: err.message,
      name: err.name,
      code: err.code,
      ...(err.stack === undefined ? {} : { stack: err.stack }),
      context: err.context,
    };
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      message: err.message,
      name: err.name,
      ...(code === undefined ? {} : { code }),
      ...(err.stack === undefined ? {} : { stack: err.stack }),
    };
  }
  return { message: String(err), name: 'UnknownError' };
}
