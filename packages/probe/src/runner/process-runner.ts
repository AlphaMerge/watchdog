import { join } from 'node:path';
import { runProgram, type CheckResult, type Logger } from '@ms/shared';
// From `types.js`, never from `check-child.js`: that module is an entry point with top-level
// `await` on stdin, and importing it here once made the probe sit waiting for its own stdin.
import { READY_MARKER, RESULT_MARKER } from './types.js';
import { linuxProcessView, ScriptGroups, type ProcessView } from './script-groups.js';
import { RefusalLog } from './refusal-log.js';
import type { CheckPhase, CheckRequest, ResultMeta, SubmitOutcome } from './index.js';

/**
 * Checks that run in a child process rather than a pool worker (`P-03`).
 *
 * **Why a process and not a worker, given the pool already terminates a check that will not
 * stop.** Three things a worker thread cannot survive or offer:
 *
 * - A **hard crash**. A worker's own heap limit and `terminate()` cover hanging and leaking, but
 *   a segmentation fault in a native module, or an `abort()` from something a user's script
 *   loaded, takes the entire probe down — every sensor on it, not one.
 * - A **different OS user**. Running somebody's script as the account that holds this probe's
 *   certificate and credential material is a decision nobody would make on purpose.
 * - A **memory bound the OS enforces**, rather than one V8 applies to a heap shared with the
 *   scheduler.
 *
 * **One process per check, not a pool of them**, which is the opposite of `CheckPool`'s trade and
 * for the opposite reason. A pool exists to amortise start-up across checks; here, *not*
 * amortising is the feature — nothing survives from one check to the next, so a leak, a stuck
 * handle or a corrupted global cannot accumulate. Measured: **about 21 ms** of start-up per
 * check, and the whole shipped catalogue costs 1.3 ms more than a one-file registry, because a
 * sensor type's heavy imports live inside `execute`
 * (`docs/findings/2026-08-27-process-runner-startup.md`). That is why this is opt-in per sensor
 * *type* rather than a probe-wide setting: 21 ms is noise beside a script that runs `df`, and
 * three to twenty times the cost of an ICMP check to a device on the same LAN.
 *
 * **The concurrency cap is much lower than the worker pool's**, and deliberately: 48 workers
 * awaiting packets cost slots and no CPU, where 48 Node processes cost 48 × ~40 MB of resident
 * memory and 48 start-ups at once. Checks that are queued here are queued behind a handful.
 *
 * **What is bounded, and what is not.** Bounded: wall-clock time (a start-up bound and then the
 * check's own timeout, `P-260`; `SIGTERM` then `SIGKILL`,
 * against the whole process group so a script that backgrounds something does not outlive its own
 * kill, and then against any script group the check process had started and not ended, `P-266`),
 * heap size, captured output, and the environment the child is given — built, never
 * inherited, so an `MS_*` override holding a database URL does not reach a user's script. Not
 * bounded, because Node exposes no `setrlimit` and reaching one would mean a shell or a native
 * dependency: CPU seconds, address space, file descriptors and child process count. `A-09`'s
 * hardening pass is where a platform-specific answer belongs; what is here works identically
 * everywhere.
 */

/** Latencies kept for the percentiles Probe Health reports (`P-04`). */
const LATENCY_WINDOW = 256;

export interface ProcessRunnerStats {
  maxConcurrent: number;
  running: number;
  queued: number;
  submitted: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** Checks skipped because the previous scan of that sensor had not finished. */
  deferred: number;
  /** Checks refused because the queue was full. */
  refused: number;
  /** Children that produced no parseable result — a crash, or a `SIGKILL` before they answered. */
  crashed: number;
  /**
   * Checks that never ran because their process did not get as far as running them (`P-260`):
   * it was still loading the probe's sensor types at the start-up bound and was ended, the load
   * failed, or the process exited or was killed before it said it was ready. Counted in `failed`
   * as well, and in neither `timedOut` nor `crashed`.
   */
  startupFailed: number;
  /**
   * Process groups a check process started and left running when it went, which the runner then
   * ended (`P-266`): a script whose check process was killed outright, ran out of heap or crashed,
   * and so never ended it. Each is logged with its sensor. Not on the heartbeat yet: a new field
   * there needs a protocol version.
   */
  scriptGroupsEnded: number;
  /**
   * Groups a check process named that `/proc` did not show to be its own (`P-266`): a forged
   * line, or a check process killed so soon after its spawn that its script was orphaned before
   * the line was read. Never killed. Logged with the sensor.
   */
  scriptGroupsRefused: number;
  /**
   * Groups left open whose leader's pid named another process by the time the check process had
   * gone (`P-266`). Never killed. Logged with the sensor.
   */
  scriptGroupsRecycled: number;
  waitMs: Percentiles;
  runMs: Percentiles;
  /**
   * From spawning a check's process to its saying it is ready to run the check (`P-260`),
   * including the ones ended at the start-up bound. Null until a process has got that far or
   * been given up, because no start-up measured is not a start-up that took no time.
   */
  startupMs: Percentiles | null;
}

interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ProcessRunnerOptions {
  logger: Logger;
  /** Node processes that may run at once. Far smaller than the worker pool's, and it must be. */
  maxConcurrent?: number;
  queueMaxLength?: number;
  /** How often a refusal episode is summarised in the log (`P-216` part 3). Injectable for tests. */
  refusalSummaryMs?: number;
  /** Heap ceiling handed to the child as `--max-old-space-size`. */
  memoryLimitMb?: number;
  /** POSIX only, and only when this process has the privilege. Both or neither. */
  uid?: number;
  gid?: number;
  /** Module whose default export is a `CheckRegistry`, imported by the child. */
  registryModule?: string;
  /** Overridable so tests can drive a child that misbehaves on purpose. */
  childModule?: string;
  /**
   * How the runner verifies and ends the script groups a check process leaves (`P-266`).
   * `/proc` on Linux; null — nothing verified, nothing ended — anywhere else. Injectable for tests.
   */
  processView?: ProcessView | null;
  /**
   * How long a check's process may take to load the probe's sensor types before it is ended and
   * the check reported as never started (`P-260`). `STARTUP_TIMEOUT_MS` unless a test sets it.
   */
  startupTimeoutMs?: number;
  /** How much of a child's own stdout/stderr is kept for a diagnosis. */
  maxOutputBytes?: number;
  /**
   * Extra environment for the child, on top of the built minimum.
   *
   * How a probe-level *policy* setting reaches a check that runs in a process of its own —
   * `T-19`'s script directory is the first, and it must come from here rather than from a
   * sensor's parameters or the boundary it enforces would be decorative. Not a general
   * pass-through: whatever is put here reaches code somebody else wrote.
   */
  childEnv?: Readonly<Record<string, string>>;
  onResult: (result: CheckResult, meta: ResultMeta) => void;
}

interface Job {
  request: CheckRequest;
  queuedAt: bigint;
  /** Answered already, by `stop` abandoning it, so the run's own result is not reported too. */
  settled: boolean;
  /** Ends the check's process when `stop` abandons it. */
  abort: AbortController;
}

interface ChildAnswer {
  ok: boolean;
  durationMs: number;
  channels?: { key: string; value: number }[];
  message?: string;
  aborted?: boolean;
  unknownType?: boolean;
  withheld?: boolean;
  /** The child could not load the probe's sensor types, so no check ran (`P-260`). */
  startup?: boolean;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_QUEUE_MAX = 256;
const DEFAULT_MEMORY_MB = 256;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

/**
 * How long past the check's own deadline the process is given before it is killed.
 *
 * The child gets an `AbortSignal` at `timeoutMs` so a well-behaved check reports its own
 * diagnosis; this is the margin in which it may do so. Past it the process group goes, which is
 * a result with nothing to say about where the check got to.
 */
export const KILL_MARGIN_MS = 2_000;

/**
 * How long a check's process is given to start: from its spawn to its saying it has loaded the
 * probe's sensor types and is about to run the check (`P-260`).
 *
 * **The check's own timeout starts after this, on both sides.** The child arms its abort once it
 * is ready, and the runner replaces this bound with the timeout plus `KILL_MARGIN_MS` when it reads
 * the ready line. So a slow start costs the check nothing, and the most a runner can spend on one
 * child is this, plus the timeout, plus the margin, plus `runProgram`'s grace between `SIGTERM`
 * and `SIGKILL`.
 *
 * **Thirty seconds, from `P-258`'s measurements.** A start takes about 21 ms on a quiet machine
 * (`docs/findings/2026-08-27-process-runner-startup.md`). Beside two probe suites, at load 6.5–29
 * on a VM whose host was itself at 20 on 8 CPUs, importing the catalogue took 0.45–14.8 s. That is
 * far past anything a probe in service should see, so twice it is a bound that a starved probe
 * still runs its scripts under, while a child that hangs while loading holds one of a handful of
 * slots for half a minute rather than for ever. A start that passes it is the machine's to
 * explain, and Probe Health's `childStartup` and `childStartupFailed` are where it shows.
 */
export const STARTUP_TIMEOUT_MS = 30_000;

export class ProcessRunner {
  readonly #logger: Logger;
  readonly #maxConcurrent: number;
  readonly #queueMax: number;
  readonly #memoryLimitMb: number;
  readonly #maxOutputBytes: number;
  readonly #uid: number | undefined;
  readonly #gid: number | undefined;
  readonly #childEnv: Readonly<Record<string, string>>;
  readonly #registryModule: string;
  readonly #childModule: string;
  readonly #startupTimeoutMs: number;
  readonly #processView: ProcessView | null;
  readonly #onResult: (result: CheckResult, meta: ResultMeta) => void;

  readonly #queue: Job[] = [];
  readonly #active = new Set<number>();
  /** The jobs `#running` counts, so `stop` can answer the ones it stops waiting for. */
  readonly #inProgress = new Set<Job>();
  #running = 0;
  #stopped = false;

  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #timedOut = 0;
  #deferred = 0;
  #refused = 0;
  /** Refusals logged once per episode, with a count every thirty seconds (`P-216` part 3). */
  readonly #refusals: RefusalLog;
  #crashed = 0;
  #startupFailed = 0;
  #scriptGroupsEnded = 0;
  #scriptGroupsRefused = 0;
  #scriptGroupsRecycled = 0;
  readonly #waits: number[] = [];
  readonly #runs: number[] = [];
  readonly #startups: number[] = [];

  constructor(options: ProcessRunnerOptions) {
    this.#logger = options.logger;
    this.#maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.#queueMax = Math.max(1, options.queueMaxLength ?? DEFAULT_QUEUE_MAX);
    this.#memoryLimitMb = Math.max(64, options.memoryLimitMb ?? DEFAULT_MEMORY_MB);
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.#uid = options.uid;
    this.#gid = options.gid;
    this.#childEnv = options.childEnv ?? {};
    this.#registryModule =
      options.registryModule ?? join(import.meta.dirname, 'catalogue-registry.js');
    this.#childModule = options.childModule ?? join(import.meta.dirname, 'check-child.js');
    this.#startupTimeoutMs = Math.max(1, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    this.#processView =
      options.processView === undefined ? linuxProcessView() : options.processView;
    this.#onResult = options.onResult;
    this.#refusals = new RefusalLog(
      this.#logger,
      'process-runner queue is full, refusing a check',
      {
        ...(options.refusalSummaryMs === undefined ? {} : { summaryMs: options.refusalSummaryMs }),
      },
    );
  }

  /** Fire and forget, exactly like `CheckPool.submit`: the wheel must never wait for a check. */
  /**
   * Whether a check offered right now would be taken — `submit`'s rule without `submit`'s counters
   * (`P-57`).
   *
   * **It exists so a listener sensor's messages are not drained into a check that is then
   * refused.** `NotificationRing.drain` advances the cursor unconditionally and hands the batch
   * back, so a caller that drains first and submits second loses everything it drained whenever
   * the answer is `already-running` — which is the ordinary case, not an exotic one: skipping
   * while the previous scan is still going is the rule (`WORKFLOW.MD §3`), and a syslog sensor
   * under a flood is exactly the sensor whose previous scan is still going.
   *
   * Safe to ask separately only because the wheel's `onDue` is synchronous and single-threaded:
   * nothing can change between the question and the `submit` that follows it. It shares
   * `#admission` with `submit` rather than restating the rule, so the two cannot drift.
   */
  accepts(sensorId: number): boolean {
    return this.#admission(sensorId) === 'accepted';
  }

  /** The decision alone. Counting is `submit`'s, so asking twice never moves a counter. */
  #admission(sensorId: number): SubmitOutcome {
    if (this.#stopped) return 'stopped';
    // WORKFLOW.MD §3, the same rule the pool follows: a sensor never stacks.
    if (this.#active.has(sensorId)) return 'already-running';
    if (this.#queue.length >= this.#queueMax) return 'queue-full';
    return 'accepted';
  }

  submit(request: CheckRequest): SubmitOutcome {
    const verdict = this.#admission(request.sensorId);
    if (verdict === 'stopped') return 'stopped';
    this.#submitted += 1;

    if (verdict === 'already-running') {
      this.#deferred += 1;
      return 'already-running';
    }
    if (verdict === 'queue-full') {
      this.#refused += 1;
      this.#refusals.refused({
        sensorId: request.sensorId,
        sensorType: request.sensorType,
        queued: this.#queue.length,
        queueMax: this.#queueMax,
      });
      return 'queue-full';
    }

    this.#active.add(request.sensorId);
    this.#queue.push({
      request,
      queuedAt: process.hrtime.bigint(),
      settled: false,
      abort: new AbortController(),
    });
    this.#pump();
    return 'accepted';
  }

  #pump(): void {
    while (this.#running < this.#maxConcurrent && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      this.#running += 1;
      this.#inProgress.add(job);
      void this.#run(job).finally(() => {
        this.#running -= 1;
        this.#inProgress.delete(job);
        this.#active.delete(job.request.sensorId);
        this.#pump();
      });
    }
  }

  async #run(job: Job): Promise<void> {
    const waitMs = msSince(job.queuedAt);
    record(this.#waits, waitMs);

    const payload = JSON.stringify({
      sensorType: job.request.sensorType,
      sensorId: job.request.sensorId,
      target: job.request.target,
      params: job.request.params,
      ...(job.request.credentials === undefined ? {} : { credentials: job.request.credentials }),
      ...(job.request.received === undefined ? {} : { received: job.request.received }),
      registryModule: this.#registryModule,
      timeoutMs: job.request.timeoutMs,
    });

    // **Two clocks, one after the other** (`P-260`). From the spawn, the start-up bound; from the
    // child's ready line, the check's timeout plus the margin its own abort is given. Before this
    // one deadline ran from the spawn, so a slow start ate into the check and a child that never
    // began it was killed and reported as a check that ran too long.
    const spawnedAt = process.hrtime.bigint();
    const deadline = new AbortController();
    const ready = new ReadyLine();
    let readyAt: bigint | undefined;
    let gaveUpAfterMs: number | undefined;
    const giveUp = (): void => {
      const sinceSpawn = msSince(spawnedAt);
      const left = leftOf(this.#startupTimeoutMs, sinceSpawn);
      if (left !== null) {
        clock = setTimeout(giveUp, left);
        return;
      }
      gaveUpAfterMs = sinceSpawn;
      deadline.abort();
    };
    let clock = setTimeout(giveUp, this.#startupTimeoutMs);
    // Made at the spawn, when the check process's pid is known: it is what a script's parent must
    // be. From the runner's own spawn, never from anything the check process says.
    let groups: ScriptGroups | undefined;
    const onSpawn = (pid: number): void => {
      if (this.#processView !== null) groups = new ScriptGroups(this.#processView, pid, this.#uid);
    };
    const onStdout = (chunk: Buffer): void => {
      // latin1 maps each byte to one character, so a marker split across two chunks, or a
      // multi-byte character a library printed before it, cannot hide it.
      const text = chunk.toString('latin1');
      groups?.push(text);
      if (readyAt !== undefined || gaveUpAfterMs !== undefined) return;
      if (!ready.push(text)) return;
      readyAt = process.hrtime.bigint();
      record(this.#startups, Number(readyAt - spawnedAt) / 1e6);
      clearTimeout(clock);
      clock = setTimeout(() => {
        deadline.abort();
      }, job.request.timeoutMs + KILL_MARGIN_MS);
    };

    const run = await runProgram({
      file: process.execPath,
      args: [`--max-old-space-size=${String(this.#memoryLimitMb)}`, this.#childModule],
      cwd: import.meta.dirname,
      // Built, never inherited. A probe's environment holds whatever arrived through `MS_*`
      // overrides, and handing that to a process running somebody's script is how a credential
      // leaves the machine. `PATH` is what a shell-out needs to find a program at all.
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: process.env['NODE_ENV'] ?? 'production',
        ...(process.platform === 'win32'
          ? {
              SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
              TEMP: process.env['TEMP'] ?? 'C:\\Windows\\Temp',
            }
          : {}),
        ...this.#childEnv,
      },
      // The backstop, never the mechanism: the two clocks above end the child first. It is the
      // most a child can be given, which keeps a runner's slot bounded whatever happens to them.
      timeoutMs: this.#startupTimeoutMs + job.request.timeoutMs + KILL_MARGIN_MS,
      signal: AbortSignal.any([job.abort.signal, deadline.signal]),
      onStdout,
      onSpawn,
      maxOutputBytes: this.#maxOutputBytes,
      stdin: payload,
      ...(this.#uid === undefined ? {} : { uid: this.#uid }),
      ...(this.#gid === undefined ? {} : { gid: this.#gid }),
    });
    clearTimeout(clock);
    if (gaveUpAfterMs !== undefined) record(this.#startups, gaveUpAfterMs);
    // Before anything else, a check abandoned by `stop` included: the check process has gone, and
    // whatever it started and did not end has nobody else to end it.
    if (groups !== undefined) this.#endLeftBehind(job, groups);

    // Abandoned by `stop` while it ran, and answered there.
    if (job.settled) return;
    const answer = parseAnswer(run.stdout);

    if (answer?.startup === true) {
      // The catalogue would not load. Every check in a process fails the same way until the
      // probe is mended, and none of them is the check's doing.
      this.#startupFailed += 1;
      this.#failed += 1;
      this.#emit(job, waitMs, 'startup', {
        outcome: 'error',
        message: answer.message ?? 'this probe could not load its sensor types to run the check',
        durationMs: answer.durationMs,
      });
      return;
    }

    if (answer !== null) {
      record(this.#runs, answer.durationMs);
      if (answer.ok) {
        this.#completed += 1;
        this.#emit(job, waitMs, 'execute', {
          outcome: 'ok',
          message: answer.message ?? '',
          durationMs: answer.durationMs,
          channels: answer.channels ?? [],
        });
        return;
      }
      this.#failed += 1;
      if (answer.aborted === true) this.#timedOut += 1;
      const phase: CheckPhase =
        answer.unknownType === true
          ? 'unknown-type'
          : answer.aborted === true
            ? 'aborted'
            : 'execute';
      this.#emit(job, waitMs, phase, {
        outcome: 'error',
        message: answer.message ?? 'the check failed and said nothing',
        durationMs: answer.durationMs,
        // Refused over where its credentials may go (`A-41c`), which is not a failed scan.
        ...(answer.withheld === true ? { withheld: true as const } : {}),
      });
      return;
    }

    // Nothing parseable came back. Which of the three reasons decides the phase, and they are not
    // interchangeable: a crash is a fault of the check, a timeout is ours, and a spawn failure
    // means the probe is misinstalled and no amount of retrying will help.
    if (run.outcome === 'timeout' && gaveUpAfterMs !== undefined) {
      // Ended while it was still loading: the check never ran, so it neither timed out nor
      // crashed, and its message says whose time it was.
      this.#startupFailed += 1;
      this.#failed += 1;
      this.#emit(job, waitMs, 'startup', {
        outcome: 'error',
        durationMs: run.durationMs,
        message:
          `the probe took ${String(Math.round(gaveUpAfterMs))} ms to start the check and gave ` +
          `up: its process had not loaded the probe's sensor types within the ` +
          `${String(this.#startupTimeoutMs)} ms it is allowed, so the check never ran` +
          tail(run.stderr),
      });
      return;
    }
    record(this.#runs, run.durationMs);
    if (run.outcome === 'timeout') {
      this.#timedOut += 1;
      this.#failed += 1;
      this.#emit(job, waitMs, 'timeout', {
        outcome: 'error',
        durationMs: run.durationMs,
        message:
          `the check did not finish within ${String(job.request.timeoutMs)} ms and its process ` +
          `was ${run.hardKilled ? 'killed' : 'stopped'}` +
          tail(run.stderr),
      });
      return;
    }
    if (run.outcome === 'failed') {
      this.#failed += 1;
      this.#emit(job, waitMs, 'worker-crash', {
        outcome: 'error',
        durationMs: run.durationMs,
        message: `this probe could not start a check process: ${run.message} (${run.code})`,
      });
      return;
    }

    const ended =
      run.outcome === 'signalled'
        ? `it was killed by ${run.signal}`
        : `it exited with code ${String(run.code)}`;
    if (readyAt === undefined) {
      // Ended before its ready line: the check never ran, so whatever ended it, it was the
      // probe's start-up and not the check (`P-260`). A crash after the line is the check's.
      this.#startupFailed += 1;
      this.#failed += 1;
      this.#logger.error(
        {
          sensorId: job.request.sensorId,
          sensorType: job.request.sensorType,
          outcome: run.outcome,
          ...(run.outcome === 'exited' ? { code: run.code } : { signal: run.signal }),
        },
        'a check process ended while loading its sensor types',
      );
      this.#emit(job, waitMs, 'startup', {
        outcome: 'error',
        durationMs: run.durationMs,
        message:
          "the check process ended while it was loading the probe's sensor types, so the " +
          `check never ran — ${ended}` +
          tail(run.stderr),
      });
      return;
    }

    this.#crashed += 1;
    this.#failed += 1;
    this.#logger.error(
      {
        sensorId: job.request.sensorId,
        sensorType: job.request.sensorType,
        outcome: run.outcome,
        ...(run.outcome === 'exited' ? { code: run.code } : {}),
        ...(run.outcome === 'signalled' ? { signal: run.signal } : {}),
      },
      'a check process ended without producing a result',
    );
    this.#emit(job, waitMs, 'worker-crash', {
      outcome: 'error',
      durationMs: run.durationMs,
      message:
        'the check process ended without answering' +
        ` — ${ended}` +
        (run.outcome === 'signalled' ? ', which is what a native crash looks like' : '') +
        tail(run.stderr),
    });
  }

  /**
   * Ends the script groups a check process had started and not seen end, once it has gone
   * (`P-266`), verified against `/proc` as `ScriptGroups` says, and logs what it refused.
   *
   * **`SIGKILL`, at once.** The check process that would have read the script's output and given
   * it its grace is gone, and the pipes the script writes to went with it; a `SIGTERM` would buy a
   * script nothing but a write that fails.
   */
  #endLeftBehind(job: Job, groups: ScriptGroups): void {
    const about = { sensorId: job.request.sensorId, sensorType: job.request.sensorType };
    if (groups.refused.length > 0) {
      this.#scriptGroupsRefused += groups.refused.length;
      this.#logger.warn(
        { ...about, count: groups.refused.length, pgids: groups.refused.slice(0, 8) },
        'a check process named process groups that are not its own; this probe left them alone',
      );
    }
    const { ended, recycled, failed } = groups.endLeftBehind();
    if (recycled.length > 0) {
      this.#scriptGroupsRecycled += recycled.length;
      this.#logger.warn(
        { ...about, pgids: recycled },
        'a check process left a group whose leader’s pid now names another process; this probe left it alone',
      );
    }
    for (const { pgid, code } of failed) {
      this.#logger.error(
        { ...about, pgid, code },
        'a check process left a process group running that this probe could not end',
      );
    }
    if (ended.length === 0) return;
    this.#scriptGroupsEnded += ended.length;
    this.#logger.warn(
      { ...about, pgids: ended },
      'a check process ended and left what it started running; this probe ended it',
    );
  }

  /**
   * The one place a result is built.
   *
   * `parts` is a discriminated union rather than an outcome beside an optional channel list, so
   * **only a successful check can supply channel values at all**. A Down sensor records none —
   * the gap is the data (CLAUDE.md) — and expressing that in the type means a new call site
   * cannot forget it, where a runtime guard would only be as good as the tests that covered it.
   */
  #emit(
    job: Job,
    waitMs: number,
    phase: CheckPhase,
    parts:
      | {
          outcome: 'ok';
          message: string;
          durationMs: number;
          channels: { key: string; value: number; name?: string; unit?: string }[];
        }
      | { outcome: 'error'; message: string; durationMs: number; withheld?: true },
  ): void {
    if (job.settled) return;
    job.settled = true;
    const result: CheckResult = {
      sensorId: job.request.sensorId,
      at: new Date().toISOString(),
      outcome: parts.outcome,
      message: parts.message,
      durationMs: Number(parts.durationMs.toFixed(3)),
      channels: parts.outcome === 'ok' ? parts.channels : [],
      ...(parts.outcome === 'error' && parts.withheld === true ? { withheld: true as const } : {}),
    };
    // `workerId` is -1 rather than absent: Probe Health reads one shape for both runners, and a
    // check that ran in a process of its own genuinely has no worker.
    this.#onResult(result, { phase, waitMs, workerId: -1 });
  }

  stats(): ProcessRunnerStats {
    return {
      maxConcurrent: this.#maxConcurrent,
      running: this.#running,
      queued: this.#queue.length,
      submitted: this.#submitted,
      completed: this.#completed,
      failed: this.#failed,
      timedOut: this.#timedOut,
      deferred: this.#deferred,
      refused: this.#refused,
      crashed: this.#crashed,
      startupFailed: this.#startupFailed,
      scriptGroupsEnded: this.#scriptGroupsEnded,
      scriptGroupsRefused: this.#scriptGroupsRefused,
      scriptGroupsRecycled: this.#scriptGroupsRecycled,
      waitMs: percentiles(this.#waits),
      runMs: percentiles(this.#runs),
      startupMs: this.#startups.length === 0 ? null : percentiles(this.#startups),
    };
  }

  /**
   * Stops accepting work and waits for what is running, for up to `drainMs` when given.
   *
   * A check that finishes inside the window reports what it found, as on any other day. One still
   * running when the window closes is answered as `pool-stopped`, which the result sink counts as
   * abandoned, and its process is ended. It is not reported as a crash, because it did not crash.
   *
   * **Bounded, because the service budget is shared** (`P-227`). This used to wait for the
   * slowest check's own timeout, 30 s by default and up to fifteen minutes, inside a 30 s hook
   * and a 20 s service budget. A stop that arrived while a script hung ran the budget out here.
   * The check pool's drain and the result spool's close, which `P-205` placed last on purpose,
   * then never ran, and the probe exited 1 on an ordinary `systemctl stop` and left the unit
   * `failed`. Without `drainMs` it still waits for everything, which only a test should ask for.
   */
  async stop(options: { drainMs?: number } = {}): Promise<void> {
    this.#stopped = true;
    this.#refusals.stop();
    // Answered rather than emptied. Truncating the array left every queued check accepted and
    // never settled — counted in nothing, and its sensor stuck in `#active` — which is the drop
    // without a count `CLAUDE.md` rules out. They never started, so `pool-stopped` is the truth.
    for (const job of this.#queue.splice(0)) {
      this.#failed += 1;
      this.#active.delete(job.request.sensorId);
      this.#emit(job, msSince(job.queuedAt), 'pool-stopped', {
        outcome: 'error',
        durationMs: 0,
        message: 'probe is stopping',
      });
    }
    const deadline =
      options.drainMs === undefined ? Infinity : performance.now() + Math.max(0, options.drainMs);
    while (this.#running > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const abandoned = [...this.#inProgress].filter((job) => !job.settled);
    for (const job of abandoned) {
      this.#failed += 1;
      this.#emit(job, msSince(job.queuedAt), 'pool-stopped', {
        outcome: 'error',
        durationMs: 0,
        message: 'probe is stopping',
      });
      job.abort.abort();
    }
    if (options.drainMs !== undefined) {
      this.#logger.info(
        { drainMs: options.drainMs, abandoned: abandoned.length },
        'process runner stopped',
      );
    }
  }
}

/**
 * The marked line, or null.
 *
 * **Read from the end**, because the marker is the last thing a child writes. Anything a library
 * printed came before it — including, in the worst case, something that looks like a marker of
 * its own, since a check whose job is to run somebody's script may well end up echoing text it
 * does not control. Taking the first match would let that text be the result.
 */
function parseAnswer(stdout: string): ChildAnswer | null {
  const lines = stdout.split('\n');
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    if (!line.startsWith(RESULT_MARKER)) continue;
    try {
      return JSON.parse(line.slice(RESULT_MARKER.length)) as ChildAnswer;
    } catch {
      // A truncated marked line — the output bound cut it. Treated as no answer at all, which is
      // right: half a result is not a reading.
      return null;
    }
  }
  return null;
}

/**
 * Watches a child's stdout for its ready line (`P-260`): a whole line reading `READY_MARKER`.
 *
 * **A whole line, and only from the start of one**, so a library that prints the marker inside
 * a sentence while the catalogue loads does not start the check's clock. Holds at most the
 * marker's length of one line, however much the child writes, because this runs on every chunk
 * and keeps nothing it does not need. A library that printed exactly the marker on a line of its
 * own would start the runner's clock early by the rest of the load; the child's own abort is
 * still armed only once it has loaded, so the check would lose nothing it had before `P-260`.
 */
export class ReadyLine {
  #line = '';
  #overlong = false;

  /** True once a ready line has arrived, counting what earlier calls were handed. */
  push(text: string): boolean {
    let rest = text;
    for (;;) {
      const end = rest.indexOf('\n');
      if (!this.#overlong) {
        this.#line += end === -1 ? rest : rest.slice(0, end);
        if (this.#line.length > READY_MARKER.length) {
          this.#overlong = true;
          this.#line = '';
        }
      }
      if (end === -1) return false;
      if (!this.#overlong && this.#line === READY_MARKER) return true;
      this.#line = '';
      this.#overlong = false;
      rest = rest.slice(end + 1);
    }
  }
}

/**
 * What is left of a bound on the monotonic clock, in whole milliseconds, or null once it has
 * passed (`P-260`).
 *
 * A timer counts whole milliseconds of the event loop's clock, so it can fire up to one before the
 * bound has passed on `process.hrtime`, which is the clock the start-up message reports. Before
 * this, a test asserting that a start given up at a 1,500 ms bound had taken at least that long
 * failed once in five runs. The runner waits out the remainder rather than report a start shorter
 * than the bound it gave up at.
 */
export function leftOf(boundMs: number, elapsedMs: number): number | null {
  return elapsedMs < boundMs ? Math.ceil(boundMs - elapsedMs) : null;
}

/** The last of stderr, for a diagnosis. Bounded, because this ends up in a sensor's message. */
function tail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === '') return '';
  const last = trimmed.split('\n').slice(-3).join(' ');
  return `: ${last.length > 400 ? `${last.slice(0, 400)}…` : last}`;
}

function msSince(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

function record(window: number[], value: number): void {
  window.push(value);
  if (window.length > LATENCY_WINDOW) window.shift();
}

function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1] ?? 0) };
}

const round = (value: number): number => Math.round(value * 100) / 100;
