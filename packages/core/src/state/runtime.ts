/**
 * `sensor_runtime` and `sensor_state`, as rows (`M-02`).
 *
 * The machine in `machine.ts` is pure; this is everything that reads or writes on its behalf.
 * The two writes are exported as functions over a `Queryable` rather than as a repository class
 * so the `Ingestor` can run them inside the transaction that writes the readings — which is not
 * a tidiness point: a state change committed without its readings, or readings committed
 * without the state change they caused, is a history that disagrees with itself.
 */

import type { CheckFailure } from '@ms/shared';
import type { Visibility } from '../auth/access.js';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { ChannelVerdict, SensorFacts } from './machine.js';
import type { ActorKind } from '../objects/audit.js';
import type { SensorState, SensorStateCause } from './tables.js';

/** One sensor's persisted working set. */
export interface SensorRuntime {
  readonly sensorId: number;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  /**
   * Where the check whose words `message` holds failed (`P-285`), or `null`. Beside the message
   * and by its rule: what explains the state, never what decides it.
   */
  readonly failure: CheckFailure | null;
  readonly since: Date;
  /**
   * Who acknowledged the alarm (`M-13`), when anybody has.
   *
   * Absent on the batch read, which selects only what the machine needs — this is for the one
   * sensor a person is looking at.
   */
  readonly acknowledgedBy?: { readonly kind: ActorKind; readonly label: string | null } | null;
  /**
   * The machine's inputs. `probeReachable` and `vouchedFor` are **not** persisted — each is a
   * live fact, about a connection or about grants, and a value read from a table would be a
   * claim about the past.
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
  /**
   * Where the check behind it failed (`P-285`), when its words are a check's: a result's that
   * the scan decided, or a held result's that a hold is explained by (`P-407`). Absent on every
   * other path — a pause, an acknowledgement, a release, a hold in the core's own words — and
   * absent is stored as NULL.
   */
  readonly failure?: CheckFailure | null;
}

/** Where one sensor ended up. Exactly one per sensor per batch, or the UPDATE is ambiguous. */
export interface RuntimeWrite {
  readonly sensorId: number;
  readonly at: Date;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  /** Where the check `message` speaks for failed (`P-285`); held by a pause with the message. */
  readonly failure: CheckFailure | null;
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
  /**
   * §2.2's answer for the readings this write is about (`P-85`).
   *
   * Null on a failed check, and that is the machine's own rule rather than a shortcut: no-data
   * is not zero, a failed scan produced no readings to judge, and carrying the last breach
   * forward would keep it alive across an outage and blame a threshold for it.
   */
  readonly channel: ChannelVerdict | null;
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
  /** Both or neither of a failure; a target never without its phase (migration 081). */
  failure_phase: string | null;
  failure_target: string | null;
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
  acknowledged_by_kind?: ActorKind | null;
  acknowledged_by_label?: string | null;
  simulated_error: boolean;
  /** §2.2's answer, or null when nothing was judged. Both columns move together (`P-85`). */
  channel_state: SensorState | null;
  channel_cause: SensorStateCause | null;
  /** When this sensor last came back from a pause (`P-97`). */
  resumed_at: Date | null;
}

const RUNTIME_COLUMNS = `
  object_id::text AS object_id, state, cause, message, failure_phase, failure_target, since,
  consecutive_failures, last_result_at,
  paused_by_parent, paused_by_dependency, paused_by_schedule, paused_manually,
  acknowledged_at, acknowledged_until, simulated_error,
  channel_state, channel_cause, resumed_at
`;

/**
 * The stored verdict, or null.
 *
 * A `ChannelVerdict` cannot be `unknown` — §2.2 ranks against Up and an unranked state would
 * outvote a genuine one — but the column is the full `sensor_state_kind`, because narrowing the
 * enum for one column is not worth a second type. A row that somehow holds one is read as
 * nothing judged rather than trusted into a state the machine does not model.
 */
/**
 * Whether nothing has been measured since this sensor last started scanning (`P-97`).
 *
 * Either it has never reported, or it has been resumed since it last did. A resume at exactly
 * the instant of the last result counts as after it: §3 says the sensor awaits its next scan
 * rather than returning to a state nothing has checked since, and a reading taken in the same
 * millisecond as the resume was taken before it in every sense that matters.
 */
function neverScanned(row: RuntimeRow): boolean {
  if (row.last_result_at === null) return true;
  return row.resumed_at !== null && row.resumed_at.getTime() >= row.last_result_at.getTime();
}

function channelVerdict(row: RuntimeRow): ChannelVerdict | null {
  const { channel_state: state, channel_cause: cause } = row;
  if (state === null || cause === null) return null;
  return state === 'up' || state === 'warning' || state === 'down' ? { state, cause } : null;
}

/**
 * A hold's words and where the check they come from stopped (`P-407`): a probe's refusal
 * (`A-41c`) or a check it could not start (`P-265`) names a phase, and a sentence the core wrote
 * names none. One value, so the words and the failure always come from the same owner.
 */
export interface HeldWords {
  readonly message: string;
  readonly failure: CheckFailure | null;
}

/**
 * A hold the state service reads live, sensor by sensor: what holds it and the words to say
 * (`P-410`). A `ReadonlyMap` is one, and so is a view that reads its words where they are kept.
 */
export type HeldWordsLookup = Pick<ReadonlyMap<number, HeldWords>, 'has' | 'get' | 'size'>;

/**
 * A hold whose every sensor says the same words (`P-413`): a lost link, a silence, a frozen clock
 * and a factory's unreached inputs. A view over the hold's live set, read as it is when asked, so
 * a set the hold replaces is followed.
 */
export function heldIn(sensors: () => ReadonlySet<number>, words: HeldWords): HeldWordsLookup {
  return {
    get size(): number {
      return sensors().size;
    },
    has: (sensorId) => sensors().has(sensorId),
    get: (sensorId) => (sensors().has(sensorId) ? words : undefined),
  };
}

/** Whether two holds say the same words and name the same place it stopped, or are both none. */
export function sameHeldWords(a: HeldWords | undefined, b: HeldWords | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.message === b.message && sameFailure(a.failure, b.failure);
}

/** Whether two failures name the same phase and the same host, or are both none. */
export function sameFailure(a: CheckFailure | null, b: CheckFailure | null): boolean {
  if (a === null || b === null) return a === b;
  return a.phase === b.phase && (a.target ?? null) === (b.target ?? null);
}

/** A row's failure, or null when it names no phase (`P-285`). */
export function failureOf(row: {
  readonly failure_phase: string | null;
  readonly failure_target: string | null;
}): CheckFailure | null {
  if (row.failure_phase === null) return null;
  return row.failure_target === null
    ? { phase: row.failure_phase }
    : { phase: row.failure_phase, target: row.failure_target };
}

function toRuntime(row: RuntimeRow): SensorRuntime {
  return {
    sensorId: Number(row.object_id),
    state: row.state,
    cause: row.cause,
    message: row.message,
    failure: failureOf(row),
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
      // Restored the same way, for the same reason: the core's evaluators re-check every voucher
      // on their next sweep and say otherwise then (`A-29`).
      vouchedFor: true,
      acknowledged: row.acknowledged_at !== null,
      // `consecutive_failures`, `last_result_at` and `resumed_at` reconstruct the scan facts
      // exactly: a row with a result and no failures ended on a success, one with failures did
      // not, and one resumed since its last result has nothing to report yet.
      //
      // `resumed_at` carries that last case because `last_result_at` used to, by being nulled —
      // which also erased the idempotence guard the at-least-once protocol depends on (`P-97`).
      scan: neverScanned(row)
        ? { kind: 'none' }
        : row.consecutive_failures === 0
          ? { kind: 'ok' }
          : { kind: 'failed', consecutiveFailures: row.consecutive_failures },
      // Persisted, because it is state (`P-85`). It was left out on the reasoning that a
      // remembered breach would be "a verdict on a measurement nobody took" — but the row also
      // stores the *conclusion* that verdict produced, so dropping the premise only meant
      // re-deciding reached a different answer from the same row. A breach carries
      // `consecutive_failures = 0`, so a null verdict reads as "last scan fine, nothing judged"
      // and every non-result path answered Up.
      channel: channelVerdict(row),
      lastResultAt: row.last_result_at,
      resumedAt: row.resumed_at,
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
 * `loadRuntimes`, with each row locked until the caller's transaction ends (`P-414`).
 *
 * In id order, `writeStateHistory`'s (`P-394`), so two writers of the same sensors take them in
 * the same order. A row another transaction has written and not committed is waited for, and
 * read as it committed: what is decided from this cannot be overwriting something it did not see.
 */
export async function lockRuntimes(
  q: Queryable,
  sensorIds: readonly number[],
): Promise<Map<number, SensorRuntime>> {
  if (sensorIds.length === 0) return new Map();
  const rows = await q.query<RuntimeRow>(
    `SELECT ${RUNTIME_COLUMNS} FROM sensor_runtime WHERE object_id = ANY($1::bigint[])
     ORDER BY object_id FOR NO KEY UPDATE`,
    [[...sensorIds]],
  );
  return new Map(rows.map((row) => [Number(row.object_id), toRuntime(row)]));
}

/**
 * The state and cause on each of these sensors' runtime rows, locked in id order (`P-415`).
 *
 * What a result write reads of the rows a probe's hold holds, before its history, so that what
 * it reads is what it will write over: a hold's re-decision that has committed is on the row,
 * and one that has not waits for the write and decides from what it leaves (`P-414`). Id order,
 * as `writeStateHistory`'s own lock and `lockRuntimes` take them (`P-394`). Only those rows, and
 * after the unheld rows the write's transitions move: every row a write touches, or a held
 * dependent ahead of a master a release has let go of, taken this early, closed a cycle with
 * the release, whose dependency recompute locks the master and then the dependents. A held
 * steady dependent taken ahead of a steady master still can (`P-422`).
 */
export async function lockRuntimeStates(
  q: Queryable,
  sensorIds: readonly number[],
): Promise<Map<number, { state: SensorState; cause: SensorStateCause }>> {
  if (sensorIds.length === 0) return new Map();
  const rows = await q.query<{ sensor_id: string; state: SensorState; cause: SensorStateCause }>(
    `SELECT object_id::text AS sensor_id, state, cause FROM sensor_runtime
     WHERE object_id = ANY($1::bigint[])
     ORDER BY object_id FOR NO KEY UPDATE`,
    [[...new Set(sensorIds)]],
  );
  return new Map(
    rows.map((row) => [Number(row.sensor_id), { state: row.state, cause: row.cause }]),
  );
}

/** Told what actually landed, after the transaction that wrote it commits (`U-02`). */
export type CommittedStates = (committed: readonly StateTransition[]) => void | Promise<void>;

/**
 * Appends the transitions to the history hypertable.
 *
 * `ON CONFLICT DO NOTHING` against the unique index on `(sensor_id, time)`, so a probe that
 * resends after a lost acknowledgement replays into the same rows rather than duplicating the
 * timeline — the same idempotence the readings have, and for the same reason.
 *
 * **This is where every state change in the system is written**, from ingestion, a pause, an
 * acknowledgement, a simulated error, a dependency cascade and a schedule window alike — which
 * is why `U-02`'s live stream is published from here rather than from each of those paths. It is
 * published `afterCommit`, and only for the rows that actually landed: announcing a change that
 * the conflict guard dropped, or one a rollback undid, would put an outage on an operator's
 * screen that never happened.
 */
export async function writeStateHistory(
  q: Queryable,
  changes: readonly StateTransition[],
  onCommitted?: CommittedStates,
  stamping: Stamping = 'after-the-newest',
): Promise<number> {
  if (changes.length === 0) return 0;
  // **Each sensor's runtime row first, in id order** (`P-394`). Both stampings read the rows
  // already stored and move a transition off an occupied instant, and a row another transaction
  // has written but not committed is not one they can see. A route that re-decides a sensor
  // holds its runtime row from the write that caused it; ingestion did not touch that row until
  // after this insert. So a result measured at the instant a route was writing found the instant
  // free, inserted into it, waited for the route, and was dropped by the guard below once the
  // route committed, while its runtime write went through. With every writer of a sensor's
  // history holding that sensor's runtime row first, the second sees the first's row and moves.
  // Id order, so two writers of the same sensors take them in the same order.
  await q.query(
    `SELECT 1 FROM sensor_runtime WHERE object_id = ANY($1::bigint[])
     ORDER BY object_id FOR NO KEY UPDATE`,
    [[...new Set(changes.map((change) => change.sensorId))]],
  );
  const ordered =
    stamping === 'as-measured' ? await asMeasured(q, changes) : await orderedAfterLast(q, changes);
  const rows = await q.query<{ sensor_id: string; time: Date }>(
    `INSERT INTO sensor_state (
       time, sensor_id, state, previous_state, cause, message, failure_phase, failure_target
     )
     SELECT * FROM unnest(
       $1::timestamptz[], $2::bigint[], $3::sensor_state_kind[],
       $4::sensor_state_kind[], $5::sensor_state_cause[], $6::text[], $7::text[], $8::text[]
     )
     -- Still here, and now it means only one thing: a genuine replay. orderedAfterLast above
     -- has already moved any transition that would have displaced a *different* row, so what
     -- reaches this guard is a batch the probe re-offered, writing into the rows it wrote
     -- before -- the same idempotence the readings have, and for the same reason.
     ON CONFLICT (sensor_id, time) DO NOTHING
     RETURNING sensor_id::text AS sensor_id, time`,
    [
      ordered.map((write) => write.at),
      ordered.map((write) => write.sensorId),
      ordered.map((write) => write.state),
      ordered.map((write) => write.previousState),
      ordered.map((write) => write.cause),
      ordered.map((write) => write.message),
      ordered.map((write) => write.failure?.phase ?? null),
      ordered.map((write) => write.failure?.target ?? null),
    ],
  );

  if (onCommitted !== undefined && rows.length > 0) {
    // Matched on the pair, not on the sensor: a batch can carry two transitions for one sensor
    // and have only one of them land, and announcing the dropped one would describe a history
    // the table does not have.
    const landed = new Set(rows.map((row) => `${row.sensor_id}@${row.time.toISOString()}`));
    const committed = ordered.filter((change) =>
      landed.has(`${String(change.sensorId)}@${change.at.toISOString()}`),
    );
    const publish = (): void => {
      void onCommitted(committed);
    };
    // No transaction to wait for means it has already committed, so the hook runs now.
    if (q.afterCommit === undefined) publish();
    else q.afterCommit(publish);
  }
  return rows.length;
}

/**
 * The same transitions, each stamped strictly after that sensor's newest stored row (`P-108`).
 *
 * `sensor_state` is keyed on `(sensor_id, time)` with `ON CONFLICT DO NOTHING`, and that guard
 * was doing two jobs it cannot both do. It makes a *replayed* batch idempotent, which is right.
 * It also silently discarded any genuinely new transition that landed on an occupied instant —
 * and `writeStateChanges` has no such guard, so `sensor_runtime` took the change the history
 * threw away. The two then disagree about what the sensor is, permanently, and uptime is
 * computed from the one that lost the row.
 *
 * Three findings, one cause:
 *
 * - **Two callers reusing one `now`.** `sweepPauses` takes one timestamp and passes it to
 *   `releaseElapsed` and to every iteration of both loops; `CompositeAuditSink` hands
 *   `ScheduleSync` and `DependencySync` the same `at`, and both react to `object.moved`. A
 *   sensor released by a dependency and paused by a window in one tick wrote `unknown` and then
 *   `paused`, and kept only the first.
 * - **Two clocks.** Result-driven transitions carry the probe's wall clock, which the protocol
 *   says the core does not rewrite; every other transition carries the core's. A probe two
 *   minutes fast left its sensors' newest row *ahead* of the core, so a pause at 12:00:30 sorted
 *   before an `up` at 12:02:00: `GET /state-log` reported Up with no duration while the badge
 *   said Paused, and any uptime figure booked the whole maintenance window as monitored Up.
 * - **The backstop that could not report.** `reevaluate` discarded this function's return and
 *   reported `transitions.length` instead — the count it *tried* to write — so the comment
 *   promising "a drop cannot pass unnoticed" was not honoured by any caller.
 *
 * `reactionTime` in `dependencies/pauses.ts` fixed this for one caller by construction, with a
 * doc comment explaining that the collision "is a corrupted SLA rather than a cosmetic glitch".
 * It was right; it was just in one of the four places that needed it. Doing it here means no
 * future caller has to know.
 *
 * **An identical row is left alone**, which is what keeps a replay idempotent: same sensor, same
 * instant, same state and cause is the batch arriving twice, and it should collide. Anything
 * else is a new fact about the sensor and gets the next millisecond.
 */
/**
 * How a transition's instant is chosen when the table already has rows for that sensor.
 *
 * **Two callers, two clocks, and they need different answers** (`P-145`).
 *
 * `after-the-newest` is `P-108`'s rule and belongs to the *core's* own transitions — a pause, an
 * acknowledgement, a dependency cascade, a schedule window. They happen at the moment the core
 * decides them, so they must sort after everything already stored: a probe two minutes fast
 * otherwise left its sensors' newest row ahead of the core, and a pause at 12:00:30 sorted before
 * an `up` at 12:02:00, so the log said Up while the badge said Paused.
 *
 * `as-measured` belongs to *results*, and is the half `P-108` got wrong. A spool replay is an
 * hour of genuine history arriving late, and stamping each row after the newest one rewrote the
 * whole outage into consecutive milliseconds — in the table `CLAUDE.md` says uptime is computed
 * from. A four-hour outage replayed as four milliseconds and the SLA read 100%. History that
 * arrives out of order is still history; only a genuine *collision* is moved, and only far enough
 * to make room.
 */
export type Stamping = 'after-the-newest' | 'as-measured';

/**
 * The same transitions at the instants they were measured, moving only what would collide.
 *
 * The unique index is `(sensor_id, time)` with `ON CONFLICT DO NOTHING`, which makes a resent
 * batch idempotent and would otherwise silently discard a *different* fact that happened to land
 * on an occupied instant — `P-108`'s finding, and still true here. So the occupied instants are
 * read first: an identical row is left to collide, and anything else takes the next millisecond.
 */
async function asMeasured(
  q: Queryable,
  changes: readonly StateTransition[],
): Promise<StateTransition[]> {
  const rows = await q.query<{
    sensor_id: string;
    time: Date;
    state: SensorState;
    cause: SensorStateCause;
  }>(
    `SELECT sensor_id::text AS sensor_id, time, state, cause
     FROM sensor_state
     WHERE (sensor_id, time) IN (
       SELECT * FROM unnest($1::bigint[], $2::timestamptz[])
     )`,
    [changes.map((change) => change.sensorId), changes.map((change) => change.at)],
  );
  const key = (sensorId: number, at: Date): string => `${String(sensorId)}@${at.toISOString()}`;
  const occupied = new Map(rows.map((row) => [key(Number(row.sensor_id), row.time), row] as const));

  return changes.map((change) => {
    let at = change.at;
    for (let step = 0; step < 1_000; step += 1) {
      const held = occupied.get(key(change.sensorId, at));
      if (held === undefined) break;
      // The same fact arriving twice, which is what makes a resent batch harmless.
      if (held.state === change.state && held.cause === change.cause) break;
      at = new Date(at.getTime() + 1);
    }
    // Claimed, so two changes in one batch cannot both take it.
    occupied.set(key(change.sensorId, at), {
      sensor_id: String(change.sensorId),
      time: at,
      state: change.state,
      cause: change.cause,
    });
    return at === change.at ? change : { ...change, at };
  });
}

/**
 * Each sensor's newest stored row, for the sensors in `$1` (`P-388`).
 *
 * One sensor at a time, read backwards from `(sensor_id, time)`, so the cost is a few blocks for
 * each sensor asked about however long its history is. The `DISTINCT ON` it replaced read every
 * row of every sensor asked about and sorted them by the id made text: at 5,000 sensors, a sort
 * that spilled to disk and 280–320 ms over four runs, against 12 ms. Exported so the measurement
 * (`test/perf/state-latest-plan.test.ts`, `docs/findings/2026-10-11-state-latest-plan.md`) is of
 * this text and not of a copy.
 */
export const NEWEST_STATES = `SELECT asked.id::text AS sensor_id, newest.time, newest.state, newest.cause
  FROM unnest($1::bigint[]) AS asked(id)
  CROSS JOIN LATERAL (
    SELECT s.time, s.state, s.cause FROM sensor_state s
    WHERE s.sensor_id = asked.id
    ORDER BY s.time DESC LIMIT 1
  ) AS newest`;

async function orderedAfterLast(
  q: Queryable,
  changes: readonly StateTransition[],
): Promise<StateTransition[]> {
  const rows = await q.query<{
    sensor_id: string;
    time: Date;
    state: SensorState;
    cause: SensorStateCause;
  }>(NEWEST_STATES, [[...new Set(changes.map((change) => change.sensorId))]]);
  const newest = new Map(rows.map((row) => [Number(row.sensor_id), row]));

  return changes.map((change) => {
    const last = newest.get(change.sensorId);
    if (last === undefined || change.at.getTime() > last.time.getTime()) {
      newest.set(change.sensorId, {
        sensor_id: String(change.sensorId),
        time: change.at,
        state: change.state,
        cause: change.cause,
      });
      return change;
    }
    // The same fact arriving twice. Let it collide; that is what makes a resent batch harmless.
    if (
      change.at.getTime() === last.time.getTime() &&
      change.state === last.state &&
      change.cause === last.cause
    ) {
      return change;
    }
    const at = new Date(last.time.getTime() + 1);
    newest.set(change.sensorId, {
      sensor_id: String(change.sensorId),
      time: at,
      state: change.state,
      cause: change.cause,
    });
    return { ...change, at };
  });
}

/**
 * The transitions that sort before their sensor's newest stored row, for the sensors in `held`;
 * the rest unchanged (`P-415`).
 *
 * A row a probe's hold kept does not take its result's state, and the history must not end on
 * that state either: a probe whose clock runs ahead (up to the 15 minutes `P-99` accepts) stamps
 * its result after the hold's row, and a hold that decided a row unchanged wrote no row at all.
 * Measured history before the newest row stays; anything at or after it is left out. A kept
 * sensor with no history yet takes none of its result's.
 */
export async function beforeTheNewest(
  q: Queryable,
  changes: readonly StateTransition[],
  held: ReadonlySet<number>,
): Promise<StateTransition[]> {
  const asked = [...new Set(changes.map((change) => change.sensorId))].filter((id) => held.has(id));
  if (asked.length === 0) return [...changes];
  const rows = await q.query<{ sensor_id: string; time: Date }>(NEWEST_STATES, [asked]);
  const newest = new Map(rows.map((row) => [Number(row.sensor_id), row.time.getTime()]));
  return changes.filter((change) => {
    if (!held.has(change.sensorId)) return true;
    const last = newest.get(change.sensorId);
    return last !== undefined && change.at.getTime() < last;
  });
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
 *
 * `overtaken` names the writes whose rows a probe's hold has reached since they were decided
 * (`SensorStateService.overtaken`, `P-415`): their state is left to the hold, as a pause's is.
 */
export async function writeRuntimes(
  q: Queryable,
  writes: readonly RuntimeWrite[],
  overtaken: ReadonlySet<number> = new Set(),
): Promise<number> {
  if (writes.length === 0) return 0;
  const rows = await q.query<{ object_id: string }>(
    `UPDATE sensor_runtime r
     -- **A pause that committed while this batch was in flight is not overwritten** (P-147).
     -- decide() evaluates layer 1 -- a pause dominates everything -- against an in-memory cache
     -- read up to batchMaxDelayMs before this statement runs, and this write had no pause guard
     -- of its own: it set state = 'down' on a row whose pause flags were true, and the reaction
     -- in the same transaction then read that row back and armed a chain for the sensor an
     -- operator had just paused. Exactly the alarm the pause was pressed to stop, from the
     -- press itself. Nothing self-healed until that sensor's next scan re-decided it.
     --
     -- Everything a result carries is still written -- last_result_at, the failure count, the
     -- readings' channel verdict -- because they are facts about the check, which did happen.
     -- Only the state, and the words that describe it, are left to the pause. That is what
     -- decide() would have produced had the pause been visible to it.
     --
     -- **And to a probe's hold that has reached the row since the result was decided**
     -- (P-415): a lost probe, a frozen clock, a check its probe could not start, a factory's
     -- unreached inputs. Those live in memory, not on the row, so the caller says which writes
     -- they overtook, from the rows it has locked.
     SET state = CASE WHEN w.held OR w.overtaken THEN r.state ELSE w.state END,
         cause = CASE WHEN w.held OR w.overtaken THEN r.cause ELSE w.cause END,
         message = CASE WHEN w.held OR w.overtaken THEN r.message ELSE w.message END,
         -- Where the check failed goes with the words (P-285): a pause's words stay, and so
         -- does what they were written beside.
         failure_phase =
           CASE WHEN w.held OR w.overtaken THEN r.failure_phase ELSE w.failure_phase END,
         failure_target =
           CASE WHEN w.held OR w.overtaken THEN r.failure_target ELSE w.failure_target END,
         since = CASE WHEN w.held OR w.overtaken THEN r.since ELSE w.since END,
         consecutive_failures = w.consecutive_failures,
         last_result_at = w.at,
         -- Only ever cleared here. §2.4 clears an acknowledgement on a recovery a reading
         -- decided and on expiry, and both of those arrive as a result; nothing about a result
         -- can create one.
         acknowledged_at = CASE WHEN w.acknowledged THEN r.acknowledged_at END,
         acknowledged_until = CASE WHEN w.acknowledged THEN r.acknowledged_until END,
         acknowledged_by_kind = CASE WHEN w.acknowledged THEN r.acknowledged_by_kind END,
         acknowledged_by_label = CASE WHEN w.acknowledged THEN r.acknowledged_by_label END,
         channel_state = w.channel_state,
         channel_cause = w.channel_cause
     FROM (
       SELECT t.*,
              -- Whether a pause already on the row outranks what this write decided (P-147).
              -- Layer 1 of the state machine: a pause dominates everything. A write that *is*
              -- the pause being applied must not be held by itself — and the discriminator for
              -- that is its state, not its cause (R05). 'user' is also the cause of both halves
              -- of an acknowledgement: acknowledged() returns down_acknowledged/user and a
              -- lapsing acknowledgement returns down/user. Exempting the cause meant that on any
              -- sensor carrying an acknowledgement — which is to say, during exactly the outage
              -- an operator is most likely to pause — the racing write P-147 exists to stop went
              -- through, overwrote paused with down, and armed a chain for the sensor the
              -- operator had just paused. Being paused, it is out of the probe configuration, so
              -- nothing re-decides it: the row stays down until somebody resumes.
              (SELECT p.paused_manually OR p.paused_by_parent
                        OR p.paused_by_schedule OR p.paused_by_dependency
                 FROM sensor_runtime p WHERE p.object_id = t.sensor_id)
                AND t.state <> 'paused' AS held
       FROM unnest(
         $1::bigint[], $2::timestamptz[], $3::sensor_state_kind[], $4::sensor_state_cause[],
         $5::text[], $6::timestamptz[], $7::int[], $8::boolean[],
         $9::sensor_state_kind[], $10::sensor_state_cause[], $11::text[], $12::text[],
         $13::boolean[]
       ) AS t(sensor_id, at, state, cause, message, since, consecutive_failures, acknowledged,
              channel_state, channel_cause, failure_phase, failure_target, overtaken)
     ) AS w
     WHERE r.object_id = w.sensor_id
       -- Both floors (P-97). GREATEST ignores nulls, so a sensor that has never reported and
       -- never resumed passes on the IS NULL arm.
       AND ((r.last_result_at IS NULL AND r.resumed_at IS NULL)
            OR w.at > GREATEST(r.last_result_at, r.resumed_at))
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
      writes.map((write) => write.channel?.state ?? null),
      writes.map((write) => write.channel?.cause ?? null),
      writes.map((write) => write.failure?.phase ?? null),
      writes.map((write) => write.failure?.target ?? null),
      writes.map((write) => overtaken.has(write.sensorId)),
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
            r.failure_phase,
            r.failure_target,
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
            coalesce(r.simulated_error, false) AS simulated_error,
            -- Every field of RuntimeRow, or toRuntime silently rebuilds different facts from
            -- the same sensor depending on which query read it. runtime-row.test.ts is what
            -- keeps these two column lists in step; it exists because both of these were
            -- forgotten here, once each.
            r.channel_state,
            r.channel_cause,
            r.resumed_at
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
 *
 * **Only the sensors the caller can see** (`A-24`). The route checks the object it was given, and
 * an acknowledgement on a group used to reach every Down sensor beneath it, holes included: a
 * write crossing into a branch the caller was never shown, and an answer — "acknowledged 12",
 * or "nothing here is Down" — about the state of what is in it. The condition is `A-12`'s, the
 * one every listing puts in its own `WHERE`.
 */
export async function downSensorsIn(
  q: Queryable,
  rootId: number,
  visibility: Visibility,
): Promise<number[]> {
  const values: unknown[] = [rootId];
  const visible = visibility.where('subtree.id', (value) => `$${String(values.push(value))}`);
  const rows = await q.query<{ object_id: string }>(
    `
    WITH RECURSIVE subtree AS (
      SELECT o.id, 0 AS depth FROM object o WHERE o.id = $1
      UNION ALL
      SELECT c.id, subtree.depth + 1
      FROM object c JOIN subtree ON c.parent_id = subtree.id
      WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
    )
    SELECT r.object_id::text AS object_id
    FROM subtree
    JOIN sensor_runtime r ON r.object_id = subtree.id
    WHERE r.state IN ('down', 'down_acknowledged') AND ${visible}
    ORDER BY r.object_id
    `,
    values,
  );
  return rows.map((row) => Number(row.object_id));
}

/**
 * Every sensor beneath an object.
 *
 * Unlike `downSensorsIn`, this filters on no state: a simulated error (`M-14`) is applied to what
 * an operator selected, whatever state it happens to be in, because forcing a Down is not a
 * statement about the current one. It does filter on sight, for `downSensorsIn`'s reason (`A-24`):
 * forcing Down a sensor in a hole would page whoever owns it, on the word of somebody who cannot
 * see it.
 */
export async function sensorsIn(
  q: Queryable,
  rootId: number,
  visibility: Visibility,
): Promise<number[]> {
  const values: unknown[] = [rootId];
  const visible = visibility.where('subtree.id', (value) => `$${String(values.push(value))}`);
  const rows = await q.query<{ object_id: string }>(
    `
    WITH RECURSIVE subtree AS (
      SELECT o.id, o.kind, 0 AS depth FROM object o WHERE o.id = $1
      UNION ALL
      SELECT c.id, c.kind, subtree.depth + 1
      FROM object c JOIN subtree ON c.parent_id = subtree.id
      WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
    )
    SELECT id::text AS object_id FROM subtree WHERE kind = 'sensor' AND ${visible} ORDER BY id
    `,
    values,
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
  readonly actorKind: ActorKind | null;
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
  /**
   * Where the check its words come from stopped: a held result's (`P-407`), and `null` beside
   * every other rewrite's words — a pause's, an acknowledgement's, a release's, the core's own.
   * Required, so a new rewrite says which rather than leaving a check's place beside its words.
   */
  readonly failure: CheckFailure | null;
  readonly since: Date;
  readonly reset: boolean;
}

/**
 * Moves each sensor's current row without pretending a scan happened.
 *
 * No `last_result_at` guard, unlike `writeRuntimes`: there is no result to be stale against, and
 * the caller has just read these rows in this transaction, locked (`lockRuntimes`, `P-414`), so
 * nothing it did not see can be on them.
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
         -- Beside the words it is written with (P-285, P-407): a held result's own, and NULL
         -- beside a pause's, an acknowledgement's, a release's or the core's own words. What a
         -- check said of where it failed went with the words it was written beside.
         failure_phase = w.failure_phase,
         failure_target = w.failure_target,
         since = w.since,
         -- last_result_at is never cleared (P-97): it is the high-water mark that makes the
         -- at-least-once probe protocol safe, and nulling it turned every duplicate into a
         -- fresh reading. resumed_at carries what it used to mean here -- nothing measured
         -- since -- and is a second floor on staleness, because a probe that lost its link
         -- keeps scanning a sensor the core has since paused.
         resumed_at = CASE WHEN w.reset THEN w.since ELSE r.resumed_at END,
         consecutive_failures = CASE WHEN w.reset THEN 0 ELSE r.consecutive_failures END,
         -- Resuming clears any acknowledgement (WORKFLOW.MD §4 rule 5): it was a statement
         -- about an outage nobody is watching any more.
         acknowledged_at = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_at END,
         acknowledged_until = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_until END,
         acknowledged_by_kind = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_by_kind END,
         acknowledged_by_label = CASE WHEN w.reset THEN NULL ELSE r.acknowledged_by_label END,
         -- A resume clears the verdict with the rest of the interval nobody watched: §3 says
         -- the sensor awaits its next scan rather than returning to what it was. Every other
         -- rewrite leaves it alone, which is the whole point — a re-decide without a reading
         -- must read the same verdict the reading wrote.
         channel_state = CASE WHEN w.reset THEN NULL ELSE r.channel_state END,
         channel_cause = CASE WHEN w.reset THEN NULL ELSE r.channel_cause END
     FROM unnest(
       $1::bigint[], $2::sensor_state_kind[], $3::sensor_state_cause[], $4::text[],
       $5::timestamptz[], $6::boolean[], $7::text[], $8::text[]
     ) AS w(sensor_id, state, cause, message, since, reset, failure_phase, failure_target)
     WHERE r.object_id = w.sensor_id
     RETURNING r.object_id::text AS object_id`,
    [
      rewrites.map((write) => write.sensorId),
      rewrites.map((write) => write.state),
      rewrites.map((write) => write.cause),
      rewrites.map((write) => write.message),
      rewrites.map((write) => write.since),
      rewrites.map((write) => write.reset),
      rewrites.map((write) => write.failure?.phase ?? null),
      rewrites.map((write) => write.failure?.target ?? null),
    ],
  );
  return rows.length;
}
