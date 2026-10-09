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
 * `promise`, or a failure naming `what` once `ms` have passed.
 *
 * **For every wait on the far end of a socket or a process.** A test's own `timeout` fails the
 * test and does not cancel it, so an `await` that never settles never reaches the `finally` that
 * stops the server or lets go of the lock — and the open handles then keep the whole file's
 * process alive, which is a suite that never finishes rather than a test that fails.
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
 * passed — after which it asks no more. The core's (`P-325`, `P-355`): a loop handed to `within`
 * alone runs on after `within` rejects, and holds the file's process.
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
