/**
 * A check's failure that says where it failed (`P-285`, `P-406`).
 *
 * The probe copies `phase` and `host` off the error a check throws, by shape (`failureSaid`), and
 * the result carries them beside the message as `failure`, so the sensor page says "Failed while
 * connecting to 192.0.2.7" without parsing the sentence. `SnmpError`, `SshError` and the two
 * refusals carry fields of their own; a transport whose errors had none extends this.
 *
 * `phase` is a word: a lower-case letter, then letters, digits and hyphens, 32 at most. `host` is
 * the device's host as the check was given it, never a URL, and absent where the failure was on
 * the probe's own machine: a program that could not be started, or a script that ran there.
 * Nothing else of the error crosses (`docs/adding-a-sensor-type.md`).
 */
export class PhasedError extends Error {
  readonly phase: string;
  readonly host: string | undefined;

  constructor(message: string, where: PhasedErrorWhere, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.phase = where.phase;
    // An empty host is none: a Windows check of the probe's own machine is given one.
    this.host = where.host === undefined || where.host === '' ? undefined : where.host;
  }
}

export interface PhasedErrorWhere {
  readonly phase: string;
  readonly host?: string | undefined;
}

/**
 * `error` in other words, and still where it failed (`P-406`): its `phase`, and its `target` or
 * else its `host`, read by shape as the probe reads them, so that whichever transport, the target
 * guard or the policy's refusal threw it keeps them. One that names no phase is a plain `Error`.
 */
export function reworded(error: unknown, message: string): Error {
  const { phase, target, host } = (typeof error === 'object' && error !== null ? error : {}) as {
    phase?: unknown;
    target?: unknown;
    host?: unknown;
  };
  if (typeof phase !== 'string' || phase === '') return new Error(message);
  const where = typeof target === 'string' && target !== '' ? target : host;
  return new PhasedError(message, { phase, host: typeof where === 'string' ? where : undefined });
}
