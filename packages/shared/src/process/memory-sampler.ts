import { readLimitMemory } from './limit-memory.js';
import { readMachineMemory } from './machine-memory.js';
import { AvailableMemoryWatch } from './memory-watch.js';

/**
 * How often a `MemorySampler` reads, in milliseconds.
 *
 * Two seconds: `P-206`'s fall from 675 MiB available to a kernel kill took six, so a squeeze of
 * that shape is read at least twice on its way down.
 */
export const MEMORY_SAMPLE_INTERVAL_MS = 2_000;

export interface MemorySamplerOptions {
  /** What the machine has left (`P-208`). Injectable so a test can squeeze a machine it invents. */
  readonly machine?: AvailableMemoryWatch;
  /** How close this process's cgroup is to its ceiling (`P-210`). Injectable likewise. */
  readonly limit?: AvailableMemoryWatch;
  readonly intervalMs?: number;
}

/**
 * The machine's memory and the cgroup ceiling's, read on a timer of their own (`P-218`).
 *
 * **Not at the heartbeat, which is where the probe read them until `P-218`.** A window keeps the
 * lowest of the last thirty seconds, and it only holds the readings somebody took. The heartbeat is
 * 10 s in the shipped configuration and may be anything up to 300. At 10 s the window held three
 * readings, and a five-second squeeze fell between two of them. At 30 s or more it held one,
 * which made it a latest-value channel again. `P-208` measured "within half a point" on the
 * development configuration's 2-second heartbeat, which no installation ships. The core never had
 * this problem, because it has always sampled on a two-second timer; both use this now.
 *
 * Reading goes on while a probe is disconnected, too. The heartbeat stops then, so the first report
 * after a reconnect used to have an empty window.
 */
export class MemorySampler {
  readonly machine: AvailableMemoryWatch;
  readonly limit: AvailableMemoryWatch;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemorySamplerOptions = {}) {
    this.machine = options.machine ?? new AvailableMemoryWatch({ read: () => readMachineMemory() });
    this.limit = options.limit ?? new AvailableMemoryWatch({ read: () => readLimitMemory() });
    this.#intervalMs = options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS;
  }

  /** Reads once now, then every interval. Unref'd, so it never holds a process open. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.sample();
    this.#timer = setInterval(() => {
      this.sample();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Both, at the same moment, so the two channels describe the same instant. */
  sample(): void {
    this.machine.sample();
    this.limit.sample();
  }
}
