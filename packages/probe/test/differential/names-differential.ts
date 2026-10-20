import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { DnsBehaviour, DnsServerPolicy } from '@ms/simulators';

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
 *
 * **A run is tied to what it ran**: each image's run carries the sha256 of the rows file, of the
 * answer rows (`answerRowsDigest`), of the policy's build (`dist/src/resolver/system-names.js`)
 * and of every build the boxes load (`buildDigest`, `names-build.ts`), and says if that build
 * changed while it ran; each box's run carries the build too. The verdict fails a run of other
 * rows or another build, so a run kept from before a change, or made across one, cannot verify
 * after it.
 *
 * **The walk's wire beside glibc's** (`P-460`, D30's recording (B)). Each plan is played again,
 * in a separate run with every cache cold, through `DnsCheck.route` alone: the name check with a
 * budget and c-ares of its own, no lanes and no helper (`names-modes.ts`). The walk is held to
 * glibc's wire, never to the policy's (`walkProblems`):
 * - the servers, names and types in order, up to where each stops. Each wire is read as its first
 *   asks (`firstAsks`): every (server, name, type) once, at its first question, whatever the
 *   transport, since the walk asks each once and glibc's tries are its own. A heard walk asked
 *   exactly what glibc asked first; a silent one stopped at a question glibc asked too, so its asks
 *   are a prefix of glibc's. Under `rotate` the walk asks every server at once and each must reply
 *   (§1.4), where glibc asks one: the walk's names are glibc's in order, and it asks no type glibc
 *   did not ask of a name. Each name it passed, or reached and heard, was asked of every server
 *   with each type glibc asked of it; the name it was silent at, of every server with the first;
 * - heard if and only if glibc returned within `WITHIN_MS`. Under `rotate` the plan decides: where
 *   one of the row's servers is silent to a type asked, the walk is silent whatever glibc's time
 *   (glibc may start at the server that answers, and return at once); where none is, heard if and
 *   only if glibc returned within 1 s;
 * - the OPT record, as the decided known limit has it (`P-454`): glibc's questions carry one under
 *   `options edns0` and none without, and the check's never do (`optProblems`). The difference is
 *   asserted, so the run says if either side moves, and fails no row on its own.
 *
 * **The regressions, labelled as such** (§7.5, `modesProblems`): the same lookup through the
 * probe's resolver in `system` and in `gate` mode answers alike, and the helper's child answers as
 * the probe's own lanes; gate mode runs a heard name on the probe's lanes and a silent one in the
 * helper. **The answer rows** (`ANSWER_ROWS`) play what S4's rows cannot: TC with TCP/53 refused,
 * FORMERR, A answered with AAAA SERVFAIL, and EDNS-intolerant servers, each with what
 * `getaddrinfo` returns. **The budget boxes** (`budgetProblems`) and **the boxes with the check
 * off** (`offProblems`, `P-461`) are judged here too.
 */

/** systemd-resolved's stub: the one server glibc asks that no simulator can be. */
export const STUB = '127.0.0.53';

/**
 * Every simulator server as a row's nameserver: each question answered as the plan says when it
 * arrives. The S5 simulator models a forwarder by default, whose unanswered question holds a slot
 * for 10 s and takes in every identical question meanwhile, so the plan after an `all-silent` one
 * would find its questions still held, and silent. A slot held 1 ms is let go before glibc's next
 * try or the next plan asks again; a question answered at once never holds one.
 */
export const NAMESERVER: DnsServerPolicy = { forwarder: { holdMs: 1 } };

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
  /** Each try's wait, in seconds, and the tries of each server (`options timeout:` and `attempts:`). */
  readonly timeout: number;
  readonly attempts: number;
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
  /** The images whose stub rows must go through systemd-resolved (`--via-resolved`). */
  readonly resolved: readonly string[];
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
  /** Whether the question carried an OPT record (EDNS, RFC 6891). */
  readonly opt: boolean;
}

/**
 * Recording (B) of a plan (`P-460`): the walk's wire, from `DnsCheck.route` alone, with its own
 * budget and c-ares, no lanes and no helper, every cache cold.
 */
export interface WalkRun {
  /** The check's route: `local`, `heard`, `sampled`, `silent`, or `unvouched:<why>`. */
  readonly route: string;
  readonly wire: readonly Wire[];
  /** Whether each of its questions carried an OPT record, in the wire's order. */
  readonly opt: readonly boolean[];
  /** From the ask to the route. */
  readonly ms: number;
}

/**
 * The regression's lookups of a plan (§7.5), each in a resolver of its own: `answer:<addresses>`
 * in `getaddrinfo`'s order, or `error:<code>`.
 */
export interface ModesRun {
  /** Through the probe's resolver in `system` mode, and in `gate` mode with the check on. */
  readonly system: string;
  readonly gate: string;
  /** Where gate mode ran it, by its Probe Health counters: the probe's lanes, or the helper. */
  readonly gateRan: 'lanes' | 'helper';
  /** `getaddrinfo` in the lookup helper's child, and on the probe's own lanes, unrouted. */
  readonly helper: string;
  readonly lanes: string;
}

/** One plan played: the questions glibc sent, how `getaddrinfo` ended, and how long it took. */
export interface PlanRun {
  readonly plan: string;
  readonly wire: readonly Wire[];
  /** Whether each of glibc's questions carried an OPT record, in the wire's order. */
  readonly opt?: readonly boolean[];
  /** `answer` with the addresses' count, or the error code. */
  readonly outcome: string;
  readonly ms: number;
  /** Through systemd-resolved: what resolved asked its upstream, for the record, never judged. */
  readonly upstream?: readonly Wire[];
  /** Recording (B), played after glibc's in a run of its own. */
  readonly walk?: WalkRun;
  readonly modes?: ModesRun;
}

export interface RowRun {
  readonly id: string;
  readonly inImage: InImage;
  readonly plans: readonly PlanRun[];
  /** What kept the row from being played as its world says: it is then unverified. */
  readonly setup?: readonly string[];
  /** Whether the policy, loaded in the image, read `options edns0`: when glibc sends OPT. */
  readonly edns0?: boolean;
}

/** One image's run, as `names-replay.ts` prints it. */
export interface ImageRun {
  readonly image: string;
  /** glibc's runtime version, from `process.report`. */
  readonly glibc: string | undefined;
  readonly node: string;
  readonly base: string;
  readonly digest: string;
  /** The sha256 of the rows file the run replayed, and of the policy's build it loaded. */
  readonly rowsDigest: string;
  readonly policyDigest: string;
  /** The sha256 of the answer rows it played (`answerRowsDigest`). */
  readonly answerRowsDigest: string;
  /** The sha256 of every build the boxes load (`names-build.ts`), as the run began. */
  readonly buildDigest: string;
  /** Where the run saw that build change under it, if it did: the run is then of no one build. */
  readonly rebuilt?: string;
  /**
   * Whether systemd-resolved was seen to serve the stub (127.0.0.53): every plan that asked the stub
   * had resolved ask its upstream (`resolvedObserved`), not only that the run was told to use it.
   */
  readonly resolved: boolean;
  readonly rows: readonly RowRun[];
  /** The answer rows (`ANSWER_ROWS`), each with its one plan. */
  readonly answers?: readonly RowRun[];
}

/** A wire glibc sent for a row's plan in an image (`system-names-recordings.json`, schema 3). */
export interface Recording {
  readonly id: string;
  readonly image: string;
  readonly plan: string;
  readonly offset?: number;
  readonly wire: readonly Wire[];
  /** Whether each question carried an OPT record, in the wire's order. */
  readonly opt: readonly boolean[];
  readonly outcome: string;
  readonly ms: number;
  /** Through systemd-resolved: what resolved asked the simulator, kept for the record. */
  readonly upstream?: readonly Wire[];
}

export interface RecordingsFile {
  readonly schema: 3;
  readonly images: Readonly<
    Record<
      string,
      {
        readonly base: string;
        readonly digest: string;
        readonly glibc: string;
        readonly node: string;
        readonly resolved: boolean;
        readonly rowsDigest: string;
        readonly policyDigest: string;
        readonly answerRowsDigest: string;
      }
    >
  >;
  readonly recordings: readonly Recording[];
  /** glibc's wire for each answer row (`ANSWER_ROWS`) in each image, plan `ANSWER_PLAN`. */
  readonly answerRecordings: readonly Recording[];
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

/** Whether each question carried an OPT record, in the order `wireOf` numbers them. */
export function optOf(asked: readonly Asked[]): boolean[] {
  return asked.map((one) => one.opt);
}

const CLASS_FIELDS = [
  'class',
  'via',
  'reason',
  'candidates',
  'types',
  'servers',
  'rotate',
  'timeout',
  'attempts',
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

// --- the walk's wire beside glibc's (`P-460`) ------------------------------------------------------

/** glibc "returned within 1 s" (§7.5): the probe's bound for a lookup that is stuck (`STUCK_MS`). */
export const WITHIN_MS = 1_000;

/**
 * A walk that differs from glibc by design, asserted exactly as it is, so the run says if either
 * side moves: `P-454`, an EDNS-deaf server, which the check hears (c-ares sends no OPT record) and
 * glibc, sending one under `options edns0`, does not.
 */
export type Divergence = 'P-454';

/**
 * A wire as its first asks: each (server, name, type) once, at its first question, the transport
 * aside, the name in lower case as DNS compares it. The walk asks each question once (§1.4, no
 * resends) where glibc asks it again on each try and over TCP after TC.
 */
export function firstAsks(wire: readonly Wire[]): string[] {
  const out: string[] = [];
  for (const [server, name, type] of wire) {
    const ask = `${server.replace(/\/tcp$/u, '')} ${name.toLowerCase()} ${type}`;
    if (!out.includes(ask)) out.push(ask);
  }
  return out;
}

const serverOf = (ask: string): string => ask.split(' ')[0] ?? '';
const nameOf = (ask: string): string => ask.split(' ')[1] ?? '';
const typeOf = (ask: string): string => ask.split(' ')[2] ?? '';

/** Each name in the order a wire first asks it. */
function namesInOrder(asks: readonly string[]): string[] {
  const out: string[] = [];
  for (const ask of asks) if (!out.includes(nameOf(ask))) out.push(nameOf(ask));
  return out;
}

const isPrefix = (part: readonly string[], whole: readonly string[]): boolean =>
  part.length <= whole.length && part.every((each, k) => each === whole[k]);

/** Why the walk's asks are not glibc's, up to where each stops, or undefined. */
function orderDiffers(
  glibc: readonly string[],
  walked: readonly string[],
  heard: boolean,
): string | undefined {
  if (walked.length === 0) return 'asked nothing';
  if (heard ? isDeepStrictEqual(walked, glibc) : walked.length > 0 && isPrefix(walked, glibc)) {
    return undefined;
  }
  return heard
    ? `heard after asking ${JSON.stringify(walked)}, where glibc asked ${JSON.stringify(glibc)}`
    : `silent after asking ${JSON.stringify(walked)}, which is not how glibc began: ${JSON.stringify(glibc)}`;
}

/** The types a wire's first asks put to each name, in the order it first put them. */
function typesByName(asks: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ask of asks) {
    const types = out.get(nameOf(ask)) ?? [];
    if (!types.includes(typeOf(ask))) types.push(typeOf(ask));
    out.set(nameOf(ask), types);
  }
  return out;
}

/**
 * Under `rotate`, the walk asks every server at once and needs each to reply (§1.4): its names
 * are glibc's in order, up to where each stops, and it asks no type of a name that glibc did not.
 * A name it went past, or reached and was heard at, it asked of every server with every type
 * glibc asked of that name, since a step ends only when each server replied to each. The name a
 * silent walk stopped at it asked of every server with glibc's first type at least: its second
 * type goes to a server only after the first is answered there.
 */
function rotateDiffers(
  servers: readonly string[],
  glibc: readonly string[],
  walked: readonly string[],
  heard: boolean,
): string | undefined {
  if (walked.length === 0) return 'asked nothing';
  const stray = walked.find((ask) => !servers.includes(serverOf(ask)));
  if (stray !== undefined) return `asked ${stray}, of a server the row does not name`;
  const theirs = namesInOrder(glibc);
  const ours = namesInOrder(walked);
  if (heard ? !isDeepStrictEqual(ours, theirs) : !isPrefix(ours, theirs)) {
    return `asked the names ${JSON.stringify(ours)}, where glibc asked ${JSON.stringify(theirs)}`;
  }
  const glibcTypes = typesByName(glibc);
  const unasked = walked.find((ask) => !(glibcTypes.get(nameOf(ask)) ?? []).includes(typeOf(ask)));
  if (unasked !== undefined) {
    return `asked ${unasked}, and glibc asked ${nameOf(unasked)} ${JSON.stringify(glibcTypes.get(nameOf(unasked)) ?? [])} only`;
  }
  for (const [k, name] of ours.entries()) {
    const types = glibcTypes.get(name) ?? [];
    const whole = heard || k < ours.length - 1;
    for (const type of whole ? types : types.slice(0, 1)) {
      const missed = servers.filter((server) => !walked.includes(`${server} ${name} ${type}`));
      if (missed.length > 0)
        return `asked ${name} ${type} of ${String(servers.length - missed.length)} of ${String(servers.length)} servers under rotate, not of ${missed.join(', ')}`;
    }
  }
  return undefined;
}

/**
 * The first of the row's servers a plan has silent to one of the types glibc asks, as
 * `<server> <type>`, or undefined. Under `rotate` the walk asks every server, so it reaches it.
 */
function silentServer(
  e: Pick<Classification, 'servers' | 'types'>,
  plan: Pick<Plan, 'answers'> | undefined,
): string | undefined {
  if (plan === undefined) return undefined;
  for (const server of e.servers) {
    const type = (e.types ?? []).find((each) => plan.answers[server]?.[each as QType] === 'silent');
    if (type !== undefined) return `${server} ${type}`;
  }
  return undefined;
}

/** What else a walk is judged by: the plan it was played under, and a listed divergence. */
export interface WalkJudged {
  /** The plan's answers: under `rotate`, whether some server is silent decides the walk. */
  readonly plan?: Pick<Plan, 'answers'> | undefined;
  readonly divergence?: Divergence | undefined;
}

/**
 * Why recording (B) of a plan disagrees with glibc's (A), or nothing (`P-460`, §7.5's fidelity
 * assertions 1 and 2): see the header. A `local` row must be routed `local` with nothing asked; a
 * walked one must be routed by its walk, heard or silent, asking each question once. Under
 * `rotate` without the plan, no server is known to be silent, and the walk is held both ways.
 */
export function walkProblems(
  e: Pick<Classification, 'class' | 'rotate' | 'servers' | 'types'>,
  run: PlanRun,
  judged: WalkJudged = {},
): string[] {
  const walk = run.walk;
  if (walk === undefined) return [`${run.plan}: the walk was not recorded`];
  const at = `${run.plan}, the walk`;
  if (e.class !== 'walk') {
    const out: string[] = [];
    if (walk.route !== 'local') out.push(`${at}: routed ${walk.route}, and the row is ${e.class}`);
    if (walk.wire.length > 0) {
      out.push(`${at}: asked ${JSON.stringify(walk.wire)} for a name glibc answers unasked`);
    }
    return out;
  }
  if (walk.route !== 'heard' && walk.route !== 'silent') {
    return [`${at}: routed ${walk.route}, not by a walk`];
  }
  const out: string[] = [];
  const again = walk.wire.filter(([server, , , tries]) => !server.endsWith('/tcp') && tries > 1);
  if (again.length > 0) out.push(`${at}: asked a question again: ${JSON.stringify(again)}`);
  const heard = walk.route === 'heard';
  const rotating = e.rotate && e.servers.length > 1;
  const glibc = firstAsks(run.wire);
  const walked = firstAsks(walk.wire);
  const differs = rotating
    ? rotateDiffers(e.servers, glibc, walked, heard)
    : orderDiffers(glibc, walked, heard);
  if (differs !== undefined) out.push(`${at}: ${differs}`);
  const fast = run.ms < WITHIN_MS;
  const took = `glibc returned in ${String(Math.round(run.ms))} ms (${run.outcome})`;
  const silent = rotating ? silentServer(e, judged.plan) : undefined;
  if (judged.divergence === 'P-454') {
    if (!heard || fast) {
      out.push(`${at}: P-454's known limit has moved: the walk was ${walk.route}, and ${took}`);
    }
  } else if (silent !== undefined) {
    // glibc may start at a server that answers, and return at once: its time says nothing here.
    if (heard) {
      out.push(`${at}: heard under rotate, and the plan has ${silent} silent (${took})`);
    }
  } else if (heard !== fast) {
    out.push(`${at}: ${walk.route}, and ${took}`);
  }
  return out;
}

/**
 * Which of glibc's questions carry an OPT record: under `options edns0` every one (`every`), or
 * the first of them and none once glibc drops EDNS (`then-none`); without it, none.
 */
export type GlibcOpt = 'every' | 'none' | 'then-none';

const GLIBC_OPT_WORDS: Readonly<Record<GlibcOpt, string>> = {
  every: 'under options edns0 every one of glibc’s questions carries an OPT record',
  none: 'without options edns0 none of glibc’s questions carries an OPT record',
  'then-none':
    'under options edns0 glibc’s first questions carry an OPT record, and none once it drops EDNS',
};

function optAsExpected(opt: readonly boolean[], expected: GlibcOpt): boolean {
  if (expected === 'every') return opt.every(Boolean);
  if (expected === 'none') return !opt.some(Boolean);
  const dropped = opt.indexOf(false);
  return opt[0] === true && dropped !== -1 && !opt.slice(dropped).some(Boolean);
}

/**
 * The OPT record on each wire (`P-454`, decided 2026-10-20 a known limit for 1.0): glibc's as
 * `expected` says, and the check's on none of its questions (c-ares 1.34.6 in Node 24.19.0 sends
 * none). Asserted exactly as it is, so the run tells if either side changes; the walk's fidelity
 * (`walkProblems`) never looks at it.
 */
export function optProblems(run: PlanRun, expected: GlibcOpt): string[] {
  const out: string[] = [];
  const opt = run.opt;
  if (opt === undefined || opt.length !== run.wire.length) {
    out.push(`${run.plan}: glibc’s OPT records were not recorded for each question`);
  } else if (!optAsExpected(opt, expected)) {
    out.push(
      `${run.plan}: glibc’s questions carried OPT records ${JSON.stringify(opt)}, and ${GLIBC_OPT_WORDS[expected]}`,
    );
  }
  const walk = run.walk;
  if (walk !== undefined) {
    if (walk.opt.length !== walk.wire.length) {
      out.push(`${run.plan}: the walk’s OPT records were not recorded for each question`);
    } else if (walk.opt.some(Boolean)) {
      out.push(
        `${run.plan}: the check’s questions carry an OPT record now, where c-ares 1.34.6 sent none: P-454’s known limit has moved`,
      );
    }
  }
  return out;
}

/**
 * §7.5's regression assertions, labelled as such, comparing `getaddrinfo` with `getaddrinfo`: gate
 * mode answers as `system` mode, the helper's child as the probe's lanes, and gate mode ran the
 * name where its walk said: a heard or local name on the probe's lanes, a silent one in the helper.
 */
export function modesProblems(run: PlanRun): string[] {
  const modes = run.modes;
  if (modes === undefined) return [`${run.plan}: the regression’s lookups were not recorded`];
  const out: string[] = [];
  if (modes.gate !== modes.system) {
    out.push(
      `${run.plan}, regression: gate mode answered ${modes.gate}, system mode ${modes.system}`,
    );
  }
  if (modes.helper !== modes.lanes) {
    out.push(
      `${run.plan}, regression: the helper’s child answered ${modes.helper}, the probe’s lanes ${modes.lanes}`,
    );
  }
  const route = run.walk?.route;
  const where =
    route === 'silent' ? 'helper' : route === 'heard' || route === 'local' ? 'lanes' : undefined;
  if (where !== undefined && modes.gateRan !== where) {
    out.push(
      `${run.plan}, regression: gate mode ran it ${modes.gateRan === 'helper' ? 'in the helper' : 'on the probe’s lanes'}, and its walk was ${route ?? ''}`,
    );
  }
  return out;
}

// --- the answer rows (`P-460`) ---------------------------------------------------------------------

/** The one plan each answer row plays. */
export const ANSWER_PLAN = 'plan';
export const ANSWER_A = '192.0.2.53';
export const ANSWER_AAAA = '2001:db8::53';
/** The answer rows' world, besides each one's resolv.conf. */
export const ANSWER_WORLD = {
  hostname: 'probe-1',
  hosts: '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n',
  nsswitch: 'hosts: files dns\n',
  gai: '',
} as const;

export interface AnswerServer {
  readonly address: string;
  /** `closed`: nothing listens on its TCP/53, so a TCP retry is refused. */
  readonly tcp: 'listen' | 'closed';
  readonly behaviour: DnsBehaviour;
}

/**
 * A row about answers rather than routes (§7.5): what S4's rows cannot play, as their plans answer
 * with addresses, NXDOMAIN, SERVFAIL, REFUSED or silence only. Each plays one plan in every image,
 * with a simulator per row, so a server's TCP can be closed.
 */
export interface AnswerRow {
  readonly id: string;
  readonly title: string;
  readonly resolvConf: string;
  readonly question: { readonly name: string; readonly family: 0 | 4 | 6 };
  readonly servers: readonly AnswerServer[];
  /** The walk's route, and whether glibc returns within `WITHIN_MS`, as the row claims them. */
  readonly walk: 'heard' | 'silent';
  readonly fast: boolean;
  readonly glibcOpt: GlibcOpt;
  readonly divergence?: Divergence;
  /** glibc's wire, in every image. */
  readonly wire: readonly Wire[];
  /** What `getaddrinfo` returns, in every image: `answer:<count>`, or the error's code. */
  readonly outcome: string;
}

const ANSWERING: DnsBehaviour = {
  reply: { kind: 'addresses', addresses: [ANSWER_A, ANSWER_AAAA] },
};
const S1 = '10.0.0.53';
const S2 = '10.0.0.54';
const TWO = `nameserver ${S1}\nnameserver ${S2}\n`;
const NAME = 'sw1.example.test';
const both = (server: string, tries = 1): Wire[] => [
  [server, NAME, 'A', tries],
  [server, NAME, 'AAAA', tries],
];

export const ANSWER_ROWS: readonly AnswerRow[] = [
  {
    id: 'answer-tc-tcp-refused',
    title: 'TC from server 1, its TCP/53 refused, server 2 answering',
    resolvConf: TWO,
    question: { name: NAME, family: 0 },
    servers: [
      { address: S1, tcp: 'closed', behaviour: { ...ANSWERING, truncate: 'tcp' } },
      { address: S2, tcp: 'listen', behaviour: ANSWERING },
    ],
    walk: 'heard',
    fast: true,
    glibcOpt: 'none',
    wire: [...both(S1), ...both(`${S2}/tcp`)],
    outcome: 'answer:2',
  },
  {
    id: 'answer-tc-tcp-refused-edns0',
    title: 'TC from server 1, its TCP/53 refused, server 2 answering, under options edns0',
    resolvConf: `${TWO}options edns0\n`,
    question: { name: NAME, family: 0 },
    servers: [
      { address: S1, tcp: 'closed', behaviour: { ...ANSWERING, truncate: 'tcp' } },
      { address: S2, tcp: 'listen', behaviour: ANSWERING },
    ],
    walk: 'heard',
    fast: true,
    glibcOpt: 'every',
    wire: [...both(S1), ...both(`${S2}/tcp`)],
    outcome: 'answer:2',
  },
  {
    id: 'answer-formerr',
    title: 'FORMERR from server 1, server 2 answering',
    resolvConf: TWO,
    question: { name: NAME, family: 0 },
    servers: [
      { address: S1, tcp: 'listen', behaviour: { reply: { kind: 'rcode', rcode: 'FORMERR' } } },
      { address: S2, tcp: 'listen', behaviour: ANSWERING },
    ],
    walk: 'heard',
    fast: true,
    glibcOpt: 'none',
    wire: both(S1),
    outcome: 'ENOTFOUND',
  },
  {
    id: 'answer-aaaa-servfail-second-silent',
    title: 'A answered and AAAA SERVFAIL from server 1, server 2 silent',
    resolvConf: TWO,
    question: { name: NAME, family: 0 },
    servers: [
      {
        address: S1,
        tcp: 'listen',
        behaviour: {
          a: { kind: 'addresses', addresses: [ANSWER_A] },
          aaaa: { kind: 'rcode', rcode: 'SERVFAIL' },
        },
      },
      { address: S2, tcp: 'listen', behaviour: { reply: { kind: 'silent' } } },
    ],
    walk: 'heard',
    fast: true,
    glibcOpt: 'none',
    wire: both(S1),
    outcome: 'answer:1',
  },
  {
    id: 'answer-edns-formerr-edns0',
    title:
      'server 1 answers FORMERR to a question with OPT, server 2 answering, under options edns0',
    resolvConf: `${TWO}options edns0\n`,
    question: { name: NAME, family: 0 },
    servers: [
      { address: S1, tcp: 'listen', behaviour: { ...ANSWERING, onOpt: 'formerr' } },
      { address: S2, tcp: 'listen', behaviour: ANSWERING },
    ],
    walk: 'heard',
    fast: true,
    glibcOpt: 'every',
    wire: both(S1),
    outcome: 'ENOTFOUND',
  },
  {
    id: 'answer-edns-deaf-edns0',
    title:
      'one server that drops a question with OPT, under options edns0 timeout:1 attempts:1 (P-454)',
    resolvConf: `nameserver ${S1}\noptions edns0 timeout:1 attempts:1\n`,
    question: { name: NAME, family: 0 },
    servers: [{ address: S1, tcp: 'listen', behaviour: { ...ANSWERING, onOpt: 'drop' } }],
    walk: 'heard',
    fast: false,
    glibcOpt: 'every',
    divergence: 'P-454',
    wire: both(S1),
    outcome: 'EAI_AGAIN',
  },
];

/** An `options` value an answer row's resolv.conf sets, or glibc's default. */
function optionIn(resolvConf: string, name: 'timeout' | 'attempts', otherwise: number): number {
  const found = new RegExp(`\\b${name}:(\\d+)`, 'u').exec(resolvConf)?.[1];
  return found === undefined ? otherwise : Number(found);
}

/** The policy's reading of an answer row in the image, as its own row would state it. */
export function answerExpectation(row: AnswerRow): Classification {
  const family = row.question.family;
  return {
    class: 'walk',
    candidates: [row.question.name],
    types: family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'],
    servers: row.servers.map((server) => server.address),
    rotate: false,
    timeout: optionIn(row.resolvConf, 'timeout', 5),
    attempts: optionIn(row.resolvConf, 'attempts', 2),
  };
}

/** An answer row's run in an image against what it claims, as problems. */
export function answerProblems(row: AnswerRow, played: RowRun): string[] {
  const out: string[] = [...(played.setup ?? [])];
  const e = answerExpectation(row);
  const misread = classificationProblem(e, played.inImage);
  if (misread !== undefined) out.push(misread);
  const edns0 = row.glibcOpt !== 'none';
  if (played.edns0 !== edns0) {
    out.push(
      `the policy in the image reads edns0 as ${String(played.edns0)}, the row says ${String(edns0)}`,
    );
  }
  const ran = played.plans.find((plan) => plan.plan === ANSWER_PLAN);
  if (ran === undefined) return [...out, `plan ${ANSWER_PLAN} not played`];
  for (const extra of played.plans.filter((plan) => plan.plan !== ANSWER_PLAN)) {
    out.push(`played ${extra.plan}, which the row has no plan for`);
  }
  if (!isDeepStrictEqual(ran.wire, row.wire)) {
    out.push(
      `${ran.plan}: the row expects ${JSON.stringify(row.wire)}, glibc sent ${JSON.stringify(ran.wire)}`,
    );
  }
  if (ran.outcome !== row.outcome) {
    out.push(`${ran.plan}: getaddrinfo returned ${ran.outcome}, and the row says ${row.outcome}`);
  }
  if (ran.ms < WITHIN_MS !== row.fast) {
    out.push(
      `${ran.plan}: glibc returned in ${String(Math.round(ran.ms))} ms (${ran.outcome}), and the row says it returns ${row.fast ? 'within' : 'after'} ${String(WITHIN_MS)} ms`,
    );
  }
  if (ran.walk !== undefined && ran.walk.route !== row.walk) {
    out.push(`${ran.plan}: the walk was ${ran.walk.route}, and the row says ${row.walk}`);
  }
  out.push(...walkProblems(e, ran, { divergence: row.divergence }));
  out.push(...optProblems(ran, row.glibcOpt));
  out.push(...modesProblems(ran));
  return out;
}

export interface Verified {
  readonly recordings: Recording[];
  /** glibc's wire for each answer row in each image. */
  readonly answerRecordings: Recording[];
  readonly problems: string[];
  /** Plans recorded and rows replayed, by image. */
  readonly counts: Record<string, { rows: number; plans: number }>;
}

/**
 * What a verdict holds every run to: the sha256 of the rows file, of the policy's build, of the
 * answer rows and of every build the boxes load, now.
 */
export interface Current {
  readonly rowsDigest: string;
  readonly policyDigest: string;
  readonly answerRowsDigest: string;
  readonly buildDigest: string;
}

/** The sha256 of a file's bytes, in hex: how a run names the rows and the build it ran. */
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The sha256 of the answer rows, as JSON: they live here rather than in the rows file, and a run
 * names the ones it played as it names the rows file, so recordings of a row since changed (its
 * resolv.conf, a server's behaviour, what it claims) cannot verify, or stand committed, for it.
 */
export function answerRowsDigest(rows: readonly AnswerRow[] = ANSWER_ROWS): string {
  return digestOf(Buffer.from(JSON.stringify(rows)));
}

/**
 * Every image's run against the rows: a recording for each plan of each row in each image that
 * replays it, or a problem. **A row or plan not played, an image not run, or an image whose glibc
 * is not the one the rows state, is a problem**: an unverified row fails the run (D30). So is a run
 * of other rows, other answer rows, another build of the policy or another build of what the boxes
 * load than `current`, or one that saw its build change while it ran; a row played that the rows
 * do not replay in that image; and an image the rows say goes through systemd-resolved where the
 * run did not see it serve the stub. Each plan whose glibc wire verified is held to its walk, its
 * OPT records and its regression lookups too (`P-460`), and every answer row must be played in
 * every image and hold.
 */
export function verify(
  rows: RowsFile,
  runs: readonly ImageRun[],
  current: Current,
  answerRows: readonly AnswerRow[] = ANSWER_ROWS,
): Verified {
  const problems: string[] = [];
  const recordings: Recording[] = [];
  const answerRecordings: Recording[] = [];
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
    if (run.rowsDigest !== current.rowsDigest) {
      problems.push(
        `${image}: replayed rows ${run.rowsDigest}, the rows file is ${current.rowsDigest}`,
      );
    }
    if (run.policyDigest !== current.policyDigest) {
      problems.push(
        `${image}: loaded the policy build ${run.policyDigest}, the build is ${current.policyDigest}`,
      );
    }
    if (run.answerRowsDigest !== current.answerRowsDigest) {
      problems.push(
        `${image}: played answer rows ${run.answerRowsDigest}, the answer rows are ${current.answerRowsDigest}`,
      );
    }
    problems.push(...buildProblems(image, run, current));
    if (rows.resolved.includes(image) && !run.resolved) {
      problems.push(`${image}: systemd-resolved was not seen to serve the stub rows`);
    }
    for (const played of run.rows) {
      const row = rows.rows.find((each) => each.id === played.id);
      if (row === undefined) problems.push(`${image}, row ${played.id}: played, and is no row`);
      else if (expectationIn(row, image) === null) {
        problems.push(`${image}, row ${row.id} (${row.title}): played, and not replayed there`);
      }
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
        // The walk is held to a glibc wire that verified, never to one already in question.
        if (played.edns0 === undefined) {
          problems.push(`${at}: whether the policy read options edns0 was not recorded`);
        }
        const opt: GlibcOpt = played.edns0 === true ? 'every' : 'none';
        for (const why of [
          ...walkProblems(e, ran, { plan }),
          ...optProblems(ran, opt),
          ...modesProblems(ran),
        ]) {
          problems.push(`${at}: ${why}`);
        }
        count.plans += 1;
        recordings.push(recordingOf(row.id, image, ran, verdict.offset));
      }
      for (const ran of played.plans) {
        if (!e.plans.some((plan) => plan.plan === ran.plan)) {
          problems.push(`${at}: played ${ran.plan}, which the row has no plan for`);
        }
      }
    }
    const answers = run.answers ?? [];
    for (const played of answers) {
      if (!answerRows.some((row) => row.id === played.id)) {
        problems.push(`${image}, answer row ${played.id}: played, and is no answer row`);
      }
    }
    for (const row of answerRows) {
      const at = `${image}, answer row ${row.id} (${row.title})`;
      const played = answers.find((each) => each.id === row.id);
      if (played === undefined) {
        problems.push(`${at}: not replayed`);
        continue;
      }
      const found = answerProblems(row, played);
      for (const why of found) problems.push(`${at}: ${why}`);
      const ran = played.plans.find((plan) => plan.plan === ANSWER_PLAN);
      if (ran !== undefined && found.length === 0) {
        answerRecordings.push(recordingOf(row.id, image, ran, undefined));
      }
    }
  }
  return { recordings, answerRecordings, problems, counts };
}

/** Why a run, an image's or a box's, is not of the build the verdict judges by, or nothing. */
function buildProblems(
  at: string,
  run: { readonly buildDigest?: string; readonly rebuilt?: string },
  current: Pick<Current, 'buildDigest'>,
): string[] {
  const out: string[] = [];
  if (run.buildDigest !== current.buildDigest) {
    out.push(
      `${at}: ran the build ${String(run.buildDigest)}, the build is ${current.buildDigest}`,
    );
  }
  if (run.rebuilt !== undefined) out.push(`${at}: its build changed while it ran (${run.rebuilt})`);
  return out;
}

function recordingOf(
  id: string,
  image: string,
  ran: PlanRun,
  offset: number | undefined,
): Recording {
  return {
    id,
    image,
    plan: ran.plan,
    ...(offset === undefined ? {} : { offset }),
    wire: ran.wire,
    opt: ran.opt ?? [],
    outcome: ran.outcome,
    ms: Math.round(ran.ms),
    ...(ran.upstream === undefined ? {} : { upstream: ran.upstream }),
  };
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
      rowsDigest: run.rowsDigest,
      policyDigest: run.policyDigest,
      answerRowsDigest: run.answerRowsDigest,
    };
  }
  return {
    schema: 3,
    images,
    recordings: verified.recordings,
    answerRecordings: verified.answerRecordings,
  };
}

/**
 * A run file as it held it: an image's run, a budget box's or a box with the check off, or why it
 * is none (an empty file is a replay that stopped).
 */
export function parseRun(
  path: string,
  text: string,
):
  | { readonly run: ImageRun }
  | { readonly budget: BudgetRun }
  | { readonly off: OffRun }
  | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return { problem: `${path}: not an image's run (${String(error)})` };
  }
  const kind = (parsed as { kind?: unknown } | null)?.kind;
  if (kind === 'budget') {
    const budget = parsed as Partial<BudgetRun>;
    if (typeof budget.forwarder !== 'string' || !Array.isArray(budget.arms)) {
      return { problem: `${path}: not a budget box's run (no forwarder or arms)` };
    }
    return { budget: budget as BudgetRun };
  }
  if (kind === 'off') {
    const off = parsed as Partial<OffRun>;
    if (typeof off.case !== 'string' || typeof off.check !== 'string') {
      return { problem: `${path}: not an off box's run (no case or check)` };
    }
    return { off: off as OffRun };
  }
  const run = parsed as Partial<ImageRun> | null;
  if (run === null || typeof run.image !== 'string' || !Array.isArray(run.rows)) {
    return { problem: `${path}: not an image's run (no image or rows)` };
  }
  return { run: run as ImageRun };
}

// --- the budget boxes (§7.5's budget rows) ---------------------------------------------------------

/** What gate mode may hold at a forwarder beyond `system` (D16: 24 against 12 for family 0). */
export const BUDGET_GATE_EXTRA = 12;
/** D16's transient after a helper loss, family 0, at a forwarder that does not merge: +8 × q. */
export const BUDGET_LOSS_TRANSIENT = 16;
/** dnsmasq's `dns-forward-max` in the box: 150 is the default, 30 is §7.5's. */
export const BUDGET_FORWARD_MAX = 30;
/** The names of one silent zone the box asks at once, in each arm. */
export const BUDGET_NAMES = 150;

export type BudgetArmName = 'system' | 'gate' | 'gate-kill';
export type Forwarder = 'dnsmasq' | 'resolved';

/** One arm: the probe's resolver in one mode asking every name of a silent zone at once. */
export interface BudgetArm {
  readonly arm: BudgetArmName;
  readonly lookups: number;
  /** Distinct questions the forwarder had open upstream at once, at their most. */
  readonly peakHeld: number;
  /** Distinct questions it sent upstream in the arm's window. */
  readonly distinct: number;
  /** dnsmasq's "Maximum number of concurrent DNS queries reached" lines (dnsmasq only). */
  readonly maxReached?: number;
  /** Gate arms: the check's state at the end (1 on and proven), and the helper's losses. */
  readonly checkState?: number;
  readonly helperLosses?: number;
  /** Gate arms: `nameQuestionsOpen` at its most over the arm. */
  readonly questionsPeak?: number;
}

export interface BudgetRun {
  readonly kind: 'budget';
  readonly forwarder: Forwarder;
  readonly image: string;
  /** dnsmasq's or systemd's version line. */
  readonly version: string;
  readonly names: number;
  readonly family: 0 | 4 | 6;
  readonly windowMs: number;
  readonly arms: readonly BudgetArm[];
  readonly setup?: readonly string[];
  /** The build the box loaded, and where it saw it change, as an image's run carries them. */
  readonly buildDigest: string;
  readonly rebuilt?: string;
}

/** The arms each forwarder's box must run. */
export const BUDGET_BOXES: Readonly<Record<Forwarder, readonly BudgetArmName[]>> = {
  dnsmasq: ['system', 'gate', 'gate-kill'],
  resolved: ['system', 'gate'],
};

/**
 * A budget box against §7.5: dnsmasq at `dns-forward-max=30` with a 150-name silent zone never
 * says its table is full, in either mode; gate mode holds at most `system` + 12 distinct questions
 * at the forwarder at once, and after a helper SIGKILL at most that and D16's transient; and the
 * same bound for systemd-resolved's distinct upstream questions. Each gate arm ran with the check
 * on and proven, the killed one lost its helper, and `system` held the zone's questions at all.
 */
export function budgetProblems(run: BudgetRun): string[] {
  const at = `budget box ${run.forwarder}`;
  const out: string[] = (run.setup ?? []).map((why) => `${at}: ${why}`);
  const arm = (name: BudgetArmName): BudgetArm | undefined =>
    run.arms.find((each) => each.arm === name);
  for (const name of BUDGET_BOXES[run.forwarder]) {
    if (arm(name) === undefined) out.push(`${at}: the ${name} arm did not run`);
  }
  if (run.names !== BUDGET_NAMES || run.family !== 0) {
    out.push(
      `${at}: asked ${String(run.names)} names for family ${String(run.family)}, not ${String(BUDGET_NAMES)} for family 0`,
    );
  }
  const system = arm('system');
  if (system === undefined) return out;
  if (system.peakHeld < 2) {
    out.push(
      `${at}: system held ${String(system.peakHeld)} questions at its most: the silent zone was not asked`,
    );
  }
  for (const each of run.arms) {
    if (run.forwarder === 'dnsmasq' && each.maxReached !== 0) {
      out.push(
        `${at}, ${each.arm}: dnsmasq said its forward table was full ${String(each.maxReached ?? 'an unknown number of')} times`,
      );
    }
    if (each.arm === 'system') continue;
    if (each.checkState !== 1) {
      out.push(
        `${at}, ${each.arm}: the check was not on and proven (nameCheckState ${String(each.checkState)})`,
      );
    }
    const bound =
      system.peakHeld + BUDGET_GATE_EXTRA + (each.arm === 'gate-kill' ? BUDGET_LOSS_TRANSIENT : 0);
    if (each.peakHeld > bound) {
      out.push(
        `${at}, ${each.arm}: held ${String(each.peakHeld)} distinct questions at once, over ${String(bound)} (system ${String(system.peakHeld)})`,
      );
    }
    if (each.arm === 'gate-kill' && (each.helperLosses ?? 0) < 1) {
      out.push(`${at}, gate-kill: the helper was not lost`);
    }
  }
  return out;
}

// --- the boxes with the check off (`P-461`) -------------------------------------------------------

export type OffCase = 'nscd' | 'resolve' | 'mdns4_minimal' | 'ld-preload' | 'ld-so-preload';

/** A box in which the check must be off, in situ: the policy loaded against the box as it is. */
export interface OffRun {
  readonly kind: 'off';
  readonly case: OffCase;
  readonly image: string;
  readonly check: 'on' | 'off';
  readonly off?: { readonly code: string; readonly why: string };
  /** What the box was, read in it: its hosts: line, nscd's socket, and what ld.so preloads. */
  readonly hostsLine: string | undefined;
  readonly nscdSocket: boolean;
  readonly ldPreload: string | undefined;
  readonly ldSoPreload: string | undefined;
  /** A name the check was asked to route in the box, once it was started: `unvouched:off`. */
  readonly route: string | undefined;
  /**
   * Every question the check put to its asker, `<server> <name> <type>`, from its start (when
   * its canary would go) to its stop: none.
   */
  readonly asked: readonly string[];
  readonly setup?: readonly string[];
  /** The build the box loaded, and where it saw it change, as an image's run carries them. */
  readonly buildDigest: string;
  readonly rebuilt?: string;
}

interface OffCaseClaim {
  readonly image: string;
  /** The rule the policy must name (`CheckOff.code`), and words its reason must have. */
  readonly code: string;
  readonly why: RegExp;
  /** Why the box is not as the case says, or undefined. */
  readonly inSitu: (run: OffRun) => string | undefined;
}

const hostsLineHas =
  (pattern: RegExp, what: string) =>
  (run: OffRun): string | undefined =>
    run.hostsLine !== undefined && pattern.test(run.hostsLine)
      ? undefined
      : `the box’s hosts: line is ${JSON.stringify(run.hostsLine)}, with no ${what}`;

/** Each box with the check off, by the rule it must be off by. */
export const OFF_CASES: Readonly<Record<OffCase, OffCaseClaim>> = {
  nscd: {
    image: 'debian12',
    code: 'nscd',
    why: /nscd is running/u,
    inSitu: (run) =>
      run.nscdSocket ? undefined : 'nscd’s socket is not there: nscd is not running',
  },
  resolve: {
    image: 'ubuntu2404',
    code: 'nsswitch',
    why: /hosts: line/u,
    inSitu: hostsLineHas(/(^|\s)resolve \[!UNAVAIL=return\](\s|$)/u, 'resolve [!UNAVAIL=return]'),
  },
  mdns4_minimal: {
    image: 'debian12',
    code: 'nsswitch',
    why: /hosts: line/u,
    inSitu: hostsLineHas(/(^|\s)mdns4_minimal(\s|$)/u, 'mdns4_minimal'),
  },
  'ld-preload': {
    image: 'debian12',
    code: 'env',
    why: /LD_PRELOAD is set/u,
    inSitu: (run) =>
      (run.ldPreload ?? '') !== '' ? undefined : 'LD_PRELOAD is not set in the box',
  },
  'ld-so-preload': {
    image: 'debian12',
    code: 'env',
    why: /ld\.so\.preload is not empty/u,
    inSitu: (run) =>
      (run.ldSoPreload ?? '') !== ''
        ? undefined
        : '/etc/ld.so.preload is empty or absent in the box',
  },
};

/**
 * A box with the check off against its case: in situ as it says, the check off by its rule, a
 * name routed `unvouched:off`, and nothing asked from the check's start to its stop, its canary
 * included.
 */
export function offProblems(run: OffRun): string[] {
  const claim = OFF_CASES[run.case];
  const at = `off box ${run.case}`;
  const out: string[] = (run.setup ?? []).map((why) => `${at}: ${why}`);
  if (run.image !== claim.image) out.push(`${at}: ran in ${run.image}, not ${claim.image}`);
  const unlike = claim.inSitu(run);
  if (unlike !== undefined) out.push(`${at}: ${unlike}`);
  if (run.check !== 'off' || run.off === undefined) {
    out.push(`${at}: the policy loaded in the box has the check on`);
    return out;
  }
  if (run.off.code !== claim.code || !claim.why.test(run.off.why)) {
    out.push(
      `${at}: the policy has the check off by ${run.off.code} (${run.off.why}), not by ${claim.code}`,
    );
  }
  if (run.route !== 'unvouched:off') {
    out.push(`${at}: the check routed a name ${String(run.route)}, not unvouched:off`);
  }
  if (!Array.isArray(run.asked)) {
    out.push(`${at}: what the check asked was not recorded`);
  } else if (run.asked.length > 0) {
    out.push(`${at}: the check asked ${run.asked.join('; ')}, with the check off`);
  }
  return out;
}

/**
 * Every budget box and box with the check off, each run once, of the build the verdict judges by,
 * and holding.
 */
export function verifyBoxes(
  budget: readonly BudgetRun[],
  off: readonly OffRun[],
  current: Pick<Current, 'buildDigest'>,
): string[] {
  const out: string[] = [];
  for (const forwarder of Object.keys(BUDGET_BOXES) as Forwarder[]) {
    const found = budget.filter((run) => run.forwarder === forwarder);
    if (found.length === 0) out.push(`budget box ${forwarder}: not run`);
    if (found.length > 1) out.push(`budget box ${forwarder}: run ${String(found.length)} times`);
    for (const run of found) {
      out.push(...buildProblems(`budget box ${forwarder}`, run, current));
      out.push(...budgetProblems(run));
    }
  }
  for (const run of budget) {
    if (!Object.hasOwn(BUDGET_BOXES, run.forwarder))
      out.push(`budget box ${run.forwarder}: no such box`);
  }
  for (const name of Object.keys(OFF_CASES) as OffCase[]) {
    const found = off.filter((run) => run.case === name);
    if (found.length === 0) out.push(`off box ${name}: not run`);
    if (found.length > 1) out.push(`off box ${name}: run ${String(found.length)} times`);
    for (const run of found) {
      out.push(...buildProblems(`off box ${name}`, run, current));
      out.push(...offProblems(run));
    }
  }
  for (const run of off) {
    if (!Object.hasOwn(OFF_CASES, run.case)) out.push(`off box ${run.case}: no such box`);
  }
  return out;
}

/**
 * Whether systemd-resolved served the stub in a run: some plan asked the stub, and every plan that
 * did had resolved ask its upstream, the simulator. A stub that a plain simulator stood in for asks
 * no upstream, so a box that did not run resolved cannot pass for one that did.
 */
export function resolvedObserved(rows: readonly RowRun[]): boolean {
  const asked = rows.flatMap((row) =>
    row.plans.filter((plan) => plan.wire.some(([server]) => server === STUB)),
  );
  return asked.length > 0 && asked.every((plan) => (plan.upstream ?? []).length > 0);
}

/**
 * Why a row cannot be played as its world says, before any plan, or undefined:
 * - **an IP literal**: Node answers it without calling `getaddrinfo`, so glibc is never asked;
 * - **the stub beside another server**, through systemd-resolved: the stub's questions come from a
 *   capture and the others' from the simulator, with no one clock between them, so the order
 *   across them, which the wire is held to, is not seen.
 */
export function unplayable(
  name: string,
  named: readonly string[],
  viaResolved: boolean,
): string | undefined {
  if (isIP(name) !== 0) return 'an IP literal: Node answers it without asking getaddrinfo';
  if (viaResolved && named.includes(STUB) && named.length > 1) {
    return `the stub with another server (${named.join(', ')}): the order across them is not seen`;
  }
  return undefined;
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
  return { server, qname: labels.join('.'), qtype, transport: 'udp', opt: carriesOpt(dns, at + 4) };
}

/** A domain name's end in a message, its labels or a pointer to them skipped; -1 if it runs out. */
function pastName(dns: Buffer, from: number): number {
  for (let at = from; at < dns.length;) {
    const length = dns[at] ?? 0;
    if (length === 0) return at + 1;
    if ((length & 0xc0) === 0xc0) return at + 2;
    at += 1 + length;
  }
  return -1;
}

/** Whether a query's answer, authority and additional sections, from `at`, hold an OPT record (type 41). */
function carriesOpt(dns: Buffer, from: number): boolean {
  const records = dns.readUInt16BE(6) + dns.readUInt16BE(8) + dns.readUInt16BE(10);
  let at = from;
  for (let k = 0; k < records; k += 1) {
    const end = pastName(dns, at);
    if (end === -1 || end + 10 > dns.length) return false;
    if (dns.readUInt16BE(end) === 41) return true;
    at = end + 10 + dns.readUInt16BE(end + 8);
  }
  return false;
}
