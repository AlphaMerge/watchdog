import type { CheckResult, Logger, ProbeQuery, QueryFailure } from '@ms/shared';
import { CheckPool, type SubmitOutcome } from '../runner/pool.js';
import { ProcessRunner, type ProcessRunnerOptions } from '../runner/process-runner.js';
import type { CheckRequest, ResultMeta } from '../runner/types.js';

/**
 * Runs what the core asked for *now*, and answers on the id it asked with (`R-09`).
 *
 * **Its own pool, one worker wide, and that is the design rather than an accident.** A scheduled
 * scan is work the system owes and can be late; an on-demand check is a person watching a
 * spinner. Putting the two in one pool costs both of them: the query queues behind however many
 * scans were due on the same tick, and the scans lose a worker to something nobody is measuring.
 * A separate pool of one also bounds the damage — a query cannot displace monitoring, however
 * many arrive.
 *
 * **The core's bound is the real one.** `ProbeQueryService` refuses past a small number in
 * flight, so this queue exists to absorb the handful that get through together and not to be a
 * backlog. Anything it cannot take is answered `busy` immediately, because a refusal an operator
 * can retry beats a spinner that was never going to finish.
 *
 * **Every path answers.** A query that produced no message would leave the core waiting out a
 * deadline, which looks exactly like a device that will not reply — the one diagnosis this whole
 * mechanism exists to hand back accurately.
 *
 * **A type that runs in a process of its own runs in one here too** (`P-242`). "Check now" is
 * meant to be the check a scheduled scan would run, and for `exe.script` a worker is not that: the
 * script directory reaches only a child's environment, so a worker answered a false "no script
 * directory configured", and with one configured it would have run the script as this probe's own
 * user, outside the child memory limit. So those types go to a process runner of their own,
 * one at a time behind the same bounded queue, and a full queue is `busy` like the pool's.
 */

export interface QueryRunnerOptions {
  logger: Logger;
  /** How the answer gets back to the core. */
  answer: (message: {
    queryId: string;
    result?: CheckResult;
    failure?: QueryFailure;
    message?: string;
  }) => void;
  /** Pool size. One unless a deployment has a reason; see the note above. */
  size?: number;
  queueMaxLength?: number;
  /** The registry the pool loads. The tests point it at fixtures; production takes the default. */
  registryModule?: string;
  /**
   * How long a check has to honour its abort before its worker is terminated: the operator's
   * `checkAbortGraceMs`, as the scheduled pool takes it (`P-242`). The pool's default otherwise.
   */
  abortGraceMs?: number;
  /**
   * The types that run in a process of their own, and how (`P-242`).
   *
   * `runner` is the scheduled process runner's own isolation — memory limit, user, group and
   * child environment — so a check on demand is bounded as a scheduled one is. Its concurrency is
   * not taken: the query runner runs one at a time, behind `queueMaxLength`. Absent, no type is
   * isolated and everything runs in the pool, which is what a test with fixtures wants.
   */
  isolation?: {
    readonly types: ReadonlySet<string>;
    readonly runner: Omit<
      ProcessRunnerOptions,
      'logger' | 'onResult' | 'maxConcurrent' | 'queueMaxLength'
    >;
  };
}

export class QueryRunner {
  readonly #logger: Logger;
  readonly #answer: QueryRunnerOptions['answer'];
  readonly #pool: CheckPool;
  readonly #isolated: ReadonlySet<string>;
  readonly #processes: ProcessRunner | undefined;
  /**
   * Which query each running check belongs to, keyed by sensor.
   *
   * Sound because the pool refuses a second check for a sensor already running — so at most one
   * query per sensor is ever in flight here, and the second is answered `busy` rather than
   * silently overwriting the first one's id.
   */
  readonly #waiting = new Map<number, string>();

  constructor(options: QueryRunnerOptions) {
    this.#logger = options.logger.child({ component: 'query-runner' });
    this.#answer = options.answer;
    this.#pool = new CheckPool({
      logger: this.#logger,
      size: options.size ?? 1,
      queueMaxLength: options.queueMaxLength ?? 8,
      ...(options.registryModule === undefined ? {} : { registryModule: options.registryModule }),
      ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
      onResult: (result, meta) => {
        this.#deliver(result, meta);
      },
    });
    this.#isolated = options.isolation?.types ?? new Set();
    this.#processes =
      options.isolation === undefined
        ? undefined
        : new ProcessRunner({
            ...options.isolation.runner,
            logger: this.#logger,
            maxConcurrent: 1,
            queueMaxLength: options.queueMaxLength ?? 8,
            onResult: (result, meta) => {
              this.#deliver(result, meta);
            },
          });
  }

  async start(): Promise<void> {
    await this.#pool.start();
  }

  /**
   * Stops, having answered everyone.
   *
   * No sweep of what is left over, because there is never any: `CheckPool.stop` settles every
   * queued and in-flight job with `pool-stopped` before it returns, and `#deliver` turns each of
   * those into an answer. A loop here would be a second mechanism for the same case, unreachable
   * and therefore untested — and untested code that only runs during shutdown is exactly the
   * code that is wrong when it finally does.
   */
  async stop(): Promise<void> {
    // No drain for either, as the pool's default has it: somebody is waiting on each, and "the
    // probe stopped" now is an answer where a script's full timeout inside a ten-second shutdown
    // hook is not. The process runner, unlike the pool, would wait for everything without it.
    await Promise.all([this.#pool.stop(), this.#processes?.stop({ drainMs: 0 })]);
    this.#waiting.clear();
  }

  /** Takes one query, or answers immediately why it will not. */
  run(queryId: string, query: ProbeQuery, timeoutMs: number): void {
    const assignment = query.assignment;
    const outcome = this.#submit({
      sensorId: assignment.sensorId,
      sensorType: assignment.sensorType,
      target: assignment.target,
      params: assignment.params,
      ...(assignment.credentials === undefined ? {} : { credentials: assignment.credentials }),
      // The core's deadline, not only the sensor's: whoever is waiting has already decided how
      // long they will wait, and a check that outlived that would be work nobody can receive.
      timeoutMs: Math.min(timeoutMs, assignment.timeoutMs),
    });

    if (outcome === 'accepted') {
      this.#waiting.set(assignment.sensorId, queryId);
      return;
    }
    this.#logger.warn({ queryId, outcome }, 'refused an on-demand check');
    this.#answer({ queryId, failure: 'busy', message: REFUSALS[outcome] });
  }

  /** To the process runner if the type runs in a process of its own, and to the pool if not. */
  #submit(request: CheckRequest): SubmitOutcome {
    if (this.#processes !== undefined && this.#isolated.has(request.sensorType)) {
      return this.#processes.submit(request);
    }
    return this.#pool.submit(request);
  }

  /**
   * Stops caring about a query.
   *
   * The check itself is left to finish — the pool aborts on its own timeout, and interrupting it
   * would buy nothing but a terminated worker. **Forgetting it is the whole mechanism**: an
   * answer is delivered by looking the check's sensor up in `#waiting`, so removing the entry is
   * exactly what makes the result arrive with nowhere to go. A second "cancelled" set beside it
   * would be a branch no mutation can reach, which is a branch that is not doing anything.
   */
  cancel(queryId: string): void {
    for (const [sensorId, id] of this.#waiting) {
      if (id !== queryId) continue;
      this.#waiting.delete(sensorId);
      return;
    }
  }

  #deliver(result: CheckResult, meta: ResultMeta): void {
    const queryId = this.#waiting.get(result.sensorId);
    if (queryId === undefined) return;
    this.#waiting.delete(result.sensorId);

    // **Two phases are not check failures, and reporting them as one is a wrong diagnosis.**
    // The pool settles an abandoned job with an `error` result like any other, which is right
    // for the spool — a scan that did not happen is a scan that did not happen — and wrong here.
    // An operator who pressed "check now" and read "probe is stopping" under the device's name
    // would reasonably conclude the device is at fault. An unknown type is the same shape: it is
    // a probe that cannot run this sensor at all, not a target that answered badly.
    const named = NOT_A_CHECK_FAILURE[meta.phase];
    if (named !== undefined) {
      this.#answer({ queryId, failure: named.failure, message: named.message(result) });
      return;
    }

    // **A failing check is a successful query**, and the distinction is the whole point of
    // asking: "the check ran and the device refused the credential" is an answer, where
    // `failure: 'failed'` would be this mechanism claiming a fault of its own.
    this.#answer({ queryId, result });
  }
}

/** Phases where the probe, not the target, is the reason there is no reading. */
const NOT_A_CHECK_FAILURE: Readonly<
  Partial<Record<string, { failure: QueryFailure; message: (result: CheckResult) => string }>>
> = {
  'pool-stopped': {
    failure: 'offline',
    message: () => 'the probe stopped before the check finished',
  },
  // **The registry's own words, not a fixed guess** (`H-13`). They name the type and, when this
  // build left it out on purpose, say why: "the v1 profile leaves it out, because flow monitoring
  // is v2". A fixed line saying the probe is probably older than the core sent an operator to
  // upgrade a probe that was already the newest build there is.
  'unknown-type': {
    failure: 'unsupported',
    message: (result) => result.message,
  },
};

const REFUSALS: Readonly<
  Record<'already-running' | 'queue-full' | 'stopped' | 'disabled', string>
> = {
  'already-running': 'this sensor is already being checked on demand',
  'queue-full': 'too many on-demand checks are already running on this probe',
  stopped: 'this probe is not running checks',
  // Distinct from `stopped`, and the difference is what the requester needs: this probe is up and
  // will keep answering, and it cannot run a check until somebody restarts it (`P-62`).
  disabled: 'this probe’s worker pool has failed and it cannot run checks until it is restarted',
};
