import { createSocket } from 'node:dgram';

/**
 * A NetFlow v5 exporter (`B-01`).
 *
 * **It writes the bytes by hand rather than calling `@ms/sensors`' decoder in reverse**, which is
 * the rule `syslog-sender.ts` and `snmp-agent.ts` both state at length: a harness that produces
 * its input with the code under test proves the decoder can read what the encoder wrote, and that
 * loop closes whether or not either matches Cisco's layout. Every offset below is written out
 * against the specification, because the offsets are the thing being asserted.
 *
 * **It can also emit datagrams that are wrong on purpose.** A decoder is mostly judged by what it
 * refuses, and the interesting refusals — a truncated datagram, a count nothing backs up, a v9
 * datagram arriving at a v5 collector — cannot be produced by an encoder that only knows how to
 * be correct.
 */

const HEADER_BYTES = 24;
const RECORD_BYTES = 48;

export interface ExportedFlow {
  srcAddr?: string;
  dstAddr?: string;
  nextHop?: string;
  inputIf?: number;
  outputIf?: number;
  packets?: number;
  octets?: number;
  /** Uptime milliseconds, the clock v5 puts flow timestamps in. */
  firstMs?: number;
  lastMs?: number;
  srcPort?: number;
  dstPort?: number;
  tcpFlags?: number;
  protocol?: number;
  tos?: number;
  srcAs?: number;
  dstAs?: number;
  srcMask?: number;
  dstMask?: number;
}

export interface ExportOptions {
  version?: number;
  /** Written into the header regardless of how many records follow — see `truncateTo`. */
  claimCount?: number;
  sysUptimeMs?: number;
  unixSecs?: number;
  unixNsecs?: number;
  flowSequence?: number;
  engineType?: number;
  engineId?: number;
  samplingMode?: 0 | 1 | 2 | 3;
  samplingInterval?: number;
  /** Cut the finished datagram to this many bytes, to produce a truncated one. */
  truncateTo?: number;
}

/** Dotted quad to a big-endian word. Throws on anything that is not one, so a typo fails loudly. */
function word(address: string): number {
  const parts = address.split('.');
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${address}`);
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`not an IPv4 address: ${address}`);
    }
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

/**
 * One datagram, as bytes on the wire. Exported so a test can assert on the frame itself rather
 * than only on what a decoder made of it.
 */
export function renderNetflowV5(
  flows: readonly ExportedFlow[],
  options: ExportOptions = {},
): Buffer {
  const datagram = Buffer.alloc(HEADER_BYTES + flows.length * RECORD_BYTES);

  datagram.writeUInt16BE(options.version ?? 5, 0);
  datagram.writeUInt16BE(options.claimCount ?? flows.length, 2);
  datagram.writeUInt32BE(options.sysUptimeMs ?? 3_600_000, 4);
  datagram.writeUInt32BE(options.unixSecs ?? Math.floor(Date.now() / 1_000), 8);
  datagram.writeUInt32BE(options.unixNsecs ?? 0, 12);
  datagram.writeUInt32BE(options.flowSequence ?? 0, 16);
  datagram.writeUInt8(options.engineType ?? 0, 20);
  datagram.writeUInt8(options.engineId ?? 0, 21);
  datagram.writeUInt16BE(
    (((options.samplingMode ?? 0) & 0b11) << 14) | ((options.samplingInterval ?? 0) & 0x3fff),
    22,
  );

  flows.forEach((flow, index) => {
    const at = HEADER_BYTES + index * RECORD_BYTES;
    datagram.writeUInt32BE(word(flow.srcAddr ?? '10.0.0.1'), at);
    datagram.writeUInt32BE(word(flow.dstAddr ?? '10.0.0.2'), at + 4);
    datagram.writeUInt32BE(word(flow.nextHop ?? '0.0.0.0'), at + 8);
    datagram.writeUInt16BE(flow.inputIf ?? 1, at + 12);
    datagram.writeUInt16BE(flow.outputIf ?? 2, at + 14);
    datagram.writeUInt32BE(flow.packets ?? 1, at + 16);
    datagram.writeUInt32BE(flow.octets ?? 64, at + 20);
    datagram.writeUInt32BE(flow.firstMs ?? 0, at + 24);
    datagram.writeUInt32BE(flow.lastMs ?? 0, at + 28);
    datagram.writeUInt16BE(flow.srcPort ?? 12345, at + 32);
    datagram.writeUInt16BE(flow.dstPort ?? 443, at + 34);
    // at + 36 is the pad byte the format never used; left zero.
    datagram.writeUInt8(flow.tcpFlags ?? 0, at + 37);
    datagram.writeUInt8(flow.protocol ?? 6, at + 38);
    datagram.writeUInt8(flow.tos ?? 0, at + 39);
    datagram.writeUInt16BE(flow.srcAs ?? 0, at + 40);
    datagram.writeUInt16BE(flow.dstAs ?? 0, at + 42);
    datagram.writeUInt8(flow.srcMask ?? 24, at + 44);
    datagram.writeUInt8(flow.dstMask ?? 24, at + 45);
    // at + 46 is two more pad bytes; left zero.
  });

  return options.truncateTo === undefined ? datagram : datagram.subarray(0, options.truncateTo);
}

/** Sends one datagram to a collector. Resolves once the socket reports it written. */
export async function exportNetflowV5(
  target: { host: string; port: number },
  flows: readonly ExportedFlow[],
  options: ExportOptions = {},
): Promise<void> {
  const datagram = renderNetflowV5(flows, options);
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(datagram, target.port, target.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}

/**
 * NetFlow v9 and IPFIX exporters (`B-03`).
 *
 * Same rule as the v5 half above: the bytes are written out against RFC 3954 and RFC 7011 rather
 * than by running the decoder backwards. The two formats differ in ways a shared encoder would
 * paper over — a 20-byte header against 16, template set 0 against 2, an enterprise bit and
 * variable-length fields that only one of them has — so each is written where it can be read
 * against its own specification.
 */

export interface TemplateFieldSpec {
  id: number;
  length: number;
  /** IPFIX only. Sets the enterprise bit and appends the private enterprise number. */
  enterprise?: number;
}

export interface TemplateSpec {
  templateId: number;
  fields: TemplateFieldSpec[];
  /** Options templates go in set 1 (v9) or 3 (IPFIX). */
  options?: boolean;
}

export interface DataSetSpec {
  templateId: number;
  /** Record payloads, already laid out to match the template. */
  records: Buffer[];
}

export interface FlowSetExportOptions {
  sysUptimeMs?: number;
  unixSecs?: number;
  sequence?: number;
  observationDomain?: number;
  /** Written into the IPFIX header regardless of the real size, to make a lying one. */
  claimLength?: number;
  /** Appended after the last set, as an exporter padding to a convenient size would. */
  trailing?: Buffer;
}

function templateSet(templates: TemplateSpec[], setId: number, ipfix: boolean): Buffer {
  const parts: Buffer[] = [];
  for (const template of templates) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(template.templateId, 0);
    head.writeUInt16BE(template.fields.length, 2);
    parts.push(head);
    for (const field of template.fields) {
      const enterprise = ipfix && field.enterprise !== undefined;
      const entry = Buffer.alloc(enterprise ? 8 : 4);
      entry.writeUInt16BE(enterprise ? field.id | 0x8000 : field.id, 0);
      entry.writeUInt16BE(field.length, 2);
      if (enterprise) entry.writeUInt32BE(field.enterprise ?? 0, 4);
      parts.push(entry);
    }
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(setId, 0);
  header.writeUInt16BE(4 + body.length, 2);
  return Buffer.concat([header, body]);
}

function dataSet(spec: DataSetSpec): Buffer {
  const body = Buffer.concat(spec.records);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(spec.templateId, 0);
  header.writeUInt16BE(4 + body.length, 2);
  return Buffer.concat([header, body]);
}

/** One v9 message: a 20-byte header, then template sets (id 0/1) and data sets (id >= 256). */
export function renderNetflowV9(
  templates: TemplateSpec[],
  data: DataSetSpec[],
  options: FlowSetExportOptions = {},
): Buffer {
  const sets: Buffer[] = [];
  const plain = templates.filter((one) => one.options !== true);
  const opts = templates.filter((one) => one.options === true);
  if (plain.length > 0) sets.push(templateSet(plain, 0, false));
  if (opts.length > 0) sets.push(templateSet(opts, 1, false));
  for (const set of data) sets.push(dataSet(set));

  const header = Buffer.alloc(20);
  header.writeUInt16BE(9, 0);
  // v9's count is records, template and data alike — informational here, since the decoder walks
  // by set length rather than trusting it.
  header.writeUInt16BE(
    templates.length + data.reduce((total, set) => total + set.records.length, 0),
    2,
  );
  header.writeUInt32BE(options.sysUptimeMs ?? 3_600_000, 4);
  header.writeUInt32BE(options.unixSecs ?? Math.floor(Date.now() / 1_000), 8);
  header.writeUInt32BE(options.sequence ?? 0, 12);
  header.writeUInt32BE(options.observationDomain ?? 0, 16);

  return Buffer.concat([header, ...sets, options.trailing ?? Buffer.alloc(0)]);
}

/** One IPFIX message: a 16-byte header carrying its own total length, then sets (id 2/3/>=256). */
export function renderIpfix(
  templates: TemplateSpec[],
  data: DataSetSpec[],
  options: FlowSetExportOptions = {},
): Buffer {
  const sets: Buffer[] = [];
  const plain = templates.filter((one) => one.options !== true);
  const opts = templates.filter((one) => one.options === true);
  if (plain.length > 0) sets.push(templateSet(plain, 2, true));
  if (opts.length > 0) sets.push(templateSet(opts, 3, true));
  for (const set of data) sets.push(dataSet(set));

  const body = Buffer.concat(sets);
  const header = Buffer.alloc(16);
  header.writeUInt16BE(10, 0);
  header.writeUInt16BE(options.claimLength ?? 16 + body.length, 2);
  header.writeUInt32BE(options.unixSecs ?? Math.floor(Date.now() / 1_000), 4);
  header.writeUInt32BE(options.sequence ?? 0, 8);
  header.writeUInt32BE(options.observationDomain ?? 0, 12);

  return Buffer.concat([header, body, options.trailing ?? Buffer.alloc(0)]);
}

/** An IPFIX variable-length field body: the length prefix RFC 7011 §7 specifies, then the bytes. */
export function variableLength(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (bytes.length < 255) return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  const prefix = Buffer.alloc(3);
  prefix.writeUInt8(255, 0);
  prefix.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
