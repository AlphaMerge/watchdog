import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { FlowDecodeError, decodeNetflowV5, type NetflowV5Datagram } from './netflow5.js';

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
 */

export interface ReceivedFlow {
  /** The exporter's address. Never resolved — a reverse lookup per datagram is a second flood. */
  readonly source: string;
  readonly datagram: NetflowV5Datagram;
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
}

export interface FlowReceiver {
  close(): Promise<void>;
}

export async function openFlowReceiver(options: FlowReceiverOptions): Promise<FlowReceiver> {
  const socket: UdpSocket = createSocket({ type: options.ipVersion, reuseAddr: true });

  socket.on('message', (datagram, sender) => {
    try {
      options.onFlow({ source: sender.address, datagram: decodeNetflowV5(datagram) });
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
  };
}
