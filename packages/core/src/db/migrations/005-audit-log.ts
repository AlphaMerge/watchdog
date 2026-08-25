import type { Migration } from './types.js';

/**
 * The configuration audit log (S-10, WORKFLOW.MD §12).
 *
 * Every create, update, move, clone, delete and setting change, with who did it, when, and what
 * changed. The sink that writes here is called inside the mutation's own transaction, so an
 * entry can never exist for a change that rolled back — nor a change without its entry.
 */
export const migration005: Migration = {
  id: 5,
  name: 'audit-log',

  up: `
    CREATE TABLE audit_log (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at          timestamptz NOT NULL,
      action      text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),

      -- ---------------------------------------------------------------------------------------
      -- No foreign key to object, and this one is not a performance trade like the hypertables'.
      -- The most important entry an audit log holds is the one recording a deletion, and a
      -- foreign key would delete it along with its subject. An audit log that forgets what it
      -- audited is not one.
      -- ---------------------------------------------------------------------------------------
      object_id   bigint,
      object_kind object_kind,

      -- Who. Flat rather than a jsonb blob, because "everything this user did" is a question an
      -- audit log exists to answer and it needs an index to answer it. The union is closed and
      -- small, so it is reassembled on read.
      --   user       ref = user id,    label = login
      --   token      ref = token id
      --   system     ref = component name
      --   anonymous  ref = remote address
      actor_kind  text NOT NULL CHECK (actor_kind IN ('user', 'token', 'system', 'anonymous')),
      actor_ref   text NOT NULL,
      actor_label text NOT NULL DEFAULT '',

      -- Bounded structured facts about the change: counts, ids, keys.
      summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- Field-level before and after, for the actions that have one.
      diff        jsonb NOT NULL DEFAULT '[]'::jsonb
    );

    -- The object history tab (A-08): this object's entries, newest first. Ordering by id rather
    -- than by at makes the page stable — two changes in the same millisecond still have an
    -- order, and it is the order they happened in.
    CREATE INDEX audit_log_object_idx ON audit_log (object_id, id DESC);

    -- The global feed, and the retention sweep.
    CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

    -- "What did this actor do." Partial on nothing, but ordered so the answer is a range scan.
    CREATE INDEX audit_log_actor_idx ON audit_log (actor_kind, actor_ref, id DESC);
  `,

  down: `
    DROP TABLE IF EXISTS audit_log;
  `,
};
