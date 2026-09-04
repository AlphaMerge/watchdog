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
  const declared = declarationsIn(catalogue);
  return (sensorType, channelKey) => declared.get(`${sensorType} ${channelKey}`) ?? null;
}

/** Every (type, channel) a registered type declares limits for. Built once, read many times. */
function declarationsIn(catalogue: SensorCatalogue): Map<string, ChannelLimits> {
  const declared = new Map<string, ChannelLimits>();
  for (const id of catalogue.ids()) {
    let defs;
    try {
      defs = catalogue.channelsFor(id, {});
    } catch {
      // `channels()` may need parameters. Such a type's channels vary per sensor and cannot be
      // matched by key across an installation anyway.
      continue;
    }
    for (const def of defs) {
      if (def.limits === undefined) continue;
      declared.set(`${id} ${def.key}`, limitsFromDeclaration(def.limits));
    }
  }
  return declared;
}

export interface DeclaredLimitsOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
}

export interface DeclaredLimitsReport {
  /** Channels whose limits this pass wrote. Zero on every start after the first. */
  readonly applied: number;
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
  const declared = declarationsIn(options.catalogue);
  if (declared.size === 0) return { applied: 0, operatorOwned: 0, unmatched: [] };

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
  return { applied, operatorOwned, unmatched };
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
