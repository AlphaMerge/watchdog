import type { CheckResult } from '@ms/shared';

/**
 * What a check is handed, and what it gives back, come from `@ms/sensors` — the package that
 * defines the contract sensor types implement.
 *
 * Re-exported rather than redeclared: P-02 wrote its own copies before that package existed, and
 * two structurally-identical interfaces in two packages is a pair that drifts. Adding
 * `CheckTarget` for P-08 is what surfaced it — the probe's copy would have gone on compiling
 * without the field the sensor needed.
 */
export type { CheckContext, CheckExecution, CheckTarget, ReceivedBatch } from '@ms/sensors';

import type { CheckContext, CheckExecution, CheckTarget, ReceivedBatch } from '@ms/sensors';

export interface CheckRequest {
  sensorId: number;
  sensorType: string;
  /** Where the check points, resolved by the core from the sensor's parent device (R-04). */
  target: CheckTarget;
  params: Record<string, unknown>;
  /**
   * Credential sets this sensor's type declared, decrypted by the core (`A-05`).
   *
   * Held in memory for as long as the assignment is, and never written anywhere: the spool
   * carries results, not requests.
   */
  credentials?: Record<string, Record<string, unknown>>;
  /**
   * What a listener collected for this sensor since its last check (`T-06`).
   *
   * Attached by the probe at submit time for a type whose declaration names a listener, and
   * absent for every polling type. Structured-cloneable, because it crosses into a worker.
   */
  received?: ReceivedBatch;
  /** Hard deadline. The sensor's own `scan.timeoutMs`, resolved by the core. */
  timeoutMs: number;
}

/**
 * Where a check got to. Not on the wire — the protocol carries a message, not a taxonomy — but
 * it is what the probe logs, and "ETIMEDOUT" alone is not a diagnosis (CLAUDE.md).
 */
export type CheckPhase =
  | 'execute'
  | 'timeout'
  | 'aborted'
  | 'worker-crash'
  | 'pool-stopped'
  // The pool latched itself off with this check already accepted (`P-62`, drained by `P-80`).
  // Distinct from `pool-stopped`, which is an orderly shutdown: this one is a fault, and the
  // difference is what an operator reads in the result's message.
  | 'pool-disabled'
  | 'unknown-type'
  // A check process that did not get as far as running its check (`P-260`): it took longer to
  // load the probe's catalogue than the start-up bound, or the load failed. The probe's fault or
  // the machine's, never the check's, and its message says which.
  | 'startup';

/**
 * Whether a check that ended in this phase never ran, for a reason of the probe's and not the
 * device's (`P-265`): its process did not start it (`startup`), or the pool gave up before it
 * could (`pool-disabled`). Its result is marked `notStarted`, and the core holds the sensor
 * Unknown behind the probe's one alarm. `pool-stopped` is not here: a stopping runner's cut-off
 * checks are never spooled.
 */
export function notStarted(phase: CheckPhase): boolean {
  return phase === 'startup' || phase === 'pool-disabled';
}

export interface ResultMeta {
  phase: CheckPhase;
  /** Milliseconds the request spent queued before a worker took it. */
  waitMs: number;
  workerId: number;
}

/**
 * What the pool resolves a check through (P-05: `@ms/sensors`).
 *
 * A registry asked for a type it does not have must reject with an error carrying
 * `code === 'UNKNOWN_SENSOR_TYPE'`. The pool reports those as the `unknown-type` phase rather
 * than as a failing check: a missing type fails identically for ever, and counting it with
 * genuine check failures buries a configuration error in a rate that looks like flapping.
 */
/**
 * Session-pool counters a registry keeps, summed across every pool it owns (`P-36`).
 *
 * **Why this is on the registry and not an import.** The pools live in `@ms/sensors`, and the
 * worker loads its registry *by path* precisely so it never depends on that package — which is
 * what lets a test drive the pool with checks that hang and crash on purpose. Reaching for
 * `snmpPool` from the worker would pull the real catalogue into every fixture run and undo that.
 * So the registry that owns the pools reports on them, and one that has none says nothing.
 *
 * **Cumulative, except `open`.** A worker is retired when the pool shrinks, and its counters go
 * with it; the pool therefore keeps a retired baseline so the totals it publishes never go
 * backwards. `open` is a gauge and is meant to fall.
 */
export interface SessionCounters {
  /** Sessions the registry's pools are holding right now, live and idle. */
  open: number;
  /** Sessions opened past the configured bound because every existing one was in use. */
  overflowed: number;
  /** Sessions closed for being idle longer than the pool's `idleMs`. */
  evicted: number;
  /** Sessions opened, ever. With `evicted`, this is how much churn an interval is causing. */
  opened: number;
}

export interface CheckRegistry {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution>;
  /**
   * Optional (`P-36`): what this registry's session pools are doing.
   *
   * Optional because a fixture registry has no pools and should not have to pretend. The worker
   * asks after every check and sends whatever comes back, so a registry that does not implement
   * it costs nothing and reports nothing — and the channel gaps rather than reading zero, which
   * is `R-06` and the rule that no-data is not zero.
   */
  sessionCounters?(): SessionCounters;
}

/** The shape the worker sniffs for. Kept structural so a test registry need not import one. */
export const UNKNOWN_SENSOR_TYPE = 'UNKNOWN_SENSOR_TYPE';

/**
 * The code of a check refused over where its credentials may go (`A-41c`): `@ms/sensors`'
 * `CredentialsWithheldError`. Sniffed structurally, for the reason `UNKNOWN_SENSOR_TYPE` is. The
 * runner marks the result `withheld`, and the core holds the sensor Unknown instead of counting a
 * failed scan: nothing was sent to the device, so nothing about it failed.
 */
export const CREDENTIALS_WITHHELD = 'CREDENTIALS_WITHHELD';

/**
 * How a check process announces its answer on stdout (`P-03`).
 *
 * **Here rather than in `check-child.ts`, and that is not tidiness.** `check-child.ts` is an
 * *entry point*: it has top-level `await` that reads stdin and a `process.exit` at the end. The
 * runner imported the marker from it once, which ran the child's own body inside the probe — a
 * parent that sat waiting for its own stdin to end, for ever. A constant shared between a program
 * and its launcher belongs in neither of them.
 */
export const RESULT_MARKER = 'ms-check-result:';

/**
 * How a check process says it has loaded the probe's catalogue and is about to run its check
 * (`P-260`), on a line of stdout of its own. Here for the reason `RESULT_MARKER` is.
 *
 * **The check's clocks start at this line, on both sides.** The child arms the check's abort
 * after it, and the runner swaps its start-up bound for the check's timeout plus its margin when
 * it reads it. Before this the child armed its abort first and then imported the catalogue, which
 * `P-258` measured at 0.45–14.8 s on a loaded machine, so a script given 10 s could be left 2 s
 * of its own and then reported as having exceeded its timeout.
 */
export const READY_MARKER = 'ms-check-ready';

/**
 * How a check process names a process group it has started, and says when that group's program
 * has ended (`P-266`): a line of stdout reading `GROUP_MARKER` then `started` or `ended`, a space
 * and the group's id. Here for the reason `RESULT_MARKER` is.
 *
 * **The runner's to act on once the check process has gone.** A script runs in a group of its
 * own, which the runner's kill of the check process's group does not reach, and the check process
 * ends it on its cancel only while it lives. A group named and not yet ended when the check
 * process has gone has nobody left to end it, so the runner does.
 */
export const GROUP_MARKER = 'ms-check-group:';

export type { CheckResult };
