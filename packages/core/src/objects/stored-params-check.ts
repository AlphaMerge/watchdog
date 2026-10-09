import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { SensorTypeGate, StoredParamProblem } from './sensor-type-gate.js';

/**
 * Naming the sensors whose stored parameters their type would now refuse (`P-358`).
 *
 * **Why it exists.** A type's `paramsSchema` is tightened in a later build — `P-348` reserved the
 * database types' own channel names as `extract` keys, `P-349` refused `runtime` as a script's
 * primary — and a sensor written before keeps running with what it has: nothing validates stored
 * parameters on a read, a clone, a start or at the probe. The operator found out only when an
 * edit that sends `params` was refused with a 400 naming the path. This pass says so at start:
 * one `warn` line per such sensor, and how many on Core Health (`sensorsWithInvalidParams`).
 *
 * **The API's validation, not a second one.** Each sensor goes through
 * `SensorTypeGate.storedParamProblems`, which is `normalise`'s structural bounds and the
 * catalogue's Ajv validator with the type's own `paramProblems` after it — what a create or an
 * edit of the same parameters meets — answered instead of thrown. So "invalid" here means exactly
 * "an edit sending these parameters back would be refused".
 *
 * **Never a value** (`P-305`). The line carries the sensor's id, its type, and for each problem
 * the JSON pointer, the schema keyword and the validator's sentence. Ajv's sentences are built
 * from the schema (`must match pattern "…"`, `must have required property 'x'`) and never from
 * the data; a type's own `paramProblems` sentence may quote what it read, so the gate cuts every
 * string the parameters hold out of it, a `writeOnly` one in each form it could be echoed in. No
 * parameter is ever a field of the line. A `writeOnly` path can be named; what is at it cannot.
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
 * **The count is as of this start.** It is published only once the pass has gone over every
 * sensor; until then, and for good if shutdown or a failed read stopped it, the channel gaps
 * rather than read a lower bound as the number. A sensor an operator mends afterwards is still
 * counted until the next start (a follow-up could take it off at the edit).
 */

/** Sensors per page: one plain indexed read of their type and parameters. */
const DEFAULT_BATCH_SIZE = 500;

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
  /** Sensors whose stored parameters their registered type's schema refuses. */
  readonly invalid: number;
  /** The types of those, sorted. */
  readonly invalidTypes: readonly string[];
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

export class StoredParamsCheck {
  readonly #db: Queryable;
  readonly #logger: Logger;
  readonly #sensorTypes: Pick<SensorTypeGate, 'storedParamProblems'>;
  readonly #batchSize: number;
  readonly #signal: AbortSignal | undefined;
  #invalid: number | null = null;

  constructor(options: StoredParamsCheckOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'stored-params-check' });
    this.#sensorTypes = options.sensorTypes;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#signal = options.signal;
  }

  /**
   * Core Health's `sensorsWithInvalidParams`: the count from the last pass that went over every
   * sensor, or null — a gap — before one has.
   */
  get invalid(): number | null {
    return this.#invalid;
  }

  async run(): Promise<StoredParamsReport> {
    const invalidTypes = new Set<string>();
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
        let problems: readonly StoredParamProblem[] | null;
        try {
          problems = this.#sensorTypes.storedParamProblems(row.type, paramsOf(row.params));
        } catch (error) {
          failedSensors += 1;
          // `describeError` of what a type threw could quote the parameters it was given; the
          // kind is enough to find it, and the sensor id says which.
          this.#logger.warn(
            {
              sensorId: Number(row.id),
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
        invalidTypes.add(row.type);
        this.#logger.warn(
          {
            sensorId: Number(row.id),
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
      invalidTypes: [...invalidTypes].sort(),
      unregistered,
      unregisteredTypes: [...unregisteredTypes].sort(),
      failedSensors,
      complete,
    };
    if (complete) this.#invalid = invalid;
    if (invalid > 0 || unregistered > 0 || failedSensors > 0 || !complete) {
      this.#logger.info(
        report,
        'checked every sensor’s stored parameters against its type’s current schema; those ' +
          'that fail are named above, and sensors of a type this build does not register were ' +
          'not judged',
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
