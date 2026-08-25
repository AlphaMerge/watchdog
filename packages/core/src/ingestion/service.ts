import type { CheckResult, CoreToProbeMessage, Logger, ProbeToCoreMessage } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { rollUp, type ChannelOutcome, type ChannelReadingFacts } from '../state/limits.js';
import type { StateDecisions } from '../state/runtime.js';
import type { SensorResult, SensorStateService, StateStats } from '../state/service.js';
import { ChannelResolver } from './channels.js';
import type { Ingestor, SampleRow } from './ingestor.js';
import type { ReplayPacer } from './replay-pacer.js';

export type ResultsMessage = Extract<ProbeToCoreMessage, { type: 'results' }>;

/** One batch, walked once: the rows to write and what the state machine should be told. */
interface Prepared {
  samples: SampleRow[];
  results: SensorResult[];
}

/** Distinguishable from `undefined`, which means "no state machine is wired". */
const FAILED = Symbol('state-decision-failed');

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

    let prepared: Prepared;
    try {
      prepared = await this.#prepare(message.results);
    } catch (error: unknown) {
      this.#logger.error({ err: error, source }, 'could not prepare a results batch for storage');
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'storage-error',
        retryAfterMs: 1_000,
      };
    }

    const samples = prepared.samples;
    const decisions = await this.#decide(source, prepared.results);
    if (decisions === FAILED) {
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

  /** Runs the machine, or reports that it could not. Never throws. */
  async #decide(
    source: string,
    results: readonly SensorResult[],
  ): Promise<StateDecisions | undefined | typeof FAILED> {
    if (this.#states === undefined) return undefined;
    try {
      return await this.#states.decide(results);
    } catch (error: unknown) {
      this.#logger.error({ err: error, source }, 'could not decide sensor states for a batch');
      return FAILED;
    }
  }

  /**
   * One pass over a batch: what to store, and what it means.
   *
   * Both halves come out of the same walk because they read the same rows. Splitting them would
   * resolve every channel twice — once to write the reading and once to judge it — and the
   * second resolution could disagree with the first if a limit changed in between.
   *
   * A failed check records no channel values — "no-data is not zero" (CLAUDE.md), and a Down
   * sensor's gap is the absence of rows. The probe should already send none; enforcing it here
   * means the invariant holds even if a sensor type gets it wrong, and the count says so rather
   * than the readings quietly appearing in a graph.
   */
  async #prepare(all: readonly CheckResult[]): Promise<Prepared> {
    const withReadings: CheckResult[] = [];
    for (const result of all) {
      this.#readingsReceived += result.channels.length;

      if (result.outcome === 'error') {
        this.#discardedOnError += result.channels.length;
        continue;
      }
      if (Number.isNaN(Date.parse(result.at))) {
        this.#discardedInvalidTime += result.channels.length;
        continue;
      }
      if (result.channels.length > 0) withReadings.push(result);
    }

    const resolved =
      withReadings.length === 0
        ? null
        : await this.#db.tx((q) => this.#resolver.resolve(q, withReadings));
    if (resolved !== null) {
      this.#channelsCreated += resolved.created;
      this.#discardedUnknownSensor += resolved.droppedReadings;
    }

    const samples: SampleRow[] = [];
    // Keyed by the result itself rather than by sensor id: one batch can carry several scans of
    // the same sensor, and each of them is judged on its own readings.
    const outcomes = new Map<CheckResult, ChannelOutcome>();
    for (const result of withReadings) {
      const at = new Date(result.at);
      const readings: ChannelReadingFacts[] = [];
      for (const reading of result.channels) {
        const channel = resolved?.ids.get(`${String(result.sensorId)}:${reading.key}`);
        if (channel === undefined) continue; // counted as dropped by the resolver
        samples.push({ channelId: channel.id, at, value: reading.value });
        readings.push({
          key: reading.key,
          name: channel.name,
          unit: channel.unit,
          value: reading.value,
          decimals: channel.decimals,
          limits: channel.limits,
          lookupId: channel.lookupId,
          lookup: channel.lookup,
        });
      }
      // M-07 belongs between these two lines: scaling changes the value a limit is compared
      // against, and the spike filter drops a reading before it is compared at all.
      if (readings.length > 0) outcomes.set(result, rollUp(readings));
    }

    // Every result, whatever its outcome: a check that failed has no readings and is precisely
    // the one the state machine exists for. Only an unparseable timestamp is dropped — it is
    // already counted above, and a result that cannot be ordered against the last one cannot be
    // folded into a machine that is a fold over time.
    const results: SensorResult[] = [];
    for (const result of all) {
      const at = Date.parse(result.at);
      if (Number.isNaN(at)) continue;
      results.push({
        sensorId: result.sensorId,
        at: new Date(at),
        outcome: result.outcome,
        message: result.message,
        channels: outcomes.get(result) ?? null,
      });
    }

    return { samples, results };
  }
}
