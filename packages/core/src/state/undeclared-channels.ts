import type { SensorCatalogue } from '@ms/sensors';
import { describeError, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import { clearUndeclaredMarks } from '../objects/repository.js';
import type { ChannelDeclaration } from '../objects/redeclare.js';
import { declaredChannelLookup, type DeclaredShapes } from './declared-limits.js';

/**
 * **Channels created without their declared shape are written once their type can answer**
 * (`P-312`).
 *
 * Ingestion creates a channel from what its sensor's type declares for the sensor's stored
 * parameters (`P-297`). When the type cannot answer for them — it throws, or breaks its own
 * declaration (`P-296`) — or this build does not register the type at all, the row gets the type's
 * answer to `{}` or nothing, and is marked `undeclared` (migration 079). Nothing on the ingestion
 * path writes a row that exists again: after a restart a cold batch only reads them. The usual
 * mend is a build whose type can answer, so this runs at every start, after the migrations, and
 * goes over the marked rows only — a partial index, so on an installation with none, which is
 * nearly every one, the whole pass is one empty read. Not behind a `P-333` marker: the mark is its
 * own, and a build that cannot answer yet leaves it for the next. `main.ts` starts it once
 * `P-323`'s repair has finished, so the two do not skip each other's sensors.
 *
 * **What it writes is what an edit would** (`P-303`): the lookup and the counter width the type now
 * declares for each marked channel. Not a counter turned gauge or the reverse — `P-303` refuses
 * that of an edit, since the channel's stored samples are one or the other on one series — so a
 * channel whose declared mode differs from the one it was created with keeps it, and the warning
 * names it and says what to do: a new sensor, as `OBJECT_CHANNEL_MODE_FIXED` does. Not limits:
 * those come from `S-18`'s pass and the resolver by type and key, never from the fallback. Not
 * the primary: `P-323`'s pass moves it, by the same declaration, at the first start of a build. A
 * key the answer does not name is left as it is: there is nothing to write it from.
 *
 * **The mark is cleared once the type has answered**, whatever was written, so each channel is
 * said once; an operator pointing the channel at a lookup clears it too (`setChannelLookup`, and
 * `keepChannelLookup` for the lookup it already had), and this never undoes that. A clone copies
 * it (`CLONED_CHANNEL_COLUMNS`), since the copy holds the same fallback's row. A sensor whose type
 * still cannot answer keeps its marks, counted in the pass's line with its type. Clearing a mark
 * on a row whose lookup and width stay as they are moves no version (`clearUndeclaredMarks`): the
 * mark is nobody's to see, and an operator with the sensor open must not be refused for it.
 *
 * **Locked as `P-323`'s repair is**: object, then `sensor_config`, then `channel`, the edit's order,
 * `SKIP LOCKED` so it waits on nothing, and everything decided again under the lock. A sensor
 * somebody else holds is left for the next start. Each write is a `channel.redeclared` entry by its
 * own system actor through `ingestionAuditSinks`, so the resolver forgets what it cached of the
 * sensor (`M-04`), as it does for an edit's.
 */

/** Who writes a channel's shape at start-up: nobody did, a build that could not answer had not. */
export const UNDECLARED_CHANNEL_REPAIR: Actor = {
  kind: 'system',
  component: 'undeclared-channel-startup-repair',
};

/** Sensors per page. One page is one unlocked read and, if anything is marked, one transaction. */
const DEFAULT_BATCH_SIZE = 500;

export interface UndeclaredChannelRepairOptions {
  readonly db: Pick<Database, 'query' | 'tx'>;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
  /** `ingestionAuditSinks`, in `main.ts`: the record, the log and the cache invalidator. */
  readonly audit: AuditSink;
  readonly batchSize?: number;
  /** Checked between pages: shutdown waits for at most the page in flight. */
  readonly signal?: AbortSignal;
}

export interface UndeclaredChannelRepairReport {
  /** Sensors with a marked channel, read. */
  readonly sensors: number;
  /** Channels whose lookup or counter width this pass wrote. */
  readonly repaired: number;
  /** Channels whose mark this pass cleared, the repaired ones included. */
  readonly cleared: number;
  /** Of `cleared`, channels whose declared mode differs from the stored one, and was kept. */
  readonly modeKept: number;
  /** Sensors whose type still cannot answer for their stored parameters; their marks stay. */
  readonly stillUndeclared: number;
  /** The types of those, sorted. */
  readonly undeclaredTypes: readonly string[];
  /** Sensors another transaction held; the next start tries them again. */
  readonly skipped: number;
  /** Pages whose transaction failed; the pages after went on. */
  readonly failedPages: number;
  /** False when shutdown or a failed read stopped it between pages. */
  readonly complete: boolean;
}

type Lookup = (
  sensorType: string,
  params: Readonly<Record<string, unknown>>,
  sensorId: number,
) => DeclaredShapes;

interface SensorRow {
  readonly id: string;
  readonly type: string;
  readonly params: unknown;
}

interface MarkedRow {
  readonly id: number;
  readonly sensor_id: string;
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly lookup_id: string | null;
  readonly counter_bits: number | null;
  readonly is_primary: boolean;
}

/** A channel whose declared mode differs from the stored one: kept, and said. */
interface KeptMode {
  readonly sensorId: number;
  readonly sensorType: string;
  readonly channelKey: string;
  readonly stored: 'counter' | 'gauge';
  readonly declared: 'counter' | 'gauge';
}

interface PageOutcome {
  readonly repaired: number;
  readonly cleared: number;
  readonly kept: readonly KeptMode[];
  readonly skipped: number;
}

export async function repairUndeclaredChannels(
  options: UndeclaredChannelRepairOptions,
): Promise<UndeclaredChannelRepairReport> {
  const logger = options.logger.child({ component: 'undeclared-channel-repair' });
  // Without a logger: its warning speaks of a channel ingestion creates, and this creates none.
  // A type that still cannot answer is counted here instead, and said in this pass's own line.
  const declared = declaredChannelLookup(options.catalogue);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const undeclaredTypes = new Set<string>();
  let sensors = 0;
  let repaired = 0;
  let cleared = 0;
  let modeKept = 0;
  let stillUndeclared = 0;
  let skipped = 0;
  let failedPages = 0;
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
        `SELECT s.object_id::text AS id, s.type, s.params
         FROM sensor_config s
         WHERE s.object_id IN (
           SELECT c.sensor_id FROM channel c
           WHERE c.undeclared AND c.sensor_id > $1::bigint
           GROUP BY c.sensor_id ORDER BY c.sensor_id LIMIT $2)
         ORDER BY s.object_id`,
        [after, batchSize],
      );
    } catch (error) {
      logger.warn(
        { ...describeError(error), afterSensorId: after, phase: 'read-page' },
        'could not read the next page of sensors with channels created undeclared; the rest ' +
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

    // Unlocked: only a sensor whose type now answers is worth a lock.
    const answering = page.filter((row) => {
      if (!answerFor(row, declared).undeclared) return true;
      stillUndeclared += 1;
      undeclaredTypes.add(row.type);
      return false;
    });
    if (answering.length === 0) continue;
    try {
      const done = await options.db.tx((q) =>
        repairLocked(
          q,
          answering.map((row) => row.id),
          declared,
          options.audit,
        ),
      );
      repaired += done.repaired;
      cleared += done.cleared;
      modeKept += done.kept.length;
      skipped += done.skipped;
      for (const one of done.kept) {
        logger.warn(
          { ...one, phase: 'repair-channel' },
          `the channel was created as a ${one.stored} before its type could declare it, and ` +
            `its type now declares a ${one.declared}; its stored samples are ${one.stored}s, ` +
            'so it is kept as it is. Add a new sensor with these parameters to read it as ' +
            `a ${one.declared}`,
        );
      }
    } catch (error) {
      failedPages += 1;
      logger.warn(
        {
          ...describeError(error),
          firstSensorId: first.id,
          lastSensorId: last.id,
          phase: 'repair-page',
        },
        'could not repair the channels created undeclared of one page of sensors; the pages ' +
          'after it go on, and the next start tries this one again',
      );
    }
  }

  const report: UndeclaredChannelRepairReport = {
    sensors,
    repaired,
    cleared,
    modeKept,
    stillUndeclared,
    undeclaredTypes: [...undeclaredTypes].sort(),
    skipped,
    failedPages,
    complete,
  };
  if (sensors > 0 || !complete) {
    logger.info(
      report,
      'wrote the lookup and counter width their types now declare onto channels created ' +
        'without them; sensors whose type still cannot answer, and sensors another ' +
        'transaction held, were left marked for the next start',
    );
  } else {
    logger.debug(report, 'no channel is marked as created without its declared shape');
  }
  return report;
}

/** What the sensor's type declares for its stored parameters. */
function answerFor(row: SensorRow, declared: Lookup): DeclaredShapes {
  const params =
    typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
      ? (row.params as Record<string, unknown>)
      : {};
  return declared(row.type, params, Number(row.id));
}

const modeOf = (bits: number | null): 'counter' | 'gauge' => (bits === null ? 'gauge' : 'counter');

/**
 * The repair for these sensors, under their locks: everything decided again from what is
 * committed once nobody else can change it, since the unlocked read only said the type answers.
 */
async function repairLocked(
  q: Queryable,
  ids: readonly string[],
  declared: Lookup,
  audit: AuditSink,
): Promise<PageOutcome> {
  // Object, then `sensor_config`, then `channel`: an edit's order, and ingestion's (`P-314`).
  const held = await q.query<{ id: string }>(
    `SELECT id::text AS id FROM object WHERE id = ANY($1::bigint[])
     ORDER BY object.id FOR NO KEY UPDATE SKIP LOCKED`,
    [ids],
  );
  const skipped = ids.length - held.length;
  if (held.length === 0) return { repaired: 0, cleared: 0, kept: [], skipped };
  const fresh = await q.query<SensorRow>(
    `SELECT object_id::text AS id, type, params FROM sensor_config
     WHERE object_id = ANY($1::bigint[])`,
    [held.map((row) => row.id)],
  );
  const answers = new Map<string, { type: string; answer: DeclaredShapes }>();
  for (const row of fresh) {
    const answer = answerFor(row, declared);
    // An edit between the two reads gave it parameters its type cannot answer for: marked still.
    if (!answer.undeclared) answers.set(row.id, { type: row.type, answer });
  }
  if (answers.size === 0) return { repaired: 0, cleared: 0, kept: [], skipped };
  const marked = await q.query<MarkedRow>(
    `SELECT id, sensor_id::text AS sensor_id, key, name, unit, lookup_id, counter_bits, is_primary
     FROM channel WHERE undeclared AND sensor_id = ANY($1::bigint[])
     ORDER BY channel.sensor_id, channel.key`,
    [[...answers.keys()]],
  );

  const writes: { id: number; lookup: string | null; bits: number | null }[] = [];
  const unchanged: { sensorId: string; key: string }[] = [];
  const mutations: Mutation[] = [];
  const kept: KeptMode[] = [];
  for (const row of marked) {
    const sensor = answers.get(row.sensor_id);
    if (sensor === undefined) continue;
    const before: ChannelDeclaration = {
      name: row.name,
      unit: row.unit,
      lookupId: row.lookup_id,
      counterBits: row.counter_bits,
      isPrimary: row.is_primary,
    };
    const shape = sensor.answer.shapes.get(row.key);
    let lookup = row.lookup_id;
    let bits = row.counter_bits;
    if (shape !== undefined) {
      lookup = shape.lookup;
      if (modeOf(shape.counterBits) === modeOf(row.counter_bits)) {
        bits = shape.counterBits;
      } else {
        kept.push({
          sensorId: Number(row.sensor_id),
          sensorType: sensor.type,
          channelKey: row.key,
          stored: modeOf(row.counter_bits),
          declared: modeOf(shape.counterBits),
        });
      }
    }
    if (lookup === row.lookup_id && bits === row.counter_bits) {
      unchanged.push({ sensorId: row.sensor_id, key: row.key });
      continue;
    }
    writes.push({ id: row.id, lookup, bits });
    mutations.push({
      action: 'channel.redeclared',
      objectId: Number(row.sensor_id),
      kind: 'sensor',
      channelKey: row.key,
      before,
      after: { ...before, lookupId: lookup, counterBits: bits },
    });
  }
  // A change: the sensor's version moves, as for an edit's re-declaration, and it is audited.
  if (writes.length > 0) {
    await q.query(
      `UPDATE channel AS c
       SET lookup_id = w.lookup_id, counter_bits = w.counter_bits, undeclared = false
       FROM unnest($1::integer[], $2::text[], $3::smallint[]) AS w(id, lookup_id, counter_bits)
       WHERE c.id = w.id`,
      [writes.map((one) => one.id), writes.map((one) => one.lookup), writes.map((one) => one.bits)],
    );
    await audit.record(q, UNDECLARED_CHANNEL_REPAIR, mutations, new Date());
  }
  // Only the mark: nothing a reader sees, so no version moves and nothing is audited.
  await clearUndeclaredMarks(q, unchanged);
  return { repaired: writes.length, cleared: writes.length + unchanged.length, kept, skipped };
}
