import snmp from 'net-snmp';
import {
  trapOidFromV1,
  trapOidFromVarbinds,
  type TrapDetail,
  type TrapVarbind,
  type TrapVersion,
} from './trap.js';

/**
 * The socket a probe listens for notifications on (`T-06`).
 *
 * **Here rather than in `@ms/probe` for one reason: `net-snmp` stays in this package.**
 * `session.ts` records why that boundary is worth keeping — ADR-001 Decision 6 named the
 * dependency's single-maintainer risk and said the mitigation is that replacing it is a change
 * to one place. A second importer in another package quietly doubles that cost. So the protocol
 * lives here, beside the session, and the probe gets a callback carrying plain data.
 *
 * Nothing above the callback knows about `net-snmp`, and nothing here knows about sensors,
 * buffers or cursors — those are `@ms/probe`'s, because they are about what a *probe* does with
 * what arrived.
 *
 * **Informs are acknowledged by the library, before the callback runs.** That is the difference
 * between a trap and an inform and it is not optional: an unacknowledged inform is retransmitted
 * by the sender until it gives up, so a receiver that only counted them would turn one event
 * into a burst. Verified against a live sender while building this.
 */

/** What a decoded notification looks like leaving this module. */
export interface ReceivedTrap {
  readonly source: string;
  readonly detail: TrapDetail;
  /** The community a v1/v2c sender used, for the probe to accept or reject. */
  readonly community: string;
}

export interface TrapReceiverOptions {
  readonly port: number;
  readonly address: string;
  readonly transport: 'udp4' | 'udp6';
  /** A decoded notification. */
  readonly onTrap: (trap: ReceivedTrap) => void;
  /**
   * A datagram that could not be decoded.
   *
   * Ordinary on a port anything on the network can send to, and it must never take the probe
   * down: a receiver whose error path throws is a probe killed by one malformed packet.
   */
  readonly onMalformed: (reason: string) => void;
}

export interface TrapReceiver {
  close(): Promise<void>;
}

const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'Boolean',
  2: 'Integer',
  3: 'BitString',
  4: 'OctetString',
  5: 'Null',
  6: 'OID',
  64: 'IpAddress',
  65: 'Counter',
  66: 'Gauge',
  67: 'TimeTicks',
  68: 'Opaque',
  70: 'Counter64',
  128: 'NoSuchObject',
  129: 'NoSuchInstance',
  130: 'EndOfMibView',
};

/** As much of net-snmp's notification PDU as this reads. */
export interface ReceiverPdu {
  readonly type: number;
  readonly varbinds?: readonly { oid: string; type: number; value: unknown }[];
  readonly enterprise?: string;
  readonly agentAddr?: string;
  readonly generic?: number;
  readonly specific?: number;
  readonly community?: string;
  readonly user?: string;
}

export function openTrapReceiver(options: TrapReceiverOptions): TrapReceiver {
  const receiver = snmp.createReceiver(
    {
      port: options.port,
      address: options.address,
      transport: options.transport,
      // The community is checked by the probe, not here, so that a rejected one can be counted
      // and reported rather than disappearing inside the library.
      disableAuthorization: true,
      // Without this the community never reaches the callback and the check above is impossible.
      includeAuthentication: true,
    },
    (error, notification) => {
      if (error !== null) {
        options.onMalformed(error.message);
        return;
      }
      if (notification === undefined) return;

      const detail = normaliseTrap(notification.pdu);
      if (detail === null) {
        options.onMalformed(`unsupported PDU type ${String(notification.pdu.type)}`);
        return;
      }
      options.onTrap({
        source: notification.rinfo.address,
        detail,
        community: notification.pdu.community ?? '',
      });
    },
  );

  return {
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        try {
          receiver.close(() => {
            resolve();
          });
        } catch {
          // A socket already gone is not worth failing a shutdown over.
          resolve();
        }
        // net-snmp does not always invoke the callback. Resolving anyway keeps an ordinary
        // shutdown from waiting for the lifecycle's timeout.
        setTimeout(resolve, 250).unref();
      });
    },
  };
}

/** A varbind's value as text. An `OctetString` is bytes, and this is where it is decoded. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * A v1, v2c or v3 notification as one shape (RFC 3584 §3.1).
 *
 * Null for a PDU that is none of them — which is what a `GetRequest` arriving on port 162 looks
 * like, someone having pointed a poller at the wrong port. Counted rather than accepted as an
 * empty trap, because an empty trap would match a rule that was written for a real one.
 *
 * Exported for its own tests: it is the single point where two wire formats stop being
 * different, and a mistake here is a filter that matches nothing with no error anywhere.
 */
export function normaliseTrap(pdu: ReceiverPdu): TrapDetail | null {
  const varbinds: TrapVarbind[] = (pdu.varbinds ?? []).map((varbind) => ({
    oid: varbind.oid,
    type: TYPE_NAMES[varbind.type] ?? String(varbind.type),
    value: textOf(varbind.value),
  }));

  if (pdu.type === snmp.PduType.Trap) {
    const enterprise = pdu.enterprise ?? '';
    const generic = pdu.generic ?? 6;
    const specific = pdu.specific ?? 0;
    return {
      trapOid: trapOidFromV1(enterprise, generic, specific),
      version: 'v1',
      kind: 'trap',
      enterprise,
      ...(pdu.agentAddr === undefined ? {} : { agentAddress: pdu.agentAddr }),
      generic,
      specific,
      varbinds,
    };
  }

  if (pdu.type === snmp.PduType.TrapV2 || pdu.type === snmp.PduType.InformRequest) {
    const trapOid = trapOidFromVarbinds(varbinds);
    // RFC 3416 puts `snmpTrapOID.0` on every v2c notification. Without it there is nothing to
    // filter on, and inventing one would make a rule match something nobody wrote it for.
    if (trapOid === null) return null;
    return {
      trapOid,
      version: versionOf(pdu),
      kind: pdu.type === snmp.PduType.InformRequest ? 'inform' : 'trap',
      varbinds,
    };
  }

  return null;
}

/** The receiver reports v3 through the same callback; a user name rather than a community. */
function versionOf(pdu: ReceiverPdu): TrapVersion {
  return pdu.user !== undefined && pdu.user !== '' ? 'v3' : 'v2c';
}
