/**
 * Where an error says its check failed, read as the probe reads it (`failureSaid`, `P-285`):
 * its `phase`, and its `target` or else its `host` (`P-406`). Read by shape, as the probe does,
 * so a test asserts what crosses to the core and not a class's own fields.
 */
export function failedIn(error: unknown): { phase: unknown; target: unknown } {
  const { phase, target, host } = (typeof error === 'object' && error !== null ? error : {}) as {
    phase?: unknown;
    target?: unknown;
    host?: unknown;
  };
  return { phase, target: typeof target === 'string' && target !== '' ? target : host };
}

/** What `fn` rejected with, or a failure saying it did not reject. */
export async function rejectionOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('it did not fail');
}
