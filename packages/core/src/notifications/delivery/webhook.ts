import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { describeError, type Logger, type WebhookConfig } from '@ms/shared';
import { WEBHOOK_METHOD } from '../methods.js';
import { refusedAddresses, sameOrigin, schemeAllowed } from './ssrf.js';
import type { Escaping } from '../placeholders.js';
import {
  headerSafe,
  type DeliveryResult,
  type DeliveryTransport,
  type OutgoingMessage,
} from './transport.js';

export interface WebhookTransportOptions {
  config: WebhookConfig;
  logger: Logger;
  /** Swapped in tests. Production resolves through the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
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
 * HTTP action delivery (`N-08`, `CAPABILITIES.MD §5.2`) — the method that covers most
 * integrations.
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
export class WebhookTransport implements DeliveryTransport {
  readonly method = WEBHOOK_METHOD.id;
  readonly #config: WebhookConfig;
  readonly #logger: Logger;
  readonly #resolve: (hostname: string) => Promise<string[]>;
  /** Addresses the guard verified, so the client cannot resolve the name a second time. */
  readonly #pinned = new Map<string, string[]>();

  constructor(options: WebhookTransportOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'webhook' });
    this.#resolve = options.resolve ?? systemResolve;
  }

  /**
   * How a value has to be escaped to survive this endpoint's body syntax.
   *
   * The case that makes it necessary: an operator writes `{"message": "%lastmessage"}` and a
   * probe reports `unexpected " in response`. Without this the document that goes out is not
   * JSON, the endpoint rejects it, and it happens only for the checks whose messages contain a
   * quote — which is to say the interesting ones.
   */
  bodyEscaping(settings: Readonly<Record<string, unknown>>): Escaping {
    switch (settings['contentType']) {
      case 'text/plain':
        return 'none';
      case 'application/x-www-form-urlencoded':
        return 'form';
      default:
        return 'json';
    }
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    const settings = message.settings;
    const rawUrl = typeof settings['url'] === 'string' ? settings['url'] : '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, retryable: false, error: `"${rawUrl}" is not a URL` };
    }

    const verb = typeof settings['verb'] === 'string' ? settings['verb'] : 'POST';
    const contentType =
      typeof settings['contentType'] === 'string' ? settings['contentType'] : 'application/json';
    const timeoutMs = typeof settings['timeoutMs'] === 'number' ? settings['timeoutMs'] : 10_000;
    const secretHeaders = readHeaders(settings['secretHeaders']);

    const deadline = Date.now() + timeoutMs;
    let target = url;
    const origin = url;

    for (let hop = 0; hop <= this.#config.maxRedirects; hop += 1) {
      const guard = await this.#check(target);
      if (guard !== null) return guard;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, retryable: true, error: `timed out after ${String(timeoutMs)} ms` };
      }

      let exchange: Exchange;
      try {
        exchange = await this.#exchange(target, {
          verb: hop === 0 ? verb : REDIRECT_VERB,
          contentType,
          // Only on the first hop, and only to the same origin thereafter: a bearer token that
          // follows a redirect to somebody else's host has been given to that host.
          headers: hop === 0 || sameOrigin(origin, target) ? secretHeaders : {},
          body: hop === 0 ? message.body : '',
          timeoutMs: remaining,
          subject: message.subject,
        });
      } catch (error: unknown) {
        return { ok: false, retryable: true, error: describeError(error).message };
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
    // window this whole method exists to close.
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
      subject: string;
    },
  ): Promise<Exchange> {
    const pinned = this.#pinned.get(target.hostname) ?? [];
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const hasBody = options.body !== '' && options.verb !== 'GET';

    return new Promise<Exchange>((resolve, reject) => {
      const request: ClientRequest = send(
        target,
        {
          method: options.verb,
          headers: {
            'user-agent': this.#config.userAgent,
            // The rendered subject, so an endpoint can route on it without parsing the body.
            'x-ms-subject': headerSafe(options.subject),
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

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function readHeaders(value: unknown): Record<string, string> {
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
