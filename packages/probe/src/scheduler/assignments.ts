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
  #onDrop: ((sensorId: number) => void) | undefined;

  constructor(wheel: TimingWheel) {
    this.#wheel = wheel;
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
    this.#assignments.set(assignment.sensorId, assignment);
    this.#wheel.add({ id: assignment.sensorId, intervalSeconds: assignment.intervalSeconds });
  }

  onDrop(listener: (sensorId: number) => void): void {
    this.#onDrop = listener;
  }

  #drop(sensorId: number): void {
    this.#assignments.delete(sensorId);
    this.#wheel.remove(sensorId);
    this.#onDrop?.(sensorId);
  }
}
