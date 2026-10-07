/**
 * How much a running total grew since the last reading (`P-216` part 3).
 *
 * **For a count that must clear itself and must not miss the interval a restart falls in.** A
 * counter channel is stored as a rate, and the rate gaps on the first reading after the total
 * restarts (`P-231`) — which for lines a service dropped is the interval right after the stall that
 * killed it. A running total never clears. This is the difference between two readings of one
 * total, and after a restart the new total itself, because it counts from zero.
 *
 * A thing rather than a function for `CpuMeter`'s reason: each reading consumes the baseline, so
 * two readers of one total (a sweep that records and a route that answers live) need one each.
 */
export class DeltaMeter {
  #total: number | null = null;
  #uptime = 0;
  #instance: string | undefined;

  /**
   * The growth since the last reading.
   *
   * `uptime` is the age in seconds of whatever keeps the total. A total that fell, or an uptime
   * that did, is a new process counting from zero, so its whole total is new.
   *
   * The first reading is the whole total when `fresh`: the process keeping it started after this
   * meter did, so no earlier reading could have covered any of it. Otherwise it is `null`, a gap —
   * the total may already have been counted by whoever read it before this meter existed, and
   * counting it again would raise an alarm for something that ended before a restart.
   *
   * **`instance` makes a restart exact** (`P-284` review): an identifier the process keeping the
   * total chose when it started. Two readings with different ones are two processes, whatever the
   * totals and uptimes say. Without it a restart is inferred, and the inference misses one: a
   * process that restarted while nobody was reading, and had run longer by the next reading than
   * the old one had by the last, with a total no lower — its whole total counted as growth past
   * the old one. Absent on either reading, the inference is all there is.
   */
  take(total: number, uptime: number, fresh: boolean, instance?: string): number | null {
    const previous = this.#total;
    const previousUptime = this.#uptime;
    const previousInstance = this.#instance;
    this.#total = total;
    this.#uptime = uptime;
    this.#instance = instance;
    if (previous === null) return fresh ? total : null;
    if (instance !== undefined && previousInstance !== undefined && instance !== previousInstance) {
      return total;
    }
    if (total < previous || uptime < previousUptime) return total;
    return total - previous;
  }
}
