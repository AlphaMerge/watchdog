import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { ProbeLink } from '../transport/probe-endpoint.js';
import type { DependencyRecomputer, StateReevaluator } from './reachability.js';

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

const THAWED_MESSAGE = "the probe's clock has passed the last result this sensor accepted";

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
 * probe's offset is known: a session that has sent no `sentAt` yet changes nothing.
 */
export class ClockFreeze {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #states: StateReevaluator;
  readonly #dependencies: DependencyRecomputer;
  readonly #links: ClockFreezeOptions['links'];
  readonly #coreEvaluatedTypes: readonly string[];
  readonly #now: () => Date;

  /** Every frozen sensor. What the state service lays over the facts. */
  readonly #frozen = new Set<number>();
  /** Which probe froze which sensors, so one probe's answer never clears another's. */
  readonly #byProbe = new Map<number, ReadonlySet<number>>();
  #sweeps = 0;

  constructor(options: ClockFreezeOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'clock-freeze' });
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#links = options.links;
    this.#coreEvaluatedTypes = options.coreEvaluatedTypes ?? [];
    this.#now = options.now ?? ((): Date => new Date());
  }

  frozenSensors(): ReadonlySet<number> {
    return this.#frozen;
  }

  /** How many of one probe's sensors are frozen, for its Probe Health. */
  frozenOn(probeObjectId: number): number {
    return this.#byProbe.get(probeObjectId)?.size ?? 0;
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
   * Replaces what one probe freezes, and moves the sensors that crossed.
   *
   * **The set changes before the re-evaluation runs, and back if the write does not land**, for
   * the reason `ProbeReachability.lost` gives (`P-80`): the state service reads the set, so it
   * has to be right first, and a set left changed after a rejected transaction claims a state
   * that was never written.
   */
  async #settle(
    probeObjectId: number,
    next: ReadonlySet<number>,
    offsetMs: number,
  ): Promise<number> {
    const before = this.#byProbe.get(probeObjectId) ?? new Set<number>();
    const entered = [...next].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !next.has(id));
    if (entered.length === 0 && left.length === 0) return 0;

    const apply = (frozen: ReadonlySet<number>, thawed: readonly number[]): void => {
      for (const id of thawed) this.#frozen.delete(id);
      for (const id of frozen) this.#frozen.add(id);
      if (frozen.size === 0) this.#byProbe.delete(probeObjectId);
      else this.#byProbe.set(probeObjectId, frozen);
    };
    apply(next, left);

    try {
      const moved = await this.#db.tx(async (q) => {
        const at = this.#now();
        let count = 0;
        if (entered.length > 0) {
          count += await this.#states.reevaluate(q, entered, at, { message: FROZEN_MESSAGE });
        }
        if (left.length > 0) {
          count += await this.#states.reevaluate(q, left, at, { message: THAWED_MESSAGE });
        }
        // As for a lost probe (`P-135`): a master that is Unknown is not Down, so whatever it
        // held is released, and one that is thawed may hold them again.
        await this.#dependencies.recompute(q, at);
        return count;
      });
      this.#logger.warn(
        { probeObjectId, frozen: entered.length, thawed: left.length, offsetMs, moved },
        entered.length > 0
          ? "sensors frozen: the probe's clock reads earlier than their last results"
          : "sensors thawed: the probe's clock has passed their last results",
      );
      return moved;
    } catch (error) {
      apply(before, entered);
      this.#logger.error(
        { probeObjectId, sensors: entered.length + left.length, err: describeError(error) },
        'could not move the sensors a probe clock froze or thawed; the next sweep tries again',
      );
      return 0;
    }
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
