import type { ChannelReading, CheckResult } from '@ms/shared';

export interface CheckRequest {
  sensorId: number;
  sensorType: string;
  params: Record<string, unknown>;
  /** Hard deadline. The sensor's own `scan.timeoutMs`, resolved by the core. */
  timeoutMs: number;
}

/**
 * What a check is handed when it runs.
 *
 * `signal` is not optional and not advisory: CLAUDE.md requires every check to honour it, and a
 * check that ignores it gets its worker terminated instead — which costs more than returning.
 */
export interface CheckContext {
  readonly sensorId: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface CheckExecution {
  channels: ChannelReading[];
  message?: string;
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
