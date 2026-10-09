import type { SensorCatalogue } from '@ms/sensors';
import { describeError, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { moveDeclaredPrimaries } from '../ingestion/channels.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { declaredChannelLookup, type DeclaredShapes } from './declared-limits.js';

/**
 * Putting `is_primary` on the channel a sensor's type declares primary, where an earlier build
 * left it elsewhere (`P-323`).
 *
 * **What it repairs.** Since `P-314` the reading that creates a declared primary's row makes it
 * primary, and since `P-309` an edit moves the primary onto a declared one that has a row. Before
 * `P-314`, a row created by a reading was created plain: an edit that put a new column first kept
 * the old primary (it creates no channels), and the reading then created the new column's row
 * without `is_primary`. Nothing moves it until an edit changes the declaration again, which may
 * never come, so the list number, the mini-graph line and a notification's last value go on
 * following the column the operator moved away from. This pass moves it once.
 *
 * **Every start, no marker** — as `S-18`'s declared-limits pass does. A marker would need a table
 * (a migration) and would buy nothing an idempotent pass does not: after the first run every
 * sensor's declared primary is already primary, the unlocked read below finds nothing to move,
 * and nothing is written, locked or audited. And it is the same upgrade for a later build: a type
 * whose new build declares a different primary for the same stored parameters gets it on
 * existing sensors at the next start, as a create of those parameters would. Nobody's decision is
 * overridden, because no route lets an operator choose `is_primary` (`P-309`): a row that is not
 * the declared primary is one an earlier declaration left behind.
 *
 * **What it moves, and what it leaves** (each a row of `declared-primary.test.ts`):
 * - the sensor's own stored parameters declare a primary, that key has a row, and the row is not
 *   primary: the current primary is demoted and that row promoted, as one move;
 * - a sensor with no primary at all whose declared primary has a row gets it — what a create of
 *   the same parameters gives it, and what `P-309`'s edit and `P-314`'s reading give it;
 * - **left** when the row is already primary, when the declared primary has no row (the reading
 *   that creates it moves it, `P-314`; demoting the current one now would leave the sensor with
 *   none), when the type declares no primary, when the type is not registered in this build, and
 *   when the type throws for the stored parameters: the `{}` fallback's primary is a
 *   placeholder's (`DeclaredShapes.primary` is null then), so a sensor whose type cannot answer
 *   keeps what it has. Those are counted, by type, in the line this pass logs.
 *
 * **The declaration is `declaredChannelLookup`'s**, the answer ingestion moves a primary from, and
 * **the move is `moveDeclaredPrimaries`**, the one ingestion makes: demoted first in a statement
 * of its own (`channel_one_primary_per_sensor` is not deferrable), audited as a
 * `channel.redeclared` entry per channel whose `isPrimary` changed. Through the sinks
 * `ingestionAuditSinks` names — the database, the log and the result-cache invalidator, so a
 * `channel.*` entry makes ingestion forget the sensor — by the system actor
 * `declared-primary-startup-repair`.
 *
 * **Bounded, and not in the way of the start.** `S-18`'s pass is one set-based statement, awaited
 * before anything reads a limit, cheap because after the first start it matches nothing. This one
 * cannot be a statement: the declaration is the sensor type's code run on each sensor's own
 * parameters, so every start reads every `sensor_config` row. So it goes in keyset pages of
 * `batchSize` sensors, each page an unlocked read and, only where something would move, a short
 * transaction of its own; and `main.ts` does not await it — it runs once the core is up, as the
 * start-up alarm reconciliation does (`P-177`), and stops between pages when shutdown begins.
 * Running it late costs nothing: what it moves is what a list shows, and no state is judged from
 * it.
 *
 * **Safe against a reading, an edit, a delete or a reorder arriving meanwhile.** A page that has
 * something to move takes the `object` rows of the sensors that would move (not the whole page)
 * `FOR NO KEY UPDATE SKIP LOCKED`, then reads `sensor_config` again, then the channel rows, and
 * only then writes: object, `sensor_config`, `channel`, the order an edit takes them in, and
 * ingestion's when it creates a channel (`P-303` review, `P-314`), and `patchChannel`'s (`P-314`).
 * **It never waits for a sensor** (`P-323` review): one somebody else holds is skipped, counted
 * and left for the next start, so the repair cannot deadlock with a writer that locks `object`
 * rows in another order (a subtree delete, a sibling reorder), and never makes an operator's
 * write wait or fail. A writer arriving after it waits for one short page transaction. What it
 * does hold it decides about again, from parameters and rows nobody can change under it, so a
 * primary an edit or a reading moved meanwhile is not moved back. A reading of an existing
 * channel takes only key-share locks, which this does not block. A page that throws anyway is
 * logged with its range and the pass goes on; the pass itself never rejects.
 */

/** Who moves a primary at start-up: nobody did, an earlier build's declaration had not. */
export const DECLARED_PRIMARY_REPAIR: Actor = {
  kind: 'system',
  component: 'declared-primary-startup-repair',
};

/** Sensors per page. One page is one unlocked read and, if anything moves, one transaction. */
const DEFAULT_BATCH_SIZE = 500;

export interface DeclaredPrimaryRepairOptions {
  readonly db: Pick<Database, 'query' | 'tx'>;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
  /** `ingestionAuditSinks`, in `main.ts`: the record, the log and the cache invalidator. */
  readonly audit: AuditSink;
  readonly batchSize?: number;
  /** Checked between pages: shutdown waits for at most the page in flight. */
  readonly signal?: AbortSignal;
}

export interface DeclaredPrimaryRepairReport {
  /** Sensors read. Every sensor in the installation, unless `complete` is false. */
  readonly sensors: number;
  /** Sensors whose primary this pass moved. Zero on every start after the first. */
  readonly moved: number;
  /**
   * Sensors with a primary to move that another transaction held when their page came to lock
   * them (`SKIP LOCKED`): left as they are, for the next start.
   */
  readonly skipped: number;
  /**
   * Pages whose move threw: each logged with its sensor range, the pages after it gone on with,
   * and its sensors left for the next start.
   */
  readonly failedPages: number;
  /**
   * Sensors left alone because their type threw for their stored parameters, so what they declare
   * primary is unknown (`P-306`'s fallback).
   */
  readonly undeclared: number;
  /** The types of those, sorted. */
  readonly undeclaredTypes: readonly string[];
  /** False when shutdown stopped it between pages; the next start goes over every sensor. */
  readonly complete: boolean;
}

interface SensorRow {
  readonly id: string;
  readonly type: string;
  readonly params: unknown;
}

interface Wanted {
  readonly sensor_id: string;
  readonly key: string;
}

type Lookup = (
  sensorType: string,
  params: Readonly<Record<string, unknown>>,
  sensorId: number,
) => DeclaredShapes;

export async function repairDeclaredPrimaries(
  options: DeclaredPrimaryRepairOptions,
): Promise<DeclaredPrimaryRepairReport> {
  const logger = options.logger.child({ component: 'declared-primary-repair' });
  // Without a logger: its warning speaks of a channel ingestion creates, and this creates none.
  // A type that cannot answer is counted here instead, and said in this pass's own line.
  const declared = declaredChannelLookup(options.catalogue);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const undeclaredTypes = new Set<string>();
  let sensors = 0;
  let moved = 0;
  let skipped = 0;
  let failedPages = 0;
  let undeclared = 0;
  let complete = true;
  let after = '0';

  for (;;) {
    if (options.signal?.aborted === true) {
      complete = false;
      break;
    }
    let page: SensorRow[];
    try {
      page = await options.db.query<SensorRow>(
        `SELECT object_id::text AS id, type, params FROM sensor_config
         WHERE object_id > $1::bigint ORDER BY object_id LIMIT $2`,
        [after, batchSize],
      );
    } catch (error) {
      // Nothing to go on to: the next page is not known. Stopped, said, and never rejected.
      logger.warn(
        { ...describeError(error), afterSensorId: after, phase: 'read-page' },
        'could not read the next page of sensors for the declared-primary repair; the rest ' +
          'waits for the next start',
      );
      complete = false;
      break;
    }
    const first = page[0];
    const last = page.at(-1);
    if (first === undefined || last === undefined) break;
    after = last.id;
    sensors += page.length;

    const wanted = primariesOf(page, declared, (type) => {
      undeclared += 1;
      undeclaredTypes.add(type);
    });
    // **A failure is the page's, not the pass's** (`P-323` review). One page whose transaction
    // throws — whatever the reason, since a lock this pass skips cannot be the reason — is logged
    // with its range and counted, and the pages after it go on; the next start tries it again.
    try {
      // Unlocked, and nearly always empty: on every start after the first, this is the whole cost
      // of a page, and no sensor is locked. Only the sensors it names are locked below; one it did
      // not name and an edit changes meanwhile is that edit's to move (`P-309`).
      const stale = await notPrimary(options.db, wanted);
      if (stale.length === 0) continue;
      const done = await options.db.tx((q) =>
        moveLocked(
          q,
          stale.map((one) => one.sensor_id),
          declared,
          options.audit,
        ),
      );
      moved += done.moved;
      skipped += done.skipped;
    } catch (error) {
      failedPages += 1;
      logger.warn(
        {
          ...describeError(error),
          firstSensorId: first.id,
          lastSensorId: last.id,
          phase: 'move-page',
        },
        'could not move the declared primaries of one page of sensors; the pages after it go ' +
          'on, and the next start tries this one again',
      );
    }
  }

  const report: DeclaredPrimaryRepairReport = {
    sensors,
    moved,
    skipped,
    failedPages,
    undeclared,
    undeclaredTypes: [...undeclaredTypes].sort(),
    complete,
  };
  if (moved > 0 || skipped > 0 || failedPages > 0 || undeclared > 0 || !complete) {
    logger.info(
      report,
      'moved is_primary onto the channel each sensor’s type declares primary, where an ' +
        'earlier build had left it elsewhere; sensors another transaction held, and sensors ' +
        'whose type could not answer for their stored parameters, were left as they are',
    );
  } else {
    logger.debug(report, 'every sensor’s declared primary is already primary');
  }
  return report;
}

/**
 * The move for these sensors, under their locks: everything decided again from what is committed
 * once nobody else can change it, since the unlocked read only said that something might move.
 *
 * **Only the sensors nobody else holds** (`P-323` review). `SKIP LOCKED` rather than a wait,
 * because this pass cannot rely on the lock order of every other writer of `object` rows: a
 * subtree delete (`deleteIds`) takes them in scan order and a sibling reorder
 * (`writeSiblingOrder`) in join order, neither by id. Waiting would mean a deadlock or the pool's
 * `lock_timeout` for one side — and the side Postgres picks might be the operator's delete. Nothing
 * here is urgent, so a held sensor is simply left: counted as `skipped`, moved by the next start.
 * Once its sensors are held, this waits on nothing: their channel rows are written only by
 * writers that take the sensor first, and the trigger it fires touches only that sensor.
 */
async function moveLocked(
  q: Queryable,
  ids: readonly string[],
  declared: Lookup,
  audit: AuditSink,
): Promise<{ moved: number; skipped: number }> {
  // Object, then `sensor_config`, then `channel`: an edit's order, and ingestion's (`P-314`).
  const held = await q.query<{ id: string }>(
    // Locked in id order, the number's and not this SELECT's text column (P-385 review).
    // Harmless either way under SKIP LOCKED, which never waits, but an order is what it says.
    `SELECT id::text AS id FROM object WHERE id = ANY($1::bigint[])
     ORDER BY object.id FOR NO KEY UPDATE SKIP LOCKED`,
    [ids],
  );
  const skipped = ids.length - held.length;
  if (held.length === 0) return { moved: 0, skipped };
  const fresh = await q.query<SensorRow>(
    `SELECT object_id::text AS id, type, params FROM sensor_config
     WHERE object_id = ANY($1::bigint[])`,
    [held.map((row) => row.id)],
  );
  // Counted on the unlocked read already; not twice.
  const stale = await notPrimary(
    q,
    primariesOf(fresh, declared, () => undefined),
  );
  if (stale.length === 0) return { moved: 0, skipped };
  await moveDeclaredPrimaries(q, stale, { audit, actor: DECLARED_PRIMARY_REPAIR });
  return { moved: stale.length, skipped };
}

/** Each sensor's declared primary, for those whose own stored parameters declare one. */
function primariesOf(
  rows: readonly SensorRow[],
  declared: Lookup,
  onUndeclared: (type: string) => void,
): Wanted[] {
  const wanted: Wanted[] = [];
  for (const row of rows) {
    const params =
      typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : {};
    const answer = declared(row.type, params, Number(row.id));
    if (answer.undeclared) onUndeclared(row.type);
    // Null for a type that declares none, one this build does not register, and the fallback.
    if (answer.primary !== null) wanted.push({ sensor_id: row.id, key: answer.primary });
  }
  return wanted;
}

/** Of the declared primaries, those with a row that is not primary: the ones to move. */
async function notPrimary(q: Queryable, wanted: readonly Wanted[]): Promise<Wanted[]> {
  if (wanted.length === 0) return [];
  return q.query<{ sensor_id: string; key: string }>(
    `SELECT c.sensor_id::text AS sensor_id, c.key
     FROM channel c
     JOIN unnest($1::bigint[], $2::text[]) AS w(sensor_id, key)
       ON w.sensor_id = c.sensor_id AND w.key = c.key
     WHERE NOT c.is_primary
     ORDER BY c.sensor_id`,
    [wanted.map((one) => one.sensor_id), wanted.map((one) => one.key)],
  );
}
