import type { VoucherCheck } from '../../src/objects/vouching.js';

/**
 * A voucher check that withholds nothing (`A-29`), for a sweep's test that is not about who
 * vouched. Named for what it claims, as `Visibility.EVERYTHING` is: a test that means "every
 * voucher holds" says so rather than leaving the check out.
 */
export const everyVoucherHolds: VoucherCheck = {
  refusals: () => Promise.resolve(new Map<number, string>()),
  settle: () => Promise.resolve(0),
};
