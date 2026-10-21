import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import {
  ForwardBudget,
  FORWARD_HOLD_MS,
  GAI_TOKENS,
  type GaiToken,
  type TokenKind,
} from '../src/resolver/forward-budget.js';
import {
  admitHelper,
  HelperKeys,
  helperUngated,
  KEY_QUIET,
  RISK_F,
  RISK_T,
  type HelperClass,
} from '../src/resolver/lane-rule.js';
import {
  HelperLookupError,
  type HelperAnswer,
  type HelperAsk,
  type LossReason,
} from '../src/resolver/lookup-helper.js';
import { NameResolver, RESOLVER_LANES, type Family } from '../src/resolver/name-resolver.js';
import { FakeHelper, StubPolicy, type FakeAsk } from './support/fake-helper.js';

/**
 * LR7 (`P-432` §7.2): a model of the lookup helper's lanes, run against the resolver as built.
 * Seeded runs of random commands (asks and "Check now", answers, denials, stuck, losses of every
 * kind with requeues, charges and isolation, answers after a loss, a failed send, the child going
 * quiet and being heard again, U rising and falling, time passing); after every command, I1 to I9.
 * And at every call of the probe's own `getaddrinfo`, I10 (D27): the name is not one the helper
 * keeps off the probe's lanes, each name in flight at an `exit`, `memory` or `hung` loss or as the
 * child goes quiet marked as the real helper marks it, and every poison mark. As each token is
 * taken, I11 (`P-478`'s fix round 1): a key held to 3 never gives the last of them to a name that
 * does not answer while a lookup of one that answers waits.
 * The generator is a seeded PRNG of its own: `fast-check` is not one of the probe's dependencies,
 * and a failing run prints its seed and its last commands, which replay it exactly.
 *
 * `MS_LR7_RUNS` and `MS_LR7_COMMANDS` set the size; the default is the design's, 1,000 runs of 200.
 */

const RUNS = Number(process.env['MS_LR7_RUNS'] ?? 1_000);
const COMMANDS = Number(process.env['MS_LR7_COMMANDS'] ?? 200);
const FIRST_SEED = Number(process.env['MS_LR7_SEED'] ?? 1);

const silent = pino({ level: 'silent' });
const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];
const LONG = 3_600_000;

/** mulberry32: small, seeded and the same on every machine. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What the test reads of a name's entry, through a lookup of it (`P-478`'s fix round 1). */
interface EntryPeek {
  readonly host: string;
  readonly family: Family;
  readonly domain: string;
  readonly failures: number;
  readonly lastAnsweredAt: number | undefined;
  readonly denial: object | undefined;
  readonly pending: Peek | undefined;
}

/** What the test reads of a lookup the resolver handed the helper as its reference. */
interface Peek {
  readonly state: 'queued' | 'running' | 'done';
  readonly token: GaiToken | undefined;
  readonly urgent: boolean;
  readonly cls: HelperClass;
  readonly key: string;
  readonly stuck: boolean;
  readonly detached: boolean;
  readonly poisonAsk: boolean;
  readonly suspect: boolean;
  readonly ungated: boolean;
  readonly pool: 'probe' | 'helper';
  readonly entry: EntryPeek;
}

const peek = (ref: object): Peek => ref as Peek;

/** A budget that tells the model every take and every release that did something (I8, I9). */
class RecordingBudget extends ForwardBudget {
  onTake: ((kind: TokenKind, holder: object) => void) | undefined;
  readonly live = new Set<GaiToken>();
  readonly releases = new Map<GaiToken, number>();

  override takeGai(kind: TokenKind, questions: number, holder: object): GaiToken | undefined {
    this.onTake?.(kind, holder);
    const token = super.takeGai(kind, questions, holder);
    if (token !== undefined) this.live.add(token);
    return token;
  }

  override releaseGai(token: GaiToken): void {
    const before = this.stats().released;
    super.releaseGai(token);
    if (this.stats().released > before) {
      this.live.delete(token);
      this.releases.set(token, (this.releases.get(token) ?? 0) + 1);
    }
  }
}

/** The helper with one more fault: the next send fails, and the child is lost with it. */
class ModelHelper extends FakeHelper {
  failNextSend = false;

  override ask(request: HelperAsk): Promise<HelperAnswer> {
    const asked = super.ask(request);
    if (this.failNextSend && this.route === 'up') {
      this.failNextSend = false;
      queueMicrotask(() => {
        this.lose('exit', 'rejoining');
      });
    }
    return asked;
  }
}

interface ProbeCall {
  readonly host: string;
  done: boolean;
  readonly answer: () => void;
  readonly fail: (code: string) => void;
}

const DOMAINS = ['zone-a.test', 'zone-b.test', 'zone-c.test'];
const NAMES = [
  ...DOMAINS.flatMap((domain) => [0, 1, 2, 3].map((n) => `n${String(n)}.${domain}`)),
  'solo1',
  'solo2',
  'gw.test',
];
const LOCAL = 'gw.test';

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function model(seed: number) {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(random() * list.length)];
  const clock = { now: 0 };
  const helper = new ModelHelper(() => clock.now);
  const policy = new StubPolicy();
  policy.local = (host) => host === LOCAL;
  const budget = new RecordingBudget({ now: () => clock.now });
  const keys = new HelperKeys();
  const calls: ProbeCall[] = [];
  const log: string[] = [];
  const violations: string[] = [];
  const resolver = new NameResolver({
    logger: silent,
    lookup: (host, family) =>
      new Promise((resolve, reject) => {
        // I10 (D27): never a name the helper says may be what crashed it.
        if (helper.avoidsSystem(host, family)) {
          violations.push(`I10: ${host} (${String(family)}) asked on the probe’s own getaddrinfo`);
        }
        const call: ProbeCall = {
          host,
          done: false,
          answer: () => {
            call.done = true;
            resolve(A);
          },
          fail: (code) => {
            call.done = true;
            reject(Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code }));
          },
        };
        calls.push(call);
      }),
    now: () => clock.now,
    random: () => 0.5,
    // The probe's lanes are never stuck here: U is the model's to raise.
    stuckMs: LONG,
    watch: { files: [], everyMs: LONG },
    gate: { helper, policy, budget, keys, tickMs: LONG },
  });
  helper.onChange = (change) => {
    resolver.onHelperChange(change);
  };

  const untokened = new Set<object>();
  let uMax = 0;
  /** Lookups lost with a child and asked again in the next: a late answer may name them. */
  const requeued: object[] = [];

  /** Every helper lookup running, as the lookups themselves say: a recount for I1. */
  const helperRunning = (): Peek[] => {
    const seen = new Set<object>();
    const running: Peek[] = [];
    for (const ask of helper.asks) {
      const ref = ask.ref;
      if (ref === undefined || seen.has(ref)) continue;
      seen.add(ref);
      const p = peek(ref);
      if (p.state === 'running' && p.pool === 'helper') running.push(p);
    }
    return running;
  };

  const ungatedNow = (p: Peek): boolean =>
    helperUngated({
      overflow: false,
      vouched: false,
      keyQuiet: keys.quiet(p.key),
      unitCapped: keys.capped(p.key, p.cls),
    });

  /** §1.8's at-risk count, recounted from the lookups (I4). */
  const atRiskNow = (): number => {
    let risk = budget.ghosts('shared') + budget.ghosts('kept') + budget.untokened();
    for (const p of helperRunning()) {
      if (p.token === undefined || p.token.kind === 'urgent') continue;
      if (p.stuck || p.detached) risk += 1;
      else if (p.token.kind === 'shared' && !ungatedNow(p)) risk += 1;
    }
    return risk;
  };

  /**
   * Whether a name answers now (`P-478`'s fix round 1), recounted from its entry: its last lookup
   * answered, with addresses or a denial, and none of its lookups is stuck or failing.
   */
  const answeringNow = (entry: EntryPeek): boolean =>
    entry.failures === 0 &&
    entry.pending?.stuck !== true &&
    (entry.lastAnsweredAt !== undefined || entry.denial !== undefined);

  /**
   * Every name the model has seen a helper lookup of, by its entry: where it looks for a key's
   * lookups queued for a name that answers. A name only ever asked on the probe's lanes is not
   * among them, so a queued lookup the model does not see is judged both ways (I2, I11).
   */
  const seenEntries = new Set<EntryPeek>();
  /** Starts I11 judged with a lookup of an answering name known queued: it must be reached. */
  let keptJudged = 0;

  const classOkNow = (cls: HelperClass): boolean => {
    const running = helperRunning().filter((p) => !p.urgent);
    const of = (c: HelperClass): number => running.filter((p) => p.cls === c).length;
    if (cls === 'retry') return of('retry') < 1;
    return of(cls) < RESOLVER_LANES - 2 && of('first') + of('refresh') < RESOLVER_LANES - 1;
  };

  // I2, I4, I6, I8 are judged as each token is taken: what the lookup was admitted on, before it
  // starts. A lookup asked again after a loss carries its token and takes none; a suspect while
  // isolating and a poison name's ask are sent alone, outside the admission.
  budget.onTake = (kind, holder) => {
    const p = peek(holder);
    if (p.poisonAsk || (p.suspect && helper.isolating())) return;
    const atRisk = atRiskNow();
    const stuckAnywhere = helperRunning().some(
      (running) =>
        running.stuck && (running.key === p.key || running.entry.domain === p.entry.domain),
    );
    for (const sent of helper.asks)
      if (sent.ref !== undefined) seenEntries.add(peek(sent.ref).entry);
    seenEntries.add(p.entry);
    const nameAnswering = answeringNow(p.entry);
    const keyFailingRunning = helperRunning().filter(
      (running) =>
        running.key === p.key &&
        !running.detached &&
        (running.stuck || !answeringNow(running.entry)),
    ).length;
    const knownQueued = [...seenEntries].some((entry) => {
      const queued = entry.pending;
      return (
        queued !== undefined &&
        queued !== p &&
        queued.state === 'queued' &&
        queued.pool === 'helper' &&
        queued.key === p.key &&
        answeringNow(entry)
      );
    });
    const ask = {
      urgent: p.urgent,
      overflow: false,
      stuckAnywhere,
      keyNew: keys.isNew(p.key),
      keyQuiet: keys.quiet(p.key),
      keyRunning: keys.running(p.key),
      vouched: false,
      nameAnswering,
      keyAnsweringQueued: knownQueued,
      keyFailingRunning,
      // The model builds no name check, so no key is vouched and the key rule holds each to 3:
      // `P-481`'s rule never binds here. Its cases are the check's own (`name-resolver-check`).
      keyFirstRunning: p.cls === 'first' ? keys.unitRunning(p.key, 'first') : 0,
      firstCap: RESOLVER_LANES - 2,
      otherKeyFirstQueued: [...seenEntries].some((entry) => {
        const queued = entry.pending;
        return (
          queued !== undefined &&
          queued.state === 'queued' &&
          queued.pool === 'helper' &&
          queued.cls === 'first' &&
          !queued.urgent &&
          queued.key !== p.key
        );
      }),
      unitRunning: keys.unitRunning(p.key, p.cls),
      unitCapped: keys.capped(p.key, p.cls),
      atRisk,
      classOk: p.urgent || classOkNow(p.cls),
      // The model builds no name check: nothing is vouched, and no lane is kept (`P-478`), as with
      // the check off.
      classSpare: p.urgent || classOkNow(p.cls),
      keepLast: false,
      urgentAvailable: budget.available('urgent'),
      sharedAvailable: budget.available('shared'),
      keptAvailable: budget.available('kept'),
    };
    // A lookup queued for an answering name the model has not seen may be what the pick read.
    const admitted = admitHelper(ask);
    const unseen = knownQueued ? admitted : admitHelper({ ...ask, keyAnsweringQueued: true });
    if (admitted !== kind && unseen !== kind) {
      violations.push(
        `I2: ${p.entry.host} took a ${kind} token where admit says ${String(admitted)}`,
      );
    }
    const ungated = helperUngated(ask);
    if (kind !== 'urgent' && !ungated) {
      const firstLook = ask.keyNew && ask.keyRunning === 0;
      if (atRisk >= (firstLook ? RISK_T + RISK_F : RISK_T)) {
        violations.push(`I4: a gated start for ${p.entry.host} at risk ${String(atRisk)}`);
      }
    }
    // I6 (`P-478`): a key the walk does not vouch for, quiet or not, never starts its 4th.
    if (kind !== 'urgent' && !ask.vouched && ask.keyRunning >= KEY_QUIET) {
      violations.push(
        `I6: unvouched key ${p.key} started its ${String(ask.keyRunning + 1)}th (${p.entry.host})`,
      );
    }
    // I11 (`P-478`'s fix round 1): while a lookup of a name that answers waits, a key's names
    // that do not answer never take the last of its 3.
    if (kind !== 'urgent' && !nameAnswering && knownQueued && ask.keyRunning < KEY_QUIET) {
      keptJudged += 1;
      if (keyFailingRunning >= KEY_QUIET - 1) {
        violations.push(
          `I11: ${p.entry.host} took the last lane of ${p.key}, held by ` +
            `${String(keyFailingRunning)} that do not answer, while one that answers waits`,
        );
      }
    }
    if (kind === 'kept' && (!ungated || p.urgent)) {
      violations.push(`I8: the kept token taken by a gated lookup, ${p.entry.host}`);
    }
  };

  const ask = (host: string, family: Family, fresh: boolean): void => {
    resolver.resolve(host, family, { fresh, waitMs: LONG }).then(
      () => undefined,
      () => undefined,
    );
  };

  /** I1, I3, I5, I7, I8, I9 after a command. */
  const check = (): void => {
    const running = helperRunning();
    const probeRunning = calls.filter((call) => !call.done).length;
    const stats = resolver.stats();
    // I1: the counts are a recount.
    if (stats.running !== running.length + probeRunning) {
      violations.push(
        `I1: running ${String(stats.running)}, recounted ${String(running.length)} + ${String(probeRunning)}`,
      );
    }
    const held = budget.stats().held;
    const heldAll = held.shared + held.kept + held.urgent;
    if (heldAll !== budget.live.size) {
      violations.push(`I1: tokens held ${String(heldAll)}, recounted ${String(budget.live.size)}`);
    }
    const holders = new Set<GaiToken>();
    for (const p of running) {
      if (p.token === undefined || p.token.released) {
        violations.push(`I1: ${p.entry.host} runs in the helper with no token`);
      } else if (holders.has(p.token)) {
        violations.push(`I1: two lookups hold one token (${p.entry.host})`);
      } else {
        holders.add(p.token);
      }
    }
    for (const token of budget.live) {
      const holder = peek(token.holder);
      if (holder.state === 'done') violations.push(`I1: a done lookup holds a token`);
      if (holder.state === 'queued' && holder.token !== token) {
        violations.push(`I1: a queued lookup's token is not its own`);
      }
    }
    if (keys.size().lookups !== running.length) {
      violations.push(
        `I1: the keys know ${String(keys.size().lookups)} lookups, ${String(running.length)} run`,
      );
    }
    for (const key of new Set(running.map((p) => p.key))) {
      const counted = running.filter((p) => p.key === key && !p.detached).length;
      if (keys.running(key) !== counted) {
        violations.push(
          `I1: key ${key} runs ${String(keys.running(key))}, recounted ${String(counted)}`,
        );
      }
    }
    if (budget.untokened() !== untokened.size) violations.push('I1: U is not the recount');
    // I3: the bounds.
    const byKind = { shared: 0, kept: 0, urgent: 0 };
    for (const p of running) if (p.token !== undefined) byKind[p.token.kind] += 1;
    if (byKind.shared + byKind.kept > GAI_TOKENS.shared + GAI_TOKENS.kept) {
      violations.push(`I3: ${String(byKind.shared + byKind.kept)} general tokens run`);
    }
    if (byKind.urgent > GAI_TOKENS.urgent) violations.push(`I3: ${String(byKind.urgent)} urgent`);
    if (held.shared > GAI_TOKENS.shared || held.kept > GAI_TOKENS.kept) {
      violations.push(`I3: held ${JSON.stringify(held)}`);
    }
    const classed = running.filter((p) => !p.urgent);
    const of = (cls: HelperClass): number => classed.filter((p) => p.cls === cls).length;
    if (of('retry') > 1) {
      violations.push(
        `I3: ${String(of('retry'))} retries run (${classed
          .filter((p) => p.cls === 'retry')
          .map((p) => `${p.entry.host}${p.suspect ? ' suspect' : ''}${p.stuck ? ' stuck' : ''}`)
          .join(', ')})`,
      );
    }
    if (of('first') > RESOLVER_LANES - 2) violations.push(`I3: ${String(of('first'))} first run`);
    if (of('refresh') > RESOLVER_LANES - 2) {
      violations.push(`I3: ${String(of('refresh'))} refreshes run`);
    }
    if (of('first') + of('refresh') > RESOLVER_LANES - 1) {
      violations.push(`I3: ${String(of('first') + of('refresh'))} first and refresh run`);
    }
    // I7: what the forwarder holds is bounded by the lanes and U.
    const ghosts = budget.ghosts('shared') + budget.ghosts('kept');
    if (held.shared + held.kept + ghosts + untokened.size > RESOLVER_LANES + uMax) {
      violations.push(`I7: held ${String(held.shared + held.kept)} + ghosts ${String(ghosts)} + U`);
    }
    // I8: the kept token is free, or held by a lookup ungated at its start.
    for (const token of budget.live) {
      if (token.kind !== 'kept') continue;
      const holder = peek(token.holder);
      if (!holder.ungated) {
        violations.push(
          `I8: the kept token is a gated lookup’s: ${holder.entry.host} ${holder.state}` +
            (holder.urgent ? ' urgent' : ''),
        );
      }
    }
    // I9: every release that did something, once per token.
    for (const [token, count] of budget.releases) {
      if (count > 1) violations.push(`I9: a token released ${String(count)} times (${token.kind})`);
    }
  };

  /** A change that says nothing new: the resolver routes and pumps again, as its tick does. */
  const tick = (): void => {
    resolver.onHelperChange({
      state: helper.state,
      previous: helper.state,
      route: helper.route,
      isolating: helper.isolatingNow,
    });
  };

  /** I5: a pump with nothing new to hear starts nothing: what could run, runs. */
  const conserving = async (): Promise<void> => {
    const asks = helper.asks.length;
    const probe = calls.length;
    tick();
    await settled();
    if (helper.asks.length !== asks) {
      const started = helper.asks.slice(asks).map((sent) => {
        const p = sent.ref === undefined ? undefined : peek(sent.ref);
        return `${sent.host} ${p?.cls ?? '?'}${p?.urgent === true ? ' urgent' : ''}`;
      });
      violations.push(`I5: helper lookups could have run: ${started.join(', ')}`);
    }
    if (calls.length !== probe) violations.push(`I5: probe-lane lookups could have run`);
  };

  const inFlight = (): FakeAsk[] => helper.inFlight();

  const lose = (reason: LossReason): void => {
    const roll = random();
    const route = roll < 0.1 ? 'resting' : roll < 0.2 ? 'down' : 'rejoining';
    const charged = random() < 0.2 ? pick(inFlight()) : undefined;
    const isolate = reason === 'exit' && random() < 0.3;
    if (isolate) helper.isolatingNow = true;
    for (const lost of inFlight()) {
      if (lost.ref !== undefined && lost !== charged && !lost.stuckSaid && route !== 'resting') {
        requeued.push(lost.ref);
      }
    }
    if (charged !== undefined) {
      helper.markPoison(charged.host, charged.family, clock.now + LONG);
    }
    // Each name in flight may be what ended the child, crash or not (D27, `P-453`): the real
    // helper keeps it off the probe's lanes for ten minutes after it is next up, here for good. A
    // hung child's were kept off as it went quiet (`goQuiet`, `P-463`); the model also loses a
    // child as hung that never went quiet, and keeps its names off as the real one would have.
    if (reason === 'exit' || reason === 'memory' || reason === 'hung') {
      for (const lost of inFlight()) helper.avoided.add(`${String(lost.family)}:${lost.host}`);
    }
    helper.lose(reason, route, {
      ...(charged === undefined ? {} : { charged }),
      suspects: isolate,
    });
    log.push(
      `lose ${reason} → ${route}${charged === undefined ? '' : ` charged ${charged.host}`}` +
        (isolate ? ', isolating' : ''),
    );
  };

  const step = async (): Promise<void> => {
    const roll = random();
    if (roll < 0.34) {
      const host = pick(NAMES) ?? 'solo1';
      const family: Family = random() < 0.5 ? 4 : 0;
      const fresh = random() < 0.1;
      log.push(`ask ${host} ${String(family)}${fresh ? ' (Check now)' : ''}`);
      ask(host, family, fresh);
    } else if (roll < 0.49) {
      const target = pick(inFlight());
      log.push(`answer ${target?.host ?? '-'}`);
      target?.answer();
    } else if (roll < 0.56) {
      const target = pick(inFlight());
      const code = pick(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']) ?? 'EAI_AGAIN';
      log.push(`fail ${target?.host ?? '-'} ${code}`);
      target?.fail(code);
    } else if (roll < 0.66) {
      const target = pick(inFlight().filter((a) => !a.stuckSaid));
      log.push(`stuck ${target?.host ?? '-'}`);
      target?.stuck();
    } else if (roll < 0.71) {
      const target = pick(calls.filter((call) => !call.done));
      log.push(`probe lane settles ${target?.host ?? '-'}`);
      if (random() < 0.7) target?.answer();
      else target?.fail('EAI_AGAIN');
    } else if (roll < 0.76) {
      if (helper.route === 'up') lose(pick(['exit', 'hung', 'memory', 'exit'] as const) ?? 'exit');
      else log.push('lose (not up)');
    } else if (roll < 0.79) {
      // A lost child's answer for a lookup asked again: settled once, if still queued.
      const ref = pick(requeued);
      log.push(`late answer ${ref === undefined ? '-' : peek(ref).entry.host}`);
      if (ref !== undefined) {
        resolver.onHelperLateAnswer(
          ref,
          random() < 0.7
            ? { ok: true, answer: { addresses: A, total: 1, ranMs: 5 } }
            : { ok: false, error: new HelperLookupError('getaddrinfo ENOTFOUND', 'ENOTFOUND', 5) },
        );
      }
    } else if (roll < 0.81) {
      log.push('the next send fails');
      helper.failNextSend = true;
    } else if (roll < 0.84) {
      if (helper.route === 'up') {
        log.push('the child goes quiet');
        helper.goQuiet();
      } else {
        log.push('quiet (not up)');
      }
    } else if (roll < 0.92) {
      if (helper.route === 'up') {
        log.push('up (already)');
      } else if (helper.route === 'down' && helper.state === 'unresponsive' && random() < 0.4) {
        log.push('the quiet child is hung');
        lose('hung');
      } else if (helper.route === 'resting' && random() < 0.5) {
        log.push('the rest ends: backoff');
        helper.move('rejoining', { state: 'backoff' });
      } else {
        log.push(`heard: ${helper.route} → up`);
        helper.move('up', { state: 'up' });
      }
    } else if (roll < 0.95) {
      if (random() < 0.6 || untokened.size === 0) {
        const holder = {};
        untokened.add(holder);
        uMax = Math.max(uMax, untokened.size);
        budget.untokenedStuck(holder, random() < 0.5 ? 1 : 2);
        log.push(`U rises to ${String(untokened.size)}`);
      } else {
        const holder = pick([...untokened]);
        if (holder !== undefined) {
          untokened.delete(holder);
          budget.untokenedDone(holder);
        }
        log.push(`U falls to ${String(untokened.size)}`);
        // Its lookup's end pumps, as `#settle` does.
        tick();
      }
    } else if (roll < 0.98) {
      const ms = Math.floor(random() * 6_000);
      clock.now += ms;
      log.push(`${String(ms)} ms pass, and the gate ticks`);
      tick();
    } else {
      const host = pick(NAMES.filter((name) => name !== LOCAL)) ?? 'solo1';
      log.push(`${host} marked poison`);
      helper.markPoison(host, 4, clock.now + LONG);
    }
    await settled();
    await conserving();
    check();
  };

  /** Everything answered, every U ended, ghosts past their hold: nothing may be left held. */
  const drain = async (): Promise<void> => {
    for (const holder of untokened) budget.untokenedDone(holder);
    untokened.clear();
    helper.isolatingNow = false;
    for (let round = 0; round < 50; round += 1) {
      if (helper.route !== 'up') helper.move('up', { state: 'up' });
      clock.now += FORWARD_HOLD_MS + 1;
      tick();
      await settled();
      for (const target of inFlight()) target.answer();
      for (const call of calls.filter((c) => !c.done)) call.answer();
      await settled();
      if (inFlight().length === 0 && calls.every((c) => c.done) && resolver.stats().queued === 0) {
        break;
      }
    }
    check();
    const stats = resolver.stats();
    if (stats.running !== 0 || stats.queued !== 0) {
      violations.push(`drained: ${String(stats.running)} running, ${String(stats.queued)} queued`);
    }
    if (budget.live.size !== 0) violations.push(`drained: ${String(budget.live.size)} tokens held`);
    if (keys.size().lookups !== 0) violations.push('drained: the keys still know lookups');
    resolver.stop();
  };

  return {
    step,
    drain,
    log,
    violations,
    asks: () => helper.asks.length,
    keptJudged: () => keptJudged,
  };
}

describe('LR7: a model of the lookup helper’s lanes (P-432 S3, §7.2)', () => {
  it(`holds I1 to I11 over ${String(RUNS)} seeded runs of ${String(COMMANDS)} commands`, async (t) => {
    let asks = 0;
    let keptJudged = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed += 1) {
      const run = model(seed);
      for (let n = 0; n < COMMANDS; n += 1) {
        await run.step();
        if (run.violations.length > 0) break;
      }
      if (run.violations.length === 0) await run.drain();
      asks += run.asks();
      keptJudged += run.keptJudged();
      assert.deepEqual(
        run.violations,
        [],
        `seed ${String(seed)} (MS_LR7_SEED=${String(seed)} MS_LR7_RUNS=1), its last commands:\n  ` +
          run.log.slice(-30).join('\n  '),
      );
    }
    // The model reached the helper: a run that never asked it proves nothing.
    assert.ok(asks > RUNS * 20, `${String(asks)} helper asks over the runs`);
    t.diagnostic(`I11 judged ${String(keptJudged)} starts of a name that does not answer`);
    // I11 judged a start that did not answer beside one that does, queued: not vacuous.
    assert.ok(RUNS < 100 || keptJudged > 0, `I11 judged ${String(keptJudged)} starts`);
  });
});
