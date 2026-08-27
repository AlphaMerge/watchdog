import '@fastify/swagger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@ms/shared';
import type { AccountService } from '../../auth/accounts.js';
import { AuthError } from '../../auth/errors.js';
import type { SessionService } from '../../auth/sessions.js';
import type { LoginThrottle } from '../../auth/throttle.js';
import { SESSION_COOKIE, sessionTokenFrom } from '../authentication.js';

export interface AuthRoutesOptions {
  accounts: AccountService;
  sessions: SessionService;
  throttle: LoginThrottle;
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
  const { accounts, sessions, throttle, logger } = options;

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

  app.post<{ Body: { login: string; password: string } }>(
    '/auth/login',
    {
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

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password',
    {
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
