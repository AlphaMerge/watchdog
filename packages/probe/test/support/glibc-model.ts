import { createSocket } from 'node:dgram';

/**
 * The `getaddrinfo` model the name gate's perf arms ask with (`P-432` S7, the design's §7.6): what
 * glibc sends for one lookup, and when, to one DNS server, played over real UDP so that the DNS
 * simulator's forwarder counts its questions beside the walk's. The probe's own lanes ask with it
 * in the test's process, and the lookup helper's child with it in its own
 * (`dns-world-child.ts`).
 *
 * **It is held to glibc, not to the name policy.** The table below is the model's own, never
 * `system-names.ts`, and it is held in two steps, so that a model that asked what glibc does not
 * would fail its own test, whatever the policy says:
 * - `glibcDisagreements` holds the table's wire (`glibcWire`, `glibcSchedule`) to every recording
 *   of glibc's (D30's recording (A), `test/fixtures/system-names-recordings.json`) of a row it can
 *   play: one server, one candidate, no `rotate`;
 * - and `name-lookups.test.ts`'s third block plays `glibcLookup`, the code the arms ask with, at
 *   the DNS simulator on loopback, and holds what reached it, try by try, and when it gave up, to
 *   `glibcWire` and `glibcSchedule`.
 *
 * **What it does not play.** A try that ends with some of the family's types answered and not
 * every one ends the lookup with `PARTIAL_CODE`: glibc would then send them one at a time on the
 * same try (`single-request`, then `single-request-reopen`), and answer with what it got, which no
 * recording has. No arm meets it: SNMP's family 4 asks one type.
 *
 * **It imports `node:dgram` and nothing of the repository**, so the helper's child that runs it
 * starts as fast as the production child does: the simulators' package root pulls in SSH and
 * SNMP, which would make a respawn's time the test's own (P5b).
 */

export type ModelFamily = 0 | 4 | 6;
export type ModelType = 'A' | 'AAAA';

export interface GlibcTable {
  /** The types one try asks, sent together on one socket, by family. */
  readonly types: Readonly<Record<ModelFamily, readonly ModelType[]>>;
  /** `RES_MAXRETRY`: an `attempts` above it is read as it. */
  readonly maxTries: number;
  /** send_dg floors every try's wait at a second (`timeout:0` is one). */
  readonly minWaitS: number;
  /** `RES_MAXRETRANS`: a `timeout` above it is read as it. */
  readonly maxWaitS: number;
}

/**
 * What glibc asks one server for one lookup (§7.6): A for family 4, AAAA for 6, both together for
 * 0; every type again at each try, with its first ID, a try every `timeout` seconds while none has
 * answered, and `attempts` tries. One server, one candidate: what the perf's world is.
 */
export const GLIBC_QUESTIONS: GlibcTable = {
  types: { 0: ['A', 'AAAA'], 4: ['A'], 6: ['AAAA'] },
  maxTries: 5,
  minWaitS: 1,
  maxWaitS: 30,
};

/** How many tries a silent lookup makes, and how long each waits. */
export interface GlibcSchedule {
  readonly tries: number;
  readonly waitMs: number;
}

export function glibcSchedule(
  timeoutS: number,
  attempts: number,
  table: GlibcTable = GLIBC_QUESTIONS,
): GlibcSchedule {
  return {
    tries: Math.min(Math.max(1, attempts), table.maxTries),
    waitMs: Math.min(Math.max(timeoutS, table.minWaitS), table.maxWaitS) * 1_000,
  };
}

/** One question on the wire, as the recordings keep it: server, name, type, try. */
export type WireQuestion = readonly [string, string, string, number];

/**
 * The questions the model sends for one lookup of `name` at `server`: try 1 alone when the server
 * replies to it, and every try when it is silent.
 */
export function glibcWire(
  server: string,
  name: string,
  family: ModelFamily,
  plan: 'replied' | 'silent',
  schedule: GlibcSchedule,
  table: GlibcTable = GLIBC_QUESTIONS,
): WireQuestion[] {
  const wire: WireQuestion[] = [];
  const tries = plan === 'replied' ? 1 : schedule.tries;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    for (const type of table.types[family]) wire.push([server, name, type, attempt]);
  }
  return wire;
}

// --- The table held to the recordings --------------------------------------------------------

/** What `system-names-rows.json` says of one row, as far as the model reads it. */
export interface RecordedRow {
  readonly id: string;
  readonly title: string;
  readonly world: {
    readonly env: Readonly<Record<string, string>>;
    readonly files: Readonly<Record<string, string>>;
  };
  readonly question: { readonly name: string; readonly family: number };
  readonly expect: {
    readonly class: string;
    readonly candidates?: readonly string[];
    readonly servers: readonly string[];
    readonly rotate: boolean;
  };
}

export interface RecordedRows {
  readonly texts: Readonly<Record<string, string>>;
  readonly rows: readonly RecordedRow[];
}

/** One plan of one row in one image, as `system-names-recordings.json` keeps it. */
export interface Recording {
  readonly id: string;
  readonly image: string;
  readonly plan: string;
  readonly wire: readonly (readonly [string, string, string, number])[];
  readonly outcome: string;
  readonly ms: number;
}

/** The plans the model plays: the server replies to the first try, or to none. */
const PLANS: Readonly<Record<string, 'replied' | 'silent'>> = {
  answer: 'replied',
  nxdomain: 'replied',
  'all-silent': 'silent',
};

/** resolv.conf's `timeout` and `attempts`, the last word winning, and glibc's 5 and 2 unset. */
export function resolvOptions(text: string): {
  readonly timeout: number;
  readonly attempts: number;
} {
  let timeout = 5;
  let attempts = 2;
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/u);
    if (words[0] !== 'options') continue;
    for (const word of words.slice(1)) {
      const said = /^(timeout|attempts):(\d+)$/u.exec(word);
      if (said === null) continue;
      if (said[1] === 'timeout') timeout = Number(said[2]);
      else attempts = Number(said[2]);
    }
  }
  return { timeout, attempts };
}

export interface GlibcHeld {
  /** Recordings compared, by the row's family, and those of a silent plan. */
  readonly byFamily: Readonly<Record<ModelFamily, number>>;
  readonly silent: number;
  /** The images a recording was compared in, by family, sorted. */
  readonly images: Readonly<Record<ModelFamily, readonly string[]>>;
  /** The images a silent plan's recording was compared in, sorted. */
  readonly silentImages: readonly string[];
  /** Each recording the table does not predict, said in words. */
  readonly disagreements: readonly string[];
}

/**
 * Holds a table to every recording of a row the model can play: a walk with one server, one
 * candidate, no `rotate` and nothing in the environment, under a plan it plays. The wire must be
 * the table's exactly, in order, try by try; a silent plan must also have taken its tries' waits,
 * and less than a second more.
 */
export function glibcDisagreements(
  rows: RecordedRows,
  recordings: readonly Recording[],
  table: GlibcTable = GLIBC_QUESTIONS,
): GlibcHeld {
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const byFamily: Record<ModelFamily, number> = { 0: 0, 4: 0, 6: 0 };
  const images: Record<ModelFamily, Set<string>> = { 0: new Set(), 4: new Set(), 6: new Set() };
  const silentImages = new Set<string>();
  let silent = 0;
  const disagreements: string[] = [];
  for (const recording of recordings) {
    const row = byId.get(recording.id);
    const plan = PLANS[recording.plan];
    if (row === undefined || plan === undefined) continue;
    const { expect, question, world } = row;
    const family = question.family;
    if (family !== 0 && family !== 4 && family !== 6) continue;
    if (expect.class !== 'walk' || expect.rotate || expect.servers.length !== 1) continue;
    if (expect.candidates?.length !== 1 || Object.keys(world.env).length > 0) continue;
    const server = expect.servers[0] ?? '';
    const candidate = expect.candidates[0] ?? '';
    const conf = rows.texts[world.files['/etc/resolv.conf'] ?? ''] ?? '';
    const { timeout, attempts } = resolvOptions(conf);
    const schedule = glibcSchedule(timeout, attempts, table);
    const predicted = glibcWire(server, candidate, family, plan, schedule, table);
    byFamily[family] += 1;
    images[family].add(recording.image);
    const where = `${row.title}, family ${String(family)}, ${recording.plan}, in ${recording.image}`;
    if (JSON.stringify(predicted) !== JSON.stringify(recording.wire)) {
      disagreements.push(
        `${where}: the model sends ${JSON.stringify(predicted)}, glibc sent ${JSON.stringify(recording.wire)}`,
      );
    }
    if (plan === 'silent') {
      silent += 1;
      silentImages.add(recording.image);
      const waited = schedule.tries * schedule.waitMs;
      if (recording.ms < waited || recording.ms >= waited + 1_000) {
        disagreements.push(
          `${where}: the model gives up after ${String(waited)} ms, glibc after ${String(recording.ms)} ms`,
        );
      }
    }
  }
  const sortedOf = (set: ReadonlySet<string>): string[] => [...set].sort();
  return {
    byFamily,
    silent,
    images: { 0: sortedOf(images[0]), 4: sortedOf(images[4]), 6: sortedOf(images[6]) },
    silentImages: sortedOf(silentImages),
    disagreements,
  };
}

/**
 * Where a hold falls short of every image the fixture was recorded in (`images`): a family, or
 * the silent plans, compared in none of an image's recordings, said in words. A count would not
 * do: one image's recordings alone clear any floor a count could set.
 */
export function glibcCoverageGaps(held: GlibcHeld, images: readonly string[]): string[] {
  const gaps: string[] = [];
  const missing = (seen: readonly string[]): string[] =>
    images.filter((image) => !seen.includes(image));
  for (const family of [0, 4, 6] as const) {
    for (const image of missing(held.images[family])) {
      gaps.push(`family ${String(family)} compared in no recording of ${image}`);
    }
  }
  for (const image of missing(held.silentImages)) {
    gaps.push(`no silent plan compared in ${image}`);
  }
  return gaps;
}

// --- The model on the wire -------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<ModelType, number>> = { A: 1, AAAA: 28 };

function encodeQuery(id: number, name: string, type: ModelType): Buffer {
  const labels = name === '' ? [] : name.split('.');
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD, as a stub sets
  header.writeUInt16BE(1, 4);
  parts.push(header);
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  const tail = Buffer.alloc(5);
  tail.writeUInt8(0, 0);
  tail.writeUInt16BE(TYPE_CODE[type], 1);
  tail.writeUInt16BE(1, 3);
  parts.push(tail);
  return Buffer.concat(parts);
}

interface DecodedReply {
  readonly id: number;
  readonly rcode: number;
  readonly name: string;
  readonly type: number;
  readonly addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
}

/** A name's end in `message` from `at`, and its text when it is not compressed. */
function readName(message: Buffer, at: number): { readonly end: number; readonly name: string } {
  const labels: string[] = [];
  let offset = at;
  for (;;) {
    const length = message.readUInt8(offset);
    if (length === 0) return { end: offset + 1, name: labels.join('.') };
    if ((length & 0xc0) === 0xc0) {
      const pointer = message.readUInt16BE(offset) & 0x3fff;
      return { end: offset + 2, name: [...labels, readName(message, pointer).name].join('.') };
    }
    labels.push(message.toString('ascii', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
}

function formatV6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

function decodeReply(message: Buffer): DecodedReply | undefined {
  try {
    if (message.length < 12) return undefined;
    const flags = message.readUInt16BE(2);
    if ((flags & 0x8000) === 0) return undefined;
    const questions = message.readUInt16BE(4);
    const answers = message.readUInt16BE(6);
    if (questions !== 1) return undefined;
    const asked = readName(message, 12);
    const type = message.readUInt16BE(asked.end);
    let offset = asked.end + 4;
    const addresses: { address: string; family: 4 | 6 }[] = [];
    for (let i = 0; i < answers; i += 1) {
      offset = readName(message, offset).end;
      const recordType = message.readUInt16BE(offset);
      const length = message.readUInt16BE(offset + 8);
      const data = message.subarray(offset + 10, offset + 10 + length);
      if (recordType === 1 && length === 4)
        addresses.push({ address: [...data].join('.'), family: 4 });
      if (recordType === 28 && length === 16)
        addresses.push({ address: formatV6(data), family: 6 });
      offset += 10 + length;
    }
    return {
      id: message.readUInt16BE(0),
      rcode: flags & 0x000f,
      name: asked.name,
      type,
      addresses,
    };
  } catch {
    return undefined;
  }
}

export interface ModelServer {
  readonly address: string;
  readonly port: number;
}

export interface GlibcModelOptions {
  readonly server: ModelServer;
  /** The source address, so the simulator's log tells the probe's lanes from the helper's. */
  readonly localAddress: string;
  readonly schedule: GlibcSchedule;
  readonly table?: GlibcTable;
  /** Told as each try's datagrams are with the kernel, in the same turn. */
  readonly onSent?: (host: string, attempt: number) => void;
}

/** The address one lookup gave, as `getaddrinfo`'s callers read it. */
export interface ModelAddress {
  readonly address: string;
  readonly family: number;
}

function failure(code: string, host: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${host}`), {
    code,
    syscall: 'getaddrinfo',
    hostname: host,
  });
}

const NOERROR = 0;
const NXDOMAIN = 3;

/**
 * The code a lookup ends with when a try ends with some of its types answered and not every one,
 * where glibc would ask them again one at a time (see the file's docstring): never `EAI_AGAIN`,
 * so that an arm meeting it reads a failure of its own, and never a code the resolver knows.
 */
export const PARTIAL_CODE = 'EMODELPARTIAL';

/** The model, and its teardown. */
export interface GlibcModel {
  /** `getaddrinfo` as the model plays it (`glibcLookup`). */
  readonly lookup: (host: string, family: ModelFamily) => Promise<readonly ModelAddress[]>;
  /** Lookups open now, each with its socket and its timer. */
  inFlight(): number;
  /**
   * Ends every open lookup now with `EAI_AGAIN`, its timer cleared and its socket closed, and
   * fails every later one the same way before it opens a socket. A lookup holds its timer for up
   * to `tries` × `waitMs`, and a resolver that has stopped still starts what it has queued, so a
   * world that stops without it leaves sockets and timers running into the next arm.
   */
  close(): void;
}

/**
 * `getaddrinfo` as the model plays it: one socket a lookup; every type of the family sent together
 * at each try, each with its own ID, which every try sends again; the lookup ends once every type
 * has a reply, or when the last try's wait runs out (`EAI_AGAIN`). A SERVFAIL or REFUSED ends the
 * try at once, as glibc moves to the next server and, with one, to the next try. Addresses
 * answer; NXDOMAIN is `ENOTFOUND` and NODATA `ENODATA`; a try that ends with only some types
 * answered is `PARTIAL_CODE`.
 */
export function glibcLookup(options: GlibcModelOptions): GlibcModel {
  const table = options.table ?? GLIBC_QUESTIONS;
  const open = new Set<() => void>();
  let closed = false;
  const lookup = (host: string, family: ModelFamily): Promise<readonly ModelAddress[]> =>
    new Promise<readonly ModelAddress[]>((resolve, reject) => {
      if (closed) {
        reject(failure('EAI_AGAIN', host));
        return;
      }
      const name = host.length > 1 && host.endsWith('.') ? host.slice(0, -1) : host;
      const types = table.types[family];
      const first = Math.floor(Math.random() * 0x10000);
      const ids = types.map((_, index) => (first + index) & 0xffff);
      const replies = new Map<number, DecodedReply>();
      const socket = createSocket('udp4');
      let attempt = 0;
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (error: Error | undefined, addresses?: readonly ModelAddress[]): void => {
        if (done) return;
        done = true;
        open.delete(end);
        clearTimeout(timer);
        socket.close();
        if (error === undefined) resolve(addresses ?? []);
        else reject(error);
      };
      const end = (): void => {
        finish(failure('EAI_AGAIN', host));
      };
      open.add(end);
      // A lookup closed while its socket binds sends nothing: dgram drops the bind's callback for a
      // socket closed before it is bound.
      const next = (): void => {
        clearTimeout(timer);
        if (replies.size > 0) {
          finish(failure(PARTIAL_CODE, host));
          return;
        }
        if (attempt >= options.schedule.tries) {
          finish(failure('EAI_AGAIN', host));
          return;
        }
        attempt += 1;
        const sending = attempt;
        let left = types.length;
        types.forEach((type, index) => {
          socket.send(
            encodeQuery(ids[index] ?? 0, name, type),
            options.server.port,
            options.server.address,
            (error) => {
              if (error !== null) {
                finish(failure('EAI_AGAIN', host));
                return;
              }
              left -= 1;
              if (left === 0) options.onSent?.(host, sending);
            },
          );
        });
        timer = setTimeout(next, options.schedule.waitMs);
      };
      socket.on('error', () => {
        finish(failure('EAI_AGAIN', host));
      });
      socket.on('message', (message) => {
        const reply = decodeReply(message);
        if (reply === undefined || reply.name.toLowerCase() !== name.toLowerCase()) return;
        const index = ids.indexOf(reply.id);
        if (index < 0 || replies.has(index) || reply.type !== TYPE_CODE[types[index] ?? 'A']) {
          return;
        }
        if (reply.rcode !== NOERROR && reply.rcode !== NXDOMAIN) {
          // SERVFAIL, REFUSED: the next try, at once, and every type again.
          replies.clear();
          next();
          return;
        }
        replies.set(index, reply);
        if (replies.size < types.length) return;
        const addresses = [...replies.values()].flatMap((said) => said.addresses);
        if (addresses.length > 0) finish(undefined, addresses);
        else if ([...replies.values()].some((said) => said.rcode === NXDOMAIN)) {
          finish(failure('ENOTFOUND', host));
        } else finish(failure('ENODATA', host));
      });
      socket.bind({ address: options.localAddress, port: 0 }, next);
    });
  return {
    lookup,
    inFlight: () => open.size,
    close: () => {
      closed = true;
      for (const end of [...open]) end();
    },
  };
}

// --- The world the helper's child is told of -------------------------------------------------

/** The environment variable the helper's child reads its world from (not `MS_*` or `NODE_*`). */
export const WORLD_ENV = 'PERF_DNS_WORLD';

export interface ChildWorld {
  readonly server: ModelServer;
  readonly localAddress: string;
  readonly schedule: GlibcSchedule;
  /** A pattern for names whose `getaddrinfo` crashes the child (P6). */
  readonly crash?: string;
}

export function readWorld(raw: string | undefined): ChildWorld {
  if (raw === undefined) throw new Error(`the perf child needs ${WORLD_ENV}`);
  return JSON.parse(raw) as ChildWorld;
}
