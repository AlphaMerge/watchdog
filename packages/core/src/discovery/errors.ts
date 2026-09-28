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
