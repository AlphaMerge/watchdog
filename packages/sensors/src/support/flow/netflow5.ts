/**
 * NetFlow v5, decoded (`B-01`).
 *
 * **Written here because npm has no maintained option** — CLAUDE.md's stated reason for the
 * syslog, NetFlow and WMI transports, and the reason `CAPABILITIES.MD §3.9` marks flow `[V2]`
 * rather than a library integration.
 *
 * **v5 first because it is the format with no template cache in it.** Cisco froze this layout in
 * 1996: a 24-byte header, then up to thirty 48-byte records, every field at a fixed offset. There
 * is nothing to negotiate and nothing to remember between datagrams, which makes it the right
 * place to settle the decode contract and the fixtures before `B-03` adds the part that can fail
 * by forgetting.
 *
 * **Two clocks, and the interesting one is not wall-clock.** The header carries `unixSecs`, when
 * the exporter thinks it sent the datagram, and `sysUptime`, milliseconds since the exporter
 * booted. The per-flow `first` and `last` are in the *uptime* clock, so a flow's wall-clock time
 * is only knowable by subtracting from `sysUptime` and adding to `unixSecs` — which means every
 * timestamp this decoder produces inherits the exporter's opinion of the time. `flowWindow`
 * exposes that arithmetic rather than hiding it, because an exporter whose clock is wrong should
 * be diagnosable and not merely wrong.
 *
 * **Nothing here decides anything**, in the sense `T-06` established for listeners: this module
 * turns bytes into values and refuses bytes it cannot account for. Filtering, counting and
 * channel assignment are the sensor's business (`B-04`).
 */

/** The only version this module decodes; `B-03` adds 9 and 10. */
export const NETFLOW_V5 = 5;

/** Header, then records. Both fixed, per Cisco's layout. */
export const V5_HEADER_BYTES = 24;
export const V5_RECORD_BYTES = 48;

/**
 * Thirty is the most an exporter may claim, because thirty records plus the header is 1,464
 * bytes and the format was designed to fit one Ethernet datagram without fragmenting.
 *
 * Enforced rather than assumed: a `count` above this is either a corrupt datagram or something
 * that is not NetFlow, and reading 65,535 records out of a 1,500-byte buffer is how a decoder
 * becomes a denial of service.
 */
export const V5_MAX_RECORDS = 30;

/** What the two high bits of `samplingInterval` mean (Cisco's sampling modes). */
export type SamplingMode = 'none' | 'deterministic' | 'random' | 'reserved';

const SAMPLING_MODES: readonly SamplingMode[] = ['none', 'deterministic', 'random', 'reserved'];

export interface NetflowV5Header {
  readonly version: number;
  /** Records the datagram *claims*. Trust it only after `decodeNetflowV5` has checked the length. */
  readonly count: number;
  /** Milliseconds since the exporter booted. The `first`/`last` fields are in this clock. */
  readonly sysUptimeMs: number;
  /** The exporter's wall clock when it sent this, in seconds and nanoseconds. */
  readonly unixSecs: number;
  readonly unixNsecs: number;
  /**
   * Running count of records exported before this datagram.
   *
   * The only way to notice loss: UDP drops silently, so a gap between one datagram's
   * `flowSequence + count` and the next one's `flowSequence` is flows that were exported and
   * never arrived. `B-04` turns that into a channel.
   */
  readonly flowSequence: number;
  /**
   * Which of the exporter's flow-switching engines sent this datagram: bytes 20 and 21 of
   * Cisco's header layout, the kind of engine and its slot.
   *
   * `flowSequence` is followed per pair of these (`B-13`). v5 was never specified, only
   * documented as a layout, and the layout does not say what the sequence is counted within; a
   * chassis exporting from two engines at one address is the case where it matters.
   */
  readonly engineType: number;
  readonly engineId: number;
  readonly samplingMode: SamplingMode;
  /** One flow in N was sampled. Zero means the exporter is not sampling. */
  readonly samplingInterval: number;
}

export interface NetflowV5Record {
  /** Dotted-quad, rendered from the big-endian word the wire carries. */
  readonly srcAddr: string;
  readonly dstAddr: string;
  readonly nextHop: string;
  /** SNMP `ifIndex` of the ingress and egress interfaces. */
  readonly inputIf: number;
  readonly outputIf: number;
  readonly packets: number;
  readonly octets: number;
  /** Uptime clock, not wall clock — see `flowWindow`. */
  readonly firstMs: number;
  readonly lastMs: number;
  readonly srcPort: number;
  readonly dstPort: number;
  /** Cumulative OR of the TCP flags seen on the flow. Meaningless when `protocol` is not 6. */
  readonly tcpFlags: number;
  /** IANA protocol number: 6 TCP, 17 UDP, 1 ICMP. */
  readonly protocol: number;
  readonly tos: number;
  readonly srcAs: number;
  readonly dstAs: number;
  readonly srcMask: number;
  readonly dstMask: number;
}

export interface NetflowV5Datagram {
  readonly header: NetflowV5Header;
  readonly records: readonly NetflowV5Record[];
}

/**
 * Why a datagram was refused.
 *
 * A discriminated reason rather than a thrown string, because the listener counts these by kind
 * and an operator staring at a `malformed` counter needs to know whether the exporter is sending
 * v9 to a v5 collector or sending rubbish.
 */
export type FlowDecodeFailure =
  | { readonly kind: 'too-short'; readonly got: number; readonly need: number }
  | { readonly kind: 'unsupported-version'; readonly version: number }
  | { readonly kind: 'count-out-of-range'; readonly count: number; readonly max: number }
  | { readonly kind: 'truncated'; readonly claimed: number; readonly present: number };

export class FlowDecodeError extends Error {
  readonly reason: FlowDecodeFailure;

  constructor(reason: FlowDecodeFailure, message: string) {
    super(message);
    this.name = 'FlowDecodeError';
    this.reason = reason;
  }
}

/** Big-endian word to dotted quad, without going through a string per octet. */
function ipv4(value: number): string {
  return `${String((value >>> 24) & 0xff)}.${String((value >>> 16) & 0xff)}.${String(
    (value >>> 8) & 0xff,
  )}.${String(value & 0xff)}`;
}

/**
 * Decodes one v5 datagram, or throws `FlowDecodeError` saying which way it was wrong.
 *
 * **The header's `count` is a claim, not a length.** It is what the exporter says it put in;
 * what arrived is `datagram.length`. A decoder that trusts the claim reads past the end of a
 * truncated datagram — and truncation is not exotic here, because v5 rides UDP with no length
 * negotiation and a path MTU smaller than the exporter assumes silently clips it. So the claim is
 * checked against the bytes present and a mismatch is refused whole rather than half-read: half a
 * flow table is worse than none, since the missing half is invisible downstream.
 */
export function decodeNetflowV5(datagram: Buffer): NetflowV5Datagram {
  if (datagram.length < V5_HEADER_BYTES) {
    throw new FlowDecodeError(
      { kind: 'too-short', got: datagram.length, need: V5_HEADER_BYTES },
      `a NetFlow datagram of ${String(datagram.length)} bytes cannot hold a ${String(V5_HEADER_BYTES)}-byte header`,
    );
  }

  const version = datagram.readUInt16BE(0);
  if (version !== NETFLOW_V5) {
    throw new FlowDecodeError(
      { kind: 'unsupported-version', version },
      `NetFlow version ${String(version)} is not v5, the only version this decoder reads`,
    );
  }

  const count = datagram.readUInt16BE(2);
  if (count < 1 || count > V5_MAX_RECORDS) {
    throw new FlowDecodeError(
      { kind: 'count-out-of-range', count, max: V5_MAX_RECORDS },
      `a v5 datagram claims ${String(count)} records, outside the 1..${String(V5_MAX_RECORDS)} the format allows`,
    );
  }

  const need = V5_HEADER_BYTES + count * V5_RECORD_BYTES;
  if (datagram.length < need) {
    const present = Math.floor((datagram.length - V5_HEADER_BYTES) / V5_RECORD_BYTES);
    throw new FlowDecodeError(
      { kind: 'truncated', claimed: count, present },
      `a v5 datagram claims ${String(count)} records and carries ${String(present)} — refusing rather than reading half a flow table`,
    );
  }

  const sampling = datagram.readUInt16BE(22);
  const header: NetflowV5Header = {
    version,
    count,
    sysUptimeMs: datagram.readUInt32BE(4),
    unixSecs: datagram.readUInt32BE(8),
    unixNsecs: datagram.readUInt32BE(12),
    flowSequence: datagram.readUInt32BE(16),
    engineType: datagram.readUInt8(20),
    engineId: datagram.readUInt8(21),
    // Top two bits are the mode, the low fourteen are the interval.
    samplingMode: SAMPLING_MODES[(sampling >>> 14) & 0b11] ?? 'reserved',
    samplingInterval: sampling & 0x3fff,
  };

  const records: NetflowV5Record[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = V5_HEADER_BYTES + i * V5_RECORD_BYTES;
    records.push({
      srcAddr: ipv4(datagram.readUInt32BE(at)),
      dstAddr: ipv4(datagram.readUInt32BE(at + 4)),
      nextHop: ipv4(datagram.readUInt32BE(at + 8)),
      inputIf: datagram.readUInt16BE(at + 12),
      outputIf: datagram.readUInt16BE(at + 14),
      packets: datagram.readUInt32BE(at + 16),
      octets: datagram.readUInt32BE(at + 20),
      firstMs: datagram.readUInt32BE(at + 24),
      lastMs: datagram.readUInt32BE(at + 28),
      srcPort: datagram.readUInt16BE(at + 32),
      dstPort: datagram.readUInt16BE(at + 34),
      // at + 36 is a pad byte the format never used.
      tcpFlags: datagram.readUInt8(at + 37),
      protocol: datagram.readUInt8(at + 38),
      tos: datagram.readUInt8(at + 39),
      srcAs: datagram.readUInt16BE(at + 40),
      dstAs: datagram.readUInt16BE(at + 42),
      srcMask: datagram.readUInt8(at + 44),
      dstMask: datagram.readUInt8(at + 45),
      // at + 46 is two more pad bytes.
    });
  }

  return { header, records };
}

/**
 * A flow's wall-clock window, from the two clocks the datagram carries.
 *
 * **This is the arithmetic every NetFlow collector gets asked about**, so it is a function with a
 * name rather than three lines inlined at the call site. `first` and `last` are uptime
 * milliseconds; the header says what uptime *was* when the datagram left and what the exporter
 * believed the wall clock to be at that moment. Subtract one, add the other.
 *
 * It inherits the exporter's clock, and there is no fixing that here: a device whose NTP has
 * failed exports flows stamped wrongly and nothing downstream can tell. What it does do is fail
 * visibly rather than quietly — a flow that ends after the datagram that reports it, or begins
 * before the exporter booted, is arithmetic anyone can check.
 */
export function flowWindow(
  header: NetflowV5Header,
  record: NetflowV5Record,
): { readonly start: Date; readonly end: Date } {
  const sentMs = header.unixSecs * 1_000 + Math.floor(header.unixNsecs / 1_000_000);
  return {
    start: new Date(sentMs - (header.sysUptimeMs - record.firstMs)),
    end: new Date(sentMs - (header.sysUptimeMs - record.lastMs)),
  };
}
