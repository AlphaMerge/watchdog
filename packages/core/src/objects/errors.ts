import { AppError, type ErrorContext } from '@ms/shared';

export type ObjectErrorCode =
  | 'OBJECT_INVALID'
  | 'CURSOR_INVALID'
  | 'CURSOR_SORT_MISMATCH'
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_NOT_PAUSED'
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
  | 'OBJECT_PRECONDITION_REQUIRED'
  | 'OBJECT_CREDENTIALS_WITHHELD'
  | 'OBJECT_CHANNEL_MODE_FIXED'
  | 'OBJECT_TREE_BUSY'
  | 'OBJECT_PARAMS_NOT_CHECKED'
  | 'CREDENTIAL_VAULT_UNAVAILABLE';

export const OBJECT_ERROR_STATUS: Readonly<Record<ObjectErrorCode, number>> = {
  OBJECT_INVALID: 400,
  CURSOR_INVALID: 400,
  CURSOR_SORT_MISMATCH: 400,
  OBJECT_NOT_FOUND: 404,
  // A resume aimed at something this object does not own. 409: the request is well formed and
  // the state of the tree is what refuses it (WORKFLOW.MD §5).
  OBJECT_NOT_PAUSED: 409,
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
  // The sensor is fine and so is the caller; who vouched for sending it its credentials is not
  // (`A-41`), and the message says how to change that.
  OBJECT_CREDENTIALS_WITHHELD: 409,
  // An edit that would turn an existing channel from a counter into a gauge or back (`P-303`).
  // 409: the parameters are fine, and would make a new sensor; this sensor's channel refuses
  // them, since its stored samples and the new ones would mean two things on one series.
  OBJECT_CHANNEL_MODE_FIXED: 409,
  // Another change held the tree for longer than this one would wait (`P-229`). 503 with
  // `Retry-After`: nothing about the request was wrong, and the same one can succeed.
  OBJECT_TREE_BUSY: 503,
  // `GET /objects?invalidParams=true` before the start-up pass has judged every sensor, or after
  // it stopped short (`P-375`). 503: the request is fine and the answer is not known yet; a
  // partial list would read as the answer.
  OBJECT_PARAMS_NOT_CHECKED: 503,
  // 503 rather than 500: the request is fine and the core is running, it simply has no vault
  // configured — an operator fixes it in the configuration file, not by retrying.
  CREDENTIAL_VAULT_UNAVAILABLE: 503,
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
  /** Sent as `Retry-After` when the same request can succeed later by itself. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ObjectErrorCode,
    message: string,
    options: {
      context: ErrorContext;
      details?: Record<string, unknown>;
      cause?: unknown;
      retryAfterSeconds?: number;
    },
  ) {
    super(code, message, {
      context: options.context,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ObjectError';
    this.code = code;
    this.status = OBJECT_ERROR_STATUS[code];
    this.details = options.details ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
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
