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
      headers: { 'x-ms-subject': headerSafe(message.subject) },
      secretHeaders: safeHeaders(settings['secretHeaders']),
    });
  }
}
