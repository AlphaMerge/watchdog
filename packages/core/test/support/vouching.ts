import type { FactoryReach } from '../../src/factory/reach.js';
import type { FactoryVouching } from '../../src/factory/service.js';
import { catalogueSensorTypeGate } from '../../src/objects/sensor-type-gate.js';
import {
  SensorVouching,
  type SensorVouchingOptions,
  type VoucherCheck,
} from '../../src/objects/vouching.js';
import { testCatalogue } from './sensor-types.js';
import { silent } from './tree.js';

/**
 * A voucher check that withholds nothing (`A-29`), for a sweep's test that is not about who
 * vouched. Named for what it claims, as `Visibility.EVERYTHING` is: a test that means "every
 * voucher holds" says so rather than leaving the check out. It re-decides nothing, so a factory
 * sweep's test that needs its sets settled into states uses a real `SensorVouching`.
 */
export const everyVoucherHolds: VoucherCheck & FactoryVouching = {
  refusals: () => Promise.resolve(new Map<number, string>()),
  settle: () => Promise.resolve(0),
  settleTogether: () => Promise.resolve(0),
  withheld: () => new Map<number, string>(),
};

/** Somewhere a factory held for its inputs' probe goes and nothing follows (`M-26`). */
export const nothingFollowsReach: Pick<FactoryReach, 'stage'> = {
  stage: () => ({
    entered: [],
    left: [],
    holds: () => false,
    cause: 'probe',
    message: '',
    undo: () => undefined,
  }),
};

/**
 * A real voucher check for a tree the installation vouches for (`M-28`): it refuses nothing and
 * asks no account's sight, and it settles what a factory sweep hands it into states, as
 * production's does.
 */
export function installationVouching(
  options: Pick<SensorVouchingOptions, 'db' | 'states' | 'dependencies'>,
): SensorVouching {
  return new SensorVouching({
    ...options,
    logger: silent,
    sensorTypes: catalogueSensorTypeGate(testCatalogue()),
    sight: () => Promise.reject(new Error('no account vouches for anything in this tree')),
  });
}
