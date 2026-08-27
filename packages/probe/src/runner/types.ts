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
export type { CheckContext, CheckExecution, CheckTarget } from '@ms/sensors';

import type { CheckContext, CheckExecution, CheckTarget } from '@ms/sensors';

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
  /** Hard deadline. The sensor's own `scan.timeoutMs`, resolved by the core. */
  timeoutMs: number;
}

/**
 * Where a check got to. Not on the wire — the protocol carries a message, not a taxonomy — but
 * it is what the probe logs, and "ETIMEDOUT" alone is not a diagnosis (CLAUDE.md).
 */
export type CheckPhase =
  'execute' | 'timeout' | 'aborted' | 'worker-crash' | 'pool-stopped' | 'unknown-type';

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
export interface CheckRegistry {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution>;
}

/** The shape the worker sniffs for. Kept structural so a test registry need not import one. */
export const UNKNOWN_SENSOR_TYPE = 'UNKNOWN_SENSOR_TYPE';

export type { CheckResult };
