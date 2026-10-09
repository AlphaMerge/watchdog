import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Actor, AuditSink, Mutation } from './audit.js';
import type { SensorTypeGate, StoredParamProblem } from './sensor-type-gate.js';
import type { ObjectId } from './types.js';

/**
 * Naming the sensors whose stored parameters their type would now refuse (`P-358`).
 *
 * **Why it exists.** A type's `paramsSchema` is tightened in a later build — `P-348` reserved the
 * database types' own channel names as `extract` keys, `P-349` refused `runtime` as a script's
 * primary — and a sensor written before keeps running with what it has: nothing validates stored
 * parameters on a read, a clone, a start or at the probe. The operator found out only when an
 * edit that sends `params` was refused with a 400 naming the path. This pass says so at start —
 * a `warn` line per such sensor, up to `WARNINGS_PER_TYPE` of each type — and how many on Core
 * Health (`sensorsWithInvalidParams`), kept current by every write after it (`P-367`).
 *
 * **The API's validation, not a second one.** Each sensor goes through
 * `SensorTypeGate.storedParamProblems`, which is `normalise`'s structural bounds and the
 * catalogue's Ajv validator with the type's own `paramProblems` after it — what a create or an
 * edit of the same parameters meets — answered instead of thrown. So "invalid" here means exactly
 * "an edit sending these parameters back would be refused". The writes below are judged by the
 * same call.
 *
 * **Never a value** (`P-305`). The line carries the sensor's id, its type, and for each problem
 * the JSON pointer, the schema keyword and the validator's sentence. Ajv's sentences are built
 * from the schema (`must match pattern "…"`, `must have required property 'x'`) and never from
 * the data; a type's own `paramProblems` sentence may quote what it read, so the gate cuts every
 * string the parameters hold out of it, a `writeOnly` one in each form it could be echoed in. No
 * parameter is ever a field of the line. A `writeOnly` path can be named; what is at it cannot.
 *
 * **At most `WARNINGS_PER_TYPE` lines per type, the rest by count** (`P-368`). One line per
 * sensor was 2,000 lines every start at 20,000 sensors with one in ten refused. A type's failures
 * come from one tightening of its schema, so its lines repeat one or two paths: the first few
 * (lowest ids first, the pass's order) show what to mend, and the pass's own `info` line gives
 * every failing type's count (`invalidByType`) and how many of each were not named
 * (`notNamedByType`).
 *
 * **A type this build does not register is skipped, and counted only in this pass's own line**,
 * by type, not on Core Health. There is no schema here to judge it by, so calling it invalid
 * would be a claim this core cannot make; and it is not what the channel counts, which is the
 * sensors an edit would refuse. Where its probe lacks the type too, the sensor itself is Down,
 * its check failing in the `unknown-type` phase, on its own page; where the probe runs a newer
 * build that has it (ADR-001 Decision 13), it is a working sensor.
 *
 * **When, and what it costs** — as `P-323`'s declared-primary repair does, and for its reason.
 * Every start, no marker (`P-333` is the shared policy, still open): an installation's schemas
 * change only with its build, but a marker would need a table and the pass is cheap. Keyset pages
 * of `batchSize` sensors (`object_id > last ORDER BY object_id LIMIT n`, the primary key's
 * order), so at most one page of parameters is held at once, never the tree. Each page is one
 * plain read: **no lock is taken**, so unlike `P-323` it needs no `SKIP LOCKED` — it cannot wait
 * for a writer or make one wait — and it writes nothing at all. `main.ts` does not await it: it
 * runs once the core is up, and is checked against `signal` between pages, so shutdown waits for
 * at most the page in flight.
 *
 * **One sensor's failure is that sensor's.** A row whose check throws (a type's own
 * `paramProblems` that throws) is logged with its id and counted in `failedSensors`; the rest of
 * its page and the pages after go on. A page that cannot be read stops the pass, `complete:
 * false`, with a `warn` line. The pass never rejects.
 *
 * **The count is kept, not re-taken** (`P-367`). The pass leaves the set of failing sensor ids,
 * and this class is also an audit sink on the object service, so every committed write of a
 * sensor's parameters moves its id in or out of the set: an edit that mends it, a delete, a
 * clone of one that fails (a clone copies its source's parameters without the gate), a write
 * that clears its secrets (`A-41`). Each is judged by `storedParamProblems` on the parameters as
 * the write left them, read inside its transaction and applied once it commits; a rolled-back
 * write moves nothing. A create is not judged: it went through the gate, so it is valid.
 *
 * **A write during the pass is not lost and not counted twice.** The pass reads without a lock,
 * so a page can hold what a sensor was before an edit that commits while the page is in flight.
 * Every id a committed write has judged since this core started is the write's: the pass leaves
 * its membership alone (and does not name it), so a stale page cannot put back a sensor an edit
 * has mended or a delete removed. The set holds each id once, so a sensor the pass and a write
 * both find failing — a clone made while the pass runs — is one. The count is published only
 * once the pass has gone over every sensor; until then, and for good if shutdown or a failed
 * read stopped it, the channel gaps rather than read a lower bound as the number.
 */

/** Sensors per page: one plain indexed read of their type and parameters. */
const DEFAULT_BATCH_SIZE = 500;

/**
 * `warn` lines per type per pass (`P-368`). Ten: enough to show a type's one or two failing paths
 * on sensors an operator can open, and at most a few dozen lines on a start where several types
 * were tightened at once; the rest are counted by type in the pass's own line.
 */
export const WARNINGS_PER_TYPE = 10;

export interface StoredParamsCheckOptions {
  readonly db: Queryable;
  readonly logger: Logger;
  /** The gate the object service validates with, so the answer is the API's. */
  readonly sensorTypes: Pick<SensorTypeGate, 'storedParamProblems'>;
  readonly batchSize?: number;
  /** Checked between pages: shutdown waits for at most the page in flight. */
  readonly signal?: AbortSignal;
}

export interface StoredParamsReport {
  /** Sensors read. Every sensor in the installation, unless `complete` is false. */
  readonly sensors: number;
  /**
   * Sensors whose stored parameters their registered type's schema refuses, as this pass read
   * them. A sensor a write had already judged is the write's, and not among them.
   */
  readonly invalid: number;
  /** The types of those, sorted. */
  readonly invalidTypes: readonly string[];
  /** How many of those of each type. */
  readonly invalidByType: Readonly<Record<string, number>>;
  /** How many of each type were past `WARNINGS_PER_TYPE`, and so not named by a line of their own. */
  readonly notNamedByType: Readonly<Record<string, number>>;
  /** Sensors of a type this build does not register, not judged. */
  readonly unregistered: number;
  /** The types of those, sorted. */
  readonly unregisteredTypes: readonly string[];
  /** Sensors whose check threw: logged each, and neither counted valid nor invalid. */
  readonly failedSensors: number;
  /** False when shutdown or a failed read stopped it between pages. */
  readonly complete: boolean;
}

interface SensorRow {
  readonly id: string;
  readonly type: string;
  readonly params: unknown;
}

export class StoredParamsCheck implements AuditSink {
  readonly #db: Queryable;
  readonly #logger: Logger;
  readonly #sensorTypes: Pick<SensorTypeGate, 'storedParamProblems'>;
  readonly #batchSize: number;
  readonly #signal: AbortSignal | undefined;
  /** The sensors whose stored parameters fail, as the pass or a later write last judged them. */
  readonly #failing = new Set<ObjectId>();
  /**
   * The sensors a committed write has judged while the pass had not finished: theirs, not the
   * pass's, whose page may be older. Dropped once the pass has ended.
   */
  #written: Set<ObjectId> | null = new Set<ObjectId>();
  #complete = false;

  constructor(options: StoredParamsCheckOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'stored-params-check' });
    this.#sensorTypes = options.sensorTypes;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#signal = options.signal;
  }

  /**
   * Core Health's `sensorsWithInvalidParams`: the sensors whose stored parameters fail, once a
   * pass has gone over every sensor, kept current by every write since; null — a gap — before.
   */
  get invalid(): number | null {
    return this.#complete ? this.#failing.size : null;
  }

  /**
   * The object service's audit sink (`P-367`): each sensor a write left with new parameters is
   * judged as the pass judges it, and a deleted one forgotten, once the write commits.
   *
   * Judged on the parameters as stored, read here inside the write's transaction, because the
   * entries this is handed are redacted: a `writeOnly` value is absent from them and present in
   * what the sensor runs with. A rename (no `changedParams`), a move, a pause or a setting is not
   * a change of parameters and reads nothing.
   */
  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    _at: Date,
  ): Promise<void> {
    const edited = new Set<ObjectId>();
    const cloned: ObjectId[] = [];
    const deleted: ObjectId[] = [];
    for (const mutation of mutations) {
      switch (mutation.action) {
        case 'object.updated':
          if (mutation.kind === 'sensor' && mutation.changedParams.length > 0) {
            edited.add(mutation.objectId);
          }
          break;
        case 'object.cloned':
          cloned.push(mutation.objectId);
          break;
        case 'object.deleted':
          for (const destroyed of mutation.destroyed) {
            if (destroyed.kind === 'sensor') deleted.push(destroyed.id);
          }
          break;
        default:
          break;
      }
    }

    const rows: SensorRow[] = [];
    if (edited.size > 0) {
      rows.push(
        ...(await q.query<SensorRow>(
          `SELECT object_id::text AS id, type, params FROM sensor_config
           WHERE object_id = ANY($1::bigint[])`,
          [[...edited]],
        )),
      );
    }
    if (cloned.length > 0) {
      rows.push(
        ...(await q.query<SensorRow>(
          `WITH RECURSIVE subtree AS (
             SELECT id, 0 AS depth FROM object WHERE id = ANY($1::bigint[])
             UNION ALL
             SELECT c.id, subtree.depth + 1
             FROM object c JOIN subtree ON c.parent_id = subtree.id
             WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
           )
           SELECT sc.object_id::text AS id, sc.type, sc.params
           FROM (SELECT DISTINCT id FROM subtree) walked
           JOIN sensor_config sc ON sc.object_id = walked.id`,
          [cloned],
        )),
      );
    }

    const verdicts = new Map<ObjectId, boolean>();
    for (const row of rows) {
      const failing = this.#judged(row);
      if (failing !== undefined) verdicts.set(Number(row.id), failing);
    }
    for (const id of deleted) verdicts.set(id, false);
    if (verdicts.size === 0) return;

    const apply = (): void => {
      for (const [id, failing] of verdicts) {
        if (failing) this.#failing.add(id);
        else this.#failing.delete(id);
        this.#written?.add(id);
      }
    };
    // Not before it commits: a write that rolls back moved nothing.
    if (q.afterCommit === undefined) apply();
    else q.afterCommit(apply);
  }

  /**
   * Whether one written sensor's parameters fail; undefined when its type's check threw, which
   * leaves it as it was. A type this build does not register is not counted, as in the pass.
   */
  #judged(row: SensorRow): boolean | undefined {
    try {
      const problems = this.#sensorTypes.storedParamProblems(row.type, paramsOf(row.params));
      return problems !== null && problems.length > 0;
    } catch (error) {
      this.#logger.warn(
        {
          sensorId: Number(row.id),
          sensorType: row.type,
          errorKind: error instanceof Error ? error.name : typeof error,
          phase: 'validate-written-params',
        },
        'could not check a written sensor’s parameters against its type; its count is left as ' +
          'it was',
      );
      return undefined;
    }
  }

  async run(): Promise<StoredParamsReport> {
    const invalidByType = new Map<string, number>();
    const notNamedByType = new Map<string, number>();
    const unregisteredTypes = new Set<string>();
    let sensors = 0;
    let invalid = 0;
    let unregistered = 0;
    let failedSensors = 0;
    let complete = true;
    let after = '0';

    for (;;) {
      if (this.#signal?.aborted === true) {
        complete = false;
        break;
      }
      let page: SensorRow[];
      try {
        page = await this.#db.query<SensorRow>(
          `SELECT object_id::text AS id, type, params FROM sensor_config
           WHERE object_id > $1::bigint ORDER BY object_id LIMIT $2`,
          [after, this.#batchSize],
        );
      } catch (error) {
        this.#logger.warn(
          { ...describeError(error), afterSensorId: after, phase: 'read-page' },
          'could not read the next page of sensors to check their stored parameters; the rest ' +
            'waits for the next start',
        );
        complete = false;
        break;
      }
      const last = page.at(-1);
      if (last === undefined) break;
      after = last.id;
      sensors += page.length;

      for (const row of page) {
        const id = Number(row.id);
        // A write committed since this page may have been read: what it judged stands.
        if (this.#written?.has(id) === true) continue;
        let problems: readonly StoredParamProblem[] | null;
        try {
          problems = this.#sensorTypes.storedParamProblems(row.type, paramsOf(row.params));
        } catch (error) {
          failedSensors += 1;
          // `describeError` of what a type threw could quote the parameters it was given; the
          // kind is enough to find it, and the sensor id says which.
          this.#logger.warn(
            {
              sensorId: id,
              sensorType: row.type,
              errorKind: error instanceof Error ? error.name : typeof error,
              phase: 'validate-stored-params',
            },
            'could not check a sensor’s stored parameters against its type; the other sensors ' +
              'go on',
          );
          continue;
        }
        if (problems === null) {
          unregistered += 1;
          unregisteredTypes.add(row.type);
          continue;
        }
        if (problems.length === 0) continue;
        invalid += 1;
        this.#failing.add(id);
        const ofType = (invalidByType.get(row.type) ?? 0) + 1;
        invalidByType.set(row.type, ofType);
        if (ofType > WARNINGS_PER_TYPE) {
          notNamedByType.set(row.type, (notNamedByType.get(row.type) ?? 0) + 1);
          continue;
        }
        this.#logger.warn(
          {
            sensorId: id,
            sensorType: row.type,
            problems: problems.map((problem) => ({
              path: problem.path === '' ? '(root)' : problem.path,
              keyword: problem.keyword,
              message: problem.message,
            })),
            phase: 'validate-stored-params',
          },
          'a sensor’s stored parameters fail its type’s current schema: it keeps running as ' +
            'stored, and an edit that sends params is refused until the paths named are mended',
        );
      }
      // A short page is the last: no need to ask for the empty one after it.
      if (page.length < this.#batchSize) break;
    }

    const report: StoredParamsReport = {
      sensors,
      invalid,
      invalidTypes: [...invalidByType.keys()].sort(),
      invalidByType: sortedRecord(invalidByType),
      notNamedByType: sortedRecord(notNamedByType),
      unregistered,
      unregisteredTypes: [...unregisteredTypes].sort(),
      failedSensors,
      complete,
    };
    if (complete) this.#complete = true;
    // Ended either way: a later write's verdict is simply the set's from here on.
    this.#written = null;
    if (invalid > 0 || unregistered > 0 || failedSensors > 0 || !complete) {
      this.#logger.info(
        report,
        notNamedByType.size > 0
          ? `checked every sensor’s stored parameters against its type’s current schema; the ` +
              `first ${String(WARNINGS_PER_TYPE)} of each type that fail are named above, and ` +
              'notNamedByType counts the rest; sensors of a type this build does not register ' +
              'were not judged'
          : 'checked every sensor’s stored parameters against its type’s current schema; those ' +
              'that fail are named above, and sensors of a type this build does not register ' +
              'were not judged',
      );
    } else {
      this.#logger.debug(report, 'every sensor’s stored parameters pass its type’s schema');
    }
    return report;
  }
}

/** A row's parameters as the repository reads them: a missing value is `{}`. */
function paramsOf(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function sortedRecord(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
