import type { Migration } from './types.js';

/**
 * Who stood behind sending each sensor its inherited credentials where it sends them (`A-41`).
 *
 * **An inherited credential set goes wherever the sensor points.** An administrator stores SNMP
 * or SSH credentials on a group, and every sensor beneath uses them — so whoever may write a device
 * there could change its host and receive them. One row per (sensor, kind) records the object the
 * set in force is stored on, the destination it is sent to, and the account that vouched for the
 * pair, which had `write` on that object when it did. A probe's configuration carries the set only
 * while all three still hold and the voucher still has that right.
 *
 * **`destination` is opaque here.** The core fingerprints it — the probe, the device's host and
 * address family, and whichever parameters the sensor type names for that kind — and compares
 * fingerprints; nothing in SQL reads inside one. A NULL user with `account` is an account since
 * deleted, as in `059`, and withholds the set until somebody vouches again.
 *
 * **The rows cannot be backfilled here**, because which types use which kinds, and which of their
 * parameters say where, is the catalogue's to know and SQL cannot ask it. So this marks the
 * installation's existing sensors as not yet vouched for, and the core records the installation as
 * voucher for every pair that resolves, once, at boot, before the probe endpoint serves anything
 * — in one transaction with clearing the mark, so a crash halfway runs it again whole. That is the
 * permissive reading `059` took for the same reason: an upgrade that withheld every credential in
 * the installation would be every credentialed sensor going Unknown at once.
 */
export const migration060: Migration = {
  id: 60,
  name: 'credential-voucher',

  up: `
    CREATE TABLE sensor_credential_voucher (
      sensor_id       bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      kind            credential_kind NOT NULL,
      owner_id        bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      destination     text NOT NULL,
      vouched_by      text NOT NULL CHECK (vouched_by IN ('account', 'installation')),
      vouched_by_user bigint REFERENCES user_account (id) ON DELETE SET NULL,
      vouched_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sensor_id, kind),
      CONSTRAINT sensor_credential_voucher_is_an_account
        CHECK (vouched_by = 'account' OR vouched_by_user IS NULL)
    );
    CREATE INDEX sensor_credential_voucher_owner_idx ON sensor_credential_voucher (owner_id);

    -- One row: true until the core has recorded the installation as voucher for what existed,
    -- and the recipe of the fingerprints recorded — what each type declared, as written — so a
    -- release changing one can tell a record it moved from one somebody moved.
    CREATE TABLE credential_voucher_adoption (
      only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
      pending  boolean NOT NULL,
      recipe   text NOT NULL DEFAULT ''
    );
    INSERT INTO credential_voucher_adoption (pending) VALUES (true);

    COMMENT ON TABLE sensor_credential_voucher IS
      'Who vouched for sending each sensor its inherited credential set where it sends it (A-41).';
    COMMENT ON TABLE credential_voucher_adoption IS
      'Whether the core has yet vouched, as the installation, for the credentials in use (A-41).';
  `,

  down: `
    DROP TABLE credential_voucher_adoption;
    DROP TABLE sensor_credential_voucher;
  `,
};
