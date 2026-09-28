import type { CheckResult } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';

/**
 * Why a probe's result was refused (`P-228`).
 *
 * - `unknown`: no such sensor. A spool draining after a delete sends exactly this, so it is
 *   ordinary; nothing is written, and it was already counted as a dropped reading before `P-228`.
 * - `moved`: the sensor was under this probe once and is not now. The probe is lagging a move the
 *   core has already made, and its spool is still delivering what it measured before. Ordinary.
 * - `foreign`: the sensor exists and was never under this probe, or is one no probe may report —
 *   a type the core evaluates itself. No correct probe sends one.
 */
export type Refusal = 'unknown' | 'moved' | 'foreign';

export interface Admitted {
  /** What the probe may report, in the order it arrived. */
  results: CheckResult[];
  /** The rest, by why. */
  refused: Record<Refusal, CheckResult[]>;
}

/** Who may report a sensor: a probe object, no probe (`core`), or nobody under it now (null). */
type Owner = number | 'core' | null;

export interface SensorOwnershipOptions {
  /**
   * Types the core evaluates itself — Core Health, Probe Health, a Sensor Factory (`T-21`).
   *
   * Such a sensor sits under a probe like any other, and without this the probe it sits under
   * could write its readings: a probe reporting its own health as fine is the one reading Probe
   * Health exists to take out of the probe's hands.
   */
  coreEvaluated?: (sensorType: string) => boolean;
}

/**
 * Which probe may report each sensor, and whether a refused one had it before (`P-228`).
 *
 * **Decided by where the sensor is when the result arrives, not when it was measured.** A probe
 * whose spool still holds results for a sensor that has since moved elsewhere is refused for
 * them: what it measured before the move was true, but keeping it would mean keeping ownership
 * history for the gate, and the cost of refusing is a gap of one spool's length on one sensor.
 * What that history *is* used for is the classification: telling that lag, which must not warn
 * anyone, from a probe reporting on a sensor it never had, which must.
 *
 * Cached, because the gate is on every batch and ownership changes about as often as a sensor
 * is moved. `ResultCacheInvalidator` clears it on every move and every delete — the only two
 * mutations that change the answer, since a new sensor's id has never been reported by anyone
 * and a moved sensor keeps its id. A load that raced a clear is not cached: its rows were read
 * before a move that has since committed.
 */
export class SensorOwnership {
  readonly #coreEvaluated: (sensorType: string) => boolean;
  /**
   * Sensor → the probe object that may report it. Existing sensors only. `core` is a type the
   * core evaluates, which no probe may report wherever it sits; null is a sensor with no probe
   * above it, which none may report now but one may have before it was moved there.
   */
  readonly #owners = new Map<number, Owner>();
  /** `probe:sensor` → whether that sensor was ever under that probe. */
  readonly #hadBefore = new Map<string, boolean>();
  #generation = 0;

  constructor(options: SensorOwnershipOptions = {}) {
    this.#coreEvaluated = options.coreEvaluated ?? ((): boolean => false);
  }

  /** Sensors whose owner is cached. For Core Health and the tests. */
  get cached(): number {
    return this.#owners.size;
  }

  /** Forgets everything. Called inside a move's or a delete's transaction, and again after it. */
  clear(): void {
    this.#generation += 1;
    this.#owners.clear();
    this.#hadBefore.clear();
  }

  /**
   * Splits one batch into what this probe may report and what it may not.
   *
   * `probeObjectId` is null for a GID no probe object has claimed: it has nothing it could
   * legitimately report, so everything that names a real sensor is foreign.
   */
  async admit(
    q: Queryable,
    probeObjectId: number | null,
    results: readonly CheckResult[],
  ): Promise<Admitted> {
    const admitted: Admitted = { results: [], refused: { unknown: [], moved: [], foreign: [] } };
    if (results.length === 0) return admitted;

    const exists = await this.#ownersOf(q, [...new Set(results.map((one) => one.sensorId))]);
    // Only these need the history. A core-evaluated sensor is foreign whatever it says: its
    // *current* ancestry includes the probe it sits under, and the walk would call that probe a
    // former owner of a sensor that was never any probe's to report.
    const notOurs: number[] = [];
    for (const result of results) {
      const owner = exists.get(result.sensorId);
      if (owner === undefined || owner === 'core') continue;
      if (owner !== probeObjectId) notOurs.push(result.sensorId);
    }
    const had =
      probeObjectId === null || notOurs.length === 0
        ? new Set<number>()
        : await this.#formerlyUnder(q, probeObjectId, [...new Set(notOurs)]);

    for (const result of results) {
      const owner = exists.get(result.sensorId);
      if (owner === undefined) admitted.refused.unknown.push(result);
      else if (owner === 'core') admitted.refused.foreign.push(result);
      else if (owner !== null && owner === probeObjectId) admitted.results.push(result);
      else if (had.has(result.sensorId)) admitted.refused.moved.push(result);
      else admitted.refused.foreign.push(result);
    }
    return admitted;
  }

  /** The owner of each sensor that exists; a sensor that does not is absent from the map. */
  async #ownersOf(q: Queryable, sensorIds: readonly number[]): Promise<Map<number, Owner>> {
    const out = new Map<number, Owner>();
    const missing: number[] = [];
    for (const id of sensorIds) {
      const owner = this.#owners.get(id);
      if (owner === undefined) missing.push(id);
      else out.set(id, owner);
    }
    if (missing.length === 0) return out;

    const generation = this.#generation;
    // **`DISTINCT ON` rather than a subquery per sensor.** Probe Health's sweep picks each
    // sensor's probe with a correlated subquery over the walk, which is fine for the handful of
    // health sensors it reads and quadratic for a batch: a first batch after a restart names
    // every sensor on the probe, and 5,000 sensors against a 30,000-row walk is 150 million
    // comparisons where this is one sort.
    const rows = await q.query<{ sensor_id: string; sensor_type: string; probe_id: string | null }>(
      `WITH RECURSIVE up AS (
         SELECT o.id AS sensor_id, o.id, o.parent_id, o.kind, 0 AS depth
         FROM object o
         WHERE o.id = ANY($1::bigint[]) AND o.kind = 'sensor'
         UNION ALL
         SELECT up.sensor_id, parent.id, parent.parent_id, parent.kind, up.depth + 1
         FROM object parent JOIN up ON parent.id = up.parent_id
         WHERE up.depth < ${String(MAX_WALK_DEPTH)}
       ),
       probe_of AS (
         SELECT DISTINCT ON (sensor_id) sensor_id, id AS probe_id
         FROM up WHERE kind = 'probe'
         ORDER BY sensor_id, depth
       )
       SELECT sc.object_id::text AS sensor_id, sc.type AS sensor_type,
              p.probe_id::text AS probe_id
       FROM sensor_config sc
       JOIN object s ON s.id = sc.object_id AND s.kind = 'sensor'
       LEFT JOIN probe_of p ON p.sensor_id = sc.object_id
       WHERE sc.object_id = ANY($1::bigint[])`,
      [missing],
    );
    for (const row of rows) {
      const owner: Owner = this.#coreEvaluated(row.sensor_type)
        ? 'core'
        : row.probe_id === null
          ? null
          : Number(row.probe_id);
      out.set(Number(row.sensor_id), owner);
      if (this.#generation === generation) this.#owners.set(Number(row.sensor_id), owner);
    }
    return out;
  }

  /**
   * Which of these sensors were ever under this probe, by the audit log (`P-228`).
   *
   * Every re-parenting goes through `ObjectService.move`, which records `object.moved` in the
   * move's own transaction with the parent it left (`diff`) and the probe it left
   * (`summary.fromProbeId`). So the sensor's **historical** ancestry is the closure of its current
   * parent and every parent a move took it or one of its ancestors out of. The probe was over it
   * once if it is in that closure, or if a move of anything in it left that probe — the second
   * test covers an ancestor that has since been deleted, which ends the walk.
   *
   * Historical rather than current ancestry because of the case the plain version gets wrong: a
   * group moved from A to B, and then a sensor moved out of that group, before A's spool has
   * drained. The sensor's current ancestors include neither the group nor A, and A's late results
   * would read as foreign. The walk goes through the sensor's own move back into the group, and
   * through the group's move back to A.
   *
   * Only ever run for refused results, and cached per probe and sensor until the next move, so a
   * mass move costs one query per batch for the sensors not yet asked about. Bounded by the audit
   * retention (`retention.auditDays`, 730 by default): a move pruned from the log is a move this
   * cannot see, and a spool older than that reads as foreign.
   */
  async #formerlyUnder(
    q: Queryable,
    probeObjectId: number,
    sensorIds: readonly number[],
  ): Promise<Set<number>> {
    const out = new Set<number>();
    const missing: number[] = [];
    for (const id of sensorIds) {
      const had = this.#hadBefore.get(`${String(probeObjectId)}:${String(id)}`);
      if (had === undefined) missing.push(id);
      else if (had) out.add(id);
    }
    if (missing.length === 0) return out;

    const generation = this.#generation;
    const rows = await q.query<{ sensor_id: string }>(
      // `UNION` rather than `UNION ALL`, and no depth: the walk is over (sensor, object) pairs,
      // so it ends by itself when a step finds nothing new — and history can contain a cycle a
      // live tree cannot (X moved under Y, later Y moved under X), which a depth bound would
      // walk round a thousand times.
      `WITH RECURSIVE was_under (sensor_id, id) AS (
         SELECT o.id, o.id FROM object o WHERE o.id = ANY($2::bigint[])
         UNION
         SELECT w.sensor_id, parent.id
         FROM was_under w
         CROSS JOIN LATERAL (
           SELECT o.parent_id AS id FROM object o
           WHERE o.id = w.id AND o.parent_id IS NOT NULL
           UNION
           SELECT (d.entry->>'before')::bigint
           FROM audit_log a CROSS JOIN LATERAL jsonb_array_elements(a.diff) AS d(entry)
           WHERE a.object_id = w.id AND a.action = 'object.moved'
             AND d.entry->>'field' = 'parentId'
         ) AS parent
       )
       SELECT DISTINCT w.sensor_id::text AS sensor_id
       FROM was_under w
       WHERE w.id = $1
          OR EXISTS (SELECT 1 FROM audit_log a
                     WHERE a.object_id = w.id AND a.action = 'object.moved'
                       AND a.summary->>'fromProbeId' = $1::text)`,
      [probeObjectId, missing],
    );
    const found = new Set(rows.map((row) => Number(row.sensor_id)));
    for (const id of missing) {
      if (found.has(id)) out.add(id);
      if (this.#generation === generation) {
        this.#hadBefore.set(`${String(probeObjectId)}:${String(id)}`, found.has(id));
      }
    }
    return out;
  }
}
