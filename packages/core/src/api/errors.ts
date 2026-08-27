import { AppError, describeError, type Logger } from '@ms/shared';
import { DatabaseError } from '../db/pool.js';
import { ObjectError } from '../objects/errors.js';
import { SettingError } from '../settings/registry.js';
import { InheritanceError } from '../settings/inheritance.js';
import { DiscoveryError } from '../discovery/errors.js';
import { QueryError } from '../timeseries/query.js';
import { MethodError } from '../notifications/methods.js';
import { TriggerError } from '../triggers/definition.js';
import { VaultError } from '../vault/service.js';
import { VaultKeyError } from '../vault/keyring.js';
import { VaultSealError } from '../vault/sealer.js';

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    context: Record<string, unknown>;
    details: Record<string, unknown>;
    correlationId?: string;
  };
}

export interface HttpError {
  status: number;
  body: HttpErrorBody;
}

/**
 * Maps a thrown value onto one HTTP envelope.
 *
 * Switches on error type and SQLSTATE — never on message text. A trigger violation that
 * escapes a pre-check is a 409 naming the constraint, not a 500: reaching one means the
 * pre-check raced or we have a bug, and either way the operator deserves to know which rule
 * they broke.
 */
export function toHttpError(error: unknown, correlationId?: string): HttpError {
  const envelope = (
    status: number,
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    details: Record<string, unknown> = {},
  ): HttpError => ({
    status,
    body: {
      error: {
        code,
        message,
        context,
        details,
        ...(correlationId === undefined ? {} : { correlationId }),
      },
    },
  });

  if (error instanceof ObjectError) {
    return envelope(
      error.status,
      error.code,
      error.message,
      { ...error.context },
      {
        ...error.details,
      },
    );
  }

  if (error instanceof QueryError) {
    // A query the rules refuse — an inverted range, an unparseable timestamp. The caller's
    // mistake, and one they can only fix if we say which value was wrong.
    return envelope(error.status, error.code, error.message, { ...error.context });
  }

  if (error instanceof SettingError) {
    return envelope(400, error.code, error.message, { ...error.context });
  }

  if (error instanceof MethodError) {
    // A template whose settings failed its method's schema, or a method this build does not
    // have (`N-05`). The problems go out: a credential form that just refuses is unusable.
    return envelope(400, error.code, error.message, { ...error.context }, { ...error.details });
  }

  if (error instanceof TriggerError) {
    // Settings that failed their kind's own schema (`N-01`). The problems go out: a trigger a
    // client cannot save and cannot see the reason for is a form that just refuses.
    return envelope(400, error.code, error.message, { ...error.context }, { ...error.details });
  }

  if (error instanceof VaultError) {
    // A kind this build has no transport for, and nothing else: the vault's other failures are
    // `VaultKeyError` and `VaultSealError` below, which are the operator's problem rather than
    // the caller's. Naming the kinds that *do* work is the useful half — a form told only "no"
    // cannot tell a typo from a feature that has not shipped.
    return envelope(400, error.code, error.message, { ...error.context });
  }

  if (error instanceof VaultKeyError || error instanceof VaultSealError) {
    // 503, and deliberately without the message. These say which key is missing or which record
    // would not decrypt, which is exactly what an operator needs in the log and exactly what an
    // unauthenticated caller should not be told about the shape of the vault.
    return envelope(503, error.code, 'the credential vault is not usable — see the core log');
  }

  if (error instanceof DiscoveryError) {
    // The parser's own sentence goes out unchanged: "that is 16,777,214 addresses and one run
    // may sweep 65,536 — the usual cause is a /8 where a /24 was meant" is the whole point of
    // having written it, and a generic "invalid range" would throw it away.
    return envelope(error.status, error.code, error.message, { ...error.context });
  }

  if (error instanceof InheritanceError) {
    // Switch on the type, never on the message — the same rule this file applies to SQLSTATE.
    // The resolver raises this when an object vanished between two statements.
    return envelope(404, error.code, error.message, { ...error.context });
  }

  if (error instanceof DatabaseError) {
    const sqlstate = error.sqlstate;
    if (sqlstate === '23514' || sqlstate === '23503' || sqlstate === '23505') {
      // A constraint or trigger that escaped a pre-check: the caller broke a real rule and
      // deserves to know which one. The constraint name goes out; the statement does not.
      return envelope(
        409,
        'OBJECT_INVALID',
        error.message,
        { phase: error.context['phase'] ?? 'database' },
        { sqlstate, ...(error.constraint === undefined ? {} : { constraint: error.constraint }) },
      );
    }
    // Nothing else from a database failure is safe to hand back. `DatabaseError.context`
    // carries the statement text and `host:port/database`, which is reconnaissance for anyone
    // who can reach the API. It is logged in full instead — see logIfUnexpected.
    return envelope(500, 'DATABASE_ERROR', 'the request could not be completed');
  }

  // A body Fastify could not parse arrives here carrying its own 4xx statusCode and no
  // `validation` array. Reporting a malformed JSON body as a 500 blames the server for the
  // client's mistake, and buries real 500s in the noise.
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const code = (error as { code?: string }).code ?? 'OBJECT_INVALID';
    return envelope(statusCode, code, describeError(error).message, { phase: 'parse-request' });
  }

  // An unexpected failure says nothing beyond "it failed". Whatever it was is in the log,
  // correlated by id; the caller gets no internals.
  if (error instanceof AppError) {
    return envelope(500, error.code, 'the request could not be completed');
  }

  return envelope(500, 'INTERNAL_ERROR', 'the request could not be completed');
}

/** Anything that escapes as a 500 is a bug; log it with everything we know. */
export function logIfUnexpected(logger: Logger, error: unknown, status: number): void {
  if (status < 500) return;
  logger.error({ err: describeError(error) }, 'request failed unexpectedly');
}
