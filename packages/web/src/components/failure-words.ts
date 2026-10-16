import type { CheckFailure } from '../api/types';

/**
 * Where a check failed, as words a person reads (`P-285`): what leads, and the host after it when
 * the probe named one. A lead ends where the host goes: "Failed while connecting to" and then
 * "192.0.2.7:22".
 */
export interface FailureWords {
  readonly lead: string;
  readonly target: string | null;
}

/**
 * A transport's phases, each as it reads before a host and with none. **Open**: a probe names
 * phases its sensor types define, and one this table does not know is said as itself rather than
 * hidden, so a new transport needs no web change to be read.
 */
const WHILE: Readonly<Record<string, readonly [withTarget: string, alone: string]>> = {
  resolve: ['Failed while resolving', 'Failed while resolving the device’s name'],
  check: ['Failed while checking whether it may connect to', 'Failed while checking the target'],
  connect: ['Failed while connecting to', 'Failed while connecting'],
  'host-key': ['Failed while checking the host key of', 'Failed while checking the host key'],
  authenticate: ['Failed while authenticating to', 'Failed while authenticating'],
  exec: ['Failed while running its command on', 'Failed while running its command'],
  get: ['Failed while reading from', 'Failed while reading'],
  getNext: ['Failed while reading from', 'Failed while reading'],
  getBulk: ['Failed while reading from', 'Failed while reading'],
  walk: ['Failed while walking a table on', 'Failed while walking a table'],
  query: ['Failed while querying', 'Failed while querying'],
};

/**
 * The runner's own phases, which say what happened to the check rather than where it was: the
 * probe settled it, so its own transport named nothing. `worker-crash` is every way a probe ends
 * up with no answer it can use, not only a crash: a worker or a check process that ended, one
 * that could not be started, an answer it could not read. Its lead says what all of them share,
 * and the message beside it says which.
 */
const RUNNER: Readonly<Record<string, string>> = {
  timeout: 'Did not finish within its timeout',
  aborted: 'Stopped at its timeout',
  'worker-crash': 'The probe got no answer it could use from the check',
  startup: 'The probe could not start it',
  'pool-disabled': 'The probe had stopped running checks',
  'pool-stopped': 'The probe was stopping',
  'unknown-type': 'The probe does not have its sensor type',
};

export function failureWords(failure: CheckFailure): FailureWords {
  const target = failure.target ?? null;
  // `Object.hasOwn`, so a phase named `constructor` is a phase and not the prototype's.
  if (Object.hasOwn(RUNNER, failure.phase)) {
    return { lead: RUNNER[failure.phase] ?? failure.phase, target };
  }
  const known = Object.hasOwn(WHILE, failure.phase) ? WHILE[failure.phase] : undefined;
  if (known !== undefined) return { lead: target === null ? known[1] : known[0], target };
  return {
    lead: target === null ? `Failed in “${failure.phase}”` : `Failed in “${failure.phase}” on`,
    target,
  };
}
