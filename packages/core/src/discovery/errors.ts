import { AppError, type ErrorContext } from '@ms/shared';

/**
 * What discovery refuses, and with what status (`D-01`).
 *
 * A table rather than a status per throw site, for the reason `objects/errors.ts` gives: two
 * places raising the same condition with different statuses is a difference nobody can act on
 * and nobody notices until a client branches on it.
 */
export type DiscoveryErrorCode =
  'DISCOVERY_RANGE_INVALID' | 'DISCOVERY_RUN_NOT_FOUND' | 'DISCOVERY_FAILED';

export const DISCOVERY_ERROR_STATUS: Readonly<Record<DiscoveryErrorCode, number>> = {
  DISCOVERY_RANGE_INVALID: 400,
  DISCOVERY_RUN_NOT_FOUND: 404,
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
