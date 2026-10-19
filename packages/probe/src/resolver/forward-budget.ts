/**
 * The question budget (`P-432` §1.6, D7, D16, D22, D26): the DNS questions this probe's
 * `getaddrinfo` calls in the lookup helper may leave unanswered at the site's servers, counted as
 * tokens. **S3 builds the tokens**: every helper `getaddrinfo` holds one from its start until it
 * settles, so the helper's lanes are the tokens and its bound at the forwarder is a constant. **S6
 * adds the walk's ledger** (`admit`, `open`, `reply`, `joinOpen`): every question the DNS check
 * sends is open from its send until its first reply of any kind, or `FORWARD_HOLD_MS`, in one of
 * three pools (heard 8, discovery 4, urgent 2), so a silent zone's scouts can never starve the
 * walks of zones that answer; and **the per-server rate** (`serverTake`, D19): each server a
 * bucket of `WALK_BURST` refilled at `WALK_RATE` a second, which key walks may empty and per-name
 * walks stop short of by `WALK_KEY_RESERVE`, so the check adds at most 10 questions a second to
 * each server at every instant.
 *
 * **A question held** is one sent and not answered: glibc sends A and AAAA together for family 0,
 * so a lookup holds 2 there and 1 for family 4 or 6 (`questionsOf`).
 *
 * **The tokens:** 2 urgent, for "Check now", and 6 general, 5 shared and 1 kept (D22).
 * - Shared available = max(0, 5 − shared held − shared availability ghosts − U).
 * - Kept available = max(0, 1 − kept held − kept availability ghost): only a helper lookup that is
 *   ungated (D23) may take it, which the admission decides (`admitHelper`); U and ghosts of the
 *   other kinds never touch it.
 * - Urgent available = max(0, 2 − urgent held − urgent ghosts).
 * - Taking a token never waits: it is there or it is not.
 *
 * **U** is the probe-lane DNS lookups past `STUCK_MS`, judged after polls (D25): their questions are
 * held at the forwarder too, so each takes one shared token's room while it runs. `local` lookups,
 * answered without the network, are never in U.
 *
 * **At a loss** (D7, D26):
 * - a lookup stuck at the loss, or treated so (every lookup of a `hung` child, a detached one),
 *   leaves its token as an **availability ghost** of its kind until the loss plus `FORWARD_HOLD_MS`,
 *   since the forwarder holds its questions for as long;
 * - a lookup that had started and was not stuck leaves a **ledger ghost** of its questions for as
 *   long, counted in `questionsOpen` and never in availability (FB9). One lookup is one or the
 *   other, never both, so no question is counted twice;
 * - a lookup asked again in the next child **carries** its token, and releases it if it leaves the
 *   helper (`carry`, `releaseGai`).
 *
 * **`questionsOpen`** = walk questions open + q × (tokens held + availability ghosts) + ledger
 * ghost questions + q × U, and its highest since the last `takePeak` (Probe Health's
 * `nameQuestionsOpen`, since the last acknowledged heartbeat).
 */

/** dnsmasq's forward timeout: how long a question the probe sent is held there unanswered. */
export const FORWARD_HOLD_MS = 10_000;

export type TokenKind = 'shared' | 'kept' | 'urgent';

/** The tokens, by kind (D22). */
export const GAI_TOKENS: Readonly<Record<TokenKind, number>> = { shared: 5, kept: 1, urgent: 2 };

/** The walk's pools (§1.6): its questions open at once, so silent scouts never starve heard walks. */
export type WalkPool = 'heard' | 'discovery' | 'urgent';
export const WALK_QUESTIONS: Readonly<Record<WalkPool, number>> = {
  heard: 8,
  discovery: 4,
  urgent: 2,
};

/** D19: a server's bucket refills at this many questions a second, up to the burst. */
export const WALK_RATE = 10;
export const WALK_BURST = 20;
/** D19: a per-name walk takes from a server's bucket only while more than this many are left. */
export const WALK_KEY_RESERVE = 5;

/** Why a walk did not send a step (`nameWalksDeferred`, §1.4, D31). */
export type DeferReason = 'budget' | 'rate' | 'stall' | 'scoutWait';

/** One question the DNS check sent: open until its first reply, or `FORWARD_HOLD_MS`. */
export interface WalkQuestion {
  readonly pool: WalkPool;
  readonly sentAt: number;
  /** Replied, or past its hold: no longer open. */
  readonly closed: boolean;
}

/** The questions one `getaddrinfo` holds at the forwarder: A and AAAA for family 0. */
export function questionsOf(family: 0 | 4 | 6): number {
  return family === 0 ? 2 : 1;
}

/** A token held by a helper lookup. */
export interface GaiToken {
  readonly kind: TokenKind;
  readonly questions: number;
  /** The lookup that holds it now: another after `carry`. */
  readonly holder: object;
  /** Released: a second release does nothing (L-F5, I9). */
  readonly released: boolean;
}

interface HeldToken {
  readonly kind: TokenKind;
  readonly questions: number;
  holder: object;
  released: boolean;
}

interface Ghost {
  readonly kind: TokenKind;
  readonly questions: number;
  readonly until: number;
}

interface LedgerGhost {
  readonly questions: number;
  readonly until: number;
}

/** One lookup lost with a child, as `lose` reads it. */
export interface LostLookup {
  readonly token: GaiToken;
  /** Stuck at the loss, or treated so (`hung`, detached): its token becomes an availability ghost. */
  readonly stuck: boolean;
  /** It had been sent to the child, so its questions may be open at the forwarder. */
  readonly started: boolean;
}

export interface ForwardBudgetStats {
  readonly held: Readonly<Record<TokenKind, number>>;
  readonly ghosts: Readonly<Record<TokenKind, number>>;
  readonly ledgerGhostQuestions: number;
  readonly untokened: number;
  readonly questionsOpen: number;
  /** The highest `questionsOpen` since the last `takePeak`. */
  readonly peak: number;
  /** Tokens released, over the budget's life: each token once (I9). */
  readonly released: number;
  /** The walk's questions open now, by pool. */
  readonly walk: Readonly<Record<WalkPool, number>>;
  /** The walks deferred, by reason, over the budget's life. */
  readonly deferred: Readonly<Record<DeferReason, number>>;
}

export interface ForwardBudgetOptions {
  readonly now: () => number;
  readonly holdMs?: number;
  readonly tokens?: Readonly<Record<TokenKind, number>>;
  readonly walk?: Readonly<Record<WalkPool, number>>;
  /** D19's bucket: `WALK_RATE`, `WALK_BURST` and `WALK_KEY_RESERVE` unless a test says. */
  readonly rate?: { readonly perSecond: number; readonly burst: number; readonly reserve: number };
}

interface OpenWalkQuestion {
  readonly pool: WalkPool;
  readonly sentAt: number;
  readonly until: number;
  closed: boolean;
}

interface Bucket {
  tokens: number;
  at: number;
}

const KINDS: readonly TokenKind[] = ['shared', 'kept', 'urgent'];

export class ForwardBudget {
  readonly #now: () => number;
  readonly #holdMs: number;
  readonly #tokens: Readonly<Record<TokenKind, number>>;
  readonly #held = new Set<HeldToken>();
  /** The handles given out, so a forged or foreign one is refused. */
  readonly #handles = new WeakMap<GaiToken, HeldToken>();
  #ghosts: Ghost[] = [];
  #ledger: LedgerGhost[] = [];
  /** U: probe-lane lookups past `STUCK_MS`, each with its questions. */
  readonly #untokened = new Map<object, number>();
  #peak = 0;
  #released = 0;
  readonly #walkCaps: Readonly<Record<WalkPool, number>>;
  /** The walk's questions open, oldest first: the head is the next to expire. */
  #walkOpen: OpenWalkQuestion[] = [];
  readonly #walkHandles = new WeakMap<WalkQuestion, OpenWalkQuestion>();
  readonly #rate: { readonly perSecond: number; readonly burst: number; readonly reserve: number };
  readonly #buckets = new Map<string, Bucket>();
  readonly #deferred: Record<DeferReason, number> = {
    budget: 0,
    rate: 0,
    stall: 0,
    scoutWait: 0,
  };

  constructor(options: ForwardBudgetOptions) {
    this.#now = options.now;
    this.#holdMs = options.holdMs ?? FORWARD_HOLD_MS;
    this.#tokens = options.tokens ?? GAI_TOKENS;
    this.#walkCaps = options.walk ?? WALK_QUESTIONS;
    this.#rate = options.rate ?? {
      perSecond: WALK_RATE,
      burst: WALK_BURST,
      reserve: WALK_KEY_RESERVE,
    };
  }

  // --- The walk's ledger (S6) ----------------------------------------------------------------

  /** Whether a pool has room for this many more questions now (§1.6). */
  admit(pool: WalkPool, questions: number): boolean {
    this.#expire();
    return this.#walkOf(pool) + questions <= this.#walkCaps[pool];
  }

  /** A question sent: open in its pool until `reply`, or its hold. */
  open(pool: WalkPool): WalkQuestion {
    const now = this.#now();
    const held: OpenWalkQuestion = { pool, sentAt: now, until: now + this.#holdMs, closed: false };
    this.#walkOpen.push(held);
    const handle: WalkQuestion = {
      pool,
      sentAt: now,
      get closed() {
        return held.closed;
      },
    };
    this.#walkHandles.set(handle, held);
    this.#touch();
    return handle;
  }

  /** Its first reply, of any kind: the forwarder holds it no longer. Idempotent. */
  reply(question: WalkQuestion): void {
    const held = this.#walkHandles.get(question);
    if (held === undefined || held.closed) return;
    held.closed = true;
    this.#walkOpen = this.#walkOpen.filter((open) => open !== held);
  }

  /** The walk's questions open now, in one pool or in all. */
  walkOpen(pool?: WalkPool): number {
    this.#expire();
    return pool === undefined ? this.#walkOpen.length : this.#walkOf(pool);
  }

  /**
   * D19: takes this many questions from a server's bucket, or none and false. A key walk (a scout,
   * a walk again, the canary) may empty it; a per-name walk takes only while more than
   * `WALK_KEY_RESERVE` would be left, so key walks always find some.
   */
  serverTake(server: string, questions: number, kind: 'key' | 'name'): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(server) ?? { tokens: this.#rate.burst, at: now };
    const refilled = Math.min(
      this.#rate.burst,
      bucket.tokens + (Math.max(0, now - bucket.at) / 1_000) * this.#rate.perSecond,
    );
    bucket.tokens = refilled;
    bucket.at = now;
    this.#buckets.set(server, bucket);
    const floor = kind === 'key' ? 0 : this.#rate.reserve;
    if (refilled - questions < floor) return false;
    bucket.tokens = refilled - questions;
    return true;
  }

  /** A walk deferred, for `nameWalksDeferred`. */
  deferred(reason: DeferReason): void {
    this.#deferred[reason] += 1;
  }

  #walkOf(pool: WalkPool): number {
    let count = 0;
    for (const open of this.#walkOpen) if (open.pool === pool) count += 1;
    return count;
  }

  /** The tokens of a kind free now (§1.6). */
  available(kind: TokenKind): number {
    this.#expire();
    const taken = this.#heldOf(kind) + this.#ghostsOf(kind);
    if (kind === 'shared') return Math.max(0, this.#tokens.shared - taken - this.#untokened.size);
    return Math.max(0, this.#tokens[kind] - taken);
  }

  /** A token of a kind for a lookup, or undefined when none is free. Never waits. */
  takeGai(kind: TokenKind, questions: number, holder: object): GaiToken | undefined {
    if (this.available(kind) <= 0) return undefined;
    const held: HeldToken = { kind, questions, holder, released: false };
    this.#held.add(held);
    const handle: GaiToken = {
      kind,
      questions,
      get holder() {
        return held.holder;
      },
      get released() {
        return held.released;
      },
    };
    this.#handles.set(handle, held);
    this.#touch();
    return handle;
  }

  /** The lookup has settled, or left the helper: its token is free. Idempotent per token. */
  releaseGai(token: GaiToken): void {
    const held = this.#handles.get(token);
    if (held === undefined || held.released) return;
    held.released = true;
    this.#held.delete(held);
    this.#released += 1;
  }

  /** A lookup asked again after a loss keeps its token, held now by `holder` (D7). */
  carry(token: GaiToken, holder: object): void {
    const held = this.#handles.get(token);
    if (held === undefined || held.released) return;
    held.holder = holder;
  }

  /**
   * The lookups a lost child held (D26): a stuck one's token becomes an availability ghost of its
   * kind, and is released; one that had started and was not stuck leaves a ledger ghost and keeps
   * its token, which the resolver carries or releases as the lookup goes on.
   */
  lose(lost: readonly LostLookup[]): void {
    const until = this.#now() + this.#holdMs;
    for (const { token, stuck, started } of lost) {
      const held = this.#handles.get(token);
      if (held === undefined || held.released) continue;
      if (stuck) {
        this.#ghosts.push({ kind: held.kind, questions: held.questions, until });
        this.releaseGai(token);
      } else if (started) {
        this.#ledger.push({ questions: held.questions, until });
      }
    }
    this.#touch();
  }

  /** A probe-lane lookup past `STUCK_MS` after polls (D25): one more in U while it runs. */
  untokenedStuck(holder: object, questions: number): void {
    if (this.#untokened.has(holder)) return;
    this.#untokened.set(holder, questions);
    this.#touch();
  }

  /** That lookup has ended. */
  untokenedDone(holder: object): void {
    this.#untokened.delete(holder);
  }

  /** The lookups holding tokens of a kind. */
  holders(kind: TokenKind): readonly object[] {
    return [...this.#held].filter((held) => held.kind === kind).map((held) => held.holder);
  }

  /** The availability ghosts of a kind still within their hold. */
  ghosts(kind: TokenKind): number {
    this.#expire();
    return this.#ghostsOf(kind);
  }

  /** U now. */
  untokened(): number {
    return this.#untokened.size;
  }

  questionsOpen(): number {
    this.#expire();
    let open = this.#walkOpen.length;
    for (const held of this.#held) open += held.questions;
    for (const ghost of this.#ghosts) open += ghost.questions;
    for (const ghost of this.#ledger) open += ghost.questions;
    for (const questions of this.#untokened.values()) open += questions;
    return open;
  }

  /** The highest `questionsOpen` since the last take, and from now the count starts again. */
  takePeak(): number {
    const peak = Math.max(this.#peak, this.questionsOpen());
    this.#peak = this.questionsOpen();
    return peak;
  }

  stats(): ForwardBudgetStats {
    this.#expire();
    const held = { shared: 0, kept: 0, urgent: 0 };
    const ghosts = { shared: 0, kept: 0, urgent: 0 };
    for (const kind of KINDS) {
      held[kind] = this.#heldOf(kind);
      ghosts[kind] = this.#ghostsOf(kind);
    }
    const open = this.questionsOpen();
    return {
      held,
      ghosts,
      ledgerGhostQuestions: this.#ledger.reduce((sum, ghost) => sum + ghost.questions, 0),
      untokened: this.#untokened.size,
      questionsOpen: open,
      peak: Math.max(this.#peak, open),
      released: this.#released,
      walk: {
        heard: this.#walkOf('heard'),
        discovery: this.#walkOf('discovery'),
        urgent: this.#walkOf('urgent'),
      },
      deferred: { ...this.#deferred },
    };
  }

  #heldOf(kind: TokenKind): number {
    let count = 0;
    for (const held of this.#held) if (held.kind === kind) count += 1;
    return count;
  }

  #ghostsOf(kind: TokenKind): number {
    let count = 0;
    for (const ghost of this.#ghosts) if (ghost.kind === kind) count += 1;
    return count;
  }

  /** Ghosts past their hold are let go: the forwarder has dropped those questions. */
  #expire(): void {
    const now = this.#now();
    if (this.#ghosts.some((ghost) => ghost.until <= now)) {
      this.#ghosts = this.#ghosts.filter((ghost) => ghost.until > now);
    }
    if (this.#ledger.some((ghost) => ghost.until <= now)) {
      this.#ledger = this.#ledger.filter((ghost) => ghost.until > now);
    }
    // Oldest first: past its hold, the forwarder has dropped it.
    while (this.#walkOpen[0] !== undefined && this.#walkOpen[0].until <= now) {
      const head = this.#walkOpen.shift();
      if (head !== undefined) head.closed = true;
    }
  }

  /** What is open now may be the highest since the last take. */
  #touch(): void {
    this.#peak = Math.max(this.#peak, this.questionsOpen());
  }
}
