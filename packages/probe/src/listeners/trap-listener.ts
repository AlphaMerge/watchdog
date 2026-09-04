import { renderTrap, type ReceivedBatch, type ReceivedNotification } from '@ms/sensors';
import { NotificationRing } from './ring.js';
import type { Logger } from '@ms/shared';
import type { ReceivedTrap, TrapReceiver, TrapReceiverOptions } from '@ms/sensors/snmp';

/**
 * The probe's SNMP trap listener (`T-06`).
 *
 * **One socket for the whole probe, and it knows nothing about sensors.** A check runs in
 * whichever worker is free and only while it is running, so a listening socket cannot live in
 * one — and a socket per sensor would mean a port per sensor, which is not how devices send
 * traps. So the probe owns one receiver and each `snmp.trap` sensor is handed whatever has
 * arrived since it last looked.
 *
 * Nothing here *decides* anything. Filter rules, counting and retention are the sensor's
 * parameters and live in `@ms/sensors`, tested against a fabricated batch with no socket in
 * sight. What is here is the community filter, the counters, and a `NotificationRing` — which
 * `T-20` moved out when the syslog listener turned out to need exactly the same ring, cursors
 * and drop counting. That split is what keeps a trap sensor an ordinary one-file plugin rather
 * than a special case wired through the probe.
 *
 * **`net-snmp` is not imported here.** The protocol half lives beside the session layer in
 * `@ms/sensors/snmp`, and is loaded by `start()` — so a probe with the listener disabled never
 * pays for it, and the dependency stays confined to one package (ADR-001 Decision 6).
 */

export const LISTENER_ID = 'snmp-trap';

export interface TrapListenerOptions {
  readonly logger: Logger;
  readonly port: number;
  readonly address: string;
  readonly transport: 'udp4' | 'udp6';
  /** Empty accepts any. v1 and v2c send it in clear, so this is a filter, not a lock. */
  readonly communities: readonly string[];
  readonly bufferSize: number;
  /** Injectable so a test can drive the ring without waiting on a clock. */
  readonly now?: () => Date;
  /**
   * How the socket is opened. Defaults to the real receiver in `@ms/sensors/snmp`.
   *
   * The seam this class is tested through, and it is the honest one: everything here is about
   * ring buffers, cursors and counters, and none of it should need a UDP port to exercise. The
   * protocol half has its own tests against a real socket, where a real socket is the point.
   */
  readonly open?: (options: TrapReceiverOptions) => TrapReceiver | Promise<TrapReceiver>;
}

export interface TrapListenerStats {
  readonly running: boolean;
  readonly received: number;
  /** Turned away because their community is not in the accept list. */
  readonly rejected: number;
  readonly malformed: number;
  readonly buffered: number;
  readonly cursors: number;
  /** Notifications overwritten in the ring. Not per sensor — see `drain`. */
  readonly overwritten: number;
}

export class TrapListener {
  readonly #logger: Logger;
  readonly #options: TrapListenerOptions;
  readonly #now: () => Date;

  readonly #ring: NotificationRing;
  #receiver: TrapReceiver | undefined;
  #received = 0;
  #rejected = 0;
  #malformed = 0;

  constructor(options: TrapListenerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'trap-listener' });
    this.#now = options.now ?? ((): Date => new Date());
    this.#ring = new NotificationRing(options.bufferSize, this.#now);
  }

  get running(): boolean {
    return this.#receiver !== undefined;
  }

  /**
   * Binds the socket.
   *
   * Async because the protocol layer — and with it `net-snmp` — is imported here rather than at
   * the top of the file: a probe with no trap sensors and the listener off never loads it.
   */
  async start(): Promise<void> {
    if (this.#receiver !== undefined) return;

    // Imported here rather than at the top of the file: a probe with the listener off never
    // loads `net-snmp`, and an injected opener never loads it at all.
    const open = this.#options.open ?? (await import('@ms/sensors/snmp')).openTrapReceiver;
    this.#receiver = await open({
      port: this.#options.port,
      address: this.#options.address,
      transport: this.#options.transport,
      onTrap: (trap) => {
        this.#accept(trap);
      },
      onMalformed: (reason) => {
        this.#malformed += 1;
        // A malformed datagram is ordinary on a port anything can send to. Logged for the first
        // few and then every thousandth: one line per bad packet is how a disk fills up during
        // an incident, and the count is on Probe Health either way — which `P-64` made true. It
        // was written here before anything carried it, and stayed wrong for three tickets.
        if (this.#malformed <= 5 || this.#malformed % 1_000 === 0) {
          this.#logger.warn({ reason, malformed: this.#malformed }, 'discarded a notification');
        }
      },
    });

    this.#logger.info(
      {
        port: this.#options.port,
        address: this.#options.address,
        transport: this.#options.transport,
        communities: this.#options.communities.length,
        bufferSize: this.#options.bufferSize,
      },
      'snmp trap listener started',
    );
  }

  async stop(): Promise<void> {
    const receiver = this.#receiver;
    this.#receiver = undefined;
    if (receiver === undefined) return;
    await receiver.close();
    this.#logger.info({ ...this.stats() }, 'snmp trap listener stopped');
  }

  /** Everything this sensor has not seen, and how much it missed. See `NotificationRing`. */
  drain(sensorId: number): ReceivedBatch {
    return this.#ring.drain(sensorId, LISTENER_ID);
  }

  /** Keeps only the cursors for sensors the probe still holds, so a deleted one stops costing. */
  retain(sensorIds: Iterable<number>): void {
    this.#ring.retain(sensorIds);
  }

  stats(): TrapListenerStats {
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

  #accept(trap: ReceivedTrap): void {
    const allowed = this.#options.communities;
    if (allowed.length > 0 && !allowed.includes(trap.community)) {
      // Counted rather than logged per trap: a misconfigured device retries for ever.
      this.#rejected += 1;
      return;
    }

    this.#received += 1;
    const notification: ReceivedNotification = {
      at: this.#now().toISOString(),
      source: trap.source,
      text: renderTrap(trap.source, trap.detail),
      detail: trap.detail as unknown as Readonly<Record<string, unknown>>,
    };
    this.#ring.push(notification);
  }
}
