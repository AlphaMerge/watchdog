import type { Migration } from './types.js';

/**
 * Probe identity and approval (R-01).
 *
 * **Reaching the port is not the same as being trusted, and until now it was.** A probe that
 * presented the shared access key was given configuration immediately: it became part of the
 * installation because it connected. This table is the gap between the two — a probe is
 * recorded when it arrives and scans nothing until a person approves it, which is PRTG's model
 * and the only one an operator can audit.
 *
 * **Separate from probe_config, because a pending probe has no object yet.** probe_config binds
 * a *branch of the tree* to a GID; this binds an *identity* to a decision. A probe waiting for
 * approval must not appear as a branch — an operator would see a probe in their tree that they
 * never agreed to and that holds no sensors — so the object is created at approval, and the two
 * tables meet at the GID from then on.
 *
 * **The per-probe key is stored as a hash and issued once.** Revoking one probe otherwise means
 * rotating the enrolment key that every other probe shares, which nobody does, which means in
 * practice nothing is ever revoked. The key is generated at approval, sent in that one welcome,
 * and never retrievable afterwards — the same rule the credential vault follows and for the
 * same reason: a value an API can return is a value that ends up in a log.
 */
export const migration030: Migration = {
  id: 30,
  name: 'probe-registration',

  up: `
    CREATE TABLE probe_registration (
      -- The identity itself. Issued by the core on a probe's first connection and persisted by
      -- the probe, so a restart re-presents it rather than enrolling all over again.
      gid            text PRIMARY KEY CHECK (length(gid) BETWEEN 1 AND 128),

      -- pending: seen, recorded, given no configuration at all.
      -- approved: bound to a probe object and scanning.
      -- revoked:  refused at the handshake. Kept rather than deleted, so the same GID cannot
      --           come back by simply reconnecting, and so the log of what was refused survives.
      status         text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'revoked')),

      -- What the probe called itself and what it is running, as reported. Untrusted strings
      -- shown to an operator, which is exactly why they are length-bounded here.
      display_name   text NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
      agent_version  text NOT NULL DEFAULT '' CHECK (length(agent_version) <= 64),
      protocol_version integer NOT NULL DEFAULT 0,

      -- Where it connected from, most recently. Shown beside the approval decision, because
      -- "a probe called backup-01 wants in" is not a decision anybody can make and
      -- "from 10.4.2.9" is.
      last_address   text NOT NULL DEFAULT '' CHECK (length(last_address) <= 64),

      -- Empty means any address. A list of CIDRs means this identity is only accepted from
      -- them: a stolen key is worth much less if it only works from one subnet.
      allow_from     text[] NOT NULL DEFAULT '{}',

      -- argon2 of the key issued at approval. Null until then, because a pending probe has no
      -- key of its own and presents the shared enrolment key instead.
      access_key_hash text,

      -- The branch this identity was bound to. ON DELETE SET NULL rather than CASCADE: deleting
      -- a probe object must not silently un-revoke an identity or lose the record that it was
      -- ever here.
      object_id      bigint REFERENCES object(id) ON DELETE SET NULL,

      -- Why it was refused, for the operator who finds it months later.
      note           text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),

      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz,
      decided_at     timestamptz,
      -- No foreign key: accounts arrive with A-01, and a reference to a table that does not
      -- exist would make this migration unapplyable. A-01 adds the reference where there is
      -- something to reference.
      decided_by     bigint
    );

    -- The administrator's question, asked whenever the probes page is opened: what is waiting.
    CREATE INDEX probe_registration_pending_idx
      ON probe_registration (first_seen_at)
      WHERE status = 'pending';

    -- One *live* identity per branch. Revoked rows are excluded deliberately: a revoked
    -- identity does not hold a branch — that is what revoking means — and the row survives only
    -- so the decision is on record and the GID cannot return by reconnecting. Without the
    -- exclusion, replacing a probe would mean deleting its record first, and deleting the record
    -- is exactly how a revoked GID gets back in.
    CREATE UNIQUE INDEX probe_registration_object_idx
      ON probe_registration (object_id)
      WHERE object_id IS NOT NULL AND status <> 'revoked';

    -- **The local probe cannot be deleted**, matching PRTG, and the flag is set explicitly
    -- rather than guessed. There is no reliable way to tell from the outside which probe runs
    -- beside the core — the address proves nothing on a host with several interfaces, and "the
    -- first one approved" is wrong for anybody who stood up a remote probe first. So the
    -- installer says so at approval (H-05, H-06), and until there is an installer an
    -- operator says so. Deleting it would leave a core whose own host is unmonitored and no
    -- obvious way to get it back.
    ALTER TABLE probe_config ADD COLUMN is_local boolean NOT NULL DEFAULT false;

    -- Every probe that already exists is approved, and keeps its GID. An upgrade must not
    -- suspend an installation's own probes into a queue nobody knew to look at; consent for
    -- these was given when somebody created the object.
    INSERT INTO probe_registration (gid, status, object_id, decided_at, note)
    SELECT gid, 'approved', object_id, now(), 'approved by upgrade: it was already connected'
    FROM probe_config
    WHERE gid IS NOT NULL;
  `,

  down: `
    DROP TABLE IF EXISTS probe_registration;
    ALTER TABLE probe_config DROP COLUMN IF EXISTS is_local;
  `,
};
