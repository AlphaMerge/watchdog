import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

/**
 * How much memory the *machine* has left, as the operating system counts it (`P-208`).
 *
 * **Not the process's own resident memory**, which Probe Health and Core Health already report as
 * `memory`. `P-206`'s probe was the largest process on the VM when the kernel killed it, but it was
 * killed because a lint run and PostgreSQL's shared buffers had taken the rest — and on a machine a
 * probe shares with the core and its database, which is the default installation, only this number
 * can say so.
 *
 * **`MemAvailable`, never `MemFree`.** `MemFree` leaves out the page cache the kernel will give back
 * the moment something asks, so on a healthy database host it reads a fraction of the truth:
 * `snmp-memory.ts` records one machine at 64% used by `MemFree` and 35% by `MemAvailable`. Windows'
 * equivalent is what `GlobalMemoryStatusEx` calls available — standby pages included — which is
 * what `os.freemem()` returns there.
 *
 * **`/proc/meminfo` is read directly on Linux** even though libuv's `os.freemem()` returns
 * `MemAvailable` there too (measured on Node 24, libuv 1.52: 6,094 against 6,096 MiB, with `MemFree`
 * at 1,485). On a kernel without `MemAvailable` libuv falls back to `MemFree` without saying so, and
 * a confident wrong number is worse than a gap. Reading the file ourselves is how that case becomes
 * one.
 *
 * **Anywhere else, a gap.** macOS and the BSDs count free pages, which is `MemFree`'s mistake again,
 * and neither is a platform this system is installed on.
 */
export interface MachineMemory {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

/** Where the numbers come from, injectable so a test does not measure the machine it runs on. */
export interface MachineMemorySources {
  readonly platform: NodeJS.Platform;
  readonly readMeminfo: () => string;
  readonly freemem: () => number;
  readonly totalmem: () => number;
}

const LIVE: MachineMemorySources = {
  platform: process.platform,
  readMeminfo: () => readFileSync('/proc/meminfo', 'utf8'),
  freemem,
  totalmem,
};

/** `/proc/meminfo`, as bytes. Every value there is in kB, and every line says so. */
export function parseMeminfo(output: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    // "MemTotal:        8126756 kB" — the unit is on the line and is always kB in practice,
    // but a line without one is a count (`HugePages_Total`) and must not be multiplied.
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+(\w+))?\s*$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    const amount = Number(match[2]);
    if (key === undefined || !Number.isFinite(amount)) continue;
    const unit = match[3]?.toLowerCase();
    values.set(key, unit === 'kb' ? amount * 1024 : amount);
  }
  return values;
}

/** What the machine has available now, or `null` where this platform cannot honestly say. */
export function readMachineMemory(sources: MachineMemorySources = LIVE): MachineMemory | null {
  if (sources.platform === 'linux') {
    let values: Map<string, number>;
    try {
      values = parseMeminfo(sources.readMeminfo());
    } catch {
      // No /proc — a sandbox, or a container without it mounted. Nothing to read is a gap.
      return null;
    }
    const availableBytes = values.get('MemAvailable');
    const totalBytes = values.get('MemTotal');
    // A kernel older than 3.14 has no `MemAvailable`. The fallback the SSH sensor uses — free plus
    // buffers plus cache — overstates it, and that sensor says so in its message; a channel with
    // limits on it has nowhere to say so, so it gaps instead.
    if (availableBytes === undefined || totalBytes === undefined || totalBytes <= 0) return null;
    return { availableBytes, totalBytes };
  }
  if (sources.platform === 'win32') {
    const totalBytes = sources.totalmem();
    if (!(totalBytes > 0)) return null;
    return { availableBytes: sources.freemem(), totalBytes };
  }
  return null;
}

/** The lowest reading in the window, as the two channels carry it. */
export interface MachineMemoryLow {
  /** Of the machine's total, to one decimal place. */
  readonly availablePercent: number;
  readonly availableBytes: number;
}

export interface MachineMemoryWatchOptions {
  /** How far back the lowest reading is taken from. Thirty seconds: Probe Health's record interval. */
  readonly windowMs?: number;
  readonly read?: () => MachineMemory | null;
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
 * so each recorded value is the worst of the interval it stands for.
 *
 * Sampled by the caller — the probe at every heartbeat, the core on a timer of its own — and read
 * in-process, because `P-206`'s other lesson is that a guard which starts a process to look is
 * slowest exactly when memory is shortest.
 */
export class MachineMemoryWatch {
  readonly #windowMs: number;
  readonly #read: () => MachineMemory | null;
  readonly #now: () => number;
  #samples: { readonly at: number; readonly memory: MachineMemory }[] = [];

  constructor(options: MachineMemoryWatchOptions = {}) {
    this.#windowMs = options.windowMs ?? 30_000;
    this.#read = options.read ?? ((): MachineMemory | null => readMachineMemory());
    this.#now = options.now ?? ((): number => performance.now());
  }

  /** Read the machine now and keep it. A reading the platform cannot give is simply not kept. */
  sample(): void {
    const memory = this.#read();
    const at = this.#now();
    this.#prune(at);
    if (memory !== null) this.#samples.push({ at, memory });
  }

  /** The lowest reading still inside the window, or `null` — a gap — when there is none. */
  lowest(): MachineMemoryLow | null {
    this.#prune(this.#now());
    let low: MachineMemory | null = null;
    for (const { memory } of this.#samples) {
      if (low === null || memory.availableBytes < low.availableBytes) low = memory;
    }
    if (low === null) return null;
    return {
      availablePercent: Math.round((low.availableBytes / low.totalBytes) * 1_000) / 10,
      availableBytes: low.availableBytes,
    };
  }

  #prune(now: number): void {
    const since = now - this.#windowMs;
    this.#samples = this.#samples.filter((sample) => sample.at >= since);
  }
}
