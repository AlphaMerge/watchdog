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
import type { ProbeLink } from '../transport/probe-endpoint.js';

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
  readonly ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly now?: () => Date;
}

export interface ProbeHealthStats {
  readonly sweeps: number;
  readonly evaluated: number;
  /** Sensors whose probe could not be worked out at all. */
  readonly unresolved: number;
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
}

export class ProbeHealthService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #sources: ProbeHealthSources;
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #now: () => Date;

  #sweeps = 0;
  #evaluated = 0;
  #unresolved = 0;

  constructor(options: ProbeHealthServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'probe-health' });
    this.#sources = options.sources;
    this.#ingest = options.ingest;
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): ProbeHealthStats {
    return { sweeps: this.#sweeps, evaluated: this.#evaluated, unresolved: this.#unresolved };
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

    const reading: ProbeHealthReading = {
      ...blank(),
      connected: 1,
      heartbeatAge,
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
      scheduled: health?.scheduled ?? null,
      spoolDepth: health?.spoolPending ?? null,
      spoolBytes: health?.spoolBytes === undefined ? null : round(health.spoolBytes / MB, 1),
      spoolDropped: health?.spoolDropped ?? null,
      clockJumps: health?.clockJumps ?? null,
      cpu: health?.cpuPercent ?? null,
      memory: health?.memoryMb ?? null,
      uptime: health?.uptimeSeconds ?? null,
    };

    return { reading, message: describe(reading, skew, health !== undefined) };
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
         SELECT o.id AS sensor_id, o.id, o.parent_id, o.kind
         FROM object o
         JOIN sensor_config sc ON sc.object_id = o.id
         WHERE sc.type = $1
         UNION ALL
         SELECT up.sensor_id, parent.id, parent.parent_id, parent.kind
         FROM object parent JOIN up ON parent.id = up.parent_id
       )
       SELECT sc.object_id::text AS id,
              sc.params AS params,
              (SELECT up.id::text FROM up WHERE up.sensor_id = sc.object_id AND up.kind = 'probe'
                 LIMIT 1) AS probe_id
       FROM sensor_config sc
       WHERE sc.type = $1`,
      [HEALTH_TYPE],
    );
    if (sensors.length === 0) return 0;

    const at = this.#now().toISOString();
    const results: CheckResult[] = [];
    for (const row of sensors) {
      const sensorId = Number(row.id);
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
function skewCode(kind: 'unknown' | 'current' | 'outdated' | 'incompatible'): number | null {
  switch (kind) {
    case 'current':
      return 0;
    case 'outdated':
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
  if (usage !== null && usage !== undefined) parts.push(`pool ${String(usage)}%`);
  const spool = reading['spoolDepth'];
  if (spool !== null && spool !== undefined && spool > 0) {
    parts.push(`${String(spool)} results spooled`);
  }
  if (skew.kind === 'outdated') parts.push(explainSkew(skew));
  return parts.join(', ');
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
