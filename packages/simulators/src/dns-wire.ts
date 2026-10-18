import { isIPv4, isIPv6 } from 'node:net';

/**
 * DNS on the wire for the DNS simulator and its clients (`P-432`): as much of RFC 1035, and of
 * RFC 6891's OPT record, as a recursor answering A, AAAA and CNAME needs.
 *
 * **Written here, not borrowed from the code under test.** The probe's walk asks with c-ares and
 * reads replies through it, so a harness that encoded its replies with c-ares, or with a library
 * the probe also uses, would pass whether or not either side spoke DNS (the rule in `index.ts`).
 *
 * Names are kept byte for byte (`latin1`), so a reply carries the question exactly as it was
 * asked: c-ares compares the two, and a resolver that folded case would answer a different name.
 */

export const DNS_TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  ANY: 255,
} as const;

export const DNS_RCODES = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

export type DnsRcodeName = keyof typeof DNS_RCODES;

const TYPE_BY_NAME = new Map<string, number>(Object.entries(DNS_TYPES));
const TYPE_BY_CODE = new Map<number, string>(
  Object.entries(DNS_TYPES).map(([name, code]) => [code, name]),
);
const RCODE_BY_CODE = new Map<number, string>(
  Object.entries(DNS_RCODES).map(([name, code]) => [code, name]),
);

/** `1` is `A`; a type this file has no name for is RFC 3597's `TYPE<n>`. */
export function typeName(code: number): string {
  return TYPE_BY_CODE.get(code) ?? `TYPE${String(code)}`;
}

/** `A`, `aaaa` or `TYPE65` to its code. */
export function typeCode(name: string): number {
  const upper = name.toUpperCase();
  const known = TYPE_BY_NAME.get(upper);
  if (known !== undefined) return known;
  const generic = /^TYPE(\d{1,5})$/u.exec(upper)?.[1];
  if (generic !== undefined && Number(generic) <= 0xffff) return Number(generic);
  throw new Error(`${name} is not a DNS type`);
}

export function rcodeName(code: number): string {
  return RCODE_BY_CODE.get(code) ?? `RCODE${String(code)}`;
}

/** A message this file cannot read: the server answers FORMERR, a client reports it. */
export class WireError extends Error {}

export interface DnsHeader {
  readonly id: number;
  readonly qr: boolean;
  readonly opcode: number;
  readonly aa: boolean;
  readonly tc: boolean;
  readonly rd: boolean;
  readonly ra: boolean;
  readonly rcode: number;
}

export interface DnsQuestion {
  /**
   * As it was on the wire, case and all, without the root's trailing dot. Labels are joined with
   * `.`, so a label holding a 0x2E byte (RFC 2181 §11 allows any octet) reads as two here; `wire`
   * keeps it as one.
   */
  readonly name: string;
  readonly type: number;
  readonly class: number;
  /** The name's labels exactly as they came, ending in the root's 0, for a reply to echo. */
  readonly wire?: Buffer;
}

export interface DnsRecord {
  readonly name: string;
  readonly type: number;
  readonly class: number;
  readonly ttl: number;
  /** An address for A and AAAA, a name for CNAME, NS and PTR; nothing for anything else. */
  readonly data: string | undefined;
}

export interface DnsMessage {
  readonly header: DnsHeader;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
  readonly additional: readonly DnsRecord[];
  /** RFC 6891's pseudo-record, when the message carried one, with its options' codes (10 is a cookie). */
  readonly opt: { readonly udpSize: number; readonly options: readonly number[] } | undefined;
}

class Reader {
  #at = 0;
  constructor(private readonly buf: Buffer) {}

  #need(bytes: number): void {
    if (this.#at + bytes > this.buf.length) throw new WireError('the message ends early');
  }

  u8(): number {
    this.#need(1);
    return this.buf.readUInt8(this.#at++);
  }

  u16(): number {
    this.#need(2);
    const value = this.buf.readUInt16BE(this.#at);
    this.#at += 2;
    return value;
  }

  u32(): number {
    this.#need(4);
    const value = this.buf.readUInt32BE(this.#at);
    this.#at += 4;
    return value;
  }

  bytes(count: number): Buffer {
    this.#need(count);
    const slice = this.buf.subarray(this.#at, this.#at + count);
    this.#at += count;
    return slice;
  }

  name(): string {
    return this.nameWire().name;
  }

  /**
   * A name, following compression pointers (RFC 1035 §4.1.4) without looping on a bad one, and
   * its labels as bytes, uncompressed, which is what a reply echoes.
   */
  nameWire(): { name: string; wire: Buffer } {
    const labels: string[] = [];
    const raw: Buffer[] = [];
    let at = this.#at;
    let jumped = false;
    for (let hops = 0; hops < 128; hops += 1) {
      if (at >= this.buf.length) throw new WireError('a name runs past the message');
      const length = this.buf.readUInt8(at);
      if (length === 0) {
        if (!jumped) this.#at = at + 1;
        raw.push(Buffer.from([0]));
        return { name: labels.join('.'), wire: Buffer.concat(raw) };
      }
      if ((length & 0xc0) === 0xc0) {
        if (at + 1 >= this.buf.length) throw new WireError('a name pointer runs past the message');
        const target = ((length & 0x3f) << 8) | this.buf.readUInt8(at + 1);
        if (!jumped) this.#at = at + 2;
        jumped = true;
        at = target;
        continue;
      }
      if ((length & 0xc0) !== 0) throw new WireError('a label has a reserved length form');
      if (at + 1 + length > this.buf.length) throw new WireError('a label runs past the message');
      labels.push(this.buf.toString('latin1', at + 1, at + 1 + length));
      raw.push(this.buf.subarray(at, at + 1 + length));
      at += 1 + length;
    }
    throw new WireError('a name has too many pointers');
  }
}

function readHeader(reader: Reader): DnsHeader & { counts: [number, number, number, number] } {
  const id = reader.u16();
  const flags = reader.u16();
  const counts: [number, number, number, number] = [
    reader.u16(),
    reader.u16(),
    reader.u16(),
    reader.u16(),
  ];
  return {
    id,
    qr: (flags & 0x8000) !== 0,
    opcode: (flags >> 11) & 0xf,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    rcode: flags & 0xf,
    counts,
  };
}

function readRecord(reader: Reader, message: Buffer): { record: DnsRecord; rdata: Buffer } {
  const name = reader.name();
  const type = reader.u16();
  const klass = reader.u16();
  const ttl = reader.u32();
  const length = reader.u16();
  const rdata = reader.bytes(length);
  let data: string | undefined;
  if (type === DNS_TYPES.A && length === 4) data = [...rdata].join('.');
  else if (type === DNS_TYPES.AAAA && length === 16) data = formatV6(rdata);
  else if (type === DNS_TYPES.CNAME || type === DNS_TYPES.NS || type === DNS_TYPES.PTR) {
    // A name in rdata may point anywhere in the message, so it is read against the whole of it.
    const offset = rdata.byteOffset - message.byteOffset;
    const inner = new Reader(message);
    inner.bytes(offset);
    data = inner.name();
  }
  return { record: { name, type, class: klass, ttl, data }, rdata };
}

/** The option codes in an OPT record's data: code, length, value, repeated (RFC 6891 §6.1.2). */
function optionCodes(rdata: Buffer): number[] {
  const codes: number[] = [];
  for (let at = 0; at + 4 <= rdata.length; at += 4 + rdata.readUInt16BE(at + 2)) {
    codes.push(rdata.readUInt16BE(at));
  }
  return codes;
}

/** Any DNS message, query or reply. Throws `WireError` on one it cannot read. */
export function decodeMessage(message: Buffer): DnsMessage {
  const reader = new Reader(message);
  const { counts, ...header } = readHeader(reader);
  const questions: DnsQuestion[] = [];
  for (let index = 0; index < counts[0]; index += 1) {
    const { name, wire } = reader.nameWire();
    questions.push({ name, wire, type: reader.u16(), class: reader.u16() });
  }
  const sections: DnsRecord[][] = [[], [], []];
  let opt: DnsMessage['opt'];
  for (const [section, count] of [counts[1], counts[2], counts[3]].entries()) {
    for (let index = 0; index < count; index += 1) {
      const { record, rdata } = readRecord(reader, message);
      if (section === 2 && record.type === DNS_TYPES.OPT) {
        opt = { udpSize: record.class, options: optionCodes(rdata) };
      } else {
        sections[section]?.push(record);
      }
    }
  }
  const [answers = [], authority = [], additional = []] = sections;
  return { header, questions, answers, authority, additional, opt };
}

class Writer {
  readonly #parts: Buffer[] = [];

  u16(value: number): this {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(value & 0xffff);
    this.#parts.push(buf);
    return this;
  }

  u32(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0);
    this.#parts.push(buf);
    return this;
  }

  bytes(buf: Buffer): this {
    this.#parts.push(buf);
    return this;
  }

  done(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

/** A name as labels, uncompressed. `''` and `.` are the root. */
export function encodeName(name: string): Buffer {
  const labels = name === '.' ? [] : name.replace(/\.$/u, '').split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    if (label === '') {
      if (labels.length === 1) break;
      throw new Error(`${name} has an empty label`);
    }
    const bytes = Buffer.from(label, 'latin1');
    if (bytes.length > 63) throw new Error(`${name} has a label over 63 bytes`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function flags(header: Omit<DnsHeader, 'id'>): number {
  return (
    (header.qr ? 0x8000 : 0) |
    ((header.opcode & 0xf) << 11) |
    (header.aa ? 0x0400 : 0) |
    (header.tc ? 0x0200 : 0) |
    (header.rd ? 0x0100 : 0) |
    (header.ra ? 0x0080 : 0) |
    (header.rcode & 0xf)
  );
}

export interface EdnsOption {
  readonly code: number;
  readonly data: Buffer;
}

/** RFC 6891's OPT record: root owner, the UDP size in the class field, then any options. */
function optRecord(udpSize: number, options: readonly EdnsOption[] = []): Buffer {
  const rdata = new Writer();
  for (const option of options) rdata.u16(option.code).u16(option.data.length).bytes(option.data);
  const data = rdata.done();
  return new Writer()
    .bytes(Buffer.from([0]))
    .u16(DNS_TYPES.OPT)
    .u16(udpSize)
    .u32(0)
    .u16(data.length)
    .bytes(data)
    .done();
}

export interface QuerySpec {
  readonly id: number;
  readonly name: string;
  readonly type: number;
  /** Recursion desired: what a stub sets. Default true. */
  readonly rd?: boolean;
  /**
   * Carry an OPT record, with these options if given: what glibc sends under `options edns0`.
   * Node's `dns.Resolver`, the probe's walk, sends none: Node sets `ARES_OPT_FLAGS`, and c-ares
   * turns EDNS on by default only for a caller that sets no flags (measured on Node 22 and 24).
   */
  readonly opt?: boolean | { readonly options: readonly EdnsOption[] };
}

export function encodeQuery(query: QuerySpec): Buffer {
  const header = flags({
    qr: false,
    opcode: 0,
    aa: false,
    tc: false,
    rd: query.rd ?? true,
    ra: false,
    rcode: 0,
  });
  const writer = new Writer()
    .u16(query.id)
    .u16(header)
    .u16(1)
    .u16(0)
    .u16(0)
    .u16(query.opt === undefined || query.opt === false ? 0 : 1)
    .bytes(encodeName(query.name))
    .u16(query.type)
    .u16(1);
  if (query.opt !== undefined && query.opt !== false) {
    writer.bytes(optRecord(1232, query.opt === true ? [] : query.opt.options));
  }
  return writer.done();
}

export interface ReplyAnswer {
  readonly name: string;
  readonly type: 'A' | 'AAAA' | 'CNAME';
  readonly ttl: number;
  /** The address, or the CNAME's target. */
  readonly data: string;
}

export interface ReplySpec {
  readonly id: number;
  readonly opcode: number;
  readonly rd: boolean;
  readonly rcode: number;
  readonly tc: boolean;
  readonly question: DnsQuestion | undefined;
  readonly answers: readonly ReplyAnswer[];
  /** Answer the OPT a query carried with one of our own, as an EDNS server does. */
  readonly opt: boolean;
}

export function encodeReply(reply: ReplySpec): Buffer {
  const header = flags({
    qr: true,
    opcode: reply.opcode,
    aa: false,
    tc: reply.tc,
    rd: reply.rd,
    ra: true,
    rcode: reply.rcode,
  });
  const writer = new Writer()
    .u16(reply.id)
    .u16(header)
    .u16(reply.question === undefined ? 0 : 1)
    .u16(reply.answers.length)
    .u16(0)
    .u16(reply.opt ? 1 : 0);
  if (reply.question !== undefined) {
    writer
      .bytes(reply.question.wire ?? encodeName(reply.question.name))
      .u16(reply.question.type)
      .u16(reply.question.class);
  }
  for (const answer of reply.answers) {
    const rdata =
      answer.type === 'A'
        ? Buffer.from(answer.data.split('.').map(Number))
        : answer.type === 'AAAA'
          ? v6Bytes(answer.data)
          : encodeName(answer.data);
    writer
      .bytes(
        // The question's own owner name goes back as the bytes it came in, as the question does.
        reply.question?.wire !== undefined && answer.name === reply.question.name
          ? reply.question.wire
          : encodeName(answer.name),
      )
      .u16(DNS_TYPES[answer.type])
      .u16(1)
      .u32(answer.ttl)
      .u16(rdata.length)
      .bytes(rdata);
  }
  if (reply.opt) writer.bytes(optRecord(1232));
  return writer.done();
}

/** An IPv6 address as 16 bytes: `::` and an IPv4 tail are understood, a zone id is not. */
export function v6Bytes(address: string): Buffer {
  if (!isIPv6(address) || address.includes('%'))
    throw new Error(`${address} is not an IPv6 address`);
  const groups = (text: string): number[] => {
    if (text === '') return [];
    const parts = text.split(':');
    const last = parts[parts.length - 1] ?? '';
    const tail = isIPv4(last) ? last.split('.').map(Number) : undefined;
    const hex = (tail === undefined ? parts : parts.slice(0, -1)).map((part) => parseInt(part, 16));
    if (tail !== undefined) {
      const [a = 0, b = 0, c = 0, d = 0] = tail;
      hex.push((a << 8) | b, (c << 8) | d);
    }
    return hex;
  };
  const [head = '', rest] = address.split('::');
  const before = groups(head);
  const after = rest === undefined ? [] : groups(rest);
  const zeros = new Array<number>(8 - before.length - after.length).fill(0);
  const buf = Buffer.alloc(16);
  [...before, ...(rest === undefined ? [] : zeros), ...after].forEach((group, index) => {
    buf.writeUInt16BE(group, index * 2);
  });
  return buf;
}

/** 16 bytes as RFC 5952 text: lower case, the longest run of zero groups as `::`. */
export function formatV6(bytes: Buffer): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index));
  let bestAt = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length += 1;
    if (length > bestLength) {
      bestAt = start;
      bestLength = length;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestAt < 0) return hex.join(':');
  return `${hex.slice(0, bestAt).join(':')}::${hex.slice(bestAt + bestLength).join(':')}`;
}

/** A message as DNS over TCP sends it: a two-byte length, then the message (RFC 1035 §4.2.2). */
export function frame(message: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(message.length);
  return Buffer.concat([length, message]);
}

/** Splits a TCP byte stream back into messages, however the stream was cut. */
export class Deframer {
  #pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const messages: Buffer[] = [];
    while (this.#pending.length >= 2) {
      const length = this.#pending.readUInt16BE(0);
      if (this.#pending.length < 2 + length) break;
      messages.push(this.#pending.subarray(2, 2 + length));
      this.#pending = this.#pending.subarray(2 + length);
    }
    return messages;
  }
}
