import type { CheckResult, Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { LookupCatalogue } from '../lookups/catalogue.js';
import type { LookupDefinition } from '../lookups/definition.js';
import type { ChannelShape } from '../state/declared-limits.js';
import { parseLimits, type ChannelLimits } from '../state/limits.js';
import { parseTransform, type ReadingTransform } from './scaling.js';

/**
 * A channel, resolved: its id and everything judging a reading needs (`M-04`).
 *
 * The limits ride along with the id because they are read on exactly the same path, at exactly
 * the same moment, for exactly the same rows. Fetching them separately would double the queries
 * a cold sensor costs and add a second cache to invalidate.
 */
export interface ResolvedChannel {
  readonly id: number;
  readonly name: string;
  readonly unit: string;
  readonly decimals: number | null;
  readonly limits: ChannelLimits;
  /** Scaling and the spike filter (`M-07`), applied before anything judges the reading. */
  readonly transform: ReadingTransform;
  /** What the channel names, whether or not this installation has it. */
  readonly lookupId: string | null;
  /** The definition, or `null` when there is none or the one it names is not loaded. */
  readonly lookup: LookupDefinition | null;
  /**
   * Set when this channel reports a counter and the stored sample is a rate (`T-02`).
   *
   * Read here rather than asked of the catalogue per reading: it rides with the channel exactly
   * as `lookupId` does, so the reading path stays one query and a type whose declaration changes
   * cannot silently reinterpret a channel that already has history.
   */
  readonly counterBits: 32 | 64 | null;
}

export interface ResolvedChannels {
  /** Channel by `sensorId:key`. */
  ids: Map<string, ResolvedChannel>;
  /** Channels created on this call, because this is the first result that mentioned them. */
  created: number;
  /** Readings whose sensor no longer exists. Dropped — but counted, never silently. */
  droppedReadings: number;
  droppedSensors: number;
}

export interface ChannelResolverOptions {
  logger: Logger;
  /** Absent leaves every channel's lookup unresolved, which is how it behaved before M-06. */
  lookups?: LookupCatalogue;
  /** Entries kept in memory. The v1 target is 15,000 channels, so the default holds them all. */
  maxCached?: number;
  /**
   * The thresholds a sensor type declares for a channel it did not declare at creation (`S-18`).
   *
   * **A channel can arrive here rather than at sensor creation**, and the two commonest reasons
   * are ordinary: a type whose channels depend on what the device answered, and a build that
   * added a channel to a type whose sensors already exist. Without this the second case gets its
   * declared limits only on the *next* restart, from the start-up pass — which is how `S-17`'s
   * new Core Health channels were found sitting unset with the limits they declare.
   *
   * Absent leaves every channel created here `unset`, which is what it did before.
   */
  declaredLimits?: (sensorType: string, channelKey: string) => ChannelLimits | null;
  /**
   * The rest of the declaration — the lookup and counter width (`P-80`).
   *
   * Without it a channel this path creates is judged by nothing (a lookup channel with a null
   * `lookup_id` and no limits falls through every branch of `evaluateChannel`) and a counter is
   * stored as a cumulative total rather than a rate. Both were silent on exactly the
   * installations that matter: the ones that existed before the channel was declared.
   *
   * Given the sensor's stored parameters and answering for each channel key that sensor declares
   * (`P-297`), since a lookup or a counter is often what a parameter chose.
   */
  declaredShape?: (
    sensorType: string,
    params: Readonly<Record<string, unknown>>,
  ) => ReadonlyMap<string, ChannelShape>;
}

/** A sensor's row, as far as what its type declares for a new channel goes. */
interface SensorDeclaring {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const NO_SHAPE: ChannelShape = { lookup: null, counterBits: null };

const DEFAULT_MAX_CACHED = 50_000;

/**
 * Maps `(sensorId, channelKey)` from the wire onto `channel.id`, creating channels the first
 * time a sensor reports them.
 *
 * Probes send keys, not ids. They have to: a probe learns what channels a check produces by
 * running it, and PRTG's model — channels appear on the first successful scan — is the one
 * `CAPABILITIES.MD` §1.1 describes. The alternative, pushing ids out to probes before they may
 * report, would make a new channel wait for a config round trip.
 *
 * The cache is what makes this affordable at the v1 target: a resolution is a map lookup on
 * every result after the first, so steady-state ingestion issues no channel queries at all.
 */
export class ChannelResolver {
  readonly #logger: Logger;
  readonly #lookups: LookupCatalogue | undefined;
  readonly #maxCached: number;
  readonly #declaredLimits: ChannelResolverOptions['declaredLimits'];
  readonly #declaredShape: ChannelResolverOptions['declaredShape'];
  readonly #cache = new Map<string, ResolvedChannel>();
  /** Lookup ids already complained about, so a missing one is one log line and not one a scan. */
  readonly #missingLookups = new Set<string>();
  /**
   * Counts forgets, so a read that one overtook is not cached (`P-240`). The second forget runs
   * after the edit commits, and a read that began before it would otherwise put the old limits
   * back after it — the edit then inert until the next one.
   */
  #generation = 0;

  constructor(options: ChannelResolverOptions) {
    this.#logger = options.logger.child({ component: 'channel-resolver' });
    this.#lookups = options.lookups;
    this.#declaredLimits = options.declaredLimits;
    this.#declaredShape = options.declaredShape;
    this.#maxCached = options.maxCached ?? DEFAULT_MAX_CACHED;
  }

  get cached(): number {
    return this.#cache.size;
  }

  /** Channels naming a lookup this installation has not loaded. Counted, never assumed away. */
  get unresolvedLookups(): number {
    return this.#missingLookups.size;
  }

  /** Forgets everything. For tests, and for whatever invalidates channels in a later phase. */
  clear(): void {
    this.#generation += 1;
    this.#cache.clear();
  }

  /**
   * Forgets one sensor's channels, so the next result re-reads them.
   *
   * What makes an edited limit take effect on the next scan rather than on the next restart
   * (`M-04`). Called from the audit sink, which every mutation already goes through — the same
   * reason `R-04`'s config push rides there rather than being remembered at each write site.
   *
   * A scan of the whole map, because the key is `sensorId:channelKey` and a second index would
   * be a second thing to keep in step. Limit edits are rare and the map holds the v1 target's
   * 15,000 channels, so this is microseconds on a path nobody is timing.
   */
  forget(sensorId: number): number {
    // Any sensor's, for every read in flight: which sensors a read covers is not worth tracking
    // for an event this rare, and a read that is not cached costs one query next time.
    this.#generation += 1;
    const prefix = `${String(sensorId)}:`;
    let dropped = 0;
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) {
        this.#cache.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * The declared thresholds for a set of channels about to be created (`S-18`).
   *
   * One extra statement, and only on the path that creates channels — which is a probe reporting
   * a key for the first time, not every batch. The sensor's *type* is what carries the
   * declaration and the resolver is given ids, so it has to be read; there is no way round that
   * short of the probe sending a type it has no reason to know the core cares about.
   */
  #declaredFor(
    sensors: ReadonlyMap<string, SensorDeclaring>,
    wanted: readonly { sensorId: number; key: string }[],
  ): (string | null)[] {
    const declared = this.#declaredLimits;
    if (declared === undefined) return wanted.map(() => null);

    return wanted.map((one) => {
      const sensor = sensors.get(String(one.sensorId));
      if (sensor === undefined) return null;
      const limits = declared(sensor.type, one.key);
      return limits === null ? null : JSON.stringify(limits);
    });
  }

  /**
   * The lookup and counter width each wanted channel declares, in the same order.
   *
   * Takes the sensors read rather than reading them, so the one query that answers both this and
   * `#declaredFor` is made once by the caller. It said it shared the query before and did not:
   * each of them awaited the read separately, which is two identical round trips on the
   * first-sighting path and a comment that was simply untrue.
   */
  #shapesFor(
    sensors: ReadonlyMap<string, SensorDeclaring>,
    wanted: readonly { sensorId: number; key: string }[],
  ): ChannelShape[] {
    const declared = this.#declaredShape;
    if (declared === undefined) return wanted.map(() => NO_SHAPE);
    // Once a sensor, however many of its channels are new: a table sensor's first scan is all of
    // them at once.
    const bySensor = new Map<string, ReadonlyMap<string, ChannelShape>>();
    return wanted.map((one) => {
      const id = String(one.sensorId);
      const sensor = sensors.get(id);
      if (sensor === undefined) return NO_SHAPE;
      let shapes = bySensor.get(id);
      if (shapes === undefined) {
        shapes = declared(sensor.type, sensor.params);
        bySensor.set(id, shapes);
      }
      return shapes.get(one.key) ?? NO_SHAPE;
    });
  }

  async #sensorsFor(
    q: Queryable,
    wanted: readonly { sensorId: number; key: string }[],
  ): Promise<Map<string, SensorDeclaring>> {
    const rows = await q.query<{ object_id: string; type: string; params: unknown }>(
      'SELECT object_id::text, type, params FROM sensor_config WHERE object_id = ANY($1::bigint[])',
      [[...new Set(wanted.map((one) => one.sensorId))]],
    );
    return new Map(
      rows.map((row) => [
        row.object_id,
        {
          type: row.type,
          params:
            typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
              ? (row.params as Record<string, unknown>)
              : {},
        },
      ]),
    );
  }

  async resolve(q: Queryable, results: readonly CheckResult[]): Promise<ResolvedChannels> {
    const ids = new Map<string, ResolvedChannel>();
    const missing = new Map<
      string,
      { sensorId: number; key: string; name: string; unit: string }
    >();

    for (const result of results) {
      for (const reading of result.channels) {
        const cacheKey = `${String(result.sensorId)}:${reading.key}`;
        const cached = this.#cache.get(cacheKey);
        if (cached !== undefined) {
          ids.set(cacheKey, cached);
          continue;
        }
        missing.set(cacheKey, {
          sensorId: result.sensorId,
          key: reading.key,
          // A probe sends display metadata only on a channel's first appearance; falling back to
          // the key keeps `channel.name` valid rather than rejecting the whole batch.
          name: reading.name ?? reading.key,
          unit: reading.unit ?? '',
        });
      }
    }

    if (missing.size === 0) {
      return { ids, created: 0, droppedReadings: 0, droppedSensors: 0 };
    }

    const generation = this.#generation;
    const wanted = [...missing.values()];
    const sensorIds = wanted.map((row) => row.sensorId);
    const keys = wanted.map((row) => row.key);
    // One query for both: the sensor's type carries the declaration, and its parameters choose
    // the lookups and counters in it (`P-297`).
    const sensors =
      this.#declaredLimits === undefined && this.#declaredShape === undefined
        ? new Map<string, SensorDeclaring>()
        : await this.#sensorsFor(q, wanted);
    const limits = this.#declaredFor(sensors, wanted);
    const shapes = this.#shapesFor(sensors, wanted);

    // Guarded by EXISTS rather than by the foreign key. A probe replaying a spool for a sensor
    // that has since been deleted is ordinary, not exceptional, and letting the foreign key
    // raise would fail the whole batch — including every other sensor's readings in it.
    const created = await q.query<{ id: number }>(
      `INSERT INTO channel (sensor_id, key, name, unit, lookup_id, counter_bits,
                            limits, limits_source)
       SELECT s.sensor_id, s.key, s.name, s.unit, s.lookup_id, s.counter_bits,
              COALESCE(s.limits, '{}'::jsonb),
              CASE WHEN s.limits IS NULL THEN 'unset' ELSE 'declared' END
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::jsonb[],
                   $6::text[], $7::smallint[])
            AS s(sensor_id, key, name, unit, limits, lookup_id, counter_bits)
       WHERE EXISTS (SELECT 1 FROM object o WHERE o.id = s.sensor_id AND o.kind = 'sensor')
       ON CONFLICT (sensor_id, key) DO NOTHING
       RETURNING id`,
      [
        sensorIds,
        keys,
        wanted.map((row) => row.name),
        wanted.map((row) => row.unit),
        limits,
        shapes.map((shape) => shape.lookup),
        shapes.map((shape) => shape.counterBits),
      ],
    );

    // One lookup for the whole set: it picks up both what was just created and what already
    // existed and therefore conflicted.
    const found = await q.query<{
      id: number;
      sensor_id: string;
      key: string;
      name: string;
      unit: string;
      decimals: number | null;
      limits: unknown;
      lookup_id: string | null;
      counter_bits: number | null;
      scale_mul: string;
      scale_div: string;
      spike_min: number | null;
      spike_max: number | null;
    }>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.decimals, c.limits,
              c.lookup_id, c.counter_bits, c.scale_mul, c.scale_div, c.spike_min, c.spike_max
       FROM channel c
       JOIN unnest($1::bigint[], $2::text[]) AS w(sensor_id, key)
         ON w.sensor_id = c.sensor_id AND w.key = c.key`,
      [sensorIds, keys],
    );

    for (const row of found) {
      const cacheKey = `${row.sensor_id}:${row.key}`;
      const channel: ResolvedChannel = {
        id: row.id,
        name: row.name,
        unit: row.unit,
        decimals: row.decimals,
        limits: parseLimits(row.limits),
        transform: parseTransform(row),
        lookupId: row.lookup_id,
        lookup: this.#lookupFor(row.lookup_id),
        counterBits: row.counter_bits === 32 || row.counter_bits === 64 ? row.counter_bits : null,
      };
      ids.set(cacheKey, channel);
      if (this.#generation === generation) this.#remember(cacheKey, channel);
    }

    let droppedReadings = 0;
    const droppedSensors = new Set<number>();
    for (const [cacheKey, row] of missing) {
      if (ids.has(cacheKey)) continue;
      droppedReadings += 1;
      droppedSensors.add(row.sensorId);
    }

    if (droppedReadings > 0) {
      this.#logger.warn(
        { readings: droppedReadings, sensors: droppedSensors.size },
        'discarded readings for sensors that no longer exist',
      );
    }

    return {
      ids,
      created: created.length,
      droppedReadings,
      droppedSensors: droppedSensors.size,
    };
  }

  /**
   * The definition a channel names, if this installation has it.
   *
   * A channel naming a lookup that is not loaded is judged by **nothing** — not by its limits.
   * Falling back would put a threshold the operator did not intend in charge of the state, and
   * the whole point of configuring a lookup is that a threshold is the wrong tool for the value.
   * So it is counted and said once, and the channel's `lookupId` is served to the UI, which can
   * compare it against `GET /lookups` and say so where somebody will read it.
   */
  #lookupFor(lookupId: string | null): LookupDefinition | null {
    if (lookupId === null) return null;
    const definition = this.#lookups?.get(lookupId);
    if (definition !== undefined) return definition;

    if (!this.#missingLookups.has(lookupId)) {
      this.#missingLookups.add(lookupId);
      this.#logger.warn(
        { lookupId },
        'a channel names a lookup this installation has not loaded; it will have no lookup state',
      );
    }
    return null;
  }

  #remember(cacheKey: string, channel: ResolvedChannel): void {
    // Oldest-first eviction. A channel that is still being reported is re-learned on its next
    // result, at the cost of one query; the cache exists to make the common case free, not to
    // be authoritative.
    if (this.#cache.size >= this.#maxCached) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(cacheKey, channel);
  }
}
