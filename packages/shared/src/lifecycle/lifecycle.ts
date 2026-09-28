import { describeError } from '../errors/app-error.js';
import type { Logger } from '../logging/logger.js';
import { createServiceNotifier, watchdogIntervalMs, type ServiceNotifier } from './systemd.js';

/** Past the shutdown budget, what the stop extension leaves for the exit itself (`P-227`). */
const STOP_EXTEND_MARGIN_MS = 5_000;

export type ShutdownReason =
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'error'; error: unknown }
  | { kind: 'requested'; detail: string };

export interface ShutdownHook {
  /** Named so a hook that overruns its budget can be identified in the log. */
  name: string;
  /** Hooks run in reverse registration order: the last thing started is the first stopped. */
  run: (signal: AbortSignal) => Promise<void> | void;
  /** Per-hook budget. Defaults to the remaining process budget. */
  timeoutMs?: number;
}

export interface LifecycleOptions {
  logger: Logger;
  /** Hard ceiling on the whole shutdown. The process exits when it expires, drained or not. */
  shutdownTimeoutMs: number;
  notifier?: ServiceNotifier;
  /** Overridable for tests. */
  exit?: (code: number) => never;
}

function timeout(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<'timeout'>((resolvePromise) => {
    handle = setTimeout(() => {
      resolvePromise('timeout');
    }, ms);
    handle.unref();
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * Graceful shutdown (TASKS.md F-04): on SIGTERM stop accepting work, drain what is in flight,
 * flush, and exit 0 inside a bounded time. Anything still running when the budget expires is
 * abandoned deliberately and loudly — a monitoring system that hangs on shutdown is a
 * monitoring system that does not restart.
 */
export class Lifecycle {
  readonly #logger: Logger;
  readonly #shutdownTimeoutMs: number;
  readonly #notifier: ServiceNotifier;
  readonly #exit: (code: number) => never;
  readonly #hooks: ShutdownHook[] = [];
  readonly #abort = new AbortController();

  #shuttingDown = false;
  #watchdogTimer: NodeJS.Timeout | undefined;
  #installed = false;
  #resolveDrained: (() => void) | undefined;
  readonly #drained: Promise<void>;

  constructor(options: LifecycleOptions) {
    this.#drained = new Promise<void>((resolve) => {
      this.#resolveDrained = resolve;
    });
    this.#logger = options.logger.child({ component: 'lifecycle' });
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.#notifier = options.notifier ?? createServiceNotifier(this.#logger);
    this.#exit =
      options.exit ??
      ((code: number): never => {
        process.exit(code);
      });
  }

  /** Aborted as soon as shutdown begins. Long-running work should honour it. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  onShutdown(hook: ShutdownHook): void {
    this.#hooks.push(hook);
  }

  /** Installs signal handlers and the crash guards. Idempotent. */
  install(): void {
    if (this.#installed) return;
    this.#installed = true;

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        void this.shutdown({ kind: 'signal', signal });
      });
    }

    process.on('uncaughtException', (error) => {
      this.#logger.fatal({ err: describeError(error) }, 'uncaught exception');
      void this.shutdown({ kind: 'error', error });
    });

    process.on('unhandledRejection', (reason) => {
      this.#logger.fatal({ err: describeError(reason) }, 'unhandled rejection');
      void this.shutdown({ kind: 'error', error: reason });
    });
  }

  /**
   * Says the service is still starting and why, and asks the supervisor for `ms` more (`P-215`).
   *
   * For a start that is *waiting* rather than failing — the core on a database in crash recovery.
   * Without it, `TimeoutStartSec` ends the wait and systemd counts a failed start, which is the
   * count a start limit acts on: a database slow to recover would look exactly like a service
   * that can never start. Call it again before `ms` runs out, or the supervisor stops waiting.
   */
  starting(status: string, ms: number): void {
    this.#notifier.extendTimeout(ms, status);
  }

  /** Signals readiness to the supervisor and starts the watchdog heartbeat. */
  ready(status?: string): void {
    this.#notifier.ready(status);
    const intervalMs = watchdogIntervalMs();
    if (intervalMs !== null) {
      this.#watchdogTimer = setInterval(() => {
        this.#notifier.watchdog();
      }, intervalMs);
      this.#watchdogTimer.unref();
      this.#logger.debug({ intervalMs }, 'watchdog heartbeat started');
    }
  }

  /**
   * Holds the process open until shutdown has finished draining.
   *
   * A service whose subsystems have not yet allocated a listening socket has nothing keeping
   * the event loop referenced — signal handlers alone do not — so it would exit the instant
   * `main()` returned. The keep-alive timer makes the process's lifetime explicitly owned by
   * the lifecycle rather than an accident of which handles happen to be open.
   */
  async waitForShutdown(): Promise<void> {
    const keepAlive = setInterval(() => undefined, 1 << 30);
    try {
      await this.#drained;
    } finally {
      clearInterval(keepAlive);
    }
  }

  async shutdown(reason: ShutdownReason): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    const exitCode = reason.kind === 'error' ? 1 : 0;
    this.#logger.info({ reason: reason.kind, ...this.#reasonDetail(reason) }, 'shutting down');
    // **The budget, told to systemd** (`P-227`). `TimeoutStopSec` was the real bound and
    // `shutdownTimeoutMs` only a wish: an operator who raised the budget past the unit's stop
    // timeout, which `config check` accepts, had the drain SIGKILLed part-way, the whole cgroup
    // with it. The extension makes the configured budget the one that holds. The margin covers
    // the exit after it, so systemd never kills a service that is keeping its own deadline.
    this.#notifier.stopping('draining', this.#shutdownTimeoutMs + STOP_EXTEND_MARGIN_MS);
    if (this.#watchdogTimer !== undefined) clearInterval(this.#watchdogTimer);
    this.#abort.abort();

    const deadline = timeout(this.#shutdownTimeoutMs);
    const drain = this.#runHooks();
    const outcome = await Promise.race([drain, deadline.promise]);
    deadline.cancel();

    // One exit point. A drain that overruns the budget is a failure even if the shutdown was
    // requested cleanly, because work was abandoned.
    if (outcome === 'timeout') {
      this.#logger.error(
        { budgetMs: this.#shutdownTimeoutMs },
        'shutdown budget exhausted, exiting with work still in flight',
      );
      this.#resolveDrained?.();
      this.#exit(exitCode === 0 ? 1 : exitCode);
      return;
    }

    this.#logger.info({ exitCode }, 'shutdown complete');
    this.#resolveDrained?.();
    this.#exit(exitCode);
  }

  async #runHooks(): Promise<'drained'> {
    for (const hook of [...this.#hooks].reverse()) {
      const startedAt = process.hrtime.bigint();
      try {
        if (hook.timeoutMs === undefined) {
          await hook.run(this.#abort.signal);
        } else {
          const hookDeadline = timeout(hook.timeoutMs);
          const result = await Promise.race([
            Promise.resolve(hook.run(this.#abort.signal)).then(() => 'done' as const),
            hookDeadline.promise,
          ]);
          hookDeadline.cancel();
          if (result === 'timeout') {
            this.#logger.warn(
              { hook: hook.name, timeoutMs: hook.timeoutMs },
              'shutdown hook exceeded its budget, continuing',
            );
            continue;
          }
        }
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.#logger.debug({ hook: hook.name, elapsedMs }, 'shutdown hook complete');
      } catch (error) {
        this.#logger.error(
          { hook: hook.name, err: describeError(error) },
          'shutdown hook failed, continuing',
        );
      }
    }
    return 'drained';
  }

  #reasonDetail(reason: ShutdownReason): Record<string, unknown> {
    switch (reason.kind) {
      case 'signal':
        return { signal: reason.signal };
      case 'error':
        return { err: describeError(reason.error) };
      case 'requested':
        return { detail: reason.detail };
    }
  }
}
