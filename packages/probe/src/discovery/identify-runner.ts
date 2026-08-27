import type { Logger } from 'pino';
import type { Fingerprint, IdentifyJob, SweepEnding } from '@ms/shared';
import { identify, type IdentifyDeps } from './identify.js';

/**
 * The identification pass (`D-02`).
 *
 * **The same discipline as `SweepRunner`, deliberately not the same class.** Both are resumable,
 * cancellable and stand down for live checks, and both report a cursor — but a sweep walks a rule
 * that generates addresses while this walks a list the core holds, a sweep's unit of work is one
 * UDP echo while this is a dozen sockets and a resolver, and a sweep finds hosts while this
 * describes them. Sharing a base class would mean one set of parameters bent to fit two jobs; two
 * hundred-line runners that read the same way is the cheaper duplication.
 *
 * **Far lower concurrency than the sweep, and that is the point of the separate bound.** Each
 * host here opens twelve TCP connections, a UDP socket and a resolver query; at the sweep's
 * thirty-two that is well over four hundred file descriptors and a burst that looks exactly like
 * a port scan to anything watching. Eight is the default, and the whole pass is still bounded by
 * the number of hosts a sweep actually found rather than by the size of the range.
 */

export interface IdentifyRunnerDeps {
  readonly logger: Logger;
  readonly sources: IdentifyDeps;
  /** How many checks are waiting for a worker. Identification stands down above zero. */
  readonly queueDepth: () => number;
  readonly onProgress: (runId: number, cursor: number, found: Fingerprint[]) => void;
  readonly onFinished: (
    runId: number,
    ending: SweepEnding,
    cursor: number,
    message: string,
  ) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly progressIntervalMs?: number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 2_000;
const YIELD_MS = 250;

export interface IdentifyStats {
  readonly running: number;
  readonly identified: number;
  readonly yieldedMs: number;
  readonly cancelled: number;
  readonly completed: number;
}

interface Run {
  readonly job: IdentifyJob;
  readonly controller: AbortController;
  cursor: number;
  found: Fingerprint[];
}

export class IdentifyRunner {
  readonly #deps: IdentifyRunnerDeps;
  readonly #logger: Logger;
  readonly #runs = new Map<number, Run>();
  #identified = 0;
  #yieldedMs = 0;
  #cancelled = 0;
  #completed = 0;
  #stopped = false;

  constructor(deps: IdentifyRunnerDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'identify' });
  }

  stats(): IdentifyStats {
    return {
      running: this.#runs.size,
      identified: this.#identified,
      yieldedMs: this.#yieldedMs,
      cancelled: this.#cancelled,
      completed: this.#completed,
    };
  }

  start(job: IdentifyJob): void {
    if (this.#stopped) return;
    const existing = this.#runs.get(job.runId);
    if (existing !== undefined) existing.controller.abort(new Error('superseded'));

    const run: Run = { job, controller: new AbortController(), cursor: job.cursor, found: [] };
    this.#runs.set(job.runId, run);
    this.#logger.info(
      { runId: job.runId, hosts: job.addresses.length, cursor: job.cursor },
      'identification started',
    );
    void this.#run(run);
  }

  cancel(runId: number): void {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      this.#deps.onFinished(runId, 'cancelled', 0, '');
      return;
    }
    run.controller.abort(new Error('cancelled'));
  }

  stop(): void {
    this.#stopped = true;
    for (const run of this.#runs.values()) run.controller.abort(new Error('cancelled'));
  }

  async #run(run: Run): Promise<void> {
    const { job, controller } = run;
    const sleep = this.#deps.sleep ?? defaultSleep;
    const progressEvery = this.#deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    const stopped = (): boolean => controller.signal.aborted;
    const inFlight = new Set<Promise<void>>();
    let lastProgress = Date.now();
    let ending: SweepEnding = 'done';
    let message = '';

    const flush = (): void => {
      const found = run.found;
      run.found = [];
      this.#deps.onProgress(job.runId, run.cursor, found);
      lastProgress = Date.now();
    };

    try {
      while (!stopped()) {
        const address = job.addresses[run.cursor];
        if (address === undefined) break;

        while (this.#deps.queueDepth() > 0 && !stopped()) {
          const waitedFrom = Date.now();
          await sleep(YIELD_MS, controller.signal);
          this.#yieldedMs += Date.now() - waitedFrom;
          if (Date.now() - lastProgress >= progressEvery) flush();
        }
        if (stopped()) break;

        while (inFlight.size >= job.concurrency && !stopped()) {
          await Promise.race(inFlight);
        }
        if (stopped()) break;

        run.cursor += 1;
        const attempt = this.#one(run, address);
        inFlight.add(attempt);
        void attempt.finally(() => inFlight.delete(attempt));

        if (Date.now() - lastProgress >= progressEvery) flush();
      }

      // Whatever is still in the air belongs to this run. A fingerprint that finished after the
      // abort is still a host that was identified, and dropping it would mean asking again.
      //
      // **A cancel here takes up to one host-timeout to take effect, and that is on purpose.**
      // The sources take no `AbortSignal` — each carries its own deadline instead, so the wait is
      // bounded by `job.timeoutMs` (a second or two in practice) rather than being open-ended.
      // Threading a signal through a resolver, a UDP session and a dozen sockets would buy back
      // that second at the cost of five more places to get cancellation subtly wrong. The sweep
      // *does* thread one, because there the wait is the timeout times the whole remaining range.
      await Promise.allSettled([...inFlight]);

      if (stopped()) {
        const reason = controller.signal.reason as unknown;
        ending =
          reason instanceof Error && reason.message === 'superseded' ? 'superseded' : 'cancelled';
      }
    } catch (error) {
      ending = 'failed';
      message = error instanceof Error ? error.message : 'identification failed';
      this.#logger.error({ runId: job.runId, err: message }, 'identification failed');
    }

    if (run.found.length > 0) flush();
    if (ending !== 'superseded') this.#runs.delete(job.runId);
    if (ending === 'cancelled') this.#cancelled += 1;
    if (ending === 'done') this.#completed += 1;

    this.#logger.info(
      { runId: job.runId, ending, cursor: run.cursor, ...this.stats() },
      'identification finished',
    );
    this.#deps.onFinished(job.runId, ending, run.cursor, message);
  }

  async #one(run: Run, address: string): Promise<void> {
    try {
      const fingerprint = await identify(
        address,
        {
          timeoutMs: run.job.timeoutMs,
          community: run.job.community,
        },
        this.#deps.sources,
      );
      run.found.push(fingerprint);
      this.#identified += 1;
    } catch (error) {
      // `identify` is written not to throw, so this is the belt to its braces. A host that
      // somehow failed anyway must not take the pass down: the sweep already proved it exists,
      // and an unidentified host is still a host worth a Ping sensor.
      this.#logger.debug(
        { address, err: error instanceof Error ? error.message : 'unknown' },
        'a host could not be identified',
      );
    }
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
