import type { CheckResult, Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { LookupCatalogue } from '../lookups/catalogue.js';
import type { LookupDefinition } from '../lookups/definition.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ChannelDeclaration } from '../objects/redeclare.js';
import {
  channelLabel,
  declaredLabel,
  type ChannelShape,
  type DeclaredShapes,
} from '../state/declared-limits.js';
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
   * stored parameters, so they were created from its answer to `{}` or from nothing (`P-306`), and
   * those of a type this build does not register (`P-312`). Each may lack a lookup or counter
   * width, and is marked `undeclared` for the start-up repair (`repairUndeclaredChannels`) to
   * write once a build's type can answer — the lookup, and the width of a channel created a
   * counter; one created a gauge stays one.
   */
  createdUndeclared: number;
  /**
   * Of `created`, those whose key the sensor's type does not declare for the sensor's stored
   * parameters though it promises to declare every key it reports (`declaresEveryChannel`,
   * `P-321`), in a reading taken under those parameters (`DECLARATION_SETTLE_MS` after their last
   * change): a probe running a different build of the type (newer, or older and still reporting a
   * key this build renamed), or the type breaking its promise. Kept, since the reading is real;
   * each is logged once, naming the sensor, the type and the key.
   *
   * **And those created on an earlier call from a reading inside that minute, at their first
   * reading after it** (`P-339`): created uncounted, since such a reading is no evidence, and
   * counted once a reading is. Not one an edit has since re-declared (`forget` drops it), nor one
   * the core restarted on before its reading came, which a restart inside that minute costs.
   */
  createdOutsideDeclaration: number;
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
   * transaction. And a primary named by its key that a reading renames (`P-403`), the same way.
   * `main.ts` gives it the database, the log and the result-cache invalidator.
   *
   * Absent, the primary still moves, the name is still taken, and nothing is recorded, which is
   * for tests about other things.
   */
  audit?: AuditSink;
}

/**
 * Who moves a primary that a reading created (`P-314`), and who names a primary after the program
 * that reports it (`P-403`): nobody did, the declaration and the reading did.
 */
export const INGESTION: Actor = { kind: 'system', component: 'ingestion' };

/**
 * A cached channel, with what only the resolver needs of its row: whether it is its sensor's
 * primary, read in the same query as the rest (`P-403`).
 */
interface CachedChannel extends ResolvedChannel {
  readonly isPrimary: boolean;
}

/** A primary named by its key that a reading of this batch names otherwise (`P-403`). */
interface NameWanted {
  readonly sensorId: number;
  readonly key: string;
  /** The name the newest reading of the batch that sent one sent, as a create would take it. */
  readonly name: string;
  readonly unit: string | undefined;
}

/**
 * What a reading's name makes of an existing channel, or null to leave it (`P-403`).
 *
 * **Only a primary still named by its key, whose own declaration says nothing of its name.**
 * `exe.script.advanced` declares its primary's name as its key unless the operator set
 * `primaryName`, whose description promises "Empty uses whatever the program calls it". A create
 * writes that declaration before any program has run, so without this the row stayed named by its
 * key for good, and only a primary a reading created took the program's name (`P-402`). So the
 * first reading that names it renames it, once: afterwards it is not named by its key.
 *
 * **A person's name is never replaced.** A person names a channel through a parameter, which is
 * the declaration itself: a `primaryName` makes the declared name something of its own, and that
 * is what the row holds. No route writes a channel's name directly (`patchChannel` takes limits,
 * a lookup and processing). A name the declaration gives the row, the type's or a person's, is
 * `P-404`'s pass's to write, not a reading's. Nor from a fallback: a type that cannot answer for
 * the stored parameters says nothing either way, so nothing is renamed on its word.
 *
 * **The unit with it, where neither the row nor the declaration has one**: what a reading that
 * created the row would have written (`channelLabel`), so a primary a create made and one a
 * reading made end the same. A unit the operator chose (`primaryUnit`) is the declaration's and
 * the row's, and stays.
 */
export function nameFromReading(
  row: { readonly key: string; readonly name: string; readonly unit: string },
  isPrimary: boolean,
  answer: DeclaredShapes,
  sent: { readonly name: string; readonly unit: string | undefined },
): { name: string; unit: string } | null {
  if (!isPrimary || row.name !== row.key || sent.name === row.key) return null;
  // A fallback's answer is a placeholder's, and an unregistered type has none (`ChannelShape`).
  if (answer.undeclared || answer.primary !== row.key) return null;
  const shape = answer.shapes.get(row.key);
  if (shape === undefined || shape.name === null) return null;
  const declared = declaredLabel(row.key, shape.name, shape.unit ?? '');
  if (declared.name !== row.key) return null;
  return {
    name: sent.name,
    unit: row.unit === '' && declared.unit === '' ? (sent.unit ?? '') : row.unit,
  };
}

/** A sensor's row, as far as what its type declares for a new channel goes. */
interface SensorDeclaring {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * When its parameters last changed (`sensor_config.params_changed_at`, `P-340`), in epoch
   * milliseconds: a reading taken before it, or not long enough after it, may have run under
   * parameters that named a key these do not (`P-321` review). Not `updated_at`, which a voucher
   * write moves too and would restart the minute for nothing a reading could have run under.
   */
  readonly changedAt: number;
}

/** A key a reading names and no cached channel answers, with the newest reading of it. */
interface WantedChannel {
  readonly sensorId: number;
  readonly key: string;
  /** What a reading of it sent, if any did; `channelLabel` decides what is stored (`P-402`). */
  readonly name: string | undefined;
  readonly unit: string | undefined;
  /** Epoch milliseconds of the newest reading naming it in the batch; `NaN` when unreadable. */
  readonly at: number;
}

/**
 * How long after a sensor's parameters changed (`P-340`) a reading may still have run under the
 * parameters before it (`P-321` review): the change reaching its probe, a scan already in flight,
 * and a probe clock ahead of the database's by up to the minute Core Health first warns of. A key
 * outside the declaration in such a reading is not counted as a broken promise.
 */
export const DECLARATION_SETTLE_MS = 60_000;

const NO_SHAPE: ChannelShape = { lookup: null, counterBits: null, name: null, unit: null };

/** What a channel outside its type's promised declaration is likely to mean (`P-321`). */
const OUTSIDE_DECLARATION =
  'a reading taken under the sensor’s current parameters named a channel its sensor ' +
  'type does not declare for them, though the type promises to declare every channel ' +
  'it reports: a probe running a different build of the type than this core (a newer ' +
  'one that added the key, or an older one still reporting a key this build renamed or ' +
  'dropped), or the type breaking its promise.';

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
  is_primary: boolean;
}

/** What `moveDeclaredPrimaries` reads back of a channel it moved, for the audit entry. */
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
  readonly #cache = new Map<string, CachedChannel>();
  /**
   * `sensorId:key` of each primary named by its key that a reading named otherwise and that was
   * left as it is (`P-403`): its declaration has a name of its own, its type could not answer,
   * or a reading had already renamed it. So a reading that names it again costs no query. Removed
   * by `forget`, which the invalidator calls for an edit of the sensor's parameters as well as for
   * a channel's entry, since either can change all of those, and by `clear`; bounded by the
   * sensors, one primary each.
   */
  readonly #nameSettled = new Set<string>();
  /**
   * `sensorId:key` of each channel created outside its promising type's declaration from a
   * reading inside `DECLARATION_SETTLE_MS` of its sensor's last change, with when that minute ends
   * and the type, until a later reading counts it (`P-339`). One entry a channel at most, removed
   * when counted or when its sensor is edited, so it is bounded by the channels there are; in
   * practice it holds the keys of the minute after an edit and nothing else.
   */
  readonly #outsideLater = new Map<string, { after: number; sensorType: string }>();
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
    this.#nameSettled.clear();
  }

  /**
   * Forgets one sensor's channels, so the next result re-reads them.
   *
   * What makes an edited limit take effect on the next scan rather than on the next restart
   * (`M-04`). Called from the audit sink, which every mutation already goes through — the same
   * reason `R-04`'s config push rides there rather than being remembered at each write site.
   */
  forget(sensorId: number): number {
    return this.forgetMany(new Set([sensorId]));
  }

  /**
   * Forgets these sensors' channels in one pass over what is held, however many there are.
   *
   * A scan of the whole map, because the key is `sensorId:channelKey` and a second index would
   * be a second thing to keep in step. The map holds the v1 target's 15,000 channels, so one scan
   * is microseconds; **one scan a sensor is not** (`P-403` review). A move or a clone that clears
   * thousands of sensors' own secrets records an `object.updated` for each in one audit call, and
   * the invalidator forgets them all, inside the mover's transaction and again after it commits:
   * a scan each would block the event loop for seconds, twice. So the invalidator gathers the
   * sensors of a call and forgets them here, once.
   */
  forgetMany(sensorIds: ReadonlySet<number>): number {
    // Any sensor's, for every read in flight: which sensors a read covers is not worth tracking
    // for an event this rare, and a read that is not cached costs one query next time.
    this.#generation += 1;
    if (sensorIds.size === 0) return 0;
    const named = (key: string): boolean => sensorIds.has(Number(key.slice(0, key.indexOf(':'))));
    let dropped = 0;
    for (const key of this.#cache.keys()) {
      if (named(key)) {
        this.#cache.delete(key);
        dropped += 1;
      }
    }
    // An edit may declare a key it had been waiting to count (`P-339`); the next creation decides.
    for (const key of this.#outsideLater.keys()) {
      if (named(key)) this.#outsideLater.delete(key);
    }
    // An edit may clear a `primaryName`, and then a reading names the primary (`P-403`).
    for (const key of this.#nameSettled) {
      if (named(key)) this.#nameSettled.delete(key);
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
    wanted: readonly WantedChannel[],
  ): {
    shapes: ChannelShape[];
    undeclared: ReadonlySet<string>;
    /** The key each sensor's own answer makes primary, by sensor id (`P-314`). */
    primaries: ReadonlyMap<string, string>;
    /**
     * `sensorId:key` for each wanted key its sensor's type does not declare though it promises
     * to declare every key it reports (`P-321`).
     */
    outside: ReadonlySet<string>;
    /**
     * The same, for a key whose reading is too close to the last change to count, with when a
     * reading starts to (`P-339`).
     */
    later: ReadonlyMap<string, number>;
  } {
    const declared = this.#declaredShape;
    const undeclared = new Set<string>();
    const primaries = new Map<string, string>();
    const outside = new Set<string>();
    const later = new Map<string, number>();
    if (declared === undefined) {
      return { shapes: wanted.map(() => NO_SHAPE), undeclared, primaries, outside, later };
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
      const shape = answer.shapes.get(one.key);
      // Checked here because this is the one place the declaration is in hand: a key seen for
      // the first time (`P-321`). Counted by the caller from the rows its INSERT returns, as
      // `undeclared` is. **Only from a reading taken under these parameters** (`P-321` review):
      // one from before the last change, or too soon after it, may have run under parameters
      // that named the key — a spool replayed after an edit took out a column an earlier edit
      // added — and is no evidence against the promise. `NaN` compares false, so an unreadable
      // time is not counted either.
      if (shape === undefined && answer.everyKey) {
        const after = sensor.changedAt + DECLARATION_SETTLE_MS;
        if (one.at > after) outside.add(`${id}:${one.key}`);
        // Not yet evidence, but a reading after `after` will be (`P-339`). An unreadable time is
        // set aside too: the next reading's time decides.
        else if (Number.isFinite(after)) later.set(`${id}:${one.key}`, after);
      }
      return shape ?? NO_SHAPE;
    });
    return { shapes, undeclared, primaries, outside, later };
  }

  async #sensorsFor(
    q: Queryable,
    wanted: readonly { sensorId: number; key: string }[],
  ): Promise<Map<string, SensorDeclaring>> {
    const rows = await q.query<{
      object_id: string;
      type: string;
      params: unknown;
      params_changed_at: Date;
    }>(
      `SELECT object_id::text, type, params, params_changed_at
       FROM sensor_config WHERE object_id = ANY($1::bigint[])`,
      [[...new Set(wanted.map((one) => one.sensorId))]],
    );
    return new Map(
      rows.map((row) => [
        row.object_id,
        {
          type: row.type,
          changedAt: row.params_changed_at.getTime(),
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
    const missing = new Map<string, WantedChannel>();
    const named = new Map<string, NameWanted>();
    let outsideLater = 0;

    for (const result of results) {
      // Only while a channel is waiting to be counted, which is rarely (`P-339`).
      if (this.#outsideLater.size > 0) outsideLater += this.#countLater(result);
      for (const reading of result.channels) {
        const cacheKey = `${String(result.sensorId)}:${reading.key}`;
        const cached = this.#cache.get(cacheKey);
        if (cached !== undefined) {
          ids.set(cacheKey, cached);
          // **What a cached reading pays for `P-403`: nothing but these comparisons.** A reading
          // that sends no name, which is nearly all of them, stops at the first. One that names
          // a primary still named by its key is the only kind that goes further, and it once.
          if (reading.name !== undefined && cached.isPrimary && cached.name === reading.key) {
            this.#wantName(named, cacheKey, result.sensorId, reading.key, {
              name: reading.name,
              unit: reading.unit,
            });
          }
          continue;
        }
        const at = Date.parse(result.at);
        const earlier = missing.get(cacheKey);
        const before = earlier?.at;
        missing.set(cacheKey, {
          sensorId: result.sensorId,
          key: reading.key,
          // A probe may send display metadata only on a channel's first appearance, so a later
          // reading of it in the batch that sends none does not lose what an earlier one sent.
          name: reading.name ?? earlier?.name,
          unit: reading.unit ?? earlier?.unit,
          // The newest of the batch's readings of it, whatever order they came in (`P-321`).
          at: before === undefined || Number.isNaN(before) ? at : Math.max(before, at),
        });
      }
    }

    if (missing.size === 0) {
      if (named.size > 0) await this.#nameFromReadings(q, named, ids);
      return {
        ids,
        created: 0,
        createdUndeclared: 0,
        createdOutsideDeclaration: outsideLater,
        droppedReadings: 0,
        droppedSensors: 0,
      };
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
    let createdOutsideDeclaration = 0;
    if (absent.length > 0) {
      ({ created, createdUndeclared, createdOutsideDeclaration } = await this.#create(q, absent));
      found.push(...(await this.#existing(q, absent)));
    }

    for (const row of found) {
      const cacheKey = `${row.sensor_id}:${row.key}`;
      const channel: CachedChannel = {
        id: row.id,
        name: row.name,
        unit: row.unit,
        decimals: row.decimals,
        limits: parseLimits(row.limits),
        transform: parseTransform(row),
        lookupId: row.lookup_id,
        lookup: this.#lookupFor(row.lookup_id),
        counterBits: row.counter_bits === 32 || row.counter_bits === 64 ? row.counter_bits : null,
        isPrimary: row.is_primary,
      };
      ids.set(cacheKey, channel);
      if (this.#generation === generation) this.#remember(cacheKey, channel);
      // The same test as a cached reading's, on the row just read: after a restart, the first
      // batch is the one that renames (`P-403`).
      const sent = missing.get(cacheKey);
      if (sent?.name !== undefined && channel.isPrimary && channel.name === row.key) {
        this.#wantName(named, cacheKey, sent.sensorId, row.key, {
          name: sent.name,
          unit: sent.unit,
        });
      }
    }
    if (named.size > 0) await this.#nameFromReadings(q, named, ids);

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
      createdOutsideDeclaration: createdOutsideDeclaration + outsideLater,
      droppedReadings,
      droppedSensors: droppedSensors.size,
    };
  }

  /**
   * Counts and logs each channel of this result that was created outside its type's declaration
   * inside the minute after an edit and is now read after it, once a channel (`P-339`).
   */
  #countLater(result: CheckResult): number {
    const at = Date.parse(result.at);
    if (Number.isNaN(at)) return 0;
    let counted = 0;
    for (const reading of result.channels) {
      const cacheKey = `${String(result.sensorId)}:${reading.key}`;
      const waiting = this.#outsideLater.get(cacheKey);
      if (waiting === undefined || !(at > waiting.after)) continue;
      this.#outsideLater.delete(cacheKey);
      counted += 1;
      this.#logger.warn(
        {
          sensorId: result.sensorId,
          sensorType: waiting.sensorType,
          channelKey: reading.key,
          phase: 'read-channel',
        },
        `${OUTSIDE_DECLARATION} The channel was created from a reading in the minute after the ` +
          'sensor’s last change, which could not tell, and this is the first reading after it',
      );
    }
    return counted;
  }

  /** The rows that exist for these `(sensor, key)` pairs, with everything judging needs. */
  async #existing(
    q: Queryable,
    wanted: readonly { sensorId: number; key: string }[],
  ): Promise<ChannelRow[]> {
    return q.query<ChannelRow>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.decimals, c.limits,
              c.lookup_id, c.counter_bits, c.scale_mul, c.scale_div, c.spike_min, c.spike_max,
              c.is_primary
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
   * created first conflicts, and was not made from the fallback here. And how many of those its
   * sensor's type does not declare though it promises to (`P-321`), each logged once: counted, not
   * refused, because the reading is real — most likely from a probe running a different build of
   * the type, which ADR-001 Decision 13 allows — and refusing it would drop a channel that is read.
   * Not from a reading the parameters before the last change may have taken (`P-321` review).
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
    absent: readonly WantedChannel[],
  ): Promise<{ created: number; createdUndeclared: number; createdOutsideDeclaration: number }> {
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
    const { shapes, undeclared, primaries, outside, later } = this.#shapesFor(sensors, absent);
    // **Named as a create names it** (`P-402`): a key the type declares gets its declared name
    // and unit, where the declaration says something of its own; otherwise what the reading
    // sent, and otherwise the key and no unit, which keeps `channel.name` valid rather than
    // rejecting the batch.
    const labels = absent.map((row, i) => channelLabel(row.key, shapes[i] ?? NO_SHAPE, row));

    // Guarded by EXISTS rather than by the foreign key. A probe replaying a spool for a sensor
    // that has since been deleted is ordinary, not exceptional, and letting the foreign key
    // raise would fail the whole batch — including every other sensor's readings in it.
    // **Marked when made from a fallback** (`P-312`), so a build whose type can answer finds it.
    const created = await q.query<{ id: number; sensor_id: string; key: string }>(
      `INSERT INTO channel (sensor_id, key, name, unit, lookup_id, counter_bits,
                            limits, limits_source, undeclared)
       SELECT s.sensor_id, s.key, s.name, s.unit, s.lookup_id, s.counter_bits,
              COALESCE(s.limits, '{}'::jsonb),
              CASE WHEN s.limits IS NULL THEN 'unset' ELSE 'declared' END,
              s.undeclared
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::jsonb[],
                   $6::text[], $7::smallint[], $8::boolean[])
            AS s(sensor_id, key, name, unit, limits, lookup_id, counter_bits, undeclared)
       WHERE EXISTS (SELECT 1 FROM object o WHERE o.id = s.sensor_id AND o.kind = 'sensor')
       ON CONFLICT (sensor_id, key) DO NOTHING
       RETURNING id, sensor_id::text AS sensor_id, key`,
      [
        absent.map((row) => row.sensorId),
        absent.map((row) => row.key),
        labels.map((label) => label.name),
        labels.map((label) => label.unit),
        limits,
        shapes.map((shape) => shape.lookup),
        shapes.map((shape) => shape.counterBits),
        absent.map((row) => undeclared.has(String(row.sensorId))),
      ],
    );
    // Only a row this INSERT returned: a key another batch created first conflicted, and that
    // batch, holding the sensor before this one could, moved the primary itself.
    const promoted = created.filter((row) => primaries.get(row.sensor_id) === row.key);
    if (promoted.length > 0) await this.#makePrimary(q, promoted);
    const beyond = created.filter((row) => outside.has(`${row.sensor_id}:${row.key}`));
    for (const row of beyond) {
      this.#logger.warn(
        {
          sensorId: Number(row.sensor_id),
          sensorType: sensors.get(row.sensor_id)?.type,
          channelKey: row.key,
          phase: 'create-channel',
        },
        `${OUTSIDE_DECLARATION} The channel was created and its readings are kept`,
      );
    }
    // Only rows this INSERT returned, as above: a key another batch created was that batch's.
    for (const row of created) {
      const cacheKey = `${row.sensor_id}:${row.key}`;
      const after = later.get(cacheKey);
      const sensorType = sensors.get(row.sensor_id)?.type;
      if (after !== undefined && sensorType !== undefined) {
        this.#outsideLater.set(cacheKey, { after, sensorType });
      }
    }
    return {
      created: created.length,
      createdUndeclared: created.filter((row) => undeclared.has(row.sensor_id)).length,
      createdOutsideDeclaration: beyond.length,
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
   * **The move itself is `moveDeclaredPrimaries`**, shared with the start-up repair (`P-323`):
   * demoted first, recorded by the system actor `ingestion`. The callers hold each sensor's
   * `object` row already (`#create`), so the lock order stays object, then `channel`; every
   * other writer of an existing channel row takes the object first too (an edit by its versioned
   * UPDATE, `patchChannel` by `lockForUpdate`), so the row demoted here is never held by somebody
   * waiting for the sensor.
   */
  async #makePrimary(
    q: Queryable,
    promoted: readonly { sensor_id: string; key: string }[],
  ): Promise<void> {
    await moveDeclaredPrimaries(q, promoted, { audit: this.#audit, actor: INGESTION });
  }

  /**
   * Notes that a reading of this batch names a primary still named by its key, unless the name
   * is that key or the channel was settled already (`P-403`). The newest such reading's name, as
   * a create keeps the newest words of its batch.
   */
  #wantName(
    named: Map<string, NameWanted>,
    cacheKey: string,
    sensorId: number,
    key: string,
    sent: { readonly name: string; readonly unit: string | undefined },
  ): void {
    if (sent.name === key || this.#nameSettled.has(cacheKey)) return;
    const earlier = named.get(cacheKey);
    named.set(cacheKey, { sensorId, key, name: sent.name, unit: sent.unit ?? earlier?.unit });
  }

  /**
   * Names each primary still named by its key after the reading that names it, where its own
   * declaration says nothing of its name (`P-403`, `nameFromReading`).
   *
   * **The cost.** Only here, and only for a primary a reading of this batch names while it is
   * still named by its key: once a sensor, since afterwards it is not, and once a sensor whose
   * declaration has a name of its own or that cannot answer, which `#nameSettled` then holds
   * until an edit or a restart. Every other batch issues nothing for it (`resolve`). When it does
   * run it is one lock, one `sensor_config` read, one `channel` read and, for a rename, one
   * UPDATE and the audit entry, in the transaction the batch already has.
   *
   * **Locked as `P-323`'s repair locks**: the `object` rows first, `FOR NO KEY UPDATE SKIP
   * LOCKED`, then `sensor_config`, then `channel`, the edit's order. `SKIP LOCKED` because this
   * batch may hold other sensors already (`#create` waits for its own), and a second wait in an
   * order of its own could cross another batch's; a held sensor is not settled, and the next
   * reading that names it tries again. Everything is decided again under the lock, from rows
   * nobody else can change, so two batches never both rename it, and a primary an edit named or
   * moved meanwhile is left.
   *
   * **Audited as `channel.redeclared` by `ingestion`**, the system actor that moves a primary a
   * reading created (`P-314`), through the same sinks: the record, the log and the result-cache
   * invalidator, which forgets the sensor so the next batch reads the new name. This batch's
   * readings carry it already.
   */
  async #nameFromReadings(
    q: Queryable,
    named: ReadonlyMap<string, NameWanted>,
    ids: Map<string, ResolvedChannel>,
  ): Promise<void> {
    const declared = this.#declaredShape;
    if (declared === undefined) {
      // Nothing can say whether the declaration names it, so nothing is renamed, nor asked again.
      for (const cacheKey of named.keys()) this.#nameSettled.add(cacheKey);
      return;
    }
    const sensorIds = [...new Set([...named.values()].map((one) => one.sensorId))];
    const held = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM object WHERE id = ANY($1::bigint[])
       ORDER BY object.id FOR NO KEY UPDATE SKIP LOCKED`,
      [sensorIds],
    );
    const holding = new Set(held.map((row) => row.id));
    const wanted = [...named.entries()].filter(([, one]) => holding.has(String(one.sensorId)));
    if (wanted.length === 0) return;
    const sensors = await this.#sensorsFor(
      q,
      wanted.map(([, one]) => one),
    );
    const rows = await q.query<DeclarationRow & { id: number; is_primary: boolean }>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, c.key, c.name, c.unit, c.lookup_id,
              c.counter_bits, c.is_primary
       FROM channel c
       JOIN unnest($1::bigint[], $2::text[]) AS w(sensor_id, key)
         ON w.sensor_id = c.sensor_id AND w.key = c.key`,
      [wanted.map(([, one]) => one.sensorId), wanted.map(([, one]) => one.key)],
    );
    const byKey = new Map(rows.map((row) => [`${row.sensor_id}:${row.key}`, row]));

    const renames: { row: (typeof rows)[number]; name: string; unit: string }[] = [];
    for (const [cacheKey, one] of wanted) {
      const row = byKey.get(cacheKey);
      const sensor = sensors.get(String(one.sensorId));
      // Gone meanwhile: the next batch drops its readings and counts them.
      if (row === undefined || sensor === undefined) continue;
      const answer = declared(sensor.type, sensor.params, one.sensorId);
      const label = nameFromReading(row, row.is_primary, answer, one);
      const entry = ids.get(cacheKey);
      if (label === null) {
        this.#nameSettled.add(cacheKey);
        // What the row says now, if another batch named it meanwhile.
        if (entry !== undefined) ids.set(cacheKey, { ...entry, name: row.name, unit: row.unit });
        continue;
      }
      renames.push({ row, ...label });
      if (entry !== undefined) ids.set(cacheKey, { ...entry, ...label });
    }
    if (renames.length === 0) return;

    // A change a reader sees: the sensor's version moves by trigger, as for any channel write.
    await q.query(
      `UPDATE channel AS c SET name = w.name, unit = w.unit
       FROM unnest($1::integer[], $2::text[], $3::text[]) AS w(id, name, unit)
       WHERE c.id = w.id`,
      [
        renames.map((one) => one.row.id),
        renames.map((one) => one.name),
        renames.map((one) => one.unit),
      ],
    );
    // Forgotten here as well as by the audit's invalidator, which a resolver built without a sink
    // lacks: the cache must not keep the key as the name, and the next batch reads the row once.
    this.forgetMany(new Set(renames.map((one) => Number(one.row.sensor_id))));
    if (this.#audit === undefined) return;
    const mutations: Mutation[] = renames.map(({ row, name, unit }) => {
      const before: ChannelDeclaration = {
        name: row.name,
        unit: row.unit,
        lookupId: row.lookup_id,
        counterBits: row.counter_bits,
        isPrimary: row.is_primary,
      };
      return {
        action: 'channel.redeclared',
        objectId: Number(row.sensor_id),
        kind: 'sensor',
        channelKey: row.key,
        before,
        after: { ...before, name, unit },
      };
    });
    await this.#audit.record(q, INGESTION, mutations, new Date());
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

  #remember(cacheKey: string, channel: CachedChannel): void {
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

/**
 * Makes each named channel its sensor's primary, demoting whatever held it first, and records
 * every channel whose `is_primary` changed (`P-314`, `P-323`).
 *
 * **One move, two callers**: the reading that creates a declared primary (`ChannelResolver`) and
 * the start-up repair of rows created before that existed (`repairDeclaredPrimaries`). Each passes
 * only rows that exist and that the sensor's own stored parameters declare primary, at most one a
 * sensor, and holds each sensor's `object` row already, so the lock order is object, then
 * `channel`.
 *
 * **Demoted first, in a statement of its own**, as `ObjectRepository.redeclareChannels` does:
 * `channel_one_primary_per_sensor` is a partial unique index and not deferrable, so it is checked
 * row by row as one UPDATE goes. Every row of these sensors still primary is demoted, so each ends
 * with exactly the one named.
 *
 * **Recorded as an edit's move is**: a `channel.redeclared` entry for each channel whose
 * `is_primary` changed, by the caller's system actor, since no person chose it. Being a
 * `channel.*` action it also makes ingestion forget what it cached of the sensor (`M-04`), though
 * nothing it caches holds `is_primary`. Absent `audit`, the rows still move and nothing is
 * recorded, which is for tests about other things.
 *
 * Returns how many channels it promoted.
 */
export async function moveDeclaredPrimaries(
  q: Queryable,
  promoted: readonly { sensor_id: string; key: string }[],
  options: { readonly audit: AuditSink | undefined; readonly actor: Actor },
): Promise<number> {
  if (promoted.length === 0) return 0;
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
  if (options.audit === undefined) return raised.length;
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
  await options.audit.record(
    q,
    options.actor,
    [...demoted.map((row) => entry(row, true)), ...raised.map((row) => entry(row, false))],
    new Date(),
  );
  return raised.length;
}
