import type {
  CheckResult,
  CoreToProbeMessage,
  HousekeepingConfig,
  Logger,
  ProbeToCoreMessage,
} from '@ms/shared';
import type { Database } from '../db/pool.js';
import { RecentCount } from '../health/recent-count.js';
import { rollUp, type ChannelOutcome, type ChannelReadingFacts } from '../state/limits.js';
import { transformReading } from './scaling.js';
import { parseCounter, rateFrom, type CounterSample } from './counters.js';
import { CounterStore } from './counter-store.js';
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
  /**
   * Every counter that was read, including the ones that produced no sample (`P-107`).
   *
   * A reset, a stale gap and a first reading all have to move the baseline forward, or the next
   * scan divides against a value the device passed long ago and reports the same failure for
   * ever. Carried to the ingestor rather than committed here: see `IngestBatch.counters`.
   */
  counters: Map<number, CounterSample>;
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
  /**
   * How far ahead of this core's clock a result may be stamped before it is refused (`P-99`).
   *
   * Generous, because the honest sources of forward skew are small and legitimate — a probe host
   * a few seconds fast, a batch assembled just before it was sent — while the failure this
   * bounds is a clock that is *years* out. A tight bound would discard good data during ordinary
   * NTP drift; the point is only to keep one absurd timestamp from becoming a permanent
   * high-water mark.
   */
  maxFutureSkewMs?: number;
  /**
   * How far behind this core's clock a result may be stamped before it is refused (`P-231`).
   *
   * **As long as anything here keeps anything**, from `maxResultAgeMs(retention)`, and no
   * shorter. A probe's spool is bounded by bytes, not age, so a probe that was cut off for a
   * month replays a month, and every day of it is worth having: past the raw retention its
   * readings still fill the rollup tiers where they hold nothing (`P-226`), and its states still
   * count towards uptime for as long as `stateDays`. A result older than all of that would be
   * dropped by the next housekeeping pass from everywhere it was written, after creating chunks
   * for it and queueing a backfill that has nothing to do. What it catches is a clock that is
   * years out: a dead RTC back at 1970 or 2000, a VM restored from an old snapshot.
   */
  maxResultAgeMs?: number;
  /** The core's clock. Injectable so a test can state the skew rather than race it. */
  now?: () => Date;
  /** A monotonic clock in milliseconds, for the refusal windows. Injectable for the same reason. */
  monotonicMs?: () => number;
}

/** Fifteen minutes. See `maxFutureSkewMs`. */
export const DEFAULT_MAX_FUTURE_SKEW_MS = 15 * 60_000;

/** The longest anything is kept by default: `dailyDays` and `stateDays`, ten years. */
export const DEFAULT_MAX_RESULT_AGE_MS = 3_650 * 86_400_000;

/**
 * The age past which nothing a result carries would be kept anywhere (`P-231`).
 *
 * The longest of the sample tiers' retention and the state history's, because a result is a
 * state as well as readings and uptime comes from the state (`CLAUDE.md`). An installation that
 * keeps its daily rollups for thirty days and its states for ten years still wants a two-month
 * replay's states.
 */
export function maxResultAgeMs(retention: HousekeepingConfig['retention']): number {
  const days = Math.max(
    retention.rawDays,
    retention.fiveMinuteDays,
    retention.hourlyDays,
    retention.dailyDays,
    retention.stateDays,
  );
  return days * 86_400_000;
}

/** How far back `timeRefusals` counts: five minutes, ten Probe Health sweeps. */
export const TIME_REFUSAL_WINDOW_MS = 5 * 60_000;

/** Results one source has had refused for their timestamp in the last window, each way. */
export interface TimeRefusals {
  /** Stamped further back than anything is kept. */
  readonly past: number;
  /** Stamped further ahead of the core's clock than `maxFutureSkewMs`. */
  readonly future: number;
}

export interface ResultStats {
  resultsReceived: number;
  readingsReceived: number;
  /** Readings sent alongside a failed check, which a sensor in error is not allowed to have. */
  discardedOnError: number;
  /** Readings whose timestamp was not a date. */
  discardedInvalidTime: number;
  /** Batches whose `sentAt` could not be read, so staleness fell back to the core's clock. */
  discardedInvalidSentAt: number;
  /** Results stamped further ahead of this core's clock than `maxFutureSkewMs` (`P-99`). */
  discardedFutureTime: number;
  /** Results stamped further back than `maxResultAgeMs` (`P-231`). */
  discardedPastTime: number;
  /** Readings for sensors that no longer exist — a spool replayed after a deletion. */
  discardedUnknownSensor: number;
  /**
   * Readings thrown away by a channel's spike filter or because they were not numbers (`M-07`).
   *
   * Counted, never silent: a filter that is quietly eating a third of a channel's data looks
   * exactly like a device that stopped reporting, and only this number tells the two apart.
   */
  discardedReadings: number;
  /** The subset of the above that a spike filter rejected, rather than arithmetic. */
  discardedSpike: number;
  /**
   * Counter readings that produced no rate, by why (`T-02`).
   *
   * Each is a deliberate gap rather than a zero, and each means something different to an
   * operator looking at a broken graph: `first` is a sensor that has just been created and is
   * expected once; `reset` is a device that rebooted, and a *rising* count of them is a device
   * rebooting repeatedly; `stale` is a monitoring outage long enough that the delta across it
   * would be meaningless. Counted separately because "the graph has holes in it" has three very
   * different causes and only these numbers separate them.
   */
  counterFirst: number;
  counterReset: number;
  counterStale: number;
  /** Rates computed across a counter going round. Routine on 32 bits; never seen on 64. */
  counterWrapped: number;
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
  readonly #maxFutureSkewMs: number;
  readonly #maxResultAgeMs: number;
  readonly #now: () => Date;

  #resultsReceived = 0;
  #readingsReceived = 0;
  #discardedOnError = 0;
  #discardedInvalidTime = 0;
  #discardedFutureTime = 0;
  #discardedPastTime = 0;
  /**
   * The same two refusals by source and over a window, for Probe Health (`P-231`). A wrong clock
   * is one probe's, and a total across the fleet cannot say which. Bounded by the sources with a
   * refusal inside the window: an empty one is dropped when it is read.
   */
  readonly #refusedForTime = new Map<string, { past: RecentCount; future: RecentCount }>();
  readonly #windowClock: { monotonicMs?: () => number };
  #discardedInvalidSentAt = 0;
  #discardedUnknownSensor = 0;
  readonly #counters = new CounterStore();
  #discardedReadings = 0;
  #discardedSpike = 0;
  /** Counter readings that produced no rate, by why. Backpressure is visible (CLAUDE.md). */
  #counterFirst = 0;
  #counterReset = 0;
  #counterStale = 0;
  #counterWrapped = 0;
  #channelsCreated = 0;

  constructor(options: IngestionServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'ingestion' });
    this.#ingestor = options.ingestor;
    this.#resolver = options.resolver ?? new ChannelResolver({ logger: options.logger });
    this.#pacer = options.pacer;
    this.#states = options.states;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    this.#maxResultAgeMs = options.maxResultAgeMs ?? DEFAULT_MAX_RESULT_AGE_MS;
    this.#windowClock =
      options.monotonicMs === undefined ? {} : { monotonicMs: options.monotonicMs };
    this.#now = options.now ?? (() => new Date());
  }

  stats(): ResultStats {
    return {
      resultsReceived: this.#resultsReceived,
      readingsReceived: this.#readingsReceived,
      discardedOnError: this.#discardedOnError,
      discardedInvalidTime: this.#discardedInvalidTime,
      discardedInvalidSentAt: this.#discardedInvalidSentAt,
      discardedFutureTime: this.#discardedFutureTime,
      discardedPastTime: this.#discardedPastTime,
      discardedUnknownSensor: this.#discardedUnknownSensor,
      discardedReadings: this.#discardedReadings,
      discardedSpike: this.#discardedSpike,
      counterFirst: this.#counterFirst,
      counterReset: this.#counterReset,
      counterStale: this.#counterStale,
      counterWrapped: this.#counterWrapped,
      channelsCreated: this.#channelsCreated,
      cachedChannels: this.#resolver.cached,
      ...(this.#states === undefined ? {} : { state: this.#states.stats() }),
    };
  }

  /**
   * Results refused for their timestamp from one source in the last `TIME_REFUSAL_WINDOW_MS`.
   * Zero for a source nothing has been refused from, which is a count and not a gap: every
   * batch from it was looked at.
   */
  timeRefusals(source: string): TimeRefusals {
    const windows = this.#refusedForTime.get(source);
    if (windows === undefined) return { past: 0, future: 0 };
    const refusals = { past: windows.past.count(), future: windows.future.count() };
    if (refusals.past === 0 && refusals.future === 0) this.#refusedForTime.delete(source);
    return refusals;
  }

  /** Accepts a batch and returns the message to send back. Never throws. */
  async acceptResults(source: string, message: ResultsMessage): Promise<CoreToProbeMessage> {
    this.#resultsReceived += message.results.length;

    let prepared: Prepared;
    try {
      prepared = await this.#prepare(source, message.results);
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

    // **Parsed and checked, not trusted** (`P-180`). The wire schema is a 1-64 character string —
    // deliberately, because this validator runs without ajv-formats, where an unknown `format` is
    // silently no validation at all — so an unparseable value reaches here as an Invalid Date.
    // That is not `undefined`, so the documented "fall back to the core's clock" path could not
    // fire: `against` became NaN, `NaN - newest > grace` is always false, and the replay guard
    // failed open permanently for that peer, with nothing logged and both counters flat. Every
    // other probe-supplied timestamp in this path is checked and counted; this one is the field
    // the whole of `P-169` rests on.
    const sentAt = this.#sentAtOf(source, message.sentAt);

    const outcome = await this.#ingestor.submit({
      source,
      samples,
      // With the samples, not before them (`P-107`). A baseline that advanced for a batch the
      // ingestor refused would make the resent batch divide against itself.
      ...(prepared.counters.size === 0 ? {} : { counters: prepared.counters }),
      ...(decisions === undefined ? {} : { states: decisions }),
      // **When the probe sent this, by its own clock** (`P-169`). What decides whether the alarm
      // reaction runs on this batch or is held for a live one — measured against the results'
      // own timestamps, which come from the same machine, so no skew between the two clocks can
      // make a live probe look like it is replaying. Absent below protocol 16, and then the
      // ingestor falls back to its own clock.
      //
      // `backlog` is deliberately *not* this signal (`P-169`): it counts rows still on disk, so
      // a live probe whose scan tick outruns one batch reports thousands. It paces, which is
      // what `R-03` added it for.
      ...(sentAt === undefined ? {} : { sentAt }),
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
   * The probe's send time, or undefined if it did not send a usable one (`P-180`).
   *
   * Undefined is the honest answer for a value that cannot be read: it puts the ingestor back on
   * the core's own clock, which is `P-146`'s test and carries `P-146`'s skew problem — worse than
   * the probe's clock, better than a guard that silently never fires.
   */
  #sentAtOf(source: string, raw: string | undefined): Date | undefined {
    if (raw === undefined) return undefined;
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed;
    this.#discardedInvalidSentAt += 1;
    this.#logger.warn(
      { source, sentAt: raw },
      'probe sent an unreadable batch timestamp; judging this batch against the core clock',
    );
    return undefined;
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
  async #prepare(source: string, offered: readonly CheckResult[]): Promise<Prepared> {
    for (const result of offered) this.#readingsReceived += result.channels.length;
    const all = this.#believable(source, offered);

    const withReadings: CheckResult[] = [];
    for (const result of all) {
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

    // **In time order, because a counter is a fold over time** (`P-106`). The state machine
    // already sorts each sensor's results for the same reason; a batch is one message and the
    // probe writes its spool in the order it scanned, but nothing in the protocol *promises*
    // that order, and a running baseline walked out of order would divide against the future.
    withReadings.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    const resolved =
      withReadings.length === 0
        ? null
        : await this.#db.tx((q) => this.#resolver.resolve(q, withReadings));
    if (resolved !== null) {
      this.#channelsCreated += resolved.created;
      this.#discardedUnknownSensor += resolved.droppedReadings;
    }

    // Baselines for every counter channel in the batch, in one query. A probe's batch carries
    // every interface on every device it watches, so a round trip per channel would make ingest
    // cost more in bookkeeping than in samples.
    const counterChannelIds: number[] = [];
    for (const result of withReadings) {
      for (const reading of result.channels) {
        const channel = resolved?.ids.get(`${String(result.sensorId)}:${reading.key}`);
        if (channel?.counterBits != null) counterChannelIds.push(channel.id);
      }
    }
    const counterBaselines =
      counterChannelIds.length === 0
        ? new Map<number, CounterSample>()
        : await this.#db.tx((q) => this.#counters.load(q, counterChannelIds));
    const counterSeen = new Map<number, CounterSample>();

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

        // A counter becomes a rate before anything else touches it (`T-02`), because everything
        // downstream — scaling, the spike filter, limits, the graph — is about the rate. The raw
        // counter is a baseline, not a measurement.
        let measured = reading.value;
        if (channel.counterBits !== null) {
          const exact = parseCounter(reading.counter ?? String(reading.value));
          if (exact === null) {
            this.#discardedReadings += 1;
            continue;
          }
          const sample = { value: exact, at };
          // **The previous reading, not the pre-batch one** (`P-106`). `counterBaselines` is
          // loaded once for the whole batch, and a batch routinely carries many consecutive
          // scans of one sensor — a spool drain after an outage is exactly that, up to
          // `spoolCatchUpMaxRows` of them. Dividing every reading against the sample that
          // preceded the *batch* turns each rate into the running average since that point:
          // 6,000 octets in the first minute and none afterwards stored 100, 50, 33.3, 25 …
          // instead of 100, 0, 0, 0. And once the span passed `MAX_GAP_MS` every remaining
          // reading came back `stale` and was dropped, so a two-hour outage replayed as zero
          // counter samples for the whole window.
          const previous = counterSeen.get(channel.id) ?? counterBaselines.get(channel.id) ?? null;
          counterSeen.set(channel.id, sample);

          // The reading's own width wins: which counter the device actually offered is
          // discovered at scan time, and the channel's is what the type declared when the
          // sensor was created.
          const bits = reading.counterBits ?? channel.counterBits;
          const outcome = rateFrom(previous, sample, bits);
          if (outcome.kind !== 'rate') {
            // Every one of these is a gap rather than a zero: a first reading has nothing to
            // divide, a reset has a discontinuity in it, and a stale one spans a gap a 32-bit
            // counter may have gone round inside. Counted, never silent.
            if (outcome.kind === 'first') this.#counterFirst += 1;
            else if (outcome.kind === 'reset') this.#counterReset += 1;
            else if (outcome.kind === 'stale') this.#counterStale += 1;
            continue;
          }
          if (outcome.wrapped) this.#counterWrapped += 1;
          measured = outcome.perSecond;
        }

        // Scaled and spike-filtered before anything else looks at it (M-07). The scaled value
        // is what is stored *and* what is judged — one number, so a chart can never disagree
        // with the alarm that fired.
        const transformed = transformReading(measured, channel.transform);
        if (transformed.kind === 'discarded') {
          this.#discardedReadings += 1;
          if (transformed.reason === 'spike') this.#discardedSpike += 1;
          // Deliberately no sample and no fact: a discarded reading is a gap, not a zero, and
          // it contributes nothing to the channel's state either. A wrapped counter must not
          // decide whether a sensor is Down.
          continue;
        }

        samples.push({ channelId: channel.id, at, value: transformed.value });
        readings.push({
          key: reading.key,
          name: channel.name,
          unit: channel.unit,
          value: transformed.value,
          decimals: channel.decimals,
          limits: channel.limits,
          lookupId: channel.lookupId,
          lookup: channel.lookup,
        });
      }
      if (readings.length > 0) outcomes.set(result, rollUp(readings));
    }

    // Every result, whatever its outcome: a check that failed has no readings and is precisely
    // the one the state machine exists for. One that cannot be read is dropped, because a result
    // that cannot be ordered against the last one cannot be folded into a machine that is a fold
    // over time. The ones no clock could have produced have already gone, in `#believable`.
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

    return { samples, results, counters: counterSeen };
  }

  /**
   * The results whose timestamps a clock could have produced: none further ahead of this core
   * than `maxFutureSkewMs`, and none further back than anything is kept. The rest are counted,
   * by source, and logged once a batch.
   *
   * **Whole results, before anything reads them** (`P-144`). The future bound once refused the
   * *result*, so the state machine never saw it, after its readings had been turned into
   * samples. A probe with a clock years out wrote graph points stamped 2030 that nothing would
   * overwrite and no query would reach, and the sensor's own state never moved. Half of one
   * result believed and half not is the one outcome a bound like this must not produce, and
   * filtering here, first, is what makes it impossible rather than avoided: nothing below sees a
   * refused result, not the readings, not the state machine, not the channel resolver.
   *
   * **The future bound is not tidiness; without it one bad result freezes a sensor for ever**
   * (`P-99`). `last_result_at` is a high-water mark: `isStaleResult` discards everything no
   * newer, and `writeRuntimes` refuses to move a row backwards. A probe whose clock is years out
   * sends one result stamped 2030, and every genuine result after it, including the ones
   * reporting a real outage, is counted stale and dropped. **The past bound is** (`P-231`): a
   * result older than anything is kept would create chunks and a backfill for readings the next
   * housekeeping pass drops, and until then nothing said which probe it came from.
   *
   * Discarded rather than clamped. Clamping would write a reading at a time nobody measured it,
   * and `CLAUDE.md` is explicit that a value the system cannot stand behind is a gap. An
   * unreadable timestamp is not judged here; the callers count it their own way.
   */
  #believable(source: string, offered: readonly CheckResult[]): readonly CheckResult[] {
    const now = this.#now().getTime();
    const horizon = now + this.#maxFutureSkewMs;
    const floor = now - this.#maxResultAgeMs;
    const past = new Refused();
    const future = new Refused();
    const kept: CheckResult[] = [];
    for (const result of offered) {
      const at = Date.parse(result.at);
      if (at > horizon) future.add(at);
      else if (at < floor) past.add(at);
      else kept.push(result);
    }
    if (past.count === 0 && future.count === 0) return offered;

    const windows = this.#refusedForTime.get(source) ?? {
      past: new RecentCount(TIME_REFUSAL_WINDOW_MS, this.#windowClock),
      future: new RecentCount(TIME_REFUSAL_WINDOW_MS, this.#windowClock),
    };
    windows.past.add(past.count);
    windows.future.add(future.count);
    this.#refusedForTime.set(source, windows);
    this.#discardedPastTime += past.count;
    this.#discardedFutureTime += future.count;

    // Once a batch and not once a result: a probe whose clock is wrong is wrong for every result
    // it sends, and a line each is thousands a minute saying one thing.
    if (future.count > 0) {
      this.#logger.warn(
        {
          source,
          ...future.describe(),
          aheadMs: future.earliest - now,
          allowedMs: this.#maxFutureSkewMs,
        },
        'results stamped too far in the future to be believed were refused; check the probe host clock',
      );
    }
    if (past.count > 0) {
      this.#logger.warn(
        {
          source,
          ...past.describe(),
          behindMs: now - past.latest,
          allowedMs: this.#maxResultAgeMs,
        },
        'results stamped older than anything this core keeps were refused; check the probe host clock',
      );
    }
    return kept;
  }
}

/** How many of a batch's results one bound refused, and the span of their timestamps. */
class Refused {
  count = 0;
  earliest = Number.POSITIVE_INFINITY;
  latest = Number.NEGATIVE_INFINITY;

  add(at: number): void {
    this.count += 1;
    this.earliest = Math.min(this.earliest, at);
    this.latest = Math.max(this.latest, at);
  }

  describe(): { refused: number; earliest: string; latest: string } {
    return {
      refused: this.count,
      earliest: new Date(this.earliest).toISOString(),
      latest: new Date(this.latest).toISOString(),
    };
  }
}
