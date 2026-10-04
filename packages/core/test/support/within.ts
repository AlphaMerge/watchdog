/**
 * `promise`, or a failure naming `what` once `ms` have passed.
 *
 * **For every wait on the far end of a socket or a process.** A test's own `timeout` fails the
 * test and does not cancel it, so an `await` that never settles never reaches the `finally` that
 * stops the server or lets go of the lock — and the open handles then keep the whole file's
 * process alive, which is a suite that never finishes rather than a test that fails.
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
