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
