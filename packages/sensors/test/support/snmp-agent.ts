import { createSocket, type Socket } from 'node:dgram';
import { Ber } from 'asn1-ber';

/**
 * An SNMP v1/v2c agent, on a real socket, that misbehaves on request.
 *
 * **Written rather than borrowed, and the reason is what it is for.** `net-snmp` ships an agent,
 * and pointing our session layer at it would test the library against itself — a closed loop
 * that passes whether or not we use the API correctly. More to the point, the things worth
 * testing in a session layer are the ones a well-behaved agent will not do: never answering,
 * losing the first datagram, returning a varbind that walks *backwards*, or handing back a
 * subtree with no end. Each of those is a switch here.
 *
 * This is the SNMP half of `P-06`'s harness arriving early because `T-01` needed it. When `P-06`
 * builds the rest, this is the piece to move rather than to write again.
 *
 * v3 is deliberately not implemented: USM is engine discovery, key localisation and a cipher,
 * and a wrong reimplementation in a test agent would prove nothing about our side. `t-01-v3`
 * uses `net-snmp`'s own agent for that, where a real USM conversation is the point.
 */

const Types = {
  Integer: 0x02,
  OctetString: 0x04,
  Null: 0x05,
  OID: 0x06,
  Counter: 0x41,
  Gauge: 0x42,
  TimeTicks: 0x43,
  Counter64: 0x46,
  NoSuchObject: 0x80,
  NoSuchInstance: 0x81,
  EndOfMibView: 0x82,
} as const;

const Pdu = {
  GetRequest: 0xa0,
  GetNextRequest: 0xa1,
  GetResponse: 0xa2,
  GetBulkRequest: 0xa5,
} as const;

export type AgentValueType = keyof typeof Types;

export interface AgentEntry {
  readonly oid: string;
  readonly type: AgentValueType;
  readonly value?: number | bigint | string;
}

export interface AgentBehaviour {
  /** Answer nothing, ever. What an unreachable agent and a wrong community look like. */
  readonly silent?: boolean;
  /** Drop this many requests before answering normally — one lost datagram, then a retry. */
  readonly dropFirst?: number;
  /** Reply with this SNMP error-status instead of varbinds. 2 is `noSuchName`. */
  readonly errorStatus?: number;
  /** Answer every GetNext with this OID, which is how a broken agent makes a walk spin. */
  readonly nonIncreasingOid?: string;
  /** Answer a request with bytes that are not a BER message at all. */
  readonly garbage?: boolean;
}

interface Row {
  arcs: number[];
  oid: string;
  type: AgentValueType;
  value: number | bigint | string | undefined;
}

function arcsOf(oid: string): number[] {
  return oid
    .trim()
    .replace(/^\./, '')
    .split('.')
    .map((arc) => Number(arc));
}

function compare(a: readonly number[], b: readonly number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export class TestSnmpAgent {
  readonly #socket: Socket;
  #rows: Row[] = [];
  #behaviour: AgentBehaviour = {};
  #seen = 0;
  #port = 0;
  /** Communities this agent accepts. An unknown one is met with silence, as a real agent does. */
  #communities = new Set<string>(['public']);

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('message', (message, from) => {
      this.#onMessage(message, from.address, from.port);
    });
  }

  static async start(entries: readonly AgentEntry[] = []): Promise<TestSnmpAgent> {
    const socket = createSocket('udp4');
    const agent = new TestSnmpAgent(socket);
    agent.load(entries);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      // Port 0 so tests never collide, and 127.0.0.1 so nothing leaves the machine.
      socket.bind(0, '127.0.0.1', () => {
        resolve();
      });
    });
    agent.#port = socket.address().port;
    return agent;
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return '127.0.0.1';
  }

  /** Requests this agent has received, including ones it deliberately ignored. */
  get requests(): number {
    return this.#seen;
  }

  resetCounters(): void {
    this.#seen = 0;
  }

  load(entries: readonly AgentEntry[]): void {
    this.#rows = entries
      .map((entry) => ({
        arcs: arcsOf(entry.oid),
        oid: entry.oid,
        type: entry.type,
        value: entry.value,
      }))
      .sort((a, b) => compare(a.arcs, b.arcs));
  }

  behave(behaviour: AgentBehaviour): void {
    this.#behaviour = behaviour;
    this.#seen = 0;
  }

  accept(...communities: string[]): void {
    this.#communities = new Set(communities);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#socket.close(() => {
        resolve();
      });
    });
  }

  #onMessage(message: Buffer, address: string, port: number): void {
    this.#seen += 1;
    if (this.#behaviour.silent === true) return;
    if (this.#seen <= (this.#behaviour.dropFirst ?? 0)) return;

    if (this.#behaviour.garbage === true) {
      this.#socket.send(Buffer.from([0x00, 0x01, 0x02, 0x03]), port, address);
      return;
    }

    let request: DecodedRequest;
    try {
      request = decode(message);
    } catch {
      return;
    }
    if (!this.#communities.has(request.community)) return;

    const reply = this.#answer(request);
    this.#socket.send(reply, port, address);
  }

  #answer(request: DecodedRequest): Buffer {
    if (this.#behaviour.errorStatus !== undefined) {
      return encodeResponse(request, [], this.#behaviour.errorStatus, 1);
    }

    if (request.type === Pdu.GetRequest) {
      const varbinds = request.oids.map((oid): OutVarbind => {
        const row = this.#rows.find((candidate) => candidate.oid === oid);
        return row === undefined
          ? { oid, type: 'NoSuchObject', value: undefined }
          : { oid: row.oid, type: row.type, value: row.value };
      });
      return encodeResponse(request, varbinds, 0, 0);
    }

    if (request.type === Pdu.GetNextRequest) {
      const varbinds = request.oids.map((oid) => this.#next(oid));
      return encodeResponse(request, varbinds, 0, 0);
    }

    // GetBulk: the first `nonRepeaters` OIDs get one successor each, the rest get up to
    // `maxRepetitions` successors, walking forward from where each one ended.
    const varbinds: OutVarbind[] = [];
    const nonRepeaters = Math.min(request.nonRepeaters, request.oids.length);
    for (let i = 0; i < nonRepeaters; i += 1) {
      varbinds.push(this.#next(request.oids[i] ?? ''));
    }
    for (let i = nonRepeaters; i < request.oids.length; i += 1) {
      let cursor = request.oids[i] ?? '';
      for (let step = 0; step < request.maxRepetitions; step += 1) {
        const next = this.#next(cursor);
        varbinds.push(next);
        if (next.type === 'EndOfMibView') break;
        cursor = next.oid;
      }
    }
    return encodeResponse(request, varbinds, 0, 0);
  }

  #next(oid: string): OutVarbind {
    if (this.#behaviour.nonIncreasingOid !== undefined) {
      const stuck = this.#rows[0];
      return {
        oid: this.#behaviour.nonIncreasingOid,
        type: stuck?.type ?? 'Integer',
        value: stuck?.value ?? 1,
      };
    }
    const from = arcsOf(oid);
    const row = this.#rows.find((candidate) => compare(candidate.arcs, from) > 0);
    return row === undefined
      ? { oid, type: 'EndOfMibView', value: undefined }
      : { oid: row.oid, type: row.type, value: row.value };
  }
}

interface OutVarbind {
  oid: string;
  type: AgentValueType;
  value: number | bigint | string | undefined;
}

interface DecodedRequest {
  version: number;
  community: string;
  type: number;
  requestId: number;
  nonRepeaters: number;
  maxRepetitions: number;
  oids: string[];
}

function decode(message: Buffer): DecodedRequest {
  const reader = new Ber.Reader(message);
  reader.readSequence();
  const version = reader.readInt();
  const community = reader.readString();

  const type = reader.peek();
  reader.readSequence(type);
  const requestId = reader.readInt();
  const second = reader.readInt();
  const third = reader.readInt();

  reader.readSequence();
  const oids: string[] = [];
  while (reader.remain > 0) {
    reader.readSequence();
    oids.push(reader.readOID());
    // Step over whatever value the request carried; a request's values are always Null.
    const valueType = reader.peek();
    reader.readString(valueType, true);
  }

  return {
    version,
    community,
    type,
    requestId,
    nonRepeaters: type === Pdu.GetBulkRequest ? second : 0,
    maxRepetitions: type === Pdu.GetBulkRequest ? third : 0,
    oids,
  };
}

/** Counter64 goes on the wire as up to eight big-endian bytes with no sign bit. */
function counter64Bytes(value: bigint): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  } while (remaining > 0n);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

function encodeResponse(
  request: DecodedRequest,
  varbinds: readonly OutVarbind[],
  errorStatus: number,
  errorIndex: number,
): Buffer {
  const writer = new Ber.Writer();
  writer.startSequence();
  writer.writeInt(request.version);
  writer.writeString(request.community);

  writer.startSequence(Pdu.GetResponse);
  writer.writeInt(request.requestId);
  writer.writeInt(errorStatus);
  writer.writeInt(errorIndex);

  writer.startSequence();
  for (const varbind of varbinds) {
    writer.startSequence();
    writer.writeOID(varbind.oid);
    writeValue(writer, varbind);
    writer.endSequence();
  }
  writer.endSequence();

  writer.endSequence();
  writer.endSequence();
  return writer.buffer;
}

function writeValue(writer: InstanceType<typeof Ber.Writer>, varbind: OutVarbind): void {
  const tag = Types[varbind.type];
  switch (varbind.type) {
    case 'Null':
      writer.writeNull();
      return;
    case 'NoSuchObject':
    case 'NoSuchInstance':
    case 'EndOfMibView':
      // An exception is a bare tag with a zero-length body, not a value of any kind.
      writer.writeByte(tag);
      writer.writeByte(0x00);
      return;
    case 'OctetString':
      writer.writeString(String(varbind.value ?? ''), tag);
      return;
    case 'OID':
      writer.writeOID(String(varbind.value ?? '0.0'), tag);
      return;
    case 'Counter64':
      writer.writeBuffer(counter64Bytes(BigInt(varbind.value ?? 0)), tag);
      return;
    default:
      writer.writeInt(Number(varbind.value ?? 0), tag);
  }
}
