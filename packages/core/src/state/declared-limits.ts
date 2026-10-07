import type { SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { limitsFromDeclaration, type ChannelLimits } from './limits.js';

/**
 * Putting a sensor type's declared thresholds onto channels that already exist (`S-18`).
 *
 * **Without this, a default would only ever reach installations created after the build that
 * declared it** — which is the worst of both: the same version of the same software alarms on a
 * new install and stays silent on the one that has been running for a year, and nothing on
 * screen says why. Every upgrade path in this project is "the schema moves forward"; this is the
 * same idea for a value the schema cannot express.
 *
 * **A declaration taken away is the same upgrade in the other direction** (`P-291`). A build
 * that stops declaring a channel's limits clears the ones an earlier build put there, and hands
 * the channel back to `unset`: otherwise an install that ran the older build alarms on a
 * threshold the documentation says is gone, and a fresh one does not. Only a `declared` row is
 * cleared, so an operator's limit stays whatever it holds.
 *
 * **What it will not touch is the point.** `limits_source = 'operator'` is a decision somebody
 * made, and that includes deciding to clear a threshold — which writes `{}`, indistinguishable
 * from a channel nobody has configured, and the reason `S-18` needed a column rather than a look
 * at the value. Only `unset` and `declared` are written, so a default may be *changed* by a later
 * build and may never be *restored* over a removal.
 *
 * Runs once at startup rather than in the housekeeping loop: an operator upgrading for a fix to
 * their alarming wants it when the service comes up, not within the hour. After the first pass
 * the query matches nothing, which is cheap enough to keep it there.
 */

/**
 * What a type declares for one channel, or null (`S-18`).
 *
 * The same question the start-up pass asks, in the shape the channel resolver needs — so a
 * channel created lazily by ingestion and one created with its sensor get the same answer from
 * the same place. Two lookups would eventually disagree, and the disagreement would be invisible.
 */
/**
 * The rest of a channel's declaration, for channels the ingestion path creates (`P-80`).
 *
 * `ChannelResolver` is the only way a key a sensor type newly declares reaches the `channel`
 * table on a sensor that already exists, and its INSERT wrote limits but not `lookup_id` or
 * `counter_bits`. So on any installation that predates a new channel, a lookup channel got
 * `lookup_id = NULL` and empty limits — which `evaluateChannel` falls straight through, judging
 * it by nothing at all. `delivering` (`P-74`), `checksCompleting` (`P-76`) and `poolState`
 * (`P-62`) are all lookup channels with no limits, so the headline alarm of each of those tickets
 * existed only on installations created by that build. A counter with no `counter_bits` is the
 * same shape of wrong: the rate conversion is skipped, the stored sample is a cumulative total,
 * and a limit written for a rate latches Down for the life of the probe process.
 */
export function declaredChannelLookup(
  catalogue: SensorCatalogue,
): (
  sensorType: string,
  channelKey: string,
) => { lookup: string | null; counterBits: number | null } {
  const shapes = new Map<string, { lookup: string | null; counterBits: number | null }>();
  for (const id of catalogue.ids()) {
    let defs;
    try {
      defs = catalogue.channelsFor(id, {});
    } catch {
      continue;
    }
    for (const def of defs) {
      shapes.set(`${id} ${def.key}`, {
        lookup: def.lookup ?? null,
        counterBits: def.counter?.bits ?? null,
      });
    }
  }
  return (sensorType, channelKey) =>
    shapes.get(`${sensorType} ${channelKey}`) ?? { lookup: null, counterBits: null };
}

export function declaredLimitsLookup(
  catalogue: SensorCatalogue,
): (sensorType: string, channelKey: string) => ChannelLimits | null {
  const { declared } = declarationsIn(catalogue);
  return (sensorType, channelKey) => declared.get(`${sensorType} ${channelKey}`) ?? null;
}

interface Declarations {
  /** Every (type, channel) a registered type declares limits for, keyed `type key`. */
  readonly declared: Map<string, ChannelLimits>;
  /**
   * Every (type, channel) the parameterless read names *without* limits, keyed `type key`.
   *
   * The type has answered for that key, and the answer is "none" (`P-291`): whatever its
   * parameters, a key it names with `{}` is a key it knows, and it did not declare a limit.
   */
  readonly bare: ReadonlySet<string>;
  /**
   * Every registered type whose parameters schema admits no parameter at all (`P-291`).
   *
   * The only types for which the parameterless read *is* every sensor's read, so the only ones
   * whose silence about a key it does not name means anything. Decided from the schema rather
   * than from whether `channels({})` throws, because no shipped type throws: the catalogue asks
   * every type for `{}` at registration, and a type whose channels come from its parameters
   * answers with a placeholder (`ssh-script`'s `value`) that says nothing about the keys a
   * real sensor of it has — or the limits declared on them at creation.
   */
  readonly fixed: readonly string[];
}

/** What the catalogue declares, built once and read many times. */
function declarationsIn(catalogue: SensorCatalogue): Declarations {
  const declared = new Map<string, ChannelLimits>();
  const bare = new Set<string>();
  const fixed: string[] = [];
  for (const id of catalogue.ids()) {
    let defs;
    try {
      defs = catalogue.channelsFor(id, {});
    } catch {
      // `channels()` may need parameters. Such a type's channels vary per sensor and cannot be
      // matched by key across an installation anyway.
      continue;
    }
    if (admitsNoParameters(catalogue.declaration(id).paramsSchema)) fixed.push(id);
    for (const def of defs) {
      if (def.limits === undefined) {
        bare.add(`${id} ${def.key}`);
        continue;
      }
      declared.set(`${id} ${def.key}`, limitsFromDeclaration(def.limits));
    }
  }
  return { declared, bare, fixed };
}

/**
 * Whether a parameters schema validates nothing but `{}` (`P-291`).
 *
 * `additionalProperties: false` with no `properties` and no `patternProperties` leaves no
 * property an object may carry, whatever else the schema says — so every sensor of the type is
 * handed `{}` and gets the parameterless channel set. Anything less certain is treated as
 * parameter-dependent, which errs towards leaving a limit rather than wiping one.
 */
function admitsNoParameters(schema: Readonly<Record<string, unknown>>): boolean {
  const none = (value: unknown): boolean =>
    value === undefined ||
    (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
  return (
    schema['additionalProperties'] === false &&
    none(schema['properties']) &&
    none(schema['patternProperties'])
  );
}

export interface DeclaredLimitsOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
}

export interface DeclaredLimitsReport {
  /** Channels whose limits this pass wrote. Zero on every start after the first. */
  readonly applied: number;
  /**
   * Channels whose declared limits this pass cleared because their type no longer declares any
   * for that key (`P-291`). Zero on every start after the first, since a cleared row is `unset`.
   */
  readonly cleared: number;
  /** Channels left alone because a person had decided about them. */
  readonly operatorOwned: number;
  /** Sensor types with declarations that no channel in this installation matched. */
  readonly unmatched: readonly string[];
}

interface Row {
  readonly id: number;
  readonly type: string;
  readonly key: string;
}

export async function applyDeclaredLimits(
  options: DeclaredLimitsOptions,
): Promise<DeclaredLimitsReport> {
  const logger = options.logger.child({ component: 'declared-limits' });

  // Built from the catalogue rather than from a list here, so a type that gains a declaration
  // needs no change on this side — the rule in `CLAUDE.md` that adding a sensor type is a
  // one-file job.
  const declarations = declarationsIn(options.catalogue);
  const { declared } = declarations;

  // Before the early return below: a catalogue that declares nothing at all may be one whose
  // last declaration was just removed, and that is a clearing to do, not nothing to do.
  const cleared = await clearWithdrawn(options, declarations);
  if (cleared > 0) {
    logger.info(
      { cleared },
      'cleared declared channel limits their sensor types no longer declare',
    );
  }

  if (declared.size === 0) return { applied: 0, cleared, operatorOwned: 0, unmatched: [] };

  const types = [...new Set([...declared.keys()].map((one) => one.split(' ')[0] ?? ''))];

  const candidates = await options.db.query<Row>(
    // `limits_source` carries the whole decision, so this reads no values and compares none.
    `SELECT c.id, sc.type, c.key
     FROM channel c
     JOIN sensor_config sc ON sc.object_id = c.sensor_id
     WHERE c.limits_source <> 'operator' AND sc.type = ANY($1::text[])`,
    [types],
  );

  const ids: number[] = [];
  const values: string[] = [];
  const matched = new Set<string>();
  for (const row of candidates) {
    const key = `${row.type} ${row.key}`;
    const limits = declared.get(key);
    if (limits === undefined) continue;
    matched.add(key);
    ids.push(row.id);
    values.push(JSON.stringify(limits));
  }

  let applied = 0;
  if (ids.length > 0) {
    // Written only where it would change something: a build that declares the same thresholds it
    // declared last time must not touch every health channel on every start, because writing a
    // channel bumps its sensor's version and invalidates every open ETag (`S-13`).
    const changed = await options.db.query<{ id: number }>(
      `UPDATE channel AS c
       SET limits = d.limits, limits_source = 'declared'
       FROM unnest($1::bigint[], $2::jsonb[]) AS d(id, limits)
       WHERE c.id = d.id AND c.limits IS DISTINCT FROM d.limits
       RETURNING c.id`,
      [ids, values],
    );
    applied = changed.length;
  }

  const operatorOwned = await countOperatorOwned(options, types);
  const unmatched = [...declared.keys()]
    .filter((key) => !matched.has(key))
    .map((key) => key.replace(' ', '.'))
    .sort();

  if (applied > 0) {
    logger.info(
      { applied, operatorOwned },
      'applied the sensor types’ declared channel limits to existing channels',
    );
  }
  return { applied, cleared, operatorOwned, unmatched };
}

/**
 * Takes away a declared limit whose type stopped declaring it (`P-291`).
 *
 * **Per channel, not per bound.** A type that still declares a channel's limits but dropped one
 * of its bounds needs nothing here: the pass above writes the whole declaration over the whole
 * column, so the dropped bound goes with the rewrite. What it cannot reach is a key with no
 * declaration left at all, because it only ever looks a key *up*.
 *
 * Back to `{}` and `unset` rather than to `{}` and `declared`: `{}` and `unset` is what a channel
 * created by this build holds, and `unset` is what lets a later build declare a limit for it
 * again. `declared` with nothing in it would be a claim about a declaration that does not exist.
 *
 * **Only where the type's answer covers the key.** That is either (a) a key the parameterless
 * read names and declares nothing for, or (b) any undeclared key of a type in `fixed`, whose
 * parameterless read is every sensor's read — which is how a channel the type dropped outright
 * is cleared. Anything else is left: a type whose channels come from its parameters may have
 * declared a limit at creation on a key `{}` never names (a column, a banner channel), and a
 * type this build does not register says nothing either way. Clearing on their behalf would be
 * guessing, and the guess would silently end an alarm.
 */
async function clearWithdrawn(
  options: DeclaredLimitsOptions,
  { declared, bare, fixed }: Declarations,
): Promise<number> {
  if (bare.size === 0 && fixed.length === 0) return 0;
  const split = (keys: Iterable<string>): { types: string[]; keys: string[] } => {
    const out = { types: [] as string[], keys: [] as string[] };
    for (const one of keys) {
      const space = one.indexOf(' ');
      out.types.push(one.slice(0, space));
      out.keys.push(one.slice(space + 1));
    }
    return out;
  };
  const named = split(bare);
  const kept = split(declared.keys());
  // `limits_source = 'declared'` is the whole guard: an operator's row is `operator`, whatever
  // it holds and however it came to hold it, and an `unset` row has nothing to clear. Like the
  // pass above, this reads no values: who wrote the row decides, not what is in it.
  const rows = await options.db.query<{ id: number }>(
    `UPDATE channel AS c
     SET limits = '{}'::jsonb, limits_source = 'unset'
     FROM sensor_config sc
     WHERE sc.object_id = c.sensor_id
       AND c.limits_source = 'declared'
       AND (
         EXISTS (
           SELECT 1 FROM unnest($1::text[], $2::text[]) AS b(type, key)
           WHERE b.type = sc.type AND b.key = c.key
         )
         OR (
           sc.type = ANY($3::text[])
           AND NOT EXISTS (
             SELECT 1 FROM unnest($4::text[], $5::text[]) AS d(type, key)
             WHERE d.type = sc.type AND d.key = c.key
           )
         )
       )
     RETURNING c.id`,
    [named.types, named.keys, fixed, kept.types, kept.keys],
  );
  return rows.length;
}

/** How many channels a person owns the thresholds of — reported, never acted on. */
async function countOperatorOwned(
  options: DeclaredLimitsOptions,
  types: readonly string[],
): Promise<number> {
  const rows = await options.db.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM channel c
     JOIN sensor_config sc ON sc.object_id = c.sensor_id
     WHERE c.limits_source = 'operator' AND sc.type = ANY($1::text[])`,
    [types],
  );
  return Number(rows[0]?.count ?? 0);
}
