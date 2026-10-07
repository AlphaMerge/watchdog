import type { ReceivedBatch, ReceivedNotification } from '@ms/sensors';
import type {
  FlowMessage,
  FlowReceiver,
  FlowReceiverOptions,
  ReceivedFlow,
} from '@ms/sensors/flow';
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

/**
 * How many exporter sequences are followed at once (`B-10`).
 *
 * A sequence is an address, a dialect and a source id, observation domain, sub-agent or v5
 * engine, and the last of those is whatever the datagram says. Far above any real site — a thousand exporters
 * with four domains each — and small enough that a device inventing one per datagram costs a
 * fixed few hundred kilobytes rather than the probe.
 */
export const MAX_SEQUENCES = 4_096;

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
  /**
   * The monotonic clock, in milliseconds, that the buffer measures a resuming sensor's window on
   * (`P-254`). Defaults to `performance.now`; injectable so a test can step the wall clock alone.
   */
  readonly monotonic?: () => number;
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
  /**
   * Records whose template this collector has not learnt yet (`B-03`).
   *
   * Ordinary for a few seconds after a restart and expected to fall to zero. It stays above zero
   * when an exporter's template refresh interval is longer than its data interval, which is a
   * fault on the device and invisible without this.
   */
  readonly undecodable: number;
  readonly buffered: number;
  readonly cursors: number;
  /** Every record the buffer gave up for a newer one, read or not. Ordinary on a full buffer. */
  readonly overwritten: number;
  /**
   * Records the buffer overwrote before a sensor that was following it had read them (`B-11`).
   *
   * The collector's backpressure: these were received and counted, and lost to `bufferSize`. Each
   * also fails the scan of the sensor that was behind, with the number. Since the collector
   * started, like every counter here.
   */
  readonly overwrittenUnread: number;
}

export class FlowListener {
  readonly #logger: Logger;
  readonly #options: FlowListenerOptions;
  readonly #now: () => Date;
  readonly #ring: NotificationRing;
  /**
   * Per sequence an exporter keeps, the number its next datagram should carry.
   *
   * Bounded (`B-10`): part of the key is read out of the datagram, so a device walking through
   * observation domains would otherwise grow this for as long as it sent.
   */
  readonly #expected = new Map<string, number>();
  #receiver: FlowReceiver | undefined;
  #received = 0;
  #rejected = 0;
  #malformed = 0;
  #missed = 0;
  #undecodable = 0;

  constructor(options: FlowListenerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'flow-listener' });
    this.#now = options.now ?? ((): Date => new Date());
    this.#ring = new NotificationRing(options.bufferSize, this.#now, options.monotonic);
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

  /**
   * Everything this sensor has not seen, and how much it missed. See `NotificationRing`.
   *
   * `windowMs` is the sensor's interval: how far back its first scan after a restart reads.
   */
  drain(sensorId: number, windowMs?: number): ReceivedBatch {
    return this.#ring.drain(sensorId, LISTENER_ID, windowMs);
  }

  retain(sensorIds: Iterable<number>, complete?: boolean): void {
    this.#ring.retain(sensorIds, complete);
  }

  stats(): FlowListenerStats {
    return {
      running: this.running,
      received: this.#received,
      rejected: this.#rejected,
      malformed: this.#malformed,
      missed: this.#missed,
      undecodable: this.#undecodable,
      buffered: this.#ring.buffered,
      cursors: this.#ring.cursors,
      overwritten: this.#ring.overwritten,
      overwrittenUnread: this.#ring.unread,
    };
  }

  #accept(received: ReceivedFlow): void {
    const allowed = this.#options.exporters;
    if (allowed.length > 0 && !allowed.includes(received.source)) {
      // Counted rather than logged per datagram: a misconfigured exporter sends for ever.
      this.#rejected += 1;
      return;
    }

    const { records, sequence, dialect, sysUptimeMs, unixSecs, undecodable } = received.message;
    this.#countSequenceGap(received.source, received.message);
    this.#undecodable += undecodable;

    const at = this.#now().toISOString();
    for (const record of records) {
      this.#received += 1;
      const notification: ReceivedNotification = {
        // The probe's clock, not the exporter's. An exporter whose NTP has failed would otherwise
        // put its flows outside every window a sensor looks at; its own stamps are kept in
        // `detail` for anyone who wants them.
        at,
        source: received.source,
        text:
          `${record.srcAddr}:${String(record.srcPort)} -> ${record.dstAddr}:${String(record.dstPort)} ` +
          `proto ${String(record.protocol)} ${String(record.packets)}pkt ${String(record.octets)}B`,
        detail: {
          srcAddr: record.srcAddr,
          dstAddr: record.dstAddr,
          srcPort: record.srcPort,
          dstPort: record.dstPort,
          protocol: record.protocol,
          packets: record.packets,
          octets: record.octets,
          inputIf: record.inputIf,
          outputIf: record.outputIf,
          // **What one sampled packet stands for.** A sensor that summed `octets` without it
          // would under-report a sampled exporter by whatever N is, silently.
          samplingRate: record.samplingRate,
          dialect,
          ...(record.nextHop === undefined ? {} : { nextHop: record.nextHop }),
          ...(record.tos === undefined ? {} : { tos: record.tos }),
          ...(record.tcpFlags === undefined ? {} : { tcpFlags: record.tcpFlags }),
          ...(record.srcAs === undefined ? {} : { srcAs: record.srcAs }),
          ...(record.dstAs === undefined ? {} : { dstAs: record.dstAs }),
          ...(record.srcMask === undefined ? {} : { srcMask: record.srcMask }),
          ...(record.dstMask === undefined ? {} : { dstMask: record.dstMask }),
          ...(sysUptimeMs === undefined ? {} : { sysUptimeMs }),
          ...(unixSecs === undefined ? {} : { unixSecs }),
          flowSequence: sequence,
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
   * **And per dialect, and per whatever the dialect counts within** (`B-10`). One device can
   * export NetFlow v9 and sFlow to one collector, and both count packets, so "what the sequence
   * counts" does not tell them apart: read against each other, every datagram of the one further
   * on is a loss and every datagram of the other a restart. Within a dialect, v9 counts per
   * source id, IPFIX per observation domain, sFlow per sub-agent of an agent and v5 per engine
   * type and id (`B-13`), which the decoder hands over as `sequenceScope`.
   *
   * A sequence that goes *backwards* is a reboot rather than a loss: the exporter restarted and
   * began again, and counting the difference would report billions of missing flows. Resynced
   * silently, because it is not an error and the operator's evidence of a reboot is `sysUptime`.
   */
  #countSequenceGap(source: string, message: FlowMessage): void {
    const { sequence, records, sequenceCounts, dialect, sequenceScope } = message;
    // **What the sequence advances by is not the same in every dialect** (`B-03`): v5 counts
    // exported flows, IPFIX counts data records, and v9 and sFlow count *packets* — one per
    // datagram. A single arithmetic for all of them reports a healthy v9 exporter as losing every
    // flow but one.
    const advance = sequenceCounts === 'packets' ? 1 : records.length;
    const key = `${source}|${dialect}|${sequenceScope ?? ''}`;
    const expected = this.#expected.get(key);
    if (expected !== undefined && sequence > expected) this.#missed += sequence - expected;
    // Deleted and set again, so the map's own order is least recently heard first.
    this.#expected.delete(key);
    this.#expected.set(key, (sequence + advance) >>> 0);
    if (this.#expected.size > MAX_SEQUENCES) {
      // The longest silent one is forgotten. It costs that sequence one comparison if it speaks
      // again — its next datagram is taken as a first — and never invents a loss.
      const [oldest] = this.#expected.keys();
      if (oldest !== undefined) this.#expected.delete(oldest);
    }
  }
}
