import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { serverIdentity, type TargetPolicy } from '@ms/shared';
import { checkedTarget, lookupFor } from '../checked-target.js';
import {
  isCredentialsWithheld,
  pinnedLookup,
  pinnedPeerRefusal,
  type PinnedAddress,
  type ResolveHost,
} from '../pinned-target.js';

/**
 * One line-oriented mail connection, shared by SMTP, POP3 and IMAP (`T-17`).
 *
 * **All three are the same transport wearing different words.** A TCP socket, CRLF-terminated
 * lines, an optional `STARTTLS` upgrade in the middle, and a reply that is either one line or
 * several with a rule for knowing when it has ended. Writing that three times is three chances
 * to get the timeout, the abort or the line splitting subtly differently — and the failure mode
 * of getting it wrong is a sensor that hangs a worker rather than one that reports a fault.
 *
 * **The read bound is per reply, not per connection**, because a mail server that has stopped
 * answering looks exactly like one that is thinking, and only a deadline tells them apart. It is
 * `ctx.signal` *and* a timer: the signal ends a check the scheduler gave up on, and the timer
 * ends one where the far end simply never speaks.
 */

export interface MailConnectionOptions {
  readonly host: string;
  readonly port: number;
  /** `none` is plain text, `tls` wraps the socket immediately, `starttls` upgrades in-band. */
  readonly security: 'none' | 'tls' | 'starttls';
  readonly verifyTls: boolean;
  readonly timeoutMs: number;
  readonly ipVersion: 'auto' | 'v4' | 'v6';
  /**
   * The address the socket connects to, in place of resolving `host` (`A-41c`): the one checked
   * against the credential set's targets. Answered to the socket's `lookup`, so `host` is still
   * what TLS sends as SNI and checks the certificate against, immediately or after `STARTTLS`.
   */
  readonly pinned?: PinnedAddress;
  /**
   * What the probe lets a sensor connect to (`CheckTarget.policy`, `A-57`). Every connection is
   * checked against it: `host` is resolved once, every address it has is checked, and the
   * socket's `lookup` answers with those. A pinned address is checked as it stands.
   */
  readonly targetPolicy?: TargetPolicy;
  /** The device's exception to it (`CheckTarget.policyException`, `A-64`). */
  readonly targetPolicyException?: readonly string[];
  /** How that one lookup is made (`CheckTarget.resolve`). Absent, the system's resolver. */
  readonly resolve?: ResolveHost;
}

/** How much a server may say before this gives up. Generous for a mailbox listing, and bounded. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

export class MailConnection {
  #socket: Socket | TLSSocket;
  #buffer = '';
  #closed: Error | null = null;
  #waiting: (() => void) | null = null;
  readonly #options: MailConnectionOptions;
  /** Every line the server sent, for a failure that can show the conversation. */
  readonly transcript: string[] = [];

  private constructor(socket: Socket | TLSSocket, options: MailConnectionOptions) {
    this.#socket = socket;
    this.#options = options;
    this.#bind(socket);
  }

  #bind(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      if (this.#buffer.length > MAX_REPLY_BYTES) {
        this.#fail(
          new MailError(
            `${this.#options.host} sent more than ${String(MAX_REPLY_BYTES)} bytes in one reply`,
          ),
        );
        return;
      }
      this.#waiting?.();
    });
    socket.on('error', (error: Error) => {
      this.#fail(error);
    });
    socket.on('close', () => {
      this.#fail(new MailError(`${this.#options.host} closed the connection`));
    });
  }

  #fail(error: Error): void {
    this.#closed ??= error;
    this.#waiting?.();
  }

  static async open(options: MailConnectionOptions, signal: AbortSignal): Promise<MailConnection> {
    const family = options.ipVersion === 'v6' ? 6 : options.ipVersion === 'v4' ? 4 : 0;
    const pinned = options.pinned;
    const began = process.hrtime.bigint();
    // **Before the socket is made** (`A-57`): the probe's target policy, over the pinned address
    // or over every address the name has. A refusal is this check's failure, and nothing is
    // sent. Each connection of a check is checked on its own lookup.
    const checked = await checkedTarget({
      host: options.host,
      family,
      ...(pinned === undefined ? {} : { pinned }),
      ...(options.targetPolicy === undefined ? {} : { policy: options.targetPolicy }),
      ...(options.targetPolicyException === undefined
        ? {}
        : { exception: options.targetPolicyException }),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      timeoutMs: options.timeoutMs,
      signal,
      verb: 'connect to',
      doing: `connecting to ${options.host}:${String(options.port)}`,
    });
    // The checked address, whatever the socket asks its lookup for (`A-41c`); or, where no
    // credential set pinned one, the addresses the policy checked.
    const pin =
      pinned === undefined
        ? lookupFor(options.host, checked)
        : { lookup: pinnedLookup(options.host, pinned) };
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const done = (error: Error): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      const timer = setTimeout(
        () => {
          made.destroy();
          done(
            new MailError(
              `${options.host}:${String(options.port)} did not accept a connection within ` +
                `${String(options.timeoutMs)} ms`,
            ),
          );
        },
        // The lookup and the connect share the one timeout, as when the socket made the lookup.
        Math.max(1, options.timeoutMs - Number(process.hrtime.bigint() - began) / 1e6),
      );
      timer.unref();
      const onAbort = (): void => {
        made.destroy();
        done(new MailError(`the check was cancelled while connecting to ${options.host}`));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const made =
        options.security === 'tls'
          ? tlsConnect({
              host: options.host,
              port: options.port,
              // RFC 6066 forbids an address literal in SNI, and Node warns about it. A device
              // configured by address simply sends none, which is what every other client does.
              ...(isAddress(options.host) ? {} : { servername: options.host }),
              rejectUnauthorized: options.verifyTls,
              // Who the certificate has to be for: the check every TLS client here shares,
              // which can answer for an IPv6 address where Node's own cannot (`A-67`).
              checkServerIdentity: serverIdentity,
              ...(family === 0 ? {} : { family }),
              ...pin,
            })
          : netConnect({
              host: options.host,
              port: options.port,
              ...(family === 0 ? {} : { family }),
              ...pin,
            });

      made.once(options.security === 'tls' ? 'secureConnect' : 'connect', () => {
        // Before anything is said on it, and so before a password is (`A-41c`): the far end
        // has to be the address that was checked.
        const refusal =
          pinned === undefined ? null : pinnedPeerRefusal(options.host, pinned, made.remoteAddress);
        if (refusal !== null) {
          made.destroy();
          done(refusal);
          return;
        }
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(made);
      });
      made.once('error', (error: Error) => {
        done(describe(error, options));
      });
    });

    return new MailConnection(socket, options);
  }

  /**
   * Upgrades a plain connection to TLS in place, after the protocol's own `STARTTLS`.
   *
   * The socket is re-bound rather than re-opened: the session state — the greeting, the
   * capabilities, the mailbox — belongs to the connection, and a fresh socket would throw it
   * away in the middle of a conversation.
   */
  async upgrade(signal: AbortSignal): Promise<void> {
    const plain = this.#socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    this.#buffer = '';

    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new MailError(
            `${this.#options.host} did not complete a TLS handshake within ` +
              `${String(this.#options.timeoutMs)} ms of STARTTLS`,
          ),
        );
      }, this.#options.timeoutMs);
      timer.unref();
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new MailError(`the check was cancelled during the TLS handshake`));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const upgraded = tlsConnect(
        {
          socket: plain,
          // **The host, though the socket is already connected** (`A-67`). It connects
          // nothing; it is what the certificate is checked against when no server name is
          // sent, which is every device given by address. Without it Node falls back to the
          // literal name `localhost`: a relay at an address was refused under a certificate
          // that lists the address, and accepted under any trusted one for `localhost`.
          host: this.#options.host,
          ...(isAddress(this.#options.host) ? {} : { servername: this.#options.host }),
          rejectUnauthorized: this.#options.verifyTls,
          checkServerIdentity: serverIdentity,
        },
        () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(upgraded);
        },
      );
      upgraded.once('error', (error: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(describe(error, this.#options));
      });
    });

    this.#socket = secure;
    this.#closed = null;
    this.#bind(secure);
  }

  write(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  /**
   * Reads until `isComplete` says the reply has ended.
   *
   * The caller decides, because each protocol ends a reply its own way: SMTP by a space after the
   * code, POP3 by a lone dot after a `+OK` that promised one, IMAP by its own tag coming back.
   */
  async read(
    isComplete: (lines: readonly string[]) => boolean,
    signal: AbortSignal,
    what: string,
  ): Promise<string[]> {
    const deadline = Date.now() + this.#options.timeoutMs;
    for (;;) {
      const lines = this.#take(isComplete);
      if (lines !== null) {
        this.transcript.push(...lines);
        return lines;
      }
      if (this.#closed !== null) throw this.#closed;
      if (signal.aborted) {
        throw new MailError(`the check was cancelled while waiting for ${what}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new MailError(
          `${this.#options.host} did not finish ${what} within ` +
            `${String(this.#options.timeoutMs)} ms` +
            (this.#buffer === '' ? ' (it sent nothing at all)' : ''),
        );
      }
      await this.#wait(left, signal);
    }
  }

  /** The complete reply sitting in the buffer, or null when more is still to come. */
  #take(isComplete: (lines: readonly string[]) => boolean): string[] | null {
    const parts = this.#buffer.split('\r\n');
    // The last part is whatever came after the final CRLF: an incomplete line, or empty.
    const complete = parts.slice(0, -1);
    for (let end = 1; end <= complete.length; end += 1) {
      const candidate = complete.slice(0, end);
      if (isComplete(candidate)) {
        this.#buffer = [...complete.slice(end), parts[parts.length - 1] ?? ''].join('\r\n');
        return candidate;
      }
    }
    return null;
  }

  #wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.#waiting = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      signal.addEventListener('abort', finish, { once: true });
      this.#waiting = finish;
    });
  }

  /** Closes without waiting. Called from a `finally`, so it must never throw. */
  close(): void {
    this.#socket.removeAllListeners('close');
    this.#socket.destroy();
  }
}

/** An IPv4 or IPv6 literal, which RFC 6066 says must not appear in SNI. */
function isAddress(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(':');
}

/** Turns a socket or TLS failure into something that names the cause. */
function describe(error: unknown, options: MailConnectionOptions): Error {
  // A refusal over where the credentials may go keeps its class (`A-41c`): that is what makes
  // the sensor read Unknown rather than Down.
  if (isCredentialsWithheld(error)) return error;
  const where = `${options.host}:${String(options.port)}`;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ECONNREFUSED') return new MailError(`nothing is listening at ${where}`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new MailError(`the device’s host name did not resolve, connecting to ${where}`);
  }
  if (code === 'CERT_HAS_EXPIRED') return new MailError(`the certificate at ${where} has expired`);
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new MailError(
      `the certificate at ${where} is self-signed and this sensor verifies certificates — turn ` +
        'that off if it is meant to be, or watch it properly with a TLS Certificate sensor',
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new MailError(`the certificate at ${where} is not valid for ${options.host}`);
  }
  return new MailError(`connecting to ${where} failed: ${message}`);
}
