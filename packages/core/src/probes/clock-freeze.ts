import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import { heldIn, type HeldWordsLookup } from '../state/runtime.js';
import type { ProbeLink } from '../transport/probe-endpoint.js';
import { PROBE_SOURCE, type DependencyRecomputer, type StateReevaluator } from './reachability.js';

/**
 * How far a sensor's last result may be ahead of its probe's clock before the sensor is frozen.
 *
 * What it absorbs is the offset's own error, which the smallest-of-a-window reading has already
 * cut to the fastest message's delay, and a check's stamp being taken as it settles. A minute is
 * far more than either and far less than any step that freezes a sensor for long enough to
 * matter.
 */
export const CLOCK_FREEZE_TOLERANCE_MS = 60_000;

/** The sentence a frozen sensor carries while it is Unknown. It is also the fix. */
export const FROZEN_MESSAGE =
  "the probe's clock reads earlier than the last result this sensor accepted, so nothing it " +
  'measures can be applied until its clock passes that; set the probe host clock';

/** What a thawed sensor says until its next result (`R-11`), where it said nothing. */
export const THAWED_MESSAGE =
  "the probe's clock has passed the last result this sensor accepted; until its next result " +
  'it stands where it stood before';

/**
 * The sensors under a probe (`$1`), not of a core-evaluated type (`$2`), whose last result is
 * later than `$3`. Exported so the committed measurement explains the statement that runs.
 *
 * The walk `ProbeReachability` uses for the sensors a probe carries, with the core-evaluated
 * types excluded for the same reason (`P-13`): a Probe Health or Sensor Factory under a probe
 * whose clock is behind is stamped by the core's clock, and would read as frozen.
 */
export const FROZEN_UNDER_SQL = `WITH RECURSIVE below AS (
    SELECT id, kind, 0 AS depth FROM object WHERE id = $1
    UNION ALL
    SELECT child.id, child.kind, below.depth + 1
    FROM object child JOIN below ON child.parent_id = below.id
    WHERE below.depth < ${String(MAX_WALK_DEPTH)}
  )
  SELECT below.id::text AS id
  FROM below
  JOIN sensor_config ON sensor_config.object_id = below.id
  JOIN sensor_runtime ON sensor_runtime.object_id = below.id
  WHERE below.kind = 'sensor'
    AND NOT (sensor_config.type = ANY($2::text[]))
    AND sensor_runtime.last_result_at > $3`;

/**
 * Which of the sensors `$2` are still under the probe `$1`: `FROZEN_UNDER_SQL`'s walk, kept to
 * the sensors a probe froze, for `ClockFreeze.resync` (`P-239`).
 */
const STILL_UNDER_SQL = `WITH RECURSIVE below AS (
    SELECT id, kind, 0 AS depth FROM object WHERE id = $1
    UNION ALL
    SELECT child.id, child.kind, below.depth + 1
    FROM object child JOIN below ON child.parent_id = below.id
    WHERE below.depth < ${String(MAX_WALK_DEPTH)}
  )
  SELECT below.id::text AS id
  FROM below
  WHERE below.kind = 'sensor' AND below.id = ANY($2::bigint[])`;

interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface ClockFreezeOptions {
  readonly db: Db;
  readonly logger: Logger;
  /** The same two a lost probe moves its sensors with, so the two are one path (`P-232`). */
  readonly states: StateReevaluator;
  readonly dependencies: DependencyRecomputer;
  readonly links: {
    connectedProbeIds(): readonly number[];
    linkFor(probeObjectId: number): ProbeLink;
  };
  /** Sensor types the core evaluates, stamped by the core's clock: never frozen by a probe's. */
  readonly coreEvaluatedTypes?: readonly string[];
  /**
   * The sensors that are a probe's own alarm, re-evaluated with the ones it freezes or thaws, as
   * `ProbeReachability` does for a lost probe (`M-22`).
   */
  readonly probeAlarms?: (probeObjectId: number) => readonly number[];
  readonly now?: () => Date;
}

export interface ClockFreezeStats {
  readonly sweeps: number;
  readonly frozen: number;
}

/**
 * The sensors that can accept nothing their probe measures, because its clock is behind their
 * last result (`P-232`).
 *
 * **One predicate, and it is exact.** A sensor is frozen when its last accepted result is stamped
 * later than its probe's clock reads now, less a tolerance. While that holds `isStaleResult` must
 * drop every result the probe sends, since each is stamped at or before its current clock. No
 * duplicate and no replay can make it true: anything a probe sends again was measured at or
 * before its clock, so a sensor that only ever accepted such results has a watermark no later
 * than it. It is true only when the probe's clock now reads earlier than a stamp it produced
 * before — an RTC reset at boot, NTP correcting a fast clock, a VM restored from a snapshot —
 * and it stays true for exactly that difference.
 *
 * **Bounded the way a lost probe is.** A frozen sensor is Unknown with cause `probe`: nothing
 * can be applied, so nothing is known, which is `WORKFLOW.MD`'s answer for an unreachable probe.
 * The set is laid over the facts by the state service at the same point as the unreachable one
 * and moved with the same `reevaluate` and dependency recompute, so whatever a lost probe's
 * sensors do to alarms, these do and no more.
 *
 * **Not a re-base of the watermark.** Results carry no clock of their own; after a step, one the
 * probe measured before it and sends again cannot be told from one measured after, and applying
 * it would put the watermark back where it was and freeze the sensor again.
 *
 * Kept across a disconnect, so a probe that comes back with its clock still behind does not
 * show its sensors' last readings for a sweep before they freeze again. Decided only while the
 * probe's offset is known: a session that has sent no `sentAt` yet changes nothing. **Kept in
 * step with the tree**, though, whether the probe is connected or not: `resync` drops a sensor
 * from a probe's set once it is no longer under that probe (`P-239`).
 *
 * **The global set is the union of the per-probe sets** (`P-239`). One sensor can be in two:
 * moved off a probe whose set was never brought up to date, and frozen again by the one it went
 * to. It stays frozen while any probe's set holds it.
 */
export class ClockFreeze {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #states: StateReevaluator;
  readonly #dependencies: DependencyRecomputer;
  readonly #links: ClockFreezeOptions['links'];
  readonly #coreEvaluatedTypes: readonly string[];
  readonly #probeAlarms: (probeObjectId: number) => readonly number[];
  readonly #now: () => Date;

  /** Every frozen sensor: the union of `#byProbe`. What the state service lays over the facts. */
  readonly #frozen = new Set<number>();
  /** Which probe froze which sensors, so one probe's answer never clears another's. */
  readonly #byProbe = new Map<number, ReadonlySet<number>>();
  /** When each probe's clock first froze something, while it still does (`M-22`). */
  readonly #since = new Map<number, Date>();
  /** Which probe froze each sensor; the one that froze it last, when two sets hold it. */
  readonly #carrier = new Map<number, number>();
  /** `#frozen`, each with `FROZEN_MESSAGE` (`P-413`). */
  readonly #words = heldIn(() => this.#frozen, { message: FROZEN_MESSAGE, failure: null });
  #sweeps = 0;

  constructor(options: ClockFreezeOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'clock-freeze' });
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#links = options.links;
    this.#coreEvaluatedTypes = options.coreEvaluatedTypes ?? [];
    this.#probeAlarms = options.probeAlarms ?? ((): readonly number[] => []);
    this.#now = options.now ?? ((): Date => new Date());
  }

  frozenSensors(): ReadonlySet<number> {
    return this.#frozen;
  }

  /**
   * The frozen sensors, each with what it says while frozen (`P-413`): what the state service lays
   * over the facts, and says, unless its probe's link is gone or it is silent. A view.
   */
  heldWords(): HeldWordsLookup {
    return this.#words;
  }

  /** How many of one probe's sensors are frozen, for its Probe Health. */
  frozenOn(probeObjectId: number): number {
    return this.#byProbe.get(probeObjectId)?.size ?? 0;
  }

  /** What this probe's clock freezes, and since when, while it freezes anything (`M-22`). */
  frozenBy(probeObjectId: number): { sensorIds: ReadonlySet<number>; since: Date } | undefined {
    const sensorIds = this.#byProbe.get(probeObjectId);
    const since = this.#since.get(probeObjectId);
    return sensorIds === undefined || since === undefined ? undefined : { sensorIds, since };
  }

  /** The probe whose clock froze this sensor, while it is frozen (`M-22`). */
  carrierOf(sensorId: number): number | undefined {
    return this.#carrier.get(sensorId);
  }

  stats(): ClockFreezeStats {
    return { sweeps: this.#sweeps, frozen: this.#frozen.size };
  }

  /** Decides every connected probe whose offset is known. Returns the sensors that moved. */
  async sweep(): Promise<number> {
    this.#sweeps += 1;
    let moved = 0;
    for (const probeObjectId of this.#links.connectedProbeIds()) {
      const link = this.#links.linkFor(probeObjectId);
      if (!link.connected || link.clockOffsetMs === null) continue;
      const now = this.#now();
      // The probe's clock now, plus the tolerance: a last result later than this is one the
      // probe's clock has not reached.
      const threshold = new Date(now.getTime() - link.clockOffsetMs + CLOCK_FREEZE_TOLERANCE_MS);
      const frozen = await this.#frozenUnder(probeObjectId, threshold);
      moved += await this.#settle(probeObjectId, frozen, link.clockOffsetMs);
    }
    return moved;
  }

  /**
   * Brings what each probe freezes into step with the tree, through the transaction of a
   * mutation that may have moved sensors (`P-239`). Returns the sensors that moved.
   *
   * **From the stored sets, whether the probe is connected or not.** A probe decides its sensors
   * only on its own sweep, and a sweep reaches only a connected probe. A sensor moved off a
   * frozen probe that had since gone away was never decided again, and stayed Unknown with cause
   * `probe` on its new, healthy probe for as long as the old one stayed away: `P-103`'s defect,
   * in this overlay. Here each set keeps only the sensors still under its probe, and the ones
   * that left are thawed as a sweep thaws them, with the probe's alarm and the dependency
   * recompute.
   *
   * **Only ever removes.** Freezing a sensor that arrived under a frozen probe needs that probe's
   * clock, which only its sweep has; until then a lost probe's arrivals are Unknown through
   * `ProbeReachability`'s own resync.
   *
   * **A failure is the mutation's.** The sets go back first (`P-80`), and the error is thrown
   * rather than logged: the transaction is aborted by then, and PostgreSQL answers a COMMIT on an
   * aborted transaction by rolling back, without an error, so a caught error would leave the
   * caller told that a mutation succeeded when nothing of it was written.
   *
   * Free when nothing is frozen, which is the normal state of an installation.
   */
  async resync(q: Queryable): Promise<number> {
    let moved = 0;
    for (const [probeObjectId, held] of [...this.#byProbe]) {
      const still = await this.#stillUnder(q, probeObjectId, held);
      const gone = new Set([...held].filter((id) => !still.has(id)));
      if (gone.size === 0) continue;
      // Taken from the set as it is now, not as it was read: a sweep may have changed it while
      // the tree was being read, and only what the tree says left is this method's to remove.
      const current = this.#byProbe.get(probeObjectId) ?? new Set<number>();
      const next = new Set([...current].filter((id) => !gone.has(id)));
      moved += await this.#settle(probeObjectId, next, null, q);
    }
    return moved;
  }

  /**
   * Replaces what one probe freezes, and moves the sensors that crossed. In a transaction of its
   * own, unless it is handed the caller's.
   *
   * **The set changes before the re-evaluation runs, and back if the write does not land**, for
   * the reason `ProbeReachability.lost` gives (`P-80`): the state service reads the set, so it
   * has to be right first, and a set left changed after a rejected transaction claims a state
   * that was never written.
   *
   * **Thawed only when no probe's set still holds it** (`P-239`). A sensor that leaves this
   * probe's set and is in another's stays frozen, carried by the other, and is not re-evaluated.
   */
  async #settle(
    probeObjectId: number,
    next: ReadonlySet<number>,
    offsetMs: number | null,
    caller?: Queryable,
  ): Promise<number> {
    const before = this.#byProbe.get(probeObjectId) ?? new Set<number>();
    const entered = [...next].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !next.has(id));
    if (entered.length === 0 && left.length === 0) return 0;

    const since = this.#since.get(probeObjectId) ?? this.#now();
    // Who carried each sensor this touches, so a failure puts every one of them back.
    const carriers = new Map([...entered, ...left].map((id) => [id, this.#carrier.get(id)]));
    this.#place(probeObjectId, next, since);
    for (const id of entered) {
      this.#frozen.add(id);
      this.#carrier.set(id, probeObjectId);
    }
    const thawed: number[] = [];
    for (const id of left) {
      const other = this.#holderOf(id);
      if (other === undefined) {
        this.#frozen.delete(id);
        this.#carrier.delete(id);
        thawed.push(id);
      } else if (this.#carrier.get(id) === probeObjectId) {
        this.#carrier.set(id, other);
      }
    }
    const restore = (): void => {
      this.#place(probeObjectId, before, since);
      for (const [id, carrier] of carriers) {
        if (carrier === undefined) {
          this.#frozen.delete(id);
          this.#carrier.delete(id);
        } else {
          this.#frozen.add(id);
          this.#carrier.set(id, carrier);
        }
      }
    };

    const move = async (q: Queryable): Promise<number> => {
      const at = this.#now();
      let count = 0;
      if (entered.length > 0) {
        count += await this.#states.reevaluate(q, entered, at, {
          message: FROZEN_MESSAGE,
          sources: PROBE_SOURCE,
        });
      }
      if (thawed.length > 0) {
        count += await this.#states.reevaluate(q, thawed, at, {
          message: THAWED_MESSAGE,
          sources: PROBE_SOURCE,
        });
      }
      // The probe's own alarm, so what a trigger sees on it moves with them (`M-22`).
      const alarms = this.#probeAlarms(probeObjectId);
      if (alarms.length > 0) {
        await this.#states.reevaluate(q, alarms, at, {
          message: THAWED_MESSAGE,
          sources: PROBE_SOURCE,
        });
      }
      // As for a lost probe (`P-135`): a master that is Unknown is not Down, so whatever it
      // held is released, and one that is thawed may hold them again.
      await this.#dependencies.recompute(q, at);
      return count;
    };
    try {
      const moved = caller === undefined ? await this.#db.tx(move) : await move(caller);
      this.#logger.warn(
        { probeObjectId, frozen: entered.length, thawed: thawed.length, offsetMs, moved },
        entered.length > 0
          ? "sensors frozen: the probe's clock reads earlier than their last results"
          : caller === undefined
            ? "sensors thawed: the probe's clock has passed their last results"
            : 'sensors thawed: the tree moved them off the probe whose clock froze them',
      );
      return moved;
    } catch (error) {
      restore();
      this.#logger.error(
        { probeObjectId, sensors: entered.length + left.length, err: describeError(error) },
        caller === undefined
          ? 'could not move the sensors a probe clock froze or thawed; the next sweep tries again'
          : 'could not thaw the sensors a tree change moved off a frozen probe; the change fails',
      );
      if (caller !== undefined) throw error;
      return 0;
    }
  }

  /** Sets one probe's set, and when it began, or clears both when the set is empty. */
  #place(probeObjectId: number, sensors: ReadonlySet<number>, since: Date): void {
    if (sensors.size === 0) {
      this.#byProbe.delete(probeObjectId);
      this.#since.delete(probeObjectId);
    } else {
      this.#byProbe.set(probeObjectId, sensors);
      this.#since.set(probeObjectId, since);
    }
  }

  /** A probe whose set holds this sensor, if any does. */
  #holderOf(sensorId: number): number | undefined {
    for (const [probeObjectId, sensors] of this.#byProbe) {
      if (sensors.has(sensorId)) return probeObjectId;
    }
    return undefined;
  }

  /** Which of `held` are still under the probe, read through the caller's transaction. */
  async #stillUnder(
    q: Queryable,
    probeObjectId: number,
    held: ReadonlySet<number>,
  ): Promise<ReadonlySet<number>> {
    const rows = await q.query<{ id: string }>(STILL_UNDER_SQL, [probeObjectId, [...held]]);
    return new Set(rows.map((row) => Number(row.id)));
  }

  /** The sensors under a probe whose last result is later than `threshold`. */
  async #frozenUnder(probeObjectId: number, threshold: Date): Promise<ReadonlySet<number>> {
    const rows = await this.#db.query<{ id: string }>(FROZEN_UNDER_SQL, [
      probeObjectId,
      [...this.#coreEvaluatedTypes],
      threshold,
    ]);
    return new Set(rows.map((row) => Number(row.id)));
  }
}
