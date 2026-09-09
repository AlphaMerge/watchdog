import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { FlowDecodeError, NETFLOW_V5, decodeNetflowV5 } from './netflow5.js';
import { IPFIX, NETFLOW_V9, decodeFlowSets } from './netflow9.js';
import { fromFlowSets, fromNetflowV5, type FlowMessage } from './record.js';
import { SFLOW_V5, decodeSflow } from './sflow.js';
import { TemplateCache, type TemplateCacheOptions } from './templates.js';

/**
 * The socket a flow collector listens on (`B-02`).
 *
 * **UDP and nothing else, unlike syslog.** `T-20` reads both transports because syslog has both
 * and a firewall exporting its audit trail over UDP has holes in it. Flow does not: NetFlow v5,
 * v9 and IPFIX over UDP are what exporters emit, IPFIX-over-TCP and -SCTP exist on paper and on
 * essentially no switch, and a collector that offered TCP would be advertising something nothing
 * sends. If a device that speaks it ever turns up, that is a ticket and not a guess made now.
 *
 * **One datagram is one export, which is the whole of the framing.** There is no length prefix
 * and no continuation: the exporter fits what it can into an MTU and sends it, which is why
 * `decodeNetflowV5` treats the header's record count as a claim to be checked rather than a
 * length to be trusted.
 *
 * **A decode failure is a counted event, never a throw across the socket.** A single misconfigured
 * exporter sends for ever, and an exception escaping a `message` handler takes the probe with it.
 *
 * **It dispatches on the version, which `B-03` shipped a decoder for and nothing called.** The
 * templated dialects were correct, tested and unreachable — `P-61` again — because this handler
 * decoded v5 and refused everything else. Every dialect now arrives as one normalised
 * `FlowMessage` (`B-06`), so nothing above here knows which format it came in.
 *
 * **The template cache lives on the receiver, not on a message.** v9 and IPFIX are stateful across
 * datagrams by design; a cache built per datagram would learn a template and forget it before the
 * data set three bytes later could use it.
 */

export interface ReceivedFlow {
  /** The exporter's address. Never resolved — a reverse lookup per datagram is a second flood. */
  readonly source: string;
  readonly message: FlowMessage;
}

export interface FlowReceiverOptions {
  readonly port: number;
  readonly address: string;
  readonly ipVersion: 'udp4' | 'udp6';
  readonly onFlow: (received: ReceivedFlow) => void;
  /**
   * Why a datagram was discarded.
   *
   * `reason` is the decoder's discriminated failure where there was one, so a caller can count
   * "this exporter is set to v9" apart from "this is not NetFlow at all" (`B-01`).
   */
  readonly onMalformed: (message: string, reason?: FlowDecodeError['reason']) => void;
  /** Bounds and expiry for the templates v9 and IPFIX carry out of band. */
  readonly templates?: TemplateCacheOptions;
}

export interface FlowReceiver {
  close(): Promise<void>;
  /** The templates learnt so far, for Probe Health and for a test. */
  templates(): { held: number; redefined: number; expired: number; evicted: number };
}

/**
 * Reads one datagram, whichever dialect it is.
 *
 * Exported so the dispatch is testable without a socket — it is the part with a decision in it,
 * and the socket around it has none.
 */
export function decodeFlowDatagram(
  datagram: Buffer,
  exporter: string,
  cache: TemplateCache,
): FlowMessage {
  if (datagram.length < 2) {
    throw new FlowDecodeError(
      { kind: 'too-short', got: datagram.length, need: 2 },
      `a flow datagram of ${String(datagram.length)} bytes cannot hold a version`,
    );
  }

  // **sFlow and NetFlow both call themselves version 5, and they are told apart by width.**
  // NetFlow's version is a 16-bit word, so a v5 datagram starts 00 05; sFlow's is 32-bit, so an
  // sFlow v5 datagram starts 00 00 00 05. Reading the first two bytes therefore gives 5 for
  // NetFlow and 0 for sFlow, which is the discriminator — and it is worth stating, because a
  // collector that guessed on port number alone would decode one as the other on any site that
  // sends both to 2055.
  const version = datagram.readUInt16BE(0);
  if (version === NETFLOW_V5) return fromNetflowV5(decodeNetflowV5(datagram));
  if (version === NETFLOW_V9 || version === IPFIX) {
    return fromFlowSets(decodeFlowSets(datagram, exporter, cache));
  }
  if (version === 0 && datagram.length >= 4 && datagram.readUInt32BE(0) === SFLOW_V5) {
    return decodeSflow(datagram);
  }
  throw new FlowDecodeError(
    { kind: 'unsupported-version', version },
    `flow version ${String(version)} is not one this collector reads ` +
      '(NetFlow 5, 9 or 10, or sFlow 5)',
  );
}

export async function openFlowReceiver(options: FlowReceiverOptions): Promise<FlowReceiver> {
  const socket: UdpSocket = createSocket({ type: options.ipVersion, reuseAddr: true });
  const cache = new TemplateCache(options.templates ?? {});

  socket.on('message', (datagram, sender) => {
    try {
      options.onFlow({
        source: sender.address,
        message: decodeFlowDatagram(datagram, sender.address, cache),
      });
    } catch (error) {
      if (error instanceof FlowDecodeError) {
        options.onMalformed(error.message, error.reason);
        return;
      }
      // Anything else is a defect in the decoder rather than a bad datagram, and it still must
      // not escape: the socket handler is the last frame before the process.
      options.onMalformed(error instanceof Error ? error.message : String(error));
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

  return {
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => {
          resolve();
        });
      }),
    templates: () => cache.stats(),
  };
}
