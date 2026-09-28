/**
 * Memory available against some total — the machine's (`P-208`), or a cgroup's ceiling (`P-210`).
 *
 * `availableBytes` is **negative** when usage is past the total, which a cgroup can be: the kernel
 * throttles a cgroup past its `memory.high` rather than stopping it there, so its working set can
 * stand above that ceiling for as long as the throttling lasts.
 */
export interface AvailableMemory {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

/** The lowest reading in the window. */
export interface AvailableMemoryLow extends AvailableMemory {
  /** Of the total, to one decimal place. Negative past it. */
  readonly availablePercent: number;
}

export interface AvailableMemoryWatchOptions {
  readonly read: () => AvailableMemory | null;
  /** How far back the lowest reading is taken from. Thirty seconds: Probe Health's record interval. */
  readonly windowMs?: number;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
}

/**
 * The **lowest** available memory over the last thirty seconds, rather than the latest reading.
 *
 * **A point sample misses the event this exists for.** `P-206` watched a VM fall from 675 MiB
 * available to 30 MiB, and the kernel kill a process, inside six seconds — and a watchdog polling
 * every two seconds read 675, then 2,230 once the kill had freed the memory, and never saw the low.
 * Probe Health and Core Health each record once every thirty seconds, so a latest-value channel
 * would show a short squeeze roughly one time in fifteen. The window matches the record interval,
 * so each recorded value is the worst of the interval it stands for. Sampling every two seconds,
 * `P-208` measured it within half a point of the true low for every squeeze held five seconds or
 * longer.
 *
 * Sampled by the caller, which is `MemorySampler` on a two-second timer in both the core and the
 * probe (`P-218`). The window only holds what somebody read, so the sampling rate is part of the
 * guarantee. Read in-process, because `P-206`'s other lesson is that a guard which starts a process
 * to look is slowest exactly when memory is shortest.
 */
export class AvailableMemoryWatch {
  readonly #windowMs: number;
  readonly #read: () => AvailableMemory | null;
  readonly #now: () => number;
  #samples: { readonly at: number; readonly memory: AvailableMemory }[] = [];

  constructor(options: AvailableMemoryWatchOptions) {
    this.#read = options.read;
    this.#windowMs = options.windowMs ?? 30_000;
    this.#now = options.now ?? ((): number => performance.now());
  }

  /** Read now and keep it. A reading the platform cannot give is simply not kept. */
  sample(): void {
    const memory = this.#read();
    const at = this.#now();
    this.#prune(at);
    if (memory !== null) this.#samples.push({ at, memory });
  }

  /** The lowest reading still inside the window, or `null` — a gap — when there is none. */
  lowest(): AvailableMemoryLow | null {
    this.#prune(this.#now());
    let low: AvailableMemory | null = null;
    for (const { memory } of this.#samples) {
      if (low === null || memory.availableBytes < low.availableBytes) low = memory;
    }
    if (low === null) return null;
    return {
      availablePercent: Math.round((low.availableBytes / low.totalBytes) * 1_000) / 10,
      availableBytes: low.availableBytes,
      totalBytes: low.totalBytes,
    };
  }

  #prune(now: number): void {
    const since = now - this.#windowMs;
    this.#samples = this.#samples.filter((sample) => sample.at >= since);
  }
}
