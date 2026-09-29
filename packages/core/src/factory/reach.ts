import type { StagedSet } from '../objects/vouching.js';

/** The Sensor Factory's type id, the one sensor type the core holds for its inputs' probe. */
export const FACTORY_SENSOR_TYPE = 'core.factory';

/** What a factory held Unknown for its inputs' probe says (`M-26`). It names nothing. */
export const UNREACHED_MESSAGE =
  'Not evaluated: every channel it computes reads a sensor on a probe that is lost, or whose ' +
  'clock is behind. It is evaluated again when those sensors report.';

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
 * **Staged, and settled with the voucher sets** (`M-28`). The set moves first, because the state
 * service reads it, and what crossed is re-decided in the transaction that settles the factory
 * sweep's voucher sets, so a factory moving between any of them is re-decided once. The set goes
 * back if that write does not land. A factory master held Down when it crosses keeps holding
 * until it is evaluated again, for `M-23`'s reason: its dependents may be anywhere, scanned as
 * before, and would each page on the outage it can no longer speak for.
 *
 * **Each held with the inputs it lacks**, so that the alarm engine can hold it behind the probe
 * those are on, as it holds the sensors themselves (`M-22`): one outage, one alarm.
 *
 * Live, like the lost set: not persisted, and empty after a restart until the first sweep.
 */
export class FactoryReach {
  #unreached: ReadonlySet<number> = new Set();
  #inputs: ReadonlyMap<number, readonly number[]> = new Map();

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
   * Replaces the set with `next`, the whole answer for a sweep, each factory with the inputs it
   * lacks, and says what crossed. Nothing is re-decided here: that is the settle it is handed to.
   */
  stage(next: ReadonlyMap<number, readonly number[]>): StagedSet {
    const before = this.#unreached;
    const inputsBefore = this.#inputs;
    const entered = [...next.keys()].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !next.has(id));
    this.#unreached = new Set(next.keys());
    this.#inputs = new Map(next);
    return {
      entered,
      left,
      holds: (sensorId) => this.#unreached.has(sensorId),
      cause: 'probe',
      message: UNREACHED_MESSAGE,
      undo: () => {
        // Put back, so the next sweep sees the same crossings and makes the same write (`A-45`).
        this.#unreached = before;
        this.#inputs = inputsBefore;
      },
    };
  }
}
