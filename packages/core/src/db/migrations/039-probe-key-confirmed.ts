import type { Migration } from './types.js';

/**
 * When a probe was last seen using the key it was issued (`P-37`).
 *
 * **The column exists because storing a key's hash is not the same as the probe having the
 * key.** `ProbeRegistry` issues an approved probe a key of its own, writes the hash, and returns
 * the key in the welcome that follows. Nothing acknowledges it. Between those two moments the
 * link can drop, the probe can be killed, its spool directory can be read-only — and the core
 * has then rotated the key while the probe has not.
 *
 * What made that unrecoverable was `hasOwnKey`, which read `access_key_hash IS NOT NULL`. A
 * probe with no key of its own presents the *enrolment* key and is accepted on it; the instant a
 * hash is stored that fallback closes, so the probe comes back on the only key it has, is
 * refused, and is refused every time after. The only exit is a human re-approving it.
 *
 * With this column the fallback closes when the probe **uses** its key rather than when the core
 * writes it down. Unconfirmed, the enrolment key is still accepted and a fresh key is issued, so
 * a lost welcome costs one reconnect. Confirmed, only the issued key works, which is the
 * property the enrolment key must not weaken.
 *
 * **Existing rows are confirmed, not left open.** Every probe already carrying a hash has been
 * connecting with it — there has been no other way to stay connected — so backfilling them as
 * unconfirmed would reopen the enrolment fallback for the whole estate on upgrade, which is a
 * security regression to fix a liveness bug. A probe that is genuinely stuck is stuck already
 * and is re-approved, which clears the hash and takes the new path.
 */
export const migration039: Migration = {
  id: 39,
  name: 'probe-key-confirmed',

  up: `
    ALTER TABLE probe_registration
      ADD COLUMN access_key_confirmed_at timestamptz;

    -- A row with a hash has been authenticating with it; see the note above on why these are
    -- confirmed rather than left open. now() rather than last_seen_at, which is null for a probe
    -- approved but never yet connected — and that probe genuinely has not confirmed anything.
    UPDATE probe_registration
      SET access_key_confirmed_at = now()
      WHERE access_key_hash IS NOT NULL AND last_seen_at IS NOT NULL;

    COMMENT ON COLUMN probe_registration.access_key_confirmed_at IS
      'When this probe last authenticated with the key it was issued. Null means the key was '
      'written but never used, so the enrolment key is still accepted and a fresh key is issued '
      'on the next handshake (P-37).';
  `,

  down: `
    ALTER TABLE probe_registration DROP COLUMN access_key_confirmed_at;
  `,
};
