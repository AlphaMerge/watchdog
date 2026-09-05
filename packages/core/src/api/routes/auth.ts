import '@fastify/swagger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@ms/shared';
import type { AccountService } from '../../auth/accounts.js';
import { AuthError } from '../../auth/errors.js';
import type { SessionService } from '../../auth/sessions.js';
import type { LoginThrottle } from '../../auth/throttle.js';
import type { TotpService } from '../../auth/totp.js';
import { SESSION_COOKIE, sessionTokenFrom } from '../authentication.js';
import { PUBLIC, READS, SELF } from '../authorization.js';

export interface AuthRoutesOptions {
  accounts: AccountService;
  sessions: SessionService;
  throttle: LoginThrottle;
  /** Absent means this build has no second factor. */
  totp?: TotpService;
  logger: Logger;
}

const principalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'login', 'role', 'mustChangePassword'],
  properties: {
    userId: { type: 'integer' },
    login: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'readwrite', 'readonly'] },
    mustChangePassword: {
      type: 'boolean',
      description:
        'The password was set by somebody else — the bootstrap, or an administrator resetting ' +
        'it. A client should send the user to a change-password form before anything else.',
    },
  },
} as const;

/**
 * Logging in and out (`A-01`).
 *
 * **The session lives in a cookie, and the cookie is `HttpOnly`.** A token in `localStorage` is
 * readable by any script that gets onto the page, which is the whole of what an XSS is worth;
 * `HttpOnly` means the one thing an injected script cannot do is read the session. `SameSite=Lax`
 * is what stops another site's form posting as this operator — `A-10`'s CSRF work builds on it
 * rather than replacing it.
 */
export function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { accounts, sessions, throttle, totp, logger } = options;

  /**
   * **`Secure` is decided per request rather than configured**, because guessing it wrong is bad
   * in both directions: set always, and login over plain HTTP silently fails because the browser
   * never sends the cookie back; set never, and a session issued over TLS travels in clear on the
   * next plain-HTTP request to the same host. Asking the request that is actually in hand is the
   * one answer that is right in both deployments, and it needs no option an operator can get
   * wrong. Behind a TLS-terminating proxy this reads the proxy's own header only when Fastify is
   * configured to trust it, which is the correct default — an untrusted `X-Forwarded-Proto` is a
   * claim anybody can make.
   */
  const cookieParts = (request: FastifyRequest, value: string, expires: string): string => {
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Expires=${expires}`,
    ];
    if (request.protocol === 'https') parts.push('Secure');
    return parts.join('; ');
  };

  /** The caller's own principal, or a 401. Every route below is about the caller's own account. */
  const mine = (request: FastifyRequest) => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    return principal;
  };

  const setSessionCookie = (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    expiresAt: Date,
  ): void => {
    void reply.header(
      'Set-Cookie',
      cookieParts(request, encodeURIComponent(token), expiresAt.toUTCString()),
    );
  };

  const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply): void => {
    void reply.header('Set-Cookie', cookieParts(request, '', 'Thu, 01 Jan 1970 00:00:00 GMT'));
  };

  app.post<{ Body: { login: string; password: string; code?: string } }>(
    '/auth/login',
    {
      config: PUBLIC,
      schema: {
        tags: ['auth'],
        summary: 'Exchange a login and password for a session',
        description:
          'Every failure answers 401 with the same code and the same sentence. Distinguishing ' +
          '"no such account" from "wrong password" would let a caller test which logins exist, ' +
          'and a login is half a credential — so which it was goes to the core log instead.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['login', 'password'],
          properties: {
            login: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 512 },
            code: {
              type: 'string',
              maxLength: 64,
              description:
                'A TOTP code or a recovery code, when the account needs one. A login without it ' +
                'answers 401 MFA_REQUIRED, which is how a client knows to ask.',
            },
          },
        },
        response: {
          200: principalSchema,
        },
      },
    },
    async (request, reply) => {
      const { login, password } = request.body;
      const address = request.ip;

      const verdict = await throttle.check(login, address);
      if (verdict.refused) {
        void reply.header('Retry-After', String(verdict.retryAfterSeconds));
        throw new AuthError(
          'AUTH_THROTTLED',
          'too many failed logins from this address; try again later',
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }

      const outcome = await accounts.authenticate(login, password);
      if (outcome.kind !== 'ok') {
        await throttle.record(login, address, false);
        // **The delay is spent before answering, not before verifying.** Delaying the check
        // would leave the same number of verifications running at once and slow nothing down
        // except the honest user; delaying the *answer* is what costs a guessing run its rate.
        await throttle.waitOut(verdict);
        logger.warn({ login, remoteAddress: address, reason: outcome.reason }, 'login rejected');
        throw new AuthError('AUTH_REJECTED', 'that login and password were not accepted');
      }

      // **The second factor is checked after the password and before the session.** After,
      // because an account that does not exist must not be told whether it would have needed a
      // code — that is the same enumerator the password path is careful about. Before the
      // session, because a session issued and then withheld is a session that exists.
      if (totp !== undefined && (await totp.isRequired(outcome.account.id))) {
        if (!(await totp.isEnrolled(outcome.account.id))) {
          // Required but not enrolled. Refusing outright would lock out everybody the policy was
          // just switched on for; a client is told to walk them through setup instead.
          await throttle.record(login, address, true);
          logger.warn({ login }, 'a group requires MFA and this account has not enrolled');
          throw new AuthError(
            'MFA_REQUIRED',
            'a group this account belongs to requires multi-factor authentication, and it has ' +
              'not been set up yet',
            { enrolled: 'false' },
          );
        }

        const code = request.body.code;
        if (code === undefined || code === '') {
          throw new AuthError('MFA_REQUIRED', 'this account needs a second factor', {
            enrolled: 'true',
          });
        }
        if (!(await totp.verify(outcome.account.id, code))) {
          // Counted as a failed login: a code is guessable in a way a password is not — six
          // digits is a million tries — so the throttle has to see these too.
          await throttle.record(login, address, false);
          await throttle.waitOut(verdict);
          logger.warn({ login, remoteAddress: address }, 'login rejected: second factor');
          throw new AuthError('MFA_CODE_INVALID', 'that code was not accepted');
        }
      }

      await throttle.record(login, address, true);
      const { token, expiresAt } = await sessions.start(outcome.account, {
        remoteAddress: address,
        userAgent: request.headers['user-agent'] ?? '',
      });
      setSessionCookie(request, reply, token, expiresAt);

      return {
        userId: outcome.account.id,
        login: outcome.account.login,
        role: outcome.account.role,
        mustChangePassword: outcome.account.mustChangePassword,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      config: PUBLIC,
      schema: {
        tags: ['auth'],
        summary: 'End the current session',
        description:
          'Idempotent, and public: logging out with a session that has already expired is the ' +
          'ordinary case and must not answer 401, or a client can be stuck unable to clear it.',
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = sessionTokenFrom(request);
      if (token !== undefined) await sessions.end(token);
      clearSessionCookie(request, reply);
      return reply.status(204).send();
    },
  );

  app.get(
    '/auth/me',
    {
      config: READS,
      schema: {
        tags: ['auth'],
        summary: 'Who this session belongs to',
        response: { 200: principalSchema },
      },
    },
    (request: FastifyRequest) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
      }
      return {
        userId: principal.userId,
        login: principal.login,
        role: principal.role,
        mustChangePassword: principal.mustChangePassword,
      };
    },
  );

  // ── multi-factor authentication (A-07) ──────────────────────────────────────────────────

  app.get(
    '/auth/mfa',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Whether this account has, or needs, a second factor',
        description:
          '`required` and `confirmed` are reported separately because the gap between them is ' +
          'the interesting state: an account a policy now demands MFA of, which has not set it ' +
          'up, has to be walked through enrolment before it can do anything.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['enrolled', 'confirmed', 'required', 'recoveryCodesLeft'],
            properties: {
              enrolled: { type: 'boolean' },
              confirmed: { type: 'boolean' },
              required: { type: 'boolean' },
              recoveryCodesLeft: {
                type: 'integer',
                description: 'Zero, with MFA on, is a lockout waiting for a lost phone.',
              },
            },
          },
        },
      },
    },
    async (request) => {
      const principal = mine(request);
      if (totp === undefined) {
        return { enrolled: false, confirmed: false, required: false, recoveryCodesLeft: 0 };
      }
      return totp.status(principal.userId);
    },
  );

  app.post(
    '/auth/mfa/enrol',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Begin enrolment',
        description:
          'Returns a secret and an otpauth:// URI for a QR code. **Nothing changes until the ' +
          'enrolment is confirmed with a code from the device** — an unconfirmed secret does ' +
          'nothing at all, which is what stops a mistyped setup locking somebody out.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['secret', 'uri'],
            properties: {
              secret: { type: 'string', description: 'Base32, for typing in by hand.' },
              uri: { type: 'string', description: 'otpauth:// URI to render as a QR code.' },
            },
          },
        },
      },
    },
    async (request) => {
      const principal = mine(request);
      if (totp === undefined) {
        throw new AuthError('MFA_NOT_ENROLLED', 'this build has no multi-factor authentication');
      }
      return totp.beginEnrolment(principal.userId, principal.login);
    },
  );

  app.post<{ Body: { code: string } }>(
    '/auth/mfa/confirm',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Confirm enrolment with a code, and receive recovery codes',
        description:
          'The recovery codes are in this response and nowhere else, ever again. They exist ' +
          'because an installation that can only be entered with a device somebody is holding ' +
          'is one that a dropped phone takes down.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['recoveryCodes'],
            properties: { recoveryCodes: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
    },
    async (request) => {
      const principal = mine(request);
      if (totp === undefined) {
        throw new AuthError('MFA_NOT_ENROLLED', 'this build has no multi-factor authentication');
      }
      return totp.confirmEnrolment(principal.userId, request.body.code);
    },
  );

  app.post<{ Body: { password: string } }>(
    '/auth/mfa/disable',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Turn off multi-factor authentication',
        description:
          'Needs the account password. Turning off a second factor from a session alone would ' +
          'make a stolen session enough to remove the thing protecting against stolen sessions.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: { password: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const principal = mine(request);
      if (totp === undefined) {
        throw new AuthError('MFA_NOT_ENROLLED', 'this build has no multi-factor authentication');
      }
      const confirmed = await accounts.authenticate(principal.login, request.body.password);
      if (confirmed.kind !== 'ok') {
        throw new AuthError('ACCOUNT_PASSWORD_WRONG', 'that password was not accepted');
      }
      await totp.disable(principal.userId);
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/mfa/recovery-codes',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Issue a fresh set of recovery codes',
        description: 'The previous set stops working immediately.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['recoveryCodes'],
            properties: { recoveryCodes: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
    },
    async (request) => {
      const principal = mine(request);
      if (totp === undefined) {
        throw new AuthError('MFA_NOT_ENROLLED', 'this build has no multi-factor authentication');
      }
      return { recoveryCodes: await totp.regenerateRecoveryCodes(principal.userId) };
    },
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password',
    {
      config: SELF,
      schema: {
        tags: ['auth'],
        summary: 'Change your own password',
        description:
          'Ends every *other* session this account holds. The reason somebody changes a password ' +
          'is usually that they think somebody else knows it, and leaving the sessions it opened ' +
          'is leaving the door they were worried about. The session making the change survives, ' +
          'so changing your password does not log you out of the tab you did it in.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 512 },
            newPassword: { type: 'string', minLength: 12, maxLength: 512 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['endedSessions'],
            properties: { endedSessions: { type: 'integer' } },
          },
        },
      },
    },
    async (request) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
      }
      await accounts.changePassword(principal.userId, request.body.newPassword, {
        current: request.body.currentPassword,
      });
      const ended = await sessions.endAllFor(principal.userId, principal.sessionId);
      return { endedSessions: ended };
    },
  );
}
