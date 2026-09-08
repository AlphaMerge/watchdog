import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@ms/shared';
import type { Actor } from '../objects/audit.js';
import type { AccountRole } from '../auth/accounts.js';
import { AuthError } from '../auth/errors.js';
import type { Principal, SessionService } from '../auth/sessions.js';
import type { TokenService } from '../auth/tokens.js';
import type { AccessRight } from '../auth/access.js';

/**
 * Who is making this request (`A-01`).
 *
 * **One place, and that is the whole point.** Four route files each carried their own `actorFor`
 * returning `{ kind: 'anonymous', remoteAddress: request.ip }`, which is four places to forget
 * when authentication arrives and four places for them to drift. It is the same rule this
 * codebase already applies to inheritance and to credential redaction: resolved once, so a new
 * endpoint cannot get it wrong by omission.
 *
 * **The cookie is read here and nowhere else.** A route that parsed it itself would be a route
 * that could accept a session this layer would have refused.
 */

export const SESSION_COOKIE = 'ms_session';

/**
 * A request's principal, however it authenticated.
 *
 * **A token principal carries a `scope` and a session one does not**, and that difference is the
 * whole of `A-06`'s authorisation story: the scope is a second ceiling, applied on top of the
 * account's role, so a token can only ever be less than its owner.
 */
export type RequestPrincipal = Principal & {
  /** Present when a token authenticated this request. */
  tokenId?: number;
  scope?: AccessRight;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on every request. Never undefined inside a handler. */
    principal?: RequestPrincipal | undefined;
  }
}

/**
 * The bearer token on this request, if it presented one.
 *
 * `Authorization: Bearer …` and nothing else. An API token in a query string is an API token in
 * every access log, proxy log and browser history between here and the caller — so a token
 * offered that way is not read at all rather than read with a warning.
 */
export function bearerTokenFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * The actor for the audit log, from whatever authenticated this request.
 *
 * Anonymous is still a real answer: it is what an unauthenticated request is, and recording the
 * address it came from is more useful than recording nothing.
 */
export function actorFor(request: FastifyRequest): Actor {
  const principal = request.principal;
  if (principal !== undefined) {
    return { kind: 'user', userId: principal.userId, login: principal.login };
  }
  return { kind: 'anonymous', remoteAddress: request.ip };
}

/**
 * Reads the session cookie without a cookie plugin.
 *
 * `Cookie` is a well-defined header and this needs exactly one name from it; adding a dependency
 * to split a string on `;` would be a dependency to audit, update and ship. Signing is not
 * wanted either — the value is already 32 random bytes whose hash is the only thing stored, so a
 * signature would protect a secret that is already unforgeable.
 */
export function sessionTokenFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value === '' ? undefined : decodeURIComponent(value);
  }
  return undefined;
}

export interface AuthenticationOptions {
  sessions: SessionService;
  /** Absent means this build accepts sessions only. */
  tokens?: TokenService;
  logger: Logger;
  /**
   * When false, unauthenticated requests are allowed through as `anonymous` and every route
   * behaves as it did before `A-01`.
   *
   * **It exists because turning authentication on is an upgrade, not a fresh install.** An
   * installation that upgrades into this must not find its own API shut off before anybody has
   * been given an account — so the switch is explicit, it defaults to on for a new install, and
   * `A-04` is where read-only enforcement lands on top of it.
   */
  required: boolean;
  /** Paths that never need a session, whatever `required` says. */
  publicPaths?: readonly string[];
}

/**
 * Login, logout and the app shell itself: refusing these would make logging in impossible.
 *
 * `/auth/session` is here for the same reason and is easy to miss: it is the route a client
 * asks *whether this installation needs a login at all*, so guarding it behind a session makes
 * it answer only the callers who already know. A route's own `config: PUBLIC` does not reach
 * this hook — this list is the hook's, and the two have to agree.
 *
 * **Exported so a test can check every entry is a route that exists.** It carried
 * `/api/v1/health` for months, and there has never been such a route — the health endpoints are
 * `/core-health`, `/probes/:id/health` and `/notification-health`, all of them behind `READS`.
 * It exempted nothing, which is why nothing noticed; what it did do was read, to anyone opening
 * this file, as evidence that an unauthenticated liveness endpoint exists. Whether this
 * installation should have one is a real question — a load balancer or a systemd unit generally
 * wants it — and it is a decision to take rather than a line to leave lying here implying it was
 * already taken.
 */
export const ALWAYS_PUBLIC = [
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/session',
];

export function registerAuthentication(app: FastifyInstance, options: AuthenticationOptions): void {
  const publicPaths = new Set([...ALWAYS_PUBLIC, ...(options.publicPaths ?? [])]);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // **The bearer token is tried first, and a request may present only one credential.** A
    // request carrying both a cookie and a token is a browser that also set an Authorization
    // header — almost always a client bug, and resolving to whichever happens to work would make
    // it an intermittent one. The explicit credential wins.
    const bearer = bearerTokenFrom(request);
    if (bearer !== undefined && options.tokens !== undefined) {
      const principal = await options.tokens.resolve(bearer);
      if (principal !== null) {
        request.principal = {
          userId: principal.userId,
          login: principal.login,
          role: principal.role,
          mustChangePassword: principal.mustChangePassword,
          mayAcknowledge: principal.mayAcknowledge,
          // A token session id is not a session: nothing may end it through /auth/logout.
          sessionId: '',
          tokenId: principal.tokenId,
          scope: principal.scope,
        };
      }
    } else {
      const token = sessionTokenFrom(request);
      if (token !== undefined) {
        // Resolving also *extends* the session, so an active operator stays logged in. A token
        // that no longer resolves is simply not authenticated — never an error, because a client
        // holding an expired cookie is the ordinary case and deserves a login page, not a 500.
        request.principal = (await options.sessions.resolve(token)) ?? undefined;
      }
    }

    if (!options.required) return;
    if (request.principal !== undefined) return;

    // Only API routes are guarded here. The app shell and its assets are public by necessity —
    // the login form is served from them — and they carry nothing but the client bundle.
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    if (publicPaths.has(path)) return;

    // Thrown rather than replied, so it goes through the one error envelope every other failure
    // uses and a client never has to parse two shapes.
    void reply;
    throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
  });
}

/**
 * Refuses a request whose account does not hold one of these roles.
 *
 * Used as a `preHandler` on the routes that administer accounts. Per-object rights are `A-03`
 * and are a different question — this is the account-level one, which is true of the account
 * everywhere or nowhere.
 */
export function requireRole(...roles: readonly AccountRole[]) {
  return async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    if (!roles.includes(principal.role)) {
      throw new AuthError(
        'AUTH_FORBIDDEN',
        `this action needs one of these roles: ${roles.join(', ')}`,
        { role: principal.role },
      );
    }
    await Promise.resolve();
  };
}
