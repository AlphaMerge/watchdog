import { setTimeout as sleep } from 'node:timers/promises';

/** Rejects after `ms`, naming what was being waited for: a test's own timeout does not stop it. */
export async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Until `met` answers true, asking every `intervalMs`, or a failure naming `what` once `ms` have
 * passed — after which it asks no more. The probe's copy of the core's (`P-325`, `P-330`): a
 * loop handed to `within` alone runs on after `within` rejects, and holds the file's process.
 */
export async function pollWithin(
  ms: number,
  what: string,
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
