import type { Migration } from './types.js';

/**
 * Libraries, and who may see one (`L-01`, `CAPABILITIES.MD §6`).
 *
 * **A library is not a tree object, for the reason a map is not** (migration 044): `§9` grants
 * access to "tree, libraries, maps and reports" per group, which makes each a first-class thing
 * with its own storage rather than a `kind` on `object`. A library in the tree would have a
 * parent, inherited settings and a pause state, none of which mean anything for a view.
 *
 * **A library holds rules, never sensors** (Phase 14, decision 1). Each node names roots, sensor
 * types, tags and states, and what it shows is evaluated whenever it is read (`L-02`). Nothing is
 * copied, so a sensor in three libraries is checked, stored and alarmed once.
 *
 * **The nodes are one `jsonb` document, for the reason a map's widgets are.** A node's rule names
 * objects that can be deleted underneath it. A child table with a foreign key would have to
 * choose between `ON DELETE CASCADE` — the node's root silently vanishes and it starts showing
 * something else — and `RESTRICT`, where deleting a group fails because somebody once put it in a
 * library. A document keeps the reference, the object goes, and `L-02` renders a node that says
 * so. "Which libraries name group 42?" is a document scan, as it is for maps, and deferred for
 * the same reason: index the shape once `L-02` has settled what it asks.
 *
 * **The document's shape is enforced by `LibraryService`, not here.** The column is only held to
 * being an array: the node count, depth and key uniqueness are checked where the error can say
 * which node is wrong, and a `CHECK` that re-derived them in SQL would be a second copy of the
 * rule to keep in step.
 *
 * **Access is flat and shared.** `library_access` has exactly the shape of `map_access` and
 * `report_access` because `auth/flat-access.ts` answers every one of them with the same SQL; it
 * reuses migration 033's `access_right` enum and `access_rank` ordering for the reason 044 gives.
 */
export const migration053: Migration = {
  id: 53,
  name: 'libraries',

  up: `
    CREATE TABLE library (
      id           bigserial PRIMARY KEY,
      name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),

      -- The 1..5 the tree and maps use, so an operator meets one idea of priority. A library list
      -- sorts by it; it does not reach the Home menu, which §6 gives to maps.
      priority     smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),

      nodes        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(nodes) = 'array'),

      -- Optimistic concurrency, as a map has it: two people arranging one library is the same
      -- situation as two people in a designer, and last-write-wins loses somebody's work silently.
      version      bigint NOT NULL DEFAULT 1,

      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Case-insensitive, like a map's and a group's: "Customer A" and "customer a" are one name.
    CREATE UNIQUE INDEX library_name_idx ON library (lower(name));

    COMMENT ON COLUMN library.nodes IS
      'Library nodes and their rules (L-01, L-02). Deliberately not foreign-keyed to object: a '
      'deleted root must leave a node that says so rather than vanishing or blocking the delete. '
      'Migration 053 documents the reasoning.';

    CREATE TABLE library_access (
      library_id bigint NOT NULL REFERENCES library(id) ON DELETE CASCADE,
      group_id   bigint NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
      right_     access_right NOT NULL,

      granted_at timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account, for the reason object_access gives: an account can be
      -- deleted and the record of who granted a right should outlive it.
      granted_by text NOT NULL DEFAULT '' CHECK (length(granted_by) <= 64),

      PRIMARY KEY (library_id, group_id)
    );

    -- What may this group see? The listing's question, as it is for maps and reports.
    CREATE INDEX library_access_group_idx ON library_access (group_id);

    CREATE TRIGGER library_set_updated_at
      BEFORE UPDATE ON library
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `,

  down: `
    DROP TRIGGER IF EXISTS library_set_updated_at ON library;
    -- library_access first: it points at library.
    DROP TABLE IF EXISTS library_access;
    DROP TABLE IF EXISTS library;
  `,
};
