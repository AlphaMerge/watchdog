import type {
  CheckResult,
  CoreToProbeMessage,
  HousekeepingConfig,
  Logger,
  ProbeToCoreMessage,
  UnfitResults,
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
import { SensorOwnership, type Admitted } from './ownership.js';
import { ResultMemory } from './result-memory.js';
import type { ReplayPacer } from './replay-pacer.js';
import type { ProbeRefusals } from '../probes/refusals.js';
import type { ProbeOrigin } from '../transport/probe-endpoint.js';

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
   * Which probe may report which sensor (`P-228`). Shared with `ResultCacheInvalidator`, which
   * clears it on a move or a delete; a fresh one, never cleared, is only right for a test.
   */
  ownership?: SensorOwnership;
  /** Where a refused result is counted per probe, for Probe Health (`P-228`). */
  refusals?: ProbeRefusals;
  /**
   * Where a check a probe refused over its credentials' targets is taken out of the batch, and
   * its sensor held Unknown (`A-41c`): `CredentialVouching.reported`. Absent, such a result is
   * the failed scan it otherwise reads as.
   */
  credentialRefusals?: {
    reported(
      probeObjectId: number,
      results: readonly CheckResult[],
      lastResultAt: (sensorId: number) => Date | null | undefined,
    ): Promise<{
      readonly results: readonly CheckResult[];
      /** Marked withheld and not the probe's to mark, as sent: counted once each (`P-295`). */
      readonly unearned: readonly CheckResult[];
      /**
       * Refusals made under the configuration before the probe's last, and dropped (`A-53`), as
       * sent: counted once each (`P-299`).
       */
      readonly late: readonly CheckResult[];
      /** Results for a sensor withheld from the probe, and dropped (`A-72`), as sent: once each. */
      readonly withheldDropped: readonly CheckResult[];
      stored(landed: boolean): Promise<void>;
    }>;
  };
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
  /**
   * How many refused or fitted results are remembered for each probe, so one sent again is
   * counted once (`P-288`, `P-295`), before the slack (`ResultMemory`). `RESULTS_REMEMBERED`
   * unless a test states a smaller bound.
   */
  resultsRemembered?: number;
  /**
   * How many probes' results are remembered at once. `PROBES_REMEMBERED` unless a test states a
   * smaller bound.
   */
  probesRemembered?: number;
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
  /**
   * Results whose timestamp was not a date, dropped whole (`P-247`). The count of results, where
   * `discardedInvalidTime` counts their readings: a failed check carries none, and was counted
   * nowhere.
   */
  discardedUnreadableTime: number;
  /** Batches whose `sentAt` could not be read, so staleness fell back to the core's clock. */
  discardedInvalidSentAt: number;
  /** Results stamped further ahead of this core's clock than `maxFutureSkewMs` (`P-99`). */
  discardedFutureTime: number;
  /** Results stamped further back than `maxResultAgeMs` (`P-231`). */
  discardedPastTime: number;
  /** Readings for sensors that no longer exist — a spool replayed after a deletion. */
  discardedUnknownSensor: number;
  /**
   * A probe's results refused because the sensor is not under it (`P-228`), by why. `unknown`
   * is a sensor that does not exist (its readings are in `discardedUnknownSensor` too), `moved`
   * one that was under this probe once, and `foreign` one that never was.
   */
  refusedUnknown: number;
  refusedMoved: number;
  refusedForeign: number;
  /**
   * A probe's results refused because they cannot be made to fit the wire schema (`P-281`): a
   * field missing or of the wrong type, an outcome or a sensor id that is not one. Taken out of
   * the batch alone; the rest is stored and the batch acknowledged.
   */
  refusedUnfit: number;
  /**
   * Readings dropped from a probe's results by fitting them (`P-281`): a key that is empty, too
   * long, or holds a NUL or a lone surrogate, a value that is not a number, channels past the
   * five hundredth. A probe since `P-277` drops these before it sends, and logs them itself.
   */
  discardedUnfitReadings: number;
  /**
   * Refused and fitted results remembered so that one sent again is counted once (`P-288`,
   * `P-295`), across every probe: at most `RESULTS_REMEMBERED` and its slack for each of
   * `PROBES_REMEMBERED`.
   */
  resultsRemembered: number;
  /** Probes whose results are remembered, at most `PROBES_REMEMBERED`. */
  probesRemembered: number;
  /** Sensors whose owning probe is cached. */
  cachedOwners: number;
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
  /**
   * Of `channelsCreated`, those created without their declared shape (`P-306`): the sensor's
   * type could not declare its channels for the sensor's stored parameters, so the channel took
   * the type's answer to `{}`, or nothing, and may keep no lookup or counter width for good. On
   * Core Health as `channelsCreatedUndeclared`; the core log names the type, once for each kind
   * of error.
   */
  channelsCreatedUndeclared: number;
  /**
   * Of `channelsCreated`, those whose key the sensor's type does not declare for the sensor's
   * stored parameters though it promises to declare every key it reports (`P-321`), in a reading
   * taken under those parameters: a probe running a different build of the type (newer, or older
   * and still reporting a key this build renamed), or the type breaking its promise. On Core Health as
   * `channelsCreatedOutsideDeclaration`; the core log names the sensor, the type and the key.
   */
  channelsCreatedOutsideDeclaration: number;
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
  readonly #ownership: SensorOwnership;
  readonly #refusals: ProbeRefusals | undefined;
  readonly #credentialRefusals: IngestionServiceOptions['credentialRefusals'];
  readonly #states: SensorStateService | undefined;
  readonly #maxFutureSkewMs: number;
  readonly #maxResultAgeMs: number;
  readonly #now: () => Date;

  #resultsReceived = 0;
  #readingsReceived = 0;
  #discardedOnError = 0;
  #discardedInvalidTime = 0;
  #discardedUnreadableTime = 0;
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
  #refusedUnknown = 0;
  #refusedMoved = 0;
  #refusedForeign = 0;
  #refusedUnfit = 0;
  #discardedUnfitReadings = 0;
  /** The results already counted as refused or fitted, by probe and then by kind, sensor and time. */
  readonly #counted: ResultMemory;
  readonly #counters = new CounterStore();
  #discardedReadings = 0;
  #discardedSpike = 0;
  /** Counter readings that produced no rate, by why. Backpressure is visible (CLAUDE.md). */
  #counterFirst = 0;
  #counterReset = 0;
  #counterStale = 0;
  #counterWrapped = 0;
  #channelsCreated = 0;
  #channelsCreatedUndeclared = 0;
  #channelsCreatedOutsideDeclaration = 0;

  constructor(options: IngestionServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'ingestion' });
    this.#ingestor = options.ingestor;
    this.#resolver = options.resolver ?? new ChannelResolver({ logger: options.logger });
    this.#pacer = options.pacer;
    this.#ownership = options.ownership ?? new SensorOwnership();
    this.#refusals = options.refusals;
    this.#credentialRefusals = options.credentialRefusals;
    this.#states = options.states;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    this.#maxResultAgeMs = options.maxResultAgeMs ?? DEFAULT_MAX_RESULT_AGE_MS;
    this.#windowClock =
      options.monotonicMs === undefined ? {} : { monotonicMs: options.monotonicMs };
    this.#now = options.now ?? (() => new Date());
    this.#counted = new ResultMemory(options.resultsRemembered, options.probesRemembered);
  }

  stats(): ResultStats {
    return {
      resultsReceived: this.#resultsReceived,
      readingsReceived: this.#readingsReceived,
      discardedOnError: this.#discardedOnError,
      discardedInvalidTime: this.#discardedInvalidTime,
      discardedUnreadableTime: this.#discardedUnreadableTime,
      discardedInvalidSentAt: this.#discardedInvalidSentAt,
      discardedFutureTime: this.#discardedFutureTime,
      discardedPastTime: this.#discardedPastTime,
      discardedUnknownSensor: this.#discardedUnknownSensor,
      refusedUnknown: this.#refusedUnknown,
      refusedMoved: this.#refusedMoved,
      refusedForeign: this.#refusedForeign,
      refusedUnfit: this.#refusedUnfit,
      discardedUnfitReadings: this.#discardedUnfitReadings,
      resultsRemembered: this.#counted.size,
      probesRemembered: this.#counted.probes,
      cachedOwners: this.#ownership.cached,
      discardedReadings: this.#discardedReadings,
      discardedSpike: this.#discardedSpike,
      counterFirst: this.#counterFirst,
      counterReset: this.#counterReset,
      counterStale: this.#counterStale,
      counterWrapped: this.#counterWrapped,
      channelsCreated: this.#channelsCreated,
      channelsCreatedUndeclared: this.#channelsCreatedUndeclared,
      channelsCreatedOutsideDeclaration: this.#channelsCreatedOutsideDeclaration,
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

  /**
   * Accepts a batch from one of the core's own producers and returns the message to send back.
   * Never throws.
   *
   * **Trusted: nothing here asks whether the source may report these sensors.** The callers are
   * in this process — Core Health, Probe Health, a Sensor Factory (`IN_PROCESS_SOURCE`) — and
   * compute sensors no probe runs. A probe's batch comes through `acceptProbeResults`.
   */
  async acceptResults(source: string, message: ResultsMessage): Promise<CoreToProbeMessage> {
    return this.#accept(source, message, message.results);
  }

  /**
   * Accepts a probe's batch: what it may report is stored, and the rest refused (`P-228`).
   * Never throws.
   *
   * **Before `P-228` any probe could write any sensor.** The only check on the way in was that
   * the id named a sensor, so a probe could declare channels on, store readings to, and — with
   * an `error` outcome and no readings at all — turn Down and alarm on a sensor under a probe it
   * had never been given. Now a probe may report the sensors under its own probe object, and
   * nothing else.
   *
   * **The gate is in front of both halves, not in the channel resolver.** The resolver reads
   * `sensor_config` only for a channel it has not cached, and a failed check has no channels at
   * all and never reaches it, while the state machine takes every result. A gate there would
   * have let the most damaging case through.
   *
   * **Refused results are acknowledged, not refused back.** A `results-nack` asks the probe to
   * send the batch again, and it would, for ever: nothing about the batch will change. The ack
   * counts only what was stored.
   */
  async acceptProbeResults(
    origin: ProbeOrigin,
    message: ResultsMessage,
  ): Promise<CoreToProbeMessage> {
    let admitted: Admitted;
    try {
      admitted = await this.#ownership.admit(this.#db, origin.probeObjectId, message.results);
    } catch (error: unknown) {
      this.#resultsReceived += message.results.length;
      this.#logger.error(
        { err: error, source: origin.gid },
        'could not check which sensors a probe may report',
      );
      return {
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'storage-error',
        retryAfterMs: 1_000,
      };
    }

    const refused = this.#refuse(origin, admitted);
    if (refused > 0 && admitted.results.length === 0) {
      // Nothing left to store. Answered here rather than sent through the ingestor as an empty
      // batch, so a probe whose whole spool is for sensors that moved away drains it at once
      // instead of queueing behind every live batch to be told that nothing happened.
      this.#resultsReceived += message.results.length;
      return { type: 'results-ack', batchId: message.batchId, storedSamples: 0, retryAfterMs: 0 };
    }
    // **Before the machine sees the batch** (`A-41c`). A check the probe refused over where its
    // credentials may go is not a failed scan, and is taken out here: its sensor is held Unknown
    // with the probe's sentence. A sensor that was held and has a real result in this batch is
    // let go first, without being re-decided, so the result decides its state in one step.
    let results: readonly CheckResult[] = admitted.results;
    let batch: { stored(landed: boolean): Promise<void> } | undefined;
    if (this.#credentialRefusals !== undefined && origin.probeObjectId !== null) {
      try {
        const reported = await this.#credentialRefusals.reported(
          origin.probeObjectId,
          admitted.results,
          (sensorId) => this.#states?.peek(sensorId)?.facts.lastResultAt,
        );
        results = reported.results;
        batch = reported;
        if (reported.unearned.length > 0) {
          // **Marked withheld, and not this probe's to mark** (`A-41c`). Taken as the results
          // they are and counted with what Probe Health counts as refused: a probe that marks
          // what it should not is one to look at. Once however often it is sent (`P-295`).
          const unearned = reported.unearned.length;
          const counted = this.#countedOnce(origin.gid, reported.unearned);
          this.#refusals?.refused(origin.probeObjectId, counted);
          this.#logger.warn(
            {
              source: origin.gid,
              probeObjectId: origin.probeObjectId,
              results: unearned,
              ...(counted < unearned ? { countedBefore: unearned - counted } : {}),
            },
            'a probe marked results withheld for sensors it was not left to check, or that were ' +
              'not errors; taken as the results they are',
          );
        }
        if (reported.late.length > 0) {
          // **Refused under the configuration before the one the probe has now** (`A-53`). Not
          // failed scans and not stored: dropped, and never silently. Counted on Probe Health
          // apart from what the core refused from the probe (`A-56`): the probe followed its
          // configuration, and a count shared with the refusals that mean a probe is marking
          // what it should not would hide those behind every change to a set's targets. Once
          // however often it is sent (`P-299`).
          const late = reported.late.length;
          const counted = this.#countedOnce(origin.gid, reported.late);
          this.#refusals?.late(origin.probeObjectId, counted);
          this.#logger.info(
            {
              source: origin.gid,
              probeObjectId: origin.probeObjectId,
              results: late,
              ...(counted < late ? { countedBefore: late - counted } : {}),
            },
            'a probe refused to scan sensors its configuration has since stopped leaving to ' +
              'it; dropped, as neither a failed scan nor a reason to hold them',
          );
        }
        if (reported.withheldDropped.length > 0) {
          // **For a sensor the core is withholding from this probe** (`A-72`): made under a
          // configuration before, whatever it says. Dropped, so the sensor does not open with a
          // Down nobody can read when it is let go, and counted on Probe Health on its own, as
          // late refusals are: the probe did nothing wrong. Once however often it is sent
          // (`P-299`).
          const withheld = reported.withheldDropped.length;
          const counted = this.#countedOnce(origin.gid, reported.withheldDropped);
          this.#refusals?.withheld(origin.probeObjectId, counted);
          this.#logger.info(
            {
              source: origin.gid,
              probeObjectId: origin.probeObjectId,
              results: withheld,
              ...(counted < withheld ? { countedBefore: withheld - counted } : {}),
            },
            'a probe reported on sensors its configuration withholds from it; dropped, as made ' +
              'under a configuration before',
          );
        }
      } catch (error: unknown) {
        this.#resultsReceived += message.results.length;
        this.#logger.error(
          { err: error, source: origin.gid },
          'could not hold the sensors a probe refused to scan',
        );
        return {
          type: 'results-nack',
          batchId: message.batchId,
          reason: 'storage-error',
          retryAfterMs: 1_000,
        };
      }
    }
    if (results.length === 0 && admitted.results.length > 0) {
      // Every result was a refusal, and each has been taken. Nothing to store.
      this.#resultsReceived += message.results.length;
      await batch?.stored(true);
      return { type: 'results-ack', batchId: message.batchId, storedSamples: 0, retryAfterMs: 0 };
    }
    const reply = await this.#accept(origin.gid, message, results);
    // A sensor let go for a result in this batch stays let go only if the result was stored: the
    // probe sends a refused batch again, and it is let go then.
    await batch?.stored(reply.type === 'results-ack');
    return reply;
  }

  /**
   * What the parser refused from a probe's batch, or fitted (`P-281`), told once the batch, which
   * held only what was kept, has been acknowledged: so against the probe object the session has
   * resolved by then, and once however often a batch refused back is sent again.
   *
   * **Refused results are counted with what Probe Health counts as refused** (`reportsRefused`),
   * the core's own number, so it reads on a probe of any version, which is the point: what sends
   * a result that cannot be fitted is a probe built before `P-277`, or something that is not our
   * probe. No warning on it there, as there is none on the rest of `reportsRefused`: the sensor
   * whose results are refused goes without results, and that is what its own state says.
   *
   * **Counted once however often it is sent** (`P-288`). A batch whose acknowledgement was lost
   * is sent again, and the store takes it again without a second row; the counts must not take
   * it twice either. The batch id cannot say so: a probe numbers every send, so the batch sent
   * again has a new one, its spool may group it with results queued since, and the numbering
   * starts again with the process, so an id remembered would one day name another batch. A
   * result is what the store itself goes by: the same sensor at the same time is the same result,
   * so its probe, sensor and time are remembered once counted (`RESULTS_REMEMBERED` for each of
   * `PROBES_REMEMBERED` probes) and it is not counted again. A refused result with no sensor id or
   * no time cannot be named, and is counted every time it arrives: a resend of one of those counts
   * twice.
   *
   * **Warned once a batch, naming the sensors**, as `#refuse` does: a probe replaying an hour of
   * spool would otherwise write a line for every result in it. Warned for a batch sent again as
   * well, with how many were counted before: the log says what arrived.
   */
  unfitResults(origin: ProbeOrigin, unfit: UnfitResults): void {
    const refused = unfit.refused.length;
    const dropped = unfit.fitted.reduce((sum, one) => sum + one.droppedChannels, 0);
    // Received, though refused: the counter is what arrived, and the refusals say what became of
    // it. What was kept is counted when it is accepted, a batch sent again included.
    this.#resultsReceived += refused;
    this.#readingsReceived += dropped;
    const counted = unfit.refused.filter((one) =>
      this.#firstCount('refused', origin.gid, one.sensorId, one.at),
    ).length;
    // Only a result that lost readings is remembered: nothing else of a fitted one is counted.
    const droppedCounted = unfit.fitted.reduce(
      (sum, one) =>
        one.droppedChannels > 0 && this.#firstCount('fitted', origin.gid, one.sensorId, one.at)
          ? sum + one.droppedChannels
          : sum,
      0,
    );
    this.#refusedUnfit += counted;
    this.#discardedUnfitReadings += droppedCounted;
    this.#refusals?.refused(origin.probeObjectId, counted);
    if (refused > 0) {
      this.#logger.warn(
        {
          source: origin.gid,
          probeObjectId: origin.probeObjectId,
          results: refused,
          ...(counted < refused ? { countedBefore: refused - counted } : {}),
          sensorIds: [...new Set(unfit.refused.map((one) => one.sensorId))].slice(0, 20),
          refused: unfit.refused.slice(0, 5),
        },
        'a probe sent results that cannot be made to fit the protocol; refused, and the rest ' +
          'of the batch kept',
      );
    }
    if (unfit.fitted.length > 0) {
      this.#logger.warn(
        {
          source: origin.gid,
          probeObjectId: origin.probeObjectId,
          results: unfit.fitted.length,
          readingsDropped: dropped,
          ...(droppedCounted < dropped ? { readingsCountedBefore: dropped - droppedCounted } : {}),
          sensorIds: [...new Set(unfit.fitted.map((one) => one.sensorId))].slice(0, 20),
          fitted: unfit.fitted.slice(0, 5),
        },
        'a probe sent results that do not fit the protocol as they are; fitted as a current ' +
          'probe fits them before sending, and kept',
      );
    }
  }

  /**
   * Whether this result is to be counted as refused or fitted: true the first time it is seen,
   * and every time for one that cannot be named (`P-288`). Remembered in `ResultMemory`, which
   * forgets the least recent past either bound.
   *
   * **One `refused` kind for every refusal** (`P-295`): unfit, unknown, moved, foreign, and
   * `A-41c`'s unearned mark. One arrival of a result meets at most one of them, and a result is
   * the same result whatever refused it: one refused as moved and sent again after its sensor was
   * deleted is not a second refusal.
   *
   * **And for every result dropped as made under a configuration before** (`P-299`): `A-53`'s
   * late refusals and `A-72`'s results for a withheld sensor. Each is counted on Probe Health
   * apart from the refusals, but it is still one result the probe sent once: a late refusal sent
   * again after its grace ran out, and judged an unearned mark then, is the refusal the probe
   * made under the configuration before, counted already, and not a probe that marks what it
   * should not.
   */
  #firstCount(
    kind: 'refused' | 'fitted',
    gid: string,
    sensorId: number | null,
    at: string | null,
  ): boolean {
    if (sensorId === null || at === null) return true;
    // Unambiguous without quoting: a sensor id holds no space, and `at` is the rest.
    return this.#counted.first(gid, `${kind === 'refused' ? 'r' : 'f'}${String(sensorId)} ${at}`);
  }

  /** How many of these results are counted now: the ones not counted before (`#firstCount`). */
  #countedOnce(gid: string, results: readonly CheckResult[]): number {
    return results.filter((one) => this.#firstCount('refused', gid, one.sensorId, one.at)).length;
  }

  /**
   * Counts what `admit` refused, here and per probe. Returns how many results that was.
   *
   * **Counted once however often it is sent** (`P-295`), by the same memory as `unfitResults`: a
   * batch whose acknowledgement was lost comes again, and its refusals with it. Received counts
   * every arrival, as it does for a stored batch sent again; the refusals, and the readings of a
   * sensor that does not exist, count each result once. **Except `foreign`'s window**: Probe
   * Health's `reportsForeign` warns while the probe has sent work it was never given in the last
   * five minutes, and a result sent again is the probe sending it again. It is told every arrival,
   * so the warning lasts as long as it did; only the totals count the result once.
   */
  #refuse(origin: ProbeOrigin, admitted: Admitted): number {
    const { unknown, moved, foreign } = admitted.refused;
    const total = unknown.length + moved.length + foreign.length;
    if (total === 0) return 0;

    // Received, even though refused: the counter is what arrived, and the discards below say
    // what became of it.
    for (const list of [unknown, moved, foreign]) {
      for (const result of list) this.#readingsReceived += result.channels.length;
    }
    const first = (list: readonly CheckResult[]): CheckResult[] =>
      list.filter((one) => this.#firstCount('refused', origin.gid, one.sensorId, one.at));
    const unknownNew = first(unknown);
    const movedNew = first(moved);
    const foreignNew = first(foreign);
    for (const result of unknownNew) this.#discardedUnknownSensor += result.channels.length;
    this.#refusedUnknown += unknownNew.length;
    this.#refusedMoved += movedNew.length;
    this.#refusedForeign += foreignNew.length;
    this.#refusals?.refused(origin.probeObjectId, unknownNew.length + movedNew.length);
    this.#refusals?.foreign(origin.probeObjectId, foreign.length, foreignNew.length);
    const countedBefore = total - unknownNew.length - movedNew.length - foreignNew.length;

    if (foreign.length > 0) {
      // Warned once a batch, not once a result: a probe replaying an hour of spool for sensors it
      // never had would otherwise write thousands of identical lines. Warned for a batch sent
      // again as well: the log says what arrived.
      this.#logger.warn(
        {
          source: origin.gid,
          probeObjectId: origin.probeObjectId,
          results: foreign.length,
          ...(foreignNew.length < foreign.length
            ? { countedBefore: foreign.length - foreignNew.length }
            : {}),
          sensorIds: [...new Set(foreign.map((one) => one.sensorId))].slice(0, 20),
        },
        'a probe reported on sensors that were never under it; refused',
      );
    }
    if (unknown.length + moved.length > 0) {
      this.#logger.debug(
        {
          source: origin.gid,
          probeObjectId: origin.probeObjectId,
          unknown: unknown.length,
          moved: moved.length,
          ...(countedBefore > 0 ? { countedBefore } : {}),
        },
        'refused results for sensors deleted or moved away from this probe',
      );
    }
    return total;
  }

  async #accept(
    source: string,
    message: ResultsMessage,
    admitted: readonly CheckResult[],
  ): Promise<CoreToProbeMessage> {
    this.#resultsReceived += message.results.length;

    let prepared: Prepared;
    try {
      prepared = await this.#prepare(source, admitted);
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
    const unreadable: CheckResult[] = [];
    for (const result of all) {
      // **Before the outcome, and counted as results** (`P-247`). Counted only as readings, a
      // failed check with a time nobody can read, which carries none, was dropped below with
      // every counter at zero: the one result a batch most needs to carry, gone without a trace.
      if (Number.isNaN(Date.parse(result.at))) {
        unreadable.push(result);
        this.#discardedInvalidTime += result.channels.length;
        continue;
      }
      if (result.outcome === 'error') {
        this.#discardedOnError += result.channels.length;
        continue;
      }
      if (result.channels.length > 0) withReadings.push(result);
    }
    if (unreadable.length > 0) {
      this.#discardedUnreadableTime += unreadable.length;
      // Once a batch, as `#believable` logs: a build that cannot write a time writes none.
      this.#logger.warn(
        {
          source,
          count: unreadable.length,
          sensorIds: unreadable.slice(0, 5).map((result) => result.sensorId),
          at: unreadable[0]?.at,
        },
        'results whose time cannot be read were dropped; the probe is sending malformed timestamps',
      );
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
      this.#channelsCreatedUndeclared += resolved.createdUndeclared;
      this.#channelsCreatedOutsideDeclaration += resolved.createdOutsideDeclaration;
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
    // over time; it was counted above. The ones no clock could have produced have already gone,
    // in `#believable`.
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
   * unreadable timestamp is not judged here; `#prepare` counts it (`P-247`).
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
        // "Or the core's": a core whose own clock is behind refuses every probe (`P-247`), and Core
        // Health's `clockBehind` is what says which.
        "results stamped too far in the future to be believed were refused; check the probe host's clock, or the core's if every probe is refused",
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
