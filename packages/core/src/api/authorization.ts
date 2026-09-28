import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessRight, AccessService } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { AuthError } from '../auth/errors.js';
import { atLeast, lower, Visibility } from '../auth/access.js';

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
  | {
      kind: 'object';
      needed: AccessRight;
      param?: string;
      from?: 'params' | 'body' | 'query';
      /**
       * Absent means "not this request", not "refuse it".
       *
       * Only ever true for a field a route's own schema makes optional — `targetParentId` on a
       * clone, which defaults to cloning in place, or a listing's scope, which defaults to
       * everything the caller can see (`A-12`). A required field that is missing is still a
       * refusal, because the alternative is a guard that a caller turns off by omission.
       */
      optional?: boolean;
      /**
       * The right on everything beneath the object too, for a change that takes the subtree with
       * it: a delete destroys it and a move carries it (`A-35`). A `none` carved beneath an
       * object the caller may write is otherwise a hole they cannot touch directly and can
       * destroy by deleting its parent.
       */
      subtree?: boolean;
    }
  /**
   * A right on an object this request does not name, found by asking (`P-154`).
   *
   * `PUT /triggers/:id` is about the object the trigger is defined on, and nothing in the path
   * or the body says which one that is. Without this the only honest bar such a route can
   * declare is the role, which is how "a read-only account could delete every trigger" became
   * "any account with `readwrite` could delete every trigger" instead of being fixed.
   *
   * Resolving to null means there is nothing for this declaration to check. Usually the row does
   * not exist: the hook allows the request through so the handler answers its own 404, because a
   * guard that answered 403 for a missing id would turn every route into an existence oracle.
   * Inside an `every` it can also mean the request is not the shape this part covers, as
   * `optional` does for an absent field: a clone made in place (`A-35`).
   */
  | {
      kind: 'derived';
      needed: AccessRight;
      /** What is being looked up, for the refusal's context. */
      what: string;
      of: (request: FastifyRequest) => Promise<number | null>;
    }
  /**
   * A right on the root: the installation as a whole (`A-12`).
   *
   * For the routes whose answer describes everything at once — the root's own detail, Core
   * Health, delivery health, the Prometheus scrape — rather than any one branch. An account
   * granted a branch was given that branch, and the name of the installation, its queue depths
   * and the list of its probes are outside it; an account that can read the root was given the
   * whole of it, holes aside.
   */
  | { kind: 'installation'; needed: AccessRight }
  /**
   * Every one of these, in order.
   *
   * A move or a clone is two questions — may this caller take the object, and may they put it
   * there — and answering only the first is how an object gets dropped into a subtree the
   * caller was explicitly denied.
   */
  | { kind: 'every'; of: readonly RouteAccess[] }
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
    /**
     * Where the right on this route's subject is decided, when the subject is not in the object
     * tree — a map, a report (`A-14`).
     *
     * **The declared bar still applies and is still checked here**: `write` refuses a read-only
     * account and a read-scoped token before anything is parsed. What the hook cannot answer is
     * "may this caller change *this* map", because `onObject` resolves against the object tree
     * and a map is not in it; the service that owns maps is the one place that decides, and this
     * names it. Set in the route's own source, next to the handler that calls that service, so
     * the claim is reviewed where it is made — the same bargain `changes: false` strikes — and
     * read by the matrix, which skips the object-grant sweep for exactly these routes and no
     * others. Never set on a route whose subject *is* in the tree: there, `onObject` is the check.
     */
    rightsIn?: string;
    /**
     * Why this route, which changes something, writes no audit entry (`A-17`).
     *
     * Absent means it does, and the audit sweep calls it to prove so. Present means one of two
     * things, said here beside the handler so a reviewer can hold the claim against the code:
     * `exempt`, because what it changes is not configuration — a session, a test send — or
     * `gap`, because it should and does not yet, owned by the named ticket. A gap is a debt with
     * a name; the ticket that pays it removes the declaration.
     */
    audit?: AuditDeclaration;
  }
}

/** See `audit` on the route config. */
export type AuditDeclaration =
  | { readonly kind: 'exempt'; readonly why: string }
  | { readonly kind: 'gap'; readonly ticket: string };

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
 * to ask that question.
 *
 * **The body here is parsed, not validated** (`G04`). This hook runs at `preValidation`, on
 * purpose, so that a caller who may not touch a route at all is refused before being told what
 * shape it wants — which means the value is whatever the caller sent, and not what the route's
 * schema promises. So it is coerced here and anything that is not an object id is refused,
 * rather than trusted because a schema that has not run yet says it is an integer.
 */
function objectIdFor(
  request: FastifyRequest,
  param: string,
  from: 'params' | 'body' | 'query',
  optional: boolean,
): number | undefined {
  const source = (
    from === 'body' ? request.body : from === 'query' ? request.query : request.params
  ) as Record<string, unknown> | undefined;
  const raw = source?.[param];
  if (optional && (raw === undefined || raw === null)) return undefined;
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
 * How each request resolves what its caller may see, installed by the hook below (`A-12`).
 *
 * Keyed by the request rather than decorated onto it, and resolved at most once however many
 * queries a handler runs. Absent only where the authorisation layer was never registered — a
 * build with no accounts at all — which is the one case where "everything" is the truth rather
 * than a default.
 */
const sights = new WeakMap<FastifyRequest, { once: () => Promise<Visibility>; fresh: Sight }>();

/** Resolves what a principal may see, afresh each time it is called. */
export interface Sight {
  (): Promise<Visibility>;
  /** Names the principal, so a caller resolving for many sockets can ask once per account. */
  readonly key: string;
}

const EVERYONE: Sight = Object.assign(() => Promise.resolve(Visibility.EVERYTHING), {
  key: 'everyone',
});

/**
 * What the caller of this request may see of the object tree (`A-12`).
 *
 * The argument every listing passes to its service. Everything when the authorisation layer is
 * off, as every other bar in this file is; a refusal on a `PUBLIC` route, which has no principal
 * to see through and must not be able to list the tree by asking.
 */
export function visibilityOf(request: FastifyRequest): Promise<Visibility> {
  const sight = sights.get(request);
  return sight === undefined ? Promise.resolve(Visibility.EVERYTHING) : sight.once();
}

/**
 * Whether this request's caller clears an account-level bar, asked rather than enforced (`A-26`).
 *
 * For a route whose answer depends on who is asking rather than one that refuses. An object's
 * history is readable with `read` on the object, but its `grant` entries belong to whoever may
 * read the grants themselves, and that is `ADMIN`. The test is the one `enforce` applies, the
 * role and then the token's scope, so the two cannot disagree about who administers. Everybody
 * clears it when the authorisation layer is off, as every bar in this file does, and nobody does
 * on a `PUBLIC` route.
 */
export function clears(request: FastifyRequest, bar: 'read' | 'write' | 'admin'): boolean {
  const sight = sights.get(request);
  if (sight === undefined || sight.fresh === EVERYONE) return true;
  const principal = request.principal;
  if (principal === undefined) return false;
  if (!ROLES[bar].includes(principal.role)) return false;
  return principal.scope === undefined || lower(principal.scope, SCOPES[bar]) === SCOPES[bar];
}

/**
 * How to ask again, for as long as this request's principal is around (`A-12`).
 *
 * The stream's: a WebSocket is one request that lives for days, and every subscription on it
 * has to see the grants as they are when it subscribes rather than as they were when the socket
 * opened — so it holds this rather than the answer `visibilityOf` memoised.
 */
export function sightOf(request: FastifyRequest): Sight {
  return sights.get(request)?.fresh ?? EVERYONE;
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
    if (declared.kind === 'public') {
      const nobody: Sight = Object.assign(
        () =>
          Promise.reject(
            new AuthError('AUTH_REQUIRED', 'a public route has nobody to see through'),
          ),
        { key: 'nobody' },
      );
      sights.set(request, { once: nobody, fresh: nobody });
      return;
    }
    if (!options.required) {
      sights.set(request, { once: EVERYONE, fresh: EVERYONE });
      return;
    }

    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }

    const fresh: Sight = Object.assign(() => options.access.visibilityFor(principal), {
      key: `${String(principal.userId)}:${principal.role}:${principal.scope ?? ''}`,
    });
    let resolved: Promise<Visibility> | undefined;
    sights.set(request, { once: () => (resolved ??= fresh()), fresh });

    await enforce(options.access, request, principal, declared);
  });
}

/**
 * One declaration, checked. Separate from the hook so `every` can recurse into it.
 */
async function enforce(
  access: AccessService,
  request: FastifyRequest,
  principal: NonNullable<FastifyRequest['principal']>,
  declared: RouteAccess,
): Promise<void> {
  if (declared.kind === 'public') return;

  if (declared.kind === 'every') {
    // In order, and the first refusal wins: the source of a move is checked before its
    // destination, so a caller who may not touch the object at all learns nothing about where
    // they tried to put it.
    for (const one of declared.of) await enforce(access, request, principal, one);
    return;
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

  if (declared.kind === 'installation') {
    await access.requireFor(principal, await access.rootId(), declared.needed);
    return;
  }

  if (declared.kind === 'derived') {
    const objectId = await declared.of(request);
    // Null is "there is no such row", which is the handler's 404 to answer and not the guard's
    // 403 — see the declaration.
    if (objectId === null) return;
    const resolved = await access.resolveFor(principal, objectId);
    if (atLeast(resolved.right, declared.needed)) return;
    // Named, because "this action needs write on that object" is unhelpful for a route whose
    // path holds no object id: the operator has to be told *which* object the id they sent
    // turned out to be about.
    throw new AuthError(
      'AUTH_FORBIDDEN',
      `this action needs ${declared.needed} on the object that ${declared.what} belongs to`,
      { objectId, held: resolved.right, needed: declared.needed, via: declared.what },
    );
  }

  if (declared.kind === 'object' || declared.kind === 'acknowledge') {
    const param = declared.param ?? 'id';
    const objectId = objectIdFor(
      request,
      param,
      declared.kind === 'object' ? (declared.from ?? 'params') : 'params',
      declared.kind === 'object' && declared.optional === true,
    );
    if (objectId === undefined) return;

    if (declared.kind === 'object') {
      // The object first, so a caller refused the object itself hears the ordinary refusal
      // with what they hold, and only a caller who may take it learns there is more beneath.
      await access.requireFor(principal, objectId, declared.needed);
      if (declared.subtree === true) {
        await access.requireSubtreeFor(principal, objectId, declared.needed);
      }
      return;
    }

    // Acknowledgement: `write` is the ordinary path, and the opt-in is the exception. Asked in
    // that order so an account that may write is never refused for want of a flag that is
    // meaningless for it.
    const resolved = await access.resolveFor(principal, objectId);
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
    throw new AuthError('AUTH_FORBIDDEN', `this action needs one of: ${ROLES[needed].join(', ')}`, {
      role: principal.role,
      needed,
    });
  }
  // **The token scope is a second ceiling and is checked even where there is no object.** This
  // is the half `A-06` never got: the scope was captured onto the principal and threaded into
  // `resolveFor`, so it applied to per-object rights and to nothing else — and since no route
  // asked for a per-object right, it applied to nothing at all.
  if (principal.scope !== undefined && lower(principal.scope, SCOPES[needed]) !== SCOPES[needed]) {
    throw new AuthError('AUTH_FORBIDDEN', `this token may only ${principal.scope}`, {
      scope: principal.scope,
      needed: SCOPES[needed],
    });
  }
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
/** Read on the root: a route whose answer is about the whole installation (`A-12`). */
export const INSTALLATION = {
  access: { kind: 'installation', needed: 'read' },
} as const satisfies { access: RouteAccess };
export const SELF = { access: { kind: 'self' } } as const satisfies { access: RouteAccess };

/**
 * A change to something outside the object tree, whose own right is decided by `service` (`A-14`).
 *
 * `write` as a role and a token scope, checked by the hook like any `WRITES` — and a declaration
 * of where the rest is checked. Maps and reports used `READS` for every route, on the reasoning
 * that the service decides; it did, for a right on a map that exists, and creating one has no
 * such right, so a read-only account and a read-scoped token both created them.
 */
export function writesIn(service: string): { access: RouteAccess; rightsIn: string } {
  return { access: { kind: 'write' }, rightsIn: service };
}

/**
 * A route that changes something other than configuration, and so writes no audit entry.
 *
 * For the handful that genuinely are that — starting or ending a session, a test send — and for
 * nothing an operator would come to the audit log looking for (`A-17`).
 */
export function notAudited(why: string): { audit: AuditDeclaration } {
  return { audit: { kind: 'exempt', why } };
}

/** A route that should write an audit entry and does not yet; `ticket` is what fixes it. */
export function auditGap(ticket: string): { audit: AuditDeclaration } {
  return { audit: { kind: 'gap', ticket } };
}

/** A right on the object named by a route parameter. */
export function onObject(needed: AccessRight, param = 'id'): { access: RouteAccess } {
  return { access: { kind: 'object', needed, param } };
}

/**
 * A right on the object named by a route parameter and on everything beneath it (`A-35`).
 *
 * For a change that takes the whole subtree with it — a delete, a move. Not for one that only
 * reaches beneath by inheritance: a pause or a setting on a container flows into a hole the way
 * every inherited value does, and changes nothing that is stored there.
 */
export function onSubtree(needed: AccessRight, param = 'id'): { access: RouteAccess } {
  return { access: { kind: 'object', needed, param, subtree: true } };
}

/**
 * A right on the object named by a field of the request body — the parent of a creation.
 *
 * `optional` is for a field the route's own schema makes optional, and nothing else. **An absent
 * field is not "no second object"**: a clone with no `targetParentId` lands in its source's
 * parent, which is a second object, and `write` on the source says nothing about it when the
 * source is itself where a grant was made. That route declares the parent separately (`A-35`).
 */
export function onBodyObject(
  needed: AccessRight,
  param: string,
  opts: { optional?: boolean } = {},
): { access: RouteAccess } {
  return {
    access: {
      kind: 'object',
      needed,
      param,
      from: 'body',
      ...(opts.optional === true ? { optional: true } : {}),
    },
  };
}

/**
 * Every one of these bars, in the order given (`P-154`).
 *
 * The shape a move or a clone needs: `write` on what is being taken, and `write` on where it is
 * going. Checking only the first lets an operator drop a device — and everything it will go on
 * to alarm about — into a branch of the tree they were denied.
 */
export function every(...declared: readonly { access: RouteAccess }[]): { access: RouteAccess } {
  return { access: { kind: 'every', of: declared.map((one) => one.access) } };
}

/**
 * A right on an object this request does not name, looked up by the route (`P-154`).
 *
 * For the routes addressed by something that *belongs* to an object rather than by the object:
 * `/triggers/:id` is a trigger id, and the right that matters is on the object it is defined on.
 */
export function onDerivedObject(
  needed: AccessRight,
  what: string,
  of: (request: FastifyRequest) => Promise<number | null>,
): { access: RouteAccess } {
  return { access: { kind: 'derived', needed, what, of } };
}

/**
 * A right on the object named by a query parameter — the sensor a preview renders against.
 *
 * `optional` is for a *scope*: `?objectId=` on the alarms, `?parentId=` on the object list. Left
 * out, the listing covers everything the caller can see; given, it has to name an object the
 * caller can read (`A-12`). Serving the visible part of a hidden scope instead would answer
 * "which of my sensors are beneath object 4711", which is a question about the shape of a branch
 * the caller cannot see.
 */
export function onQueryObject(
  needed: AccessRight,
  param: string,
  opts: { optional?: boolean } = {},
): { access: RouteAccess } {
  return {
    access: {
      kind: 'object',
      needed,
      param,
      from: 'query',
      ...(opts.optional === true ? { optional: true } : {}),
    },
  };
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
