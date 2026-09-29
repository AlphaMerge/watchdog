import type { Logger } from 'pino';
import {
  addressAt,
  parseIpRange,
  toText,
  type IpRange,
  type SweepEnding,
  type SweepHost,
  type SweepJob,
} from '@ms/shared';

/**
 * The ping sweep (`D-01`).
 *
 * **Three properties the ticket asks for, and each is a different mechanism.**
 *
 * *Resumable* is `cursor`: one integer, how many addresses have been offered. It is sent by the
 * core when a sweep starts or restarts, and reported back with every progress message. A probe
 * restart, a reconnect and a core failover all resume the same way. Re-sweeping a few addresses
 * after a crash costs nothing — a host found twice is the same host — so the cursor is a
 * *floor*, never a promise, and the core advances it only on what it has recorded.
 *
 * *Cancellable* is an `AbortController` per run: the in-flight pings are killed rather than
 * waited out, because an operator who typed the wrong range wants them to stop now and not in
 * 65,536 timeouts.
 *
 * *Rate-limited so it never starves live checks* is the one that needs saying properly.
 * `concurrency` and `ratePerSecond` bound the sweep in absolute terms, but a bound chosen in
 * advance cannot know what else the probe is doing at three o'clock on a Tuesday — so the sweep
 * also **watches the check pool and stands down**. While checks are queued it stops offering
 * addresses entirely, and the time it spent waiting is counted and reported rather than being
 * invisible: CLAUDE.md's rule is that backpressure is visible, never silent.
 *
 * **It shells out to `ping` per address, and that is a deliberate cost.** One process per
 * address is roughly 2 ms of setup (`docs/findings/2026-08-27-process-runner-startup.md`
 * measured 20 ms for a Node child; `ping` is far cheaper), which at 64 concurrent is well past
 * what any network answers. The alternative — a raw ICMP socket sending 65,536 echoes and
 * demultiplexing the replies — is faster and needs `CAP_NET_RAW`, which is exactly the privilege
 * `ADR-001` decided the default path would not require. `P-07`'s optional raw-socket fast path
 * is where that trade gets revisited, for this as well as for the ping sensor.
 */

export interface SweepDeps {
  readonly logger: Logger;
  /** Runs one address and says whether it answered. Injected so the tests need no network. */
  readonly probe: (
    address: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<number | null>;
  /** How many checks are waiting for a worker right now. The sweep stands down above zero. */
  readonly queueDepth: () => number;
  /** Reports progress. Called often; the caller batches onto the wire. */
  readonly onProgress: (runId: number, cursor: number, found: SweepHost[], failed: number) => void;
  readonly onFinished: (
    runId: number,
    ending: SweepEnding,
    cursor: number,
    message: string,
  ) => void;
  /** Injected so the tests do not wait. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected so a test can assert that progress arrives *during* a run, not only at its end. */
  readonly progressIntervalMs?: number;
  /**
   * Monotonic milliseconds, which the rate, the progress interval and the time spent standing
   * down are all timed on (`P-247`). On the wall clock, a backward step of an hour refilled the
   * bucket by minus an hour's worth, and the run slept the hour with no progress sent.
   */
  readonly now?: () => number;
}

/**
 * How often progress goes to the core, whether or not anything was found.
 *
 * **Not only at the end**, and that is the point of having an interval at all. A /16 reported
 * once at the finish would sit at 0% for an hour with nothing to say whether it was working, and
 * a crash at minute fifty-nine would lose every host it had found — because the cursor the core
 * holds would still be zero. Two seconds is chosen so a progress bar moves visibly and a
 * disconnect costs at most two seconds of re-sweeping.
 */
const DEFAULT_PROGRESS_INTERVAL_MS = 2_000;

/** How long the sweep waits before looking at the check queue again. */
const YIELD_MS = 250;

export interface SweepStats {
  readonly running: number;
  readonly swept: number;
  readonly found: number;
  readonly failed: number;
  /** Milliseconds spent standing down for live checks. Visible, never silent. */
  readonly yieldedMs: number;
  readonly cancelled: number;
  readonly completed: number;
}

interface Run {
  readonly job: SweepJob;
  readonly range: IpRange;
  readonly controller: AbortController;
  cursor: number;
  found: SweepHost[];
  failed: number;
}

export class SweepRunner {
  readonly #deps: SweepDeps;
  readonly #logger: Logger;
  readonly #runs = new Map<number, Run>();
  #swept = 0;
  #found = 0;
  #failed = 0;
  #yieldedMs = 0;
  #cancelled = 0;
  #completed = 0;
  #stopped = false;

  constructor(deps: SweepDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'sweep' });
  }

  stats(): SweepStats {
    return {
      running: this.#runs.size,
      swept: this.#swept,
      found: this.#found,
      failed: this.#failed,
      yieldedMs: this.#yieldedMs,
      cancelled: this.#cancelled,
      completed: this.#completed,
    };
  }

  /**
   * Starts or resumes a sweep. Never throws — a bad range is a finished run with a reason.
   *
   * Starting a run that is already running **supersedes** it rather than running two: a core
   * that reconnected and re-sent the job must not double the pings, and the newer message
   * carries the newer cursor.
   */
  start(job: SweepJob): void {
    if (this.#stopped) return;

    const existing = this.#runs.get(job.runId);
    if (existing !== undefined) {
      // Superseded, not cancelled: the distinction matters to whoever reads the run's history,
      // because one is the operator's decision and the other is a reconnect.
      existing.controller.abort(new Error('superseded'));
    }

    let range: IpRange;
    try {
      range = parseIpRange(job.range);
    } catch (error) {
      this.#deps.onFinished(
        job.runId,
        'failed',
        job.cursor,
        error instanceof Error ? error.message : 'the range could not be read',
      );
      return;
    }

    const run: Run = {
      job,
      range,
      controller: new AbortController(),
      cursor: job.cursor,
      found: [],
      failed: 0,
    };
    this.#runs.set(job.runId, run);
    this.#logger.info(
      { runId: job.runId, range: job.range, size: range.size, cursor: job.cursor },
      'sweep started',
    );
    void this.#run(run);
  }

  cancel(runId: number): void {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      // A cancel for a run this probe is not running is not an error: the core may have
      // restarted, or the run may have finished between the operator's click and this message.
      // Answering anyway is what stops the core waiting for a finish that will never come.
      this.#deps.onFinished(runId, 'cancelled', 0, '');
      return;
    }
    run.controller.abort(new Error('cancelled'));
  }

  /** Stops everything, for shutdown. Each run reports as cancelled so the core can resume it. */
  stop(): void {
    this.#stopped = true;
    for (const run of this.#runs.values()) run.controller.abort(new Error('cancelled'));
  }

  async #run(run: Run): Promise<void> {
    const { job, range, controller } = run;
    const sleep = this.#deps.sleep ?? defaultSleep;
    const clock = this.#deps.now ?? ((): number => performance.now());
    const inFlight = new Set<Promise<void>>();
    // A token bucket rather than a delay per address: a fixed delay makes the *floor* the rate,
    // so a network that answers instantly runs at exactly the limit and one that times out runs
    // far below it. The bucket lets a slow patch be made up for by a fast one and still averages
    // what was asked for.
    let allowance = job.ratePerSecond;
    let lastRefill = clock();
    let lastProgress = clock();
    const progressEvery = this.#deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    let ending: SweepEnding = 'done';
    let message = '';
    // Read through a function rather than the property directly. `signal.aborted` is a readonly
    // boolean, so the type system narrows it at the top of the loop and holds that narrowing
    // across every `await` below — which is exactly where it can change. A call cannot be
    // narrowed, so this asks the signal each time, as intended.
    const stopped = (): boolean => controller.signal.aborted;

    // Flushed from the loop rather than from a timer, which bounds how stale progress can be by
    // one address timeout rather than by the interval: when every slot is parked on a
    // three-second timeout the loop is inside `Promise.race` and nothing is reported until one
    // of them returns. Measured live on a /24 of mostly-empty addresses at a 3 s timeout — the
    // first progress arrived at about two seconds, the second about three. A timer would report
    // more punctually and would have to reach into the run's buffers from outside the loop that
    // owns them, which is a race for a few seconds of freshness on a job that takes minutes.
    const flush = (): void => {
      const found = run.found;
      run.found = [];
      const failed = run.failed;
      run.failed = 0;
      this.#deps.onProgress(job.runId, run.cursor, found, failed);
      lastProgress = clock();
    };

    try {
      while (!stopped()) {
        const address = addressAt(range, run.cursor);
        if (address === null) break;

        // **Standing down for live checks.** A queued check is a scan that is already late, and
        // a discovery run that makes it later has traded a one-off convenience for the thing
        // this system exists to do.
        while (this.#deps.queueDepth() > 0 && !stopped()) {
          const waitedFrom = clock();
          await sleep(YIELD_MS, controller.signal);
          this.#yieldedMs += clock() - waitedFrom;
          if (clock() - lastProgress >= progressEvery) flush();
        }
        if (stopped()) break;

        if (job.ratePerSecond > 0) {
          const now = clock();
          allowance = Math.min(
            job.ratePerSecond,
            allowance + ((now - lastRefill) / 1_000) * job.ratePerSecond,
          );
          lastRefill = now;
          if (allowance < 1) {
            await sleep(
              Math.ceil(((1 - allowance) / job.ratePerSecond) * 1_000),
              controller.signal,
            );
            continue;
          }
          allowance -= 1;
        }

        while (inFlight.size >= job.concurrency && !stopped()) {
          await Promise.race(inFlight);
        }
        if (stopped()) break;

        run.cursor += 1;
        const text = toText(address);
        const attempt = this.#one(run, text);
        inFlight.add(attempt);
        void attempt.finally(() => inFlight.delete(attempt));

        if (clock() - lastProgress >= progressEvery) flush();
      }

      // Whatever is still in the air belongs to this run, cancelled or not: an address whose
      // reply arrived after the abort is still a host that is there, and dropping it would be a
      // host missed on the one run that found it.
      await Promise.allSettled([...inFlight]);

      if (stopped()) {
        const reason = controller.signal.reason as unknown;
        ending =
          reason instanceof Error && reason.message === 'superseded' ? 'superseded' : 'cancelled';
      }
    } catch (error) {
      ending = 'failed';
      message = error instanceof Error ? error.message : 'the sweep failed';
      this.#logger.error({ runId: job.runId, err: message }, 'sweep failed');
    }

    // The last findings go before the finish, so the core never records a run as complete while
    // a host it found is still in a buffer.
    if (run.found.length > 0 || run.failed > 0) flush();

    // Superseded means another `start` for this id has taken over, and it owns the map entry —
    // deleting here would remove the newer run.
    if (ending !== 'superseded') this.#runs.delete(job.runId);
    if (ending === 'cancelled') this.#cancelled += 1;
    if (ending === 'done') this.#completed += 1;

    this.#logger.info(
      { runId: job.runId, ending, cursor: run.cursor, ...this.stats() },
      'sweep finished',
    );
    this.#deps.onFinished(job.runId, ending, run.cursor, message);
  }

  async #one(run: Run, address: string): Promise<void> {
    try {
      const rtt = await this.#deps.probe(address, run.job.timeoutMs, run.controller.signal);
      this.#swept += 1;
      if (rtt !== null) {
        run.found.push({ address, rttMs: rtt });
        this.#found += 1;
      }
    } catch (error) {
      // An address that could not be *attempted* — no route, no permission to ping — is
      // different from one that did not answer, and counting them together would report a
      // firewalled network as an empty one.
      if (!run.controller.signal.aborted) {
        run.failed += 1;
        this.#failed += 1;
        this.#logger.debug(
          { address, err: error instanceof Error ? error.message : 'unknown' },
          'an address could not be swept',
        );
      }
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
