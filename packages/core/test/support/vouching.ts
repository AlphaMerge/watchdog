import type { FactoryReach } from '../../src/factory/reach.js';
import type { VoucherCheck } from '../../src/objects/vouching.js';

/**
 * A voucher check that withholds nothing (`A-29`), for a sweep's test that is not about who
 * vouched. Named for what it claims, as `Visibility.EVERYTHING` is: a test that means "every
 * voucher holds" says so rather than leaving the check out.
 */
export const everyVoucherHolds: VoucherCheck & { withheld(): ReadonlyMap<number, string> } = {
  refusals: () => Promise.resolve(new Map<number, string>()),
  settle: () => Promise.resolve(0),
  withheld: () => new Map<number, string>(),
};

/** Somewhere a factory held for its inputs' probe goes and nothing follows (`M-26`). */
export const nothingFollowsReach: Pick<FactoryReach, 'settle'> = {
  settle: () => Promise.resolve(0),
};
