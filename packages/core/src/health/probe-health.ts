import { PROBE_HEALTH_CHANNELS, PROBE_HEALTH_COUNTERS } from '@ms/sensors';
import {
  capabilitiesFor,
  DeltaMeter,
  describeError,
  describeSkew,
  explainSkew,
  versionFor,
  type ChannelReading,
  type CheckResult,
  type Logger,
  type ProbeHealthReport,
} from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { ProtocolFlap } from '../objects/credential-vouching.js';
import { storedVoucher, type VoucherCheck } from '../objects/vouching.js';
import type { TimeRefusals } from '../ingestion/service.js';
import type { DeliveryVerdict } from '../probes/delivery.js';
import type { MemoryFold, ProbeLink } from '../transport/probe-endpoint.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import { judgeCoreClock, remoteClockOffsets } from './core-clock.js';
import { RecentCount } from './recent-count.js';

/**
 * Probe Health, evaluated by the core (`P-13`, and `P-04`'s remaining half).
 *
 * **The core evaluates this because a probe cannot report its own absence.** `R-05` made a lost
 * probe one alarm rather than a thousand: its sensors go Unknown, because nobody asked them
 * anything, and the single alarm comes from here. A sensor that ran *on* the probe would fall
 * silent at exactly that moment, and silence is not an alarm.
 *
 * So the reading is assembled from two halves. The core's half — connected or not, how old the
 * last heartbeat is, what protocol this probe speaks — is always available and is the half that
 * matters most. The probe's half — scheduler lag, pool saturation, deferred and refused checks,
 * spool depth — rides on the heartbeat from protocol 7, and when it is missing the channels
 * **gap** and the message says why, rather than reading zero.
 */

/**
 * Every reason a probe's own numbers can be missing (`P-255`), for the API's schema.
 *
 * - `not-connected`: no link, so nothing but `connected` has a value.
 * - `protocol`: the probe speaks a protocol older than the one that carries its numbers. The
 *   only reason that is about versions, and the only one whose sentence names one.
 * - `no-heartbeat`: connected, new enough, and no heartbeat has arrived on this session yet —
 *   the first seconds after either end restarts.
 * - `not-reported`: heartbeats arrive and carry no numbers, from a probe new enough to send them.
 */
export const PROBE_NUMBERS_UNAVAILABLE = [
  'not-connected',
  'protocol',
  'no-heartbeat',
  'not-reported',
] as const;

/**
 * Why Probe Health has none of the probe's own numbers, or `null` when it has them (`P-255`).
 *
 * **A value, not only a sentence.** The message used to give the protocol as the reason whatever
 * the reason was — "it speaks protocol 28, the same as this build" four seconds after a restart,
 * when the reason was that no heartbeat had arrived yet — and sent an operator looking at
 * versions. A caller that acts on the reason reads this; the sentence is for a person.
 */
export type ProbeNumbersUnavailable =
  | { reason: 'not-connected' }
  | { reason: 'protocol'; protocolVersion: number; requiredVersion: number }
  | { reason: 'no-heartbeat'; connectedSeconds: number }
  | { reason: 'not-reported' };

/** Everything the service needs to know about one probe, from wherever it comes. */
export interface ProbeHealthSources {
  /** The live link, from the probe endpoint. Answers for a probe that is not connected. */
  link: (probeObjectId: number) => ProbeLink;
  /**
   * Results the core refused from this probe for their timestamp (`P-231`), by its GID. Absent
   * on a build without ingestion, and then both channels gap.
   */
  timeRefusals?: (gid: string) => TimeRefusals;
  /**
   * What the core refused from this probe (`P-228`), from `ProbeRefusals`. Absent on a build
   * that does not count them, and then both channels gap rather than read a confident zero.
   */
  refusals?: (probeObjectId: number) => { refused: number; foreignRecently: number };
  /**
   * How many of this probe's refusals to scan the core dropped as made under the configuration
   * before its last (`A-53`, `A-56`), from `ProbeRefusals.lateFor`. Absent on a build that does
   * not count them, and then the channel gaps.
   */
  lateRefusals?: (probeObjectId: number) => number;
  /**
   * How many of this probe's results were for a sensor the core withholds from it, and dropped
   * (`A-72`), from `ProbeRefusals.withheldFor`. Absent, the channel gaps.
   */
  withheldResults?: (probeObjectId: number) => number;
  /**
   * The flap this probe's protocol version is in, or null when none (`A-72`), from
   * `CredentialVouching.protocolFlap`. Absent, the channel gaps and the sentence says nothing.
   */
  protocolFlap?: (probeObjectId: number) => ProtocolFlap | null;
  /**
   * How many of this probe's sensors its clock has frozen (`P-232`). Absent on a build without
   * the sweep, and then the channel gaps.
   */
  frozenSensors?: (probeObjectId: number) => number;
  /**
   * The memory lows every probe at protocol 20 reported since the last call, by probe, from the
   * endpoint's `drainMemory` (`P-219`). Drained by the sweep, once a sweep, and by nothing else
   * (`P-245`). Absent on a build without it, and then every probe is recorded by its latest
   * report, as below 20.
   */
  drainMemory?: () => ReadonlyMap<number, MemoryFold>;
  /**
   * Every probe connected now, from the endpoint (`P-250`). Each sweep takes every one's log
   * baseline from it, recorded or not; absent, `logDropped` gaps.
   */
  connectedProbeIds?: () => readonly number[];
}

export interface ProbeHealthServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly sources: ProbeHealthSources;
  /**
   * Whether each probe is still delivering (`P-74`), absent on a build without the sweep.
   *
   * Optional so the two channels gap rather than read a confident "delivering" on a core that is
   * not watching — absent is absent, the same rule the probe-reported channels follow.
   */
  readonly delivery?: {
    verdictFor: (probeObjectId: number) => DeliveryVerdict | null;
    /**
     * True while the core has yet to learn whether this probe is missing (`M-22`). The sweep
     * sends nothing for it meanwhile: a gap, never a synthetic reading.
     */
    awaitingFirstConnect?: (probeObjectId: number) => boolean;
  };
  readonly ingest: (results: readonly CheckResult[]) => Promise<void>;
  /**
   * Asked before a sensor is read, whether whoever vouched for it may still read the probe it
   * reports on (`A-29`). A probe's health is `onObject('read')` on `/probes/:id/health`, and a
   * sensor must not go on publishing it to a branch its voucher lost.
   */
  readonly vouching: VoucherCheck;
  /**
   * Where the sweep publishes which probe each sensor reports on (`M-22`). Shared with the alarm
   * engine, which is built long before this service. Absent, the service keeps its own.
   */
  readonly targets?: ProbeHealthTargets;
  /**
   * Told of the probes a sweep found with fewer Probe Health sensors reporting on them than the
   * last one, before its results go in (`M-27`). The alarm engine re-decides what those probes
   * hold, so a trigger that heard of a probe only from a Probe Health moved off it stops holding.
   * Absent, nobody is told.
   */
  readonly onReportersLost?: (probeObjectIds: readonly number[]) => Promise<void>;
  readonly now?: () => Date;
  /** How long this core has been running, in seconds. Injectable so a test can start it late. */
  readonly uptime?: () => number;
  /**
   * Milliseconds on a monotonic clock, for the five-minute counts taken from a probe's running
   * totals (`P-283`, `P-284`). Injectable so a test can move it.
   */
  readonly monotonicMs?: () => number;
}

export interface ProbeHealthStats {
  readonly sweeps: number;
  readonly evaluated: number;
  /** Sensors whose probe could not be worked out at all. */
  readonly unresolved: number;
  /** Sensors not read because of who vouched for them (`A-29`), counted per sweep. */
  readonly withheld: number;
}

/** One reading of every channel. `null` is a gap and stays one — never a zero (`CLAUDE.md`). */
export type ProbeHealthReading = Readonly<Record<string, number | null>>;

const HEALTH_TYPE = 'ms.probe.health';

/**
 * How far back the counts taken from a probe's running totals look (`P-283`, `P-284`):
 * `reportsForeign`'s five minutes, long enough to span ten sweeps and short enough to clear.
 */
const RECENT_WINDOW_MS = 5 * 60_000;

/**
 * The channels the core counts over the last five minutes from a probe's running totals, and the
 * total each is taken from: `undefined` when the probe sends none of it, which gaps the channel.
 *
 * **A count over a window, not a counter's rate** (`P-284`), because a rate gaps on the first
 * record after the total restarts and after a gap longer than the rate allows — a probe restart,
 * a long link outage — and a warning on a rate missed what fell in that record. The window is
 * fed by a `DeltaMeter`, which takes another `instanceId` (or, from a probe at 31, a total that
 * fell or an uptime that did) as a new process counting from zero, and growth across a link gap
 * as growth.
 */
const RECENT_TOTALS = {
  /** `P-284`: the refused script groups' running total, since protocol 31. */
  scriptGroupsRefusedRecently: (health: ProbeHealthReport): number | undefined =>
    health.scriptGroupsRefused,
  /** `P-283`: the spooled results the drain discarded, either way, since protocol 32. */
  resultsDiscarded: (health: ProbeHealthReport): number | undefined =>
    health.spoolRejected === undefined && health.spoolOversized === undefined
      ? undefined
      : (health.spoolRejected ?? 0) + (health.spoolOversized ?? 0),
} as const;

type RecentKey = keyof typeof RECENT_TOTALS;

const MB = 1024 * 1024;

interface SensorRow {
  id: string;
  params: Record<string, unknown>;
  /** The probe ancestor of this sensor, or null when it has none. */
  probe_id: string | null;
  vouched_by: string;
  vouched_by_user: string | null;
}

/** Every Probe Health sensor, with what decides the probe it reports on. */
async function readHealthSensors(q: Queryable): Promise<SensorRow[]> {
  return q.query<SensorRow>(
    `WITH RECURSIVE up AS (
       SELECT o.id AS sensor_id, o.id, o.parent_id, o.kind, 0 AS depth
       FROM object o
       JOIN sensor_config sc ON sc.object_id = o.id
       WHERE sc.type = $1
       UNION ALL
       SELECT up.sensor_id, parent.id, parent.parent_id, parent.kind, up.depth + 1
       FROM object parent JOIN up ON parent.id = up.parent_id
       WHERE up.depth < ${String(MAX_WALK_DEPTH)}
     )
     SELECT sc.object_id::text AS id,
            sc.params AS params,
            sc.vouched_by,
            sc.vouched_by_user::text AS vouched_by_user,
            (SELECT up.id::text FROM up WHERE up.sensor_id = sc.object_id AND up.kind = 'probe'
               LIMIT 1) AS probe_id
     FROM sensor_config sc
     WHERE sc.type = $1`,
    [HEALTH_TYPE],
  );
}

/** The probe a Probe Health sensor reports on: the one it names, or the one above it. */
function targetOf(row: SensorRow): number | undefined {
  const named = row.params['probeId'];
  const probeId = typeof named === 'number' ? named : Number(row.probe_id ?? Number.NaN);
  return Number.isInteger(probeId) && probeId > 0 ? probeId : undefined;
}

/**
 * Which probe each Probe Health sensor reports on (`M-22`).
 *
 * The alarm engine holds a lost or frozen probe's sensors behind these, so it has to know them
 * from the moment it can react. That includes the boot reconciliation, which runs long before
 * the first sweep. `refresh` resolves them from the tree for that, and every sweep publishes what
 * it actually read. A sensor it withheld or could not resolve is left out, because it raises
 * nothing.
 */
export class ProbeHealthTargets {
  #reportsOn: ReadonlyMap<number, number> = new Map();
  #reporting: ReadonlyMap<number, readonly number[]> = new Map();

  /** The Probe Health sensors reporting on this probe. */
  reportingOn(probeObjectId: number): readonly number[] {
    return this.#reporting.get(probeObjectId) ?? [];
  }

  /** The probe this Probe Health sensor reports on. */
  reportsOn(sensorId: number): number | undefined {
    return this.#reportsOn.get(sensorId);
  }

  /** From the tree, for a core that has not swept yet. */
  async refresh(q: Queryable): Promise<void> {
    const reportsOn = new Map<number, number>();
    for (const row of await readHealthSensors(q)) {
      const probe = targetOf(row);
      if (probe !== undefined) reportsOn.set(Number(row.id), probe);
    }
    this.publish(reportsOn);
  }

  /**
   * Replaces the targets with `reportsOn`, and returns the probes that a sensor stopped reporting
   * on (`M-27`): retargeted by an edit to its *Probe* parameter or a move, withheld, or deleted.
   */
  publish(reportsOn: ReadonlyMap<number, number>): number[] {
    const reporting = new Map<number, number[]>();
    for (const [sensorId, probeObjectId] of reportsOn) {
      const list = reporting.get(probeObjectId) ?? [];
      list.push(sensorId);
      reporting.set(probeObjectId, list);
    }
    const lost: number[] = [];
    for (const [sensorId, probeObjectId] of this.#reportsOn) {
      if (reportsOn.get(sensorId) !== probeObjectId && !lost.includes(probeObjectId)) {
        lost.push(probeObjectId);
      }
    }
    this.#reportsOn = reportsOn;
    this.#reporting = reporting;
    return lost;
  }
}

export class ProbeHealthService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #sources: ProbeHealthSources;
  readonly #delivery: ProbeHealthServiceOptions['delivery'];
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #vouching: VoucherCheck;
  readonly #now: () => Date;
  readonly #uptime: () => number;
  /**
   * One baseline per probe for its log's drops (`P-216` part 3), and the session it belongs to:
   * a new session starts a new baseline (`P-250`).
   */
  readonly #logMeters = new Map<number, { meter: DeltaMeter; session: number }>();
  /**
   * Per probe, the five-minute counts taken from its running totals (`P-283`, `P-284`), each with
   * the baseline it is taken against. Unlike the log's, a baseline outlives its session: what a
   * probe refused while its link was down is still a refusal, and the first record after the
   * link returns is the one that has to say so.
   */
  readonly #recent = new Map<
    number,
    Map<RecentKey, { meter: DeltaMeter; count: RecentCount; unknown: boolean }>
  >();
  readonly #monotonicMs: (() => number) | undefined;

  #sweeps = 0;
  #evaluated = 0;
  #unresolved = 0;
  #withheld = 0;
  readonly #targets: ProbeHealthTargets;
  readonly #onReportersLost: ((probeObjectIds: readonly number[]) => Promise<void>) | undefined;
  /** Probes that lost a reporter and whose held sensors are still to be re-decided (`M-27`). */
  readonly #releasing = new Set<number>();

  constructor(options: ProbeHealthServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'probe-health' });
    this.#sources = options.sources;
    this.#delivery = options.delivery;
    this.#ingest = options.ingest;
    this.#vouching = options.vouching;
    this.#targets = options.targets ?? new ProbeHealthTargets();
    this.#onReportersLost = options.onReportersLost;
    this.#now = options.now ?? ((): Date => new Date());
    this.#uptime = options.uptime ?? ((): number => process.uptime());
    this.#monotonicMs = options.monotonicMs;
  }

  /** Which probe each of these sensors reported on at the last sweep (`M-22`). */
  get targets(): ProbeHealthTargets {
    return this.#targets;
  }

  stats(): ProbeHealthStats {
    return {
      sweeps: this.#sweeps,
      evaluated: this.#evaluated,
      unresolved: this.#unresolved,
      withheld: this.#withheld,
    };
  }

  /**
   * Every channel for one probe, read now. Public so the API can answer without a sensor.
   *
   * `local` is the probe beside the core (`probe_config.is_local`), whose machine is the core's:
   * its machine-wide channels gap, because Core Health owns that reading (`M-21`). The sweep
   * passes it; the API does not, because it raises no alarm and the operator asking should see
   * what the probe reports.
   *
   * `coreClockOwned` is the sweep's verdict that every remote probe reads ahead, so the clock at
   * fault is the core's and Core Health says so (`P-247`): this probe's two clock warnings gap.
   */
  read(
    probeObjectId: number,
    /** `link` is the sweep's, read once for the reading and the record alike. */
    options: {
      readonly local?: boolean;
      readonly link?: ProbeLink;
      readonly coreClockOwned?: boolean;
    } = {},
  ): {
    reading: ProbeHealthReading;
    message: string;
    /** Why the probe's own numbers are gaps, or `null` when it reported them (`P-255`). */
    unavailable: ProbeNumbersUnavailable | null;
    /**
     * The protocol version this probe speaks on its current connection, or `null` when it is not
     * connected (`U-30`). What decides which of its numbers it can send at all: a probe that
     * reports, below the version a listener's counters arrived in, leaves them out whether the
     * listener runs or not.
     */
    protocolVersion: number | null;
  } {
    const link = options.link ?? this.#sources.link(probeObjectId);
    if (!link.connected) {
      // **The whole reason this is core-evaluated.** Everything else is a gap rather than a zero:
      // the probe's numbers are not zero, they are unknown, and a scheduler lag of 0 ms on a
      // probe that is gone is the most misleading reading this system could produce.
      return {
        reading: { ...blank(), connected: 0 },
        message: 'not connected to the core',
        unavailable: { reason: 'not-connected' },
        protocolVersion: null,
      };
    }

    const skew = describeSkew(link.protocolVersion);
    const health = link.health;
    const unavailable = whyUnavailable(link);
    const heartbeatAge =
      link.lastHeartbeatAt === null
        ? null
        : Math.max(0, Math.round((this.#now().getTime() - link.lastHeartbeatAt.getTime()) / 1_000));

    // **Computed here, not reported by the probe** (`P-74`). A probe that has stopped delivering
    // cannot be relied on to say so — the whole point is that it looks fine from its own side —
    // and this is a fact about arrivals, which only the core can see. No protocol field, and it
    // therefore works against a probe of any version.
    const delivery = this.#delivery?.verdictFor(probeObjectId) ?? null;
    // Also the core's, and for the same reason (`P-231`): a probe cannot see that its own clock
    // is wrong, only the core it is compared against can.
    const refused = this.#sources.timeRefusals?.(link.gid) ?? null;
    const refusals = this.#sources.refusals?.(probeObjectId);
    // `undefined` when nothing says, which gaps; null when the probe is in no flap (`A-72`).
    const flap =
      this.#sources.protocolFlap === undefined
        ? undefined
        : this.#sources.protocolFlap(probeObjectId);

    const reading: ProbeHealthReading = {
      ...blank(),
      connected: 1,
      heartbeatAge,
      delivering: delivery === null ? null : delivery.stalled ? 0 : 1,
      // How long since anything arrived. No limit: `delivering` is the alarm, and a second one
      // for the same outage is what "one outage, one alarm" forbids.
      resultAge:
        delivery?.silentForMs === null || delivery?.silentForMs === undefined
          ? null
          : Math.round(delivery.silentForMs / 1_000),
      // A skew of `unknown` gaps rather than taking a code: a lookup maps a reading to a state
      // and has no Unknown to map to, so the honest answer is no reading.
      protocol: skewCode(skew.kind),
      // How many times the version changed in the run that made it a flap, and 0 in none: a
      // probe that is not flapping is a reading, not a gap (`A-72`).
      protocolFlap: flap === undefined ? null : (flap?.changes ?? 0),
      reportsRefused: refusals?.refused ?? null,
      reportsForeign: refusals?.foreignRecently ?? null,
      // Not among `reportsRefused` (`A-56`): the probe refused honestly, under a configuration
      // it no longer has, and the two have to be told apart on the sensor.
      lateRefusals: this.#sources.lateRefusals?.(probeObjectId) ?? null,
      // Apart from both again (`A-72`): results the probe made for a sensor the core has since
      // stopped sending it, dropped. Nothing is wrong with the probe.
      resultsWithheld: this.#sources.withheldResults?.(probeObjectId) ?? null,
      schedulerLag: health?.schedulerLagMs?.p95 ?? null,
      poolUsage: poolUsage(health?.poolBusy, health?.poolSize),
      // Absent below protocol 19 (`P-236`); the memory cap also wherever memory cannot be read.
      poolCeiling: health?.poolCeiling ?? null,
      poolMemoryCap: health?.poolMemoryCap ?? null,
      poolHeldBack: health?.poolHeldBack ?? null,
      queued: health?.queued ?? null,
      checkWait: health?.queueWaitMs?.p95 ?? null,
      deferred: health?.deferred ?? null,
      refused: health?.refused ?? null,
      timedOut: health?.timedOut ?? null,
      workerCrashes: health?.workerCrashes ?? null,
      // `P-263`. A gap for either end below protocol 30.
      workerStartupFailed: health?.workerStartupFailed ?? null,
      // Null, not 0, when the probe does not send it: an older probe cannot say whether its pool
      // is alive, and reading that silence as "running" is the one mistake this channel exists to
      // prevent. The lookup's `undefinedState` makes the gap a warning rather than an Up.
      poolState: health?.poolState ?? null,
      discarded: health?.discarded ?? null,
      // Null for a probe too old to report it — absent is absent, and the lookup's
      // `undefinedState` makes that a warning rather than a confident "settling".
      checksCompleting: health?.checksCompleting ?? null,
      checksBehind: health?.checksBehind ?? null,
      checksOutstanding: health?.checksOutstanding ?? null,
      // Milliseconds on the wire, seconds on the channel — as `spoolStalled` below.
      checkStalled:
        health?.checkStalledMs === undefined ? null : round(health.checkStalledMs / 1000, 1),
      // Null rather than 0 for a probe running no such listener: a channel that gaps says "not
      // running one", and a zero says "running one and hearing nothing", which are different
      // answers to the question an operator is asking.
      trapReceived: health?.trapReceived ?? null,
      trapRejected: health?.trapRejected ?? null,
      trapMalformed: health?.trapMalformed ?? null,
      syslogReceived: health?.syslogReceived ?? null,
      syslogRejected: health?.syslogRejected ?? null,
      syslogMalformed: health?.syslogMalformed ?? null,
      // `B-14`. A gap for no listener and for either end below protocol 26, never a zero that
      // reads as a buffer that lost nothing.
      trapOverwritten: health?.trapOverwritten ?? null,
      syslogOverwritten: health?.syslogOverwritten ?? null,
      // `P-270`. What a resuming sensor's first scan named as before its window: neither read nor
      // lost. A gap for no listener and for either end below protocol 31, never a zero.
      trapEarlier: health?.trapEarlier ?? null,
      syslogEarlier: health?.syslogEarlier ?? null,
      flowReceived: health?.flowReceived ?? null,
      flowRejected: health?.flowRejected ?? null,
      flowMalformed: health?.flowMalformed ?? null,
      flowMissed: health?.flowMissed ?? null,
      flowUndecodable: health?.flowUndecodable ?? null,
      // `B-11`. A gap for no collector and for either end below protocol 25, never a zero that
      // reads as a buffer that lost nothing.
      flowOverwritten: health?.flowOverwritten ?? null,
      flowEarlier: health?.flowEarlier ?? null,
      // Null, not 0, when the probe sends nothing: a build with no child-process runner has
      // nothing to say here, and a confident zero cannot be told from one that is idle.
      childSlots: health?.childSlots ?? null,
      childBusy: health?.childBusy ?? null,
      childQueued: health?.childQueued ?? null,
      childDeferred: health?.childDeferred ?? null,
      childRefused: health?.childRefused ?? null,
      childTimedOut: health?.childTimedOut ?? null,
      childCrashes: health?.childCrashes ?? null,
      // `P-260`. A gap for no child runner and for either end below protocol 29, and the time
      // also until a child has started: no start measured is not a start that took no time.
      childStartupFailed: health?.childStartupFailed ?? null,
      childStartup: health?.childStartupMs?.p95 ?? null,
      // `P-275`. The script groups a dead check process left open: a gap for no child runner and
      // for either end below protocol 31, never a zero that says none was refused.
      scriptGroupsEnded: health?.scriptGroupsEnded ?? null,
      scriptGroupsRefused: health?.scriptGroupsRefused ?? null,
      // `P-284`. The refusals of the last five minutes, which carries the warning: counted however
      // they fell, across a probe restart or a link gap, which the counter's rate is not.
      scriptGroupsRefusedRecently: this.#recentCount(
        probeObjectId,
        health,
        'scriptGroupsRefusedRecently',
      ),
      scriptGroupsRecycled: health?.scriptGroupsRecycled ?? null,
      // `P-283`. Readings the wire could not carry, taken out of results: a gap for either end
      // below protocol 32.
      resultChannelsDropped: health?.resultChannelsDropped ?? null,
      // `?? null` throughout, so a probe whose registry keeps no session pools gaps these rather
      // than reading zero — a probe with nothing to report is not a probe with nothing open
      // (`P-36`, and `R-06` again).
      sessionsOpen: health?.sessionsOpen ?? null,
      sessionOverflows: health?.sessionOverflows ?? null,
      sessionsEvicted: health?.sessionsEvicted ?? null,
      sessionsOpened: health?.sessionsOpened ?? null,
      scheduled: health?.scheduled ?? null,
      skippedTicks: health?.skippedTicks ?? null,
      spoolDepth: health?.spoolPending ?? null,
      spoolBytes: health?.spoolBytes === undefined ? null : round(health.spoolBytes / MB, 1),
      spoolDropped: health?.spoolDropped ?? null,
      spoolUnwritten: health?.spoolUnwritten ?? null,
      spoolCorrupt: health?.spoolCorrupt ?? null,
      // `P-283`. What the drain discarded, refused as invalid or larger than a frame, as totals,
      // and both over the last five minutes, which carries the error. Gaps with no drain and for
      // either end below protocol 32.
      spoolRejected: health?.spoolRejected ?? null,
      spoolOversized: health?.spoolOversized ?? null,
      resultsDiscarded: this.#recentCount(probeObjectId, health, 'resultsDiscarded'),
      // Milliseconds on the wire, seconds on the channel: every other duration an operator reads
      // here is in seconds, and a threshold written in milliseconds beside them would be read
      // wrong exactly once.
      spoolStalled:
        health?.spoolStalledMs === undefined ? null : round(health.spoolStalledMs / 1000, 1),
      clockJumps: health?.clockJumps ?? null,
      // **Gaps while Core Health owns the clock** (`P-247`): every remote probe ahead is the
      // core's clock behind, one fault and Core Health's alarm, not one per probe naming the
      // wrong machine. The sentence still gives the offset. Refusals as too old stay: a core
      // that is behind does not cause them.
      resultsFutureDated: options.coreClockOwned === true ? null : (refused?.future ?? null),
      resultsPastDated: refused?.past ?? null,
      // The core's reading of the probe's clock, from the `sentAt` on what it sends (`P-232`).
      // Seconds, positive when the probe is behind; a gap until this session has sent one.
      clockOffset:
        link.clockOffsetMs === null || options.coreClockOwned === true
          ? null
          : round(link.clockOffsetMs / 1000, 1),
      sensorsFrozen: this.#sources.frozenSensors?.(probeObjectId) ?? null,
      cpu: health?.cpuPercent ?? null,
      memory: health?.memoryMb ?? null,
      uptime: health?.uptimeSeconds ?? null,
      // Absent from a probe older than protocol 17 and from one whose platform cannot say, and
      // either way a gap: a zero here would be the error limit firing on nothing (`P-208`).
      //
      // **A gap for the local probe too, whatever it sent** (`M-21`). Its machine is the core's,
      // both read the same `/proc/meminfo` the same way, and Core Health carries the same limits,
      // so one squeeze would be two sensors Down in the same sweep. Core Health owns it: it is the
      // only watch on a core with no local probe. The probe's own cgroup channels below are not
      // the machine's and stay.
      memoryAvailable: options.local === true ? null : (health?.memoryAvailablePercent ?? null),
      memoryAvailableBytes: options.local === true ? null : (health?.memoryAvailableMb ?? null),
      // Absent below protocol 18 and wherever the probe has no ceiling to be near (`P-210`).
      memoryLimitUsage: health?.memoryLimitUsagePercent ?? null,
      memoryLimit: health?.memoryLimitMb ?? null,
      // A count per record, so only a record takes one (`#recorded`). What `read` has is a running
      // total, which would warn for ever after one stall.
      logDropped: null,
      logBacklog:
        health?.logBacklogBytes === undefined ? null : round(health.logBacklogBytes / MB, 2),
    };

    return {
      reading,
      unavailable,
      protocolVersion: link.protocolVersion,
      message: describe(
        reading,
        skew,
        unavailable,
        health?.poolSize,
        { local: options.local === true, machineAvailablePercent: health?.memoryAvailablePercent },
        options.coreClockOwned === true && link.clockOffsetMs !== null
          ? -link.clockOffsetMs / 1_000
          : undefined,
        flap ?? undefined,
      ),
    };
  }

  /**
   * One sweep: every Probe Health sensor, each about the probe it names or the one it sits under.
   *
   * The probe is resolved in SQL by walking up from the sensor, because "the probe this sensor is
   * under" is a tree question and the tree lives in the database. A `probeId` parameter overrides
   * it — the case that matters is a sensor placed deliberately somewhere else, so that losing one
   * probe does not also lose the view of it.
   */
  async sweep(): Promise<number> {
    this.#sweeps += 1;
    // **Every fold, every sweep, before anything can skip a record** (`P-245`). A low this sweep
    // does not record is let go, and is a gap: its probe had no sensor yet, its sensor was
    // withheld or names no probe, the core had just started (`M-22`), there are no sensors at
    // all, or the sweep failed. Taken only where a record was written, a fold kept every low of
    // that time and gave the first record after it a squeeze long over, stamped now. Shared by
    // every sensor on one probe: two sensors reporting on it record the same lows (`P-219`).
    const folds = this.#sources.drainMemory?.();
    // **Every probe's log baseline, every sweep, for the same reason** (`P-250`). Taken only where
    // a record was written, a probe with no Probe Health dropping lines on Monday gave the sensor
    // added on Thursday a count of Monday's lines, stamped Thursday: a warning for a stall three
    // days over. Now what no record takes is let go, and is a gap, on every path that skips one.
    const logs = this.#advanceLogs();
    // **And every probe's five-minute counts** (`P-283`, `P-284`), recorded or not, so that a
    // count is dated by the sweep that first saw it whichever sensor reads it.
    this.#advanceRecent();
    const sensors = await readHealthSensors(this.#db);
    // Settled even when there are none, so a sensor withheld last sweep and deleted since is let
    // go rather than held Unknown for ever.
    const withheld = await this.#vouching.refusals(
      sensors.map((row) => ({
        sensorId: Number(row.id),
        sensorType: HEALTH_TYPE,
        params: row.params,
        enclosingProbeId: row.probe_id === null ? null : Number(row.probe_id),
        voucher: storedVoucher(row.vouched_by, row.vouched_by_user),
      })),
    );
    await this.#vouching.settle('probe-health', withheld);
    const reportsOn = new Map<number, number>();
    if (sensors.length === 0) {
      await this.#publish(reportsOn);
      return 0;
    }

    // The probe beside the core, whose machine Core Health owns (`M-21`). Read per sweep, not
    // per sensor: at most one, and a flag an approval can raise at any time.
    const local = new Set(
      (
        await this.#db.query<{ object_id: string }>(
          'SELECT object_id::text AS object_id FROM probe_config WHERE is_local',
        )
      ).map((row) => Number(row.object_id)),
    );

    // Whether the core's own clock is behind every remote probe, judged once for all of them
    // from the same live links Core Health reads (`P-247`).
    const coreClock = judgeCoreClock(
      remoteClockOffsets(this.#sources.connectedProbeIds?.() ?? [], local, (id) =>
        this.#sources.link(id),
      ),
    );

    const at = this.#now().toISOString();
    const results: CheckResult[] = [];
    for (const row of sensors) {
      const sensorId = Number(row.id);
      // Not read and nothing recorded: a gap, and Unknown laid over it by the check (`A-29`).
      if (withheld.has(sensorId)) {
        this.#withheld += 1;
        continue;
      }
      const probeId = targetOf(row);
      if (probeId === undefined) {
        // A sensor with no probe above it and none named. Not a silent gap: an operator who put
        // this sensor somewhere it cannot answer needs to be told, and the sentence says how.
        this.#unresolved += 1;
        results.push({
          sensorId,
          at,
          outcome: 'error',
          durationMs: 0,
          channels: [],
          message:
            'this Probe Health sensor has no probe above it and names none — set its Probe ' +
            'parameter, or move it under the probe it reports on',
        });
        continue;
      }

      reportsOn.set(sensorId, probeId);
      // **Not yet a probe that is gone** (`M-22`). A core that has just started has not heard
      // from any probe, and reading `connected` 0 for one that redials forty seconds in pages
      // every Down trigger over it once per restart. Nothing is sent until the delivery grace
      // has run out, the same one after which the watch marks the probe lost, so the sensor
      // keeps the state it had. The price: a probe genuinely dead at boot is named that much
      // later, exactly as late as the lost mark.
      if (this.#delivery?.awaitingFirstConnect?.(probeId) === true) continue;
      try {
        const link = this.#sources.link(probeId);
        const { reading, message } = this.read(probeId, {
          local: local.has(probeId),
          link,
          coreClockOwned: coreClock.owned && !local.has(probeId),
        });
        results.push({
          sensorId,
          at,
          outcome: 'ok',
          durationMs: 0,
          channels: readingsFrom(
            this.#recorded(probeId, link, reading, { folds, logs }, local.has(probeId)),
          ),
          message,
        });
        this.#evaluated += 1;
      } catch (error: unknown) {
        this.#logger.error(
          { ...describeError(error), sensorId, probeId },
          'could not read a probe’s health',
        );
        results.push({
          sensorId,
          at,
          outcome: 'error',
          durationMs: 0,
          channels: [],
          message: `Probe Health could not be read: ${messageOf(error)}`,
        });
      }
    }

    // Before the results go in, because they are what the alarm engine reacts to (`M-22`).
    await this.#publish(reportsOn);
    await this.#ingest(results);
    return results.length;
  }

  /**
   * Publishes the targets, and tells whoever is listening which probes lost a sensor reporting
   * on them (`M-27`). Nothing else re-decides what such a probe holds: the sensor itself still
   * has a row and may still be live, reporting on another probe now, so neither a pause's
   * reaction nor a delete's reaches the sensors it held.
   */
  async #publish(reportsOn: ReadonlyMap<number, number>): Promise<void> {
    for (const probe of this.#targets.publish(reportsOn)) this.#releasing.add(probe);
    const release = this.#onReportersLost;
    if (release === undefined || this.#releasing.size === 0) return;
    const probes = [...this.#releasing];
    try {
      await release(probes);
      for (const probe of probes) this.#releasing.delete(probe);
    } catch (error) {
      // Kept, so the next sweep asks again (`A-45`): the targets have moved, and it would find
      // nothing new to tell.
      this.#logger.error(
        { ...describeError(error), probes },
        'could not re-decide what a probe held after a Probe Health stopped reporting on it; the next sweep tries again',
      );
    }
  }

  /**
   * The reading as it is recorded: for a probe at protocol 20, its memory channels are every low
   * it reported since the last record, folded, and a gap when it reported none (`P-219`).
   *
   * **`read` gives the latest report, which is right for a scrape or the API and wrong for a
   * record.** Below 20 the latest report is the lowest of the last thirty seconds, and recording
   * it is what the core always did. From 20 a report covers only the time since the one before,
   * so the latest alone would drop the lows of every report between two records, and the fold is
   * what puts each in exactly one. A gap, not the last report again, when nothing arrived since:
   * at a heartbeat longer than thirty seconds every other record has no report of its own, and
   * repeating one would be a reading presented as new that nobody took.
   *
   * A probe that dropped since its last reports is still owed them, so a fold is recorded when
   * there is one, connected or not.
   */
  #recorded(
    probeId: number,
    link: ProbeLink,
    latest: ProbeHealthReading,
    taken: {
      folds: ReadonlyMap<number, MemoryFold> | undefined;
      /** Each connected probe's log drops since the last sweep, taken at its start (`P-250`). */
      logs: ReadonlyMap<number, number | null>;
    },
    local: boolean,
  ): ProbeHealthReading {
    const reading: ProbeHealthReading = {
      ...latest,
      // **Not the local probe's to report** (`P-216` part 3, `M-21`'s rule): it writes to the core's
      // journal, and a journal that stops reading makes both drop at once. Core Health counts the
      // local probe's lines with its own, so here it gaps. Taken all the same, so the baseline
      // stays current if the flag is lowered.
      logDropped: local ? null : (taken.logs.get(probeId) ?? null),
    };
    const folds = taken.folds;
    if (folds === undefined) return reading;
    const fold = folds.get(probeId);
    const folded = link.connected
      ? capabilitiesFor(link.protocolVersion).memorySinceLastReport
      : fold !== undefined;
    if (!folded) return reading;
    return {
      ...reading,
      // The local probe's machine is Core Health's, folded or not (`M-21`): `read` gapped the
      // pair, and a fold laid over it would be the second alarm for one squeeze.
      ...(local
        ? {}
        : {
            memoryAvailable: fold?.memoryAvailablePercent ?? null,
            memoryAvailableBytes: fold?.memoryAvailableMb ?? null,
          }),
      memoryLimitUsage: fold?.memoryLimitUsagePercent ?? null,
      memoryLimit: fold?.memoryLimitMb ?? null,
    };
  }

  /**
   * One of the five-minute counts for a probe, or `null` when it sends no total to count from, no
   * sweep has taken one yet, or the last sweep could only take a baseline (`P-283`, `P-284`). Read,
   * never advanced: the sweep advances them.
   */
  #recentCount(
    probeObjectId: number,
    health: ProbeHealthReport | undefined,
    key: RecentKey,
  ): number | null {
    if (health === undefined || RECENT_TOTALS[key](health) === undefined) return null;
    const entry = this.#recent.get(probeObjectId)?.get(key);
    if (entry === undefined || entry.unknown) return null;
    return entry.count.count();
  }

  /**
   * Adds what each connected probe's running totals grew by since the last sweep to its
   * five-minute counts (`P-283`, `P-284`).
   *
   * **Once a probe is known, everything counts.** The baseline outlives a session, so what grew
   * across a link gap, however long, is counted on the first sweep after it. A restart is told by
   * the probe's `instanceId` (protocol 32), so the restarted process's whole total is new whatever
   * its uptime; from a probe at 31, which sends none, by a total or an uptime that fell, which
   * misses a restart inside a gap longer than the old process's uptime with a total no lower.
   *
   * **A probe met for the first time** — the first sweep after this core started, or a probe it
   * has never had — counts its whole total only if it started after this core did. Otherwise the
   * core before this one may already have warned on what it holds, so the baseline is the first
   * report of its session: from protocol 32, sent the moment it is welcomed and before its drain
   * sends anything, so what it refused or discarded after that is counted. What is still not
   * seen: what it refused or discarded **before that first report** while this core was running —
   * a probe cut off across a core restart that refused while it was cut off. That sweep's reading
   * is a gap rather than a zero, unless it already counted something since the first report: it
   * does not know, and a zero would say nothing was refused.
   */
  #advanceRecent(): void {
    for (const probeId of this.#sources.connectedProbeIds?.() ?? []) {
      const link = this.#sources.link(probeId);
      if (!link.connected) continue;
      const health = link.health;
      const uptime = health?.uptimeSeconds;
      if (health === undefined || uptime === undefined) continue;
      let held = this.#recent.get(probeId);
      for (const key of Object.keys(RECENT_TOTALS) as RecentKey[]) {
        const total = RECENT_TOTALS[key](health);
        if (total === undefined) continue;
        if (held === undefined) {
          held = new Map();
          this.#recent.set(probeId, held);
        }
        const known = held.get(key);
        if (known !== undefined) {
          known.unknown = false;
          known.count.add(known.meter.take(total, uptime, false, health.instanceId) ?? 0);
          continue;
        }
        const entry = {
          meter: new DeltaMeter(),
          count: new RecentCount(
            RECENT_WINDOW_MS,
            this.#monotonicMs === undefined ? {} : { monotonicMs: this.#monotonicMs },
          ),
          unknown: false,
        };
        held.set(key, entry);
        if (uptime < this.#uptime()) {
          // Started after this core did: no core before this one can have counted any of it.
          entry.count.add(entry.meter.take(total, uptime, true, health.instanceId) ?? 0);
          continue;
        }
        const first = link.firstHealth;
        const firstTotal = first === undefined ? undefined : RECENT_TOTALS[key](first);
        if (first !== undefined && firstTotal !== undefined && first.uptimeSeconds !== undefined) {
          entry.meter.take(firstTotal, first.uptimeSeconds, false, first.instanceId);
        }
        const grown = entry.meter.take(total, uptime, false, health.instanceId) ?? 0;
        entry.count.add(grown);
        entry.unknown = grown === 0;
      }
    }
  }

  /**
   * Log lines each connected probe dropped since the last sweep (`P-216` part 3, `P-250`), from
   * the running total on its latest heartbeat. Taken for every probe at the start of every sweep,
   * so a window no record covers is let go rather than counted by the next one.
   *
   * **A count per sweep, not the total and not a counter's rate.** A total warns for ever after one
   * stall; a rate gaps on the first reading after the probe restarts, which is the reading that
   * covers the stall that restarted it. A probe this core meets already running gaps once,
   * because the core before this one may have recorded what it holds; one that started after this
   * core counts in full. **A new session gaps too**: the lines a probe dropped while it was not
   * connected fell in no sweep's window, and counting them at the reconnect would date them now.
   */
  #advanceLogs(): ReadonlyMap<number, number | null> {
    const taken = new Map<number, number | null>();
    const connected = this.#sources.connectedProbeIds?.() ?? [];
    for (const probeId of connected) {
      const link = this.#sources.link(probeId);
      if (!link.connected) continue;
      const total = link.health?.logDropped;
      const uptime = link.health?.uptimeSeconds;
      if (total === undefined || uptime === undefined) continue;
      const session = link.connectedAt.getTime();
      const held = this.#logMeters.get(probeId);
      if (held === undefined || held.session !== session) {
        const meter = new DeltaMeter();
        this.#logMeters.set(probeId, { meter, session });
        // A probe first seen by this core counts in full if it started after the core did; one
        // met again on a new session does not (above).
        taken.set(
          probeId,
          meter.take(total, uptime, held === undefined && uptime < this.#uptime()),
        );
        continue;
      }
      taken.set(probeId, held.meter.take(total, uptime, false));
    }
    return taken;
  }
}

/** Every channel present and null, so a caller cannot forget one and have it silently vanish. */
function blank(): Record<string, number | null> {
  return Object.fromEntries(PROBE_HEALTH_CHANNELS.map((key: string) => [key, null]));
}

/**
 * The reading as channel readings.
 *
 * A `null` is left out rather than sent as zero — the rule the whole ticket turns on. A
 * `schedulerLag` of 0 ms from a probe that is not answering would be the most confidently wrong
 * number this system could store.
 */
export function readingsFrom(reading: ProbeHealthReading): ChannelReading[] {
  const out: ChannelReading[] = [];
  for (const key of PROBE_HEALTH_CHANNELS) {
    const value = reading[key];
    if (value === undefined || value === null || !Number.isFinite(value)) continue;
    out.push(
      PROBE_HEALTH_COUNTERS.has(key)
        ? { key, value, counter: String(Math.trunc(value)), counterBits: 64 }
        : { key, value },
    );
  }
  return out;
}

/** `null` for `unknown`, which has no lookup code and must be a gap. */
function skewCode(
  kind: 'unknown' | 'current' | 'outdated' | 'ahead' | 'incompatible',
): number | null {
  switch (kind) {
    case 'current':
      return 0;
    case 'outdated':
      return 1;
    // **The same code as `outdated`, deliberately** (`P-178`). Both mean "the pair is speaking an
    // older protocol than one of them knows", which is the fact this channel exists to surface;
    // which *end* is behind is in the explanation beside it, and adding a fourth code would
    // change a lookup table that operators have already mapped to states.
    case 'ahead':
      return 1;
    case 'incompatible':
      return 2;
    // Unreachable from `read`, whose version comes from a live session — but the union carries
    // it, and a gap is the only honest answer: a lookup maps a *reading* to a state and has no
    // Unknown to map to, so inventing a fourth code would have meant marking every probe after
    // an upgrade as something until it reconnected.
    case 'unknown':
      return null;
  }
}

/**
 * Below this the local probe's message names its machine's memory (`M-21`): Probe Health's own
 * warning limit, which the local probe's channel no longer applies.
 */
const MACHINE_LOW_PERCENT = 20;

function poolUsage(busy: number | undefined, size: number | undefined): number | null {
  // A pool of zero is not 0% used — it is a pool that does not exist, and dividing by it would
  // report either a gap or Infinity depending on the numerator.
  if (busy === undefined || size === undefined || size <= 0) return null;
  return round((busy / size) * 100, 1);
}

/** The one line an operator reads in a list. */
function describe(
  reading: ProbeHealthReading,
  skew: ReturnType<typeof describeSkew>,
  /** `null` when the probe reported its own numbers. */
  unavailable: ProbeNumbersUnavailable | null,
  /**
   * Workers the probe is currently holding.
   *
   * Named in the message since `P-18`, because the pool is no longer a fixed size an operator
   * can be assumed to know: "pool 0%" is the same sentence for four workers and for
   * forty-eight, and the difference between them is whether a probe has room. The *channel*
   * stays a percentage — that is the number a limit is set on — and the size belongs in the
   * sentence beside it rather than as a channel of its own.
   */
  poolSize?: number,
  /**
   * The local probe's machine, which its channels leave to Core Health (`M-21`). Named in words
   * when it is low, so the probe's sensor says why things may be slow without a second alarm.
   */
  machine: { local: boolean; machineAvailablePercent: number | undefined } = {
    local: false,
    machineAvailablePercent: undefined,
  },
  /**
   * Seconds this probe reads ahead of the core, when every remote probe does and Core Health
   * reports it as the core's clock (`P-247`). Said in words, since the channels gap.
   */
  aheadOfCoreSeconds?: number,
  /** The flap the probe's protocol version is in, which the sentence names (`A-72`). */
  flap?: ProtocolFlap,
): string {
  const parts: string[] = [];
  const scheduled = reading['scheduled'];
  parts.push(
    scheduled === null || scheduled === undefined
      ? 'connected'
      : `connected, ${String(scheduled)} sensors scheduled`,
  );
  // **The flap, named** (`A-72`): first, because it is why sensors under this probe are Unknown
  // and say nothing of it themselves, and the core's, so on a probe of any version.
  if (flap !== undefined) {
    parts.push(
      `its protocol version changed ${String(flap.changes)} times in ${minutes(flap.sinceMs)} ` +
        `and is ${String(flap.version)} now, so the sensors its version decides hold where they ` +
        `stood, as at protocol ${String(flap.floor)}, until it has held one version for an hour ` +
        `(${minutes(flap.remainingMs)} from now if it holds)`,
    );
  }
  // Before the probe's own numbers, because it is the core's and reads on a probe of any version
  // — and because it is the one part of this sentence that is about trust rather than load.
  const foreign = reading['reportsForeign'];
  if (foreign !== null && foreign !== undefined && foreign > 0) {
    parts.push(
      `${String(foreign)} report${foreign === 1 ? '' : 's'} on work never given to it in the ` +
        'last 5 minutes, refused',
    );
  }

  // The core's measurement, so on a probe of any version, and before its own numbers.
  if (aheadOfCoreSeconds !== undefined) {
    parts.push(
      `its clock reads ${String(Math.round(aheadOfCoreSeconds))} s ahead of the core's, as every ` +
        "probe's does, which Core Health reports as the core's clock",
    );
  }
  if (unavailable !== null) {
    // **Said in words, never as an absent channel.** `R-06`'s rule: a probe that connects and
    // quietly does less than it should is the failure worth making visible.
    //
    // **And the reason it is, not a protocol by default** (`P-255`). Only `protocol` names a
    // version as the cause; the others say what is actually missing, and a real skew beside them
    // is named as a skew, as it is on a probe that reports.
    switch (unavailable.reason) {
      case 'protocol':
        parts.push(`its own numbers are unavailable — it ${explainSkew(skew)}`);
        return parts.join('; ');
      case 'no-heartbeat':
        parts.push(
          'its own numbers are not in yet — no heartbeat has arrived in the ' +
            `${span(unavailable.connectedSeconds)} since it connected`,
        );
        break;
      case 'not-reported':
        parts.push('its own numbers are unavailable — its heartbeats arrive without them');
        break;
      // Unreachable: `read` answers a lost probe before it describes anything.
      case 'not-connected':
        return 'not connected to the core';
    }
    if (skew.kind === 'outdated' || skew.kind === 'ahead') parts.push(explainSkew(skew));
    return parts.join('; ');
  }

  const lag = reading['schedulerLag'];
  if (lag !== null && lag !== undefined) parts.push(`scheduler lag ${String(lag)} ms`);
  const usage = reading['poolUsage'];
  if (usage !== null && usage !== undefined) {
    parts.push(
      poolSize === undefined
        ? `pool ${String(usage)}%`
        : `pool ${String(usage)}% of ${String(poolSize)}`,
    );
  }
  // Named when it binds (`P-236`): "pool 100% of 77" reads as a probe that needs a bigger
  // `workerPoolSize`, and the remedy is memory instead.
  const heldBack = reading['poolHeldBack'];
  const ceiling = reading['poolCeiling'];
  if (
    heldBack !== null &&
    heldBack !== undefined &&
    heldBack > 0 &&
    ceiling !== null &&
    ceiling !== undefined
  ) {
    parts.push(
      `memory holds the pool at ${String(ceiling)} workers, ${String(heldBack)} short of its ceiling`,
    );
  }
  const available = machine.machineAvailablePercent;
  if (machine.local && available !== undefined && available < MACHINE_LOW_PERCENT) {
    parts.push(`its machine has ${String(available)}% memory available, which Core Health reports`);
  }
  const spool = reading['spoolDepth'];
  if (spool !== null && spool !== undefined && spool > 0) {
    parts.push(`${String(spool)} results spooled`);
  }
  // Named, because each is the cause of its own limit and the channel name alone says less than
  // the sentence (`P-283`, `P-284`).
  const discarded = reading['resultsDiscarded'];
  if (discarded !== null && discarded !== undefined && discarded > 0) {
    parts.push(
      `${String(discarded)} result${discarded === 1 ? '' : 's'} discarded unsent in the last ` +
        '5 minutes',
    );
  }
  const refusedGroups = reading['scriptGroupsRefusedRecently'];
  if (refusedGroups !== null && refusedGroups !== undefined && refusedGroups > 0) {
    parts.push(
      `${String(refusedGroups)} process group${refusedGroups === 1 ? '' : 's'} a check process ` +
        `named as its own and ${refusedGroups === 1 ? 'was' : 'were'} not, left alone, in the ` +
        'last 5 minutes',
    );
  }
  // Both mean the pair is speaking an older protocol than one end knows, and both are worth a
  // sentence: `outdated` says upgrade the probe, `ahead` says upgrade this core (`P-178`).
  if (skew.kind === 'outdated' || skew.kind === 'ahead') parts.push(explainSkew(skew));
  return parts.join(', ');
}

/**
 * Why a connected probe's own numbers are missing, or `null` when they are not (`P-255`).
 *
 * **The protocol first**, because a probe too old to carry its numbers will not carry them on any
 * heartbeat, so its first one arriving changes nothing. Then whether one has arrived on this
 * session — `lastHeartbeatAt` belongs to the session and starts null on each — and only then the
 * probe that sends heartbeats and leaves its numbers out.
 */
function whyUnavailable(
  link: Extract<ProbeLink, { connected: true }>,
): ProbeNumbersUnavailable | null {
  if (link.health !== undefined) return null;
  if (!capabilitiesFor(link.protocolVersion).healthReporting) {
    return {
      reason: 'protocol',
      protocolVersion: link.protocolVersion,
      requiredVersion: versionFor('healthReporting'),
    };
  }
  if (link.lastHeartbeatAt === null) {
    // The monotonic age, not `connectedAt` against the wall clock: a duration is arithmetic.
    return { reason: 'no-heartbeat', connectedSeconds: Math.round(link.connectedForMs / 1_000) };
  }
  return { reason: 'not-reported' };
}

/** Seconds as a sentence reads them: seconds under two minutes, whole minutes after. */
function span(seconds: number): string {
  return seconds < 120 ? `${String(seconds)} s` : minutes(seconds * 1_000);
}

/** A span as an operator reads it in a sentence: whole minutes, rounded up, never none. */
function minutes(ms: number): string {
  const whole = Math.max(1, Math.ceil(ms / 60_000));
  return `${String(whole)} minute${whole === 1 ? '' : 's'}`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
