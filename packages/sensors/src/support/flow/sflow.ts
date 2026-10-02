import { FlowDecodeError } from './netflow5.js';
import type { FlowMessage, FlowRecord } from './record.js';

/**
 * sFlow v5 (`B-05`).
 *
 * **A different protocol wearing a similar name.** NetFlow reports *accounting*: the exporter
 * keeps a flow table and tells you how many bytes each flow carried. sFlow reports *sampling*: it
 * takes one packet in N, copies the first few dozen bytes of it, and sends that. Nothing in an
 * sFlow datagram is a flow. The record this module produces is one reconstructed from a packet
 * header, and the only thing making it comparable to a NetFlow record is `samplingRate`.
 *
 * **Two fields decide whether the numbers are right, and both are easy to read wrongly.**
 *
 * `frame_length` is the length of the packet *on the wire*, before sampling truncated it —
 * typically 1,514 where `header_length` is 128. A collector that reported the header length would
 * under-report by an order of magnitude and the number would look entirely plausible.
 *
 * `sampling_rate` is the N in one-in-N. It is carried per sample, not per datagram, because an
 * agent may sample different interfaces at different rates. It goes onto the record rather than
 * being applied here (`B-06`): the decoder says what arrived and what it stands for, and the
 * consumer decides whether to scale.
 *
 * **Counter samples are decoded far enough to be counted and no further.** They carry interface
 * counters — `ifInOctets`, `ifOutErrors` and the rest — which are SNMP-shaped data about an
 * interface, not flows. Forcing them into a `FlowRecord` would put a number that is a lifetime
 * total into a field the rest of this subsystem reads as an interval delta, and everything
 * downstream would be wrong in a way nothing could see. They are counted so an operator can tell
 * a silent agent from one sending only counters; turning them into interface sensors is its own
 * ticket, and `snmp.traffic` already covers that ground.
 *
 * **XDR: everything is a 4-byte big-endian word and every block is padded up to one.** A reader
 * that forgets the padding walks into the next record's header and decodes noise.
 */

export const SFLOW_V5 = 5;

/** Datagram header before the samples: version, address type, agent, sub-agent, seq, uptime, n. */
const MIN_HEADER_BYTES = 28;

const SAMPLE_FLOW = 1;
const SAMPLE_COUNTER = 2;
const SAMPLE_FLOW_EXPANDED = 3;
const SAMPLE_COUNTER_EXPANDED = 4;

/** Flow record format 1: a copied packet header. */
const RECORD_RAW_HEADER = 1;

/** The only link layer worth decoding here; anything else is counted and skipped. */
const HEADER_PROTOCOL_ETHERNET = 1;

const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_VLAN = 0x8100;
const ETHERTYPE_QINQ = 0x88a8;

export interface SflowResult extends FlowMessage {
  /** Counter samples seen — decoded far enough to count, deliberately no further. */
  readonly counterSamples: number;
  /** Samples this reader could not turn into a record: a link layer or format it does not read. */
  readonly skipped: number;
  /** Packets the agent says it dropped because it could not sample them fast enough. */
  readonly agentDrops: number;
}

/** A cursor over an XDR buffer that refuses to read past its end. */
class Reader {
  #at = 0;
  readonly #buffer: Buffer;
  readonly #end: number;

  constructor(buffer: Buffer, end = buffer.length) {
    this.#buffer = buffer;
    this.#end = Math.min(end, buffer.length);
  }

  get remaining(): number {
    return this.#end - this.#at;
  }

  get offset(): number {
    return this.#at;
  }

  uint32(): number {
    if (this.remaining < 4) throw new SflowShort(4, this.remaining);
    const value = this.#buffer.readUInt32BE(this.#at);
    this.#at += 4;
    return value;
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.remaining < length) throw new SflowShort(length, this.remaining);
    const slice = this.#buffer.subarray(this.#at, this.#at + length);
    this.#at += length;
    return slice;
  }

  /** XDR pads every opaque block up to a 4-byte boundary; the padding is not part of the value. */
  opaque(length: number): Buffer {
    const value = this.bytes(length);
    const padding = (4 - (length % 4)) % 4;
    if (padding > 0) this.skip(padding);
    return value;
  }

  skip(length: number): void {
    if (length < 0 || this.remaining < length) throw new SflowShort(length, this.remaining);
    this.#at += length;
  }

  /** A sub-reader over the next `length` bytes, so a malformed record cannot escape its own. */
  window(length: number): Reader {
    const slice = this.bytes(length);
    return new Reader(slice);
  }
}

class SflowShort extends Error {
  constructor(need: number, got: number) {
    super(`needed ${String(need)} bytes and ${String(got)} were left`);
    this.name = 'SflowShort';
  }
}

/** Decodes one sFlow v5 datagram into the same record shape every other dialect produces. */
export function decodeSflow(datagram: Buffer): SflowResult {
  if (datagram.length < MIN_HEADER_BYTES) {
    throw new FlowDecodeError(
      { kind: 'too-short', got: datagram.length, need: MIN_HEADER_BYTES },
      `an sFlow datagram of ${String(datagram.length)} bytes cannot hold a header`,
    );
  }

  const reader = new Reader(datagram);
  const version = reader.uint32();
  if (version !== SFLOW_V5) {
    throw new FlowDecodeError(
      { kind: 'unsupported-version', version },
      `sFlow version ${String(version)} is not v5, the only one this collector reads`,
    );
  }

  // The agent's own address, which is not necessarily the address the datagram came from: an
  // agent behind NAT, or one with several interfaces, reports the one it identifies itself by.
  // Read, not skipped (`B-10`): the datagram's sequence is counted per sub-agent *of this agent*,
  // so two agents behind one address, or one agent's two sub-agents, are separate counts.
  const addressType = reader.uint32();
  let agent: string;
  if (addressType === 1) agent = reader.bytes(4).join('.');
  else if (addressType === 2) agent = reader.bytes(16).toString('hex');
  else {
    throw new FlowDecodeError(
      { kind: 'unsupported-version', version: addressType },
      `sFlow agent address type ${String(addressType)} is neither IPv4 nor IPv6`,
    );
  }

  const subAgent = reader.uint32();
  const sequence = reader.uint32();
  const sysUptimeMs = reader.uint32();
  const sampleCount = reader.uint32();

  const records: FlowRecord[] = [];
  let counterSamples = 0;
  let skipped = 0;
  let agentDrops = 0;

  for (let i = 0; i < sampleCount && reader.remaining >= 8; i += 1) {
    const format = reader.uint32() & 0xfff;
    const length = reader.uint32();
    // **A length that overruns ends the walk rather than being clamped.** Clamping would decode
    // the next sample's header as this one's body and report the noise as traffic.
    if (length > reader.remaining) {
      throw new FlowDecodeError(
        { kind: 'truncated', claimed: length, present: reader.remaining },
        `an sFlow sample declares ${String(length)} bytes with ${String(reader.remaining)} left`,
      );
    }
    const sample = reader.window(length);

    try {
      if (format === SAMPLE_FLOW || format === SAMPLE_FLOW_EXPANDED) {
        const decoded = readFlowSample(sample, format === SAMPLE_FLOW_EXPANDED);
        agentDrops += decoded.drops;
        if (decoded.record === undefined) skipped += 1;
        else records.push(decoded.record);
      } else if (format === SAMPLE_COUNTER || format === SAMPLE_COUNTER_EXPANDED) {
        counterSamples += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      // One malformed sample is not a malformed datagram: the others are independent and an
      // agent that gets one record wrong should not cost the operator the rest.
      if (!(error instanceof SflowShort)) throw error;
      skipped += 1;
    }
  }

  return {
    dialect: 'sflow',
    records,
    sequence,
    // An sFlow agent's sequence counts *datagrams* it has sent, like NetFlow v9's.
    sequenceCounts: 'packets',
    // "Incremented with each sample datagram generated by a sub-agent within an agent" (sFlow v5).
    sequenceScope: `${agent}/${String(subAgent)}`,
    undecodable: 0,
    sysUptimeMs,
    counterSamples,
    skipped,
    agentDrops,
  };
}

interface FlowSample {
  readonly record: FlowRecord | undefined;
  readonly drops: number;
}

function readFlowSample(reader: Reader, expanded: boolean): FlowSample {
  reader.uint32(); // sample sequence number
  if (expanded) {
    reader.uint32(); // source id type
    reader.uint32(); // source id index
  } else {
    reader.uint32(); // source id, type and index packed into one word
  }

  const samplingRate = reader.uint32();
  reader.uint32(); // sample pool
  const drops = reader.uint32();

  // Expanded samples carry a format word alongside each interface value.
  const inputIf = expanded ? (reader.uint32(), reader.uint32()) : reader.uint32();
  const outputIf = expanded ? (reader.uint32(), reader.uint32()) : reader.uint32();

  const recordCount = reader.uint32();
  for (let i = 0; i < recordCount && reader.remaining >= 8; i += 1) {
    const format = reader.uint32() & 0xfff;
    const length = reader.uint32();
    if (length > reader.remaining) break;
    const body = reader.window(length);
    if (format !== RECORD_RAW_HEADER) continue;

    const record = readRawHeader(body, samplingRate, inputIf, outputIf);
    if (record !== undefined) return { record, drops };
  }

  return { record: undefined, drops };
}

function readRawHeader(
  reader: Reader,
  samplingRate: number,
  inputIf: number,
  outputIf: number,
): FlowRecord | undefined {
  const protocol = reader.uint32();
  // **The length on the wire, not the length of the copy.** `frame_length` is typically 1,514
  // where `header_length` below is 128; reporting the latter under-reports by an order of
  // magnitude and looks entirely plausible while doing it.
  const frameLength = reader.uint32();
  reader.uint32(); // bytes stripped from the end (the FCS, usually)
  const headerLength = reader.uint32();
  if (protocol !== HEADER_PROTOCOL_ETHERNET) return undefined;

  const header = reader.opaque(Math.min(headerLength, reader.remaining));
  const parsed = readEthernet(header);
  if (parsed === undefined) return undefined;

  return {
    ...parsed,
    packets: 1,
    octets: frameLength,
    inputIf,
    outputIf,
    // Zero would mean "this packet stands for none of them"; an agent that reports no rate is
    // reporting one packet per packet.
    samplingRate: samplingRate > 0 ? samplingRate : 1,
  };
}

type Addressed = Pick<
  FlowRecord,
  'srcAddr' | 'dstAddr' | 'srcPort' | 'dstPort' | 'protocol' | 'tos'
>;

/** Enough of an Ethernet frame to find the IPv4 header, VLAN tags included. */
function readEthernet(frame: Buffer): Addressed | undefined {
  if (frame.length < 14) return undefined;
  let at = 12;
  let ethertype = frame.readUInt16BE(at);
  at += 2;

  // 802.1Q and 802.1ad each insert four bytes before the real ethertype, and a switch trunk port
  // sends both. A reader that stopped at the first tag reads the VLAN id as an ethertype.
  let tags = 0;
  while ((ethertype === ETHERTYPE_VLAN || ethertype === ETHERTYPE_QINQ) && tags < 2) {
    if (frame.length < at + 4) return undefined;
    at += 2;
    ethertype = frame.readUInt16BE(at);
    at += 2;
    tags += 1;
  }

  if (ethertype !== ETHERTYPE_IPV4) return undefined;
  return readIpv4(frame.subarray(at));
}

function readIpv4(packet: Buffer): Addressed | undefined {
  if (packet.length < 20) return undefined;
  const versionAndIhl = packet.readUInt8(0);
  if (versionAndIhl >> 4 !== 4) return undefined;
  // The IHL is in 32-bit words and options make it longer than five; a fixed 20 would read the
  // options as the transport header on exactly the packets that carry them.
  const headerBytes = (versionAndIhl & 0x0f) * 4;
  if (headerBytes < 20 || packet.length < headerBytes) return undefined;

  const tos = packet.readUInt8(1);
  const protocol = packet.readUInt8(9);
  const srcAddr = packet.subarray(12, 16).join('.');
  const dstAddr = packet.subarray(16, 20).join('.');

  // Ports live in the first four bytes of TCP and UDP alike. A fragment past the first carries
  // no transport header at all, and its fragment offset says so.
  const fragmentOffset = packet.readUInt16BE(6) & 0x1fff;
  const payload = packet.subarray(headerBytes);
  const hasPorts =
    fragmentOffset === 0 && payload.length >= 4 && (protocol === 6 || protocol === 17);

  return {
    srcAddr,
    dstAddr,
    srcPort: hasPorts ? payload.readUInt16BE(0) : 0,
    dstPort: hasPorts ? payload.readUInt16BE(2) : 0,
    protocol,
    tos,
  };
}
