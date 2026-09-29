import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { trustedProxyProblem, type Logger } from '@ms/shared';
import { addressKey } from '../auth/address-key.js';
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
 * the plain-HTTP one unreachable for a year. Behind a proxy, "a TLS request" is the proxy's
 * `X-Forwarded-Proto`, believed only from an address in `api.trustedProxies` (`A-36`); before
 * that setting existed the core saw plain HTTP from every proxy and this header was never sent.
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
 * The names this core answers to (`A-47`).
 *
 * **DNS rebinding is why.** A page on `http://evil.example:8080` whose name the attacker then
 * re-points at this machine is, to the browser, same-origin with every request it sends here: it
 * reads every answer, opens the stream, and — with authentication off — writes. Its `Origin` and
 * its `Host` are both `evil.example:8080`, so comparing the two, which is what the write guard and
 * the stream's check do, proves nothing. Only a list of the core's own names can tell it apart.
 *
 * **An address always passes**: nobody can re-point one, so a page that reached the core by
 * address is on the core's own origin. That also covers a core bound to `0.0.0.0` and reached by
 * whichever of the machine's addresses. Names pass when they are `localhost` or under it, the host
 * of `notifications.publicUrl`, the host of an `api.allowedOrigins` entry, or listed in
 * `api.allowedHosts`. Ports are not compared: a proxy forwards `Host` without the core's port.
 *
 * A request with no `Host` at all passes. Every browser sends one, so its absence is a client that
 * a rebound page cannot be.
 */
export class HostAllowList {
  readonly #names: ReadonlySet<string>;
  #refused = 0;

  constructor(options: {
    allowedHosts?: readonly string[];
    allowedOrigins?: readonly string[];
    publicUrl?: string;
  }) {
    const names = new Set<string>();
    for (const entry of options.allowedHosts ?? []) names.add(normaliseName(entry));
    for (const url of [...(options.allowedOrigins ?? []), options.publicUrl ?? '']) {
      const host = hostOfUrl(url);
      if (host !== null) names.add(host);
    }
    this.#names = names;
  }

  /** Whether a request with this `Host` header is one this core answers. */
  allows(header: string | undefined): boolean {
    if (header === undefined || header === '') return true;
    const name = nameInHost(header);
    // Strictly: `127.0.0.1.evil.example` is a name under somebody else's domain, not an address.
    if (isIP(name) !== 0) return true;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    return this.#names.has(name);
  }

  /** Counts a refusal, for Core Health. */
  refuse(): void {
    this.#refused += 1;
  }

  /** Every `Host` refused since this process started. */
  stats(): { refused: number } {
    return { refused: this.#refused };
  }
}

/**
 * Refuses, first and whether or not authentication is on, a request whose `Host` is not one of
 * this core's names (`A-47`).
 *
 * **421 Misdirected Request**, which says exactly this: the request reached a server that is not
 * the one it names. The body names the setting and the `Host` seen, because the one person who
 * meets this legitimately is an operator reaching the core by a name nobody listed, and the
 * refusal is the fix. Each name is logged once, so a scanner cannot fill the log.
 */
export function registerHostCheck(
  app: FastifyInstance,
  options: { hosts: HostAllowList; logger: Logger },
): void {
  const logged = new Set<string>();
  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    const header = request.headers.host;
    if (options.hosts.allows(header)) {
      done();
      return;
    }
    options.hosts.refuse();
    const seen = (header ?? '').slice(0, 255);
    const name = nameInHost(seen);
    if (logged.size < 100 && !logged.has(name)) {
      logged.add(name);
      options.logger.warn(
        { host: seen, method: request.method, path: request.url },
        'refusing a request for a name this core does not answer to; if it is one of this ' +
          "core's names, add it to api.allowedHosts",
      );
    }
    done(
      new AuthError(
        'HOST_NOT_ALLOWED',
        `this core does not answer to "${name}": if that is one of its names, add it to ` +
          'api.allowedHosts',
        { host: seen, setting: 'api.allowedHosts' },
      ),
    );
  });
}

/** The name in a `Host` header: lower case, without a port, brackets or a trailing dot. */
function nameInHost(header: string): string {
  const text = header.trim().toLowerCase();
  let name: string;
  if (text.startsWith('[')) {
    // An address only if nothing but a port follows the bracket: `[::1].evil.example` is not one.
    const end = text.indexOf(']');
    const rest = end === -1 ? '' : text.slice(end + 1);
    name = end !== -1 && /^(?::\d*)?$/.test(rest) ? text.slice(1, end) : text;
  } else {
    const colon = text.lastIndexOf(':');
    name = colon === -1 ? text : text.slice(0, colon);
  }
  return name.replace(/\.$/, '');
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** The host of a configured URL, or null for an empty or unparseable one. */
function hostOfUrl(url: string): string | null {
  if (url === '') return null;
  try {
    const host = new URL(url).hostname;
    return host === '' ? null : normaliseName(host.replace(/^\[(.*)\]$/, '$1'));
  } catch {
    return null;
  }
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
 * **A request an API token authenticated is exempt**, and must be: a script posting with a
 * bearer token sends no cookie, so there is no ambient authority to forge, and demanding an
 * `Origin` from `curl` would break every integration for no gain.
 *
 * **Asked of the principal, not of the header** (`A-36`). The exemption was once any request
 * carrying `Authorization`, which is not the same thing. A reverse proxy that authenticates with
 * HTTP Basic or Negotiate forwards the browser's own header, and a browser attaches those on its
 * own, to cross-site requests too — ambient authority exactly as a cookie is, and `SameSite` does
 * not govern it. So every write through such a proxy skipped the guard, and the session cookie
 * beside the header then authenticated it.
 */
export interface CsrfOptions {
  logger: Logger;
  /**
   * Extra origins to accept — a UI served from somewhere other than the API (`A-19`).
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
    // ride on, and `curl` sends no Origin. Registered after authentication, so the principal is
    // what the request actually authenticated as.
    if (request.principal?.tokenId !== undefined) {
      done();
      return;
    }
    done(refusalFor(request, allowed, options.logger, 'write'));
  });
}

/**
 * The stream's handshake, from another origin (`A-36`).
 *
 * **The guard above passes every GET, and a WebSocket handshake is a GET — the one GET whose answer
 * another origin can read.** The same-origin policy hides an ordinary response from a page on
 * another origin; it does not govern a socket, whose every frame the page that opened it reads.
 * The session cookie goes with the handshake whenever that page is same-site: another port on the
 * core's host, such as a Grafana beside it or anything on `localhost` through an SSH tunnel, or a
 * sibling subdomain, because a site ignores the port and `SameSite=Lax` is per site. With
 * authentication off no cookie is needed at all. So a page like that could subscribe and read the
 * state of everything its victim could see, for as long as the tab stayed open.
 *
 * A browser always sends `Origin` on a handshake and page script cannot change it, so the guard's
 * own comparison decides. A client that sends none is not a browser, and has only the credentials
 * it was given; it is let through, as the guard lets `curl` through.
 *
 * **Registered whether or not authentication is required, and so apart from the guard.** With
 * authentication off, this is all that stands between another site and the stream.
 */
export function registerUpgradeOriginCheck(app: FastifyInstance, options: CsrfOptions): void {
  const allowed = new Set((options.allowedOrigins ?? []).map(normaliseOrigin));

  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    // The header rather than whether `@fastify/websocket` took the request: a page cannot set
    // `Upgrade` on anything but a handshake, and a plain GET that carries it asks for nothing.
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
      done();
      return;
    }
    done(refusalFor(request, allowed, options.logger, 'stream'));
  });
}

/**
 * Whether `Origin` names this API or an origin configured to stand for it, and the refusal when
 * it does not. One comparison, so the write guard and the stream cannot come to disagree about
 * what "another origin" means.
 *
 * **The host is compared and the scheme is not.** Behind a proxy that terminates TLS and is not in
 * `api.trustedProxies`, the core cannot know the scheme the browser used, and comparing it would
 * refuse every write and every stream from such an installation.
 */
function refusalFor(
  request: FastifyRequest,
  allowed: ReadonlySet<string>,
  logger: Logger,
  what: 'write' | 'stream',
): AuthError | undefined {
  const origin = request.headers.origin;
  // Absent on same-origin requests from some clients and on every non-browser one. Refusing it
  // would break `curl` against a cookie-authenticated session, which is how an operator debugs
  // this system.
  if (origin === undefined) return undefined;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    logger.warn({ origin, path: request.url }, 'refusing a request with an unparseable Origin');
    return new AuthError('AUTH_FORBIDDEN', 'that Origin header is not a URL');
  }

  const host = request.headers.host ?? '';
  if (originHost === host || allowed.has(origin)) return undefined;

  logger.warn(
    { origin, host, method: request.method, path: request.url },
    `refusing a cross-origin ${what}`,
  );
  return new AuthError('AUTH_FORBIDDEN', 'this request came from another origin', { origin });
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
 * What Fastify is told to believe about `X-Forwarded-For` and `X-Forwarded-Proto`, from
 * `api.trustedProxies` (`A-36`): `false` for nobody.
 *
 * **Checked again here, not left to Fastify**, which also refuses a bad entry but names the entry
 * and not the setting — "invalid IP address: ms-proxy", at startup, with nothing to say which file
 * or key — and accepts `uniquelocal` and `linklocal`, which name the network the browsers are on.
 * Loading the configuration has already refused all of these; a server built without loading one,
 * as every test builds it, is held to the same rule by the same function.
 */
export function proxyTrust(entries: readonly string[]): string[] | false {
  for (const entry of entries) {
    const problem = trustedProxyProblem(entry);
    if (problem !== undefined) throw new Error(problem);
  }
  return entries.length === 0 ? false : [...entries];
}

/**
 * Says once that something in front of the core is speaking for browsers and nobody is believed
 * (`A-36`).
 *
 * The failure it names is otherwise silent until it bites: an install behind a proxy with
 * `api.trustedProxies` empty sees every browser as the proxy — one address for the login throttle
 * and the rate limit, so one person's wrong passwords refuse everybody's login — and never marks
 * the session cookie `Secure`. A request carrying `X-Forwarded-For` is that situation, or a client
 * that set the header itself; the warning names the peer, and says it once, so the log is not the
 * proxy's traffic twice over.
 *
 * **Only while nobody is trusted.** With a list, a forwarded address that stayed the peer's is as
 * likely a request from the proxy's own host — `curl` on it, forwarded with `127.0.0.1` — as a
 * second proxy nobody listed, and a warning that is wrong half the time is read by nobody.
 */
export function registerForwardedHeaderNotice(
  app: FastifyInstance,
  options: { logger: Logger; trustedProxies: readonly string[] },
): void {
  if (options.trustedProxies.length > 0) return;
  let said = false;
  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (!said && request.headers['x-forwarded-for'] !== undefined) {
      said = true;
      options.logger.warn(
        { peer: request.ip },
        'a request carried X-Forwarded-For and api.trustedProxies is empty, so the header was ' +
          'ignored: if a reverse proxy is in front of this core, every browser behind it is one ' +
          'address to the login throttle and the rate limit, and the session cookie is never ' +
          'marked Secure',
      );
    }
    done();
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
 * unauthenticated flood uncounted. Behind a proxy the address is the browser's only when the proxy
 * is in `api.trustedProxies` (`A-36`); otherwise every browser is the proxy, and shares a bucket.
 * `A-01`'s login throttle is separate and stricter, because a
 * login is worth far more attempts to an attacker than a page of sensors is.
 */
export interface RateLimitOptions {
  logger: Logger;
  /** Requests allowed per window. */
  max?: number;
  windowMs?: number;
  /**
   * Monotonic milliseconds, which the windows are timed on (`P-247`). A window is a duration, and
   * on the wall clock a backward step of an hour kept every client's window open for that hour:
   * past the limit, the NOC's own UI answered 429 for the length of the step.
   */
  now?: () => number;
  /** The wall clock, only for `x-ratelimit-reset`, which a client reads as a Unix time. */
  wallNow?: () => number;
}

const DEFAULT_MAX = 1_200;
const DEFAULT_WINDOW_MS = 60_000;

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  const max = options.max ?? DEFAULT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? ((): number => performance.now());
  const wallNow = options.wallNow ?? Date.now;

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
    // An IPv6 client is its /64 (`A-47`): one connection hands out a whole prefix, and keying on
    // the exact address gave it that many buckets.
    const key =
      principal === undefined ? `ip:${addressKey(request.ip)}` : `user:${String(principal.userId)}`;
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
    // A Unix time for the client, from how long the window has left on the monotonic clock.
    void reply.header(
      'x-ratelimit-reset',
      String(Math.ceil((wallNow() + (bucket.resetAt - at)) / 1000)),
    );

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
