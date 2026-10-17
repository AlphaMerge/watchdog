import { MailConnection, type MailConnectionOptions } from './connection.js';

/**
 * As much POP3 as a monitoring check needs (`T-17`).
 *
 * **The simplest of the three, and the one with the sharpest edge.** POP3 has no message ids that
 * survive a session: `LIST` numbers messages 1..n *within this connection*, and a message deleted
 * in another session renumbers everything after it. So nothing here remembers a number between
 * checks, and the round-trip sensor searches by content rather than by position.
 *
 * **`DELE` is not a delete until `QUIT`.** RFC 1939 §6 — the deletions happen in the UPDATE state
 * when the session ends cleanly, so a check that abandoned the connection would leave the
 * mailbox filling up with its own test messages for ever.
 */

const okOrError = (lines: readonly string[]): boolean => {
  const first = lines[0] ?? '';
  return first.startsWith('+OK') || first.startsWith('-ERR');
};

/** A multi-line reply ends at a line holding one dot — and only after the `+OK` that promised it. */
const untilDot = (lines: readonly string[]): boolean => {
  const first = lines[0] ?? '';
  if (first.startsWith('-ERR')) return true;
  if (!first.startsWith('+OK')) return false;
  return lines.length > 1 && lines[lines.length - 1] === '.';
};

export interface Pop3Message {
  /** Only meaningful inside this session. */
  readonly number: number;
  readonly bytes: number;
}

export class Pop3Session {
  readonly #connection: MailConnection;
  readonly #signal: AbortSignal;

  private constructor(connection: MailConnection, signal: AbortSignal) {
    this.#connection = connection;
    this.#signal = signal;
  }

  static async open(options: MailConnectionOptions, signal: AbortSignal): Promise<Pop3Session> {
    const connection = await MailConnection.open(options, signal);
    const session = new Pop3Session(connection, signal);
    try {
      const greeting = await session.#read(okOrError, 'the greeting');
      if (!(greeting[0] ?? '').startsWith('+OK')) {
        throw connection.failed(`${options.host} did not greet: ${greeting[0] ?? '(nothing)'}`);
      }
      if (options.security === 'starttls') {
        connection.phase = 'handshake';
        const ready = await session.#send('STLS', okOrError, 'the STLS reply');
        if (!(ready[0] ?? '').startsWith('+OK')) {
          throw connection.failed(
            `${options.host} refused STLS: ${ready[0] ?? ''} — this sensor was told to require ` +
              'encryption, and continuing in the clear would send the password in plain text',
          );
        }
        await connection.upgrade(signal);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    return session;
  }

  async login(username: string, password: string): Promise<void> {
    this.#connection.phase = 'authenticate';
    const user = await this.#send(`USER ${username}`, okOrError, 'the USER reply');
    if (!(user[0] ?? '').startsWith('+OK')) {
      throw this.#connection.failed(`the user name was refused: ${user[0] ?? ''}`);
    }
    // Not logged, not put in a message, and never echoed back: this is the one line of the
    // conversation that must not appear in a transcript a failure shows.
    const pass = await this.#send(`PASS ${password}`, okOrError, 'the PASS reply', true);
    if (!(pass[0] ?? '').startsWith('+OK')) {
      throw this.#connection.failed(`authentication was refused: ${pass[0] ?? ''}`);
    }
  }

  /** `STAT` — the count and total size, which is what a mailbox-depth check is. */
  async stat(): Promise<{ count: number; bytes: number }> {
    this.#connection.phase = 'query';
    const reply = await this.#send('STAT', okOrError, 'the STAT reply');
    const match = /^\+OK\s+(\d+)\s+(\d+)/.exec(reply[0] ?? '');
    if (match === null) {
      throw this.#connection.failed(`STAT answered something this cannot read: ${reply[0] ?? ''}`);
    }
    return { count: Number(match[1]), bytes: Number(match[2]) };
  }

  async list(): Promise<Pop3Message[]> {
    this.#connection.phase = 'query';
    const reply = await this.#send('LIST', untilDot, 'the message list');
    if ((reply[0] ?? '').startsWith('-ERR')) {
      throw this.#connection.failed(`LIST was refused: ${reply[0] ?? ''}`);
    }
    const out: Pop3Message[] = [];
    for (const line of reply.slice(1, -1)) {
      const match = /^(\d+)\s+(\d+)/.exec(line);
      if (match !== null) out.push({ number: Number(match[1]), bytes: Number(match[2]) });
    }
    return out;
  }

  /** `TOP n 0` — the headers only, which is all a round-trip needs to find its own message. */
  async headers(number: number): Promise<string[]> {
    const reply = await this.#send(`TOP ${String(number)} 0`, untilDot, 'the message headers');
    if ((reply[0] ?? '').startsWith('-ERR')) {
      throw this.#connection.failed(
        `TOP was refused for message ${String(number)}: ${reply[0] ?? ''} — a server without TOP ` +
          'cannot be used for a round trip, because finding one message would mean downloading ' +
          'every message in the mailbox',
      );
    }
    return reply.slice(1, -1);
  }

  /** Marks for deletion. Nothing is actually removed until `quit` completes — RFC 1939 §6. */
  async markDeleted(number: number): Promise<void> {
    const reply = await this.#send(`DELE ${String(number)}`, okOrError, 'the DELE reply');
    if (!(reply[0] ?? '').startsWith('+OK')) {
      throw this.#connection.failed(
        `message ${String(number)} could not be deleted: ${reply[0] ?? ''}`,
      );
    }
  }

  /**
   * `QUIT`, and the only thing that makes a `DELE` real.
   *
   * Throws when the server refuses, because a round-trip sensor whose cleanup silently failed
   * fills a mailbox with its own test messages one a minute until somebody notices.
   */
  async quit(): Promise<void> {
    try {
      const reply = await this.#send('QUIT', okOrError, 'the QUIT reply');
      if (!(reply[0] ?? '').startsWith('+OK')) {
        throw this.#connection.failed(
          `the server refused QUIT: ${reply[0] ?? ''} — anything marked for deletion in this ` +
            'session has not been deleted',
        );
      }
    } finally {
      this.#connection.close();
    }
  }

  close(): void {
    this.#connection.close();
  }

  async #send(
    line: string,
    isComplete: (lines: readonly string[]) => boolean,
    what: string,
    secret = false,
  ): Promise<string[]> {
    this.#connection.write(line);
    if (!secret) this.#connection.transcript.push(`> ${line}`);
    else this.#connection.transcript.push('> PASS ••••••');
    return this.#read(isComplete, what);
  }

  #read(isComplete: (lines: readonly string[]) => boolean, what: string): Promise<string[]> {
    return this.#connection.read(isComplete, this.#signal, what);
  }
}
