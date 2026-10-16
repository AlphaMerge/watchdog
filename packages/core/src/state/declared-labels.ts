import type { SensorCatalogue } from '@ms/sensors';
import { describeError, isExactBuild, type BuildStamp, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { passIsDue, recordPass, rulesDigest, type StartupPassRules } from '../db/startup-pass.js';
import type { Actor, AuditSink, Mutation } from '../objects/audit.js';
import type { ChannelDeclaration } from '../objects/redeclare.js';
import { channelLabel, declaredChannelLookup, type DeclaredShapes } from './declared-limits.js';

/**
 * **A channel ingestion named by its key is given the name and unit its type declares**
 * (`P-402`).
 *
 * **What it repairs.** A create writes each channel's declared name and unit (`createChannels`).
 * A channel first seen in a reading is created by ingestion, which until `P-402` took only the
 * reading's own words and, with none, the key and no unit. Core Health's and Probe Health's
 * readings carry none, so on an installation whose health sensors predate a build, every channel
 * that build added to them read `probesSilent` where it should read "Probes not delivering", with
 * no unit — in the channel table, the history panel, which also draws a channel with its
 * same-unit siblings and so drew this one apart from them, and the series table. Nothing mended
 * it: a channel's name and unit are written by a create, ingestion, a clone and an edit's
 * re-declaration, which writes them only when the declaration itself changed, or when the type
 * cannot answer for the stored parameters, and a type with no parameters never changes it.
 *
 * **Which rows.** Only those named by their key with no unit — what ingestion wrote when a
 * reading sent nothing. A row whose reading sent a name or a unit is left, even where ingestion
 * would name it otherwise today (an `exe.script.advanced` primary created after an edit, with
 * `primaryName` set): its words came from somewhere, and this cannot tell where. A name a reading
 * sent, a script channel's own words, is never rewritten; and no route lets an operator choose a
 * channel's name or unit (`patchChannel` takes limits, a lookup and processing), so nobody's
 * decision is overridden. Each gets what ingestion now creates for a reading that sent nothing
 * (`channelLabel`): its declared name where that is more than its key, and its declared unit
 * where there is one. So a row this repairs and a row created today agree, and one whose
 * declaration says nothing of its own is left. A row an older build's create named by its key,
 * where this build's declaration names it, is renamed too: what a create writes today. A key the
 * sensor's own answer does not name is left, and so is a sensor whose type cannot answer for its
 * stored parameters or is not registered in this build: counted, and the types named in the
 * pass's line.
 *
 * **Once per build** (`P-333`), keyed on the exact build as `P-323`'s pass is
 * (`declaredLabelRules`): a declaration is a type's code run on each sensor's parameters, so only
 * a new build can change one, and a new build is when a type gains channels. Rows that are right
 * as they are — a declared name that is only its key, a script's channel named by its key — stay
 * candidates, read again only when the build changes. Recorded only by a run that read every
 * candidate and left none for later.
 *
 * **Locked as `P-323`'s and `P-312`'s repairs are**: object, then `sensor_config`, then `channel`,
 * the edit's order, `SKIP LOCKED` so it waits on nothing, and everything decided again under the
 * lock, so a channel an edit renamed meanwhile is not a candidate any more. A sensor somebody else
 * holds is left for the next start. Each write moves the sensor's version — a name and a unit are
 * what a reader sees, and the resolver caches both — and is a `channel.redeclared` entry by its
 * own system actor through `ingestionAuditSinks`, so the resolver forgets the sensor (`M-04`).
 */

/** Who names a channel at start-up: nobody did, ingestion had only the key to go on. */
export const DECLARED_LABEL_REPAIR: Actor = {
  kind: 'system',
  component: 'declared-label-startup-repair',
};

/** Sensors per page. One page is one unlocked read and, if anything is renamed, one transaction. */
const DEFAULT_BATCH_SIZE = 500;

export interface DeclaredLabelRepairOptions {
  readonly db: Pick<Database, 'query' | 'tx'>;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
  /** `ingestionAuditSinks`, in `main.ts`: the record, the log and the cache invalidator. */
  readonly audit: AuditSink;
  readonly batchSize?: number;
  /** Checked between pages: shutdown waits for at most the page in flight. */
  readonly signal?: AbortSignal;
  /**
   * What a finished run records, and a later start compares (`P-333`): `declaredLabelRules` of
   * the running build. Absent or null, the pass runs and records nothing.
   */
  readonly rules?: string | null;
}

export interface DeclaredLabelRepairReport {
  /** False when this exact build already finished a run: nothing was read. */
  readonly ran: boolean;
  /** Sensors with a channel named by its key and no unit, read. */
  readonly sensors: number;
  /** Channels whose name or unit this pass wrote. */
  readonly relabelled: number;
  /** Sensors with a channel to rename that another transaction held; the next start tries them. */
  readonly skipped: number;
  /** Pages whose transaction failed; the pages after went on. */
  readonly failedPages: number;
  /**
   * Sensors left because their type could not answer for their stored parameters (`P-306`'s
   * fallback) or is not registered in this build (`P-312`).
   */
  readonly undeclared: number;
  /** The types of those, sorted. */
  readonly undeclaredTypes: readonly string[];
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

/** A channel named by its key with no unit, with what its `channel.redeclared` entry records. */
interface CandidateRow {
  readonly id: number;
  readonly sensor_id: string;
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly lookup_id: string | null;
  readonly counter_bits: number | null;
  readonly is_primary: boolean;
}

interface Relabel {
  readonly row: CandidateRow;
  readonly name: string;
  readonly unit: string;
}

export async function repairDeclaredLabels(
  options: DeclaredLabelRepairOptions,
): Promise<DeclaredLabelRepairReport> {
  const logger = options.logger.child({ component: 'declared-label-repair' });
  const pass: StartupPassRules = { name: DECLARED_LABEL_PASS, rules: options.rules ?? null };
  // **Never rejects**, the marker included: a marker that cannot be read is a pass to run.
  let due = true;
  try {
    due = await passIsDue(options.db, pass);
  } catch (error) {
    logger.warn(
      { ...describeError(error), phase: 'read-marker' },
      'could not read whether this build has named the channels created by their key; naming ' +
        'them again',
    );
  }
  if (!due) {
    logger.debug('this build has already named every channel created by its key; not read again');
    return {
      ran: false,
      sensors: 0,
      relabelled: 0,
      skipped: 0,
      failedPages: 0,
      undeclared: 0,
      undeclaredTypes: [],
      complete: true,
    };
  }
  // Without a logger: its warning speaks of a channel ingestion creates, and this creates none.
  // A type that cannot answer is counted here instead, and said in this pass's own line.
  const declared = declaredChannelLookup(options.catalogue);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const undeclaredTypes = new Set<string>();
  let sensors = 0;
  let relabelled = 0;
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
        `SELECT s.object_id::text AS id, s.type, s.params
         FROM sensor_config s
         WHERE s.object_id IN (
           SELECT c.sensor_id FROM channel c
           WHERE c.name = c.key AND c.unit = '' AND c.sensor_id > $1::bigint
           GROUP BY c.sensor_id ORDER BY c.sensor_id LIMIT $2)
         ORDER BY s.object_id`,
        [after, batchSize],
      );
    } catch (error) {
      // Nothing to go on to: the next page is not known. Stopped, said, and never rejected.
      logger.warn(
        { ...describeError(error), afterSensorId: after, phase: 'read-page' },
        'could not read the next page of sensors with channels named by their key; the rest ' +
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

    const answers = answersOf(page, declared, (type) => {
      undeclared += 1;
      undeclaredTypes.add(type);
    });
    // **A failure is the page's, not the pass's**, as in `P-323`'s: logged with its range and
    // counted, and the pages after it go on; the next start tries it again.
    try {
      // Unlocked, and empty for a page whose candidates are all right as they are: only the
      // sensors with a channel to rename are locked below.
      const stale = relabelsOf(await candidatesOf(options.db, [...answers.keys()]), answers);
      if (stale.length === 0) continue;
      const done = await options.db.tx((q) =>
        relabelLocked(
          q,
          [...new Set(stale.map((one) => one.row.sensor_id))],
          declared,
          options.audit,
        ),
      );
      relabelled += done.relabelled;
      skipped += done.skipped;
    } catch (error) {
      failedPages += 1;
      logger.warn(
        {
          ...describeError(error),
          firstSensorId: first.id,
          lastSensorId: last.id,
          phase: 'relabel-page',
        },
        'could not name the channels created by their key of one page of sensors; the pages ' +
          'after it go on, and the next start tries this one again',
      );
    }
  }

  const report: DeclaredLabelRepairReport = {
    ran: true,
    sensors,
    relabelled,
    skipped,
    failedPages,
    undeclared,
    undeclaredTypes: [...undeclaredTypes].sort(),
    complete,
  };
  if (relabelled > 0 || skipped > 0 || failedPages > 0 || undeclared > 0 || !complete) {
    logger.info(
      report,
      'wrote the name and unit their types declare onto channels ingestion had named by their ' +
        'key; sensors another transaction held, and sensors whose type could not answer for ' +
        'their stored parameters, were left as they are',
    );
  } else {
    logger.debug(report, 'every channel named by its key is named as its type declares');
  }
  // Recorded only when nothing is left for the next start to do.
  if (complete && failedPages === 0 && skipped === 0) {
    try {
      await recordPass(options.db, pass);
    } catch (error) {
      logger.warn(
        { ...describeError(error), phase: 'record-marker' },
        'could not record that this build named the channels created by their key; the next ' +
          'start reads them again',
      );
    }
  }
  return report;
}

/** The `startup_pass` row this pass keeps. */
export const DECLARED_LABEL_PASS = 'declared-label';

/** Bumped when what the pass does with a declaration changes; a new build reruns it anyway. */
const DECLARED_LABEL_RULES_VERSION = 1;

/**
 * What a run of the repair under this build records (`P-333`), or null for a build that is not
 * exactly one commit, as `declaredPrimaryRules` is: then every start runs it.
 */
export function declaredLabelRules(build: BuildStamp): string | null {
  if (!isExactBuild(build)) return null;
  return rulesDigest([DECLARED_LABEL_RULES_VERSION, build.commit, build.profile, build.lock]);
}

/** Each sensor's own answer, for those whose type answers for their stored parameters. */
function answersOf(
  rows: readonly SensorRow[],
  declared: Lookup,
  onUndeclared: (type: string) => void,
): Map<string, DeclaredShapes> {
  const answers = new Map<string, DeclaredShapes>();
  for (const row of rows) {
    const params =
      typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : {};
    const answer = declared(row.type, params, Number(row.id));
    // A fallback's names are a placeholder's, and an unregistered type has none (`ChannelShape`).
    if (answer.undeclared) onUndeclared(row.type);
    else answers.set(row.id, answer);
  }
  return answers;
}

/** The channels of these sensors named by their key with no unit. */
async function candidatesOf(
  q: Pick<Queryable, 'query'>,
  sensorIds: readonly string[],
): Promise<CandidateRow[]> {
  if (sensorIds.length === 0) return [];
  return q.query<CandidateRow>(
    `SELECT id, sensor_id::text AS sensor_id, key, name, unit, lookup_id, counter_bits, is_primary
     FROM channel
     WHERE name = key AND unit = '' AND sensor_id = ANY($1::bigint[])
     ORDER BY channel.sensor_id, channel.key`,
    [sensorIds],
  );
}

/** Of the candidates, those whose declaration names them otherwise, with what it names them. */
function relabelsOf(
  rows: readonly CandidateRow[],
  answers: ReadonlyMap<string, DeclaredShapes>,
): Relabel[] {
  const relabels: Relabel[] = [];
  for (const row of rows) {
    const shape = answers.get(row.sensor_id)?.shapes.get(row.key);
    if (shape === undefined) continue;
    // What ingestion creates today for a reading that sent nothing, which is what this row got.
    const label = channelLabel(row.key, shape, { name: undefined, unit: undefined });
    if (label.name === row.name && label.unit === row.unit) continue;
    relabels.push({ row, name: label.name, unit: label.unit });
  }
  return relabels;
}

/**
 * The renames for these sensors, under their locks: everything decided again from what is
 * committed once nobody else can change it, since the unlocked read only said that something
 * might be renamed. `SKIP LOCKED` for `P-323`'s reason: a held sensor is left for the next start.
 */
async function relabelLocked(
  q: Queryable,
  ids: readonly string[],
  declared: Lookup,
  audit: AuditSink,
): Promise<{ relabelled: number; skipped: number }> {
  // Object, then `sensor_config`, then `channel`: an edit's order, and ingestion's (`P-314`).
  const held = await q.query<{ id: string }>(
    `SELECT id::text AS id FROM object WHERE id = ANY($1::bigint[])
     ORDER BY object.id FOR NO KEY UPDATE SKIP LOCKED`,
    [ids],
  );
  const skipped = ids.length - held.length;
  if (held.length === 0) return { relabelled: 0, skipped };
  const fresh = await q.query<SensorRow>(
    `SELECT object_id::text AS id, type, params FROM sensor_config
     WHERE object_id = ANY($1::bigint[])`,
    [held.map((row) => row.id)],
  );
  // Counted on the unlocked read already; not twice.
  const answers = answersOf(fresh, declared, () => undefined);
  const relabels = relabelsOf(await candidatesOf(q, [...answers.keys()]), answers);
  if (relabels.length === 0) return { relabelled: 0, skipped };

  const mutations: Mutation[] = relabels.map(({ row, name, unit }) => {
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
  // A change a reader sees: the sensor's version moves, as for an edit's re-declaration.
  await q.query(
    `UPDATE channel AS c SET name = w.name, unit = w.unit
     FROM unnest($1::integer[], $2::text[], $3::text[]) AS w(id, name, unit)
     WHERE c.id = w.id`,
    [
      relabels.map((one) => one.row.id),
      relabels.map((one) => one.name),
      relabels.map((one) => one.unit),
    ],
  );
  await audit.record(q, DECLARED_LABEL_REPAIR, mutations, new Date());
  return { relabelled: relabels.length, skipped };
}
