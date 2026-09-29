import { ConfigError, describeError } from '../errors/app-error.js';
import { writeLineSync } from '../logging/output.js';

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

/**
 * Writes the line to standard error and exits with the status: the end of every start-up failure.
 *
 * **The line is waited for** (`P-216` part 3). `process.stderr.write` on a pipe the journal has
 * stopped reading queues the line and returns, and `process.exit` a moment later discards it:
 * `systemctl status` then says the unit exited 78 and nothing about why. This writes it
 * synchronously, waiting up to two seconds for a stalled journal, and exits either way.
 */
export function exitWithLine(status: number, line: string): never {
  writeLineSync(2, line);
  process.exit(status);
}
