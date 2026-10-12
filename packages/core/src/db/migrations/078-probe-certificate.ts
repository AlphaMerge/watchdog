import type { Migration } from './types.js';

/**
 * The certificate each probe is bound to (`P-326`).
 *
 * mTLS proved only that the installation's CA signed a peer's certificate, and nothing tied that
 * certificate to a GID: any holder of one could name any probe, and only the key stopped it. A
 * pending probe has no key of its own, so the shared enrolment key alone proved it (`P-327`).
 * Each row now records the SHA-256 fingerprint of the certificate that enrolled it, and a hello
 * presenting another is refused before its key is looked at.
 *
 * Null for a row recorded before this: the first hello that proves it binds the certificate it
 * presents, as migration 039 let a key in use before it count as confirmed. An administrator
 * re-pins a probe whose certificate was replaced, to a fingerprint or to null for the next
 * certificate that proves it (`PUT /probes/{gid}/certificate`).
 *
 * The rollback drops both columns; a probe is then bound by its key alone, as before.
 */
export const migration078: Migration = {
  id: 78,
  name: 'probe-certificate',

  up: `
    ALTER TABLE probe_registration
      ADD COLUMN cert_fingerprint text
        CONSTRAINT probe_registration_cert_fingerprint_check
        CHECK (cert_fingerprint IS NULL OR cert_fingerprint ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){31}$'),
      ADD COLUMN cert_bound_at timestamptz
        CONSTRAINT probe_registration_cert_bound_at_check
        CHECK ((cert_bound_at IS NULL) = (cert_fingerprint IS NULL));

    COMMENT ON COLUMN probe_registration.cert_fingerprint IS
      'SHA-256 of the client certificate this probe is bound to, colon-separated hex; null takes the next one that proves it (P-326).';
  `,

  down: `
    ALTER TABLE probe_registration DROP COLUMN cert_bound_at, DROP COLUMN cert_fingerprint;
  `,
};
