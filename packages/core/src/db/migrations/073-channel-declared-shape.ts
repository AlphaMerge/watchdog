import { sensorTypesFor, standardCatalogue, type SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { BUILD } from '../../version.js';
import type { Queryable } from '../pool.js';
import type { Migration } from './types.js';

/** How many sensor ids one read covers: one short statement each, and one short update. */
export const SHAPE_WINDOW = 10_000;

/** How many sensors a type's unjudged channels are named by in the log, at most. */
export const UNJUDGED_LISTED = 50;

/** Channels of one type whose type declares a lookup their row does not hold. */
export interface Unjudged {
  readonly channels: number;
  /** The first sensors holding one, in id order, at most `UNJUDGED_LISTED`. */
  readonly sensorIds: readonly number[];
}

/** What the repair wrote, and what it left alone and why (`P-302`). */
export interface ShapeRepair {
  /** Channels given the counter width their type declares: stored as rates from now on. */
  readonly counters: number;
  /** Copied thresholds that said `unset`, now `declared` (a fixed type) or `operator`. */
  readonly limitSources: { readonly declared: number; readonly operator: number };
  /** Each type with a channel written, and how many. */
  readonly byType: Readonly<Record<string, number>>;
  /** Not written, only said: each type's channels with no lookup where it declares one. */
  readonly unjudged: Readonly<Record<string, Unjudged>>;
  /** Sensors of a type this build does not register: nothing says what they declare. */
  readonly unregistered: number;
  /** Sensors whose type could not answer for their stored parameters: left as they are. */
  readonly unanswerable: Readonly<Record<string, number>>;
}

export interface ShapeRepairOptions {
  readonly logger?: Logger;
  readonly window?: number;
  readonly listed?: number;
}

interface Row {
  id: number;
  sensor_id: string;
  type: string;
  params: Record<string, unknown>;
  key: string;
  lookup_id: string | null;
  counter_bits: number | null;
  copied_limits: boolean;
}

interface Shape {
  readonly lookup: string | null;
  readonly counterBits: number | null;
}

/**
 * Gives every channel the counter width its type declares and its row lacks, says which channels
 * lack a declared lookup, and labels copied thresholds (`P-302`).
 *
 * **What it repairs.** Until `P-302` a clone copied its source's channels without `lookup_id`,
 * `counter_bits` and `limits_source`, and nothing writes a channel's shape after it exists. So a
 * cloned `snmp.traffic` sensor stored cumulative octets as values on `in`, `out` and `total`, and
 * judged `status` by nothing. The same rows came out of ingestion before `P-80` (a key a later
 * build declared) and before `P-297` (a parameter-made key, answered from `{}`). It reads the
 * row, not how the row came to be.
 *
 * **`counter_bits` is written**, into an empty column only, where the type declares a counter for
 * the sensor's stored parameters. No person can set it, so an empty one is never a decision. It
 * turns stored totals into rates from the next readings on, and the only states it can move are
 * the ones the totals latched: a rate threshold a climbing total held in Down or Warning clears.
 *
 * **`lookup_id` is not written, only counted** (`P-302` review). An empty one may be a lookup an
 * operator cleared (`M-06`) on purpose, and on an old clone that decision was made on the
 * *source*, which the old clone did not copy and the audit log cannot reliably name
 * (`object.cloned` records only the root), and which retention erases in any case. Filling it
 * would judge every shut port on every clone at the first scan: the alarm storm the clear was
 * there to prevent. Not filling it leaves the channel judged by nothing, as it is today. So each
 * type's channels with a declared lookup and none in the row are counted, and the first sensors
 * holding them named, for an operator to set by hand (`installation.md`).
 *
 * **`limits_source`, on a row holding thresholds as `unset`**, which nothing but the old clone
 * wrote (`createChannels` writes `unset` only with `{}`, and `038` labelled every older row). On a
 * `fixedChannels` type it becomes `declared`, so the start-up pass brings it to this build's
 * declaration, or clears it where there is none (`P-291`): the start-up pass has already done
 * that to every such clone that lived through a start, and a clone made since then carries the
 * declaration of the build it was made under, which an install that skips a release would
 * otherwise keep as an operator's for good. On any other type it becomes `operator`: such a type
 * cannot declare limits (`P-293`), so they are a person's, copied from the source. A type this
 * build does not register is treated as the latter: the start-up pass leaves it alone anyway.
 *
 * **Asked with the sensor's own stored parameters**, as ingestion asks since `P-297`. A type that
 * cannot answer for them is not answered with `{}` here, unlike ingestion's fallback: a repair
 * that wrote a guess would write it for good. Those sensors are counted by type and left. So are
 * the sensors of a type this build does not register.
 *
 * **In windows of sensor ids**, each one read and at most one update on the pool, like `071`.
 * The update fills only what is still empty and relabels only what still says `unset`, so a
 * write between the read and the update is kept, and a second run writes nothing.
 */
export async function repairChannelShapes(
  db: Queryable,
  catalogue: SensorCatalogue,
  options: ShapeRepairOptions = {},
): Promise<ShapeRepair> {
  const window = options.window ?? SHAPE_WINDOW;
  const listed = options.listed ?? UNJUDGED_LISTED;
  let counters = 0;
  let unregistered = 0;
  const limitSources = { declared: 0, operator: 0 };
  const byType: Record<string, number> = {};
  const unanswerable: Record<string, number> = {};
  const unjudged: Record<string, { channels: number; sensorIds: number[] }> = {};

  const [bounds] = await db.query<{ low: string | null; high: string | null }>(
    'SELECT min(sensor_id)::text AS low, max(sensor_id)::text AS high FROM channel',
  );
  if (bounds !== undefined && bounds.low !== null && bounds.high !== null) {
    const high = BigInt(bounds.high);
    const step = BigInt(window);
    for (let from = BigInt(bounds.low) - 1n; from < high; from += step) {
      const rows = await db.query<Row>(
        `SELECT c.id, c.sensor_id::text AS sensor_id, sc.type, sc.params, c.key, c.lookup_id,
                c.counter_bits,
                (c.limits_source = 'unset' AND c.limits <> '{}'::jsonb) AS copied_limits
           FROM channel c
           JOIN sensor_config sc ON sc.object_id = c.sensor_id
          WHERE c.sensor_id > $1 AND c.sensor_id <= $2
            AND (c.lookup_id IS NULL OR c.counter_bits IS NULL
                 OR (c.limits_source = 'unset' AND c.limits <> '{}'::jsonb))
          ORDER BY c.sensor_id, c.key`,
        [from.toString(), (from + step).toString()],
      );

      const shapes = new Map<string, ReadonlyMap<string, Shape> | null>();
      const shapeOf = (row: Row): ReadonlyMap<string, Shape> | null => {
        const known = shapes.get(row.sensor_id);
        if (known !== undefined) return known;
        let answer: ReadonlyMap<string, Shape> | null = null;
        if (!catalogue.has(row.type)) {
          unregistered += 1;
        } else {
          try {
            answer = new Map(
              catalogue
                .channelsFor(row.type, row.params)
                .map((def) => [
                  def.key,
                  { lookup: def.lookup ?? null, counterBits: def.counter?.bits ?? null },
                ]),
            );
          } catch {
            unanswerable[row.type] = (unanswerable[row.type] ?? 0) + 1;
          }
        }
        shapes.set(row.sensor_id, answer);
        return answer;
      };

      const ids: number[] = [];
      const widths: (number | null)[] = [];
      const owners: (string | null)[] = [];
      for (const row of rows) {
        const shape = shapeOf(row)?.get(row.key);
        if (row.lookup_id === null && shape !== undefined && shape.lookup !== null) {
          const entry = (unjudged[row.type] ??= { channels: 0, sensorIds: [] });
          entry.channels += 1;
          const sensorId = Number(row.sensor_id);
          if (entry.sensorIds.length < listed && !entry.sensorIds.includes(sensorId)) {
            entry.sensorIds.push(sensorId);
          }
        }
        const width = row.counter_bits === null ? (shape?.counterBits ?? null) : null;
        const owner = !row.copied_limits
          ? null
          : catalogue.has(row.type) && catalogue.declaration(row.type).fixedChannels === true
            ? 'declared'
            : 'operator';
        if (width === null && owner === null) continue;
        ids.push(row.id);
        widths.push(width);
        owners.push(owner);
        if (width !== null) counters += 1;
        if (owner === 'declared') limitSources.declared += 1;
        if (owner === 'operator') limitSources.operator += 1;
        byType[row.type] = (byType[row.type] ?? 0) + 1;
      }
      if (ids.length === 0) continue;
      await db.query(
        `UPDATE channel c
            SET counter_bits = COALESCE(c.counter_bits, v.counter_bits),
                limits_source = CASE
                  WHEN v.owner IS NOT NULL AND c.limits_source = 'unset'
                       AND c.limits <> '{}'::jsonb THEN v.owner
                  ELSE c.limits_source
                END
           FROM unnest($1::int[], $2::smallint[], $3::text[]) AS v (id, counter_bits, owner)
          WHERE c.id = v.id`,
        [ids, widths, owners],
      );
    }
  }

  options.logger?.info(
    { counters, limitSources, byType, unregistered, unanswerable, phase: 'migration-073' },
    'channels given the counter width and threshold owner their sensor types declare; a counter ' +
      'channel stored cumulative totals until now and stores rates from its second reading on',
  );
  if (Object.keys(unjudged).length > 0) {
    options.logger?.warn(
      { unjudged, listedPerType: listed, phase: 'migration-073' },
      'these channels have no lookup though their sensor type declares one, so nothing judges ' +
        'them: cleared on purpose, or lost by a clone made before P-302. The upgrade does not ' +
        'set them, because a lookup set where it was cleared raises every alarm it was cleared ' +
        'to silence; set the ones you want by hand (PATCH /api/v1/objects/:id/channels/:key ' +
        'with a lookupId)',
    );
  }
  return { counters, limitSources, byType, unjudged, unregistered, unanswerable };
}

async function repair(context: { readonly db: Queryable; readonly logger: Logger }): Promise<void> {
  // A database with no channel has nothing to repair, and the catalogue is not worth building
  // for it: every test database is migrated, and most hold nothing.
  const [any] = await context.db.query<{ any: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM channel) AS any',
  );
  if (any?.any !== true) return;
  // The core's own catalogue, as `coreCatalogue` in `profile.ts` builds it: the types this build
  // registers and nothing else. Not imported from there, which would put the v2 subsystems'
  // modules in every migration's graph.
  const catalogue = standardCatalogue(sensorTypesFor(BUILD.profile));
  await repairChannelShapes(context.db, catalogue, { logger: context.logger });
}

/**
 * Channels given the counter width their type declares, copied thresholds given an owner, and
 * the channels judged by nothing named (`P-302`): see `repairChannelShapes`.
 *
 * **What an operator sees.** A counter channel that had no width stored the device's cumulative
 * total as each reading's value: `in`, `out` and `total` on a cloned traffic sensor climbed for
 * as long as it ran, in a unit that says per second. Those samples, and the rollups made from
 * them, stay as they are: a total cannot be turned into a rate after the fact without the reading
 * before it, and the repair rewrites no history. The first reading after the upgrade has no
 * counter baseline, so it stores nothing (a gap, as a new sensor's first reading does); from the
 * second on, the channel stores rates. A graph across the upgrade shows the totals, a one-interval
 * gap, then rates far smaller; a threshold written for a rate that the totals held in Down or
 * Warning clears once the rates arrive; that is the only state the repair can move. A status
 * channel with no lookup stays judged by nothing, and the log names the sensors holding one.
 *
 * `up` says so on the column. **The rollback** removes that comment and leaves every row as it is:
 * what was empty cannot be told apart from what the repair wrote, and the build before reads these
 * columns as they are and has no reason to want them empty.
 */
export const migration073: Migration = {
  id: 73,
  name: 'channel-declared-shape',
  transactional: false,

  up: `
    COMMENT ON COLUMN channel.counter_bits IS
      'Set when this channel reports a counter rather than a measurement (T-02). The stored sample is the rate; the raw counter lives in channel_counter. Rows a clone wrote without it were given their type''s by migration 073 (P-302).';
  `,

  data: repair,

  down: `
    COMMENT ON COLUMN channel.counter_bits IS
      'Set when this channel reports a counter rather than a measurement (T-02). The stored sample is the rate; the raw counter lives in channel_counter.';
  `,
};
