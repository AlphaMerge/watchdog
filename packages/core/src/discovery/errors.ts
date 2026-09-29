import { AppError, type ErrorContext } from '@ms/shared';

/**
 * What discovery refuses, and with what status (`D-01`).
 *
 * A table rather than a status per throw site, for the reason `objects/errors.ts` gives: two
 * places raising the same condition with different statuses is a difference nobody can act on
 * and nobody notices until a client branches on it.
 */
export type DiscoveryErrorCode =
  | 'DISCOVERY_RANGE_INVALID'
  | 'DISCOVERY_RUN_NOT_FOUND'
  | 'DISCOVERY_SCHEDULE_INVALID'
  | 'DISCOVERY_PROBE_INVALID'
  | 'DISCOVERY_SCHEDULE_CHANGED'
  | 'DISCOVERY_PRECONDITION_REQUIRED'
  | 'DISCOVERY_RUN_FAILED'
  | 'DISCOVERY_FAILED';

export const DISCOVERY_ERROR_STATUS: Readonly<Record<DiscoveryErrorCode, number>> = {
  DISCOVERY_RANGE_INVALID: 400,
  DISCOVERY_RUN_NOT_FOUND: 404,
  // A cadence the calendar cannot fire (`D-07`): an hourly rediscovery asked for minute 180, a
  // time zone this build has never heard of. The caller's mistake, and one they can only fix if
  // we say which value was wrong — a 500 would blame the server and hide the sentence.
  DISCOVERY_SCHEDULE_INVALID: 400,
  // A probe that is not the one the group is under (`A-28`). One status for every wrong probe —
  // hidden, foreign, not a probe, or not there — so the answer says nothing about which.
  DISCOVERY_PROBE_INVALID: 400,
  // An edit made against a version of a rule that is no longer current (`D-11`). 412, as HTTP
  // defines a failed `If-Match` and as an object's edit answers: two people editing one rule
  // must not have the second silently undo the first.
  DISCOVERY_SCHEDULE_CHANGED: 412,
  // An edit that did not say which version it was made against.
  DISCOVERY_PRECONDITION_REQUIRED: 428,
  // Provisioning a run that cannot be provisioned, and has been failed with the reason (`A-41`):
  // its rule was deleted, so nobody stands behind what it found. The run says the same sentence.
  DISCOVERY_RUN_FAILED: 409,
  DISCOVERY_FAILED: 500,
};

export class DiscoveryError extends AppError {
  override readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, message: string, options: { context?: ErrorContext } = {}) {
    super(code, message, { context: options.context ?? {} });
    this.code = code;
    this.name = 'DiscoveryError';
  }

  get status(): number {
    return DISCOVERY_ERROR_STATUS[this.code];
  }
}

/**
 * A discovery run that is not there, and one the caller may not see: one answer (`A-37`).
 *
 * The routes addressed by a run's id throw it for an id nobody used, and the authorisation guard
 * throws it for a run in a group the caller cannot read, so trying ids learns nothing.
 */
export function runNotFound(id: number): DiscoveryError {
  return new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', `there is no discovery run ${String(id)}`, {
    context: { id },
  });
}
