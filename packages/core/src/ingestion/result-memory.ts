/**
 * Counted results remembered for each probe (`P-288`, `P-295`, `P-299`): two full batches of
 * 5,000, so a batch whose acknowledgement was lost is still remembered when it is sent again
 * behind another as large. **Per probe**, because between the lost acknowledgement and the resend there is a
 * reconnect, and in a fleet-wide replay after an upgrade other probes send their own refusals
 * meanwhile: one set shared by all of them would forget the first probe's before it came back.
 *
 * **At least this many, and at most a tenth more** (`RESULTS_REMEMBERED_SLACK`): a probe's set
 * grows past the bound by the slack and is then trimmed back to it in one pass.
 */
export const RESULTS_REMEMBERED = 10_000;

/**
 * How far past `RESULTS_REMEMBERED` a probe's set grows before it is trimmed, as a fraction of
 * the bound, and at least one (`P-295` review).
 *
 * **Why not one out for every one in.** Deleting a set's oldest key means walking its keys from
 * the start, and V8 leaves a deleted entry as a hole the walk skips until the table is rebuilt.
 * At the bound every new key paid for thousands of holes: 8.6 s for a million keys against 0.74 s
 * with no eviction at all, about 43 ms for each batch of 5,000 refused results and 98 ms at
 * worst, on the core's event loop. That was rare while only unfit results came here, and is
 * every refusal in a spool draining after a delete or a move since `P-295`. Trimming a tenth at
 * once pays the walk once for a thousand keys (`result-memory-performance.test.ts` measures it).
 */
export const RESULTS_REMEMBERED_SLACK = 0.1;

/**
 * Probes whose counted results are remembered at once (`P-288`); the one heard from least
 * recently is forgotten first. v1 is sized for fewer than 30 remote probes (`CAPABILITIES.MD`),
 * and the local one makes 30 at most.
 *
 * **Worst case about 75 MB**, all 32 probes each holding 11,000 (the bound and its slack): a key
 * is the kind, the sensor id and the result's `at` (at most 64 characters as the schema takes it,
 * sent whole), so at most 82 characters, about 210 bytes with the string's header and the set's
 * entry where a character outside Latin-1 makes it two bytes a character. An ISO time makes it
 * about 35 characters and 80 bytes, some 28 MB for the same 352,000. **Only a refusal is
 * remembered**, or a result that lost readings to fitting or was dropped: a result that did not
 * fit, one for a sensor not under the probe (`P-295`), one marked withheld that was not the
 * probe's to mark, and one dropped as made under a configuration before, a late refusal or a
 * result for a withheld sensor (`P-299`). Empty while every probe fits its own results and
 * reports only on its own sensors under the configuration it has; a spool draining after a
 * delete, a move or a change to what a probe is left fills it for that probe, and no further
 * than the bound.
 */
export const PROBES_REMEMBERED = 32;

/**
 * The results already counted, by probe GID and then by key (`P-288`, `P-295`), so a result sent
 * again is counted once. Both levels in order of use, the least recent first and the first
 * forgotten: a probe past the probe bound, and a probe's oldest results once its set has grown
 * past its bound by the slack, trimmed back to the bound in one pass.
 *
 * **A key seen again moves to the newest end**, and so does its probe (`P-288` review): deleted and
 * added again, which a trim then reaches last. A batch sent a third time, after a second link lost
 * its acknowledgement too, is still remembered however many results the probe has sent since.
 */
export class ResultMemory {
  readonly #byProbe = new Map<string, Set<string>>();
  readonly #bound: number;
  readonly #trimAt: number;
  readonly #probeBound: number;

  constructor(bound: number = RESULTS_REMEMBERED, probeBound: number = PROBES_REMEMBERED) {
    this.#bound = bound;
    this.#trimAt = bound + Math.max(1, Math.ceil(bound * RESULTS_REMEMBERED_SLACK));
    this.#probeBound = probeBound;
  }

  /** True the first time this probe's key is seen; false while it is remembered. */
  first(gid: string, key: string): boolean {
    const seen = this.#byProbe.get(gid) ?? new Set<string>();
    this.#byProbe.delete(gid);
    this.#byProbe.set(gid, seen);
    // At most one over, and only when a probe not heard from is: the walk is short.
    if (this.#byProbe.size > this.#probeBound) trimTo(this.#byProbe, this.#probeBound);
    const again = seen.delete(key);
    seen.add(key);
    if (again) return false;
    if (seen.size > this.#trimAt) trimTo(seen, this.#bound);
    return true;
  }

  /** Keys remembered across every probe. */
  get size(): number {
    let total = 0;
    for (const seen of this.#byProbe.values()) total += seen.size;
    return total;
  }

  /** Probes with keys remembered. */
  get probes(): number {
    return this.#byProbe.size;
  }
}

/** Deletes the first-inserted entries of a set or map until it holds no more than `bound`. */
function trimTo(entries: Set<string> | Map<string, unknown>, bound: number): void {
  for (const key of entries.keys()) {
    if (entries.size <= bound) return;
    entries.delete(key);
  }
}
