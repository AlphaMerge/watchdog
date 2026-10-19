import { isDeepStrictEqual } from 'node:util';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * The differential's judgement (`P-432` S8, the design's D30 and §7.5): what glibc sent for each
 * of S4's exported rows, in each image, against what the gate's name policy says it sends.
 *
 * **Everything here is pure**, so it is unit-tested on the toolchain and run unchanged in the
 * images: `names-replay.ts` sets each row's world up in an image, plays each plan with the S5
 * simulator as every server, and hands the questions it saw here; `names-verify.ts` takes every
 * image's run and writes the recordings, or fails naming every row that disagreed.
 *
 * **What a row claims** (`test/fixtures/system-names-rows.json`, written by `system-names.test`):
 * in its world, `GlibcNamePolicy` classifies the question as it says (`class`, `via`, the
 * candidates in order and the types asked of each, the servers in order and `rotate`), and for each
 * plan (what every server answers) glibc sends exactly the plan's wire. A `local` row's wire is
 * empty: glibc answers it without asking DNS. A walked row's wire is every question, in order, at
 * the server it went to, with its try. So a row disagrees when:
 * - the policy, loaded in the image against the row's real files, classifies the question
 *   otherwise than the row says (the export is stale, or the image is not the world: a module
 *   missing, nscd running, another glibc);
 * - glibc asked DNS for a `local` name, or did not for a walked one;
 * - glibc asked another candidate, another type, another server, in another order, or again.
 *
 * **Under `rotate`** glibc starts its first send at a server chosen at random
 * (resolv/res_send.c `nameserver_offset`), so a rotating plan's wire is one of `wireByOffset`, and
 * the recording keeps which.
 */

export type QType = 'A' | 'AAAA';
export type Reply = 'nxdomain' | 'servfail' | 'refused' | 'silent' | 'address';
/** `[server, name, type, try]`, `try` from 1. A question over TCP has its server as `<server>/tcp`. */
export type Wire = readonly [string, string, string, number];

export interface Plan {
  readonly plan: string;
  readonly answers: Readonly<Record<string, Readonly<Partial<Record<QType, Reply>>>>>;
  readonly wire?: readonly Wire[];
  readonly wireByOffset?: readonly (readonly Wire[])[];
}

/** What a row says of a question at one glibc, its plans aside. */
export interface Classification {
  readonly class: string;
  readonly via?: string;
  readonly reason?: string;
  readonly candidates?: readonly string[];
  readonly types?: readonly string[];
  readonly servers: readonly string[];
  readonly rotate: boolean;
}

export interface Expectation extends Classification {
  readonly plans: readonly Plan[];
}

export interface World {
  readonly glibc: string;
  readonly hostname: string;
  readonly env: Readonly<Record<string, string>>;
  /** Each system path to a text id; a path not listed is absent. */
  readonly files: Readonly<Record<string, string>>;
  readonly missingModules: readonly string[];
  readonly addresses: readonly string[];
  readonly ipv6: boolean;
}

export interface Row {
  readonly id: string;
  readonly title: string;
  readonly world: World;
  readonly question: { readonly name: string; readonly family: 0 | 4 | 6 };
  readonly expect: Expectation;
  readonly byImage: Readonly<Record<string, Expectation | null>>;
}

export interface RowsFile {
  readonly schema: number;
  readonly images: Readonly<Record<string, string>>;
  readonly texts: Readonly<Record<string, string>>;
  readonly rows: readonly Row[];
}

/** What the policy, loaded in the image, made of a row's question: a class, or the check off. */
export type InImage =
  ({ readonly off?: undefined } & Classification) | { readonly off: string; readonly class: 'off' };

/** One question a server saw, in the order the servers saw them. */
export interface Asked {
  readonly server: string;
  readonly qname: string;
  readonly qtype: string;
  readonly transport: 'udp' | 'tcp';
}

/** One plan played: the questions glibc sent, how `getaddrinfo` ended, and how long it took. */
export interface PlanRun {
  readonly plan: string;
  readonly wire: readonly Wire[];
  /** `answer` with the addresses' count, or the error code. */
  readonly outcome: string;
  readonly ms: number;
  /** Through systemd-resolved: what resolved asked its upstream, for the record, never judged. */
  readonly upstream?: readonly Wire[];
}

export interface RowRun {
  readonly id: string;
  readonly inImage: InImage;
  readonly plans: readonly PlanRun[];
  /** What kept the row from being played as its world says: it is then unverified. */
  readonly setup?: readonly string[];
}

/** One image's run, as `names-replay.ts` prints it. */
export interface ImageRun {
  readonly image: string;
  /** glibc's runtime version, from `process.report`. */
  readonly glibc: string | undefined;
  readonly node: string;
  readonly base: string;
  readonly digest: string;
  /** Whether systemd-resolved served the stub (127.0.0.53) for this run. */
  readonly resolved: boolean;
  readonly rows: readonly RowRun[];
}

/** A wire glibc sent for a row's plan in an image (`system-names-recordings.json`, schema 1). */
export interface Recording {
  readonly id: string;
  readonly image: string;
  readonly plan: string;
  readonly offset?: number;
  readonly wire: readonly Wire[];
  readonly outcome: string;
  readonly ms: number;
}

export interface RecordingsFile {
  readonly schema: 1;
  readonly images: Readonly<
    Record<
      string,
      {
        readonly base: string;
        readonly digest: string;
        readonly glibc: string;
        readonly node: string;
        readonly resolved: boolean;
      }
    >
  >;
  readonly recordings: readonly Recording[];
}

/** The row's expectation in an image: null where the check is off there, so it is not replayed. */
export function expectationIn(row: Row, image: string): Expectation | null {
  return Object.hasOwn(row.byImage, image) ? (row.byImage[image] ?? null) : row.expect;
}

/** The questions as a wire: each one's try is how many times that server was asked it before, plus 1. */
export function wireOf(asked: readonly Asked[]): Wire[] {
  const seen = new Map<string, number>();
  return asked.map((one): Wire => {
    const server = one.transport === 'tcp' ? `${one.server}/tcp` : one.server;
    const key = JSON.stringify([server, one.qname, one.qtype]);
    const tries = (seen.get(key) ?? 0) + 1;
    seen.set(key, tries);
    return [server, one.qname, one.qtype, tries];
  });
}

const CLASS_FIELDS = [
  'class',
  'via',
  'reason',
  'candidates',
  'types',
  'servers',
  'rotate',
] as const;

/** Why the policy in the image read the question otherwise than the row says, or undefined. */
export function classificationProblem(e: Classification, inImage: InImage): string | undefined {
  if (inImage.off !== undefined) return `the check is off in the image: ${inImage.off}`;
  for (const field of CLASS_FIELDS) {
    if (!isDeepStrictEqual(e[field], inImage[field])) {
      return (
        `the policy in the image reads ${field} as ${JSON.stringify(inImage[field])}, ` +
        `the row says ${JSON.stringify(e[field])}`
      );
    }
  }
  return undefined;
}

/** A plan judged: the offset its wire matched under `rotate`, or why it disagrees. */
export type PlanVerdict =
  | { readonly ok: true; readonly offset?: number }
  | { readonly ok: false; readonly problem: string };

/** Whether glibc sent the plan's wire (one of them, under `rotate`). */
export function judgePlan(e: Expectation, run: PlanRun): PlanVerdict {
  const plan = e.plans.find((each) => each.plan === run.plan);
  if (plan === undefined) return { ok: false, problem: `the row has no plan ${run.plan}` };
  if (plan.wire !== undefined) {
    return isDeepStrictEqual(run.wire, plan.wire)
      ? { ok: true }
      : {
          ok: false,
          problem: `${run.plan}: the policy expects ${JSON.stringify(plan.wire)}, glibc sent ${JSON.stringify(run.wire)}`,
        };
  }
  const offsets = plan.wireByOffset ?? [];
  const offset = offsets.findIndex((wire) => isDeepStrictEqual(run.wire, wire));
  return offset >= 0
    ? { ok: true, offset }
    : {
        ok: false,
        problem: `${run.plan}: the policy expects one of ${JSON.stringify(offsets)}, glibc sent ${JSON.stringify(run.wire)}`,
      };
}

export interface Verified {
  readonly recordings: Recording[];
  readonly problems: string[];
  /** Plans recorded and rows replayed, by image. */
  readonly counts: Record<string, { rows: number; plans: number }>;
}

/**
 * Every image's run against the rows: a recording for each plan of each row in each image that
 * replays it, or a problem. **A row or plan not played, an image not run, or an image whose glibc
 * is not the one the rows state, is a problem**: an unverified row fails the run (D30).
 */
export function verify(rows: RowsFile, runs: readonly ImageRun[]): Verified {
  const problems: string[] = [];
  const recordings: Recording[] = [];
  const counts: Record<string, { rows: number; plans: number }> = {};
  for (const run of runs) {
    if (!Object.hasOwn(rows.images, run.image)) {
      problems.push(`${run.image} is no image the rows are replayed in`);
    }
  }
  for (const [image, glibc] of Object.entries(rows.images)) {
    const found = runs.filter((each) => each.image === image);
    const run = found[0];
    if (run === undefined) {
      problems.push(`${image}: not run`);
      continue;
    }
    if (found.length > 1) problems.push(`${image}: run ${String(found.length)} times`);
    if (run.glibc !== glibc) {
      problems.push(`${image}: runs glibc ${String(run.glibc)}, the rows state ${glibc}`);
    }
    const count = { rows: 0, plans: 0 };
    counts[image] = count;
    for (const row of rows.rows) {
      const e = expectationIn(row, image);
      if (e === null) continue;
      const at = `${image}, row ${row.id} (${row.title})`;
      const played = run.rows.find((each) => each.id === row.id);
      if (played === undefined) {
        problems.push(`${at}: not replayed`);
        continue;
      }
      count.rows += 1;
      for (const why of played.setup ?? []) problems.push(`${at}: ${why}`);
      const misread = classificationProblem(e, played.inImage);
      if (misread !== undefined) problems.push(`${at}: ${misread}`);
      for (const plan of e.plans) {
        const ran = played.plans.find((each) => each.plan === plan.plan);
        if (ran === undefined) {
          problems.push(`${at}: plan ${plan.plan} not played`);
          continue;
        }
        const verdict = judgePlan(e, ran);
        if (!verdict.ok) {
          problems.push(`${at}: ${verdict.problem}`);
          continue;
        }
        if ((played.setup ?? []).length > 0 || misread !== undefined) continue;
        count.plans += 1;
        recordings.push({
          id: row.id,
          image,
          plan: plan.plan,
          ...(verdict.offset === undefined ? {} : { offset: verdict.offset }),
          wire: ran.wire,
          outcome: ran.outcome,
          ms: Math.round(ran.ms),
        });
      }
      for (const ran of played.plans) {
        if (!e.plans.some((plan) => plan.plan === ran.plan)) {
          problems.push(`${at}: played ${ran.plan}, which the row has no plan for`);
        }
      }
    }
  }
  return { recordings, problems, counts };
}

/** The recordings file for a run that verified. */
export function recordingsFile(runs: readonly ImageRun[], verified: Verified): RecordingsFile {
  const images: Record<string, RecordingsFile['images'][string]> = {};
  for (const run of [...runs].sort((a, b) => (a.image < b.image ? -1 : 1))) {
    images[run.image] = {
      base: run.base,
      digest: run.digest,
      glibc: run.glibc ?? 'none',
      node: run.node,
      resolved: run.resolved,
    };
  }
  return { schema: 1, images, recordings: verified.recordings };
}

// --- setting a world up --------------------------------------------------------------------------

/**
 * A server address as the policy and c-ares write it: IPv4 as it is, IPv6 in its shortest form
 * (RFC 5952; an IPv4-mapped one in hex, `::ffff:a00:1`), as the WHATWG URL parser serialises it.
 * Undefined for anything else.
 */
export function canonicalAddress(text: string): string | undefined {
  if (isIPv4(text)) return text;
  if (!isIPv6(text) || text.includes('%')) return undefined;
  return new URL(`http://[${text}]/`).hostname.slice(1, -1);
}

/** Every distinct server a resolv.conf names, canonical, in order: all of them, not just the first 3. */
export function nameserversOf(resolvConf: string): string[] {
  const out: string[] = [];
  for (const line of resolvConf.split('\n')) {
    const match = /^nameserver[ \t]+(\S+)/u.exec(line);
    const address = match === null ? undefined : canonicalAddress(match[1] ?? '');
    if (address !== undefined && !out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * Where a simulator must listen to be the server glibc asks at `address`: an IPv4-mapped IPv6
 * address is the IPv4 one, since glibc's AF_INET6 socket reaches it as IPv4.
 */
export function listenerOf(address: string): { readonly v4?: string; readonly v6?: string } {
  if (isIPv4(address)) return { v4: address };
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] ?? '0', 16);
    const low = Number.parseInt(mapped[2] ?? '0', 16);
    return { v4: [high >> 8, high & 255, low >> 8, low & 255].join('.') };
  }
  return { v6: address };
}

// --- a packet capture ------------------------------------------------------------------------------

/**
 * The DNS questions in a pcap file (tcpdump `-w`), each with the address it was sent to. Only for
 * the one server glibc asks that no simulator can be: systemd-resolved's stub, whose questions
 * upstream the simulator sees, and whose questions from glibc only a capture on `lo` can. IPv4 and
 * IPv6, over Ethernet (what Linux's `lo` reports), Linux cooked v1 and v2, and raw IP.
 */
export function pcapQuestions(file: Uint8Array): Asked[] {
  const data = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (data.length < 24) return [];
  const magic = data.readUInt32LE(0);
  const little = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
  if (!little && data.readUInt32BE(0) !== 0xa1b2c3d4 && data.readUInt32BE(0) !== 0xa1b23c4d) {
    throw new Error('not a pcap file');
  }
  const u32 = (at: number): number => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
  const linkType = u32(20);
  const out: Asked[] = [];
  for (let at = 24; at + 16 <= data.length;) {
    const captured = u32(at + 8);
    const packet = data.subarray(at + 16, at + 16 + captured);
    at += 16 + captured;
    const ip = linkPayload(packet, linkType);
    if (ip === undefined) continue;
    const asked = udpQuestion(ip);
    if (asked !== undefined) out.push(asked);
  }
  return out;
}

function linkPayload(packet: Buffer, linkType: number): Buffer | undefined {
  if (linkType === 1) return packet.length >= 14 ? packet.subarray(14) : undefined;
  if (linkType === 113) return packet.length >= 16 ? packet.subarray(16) : undefined;
  if (linkType === 276) return packet.length >= 20 ? packet.subarray(20) : undefined;
  if (linkType === 101) return packet;
  return undefined;
}

function udpQuestion(ip: Buffer): Asked | undefined {
  if (ip.length < 1) return undefined;
  const version = (ip[0] ?? 0) >> 4;
  let server: string;
  let udp: Buffer;
  if (version === 4) {
    const headerLength = ((ip[0] ?? 0) & 15) * 4;
    if (ip.length < headerLength + 8 || ip[9] !== 17) return undefined;
    server = [...ip.subarray(16, 20)].join('.');
    udp = ip.subarray(headerLength);
  } else if (version === 6) {
    if (ip.length < 48 || ip[6] !== 17) return undefined;
    const groups: string[] = [];
    for (let k = 0; k < 8; k += 1) groups.push(ip.readUInt16BE(24 + 2 * k).toString(16));
    server = canonicalAddress(groups.join(':')) ?? groups.join(':');
    udp = ip.subarray(40);
  } else {
    return undefined;
  }
  if (udp.readUInt16BE(2) !== 53) return undefined;
  const dns = udp.subarray(8);
  if (dns.length < 12 || ((dns[2] ?? 0) & 0x80) !== 0 || dns.readUInt16BE(4) < 1) return undefined;
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = dns[at];
    if (length === undefined || length > 63) return undefined;
    at += 1;
    if (length === 0) break;
    labels.push(dns.subarray(at, at + length).toString('latin1'));
    at += length;
  }
  if (at + 2 > dns.length) return undefined;
  const type = dns.readUInt16BE(at);
  const qtype = type === 1 ? 'A' : type === 28 ? 'AAAA' : `TYPE${String(type)}`;
  return { server, qname: labels.join('.'), qtype, transport: 'udp' };
}
