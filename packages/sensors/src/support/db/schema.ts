import type { JsonSchema } from '../../contract.js';

/**
 * The database credential (`T-18`).
 *
 * **Flat, not a `oneOf`**, for the reason every other kind here is: the catalogue refuses a
 * `writeOnly` inside a combinator, because `splitCredential` uses the same annotation to decide
 * what is encrypted, and a password landing in `public_params` is a password the API returns.
 *
 * **The kind was already in the `credential_kind` enum** from migration 001, which is why this
 * ticket needed no migration where `T-17`'s mail kind did.
 */
export const DATABASE_CREDENTIAL_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  username: {
    type: 'string',
    maxLength: 255,
    title: 'User name',
    description:
      'A monitoring account, with `SELECT` on what it is watching and nothing else. These ' +
      'sensors run whatever query they are given with whatever rights this account has, so the ' +
      'rights are the only thing standing between a mistyped query and a change to the data.',
  },
  password: {
    type: 'string',
    maxLength: 1_024,
    writeOnly: true,
    title: 'Password',
  },
};
