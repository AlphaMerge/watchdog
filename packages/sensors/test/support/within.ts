import { setTimeout as sleep } from 'node:timers/promises';

/**
 * What a bounded wait was waiting for: words, or a function asked for them once the bound has
 * passed, so a failure can say what had been seen by then. The core's (`P-356`).
 */
export type Waited = string | (() => string);

/** The words for `what`, at the bound. A description that throws still leaves a failure. */
function described(what: Waited): string {
  if (typeof what === 'string') return what;
  try {
    return what();
  } catch (error) {
    return `(a description that threw: ${String(error)})`;
  }
}

/**
 * `promise`, or a failure naming `what` once `ms` have passed (`P-279`).
 *
 * **For every wait on the far end of a socket or a process**, as `packages/core/test/support/
 * within.ts` has it. A test's own `timeout` fails the test and does not cancel it, and a
 * wall-clock reading asserted afterwards is one a loaded machine can push past any number: this
 * says what did not happen, and when it gave up waiting for it.
 */
export async function within<T>(ms: number, what: Waited, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms waiting for ${described(what)}`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Until `met` answers true, asking every `intervalMs`, or a failure naming `what` once `ms` have
 * passed — after which it asks no more, so a wait that gave up leaves nothing running to hold the
 * process open. The core's, under the core's name (`P-325`, `P-355`).
 */
export async function pollWithin(
  ms: number,
  what: Waited,
  met: () => boolean | Promise<boolean>,
  intervalMs = 20,
): Promise<void> {
  const stop = new AbortController();
  const polling = (async (): Promise<void> => {
    while (!stop.signal.aborted) {
      if (await met()) return;
      // Rejects at once if the bound passed while `met` was out.
      try {
        await sleep(intervalMs, undefined, { signal: stop.signal });
      } catch {
        return;
      }
    }
  })();
  try {
    await within(ms, what, polling);
  } finally {
    stop.abort();
  }
}
