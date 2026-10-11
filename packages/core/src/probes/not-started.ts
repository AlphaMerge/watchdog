import { describeError, type CheckResult, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import { PROBE_SOURCE, type DependencyRecomputer, type StateReevaluator } from './reachability.js';

/** What a sensor let go by a tree change says until its next result. */
export const MOVED_OFF_MESSAGE =
  'no longer under the probe that could not start its check; until its next result it stands ' +
  'where it stood before';

/** Which of the sensors `$2` are still under the probe `$1`: `ClockFreeze`'s walk. */
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

/** When each of the sensors `$1` last took a result. */
const LAST_RESULT_SQL = `SELECT object_id::text AS id, last_result_at
  FROM sensor_runtime WHERE object_id = ANY($1::bigint[])`;

interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface NotStartedOptions {
  readonly db: Db;
  readonly logger: Logger;
  /** The same two a lost probe moves its sensors with, so the three are one path. */
  readonly states: StateReevaluator;
  readonly dependencies: DependencyRecomputer;
  /** The sensors that are a probe's own alarm, re-evaluated with the ones it holds (`M-22`). */
  readonly probeAlarms?: (probeObjectId: number) => readonly number[];
  readonly now?: () => Date;
}

/** What one probe holds: each sensor, by when its last check that could not start was made. */
interface Held {
  readonly at: number;
  readonly message: string;
}

/** A batch's results with the ones that could not start taken out, and how many were held. */
export interface HeldBatch {
  readonly results: readonly CheckResult[];
  /** Sensors this batch held, or held again by a later result. */
  readonly held: number;
  /**
   * Results that could not start and hold nothing: a later one of the same sensor in the batch,
   * a started one at or after it, or no later than what the sensor already has. A resend.
   */
  readonly dropped: number;
}

/** What a batch let go, to be put back when it is not stored. */
export interface ReleasedBatch {
  readonly released: number;
  stored(landed: boolean): void;
}

const NOTHING_RELEASED: ReleasedBatch = { released: 0, stored: () => undefined };

/**
 * The sensors whose last check their probe could not start (`P-265`).
 *
 * **The probe's fault, so the probe's alarm.** A check the probe could not start — its check
 * process never reached its ready line (`P-260`), or the worker pool gave up before it was run —
 * never asked the device anything. Taken as a failed scan, a starved probe turned every script
 * sensor it carries Down at once, one alarm each. The probe marks these results `notStarted`
 * (protocol 33), and the sensor is held Unknown with cause `probe` instead, with the probe's own
 * sentence, carried behind Probe Health's one alarm as a lost probe's sensors are: laid over the
 * facts by the state service at the same point, moved with the same `reevaluate` and dependency
 * recompute, and joined to the probe's episode.
 *
 * **Let go by its next result, which decides it in one step.** A sensor held here has a result
 * coming: its probe keeps scheduling it. The first one that started, and is later than the hold,
 * takes it out of the set *before* the batch reaches the state machine, without a re-evaluation,
 * so it goes from Unknown to whatever that result says in one transition. If the batch is not
 * stored the probe sends it again, so the sensor is put back until it is.
 *
 * **Not persisted**, as `ClockFreeze` is not. A core that restarts reads the sensor as it was
 * written, Unknown with the probe's words, until its next result.
 *
 * **Kept in step with the tree** by `resync`, as `ClockFreeze` is (`P-239`): a sensor moved off
 * the probe, or deleted, is let go, since the probe that could not start it will not send it
 * again.
 */
export class NotStarted {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #states: StateReevaluator;
  readonly #dependencies: DependencyRecomputer;
  readonly #probeAlarms: (probeObjectId: number) => readonly number[];
  readonly #now: () => Date;

  /** Every held sensor: the union of `#byProbe`. What the state service lays over the facts. */
  readonly #held = new Set<number>();
  /** Which probe holds which sensors. */
  readonly #byProbe = new Map<number, Map<number, Held>>();
  /** When each probe first held something, while it still does (`M-22`). */
  readonly #since = new Map<number, Date>();
  /** Which probe holds each sensor; the one that held it last, when two do. */
  readonly #carrier = new Map<number, number>();

  constructor(options: NotStartedOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'not-started' });
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#probeAlarms = options.probeAlarms ?? ((): readonly number[] => []);
    this.#now = options.now ?? ((): Date => new Date());
  }

  heldSensors(): ReadonlySet<number> {
    return this.#held;
  }

  /** How many of one probe's sensors are held, for its Probe Health. */
  heldOn(probeObjectId: number): number {
    return this.#byProbe.get(probeObjectId)?.size ?? 0;
  }

  /** What this probe holds, and since when, while it holds anything (`M-22`). */
  heldBy(probeObjectId: number): { sensorIds: ReadonlySet<number>; since: Date } | undefined {
    const held = this.#byProbe.get(probeObjectId);
    const since = this.#since.get(probeObjectId);
    return held === undefined || since === undefined
      ? undefined
      : { sensorIds: new Set(held.keys()), since };
  }

  /** The probe that holds this sensor, while one does (`M-22`). */
  carrierOf(sensorId: number): number | undefined {
    return this.#carrier.get(sensorId);
  }

  /**
   * Takes the results a probe could not start out of its batch, and holds their sensors.
   *
   * **The sensor's last word in the batch decides.** A check that could not start and then one
   * that ran leaves the sensor to the one that ran, which `release` lets go; the other way round
   * holds it. A result no later than the sensor's last accepted one, or than the hold it already
   * has, is a resend of something already decided, and is dropped and counted.
   *
   * A failure is the batch's: the sets go back and the error is thrown, so the batch is refused
   * and sent again.
   */
  async hold(probeObjectId: number, results: readonly CheckResult[]): Promise<HeldBatch> {
    if (!results.some((result) => result.notStarted === true)) {
      return { results, held: 0, dropped: 0 };
    }
    const unstarted = (result: CheckResult): boolean =>
      result.notStarted === true && !Number.isNaN(Date.parse(result.at));
    // A time nobody can read orders against nothing: left for the machine's own gate, which
    // drops and counts it.
    const kept = results.filter((result) => !unstarted(result));
    const marked = results.filter(unstarted);
    /** Each sensor's latest result that could not start. */
    const latest = new Map<number, CheckResult>();
    for (const result of marked) {
      const before = latest.get(result.sensorId);
      if (before === undefined || Date.parse(before.at) < Date.parse(result.at)) {
        latest.set(result.sensorId, result);
      }
    }
    // Unless a check of the same sensor in this batch started at or after it.
    const candidates = [...latest.values()].filter(
      (result) =>
        !kept.some(
          (one) =>
            one.sensorId === result.sensorId &&
            one.notStarted !== true &&
            Date.parse(one.at) >= Date.parse(result.at),
        ),
    );
    const last = await this.#lastResults(candidates.map((result) => result.sensorId));
    const current = this.#byProbe.get(probeObjectId);
    const entering = candidates.filter((result) => {
      const at = Date.parse(result.at);
      const known = last.get(result.sensorId);
      if (known !== undefined && known !== null && at <= known.getTime()) return false;
      const holding = current?.get(result.sensorId);
      return holding === undefined || at > holding.at;
    });
    const dropped = marked.length - entering.length;
    if (entering.length === 0) return { results: kept, held: 0, dropped };

    const before = new Map(current);
    const since = this.#since.get(probeObjectId) ?? this.#now();
    const carriers = new Map(
      entering.map((result) => [result.sensorId, this.#carrier.get(result.sensorId)]),
    );
    const next = new Map(current);
    for (const result of entering) {
      next.set(result.sensorId, { at: Date.parse(result.at), message: result.message });
      this.#held.add(result.sensorId);
      this.#carrier.set(result.sensorId, probeObjectId);
    }
    this.#place(probeObjectId, next, since);
    // Only the ones whose words changed are re-decided: a sensor held already in the same words
    // has its hold moved forward and nothing else.
    const toMove = entering.filter(
      (result) => before.get(result.sensorId)?.message !== result.message,
    );
    try {
      if (toMove.length > 0) {
        await this.#db.tx(async (q) => {
          const at = this.#now();
          const byMessage = new Map<string, number[]>();
          for (const result of toMove) {
            const ids = byMessage.get(result.message) ?? [];
            ids.push(result.sensorId);
            byMessage.set(result.message, ids);
          }
          for (const [message, ids] of byMessage) {
            await this.#states.reevaluate(q, ids, at, { message, sources: PROBE_SOURCE });
          }
          await this.#moveAlarms(q, probeObjectId, at);
        });
      }
    } catch (error) {
      this.#place(probeObjectId, before, since);
      for (const [id, carrier] of carriers) {
        if (carrier === undefined) {
          this.#held.delete(id);
          this.#carrier.delete(id);
        } else {
          this.#carrier.set(id, carrier);
        }
      }
      this.#logger.error(
        { probeObjectId, sensors: entering.length, err: describeError(error) },
        'could not hold the sensors whose checks a probe could not start; the batch is refused',
      );
      throw error;
    }
    if (toMove.length > 0) {
      this.#logger.warn(
        {
          probeObjectId,
          held: toMove.length,
          sensorIds: toMove.slice(0, 20).map((r) => r.sensorId),
        },
        'sensors held Unknown: their probe could not start their checks',
      );
    }
    return { results: kept, held: entering.length, dropped };
  }

  /**
   * Lets go the sensors this batch has a started result for, later than their hold, without
   * re-deciding them: the result does, in one step. Called with what is left of the batch once
   * everything that is not a result has been taken out, so only a result that will be stored
   * lets a sensor go. `stored(false)` puts them back.
   */
  release(probeObjectId: number, results: readonly CheckResult[]): ReleasedBatch {
    const current = this.#byProbe.get(probeObjectId);
    if (current === undefined) return NOTHING_RELEASED;
    const letGo = new Map<number, Held>();
    for (const result of results) {
      if (result.notStarted === true) continue;
      const holding = current.get(result.sensorId);
      if (holding !== undefined && Date.parse(result.at) > holding.at) {
        letGo.set(result.sensorId, holding);
      }
    }
    if (letGo.size === 0) return NOTHING_RELEASED;

    const since = this.#since.get(probeObjectId) ?? this.#now();
    const next = new Map([...current].filter(([id]) => !letGo.has(id)));
    this.#place(probeObjectId, next, since);
    const carriers = new Map<number, number | undefined>();
    for (const id of letGo.keys()) {
      carriers.set(id, this.#carrier.get(id));
      this.#forget(id, probeObjectId);
    }
    return {
      released: letGo.size,
      stored: (landed) => {
        if (landed) return;
        // Put back what is still missing: a hold made since, by a later batch, stands.
        const now = this.#byProbe.get(probeObjectId) ?? new Map<number, Held>();
        const back = new Map(now);
        for (const [id, held] of letGo) {
          if (back.has(id)) continue;
          back.set(id, held);
          this.#held.add(id);
          const carrier = carriers.get(id);
          this.#carrier.set(id, carrier ?? probeObjectId);
        }
        this.#place(probeObjectId, back, this.#since.get(probeObjectId) ?? since);
      },
    };
  }

  /**
   * Brings each probe's set into step with the tree, through the transaction of a mutation that
   * may have moved sensors, as `ClockFreeze.resync` does (`P-239`). A sensor no longer under the
   * probe that held it is let go and re-decided, with the probe's alarm and the dependency
   * recompute. A failure is the mutation's: the sets go back and the error is thrown.
   *
   * Free when nothing is held, which is the normal state of an installation.
   */
  async resync(q: Queryable): Promise<number> {
    let moved = 0;
    for (const [probeObjectId, held] of [...this.#byProbe]) {
      const rows = await q.query<{ id: string }>(STILL_UNDER_SQL, [
        probeObjectId,
        [...held.keys()],
      ]);
      const still = new Set(rows.map((row) => Number(row.id)));
      const gone = [...held.keys()].filter((id) => !still.has(id));
      if (gone.length === 0) continue;

      const current = this.#byProbe.get(probeObjectId) ?? new Map<number, Held>();
      const since = this.#since.get(probeObjectId) ?? this.#now();
      const before = new Map(current);
      const carriers = new Map(gone.map((id) => [id, this.#carrier.get(id)]));
      this.#place(probeObjectId, new Map([...current].filter(([id]) => !gone.includes(id))), since);
      const freed = gone.filter((id) => {
        this.#forget(id, probeObjectId);
        return !this.#held.has(id);
      });
      try {
        const at = this.#now();
        if (freed.length > 0) {
          moved += await this.#states.reevaluate(q, freed, at, {
            message: MOVED_OFF_MESSAGE,
            sources: PROBE_SOURCE,
          });
        }
        await this.#moveAlarms(q, probeObjectId, at);
      } catch (error) {
        this.#place(probeObjectId, before, since);
        for (const [id, carrier] of carriers) {
          this.#held.add(id);
          this.#carrier.set(id, carrier ?? probeObjectId);
        }
        this.#logger.error(
          { probeObjectId, sensors: gone.length, err: describeError(error) },
          'could not let go the sensors a tree change moved off the probe that held them; the ' +
            'change fails',
        );
        throw error;
      }
      this.#logger.info(
        { probeObjectId, released: freed.length },
        'sensors let go: the tree moved them off the probe that could not start their checks',
      );
    }
    return moved;
  }

  /** The probe's own alarm and the dependency recompute, as `ClockFreeze` moves them. */
  async #moveAlarms(q: Queryable, probeObjectId: number, at: Date): Promise<void> {
    const alarms = this.#probeAlarms(probeObjectId);
    if (alarms.length > 0) {
      await this.#states.reevaluate(q, alarms, at, { message: '', sources: PROBE_SOURCE });
    }
    // As for a lost probe (`P-135`): a master that is Unknown is not Down, so whatever it held is
    // released.
    await this.#dependencies.recompute(q, at);
  }

  /**
   * Takes a sensor out of the union once no probe's set holds it, and hands it to the probe that
   * still does when another does.
   */
  #forget(sensorId: number, probeObjectId: number): void {
    for (const [other, held] of this.#byProbe) {
      if (other !== probeObjectId && held.has(sensorId)) {
        if (this.#carrier.get(sensorId) === probeObjectId) this.#carrier.set(sensorId, other);
        return;
      }
    }
    this.#held.delete(sensorId);
    this.#carrier.delete(sensorId);
  }

  /** Sets one probe's set, and when it began, or clears both when the set is empty. */
  #place(probeObjectId: number, sensors: ReadonlyMap<number, Held>, since: Date): void {
    if (sensors.size === 0) {
      this.#byProbe.delete(probeObjectId);
      this.#since.delete(probeObjectId);
    } else {
      this.#byProbe.set(probeObjectId, new Map(sensors));
      this.#since.set(probeObjectId, since);
    }
  }

  /** When each of these sensors last took a result, read from the database. */
  async #lastResults(sensorIds: readonly number[]): Promise<Map<number, Date | null>> {
    if (sensorIds.length === 0) return new Map();
    const rows = await this.#db.query<{ id: string; last_result_at: Date | null }>(
      LAST_RESULT_SQL,
      [[...sensorIds]],
    );
    return new Map(rows.map((row) => [Number(row.id), row.last_result_at]));
  }
}
