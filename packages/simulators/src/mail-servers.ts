import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';

/**
 * In-house SMTP, POP3 and IMAP simulators (`T-17`).
 *
 * CLAUDE.md requires new sensor types to be tested against a simulator rather than a live target,
 * and these three are the reason the mail ticket is large: what is worth asserting about a mail
 * sensor is what happens when a relay accepts a connection and then refuses at `RCPT TO`, when a
 * server does not offer `STARTTLS`, when `QUIT` fails and a deletion therefore never happened.
 * None of that is reachable against a real server behaving normally.
 *
 * **One mailbox shared by all three**, so a round trip is a real round trip: the SMTP simulator
 * delivers into it and the POP3 and IMAP simulators read it out.
 */

export interface Message {
  readonly subject: string;
  readonly raw: string;
  deleted: boolean;
}

export class Mailbox {
  readonly messages: Message[] = [];
  /** Delivery delay in ms, so the round-trip sensor's polling has something to poll for. */
  deliverAfterMs = 0;

  deliver(raw: string): void {
    const subject = /^subject:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? '';
    const message: Message = { subject, raw, deleted: false };
    if (this.deliverAfterMs === 0) {
      this.messages.push(message);
      return;
    }
    const timer = setTimeout(() => {
      this.messages.push(message);
    }, this.deliverAfterMs);
    timer.unref();
  }

  get live(): Message[] {
    return this.messages.filter((message) => !message.deleted);
  }

  reset(): void {
    this.messages.length = 0;
    this.deliverAfterMs = 0;
  }
}

export interface MailServerOptions {
  readonly mailbox: Mailbox;
  readonly username?: string;
  readonly password?: string;
  /** A self-signed key/cert pair, when the test wants STARTTLS. */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Offer STARTTLS at all. False is the "server does not support it" case. */
  readonly offerStartTls?: boolean;
  /** Refuse at this stage, to prove the sensor names the step rather than "the check failed". */
  readonly refuseAt?: 'greeting' | 'mail-from' | 'rcpt-to' | 'data' | 'quit';
  /** Milliseconds before the greeting, for the timeout case. */
  readonly greetingDelayMs?: number;
  /**
   * Refuse `MAIL FROM` until the client has authenticated.
   *
   * Off by default, because a relay that advertises `AUTH` and still accepts mail from a known
   * host is the ordinary internal case — and it is the case the sensor's `requireAuth: false`
   * default is written for.
   */
  readonly requireAuth?: boolean;
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

/** A line-oriented server. Each simulator supplies the conversation; this supplies the plumbing. */
function serve(
  handle: (socket: Duplexish, options: MailServerOptions) => void,
  options: MailServerOptions,
): Promise<RunningServer> {
  // Tracked so `close()` can end them. `Server.close` waits for open connections, and a mail
  // conversation left mid-dialogue by a test is one — the same teardown hang `P-63` fixed in the
  // HTTP simulator, in the one helper every mail simulator here is built on.
  const sockets = new Set<Socket>();
  const server: Server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    handle(wrap(socket, options), options);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

interface Duplexish {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  /** Swaps the socket for a TLS one in place, which is what STARTTLS is. */
  upgrade(): void;
  end(): void;
}

function wrap(socket: Socket, options: MailServerOptions): Duplexish {
  let current: Socket | TLSSocket = socket;
  let buffer = '';
  let handler: (line: string) => void = () => undefined;
  /** Set while a simulator is consuming raw lines (SMTP's DATA), so they are not parsed. */
  const bind = (target: Socket | TLSSocket): void => {
    target.setEncoding('utf8');
    target.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf('\r\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        handler(line);
      }
    });
    target.on('error', () => undefined);
  };
  bind(current);

  return {
    send(line: string): void {
      current.write(`${line}\r\n`);
    },
    onLine(next): void {
      handler = next;
    },
    upgrade(): void {
      const pair = options.tls;
      if (pair === undefined) throw new Error('the test asked for STARTTLS with no certificate');
      current.removeAllListeners('data');
      buffer = '';
      const secure = new TLSSocket(current, {
        isServer: true,
        secureContext: createSecureContext({ key: pair.key, cert: pair.cert }),
      });
      current = secure;
      bind(secure);
    },
    end(): void {
      current.end();
    },
  };
}

/** SMTP, enough of it to be refused at every interesting stage. */
export function smtpServer(options: MailServerOptions): Promise<RunningServer> {
  return serve((socket) => {
    let authenticated = options.requireAuth !== true;
    let inData = false;
    let body = '';
    let sender = '';
    let awaiting: 'none' | 'user' | 'password' = 'none';

    const greet = (): void => {
      if (options.refuseAt === 'greeting') socket.send('554 not accepting mail right now');
      else socket.send('220 sim.example.invalid ESMTP');
    };
    if (options.greetingDelayMs === undefined) greet();
    else setTimeout(greet, options.greetingDelayMs).unref();

    socket.onLine((line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          options.mailbox.deliver(body);
          socket.send('250 2.0.0 Ok: queued as SIM12345');
          return;
        }
        // Un-stuff, so a message whose own line began with a dot round-trips.
        body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        return;
      }
      if (awaiting === 'user') {
        awaiting = 'password';
        socket.send('334 UGFzc3dvcmQ6');
        return;
      }
      if (awaiting === 'password') {
        awaiting = 'none';
        authenticated = Buffer.from(line, 'base64').toString('utf8') === (options.password ?? '');
        socket.send(authenticated ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
        return;
      }

      const [verb = '', ...rest] = line.split(' ');
      const argument = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const lines = ['250-sim.example.invalid'];
          if (options.offerStartTls === true) lines.push('250-STARTTLS');
          if (options.username !== undefined) lines.push('250-AUTH PLAIN LOGIN');
          lines.push('250 SIZE 10485760');
          for (const one of lines) socket.send(one);
          return;
        }
        case 'HELO':
          socket.send('250 sim.example.invalid');
          return;
        case 'STARTTLS':
          if (options.offerStartTls !== true) {
            socket.send('502 5.5.1 not implemented');
            return;
          }
          socket.send('220 2.0.0 ready to start TLS');
          socket.upgrade();
          return;
        case 'AUTH': {
          const [mechanism = '', token = ''] = argument.split(' ');
          if (mechanism.toUpperCase() === 'PLAIN') {
            const parts = Buffer.from(token, 'base64').toString('utf8').split('\0');
            authenticated = parts[1] === options.username && parts[2] === options.password;
            socket.send(authenticated ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
            return;
          }
          awaiting = 'user';
          socket.send('334 VXNlcm5hbWU6');
          return;
        }
        case 'MAIL':
          if (!authenticated) {
            socket.send('530 5.7.0 authentication required');
            return;
          }
          if (options.refuseAt === 'mail-from') {
            socket.send('452 4.3.1 insufficient system storage');
            return;
          }
          sender = /<(.*)>/.exec(argument)?.[1] ?? '';
          socket.send('250 2.1.0 Ok');
          return;
        case 'RCPT':
          if (options.refuseAt === 'rcpt-to') {
            socket.send('550 5.1.1 no such user');
            return;
          }
          socket.send('250 2.1.5 Ok');
          return;
        case 'DATA':
          if (options.refuseAt === 'data') {
            socket.send('451 4.3.0 temporary failure');
            return;
          }
          inData = true;
          body = `X-Envelope-From: ${sender}\n`;
          socket.send('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'QUIT':
          socket.send(options.refuseAt === 'quit' ? '451 cannot close' : '221 2.0.0 Bye');
          socket.end();
          return;
        default:
          socket.send('500 5.5.2 unrecognised command');
      }
    });
  }, options);
}

/** POP3, including the part that matters: `DELE` only takes effect at `QUIT`. */
export function pop3Server(options: MailServerOptions): Promise<RunningServer> {
  return serve((socket) => {
    // A session's numbering is fixed when it opens — RFC 1939 — so this snapshot is the protocol,
    // not a shortcut.
    let session: Message[] = [];
    const marked = new Set<number>();
    let authenticated = false;

    socket.send('+OK sim POP3 ready');
    socket.onLine((line) => {
      const [verb = '', ...rest] = line.split(' ');
      const argument = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'STLS':
          if (options.offerStartTls !== true) {
            socket.send('-ERR not supported');
            return;
          }
          socket.send('+OK begin TLS');
          socket.upgrade();
          return;
        case 'USER':
          socket.send(argument === options.username ? '+OK' : '-ERR no such mailbox');
          return;
        case 'PASS':
          authenticated = argument === options.password;
          if (authenticated) session = options.mailbox.live;
          socket.send(authenticated ? '+OK mailbox ready' : '-ERR authentication failed');
          return;
        case 'STAT': {
          if (!authenticated) {
            socket.send('-ERR not authenticated');
            return;
          }
          const live = session.filter((_, at) => !marked.has(at + 1));
          const bytes = live.reduce((total, message) => total + message.raw.length, 0);
          socket.send(`+OK ${String(live.length)} ${String(bytes)}`);
          return;
        }
        case 'LIST':
          if (!authenticated) {
            socket.send('-ERR not authenticated');
            return;
          }
          socket.send('+OK scan listing follows');
          session.forEach((message, at) => {
            if (!marked.has(at + 1)) {
              socket.send(`${String(at + 1)} ${String(message.raw.length)}`);
            }
          });
          socket.send('.');
          return;
        case 'TOP': {
          const number = Number(argument.split(' ')[0]);
          const message = session[number - 1];
          if (message === undefined || marked.has(number)) {
            socket.send('-ERR no such message');
            return;
          }
          socket.send('+OK top of message follows');
          for (const header of message.raw.split('\n')) {
            if (header.trim() === '') break;
            socket.send(header);
          }
          socket.send('.');
          return;
        }
        case 'DELE': {
          const number = Number(argument);
          if (session[number - 1] === undefined) {
            socket.send('-ERR no such message');
            return;
          }
          marked.add(number);
          socket.send('+OK marked');
          return;
        }
        case 'QUIT':
          if (options.refuseAt === 'quit') {
            // Nothing is deleted. This is the case a sensor must notice: a cleanup that silently
            // did not happen fills a mailbox one message a minute.
            socket.send('-ERR could not update the mailbox');
            socket.end();
            return;
          }
          for (const number of marked) {
            const message = session[number - 1];
            if (message !== undefined) message.deleted = true;
          }
          socket.send('+OK signing off');
          socket.end();
          return;
        default:
          socket.send('-ERR unknown command');
      }
    });
  }, options);
}

/** IMAP4rev1, tagged, with the search and expunge a round trip needs. */
export function imapServer(options: MailServerOptions): Promise<RunningServer> {
  return serve((socket) => {
    let authenticated = false;
    let selected: Message[] = [];
    const flagged = new Set<number>();

    socket.send('* OK [CAPABILITY IMAP4rev1 STARTTLS] sim ready');
    socket.onLine((line) => {
      const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
      const tag = match?.[1] ?? '*';
      const verb = (match?.[2] ?? '').toUpperCase();
      const argument = match?.[3] ?? '';

      switch (verb) {
        case 'CAPABILITY':
          socket.send('* CAPABILITY IMAP4rev1');
          socket.send(`${tag} OK done`);
          return;
        case 'STARTTLS':
          if (options.offerStartTls !== true) {
            socket.send(`${tag} NO not supported`);
            return;
          }
          socket.send(`${tag} OK begin TLS`);
          socket.upgrade();
          return;
        case 'LOGIN': {
          const [user = '', password = ''] = [...argument.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
            (found) => (found[1] ?? '').replace(/\\(.)/g, '$1'),
          );
          authenticated = user === options.username && password === options.password;
          socket.send(authenticated ? `${tag} OK logged in` : `${tag} NO authentication failed`);
          return;
        }
        case 'STATUS': {
          if (!authenticated) {
            socket.send(`${tag} NO not authenticated`);
            return;
          }
          const live = options.mailbox.live;
          socket.send(
            `* STATUS "INBOX" (MESSAGES ${String(live.length)} RECENT ${String(live.length)} ` +
              `UNSEEN ${String(live.length)})`,
          );
          socket.send(`${tag} OK done`);
          return;
        }
        case 'SELECT':
          if (!authenticated) {
            socket.send(`${tag} NO not authenticated`);
            return;
          }
          selected = options.mailbox.live;
          flagged.clear();
          socket.send(`* ${String(selected.length)} EXISTS`);
          socket.send(`${tag} OK [READ-WRITE] selected`);
          return;
        case 'SEARCH': {
          const wanted = /HEADER\s+Subject\s+"([^"]*)"/i.exec(argument)?.[1] ?? '';
          const hits = selected
            .map((message, at) => ({ message, number: at + 1 }))
            .filter(({ message }) => message.subject.includes(wanted))
            .map(({ number }) => number);
          socket.send(`* SEARCH${hits.length === 0 ? '' : ` ${hits.join(' ')}`}`);
          socket.send(`${tag} OK done`);
          return;
        }
        case 'STORE': {
          for (const part of (argument.split(' ')[0] ?? '').split(',')) {
            const number = Number(part);
            if (Number.isFinite(number)) flagged.add(number);
          }
          socket.send(`${tag} OK stored`);
          return;
        }
        case 'EXPUNGE':
          if (options.refuseAt === 'quit') {
            socket.send(`${tag} NO the mailbox is read-only right now`);
            return;
          }
          for (const number of flagged) {
            const message = selected[number - 1];
            if (message !== undefined) message.deleted = true;
          }
          socket.send(`${tag} OK expunged`);
          return;
        case 'LOGOUT':
          socket.send('* BYE');
          socket.send(`${tag} OK logged out`);
          socket.end();
          return;
        default:
          socket.send(`${tag} BAD unknown command`);
      }
    });
  }, options);
}
