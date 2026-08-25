import { AppError, type ErrorContext } from '@ms/shared';

export type ObjectErrorCode =
  | 'OBJECT_INVALID'
  | 'CURSOR_INVALID'
  | 'CURSOR_SORT_MISMATCH'
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_PARENT_NOT_FOUND'
  | 'OBJECT_PARENT_INVALID'
  | 'OBJECT_CYCLE'
  | 'OBJECT_KIND_MISMATCH'
  | 'OBJECT_NOT_EMPTY'
  | 'OBJECT_SUBTREE_CHANGED'
  | 'OBJECT_NOT_DELETABLE'
  | 'OBJECT_NOT_MOVABLE'
  | 'OBJECT_NOT_CLONEABLE'
  | 'OBJECT_CLONE_TOO_LARGE'
  | 'OBJECT_VERSION_CONFLICT'
  | 'OBJECT_PRECONDITION_REQUIRED';

export const OBJECT_ERROR_STATUS: Readonly<Record<ObjectErrorCode, number>> = {
  OBJECT_INVALID: 400,
  CURSOR_INVALID: 400,
  CURSOR_SORT_MISMATCH: 400,
  OBJECT_NOT_FOUND: 404,
  OBJECT_PARENT_NOT_FOUND: 404,
  OBJECT_PARENT_INVALID: 409,
  OBJECT_CYCLE: 409,
  OBJECT_KIND_MISMATCH: 409,
  OBJECT_NOT_EMPTY: 409,
  OBJECT_SUBTREE_CHANGED: 409,
  OBJECT_NOT_DELETABLE: 409,
  OBJECT_NOT_MOVABLE: 409,
  OBJECT_NOT_CLONEABLE: 409,
  OBJECT_CLONE_TOO_LARGE: 409,
  OBJECT_VERSION_CONFLICT: 412,
  OBJECT_PRECONDITION_REQUIRED: 428,
};

/**
 * A failure with an HTTP meaning attached.
 *
 * `AppError.context` is scalar-only by design, and widening it would touch every error in
 * `packages/`. Structured payloads — delete counts, a cycle path — go in `details` instead,
 * which is what the wire envelope carries and what a client machine-reads.
 */
export class ObjectError extends AppError {
  override readonly code: ObjectErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ObjectErrorCode,
    message: string,
    options: { context: ErrorContext; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(code, message, {
      context: options.context,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ObjectError';
    this.code = code;
    this.status = OBJECT_ERROR_STATUS[code];
    this.details = options.details ?? {};
  }
}

export function notFound(id: number): ObjectError {
  return new ObjectError('OBJECT_NOT_FOUND', `object ${String(id)} does not exist`, {
    context: { objectId: id, phase: 'lookup' },
  });
}

export function parentNotFound(parentId: number): ObjectError {
  return new ObjectError(
    'OBJECT_PARENT_NOT_FOUND',
    `parent object ${String(parentId)} does not exist`,
    { context: { parentId, phase: 'lookup' } },
  );
}
