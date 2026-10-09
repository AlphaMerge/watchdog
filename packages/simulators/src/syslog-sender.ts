import { createSocket } from 'node:dgram';
import { connect, isIPv6, type Socket } from 'node:net';

/**
 * A syslog sender, over UDP and both of RFC 6587's TCP framings (`P-06`, for `T-20`).
 *
 * **It renders the messages by hand rather than calling `@ms/sensors`' `renderSyslog`**, and that
 * is the same rule `snmp-agent.ts` states at length: a harness that produces its input with the
 * code under test proves the parser can read what the renderer wrote, which is a closed loop that
 * passes whether or not either matches RFC 3164 or RFC 5424. The bytes here are written out
 * because the bytes are the thing being asserted.
 *
 * **Both TCP framings, because guessing wrong is not a parse error.** RFC 6587 offers
 * octet-counting (`123 <13>1 …`) and non-transparent framing (a trailing newline), and a receiver
 * that assumes the wrong one silently corrupts message boundaries — which gets blamed on the
 * sender for weeks. A sender that can do both is how the receiver's handling of each is tested.
 */

export type SyslogFormat = 'rfc3164' | 'rfc5424';

export interface SyslogMessageOptions {
  facility?: number;
  severity?: number;
  hostname?: string;
  tag?: string;
  message?: string;
  /** ISO-8601. Left out, the sender stamps the message itself. */
  timestamp?: Date;
  format?: SyslogFormat;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One message, as bytes on the wire. Exported so a test can assert on the frame itself. */
export function renderMessage(options: SyslogMessageOptions = {}): string {
  const facility = options.facility ?? 1;
  const severity = options.severity ?? 6;
  const priority = facility * 8 + severity;
  const at = options.timestamp ?? new Date();
  const host = options.hostname ?? 'simulator';
  const tag = options.tag ?? 'test';
  const text = options.message ?? 'a message';

  if ((options.format ?? 'rfc5424') === 'rfc5424') {
    return `<${String(priority)}>1 ${at.toISOString()} ${host} ${tag} - - - ${text}`;
  }
  // RFC 3164's timestamp is `Mmm dd hh:mm:ss` with the day space-padded, which is the detail a
  // parser written against 5424 alone gets wrong: two spaces before a single-digit day.
  const day = String(at.getUTCDate()).padStart(2, ' ');
  const clock = [at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  const month = MONTHS[at.getUTCMonth()] ?? 'Jan';
  return `<${String(priority)}>${month} ${day} ${clock} ${host} ${tag}: ${text}`;
}

/**
 * Sends one datagram per message and returns once they are all handed to the socket.
 *
 * From an IPv6 socket when `host` is an IPv6 address, so a test can be a sender of either family.
 *
 * **`trailer`, for a test that has to know the sender is done** (`P-378`). UDP has no end of
 * stream, so a collector cannot tell the last datagram from a gap before the next. A trailer is
 * sent as it is, not rendered, after every message and from the same socket, once the last
 * message's send has called back. The test leans on the loopback delivering one socket's
 * datagrams to one address in the order they were sent: then a collector that has read the
 * trailer has read everything before it, an excess datagram included. A trailer sent from a
 * socket of the test's own would be a second sender, which Linux does not order against the
 * first: their datagrams can sit in different CPUs' backlogs.
 */
export async function sendUdp(
  port: number,
  messages: readonly SyslogMessageOptions[],
  host = '127.0.0.1',
  options: { trailer?: string } = {},
): Promise<void> {
  const socket = createSocket(isIPv6(host) ? 'udp6' : 'udp4');
  const send = (payload: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      socket.send(payload, port, host, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  try {
    for (const message of messages) {
      await send(Buffer.from(renderMessage(message), 'utf8'));
    }
    if (options.trailer !== undefined) await send(Buffer.from(options.trailer, 'utf8'));
  } finally {
    socket.close();
  }
}

export type TcpFraming = 'octet-counting' | 'non-transparent';

/**
 * Sends messages over one TCP connection in the chosen framing.
 *
 * **One connection for all of them on purpose.** A receiver that handles each message correctly
 * and loses the boundary between two is the failure this exists to catch, and it is unreachable
 * if every message arrives in a connection of its own.
 */
export async function sendTcp(
  port: number,
  messages: readonly SyslogMessageOptions[],
  options: {
    framing?: TcpFraming;
    host?: string;
    /** Byte offset to break the send at. See the note by the write below. */
    splitAt?: number;
    /** How long to wait between the two halves of a split. */
    splitDelayMs?: number;
  } = {},
): Promise<void> {
  const framing = options.framing ?? 'octet-counting';
  const frames = messages.map((message) => {
    const rendered = renderMessage(message);
    if (framing === 'non-transparent') return `${rendered}\n`;
    return `${String(Buffer.byteLength(rendered, 'utf8'))} ${rendered}`;
  });
  const payload = Buffer.from(frames.join(''), 'utf8');

  const socket: Socket = connect({ port, host: options.host ?? '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      resolve();
    });
  });

  try {
    // **A deliberate split mid-frame.** TCP is a stream, so a receiver that assumes one `data`
    // event is one message works perfectly until the day the network disagrees. `splitAt` makes
    // that day reproducible.
    //
    // **The pause between the halves is not decoration.** Two writes with nothing between them
    // are coalesced into one segment and arrive as one `data` event, so the split would exist
    // only on the sending side and the receiver would never be tested. Waiting forces the first
    // half out on its own, which is the case that breaks naive buffering.
    if (options.splitAt !== undefined && options.splitAt > 0 && options.splitAt < payload.length) {
      socket.setNoDelay(true);
      await write(socket, payload.subarray(0, options.splitAt));
      await sleep(options.splitDelayMs ?? 20);
      await write(socket, payload.subarray(options.splitAt));
    } else {
      await write(socket, payload);
    }
  } finally {
    await new Promise<void>((resolve) => {
      socket.end(() => {
        resolve();
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(socket: Socket, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(chunk, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}
