import { randomUUID } from 'node:crypto';
import {
  capabilitiesFor,
  versionFor,
  type CheckResult,
  type Logger,
  type ProbeQuery,
  type QueryFailure,
  type UnfitResults,
} from '@ms/shared';
import type { ProbeRefusals } from './refusals.js';

/**
 * On-demand queries to a probe, with an API call waiting on the answer (`R-09`).
 *
 * **Everything else in this protocol is one-way, and that is what makes this its own mechanism
 * rather than another message.** The core tells a probe what to scan; the probe reports what it
 * found; neither waits for the other, which is why `D-02` identifies two hundred hosts down the
 * asynchronous discovery path instead of this one. Here a person is looking at a spinner, so the
 * request has to be correlated to its answer, bounded in time, and bounded in number.
 *
 * **Three failures this exists to make impossible.**
 *
 * A promise that never settles. Every path that removes a pending query settles it — the answer,
 * the timeout, the disconnect, and shutdown — because an HTTP handler awaiting a promise nobody
 * will resolve is a socket that stays open until the client gives up, and enough of those is the
 * API going quiet for a reason no log line explains.
 *
 * An unbounded queue. `CLAUDE.md` requires backpressure to be visible and never silent: past the
 * in-flight bound a query is **refused immediately and counted**, rather than queued behind
 * others whose deadlines are already running. A refusal an operator can retry beats a spinner
 * that was never going to finish.
 *
 * An answer delivered to the wrong caller. Ids are per-core-process UUIDs rather than a counter,
 * so a probe that reconnects to a restarted core cannot answer an id this core has since reused.
 */

/**
 * What `offline` says. One sentence for every way of finding out (`A-52`): the query had no
 * session to go to, or "check now" found nobody on the line before it built anything to send.
 */
export const PROBE_NOT_CONNECTED = 'the probe that owns this sensor is not connected';

/** What the core did with a query. A discriminated union, because each arm is acted on. */
export type QueryOutcome =
  { kind: 'ok'; result: CheckResult } | { kind: 'failed'; failure: QueryFailure; message: string };

export interface ProbeQuerySender {
  /**
   * Sends to the probe that owns this object, or says why it could not.
   *
   * `offline` and `too-old` are separated for `R-06`'s reason: one waits and the other never
   * will, and collapsing them is how a request hangs on a probe that was never going to answer.
   */
  sendQuery(
    probeObjectId: number,
    message:
      | {
          kind: 'ask';
          queryId: string;
          query: ProbeQuery;
          timeoutMs: number;
          /**
           * The protocol version the query was built for (`A-41c`). A session speaking any other
           * is not the probe that was asked about, and is not sent it: answered `offline`.
           */
          peerVersion?: number;
        }
      | { kind: 'cancel'; queryId: string },
  ): { kind: 'sent' } | { kind: 'offline' } | { kind: 'too-old'; protocolVersion: number };
  /**
   * What the probe on the line for this object speaks, or 0 when none is (`A-41c`). Absent on a
   * sender with no sessions, which reads as none.
   */
  protocolVersionOf?(probeObjectId: number): number;
}

export interface ProbeQueryServiceOptions {
  logger: Logger;
  sender: ProbeQuerySender;
  /** Where an answer from the wrong probe is counted, for Probe Health (`P-228`). */
  refusals?: ProbeRefusals;
  /** How long to wait when a caller does not say. */
  defaultTimeoutMs?: number;
  /**
   * Queries in flight across every probe.
   *
   * Small on purpose. These are interactive — one operator, one form, one button — so a number
   * in the tens is a queue of people, not of work, and anything larger is either a script or a
   * bug. Each one holds a probe worker that has scans to get on with.
   */
  maxInFlight?: number;
  /** Per probe, so one unresponsive device cannot spend the whole allowance. */
  maxInFlightPerProbe?: number;
  /** Injected so a test does not wait in real time. */
  timer?: {
    set: (fn: () => void, ms: number) => NodeJS.Timeout;
    clear: (handle: NodeJS.Timeout) => void;
  };
}

export interface ProbeQueryStats {
  /** Queries awaiting an answer right now. */
  inFlight: number;
  /** Turned away because the bound was reached. Backpressure, visible (`CLAUDE.md`). */
  refused: number;
  /** Answered by a probe, whatever the answer was. */
  answered: number;
  /** Deadlines that expired with nothing back. */
  timedOut: number;
  /** Abandoned because the probe's connection went while they were waiting. */
  abandoned: number;
  /** Answers refused because a probe other than the one asked sent them (`P-228`). */
  foreign: number;
  /**
   * Answers whose result could not be made to fit the protocol, refused and answered `too-old`
   * (`P-289`). Counted on the probe's Reports refused as well.
   */
  unfit: number;
}

interface Pending {
  probeObjectId: number;
  settle: (outcome: QueryOutcome) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_MAX_PER_PROBE = 8;

export class ProbeQueryService {
  readonly #logger: Logger;
  readonly #sender: ProbeQuerySender;
  readonly #refusals: ProbeRefusals | undefined;
  readonly #defaultTimeoutMs: number;
  readonly #maxInFlight: number;
  readonly #maxPerProbe: number;
  readonly #timer: NonNullable<ProbeQueryServiceOptions['timer']>;
  readonly #pending = new Map<string, Pending>();

  #refused = 0;
  #answered = 0;
  #timedOut = 0;
  #abandoned = 0;
  #foreign = 0;
  #unfit = 0;

  constructor(options: ProbeQueryServiceOptions) {
    this.#logger = options.logger.child({ component: 'probe-queries' });
    this.#sender = options.sender;
    this.#refusals = options.refusals;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#maxPerProbe = options.maxInFlightPerProbe ?? DEFAULT_MAX_PER_PROBE;
    this.#timer = options.timer ?? {
      set: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Never a reason to hold the process open: a query nobody is waiting for any more is a
        // query whose answer does not matter.
        handle.unref();
        return handle;
      },
      clear: (handle) => {
        clearTimeout(handle);
      },
    };
  }

  stats(): ProbeQueryStats {
    return {
      inFlight: this.#pending.size,
      refused: this.#refused,
      answered: this.#answered,
      timedOut: this.#timedOut,
      abandoned: this.#abandoned,
      foreign: this.#foreign,
      unfit: this.#unfit,
    };
  }

  /**
   * Asks one probe, and resolves with what came back or with why nothing did.
   *
   * **Never rejects.** Every caller is an HTTP handler that has to turn this into a response, and
   * a mechanism whose failures arrive as exceptions is one where forgetting a `catch` turns a
   * probe being offline into a 500.
   */
  /**
   * What the probe that would be asked speaks now, or 0 with none connected (`A-41c`). What a
   * check's credentials are decided against, and then handed to `ask` so that the probe that
   * gets the query is the one they were decided for.
   */
  peerVersion(probeObjectId: number): number {
    return this.#sender.protocolVersionOf?.(probeObjectId) ?? 0;
  }

  async ask(
    probeObjectId: number,
    query: ProbeQuery,
    options: { timeoutMs?: number; peerVersion?: number } = {},
  ): Promise<QueryOutcome> {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    const busy = this.#tooBusyFor(probeObjectId);
    if (busy !== null) {
      this.#refused += 1;
      this.#logger.warn({ probeObjectId, inFlight: this.#pending.size }, busy);
      return { kind: 'failed', failure: 'busy', message: busy };
    }

    const queryId = randomUUID();
    const delivery = this.#sender.sendQuery(probeObjectId, {
      kind: 'ask',
      queryId,
      query,
      timeoutMs,
      ...(options.peerVersion === undefined ? {} : { peerVersion: options.peerVersion }),
    });
    if (delivery.kind === 'offline') {
      return { kind: 'failed', failure: 'offline', message: PROBE_NOT_CONNECTED };
    }
    if (delivery.kind === 'too-old') {
      const needs = versionFor('onDemandQuery');
      return {
        kind: 'failed',
        failure: 'too-old',
        message:
          `the probe speaks protocol ${String(delivery.protocolVersion)} and this needs ` +
          `${String(needs)} — upgrade the probe`,
      };
    }

    return new Promise<QueryOutcome>((resolve) => {
      const timer = this.#timer.set(() => {
        // Removed *before* resolving, so a `query-result` racing this deadline finds nothing to
        // deliver to rather than settling a promise twice.
        this.#pending.delete(queryId);
        this.#timedOut += 1;
        this.#sender.sendQuery(probeObjectId, { kind: 'cancel', queryId });
        this.#logger.warn({ probeObjectId, queryId, timeoutMs }, 'a probe query timed out');
        resolve({
          kind: 'failed',
          failure: 'timeout',
          message: `the probe did not answer within ${String(timeoutMs)} ms`,
        });
      }, timeoutMs);

      this.#pending.set(queryId, { probeObjectId, settle: resolve, timer });
    });
  }

  /**
   * Delivers a probe's answer to whoever is waiting for it.
   *
   * An id nobody is waiting for is ordinary and is logged rather than refused: it is what a
   * result that lost a race with its own deadline looks like, and the answer is simply late.
   *
   * **Only the probe the query was put to may answer it** (`P-228`). The probe was recorded when
   * the query was sent and never compared, so any connected probe that learned a query id could
   * settle it with a reading of its choosing — the answer an operator was waiting on to decide
   * whether the thing they just fixed works. The id is a random UUID, so this is not a guess
   * anyone makes by accident, and that is exactly why an answer from elsewhere is foreign rather
   * than late: it is refused, the caller keeps waiting for the real one, and Probe Health warns
   * on the probe that sent it.
   *
   * **A result the core could not make fit is refused, and the query answered `too-old`**
   * (`P-289`). It used to close the link, so the caller was told the probe had gone and every
   * other query on it failed too. Every probe since `P-277` fits its results before sending, so
   * one that does not is a build before it (or not our probe), and an upgrade is what mends it:
   * `too-old` is the answer that says so, and puts an upgrade prompt where a retry would do the
   * same again. Counted on Reports refused, as a refused result in a batch is (`P-281`). A result
   * only fitted is the answer, and said in the log: nothing was stored, so nothing is counted.
   */
  deliver(
    message: {
      queryId: string;
      result?: CheckResult;
      failure?: QueryFailure;
      message?: string;
    },
    from: number | null,
    unfit?: UnfitResults,
  ): void {
    const pending = this.#pending.get(message.queryId);
    if (pending === undefined) {
      this.#logger.debug(
        { queryId: message.queryId, ...(unfit === undefined ? {} : { unfit }) },
        'a probe answered a query nobody awaits',
      );
      return;
    }
    if (pending.probeObjectId !== from) {
      this.#foreign += 1;
      this.#refusals?.foreign(from);
      this.#logger.warn(
        { queryId: message.queryId, askedProbe: pending.probeObjectId, answeredBy: from },
        'a probe answered a query that was put to another probe; refused',
      );
      return;
    }
    this.#pending.delete(message.queryId);
    this.#timer.clear(pending.timer);
    this.#answered += 1;

    const refused = unfit?.refused[0];
    if (refused !== undefined) {
      this.#unfit += 1;
      this.#refusals?.refused(from);
      this.#logger.warn(
        { queryId: message.queryId, probeObjectId: from, refused },
        'a probe answered a query with a result that cannot be made to fit the protocol; ' +
          'refused, and the query answered too-old',
      );
      pending.settle({
        kind: 'failed',
        failure: 'too-old',
        message:
          `the probe answered with a result that does not fit the protocol (${refused.reason}); ` +
          'a current probe fits its results before sending them — upgrade the probe',
      });
      return;
    }
    const fitted = unfit?.fitted[0];
    if (fitted !== undefined) {
      this.#logger.warn(
        { queryId: message.queryId, probeObjectId: from, fitted },
        'a probe answered a query with a result that does not fit the protocol as it is; ' +
          'fitted as a current probe fits it before sending',
      );
    }

    if (message.result !== undefined) {
      pending.settle({ kind: 'ok', result: message.result });
      return;
    }
    pending.settle({
      kind: 'failed',
      // A probe that sends neither a result nor a reason has still answered; calling that
      // `unsupported` names the likeliest cause and keeps the caller off the timeout path.
      failure: message.failure ?? 'unsupported',
      message: message.message ?? 'the probe answered without a result',
    });
  }

  /**
   * Settles everything waiting on a probe whose connection has gone.
   *
   * Without this the caller waits out its full deadline for an answer that provably cannot
   * arrive — the socket carrying it no longer exists — which is the slowest possible way to
   * learn a fact the core already knows.
   */
  probeDisconnected(probeObjectId: number): void {
    for (const [queryId, pending] of [...this.#pending]) {
      if (pending.probeObjectId !== probeObjectId) continue;
      this.#pending.delete(queryId);
      this.#timer.clear(pending.timer);
      this.#abandoned += 1;
      pending.settle({
        kind: 'failed',
        failure: 'offline',
        message: 'the probe disconnected before it answered',
      });
    }
  }

  /** Settles everything still waiting, so shutdown does not leave a request hanging. */
  stop(): void {
    for (const [queryId, pending] of [...this.#pending]) {
      this.#pending.delete(queryId);
      this.#timer.clear(pending.timer);
      this.#abandoned += 1;
      pending.settle({
        kind: 'failed',
        failure: 'offline',
        message: 'the core is shutting down',
      });
    }
  }

  /** The reason this query cannot be admitted, or `null` if it can. */
  #tooBusyFor(probeObjectId: number): string | null {
    if (this.#pending.size >= this.#maxInFlight) {
      return `${String(this.#maxInFlight)} on-demand queries are already in flight`;
    }
    let forProbe = 0;
    for (const pending of this.#pending.values()) {
      if (pending.probeObjectId === probeObjectId) forProbe += 1;
    }
    if (forProbe >= this.#maxPerProbe) {
      return `${String(this.#maxPerProbe)} on-demand queries are already in flight for this probe`;
    }
    return null;
  }
}

/** The capability gate, so a caller can refuse before building a query it cannot send. */
export function canQuery(protocolVersion: number): boolean {
  return capabilitiesFor(protocolVersion).onDemandQuery;
}
