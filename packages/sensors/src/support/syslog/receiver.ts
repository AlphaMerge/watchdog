import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server, type Socket as TcpSocket } from 'node:net';
import { parseSyslog, MAX_LINE, type SyslogMessage } from './parse.js';

/**
 * The sockets a syslog receiver listens on (`T-20`).
 *
 * **UDP and TCP at once, because a network has both.** UDP is what RFC 3164 devices send and what
 * everything defaults to; TCP is what anything that cares about not losing messages uses, and it
 * is not optional in practice — a firewall exporting an audit trail over UDP is a firewall whose
 * audit trail has holes in it.
 *
 * **TCP syslog has two framings and they are not compatible.** RFC 6587 §3.4.1 is
 * *octet-counting* — a decimal length, a space, then exactly that many bytes — and §3.4.2 is
 * *non-transparent framing*, which is "lines separated by newlines and good luck". Both are in
 * the wild, so both are read, told apart by whether the first byte of a frame is a digit. Guessing
 * wrong on octet-counting turns one message into several with the count glued to the front of the
 * first, which is the kind of corruption that gets blamed on the sender for weeks.
 *
 * **A per-connection buffer is bounded.** A sender that opens a connection and streams a gigabyte
 * without a newline must not be a probe that runs out of memory: past the bound the connection is
 * closed and counted, because the alternative is losing every *other* device's messages too.
 */

export interface ReceivedSyslog {
  /** The sender's address. Never resolved — a reverse lookup per message is a flood. */
  readonly source: string;
  readonly transport: 'udp' | 'tcp';
  readonly message: SyslogMessage;
}

export interface SyslogReceiverOptions {
  readonly port: number;
  readonly address: string;
  readonly udp: boolean;
  readonly tcp: boolean;
  readonly ipVersion: 'udp4' | 'udp6';
  readonly onMessage: (received: ReceivedSyslog) => void;
  readonly onMalformed: (reason: string) => void;
  /** Bytes one TCP connection may buffer without completing a frame. */
  readonly maxFrameBytes?: number;
}

export interface SyslogReceiver {
  close(): Promise<void>;
}

const DEFAULT_MAX_FRAME = MAX_LINE;

/**
 * Why a socket handler threw, for `onMalformed` (`P-217`).
 *
 * These handlers are the last frame before the process: `dgram` and `net` call them from their
 * own event loops, so anything that escapes one is an `uncaughtException` and the probe goes down
 * with every check it was running. Nothing in parsing throws today, and the flow receiver already
 * holds the same line; this is so that the day something does, it costs one message.
 */
function thrown(error: unknown): string {
  return `handling a message threw: ${error instanceof Error ? error.message : String(error)}`;
}

export async function openSyslogReceiver(options: SyslogReceiverOptions): Promise<SyslogReceiver> {
  const maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME;
  let udp: UdpSocket | undefined;
  let tcp: Server | undefined;
  const connections = new Set<TcpSocket>();

  if (options.udp) {
    const socket = createSocket({ type: options.ipVersion, reuseAddr: true });
    socket.on('message', (datagram, sender) => {
      // One datagram is one message. That is the whole of UDP framing, and it is why UDP syslog
      // silently truncates anything past the MTU — which is the sender's problem and not ours.
      try {
        const text = datagram.toString('utf8');
        if (text.trim() === '') {
          options.onMalformed('an empty datagram');
          return;
        }
        options.onMessage({
          source: sender.address,
          transport: 'udp',
          message: parseSyslog(text),
        });
      } catch (error: unknown) {
        options.onMalformed(thrown(error));
      }
    });
    socket.on('error', (error: Error) => {
      options.onMalformed(`the UDP socket failed: ${error.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(options.port, options.address, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    udp = socket;
  }

  if (options.tcp) {
    const server = createServer((connection) => {
      connections.add(connection);
      connection.setNoDelay(true);
      const source = connection.remoteAddress ?? 'unknown';
      let buffer = '';

      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > maxFrame) {
          // Closing loses this sender's stream; not closing loses every other sender's, because
          // the probe runs out of memory. Counted either way.
          options.onMalformed(
            `${source} sent more than ${String(maxFrame)} bytes without completing a frame`,
          );
          buffer = '';
          connection.destroy();
          return;
        }
        try {
          buffer = drain(buffer, source, options);
        } catch (error: unknown) {
          // Part of the buffer may have been delivered and part not, so where the next frame
          // starts is unknown: this sender's stream ends, and every other sender's carries on.
          options.onMalformed(thrown(error));
          buffer = '';
          connection.destroy();
        }
      });
      connection.on('error', () => {
        // A sender that disappears mid-stream is ordinary, not a fault worth a log line each.
        connection.destroy();
      });
      connection.on('close', () => {
        connections.delete(connection);
        // Whatever is left with no trailing newline is still a message: a device that closes its
        // connection after writing one line without a newline is common enough to matter.
        const last = buffer.trim();
        if (last !== '') {
          try {
            options.onMessage({ source, transport: 'tcp', message: parseSyslog(last) });
          } catch (error: unknown) {
            options.onMalformed(thrown(error));
          }
        }
      });
    });
    server.on('error', (error: Error) => {
      options.onMalformed(`the TCP listener failed: ${error.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    tcp = server;
  }

  return {
    async close(): Promise<void> {
      for (const connection of connections) connection.destroy();
      connections.clear();
      const closing = udp;
      if (closing !== undefined) {
        await new Promise<void>((resolve) => {
          closing.close(() => {
            resolve();
          });
        });
      }
      const listener = tcp;
      if (listener !== undefined) {
        await new Promise<void>((resolve) => {
          listener.close(() => {
            resolve();
          });
        });
      }
    },
  };
}

/**
 * Takes whole frames out of a TCP buffer, in whichever of RFC 6587's two framings this is.
 *
 * Returns what is left. Exported for its own tests: framing is where a receiver quietly corrupts
 * messages, and a test that only ever sends one complete line at a time would never find it.
 */
export function drain(
  buffer: string,
  source: string,
  options: Pick<SyslogReceiverOptions, 'onMessage' | 'onMalformed'>,
): string {
  let rest = buffer;
  for (;;) {
    const trimmed = rest.replace(/^[\r\n]+/, '');
    if (trimmed === '') return '';

    // §3.4.1, octet-counting: `<length> <message>`. A frame beginning with a digit is this one,
    // because a syslog message beginning with a digit would have to have no priority at all.
    const counted = /^(\d{1,7}) /.exec(trimmed);
    if (counted !== null) {
      const length = Number(counted[1]);
      const start = counted[0].length;
      if (trimmed.length < start + length) return trimmed;
      const frame = trimmed.slice(start, start + length);
      options.onMessage({ source, transport: 'tcp', message: parseSyslog(frame) });
      rest = trimmed.slice(start + length);
      continue;
    }

    // §3.4.2, non-transparent framing: whatever is up to the next newline.
    const newline = trimmed.indexOf('\n');
    if (newline < 0) return trimmed;
    const line = trimmed.slice(0, newline).replace(/\r$/, '');
    if (line.trim() !== '') {
      options.onMessage({ source, transport: 'tcp', message: parseSyslog(line) });
    }
    rest = trimmed.slice(newline + 1);
  }
}
