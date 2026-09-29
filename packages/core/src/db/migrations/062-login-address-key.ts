import type { Migration } from './types.js';

/**
 * What a login attempt's address counts as (`A-47`).
 *
 * **An IPv6 client is its /64**, so the throttle counts `address_key` — the IPv4 address, or the
 * IPv6 /64 — where it counted the exact address, and one connection rotating through its prefix is
 * one client. `remote_address` keeps the address as it was, because an audit of a breach reads it.
 *
 * **Rows from before this migration are left NULL, and nothing counts them.** A failure counts
 * for fifteen minutes, so the gap is fifteen minutes long, and computing a key in SQL would cast
 * whatever text the column holds to `inet` — a row that is not an address would fail the whole
 * upgrade for a count that stops mattering a quarter of an hour later. The same NULL means a login
 * made before the upgrade does not yet make its address a known one for that account; the first
 * login after it does.
 */
export const migration062: Migration = {
  id: 62,
  name: 'login-address-key',

  up: `
    ALTER TABLE login_attempt
      ADD COLUMN address_key text CHECK (length(address_key) <= 64);
    CREATE INDEX login_attempt_address_key_idx ON login_attempt (address_key, at);
  `,

  down: `
    DROP INDEX login_attempt_address_key_idx;
    ALTER TABLE login_attempt DROP COLUMN address_key;
  `,
};
