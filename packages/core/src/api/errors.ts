import { AppError, describeError, type Logger } from '@ms/shared';
import { DatabaseError } from '../db/pool.js';
import { ObjectError } from '../objects/errors.js';
import { MapError } from '../maps/errors.js';
import { ReportError } from '../reports/errors.js';
import { LibraryError } from '../libraries/errors.js';
import { SettingError } from '../settings/registry.js';
import { InheritanceError } from '../settings/inheritance.js';
import { DiscoveryError } from '../discovery/errors.js';
import { ProbeRegistryError } from '../probes/registry.js';
import { AuthError } from '../auth/errors.js';
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

/** What an `AppError` code answers: its status, and whether its own sentence goes with it. */
export interface AppErrorAnswer {
  readonly status: number;
  /**
   * A refusal's sentence is the answer, and the caller needs it to fix the request. A fault's
   * message can carry a path, a statement or a key id, so it goes to the log and not the wire.
   */
  readonly says: boolean;
}

const MASKED = 'the request could not be completed';

/**
 * Every `AppError` code that no branch of `toHttpError` answers, and what it answers (`P-221`).
 *
 * **The fallback used to be the whole answer, and it was a 500 with the message replaced.** So a
 * plain `AppError` reached the client as "the request could not be completed":
 * `DEVICE_TEMPLATE_NOT_FOUND` for a template that does not exist, and before `A-23` a template
 * with nothing in it to save. That reports a client's mistake as the server's fault, and counts
 * it in every 5xx rate an operator watches. The classes with a status of their own have a branch
 * below. Everything else is listed here by code, and `error-statuses.test.ts` reads the source for
 * every code the core can throw and fails on any that this table does not name.
 */
export const APP_ERROR_STATUS: ReadonlyMap<string, AppErrorAnswer> = new Map([
  // The caller's. They can fix it once they are told what it is.
  ['DEVICE_TEMPLATE_NOT_FOUND', { status: 404, says: true }],
  // Wrapped as `DISCOVERY_RANGE_INVALID` by the discovery routes. A parse that escapes some other
  // way is still the caller's range.
  ['IP_RANGE_INVALID', { status: 400, says: true }],
  // The core's, and it will pass. 503 tells a client to ask again rather than to file a bug, and
  // the sentence says as much.
  ['CORE_STARTING', { status: 503, says: true }],
  // The core's, and a fault. Each is raised at start-up or inside the core, and one that reaches
  // a request is a bug whose detail is in the log.
  ['ACCOUNT_NOT_CREATED', { status: 500, says: false }],
  ['CONFIG_INVALID', { status: 500, says: false }],
  // A register after sealing. Only the start-up loader registers a template; no route does.
  ['DEVICE_TEMPLATE_INVALID', { status: 500, says: false }],
  ['FRAME_INVALID', { status: 500, says: false }],
  // The same, for the lookup catalogue.
  ['LOOKUP_INVALID', { status: 500, says: false }],
  ['MIGRATION_FAILED', { status: 500, says: false }],
  ['PROTOCOL_INVALID', { status: 500, says: false }],
  // Not 503: a database without TimescaleDB does not recover by being asked again.
  ['STORAGE_ENGINE_UNAVAILABLE', { status: 500, says: false }],
  ['TLS_FILE_UNREADABLE', { status: 500, says: false }],
  ['TLS_NOT_CONFIGURED', { status: 500, says: false }],
]);

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

  if (error instanceof MapError) {
    // **Absent until `G-10` went looking for it.** `MapError` extends `AppError`, and without a
    // branch of its own every one of them fell through to the catch-all below and reached the
    // client as a 500 with its message replaced: the 404 that `G-01` is careful to answer instead
    // of a 403, the 409 a second designer gets from `If-Match`, the 400 for an invalid name. The
    // service was right about all of them and the wire said "the request could not be completed".
    return envelope(
      error.status,
      error.code,
      error.message,
      { ...error.context },
      { ...error.details },
    );
  }

  if (error instanceof ReportError) {
    // Written with the map branch above in view, which was missing until `G-10` went looking and
    // turned every `MapError` into a 500. The same trap is set here: `ReportError` extends
    // `AppError`, so without this branch the 404 that hides a report's existence, the 409 from
    // `If-Match`, and — worst — `REPORT_NO_CONTEXT`'s 422 would all reach the client as "the
    // request could not be completed". A report whose account was deleted has to say so; that is
    // the entire reason migration 047 keeps the login.
    return envelope(
      error.status,
      error.code,
      error.message,
      { ...error.context },
      { ...error.details },
    );
  }

  if (error instanceof LibraryError) {
    // From the first commit this time (`L-01`), rather than after an HTTP test went looking — the
    // map branch above says what its absence cost. A library's 404 is what keeps an unreadable one
    // from being told apart from a missing one, and without this branch it would be a 500.
    return envelope(
      error.status,
      error.code,
      error.message,
      { ...error.context },
      { ...error.details },
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

  if (error instanceof AuthError) {
    // The status travels with the error (`A-01`). Note that every *login* failure is one code
    // and one sentence: "no such account" and "wrong password" as distinguishable answers is a
    // login enumerator, so which it was goes to the log and never to the caller.
    return envelope(error.status, error.code, error.message, { ...error.context });
  }

  if (error instanceof ProbeRegistryError) {
    // A probe that is not there, an object already claimed by another identity, an address
    // filter that will not parse. All three are the caller's, and all three have a sentence.
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

  // Every other `AppError`, by its code (`P-221`). A code missing from the table cannot ship,
  // because the test fails on it. One that arrives anyway, from a subclass that test cannot read,
  // is the server's fault until somebody decides otherwise: whatever it was is in the log,
  // correlated by id, and the caller gets no internals.
  if (error instanceof AppError) {
    const answer = APP_ERROR_STATUS.get(error.code);
    return answer?.says === true
      ? envelope(answer.status, error.code, error.message, { ...error.context })
      : envelope(answer?.status ?? 500, error.code, MASKED);
  }

  return envelope(500, 'INTERNAL_ERROR', MASKED);
}

/** Anything that escapes as a 500 is a bug; log it with everything we know. */
export function logIfUnexpected(logger: Logger, error: unknown, status: number): void {
  if (status < 500) return;
  logger.error({ err: describeError(error) }, 'request failed unexpectedly');
}
