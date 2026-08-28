import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@ms/shared';
import { AuthError } from '../auth/errors.js';

/**
 * Security headers, CSRF and request rate limiting (`A-09`).
 *
 * **Written here rather than taken from a plugin, and that is a decision with a reason.** Each of
 * these is a few dozen lines and one policy judgement; a plugin is a dependency to audit, update
 * and ship inside an installer, and `CLAUDE.md`'s standalone constraint means every one of those
 * is an operator's problem too. What a plugin would buy — configurability we do not want and
 * defaults we would override — is not worth that.
 */

/**
 * Headers on every response.
 *
 * **The CSP is the only one with a real decision in it.** `default-src 'self'` with no
 * `unsafe-inline` is what makes an injected `<script>` inert, and it costs the ability to use
 * inline styles — which is why the UI ships a stylesheet rather than style attributes. The rest
 * are cheap: they turn off browser behaviours this application never wants.
 */
const HEADERS: Readonly<Record<string, string>> = {
  // Scripts, styles and connections from this origin only. `img-src` allows data: because
  // uPlot renders to canvas and exports PNGs from it.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  // No sniffing: a JSON response that a browser decides is HTML is an XSS in an API.
  'x-content-type-options': 'nosniff',
  // `frame-ancestors 'none'` above covers modern browsers; this covers the rest.
  'x-frame-options': 'DENY',
  // A monitoring URL carries object ids and search terms. Neither belongs in a third party's
  // access log because somebody clicked a link in a sensor's comment field.
  'referrer-policy': 'no-referrer',
  // This application asks for none of these, and saying so stops an injected script asking.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * `Strict-Transport-Security`, added only on a TLS request.
 *
 * **Never on plain HTTP**, where it would be ignored by a compliant browser and actively harmful
 * behind a proxy that terminates TLS elsewhere — an installation reachable on both would find
 * the plain-HTTP one unreachable for a year.
 */
const HSTS = 'max-age=31536000; includeSubDomains';

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (request: FastifyRequest, reply: FastifyReply, payload, done) => {
    for (const [name, value] of Object.entries(HEADERS)) void reply.header(name, value);
    if (request.protocol === 'https') void reply.header('strict-transport-security', HSTS);
    done(null, payload);
  });
}

/**
 * Cross-site request forgery.
 *
 * **`SameSite=Lax` on the session cookie is the primary defence** (`A-01`), and it is a good one:
 * a cross-site POST does not carry the cookie at all, so the request arrives unauthenticated. This
 * is the second layer, for the cases `Lax` does not cover — an old browser, and any future
 * decision to relax the cookie.
 *
 * **It checks `Origin`, not a token, and the difference is worth stating.** A synchroniser token
 * needs somewhere to live, which for a single-page application is a cookie or a meta tag, and
 * both are readable by the injected script that a token is supposed to help against. `Origin` is
 * set by the browser, cannot be forged by page script, and is present on exactly the requests
 * that matter — anything with side effects.
 *
 * **Token-authenticated requests are exempt**, and must be: a script posting with an
 * `Authorization` header sends no cookie, so there is no ambient authority to forge, and
 * demanding an `Origin` from `curl` would break every integration for no gain.
 */
export interface CsrfOptions {
  logger: Logger;
  /** Extra origins to accept — a UI served from somewhere other than the API. */
  allowedOrigins?: readonly string[];
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerCsrfGuard(app: FastifyInstance, options: CsrfOptions): void {
  const allowed = new Set(options.allowedOrigins ?? []);

  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      done();
      return;
    }
    // A bearer token carries no ambient authority: there is nothing for a third-party page to
    // ride on, and `curl` sends no Origin.
    if (request.headers.authorization !== undefined) {
      done();
      return;
    }

    const origin = request.headers.origin;
    // Absent on same-origin requests from some clients and on every non-browser one. Refusing it
    // would break `curl` against a cookie-authenticated session, which is how an operator debugs
    // this system.
    if (origin === undefined) {
      done();
      return;
    }

    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      options.logger.warn(
        { origin, path: request.url },
        'refusing a request with an unparseable Origin',
      );
      done(new AuthError('AUTH_FORBIDDEN', 'that Origin header is not a URL'));
      return;
    }

    const host = request.headers.host ?? '';
    if (originHost === host || allowed.has(origin)) {
      done();
      return;
    }

    options.logger.warn(
      { origin, host, method: request.method, path: request.url },
      'refusing a cross-origin write',
    );
    done(new AuthError('AUTH_FORBIDDEN', 'this request came from another origin', { origin }));
  });
}

/**
 * A ceiling on requests per client, per window.
 *
 * **Not a fairness mechanism and not a quota — a backstop.** The limit is set high enough that no
 * legitimate client meets it, because the thing it defends against is a loop in somebody's script
 * or an enumeration run, and a limit low enough to shape traffic would page an operator every
 * time the UI opened a busy page.
 *
 * **Keyed by account where there is one, by address where there is not.** Keying only by address
 * puts everybody behind one NAT in the same bucket; keying only by account leaves an
 * unauthenticated flood uncounted. `A-01`'s login throttle is separate and stricter, because a
 * login is worth far more attempts to an attacker than a page of sensors is.
 */
export interface RateLimitOptions {
  logger: Logger;
  /** Requests allowed per window. */
  max?: number;
  windowMs?: number;
  now?: () => number;
}

const DEFAULT_MAX = 1_200;
const DEFAULT_WINDOW_MS = 60_000;

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  const max = options.max ?? DEFAULT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? Date.now;

  /**
   * Fixed windows rather than a sliding log.
   *
   * A sliding window is fairer at a boundary and costs a timestamp per request per client, which
   * at this system's request rate is a lot of garbage for a backstop nobody should reach. The
   * boundary case — twice the limit across two adjacent windows — is not a threat when the limit
   * is a backstop rather than a quota.
   */
  const buckets = new Map<string, { count: number; resetAt: number }>();

  // Swept rather than left to grow: a bucket per address is a slow leak in a service that runs
  // for months, and the sweep is O(buckets) once a window rather than per request.
  const sweep = setInterval(() => {
    const at = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
  }, windowMs);
  sweep.unref();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(sweep);
    done();
  });

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const principal = request.principal;
    const key = principal === undefined ? `ip:${request.ip}` : `user:${String(principal.userId)}`;
    const at = now();

    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    void reply.header('x-ratelimit-limit', String(max));
    void reply.header('x-ratelimit-remaining', String(remaining));
    void reply.header('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
      void reply.header('retry-after', String(retryAfter));
      options.logger.warn({ key, count: bucket.count, max }, 'rate limit exceeded');
      done(
        new AuthError('AUTH_THROTTLED', 'too many requests; slow down', {
          retryAfterSeconds: retryAfter,
        }),
      );
      return;
    }
    done();
  });
}
