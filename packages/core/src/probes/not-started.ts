import { describeError, type CheckFailure, type CheckResult, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import { sameHeldWords, type HeldWords, type HeldWordsLookup } from '../state/runtime.js';
import {
  PROBE_SOURCE,
  type DependencyRecomputer,
  type ReachabilityStates,
} from './reachability.js';

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
  /**
   * The same two a lost probe moves its sensors with, so the three are one path. Its
   * `forgetSensors` too: a release lets a sensor go without re-deciding it, and its next result
   * is decided from the stored row (`P-409`), though since `P-412` nothing cached says its probe
   * cannot run it.
   */
  readonly states: ReachabilityStates;
  readonly dependencies: DependencyRecomputer;
  /** The sensors that are a probe's own alarm, re-evaluated with the ones it holds (`M-22`). */
  readonly probeAlarms?: (probeObjectId: number) => readonly number[];
  readonly now?: () => Date;
}

/**
 * What one probe holds: each sensor, by when its last check that could not start was made, and
 * what that check said and where it stopped (`P-410`).
 */
interface Held {
  readonly at: number;
  /**
   * When this core placed it, against every other probe's holds: the one placed last carries the
   * sensor. A probe's `at` is its own clock, and orders nothing between two probes.
   */
  readonly order: number;
  readonly words: HeldWords;
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

/** What a check that could not start said, and where it stopped: none from below protocol 35. */
function wordsOf(result: CheckResult): HeldWords {
  return { message: result.message, failure: result.failure ?? null };
}

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
 * **Its words are the latest round's** (`P-410`). Each round names its own start-up time and the
 * check process's last output, or the pool's give-up, so the state service reads them live from
 * `heldWords`, as it reads a withheld sensor's, and a sensor held again in other words says them
 * with no transition. Two probes hold one sensor only when it moved between their batches; it
 * says the words of the one this core placed it under last, and a put-back keeps its own place
 * in that order, so it never takes the carrier from a hold made since.
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
  readonly #states: ReachabilityStates;
  readonly #dependencies: DependencyRecomputer;
  readonly #probeAlarms: (probeObjectId: number) => readonly number[];
  readonly #now: () => Date;

  /** Every held sensor: the union of `#byProbe`. What the state service lays over the facts. */
  readonly #held = new Set<number>();
  /** Which probe holds which sensors. */
  readonly #byProbe = new Map<number, Map<number, Held>>();
  /** When each probe first held something, while it still does (`M-22`). */
  readonly #since = new Map<number, Date>();
  /** The last `Held.order` given. */
  #placed = 0;
  /** `#held`, with each sensor's words from the probe carrying it. Allocated once. */
  readonly #words: HeldWordsLookup;

  constructor(options: NotStartedOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'not-started' });
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#probeAlarms = options.probeAlarms ?? ((): readonly number[] => []);
    this.#now = options.now ?? ((): Date => new Date());
    const held = this.#held;
    this.#words = {
      get size(): number {
        return held.size;
      },
      has: (sensorId) => held.has(sensorId),
      get: (sensorId) => this.#wordsOf(sensorId),
    };
  }

  heldSensors(): ReadonlySet<number> {
    return this.#held;
  }

  /**
   * The held sensors, each with what its carrier's last check that could not start said and
   * where it stopped (`P-410`). What the state service lays over the facts, and says. A view: it
   * reads the sets as they are, so a hold put back after a write that failed reads as it was.
   */
  heldWords(): HeldWordsLookup {
    return this.#words;
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

  /** The probe that holds this sensor, while one does; the one that held it last, when two do (`M-22`). */
  carrierOf(sensorId: number): number | undefined {
    return this.#carrying(sensorId)?.probeObjectId;
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
    // What each sensor says now, which is its carrier's words: another probe's, when that one held
    // it last.
    const said = new Map(
      entering.map((result) => [result.sensorId, this.#wordsOf(result.sensorId)]),
    );
    const next = new Map(current);
    for (const result of entering) {
      this.#placed += 1;
      next.set(result.sensorId, {
        at: Date.parse(result.at),
        order: this.#placed,
        words: wordsOf(result),
      });
      this.#held.add(result.sensorId);
    }
    this.#place(probeObjectId, next, since);
    // New to this probe's set moves its alarm with it. Held again in words or a place other than
    // the sensor says is reworded, with no transition, and moves nothing else (`P-410`). The same
    // words and place move the hold forward and open nothing.
    const entered = entering.filter((result) => !before.has(result.sensorId));
    const reworded = entering.filter(
      (result) =>
        before.has(result.sensorId) && !sameHeldWords(said.get(result.sensorId), wordsOf(result)),
    );
    const toMove = [...entered, ...reworded];
    try {
      if (toMove.length > 0) {
        await this.#db.tx(async (q) => {
          const at = this.#now();
          // One re-decision per sentence and place it stopped, so one sensor's failure is never
          // stored beside another's words (`P-407`). A probe below protocol 35 names none.
          const byWords = new Map<
            string,
            { message: string; failure: CheckFailure | null; ids: number[] }
          >();
          for (const result of toMove) {
            const failure = result.failure ?? null;
            const key = JSON.stringify([
              result.message,
              failure?.phase ?? null,
              failure?.target ?? null,
            ]);
            const group = byWords.get(key) ?? { message: result.message, failure, ids: [] };
            group.ids.push(result.sensorId);
            byWords.set(key, group);
          }
          for (const { message, failure, ids } of byWords.values()) {
            await this.#states.reevaluate(q, ids, at, { message, sources: PROBE_SOURCE, failure });
          }
          if (entered.length > 0) await this.#moveAlarms(q, probeObjectId, at);
        });
      }
    } catch (error) {
      this.#place(probeObjectId, before, since);
      this.#recount(entering.map((result) => result.sensorId));
      this.#logger.error(
        { probeObjectId, sensors: entering.length, err: describeError(error) },
        'could not hold the sensors whose checks a probe could not start; the batch is refused',
      );
      throw error;
    }
    if (entered.length > 0) {
      this.#logger.warn(
        {
          probeObjectId,
          held: entered.length,
          sensorIds: entered.slice(0, 20).map((r) => r.sensorId),
        },
        'sensors held Unknown: their probe could not start their checks',
      );
    }
    if (reworded.length > 0) {
      this.#logger.debug(
        { probeObjectId, reworded: reworded.length },
        'sensors held again in new words: their probe still cannot start their checks',
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
    this.#recount(letGo.keys());
    // **Decided from the row, not from what was cached while held** (`P-409`, as `A-41c`'s
    // release). A started result older than the hold, decided while the sensor was held, left it
    // cached with the probe unable to run it, and the result letting it go was decided from that:
    // Unknown again, and every result after it, a real Down included, until something re-decided
    // the sensor. Since `P-412` nothing cached carries the hold, so this is a re-read of the row.
    this.#states.forgetSensors([...letGo.keys()]);
    return {
      released: letGo.size,
      stored: (landed) => {
        if (landed) return;
        // Put back what is still missing: a hold made since, by a later batch, stands.
        const now = this.#byProbe.get(probeObjectId) ?? new Map<number, Held>();
        const back = new Map(now);
        // Each in its own place in the order, so the carrier is the one that held it last: a hold
        // made since by another probe keeps it, and its words (`P-410`).
        for (const [id, held] of letGo) {
          if (!back.has(id)) back.set(id, held);
        }
        this.#place(probeObjectId, back, this.#since.get(probeObjectId) ?? since);
        this.#recount(letGo.keys());
        // Held again: what was cached for a result nobody stored must not go on saying it is let
        // go.
        this.#states.forgetSensors([...letGo.keys()]);
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
      this.#place(probeObjectId, new Map([...current].filter(([id]) => !gone.includes(id))), since);
      this.#recount(gone);
      const freed = gone.filter((id) => !this.#held.has(id));
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
        this.#recount(gone);
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

  /** What the probe carrying this sensor last said of it, if any holds it. */
  #wordsOf(sensorId: number): HeldWords | undefined {
    return this.#carrying(sensorId)?.held.words;
  }

  /** The probe that placed its hold of this sensor last, of those that hold it, and that hold. */
  #carrying(sensorId: number): { probeObjectId: number; held: Held } | undefined {
    let carrying: { probeObjectId: number; held: Held } | undefined;
    for (const [probeObjectId, sensors] of this.#byProbe) {
      const held = sensors.get(sensorId);
      if (held !== undefined && (carrying === undefined || held.order > carrying.held.order)) {
        carrying = { probeObjectId, held };
      }
    }
    return carrying;
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

  /** Keeps `#held` the union of the sets for these sensors, once the sets have changed. */
  #recount(sensorIds: Iterable<number>): void {
    for (const id of sensorIds) {
      if (this.#carrying(id) === undefined) this.#held.delete(id);
      else this.#held.add(id);
    }
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
