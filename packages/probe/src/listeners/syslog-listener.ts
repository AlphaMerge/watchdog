import { renderSyslog, type ReceivedBatch, type ReceivedNotification } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import type { ReceivedSyslog, SyslogReceiver, SyslogReceiverOptions } from '@ms/sensors/syslog';
import { NotificationRing } from './ring.js';

/**
 * The probe's syslog listener (`T-20`).
 *
 * **The trap listener with a different socket in front of it**, which is exactly what `T-06`'s
 * contract was for: one socket for the whole probe, a ring buffer, a cursor per sensor, and
 * nothing here that decides anything. Filter rules, severity counting and retention are the
 * sensor's parameters and live in `@ms/sensors`, testable against a fabricated batch with no
 * socket in sight.
 *
 * **The sender allow-list is a filter, not a lock**, the same as the trap listener's community
 * check. Syslog has no authentication whatsoever — anything that can reach the port can claim to
 * be anything — so this stops a *misconfigured* device filling the buffer and stops nothing else.
 * Saying so is the point: an operator who believed it was access control would deploy this on a
 * port reachable from the internet.
 *
 * **Nothing is resolved.** The source is an address, never a hostname, because a reverse lookup
 * per message during a flood is a second flood — this one against the resolver.
 */

export const LISTENER_ID = 'syslog';

export interface SyslogListenerOptions {
  readonly logger: Logger;
  readonly port: number;
  readonly address: string;
  readonly udp: boolean;
  readonly tcp: boolean;
  readonly ipVersion: 'udp4' | 'udp6';
  /**
   * Addresses whose messages are kept. Empty accepts any.
   *
   * A filter and not a lock — syslog authenticates nothing — and the description above is what
   * an operator needs to have read before relying on it.
   */
  readonly senders: readonly string[];
  readonly bufferSize: number;
  readonly now?: () => Date;
  /** Injectable, so the ring, the cursors and the counters are testable without a port. */
  readonly open?: (options: SyslogReceiverOptions) => SyslogReceiver | Promise<SyslogReceiver>;
}

export interface SyslogListenerStats {
  readonly running: boolean;
  readonly received: number;
  /** Turned away because their sender is not in the accept list. */
  readonly rejected: number;
  readonly malformed: number;
  readonly buffered: number;
  readonly cursors: number;
  readonly overwritten: number;
}

export class SyslogListener {
  readonly #logger: Logger;
  readonly #options: SyslogListenerOptions;
  readonly #now: () => Date;
  readonly #ring: NotificationRing;
  #receiver: SyslogReceiver | undefined;
  #received = 0;
  #rejected = 0;
  #malformed = 0;

  constructor(options: SyslogListenerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'syslog-listener' });
    this.#now = options.now ?? ((): Date => new Date());
    this.#ring = new NotificationRing(options.bufferSize, this.#now);
  }

  get running(): boolean {
    return this.#receiver !== undefined;
  }

  async start(): Promise<void> {
    if (this.#receiver !== undefined) return;

    // Imported here rather than at the top: a probe with the listener off never loads the
    // sockets, and an injected opener never loads them at all.
    const open = this.#options.open ?? (await import('@ms/sensors/syslog')).openSyslogReceiver;
    this.#receiver = await open({
      port: this.#options.port,
      address: this.#options.address,
      udp: this.#options.udp,
      tcp: this.#options.tcp,
      ipVersion: this.#options.ipVersion,
      onMessage: (received) => {
        this.#accept(received);
      },
      onMalformed: (reason) => {
        this.#malformed += 1;
        // Logged for the first few and then every thousandth: one line per bad packet is how a
        // disk fills up during an incident, and the count is on Probe Health either way.
        if (this.#malformed <= 5 || this.#malformed % 1_000 === 0) {
          this.#logger.warn({ reason, malformed: this.#malformed }, 'discarded a syslog message');
        }
      },
    });

    this.#logger.info(
      {
        port: this.#options.port,
        address: this.#options.address,
        udp: this.#options.udp,
        tcp: this.#options.tcp,
        senders: this.#options.senders.length,
        bufferSize: this.#options.bufferSize,
      },
      'syslog listener started',
    );
  }

  async stop(): Promise<void> {
    const receiver = this.#receiver;
    this.#receiver = undefined;
    if (receiver === undefined) return;
    await receiver.close();
    this.#logger.info({ ...this.stats() }, 'syslog listener stopped');
  }

  /** Everything this sensor has not seen, and how much it missed. See `NotificationRing`. */
  drain(sensorId: number): ReceivedBatch {
    return this.#ring.drain(sensorId, LISTENER_ID);
  }

  retain(sensorIds: Iterable<number>): void {
    this.#ring.retain(sensorIds);
  }

  stats(): SyslogListenerStats {
    return {
      running: this.running,
      received: this.#received,
      rejected: this.#rejected,
      malformed: this.#malformed,
      buffered: this.#ring.buffered,
      cursors: this.#ring.cursors,
      overwritten: this.#ring.overwritten,
    };
  }

  #accept(received: ReceivedSyslog): void {
    const allowed = this.#options.senders;
    if (allowed.length > 0 && !allowed.includes(received.source)) {
      // Counted rather than logged per message: a misconfigured device sends for ever.
      this.#rejected += 1;
      return;
    }

    this.#received += 1;
    const message = received.message;
    const notification: ReceivedNotification = {
      // The probe's clock, not the sender's. A device with a wrong clock would otherwise put its
      // messages outside every window a sensor looks at, and the sender's own stamp is kept in
      // `detail.timestamp` for anybody who wants it.
      at: this.#now().toISOString(),
      source: received.source,
      text: renderSyslog(received.source, message),
      detail: {
        priority: message.priority,
        facility: message.facility,
        facilityName: message.facilityName,
        severity: message.severity,
        severityName: message.severityName,
        timestamp: message.timestamp,
        hostname: message.hostname,
        appName: message.appName,
        procId: message.procId,
        msgId: message.msgId,
        message: message.message,
        format: message.format,
        structured: message.structured,
        transport: received.transport,
      },
    };
    this.#ring.push(notification);
  }
}
