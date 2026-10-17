import { parentPort, workerData } from 'node:worker_threads';
import {
  countedElsewhere,
  RESOLVER_BUSY,
  RESOLVER_LATE,
  type ResolvedAddress,
  type ResolveHost,
} from '@ms/sensors';
import type { ResolveRequest } from '../resolver/protocol.js';
import type { CheckExecution } from './types.js';

/**
 * A check worker's side of the probe's resolver (`P-426`): the `ResolveHost` its catalogue is
 * built with, asking the main thread's `NameResolver` over the worker's port to its pool.
 *
 * **It settles its own wait.** Whatever the main thread does, a request ends here no later than its
 * `waitMs` and a little slack, and a reply that arrives after is dropped by its id. The check has
 * long since stopped waiting by then (`resolveWithin` gives up at `waitMs`); this is what keeps
 * the map of requests from growing behind a main thread that never answers.
 *
 * **And it tells a busy probe from a silent resolver.** The resolver acknowledges a request it
 * cannot answer at once as soon as it reads it. A request neither answered nor acknowledged by the
 * end of its bound (`ackWithinMs`) was never read: the main thread is stalled, which is the probe,
 * not DNS, and the check fails saying so (`RESOLVER_BUSY`), not counted as given up. It waits the
 * whole bound for that, not part of it (`P-426`'s review): a main thread that stalls for two
 * seconds and then answers from what it keeps answers a check whose bound is longer, and failing
 * the check sooner could only reach the pool once the main thread runs again anyway.
 *
 * Counted by the resolver, not here: the promise is `countedElsewhere`, since the resolver's
 * running and queued lookups are in `lookupsInFlight` already.
 */

/** What the client posts and listens on: a worker's `parentPort`, or a test's channel. */
export interface ResolvePort {
  postMessage(message: ResolveRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface PoolResolveClientOptions {
  /** "Check now": every request asks the resolver rather than its cache. */
  readonly fresh?: boolean;
  /** How long past its `waitMs` a request is kept for its reply. `SETTLE_SLACK_MS` by default. */
  readonly slackMs?: number;
  /** How long the main thread has to take a request. `ackWithinMs(waitMs)` by default. */
  readonly ackWithinMs?: number;
}

/** How long past its bound a request is kept: longer than the resolver keeps its waiter. */
export const SETTLE_SLACK_MS = 500;
/** What a request is waited for when its caller does not say. */
const DEFAULT_WAIT_MS = 10_000;

/** How far before its bound an unread request is ended, so its words reach the check first. */
export const ACK_LEAD_MS = 20;

/**
 * How long the main thread has to take a request: its whole bound, less `ACK_LEAD_MS`, so that the
 * check is told the probe was overloaded before its own wait (`resolveWithin`, armed after this
 * with the same bound) says the resolver is not answering.
 */
export function ackWithinMs(waitMs: number): number {
  return Math.max(1, waitMs - ACK_LEAD_MS);
}

interface Request {
  readonly resolve: (addresses: readonly ResolvedAddress[]) => void;
  readonly reject: (error: Error) => void;
  ackTimer: NodeJS.Timeout | undefined;
  readonly settleTimer: NodeJS.Timeout;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class PoolResolveClient {
  readonly #port: ResolvePort;
  readonly #fresh: boolean;
  readonly #slackMs: number;
  readonly #ackWithinMs: number | undefined;
  readonly #requests = new Map<number, Request>();
  readonly #notes: string[] = [];
  #nextId = 0;

  constructor(port: ResolvePort, options: PoolResolveClientOptions = {}) {
    this.#port = port;
    this.#fresh = options.fresh ?? false;
    this.#slackMs = Math.max(0, options.slackMs ?? SETTLE_SLACK_MS);
    this.#ackWithinMs = options.ackWithinMs;
    port.on('message', (message: unknown) => {
      this.#onMessage(message);
    });
  }

  /** Requests asked and not yet answered or given up on. */
  get pending(): number {
    return this.#requests.size;
  }

  /**
   * What the resolver said about the answers it gave since the last call, and forgets them: for
   * "Check now", that a cached answer was used because the resolver did not answer.
   */
  takeNotes(): string[] {
    return this.#notes.splice(0);
  }

  readonly resolve: ResolveHost = (host, family, options) => {
    const waitMs =
      options?.waitMs !== undefined && Number.isFinite(options.waitMs) && options.waitMs > 0
        ? options.waitMs
        : DEFAULT_WAIT_MS;
    this.#nextId += 1;
    const id = this.#nextId;
    const asked = new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
      const ackMs = this.#ackWithinMs ?? ackWithinMs(waitMs);
      const settleTimer = setTimeout(() => {
        this.#end(
          id,
          failure(
            RESOLVER_LATE,
            `the probe’s resolver had not answered ${host} within ${String(waitMs)} ms`,
          ),
        );
      }, waitMs + this.#slackMs);
      settleTimer.unref();
      const ackTimer = setTimeout(() => {
        this.#end(
          id,
          failure(
            RESOLVER_BUSY,
            `the probe’s main thread did not take the lookup within ${String(waitMs)} ms ` +
              '(the probe is overloaded)',
          ),
        );
      }, ackMs);
      ackTimer.unref();
      this.#requests.set(id, { resolve, reject, ackTimer, settleTimer });
    });
    try {
      this.#port.postMessage({ type: 'resolve', id, host, family, waitMs, fresh: this.#fresh });
    } catch (error: unknown) {
      this.#end(
        id,
        failure(
          RESOLVER_BUSY,
          `the lookup could not be sent to the probe’s main thread: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return countedElsewhere(asked);
  };

  #onMessage(message: unknown): void {
    const said = message as { type?: unknown; id?: unknown } | null;
    if (said === null || typeof said !== 'object' || typeof said.id !== 'number') return;
    if (said.type === 'resolve-ack') {
      const request = this.#requests.get(said.id);
      if (request !== undefined) {
        clearTimeout(request.ackTimer);
        request.ackTimer = undefined;
      }
      return;
    }
    if (said.type !== 'resolved') return;
    const reply = message as
      | { id: number; ok: true; addresses: readonly ResolvedAddress[]; note?: string }
      | { id: number; ok: false; code: string; message: string };
    const request = this.#take(reply.id);
    // A reply to a request this side already gave up on: dropped.
    if (request === undefined) return;
    if (reply.ok) {
      if (typeof reply.note === 'string' && reply.note !== '') this.#notes.push(reply.note);
      request.resolve(reply.addresses);
    } else {
      request.reject(failure(reply.code, reply.message));
    }
  }

  #take(id: number): Request | undefined {
    const request = this.#requests.get(id);
    if (request === undefined) return undefined;
    this.#requests.delete(id);
    clearTimeout(request.ackTimer);
    clearTimeout(request.settleTimer);
    return request;
  }

  #end(id: number, error: Error): void {
    this.#take(id)?.reject(error);
  }
}

/**
 * One check, with what the resolver said about the answers it used added to its message
 * (`P-426`): for "Check now", that the resolver did not answer and a kept answer was used, so the
 * operator who pressed it reads that the address is not a fresh one. A worker runs one check at a
 * time, so what was said while this one ran is this one's.
 */
export async function withResolverNotes(
  client: PoolResolveClient | undefined,
  run: () => Promise<CheckExecution>,
): Promise<CheckExecution> {
  if (client === undefined) return run();
  client.takeNotes();
  let execution: CheckExecution;
  try {
    execution = await run();
  } catch (error: unknown) {
    const notes = client.takeNotes();
    if (notes.length > 0 && error instanceof Error) error.message = noted(error.message, notes);
    throw error;
  }
  const notes = client.takeNotes();
  return notes.length === 0
    ? execution
    : { ...execution, message: noted(execution.message ?? '', notes) };
}

function noted(said: string, notes: readonly string[]): string {
  const note = notes.join('; ');
  return said === '' ? note : `${said} (${note})`;
}

let shared: PoolResolveClient | undefined;
let decided = false;

/**
 * This worker's client, when its pool serves lookups (`workerData.resolveThroughPool`); undefined
 * in a thread no pool started so, a process child, or the main thread, which resolve for
 * themselves. One per thread.
 */
export function poolResolver(): PoolResolveClient | undefined {
  if (decided) return shared;
  decided = true;
  const data = workerData as { resolveThroughPool?: unknown; freshLookups?: unknown } | null;
  if (parentPort === null || data?.resolveThroughPool !== true) return undefined;
  shared = new PoolResolveClient(parentPort, { fresh: data.freshLookups === true });
  return shared;
}
