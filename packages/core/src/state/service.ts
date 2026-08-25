/**
 * What turns check results into sensor states (`M-02`).
 *
 * `IngestionService` reads the readings out of a batch; this reads the *outcome* out of the
 * same batch and decides what it means. The division is `WORKFLOW.MD` §4: the probe reports
 * what happened to the check, the core decides whether that is Up, Warning or Down, because
 * limits, lookups, pauses and acknowledgements are the core's configuration and a probe knows
 * none of them.
 *
 * The cache is what makes it affordable at the v1 target of 5,000 sensors: after the first
 * result from a sensor, deciding its state is a map lookup and some arithmetic, and a scan
 * interval issues no state queries at all.
 */

import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import {
  applyResult,
  DEFAULT_FAILURE_POLICY,
  type ChannelVerdict,
  type FailurePolicy,
} from './machine.js';
import {
  loadRuntimes,
  type RuntimeWrite,
  type SensorRuntime,
  type StateDecisions,
  type StateTransition,
} from './runtime.js';

/** One result, as much of it as the state machine reads. */
export interface SensorResult {
  readonly sensorId: number;
  readonly at: Date;
  readonly outcome: 'ok' | 'error';
  readonly message: string;
  /** `M-04`'s verdict on this result's readings. Absent until limits exist. */
  readonly channel?: ChannelVerdict | null;
}

export interface SensorStateServiceOptions {
  db: Database;
  logger: Logger;
  /** `M-03` makes this per-sensor and inheritable. Until then, one policy for everything. */
  policy?: FailurePolicy;
  /** Sensors held in memory. The v1 target is 5,000, so the default holds every one of them. */
  maxCached?: number;
}

export interface StateStats {
  /** Results that moved a sensor's machine. */
  resultsApplied: number;
  /**
   * Results no older sensor state could be moved by — a duplicate after a lost acknowledgement,
   * or a spool arriving behind a live result. Normal on replay, and never silent.
   */
  resultsStale: number;
  /** Results for sensors that no longer exist. */
  resultsUnknownSensor: number;
  /** State changes recorded. This is what uptime is computed from. */
  transitions: number;
  cachedSensors: number;
}

const DEFAULT_MAX_CACHED = 20_000;

export class SensorStateService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #policy: FailurePolicy;
  readonly #maxCached: number;
  readonly #cache = new Map<number, SensorRuntime>();

  #resultsApplied = 0;
  #resultsStale = 0;
  #resultsUnknownSensor = 0;
  #transitions = 0;

  constructor(options: SensorStateServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'state' });
    this.#policy = options.policy ?? DEFAULT_FAILURE_POLICY;
    this.#maxCached = options.maxCached ?? DEFAULT_MAX_CACHED;
  }

  stats(): StateStats {
    return {
      resultsApplied: this.#resultsApplied,
      resultsStale: this.#resultsStale,
      resultsUnknownSensor: this.#resultsUnknownSensor,
      transitions: this.#transitions,
      cachedSensors: this.#cache.size,
    };
  }

  /** For tests, and for whatever invalidates a sensor's configuration in a later phase. */
  clear(): void {
    this.#cache.clear();
  }

  /** The current state of a sensor as far as this process knows. Undefined if never seen. */
  peek(sensorId: number): SensorRuntime | undefined {
    return this.#cache.get(sensorId);
  }

  /**
   * Decides what a batch of results means, and advances the cache to match.
   *
   * The cache moves here rather than after the write commits, because a second batch may be
   * decided before the first has landed and it must see the first one's failures. The write
   * failing is handled the other way round — see {@link forget}, which drops the affected
   * sensors so the next batch re-reads the last committed truth instead of trusting a cache
   * that ran ahead of the database.
   */
  async decide(results: readonly SensorResult[]): Promise<StateDecisions> {
    if (results.length === 0) return { transitions: [], runtimes: [] };

    const bySensor = new Map<number, SensorResult[]>();
    for (const result of results) {
      const existing = bySensor.get(result.sensorId);
      if (existing === undefined) bySensor.set(result.sensorId, [result]);
      else existing.push(result);
    }

    await this.#warm([...bySensor.keys()]);

    const transitions: StateTransition[] = [];
    const runtimes: RuntimeWrite[] = [];

    for (const [sensorId, batch] of bySensor) {
      const known = this.#cache.get(sensorId);
      if (known === undefined) {
        // Not a sensor any more, or never was. Counted, never silently ignored.
        this.#resultsUnknownSensor += batch.length;
        continue;
      }
      let runtime: SensorRuntime = known;

      // A probe may batch several intervals together, and a spool replays whatever order it
      // was written in. The machine is a fold over time, so it has to see them in time order.
      batch.sort((a, b) => a.at.getTime() - b.at.getTime());

      let moved = false;
      for (const result of batch) {
        const last = runtime.facts.lastResultAt;
        // Strictly newer, so a duplicate delivery is a no-op rather than a second failure. The
        // acknowledgement protocol is at-least-once by design; this is what makes that safe.
        if (last !== null && result.at.getTime() <= last.getTime()) {
          this.#resultsStale += 1;
          continue;
        }

        const applied = applyResult(runtime.facts, result, this.#policy);
        this.#resultsApplied += 1;
        moved = true;

        const changed =
          applied.decision.state !== runtime.state || applied.decision.cause !== runtime.cause;
        if (changed) {
          transitions.push({
            sensorId,
            at: result.at,
            state: applied.decision.state,
            previousState: runtime.state,
            cause: applied.decision.cause,
            message: result.message,
          });
        }

        runtime = {
          sensorId,
          state: applied.decision.state,
          cause: applied.decision.cause,
          message: result.message,
          // The clock on "Down for 2h 15m" starts when the state did, and does not restart
          // because the sensor failed again in the same way.
          since: changed ? result.at : runtime.since,
          facts: applied.facts,
        };
      }

      if (!moved) continue;
      this.#remember(sensorId, runtime);
      runtimes.push({
        sensorId,
        at: runtime.facts.lastResultAt ?? runtime.since,
        state: runtime.state,
        cause: runtime.cause,
        message: runtime.message,
        since: runtime.since,
        consecutiveFailures:
          runtime.facts.scan.kind === 'failed' ? runtime.facts.scan.consecutiveFailures : 0,
      });
    }

    this.#transitions += transitions.length;
    if (transitions.length > 0) {
      for (const transition of transitions) {
        this.#logger.info(
          {
            sensorId: transition.sensorId,
            from: transition.previousState,
            to: transition.state,
            cause: transition.cause,
            at: transition.at.toISOString(),
            message: transition.message,
          },
          `sensor ${String(transition.sensorId)} is ${transition.state}`,
        );
      }
    }

    return { transitions, runtimes };
  }

  /**
   * Forgets what a failed write decided.
   *
   * The rows never committed, so the probe still holds the batch and will offer it again. The
   * cache, however, has already moved — and if it stayed moved, the resent results would look
   * stale and the state change would be lost for good. Dropping the entries costs one query
   * next time and makes the database the authority again.
   */
  forget(decisions: StateDecisions): void {
    for (const write of decisions.runtimes) this.#cache.delete(write.sensorId);
  }

  /** Loads every sensor not already cached. One query for the whole batch, or none at all. */
  async #warm(sensorIds: readonly number[]): Promise<void> {
    const missing = sensorIds.filter((id) => !this.#cache.has(id));
    if (missing.length === 0) return;

    const loaded = await this.#db.tx((q: Queryable) => loadRuntimes(q, missing));
    for (const [id, runtime] of loaded) this.#remember(id, runtime);
  }

  #remember(sensorId: number, runtime: SensorRuntime): void {
    // Oldest-first eviction, like the channel resolver: a sensor still reporting is re-read on
    // its next result at the cost of one query. The cache exists to make the common case free,
    // not to be authoritative.
    if (!this.#cache.has(sensorId) && this.#cache.size >= this.#maxCached) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(sensorId, runtime);
  }
}
