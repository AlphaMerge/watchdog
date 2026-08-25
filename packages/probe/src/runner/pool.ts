import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describeError, type CheckResult, type Logger } from '@ms/shared';
import type { CheckPhase, CheckRequest, ResultMeta } from './types.js';

/** Latencies kept for the percentiles Probe Health reports (P-13). */
const LATENCY_WINDOW = 1_024;

/**
 * Consecutive worker starts that may fail before the pool gives up.
 *
 * A worker that dies during start-up — a broken registry module, a missing file — dies again the
 * moment it is replaced. Respawning for ever would fill the log at the speed of the event loop
 * and hide the one line that mattered.
 */
const MAX_CONSECUTIVE_START_FAILURES = 3;

export type SubmitOutcome = 'accepted' | 'already-running' | 'queue-full' | 'stopped';

export interface PoolStats {
  size: number;
  busy: number;
  queued: number;
  submitted: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** Checks skipped because the previous scan of that sensor had not finished. */
  deferred: number;
  /** Checks refused because the queue was full. */
  refused: number;
  workerCrashes: number;
  waitMs: { p50: number; p95: number; p99: number; max: number };
  runMs: { p50: number; p95: number; p99: number; max: number };
}

export interface CheckPoolOptions {
  logger: Logger;
  /** 0 derives from the machine. */
  size?: number;
  queueMaxLength?: number;
  /**
   * How long a check has to honour its abort before the worker is terminated.
   *
   * The cooperative path is the cheap one — an aborted check returns and its worker is reusable
   * immediately. Termination is the backstop for a check that cannot be interrupted, and it
   * costs a worker restart.
   */
  abortGraceMs?: number;
  /** Module whose default export is a `CheckRegistry`. P-05 supplies the real one. */
  registryModule?: string;
  onResult: (result: CheckResult, meta: ResultMeta) => void;
}

interface Job {
  id: string;
  request: CheckRequest;
  queuedAt: bigint;
  startedAt: bigint;
  waitMs: number;
  timeout: NodeJS.Timeout | undefined;
  grace: NodeJS.Timeout | undefined;
  /** True once a result has been emitted; a late reply from the worker is then ignored. */
  settled: boolean;
}

interface Slot {
  id: number;
  worker: Worker;
  ready: boolean;
  job: Job | undefined;
  /**
   * Set when the pool itself is taking this worker out of service.
   *
   * Terminating a worker fires the same `exit` event a crash does, and without this the pool
   * would count its own recycle as a crash and spawn a *second* replacement — ending up one
   * worker over its bound every time a check ignored an abort.
   */
  retired: boolean;
}

/**
 * The bounded worker pool that runs checks (ADR-001 Decision 3).
 *
 * Three guarantees, in the order they matter.
 *
 * **Nothing blocks the scheduler.** `submit` returns immediately; results arrive by callback.
 * The timing wheel hands over ids and gets on with the next tick.
 *
 * **A hung check costs one worker, briefly, and nothing else.** The result is emitted the instant
 * the timeout expires, not when the check finally returns — so a sensor stuck on a dead SSH
 * connection reports Down on time. The worker is asked to abort, and terminated if it will not.
 *
 * **A sensor never stacks.** A check whose next scan comes due while the previous is still
 * running is skipped and counted (`WORKFLOW.MD` §3), which costs nothing to decide because the
 * wheel has already scheduled the next one.
 */
export class CheckPool {
  readonly #logger: Logger;
  readonly #size: number;
  readonly #queueMax: number;
  readonly #abortGraceMs: number;
  readonly #registryModule: string;
  readonly #onResult: (result: CheckResult, meta: ResultMeta) => void;

  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  /** Sensors queued or running, so a second scan of the same sensor is skipped. */
  readonly #active = new Set<number>();
  readonly #wait: number[] = [];
  readonly #run: number[] = [];

  #nextJobId = 0;
  #nextWorkerId = 0;
  #startFailures = 0;
  #stopped = false;
  #disabled = false;

  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #timedOut = 0;
  #deferred = 0;
  #refused = 0;
  #crashes = 0;

  constructor(options: CheckPoolOptions) {
    this.#logger = options.logger.child({ component: 'check-pool' });
    // One core left for the event loop that owns the wheel, the transport and the spool.
    this.#size =
      options.size !== undefined && options.size > 0
        ? options.size
        : Math.max(1, availableParallelism() - 1);
    this.#queueMax = options.queueMaxLength ?? 1_000;
    this.#abortGraceMs = options.abortGraceMs ?? 2_000;
    this.#registryModule =
      options.registryModule ?? join(import.meta.dirname, 'catalogue-registry.js');
    this.#onResult = options.onResult;
  }

  get size(): number {
    return this.#size;
  }

  /** Resolves once every worker has loaded its registry and is ready for work. */
  async start(): Promise<void> {
    if (this.#slots.length > 0) return;
    await Promise.all(Array.from({ length: this.#size }, () => this.#spawn()));
    this.#logger.info({ size: this.#size, registry: this.#registryModule }, 'check pool started');
  }

  /**
   * Stops accepting work and terminates every worker.
   *
   * Checks in flight are abandoned rather than awaited: a probe shutting down has nothing useful
   * to do with a result nobody will read, and waiting would mean the slowest hung check decides
   * how long shutdown takes.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) this.#settle(job, 'pool-stopped', 'probe is stopping');
    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.job !== undefined) {
          this.#settle(slot.job, 'pool-stopped', 'probe is stopping');
        }
        await slot.worker.terminate();
      }),
    );
    this.#slots.length = 0;
    this.#logger.info(this.stats(), 'check pool stopped');
  }

  /** Offers a check. Never blocks, never throws, always answers what it did. */
  submit(request: CheckRequest): SubmitOutcome {
    if (this.#stopped || this.#disabled) return 'stopped';
    this.#submitted += 1;

    if (this.#active.has(request.sensorId)) {
      // The previous scan of this sensor is still going. Skipping is the rule (WORKFLOW.MD §3)
      // and it is free: the wheel has already scheduled the next one.
      this.#deferred += 1;
      return 'already-running';
    }
    if (this.#queue.length >= this.#queueMax) {
      this.#refused += 1;
      this.#logger.warn(
        { sensorId: request.sensorId, queued: this.#queue.length },
        'check queue is full, refusing a check',
      );
      return 'queue-full';
    }

    this.#nextJobId += 1;
    this.#queue.push({
      id: String(this.#nextJobId),
      request,
      queuedAt: process.hrtime.bigint(),
      startedAt: 0n,
      waitMs: 0,
      timeout: undefined,
      grace: undefined,
      settled: false,
    });
    this.#active.add(request.sensorId);
    this.#pump();
    return 'accepted';
  }

  stats(): PoolStats {
    return {
      size: this.#size,
      busy: this.#slots.filter((slot) => slot.job !== undefined).length,
      queued: this.#queue.length,
      submitted: this.#submitted,
      completed: this.#completed,
      failed: this.#failed,
      timedOut: this.#timedOut,
      deferred: this.#deferred,
      refused: this.#refused,
      workerCrashes: this.#crashes,
      waitMs: percentiles(this.#wait),
      runMs: percentiles(this.#run),
    };
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) return;
      if (!slot.ready || slot.job !== undefined) continue;
      const job = this.#queue.shift();
      /* c8 ignore next -- guarded by the length check above */
      if (job === undefined) return;
      this.#dispatch(slot, job);
    }
  }

  #dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    job.startedAt = process.hrtime.bigint();
    job.waitMs = Number(job.startedAt - job.queuedAt) / 1e6;
    record(this.#wait, job.waitMs);

    job.timeout = setTimeout(() => {
      this.#onTimeout(slot, job);
    }, job.request.timeoutMs);
    job.timeout.unref();

    slot.worker.postMessage({
      type: 'run',
      jobId: job.id,
      sensorId: job.request.sensorId,
      sensorType: job.request.sensorType,
      params: job.request.params,
    });
  }

  /**
   * The check ran out of time.
   *
   * The result goes out now rather than when the check eventually returns: a sensor stuck on a
   * dead connection has to report Down on schedule, or the state machine learns about an outage
   * a minute late. Freeing the worker is a separate problem, handled below it.
   */
  #onTimeout(slot: Slot, job: Job): void {
    if (job.settled) return;
    this.#timedOut += 1;
    this.#settle(
      job,
      'timeout',
      `the check did not finish within ${String(job.request.timeoutMs)} ms`,
    );

    slot.worker.postMessage({ type: 'abort', jobId: job.id });
    job.grace = setTimeout(() => {
      if (slot.job !== job) return;
      this.#logger.warn(
        { sensorId: job.request.sensorId, workerId: slot.id },
        'a check ignored its abort signal; terminating the worker',
      );
      void this.#recycle(slot);
    }, this.#abortGraceMs);
    job.grace.unref();
  }

  #onWorkerMessage(slot: Slot, message: unknown): void {
    const parsed = message as { type?: string; jobId?: string };
    if (parsed.type === 'ready') {
      slot.ready = true;
      this.#startFailures = 0;
      this.#pump();
      return;
    }
    if (parsed.type !== 'result') return;

    const job = slot.job;
    if (job === undefined || job.id !== parsed.jobId) return;
    clear(job);
    slot.job = undefined;

    if (!job.settled) {
      const result = message as {
        durationMs: number;
        ok: boolean;
        aborted?: boolean;
        unknownType?: boolean;
        message: string;
        channels?: { key: string; value: number; name?: string; unit?: string }[];
      };
      record(this.#run, result.durationMs);
      if (result.ok) {
        this.#completed += 1;
        this.#emit(job, slot, 'execute', {
          outcome: 'ok',
          message: result.message,
          durationMs: result.durationMs,
          channels: result.channels ?? [],
        });
      } else {
        this.#failed += 1;
        const phase: CheckPhase =
          result.unknownType === true
            ? 'unknown-type'
            : result.aborted === true
              ? 'aborted'
              : 'execute';
        this.#emit(job, slot, phase, {
          outcome: 'error',
          message: result.message,
          durationMs: result.durationMs,
          channels: [],
        });
      }
    }

    this.#pump();
  }

  /** A worker died: mid-check, or during start-up. */
  #onWorkerGone(slot: Slot, reason: string): void {
    if (this.#stopped || slot.retired) return;
    this.#crashes += 1;

    const job = slot.job;
    if (job !== undefined) {
      // Exactly one result is lost, and it is reported rather than dropped.
      this.#settle(job, 'worker-crash', `the worker running this check ${reason}`);
      slot.job = undefined;
    }

    if (!slot.ready) {
      this.#startFailures += 1;
      if (this.#startFailures >= MAX_CONSECUTIVE_START_FAILURES) {
        this.#disabled = true;
        this.#logger.error(
          { failures: this.#startFailures, registry: this.#registryModule },
          'check workers keep failing to start; the pool is disabled until the probe restarts',
        );
        return;
      }
    }

    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    void this.#spawn().then(() => {
      this.#pump();
    });
  }

  async #recycle(slot: Slot): Promise<void> {
    slot.retired = true;
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
    slot.job = undefined;
    await slot.worker.terminate();
    if (this.#stopped) return;
    await this.#spawn();
    this.#pump();
  }

  async #spawn(): Promise<void> {
    if (this.#stopped || this.#disabled) return;
    this.#nextWorkerId += 1;
    const worker = new Worker(join(import.meta.dirname, 'check-worker.js'), {
      workerData: { registryModule: pathToFileURL(this.#registryModule).href },
    });
    const slot: Slot = {
      id: this.#nextWorkerId,
      worker,
      ready: false,
      job: undefined,
      retired: false,
    };
    this.#slots.push(slot);

    worker.on('message', (message: unknown) => {
      this.#onWorkerMessage(slot, message);
    });
    worker.on('error', (error) => {
      this.#logger.error({ err: describeError(error), workerId: slot.id }, 'check worker failed');
      this.#onWorkerGone(slot, 'failed');
    });
    worker.on('exit', (code) => {
      if (slot.ready && code === 0 && this.#stopped) return;
      this.#onWorkerGone(slot, `exited with code ${String(code)}`);
    });

    await new Promise<void>((resolve) => {
      const settle = (): void => {
        resolve();
      };
      worker.once('message', settle);
      worker.once('error', settle);
      worker.once('exit', settle);
    });
  }

  #settle(job: Job, phase: CheckPhase, message: string): void {
    if (job.settled) return;
    if (phase === 'worker-crash' || phase === 'pool-stopped') this.#failed += 1;
    this.#emit(job, undefined, phase, {
      outcome: 'error',
      message,
      durationMs: job.startedAt === 0n ? 0 : Number(process.hrtime.bigint() - job.startedAt) / 1e6,
      channels: [],
    });
  }

  #emit(
    job: Job,
    slot: Slot | undefined,
    phase: CheckPhase,
    parts: {
      outcome: 'ok' | 'error';
      message: string;
      durationMs: number;
      channels: { key: string; value: number; name?: string; unit?: string }[];
    },
  ): void {
    job.settled = true;
    clear(job);
    this.#active.delete(job.request.sensorId);

    const result: CheckResult = {
      sensorId: job.request.sensorId,
      at: new Date().toISOString(),
      outcome: parts.outcome,
      message: parts.message,
      durationMs: Number(parts.durationMs.toFixed(3)),
      // A failed check records no channel values: the gap is the data (CLAUDE.md).
      channels: parts.outcome === 'ok' ? parts.channels : [],
    };
    this.#onResult(result, { phase, waitMs: job.waitMs, workerId: slot?.id ?? 0 });
  }
}

function clear(job: Job): void {
  if (job.timeout !== undefined) clearTimeout(job.timeout);
  if (job.grace !== undefined) clearTimeout(job.grace);
  job.timeout = undefined;
  job.grace = undefined;
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
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return Number((sorted[index] ?? 0).toFixed(3));
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
