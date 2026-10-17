import { MailConnection, type MailConnectionOptions } from './connection.js';

/**
 * As much SMTP as a monitoring check needs (`T-17`).
 *
 * **Not a mail client.** It greets, optionally upgrades and authenticates, and either stops there
 * or posts one message. No queueing, no retries, no bounce handling, no MIME beyond a header
 * block and a line of text — the things that make a mail library large are the things a check
 * must not do, because a sensor that retried would be a sensor that reports Up while a relay is
 * refusing every third message.
 *
 * **`EHLO` first and `HELO` only as a fallback**, in that order, because a server that answers
 * `EHLO` with 500 is old rather than broken and refusing to talk to it would be this sensor's
 * opinion rather than a fault.
 */

/** A reply has ended when a line has a space rather than a hyphen after its three-digit code. */
const replyComplete = (lines: readonly string[]): boolean => {
  const last = lines[lines.length - 1] ?? '';
  return /^[0-9]{3}(?: |$)/.test(last);
};

export interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
  readonly text: string;
}

export class SmtpSession {
  readonly #connection: MailConnection;
  readonly #signal: AbortSignal;
  #capabilities = new Set<string>();

  private constructor(connection: MailConnection, signal: AbortSignal) {
    this.#connection = connection;
    this.#signal = signal;
  }

  get capabilities(): ReadonlySet<string> {
    return this.#capabilities;
  }

  static async open(options: MailConnectionOptions, signal: AbortSignal): Promise<SmtpSession> {
    const connection = await MailConnection.open(options, signal);
    const session = new SmtpSession(connection, signal);
    try {
      const greeting = await session.#read('the greeting');
      if (greeting.code !== 220) {
        throw connection.failed(
          `${options.host} greeted with ${String(greeting.code)} rather than 220: ${greeting.text}`,
        );
      }
      await session.#hello(options.host);
      if (options.security === 'starttls') {
        connection.phase = 'handshake';
        if (!session.#capabilities.has('STARTTLS')) {
          // Named rather than silently continuing in the clear. A sensor that quietly downgraded
          // would report a healthy relay while sending credentials in plain text.
          throw connection.failed(
            `${options.host} does not offer STARTTLS, and this sensor was told to require it`,
          );
        }
        const ready = await session.command('STARTTLS', 'the STARTTLS reply');
        if (ready.code !== 220) {
          throw connection.failed(`STARTTLS was refused with ${String(ready.code)}: ${ready.text}`);
        }
        await connection.upgrade(signal);
        // The capability list before and after an upgrade are different documents — AUTH in
        // particular usually appears only once the connection is encrypted.
        connection.phase = 'connect';
        await session.#hello(options.host);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    return session;
  }

  async #hello(host: string): Promise<void> {
    const name = clientName(host);
    const extended = await this.command(`EHLO ${name}`, 'the EHLO reply');
    if (extended.code === 250) {
      this.#capabilities = new Set(
        extended.lines
          .slice(1)
          .map((line) => line.slice(4).trim().toUpperCase().split(' ')[0] ?? '')
          .filter((word) => word !== ''),
      );
      // AUTH's mechanisms are on the same line as the keyword, and which ones exist decides
      // whether LOGIN is available at all.
      for (const line of extended.lines) {
        const auth = /^250[ -]AUTH\s+(.+)$/i.exec(line);
        if (auth !== null) {
          for (const mechanism of (auth[1] ?? '').trim().toUpperCase().split(/\s+/)) {
            this.#capabilities.add(`AUTH=${mechanism}`);
          }
        }
      }
      return;
    }
    const plain = await this.command(`HELO ${name}`, 'the HELO reply');
    if (plain.code !== 250) {
      throw this.#connection.failed(
        `${host} refused both EHLO and HELO — the last was ${String(plain.code)}: ${plain.text}`,
      );
    }
    this.#capabilities = new Set();
  }

  async authenticate(username: string, password: string): Promise<void> {
    this.#connection.phase = 'authenticate';
    if (this.#capabilities.has('AUTH=PLAIN')) {
      const token = Buffer.from(`\0${username}\0${password}`).toString('base64');
      const reply = await this.command(`AUTH PLAIN ${token}`, 'the authentication reply');
      if (reply.code === 235) return;
      throw this.#connection.failed(
        `authentication was refused: ${String(reply.code)} ${reply.text}`,
      );
    }
    if (this.#capabilities.has('AUTH=LOGIN')) {
      const start = await this.command('AUTH LOGIN', 'the authentication challenge');
      if (start.code !== 334) {
        throw this.#connection.failed(
          `AUTH LOGIN was refused: ${String(start.code)} ${start.text}`,
        );
      }
      const asked = await this.command(
        Buffer.from(username).toString('base64'),
        'the password challenge',
      );
      if (asked.code !== 334) {
        throw this.#connection.failed(
          `the user name was refused: ${String(asked.code)} ${asked.text}`,
        );
      }
      const done = await this.command(
        Buffer.from(password).toString('base64'),
        'the authentication reply',
      );
      if (done.code === 235) return;
      throw this.#connection.failed(
        `authentication was refused: ${String(done.code)} ${done.text}`,
      );
    }
    throw this.#connection.failed(
      'this server offers no authentication mechanism this sensor can use — it advertised ' +
        (this.#capabilities.size === 0
          ? 'nothing at all, which means it only speaks HELO'
          : [...this.#capabilities].join(', ')),
    );
  }

  /**
   * Posts one message and returns the server's acceptance line, which usually holds a queue id.
   *
   * **The addresses are checked for line breaks here, at the protocol, not at the caller.** A
   * carriage return inside `MAIL FROM:<…>` ends the command and everything after it is read as
   * the next one — an address is a sensor parameter, so that is command injection through a
   * configuration form. Guarding it in the one place that writes the command means a new caller
   * cannot forget.
   */
  async send(from: string, to: string, message: string): Promise<string> {
    this.#connection.phase = 'send';
    for (const [what, address] of [
      ['sender', from],
      ['recipient', to],
    ] as const) {
      if (/[\r\n]/.test(address)) {
        throw this.#connection.failed(
          `the ${what} address contains a line break, which would end the SMTP command and let ` +
            'whatever follows it be read as another one',
        );
      }
    }
    const sender = await this.command(`MAIL FROM:<${from}>`, 'the MAIL FROM reply');
    if (sender.code !== 250) {
      throw this.#connection.failed(
        `the sender ${from} was refused: ${String(sender.code)} ${sender.text}`,
      );
    }
    const recipient = await this.command(`RCPT TO:<${to}>`, 'the RCPT TO reply');
    if (recipient.code !== 250 && recipient.code !== 251) {
      throw this.#connection.failed(
        `the recipient ${to} was refused: ${String(recipient.code)} ${recipient.text}`,
      );
    }
    const start = await this.command('DATA', 'the DATA reply');
    if (start.code !== 354) {
      throw this.#connection.failed(
        `the server would not accept a message: ${String(start.code)} ${start.text}`,
      );
    }
    // Dot-stuffing. A line of a single dot inside a message ends it, which is how a monitoring
    // message containing one would truncate every message after it in the mailbox.
    const body = message
      .split(/\r?\n/)
      .map((line) => (line.startsWith('.') ? `.${line}` : line))
      .join('\r\n');
    this.#connection.write(`${body}\r\n.`);
    const accepted = await this.#read('the message to be accepted');
    if (accepted.code !== 250) {
      throw this.#connection.failed(
        `the message was refused after DATA: ${String(accepted.code)} ${accepted.text}`,
      );
    }
    return accepted.text;
  }

  async command(line: string, what: string): Promise<SmtpReply> {
    this.#connection.write(line);
    return this.#read(what);
  }

  async #read(what: string): Promise<SmtpReply> {
    const lines = await this.#connection.read(replyComplete, this.#signal, what);
    const last = lines[lines.length - 1] ?? '';
    return {
      code: Number(last.slice(0, 3)),
      lines,
      text: lines
        .map((line) => line.slice(4))
        .join(' ')
        .trim(),
    };
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT', 'the QUIT reply');
    } catch {
      // A server that hangs up on QUIT has still done everything asked of it, and turning that
      // into a check failure would report a fault that did not happen.
    }
    this.#connection.close();
  }

  close(): void {
    this.#connection.close();
  }
}

/**
 * What to call ourselves in EHLO.
 *
 * Not the monitored host — that is who we are talking *to*. Some relays check that the name
 * resolves, so a plain label is safer than a fabricated FQDN, and the address literal form is
 * what RFC 5321 §4.1.3 says to use when there is nothing better.
 */
function clientName(host: string): string {
  return /^[0-9.]+$/.test(host) || host.includes(':') ? '[127.0.0.1]' : 'monitoring-system';
}
