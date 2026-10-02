import { flowWindow, type NetflowV5Datagram } from './netflow5.js';
import type { DecodedFlowSets, FlowFields } from './netflow9.js';

/**
 * One flow, whichever dialect it arrived in (`B-06`).
 *
 * **The three decoders do not produce the same thing, and without this they never would.** v5
 * yields typed records; v9 and IPFIX yield a map of raw IANA elements to bytes; sFlow yields a
 * sampled packet header. Handing those to the listener as they are puts a per-dialect branch in
 * the listener *and* another in the sensor, and guarantees a third when the next format arrives.
 * Normalising here is what lets everything above know nothing about dialects — which is the
 * arrangement `T-06` set up for listeners and this subsystem had quietly abandoned.
 */
export interface FlowRecord {
  readonly srcAddr: string;
  readonly dstAddr: string;
  readonly srcPort: number;
  readonly dstPort: number;
  /** IANA protocol number: 6 TCP, 17 UDP, 1 ICMP. */
  readonly protocol: number;
  readonly packets: number;
  readonly octets: number;
  readonly inputIf: number;
  readonly outputIf: number;
  readonly nextHop?: string;
  readonly tos?: number;
  readonly tcpFlags?: number;
  readonly srcAs?: number;
  readonly dstAs?: number;
  readonly srcMask?: number;
  readonly dstMask?: number;
  /**
   * How many real packets each sampled one stands for. 1 when nothing is sampling.
   *
   * **On the record rather than the message, and never absent.** v5 carries a sampling interval
   * in its header, sFlow is sampled by definition and typically 1-in-512 or 1-in-2048, and a
   * record that does not say what it represents is a record somebody reads as an exact byte
   * count. A collector reporting sampled bytes unscaled under-reports by whatever N is, silently,
   * on exactly the busy links anybody is watching.
   */
  readonly samplingRate: number;
}

export type FlowDialect = 'netflow5' | 'netflow9' | 'ipfix' | 'sflow';

export interface FlowMessage {
  readonly dialect: FlowDialect;
  readonly records: readonly FlowRecord[];
  /** The exporter's own running count, and what it counts — the two differ by dialect. */
  readonly sequence: number;
  readonly sequenceCounts: 'packets' | 'data-records' | 'flows';
  /**
   * Which of the exporter's running counts `sequence` is, where one address keeps several
   * (`B-10`). Absent where the dialect has one for the whole exporter, which none of the four
   * decoded here does.
   *
   * NetFlow v9 counts per source id and IPFIX per observation domain (RFC 3954 §5.1, RFC 7011
   * §3.1), so a router with two line cards exporting from one address sends two unrelated
   * sequences. sFlow counts per sub-agent within an agent, and names the agent in the datagram
   * because the address it arrives from need not be the agent's. NetFlow v5 names an engine
   * type and an engine id in its header and its scope is the two together (`B-13`): no
   * specification says what `flow_sequence` is counted within, and one count per engine is the
   * reading that costs a single-engine exporter nothing. Opaque to everything but the
   * loss arithmetic, which compares a sequence only with the last one of the same scope.
   */
  readonly sequenceScope?: string;
  /** Records this collector could not read, almost always a template it has not learnt. */
  readonly undecodable: number;
  /** Milliseconds since the exporter booted, where the dialect carries it. */
  readonly sysUptimeMs?: number;
  readonly unixSecs?: number;
}

/** IANA Information Element ids, the handful a flow record is actually made of (RFC 7012). */
const IE = {
  octetDeltaCount: 1,
  packetDeltaCount: 2,
  protocolIdentifier: 4,
  tcpControlBits: 6,
  sourceTransportPort: 7,
  sourceIPv4Address: 8,
  sourceIPv4PrefixLength: 9,
  ingressInterface: 10,
  destinationTransportPort: 11,
  destinationIPv4Address: 12,
  destinationIPv4PrefixLength: 13,
  egressInterface: 14,
  ipNextHopIPv4Address: 15,
  bgpSourceAsNumber: 16,
  bgpDestinationAsNumber: 17,
  ipClassOfService: 5,
} as const;

/**
 * A big-endian unsigned integer of whatever width the template gave the field.
 *
 * **Any width, because IPFIX lets a template say so.** `octetDeltaCount` is canonically 8 bytes
 * and exporters ship it as 4 to save space; a decoder that assumed either would read one of them
 * as garbage. Widths above 6 bytes go through `BigInt` so a 64-bit counter does not lose its low
 * bits on the way to a `number` — past 2^53 that rounding is silent and lands on the busiest
 * links.
 */
function uint(bytes: Buffer | undefined): number {
  if (bytes === undefined || bytes.length === 0) return 0;
  if (bytes.length > 6) return Number(bytes.readBigUInt64BE(bytes.length - 8));
  return bytes.readUIntBE(0, bytes.length);
}

/** Four bytes as a dotted quad; anything else is a v6 address this record shape cannot hold. */
function ipv4(bytes: Buffer | undefined): string {
  if (bytes === undefined || bytes.length !== 4) return '';
  return bytes.join('.');
}

/** v5's typed records, which already carry every field the shape names. */
export function fromNetflowV5(datagram: NetflowV5Datagram): FlowMessage {
  const { header } = datagram;
  // `samplingInterval` is 0 when the exporter is not sampling, which means one packet stands for
  // one packet — not for zero of them.
  const samplingRate = header.samplingInterval > 0 ? header.samplingInterval : 1;

  return {
    dialect: 'netflow5',
    sequence: header.flowSequence,
    // v5's sequence counts exported *flows*, which is neither of the other two dialects' meanings.
    sequenceCounts: 'flows',
    // **Per engine (`B-13`).** The header names the engine that exported the datagram, by type
    // and by id, and a chassis exporting from two of them at one address sends two running
    // counts. Both bytes, because an id is only unique within a type. An exporter with one
    // engine sends the same pair in every datagram and is followed exactly as before.
    sequenceScope: `${String(header.engineType)}/${String(header.engineId)}`,
    undecodable: 0,
    sysUptimeMs: header.sysUptimeMs,
    unixSecs: header.unixSecs,
    records: datagram.records.map((record) => ({
      srcAddr: record.srcAddr,
      dstAddr: record.dstAddr,
      srcPort: record.srcPort,
      dstPort: record.dstPort,
      protocol: record.protocol,
      packets: record.packets,
      octets: record.octets,
      inputIf: record.inputIf,
      outputIf: record.outputIf,
      nextHop: record.nextHop,
      tos: record.tos,
      tcpFlags: record.tcpFlags,
      srcAs: record.srcAs,
      dstAs: record.dstAs,
      srcMask: record.srcMask,
      dstMask: record.dstMask,
      samplingRate,
    })),
  };
}

/** One v9 or IPFIX data record: raw elements, read by id at whatever width the template gave. */
function fromFields(fields: FlowFields): FlowRecord {
  return {
    srcAddr: ipv4(fields.get(IE.sourceIPv4Address)),
    dstAddr: ipv4(fields.get(IE.destinationIPv4Address)),
    srcPort: uint(fields.get(IE.sourceTransportPort)),
    dstPort: uint(fields.get(IE.destinationTransportPort)),
    protocol: uint(fields.get(IE.protocolIdentifier)),
    packets: uint(fields.get(IE.packetDeltaCount)),
    octets: uint(fields.get(IE.octetDeltaCount)),
    inputIf: uint(fields.get(IE.ingressInterface)),
    outputIf: uint(fields.get(IE.egressInterface)),
    nextHop: ipv4(fields.get(IE.ipNextHopIPv4Address)),
    tos: uint(fields.get(IE.ipClassOfService)),
    tcpFlags: uint(fields.get(IE.tcpControlBits)),
    srcAs: uint(fields.get(IE.bgpSourceAsNumber)),
    dstAs: uint(fields.get(IE.bgpDestinationAsNumber)),
    srcMask: uint(fields.get(IE.sourceIPv4PrefixLength)),
    dstMask: uint(fields.get(IE.destinationIPv4PrefixLength)),
    // **Not read from the record, and that is a real limitation worth stating.** v9 and IPFIX
    // report sampling through an *options* template — `samplingInterval`, or a sampler the flow
    // record points at by id — which arrives out of band and is a separate lookup. Until that is
    // wired, a sampled v9 exporter's counts are the exporter's own, which is what the exporter
    // says they are. `B-04`'s channels are honest about arriving numbers either way.
    samplingRate: 1,
  };
}

export function fromFlowSets(decoded: DecodedFlowSets): FlowMessage {
  return {
    dialect: decoded.header.version === 10 ? 'ipfix' : 'netflow9',
    sequence: decoded.header.sequence,
    sequenceCounts: decoded.header.sequenceCounts,
    sequenceScope: String(decoded.header.observationDomain),
    undecodable: decoded.undecodable,
    ...(decoded.header.sysUptimeMs === undefined
      ? {}
      : { sysUptimeMs: decoded.header.sysUptimeMs }),
    unixSecs: decoded.header.unixSecs,
    records: decoded.records.map(fromFields),
  };
}

/**
 * The wall-clock window of a v5 flow, for a caller that wants it.
 *
 * Re-exported here rather than reached for in `netflow5.js`, so nothing above this module has to
 * know which dialect a record came from to date it.
 */
export { flowWindow };
