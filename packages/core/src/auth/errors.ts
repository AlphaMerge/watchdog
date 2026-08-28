import { AppError } from '@ms/shared';

/**
 * Failures the caller can act on (`A-01`), typed rather than mapped by message.
 *
 * The same shape every other subsystem here uses — the status travels with the error, and
 * `toHttpError` switches on the *type*, never on the string.
 *
 * **`AUTH_REJECTED` deliberately covers every reason a login failed.** No such account, wrong
 * password and disabled account are one code and one sentence, because distinguishing them is a
 * login enumerator: an attacker with a list of addresses learns which are real by reading the
 * error, and a login is half a credential. Which of the three it actually was goes to the log,
 * where the operator investigating can see it and an attacker cannot.
 */
export type AuthErrorCode =
  | 'AUTH_REJECTED'
  | 'AUTH_REQUIRED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_THROTTLED'
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_LOGIN_INVALID'
  | 'ACCOUNT_PASSWORD_WEAK'
  | 'ACCOUNT_PASSWORD_WRONG'
  | 'ACCOUNT_LAST_ADMIN'
  | 'GROUP_EXISTS'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_INVALID'
  | 'GROUP_BUILTIN'
  | 'GROUP_NOT_MEMBER'
  | 'ACCESS_TARGET_MISSING'
  | 'ACCESS_INVALID'
  | 'ACCOUNT_READONLY_ADMIN';

const STATUS: Readonly<Record<AuthErrorCode, number>> = {
  // 401, not 403: the credentials were not accepted, and the client may present better ones.
  AUTH_REJECTED: 401,
  AUTH_REQUIRED: 401,
  // 403: authenticated, and still not allowed. A client that retries with the same session gets
  // the same answer, which is what distinguishes this from a 401.
  AUTH_FORBIDDEN: 403,
  AUTH_THROTTLED: 429,
  ACCOUNT_EXISTS: 409,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_LOGIN_INVALID: 400,
  ACCOUNT_PASSWORD_WEAK: 400,
  // 400 rather than 401: this is a *change-password* request that named the wrong current
  // password. The session is perfectly valid; the body is wrong.
  ACCOUNT_PASSWORD_WRONG: 400,
  ACCOUNT_LAST_ADMIN: 409,
  GROUP_EXISTS: 409,
  GROUP_NOT_FOUND: 404,
  GROUP_INVALID: 400,
  // 409 rather than 403: the caller may well be an administrator, and the refusal is about the
  // group being structural rather than about who is asking.
  GROUP_BUILTIN: 409,
  GROUP_NOT_MEMBER: 400,
  ACCESS_TARGET_MISSING: 404,
  ACCESS_INVALID: 400,
  // 409: the request is coherent, the installation's current shape refuses it.
  ACCOUNT_READONLY_ADMIN: 409,
};

export class AuthError extends AppError {
  readonly status: number;

  constructor(code: AuthErrorCode, message: string, context: Record<string, string | number> = {}) {
    super(code, message, { context });
    this.name = 'AuthError';
    this.status = STATUS[code];
  }
}
