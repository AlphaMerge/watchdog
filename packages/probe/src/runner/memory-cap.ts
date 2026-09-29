import {
  memoryReserveBytes,
  readLimitMemory,
  readMachineMemory,
  type AvailableMemory,
} from '@ms/shared';
import { WORKER_RESIDENT_MIB } from '../measured.js';

/**
 * How many check workers the memory this probe may use can hold (`P-236`).
 *
 * **The bound `P-34` never had.** The pool's ceiling is derived from the work: Little's law on
 * measured check durations. Checks that hang to their timeout make that number enormous — 5,000
 * `port.tcp` checks waiting 5 s each wanted about 540 workers, clamped to 256 — and nothing
 * compared it with memory. `P-216b` measured the result: the pool grew to 98–110 workers, 3.7–4.0
 * GiB, and the kernel killed the probe for its 4 GiB box six times in six minutes while Probe
 * Health read 95% of the limit (`docs/findings/2026-09-29-probe-starvation-b.md`).
 *
 *     cap = held + floor((available − reserve) / perWorker)
 *
 * **`available` is the tightest cgroup ceiling's** (`readLimitMemory`, `P-210`), measured against
 * the working set so page cache the kernel would drop does not count as used. Where no ceiling
 * exists — cgroup v1, WinSW on Windows, no `MemoryMax` — it falls back to what the machine has
 * available (`P-208`), and then the probe competes with everything else on the host: the reserve
 * is its only protection, which is why `administration.md` recommends `MemoryMax` for exactly
 * that case. With neither reading there is no cap, and the pool behaves as it did before.
 *
 * **It corrects itself.** The per-worker figure is a measured constant, not a live one, but
 * `available` is read again each time, so an estimate that is low shows up as less available on
 * the next reading and the cap stops rising.
 */

export interface MemoryCapReading {
  /** The most workers memory allows now, including those already held. Never negative. */
  readonly workers: number;
  readonly availableBytes: number;
  readonly totalBytes: number;
  readonly reserveBytes: number;
  readonly perWorkerBytes: number;
  /** Where the reading came from: the probe's own cgroup ceiling, or the machine's memory. */
  readonly source: 'limit' | 'machine';
}

const MIB = 1024 * 1024;

/**
 * The arithmetic, pure, so it can be tested against a table.
 *
 * `held` is the workers held and on their way: their memory is already inside `available`, or is
 * about to be, and the cap is an absolute number of workers rather than a number to add.
 */
export function workersMemoryAllows(input: {
  readonly held: number;
  readonly memory: AvailableMemory;
  readonly perWorkerBytes: number;
}): { readonly workers: number; readonly reserveBytes: number } {
  const reserveBytes = memoryReserveBytes(input.memory.totalBytes);
  const spare = input.memory.availableBytes - reserveBytes;
  // Rounded towards fewer workers either way: a spare fraction does not buy a worker, and a deficit
  // of a fraction of a worker is still a deficit.
  const more = Math.floor(spare / input.perWorkerBytes);
  return { workers: Math.max(0, input.held + more), reserveBytes };
}

export interface MemoryCapSources {
  readonly limit: () => AvailableMemory | null;
  readonly machine: () => AvailableMemory | null;
  /** Monotonic milliseconds. */
  readonly now: () => number;
}

const LIVE: MemoryCapSources = {
  limit: () => readLimitMemory(),
  machine: () => readMachineMemory(),
  now: () => performance.now(),
};

/**
 * How long one reading of memory is used before it is taken again.
 *
 * The pool asks on every growth attempt, and while a probe is saturated that is every submit: a
 * thousand a second of cgroup reads would be the probe spending its CPU measuring how busy it is.
 * A reading is kept with the number of workers held when it was taken, so a worker added since is
 * counted against it rather than on top of it.
 */
export const MEMORY_CAP_READ_INTERVAL_MS = 1_000;

interface Taken {
  readonly memory: AvailableMemory;
  readonly source: 'limit' | 'machine';
  /** Workers held when it was taken. */
  readonly held: number;
}

export class MemoryCap {
  readonly #sources: MemoryCapSources;
  readonly #perWorkerBytes: number;
  /** The last reading and when it was taken; `taken` is `null` when neither source could say. */
  #last: { readonly at: number; readonly taken: Taken | null } | undefined;

  constructor(options: { sources?: Partial<MemoryCapSources>; perWorkerMiB?: number } = {}) {
    this.#sources = { ...LIVE, ...options.sources };
    this.#perWorkerBytes = (options.perWorkerMiB ?? WORKER_RESIDENT_MIB) * MIB;
  }

  /** The cap for a pool holding `held` workers, or `undefined` where memory cannot be read. */
  read(held: number): MemoryCapReading | undefined {
    const now = this.#sources.now();
    if (this.#last === undefined || now - this.#last.at >= MEMORY_CAP_READ_INTERVAL_MS) {
      this.#last = { at: now, taken: this.#take(held) };
    }
    const taken = this.#last.taken;
    if (taken === null) return undefined;
    // Workers added since the reading are not in it yet, and workers given up since still are.
    // Both are differences in `held`, so the cap worked out at the reading stands as an absolute.
    const { workers, reserveBytes } = workersMemoryAllows({
      held: taken.held,
      memory: taken.memory,
      perWorkerBytes: this.#perWorkerBytes,
    });
    return {
      workers,
      availableBytes: taken.memory.availableBytes,
      totalBytes: taken.memory.totalBytes,
      reserveBytes,
      perWorkerBytes: this.#perWorkerBytes,
      source: taken.source,
    };
  }

  #take(held: number): Taken | null {
    const limit = this.#sources.limit();
    if (limit !== null) return { memory: limit, source: 'limit', held };
    const machine = this.#sources.machine();
    if (machine !== null) return { memory: machine, source: 'machine', held };
    return null;
  }
}
