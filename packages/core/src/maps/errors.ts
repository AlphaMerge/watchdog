import { AppError, type ErrorContext } from '@ms/shared';

/**
 * What can go wrong with a map (`G-01`).
 *
 * **Its own codes rather than `ObjectErrorCode`'s**, because a map is not an object and the two
 * lists would otherwise grow into each other: half of `ObjectErrorCode` is about parents, cycles
 * and subtrees, none of which a map has, and a client switching on a shared enum would have to
 * handle codes that cannot occur.
 */
export type MapErrorCode =
  | 'MAP_INVALID'
  | 'MAP_NOT_FOUND'
  | 'MAP_NAME_TAKEN'
  | 'MAP_CHANGED'
  | 'MAP_FORBIDDEN'
  | 'MAP_GROUP_NOT_FOUND';

export const MAP_ERROR_STATUS: Readonly<Record<MapErrorCode, number>> = {
  MAP_INVALID: 400,
  MAP_NOT_FOUND: 404,
  MAP_GROUP_NOT_FOUND: 404,
  MAP_NAME_TAKEN: 409,
  // The request is well formed and the state of the map is what refuses it: somebody else saved
  // while this designer was open.
  MAP_CHANGED: 409,
  MAP_FORBIDDEN: 403,
};

export class MapError extends AppError {
  override readonly code: MapErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MapErrorCode,
    message: string,
    options: { context: ErrorContext; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(code, message, {
      context: options.context,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'MapError';
    this.code = code;
    this.status = MAP_ERROR_STATUS[code];
    this.details = options.details ?? {};
  }
}

export function mapNotFound(id: number): MapError {
  return new MapError('MAP_NOT_FOUND', `map ${String(id)} does not exist`, {
    context: { mapId: id, phase: 'lookup' },
  });
}

/**
 * A map the caller may not see reads as absent, not as forbidden.
 *
 * **Deliberate, and the same rule the object API follows.** Answering 403 for a map that exists
 * and 404 for one that does not turns the error into an oracle: anybody could enumerate ids and
 * learn how many maps an installation has and which ids are live, without holding a right on any
 * of them. A caller who cannot read it is told the same thing either way.
 */
export function invisible(id: number): MapError {
  return mapNotFound(id);
}

export function changedUnderneath(id: number, expected: number, actual: number): MapError {
  return new MapError(
    'MAP_CHANGED',
    `map ${String(id)} has moved on: expected version ${String(expected)}, found ${String(actual)}`,
    {
      context: { mapId: id, phase: 'update' },
      details: { expectedVersion: expected, actualVersion: actual },
    },
  );
}
