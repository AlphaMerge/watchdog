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
 * The seam `P-05` fills. Until the registry exists nothing can be checked, and the placeholder
 * says so by name rather than by failing to find a function.
 */
export interface CheckRegistry {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution>;
}

export type { CheckResult };
