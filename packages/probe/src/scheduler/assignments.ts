import type { SensorAssignment } from '@ms/shared';
import type { TimingWheel } from './wheel.js';

/** A configuration message, reduced to what the scheduler has to do about it. */
export type ConfigUpdate =
  | { kind: 'set'; version: string; sensors: readonly SensorAssignment[] }
  | {
      kind: 'delta';
      version: string;
      upserted: readonly SensorAssignment[];
      removed: readonly number[];
    };

/**
 * What this probe has been told to scan, and the wheel kept in step with it (R-04).
 *
 * The whole assignment is kept rather than just the parts a check needs, because
 * `intervalSeconds` is what decides whether an update has to re-arm the wheel — and re-arming
 * one that has not changed would reset its phase, bunching sensors onto the tick a push happened
 * to arrive on. `TimingWheel.add` already returns early for an unchanged interval, so an upsert
 * can be unconditional and still leave untouched sensors exactly where they were.
 */
/**
 * What the store tells, and who it tells (`P-111`).
 *
 * Both are required. A store whose arrivals and departures reach nobody is not a configuration
 * anybody wants — it is the shape two shipped fixes silently reverted to when the lines in
 * `main()` that registered these were deleted, with every test still green.
 */
export interface AssignmentListeners {
  /** A sensor became this probe's responsibility (`P-80`). */
  readonly onAdd: (sensorId: number) => void;
  /** A sensor stopped being it, so per-sensor state goes with it (`P-77`). */
  readonly onDrop: (sensorId: number) => void;
}

export class AssignmentStore {
  readonly #wheel: TimingWheel;
  readonly #assignments = new Map<number, SensorAssignment>();

  /**
   * Told when a sensor leaves, so whatever is keeping per-sensor state can release it (`P-77`).
   *
   * The check-flow watchdog holds a last-completion time per sensor; without this it kept one for
   * every sensor the probe had ever been assigned, which on a probe that is repeatedly reassigned
   * grows without bound. The store is the only thing that knows a sensor has gone.
   */
  readonly #onDrop: (sensorId: number) => void;

  /**
   * Told when a sensor arrives, so per-sensor bookkeeping can start its clock (`P-80`).
   *
   * The counterpart of `#onDrop`, and needed for the same reason: only the store knows when this
   * probe became responsible for a sensor. Without it the check-flow watchdog had to guess, and
   * its guess — the process start — counted every sensor assigned later as behind schedule from
   * the moment it arrived.
   */
  readonly #onAdd: (sensorId: number) => void;

  /**
   * `onAdd` and `onDrop` are taken here rather than registered afterwards (`P-111`).
   *
   * They were `store.onAdd(...)` calls in `main()`, and deleting both of them compiled and left
   * all 283 probe tests green — the watchdog's own tests call `assigned` and `forget` directly,
   * so they prove the *mechanism* and never the wiring. `P-80` and `P-82` both depend on these
   * lines, and neither could tell you they were gone.
   *
   * A constructor parameter is the cheapest guard there is: the compiler refuses a store that
   * tells nobody, which is the same thing that already protects `reconcilesReadings` and
   * `ingestionDiscards` on the core side.
   */
  constructor(wheel: TimingWheel, listeners: AssignmentListeners) {
    this.#wheel = wheel;
    this.#onAdd = listeners.onAdd;
    this.#onDrop = listeners.onDrop;
  }

  get size(): number {
    return this.#assignments.size;
  }

  get(sensorId: number): SensorAssignment | undefined {
    return this.#assignments.get(sensorId);
  }

  ids(): number[] {
    return [...this.#assignments.keys()].sort((a, b) => a - b);
  }

  /**
   * Every assignment, for the pool's demand calculation (`P-34`).
   *
   * The map's own iterator rather than a copy: this is read on a timer over a list that reaches
   * five thousand entries at the v1 target, and the caller only sums over it.
   */
  values(): IterableIterator<SensorAssignment> {
    return this.#assignments.values();
  }

  /** Applies an update and returns how many assignments are now scheduled. */
  apply(update: ConfigUpdate): number {
    if (update.kind === 'set') {
      // A snapshot is authoritative: anything absent from it is gone, including sensors this
      // probe owned until a device was moved to a different one.
      const keep = new Set(update.sensors.map((sensor) => sensor.sensorId));
      for (const sensorId of [...this.#assignments.keys()]) {
        if (!keep.has(sensorId)) this.#drop(sensorId);
      }
      for (const assignment of update.sensors) this.#upsert(assignment);
    } else {
      for (const sensorId of update.removed) this.#drop(sensorId);
      for (const assignment of update.upserted) this.#upsert(assignment);
    }
    return this.#assignments.size;
  }

  #upsert(assignment: SensorAssignment): void {
    // Only on arrival, not on every re-push of an assignment the probe already had: an edit to a
    // sensor's parameters must not restart the clock on whether it is being checked.
    const arriving = !this.#assignments.has(assignment.sensorId);
    this.#assignments.set(assignment.sensorId, assignment);
    this.#wheel.add({ id: assignment.sensorId, intervalSeconds: assignment.intervalSeconds });
    if (arriving) this.#onAdd(assignment.sensorId);
  }

  #drop(sensorId: number): void {
    this.#assignments.delete(sensorId);
    this.#wheel.remove(sensorId);
    this.#onDrop(sensorId);
  }
}
