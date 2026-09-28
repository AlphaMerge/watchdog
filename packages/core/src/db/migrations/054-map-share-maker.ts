import type { Migration } from './types.js';

/**
 * Who made a share link, as an account and not only as a name (`A-22`).
 *
 * **A public map is resolved through its link's maker.** `ADR-002` let a map's stored widget list
 * be its own authorisation on the premise that the list is "exactly what the person who made the
 * link was looking at" — and after `A-12` an author granted one branch can put any id on a
 * canvas, so the premise needs enforcing rather than assuming. Resolving through the maker needs
 * the maker's account, and `created_by` is a login kept as text, deliberately, so that it outlives
 * the account.
 *
 * **Both, then.** `created_by` stays the record; `created_by_user` is the authority, and it goes
 * to NULL when the account is deleted — a link whose maker is gone publishes nothing, which is the
 * same answer a maker who can see nothing gets.
 *
 * **The backfill matches the login as it is now**, folded, the way the unique index compares it.
 * A link whose maker was since renamed or deleted matches nobody, so it stays NULL and goes dark
 * on upgrade: every tile unavailable and every list empty until somebody who can see the objects
 * makes a new link. That is the conservative reading of a link nobody can vouch for, and the
 * findings for `A-22` say so where an operator will look.
 */
export const migration054: Migration = {
  id: 54,
  name: 'map-share-maker',

  up: `
    ALTER TABLE map_share
      ADD COLUMN created_by_user bigint REFERENCES user_account(id) ON DELETE SET NULL;

    UPDATE map_share s
    SET created_by_user = u.id
    FROM user_account u
    WHERE s.created_by <> '' AND lower(u.login) = lower(s.created_by);

    COMMENT ON COLUMN map_share.created_by_user IS
      'The account a public view of this link is resolved through (A-22). NULL publishes nothing.';
  `,

  down: `
    ALTER TABLE map_share DROP COLUMN created_by_user;
  `,
};
