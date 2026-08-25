import type { CheckResult, Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { LookupCatalogue } from '../lookups/catalogue.js';
import type { LookupDefinition } from '../lookups/definition.js';
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
}

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
  readonly #cache = new Map<string, ResolvedChannel>();
  /** Lookup ids already complained about, so a missing one is one log line and not one a scan. */
  readonly #missingLookups = new Set<string>();

  constructor(options: ChannelResolverOptions) {
    this.#logger = options.logger.child({ component: 'channel-resolver' });
    this.#lookups = options.lookups;
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

    const wanted = [...missing.values()];
    const sensorIds = wanted.map((row) => row.sensorId);
    const keys = wanted.map((row) => row.key);

    // Guarded by EXISTS rather than by the foreign key. A probe replaying a spool for a sensor
    // that has since been deleted is ordinary, not exceptional, and letting the foreign key
    // raise would fail the whole batch — including every other sensor's readings in it.
    const created = await q.query<{ id: number }>(
      `INSERT INTO channel (sensor_id, key, name, unit)
       SELECT s.sensor_id, s.key, s.name, s.unit
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[])
            AS s(sensor_id, key, name, unit)
       WHERE EXISTS (SELECT 1 FROM object o WHERE o.id = s.sensor_id AND o.kind = 'sensor')
       ON CONFLICT (sensor_id, key) DO NOTHING
       RETURNING id`,
      [sensorIds, keys, wanted.map((row) => row.name), wanted.map((row) => row.unit)],
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
      scale_mul: string;
      scale_div: string;
      spike_min: number | null;
      spike_max: number | null;
    }>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.decimals, c.limits,
              c.lookup_id, c.scale_mul, c.scale_div, c.spike_min, c.spike_max
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
      };
      ids.set(cacheKey, channel);
      this.#remember(cacheKey, channel);
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
