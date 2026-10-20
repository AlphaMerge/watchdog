import type { ResolvedAddress } from '@ms/sensors';
import {
  familiesMet,
  HelperLookupError,
  HelperLostError,
  mayRequeue,
  type HelperAnswer,
  type HelperAsk,
  type HelperChange,
  type HelperLoss,
  type HelperPort,
  type HelperSnapshot,
  type HelperState,
  type LookupHelperStats,
  type LossReason,
  type PoisonMark,
  type RouteState,
} from '../../src/resolver/lookup-helper.js';
import type { Family } from '../../src/resolver/name-resolver.js';
import type {
  CheckOff,
  NameClass,
  PolicyChange,
  PolicyDescription,
  PolicySnapshot,
  PolicyView,
  SystemNamePolicy,
} from '../../src/resolver/system-names.js';
import type { WatchedReading } from '../../src/resolver/name-resolver.js';

/**
 * A lookup helper the test plays (`P-432` S3): every ask is held until the test answers it, says
 * it is stuck, or loses it with its child; the route is what the test sets; a change goes to the
 * resolver as the real helper sends it, a microtask after the lookups it affects are settled.
 */

/** One ask the resolver made of the helper. */
export interface FakeAsk {
  readonly host: string;
  readonly family: Family;
  readonly max: number;
  readonly ref: object | undefined;
  readonly suspect: boolean;
  /** Whether the test has said it is stuck. */
  stuckSaid: boolean;
  /** Whether it has been settled, one way or another. */
  done: boolean;
  answer(addresses?: readonly ResolvedAddress[], total?: number): void;
  fail(code: string): void;
  stuck(): void;
  reject(error: Error): void;
}

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];

function stateOf(route: RouteState): HelperState {
  switch (route) {
    case 'up':
      return 'up';
    case 'rejoining':
      return 'backoff';
    case 'down':
      return 'unresponsive';
    case 'resting':
      return 'resting';
  }
}

export class FakeHelper implements HelperPort {
  route: RouteState = 'up';
  state: HelperState = 'up';
  isolatingNow = false;
  endedIsolation = 0;
  /** Each hold the resolver said a suspect has, in ms (`suspectHeld`). */
  readonly held: number[] = [];
  readonly asks: FakeAsk[] = [];
  readonly poisoned = new Map<string, PoisonMark>();
  /**
   * Names kept off the probe's lanes, as `family:host`: what the real helper keeps for a name in
   * flight at a loss, or as its child goes quiet (`goQuiet`). `avoidsSystem` reads it as the real
   * one does, poison marks with it.
   */
  readonly avoided = new Set<string>();
  readonly skewed: string[] = [];
  readonly snapshots: (HelperSnapshot | undefined)[] = [];
  /** The child's resident set at its last beat, as `stats()` says it. */
  rss: number | undefined = undefined;
  /** The last loss `lose` took, as the real helper keeps it: its child's end can be set after. */
  lastLoss: HelperLoss | undefined;
  readonly lossTotals: Record<LossReason, number> = {
    start: 0,
    skew: 0,
    exit: 0,
    hung: 0,
    memory: 0,
  };
  onChange: ((change: HelperChange) => void) | undefined;
  readonly #now: () => number;

  constructor(now: () => number = () => 0) {
    this.#now = now;
  }

  start(snapshot?: HelperSnapshot): Promise<boolean> {
    this.snapshots.push(snapshot);
    return Promise.resolve(this.route === 'up');
  }

  ask(request: HelperAsk): Promise<HelperAnswer> {
    if (this.route !== 'up') {
      return Promise.reject(
        new HelperLostError(`not up: ${request.host}`, {
          reason: 'unavailable',
          stuck: false,
          detached: false,
          started: false,
          charged: false,
          requeue: false,
          suspect: false,
          pid: undefined,
        }),
      );
    }
    return new Promise<HelperAnswer>((resolve, reject) => {
      const ask: FakeAsk = {
        host: request.host,
        family: request.family,
        max: request.max,
        ref: request.ref,
        suspect: request.suspect === true,
        stuckSaid: false,
        done: false,
        answer: (addresses = A, total = addresses.length) => {
          if (ask.done) return;
          ask.done = true;
          resolve({ addresses, total, ranMs: 5 });
        },
        fail: (code) => {
          if (ask.done) return;
          ask.done = true;
          reject(new HelperLookupError(`getaddrinfo ${code} ${request.host}`, code, 5));
        },
        stuck: () => {
          if (ask.done || ask.stuckSaid) return;
          ask.stuckSaid = true;
          request.onStuck?.(1_000);
        },
        reject: (error) => {
          if (ask.done) return;
          ask.done = true;
          reject(error);
        },
      };
      this.asks.push(ask);
    });
  }

  /** The asks still in flight. */
  inFlight(): FakeAsk[] {
    return this.asks.filter((ask) => !ask.done);
  }

  /** The asks made for a name, oldest first. */
  asksFor(host: string): FakeAsk[] {
    return this.asks.filter((ask) => ask.host === host);
  }

  /** The last ask made for a name. */
  last(host: string): FakeAsk {
    const ask = this.asksFor(host).at(-1);
    if (ask === undefined) throw new Error(`no ask for ${host}`);
    return ask;
  }

  /**
   * The child lost: every ask in flight rejected in one turn with S2's facts, then the change to
   * `route` a microtask later. `charged` names the one ask the crash is charged to.
   */
  lose(
    reason: LossReason,
    route: RouteState,
    options: {
      readonly charged?: FakeAsk;
      readonly suspects?: boolean;
      readonly ends?: boolean;
      /** How the child ended, when its exit is read with the loss: unknown (null) unless said. */
      readonly signal?: NodeJS.Signals;
      readonly exitCode?: number;
    } = {},
  ): void {
    const ends = options.ends ?? route === 'resting';
    this.lossTotals[reason] += 1;
    this.lastLoss = {
      at: this.#now(),
      reason,
      pid: 4242,
      why: `the test lost it (${reason})`,
      exitCode: options.exitCode ?? null,
      signal: options.signal ?? null,
      stderr: '',
      fatal: undefined,
      held: 0,
      requeued: 0,
      faulted: 0,
      chargedTo: undefined,
      charged: undefined,
    };
    for (const ask of this.inFlight()) {
      const charged = ask === options.charged;
      const requeue = mayRequeue(reason, { stuck: ask.stuckSaid, detached: false, charged }, ends);
      ask.reject(
        new HelperLostError(`the lookup helper was lost (${reason}) while asking for ${ask.host}`, {
          reason,
          stuck: ask.stuckSaid,
          detached: false,
          started: true,
          charged,
          requeue,
          suspect: options.suspects === true && (requeue || ask.stuckSaid),
          pid: 4242,
        }),
      );
    }
    this.route = route;
    const previous = this.state;
    this.state = stateOf(route);
    queueMicrotask(() => {
      this.onChange?.({
        state: this.state,
        previous,
        route,
        isolating: this.isolatingNow,
        loss: reason,
      });
    });
  }

  /** A change of route with no loss: the child judged quiet, back up, a window closed, a rest. */
  move(route: RouteState, extra: Partial<HelperChange> = {}): void {
    this.route = route;
    const previous = this.state;
    this.state = extra.state ?? stateOf(route);
    this.onChange?.({
      state: this.state,
      previous,
      route,
      isolating: this.isolatingNow,
      ...extra,
    });
  }

  /**
   * The child judged quiet (D26): every ask in flight detached, its name kept off the probe's lanes
   * as the real helper keeps it (`P-463`), and the route down.
   */
  goQuiet(): void {
    const quiet = this.inFlight();
    for (const ask of quiet) this.avoided.add(`${String(ask.family)}:${ask.host}`);
    const detached = quiet.map((ask) => ask.ref).filter((ref): ref is object => ref !== undefined);
    this.move('down', { state: 'unresponsive', detached });
  }

  routeState(): RouteState {
    return this.route;
  }

  isolating(): boolean {
    return this.isolatingNow;
  }

  endIsolation(): void {
    if (!this.isolatingNow) return;
    this.isolatingNow = false;
    this.endedIsolation += 1;
  }

  suspectHeld(forMs: number): void {
    this.held.push(forMs);
  }

  /** As the real helper answers: a mark in any family a lookup of `family` asks for (D27). */
  avoidsSystem(host: string, family: 0 | 4 | 6): boolean {
    return familiesMet(family).some((met) => {
      const key = `${String(met)}:${host}`;
      return this.avoided.has(key) || this.poisoned.has(key);
    });
  }

  poison(host: string, family: 0 | 4 | 6): PoisonMark | undefined {
    return this.poisoned.get(`${String(family)}:${host}`);
  }

  /** Marks a name poison, due its hourly ask at `nextAskAt`. */
  markPoison(host: string, family: 0 | 4 | 6, nextAskAt: number): PoisonMark {
    const mark: PoisonMark = {
      host,
      family,
      markedAt: this.#now(),
      signal: 'SIGSEGV',
      nextAskAt,
      retryMs: 3_600_000,
    };
    this.poisoned.set(`${String(family)}:${host}`, mark);
    return mark;
  }

  poisonDue(): readonly PoisonMark[] {
    const now = this.#now();
    return [...this.poisoned.values()].filter((mark) => mark.nextAskAt <= now);
  }

  markSkewed(file: string): void {
    this.skewed.push(file);
  }

  stats(): LookupHelperStats {
    return {
      state: this.state,
      route: this.route,
      pid: 4242,
      inFlight: this.inFlight().length,
      losses: Object.values(this.lossTotals).reduce((sum, n) => sum + n, 0),
      lossesByReason: { ...this.lossTotals },
      lastLoss: this.lastLoss === undefined ? undefined : { ...this.lastLoss },
      rss: this.rss,
      rssPeak: this.rss ?? 0,
      lagMaxMs: undefined,
      lagPeakMs: 0,
      isolating: this.isolatingNow,
      poisoned: this.poisoned.size,
      msInState: {
        idle: 0,
        starting: 0,
        up: 0,
        unresponsive: 0,
        backoff: 0,
        resting: 0,
        stopping: 0,
        stopped: 0,
      },
      ticks: 0,
      quietTicks: 0,
      heardTicks: 0,
      messages: 0,
      restMs: undefined,
    };
  }

  stop(): Promise<void> {
    for (const ask of this.inFlight()) {
      ask.reject(
        new HelperLostError(`the probe is stopping: ${ask.host} was not answered`, {
          reason: 'stop',
          stuck: ask.stuckSaid,
          detached: false,
          started: true,
          charged: false,
          requeue: false,
          suspect: false,
          pid: 4242,
        }),
      );
    }
    this.move('down', { state: 'stopped' });
    return Promise.resolve();
  }
}

/** A name policy the test sets: which names are `local`, and whether the check is off. */
export class StubPolicy implements SystemNamePolicy {
  local: (host: string, family: Family) => boolean = () => false;
  off: CheckOff | undefined = { code: 'unloaded', why: 'the test’s policy vouches for nothing' };
  readOnce: string[] = [];
  moved: string[] = [];
  isSkewed = false;
  readonly loads: ({ readonly hosts?: string } | undefined)[] = [];
  readonly looks: (readonly WatchedReading[])[] = [];
  watched: string[] = [];

  load(options?: { readonly hosts?: string }): Promise<void> {
    this.loads.push(options);
    return Promise.resolve();
  }

  looked(readings: readonly WatchedReading[]): Promise<PolicyChange> {
    this.looks.push(readings);
    const moved = this.moved.filter((file) => readings.some((reading) => reading.file === file));
    return Promise.resolve({ applied: [], moved, nscdChanged: false });
  }

  classify(host: string, family: Family): NameClass {
    if (this.local(host, family)) return { kind: 'local', via: 'hosts' };
    return { kind: 'off', reason: this.off ?? { code: 'unloaded', why: 'off' } };
  }

  view(): PolicyView {
    return {
      platform: 'linux',
      glibc: [2, 39],
      conf: undefined,
      line: undefined,
      hosts: new Map(),
      nscd: false,
      modules: new Map(),
      gaiReload: false,
      off: this.off,
    };
  }

  snapshot(): PolicySnapshot {
    return { node: process.version, glibc: '2.39', digests: {} };
  }

  skewed(): boolean {
    return this.isSkewed;
  }

  watchedFiles(): readonly string[] {
    return this.watched;
  }

  /** On while the test says the check is: the stub plays a build that has it. */
  checkOn(): boolean {
    return this.off === undefined;
  }

  describe(): PolicyDescription {
    return {
      check: this.off === undefined ? 'on' : 'off',
      off: this.off,
      shapeOff: this.off,
      platform: 'linux',
      glibc: '2.39',
      servers: [],
      search: [],
      searchFrom: undefined,
      options: undefined,
      hostsLine: undefined,
      nscd: false,
      modules: [],
      readOnce: this.readOnce,
      skewed: this.isSkewed,
    };
  }
}
