import type { ReceivedBatch, ReceivedNotification } from '@ms/sensors';
import type { FlowReceiver, FlowReceiverOptions, ReceivedFlow } from '@ms/sensors/flow';
import type { Logger } from '@ms/shared';
import { NotificationRing } from './ring.js';

/**
 * The probe's flow listener (`B-02`).
 *
 * **The syslog listener with a different socket in front of it**, which is what `T-06`'s contract
 * was for and what `T-20` already proved transfers: one socket for the whole probe, a ring buffer,
 * a cursor per sensor, and nothing here that decides anything. Filtering, per-protocol counting
 * and channel assignment are the sensor's parameters and arrive with `B-04`, testable against a
 * fabricated batch with no socket in sight.
 *
 * **The exporter allow-list is a filter, not a lock.** NetFlow authenticates nothing whatsoever —
 * a UDP datagram claiming any source can be sent by anything that can reach the port — so this
 * stops a *misconfigured* exporter filling the buffer and stops nothing else. Saying so is the
 * point: an operator who believed it was access control would put this on a reachable port.
 *
 * **One notification per flow record, not per datagram.** A datagram is a transport detail that
 * holds one to thirty flows depending on how busy the exporter was; a sensor counting traffic
 * wants flows. Buffering by datagram would make the ring's capacity mean thirty different things
 * and make a drop count uninterpretable.
 *
 * **Nothing is resolved.** The source is an address, never a hostname: a reverse lookup per flow
 * during a traffic spike is a second flood, this one against the resolver.
 */

export const LISTENER_ID = 'flow';

export interface FlowListenerOptions {
  readonly logger: Logger;
  readonly port: number;
  readonly address: string;
  readonly ipVersion: 'udp4' | 'udp6';
  /**
   * Exporter addresses whose flows are kept. Empty accepts any.
   *
   * A filter and not a lock — NetFlow authenticates nothing — and the paragraph above is what an
   * operator needs to have read before relying on it.
   */
  readonly exporters: readonly string[];
  readonly bufferSize: number;
  readonly now?: () => Date;
  /** Injectable, so the ring, the cursors and the counters are testable without a port. */
  readonly open?: (options: FlowReceiverOptions) => FlowReceiver | Promise<FlowReceiver>;
}

export interface FlowListenerStats {
  readonly running: boolean;
  /** Flow records accepted, not datagrams — see the note on the class. */
  readonly received: number;
  /** Datagrams turned away because their exporter is not in the accept list. */
  readonly rejected: number;
  readonly malformed: number;
  /**
   * Flows the exporter says it sent that never arrived, from gaps in `flowSequence`.
   *
   * The only way to see UDP loss at all: the transport drops silently, so the exporter's own
   * running count is the sole evidence. Counted per exporter and summed, because two exporters
   * have unrelated sequences and comparing across them would invent losses that never happened.
   */
  readonly missed: number;
  readonly buffered: number;
  readonly cursors: number;
  readonly overwritten: number;
}

export class FlowListener {
  readonly #logger: Logger;
  readonly #options: FlowListenerOptions;
  readonly #now: () => Date;
  readonly #ring: NotificationRing;
  /** Per exporter, the sequence number the next datagram should carry. */
  readonly #expected = new Map<string, number>();
  #receiver: FlowReceiver | undefined;
  #received = 0;
  #rejected = 0;
  #malformed = 0;
  #missed = 0;

  constructor(options: FlowListenerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'flow-listener' });
    this.#now = options.now ?? ((): Date => new Date());
    this.#ring = new NotificationRing(options.bufferSize, this.#now);
  }

  get running(): boolean {
    return this.#receiver !== undefined;
  }

  async start(): Promise<void> {
    if (this.#receiver !== undefined) return;

    // Imported here rather than at the top: a probe with the listener off never loads the socket,
    // and an injected opener never loads it at all.
    const open = this.#options.open ?? (await import('@ms/sensors/flow')).openFlowReceiver;
    this.#receiver = await open({
      port: this.#options.port,
      address: this.#options.address,
      ipVersion: this.#options.ipVersion,
      onFlow: (received) => {
        this.#accept(received);
      },
      onMalformed: (message, reason) => {
        this.#malformed += 1;
        // The first few and then every thousandth: one line per bad datagram is how a disk fills
        // up during an incident, and the count reaches Probe Health either way.
        if (this.#malformed <= 5 || this.#malformed % 1_000 === 0) {
          this.#logger.warn(
            { reason: reason?.kind ?? 'unknown', message, malformed: this.#malformed },
            'discarded a flow datagram',
          );
        }
      },
    });

    this.#logger.info(
      {
        port: this.#options.port,
        address: this.#options.address,
        exporters: this.#options.exporters.length,
        bufferSize: this.#options.bufferSize,
      },
      'flow listener started',
    );
  }

  async stop(): Promise<void> {
    const receiver = this.#receiver;
    this.#receiver = undefined;
    if (receiver === undefined) return;
    await receiver.close();
    this.#logger.info({ ...this.stats() }, 'flow listener stopped');
  }

  /** Everything this sensor has not seen, and how much it missed. See `NotificationRing`. */
  drain(sensorId: number): ReceivedBatch {
    return this.#ring.drain(sensorId, LISTENER_ID);
  }

  retain(sensorIds: Iterable<number>): void {
    this.#ring.retain(sensorIds);
  }

  stats(): FlowListenerStats {
    return {
      running: this.running,
      received: this.#received,
      rejected: this.#rejected,
      malformed: this.#malformed,
      missed: this.#missed,
      buffered: this.#ring.buffered,
      cursors: this.#ring.cursors,
      overwritten: this.#ring.overwritten,
    };
  }

  #accept(received: ReceivedFlow): void {
    const allowed = this.#options.exporters;
    if (allowed.length > 0 && !allowed.includes(received.source)) {
      // Counted rather than logged per datagram: a misconfigured exporter sends for ever.
      this.#rejected += 1;
      return;
    }

    const { header, records } = received.datagram;
    this.#countSequenceGap(received.source, header.flowSequence, header.count);

    const at = this.#now().toISOString();
    for (const record of records) {
      this.#received += 1;
      const notification: ReceivedNotification = {
        // The probe's clock, not the exporter's. An exporter whose NTP has failed would otherwise
        // put its flows outside every window a sensor looks at; its own stamps are kept in
        // `detail` for anyone who wants them, and `flowWindow` is how they are read.
        at,
        source: received.source,
        text:
          `${record.srcAddr}:${String(record.srcPort)} -> ${record.dstAddr}:${String(record.dstPort)} ` +
          `proto ${String(record.protocol)} ${String(record.packets)}pkt ${String(record.octets)}B`,
        detail: {
          srcAddr: record.srcAddr,
          dstAddr: record.dstAddr,
          nextHop: record.nextHop,
          inputIf: record.inputIf,
          outputIf: record.outputIf,
          packets: record.packets,
          octets: record.octets,
          firstMs: record.firstMs,
          lastMs: record.lastMs,
          srcPort: record.srcPort,
          dstPort: record.dstPort,
          tcpFlags: record.tcpFlags,
          protocol: record.protocol,
          tos: record.tos,
          srcAs: record.srcAs,
          dstAs: record.dstAs,
          srcMask: record.srcMask,
          dstMask: record.dstMask,
          // The header half, carried per record so a sensor reading one notification can do the
          // uptime-to-wall-clock arithmetic without holding the datagram it came from.
          sysUptimeMs: header.sysUptimeMs,
          unixSecs: header.unixSecs,
          unixNsecs: header.unixNsecs,
          flowSequence: header.flowSequence,
          engineType: header.engineType,
          engineId: header.engineId,
          samplingMode: header.samplingMode,
          samplingInterval: header.samplingInterval,
        },
      };
      this.#ring.push(notification);
    }
  }

  /**
   * Flows exported but never received, from the exporter's own running count.
   *
   * **Per exporter, because sequences are per exporter.** Two devices sending to one collector
   * have unrelated counters, and a single shared "expected next" would report a loss on every
   * alternate datagram — a number that looks like a failing network and is arithmetic.
   *
   * A sequence that goes *backwards* is a reboot rather than a loss: the exporter restarted and
   * began again, and counting the difference would report billions of missing flows. Resynced
   * silently, because it is not an error and the operator's evidence of a reboot is `sysUptime`.
   */
  #countSequenceGap(source: string, sequence: number, count: number): void {
    const expected = this.#expected.get(source);
    if (expected !== undefined && sequence > expected) this.#missed += sequence - expected;
    this.#expected.set(source, (sequence + count) >>> 0);
  }
}
