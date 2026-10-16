import { fitFailure, type CheckFailure } from '@ms/shared';
import type { CheckPhase } from './types.js';

/**
 * Where a failed check failed, for its result (`P-285`): what the error it threw said, when that
 * named a phase (`failureSaid`), else the runner's own phase. **The check's own word first**: a
 * check process that ran out of time throws from the phase it was in (`walk`, `exec`), which is
 * what tells "the agent stopped answering mid-walk" from "the box is gone", and its message says
 * the time ran out. `execute` is never sent: it says only that the check ran and threw, so a
 * plain `Error` leaves no `failure` at all, and absent is "not named", never a guess.
 *
 * Bounded here by `fitFailure` — a phase that is not a word falls back to the runner's, and a
 * target that is not a plain host is left off — so both runners send what the core keeps.
 */
export function failureOf(phase: CheckPhase, said: unknown): CheckFailure | undefined {
  const named = fitFailure(said);
  if (named !== null) return named;
  return phase === 'execute' ? undefined : { phase };
}

/** `failure` among a result's fields: on a failed check only, and only when a phase is named. */
export function failureField(
  outcome: 'ok' | 'error',
  phase: CheckPhase,
  said: unknown,
): { failure?: CheckFailure } {
  if (outcome !== 'error') return {};
  const failure = failureOf(phase, said);
  return failure === undefined ? {} : { failure };
}
