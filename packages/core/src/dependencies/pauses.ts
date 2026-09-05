import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { DEPENDENCY_DELAY_SECONDS } from '../settings/registry.js';
import { DependencyRepository } from './repository.js';

/** Just enough of `SensorStateService` for a dependency to take effect now. */
export interface ReevaluatesSensors {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    cause: { message: string },
  ): Promise<number>;
}

/**
 * Just enough of `InheritanceResolver` to read the delay for a handful of masters.
 *
 * Narrowed to `number` rather than generic: the only key this module resolves is the delay, and
 * a type parameter used once is a parameter that documents nothing.
 */
export interface ResolvesDelays {
  resolveForObjects(
    objectIds: readonly number[],
    key: string,
  ): Promise<Map<number, { value: number }>>;
  withExecutor(q: Queryable): ResolvesDelays;
}

/** What the reactor is told about a state change. Just the fields it reads. */
export interface StateChange {
  readonly sensorId: number;
  readonly state: string;
  /** `null` on a sensor's very first transition, which is never a recovery from Down. */
  readonly previousState: string | null;
  /** When the transition happened. See `after`. */
  readonly at?: Date;
}

/**
 * A moment strictly later than every transition this reaction is responding to.
 *
 * `sensor_state` is keyed on `(sensor_id, time)` and inserts with `ON CONFLICT DO NOTHING`, so a
 * pause written at the same instant as the Down that caused it is **silently dropped** — leaving
 * the history saying Down while `sensor_runtime` says Paused. Uptime is computed from the
 * history (`CLAUDE.md`), so the two disagreeing is a corrupted SLA rather than a cosmetic
 * glitch.
 *
 * In production the wall clock is already past the result's timestamp and the collision does not
 * arise; it takes a probe whose clock runs a little ahead, or a replay, to line them up. That is
 * exactly the sort of thing that happens once and is never reproduced, so the ordering is made
 * true by construction instead: the pause was *caused* by the Down, so it happened after it.
 *
 * Found by `M-17`'s scenario test, which drove the reaction at the result's own timestamp and
 * watched forty dependents keep a Down in the history that nothing would ever supersede.
 */
export function reactionTime(changes: readonly StateChange[], now: Date): Date {
  let latest = now.getTime();
  for (const change of changes) {
    const at = change.at?.getTime();
    if (at !== undefined && at >= latest) latest = at + 1;
  }
  return latest === now.getTime() ? now : new Date(latest);
}

export interface DependencyPausesOptions {
  logger: Logger;
  settings: ResolvesDelays;
  repository?: DependencyRepository;
  states?: ReevaluatesSensors;
  /**
   * How many times the cascade may propagate before it is declared a cycle.
   *
   * A backstop, not the defence: `ObjectService` refuses an assignment that would close a loop.
   * This is what stops a loop that got in some other way — a hand-edited row, a restore — from
   * spinning inside a transaction rather than merely being wrong.
   */
  maxRounds?: number;
}

export interface DependencyRecompute {
  readonly moved: number;
  readonly transitions: number;
  readonly rounds: number;
}

const NOTHING: DependencyRecompute = { moved: 0, transitions: 0, rounds: 0 };

const DOWN_STATES = new Set(['down', 'down_acknowledged']);

/**
 * What turns a master going Down into `sensor_runtime.paused_by_dependency` (`M-11`).
 *
 * *One outage, one alarm*: forty sensors on an unreachable switch should produce one Down and
 * thirty-nine Paused, not forty alarms. That is the entire purpose, and `M-17`'s scenario test is
 * what will hold it to it.
 *
 * **Driven by state changes, not by a clock.** Schedules recompute on the minute because time is
 * what moves them; a dependency moves when a master's state moves, which happens in the
 * ingestion path thousands of times a minute. So the first thing asked of every batch is whether
 * any sensor that changed is the master of anything — one indexed lookup — and an installation
 * with no dependencies never gets past it.
 *
 * **The cascade is a fixpoint, not a recursion.** `WORKFLOW.MD §5` requires dependents of a
 * paused dependent to pause too, and a master held by its own master is itself holding. Each
 * round of `applyPauses` propagates one level, and the loop runs until nothing moves — bounded,
 * so a cycle that got past the cycle check is a logged warning rather than a transaction that
 * never returns.
 */
export class DependencyPauses {
  readonly #repo: DependencyRepository;
  readonly #states: ReevaluatesSensors | undefined;
  readonly #settings: ResolvesDelays;
  readonly #logger: Logger;
  readonly #maxRounds: number;

  constructor(options: DependencyPausesOptions) {
    this.#repo = options.repository ?? new DependencyRepository();
    this.#states = options.states;
    this.#settings = options.settings;
    this.#logger = options.logger.child({ component: 'dependencies' });
    this.#maxRounds = options.maxRounds ?? 20;
  }

  /**
   * Reacts to a batch of state changes.
   *
   * Runs inside the caller's transaction — the readings, the states they decided and the pauses
   * those caused all commit together or not at all.
   */
  async react(
    q: Queryable,
    changes: readonly StateChange[],
    now: Date,
  ): Promise<DependencyRecompute> {
    if (changes.length === 0) return NOTHING;
    const masters = await this.#repo.mastersAmong(
      q,
      changes.map((change) => change.sensorId),
    );
    if (masters.length === 0) return NOTHING;

    // Strictly after the transitions being reacted to, or the pause collides with the Down that
    // caused it and the history loses one of them.
    const reactedAt = reactionTime(changes, now);

    // Only the masters, and only the transitions that cross the Down boundary. A master going
    // from Up to Warning changes nothing about what it holds.
    const isMaster = new Set(masters);
    const failed: number[] = [];
    const recoveredIds: number[] = [];
    for (const change of changes) {
      if (!isMaster.has(change.sensorId)) continue;
      const wasDown = change.previousState !== null && DOWN_STATES.has(change.previousState);
      const isDown = DOWN_STATES.has(change.state);
      if (isDown) failed.push(change.sensorId);
      else if (wasDown) recoveredIds.push(change.sensorId);
    }

    await this.#repo.markRecoveries(q, await this.#delaysFor(q, recoveredIds), failed, reactedAt);

    return this.#settle(q, reactedAt);
  }

  /**
   * How long each recovered master keeps holding — resolved on the objects that configure it.
   *
   * **`P-89`: this used to resolve `dependency.delaySeconds` on the masters.** The setting is
   * written to the object that carries the *dependency* — `ObjectService.setDependency` says so
   * in as many words, because a delay set alongside "master object for parent device" must land
   * on the device rather than on the sensor. The two coincide only in `device` mode, where the
   * master sensor sits inside the device the setting lands on; that is the mode the existing
   * test used, which is why it stayed green. In `object` mode — WORKFLOW.MD §5's "every branch
   * office depends on the WAN link sensor" — the master lives elsewhere in the tree, the value
   * is not on its chain, and every recovery fell back to the registry default of 0. The API and
   * the resolver went on reporting the configured delay, so the UI showed a number the engine
   * never used, and each flap of the master released and re-paused every dependent: two rows
   * per dependent per bounce in the table uptime is computed from, and long enough bounces let
   * the dependents arm and fire the alarms the setting exists to prevent.
   *
   * **The longest wins when dependents disagree.** `dependency_clear_at` is one column on the
   * master, so one master has one deadline. Releasing a dependent before its own configured
   * delay is the failure this setting exists to prevent, and holding one a little longer than
   * it asked for costs an interval of monitoring on a device whose master has only just come
   * back. In `device` mode every dependent inherits the same value and the question does not
   * arise.
   */
  async #delaysFor(
    q: Queryable,
    recoveredIds: readonly number[],
  ): Promise<{ sensorId: number; delaySeconds: number }[]> {
    if (recoveredIds.length === 0) return [];
    const dependents = await this.#repo.dependentsOf(q, recoveredIds);
    const wanted = [...new Set([...dependents.values()].flat())];
    const delays =
      wanted.length === 0
        ? new Map<number, { value: number }>()
        : await this.#settings
            .withExecutor(q)
            .resolveForObjects(wanted, DEPENDENCY_DELAY_SECONDS.key);

    return recoveredIds.map((sensorId) => ({
      sensorId,
      delaySeconds: (dependents.get(sensorId) ?? []).reduce(
        (longest, dependent) => Math.max(longest, delays.get(dependent)?.value ?? 0),
        0,
      ),
    }));
  }

  /**
   * Recomputes from whatever the rows say, without being told what changed.
   *
   * What the sweep calls when a recovery delay runs out, and what a dependency being assigned or
   * cleared calls. Idempotent, so nothing has to work out whether it is needed.
   */
  async recompute(q: Queryable, now: Date): Promise<DependencyRecompute> {
    if (!(await this.#repo.anyWork(q))) return NOTHING;
    return this.#settle(q, now);
  }

  /** Releases the masters whose recovery delay has elapsed, then settles. */
  async releaseElapsed(q: Queryable, now: Date, limit = 200): Promise<DependencyRecompute> {
    const elapsed = await this.#repo.delaysElapsed(q, now, limit);
    if (elapsed.length === 0) return NOTHING;
    await this.#repo.clearDelays(q, elapsed);
    const result = await this.#settle(q, now);
    this.#logger.info(
      { masters: elapsed, released: result.moved },
      'dependency recovery delays elapsed',
    );
    return result;
  }

  /** Rounds of `applyPauses` until nothing moves. One round propagates one level. */
  async #settle(q: Queryable, now: Date): Promise<DependencyRecompute> {
    let moved = 0;
    let transitions = 0;
    let rounds = 0;

    for (; rounds < this.#maxRounds; rounds += 1) {
      const changes = await this.#repo.applyPauses(q, now);
      if (changes.length === 0) break;
      moved += changes.length;

      const masterIds = [
        ...new Set(changes.map((change) => change.masterId).filter((id) => id !== null)),
      ];
      const names = await this.#repo.namesOf(q, masterIds);
      // Grouped by master so the state history names the outage: "master #12 (core-switch) is
      // Down" is an answer, and "paused by a dependency" sends an operator looking for which.
      const grouped = new Map<number | null, number[]>();
      for (const change of changes) {
        const group = grouped.get(change.masterId);
        if (group === undefined) grouped.set(change.masterId, [change.sensorId]);
        else group.push(change.sensorId);
      }
      for (const [masterId, sensorIds] of grouped) {
        const name = masterId === null ? undefined : names.get(masterId);
        const message =
          masterId === null
            ? 'its master recovered'
            : `master #${String(masterId)}${name === undefined ? '' : ` (${name})`} is Down`;
        transitions += (await this.#states?.reevaluate(q, sensorIds, now, { message })) ?? 0;
      }
    }

    if (rounds >= this.#maxRounds) {
      // Not thrown: refusing the batch would stop ingestion for a configuration mistake, and the
      // flags are still consistent with the last round that ran. Loud, because a cycle means two
      // sensors will hold each other paused until somebody breaks it.
      this.#logger.error(
        { rounds },
        'the dependency cascade did not settle; a master cycle is the likely cause',
      );
    }
    return { moved, transitions, rounds };
  }
}
