import type { CheckResult, CoreToProbeMessage, Logger, ProbeToCoreMessage } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { StateDecisions } from '../state/runtime.js';
import type { SensorResult, SensorStateService, StateStats } from '../state/service.js';
import { ChannelResolver } from './channels.js';
import type { Ingestor, SampleRow } from './ingestor.js';
import type { ReplayPacer } from './replay-pacer.js';

export type ResultsMessage = Extract<ProbeToCoreMessage, { type: 'results' }>;

export interface IngestionServiceOptions {
  db: Database;
  logger: Logger;
  ingestor: Ingestor;
  resolver?: ChannelResolver;
  /** Absent leaves catch-up unpaced, which is how it behaved before R-03. */
  pacer?: ReplayPacer;
  /**
   * The state machine (`M-02`). Absent stores readings and decides nothing, which is what a
   * throughput benchmark wants and no running system does.
   */
  states?: SensorStateService;
}

export interface ResultStats {
  resultsReceived: number;
  readingsReceived: number;
  /** Readings sent alongside a failed check, which a sensor in error is not allowed to have. */
  discardedOnError: number;
  /** Readings whose timestamp was not a date. */
  discardedInvalidTime: number;
  /** Readings for sensors that no longer exist — a spool replayed after a deletion. */
  discardedUnknownSensor: number;
  channelsCreated: number;
  cachedChannels: number;
  /** Absent when no state machine is wired. */
  state?: StateStats;
}

/**
 * Turns a probe's `results` message into readings and states, and answers it.
 *
 * The division of labour is `WORKFLOW.MD` §4: the probe reports what happened to the check, the
 * core decides what that means. So the channel values are stored here, and `outcome`, `message`
 * and the sensor's own history go to the state machine (`M-02`) — the only thing entitled to
 * decide whether a sensor is Up, Warning or Down, because limits, lookups, pauses and
 * acknowledgements are the core's configuration and a probe knows none of them.
 *
 * The two halves are decided separately and written together. A failed check is the case that
 * makes the distinction visible: it contributes no readings at all and yet is the most
 * important thing in the batch.
 */
export class IngestionService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #ingestor: Ingestor;
  readonly #resolver: ChannelResolver;
  readonly #pacer: ReplayPacer | undefined;
  readonly #states: SensorStateService | undefined;

  #resultsReceived = 0;
  #readingsReceived = 0;
  #discardedOnError = 0;
  #discardedInvalidTime = 0;
  #discardedUnknownSensor = 0;
  #channelsCreated = 0;

  constructor(options: IngestionServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'ingestion' });
    this.#ingestor = options.ingestor;
    this.#resolver = options.resolver ?? new ChannelResolver({ logger: options.logger });
    this.#pacer = options.pacer;
    this.#states = options.states;
  }

  stats(): ResultStats {
    return {
      resultsReceived: this.#resultsReceived,
      readingsReceived: this.#readingsReceived,
      discardedOnError: this.#discardedOnError,
      discardedInvalidTime: this.#discardedInvalidTime,
      discardedUnknownSensor: this.#discardedUnknownSensor,
      channelsCreated: this.#channelsCreated,
      cachedChannels: this.#resolver.cached,
      ...(this.#states === undefined ? {} : { state: this.#states.stats() }),
    };
  }

  /** Accepts a batch and returns the message to send back. Never throws. */
  async acceptResults(source: string, message: ResultsMessage): Promise<CoreToProbeMessage> {
    this.#resultsReceived += message.results.length;

    let usable: CheckResult[];
    try {
      usable = this.#usableResults(message.results);
    } catch (error: unknown) {
      // Only a programming fault can land here; a malformed message was already refused by the
      // schema at the connection boundary.
      this.#logger.error({ err: error, source }, 'could not read a results batch');
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'invalid',
        retryAfterMs: 0,
      };
    }

    let samples: SampleRow[];
    let decisions: StateDecisions | undefined;
    try {
      samples = await this.#toSamples(usable);
      // Every result, not just the usable ones: a check that failed has no readings and is
      // precisely the one the state machine exists for.
      decisions = await this.#states?.decide(toSensorResults(message.results));
    } catch (error: unknown) {
      this.#logger.error({ err: error, source }, 'could not prepare a results batch for storage');
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'storage-error',
        retryAfterMs: 1_000,
      };
    }

    const outcome = await this.#ingestor.submit({
      source,
      samples,
      ...(decisions === undefined ? {} : { states: decisions }),
    });
    if (!outcome.accepted) {
      // Nothing committed, so the probe will offer the batch again — but the machine has
      // already moved. Rewinding it here is what stops the resent results looking stale and the
      // state change being lost for good.
      if (decisions !== undefined) this.#states?.forget(decisions);
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: outcome.reason,
        retryAfterMs: outcome.retryAfterMs,
      };
    }

    // The queue's hint says how full the core is; the pacer says how much of that capacity this
    // probe may take. Added rather than maximised: a catch-up during genuine pressure should
    // wait for both reasons, not for whichever happens to be larger.
    const pacing = this.#pacer?.pace(source, message.backlog) ?? 0;

    return {
      type: 'results-ack',
      batchId: message.batchId,
      storedSamples: outcome.storedSamples,
      retryAfterMs: outcome.retryAfterMs + pacing,
    };
  }

  /**
   * Drops what must not be stored, and counts every drop.
   *
   * A failed check records no channel values — "no-data is not zero" (CLAUDE.md), and a Down
   * sensor's gap is the absence of rows. The probe should already send none; enforcing it here
   * means the invariant holds even if a sensor type gets it wrong, and the count says so rather
   * than the readings quietly appearing in a graph.
   */
  #usableResults(results: readonly CheckResult[]): CheckResult[] {
    const usable: CheckResult[] = [];
    for (const result of results) {
      this.#readingsReceived += result.channels.length;

      if (result.outcome === 'error') {
        this.#discardedOnError += result.channels.length;
        continue;
      }
      if (Number.isNaN(Date.parse(result.at))) {
        this.#discardedInvalidTime += result.channels.length;
        continue;
      }
      if (result.channels.length > 0) usable.push(result);
    }
    return usable;
  }

  async #toSamples(results: readonly CheckResult[]): Promise<SampleRow[]> {
    if (results.length === 0) return [];

    const resolved = await this.#db.tx((q) => this.#resolver.resolve(q, results));
    this.#channelsCreated += resolved.created;
    this.#discardedUnknownSensor += resolved.droppedReadings;

    const samples: SampleRow[] = [];
    for (const result of results) {
      const at = new Date(result.at);
      for (const reading of result.channels) {
        const channelId = resolved.ids.get(`${String(result.sensorId)}:${reading.key}`);
        if (channelId === undefined) continue; // counted as dropped by the resolver
        samples.push({ channelId, at, value: reading.value });
      }
    }
    return samples;
  }
}

/**
 * The state machine's view of a batch: every result, whatever its outcome, minus the ones whose
 * timestamp is not a date.
 *
 * An unparseable time is already counted as a discard by `#usableResults`; it is dropped again
 * here rather than defaulted, because a result with no usable time cannot be ordered against
 * the last one, and ordering is what makes the machine idempotent.
 */
function toSensorResults(results: readonly CheckResult[]): SensorResult[] {
  const usable: SensorResult[] = [];
  for (const result of results) {
    const at = Date.parse(result.at);
    if (Number.isNaN(at)) continue;
    usable.push({
      sensorId: result.sensorId,
      at: new Date(at),
      outcome: result.outcome,
      message: result.message,
    });
  }
  return usable;
}
