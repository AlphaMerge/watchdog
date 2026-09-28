import { ConfigError, describeError } from '../errors/app-error.js';

/**
 * `EX_CONFIG` from `sysexits.h`: the service refused to start with what it was given.
 *
 * Both units list it in `RestartPreventExitStatus=` (`P-215`), so systemd stops at once rather than
 * restarting into the same refusal. That matters twice over under the units' start limit: a
 * refusal that exited 1 went round five times in about thirty-five seconds and left the unit
 * `failed` with the start limit spent, so the operator's own `systemctl restart`, after fixing
 * the cause, was refused too (`P-222`). Exit 78 uses one start, and the next one is theirs.
 */
export const EX_CONFIG = 78;

/**
 * How a service's `main()` ends when start-up throws: the exit status, and the one line for the
 * journal.
 *
 * **78 for what only a person can fix, 1 for everything else.** A `ConfigError` is a refusal that
 * restarting cannot change — a wrong password, a database that does not exist, a schema this
 * build will not run against. Anything else keeps exit 1, which systemd restarts, because a failure
 * nobody has classified is not known to be permanent. What waiting fixes never gets here: it is
 * waited for where it happens (`docs/administration.md`, *What a start failure does*).
 */
export function startFailure(error: unknown): { status: number; line: string } {
  const { message } = describeError(error);
  return error instanceof ConfigError
    ? { status: EX_CONFIG, line: `Configuration error: ${message}\n` }
    : { status: 1, line: `fatal: ${message}\n` };
}
