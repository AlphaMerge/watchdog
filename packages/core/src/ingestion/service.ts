import type { CheckResult, CoreToProbeMessage, Logger, ProbeToCoreMessage } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { ChannelResolver } from './channels.js';
import type { Ingestor, SampleRow } from './ingestor.js';

export type ResultsMessage = Extract<ProbeToCoreMessage, { type: 'results' }>;

export interface IngestionServiceOptions {
  db: Database;
  logger: Logger;
  ingestor: Ingestor;
  resolver?: ChannelResolver;
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
}

/**
 * Turns a probe's `results` message into readings, and answers it.
 *
 * The division of labour is `WORKFLOW.MD` §4: the probe reports what happened to the check, the
 * core decides what that means. So this reads the channel values and stores them, and leaves
 * `outcome` and `message` for the state machine (`M-02`), which is the only thing entitled to
 * decide whether a sensor is Up, Warning or Down — limits and lookups are the core's
 * configuration, not the probe's.
 */
export class IngestionService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #ingestor: Ingestor;
  readonly #resolver: ChannelResolver;

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
    try {
      samples = await this.#toSamples(usable);
    } catch (error: unknown) {
      this.#logger.error({ err: error, source }, 'could not resolve channels for a results batch');
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'storage-error',
        retryAfterMs: 1_000,
      };
    }

    const outcome = await this.#ingestor.submit({ source, samples });
    if (!outcome.accepted) {
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: outcome.reason,
        retryAfterMs: outcome.retryAfterMs,
      };
    }

    return {
      type: 'results-ack',
      batchId: message.batchId,
      storedSamples: outcome.storedSamples,
      retryAfterMs: outcome.retryAfterMs,
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
