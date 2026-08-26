/**
 * `sensor_runtime` and `sensor_state`, as rows (`M-02`).
 *
 * The machine in `machine.ts` is pure; this is everything that reads or writes on its behalf.
 * The two writes are exported as functions over a `Queryable` rather than as a repository class
 * so the `Ingestor` can run them inside the transaction that writes the readings — which is not
 * a tidiness point: a state change committed without its readings, or readings committed
 * without the state change they caused, is a history that disagrees with itself.
 */

import type { Queryable } from '../db/pool.js';
import type { SensorFacts } from './machine.js';
import type { SensorState, SensorStateCause } from './tables.js';

/** One sensor's persisted working set. */
export interface SensorRuntime {
  readonly sensorId: number;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  readonly since: Date;
  /**
   * Who acknowledged the alarm (`M-13`), when anybody has.
   *
   * Absent on the batch read, which selects only what the machine needs — this is for the one
   * sensor a person is looking at.
   */
  readonly acknowledgedBy?: { readonly kind: string; readonly label: string | null } | null;
  /**
   * The machine's inputs. `probeReachable` is **not** persisted — it is a live fact about a
   * connection, and a value read from a table would be a claim about the past.
   */
  readonly facts: SensorFacts;
}

/**
 * One transition, for the history hypertable.
 *
 * Written when the state **or the cause** moved: a sensor that goes from Down (scan) to Down
 * (limit) has not changed state, but it has changed what an operator should look at, and
 * `docs/state-machine.md` §5 invariant 10 requires the transition either way.
 */
export interface StateTransition {
  readonly sensorId: number;
  readonly at: Date;
  readonly state: SensorState;
  /**
   * What it changed from, or `null` if there was nothing before it. Stored rather than derived
   * from the preceding row, because retention eventually drops that row and "what did it change
   * from" has to survive it.
   */
  readonly previousState: SensorState | null;
  readonly cause: SensorStateCause;
  readonly message: string;
}

/** Where one sensor ended up. Exactly one per sensor per batch, or the UPDATE is ambiguous. */
export interface RuntimeWrite {
  readonly sensorId: number;
  readonly at: Date;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  readonly since: Date;
  readonly consecutiveFailures: number;
  /**
   * Whether the acknowledgement survived this result (`M-13`).
   *
   * The machine clears one on recovery and on expiry (§2.4), and until `M-13` that clearing
   * lived only in the cached facts — so the columns stayed set, and a cache eviction or a
   * restart brought a silenced alarm back silenced. A result never *sets* an acknowledgement, so
   * `false` here means clear the columns and `true` means leave them exactly as they are.
   */
  readonly acknowledged: boolean;
}

/** What one batch of results decided. Both halves are written in the readings' transaction. */
export interface StateDecisions {
  readonly transitions: readonly StateTransition[];
  readonly runtimes: readonly RuntimeWrite[];
}

interface RuntimeRow {
  object_id: string;
  state: SensorState;
  cause: SensorStateCause;
  message: string;
  since: Date;
  consecutive_failures: number;
  last_result_at: Date | null;
  paused_by_parent: boolean;
  paused_by_dependency: boolean;
  paused_by_schedule: boolean;
  paused_manually: boolean;
  acknowledged_at: Date | null;
  acknowledged_until: Date | null;
  /** Only the single-sensor read selects these; the hot path does not need them (`M-13`). */
  acknowledged_by_kind?: string | null;
  acknowledged_by_label?: string | null;
  simulated_error: boolean;
}

const RUNTIME_COLUMNS = `
  object_id::text AS object_id, state, cause, message, since,
  consecutive_failures, last_result_at,
  paused_by_parent, paused_by_dependency, paused_by_schedule, paused_manually,
  acknowledged_at, acknowledged_until, simulated_error
`;

function toRuntime(row: RuntimeRow): SensorRuntime {
  return {
    sensorId: Number(row.object_id),
    state: row.state,
    cause: row.cause,
    message: row.message,
    since: row.since,
    acknowledgedBy:
      row.acknowledged_by_kind == null
        ? null
        : { kind: row.acknowledged_by_kind, label: row.acknowledged_by_label ?? null },
    facts: {
      pause: {
        parent: row.paused_by_parent,
        dependency: row.paused_by_dependency,
        schedule: row.paused_by_schedule,
        manual: row.paused_manually,
      },
      simulatedError: row.simulated_error,
      // Restored optimistically. R-05 is what will say otherwise, from the connection it can
      // see; a core that has just started has not yet learned that a probe is missing, and
      // recording thousands of "probe unreachable" transitions on every restart would be an
      // alarm storm generated by the restart itself.
      probeReachable: true,
      acknowledged: row.acknowledged_at !== null,
      // `consecutive_failures` and `last_result_at` reconstruct the scan facts exactly: a row
      // with a result and no failures ended on a success, and one with failures did not.
      scan:
        row.last_result_at === null
          ? { kind: 'none' }
          : row.consecutive_failures === 0
            ? { kind: 'ok' }
            : { kind: 'failed', consecutiveFailures: row.consecutive_failures },
      // Not persisted: the next result brings its own readings, and a limit breach remembered
      // across a restart would be a verdict on a measurement nobody took.
      channel: null,
      lastResultAt: row.last_result_at,
      acknowledgedUntil: row.acknowledged_until,
    },
  };
}

/**
 * Reads the runtime for a set of sensors.
 *
 * A sensor with no row does not exist: migration 008 gives every sensor one at creation, by
 * trigger on `sensor_config`. So an absence here is a deleted sensor, which the caller counts
 * rather than invents a state for.
 */
export async function loadRuntimes(
  q: Queryable,
  sensorIds: readonly number[],
): Promise<Map<number, SensorRuntime>> {
  if (sensorIds.length === 0) return new Map();
  const rows = await q.query<RuntimeRow>(
    `SELECT ${RUNTIME_COLUMNS} FROM sensor_runtime WHERE object_id = ANY($1::bigint[])`,
    [[...sensorIds]],
  );
  return new Map(rows.map((row) => [Number(row.object_id), toRuntime(row)]));
}

/**
 * Appends the transitions to the history hypertable.
 *
 * `ON CONFLICT DO NOTHING` against the unique index on `(sensor_id, time)`, so a probe that
 * resends after a lost acknowledgement replays into the same rows rather than duplicating the
 * timeline — the same idempotence the readings have, and for the same reason.
 */
export async function writeStateHistory(
  q: Queryable,
  changes: readonly StateTransition[],
): Promise<number> {
  if (changes.length === 0) return 0;
  const rows = await q.query<{ sensor_id: string }>(
    `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
     SELECT * FROM unnest(
       $1::timestamptz[], $2::bigint[], $3::sensor_state_kind[],
       $4::sensor_state_kind[], $5::sensor_state_cause[], $6::text[]
     )
     ON CONFLICT (sensor_id, time) DO NOTHING
     RETURNING sensor_id::text AS sensor_id`,
    [
      changes.map((write) => write.at),
      changes.map((write) => write.sensorId),
      changes.map((write) => write.state),
      changes.map((write) => write.previousState),
      changes.map((write) => write.cause),
      changes.map((write) => write.message),
    ],
  );
  return rows.length;
}

/**
 * Moves each sensor's current row forward.
 *
 * The `last_result_at` predicate is the idempotence guard: a duplicated or out-of-order result
 * cannot move the row backwards, and cannot count the same failure twice. It matters because
 * the acknowledgement protocol is at-least-once by design — a probe that misses an
 * acknowledgement offers the batch again, and applying it twice would advance a two-step
 * failure to Down on the strength of one outage.
 *
 * Returns how many rows moved. Fewer than were offered means a sensor was deleted, or a result
 * was stale; the caller counts the difference rather than assuming.
 */
export async function writeRuntimes(
  q: Queryable,
  writes: readonly RuntimeWrite[],
): Promise<number> {
  if (writes.length === 0) return 0;
  const rows = await q.query<{ object_id: string }>(
    `UPDATE sensor_runtime r
     SET state = w.state,
         cause = w.cause,
         message = w.message,
         since = w.since,
         consecutive_failures = w.consecutive_failures,
         last_result_at = w.at,
         -- Only ever cleared here. §2.4 clears an acknowledgement on a recovery a reading
         -- decided and on expiry, and both of those arrive as a result; nothing about a result
         -- can create one.
         acknowledged_at = CASE WHEN w.acknowledged THEN r.acknowledged_at END,
         acknowledged_until = CASE WHEN w.acknowledged THEN r.acknowledged_until END,
         acknowledged_by_kind = CASE WHEN w.acknowledged THEN r.acknowledged_by_kind END,
         acknowledged_by_label = CASE WHEN w.acknowledged THEN r.acknowledged_by_label END
     FROM unnest(
       $1::bigint[], $2::timestamptz[], $3::sensor_state_kind[], $4::sensor_state_cause[],
       $5::text[], $6::timestamptz[], $7::int[], $8::boolean[]
     ) AS w(sensor_id, at, state, cause, message, since, consecutive_failures, acknowledged)
     WHERE r.object_id = w.sensor_id
       AND (r.last_result_at IS NULL OR w.at > r.last_result_at)
     RETURNING r.object_id::text AS object_id`,
    [
      writes.map((write) => write.sensorId),
      writes.map((write) => write.at),
      writes.map((write) => write.state),
      writes.map((write) => write.cause),
      writes.map((write) => write.message),
      writes.map((write) => write.since),
      writes.map((write) => write.consecutiveFailures),
      writes.map((write) => write.acknowledged),
    ],
  );
  return rows.length;
}

/**
 * One sensor's current state, for the read side.
 *
 * Joined from `object` rather than read from `sensor_runtime` alone, so one query distinguishes
 * the three answers a caller needs: no such object, not a sensor, and a sensor that has not
 * reported yet. The last of those is Unknown, not a 404 — the row is created by the first batch
 * of results, and a sensor waiting for its first scan is in a perfectly ordinary state.
 *
 * The defaults are applied in SQL so the shape is the same either way. `since` falls back to
 * when the sensor was created, which is when it genuinely became Unknown.
 */
export async function readSensorState(
  q: Queryable,
  sensorId: number,
): Promise<SensorRuntime | null> {
  const rows = await q.query<RuntimeRow>(
    `SELECT o.id::text AS object_id,
            coalesce(r.state, 'unknown') AS state,
            coalesce(r.cause, 'scan') AS cause,
            coalesce(r.message, '') AS message,
            coalesce(r.since, o.created_at) AS since,
            coalesce(r.consecutive_failures, 0) AS consecutive_failures,
            r.last_result_at,
            coalesce(r.paused_by_parent, false) AS paused_by_parent,
            coalesce(r.paused_by_dependency, false) AS paused_by_dependency,
            coalesce(r.paused_by_schedule, false) AS paused_by_schedule,
            coalesce(r.paused_manually, false) AS paused_manually,
            r.acknowledged_at,
            r.acknowledged_until,
            r.acknowledged_by_kind,
            r.acknowledged_by_label,
            coalesce(r.simulated_error, false) AS simulated_error
     FROM object o
     LEFT JOIN sensor_runtime r ON r.object_id = o.id
     WHERE o.id = $1 AND o.kind = 'sensor'`,
    [sensorId],
  );
  const row = rows[0];
  return row === undefined ? null : toRuntime(row);
}

/**
 * The sensors beneath an object that are currently Down (`M-13`).
 *
 * What "acknowledge this device" acts on. A **snapshot, not a rule**: it covers what is Down at
 * the moment somebody clicks, and a sensor that fails an hour later is a new alarm nobody has
 * looked at yet. Anything else would be an acknowledgement that silences outages that had not
 * happened when it was written.
 *
 * `down_acknowledged` is included so that extending or re-wording an existing acknowledgement
 * over a whole device is the same call as making one.
 */
export async function downSensorsIn(q: Queryable, rootId: number): Promise<number[]> {
  const rows = await q.query<{ object_id: string }>(
    `
    WITH RECURSIVE subtree AS (
      SELECT o.id, 0 AS depth FROM object o WHERE o.id = $1
      UNION ALL
      SELECT c.id, subtree.depth + 1
      FROM object c JOIN subtree ON c.parent_id = subtree.id
      WHERE subtree.depth < 1000
    )
    SELECT r.object_id::text AS object_id
    FROM subtree
    JOIN sensor_runtime r ON r.object_id = subtree.id
    WHERE r.state IN ('down', 'down_acknowledged')
    ORDER BY r.object_id
    `,
    [rootId],
  );
  return rows.map((row) => Number(row.object_id));
}

/**
 * Every sensor beneath an object.
 *
 * Unlike `downSensorsIn`, this filters on nothing: a simulated error (`M-14`) is applied to what
 * an operator selected, whatever state it happens to be in, because forcing a Down is not a
 * statement about the current one.
 */
export async function sensorsIn(q: Queryable, rootId: number): Promise<number[]> {
  const rows = await q.query<{ object_id: string }>(
    `
    WITH RECURSIVE subtree AS (
      SELECT o.id, o.kind, 0 AS depth FROM object o WHERE o.id = $1
      UNION ALL
      SELECT c.id, c.kind, subtree.depth + 1
      FROM object c JOIN subtree ON c.parent_id = subtree.id
      WHERE subtree.depth < 1000
    )
    SELECT id::text AS object_id FROM subtree WHERE kind = 'sensor' ORDER BY id
    `,
    [rootId],
  );
  return rows.map((row) => Number(row.object_id));
}

/**
 * Sets or clears the simulated-error flag (`M-14`).
 *
 * Its own statement rather than a field on `writeStateChanges`, for the reason acknowledgements
 * have one: §2 reads the column to decide the state, so the fact has to be in the row before
 * the machine is asked what it means.
 */
export async function writeSimulatedErrors(
  q: Queryable,
  sensorIds: readonly number[],
  simulated: boolean,
): Promise<number> {
  if (sensorIds.length === 0) return 0;
  const rows = await q.query<{ object_id: string }>(
    `UPDATE sensor_runtime SET simulated_error = $2
     WHERE object_id = ANY($1::bigint[]) AND simulated_error IS DISTINCT FROM $2
     RETURNING object_id::text AS object_id`,
    [sensorIds, simulated],
  );
  return rows.length;
}

/** An acknowledgement to write, or `null` to clear one (`M-13`). */
export interface AcknowledgementWrite {
  readonly sensorId: number;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedUntil: Date | null;
  readonly actorKind: string | null;
  readonly actorLabel: string | null;
}

/**
 * Writes or clears acknowledgements.
 *
 * Separate from `writeStateChanges` because the two are written in one transaction but decided
 * in the wrong order to combine: the columns have to be there before the machine is asked what
 * they mean, since it is `acknowledged_at` that turns a computed `down` into `down_acknowledged`
 * (§2.4). So this writes the fact, and the re-evaluation that follows writes the state.
 */
export async function writeAcknowledgements(
  q: Queryable,
  writes: readonly AcknowledgementWrite[],
): Promise<number> {
  if (writes.length === 0) return 0;
  const rows = await q.query<{ object_id: string }>(
    `UPDATE sensor_runtime r
     SET acknowledged_at = w.acknowledged_at,
         acknowledged_until = w.acknowledged_until,
         acknowledged_by_kind = w.actor_kind,
         acknowledged_by_label = w.actor_label
     FROM unnest(
       $1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[]
     ) AS w(sensor_id, acknowledged_at, acknowledged_until, actor_kind, actor_label)
     WHERE r.object_id = w.sensor_id
     RETURNING r.object_id::text AS object_id`,
    [
      writes.map((write) => write.sensorId),
      writes.map((write) => write.acknowledgedAt),
      writes.map((write) => write.acknowledgedUntil),
      writes.map((write) => write.actorKind),
      writes.map((write) => write.actorLabel),
    ],
  );
  return rows.length;
}

/**
 * One sensor's state, changed by something that was not a result (`M-08`).
 *
 * A pause, a resume, an acknowledgement, a probe going away: none of them carry a reading, so
 * none of them may touch `last_result_at` or the failure count. `reset` is the exception, and it
 * is what §3's "resume yields Unknown" is made of — when the last pause source clears, the
 * sensor forgets what it measured before the pause, because reporting a state the system has not
 * checked since would be reporting something it does not know.
 */
export interface StateRewrite {
  readonly sensorId: number;
  readonly at: Date;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  readonly since: Date;
  readonly reset: boolean;
}

/**
 * Moves each sensor's current row without pretending a scan happened.
 *
 * No `last_result_at` guard, unlike `writeRuntimes`: there is no result to be stale against, and
 * the caller has just read these rows in this transaction.
 */
export async function writeStateChanges(
  q: Queryable,
  rewrites: readonly StateRewrite[],
): Promise<number> {
  if (rewrites.length === 0) return 0;
  const rows = await q.query<{ object_id: string }>(
    `UPDATE sensor_runtime r
     SET state = w.state,
         cause = w.cause,
         message = w.message,
         since = w.since,
         last_result_at = CASE WHEN w.reset THEN NULL ELSE r.last_result_at END,
         consecutive_failures = CASE WHEN w.reset THEN 0 ELSE r.consecutive_failures END,
         -- Resuming clears any acknowledgement (WORKFLOW.MD §4 rule 5): it was a statement
         -- about an outage nobody is watching any more.
         acknowledged_at = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_at END,
         acknowledged_until = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_until END,
         acknowledged_by_kind = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_by_kind END,
         acknowledged_by_label = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_by_label END
     FROM unnest(
       $1::bigint[], $2::sensor_state_kind[], $3::sensor_state_cause[], $4::text[],
       $5::timestamptz[], $6::boolean[]
     ) AS w(sensor_id, state, cause, message, since, reset)
     WHERE r.object_id = w.sensor_id
     RETURNING r.object_id::text AS object_id`,
    [
      rewrites.map((write) => write.sensorId),
      rewrites.map((write) => write.state),
      rewrites.map((write) => write.cause),
      rewrites.map((write) => write.message),
      rewrites.map((write) => write.since),
      rewrites.map((write) => write.reset),
    ],
  );
  return rows.length;
}
