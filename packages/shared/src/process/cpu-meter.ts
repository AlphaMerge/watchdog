/**
 * One CPU baseline, for a process reporting its own busyness (`P-12`, `P-13`).
 *
 * **CPU is a rate and `process.cpuUsage()` is a total**, so a reading needs a previous sample —
 * and each reading consumes it. That makes the meter a thing rather than a function: two readers
 * of the same process (a sweep that records history and a route that answers live) need one
 * baseline each, or the faster one silently shortens the other's window.
 *
 * Dividing lifetime CPU by lifetime wall clock is the obvious alternative and is wrong: it
 * converges on a flat line and never rises during an incident, which is the one moment the
 * number is worth having.
 */
export class CpuMeter {
  #usage: NodeJS.CpuUsage | null = null;
  #at: bigint | null = null;

  /**
   * The interval since this meter was last read, or `null` the first time.
   *
   * **`null`, not zero.** Zero would say the process is idle, which is a claim about the machine
   * rather than about the measurement — `CLAUDE.md`'s no-data rule applied to a number that is
   * not a device reading.
   */
  take(usage: NodeJS.CpuUsage, at: bigint): { usedUs: number; elapsedNs: bigint } | null {
    const previous = this.#usage;
    const previousAt = this.#at;
    this.#usage = usage;
    this.#at = at;
    if (previous === null || previousAt === null) return null;
    return {
      usedUs: usage.user - previous.user + (usage.system - previous.system),
      elapsedNs: at - previousAt,
    };
  }

  /**
   * The percentage of one core used since the last reading, or `null` the first time.
   *
   * Over 100 on a process using more than one thread, which is correct and deliberate:
   * normalising by core count would report a process saturating one thread as "6% busy" on a
   * sixteen-core box, and a single-threaded event loop at its ceiling is precisely the thing
   * worth alarming on.
   */
  percent(usage: NodeJS.CpuUsage, at: bigint): number | null {
    const interval = this.take(usage, at);
    if (interval === null) return null;
    const elapsedUs = Number(interval.elapsedNs) / 1_000;
    if (elapsedUs <= 0) return null;
    return Math.round((interval.usedUs / elapsedUs) * 1_000) / 10;
  }
}
