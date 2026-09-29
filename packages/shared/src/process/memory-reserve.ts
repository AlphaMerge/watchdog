const MIB = 1024 * 1024;

/** A quarter of a GiB at least. */
const RESERVE_FLOOR_BYTES = 256 * MIB;
const RESERVE_FRACTION = 0.25;

/**
 * Memory kept back from the pool: the larger of 256 MiB and a quarter of the ceiling.
 *
 * For what is not workers — the main thread's heap, the spool, the log's backlog when stdout is
 * slow, workers that have only just started — and **for the surge the limit channels are set
 * for** (`P-244`). `memoryLimitUsage` warns at 80% because from there one surge still fits under
 * the ceiling: the probe's start-up grew 856 MiB in five seconds, 14% of 6 GiB (`P-206`), and a
 * configuration push can start one at any time (`P-34`). At a tenth, the cap parked a saturated
 * probe at about 90% — `P-216c` read 89.9–94.7% in every stage — where that surge does not fit,
 * so the warning was true and stood for as long as the pool was full. A quarter stops the pool
 * under 75% plus one worker: clear of the warning, with the room it assumes, and clear of
 * `memoryAvailable`'s 20% on a probe measuring the machine, where a tenth sat on the error limit.
 *
 * **What it costs is workers while memory binds, and only then.** At the ceiling's 256 workers of
 * 40 MiB the cap binds below about 13 GiB; at the stock 6 GiB a saturated pool stops 23 workers
 * sooner, about 107 rather than 130 beside a 300 MiB main thread. On a larger box the ceiling
 * binds first and the reserve is never reached. The floor, because a quarter of a small ceiling
 * is not enough for the main thread.
 *
 * **No upper bound, because the limits it keeps clear of are fractions.** A reserve capped at, say,
 * 1 GiB would park any ceiling above 5 GiB over the 80% warning again, the stock 6 GiB at 83%, and
 * would let a probe with no ceiling of its own take a large machine down to 1 GiB, under
 * `memoryAvailable`'s 10% error. Where a quarter looks like a lot — 4 GiB of 16 — it is never
 * reached: the pool's 256 workers use 64% of that ceiling.
 */
export function memoryReserveBytes(totalBytes: number): number {
  return Math.max(RESERVE_FLOOR_BYTES, Math.ceil(totalBytes * RESERVE_FRACTION));
}
