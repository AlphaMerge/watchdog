/**
 * Why a check was ended, in the words of whoever ended it (`P-262`).
 *
 * For a check that shells out and has to say which limit its program ran into. The probe's
 * check process and pool worker abort with *the check exceeded its timeout*, and a check process
 * sent `SIGTERM` by the probe (as it stops, or past the check's timeout and margin) with *the
 * probe ended the check’s process*; anything else that aborts a check gives a reason of its own.
 * An abort with none is a cancel and says so, rather than Node's *This operation was aborted*.
 */
export function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message !== '') {
    return reason.message;
  }
  if (typeof reason === 'string' && reason !== '') return reason;
  return 'the check was cancelled';
}

/**
 * How `runProgram` ended a program that ran into a limit, as a message says it (`P-262`).
 *
 * **What happened, per platform, and nothing it did not do.** On Linux and every other POSIX
 * system the program's whole process group is sent `SIGTERM`, then `SIGKILL` once `graceMs` has
 * passed if it has not ended: `hardKilled` says it ignored the first. On Windows `SIGTERM` is
 * `TerminateProcess` on the program alone — it cannot be ignored, and what the program started
 * is not ended — and `taskkill /T` is sent only if the program's output is still open `graceMs`
 * later. The 1.0 probe runs on Linux; the Windows tree-kill is a ticket of its own.
 */
export function endedHow(
  hardKilled: boolean,
  graceMs: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return hardKilled
      ? `ended, and taskkill /T was sent ${String(graceMs)} ms later with its output still open`
      : 'ended (on Windows, the program itself: what it started is not ended)';
  }
  return hardKilled
    ? `killed with SIGKILL, having ignored SIGTERM for ${String(graceMs)} ms`
    : 'stopped with SIGTERM';
}
