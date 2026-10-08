import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation ids travel with the async context so every log line emitted while handling a
 * request — or executing a check — can be tied back to it without threading a logger through
 * every call site.
 */
export interface CorrelationContext {
  /** One HTTP/WebSocket request, or the decision on one probe's hello (`P-319`). */
  readonly requestId?: string;
  /** One check execution. */
  readonly checkId?: string;
  readonly sensorId?: number;
  readonly probeGid?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Runs `fn` with the given correlation fields merged over any enclosing context. */
export function withCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...context };
  return storage.run(merged, fn);
}
