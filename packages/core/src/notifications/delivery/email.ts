import { createTransport, type Transporter } from 'nodemailer';
import {
  describeError,
  serverIdentity,
  type Logger,
  type SmtpConfig,
  type SmtpRelay,
} from '@ms/shared';
import { EMAIL_METHOD } from '../methods.js';
import {
  headerSafe,
  type DeliveryResult,
  type DeliveryTransport,
  type OutgoingMessage,
} from './transport.js';
import type { Escaping } from '../placeholders.js';
import { NOBODY_TO_SEND_TO, type RecipientSource } from '../recipients.js';

export interface EmailTransportOptions {
  config: SmtpConfig;
  logger: Logger;
  /**
   * Turns a template's users and groups into addresses when a message is sent (`M-19`).
   *
   * Required: email is the one method that sends to people, and a transport built without this
   * is the one that dropped them for a year without saying so.
   */
  recipients: RecipientSource;
  /** Swapped in tests for a relay that fails on demand. Production uses nodemailer. */
  build?: (relay: SmtpRelay, config: SmtpConfig) => Transporter;
}

/** What a relay attempt produced, before the fallback decision is made. */
interface Attempt {
  readonly relay: string;
  readonly result: DeliveryResult;
}

/** One file on a message. Only email can carry these; no other method has an attachment. */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/**
 * A message to send, with nothing about *why* in it.
 *
 * **The alarm shape is `OutgoingMessage` and is one caller's contract, not SMTP's.** `E-09` sends a
 * report, which has no sensor, no notification request and no `MessageContext` — eighteen fields
 * that would all have to be filled with lies. Rather than loosen that type for every transport, or
 * build a second SMTP client, the relay handling below works on this and both entry points build
 * one. `send` is unchanged from the outside.
 */
interface Envelope {
  readonly subject: string;
  readonly body: string;
  readonly html: boolean;
  readonly priority: number;
  readonly from: string;
  readonly attachments: readonly MailAttachment[];
  /** For the correlation headers and the log lines. `sensorId` 0 means "not about a sensor". */
  readonly requestId: number;
  readonly sensorId: number;
}

/** What `E-09` hands this transport: a document, some addresses, and nothing else. */
export interface DocumentMessage {
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly attachments: readonly MailAttachment[];
  /** Ties the delivered mail back to the row that owed it. A report run's id. */
  readonly requestId: number;
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
  readonly #recipients: RecipientSource;
  readonly #build: (relay: SmtpRelay, config: SmtpConfig) => Transporter;
  readonly #transports = new Map<string, Transporter>();

  constructor(options: EmailTransportOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'email' });
    this.#recipients = options.recipients;
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

    if (message.recipients.length === 0) {
      return { ok: false, retryable: false, error: 'the template has no recipients' };
    }
    const resolved = await this.#recipients.resolve(message.recipients, message.about);
    if (resolved.addresses.length === 0) {
      // Permanent: waiting does not give anybody an address or a right. "Nobody to send to" is
      // actionable only once it says who and why, so who travels with it — beside the error, not
      // in it, because who may read the names depends on who is asking (`A-44`).
      return {
        ok: false,
        retryable: false,
        error: NOBODY_TO_SEND_TO,
        skipped: resolved.skipped,
      };
    }

    const override = message.settings['senderOverride'];
    const result = await this.#deliver(
      {
        subject: message.subject,
        body: message.body,
        html: message.settings['format'] === 'html',
        priority: message.priority,
        from: headerSafe(
          typeof override === 'string' && override !== '' ? override : this.#config.sender,
        ),
        attachments: [],
        requestId: message.requestId,
        sensorId: message.sensorId,
      },
      resolved.addresses.map(headerSafe),
    );
    // **Sent, and who was not** — a partial send is still a send, and the people it missed are
    // named where the delivery is recorded rather than dropped without a word (`M-19`).
    if (!result.ok || resolved.skipped.length === 0) return result;
    return { ok: true, detail: result.detail, skipped: resolved.skipped };
  }

  /**
   * Sends a document to a list of addresses (`E-09`).
   *
   * The same relays, the same fallback, the same header sanitising and the same partial-send
   * detection `P-119` added — a report is an attachment, not a new channel, and building a second
   * path to the same relay is how the two drift.
   */
  async sendDocument(message: DocumentMessage): Promise<DeliveryResult> {
    if (!this.configured) {
      return {
        ok: false,
        retryable: false,
        error:
          'no SMTP relay is configured — set notifications.smtp.primary.host and ' +
          'notifications.smtp.sender',
      };
    }
    const to = message.recipients.map(headerSafe).filter((address) => address !== '');
    if (to.length === 0) {
      return { ok: false, retryable: false, error: 'the report has no recipients' };
    }

    return this.#deliver(
      {
        subject: message.subject,
        body: message.body,
        html: false,
        // 3 is normal. A report is not an alarm, and one that arrives marked high-importance every
        // month is how a mail client's rules learn to ignore it.
        priority: 3,
        from: headerSafe(this.#config.sender),
        attachments: message.attachments,
        requestId: message.requestId,
        sensorId: 0,
      },
      to,
    );
  }

  async #deliver(mail: Envelope, to: readonly string[]): Promise<DeliveryResult> {
    const attempts: Attempt[] = [];
    for (const [name, relay] of this.#relays()) {
      const result = await this.#sendVia(relay, name, mail, to);
      attempts.push({ relay: name, result });
      if (result.ok) {
        if (attempts.length > 1) {
          this.#logger.warn(
            { requestId: mail.requestId, relay: name },
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
    mail: Envelope,
    to: readonly string[],
  ): Promise<DeliveryResult> {
    try {
      const transport = this.#transportFor(name, relay);
      const { html, from } = mail;

      const sent: unknown = await transport.sendMail({
        from,
        to: [...to],
        subject: headerSafe(mail.subject),
        ...(html ? { html: mail.body } : { text: mail.body }),
        ...(mail.attachments.length === 0
          ? {}
          : {
              attachments: mail.attachments.map((file) => ({
                // Sanitised here as well: a filename is built from an operator's report title and
                // travels in a Content-Disposition header, which is line-oriented like every
                // other one.
                filename: headerSafe(file.filename),
                contentType: file.contentType,
                content: file.content,
              })),
            }),
        headers: {
          // What an operator's mail client sorts on. 1-2 high, 3 normal, 4-5 low, which is the
          // convention every client agrees on even though the header is not standardised.
          'X-Priority': String(mail.priority),
          Importance: mail.priority <= 2 ? 'high' : mail.priority >= 4 ? 'low' : 'normal',
          // Ties a delivered message back to the row that owed it, which is the only way to
          // answer "did this alarm go out" from the mail side.
          'X-MS-Request': String(mail.requestId),
          // Omitted rather than claiming sensor zero: `E-09` sends a report, which is not about
          // one sensor, and a header that says `0` is a worse answer than no header.
          ...(mail.sensorId === 0 ? {} : { 'X-MS-Sensor': String(mail.sensorId) }),
        },
      });
      // Narrowed rather than trusted: `@types/nodemailer` lags the runtime (see
      // `buildTransport`), so what comes back is `any` as far as the checker is concerned.
      const envelope = sent as {
        messageId?: unknown;
        rejected?: unknown;
        accepted?: unknown;
      } | null;
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
      // **"Nobody got it" is `accepted`, not a count against our own list** (`R13`). `to.length`
      // counts the recipient *entries* the template resolved, and one entry is a 320-character
      // string that nothing stops from holding two addresses — `ops@x, oncall@x` passes the
      // `includes('@')` check the template applies. nodemailer parses that into two envelope
      // recipients, so one rejection out of two satisfied `rejected.length >= to.length`: a
      // message a real person received was reported a permanent failure, the fallback relay sent
      // them a second copy, and with no fallback Delivery Health went Down over an alarm that
      // was delivered. nodemailer reports exactly who took it; ask that.
      const accepted = Array.isArray(envelope?.accepted)
        ? envelope.accepted.map((one) => String(one))
        : undefined;
      const nobodyTookIt =
        accepted === undefined ? rejected.length >= to.length : accepted.length === 0;
      if (rejected.length > 0 && nobodyTookIt) {
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
          { relay: name, rejected, requestId: mail.requestId, sensorId: mail.sensorId },
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
 *
 * **The return is asserted for the same reason, and the lag is now a major version wide.**
 * nodemailer 10 ships no types of its own and `@types/nodemailer` is still published for 9, where
 * `createTransport` is declared as returning `Mail<any>` rather than a `Transporter`. The value is
 * the transport; only the definition disagrees, and `email-delivery.test.ts` sends real mail
 * through it against a real relay on every run.
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
    // Who the certificate has to be for is the check every TLS client here shares (`A-67`):
    // Node's own for a name or an IPv4 address, and for a relay given by IPv6 address one that
    // Node's cannot make — it reads the address as a name, so such a relay failed every send
    // under a certificate that lists it. nodemailer hands these options to both of its TLS
    // connections, implicit and after STARTTLS. Whether it is enforced is `verifyCertificate`.
    tls: { rejectUnauthorized: relay.verifyCertificate, checkServerIdentity: serverIdentity },
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
  // See the note above: the 9.x definitions type this as `Mail<any>`, and the runtime returns the
  // transport this claims. The directive has to sit immediately above the statement it covers.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return createTransport(options as Parameters<typeof createTransport>[0]);
}
