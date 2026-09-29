import type { Logger, WebhookConfig } from '@ms/shared';
import { WEBHOOK_METHOD } from '../methods.js';
import { GuardedHttpClient, safeHeaders } from './http-client.js';
import type { Escaping } from '../placeholders.js';
import {
  headerSafe,
  type DeliveryResult,
  type DeliveryTransport,
  type OutgoingMessage,
} from './transport.js';

/** What `x-ms-subject-encoding` says when the subject had to be encoded to be a header (`N-18`). */
export const SUBJECT_ENCODING = 'utf-8-percent';

/**
 * The rendered subject as request headers, which nothing it contains can make fail (`N-18`).
 *
 * **Node refuses a header value with any character above U+00FF**, and throws before the request
 * is sent. A subject is built from names and messages this system does not choose: a device named
 * in Cyrillic or CJK, a sensor with an emoji, an em dash in a check's own message, or the `—` that
 * `%lastvalue` and `%laststatus` render when there is nothing to show. Each failed the delivery,
 * and every retry rendered the same subject and failed it again, so the alarm never went out.
 *
 * Printable ASCII travels as it always has, which is every subject an endpoint has been sent so
 * far. Anything else travels as its UTF-8, percent-encoded, and `x-ms-subject-encoding` says so;
 * `decodeURIComponent` on the receiving side gives the text back. Latin-1 is encoded too, although
 * Node would send it: sent raw, it arrives as bytes a receiver has to guess the charset of. The
 * body carries the full text either way.
 *
 * **Well-formed first**, because `encodeURIComponent` throws on half a surrogate pair, which a
 * subject cut at a length limit can end in. The round trip through UTF-8 makes it U+FFFD.
 */
export function subjectHeaders(subject: string): Record<string, string> {
  const flat = headerSafe(subject);
  if (/^[\x20-\x7E]*$/u.test(flat)) return { 'x-ms-subject': flat };
  const wellFormed = Buffer.from(flat, 'utf8').toString('utf8');
  return {
    'x-ms-subject': encodeURIComponent(wellFormed),
    'x-ms-subject-encoding': SUBJECT_ENCODING,
  };
}

export interface WebhookTransportOptions {
  config: WebhookConfig;
  logger: Logger;
  /** Swapped in tests. Production resolves through the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * HTTP action delivery (`N-08`, `CAPABILITIES.MD §5.2`) — the method that covers most
 * integrations.
 *
 * Everything about *reaching* the endpoint — the SSRF guard, DNS pinning, redirect handling, the
 * status reading — is `GuardedHttpClient`, shared with `N-09`'s Slack and Teams. What is left
 * here is the part that is specific to this method: the operator writes the document, so the
 * verb, the content type and the escaping are all theirs to choose.
 */
export class WebhookTransport implements DeliveryTransport {
  readonly method = WEBHOOK_METHOD.id;
  readonly #http: GuardedHttpClient;

  constructor(options: WebhookTransportOptions) {
    this.#http = new GuardedHttpClient({
      config: options.config,
      logger: options.logger.child({ component: 'webhook' }),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    });
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

    return this.#http.send({
      url,
      verb: typeof settings['verb'] === 'string' ? settings['verb'] : 'POST',
      contentType:
        typeof settings['contentType'] === 'string' ? settings['contentType'] : 'application/json',
      body: message.body,
      timeoutMs: typeof settings['timeoutMs'] === 'number' ? settings['timeoutMs'] : 10_000,
      // The rendered subject, so an endpoint can route on it without parsing the body.
      headers: subjectHeaders(message.subject),
      secretHeaders: safeHeaders(settings['secretHeaders']),
    });
  }
}
