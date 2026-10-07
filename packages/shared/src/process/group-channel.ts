/**
 * Where `runProgram` says a process group of its making has begun and has ended (`P-266`).
 *
 * **For a process whose death would orphan the group.** A program runs in a group of its own, so
 * whoever ends the *caller's* group does not reach it; while the caller lives, `runProgram` ends
 * the program on its deadline or signal. The probe's check process is the caller that can die
 * outright — its runner's `SIGKILL`, a heap exhausted, a crash — and then nothing is left to end
 * the script. It subscribes here and tells its runner, which ends what is still open once the
 * check process has gone.
 *
 * A channel rather than an option, because the caller of `runProgram` is a sensor type, and the
 * process that has to know is the one around it. Nothing subscribes anywhere else, and a publish
 * with no subscriber is not made. POSIX only: on Windows there is no group to name (`H-38`).
 *
 * **A module of its own, behind `@ms/shared/process-group`,** because the check process reads it
 * before its ready line, and that is the probe's start-up (`P-260`): the package's index loads
 * Ajv and the protocol schemas, which a check process has no use for until its check runs.
 */
export const PROGRAM_GROUP_CHANNEL = 'ms:program-group';

/**
 * One message on `PROGRAM_GROUP_CHANNEL`. `started` as soon as the program has a pid, which is its
 * group's id; `ended` once the program has ended and its pipes are read to the end — what it
 * started and left behind, after it ended on its own, stays its own as it always has.
 */
export interface ProgramGroupEvent {
  readonly event: 'started' | 'ended';
  readonly pgid: number;
}
