import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { describeError, type Logger, type WebhookConfig } from '@ms/shared';
import { refusedAddresses, sameOrigin, schemeAllowed } from '@ms/shared';
import { headerSafe, type DeliveryResult } from './transport.js';

export interface GuardedHttpOptions {
  config: WebhookConfig;
  logger: Logger;
  /** Swapped in tests. Production resolves through the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface GuardedHttpRequest {
  readonly url: URL;
  /** Default `POST`. A redirect turns it into a `GET` whatever it started as. */
  readonly verb?: string;
  /** Default `application/json`. Ignored when there is no body. */
  readonly contentType?: string;
  readonly body: string;
  readonly timeoutMs: number;
  /** Sent on every hop. Nothing here may be a credential. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent on the first hop, and after that only to the same origin. */
  readonly secretHeaders?: Readonly<Record<string, string>>;
}

/** The `all: true` form of Node's DNS callback, which its own types do not expose here. */
type AllLookup = (error: Error | null, addresses: { address: string; family: number }[]) => void;

/** One HTTP exchange, reduced to what a delivery decision needs. */
interface Exchange {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Posting to a URL somebody else configured, safely (`N-08`, shared with `N-09`).
 *
 * Every HTTP delivery method goes through this: the generic webhook, Slack and Teams. They differ
 * only in what document they build and where the URL comes from, and the part that has to be
 * right — the guard — is the part that must not exist in three copies.
 *
 * **`node:http` rather than `fetch`, for one reason: the SSRF guard.** A guard that resolves a
 * hostname, decides it is acceptable and then hands the *name* to a client has checked nothing —
 * the client resolves it again, and a DNS answer with a one-second TTL can point somewhere else
 * by then. That is DNS rebinding, and it is not exotic. Here the name is resolved once, every
 * address it returned is judged, and the connection is then pinned to a verified address through
 * the request's own `lookup` hook. `fetch` has no equivalent seam.
 *
 * Redirects are followed by hand for the same reason: every hop is a new host that has to be
 * judged again, and a hop to a different origin must not carry the secret headers with it.
 */
export class GuardedHttpClient {
  readonly #config: WebhookConfig;
  readonly #logger: Logger;
  readonly #resolve: (hostname: string) => Promise<string[]>;
  /** Addresses the guard verified, so the client cannot resolve the name a second time. */
  readonly #pinned = new Map<string, string[]>();

  constructor(options: GuardedHttpOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#resolve = options.resolve ?? systemResolve;
  }

  async send(request: GuardedHttpRequest): Promise<DeliveryResult> {
    const verb = request.verb ?? 'POST';
    const contentType = request.contentType ?? 'application/json';
    const secretHeaders = request.secretHeaders ?? {};

    // Monotonic (`P-247`): a deadline is a duration, and on the wall clock a forward step timed
    // out a delivery that had not started, and a backward one let it run for the step.
    const deadline = performance.now() + request.timeoutMs;
    const origin = request.url;
    let target = request.url;

    for (let hop = 0; hop <= this.#config.maxRedirects; hop += 1) {
      const guard = await this.#check(target);
      if (guard !== null) return guard;

      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return {
          ok: false,
          retryable: true,
          error: `timed out after ${String(request.timeoutMs)} ms`,
        };
      }

      let exchange: Exchange;
      try {
        exchange = await this.#exchange(target, {
          verb: hop === 0 ? verb : REDIRECT_VERB,
          contentType,
          // Only on the first hop, and only to the same origin thereafter: a bearer token that
          // follows a redirect to somebody else's host has been given to that host.
          headers: {
            ...(request.headers ?? {}),
            ...(hop === 0 || sameOrigin(origin, target) ? secretHeaders : {}),
          },
          body: hop === 0 ? request.body : '',
          timeoutMs: remaining,
        });
      } catch (error: unknown) {
        const described = describeError(error);
        // **A header Node will not send fails every attempt the same way** (`N-19`). The template
        // save refuses one now, but a row stored before it can still carry a secret header whose
        // name is not a token or whose value has a character above U+00FF. Retrying that only
        // spends the attempts and delays the answer. Node's message names the header and never
        // its value, which is a secret, so it is passed on as it is.
        if (UNSENDABLE_HEADER.has(described.code ?? '')) {
          return {
            ok: false,
            retryable: false,
            error: `a header this template sets cannot be sent: ${described.message}`,
          };
        }
        return { ok: false, retryable: true, error: described.message };
      }

      if (exchange.status >= 300 && exchange.status < 400 && exchange.location !== null) {
        let next: URL;
        try {
          next = new URL(exchange.location, target);
        } catch {
          return {
            ok: false,
            retryable: false,
            error: `redirected to "${exchange.location}", which is not a URL`,
          };
        }
        if (!sameOrigin(origin, next)) {
          this.#logger.info(
            { from: target.host, to: next.host },
            'a webhook redirected across origins; secret headers were not forwarded',
          );
        }
        target = next;
        continue;
      }

      return classify(exchange, target);
    }

    return {
      ok: false,
      retryable: false,
      error: `more than ${String(this.#config.maxRedirects)} redirects`,
    };
  }

  /** The guard. Returns a refusal, or null when the target may be reached. */
  async #check(target: URL): Promise<DeliveryResult | null> {
    if (!schemeAllowed(target)) {
      return {
        ok: false,
        retryable: false,
        error: `"${target.protocol}" is not http or https`,
      };
    }

    let addresses: string[];
    try {
      addresses = await this.#resolve(target.hostname);
    } catch (error: unknown) {
      // A name that does not resolve now may resolve in a minute.
      return {
        ok: false,
        retryable: true,
        error: `${target.hostname}: ${describeError(error).message}`,
      };
    }
    if (addresses.length === 0) {
      return { ok: false, retryable: true, error: `${target.hostname} resolved to nothing` };
    }

    const refused = refusedAddresses(this.#config.targetPolicy, addresses);
    if (refused.length > 0) {
      const reasons = refused.map((one) => `${one.address} is ${one.reason}`).join('; ');
      return {
        ok: false,
        // Not retryable: the address is not going to become acceptable, and an operator has to
        // change either the URL or the policy.
        retryable: false,
        error: `${target.hostname} refused by the target policy — ${reasons}`,
      };
    }
    // Pin the addresses that were checked. Resolving again inside the client is the rebinding
    // window this whole class exists to close.
    this.#pinned.set(target.hostname, addresses);
    return null;
  }

  async #exchange(
    target: URL,
    options: {
      verb: string;
      contentType: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    },
  ): Promise<Exchange> {
    const pinned = this.#pinned.get(target.hostname) ?? [];
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const hasBody = options.body !== '' && options.verb !== 'GET';

    return new Promise<Exchange>((resolveExchange, rejectExchange) => {
      // **A wall-clock deadline for the hop, not only an idle one** (`P-143`).
      // `request.setTimeout` fires when the socket has been *quiet* for that long, so an endpoint
      // that trickles one byte a second resets it for ever — and the deadline across hops is only
      // consulted between them, so a single stalled hop was unbounded. The delivery loop that
      // awaits this is not concurrent: one endpoint holding a connection open holds up every
      // notification behind it.
      // **`let`, and null-checked in the callback** (`P-151`). The timer has to be armed before
      // the request so that a `send()` which blocks or throws is still bounded — but
      // `http.request` throws *synchronously* from its own constructor for a header name that is
      // not a token (`ERR_INVALID_HTTP_TOKEN`) or a value outside latin-1 (`ERR_INVALID_CHAR`),
      // and both are reachable: a webhook template's `secretHeaders` keys are unconstrained, and
      // `x-ms-subject` carries a rendered subject that can contain any character a sensor name
      // has. When it threw, the executor unwound and the promise rejected — an ordinary retryable
      // failure — but this timer stayed armed against a `const` in its temporal dead zone. It
      // fired `ReferenceError: Cannot access 'request' before initialization` from a timer, which
      // reaches `uncaughtException` in the lifecycle and takes the whole core down with it. Every
      // retry re-armed the crash.
      // `prefer-const` sees one assignment and asks for `const` back. Taking it would restore
      // the crash above: the timer below closes over `request` and can fire before the
      // assignment on a synchronous throw, which is a `ReferenceError` on a `const`.
      // eslint-disable-next-line prefer-const
      let request: ClientRequest | undefined;
      const hard = setTimeout(() => {
        request?.destroy(new Error(`timed out after ${String(options.timeoutMs)} ms`));
      }, options.timeoutMs);
      hard.unref();
      const settle = <T>(fn: (value: T) => void) => {
        return (value: T): void => {
          clearTimeout(hard);
          fn(value);
        };
      };
      const resolve = settle(resolveExchange);
      const reject = settle(rejectExchange);

      request = send(
        target,
        {
          method: options.verb,
          headers: {
            'user-agent': this.#config.userAgent,
            ...(hasBody
              ? {
                  'content-type': options.contentType,
                  'content-length': String(Buffer.byteLength(options.body)),
                }
              : {}),
            ...options.headers,
          },
          // The verified addresses, never the name. This hook exists only to stop a second
          // resolution — the answer was already decided and judged by `#check`.
          //
          // Both callback shapes, because Node asks for either: happy-eyeballs
          // (`autoSelectFamily`, on by default since Node 20) passes `all: true` and expects an
          // array, and a plain connect expects one address. Answering the wrong shape produces
          // "Invalid IP address: undefined" from somewhere that looks nothing like this.
          lookup: (hostname, options, callback) => {
            const entries = pinned.map((address) => ({
              address,
              family: address.includes(':') ? 6 : 4,
            }));
            const first = entries[0];
            if (first === undefined) {
              callback(new Error(`no verified address for ${hostname}`), '', 4);
              return;
            }
            const wantsAll = (options as { all?: boolean }).all === true;
            if (wantsAll) (callback as unknown as AllLookup)(null, entries);
            else callback(null, first.address, first.family);
          },
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            // Bounded: an endpoint that answers with a gigabyte is not something to buffer, and
            // the body is only ever used to explain a failure.
            if (size < MAX_BODY_BYTES) {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              location: firstHeader(response.headers['location']),
              body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES).trim(),
            });
          });
          response.on('error', reject);
        },
      );

      // Kept as well: it fails a connection that never establishes at the same bound, and it
      // fires sooner than the wall clock on a socket that goes quiet early.
      request.setTimeout(options.timeoutMs, () => {
        request.destroy(new Error(`timed out after ${String(options.timeoutMs)} ms`));
      });
      request.on('error', reject);
      if (hasBody) request.write(options.body);
      request.end();
    });
  }
}

/**
 * What a status code means for a delivery.
 *
 * The same reading HTTP already has: 2xx is done, 5xx and 429 are "not now", and everything else
 * in the 4xx range is a request this endpoint will never accept however many times it is sent.
 * Slack and Teams both fit it without special-casing — a revoked incoming-webhook URL answers
 * 403 or 404, which is exactly the "never going to work" case, and a rate limit answers 429.
 */
function classify(exchange: Exchange, target: URL): DeliveryResult {
  if (exchange.status >= 200 && exchange.status < 300) {
    return { ok: true, detail: `${String(exchange.status)} from ${target.host}` };
  }
  const excerpt = exchange.body === '' ? '' : ` — ${exchange.body.slice(0, 200)}`;
  return {
    ok: false,
    retryable: exchange.status >= 500 || exchange.status === 429 || exchange.status === 408,
    error: `${String(exchange.status)} from ${target.host}${excerpt}`,
  };
}

/**
 * What a redirected request becomes: a GET, with no body.
 *
 * A 303 says so outright, and by universal practice a 301 or 302 after a POST does the same —
 * every HTTP client settled this the same way years ago. Reposting the body to wherever a
 * redirect points is how one webhook becomes two deliveries to two endpoints.
 */
const REDIRECT_VERB = 'GET';

/** What `http.request` throws, synchronously, for a header it will not put on the wire. */
const UNSENDABLE_HEADER: ReadonlySet<string> = new Set([
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
]);

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Drops anything that could end a header line, and anything that is not a string. */
export function safeHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    // A header name or value carrying a newline is a request-splitting attempt, and these come
    // from an operator's own configuration rather than from a check — but the cost of refusing
    // them is nothing and the cost of forwarding one is a second request nobody wrote.
    if (typeof entry === 'string') headers[headerSafe(name)] = headerSafe(entry);
  }
  return headers;
}

/** Every address the system resolver returns for a name. */
async function systemResolve(hostname: string): Promise<string[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}
