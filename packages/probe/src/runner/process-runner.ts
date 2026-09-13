import { join } from 'node:path';
import { runProgram, type CheckResult, type Logger } from '@ms/shared';
// From `types.js`, never from `check-child.js`: that module is an entry point with top-level
// `await` on stdin, and importing it here once made the probe sit waiting for its own stdin.
import { RESULT_MARKER } from './types.js';
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
 * **What is bounded, and what is not.** Bounded: wall-clock time (`SIGTERM` then `SIGKILL`,
 * against the whole process group so a script that backgrounds something does not outlive its own
 * kill), heap size, captured output, and the environment the child is given — built, never
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
  waitMs: { p50: number; p95: number; p99: number; max: number };
  runMs: { p50: number; p95: number; p99: number; max: number };
}

export interface ProcessRunnerOptions {
  logger: Logger;
  /** Node processes that may run at once. Far smaller than the worker pool's, and it must be. */
  maxConcurrent?: number;
  queueMaxLength?: number;
  /** Heap ceiling handed to the child as `--max-old-space-size`. */
  memoryLimitMb?: number;
  /** POSIX only, and only when this process has the privilege. Both or neither. */
  uid?: number;
  gid?: number;
  /** Module whose default export is a `CheckRegistry`, imported by the child. */
  registryModule?: string;
  /** Overridable so tests can drive a child that misbehaves on purpose. */
  childModule?: string;
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
}

interface ChildAnswer {
  ok: boolean;
  durationMs: number;
  channels?: { key: string; value: number }[];
  message?: string;
  aborted?: boolean;
  unknownType?: boolean;
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
const KILL_MARGIN_MS = 2_000;

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
  readonly #onResult: (result: CheckResult, meta: ResultMeta) => void;

  readonly #queue: Job[] = [];
  readonly #active = new Set<number>();
  #running = 0;
  #stopped = false;

  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #timedOut = 0;
  #deferred = 0;
  #refused = 0;
  #crashed = 0;
  readonly #waits: number[] = [];
  readonly #runs: number[] = [];

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
    this.#onResult = options.onResult;
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
      this.#logger.warn(
        { sensorId: request.sensorId, queued: this.#queue.length },
        'process-runner queue is full, refusing a check',
      );
      return 'queue-full';
    }

    this.#active.add(request.sensorId);
    this.#queue.push({ request, queuedAt: process.hrtime.bigint() });
    this.#pump();
    return 'accepted';
  }

  #pump(): void {
    while (this.#running < this.#maxConcurrent && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      this.#running += 1;
      void this.#run(job).finally(() => {
        this.#running -= 1;
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
      timeoutMs: job.request.timeoutMs + KILL_MARGIN_MS,
      maxOutputBytes: this.#maxOutputBytes,
      stdin: payload,
      ...(this.#uid === undefined ? {} : { uid: this.#uid }),
      ...(this.#gid === undefined ? {} : { gid: this.#gid }),
    });

    const answer = parseAnswer(run.stdout);

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
      });
      return;
    }

    // Nothing parseable came back. Which of the three reasons decides the phase, and they are not
    // interchangeable: a crash is a fault of the check, a timeout is ours, and a spawn failure
    // means the probe is misinstalled and no amount of retrying will help.
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
        (run.outcome === 'signalled'
          ? ` — it was killed by ${run.signal}, which is what a native crash looks like`
          : ` — it exited with code ${String(run.code)}`) +
        tail(run.stderr),
    });
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
      | { outcome: 'error'; message: string; durationMs: number },
  ): void {
    const result: CheckResult = {
      sensorId: job.request.sensorId,
      at: new Date().toISOString(),
      outcome: parts.outcome,
      message: parts.message,
      durationMs: Number(parts.durationMs.toFixed(3)),
      channels: parts.outcome === 'ok' ? parts.channels : [],
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
      waitMs: percentiles(this.#waits),
      runMs: percentiles(this.#runs),
    };
  }

  /**
   * Stops accepting work and waits for what is running.
   *
   * Nothing is killed here: `runProgram` already holds a deadline on every child, so the longest
   * this can take is the slowest check's own timeout plus the kill margin. Killing them instead
   * would turn a clean shutdown into a batch of results that say a check crashed.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
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
    while (this.#running > 0) await new Promise((resolve) => setTimeout(resolve, 20));
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

function percentiles(values: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1] ?? 0) };
}

const round = (value: number): number => Math.round(value * 100) / 100;
