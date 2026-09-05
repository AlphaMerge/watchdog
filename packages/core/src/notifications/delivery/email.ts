import { createTransport, type Transporter } from 'nodemailer';
import { describeError, type Logger, type SmtpConfig, type SmtpRelay } from '@ms/shared';
import { EMAIL_METHOD } from '../methods.js';
import {
  headerSafe,
  type DeliveryResult,
  type DeliveryTransport,
  type OutgoingMessage,
} from './transport.js';
import type { Escaping } from '../placeholders.js';

export interface EmailTransportOptions {
  config: SmtpConfig;
  logger: Logger;
  /** Swapped in tests for a relay that fails on demand. Production uses nodemailer. */
  build?: (relay: SmtpRelay, config: SmtpConfig) => Transporter;
}

/** What a relay attempt produced, before the fallback decision is made. */
interface Attempt {
  readonly relay: string;
  readonly result: DeliveryResult;
}

/**
 * Email delivery (`N-07`, `CAPABILITIES.MD §5.2`).
 *
 * `nodemailer` does the SMTP, per `ADR-001` Decision 6 — an ESMTP client with STARTTLS, four SASL
 * mechanisms, MIME encoding and dot-stuffing is a great deal of well-trodden protocol to get
 * subtly wrong, and unlike syslog or NetFlow the ecosystem here is alive. What this class owns is
 * everything around it: which relay, what the message says, and what a failure means.
 *
 * **Primary then fallback, and only then.** Paessler's own advice is two delivery paths per
 * trigger; this is the cheaper half — one relay going down must not silence an installation. The
 * fallback is tried when the primary fails for any reason, including a refused address, because a
 * relay that rejects a recipient the fallback would accept is exactly the split-horizon setup a
 * fallback exists for.
 *
 * **Headers are sanitised here as well as by nodemailer.** A subject is built from a sensor's
 * name and a probe's own message, neither of which this system controls, and nodemailer has had
 * CRLF-injection advisories against three separate fields. Doing it twice costs one regex.
 */
export class EmailTransport implements DeliveryTransport {
  readonly method = EMAIL_METHOD.id;
  readonly #config: SmtpConfig;
  readonly #logger: Logger;
  readonly #build: (relay: SmtpRelay, config: SmtpConfig) => Transporter;
  readonly #transports = new Map<string, Transporter>();

  constructor(options: EmailTransportOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'email' });
    this.#build = options.build ?? buildTransport;
  }

  /** Whether this installation can send email at all. */
  get configured(): boolean {
    return this.#config.primary.host !== '' && this.#config.sender !== '';
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    if (!this.configured) {
      return {
        ok: false,
        // Not retryable: no amount of waiting configures a relay, and a queue quietly filling
        // with mail nobody set an address for is worse than being told.
        retryable: false,
        error:
          'no SMTP relay is configured — set notifications.smtp.primary.host and ' +
          'notifications.smtp.sender',
      };
    }

    const addresses = this.#addressesIn(message);
    if ('error' in addresses) return addresses.error;

    const attempts: Attempt[] = [];
    for (const [name, relay] of this.#relays()) {
      const result = await this.#sendVia(relay, name, message, addresses.to);
      attempts.push({ relay: name, result });
      if (result.ok) {
        if (attempts.length > 1) {
          this.#logger.warn(
            { requestId: message.requestId, relay: name },
            'the primary relay failed; the message went out through the fallback',
          );
        }
        return result;
      }
    }

    // Every relay's reason, not just the last: "primary refused the address, fallback timed out"
    // is a diagnosis, and "timed out" on its own sends somebody to look at the wrong machine.
    const reasons = attempts
      .map((attempt) => `${attempt.relay}: ${attempt.result.ok ? 'sent' : attempt.result.error}`)
      .join('; ');
    return {
      ok: false,
      error: reasons,
      // Retryable if *any* relay might work later. One permanent rejection does not make the
      // whole thing permanent when another relay timed out.
      retryable: attempts.some((attempt) => !attempt.result.ok && attempt.result.retryable),
    };
  }

  async close(): Promise<void> {
    for (const transport of this.#transports.values()) transport.close();
    this.#transports.clear();
    return Promise.resolve();
  }

  /** The relays to try, in order. A fallback with no host is not a relay. */
  *#relays(): Generator<[string, SmtpRelay]> {
    yield ['primary', this.#config.primary];
    if (this.#config.fallback.host !== '') yield ['fallback', this.#config.fallback];
  }

  #addressesIn(message: OutgoingMessage): { to: string[] } | { error: DeliveryResult } {
    const to: string[] = [];
    const unresolved: string[] = [];
    for (const recipient of message.recipients) {
      if (recipient.kind === 'address') to.push(headerSafe(recipient.value));
      else unresolved.push(`${recipient.kind} "${recipient.value}"`);
    }

    if (to.length === 0) {
      return {
        error: {
          ok: false,
          retryable: false,
          error:
            unresolved.length === 0
              ? 'the template has no recipients'
              : // A-01 and A-02 are what make these resolve. Saying so is better than an empty
                // recipient list that looks like a mistake nobody made.
                `no addresses: ${unresolved.join(', ')} cannot be resolved until accounts exist`,
        },
      };
    }
    return { to };
  }

  /**
   * HTML when the template says so, and nothing otherwise (`P-118`).
   *
   * The email transport declared no escaping at all, so `html: message.body` put probe-controlled
   * text straight into a document. A plain-text email needs none: there is no syntax in it to
   * break out of.
   */
  bodyEscaping(settings: Readonly<Record<string, unknown>>): Escaping {
    return settings['format'] === 'html' ? 'html' : 'none';
  }

  async #sendVia(
    relay: SmtpRelay,
    name: string,
    message: OutgoingMessage,
    to: readonly string[],
  ): Promise<DeliveryResult> {
    try {
      const transport = this.#transportFor(name, relay);
      const html = message.settings['format'] === 'html';
      const override = message.settings['senderOverride'];
      const from = headerSafe(
        typeof override === 'string' && override !== '' ? override : this.#config.sender,
      );

      const sent: unknown = await transport.sendMail({
        from,
        to: [...to],
        subject: headerSafe(message.subject),
        ...(html ? { html: message.body } : { text: message.body }),
        headers: {
          // What an operator's mail client sorts on. 1-2 high, 3 normal, 4-5 low, which is the
          // convention every client agrees on even though the header is not standardised.
          'X-Priority': String(message.priority),
          Importance: message.priority <= 2 ? 'high' : message.priority >= 4 ? 'low' : 'normal',
          // Ties a delivered message back to the row that owed it, which is the only way to
          // answer "did this alarm go out" from the mail side.
          'X-MS-Request': String(message.requestId),
          'X-MS-Sensor': String(message.sensorId),
        },
      });
      // Narrowed rather than trusted: `@types/nodemailer` lags the runtime (see
      // `buildTransport`), so what comes back is `any` as far as the checker is concerned.
      const envelope = sent as { messageId?: unknown; rejected?: unknown } | null;
      const messageId =
        typeof envelope === 'object' && envelope !== null && 'messageId' in envelope
          ? String(envelope.messageId)
          : 'sent';

      // **A relay that accepts the message and rejects a recipient reports both, and the
      // rejection was thrown away** (`P-119`). `sendMail` resolves for a partial send, so an
      // alarm that reached nobody on the list — every address unknown at the relay — was recorded
      // `delivered`, counted as a success on Delivery Health, and never retried. The one place an
      // operator would look says the notification went out.
      const rejected = Array.isArray(envelope?.rejected)
        ? envelope.rejected.map((one) => String(one))
        : [];
      if (rejected.length > 0 && rejected.length >= to.length) {
        return {
          ok: false,
          // Not retryable: a rejection at RCPT TO is the relay's permanent answer about that
          // address, and retrying ten times changes nothing except how long the operator waits
          // to find out. It is in the log with the addresses, which is what they can act on.
          retryable: false,
          error: `${name} rejected every recipient: ${rejected.join(', ')}`,
        };
      }
      if (rejected.length > 0) {
        // Sent, and short. Recorded as delivered because somebody did get it, and said out loud
        // because "delivered" for a message half the list never saw is how a rota gap survives
        // for months.
        this.#logger.warn(
          { relay: name, rejected, requestId: message.requestId, sensorId: message.sensorId },
          'the relay rejected some recipients',
        );
        return { ok: true, detail: `${name}: ${messageId}; rejected ${rejected.join(', ')}` };
      }
      return { ok: true, detail: `${name}: ${messageId}` };
    } catch (error: unknown) {
      return { ok: false, ...classify(error) };
    }
  }

  #transportFor(name: string, relay: SmtpRelay): Transporter {
    const held = this.#transports.get(name);
    if (held !== undefined) return held;
    const built = this.#build(relay, this.#config);
    this.#transports.set(name, built);
    return built;
  }
}

/**
 * Whether a failure is worth trying again, and what to say about it.
 *
 * SMTP already answers this: a 4xx is "not now" and a 5xx is "not ever", which is the whole
 * reason the protocol has two failure classes. Anything without a code is a connection problem,
 * and those are transient far more often than not.
 */
function classify(error: unknown): { error: string; retryable: boolean } {
  const described = describeError(error);
  const code = (error as { responseCode?: number }).responseCode;
  const command = (error as { command?: string }).command;
  const where = command === undefined ? '' : ` during ${command}`;

  if (typeof code === 'number') {
    return {
      error: `${String(code)}${where}: ${described.message}`,
      retryable: code >= 400 && code < 500,
    };
  }
  return { error: `${described.message}${where}`, retryable: true };
}

/**
 * Turns one relay's configuration into a nodemailer transport.
 *
 * The options object is asserted rather than typed, and the reason is worth recording:
 * `@types/nodemailer` is a separate package on its own release cadence, and its published
 * definitions lag the runtime — `connectionTimeout` and friends are real options that the types
 * do not yet name. Every field below is checked against nodemailer's documented SMTP options and
 * exercised by the tests in `email-delivery.test.ts`, which is a stronger guarantee than a type
 * definition maintained by somebody else.
 */
function buildTransport(relay: SmtpRelay, config: SmtpConfig): Transporter {
  const options: Record<string, unknown> = {
    host: relay.host,
    port: relay.port,
    // `secure` is implicit TLS from the first byte (465). STARTTLS is the same connection
    // upgraded, which nodemailer does when the relay advertises it — `requireTLS` makes it a
    // requirement rather than an offer, so a relay that quietly stopped advertising STARTTLS
    // fails loudly instead of sending the password in the clear.
    secure: relay.security === 'tls',
    requireTLS: relay.security === 'starttls',
    ignoreTLS: relay.security === 'none',
    tls: { rejectUnauthorized: relay.verifyCertificate },
    ...(relay.heloName === '' ? {} : { name: headerSafe(relay.heloName) }),
    ...(relay.auth === 'none'
      ? {}
      : {
          auth: { user: relay.user, pass: relay.password },
          ...(relay.auth === 'auto' ? {} : { authMethod: relay.auth.toUpperCase() }),
        }),
    connectionTimeout: relay.timeoutMs,
    greetingTimeout: relay.timeoutMs,
    socketTimeout: relay.timeoutMs,
    // One connection per message. A pool is the right answer for bulk mail and the wrong one
    // here: notifications are rare, bursty and must not be delayed behind a stale socket that
    // the relay closed hours ago.
    pool: false,
    from: config.sender,
  };
  return createTransport(options as Parameters<typeof createTransport>[0]);
}
