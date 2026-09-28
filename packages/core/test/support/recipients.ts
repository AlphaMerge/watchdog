import type { RecipientSource } from '../../src/notifications/recipients.js';

/**
 * Addresses and nobody else, for a test about the relay rather than about people (`M-19`).
 *
 * A user or group is skipped as unknown, the way the real resolver treats one that does not
 * exist, so a test that needs people resolved says so by using `RecipientResolver` against a
 * database — and a test about SMTP is not quietly depending on an account table.
 */
export const addressesOnly: RecipientSource = {
  resolve: (recipients) =>
    Promise.resolve({
      addresses: recipients
        .filter((recipient) => recipient.kind === 'address')
        .map((recipient) => recipient.value),
      skipped: recipients
        .filter((recipient) => recipient.kind !== 'address')
        .map((recipient) => ({
          who: `${recipient.kind === 'user' ? 'user' : 'group'} "${recipient.value}"`,
          reason:
            recipient.kind === 'user' ? ('no such account' as const) : ('no such group' as const),
        })),
    }),
};
