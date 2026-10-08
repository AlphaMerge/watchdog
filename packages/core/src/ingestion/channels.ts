import type { CheckResult, Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { LookupCatalogue } from '../lookups/catalogue.js';
import type { LookupDefinition } from '../lookups/definition.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ChannelDeclaration } from '../objects/redeclare.js';
import type { ChannelShape, DeclaredShapes } from '../state/declared-limits.js';
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
  /**
   * Of `created`, those whose sensor's type could not declare its channels for the sensor's
   * stored parameters, so they were created from its answer to `{}` or from nothing (`P-306`).
   * Each may lack a lookup or counter width for good: nothing writes the row again.
   */
  createdUndeclared: number;
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
   * (`P-297`), since a lookup or a counter is often what a parameter chose; and saying when the
   * type could not answer for them, so the channels created from its fallback are counted
   * (`P-306`).
   */
  declaredShape?: (
    sensorType: string,
    params: Readonly<Record<string, unknown>>,
    sensorId: number,
  ) => DeclaredShapes;
  /**
   * Where a primary this path moves is recorded (`P-314`): a `channel.redeclared` entry for each
   * channel whose `is_primary` it changed, by the system actor `ingestion`, in the same
   * transaction. `main.ts` gives it the database, the log and the result-cache invalidator.
   *
   * Absent, the primary still moves and nothing is recorded, which is for tests about other
   * things.
   */
  audit?: AuditSink;
}

/** Who moves a primary that a reading created (`P-314`): nobody did, the declaration did. */
const INGESTION: Actor = { kind: 'system', component: 'ingestion' };

/** A sensor's row, as far as what its type declares for a new channel goes. */
interface SensorDeclaring {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const NO_SHAPE: ChannelShape = { lookup: null, counterBits: null };

/** A `channel` row as the resolver reads it. */
interface ChannelRow {
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
}

/** What `#makePrimary` reads back of a channel it moved, for the audit entry. */
interface DeclarationRow {
  sensor_id: string;
  key: string;
  name: string;
  unit: string;
  lookup_id: string | null;
  counter_bits: number | null;
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
  readonly #declaredLimits: ChannelResolverOptions['declaredLimits'];
  readonly #declaredShape: ChannelResolverOptions['declaredShape'];
  readonly #audit: AuditSink | undefined;
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
    this.#audit = options.audit;
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
  ): {
    shapes: ChannelShape[];
    undeclared: ReadonlySet<string>;
    /** The key each sensor's own answer makes primary, by sensor id (`P-314`). */
    primaries: ReadonlyMap<string, string>;
  } {
    const declared = this.#declaredShape;
    const undeclared = new Set<string>();
    const primaries = new Map<string, string>();
    if (declared === undefined) {
      return { shapes: wanted.map(() => NO_SHAPE), undeclared, primaries };
    }
    // Once a sensor, however many of its channels are new: a table sensor's first scan is all of
    // them at once.
    const bySensor = new Map<string, DeclaredShapes>();
    const shapes = wanted.map((one) => {
      const id = String(one.sensorId);
      const sensor = sensors.get(id);
      if (sensor === undefined) return NO_SHAPE;
      let answer = bySensor.get(id);
      if (answer === undefined) {
        answer = declared(sensor.type, sensor.params, one.sensorId);
        bySensor.set(id, answer);
        // Counted by the caller from the rows its INSERT returns, not here: a key another batch
        // created meanwhile conflicts, and was not made from this answer.
        if (answer.undeclared) undeclared.add(id);
        if (answer.primary !== null) primaries.set(id, answer.primary);
      }
      return answer.shapes.get(one.key) ?? NO_SHAPE;
    });
    return { shapes, undeclared, primaries };
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
      return { ids, created: 0, createdUndeclared: 0, droppedReadings: 0, droppedSensors: 0 };
    }

    const generation = this.#generation;
    const wanted = [...missing.values()];
    // What exists already, first: after a restart every channel is missing from the cache and
    // nearly all of them are in the table, so a cold batch is this one query and nothing below.
    const found = await this.#existing(q, wanted);
    const have = new Set(found.map((row) => `${row.sensor_id}:${row.key}`));
    const absent = wanted.filter((one) => !have.has(`${String(one.sensorId)}:${one.key}`));
    let created = 0;
    let createdUndeclared = 0;
    if (absent.length > 0) {
      ({ created, createdUndeclared } = await this.#create(q, absent));
      found.push(...(await this.#existing(q, absent)));
    }

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
      created,
      createdUndeclared,
      droppedReadings,
      droppedSensors: droppedSensors.size,
    };
  }

  /** The rows that exist for these `(sensor, key)` pairs, with everything judging needs. */
  async #existing(
    q: Queryable,
    wanted: readonly { sensorId: number; key: string }[],
  ): Promise<ChannelRow[]> {
    return q.query<ChannelRow>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.decimals, c.limits,
              c.lookup_id, c.counter_bits, c.scale_mul, c.scale_div, c.spike_min, c.spike_max
       FROM channel c
       JOIN unnest($1::bigint[], $2::text[]) AS w(sensor_id, key)
         ON w.sensor_id = c.sensor_id AND w.key = c.key`,
      [wanted.map((row) => row.sensorId), wanted.map((row) => row.key)],
    );
  }

  /**
   * Creates the channels no row exists for, with what their sensors' types declare; returns how
   * many it wrote, and how many of those its sensor's type could not declare for the sensor's
   * stored parameters (`P-306`), counted from the rows the INSERT returned: a key another batch
   * created first conflicts, and was not made from the fallback here.
   *
   * **The sensors are locked before their parameters are read** (`P-303` review). The shape comes
   * from `sensor_config.params`, and an edit to those parameters re-declares the channels it can
   * see, which a channel this path is creating is not, yet. Read unlocked, under READ COMMITTED,
   * the parameters could be the ones the edit was replacing: the edit commits having seen no row,
   * this INSERT commits the old lookup and counter width, and from then on the stored declaration
   * matches the new parameters, so no later edit would look at the row again — `P-80`'s failure,
   * for good. So each sensor's `object` row is taken `FOR NO KEY UPDATE` first, which an edit holds
   * from its first statement (the versioned `UPDATE object`) to its commit. Whichever is first,
   * the other waits: an edit after this sees the row and re-declares it; this after an edit reads,
   * in a statement of its own and so a snapshot of its own, the parameters the edit committed.
   *
   * **The lock order is object, then `sensor_config`, then `channel`**, the edit's own: it writes
   * `object`, then `sensor_config`, then `channel`, whose `channel_touch_owner` trigger touches
   * `object` again, a row it already holds. The rows are taken in id order, so two batches over
   * the same sensors cannot take them crosswise. And the mode is the one the INSERT below took
   * anyway, through that trigger: this takes it a statement earlier rather than taking something
   * new, and a share lock, which two batches could both hold and then both try to raise, is what
   * it must not be. Paid only here, for a key no row exists for: a sensor's first reading, a key a
   * build or an edit added.
   */
  async #create(
    q: Queryable,
    absent: readonly { sensorId: number; key: string; name: string; unit: string }[],
  ): Promise<{ created: number; createdUndeclared: number }> {
    const declares = this.#declaredLimits !== undefined || this.#declaredShape !== undefined;
    if (declares) {
      await q.query(
        `SELECT id FROM object WHERE id = ANY($1::bigint[]) ORDER BY id FOR NO KEY UPDATE`,
        [[...new Set(absent.map((one) => one.sensorId))]],
      );
    }
    // One query for both: the sensor's type carries the declaration, and its parameters choose
    // the lookups and counters in it (`P-297`).
    const sensors = declares
      ? await this.#sensorsFor(q, absent)
      : new Map<string, SensorDeclaring>();
    const limits = this.#declaredFor(sensors, absent);
    const { shapes, undeclared, primaries } = this.#shapesFor(sensors, absent);

    // Guarded by EXISTS rather than by the foreign key. A probe replaying a spool for a sensor
    // that has since been deleted is ordinary, not exceptional, and letting the foreign key
    // raise would fail the whole batch — including every other sensor's readings in it.
    const created = await q.query<{ id: number; sensor_id: string; key: string }>(
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
       RETURNING id, sensor_id::text AS sensor_id, key`,
      [
        absent.map((row) => row.sensorId),
        absent.map((row) => row.key),
        absent.map((row) => row.name),
        absent.map((row) => row.unit),
        limits,
        shapes.map((shape) => shape.lookup),
        shapes.map((shape) => shape.counterBits),
      ],
    );
    // Only a row this INSERT returned: a key another batch created first conflicted, and that
    // batch, holding the sensor before this one could, moved the primary itself.
    const promoted = created.filter((row) => primaries.get(row.sensor_id) === row.key);
    if (promoted.length > 0) await this.#makePrimary(q, promoted);
    return {
      created: created.length,
      createdUndeclared: created.filter((row) => undeclared.has(row.sensor_id)).length,
    };
  }

  /**
   * Moves each sensor's primary to the channel just created for the key its type declares
   * primary (`P-314`).
   *
   * **Why here.** `is_primary` is written by a create, a clone and an edit (`P-309`), each from
   * the type's declaration. An edit that declares a primary with no row yet — a column it adds
   * and puts first, `exe.script.advanced`'s `primaryChannel` renamed — keeps the current one,
   * since it creates no channels; this path creates that row, so it is where the declaration can
   * first be honoured. Before this the row was created plain and became primary only on the next
   * edit that changed the declaration, which might never come: the sensor's list number, its
   * mini-graph line and a notification's last value went on following the column the operator
   * had moved away from.
   *
   * **A sensor with no primary gets one too.** One primary is what a create of the same
   * parameters gives it and what `P-309`'s edit gives a sensor with none whose declared primary
   * has a row; leaving it none would keep it without a list number until an edit.
   *
   * **Not from a fallback.** When the type could not answer for the stored parameters the shape
   * came from `{}`, whose primary is a placeholder's (`DeclaredShapes.primary` is null then), so
   * the sensor keeps what it has.
   *
   * **Demoted first, in a statement of its own**, as `ObjectRepository.redeclareChannels` does:
   * `channel_one_primary_per_sensor` is a partial unique index and not deferrable, so it is
   * checked row by row as one UPDATE goes. The callers hold each sensor's `object` row already
   * (`#create`), so the lock order stays object, then `channel`; every other writer of an
   * existing channel row takes the object first too (an edit by its versioned UPDATE,
   * `patchChannel` by `lockForUpdate`), so the row demoted here is never held by somebody waiting
   * for the sensor.
   *
   * **Recorded as the edit's move is**: a `channel.redeclared` entry for each channel whose
   * `is_primary` changed, by the system actor `ingestion`, since no person chose it. Being a
   * `channel.*` action it also makes ingestion forget what it cached of the sensor (`M-04`),
   * though nothing it caches holds `is_primary`.
   */
  async #makePrimary(
    q: Queryable,
    promoted: readonly { sensor_id: string; key: string }[],
  ): Promise<void> {
    const sensors = promoted.map((row) => row.sensor_id);
    const demoted = await q.query<DeclarationRow>(
      `UPDATE channel SET is_primary = false
       WHERE sensor_id = ANY($1::bigint[]) AND is_primary
       RETURNING sensor_id::text AS sensor_id, key, name, unit, lookup_id, counter_bits`,
      [sensors],
    );
    const raised = await q.query<DeclarationRow>(
      `UPDATE channel AS c SET is_primary = true
       FROM unnest($1::bigint[], $2::text[]) AS p(sensor_id, key)
       WHERE c.sensor_id = p.sensor_id AND c.key = p.key
       RETURNING c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.lookup_id,
                 c.counter_bits`,
      [sensors, promoted.map((row) => row.key)],
    );
    // Said by the audit sink's log, as an edit's move is; nothing of its own here.
    if (this.#audit === undefined) return;
    const entry = (row: DeclarationRow, wasPrimary: boolean): Mutation => {
      const before: ChannelDeclaration = {
        name: row.name,
        unit: row.unit,
        lookupId: row.lookup_id,
        counterBits: row.counter_bits,
        isPrimary: wasPrimary,
      };
      return {
        action: 'channel.redeclared',
        objectId: Number(row.sensor_id),
        kind: 'sensor',
        channelKey: row.key,
        before,
        after: { ...before, isPrimary: !wasPrimary },
      };
    };
    await this.#audit.record(
      q,
      INGESTION,
      [...demoted.map((row) => entry(row, true)), ...raised.map((row) => entry(row, false))],
      new Date(),
    );
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
