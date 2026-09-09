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
/**
 * The policy, with whatever image origins configuration adds (`G-08`, `ADR-004`).
 *
 * **The first thing here that depends on configuration**, and it is worth saying why that is
 * acceptable: a map tile provider is an origin an operator chose and pasted, `img-src` is the one
 * directive it needs, and the widening is exactly one host rather than a wildcard. Everything else
 * stays `'self'` — a tile source may serve images and nothing else.
 */
function policy(imageOrigins: readonly string[]): string {
  const images = ["'self'", 'data:', ...imageOrigins].join(' ');
  return (
    `default-src 'self'; img-src ${images}; object-src 'none'; base-uri 'none'; ` +
    "frame-ancestors 'none'; form-action 'self'"
  );
}

const HEADERS: Readonly<Record<string, string>> = {
  // Scripts, styles and connections from this origin only. `img-src` allows data: because
  // uPlot renders to canvas and exports PNGs from it.
  'content-security-policy': policy([]),
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

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: { imageOrigins?: readonly string[] } = {},
): void {
  const headers: Readonly<Record<string, string>> =
    options.imageOrigins === undefined || options.imageOrigins.length === 0
      ? HEADERS
      : { ...HEADERS, 'content-security-policy': policy(options.imageOrigins) };

  app.addHook('onSend', (request: FastifyRequest, reply: FastifyReply, payload, done) => {
    for (const [name, value] of Object.entries(headers)) {
      // **A route that has already set one of these keeps it** — and every one of these headers
      // is a floor rather than a ceiling, so the only way a route can differ is by being
      // stricter. `G-05` serves an operator's uploaded image under `default-src 'none'`, which
      // this hook would otherwise widen to the application's own `'self'` on the way out.
      if (reply.getHeader(name) !== undefined) continue;
      void reply.header(name, value);
    }
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
  /**
   * Extra origins to accept — a UI served from somewhere other than the API (`A-11`).
   *
   * The case is not exotic: **any proxy that rewrites `Host` produces it**. Vite's
   * `changeOrigin` does in development, so the UI on `:5173` forwards to the core on `:8080`
   * with `Origin: http://127.0.0.1:5173` and `Host: 127.0.0.1:8080` — headers that look
   * cross-origin for a request the browser considers same-origin. A reverse proxy in front of a
   * production install does the same thing.
   *
   * This is *not* a CORS allowlist and does not make the API callable from another origin: a
   * genuinely cross-origin browser call needs `Access-Control-*` headers this API does not send,
   * and would be blocked before it arrived. What is listed here is trusted to the extent that
   * naming an origin an attacker controls hands them every session cookie's authority.
   */
  allowedOrigins?: readonly string[];
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerCsrfGuard(app: FastifyInstance, options: CsrfOptions): void {
  const allowed = new Set((options.allowedOrigins ?? []).map(normaliseOrigin));

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
 * What a browser would actually send, from what an operator actually wrote.
 *
 * `https://ms.example.com/` and `https://ms.example.com/app` both become `https://ms.example.com`,
 * because an `Origin` header carries no path and a value pasted out of an address bar would
 * otherwise match nothing. **Anything that could never appear in an `Origin` throws at startup
 * rather than being skipped**: an allowlist that quietly ignores its own entry is
 * indistinguishable from a config file that was never read, and the operator would then be
 * debugging the guard.
 */
function normaliseOrigin(configured: string): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    // What a bare "ms.example.com" or "127.0.0.1:5173" does: neither is a URL, and the scheme is
    // the part people leave off.
    throw new Error(
      `api.allowedOrigins: "${configured}" is not a URL — an origin needs a scheme, as in ` +
        '"https://ms.example.com" or "http://127.0.0.1:5173"',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // `file:` and `data:` have no origin at all (a browser sends `Origin: null` for those, which
    // is not something to match on), and no other scheme reaches an HTTP API. Accepting one would
    // be an entry that parses, sits in the config looking configured, and matches nothing.
    throw new Error(
      `api.allowedOrigins: "${configured}" is ${url.protocol} — a browser only sends an http or ` +
        'https origin to this API',
    );
  }
  return url.origin;
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
