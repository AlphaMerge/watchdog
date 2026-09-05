import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessRight, AccessService } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { AuthError } from '../auth/errors.js';
import { atLeast, lower } from '../auth/access.js';

/**
 * Who may call a route (`A-11`).
 *
 * **The whole point is that this is not optional.** Before this existed, `AccessService` — the
 * resolver that carries the role ceiling of `A-04` and the token scope of `A-06` — was called by
 * exactly one route, and that route only *reported* the answer. Every mutating route in the
 * installation was open to any authenticated principal: a read-only account could delete every
 * trigger, a read-scoped API token could rewrite the schedules, and `POST /templates/:id/test`
 * would really send a notification for anybody who asked.
 *
 * The reason it went unnoticed is worth stating, because it is the same shape three times in
 * this codebase now. `access-matrix.test.ts` is named for this exact criterion and could not
 * fail on it: its matrix calls one route — `GET /objects/:id/access/effective`, the *reporting*
 * endpoint — so it asserted the resolver against itself, and its route sweep filtered to `GET`.
 * A test that sweeps only reads cannot notice that no write is guarded.
 *
 * So authorisation is declared per route, in the route's own options, and **a route that
 * declares nothing stops the server from starting**. That is the same enforcement the response
 * schemas get, for the same reason: a rule a new endpoint has to remember is a rule a new
 * endpoint will eventually forget, and the failure here is silent and total.
 */
export type RouteAccess =
  /**
   * No principal needed at all. Login, logout, health.
   *
   * Spelled rather than implied by omission: "nobody has thought about this route" and "this
   * route is deliberately open" must not look the same in the source.
   */
  | { kind: 'public' }
  /** Any authenticated principal. A token must hold at least `read`. */
  | { kind: 'read' }
  /** An account that may change things — `readwrite` or `admin`, with a `write` token. */
  | { kind: 'write' }
  /** An administrator, with a `full` token. */
  | { kind: 'admin' }
  /**
   * The caller acting on their own account: password, MFA, the session itself.
   *
   * **Any role, and no API token.** A read-only account must be able to change its own password
   * and enrol in MFA — refusing that would make the role unusable — while an API token must not
   * be able to, because a token that can change the password can lock its owner out of the
   * account that issued it. Neither `read` nor `write` expresses that pair.
   */
  | { kind: 'self' }
  /**
   * A right on one object, resolved through `AccessService` — grants, inheritance, the role
   * ceiling and the token scope, all of it.
   *
   * `param` names the route parameter holding the object id, because it is `:id` on
   * `/objects/:id` and `:objectId` on the routes that hang something off an object.
   */
  | { kind: 'object'; needed: AccessRight; param?: string; from?: 'params' | 'body' | 'query' }
  /**
   * Acknowledging an alarm (`A-04`, migration 034).
   *
   * `write` on the object, **or** `read` plus the account's own `may_acknowledge` opt-in. The
   * exception exists because the person on the end of a phone at 3am is often exactly the
   * account that may look but not change, and "silence this, I am dealing with it" is a note on
   * an alarm rather than a change to the monitored estate. Off by default, per account: a
   * permission that grants itself is not a permission.
   */
  | { kind: 'acknowledge'; param?: string };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required. A route without one makes `ApiServer.build` throw. */
    access?: RouteAccess;
    /**
     * False on a route that is a read wearing a `POST` — a preview over a pasted document, a
     * plan over a fingerprint. Nothing stored, nothing sent.
     *
     * **Orthogonal to the bar, and that is the point.** "Every route that is not a GET asks for
     * more than read" is a rule a test can enforce without a list, and the moment there is one
     * honest exception either the rule goes or the exception is written down. Written down, and
     * next to the route: a route setting this is claiming in its own source that it changes
     * nothing, which is a claim a reviewer can check against the handler three lines below.
     */
    changes?: boolean;
  }
}

/** The roles that satisfy each account-level requirement. */
const ROLES: Readonly<Record<'read' | 'write' | 'admin', readonly AccountRole[]>> = {
  read: ['readonly', 'readwrite', 'admin'],
  write: ['readwrite', 'admin'],
  admin: ['admin'],
};

/** The token scope each account-level requirement needs, on top of the role. */
const SCOPES: Readonly<Record<'read' | 'write' | 'admin', AccessRight>> = {
  read: 'read',
  write: 'write',
  admin: 'full',
};

export interface AuthorizationOptions {
  access: AccessService;
  /**
   * Mirrors `AuthenticationOptions.required`. When false the whole layer stands down, because an
   * installation that has not turned authentication on has no principal to authorise and every
   * request would otherwise be refused as anonymous.
   */
  required: boolean;
}

/**
 * The object id this route is about, from wherever its declaration says it lives.
 *
 * **The body is a real source, not a convenience.** Creating an object names its parent in the
 * body, and the right that matters is `write` on that parent — an account that may not write to
 * a probe must not be able to hang a device off it. Reading the id from the body is the only way
 * to ask that question, and the body has already been schema-validated by the time a
 * `preHandler` runs.
 */
function objectIdFor(
  request: FastifyRequest,
  param: string,
  from: 'params' | 'body' | 'query',
): number {
  const source = (
    from === 'body' ? request.body : from === 'query' ? request.query : request.params
  ) as Record<string, unknown> | undefined;
  const raw = source?.[param];
  const id = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(id)) {
    // Not a 403: the route matched but its id is unusable, so there is no object to have a right
    // on. Answering "forbidden" would tell a caller their credentials were the problem.
    throw new AuthError('ACCESS_INVALID', `route parameter ${param} is not an object id`, {
      param,
    });
  }
  return id;
}

/**
 * Refuses a request whose account, role or token does not reach the declared bar.
 *
 * Registered once, globally, and reads the declaration off the route — so it runs for routes
 * that have not been written yet.
 */
export function registerAuthorization(app: FastifyInstance, options: AuthorizationOptions): void {
  // **`preValidation`, not `preHandler`, and the difference is provable.** Fastify validates the
  // body before `preHandler` runs, so a caller who may not touch a route at all was answered 400
  // for a malformed body rather than 403 — which meant a sweep that posted `{}` at every mutating
  // route could not tell a guard from a schema. Refusing before validating is also the better
  // order on its own terms: an unauthorised caller learns nothing about the shape a route wants.
  app.addHook('preValidation', async (request) => {
    // **A request that matched no route is a 404, and must stay one.** The hook runs for the
    // not-found handler too, where there is no route and so no declaration; refusing it there
    // would answer 403 to every typo, which tells a caller a path exists when it does not.
    if (request.routeOptions.url === undefined) return;

    const declared = request.routeOptions.config.access;
    // Undeclared is not "allow": `build()` refuses to start in that case, so reaching here at
    // all means the guard was bypassed. Refuse rather than fall open.
    if (declared === undefined) {
      throw new AuthError('AUTH_FORBIDDEN', 'this route declares no authorisation');
    }
    if (declared.kind === 'public') return;
    if (!options.required) return;

    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }

    if (declared.kind === 'self') {
      // A session, not a token. `tokenId` is how a token principal is told apart from a session
      // one — the scope cannot do it, because a `full` token is exactly the dangerous case.
      if (principal.tokenId !== undefined) {
        throw new AuthError('AUTH_FORBIDDEN', 'an API token may not change its own account', {
          scope: principal.scope ?? '',
        });
      }
      return;
    }

    if (declared.kind === 'object' || declared.kind === 'acknowledge') {
      const param = declared.param ?? 'id';
      const objectId = objectIdFor(
        request,
        param,
        declared.kind === 'object' ? (declared.from ?? 'params') : 'params',
      );

      if (declared.kind === 'object') {
        await options.access.requireFor(principal, objectId, declared.needed);
        return;
      }

      // Acknowledgement: `write` is the ordinary path, and the opt-in is the exception. Asked in
      // that order so an account that may write is never refused for want of a flag that is
      // meaningless for it.
      const resolved = await options.access.resolveFor(principal, objectId);
      if (atLeast(resolved.right, 'write')) return;
      if (principal.mayAcknowledge && atLeast(resolved.right, 'read')) return;
      throw new AuthError(
        'AUTH_FORBIDDEN',
        'acknowledging needs write on that object, or an account allowed to acknowledge',
        {
          objectId,
          held: resolved.right,
          mayAcknowledge: String(principal.mayAcknowledge),
        },
      );
    }

    const needed = declared.kind;
    if (!ROLES[needed].includes(principal.role)) {
      throw new AuthError(
        'AUTH_FORBIDDEN',
        `this action needs one of: ${ROLES[needed].join(', ')}`,
        {
          role: principal.role,
          needed,
        },
      );
    }
    // **The token scope is a second ceiling and is checked even where there is no object.** This
    // is the half `A-06` never got: the scope was captured onto the principal and threaded into
    // `resolveFor`, so it applied to per-object rights and to nothing else — and since no route
    // asked for a per-object right, it applied to nothing at all.
    if (
      principal.scope !== undefined &&
      lower(principal.scope, SCOPES[needed]) !== SCOPES[needed]
    ) {
      throw new AuthError('AUTH_FORBIDDEN', `this token may only ${principal.scope}`, {
        scope: principal.scope,
        needed: SCOPES[needed],
      });
    }
  });
}

/**
 * The declarations, named once so a route reads `config: WRITES` rather than a nested literal.
 *
 * Terse on purpose. A declaration that is tedious to write is one somebody will be tempted to
 * copy from the route above without reading it — and the wrong bar, confidently declared, is
 * worse than the missing one this guard was built to catch.
 */
export const PUBLIC = { access: { kind: 'public' } } as const satisfies { access: RouteAccess };
export const READS = { access: { kind: 'read' } } as const satisfies { access: RouteAccess };
/** A `POST` that is a read: any authenticated principal, and nothing is written. */
export const COMPUTES = { access: { kind: 'read' }, changes: false } as const satisfies {
  access: RouteAccess;
  changes: boolean;
};
export const WRITES = { access: { kind: 'write' } } as const satisfies { access: RouteAccess };
export const ADMIN = { access: { kind: 'admin' } } as const satisfies { access: RouteAccess };
export const SELF = { access: { kind: 'self' } } as const satisfies { access: RouteAccess };

/** A right on the object named by a route parameter. */
export function onObject(needed: AccessRight, param = 'id'): { access: RouteAccess } {
  return { access: { kind: 'object', needed, param } };
}

/** A right on the object named by a field of the request body — the parent of a creation. */
export function onBodyObject(needed: AccessRight, param: string): { access: RouteAccess } {
  return { access: { kind: 'object', needed, param, from: 'body' } };
}

/** A right on the object named by a query parameter — the sensor a preview renders against. */
export function onQueryObject(needed: AccessRight, param: string): { access: RouteAccess } {
  return { access: { kind: 'object', needed, param, from: 'query' } };
}

/** The same, on a route that computes and stores nothing. */
export function computesOn(declared: { access: RouteAccess }): {
  access: RouteAccess;
  changes: boolean;
} {
  return { ...declared, changes: false };
}

/** Acknowledging the alarm on the object named by a route parameter. */
export function toAcknowledge(param = 'id'): { access: RouteAccess } {
  return { access: { kind: 'acknowledge', param } };
}
