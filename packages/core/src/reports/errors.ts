import { AppError, type ErrorContext } from '@ms/shared';

/**
 * What can go wrong with a report (`E-01`).
 *
 * **Its own codes rather than `MapErrorCode`'s**, for the reason `maps/errors.ts` gives about not
 * sharing with `ObjectErrorCode`: the two lists would grow into each other. A map has a canvas
 * and share links; a report has a security context and a schedule. The overlap today is four
 * codes that mean the same words about different things, and a client switching on a shared enum
 * would have to handle codes that cannot occur for the thing it is holding.
 *
 * **`REPORT_NO_CONTEXT` is the one that is not a copy**, and it exists because `§6`'s security
 * context can be left dangling by deleting an account. Migration 047 nulls `run_as_user_id` and
 * keeps `run_as_login`, so the state is readable rather than silent; this is what the reader of
 * that state is supposed to raise. `E-03` is where it starts being thrown by a scheduler rather
 * than by a write.
 */
export type ReportErrorCode =
  | 'REPORT_INVALID'
  | 'REPORT_NOT_FOUND'
  | 'REPORT_NAME_TAKEN'
  | 'REPORT_CHANGED'
  | 'REPORT_PRECONDITION_REQUIRED'
  | 'REPORT_FORBIDDEN'
  | 'REPORT_GROUP_NOT_FOUND'
  | 'REPORT_USER_NOT_FOUND'
  | 'REPORT_NO_CONTEXT'
  | 'REPORT_TOO_LARGE'
  | 'REPORT_BUSY';

export const REPORT_ERROR_STATUS: Readonly<Record<ReportErrorCode, number>> = {
  REPORT_INVALID: 400,
  REPORT_NOT_FOUND: 404,
  REPORT_GROUP_NOT_FOUND: 404,
  REPORT_USER_NOT_FOUND: 404,
  REPORT_NAME_TAKEN: 409,
  // Well formed, and the state of the report is what refuses it: somebody else saved first.
  REPORT_CHANGED: 409,
  // 428, as the object and map APIs answer it (`A-14`). It was 401 — "log in first" — to a
  // caller who was logged in and had left out `If-Match`.
  REPORT_PRECONDITION_REQUIRED: 428,
  REPORT_FORBIDDEN: 403,
  // **422, not 403 or 500.** The request is understood and the report is real; what is missing is
  // the account whose scope it renders through, and that is neither the caller's fault nor a
  // failure of this service. A 403 would suggest the caller could fix it by holding a right.
  REPORT_NO_CONTEXT: 422,
  // **422 as well, and for the same shape of reason.** The request is understood and the report is
  // real; what cannot be done is produce it at the size it was asked for. It is not a 413 — the
  // request entity is a few hundred bytes — and it is not a 500, because nothing failed: the
  // answer is "narrow it", and only the author can.
  REPORT_TOO_LARGE: 422,
  // **409, because the state of the report is what refuses it** — the same reasoning as
  // `REPORT_CHANGED`. A report already rendering will not render again, and the fix is to wait
  // rather than to change the request. A 429 would suggest a rate limit that clears on its own
  // schedule; this clears when that run finishes, which the runs list can be asked about.
  REPORT_BUSY: 409,
};

export class ReportError extends AppError {
  override readonly code: ReportErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReportErrorCode,
    message: string,
    options: { context: ErrorContext; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(code, message, {
      context: options.context,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ReportError';
    this.code = code;
    this.status = REPORT_ERROR_STATUS[code];
    this.details = options.details ?? {};
  }
}

export function reportNotFound(id: number): ReportError {
  return new ReportError('REPORT_NOT_FOUND', `report ${String(id)} does not exist`, {
    context: { reportId: id, phase: 'lookup' },
  });
}

/**
 * A report the caller may not see reads as absent, not as forbidden.
 *
 * The map API's rule: answering 403 for one that exists and 404 for one that does not turns the
 * error into an oracle for enumerating ids. A caller without the right is told the same thing
 * either way. **The object API answers 403 instead**, and `maps/errors.ts` says why both are
 * sound: it resolves a right before reading the row, and this reads the row first.
 */
export function invisible(id: number): ReportError {
  return reportNotFound(id);
}

export function changedUnderneath(id: number, expected: number, actual: number): ReportError {
  return new ReportError(
    'REPORT_CHANGED',
    `report ${String(id)} has moved on: expected version ${String(expected)}, found ${String(actual)}`,
    {
      context: { reportId: id, phase: 'update' },
      details: { expectedVersion: expected, actualVersion: actual },
    },
  );
}

/**
 * The account this report renders through is gone.
 *
 * Carries the login rather than only the id, because that is the whole point of snapshotting it
 * in migration 047: an operator reading this has to know *whose* scope was lost to decide what to
 * put back, and the id of a deleted account tells them nothing.
 */
export function contextLost(id: number, login: string): ReportError {
  return new ReportError(
    'REPORT_NO_CONTEXT',
    `report ${String(id)} runs as "${login}", and that account no longer exists`,
    {
      context: { reportId: id, phase: 'context' },
      details: { runAsLogin: login },
    },
  );
}
