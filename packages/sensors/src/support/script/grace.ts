/**
 * How long a script is given to end on `SIGTERM` before its process group is sent `SIGKILL`
 * (`P-262`), whichever limit it ran into. POSIX; on Windows the program is ended at once.
 *
 * **Under the probe runner's kill margin, deliberately.** A script check runs in a process of its
 * own, whose `ctx.signal` aborts at the check's timeout; the runner kills that process 2 s later
 * (`KILL_MARGIN_MS`) if it has not answered. `runProgram`'s default of 5 s would let a script
 * that ignores `SIGTERM` outlive that, and the sensor would read the runner's *did not finish
 * within* instead of what the script was doing. One second ends the script and leaves the other
 * for the answer. The same for the script's own `timeoutMs`, which can sit just below the
 * check's and would otherwise run its grace past the same kill.
 *
 * Here rather than beside the code that uses it so the probe can import it, for the test that
 * holds the two numbers together, without the running path behind it.
 */
export const SCRIPT_GRACE_MS = 1_000;
