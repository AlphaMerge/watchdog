import { AppError, type ErrorContext } from '@ms/shared';

/**
 * What can go wrong with a library (`L-01`).
 *
 * **Its own codes, for the reason a map has its own** (`maps/errors.ts`): a library is not an
 * object, and a client switching on a shared enum would have to handle codes that cannot occur.
 * The list is a map's without the share and background codes, because a library has neither.
 */
export type LibraryErrorCode =
  | 'LIBRARY_INVALID'
  | 'LIBRARY_NOT_FOUND'
  | 'LIBRARY_NAME_TAKEN'
  | 'LIBRARY_CHANGED'
  | 'LIBRARY_PRECONDITION_REQUIRED'
  | 'LIBRARY_FORBIDDEN'
  | 'LIBRARY_GROUP_NOT_FOUND';

export const LIBRARY_ERROR_STATUS: Readonly<Record<LibraryErrorCode, number>> = {
  LIBRARY_INVALID: 400,
  LIBRARY_NOT_FOUND: 404,
  LIBRARY_GROUP_NOT_FOUND: 404,
  LIBRARY_NAME_TAKEN: 409,
  // Somebody else saved while this editor was open. 412, as `MAP_CHANGED` says (`L-06`).
  LIBRARY_CHANGED: 412,
  // 428, as the object and map APIs answer a missing `If-Match` (`A-14`).
  LIBRARY_PRECONDITION_REQUIRED: 428,
  LIBRARY_FORBIDDEN: 403,
};

export class LibraryError extends AppError {
  override readonly code: LibraryErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LibraryErrorCode,
    message: string,
    options: { context: ErrorContext; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(code, message, {
      context: options.context,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'LibraryError';
    this.code = code;
    this.status = LIBRARY_ERROR_STATUS[code];
    this.details = options.details ?? {};
  }
}

export function libraryNotFound(id: number): LibraryError {
  return new LibraryError('LIBRARY_NOT_FOUND', `library ${String(id)} does not exist`, {
    context: { libraryId: id, phase: 'lookup' },
  });
}

/**
 * A library the caller may not see reads as absent, not as forbidden — `maps/errors.ts` gives the
 * reasoning, and it is the same here: answering 403 for one that exists and 404 for one that does
 * not would let anybody enumerate which ids are live without holding a right on any of them.
 */
export function invisible(id: number): LibraryError {
  return libraryNotFound(id);
}

export function changedUnderneath(id: number, expected: number, actual: number): LibraryError {
  return new LibraryError(
    'LIBRARY_CHANGED',
    `library ${String(id)} has moved on: expected version ${String(expected)}, found ${String(actual)}`,
    {
      context: { libraryId: id, phase: 'update' },
      details: { expectedVersion: expected, actualVersion: actual },
    },
  );
}
