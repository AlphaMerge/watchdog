import { sensorTypesFor, standardCatalogue, type SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { declaredLimitsLookup } from '../../state/declared-limits.js';
import { BUILD } from '../../version.js';
import type { Queryable } from '../pool.js';
import type { Migration } from './types.js';

/** How many sensor ids one read covers: one short statement each, and one short update. */
export const SHAPE_WINDOW = 10_000;

/** What the repair wrote, and what it left alone and why (`P-302`). */
export interface ShapeRepair {
  /** Channels given the counter width their type declares: stored as rates from now on. */
  readonly counters: number;
  /** Channels given the lookup their type declares: judged by it from the next reading. */
  readonly lookups: number;
  /** Channels whose lookup is left empty because an operator set it (`channel.lookup.set`). */
  readonly lookupsAnOperatorSet: number;
  /** Channels holding copied thresholds marked `unset`, now `declared` or `operator`. */
  readonly limitSources: number;
  /** Each type with a channel written, and how many. */
  readonly byType: Readonly<Record<string, number>>;
  /** Sensors of a type this build does not register: nothing says what they declare. */
  readonly unregistered: number;
  /** Sensors whose type could not answer for their stored parameters: left as they are. */
  readonly unanswerable: Readonly<Record<string, number>>;
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
  lookup_set: boolean;
}

interface Shape {
  readonly lookup: string | null;
  readonly counterBits: number | null;
}

/**
 * Gives every channel what its type declares and its row lacks (`P-302`), and returns what it
 * wrote.
 *
 * **What it repairs.** Until `P-302` a clone copied its source's channels without `lookup_id`,
 * `counter_bits` and `limits_source`, and nothing writes a channel's shape after it exists. So a
 * cloned `snmp.traffic` sensor stored cumulative octets as values on `in`, `out` and `total`, and
 * judged `status` by nothing. The same rows came out of ingestion before `P-80` (a key a later
 * build declared, with no lookup or counter) and before `P-297` (a parameter-made key, answered
 * from `{}`), and the repair is the same for them, so it is not limited to clones: it reads the
 * row, not how the row came to be.
 *
 * **What it writes, and only into an empty column.**
 * - `counter_bits`, where the type declares a counter for the sensor's stored parameters. No
 *   person can set this column, so an empty one is never a decision.
 * - `lookup_id`, where the type declares one, unless the audit log holds a `channel.lookup.set`
 *   for that sensor and key: a lookup an operator cleared (`M-06`) stays cleared. Read from the
 *   log because the row cannot say; an entry pruned past the retention is a decision forgotten.
 * - `limits_source`, where a row holds thresholds and says `unset`, which nothing but the old
 *   clone wrote (`createChannels` writes `unset` only with `{}`, and `038` labelled every older
 *   row). `declared` if they are exactly what the type declares for that key, as the start-up
 *   pass would have left them; otherwise `operator`, as `038` decided: thresholds nobody declared
 *   were set by somebody, on the source, and the start-up pass must not replace them.
 *
 * A width already set is never changed (the reading's own `counterBits` wins over it), nor is a
 * lookup already set, nor a channel the type does not name.
 *
 * **Asked with the sensor's own stored parameters**, as ingestion asks since `P-297`. A type that
 * cannot answer for them is not answered with `{}` here, unlike ingestion's fallback: a repair
 * that wrote a guess would write it for good. Those sensors are counted by type and left. So are
 * the sensors of a type this build does not register.
 *
 * **In windows of sensor ids**, each one read and at most one update on the pool, like `071`.
 * The update fills only what is still empty, so a write between the read and the update is kept,
 * and a second run finds nothing.
 */
export async function repairChannelShapes(
  db: Queryable,
  catalogue: SensorCatalogue,
  window: number = SHAPE_WINDOW,
): Promise<ShapeRepair> {
  const declaredLimits = declaredLimitsLookup(catalogue);
  const totals = {
    counters: 0,
    lookups: 0,
    lookupsAnOperatorSet: 0,
    limitSources: 0,
    unregistered: 0,
  };
  const byType: Record<string, number> = {};
  const unanswerable: Record<string, number> = {};

  const [bounds] = await db.query<{ low: string | null; high: string | null }>(
    'SELECT min(sensor_id)::text AS low, max(sensor_id)::text AS high FROM channel',
  );
  if (bounds === undefined || bounds.low === null || bounds.high === null) {
    return { ...totals, byType, unanswerable };
  }
  const high = BigInt(bounds.high);
  const step = BigInt(window);
  for (let from = BigInt(bounds.low) - 1n; from < high; from += step) {
    const rows = await db.query<Row>(
      `SELECT c.id, c.sensor_id::text AS sensor_id, sc.type, sc.params, c.key, c.lookup_id,
              c.counter_bits,
              (c.limits_source = 'unset' AND c.limits <> '{}'::jsonb) AS copied_limits,
              EXISTS (
                SELECT 1 FROM audit_log a
                 WHERE a.object_id = c.sensor_id AND a.action = 'channel.lookup.set'
                   AND a.summary ->> 'channelKey' = c.key
              ) AS lookup_set
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
        totals.unregistered += 1;
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
    const lookups: (string | null)[] = [];
    const counters: (number | null)[] = [];
    const declared: (string | null)[] = [];
    for (const row of rows) {
      const shape = shapeOf(row)?.get(row.key);
      const counter = row.counter_bits === null ? (shape?.counterBits ?? null) : null;
      let lookup: string | null = null;
      if (row.lookup_id === null && shape !== undefined && shape.lookup !== null) {
        if (row.lookup_set) totals.lookupsAnOperatorSet += 1;
        else lookup = shape.lookup;
      }
      if (counter === null && lookup === null && !row.copied_limits) continue;
      ids.push(row.id);
      lookups.push(lookup);
      counters.push(counter);
      const limits = row.copied_limits ? declaredLimits(row.type, row.key) : null;
      declared.push(limits === null ? null : JSON.stringify(limits));
      if (counter !== null) totals.counters += 1;
      if (lookup !== null) totals.lookups += 1;
      if (row.copied_limits) totals.limitSources += 1;
      byType[row.type] = (byType[row.type] ?? 0) + 1;
    }
    if (ids.length === 0) continue;
    await db.query(
      `UPDATE channel c
          SET counter_bits = COALESCE(c.counter_bits, v.counter_bits),
              lookup_id = COALESCE(c.lookup_id, v.lookup_id),
              limits_source = CASE
                WHEN c.limits_source <> 'unset' OR c.limits = '{}'::jsonb THEN c.limits_source
                WHEN c.limits = v.declared THEN 'declared'
                ELSE 'operator'
              END
         FROM unnest($1::int[], $2::text[], $3::smallint[], $4::jsonb[])
              AS v (id, lookup_id, counter_bits, declared)
        WHERE c.id = v.id`,
      [ids, lookups, counters, declared],
    );
  }
  return { ...totals, byType, unanswerable };
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
  const repaired = await repairChannelShapes(context.db, catalogue);
  context.logger.info(
    { ...repaired, phase: 'migration-073' },
    'channels given the counter width, lookup and threshold owner their sensor types declare; ' +
      'a counter channel stored cumulative totals until now and stores rates from its second ' +
      'reading on, and a lookup channel is judged from its next reading',
  );
}

/**
 * Channels given the shape their type declares (`P-302`): see `repairChannelShapes`.
 *
 * **What an operator sees.** A counter channel that had no width stored the device's cumulative
 * total as each reading's value: `in`, `out` and `total` on a cloned traffic sensor climbed for
 * as long as it ran, in a unit that says per second. Those samples, and the rollups made from
 * them, stay as they are: a total cannot be turned into a rate after the fact without the reading
 * before it, and the repair rewrites no history. The first reading after the upgrade has no
 * counter baseline, so it stores nothing (a gap, as a new sensor's first reading does); from the
 * second on, the channel stores rates. A graph across the upgrade shows the totals, a one-interval
 * gap, then rates far smaller; a threshold written for a rate that the totals held in Down or
 * Warning clears once the rates arrive. A lookup channel is judged from its next reading, so an
 * interface that has been down all along turns its sensor Down then, which is the alarm it
 * should have raised when it went down.
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
    COMMENT ON COLUMN channel.lookup_id IS
      'The lookup that judges this channel (M-06): declared by its sensor type, or set by an operator. Rows a clone wrote without it were given their type''s by migration 073 (P-302).';
  `,

  data: repair,

  down: `
    COMMENT ON COLUMN channel.lookup_id IS NULL;
  `,
};
