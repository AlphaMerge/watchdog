import { describeError, type CheckFailure, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Visibility } from '../auth/access.js';
import {
  credentialKey,
  type Credential,
  type CredentialCheck,
  type Lapse,
} from '../auth/credentials.js';
import type { ObjectId } from '../objects/types.js';
import { failureOf } from './runtime.js';
import type { SensorState, SensorStateCause } from './tables.js';

/**
 * What `publish` and `publishProbe` read through: the pool, which a transaction's executor is not
 * (it has no `tx`), so the compiler refuses one (`P-253`).
 */
export type StreamPool = Pick<Database, 'query' | 'tx'>;

/**
 * One committed state change, as a subscriber receives it.
 *
 * **Unnumbered, deliberately** (`A-21`). A number given here would be the installation's, one per
 * change, and a subscriber that sees a tenth of the tree would read the other nine tenths in the
 * gaps between its own — how many changes, and when. What a socket was sent is numbered where it
 * is sent, in the stream route, and counts nothing else.
 */
export interface StateEvent {
  readonly sensorId: ObjectId;
  readonly sensorName: string;
  /**
   * Root first, sensor last.
   *
   * Not overhead: it is how a subscription scoped to a subtree is matched without a query per
   * event, and it is also what a tree needs in order to roll a colour up to the ancestor an
   * operator is actually looking at.
   */
  readonly path: readonly ObjectId[];
  readonly state: SensorState;
  readonly previousState: SensorState | null;
  readonly cause: SensorStateCause;
  readonly message: string;
  /** Where the check behind the change failed, beside the message and by its rule (`P-285`). */
  readonly failure: CheckFailure | null;
  readonly at: string;
}

/** One sensor's state as it stands, which is what a subscriber is handed on connect. */
export interface StateSnapshotEntry {
  readonly sensorId: ObjectId;
  readonly sensorName: string;
  readonly path: readonly ObjectId[];
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  /** Where the check the message speaks for failed (`P-285`), or `null`. */
  readonly failure: CheckFailure | null;
  readonly since: string;
}

export interface StateSnapshot {
  readonly objectId: ObjectId | null;
  readonly entries: readonly StateSnapshotEntry[];
  /** True when the subtree has more sensors than one snapshot may carry. */
  readonly truncated: boolean;
}

/**
 * A snapshot, and the access epoch it was read at (`A-30`).
 *
 * **Apart, so the epoch is never sent.** It counts every grant change in the installation, and a
 * subscriber who could watch it move would learn when grants change in branches it cannot see —
 * `A-21`'s lesson about a number that belongs to the installation rather than to the socket.
 */
export interface SnapshotRead {
  readonly snapshot: StateSnapshot;
  readonly epoch: number | null;
}

export interface StreamStats {
  /** Subscribers currently attached. */
  readonly subscribers: number;
  /** Events published since start, counted once however many subscribers saw them. */
  readonly published: number;
  readonly delivered: number;
  /**
   * Subscribers cut off because they could not keep up.
   *
   * Counted, never silent (`CLAUDE.md`). Dropping individual events instead would leave a client
   * quietly showing a state the system has moved on from, which is worse than telling it to
   * start again.
   */
  readonly overflowed: number;
  /** State changes that were published while nobody was listening, and so cost nothing. */
  readonly unwatched: number;
  /**
   * Subscribers told to start again because what their account may see changed underneath them
   * (`A-12`) — a grant revoked, a group left. Counted apart from `overflowed`, which is about a
   * client that cannot keep up; this is about the server knowing better than the client does.
   */
  readonly resynced: number;
  /**
   * Sockets the stream route closed rather than answer again (`A-30`): one that stopped reading
   * what it was sent, one subscribing faster than any client needs to, one that kept sending
   * frames it had been told were wrong. Beside `overflowed` on Core Health, because both are a
   * client the core stopped serving to protect everybody else.
   */
  readonly severed: number;
  /**
   * Sockets found to be open on a credential that no longer authenticates (`A-34`), by why: a
   * session ended or expired, a token revoked, an account disabled. Each is a stream that would
   * otherwise have gone on serving whoever held it. Counted once, when it is found — which is
   * when it stops being sent anything, and may be a sweep interval before it is closed (`U-25`).
   */
  readonly signedOut: Readonly<Record<Lapse, number>>;
  /**
   * Checks of those credentials that could not be made. **A failed check closes nothing** — it
   * is not an answer, and treating it as "signed out" would close every socket in the
   * installation because the database blinked — so this is the number that says the check is not
   * happening.
   */
  readonly credentialCheckFailures: number;
  /**
   * Changes to a probe's link or report that were folded into a frame already on its way to the
   * same watcher, or into a publish already reading that probe's place in the tree (`U-24`).
   *
   * Counted, never silent (`CLAUDE.md`), and nothing is lost by it: the frame says "ask again"
   * and carries no value, so the one that does arrive is answered with whatever is true by then.
   * A number that climbs is a probe whose link is flapping, or a browser that has stopped reading.
   */
  readonly probeCoalesced: number;
  /**
   * Sockets closed with "reconnect" because a check their own frame needed could not be made
   * (`U-26`). Not signed out — nobody could say — and not severed, which is a client
   * misbehaving. A number that climbs is browsers being sent round the reconnect ladder by a
   * database that is refusing queries.
   */
  readonly unsure: number;
  /**
   * The sweep's own queries that were asked and have not answered: a credential check per
   * `CredentialCheck`, and the read of the access epoch (`U-26`). The sweep gives each
   * `credentialWaitMs` and then goes on without it, and **does not ask again while one is still
   * out**: a tick that asked afresh every five seconds of a table that is locked would fill the
   * pool with questions nobody is waiting for. Zero on a healthy core; anything else, held, is
   * a database that has stopped answering the stream.
   *
   * **And an edge's question, once it is past its wait** (`U-27`): one at most per check, since
   * an edge asks nothing new while it is out. Not before — an edge's question is in flight for a
   * millisecond on every published batch, and counted then it would make a healthy core read 1
   * whenever a sample landed in that millisecond.
   */
  readonly checksOutstanding: number;
  /**
   * Edges — a published batch, a probe's change — sent out without an answer about every socket
   * (`U-27`): the check failed, did not answer in `credentialWaitMs`, or was not asked because the
   * one before it is still out. Such an edge goes only to sockets vouched for in the last sweep
   * interval; see `StateBroadcaster.publish`. Zero on a healthy core.
   */
  readonly edgesUnvetted: number;
  /**
   * Sockets an unvetted edge held back (`U-27`): nobody had said within one sweep interval that
   * they were still signed in, so they were sent nothing of it, and nothing after it, until the
   * sweep could say so and sent them back to subscribe again. Counted once each time a socket's
   * subscription is held back; nothing is dropped without the socket being told.
   */
  readonly withheld: number;
  /**
   * Edges that arrived while another edge's question was out, and were answered together by one
   * question asked as soon as it came back (`U-27`). Not lost: each waits for a question asked
   * after it arrived, and is vetted by it. A rate is published batches arriving faster than the
   * database answers about who is signed in.
   *
   * **Unless that question is never asked, or never answers** (`U-28`). When the one out goes
   * past its wait, nothing is asked for the edges waiting on the next, and they are sent at once
   * by the unvetted rule; when the shared question itself goes past its own wait, likewise. Such
   * an edge is counted here and in `edgesUnvetted` both.
   */
  readonly edgesCoalesced: number;
  /**
   * State changes committed and published to nobody, because where their sensors sit in the tree
   * could not be read (`U-28`). Every tree subscription open at that moment has missed them, and
   * is owed an `overflow` — subscribe again — on the sweep's clock: see `publish`. Zero on a
   * healthy core.
   */
  readonly unplaced: number;
  /**
   * Subscriptions owed an `overflow` and not yet sent it (`U-28`): sockets an unvetted edge held
   * back that a sweep has since vouched for, and tree subscriptions that missed a change that could
   * not be placed. Each is a snapshot read once it is sent, so they go out
   * `resumeSpacingMs` apart, and not all on the sweep that ends an outage. Zero once they have.
   */
  readonly resyncsOwed: number;
}

export interface StateBroadcasterOptions {
  logger: Logger;
  /**
   * How many bytes one subscriber may have accepted but not yet put on the wire before it is
   * cut off. Bytes rather than events because that is the quantity the transport can actually
   * measure — see `StateSubscriber.backlog`.
   */
  backlogLimitBytes?: number;
  /** How many sensors a snapshot may carry. */
  snapshotLimit?: number;
  /**
   * How often every admitted socket's credential is checked when nothing is published, and how
   * often a socket already found lapsed is closed (`U-25`): the longest a lapsed socket stays
   * open, saying nothing.
   */
  credentialSweepMs?: number;
  /**
   * How long a sweep waits for each of its queries — the credential check, the access epoch, a
   * watcher's view — before it goes on without the answer (`U-26`): counted, and closing
   * nothing. One that never answers would otherwise hold the sweep, and every one after it, for
   * good. **The sweep's and an edge's** (`U-27`): a client's own frame waits for its answer
   * however long.
   */
  credentialWaitMs?: number;
  /**
   * Milliseconds on a clock that only goes forward: what a socket's last answer is aged by
   * (`U-27`). `performance.now` unless a test moves it.
   */
  clock?: () => number;
  /**
   * How far apart the `overflow`s a sweep owes are sent (`U-28`). Each sends a page back to read
   * a snapshot, and after an outage every open page is owed one. Zero sends them all at once;
   * otherwise a sweep sends at most as many as fit in its interval and leaves the rest to the next.
   */
  resumeSpacingMs?: number;
  /**
   * The access epoch, read now (`U-24`). What the sweep compares every probe watcher's view
   * with, so a watcher whose access moved is told on the sweep's clock and on no other. Absent,
   * a watcher's view is brought up to date only where a frame is about to be sent through it.
   */
  accessEpoch?: () => Promise<number | null>;
}

/**
 * 1 MiB, which is thousands of state frames.
 *
 * Deliberately forgiving. Cutting a subscriber off costs it a fresh snapshot of up to 20,000
 * sensors, so a limit tight enough to fire on an ordinary network stall would be worse than the
 * backlog it prevents. What it has to stop is the unbounded case — a suspended browser tab that
 * never reads again — and any finite number does that.
 */
const DEFAULT_BACKLOG_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SNAPSHOT_LIMIT = 20_000;

/**
 * Five seconds between checks of every open socket's credential (`A-34`).
 *
 * The sweep is for the quiet installation; a busy one checks on every published batch. Its cost is
 * one query per sweep however many sockets are open: at `P-15`'s scale, with a few hundred
 * sockets, that is a few hundred primary-key probes into `user_session` and `user_account` — well
 * under a millisecond of database time every five seconds.
 *
 * **And the only clock a lapsed socket is closed on** (`U-25`). A published batch that finds a
 * socket lapsed stops sending to it and leaves it open; the sweep closes it. So five seconds, and
 * the time one check takes, is the longest a socket stays open after its credential lapsed —
 * busy installation or quiet — and in that time it is sent nothing. **From a check that
 * answers** (`U-26`): one that cannot closes nothing, a silenced socket included, so while the
 * database is away such a socket stays open, and silent, until it is back.
 */
const DEFAULT_CREDENTIAL_SWEEP_MS = 5_000;

/**
 * Two seconds for a sweep's credential check to answer (`U-26`).
 *
 * A few hundred primary-key reads take well under a millisecond, so a check still out after two
 * seconds is a database that is not answering, and is treated as that: counted as a check that
 * could not be made, which closes nothing. Shorter than the sweep's interval, so the tick after
 * a check that hung is not skipped for it.
 *
 * **And for an edge's** (`U-27`): past it, the edge goes only to sockets vouched for within the
 * last sweep interval, and is not held for the answer.
 *
 * **Not the bound on a client's frame.** The pool has no query timeout and this wait includes
 * the time a query spends queued for a connection, so a database answering in three seconds
 * fails every check held to two. On the sweep that costs a tick. On a subscription it closed a
 * signed-in socket whose only fault was a slow database, and the client came straight back to
 * ask the same database again.
 */
const DEFAULT_CREDENTIAL_WAIT_MS = 2_000;

/**
 * A tenth of a second between the `overflow`s a sweep owes (`U-28`): ten pages a second, fifty a
 * five-second sweep.
 *
 * Each sends a page back to read a snapshot, which took 24 to 182 ms at the median and 236 ms at
 * the worst 90th percentile measured (`docs/findings/2026-09-28-object-visibility.md`). So at
 * this spacing one to three are being read at a time, not every open page at once on a database
 * that has only just come back. A few hundred pages are all back inside half a minute.
 */
const DEFAULT_RESUME_SPACING_MS = 100;

/** What a sweep's query that outlived `credentialWaitMs` is failed with. */
class CredentialCheckTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer in ${String(ms)} ms`);
    this.name = 'CredentialCheckTimeout';
  }
}

/** A credential check that was not asked, because the last one is still out. */
class CredentialCheckOutstanding extends Error {
  constructor() {
    super('the credential check before this one has not answered; nothing new was asked');
    this.name = 'CredentialCheckOutstanding';
  }
}

/** What one credential check said, and when it was asked: what it vouches from (`U-27`). */
interface Answered {
  readonly asked: number;
  readonly lapsed: ReadonlyMap<string, Lapse>;
}

/**
 * The one question an edge has out for a check (`U-27`), and the edges waiting for the next.
 *
 * **One out, one waiting, and no more.** A batch must be vetted by a question asked after it was
 * committed (`A-34`), so an edge that arrives while one is out cannot take that one's answer;
 * it waits for the next, which every edge arriving in the meantime shares, and which is asked the
 * moment the one out comes back. Not a queue: however many edges arrive, there is one question
 * in the database and one more to ask.
 */
interface EdgeRound {
  /** Past `credentialWaitMs` and still out: edges ask nothing until it answers. */
  late: boolean;
  /** Edges that arrived while it was out and inside its wait, and the credentials they ask about. */
  next:
    | {
        readonly credentials: Map<string, Credential>;
        readonly answer: Promise<Answered>;
        readonly resolve: (answer: Answered) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
}

/** What a subscriber does with an event, and what it is told when it falls behind. */
export interface StateSubscriber {
  send(event: StateEvent): void;
  /**
   * Everything it holds is suspect and it must resubscribe: its own queue overflowed, or — with
   * a reason — what its account may see has changed (`A-12`).
   */
  overflow(reason?: string): void;
  /**
   * Bytes this subscriber has accepted and not yet delivered, if it can say.
   *
   * The broadcaster cannot work this out for itself, and `P-60` is what happened when it tried:
   * `send` returns `void` and returns *immediately* — a WebSocket's does, because it buffers
   * internally — so a counter the broadcaster raised and lowered around the call was zero every
   * time it was read, and the cut-off below it could never fire. The transport is the only thing
   * that knows, so the transport is asked. A subscriber that consumes synchronously has no
   * backlog and may leave this out.
   */
  backlog?(): number;
}

/**
 * What watches one probe's own link and report, rather than the sensors beneath it (`U-24`).
 *
 * **Told that it changed, and nothing about how.** What a reader may know of a probe's health is
 * decided by `GET /probes/{id}/health` and by nothing else; a frame carrying a value would be a
 * second place deciding it, and the one that is forgotten when the first changes.
 */
export interface ProbeWatcher {
  /** The probe's link came or went, or what its report leaves out changed. */
  changed(): void;
  /** What its account may see has changed, or could not be confirmed (`A-12`): subscribe again. */
  overflow(reason?: string): void;
}

/**
 * What a subscriber may see, and how to ask again (`A-12`).
 *
 * Resolved when it subscribes and held for as long as it stays attached — which can be days, so
 * `resolve` is how the broadcaster finds out that the answer has gone stale. `key` names the
 * principal, so one grant change re-resolves each account once however many tabs it has open.
 */
export interface StreamSight {
  visibility: Visibility;
  readonly key: string;
  readonly resolve: () => Promise<Visibility>;
}

/**
 * An open stream socket, and what authenticated it (`A-34`).
 *
 * The socket rather than the subscription, because a socket with no subscription is still a
 * signed-in connection — one refused a hidden object, or between an overflow and its resubscribe —
 * and "every socket that principal opened" is the promise.
 */
export interface StreamSocket {
  readonly credential: Credential;
  /**
   * Its credential no longer authenticates anything, found where something was about to be sent
   * (`U-25`). **Send it nothing from here on, and do not close it**: detach what it subscribed
   * to, synchronously, and let nothing more out — no frame, no `overflow`, no answer. `signOut`
   * follows, on the sweep's clock or at the socket's own next frame, once a check can answer.
   */
  silence(lapse: Lapse): void;
  /** Its credential no longer authenticates anything. Close it, saying why. */
  signOut(lapse: Lapse): void;
  /**
   * An edge could not find out whether it is still signed in, and nothing has said so within one
   * sweep interval (`U-27`). **Send it nothing of this edge, and nothing after**: detach what it
   * subscribed to, synchronously, as `silence` does, and remember that it has missed something.
   * Close nothing and say nothing — this is the instant of an edge. Returns whether there was a
   * subscription to detach; one with none has missed nothing.
   */
  withhold(): boolean;
  /**
   * A sweep has said it is still signed in since an edge held it back (`U-27`): if what it holds
   * is still the subscription that missed something, tell it to subscribe again (`overflow`).
   * On the sweep's clock, so the frame says nothing about when the edge was.
   */
  resume(): void;
}

/** A socket's place in the credential sweep, handed back by `admit`. */
export interface Admission {
  /**
   * Whether the credential still authenticates, asked now; the socket is signed out if not. For a
   * frame about to be sent that no published batch has vouched for — a snapshot — and for a frame
   * the client has just sent. Rejects when it cannot tell, which closes nothing.
   *
   * **A socket already silenced is asked about too, and then closed whatever the answer**
   * (`U-25`). The question buys nothing — it was decided — except that the close comes as long
   * after the client's frame as it would have had nothing been published in between, so a
   * signed-out client cannot learn from how fast it is closed that something was.
   *
   * **It waits for the answer however long that takes.** A slow database is a late answer, not
   * a refusal: bounded, a check that took three seconds closed every signed-in socket that
   * subscribed.
   *
   * **And when the question cannot be answered, it rejects for a silenced socket as for any
   * other, and closes neither** (`U-26`). A silenced socket closed here while the database was
   * away, where a lapsed one nothing had been published to was not, is the same oracle by another
   * door. What the caller does with "cannot tell" is one thing for every socket.
   */
  confirm(): Promise<boolean>;
  /** The socket has closed. */
  release(): void;
}

interface Attached {
  readonly subscriber: StateSubscriber;
  readonly objectId: ObjectId | null;
  readonly sight: StreamSight;
  /** When it attached, in attachments: what `#catchUp` compares with its horizon (`A-30`). */
  readonly order: number;
}

/** A probe watcher's attachment: `Attached`, for the other kind of subscription (`U-24`). */
interface Watching {
  readonly subscriber: ProbeWatcher;
  readonly probeId: ObjectId;
  readonly sight: StreamSight;
  /**
   * Whether the route has decided this watcher may see the probe (`U-26`). Until it has, the
   * watcher is attached so that a change is not missed, and costs a change nothing: no read of
   * the probe's place is made on its account. See `considerProbe`.
   */
  judged: boolean;
  /** The probe changed while this watcher was not yet judged. Said to it when it stands. */
  heard: boolean;
}

/** A probe watch that is attached and not yet judged (`U-26`). See `considerProbe`. */
export interface ProbeConsideration {
  /**
   * The watch stands: the caller has decided this watcher may see the probe. A change that
   * happened while that was being decided is said now, once.
   */
  readonly stand: () => void;
  /** Detaches it. True when it was still attached. */
  readonly detach: () => boolean;
}

/**
 * Live state changes, pushed rather than polled (`U-02`).
 *
 * **Published after the commit, never inside it.** A frame announcing a state change, sent from
 * inside the transaction that decided it, is an outage on an operator's screen that may never
 * have happened — the transaction can still roll back. `Queryable.afterCommit` is the seam, and
 * `writeStateHistory` is where it is used, because that one function is what every state change
 * in the system goes through: ingestion, a pause, an acknowledgement, a simulated error, a
 * dependency cascade and a schedule window all end up there.
 *
 * **Nobody listening costs one comparison.** The ancestry read that scopes an event to a subtree
 * only happens when there is a subscriber, which is the same guard `M-09` and `N-02` put in
 * front of their sweeps: an installation with no browser open pays nothing for the feature.
 *
 * **A subscriber that cannot keep up is cut off, not quietly trimmed.** Dropping events from the
 * middle of a stream leaves a client showing a state the system has moved on from and no way to
 * know it. Overflow tells it to resubscribe — which takes a fresh snapshot — and is counted.
 */
export class StateBroadcaster {
  readonly #logger: Logger;
  readonly #backlogLimit: number;
  readonly #snapshotLimit: number;
  readonly #attached = new Set<Attached>();
  /**
   * Who watches a probe itself (`U-24`). Apart from `#attached`, so that a state change never
   * walks them and `watching` — the guard in front of every ancestry read — is not held open by
   * a form that asked about one probe.
   */
  readonly #watchers = new Set<Watching>();
  /** Probes whose place in the tree is being read for a frame that has not gone yet (`U-24`). */
  readonly #announcing = new Map<ObjectId, { folded: boolean }>();
  #probeCoalesced = 0;
  #unsure = 0;
  /** The sweep's credential checks that have not answered, by check (`U-26`). */
  readonly #pending = new Map<CredentialCheck, Promise<unknown>>();
  /** The sweep's read of the access epoch, while it has not answered (`U-26`). */
  #epochRead: Promise<number | null> | undefined;
  /**
   * Resolutions in flight, by principal and the epoch that sent for them (`A-30`). Publishes run
   * concurrently — every committed batch is one — and each noticed the same grant change and asked
   * again for every account on its own, so one change under ingestion load cost an account one
   * resolution per batch in flight rather than one.
   */
  readonly #resolving = new Map<string, Promise<Visibility>>();
  #attachments = 0;
  #published = 0;
  #delivered = 0;
  #overflowed = 0;
  #unwatched = 0;
  #resynced = 0;
  #severed = 0;

  readonly #sweepMs: number;
  readonly #waitMs: number;
  readonly #accessEpoch: (() => Promise<number | null>) | undefined;
  /**
   * Every open socket something authenticated (`A-34`), subscribed or not, and what to ask about
   * it. One check in a running core — the API server's — so one query however many sockets.
   */
  readonly #admitted = new Map<StreamSocket, CredentialCheck>();
  /**
   * Sockets found lapsed where something was about to be sent, and why (`U-25`): silenced there,
   * still open, still admitted — so the sweep's timer stays armed for them — and closed by the
   * next sweep whose check answers. Never asked about again by a batch; asked about by the sweep
   * and by the socket's own frame, for the timing and the reason and not for the decision
   * (`U-26`): a credential that lapsed and came back has still missed what was not sent to it,
   * and the close is how the client finds out.
   */
  readonly #silenced = new Map<StreamSocket, Lapse>();
  /**
   * When a check last said each admitted socket was still signed in, on `#clock`: the instant it
   * was asked (`U-27`). Admission is the first such answer — the upgrade was authenticated by the
   * credential a moment before. What an edge whose check failed goes by: see `#atEdge`.
   */
  readonly #vouched = new Map<StreamSocket, number>();
  /** Sockets an unvetted edge held back, until a sweep can say they are signed in (`U-27`). */
  readonly #withheld = new Set<StreamSocket>();
  /** The question each check has out for an edge, and the edges waiting on the next (`U-27`). */
  readonly #edgeRounds = new Map<CredentialCheck, EdgeRound>();
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #sweeping = false;
  readonly #signedOut: Record<Lapse, number> = { ended: 0, expired: 0, revoked: 0, disabled: 0 };
  #credentialCheckFailures = 0;
  #edgesUnvetted = 0;
  #withheldCount = 0;
  #edgesCoalesced = 0;
  #unplaced = 0;
  /**
   * Who is owed an `overflow` the sweep sends (`U-28`), oldest first: a socket an edge held back,
   * once a sweep has vouched for it, or a tree subscription that missed a change that could not
   * be placed. Keyed by what is owed, so owing twice is owing once.
   */
  readonly #owed = new Map<StreamSocket | Attached, () => void>();
  /** Taken from `#owed` by a sweep, and waiting for its turn to be sent (`U-28`). */
  #releasing = 0;
  readonly #resumeSpacingMs: number;
  readonly #clock: () => number;

  constructor(options: StateBroadcasterOptions) {
    this.#logger = options.logger.child({ component: 'stream' });
    this.#backlogLimit = options.backlogLimitBytes ?? DEFAULT_BACKLOG_LIMIT_BYTES;
    this.#snapshotLimit = options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
    this.#sweepMs = options.credentialSweepMs ?? DEFAULT_CREDENTIAL_SWEEP_MS;
    this.#waitMs = options.credentialWaitMs ?? DEFAULT_CREDENTIAL_WAIT_MS;
    this.#accessEpoch = options.accessEpoch;
    this.#clock = options.clock ?? (() => performance.now());
    this.#resumeSpacingMs = options.resumeSpacingMs ?? DEFAULT_RESUME_SPACING_MS;
  }

  /**
   * Runs the sweep while there is something for it to look at, and not otherwise: a socket to
   * ask about (`A-34`), or a probe watcher whose view can go stale (`U-24`). Unreferenced, so an
   * open browser tab never holds the process up.
   *
   * **Its ticks are its own.** The interval starts when the first socket or watcher arrives and
   * runs on the wall clock from there, so what it tells a watcher is timed by nothing a probe
   * does. And while anybody is owed an `overflow` (`U-28`), since the sweep is what sends it.
   */
  #arm(): void {
    const wanted =
      this.#admitted.size > 0 ||
      (this.#accessEpoch !== undefined && this.#watchers.size > 0) ||
      this.#owed.size > 0;
    if (wanted) {
      this.#sweeper ??= setInterval(() => {
        void this.sweep();
      }, this.#sweepMs).unref();
    } else if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper);
      this.#sweeper = undefined;
    }
  }

  get stats(): StreamStats {
    return {
      subscribers: this.#attached.size + this.#watchers.size,
      published: this.#published,
      delivered: this.#delivered,
      overflowed: this.#overflowed,
      unwatched: this.#unwatched,
      resynced: this.#resynced,
      severed: this.#severed,
      signedOut: { ...this.#signedOut },
      credentialCheckFailures: this.#credentialCheckFailures,
      probeCoalesced: this.#probeCoalesced,
      unsure: this.#unsure,
      checksOutstanding:
        this.#pending.size +
        (this.#epochRead === undefined ? 0 : 1) +
        [...this.#edgeRounds.values()].filter((round) => round.late).length,
      edgesUnvetted: this.#edgesUnvetted,
      withheld: this.#withheldCount,
      edgesCoalesced: this.#edgesCoalesced,
      unplaced: this.#unplaced,
      resyncsOwed: this.#owed.size + this.#releasing,
    };
  }

  /**
   * Counts a probe change the stream route folded into a frame the socket had not yet taken
   * (`U-24`). See `StreamStats.probeCoalesced`.
   */
  coalesced(): void {
    this.#probeCoalesced += 1;
  }

  /**
   * Counts a socket the stream route closed to reconnect, because a check its own frame needed
   * could not be made (`U-26`). See `StreamStats.unsure`.
   */
  unsure(): void {
    this.#unsure += 1;
  }

  /** Counts a socket the stream route closed to protect the core (`A-30`). See `StreamStats`. */
  severed(): void {
    this.#severed += 1;
  }

  /**
   * Puts an open socket under `check` (`A-34`): asked on every published batch before anything is
   * delivered, and on a sweep when nothing is published, so a quiet installation still closes it.
   *
   * **Found lapsed by a batch, it is silenced; closing it is the sweep's** (`U-25`). `silence` is
   * called once, where the batch found it, and `signOut` once, on the sweep's next tick — or
   * `signOut` alone when it is the sweep, or `confirm`, that finds it.
   */
  admit(socket: StreamSocket, check: CredentialCheck): Admission {
    this.#admitted.set(socket, check);
    // The upgrade that opened it was authenticated by this credential just now (`U-27`).
    this.#vouched.set(socket, this.#clock());
    // Only while there is a socket to sweep, so an installation nobody is watching pays nothing.
    this.#arm();
    return {
      confirm: async () => {
        if (!this.#admitted.has(socket)) return false;
        // Rejects when it could not be asked about, decided already or not (`U-26`): "cannot
        // tell" is the caller's, and is the same for every socket. Unbounded: see `confirm`.
        await this.#examine([socket], 'frame');
        return this.#admitted.has(socket);
      },
      release: () => {
        this.#forget(socket);
        this.#arm();
      },
    };
  }

  /** Everything held about a socket that is closed, or being closed. */
  #forget(socket: StreamSocket): void {
    this.#admitted.delete(socket);
    this.#silenced.delete(socket);
    this.#vouched.delete(socket);
    this.#withheld.delete(socket);
    this.#owed.delete(socket);
  }

  /**
   * Checks every admitted socket's credential, and signs out those that lapsed (`A-34`). What the
   * timer runs; public so a test can run one without waiting for it.
   *
   * **The only place a socket is closed for a lapse that a published batch found** (`U-25`).
   * `publish` and `publishProbe` ask the same question so that nothing committed after a sign-out
   * is delivered, and what they find they silence. Closing it there would tell an account that
   * was signed out or disabled the instant some sensor changed state or some probe's link moved —
   * including ones it could never see — as the timing of its own close frame. Here the instant
   * is this timer's, armed when the first socket or watcher arrived and moved by nothing since.
   *
   * **A silenced socket and one this sweep finds are closed together, after the one question**:
   * were the silenced closed first, which of the two a socket was would be in the gap. The
   * question is asked about the silenced ones too (`U-26`), in the same query, so that a sweep
   * with nobody else to ask about waits as long as one that has — and so that the close says why
   * the credential fails now, by the rule an unsilenced socket's close goes by.
   *
   * **Never rejects, and a failure closes nothing, decided or not** (`U-26`). It is counted and
   * logged, and the sockets stay open until a check can answer — a database that blinked is not a
   * reason to sign everybody out. A silenced socket stays open with them, and is still sent
   * nothing: closing it here while a lapsed socket that no edge had found stayed open would say
   * which of the two it was. So the five seconds are five seconds from a database that answers.
   *
   * **A check that does not answer is one that failed, after `credentialWaitMs`.** The sweep ends
   * there, and an answer that arrives later is not acted on. **The next tick asks again only once
   * that answer has come**: while it is still out, a tick asks nothing new and counts itself as
   * a check that could not be made, so a database that has stopped answering holds one question
   * of the sweep's and not one per tick. `StreamStats.checksOutstanding` says how many.
   *
   * **And the only place a socket an edge held back is told to subscribe again** (`U-27`): once
   * this sweep's check says it is still signed in, `resume` sends it `overflow`. At the edge it
   * was sent nothing, so a signed-out socket and a signed-in one were alike there; here the
   * instant is this timer's, as a close is.
   *
   * **The review of probe watchers is bounded the same way** — the read of the access epoch, and
   * each view asked for again — so a watcher attached does not put the sweep back at the mercy
   * of one query.
   *
   * **And what is owed goes out paced** (`U-28`): see `#release`.
   */
  async sweep(): Promise<void> {
    // One at a time: a sweep still waiting on a slow database is not joined by another.
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      await this.#vet('sweep');
      // Before the review, so when the first goes is timed by the credential check and nothing
      // else, as it was when the check sent it.
      this.#release();
      await this.#review();
      this.#arm();
    } finally {
      this.#sweeping = false;
    }
  }

  /**
   * Owes `whom` an `overflow`, sent by a sweep (`U-28`). Owing it again changes nothing, its place
   * in the line included.
   */
  #owe(whom: StreamSocket | Attached, send: () => void): void {
    if (!this.#owed.has(whom)) this.#owed.set(whom, send);
    this.#arm();
  }

  /**
   * Sends what is owed, oldest first, `resumeSpacingMs` apart: the first now, on the sweep's clock,
   * and no more than fit in one sweep interval, so that the next sweep picks up about where these
   * end (`U-28`).
   *
   * **Why apart.** Each `overflow` is a page that reads a snapshot straight back. A long outage
   * ends with every open page owed one — held back by edges nobody could vet, or missing a change
   * that could not be placed — and sent on one sweep they were that many snapshot reads at once,
   * on a database that had only just come back. Spaced, the same pages are back within seconds of
   * one another, one or two reads at a time.
   *
   * **What it says.** Only that grants, a sign-in or a placement were in doubt within the last
   * intervals, which the account learns from the `overflow` anyway. Its place in the line is how
   * many were owed before it, so a page sent back late after an outage can tell that other pages
   * were — not whose, nor what they were sent.
   */
  #release(): void {
    const spacing = this.#resumeSpacingMs;
    const room = spacing <= 0 ? Infinity : Math.max(1, Math.floor(this.#sweepMs / spacing));
    let turn = 0;
    for (const [whom, send] of this.#owed) {
      if (turn >= room) break;
      this.#owed.delete(whom);
      if (turn === 0 || spacing <= 0) {
        send();
      } else {
        this.#releasing += 1;
        setTimeout(() => {
          this.#releasing -= 1;
          send();
        }, turn * spacing).unref();
      }
      turn += 1;
    }
  }

  /**
   * Brings every probe watcher's view up to date, and sends back to the start those whose view
   * changed (`U-24`). The sweep's second job, and the **only** place a watcher is told that what
   * its account may see has moved.
   *
   * **Here, and not where a probe's change is published.** A tree subscriber is examined when a
   * batch is published, because it is about to be sent that batch. A watcher examined when its
   * probe changes would be sent `overflow` at the instant a probe it may no longer see connected
   * or dropped — the one fact the revocation was meant to keep from it, delivered as the timing
   * of a frame that carries nothing. On the sweep's clock the instant says only that grants
   * moved, within the sweep's interval, which the account learns from its next request anyway.
   *
   * One read of the epoch per sweep while anybody watches, and no resolution unless it moved.
   * Never rejects: what could not be asked this time is asked on the next tick.
   *
   * **Each wait is `credentialWaitMs` at most** (`U-26`). A read of the epoch that is still out
   * is waited on again by the next tick and not asked a second time; a view still being asked
   * for is the same one `#resolve` already holds. A watcher whose view did not come back in time
   * is left exactly as it was — told nothing, and reviewed on the next tick — where one whose
   * view could not be asked for at all is sent back, as before.
   */
  async #review(): Promise<void> {
    const read = this.#accessEpoch;
    if (read === undefined || this.#watchers.size === 0) return;
    let epoch: number | null;
    try {
      epoch = await this.#within(this.#readEpoch(read), 'the access epoch');
    } catch (error: unknown) {
      this.#logger.warn(
        { err: describeError(error), watchers: this.#watchers.size },
        'could not read the access epoch; probe watchers are reviewed on the next sweep',
      );
      return;
    }
    if (epoch === null) return;
    const at = epoch;
    const stale = [...this.#watchers].filter((watching) => {
      const seen = watching.sight.visibility.epoch;
      // Different, not older (`A-25`), as `#catchUp` has it.
      return seen !== null && seen !== at;
    });
    await Promise.all(
      stale.map(async (watching) => {
        let next: Visibility | null;
        try {
          next = await this.#within(
            this.#resolve(watching.sight, at),
            'what a probe watcher may see',
          );
        } catch (error) {
          // Slow is not wrong: its view is asked for again on the next tick, or is still being.
          if (error instanceof CredentialCheckTimeout) {
            this.#logger.warn(
              { err: describeError(error) },
              'a probe watcher’s view was not answered in time; it is reviewed on the next sweep',
            );
            return;
          }
          this.#logger.warn(
            { err: describeError(error) },
            'could not re-resolve what a probe watcher may see; it must subscribe again',
          );
          next = null;
        }
        if (!this.#watchers.has(watching)) return;
        if (next?.sameAs(watching.sight.visibility) === true) {
          watching.sight.visibility = next;
          return;
        }
        this.#watchers.delete(watching);
        this.#resynced += 1;
        watching.subscriber.overflow(
          next === null
            ? 'could not confirm what this account may see; subscribe again'
            : 'what this account may see has changed; subscribe again',
        );
      }),
    );
    this.#arm();
  }

  /**
   * The access epoch, asked once however many ticks wait for it (`U-26`): a read that has not
   * answered is the one the next tick waits on.
   */
  #readEpoch(read: () => Promise<number | null>): Promise<number | null> {
    if (this.#epochRead !== undefined) return this.#epochRead;
    const reading = read();
    this.#epochRead = reading;
    const settle = (): void => {
      if (this.#epochRead === reading) this.#epochRead = undefined;
    };
    reading.then(settle, settle);
    return reading;
  }

  /**
   * `#examine` for every admitted socket, never rejecting. See `sweep`, and `publish` for an edge.
   *
   * An edge does not ask again about a socket already silenced, so it costs the one question it
   * cost before `U-25`, less the sockets already decided; the sweep asks about every socket, in
   * the one query it always made (`U-26`).
   */
  async #vet(by: 'edge' | 'sweep'): Promise<void> {
    if (this.#admitted.size === 0) return;
    try {
      await this.#examine([...this.#admitted.keys()], by);
    } catch (error: unknown) {
      this.#logger.warn(
        { err: describeError(error), sockets: this.#admitted.size },
        by === 'edge'
          ? 'could not check whether open stream sockets are still signed in; a change went only ' +
              'to those vouched for in the last sweep interval'
          : 'could not check whether open stream sockets are still signed in; they stay open ' +
              'until a check can say',
      );
    }
  }

  /**
   * Asks each check once about these sockets' credentials, however many sockets share one, and
   * acts on what it says. Rejects, each failure counted, when a check cannot answer — after
   * acting on what the others said.
   *
   * - **An edge** (`by === 'edge'`) silences a lapsed socket: stops sending to it and leaves it
   *   open for the sweep. It does not ask about a socket already silenced. Where its check could
   *   not answer it goes by `#atEdge`'s rule (`U-27`).
   * - **The sweep and a client's frame** sign a lapsed socket out — and those silenced before. One
   *   whose check could not answer, silenced or not, is left exactly as it was (`U-26`).
   *
   * Every answer that says a socket is signed in is remembered, with when it was asked (`U-27`).
   *
   * **How long each waits.** A client's frame waits for its answer however long. The sweep waits
   * `credentialWaitMs`, and asks a check nothing while that check's last question from a sweep is
   * still out. An edge waits `credentialWaitMs` from when its own question is asked, and shares
   * that question as `#askAtEdge` says (`U-28`).
   */
  async #examine(sockets: readonly StreamSocket[], by: 'edge' | 'sweep' | 'frame'): Promise<void> {
    const asking = new Map<CredentialCheck, Map<string, Credential>>();
    for (const socket of sockets) {
      const check = this.#admitted.get(socket);
      if (check === undefined) continue;
      if (by === 'edge' && this.#silenced.has(socket)) continue;
      const asked = asking.get(check) ?? new Map<string, Credential>();
      asked.set(credentialKey(socket.credential), socket.credential);
      asking.set(check, asked);
    }
    const answers = new Map<CredentialCheck, Answered>();
    const failures: unknown[] = [];
    await Promise.all(
      [...asking].map(async ([check, asked]) => {
        try {
          answers.set(check, await this.#ask(check, asked, by));
        } catch (error: unknown) {
          this.#credentialCheckFailures += 1;
          failures.push(error);
        }
      }),
    );
    // Remembered before anything is acted on, by every kind of question.
    for (const socket of sockets) {
      const check = this.#admitted.get(socket);
      if (check === undefined || this.#silenced.has(socket)) continue;
      const answered = answers.get(check);
      if (answered === undefined || answered.lapsed.has(credentialKey(socket.credential))) {
        continue;
      }
      // The later of two: an answer asked before another that has already come back is older.
      const before = this.#vouched.get(socket);
      if (before === undefined || before < answered.asked) {
        this.#vouched.set(socket, answered.asked);
      }
    }
    if (by === 'edge') this.#atEdge(sockets, answers);
    else this.#settle(sockets, answers, by);
    this.#arm();
    if (failures.length > 0) throw failures[0];
  }

  /** One check's answer about these credentials, waited for as `by` waits. See `#examine`. */
  async #ask(
    check: CredentialCheck,
    credentials: ReadonlyMap<string, Credential>,
    by: 'edge' | 'sweep' | 'frame',
  ): Promise<Answered> {
    // Bounded inside, from when its own question is asked (`U-28`): see `#askAtEdge`.
    if (by === 'edge') return this.#askAtEdge(check, credentials);
    const asked = this.#clock();
    if (by === 'frame') return { asked, lapsed: await check.lapsed([...credentials.values()]) };
    if (this.#pending.has(check)) throw new CredentialCheckOutstanding();
    const answer = check.lapsed([...credentials.values()]);
    this.#pending.set(check, answer);
    const settle = (): void => {
      if (this.#pending.get(check) === answer) this.#pending.delete(check);
    };
    answer.then(settle, settle);
    return { asked, lapsed: await this.#within(answer, 'the credential check') };
  }

  /**
   * The answer an edge waits for (`U-27`): to a question asked now, if this check has none out;
   * to the next one, if it has one out inside its wait; and to nothing — rejected at once — if the
   * one out is past its wait.
   *
   * **Why not the answer already on its way.** That question was asked before this edge's batch
   * committed, and could say "signed in" about a session whose logout committed in between —
   * which `A-34` exists to stop. So an edge that arrives while a question is out waits for the
   * next, asked the moment the one out comes back, and **every edge arriving meanwhile shares
   * it**: counted in `edgesCoalesced`, and one query however many there were.
   *
   * **And why nothing, past the wait.** A question that has not answered in `credentialWaitMs` is
   * a database that is not answering; asking it again for every edge is a pool full of questions
   * nobody waits for, which is the sweep's rule too (`U-26`). Edges arriving then are decided by
   * `#atEdge` straight away, and the edges that were waiting for the next question are decided
   * with them. When the late one does answer, the next edge asks afresh.
   *
   * **How long each waits** (`U-28`). The edge that asks waits `credentialWaitMs` from asking. One
   * that joins waits what is left of the one out, and then `credentialWaitMs` from when its own
   * question is asked — so at most twice the wait, and never less than its own question was
   * given. Bounded from its arrival, as it was, an edge that joined at a database answering in
   * 1.2 s was failed at 2 s, while the question it waited for still had 0.4 s to go: a third of
   * edges counted as failed checks, though every query answered inside its own wait.
   */
  #askAtEdge(
    check: CredentialCheck,
    credentials: ReadonlyMap<string, Credential>,
  ): Promise<Answered> {
    const out = this.#edgeRounds.get(check);
    if (out === undefined) return this.#startEdgeRound(check, credentials);
    if (out.late) return Promise.reject(new CredentialCheckOutstanding());
    this.#edgesCoalesced += 1;
    if (out.next === undefined) {
      let resolve: (answer: Answered) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const answer = new Promise<Answered>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      out.next = { credentials: new Map(), answer, resolve, reject };
    }
    for (const [key, credential] of credentials) out.next.credentials.set(key, credential);
    return out.next.answer;
  }

  /** Asks `check` for an edge now, as the one question this check has out for edges (`U-27`). */
  #startEdgeRound(
    check: CredentialCheck,
    credentials: ReadonlyMap<string, Credential>,
  ): Promise<Answered> {
    const asked = this.#clock();
    const lapsed = check.lapsed([...credentials.values()]);
    const round: EdgeRound = { late: false, next: undefined };
    this.#edgeRounds.set(check, round);
    /** Hands whoever waits for the next question to `then`, and leaves the round without one. */
    const handOn = (then: (next: NonNullable<EdgeRound['next']>) => void): void => {
      const next = round.next;
      round.next = undefined;
      if (next !== undefined) then(next);
    };
    let giveUp: (error: unknown) => void = () => undefined;
    const late = new Promise<never>((_, reject) => {
      giveUp = reject;
    });
    // One timer for the round: this question's bound, from when it was asked (`U-28`).
    const timer = setTimeout(() => {
      round.late = true;
      giveUp(new CredentialCheckTimeout('the credential check', this.#waitMs));
      // Nothing will be asked for them while this is out: decided now, by what was said before.
      handOn((next) => {
        next.reject(new CredentialCheckOutstanding());
      });
    }, this.#waitMs).unref();
    const settle = (): void => {
      clearTimeout(timer);
      if (this.#edgeRounds.get(check) === round) this.#edgeRounds.delete(check);
      // Back inside its wait: the edges that waited on it get a question of their own, now.
      handOn((next) => {
        this.#startEdgeRound(check, next.credentials).then(next.resolve, next.reject);
      });
    };
    lapsed.then(settle, settle);
    // What it says after its wait is dropped, as `#within` drops it.
    return Promise.race([lapsed.then((answer) => ({ asked, lapsed: answer })), late]);
  }

  /**
   * What an edge does with what its check said (`U-27` for the rule, `U-25` for the rest).
   *
   * A socket the check found lapsed is **silenced**: sent nothing of this edge or any after it,
   * and left open for the sweep to close. Synchronous, and it detaches the socket's subscription,
   * so a batch waiting on this check delivers to nobody it silenced; still admitted, so the timer
   * that closes it stays armed.
   *
   * **Where the check could not answer** — it failed, it did not answer in `credentialWaitMs`, or
   * it was not asked because the one before it is still out — **the edge goes to a socket whose
   * last answer said signed in and is younger than one sweep interval, and to no other.** A
   * database that blinks costs nobody their tree, since a socket in use is vouched for at every
   * edge and every sweep; and a socket whose credential lapsed since its last answer is exposed
   * for one interval at most, which a credential that lapses and comes back inside one interval
   * already is. Every other socket is **held back**: `withhold` detaches its subscription, says
   * nothing, and the sweep that next vouches for it sends it back to subscribe again. Nothing is
   * dropped without the socket being told, and a socket held back is sent nothing at the edge,
   * exactly as a signed-out one is — the two cannot be told apart there. Counted: the edge in
   * `edgesUnvetted`, each socket held back in `withheld`.
   *
   * Before `U-27` a failed check delivered to every socket not silenced, a signed-out one
   * included, and a check that hung held the batch and every later one for as long as it hung.
   */
  #atEdge(sockets: readonly StreamSocket[], answers: ReadonlyMap<CredentialCheck, Answered>): void {
    const now = this.#clock();
    let unvetted = false;
    for (const socket of sockets) {
      const check = this.#admitted.get(socket);
      // Released while the check was out — closed by its client, or signed out by another check.
      if (check === undefined) continue;
      // Found by an earlier edge, and counted there.
      if (this.#silenced.has(socket)) continue;
      const answered = answers.get(check);
      if (answered === undefined) {
        unvetted = true;
        const vouched = this.#vouched.get(socket);
        if (vouched !== undefined && now - vouched < this.#sweepMs) continue;
        if (socket.withhold()) {
          this.#withheldCount += 1;
          this.#withheld.add(socket);
        }
        continue;
      }
      const lapse = answered.lapsed.get(credentialKey(socket.credential));
      if (lapse === undefined) continue;
      this.#signedOut[lapse] += 1;
      this.#silenced.set(socket, lapse);
      socket.silence(lapse);
    }
    if (unvetted) this.#edgesUnvetted += 1;
  }

  /**
   * What the sweep and a client's frame do with what their check said: sign out every socket
   * whose credential lapsed, and every socket an edge silenced (`U-25`, `U-26`); and, on the
   * sweep, send a socket an edge held back that is still signed in back to subscribe (`U-27`).
   */
  #settle(
    sockets: readonly StreamSocket[],
    answers: ReadonlyMap<CredentialCheck, Answered>,
    by: 'sweep' | 'frame',
  ): void {
    for (const socket of sockets) {
      const check = this.#admitted.get(socket);
      // Released while the check was out — closed by its client, or signed out by another check.
      if (check === undefined) continue;
      const decided = this.#silenced.get(socket);
      const answered = answers.get(check);
      // **Cannot tell, so nothing is closed — a silenced socket no more than any other**
      // (`U-26`). It stays silent and admitted, and the next check that answers closes it. One
      // held back stays held back.
      if (answered === undefined) continue;
      const now = answered.lapsed.get(credentialKey(socket.credential));
      // Found here, so counted here; one an edge found was counted there.
      if (decided === undefined && now !== undefined) this.#signedOut[now] += 1;
      // **Why it fails now, for both kinds** (`U-26`): a session that ended and whose account
      // was then disabled is closed as disabled whether or not an edge found it in between.
      // What the edge recorded is the reason only for a credential that has come back since —
      // which has still missed frames, and is closed for that.
      const lapse = now ?? decided;
      if (lapse === undefined) {
        // Signed in, and held back by an edge that could not say so: told on this clock, in its
        // turn (`U-28`). Signed out before its turn comes, it is forgotten and told nothing.
        if (by === 'sweep' && this.#withheld.delete(socket)) {
          this.#owe(socket, () => {
            if (this.#admitted.has(socket)) socket.resume();
          });
        }
        continue;
      }
      this.#forget(socket);
      socket.signOut(lapse);
    }
  }

  /**
   * The answer to one of the sweep's queries, or a rejection once `credentialWaitMs` has passed
   * (`U-26`). An edge's question carries its own bound, from when it is asked (`U-28`).
   *
   * The query itself is not stopped — there is nothing to stop it with — and what a credential
   * check says after the wait is dropped: acting on it would close a socket at an instant that
   * is neither the sweep's tick nor the client's frame, or silence one at no edge's. Its caller
   * keeps hold of it, so that it is not asked again while it is out.
   */
  async #within<T>(answer: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CredentialCheckTimeout(what, this.#waitMs));
      }, this.#waitMs).unref();
    });
    // The loser of the race has nobody else to catch it.
    answer.catch(() => undefined);
    try {
      return await Promise.race([answer, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether anything is listening. The guard every publish path checks first. */
  get watching(): boolean {
    return this.#attached.size > 0;
  }

  /**
   * Attaches a subscriber, scoped to a subtree or to everything, seeing what `sight` allows.
   * Returns how to detach it.
   *
   * **The sight is not optional** (`A-12`). A broadcaster that fanned every event out to every
   * socket is how `{"subscribe":{}}` streamed the whole installation to an account granted one
   * branch; a subscriber that genuinely sees everything says so with `Visibility.EVERYTHING`.
   */
  subscribe(
    subscriber: StateSubscriber,
    objectId: ObjectId | null,
    sight: StreamSight,
  ): () => void {
    this.#attachments += 1;
    const attached: Attached = { subscriber, objectId, sight, order: this.#attachments };
    this.#attached.add(attached);
    return () => {
      // Nothing is owed to a subscription that has gone (`U-28`).
      this.#owed.delete(attached);
      return this.#attached.delete(attached);
    };
  }

  /**
   * Whether this visibility can read the object a subscription would be scoped to.
   *
   * The same question `GET /objects/:id` asks, and refused the same way when the answer is no: a
   * subscription to a hidden object that streamed the visible sensors beneath it would say where
   * they sit in a branch the subscriber was never shown.
   */
  async canSee(q: Queryable, objectId: ObjectId, visibility: Visibility): Promise<boolean> {
    if (visibility.everything) return true;
    const values: unknown[] = [objectId];
    const visible = visibility.where('o.id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ visible: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM object o WHERE o.id = $1 AND ${visible}) AS visible`,
      values,
    );
    return rows[0]?.visible === true;
  }

  /**
   * Attaches a watcher to one probe's own link and report (`U-24`). Returns how to detach it.
   *
   * Seen through `sight` exactly as a sensor's state is: the frame goes to a watcher whose
   * visibility sees the probe **at the moment it is sent**, so attaching one is not a grant.
   */
  watchProbe(subscriber: ProbeWatcher, probeId: ObjectId, sight: StreamSight): () => boolean {
    const considered = this.considerProbe(subscriber, probeId, sight);
    considered.stand();
    return considered.detach;
  }

  /**
   * `watchProbe`, for a caller that has not yet decided whether this watcher may see the probe
   * (`U-26`): attached now, so no change is missed while that is decided, and **not yet a reason
   * to read anything**.
   *
   * The stream route attaches before it judges, so that a change landing while `canWatchProbe`
   * is out is not lost. Attached as an ordinary watcher, that made a subscription to a probe the
   * account may not see a reason for `publishProbe` to read the probe's place at every edge in
   * the judging window — a query a refused client could buy by subscribing again. An unjudged
   * watcher is only marked: `publishProbe` notes that the probe changed and reads nothing for
   * it. `stand` is the caller saying the watcher may see the probe; a noted change is said then,
   * once, and the order the route was keeping — attach, judge, answer, then the frame — holds.
   * A watcher never judged is detached having cost one flag.
   */
  considerProbe(
    subscriber: ProbeWatcher,
    probeId: ObjectId,
    sight: StreamSight,
  ): ProbeConsideration {
    const watching: Watching = { subscriber, probeId, sight, judged: false, heard: false };
    this.#watchers.add(watching);
    this.#arm();
    return {
      stand: () => {
        if (watching.judged || !this.#watchers.has(watching)) return;
        watching.judged = true;
        if (!watching.heard) return;
        watching.heard = false;
        watching.subscriber.changed();
        this.#delivered += 1;
      },
      detach: () => {
        const held = this.#watchers.delete(watching);
        this.#arm();
        return held;
      },
    };
  }

  /**
   * Whether this visibility can read a probe with this id, and the access epoch that was true at
   * (`U-24`).
   *
   * `canSee`, and that the object is a probe: a watch on a device would be a subscription nothing
   * is ever published to, which looks exactly like a probe where nothing changes. One answer for
   * a probe that is hidden, an id that names nothing and an object that is not a probe, so the
   * refusal says nothing about which.
   *
   * **The epoch is read in the same statement**, for the reason `snapshot`'s is: `visibility` was
   * resolved in an earlier one, and `confirm` is how the caller learns it has moved since.
   */
  async canWatchProbe(
    q: Queryable,
    probeId: ObjectId,
    visibility: Visibility,
  ): Promise<{ visible: boolean; epoch: number | null }> {
    const values: unknown[] = [probeId];
    const visible = visibility.where('o.id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ visible: boolean; epoch: string | null }>(
      `SELECT EXISTS (
                SELECT 1 FROM object o WHERE o.id = $1 AND o.kind = 'probe' AND ${visible}
              ) AS visible,
              (SELECT value::text FROM access_epoch) AS epoch`,
      values,
    );
    const row = rows[0];
    return {
      visible: row?.visible === true,
      epoch: row === undefined || row.epoch === null ? null : Number(row.epoch),
    };
  }

  /**
   * Says that a probe's link or report changed, to whoever watches that probe and may see it
   * (`U-24`).
   *
   * **No transaction and no state**: a probe connecting is a fact about a socket, held in memory
   * beside the link, and this is called when it changes. It writes nothing, so it raises nothing
   * — the alarm for a lost probe is still Probe Health's, decided where it always was.
   *
   * **Nobody watching that probe costs one walk of the watchers and no query**, as an unwatched
   * state change costs none. A watcher the route has not judged yet is nobody (`U-26`).
   *
   * **One read in flight per probe.** A link that flaps calls this for every edge, and each call
   * would otherwise hold a query of its own. A change that arrives while the probe's place is
   * being read is covered by the frame that read is about to send: the frame goes after the
   * change, and whoever receives it asks for what is true then. It is counted and folded in.
   *
   * **This never rejects**, for the reason `publish` does not: it is called from the probe
   * endpoint's socket handlers, where a rejection has nobody to catch it.
   *
   * **The pool, never a transaction** (`P-253`), which the type says: a `tx` is what a
   * transaction's executor has not got. What never rejects swallows its read's failure, and
   * inside a transaction that failure would have aborted it with nobody told.
   */
  async publishProbe(db: StreamPool, probeId: ObjectId): Promise<number> {
    let watched = false;
    // Watchers the route has not judged yet (`U-26`): told when they stand, and no reason to
    // read anything now. See `considerProbe`.
    const early = new Set<Watching>();
    for (const watching of this.#watchers) {
      if (watching.probeId !== probeId) continue;
      if (watching.judged) {
        watched = true;
        continue;
      }
      watching.heard = true;
      early.add(watching);
    }
    if (!watched) return 0;
    const inFlight = this.#announcing.get(probeId);
    if (inFlight !== undefined) {
      this.#probeCoalesced += 1;
      inFlight.folded = true;
      return 0;
    }
    const announcing = { folded: false };
    this.#announcing.set(probeId, announcing);

    // As `publish`: every socket's credential before anything is delivered (`A-34`), and a
    // lapsed one silenced, not closed — a close here is a frame at the instant of this edge. Bounded
    // and shared as `publish`'s is (`U-27`).
    const vetting = this.#vet('edge');
    let path: ObjectId[] | undefined;
    let epoch: number | null;
    try {
      const read = await this.#ancestryOf(db, [probeId]);
      path = read.ancestry.get(probeId)?.path;
      epoch = read.epoch;
    } catch (error) {
      this.#logger.error(
        { probeId, err: describeError(error) },
        'could not read where a probe sits; nobody watching it was told that it changed',
      );
      await vetting;
      return 0;
    } finally {
      // From here a new change is a new frame: this one's read is over, and what it is about to
      // send may be on its way before the next change is.
      this.#announcing.delete(probeId);
    }
    await vetting;
    // Deleted between the change and this read. Its watchers learn that from the object's routes.
    if (path === undefined) return 0;

    // **Whoever watches this probe now, and nobody who starts while the views below are asked
    // for**: one that attaches later reads the probe's route after this change, so it loses
    // nothing, and it was not examined here.
    //
    // Nor one that was not judged when this change arrived (`U-26`): it was marked above, and is
    // told once when it stands, or has been already.
    //
    // **Unless a later change was folded into this read.** A watcher that stood while the read
    // was out has been told of the change that marked it, and the one folded in after it stood
    // is told by nothing but this frame: left out, it would never hear of it. So with anything
    // folded in, everybody judged by now is told; one told twice for one change has the second
    // folded into the frame it has not taken yet, where the route counts it.
    const targets = [...this.#watchers].filter(
      (watching) =>
        watching.probeId === probeId &&
        watching.judged &&
        (announcing.folded || !early.has(watching)),
    );
    const at = epoch;
    const views = await Promise.all(
      targets.map(async (watching): Promise<Visibility | null> => {
        const held = watching.sight.visibility;
        if (at === null || held.epoch === null || held.epoch === at) return held;
        // **Grants moved since this view was resolved, so it is asked for again — and whatever
        // the answer, the watcher is told nothing about it here.** The frame goes only through
        // the view the account has now; a watcher that has lost the probe is sent no frame, and
        // no `overflow` either, because this is the instant the probe changed and anything sent
        // now says so. Sending it back to the start is the sweep's, on the sweep's clock.
        try {
          const next = await this.#resolve(watching.sight, at);
          // The same view at a newer epoch: kept, so the next change does not ask again. A
          // changed one is left as it was, for the sweep to find and act on.
          if (next.sameAs(held)) watching.sight.visibility = next;
          return next;
        } catch (error) {
          this.#logger.warn(
            { err: describeError(error) },
            'could not re-resolve what a probe watcher may see; it is not told of this change',
          );
          return null;
        }
      }),
    );

    let sent = 0;
    for (const [index, watching] of targets.entries()) {
      // Detached while the views were asked for.
      if (!this.#watchers.has(watching)) continue;
      // **The hard rule.** The question a sensor's frame is asked, of the probe's own path: a
      // watcher that may not see the probe is sent nothing, not even a frame with its id.
      if (views[index]?.sees(path) !== true) continue;
      watching.subscriber.changed();
      sent += 1;
      this.#delivered += 1;
    }
    return sent;
  }

  /**
   * Publishes the state changes a transaction has just committed.
   *
   * Reads the ancestry of the sensors involved, and only then, because that read is the whole
   * cost of the feature and an installation nobody is watching must not pay it.
   *
   * **This never rejects** (`P-91`). It is the body of an `afterCommit` hook, and
   * `Database.tx`'s hook loop try/catches only the *synchronous* call — so a rejection from the
   * `#ancestryOf` query, which runs on the pool outside any transaction, escaped to
   * `unhandledRejection`, whose lifecycle handler logs fatal and shuts ms-core down. A pool
   * timeout under ingestion load, or a Postgres failover, therefore stopped the monitoring at
   * the moment the database was unhealthy and monitoring mattered most — over a broadcast whose
   * transaction had already committed and whose failure costs a repaint, not a fact.
   *
   * The guarantee lives here rather than in the caller's `.catch` because there is nothing a
   * caller could usefully do with the error, and a second hook added later would have to
   * remember. What it costs is every open tree reading a fresh snapshot, sent back by the next
   * sweep (`U-28`). Before that, the live stream stayed behind until the sensor next changed.
   *
   * **The pool, never a transaction** (`P-253`), which the type says. Handed one, the read that
   * fails here would abort it unseen; the read that succeeds would read what has not committed,
   * which is what being an `afterCommit` hook exists to prevent (`U-02`); and a transaction's
   * executor captured into that hook runs on a client already released.
   */
  async publish(
    db: StreamPool,
    changes: readonly {
      readonly sensorId: ObjectId;
      readonly state: SensorState;
      readonly previousState: SensorState | null;
      readonly cause: SensorStateCause;
      readonly message: string;
      readonly failure?: CheckFailure | null;
      readonly at: Date;
    }[],
  ): Promise<number> {
    if (changes.length === 0) return 0;
    if (!this.watching) {
      this.#unwatched += changes.length;
      return 0;
    }

    // **Every socket's credential, asked after this batch committed and before any of it is
    // delivered** (`A-34`), so nothing committed after a logout reaches the socket it ended. Beside
    // the ancestry read rather than after it, so it costs this batch no time; and never rejecting.
    //
    // **A lapsed socket is silenced here and closed by the sweep** (`U-25`): it is sent nothing
    // of this batch or of any later one, and the close that says so is not timed by this commit.
    //
    // **Waited for `credentialWaitMs` at most, and asked once however many batches are out**
    // (`U-27`, `#askAtEdge`). A check that fails or does not answer in time sends the batch only
    // to sockets vouched for within the last sweep interval, and holds the rest back until the
    // sweep can say: `#atEdge`. So a database that hangs holds no batch past the wait, and no
    // later batch behind it.
    const vetting = this.#vet('edge');
    let ancestry: Map<ObjectId, { name: string; path: ObjectId[] }>;
    let epoch: number | null;
    try {
      ({ ancestry, epoch } = await this.#ancestryOf(
        db,
        changes.map((change) => change.sensorId),
      ));
    } catch (error) {
      // **Every tree open now has missed these changes** (`U-28`): without their paths nobody can
      // say whose subtree and view they fall in, so each is owed an `overflow` — subscribe again,
      // which reads a snapshot that holds them. Before, the batch went to nobody, logged and not
      // counted, and every open tree showed the old state until that sensor next changed.
      //
      // **Owed, and sent by the sweep, not here.** Most of these subscriptions would never have
      // been sent the change at all; an `overflow` at this instant would tell each of them that
      // something committed now, somewhere it may not see — the instant `A-21` keeps from a
      // subscriber, and `U-25` from a signed-out one. On the sweep's clock it says only that some
      // change in the last interval could not be placed. Until then each is sent the changes
      // that can be, as before; the snapshot it reads afterwards supersedes them.
      this.#unplaced += changes.length;
      for (const attached of this.#attached) {
        this.#owe(attached, () => {
          if (!this.#attached.delete(attached)) return;
          attached.subscriber.overflow('a change could not be placed in the tree; subscribe again');
        });
      }
      this.#logger.error(
        { states: changes.length, subscribers: this.#attached.size, err: describeError(error) },
        'could not read the ancestry of committed state changes; every open tree is sent back ' +
          'to subscribe again on the next sweep',
      );
      await vetting;
      return 0;
    }
    await vetting;

    // **Grants change while sockets stay open** (`A-12`). The epoch came back with the ancestry,
    // so noticing costs no round trip; only a batch published after a grant change pays for
    // re-resolving, and only for the subscribers whose answer was read at another epoch.
    const horizon = epoch === null ? this.#attachments : await this.#catchUp(epoch);

    let sent = 0;
    for (const change of changes) {
      const found = ancestry.get(change.sensorId);
      // A sensor deleted between the commit and this read. Nothing to say about it, and the
      // deletion is its own event as far as a tree is concerned.
      if (found === undefined) continue;
      this.#published += 1;
      const event: StateEvent = {
        sensorId: change.sensorId,
        sensorName: found.name,
        path: found.path,
        state: change.state,
        previousState: change.previousState,
        cause: change.cause,
        message: change.message,
        failure: change.failure ?? null,
        at: change.at.toISOString(),
      };
      sent += this.#deliver(event, horizon);
    }
    return sent;
  }

  /**
   * The current state of a subtree, and the access epoch it was read at.
   *
   * Taken *after* the subscriber is attached, so nothing can happen in the gap: an event that
   * lands between the two is held by the route until this has been sent, and delivered after it
   * (`A-30`), where applying it a second time sets the state it already has. The alternative
   * ordering loses changes and looks fine.
   *
   * **The epoch is read in the same statement as the rows** (`A-30`), so the two are one moment.
   * `visibility` was resolved in an earlier one, and a grant revoked in between would otherwise
   * be read straight past: the sensors it hid are in the snapshot, and nothing sends the socket
   * back until some later change happens to be published. `confirm` is what the caller does with
   * it.
   */
  async snapshot(
    q: Queryable,
    objectId: ObjectId | null,
    visibility: Visibility,
  ): Promise<SnapshotRead> {
    const values: unknown[] = [objectId, this.#snapshotLimit + 1];
    // Inside the query, so the limit counts only sensors the subscriber may see (`A-12`).
    const visible = visibility.where('covered.id', (value) => `$${String(values.push(value))}`);
    const read = await q.query<{
      sensor_id: string | null;
      name: string;
      path: string[];
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      failure_phase: string | null;
      failure_target: string | null;
      since: Date;
      epoch: string;
    }>(
      `
      -- Two walks. Up first, to get the subtree root's own ancestors, then down. The paths a
      -- snapshot carries have to be the same absolute paths the events carry — a client that
      -- matched one against the other would find the tree it drew and the tree it updates are
      -- rooted differently.
      WITH RECURSIVE up AS (
        SELECT o.id, o.parent_id, ARRAY[o.id] AS prefix, 0 AS depth
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, ARRAY[p.id] || up.prefix, up.depth + 1
        FROM object p JOIN up ON p.id = up.parent_id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      ),
      covered AS (
        SELECT o.id, (SELECT prefix FROM up WHERE parent_id IS NULL LIMIT 1) AS path, 0 AS depth
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT c.id, covered.path || c.id, covered.depth + 1
        FROM object c JOIN covered ON c.parent_id = covered.id
        WHERE covered.depth < ${String(MAX_WALK_DEPTH)}
      ),
      picked AS (
        SELECT covered.id, o.name, covered.path, sr.state, sr.cause, sr.message,
               sr.failure_phase, sr.failure_target, sr.since
        FROM covered
        JOIN object o ON o.id = covered.id
        JOIN sensor_runtime sr ON sr.object_id = covered.id
        WHERE o.kind = 'sensor' AND ${visible}
        ORDER BY covered.id
        LIMIT $2
      )
      -- One row even when nothing is picked, so an empty snapshot still says when it was read.
      SELECT picked.id::text AS sensor_id, picked.name, picked.path::text[] AS path,
             picked.state, picked.cause, picked.message,
             picked.failure_phase, picked.failure_target, picked.since,
             (SELECT value::text FROM access_epoch) AS epoch
      FROM (SELECT 1) AS one
      LEFT JOIN picked ON true
      ORDER BY picked.id
      `,
      values,
    );
    const first = read[0];
    const epoch = first === undefined ? null : Number(first.epoch);
    const rows = read.filter(
      (row): row is typeof row & { sensor_id: string } => row.sensor_id !== null,
    );

    const truncated = rows.length > this.#snapshotLimit;
    if (truncated) {
      this.#logger.warn(
        { objectId, limit: this.#snapshotLimit },
        'a subtree has more sensors than one snapshot carries',
      );
    }
    return {
      epoch,
      snapshot: {
        objectId,
        truncated,
        entries: rows.slice(0, this.#snapshotLimit).map((row) => ({
          sensorId: Number(row.sensor_id),
          sensorName: row.name,
          // The same steps an event for this sensor would carry, so a client matching one against
          // the other finds the same tree (`A-12`).
          path: visibility.trim(row.path.map(Number)),
          state: row.state,
          cause: row.cause,
          message: row.message,
          failure: failureOf(row),
          since: row.since.toISOString(),
        })),
      },
    };
  }

  /**
   * Whether a snapshot read at `epoch` may still be sent through `sight` (`A-30`).
   *
   * True when nothing moved between resolving the sight and reading the snapshot, or when it
   * moved and asking again gives the same answer — in which case the sight is brought up to date,
   * so the next published batch does not ask a third time. False when the answer changed: the
   * snapshot was read through a view this account no longer has, and must not be sent. That is a
   * resync, counted as one, and the caller says so the way `#catchUp` does.
   *
   * Rejects when the resolution fails; the caller already treats a snapshot it could not read as
   * a subscription to refuse.
   */
  async confirm(sight: StreamSight, epoch: number | null): Promise<boolean> {
    const seen = sight.visibility.epoch;
    if (epoch === null || seen === null || seen === epoch) return true;
    const next = await this.#resolve(sight, epoch);
    if (next.sameAs(sight.visibility)) {
      sight.visibility = next;
      return true;
    }
    this.#resynced += 1;
    return false;
  }

  /**
   * What `sight` may see now, asked once per principal however many batches noticed the same
   * epoch at the same time (`A-30`).
   *
   * Keyed by the epoch as well as the principal: an answer being fetched for an older epoch may
   * already be stale for a newer one, and waiting on it would carry the staleness forward.
   */
  #resolve(sight: StreamSight, epoch: number): Promise<Visibility> {
    const key = `${sight.key}@${String(epoch)}`;
    const inFlight = this.#resolving.get(key);
    if (inFlight !== undefined) return inFlight;
    const pending = sight.resolve();
    this.#resolving.set(key, pending);
    const settle = (): void => {
      if (this.#resolving.get(key) === pending) this.#resolving.delete(key);
    };
    pending.then(settle, settle);
    return pending;
  }

  /**
   * Re-resolves every subscriber whose visibility was read at another epoch, and sends back to the
   * start any whose answer changed.
   *
   * **A changed view is a resync, not a quiet swap.** The client has already painted sensors it
   * may no longer see, and patching events onto that tree would leave them there; `overflow` is
   * the frame that already means "everything you hold is suspect, subscribe again", and the
   * client already does exactly that with it.
   *
   * **A resolution that fails cuts the subscriber off rather than guessing.** It must not reject
   * — see `publish` — and the one answer that cannot leak is to stop sending until the client
   * has subscribed again, which resolves afresh or fails where the failure can be reported.
   *
   * Returns its horizon, the last attachment it looked at, which is how `#deliver` knows the ones
   * it did not (`A-30`): a subscriber that attached while this was waiting was never examined,
   * and is skipped for this batch rather than sent it through a view resolved before the grants
   * moved.
   */
  async #catchUp(epoch: number): Promise<number> {
    const horizon = this.#attachments;
    // Tree subscribers only. A probe watcher is reviewed by the sweep and nowhere else (`U-24`,
    // `#review`): examined here, it would be told at the instant something changed state.
    const stale = [...this.#attached].filter((attached) => {
      const seen = attached.sight.visibility.epoch;
      // Different, not older (`A-25`): the counter only rises in a running database, but a
      // restore or a rollback can put it back, and a socket resolved at the higher number would
      // then never be told again until the counter passed it.
      return seen !== null && seen !== epoch;
    });
    if (stale.length === 0) return horizon;

    await Promise.all(
      stale.map(async (attached) => {
        let next: Visibility | null;
        try {
          next = await this.#resolve(attached.sight, epoch);
        } catch (error) {
          this.#logger.warn(
            { err: describeError(error) },
            'could not re-resolve what a stream subscriber may see; it must resubscribe',
          );
          next = null;
        }
        // Detached while this was being asked: nothing to update and nobody to tell.
        if (!this.#attached.has(attached)) return;
        if (next?.sameAs(attached.sight.visibility) === true) {
          attached.sight.visibility = next;
          return;
        }
        this.#attached.delete(attached);
        this.#resynced += 1;
        attached.subscriber.overflow(
          next === null
            ? 'could not confirm what this account may see; subscribe again'
            : 'what this account may see has changed; subscribe again',
        );
      }),
    );
    return horizon;
  }

  /**
   * Fans one event out to whoever asked for that subtree and may see it.
   *
   * **Not to a subscriber that attached after `horizon`** (`A-30`). `#catchUp` never examined it
   * — it attached while the check waited on a resolution, or between its return and this — and
   * its view may have been resolved before the grants moved. Skipping it loses nothing: it
   * attached after this batch committed, so the snapshot it is about to read already holds the
   * change, and the next batch examines it. Its epoch is not the test: a subscriber attached long
   * ago can have had its sight brought forward by a concurrent batch, and skipping that one would
   * lose the change.
   */
  #deliver(event: StateEvent, horizon: number): number {
    let sent = 0;
    for (const attached of this.#attached) {
      if (attached.order > horizon) continue;
      if (attached.objectId !== null && !event.path.includes(attached.objectId)) continue;
      // Checked against the path the event already carries, so fanning out to a hundred
      // sockets is a hundred walks of a short array and not a hundred queries (`A-12`).
      const visibility = attached.sight.visibility;
      if (!visibility.sees(event.path)) continue;
      // Asked, not inferred. See `StateSubscriber.backlog`.
      const backlog = attached.subscriber.backlog?.() ?? 0;
      if (backlog >= this.#backlogLimit) {
        this.#attached.delete(attached);
        this.#overflowed += 1;
        this.#logger.warn(
          { objectId: attached.objectId, backlog, limit: this.#backlogLimit },
          'a subscriber fell too far behind and was cut off; it must resubscribe',
        );
        attached.subscriber.overflow();
        continue;
      }
      attached.subscriber.send(
        visibility.everything ? event : { ...event, path: visibility.trim(event.path) },
      );
      sent += 1;
      this.#delivered += 1;
    }
    return sent;
  }

  /**
   * Root-first ancestor paths for a batch of sensors, and the access epoch, in one query.
   *
   * The epoch rides along because this query already runs for every published batch, so a
   * stream learns that grants changed without paying a round trip to ask (`A-12`). Null when no
   * sensor survived to be placed — there is nothing to deliver, so nothing to be stale about.
   */
  async #ancestryOf(
    q: Queryable,
    sensorIds: readonly ObjectId[],
  ): Promise<{
    ancestry: Map<ObjectId, { name: string; path: ObjectId[] }>;
    epoch: number | null;
  }> {
    const rows = await q.query<{ sensor_id: string; name: string; path: string[]; epoch: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS origin, o.id, o.parent_id, o.name AS origin_name, ARRAY[o.id] AS path,
               0 AS depth
        FROM object o WHERE o.id = ANY($1::bigint[])
        UNION ALL
        SELECT chain.origin, p.id, p.parent_id, chain.origin_name, ARRAY[p.id] || chain.path,
               chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT origin::text AS sensor_id, origin_name AS name, path::text[] AS path,
             (SELECT value::text FROM access_epoch) AS epoch
      FROM chain
      WHERE parent_id IS NULL
      `,
      [sensorIds],
    );
    const first = rows[0];
    return {
      ancestry: new Map(
        rows.map((row) => [Number(row.sensor_id), { name: row.name, path: row.path.map(Number) }]),
      ),
      epoch: first === undefined ? null : Number(first.epoch),
    };
  }
}
