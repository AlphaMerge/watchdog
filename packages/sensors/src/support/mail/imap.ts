import { MailConnection, type MailConnectionOptions } from './connection.js';

/**
 * As much IMAP4rev1 as a monitoring check needs (`T-17`).
 *
 * **Tagged, which is the one thing that makes IMAP different to write against.** Every command
 * carries a tag and the reply is finished when that tag comes back — untagged `*` lines in
 * between are the actual answer, and a server may send them unprompted at any time. Reading IMAP
 * as "one command, one reply" works until the day a `* 3 EXISTS` arrives in the middle and every
 * subsequent reply is off by one line.
 *
 * **The subset stops well short of a mail client**: no IDLE, no partial fetch, no UTF-7 mailbox
 * names, no literals in what this sends. `SEARCH` and a header `FETCH` are what a round trip
 * needs to find its own message, and `STORE \Deleted` plus `EXPUNGE` are what stops the mailbox
 * filling up with them.
 */

export interface ImapStatus {
  readonly messages: number;
  readonly recent: number;
  readonly unseen: number;
}

export class ImapSession {
  readonly #connection: MailConnection;
  readonly #signal: AbortSignal;
  #tag = 0;
  #capabilities = new Set<string>();

  private constructor(connection: MailConnection, signal: AbortSignal) {
    this.#connection = connection;
    this.#signal = signal;
  }

  get capabilities(): ReadonlySet<string> {
    return this.#capabilities;
  }

  static async open(options: MailConnectionOptions, signal: AbortSignal): Promise<ImapSession> {
    const connection = await MailConnection.open(options, signal);
    const session = new ImapSession(connection, signal);
    try {
      const greeting = await connection.read(
        (lines) => (lines[0] ?? '').startsWith('*'),
        signal,
        'the greeting',
      );
      const hello = greeting[0] ?? '';
      if (!/^\*\s+(OK|PREAUTH)\b/.test(hello)) {
        throw connection.failed(`${options.host} did not greet: ${hello || '(nothing)'}`);
      }
      session.#readCapabilities(greeting);
      if (options.security === 'starttls') {
        connection.phase = 'handshake';
        const reply = await session.command('STARTTLS', 'the STARTTLS reply');
        if (reply.status !== 'OK') {
          throw connection.failed(
            `${options.host} refused STARTTLS: ${reply.text} — this sensor was told to require ` +
              'encryption, and continuing in the clear would send the password in plain text',
          );
        }
        await connection.upgrade(signal);
        // Capabilities before and after an upgrade are different documents; a server commonly
        // hides LOGIN behind TLS with LOGINDISABLED until then.
        const refreshed = await session.command('CAPABILITY', 'the capability list');
        session.#readCapabilities(refreshed.untagged);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    return session;
  }

  #readCapabilities(lines: readonly string[]): void {
    for (const line of lines) {
      const match = /CAPABILITY\s+([^\]]*)/i.exec(line);
      if (match === null) continue;
      for (const word of (match[1] ?? '').trim().split(/\s+/)) {
        if (word !== '' && word !== ']') this.#capabilities.add(word.toUpperCase());
      }
    }
  }

  async login(username: string, password: string): Promise<void> {
    this.#connection.phase = 'authenticate';
    if (this.#capabilities.has('LOGINDISABLED')) {
      throw this.#connection.failed(
        'this server advertises LOGINDISABLED, which means it will not accept a password on an ' +
          'unencrypted connection — use STARTTLS or implicit TLS',
      );
    }
    const reply = await this.command(
      `LOGIN ${quoted(username)} ${quoted(password)}`,
      'the login reply',
      `LOGIN ${quoted(username)} ••••••`,
    );
    if (reply.status !== 'OK') {
      throw this.#connection.failed(`authentication was refused: ${reply.text}`);
    }
  }

  /** `STATUS` — counts without selecting, which is what a mailbox-depth check is. */
  async status(mailbox: string): Promise<ImapStatus> {
    this.#connection.phase = 'query';
    const reply = await this.command(
      `STATUS ${quoted(mailbox)} (MESSAGES RECENT UNSEEN)`,
      'the mailbox status',
    );
    if (reply.status !== 'OK') {
      throw this.#connection.failed(`the mailbox ${mailbox} could not be read: ${reply.text}`);
    }
    const line = reply.untagged.find((one) => /STATUS/i.test(one)) ?? '';
    const read = (name: string): number => {
      const match = new RegExp(`${name}\\s+(\\d+)`, 'i').exec(line);
      return match === null ? 0 : Number(match[1]);
    };
    return { messages: read('MESSAGES'), recent: read('RECENT'), unseen: read('UNSEEN') };
  }

  /** `SELECT`, which a search or a delete needs and `STATUS` does not. */
  async select(mailbox: string): Promise<number> {
    this.#connection.phase = 'query';
    const reply = await this.command(`SELECT ${quoted(mailbox)}`, 'the mailbox to be selected');
    if (reply.status !== 'OK') {
      throw this.#connection.failed(`the mailbox ${mailbox} could not be selected: ${reply.text}`);
    }
    for (const line of reply.untagged) {
      const match = /^\*\s+(\d+)\s+EXISTS/i.exec(line);
      if (match !== null) return Number(match[1]);
    }
    return 0;
  }

  /** Sequence numbers matching a search. `HEADER Subject "…"` is what a round trip uses. */
  async search(criteria: string): Promise<number[]> {
    const reply = await this.command(`SEARCH ${criteria}`, 'the search results');
    if (reply.status !== 'OK')
      throw this.#connection.failed(`the search was refused: ${reply.text}`);
    const line = reply.untagged.find((one) => /^\*\s+SEARCH/i.test(one)) ?? '';
    return line
      .replace(/^\*\s+SEARCH/i, '')
      .trim()
      .split(/\s+/)
      .filter((word) => /^\d+$/.test(word))
      .map(Number);
  }

  /** Marks deleted and expunges, which is the only pair that actually removes anything. */
  async deleteMessages(numbers: readonly number[]): Promise<void> {
    if (numbers.length === 0) return;
    const stored = await this.command(
      `STORE ${numbers.join(',')} +FLAGS (\\Deleted)`,
      'the messages to be flagged',
    );
    if (stored.status !== 'OK') {
      throw this.#connection.failed(
        `the test messages could not be flagged for deletion: ${stored.text}`,
      );
    }
    const expunged = await this.command('EXPUNGE', 'the mailbox to be expunged');
    if (expunged.status !== 'OK') {
      throw this.#connection.failed(
        `the test messages were flagged but not removed: ${expunged.text} — a round-trip sensor ` +
          'whose cleanup fails fills a mailbox one message a minute',
      );
    }
  }

  async command(
    line: string,
    what: string,
    redacted?: string,
  ): Promise<{ status: string; text: string; untagged: string[] }> {
    this.#tag += 1;
    const tag = `a${String(this.#tag).padStart(4, '0')}`;
    this.#connection.write(`${tag} ${line}`);
    this.#connection.transcript.push(`> ${tag} ${redacted ?? line}`);

    const lines = await this.#connection.read(
      (candidates) => {
        const last = candidates[candidates.length - 1] ?? '';
        return last.startsWith(`${tag} `);
      },
      this.#signal,
      what,
    );
    const final = lines[lines.length - 1] ?? '';
    const match = new RegExp(`^${tag}\\s+(OK|NO|BAD)\\s*(.*)$`, 'i').exec(final);
    return {
      status: (match?.[1] ?? 'BAD').toUpperCase(),
      text: match?.[2] ?? final,
      untagged: lines.slice(0, -1),
    };
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT', 'the logout reply');
    } catch {
      // A server that hangs up on LOGOUT has done everything asked of it.
    }
    this.#connection.close();
  }

  close(): void {
    this.#connection.close();
  }
}

/**
 * An IMAP quoted string.
 *
 * Backslash and double quote are the two characters that need escaping, and a password
 * containing either is exactly the case that would otherwise produce a login failure nobody can
 * explain.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
