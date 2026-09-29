import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { WithheldDependencies, WithheldReevaluator } from '../objects/vouching.js';

/** The Sensor Factory's type id, the one sensor type the core holds for its inputs' probe. */
export const FACTORY_SENSOR_TYPE = 'core.factory';

/** What a factory held Unknown for its inputs' probe says (`M-26`). It names nothing. */
export const UNREACHED_MESSAGE =
  'Not evaluated: every channel it computes reads a sensor on a probe that is lost, or whose ' +
  'clock is behind. It is evaluated again when those sensors report.';

interface Db {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface FactoryReachOptions {
  readonly db: Db;
  readonly logger: Logger;
  /** Absent in a unit test that only asks which factories are held. */
  readonly states?: WithheldReevaluator;
  readonly dependencies?: WithheldDependencies;
  readonly now?: () => Date;
}

/**
 * The Sensor Factories held Unknown, cause `probe`, because every channel they compute gapped on
 * a sensor on a probe that is lost or whose clock is behind, or back and not yet reporting
 * (`M-26`).
 *
 * **A factory over a lost probe's sensor went Down.** Its inputs record nothing, so once its
 * maximum age ran out every channel gapped, it reported an error, and it paged beside the probe's
 * Probe Health, which is the one alarm for that outage. Nothing it is built on has failed: it
 * stopped being measured, which is what Unknown with cause `probe` already says about the
 * sensors themselves. So the factory sweep finds such a factory and it is laid over the facts as
 * the lost probe's sensors are, `probeReachable: false`, and the state machine's row 3 decides it.
 *
 * **Settled on crossing, as `SensorVouching.settle` is.** The set moves first, because the state
 * service reads it, and back if the write does not land. A factory master held Down when it
 * crosses keeps holding until it is evaluated again, for `M-23`'s reason: its dependents may be
 * anywhere, scanned as before, and would each page on the outage it can no longer speak for.
 *
 * **Each held with the inputs it lacks**, so that the alarm engine can hold it behind the probe
 * those are on, as it holds the sensors themselves (`M-22`): one outage, one alarm.
 *
 * Live, like the lost set: not persisted, and empty after a restart until the first sweep.
 */
export class FactoryReach {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #states: WithheldReevaluator | undefined;
  readonly #dependencies: WithheldDependencies | undefined;
  readonly #now: () => Date;
  #unreached: ReadonlySet<number> = new Set();
  #inputs: ReadonlyMap<number, readonly number[]> = new Map();

  constructor(options: FactoryReachOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'factory' });
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** The factories held Unknown for their inputs' probe right now. */
  unreached(): ReadonlySet<number> {
    return this.#unreached;
  }

  /**
   * The sensors a held factory lacks, in id order: sensors a probe scans, reached through any
   * factory held between.
   */
  inputsOf(factoryId: number): readonly number[] | undefined {
    return this.#inputs.get(factoryId);
  }

  /**
   * Replaces the set with `next`, the whole answer for a sweep, and re-decides what crossed. Each
   * factory comes with the inputs it lacks.
   */
  async settle(next: ReadonlyMap<number, readonly number[]>): Promise<number> {
    const before = this.#unreached;
    const inputsBefore = this.#inputs;
    const entered = [...next.keys()].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !next.has(id));
    this.#inputs = new Map(next);
    if (entered.length === 0 && left.length === 0) return 0;
    this.#unreached = new Set(next.keys());
    const states = this.#states;
    if (states === undefined) return 0;

    try {
      const moved = await this.#db.tx(async (q) => {
        const at = this.#now();
        await this.#dependencies?.holdWithheld(q, entered);
        const count = await states.reevaluate(q, [...entered, ...left], at, {
          message: UNREACHED_MESSAGE,
          sources: ['probe'],
        });
        await this.#dependencies?.returnWithheld(q, left, at);
        await this.#dependencies?.recompute(q, at);
        return count;
      });
      this.#logger.info(
        { unreached: entered.length, released: left.length, moved },
        'sensor factories held or released because the probe carrying what they read is away',
      );
      return moved;
    } catch (error) {
      // Put back, so the next sweep sees the same crossings and makes the same write (`A-45`).
      this.#unreached = before;
      this.#inputs = inputsBefore;
      this.#logger.error(
        { sensors: entered.length + left.length, err: describeError(error) },
        'could not re-decide sensor factories whose inputs’ probe is away; the next sweep tries again',
      );
      return 0;
    }
  }
}
