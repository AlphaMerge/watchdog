import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { SensorStateCause } from '../state/tables.js';
import { isActiveAt } from './definition.js';
import { ScheduleRepository, type StoredSchedule } from './repository.js';

/** Just enough of `SensorStateService` for a window to take effect now. */
export interface ReevaluatesSensors {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    /** `sources` names the causes this message speaks for — see `P-94` on `reevaluate`. */
    cause: { message: string; sources?: readonly SensorStateCause[] },
  ): Promise<number>;
}

export interface SchedulePausesOptions {
  logger: Logger;
  repository?: ScheduleRepository;
  /**
   * Optional for the same reason `ObjectService`'s is: without it the flags still move and the
   * probe still stops scanning, the states simply do not follow. Not a system anyone should
   * run, and exactly what a test about the SQL should not have to build.
   */
  states?: ReevaluatesSensors;
}

export interface ScheduleRecompute {
  /** Sensors whose `paused_by_schedule` moved. */
  readonly moved: number;
  /** Of those, how many produced a state transition. */
  readonly transitions: number;
  /** Which schedules are outside their monitored periods at this instant. */
  readonly inactive: readonly number[];
}

const NOTHING: ScheduleRecompute = { moved: 0, transitions: 0, inactive: [] };

/**
 * What turns a schedule into `sensor_runtime.paused_by_schedule` (`M-09`).
 *
 * The whole subsystem in one method: read the schedules, ask each whether it monitors *now*,
 * write the flag for every sensor that inherits one of the ones that does not, and re-evaluate
 * the sensors whose flag moved. Idempotent, so it can be called from a sweep, from a schedule
 * edit and from an assignment change without any of them needing to know what the others do.
 *
 * **A window opening or closing is not a configuration change.** Nothing here writes an audit
 * entry: no operator did anything, and a log that filled with "the office-hours schedule
 * became active" twice a day would bury the entries that record a decision. What the boundary
 * does produce is the thing uptime is computed from — a row in `sensor_state` — and that is
 * written by `reevaluate` exactly as a manual pause's is.
 */
export class SchedulePauses {
  readonly #repo: ScheduleRepository;
  readonly #states: ReevaluatesSensors | undefined;
  readonly #logger: Logger;

  constructor(options: SchedulePausesOptions) {
    this.#repo = options.repository ?? new ScheduleRepository();
    this.#states = options.states;
    this.#logger = options.logger.child({ component: 'schedules' });
  }

  /**
   * Recomputes every sensor's schedule flag against the clock.
   *
   * Runs inside the caller's transaction — the flag, the state history row and the audit entry
   * of whatever prompted it all commit together or not at all.
   */
  async recompute(q: Queryable, now: Date): Promise<ScheduleRecompute> {
    // Nothing assigned and nothing currently held: this is the one query an installation that
    // never uses schedules pays for the feature.
    if (!(await this.#repo.anyWork(q))) return NOTHING;

    const schedules = await this.#repo.list(q);
    const inactive = schedules.filter((schedule) => !isActiveAt(schedule.definition, now));
    const changes = await this.#repo.applyPauses(
      q,
      inactive.map((schedule) => schedule.id),
    );
    if (changes.length === 0) return { ...NOTHING, inactive: inactive.map((s) => s.id) };

    // Grouped by schedule so the state history says *which* one, rather than "a schedule".
    // "Paused: outside the 'Office hours (Mon–Fri 08:00–18:00)' schedule" is an answer; "paused
    // by a schedule" sends an operator looking for which of five it was.
    const byName = new Map(schedules.map((schedule) => [schedule.id, schedule.name]));
    const grouped = new Map<number | null, number[]>();
    for (const change of changes) {
      const group = grouped.get(change.scheduleId);
      if (group === undefined) grouped.set(change.scheduleId, [change.sensorId]);
      else group.push(change.sensorId);
    }

    let transitions = 0;
    for (const [scheduleId, sensorIds] of grouped) {
      const name = scheduleId === null ? null : byName.get(scheduleId);
      const message =
        name === undefined || name === null
          ? 'outside its monitoring schedule'
          : `outside the "${name}" schedule`;
      // `reevaluate` blanks the message for a sensor that is resuming, so the same call covers
      // both directions: the reason a sensor is Unknown after a window opens is that nothing
      // has scanned it yet, not the schedule's name.
      //
      // **`sources` because a window opening does not always resume the sensor** (`P-94`). One
      // held by a manual pause as well stays paused and its cause moves to `user`; without this
      // the schedule's text was written over the operator's own words at the moment the
      // schedule stopped being the reason for anything.
      transitions +=
        (await this.#states?.reevaluate(q, sensorIds, now, {
          message,
          sources: ['schedule'],
        })) ?? 0;
    }

    this.#logger.debug(
      { moved: changes.length, transitions, inactive: inactive.map((s) => s.id) },
      'schedule flags recomputed',
    );
    return { moved: changes.length, transitions, inactive: inactive.map((s) => s.id) };
  }

  /** The schedules, for anything that needs to say what one is called or when it next changes. */
  async list(q: Queryable): Promise<StoredSchedule[]> {
    return this.#repo.list(q);
  }
}
