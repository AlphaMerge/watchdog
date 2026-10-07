/**
 * `promise`, or a failure naming `what` once `ms` have passed (`P-279`).
 *
 * **For every wait on the far end of a socket or a process**, as `packages/core/test/support/
 * within.ts` has it. A test's own `timeout` fails the test and does not cancel it, and a
 * wall-clock reading asserted afterwards is one a loaded machine can push past any number: this
 * says what did not happen, and when it gave up waiting for it.
 */
export async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Until `predicate` holds, polled, or a failure naming `what` once `ms` have passed. The polling
 * stops either way, so a wait that gave up leaves nothing running to hold the process open.
 */
export async function until(ms: number, what: string, predicate: () => boolean): Promise<void> {
  const poll = { stopped: false };
  try {
    await within(
      ms,
      what,
      (async () => {
        while (!poll.stopped && !predicate()) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
    );
  } finally {
    poll.stopped = true;
  }
}
