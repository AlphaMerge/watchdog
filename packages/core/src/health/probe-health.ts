import { PROBE_HEALTH_CHANNELS, PROBE_HEALTH_COUNTERS } from '@ms/sensors';
import {
  describeError,
  describeSkew,
  explainSkew,
  type ChannelReading,
  type CheckResult,
  type Logger,
} from '@ms/shared';
import type { Database } from '../db/pool.js';
import { storedVoucher, type VoucherCheck } from '../objects/vouching.js';
import type { DeliveryVerdict } from '../probes/delivery.js';
import type { ProbeLink } from '../transport/probe-endpoint.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';

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

/** Everything the service needs to know about one probe, from wherever it comes. */
export interface ProbeHealthSources {
  /** The live link, from the probe endpoint. Answers for a probe that is not connected. */
  link: (probeObjectId: number) => ProbeLink;
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
  readonly delivery?: { verdictFor: (probeObjectId: number) => DeliveryVerdict | null };
  readonly ingest: (results: readonly CheckResult[]) => Promise<void>;
  /**
   * Asked before a sensor is read, whether whoever vouched for it may still read the probe it
   * reports on (`A-29`). A probe's health is `onObject('read')` on `/probes/:id/health`, and a
   * sensor must not go on publishing it to a branch its voucher lost.
   */
  readonly vouching: VoucherCheck;
  readonly now?: () => Date;
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

const MB = 1024 * 1024;

interface SensorRow {
  id: string;
  params: Record<string, unknown>;
  /** The probe ancestor of this sensor, or null when it has none. */
  probe_id: string | null;
  vouched_by: string;
  vouched_by_user: string | null;
}

export class ProbeHealthService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #sources: ProbeHealthSources;
  readonly #delivery: ProbeHealthServiceOptions['delivery'];
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #vouching: VoucherCheck;
  readonly #now: () => Date;

  #sweeps = 0;
  #evaluated = 0;
  #unresolved = 0;
  #withheld = 0;

  constructor(options: ProbeHealthServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'probe-health' });
    this.#sources = options.sources;
    this.#delivery = options.delivery;
    this.#ingest = options.ingest;
    this.#vouching = options.vouching;
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): ProbeHealthStats {
    return {
      sweeps: this.#sweeps,
      evaluated: this.#evaluated,
      unresolved: this.#unresolved,
      withheld: this.#withheld,
    };
  }

  /** Every channel for one probe, read now. Public so the API can answer without a sensor. */
  read(probeObjectId: number): { reading: ProbeHealthReading; message: string } {
    const link = this.#sources.link(probeObjectId);
    if (!link.connected) {
      // **The whole reason this is core-evaluated.** Everything else is a gap rather than a zero:
      // the probe's numbers are not zero, they are unknown, and a scheduler lag of 0 ms on a
      // probe that is gone is the most misleading reading this system could produce.
      return {
        reading: { ...blank(), connected: 0 },
        message: 'not connected to the core',
      };
    }

    const skew = describeSkew(link.protocolVersion);
    const health = link.health;
    const heartbeatAge =
      link.lastHeartbeatAt === null
        ? null
        : Math.max(0, Math.round((this.#now().getTime() - link.lastHeartbeatAt.getTime()) / 1_000));

    // **Computed here, not reported by the probe** (`P-74`). A probe that has stopped delivering
    // cannot be relied on to say so — the whole point is that it looks fine from its own side —
    // and this is a fact about arrivals, which only the core can see. No protocol field, and it
    // therefore works against a probe of any version.
    const delivery = this.#delivery?.verdictFor(probeObjectId) ?? null;

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
      schedulerLag: health?.schedulerLagMs?.p95 ?? null,
      poolUsage: poolUsage(health?.poolBusy, health?.poolSize),
      queued: health?.queued ?? null,
      checkWait: health?.queueWaitMs?.p95 ?? null,
      deferred: health?.deferred ?? null,
      refused: health?.refused ?? null,
      timedOut: health?.timedOut ?? null,
      workerCrashes: health?.workerCrashes ?? null,
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
      flowReceived: health?.flowReceived ?? null,
      flowRejected: health?.flowRejected ?? null,
      flowMalformed: health?.flowMalformed ?? null,
      flowMissed: health?.flowMissed ?? null,
      flowUndecodable: health?.flowUndecodable ?? null,
      // Null, not 0, when the probe sends nothing: a build with no child-process runner has
      // nothing to say here, and a confident zero cannot be told from one that is idle.
      childSlots: health?.childSlots ?? null,
      childBusy: health?.childBusy ?? null,
      childQueued: health?.childQueued ?? null,
      childDeferred: health?.childDeferred ?? null,
      childRefused: health?.childRefused ?? null,
      childTimedOut: health?.childTimedOut ?? null,
      childCrashes: health?.childCrashes ?? null,
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
      // Milliseconds on the wire, seconds on the channel: every other duration an operator reads
      // here is in seconds, and a threshold written in milliseconds beside them would be read
      // wrong exactly once.
      spoolStalled:
        health?.spoolStalledMs === undefined ? null : round(health.spoolStalledMs / 1000, 1),
      clockJumps: health?.clockJumps ?? null,
      cpu: health?.cpuPercent ?? null,
      memory: health?.memoryMb ?? null,
      uptime: health?.uptimeSeconds ?? null,
      // Absent from a probe older than protocol 17 and from one whose platform cannot say, and
      // either way a gap: a zero here would be the error limit firing on nothing (`P-208`).
      memoryAvailable: health?.memoryAvailablePercent ?? null,
      memoryAvailableBytes: health?.memoryAvailableMb ?? null,
      // Absent below protocol 18 and wherever the probe has no ceiling to be near (`P-210`).
      memoryLimitUsage: health?.memoryLimitUsagePercent ?? null,
      memoryLimit: health?.memoryLimitMb ?? null,
    };

    return {
      reading,
      message: describe(reading, skew, health !== undefined, health?.poolSize),
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
    const sensors = await this.#db.query<SensorRow>(
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
    if (sensors.length === 0) return 0;

    const at = this.#now().toISOString();
    const results: CheckResult[] = [];
    for (const row of sensors) {
      const sensorId = Number(row.id);
      // Not read and nothing recorded: a gap, and Unknown laid over it by the check (`A-29`).
      if (withheld.has(sensorId)) {
        this.#withheld += 1;
        continue;
      }
      const named = row.params['probeId'];
      const probeId = typeof named === 'number' ? named : Number(row.probe_id ?? Number.NaN);
      if (!Number.isInteger(probeId) || probeId <= 0) {
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

      try {
        const { reading, message } = this.read(probeId);
        results.push({
          sensorId,
          at,
          outcome: 'ok',
          durationMs: 0,
          channels: readingsFrom(reading),
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

    await this.#ingest(results);
    return results.length;
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
  reporting: boolean,
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
): string {
  const parts: string[] = [];
  const scheduled = reading['scheduled'];
  parts.push(
    scheduled === null || scheduled === undefined
      ? 'connected'
      : `connected, ${String(scheduled)} sensors scheduled`,
  );

  if (!reporting) {
    // **Said in words, never as an absent channel.** `R-06`'s rule: a probe that connects and
    // quietly does less than it should is the failure worth making visible.
    parts.push(`its own numbers are unavailable — it ${explainSkew(skew)}`);
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
  const spool = reading['spoolDepth'];
  if (spool !== null && spool !== undefined && spool > 0) {
    parts.push(`${String(spool)} results spooled`);
  }
  // Both mean the pair is speaking an older protocol than one end knows, and both are worth a
  // sentence: `outdated` says upgrade the probe, `ahead` says upgrade this core (`P-178`).
  if (skew.kind === 'outdated' || skew.kind === 'ahead') parts.push(explainSkew(skew));
  return parts.join(', ');
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
