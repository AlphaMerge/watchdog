import type { Migration } from './types.js';

/**
 * Maps, and who may see one (`G-01`, `CAPABILITIES.MD §6`).
 *
 * **A map is not a tree object, and this table exists because of that.** The hierarchy is Root →
 * Probe → Group → Device → Sensor → Channel; a map is none of them. `§9` grants access to "tree,
 * libraries, maps and reports" per group, which makes a map a first-class thing with its own
 * storage rather than a `kind` on `object`. Putting it in the tree would have meant a map with a
 * parent, inherited settings, a position among sensors and a pause state, none of which mean
 * anything for a dashboard.
 *
 * **The widgets are `jsonb`, and that decides the dangling-reference question by forcing it.** A
 * widget names the sensor it draws; that sensor can be deleted underneath it. Rows in a child
 * table with a foreign key would have to choose between `ON DELETE CASCADE` — the widget silently
 * disappears, so a dashboard quietly stops mentioning the thing that failed — and `RESTRICT`,
 * which makes deleting a sensor fail because somebody once put it on a map. Both are worse than
 * the third option, which is what a document gets for free: the reference stays, the object is
 * gone, and the resolver renders a widget that says so. **`G-02` must therefore report a missing
 * object rather than skipping it**, and that is a requirement this schema creates rather than a
 * detail it leaves open.
 *
 * The cost is that "which maps reference sensor 42?" is a document scan rather than an index
 * lookup. It is a real cost and it is deferred deliberately: the answer wants an index over
 * whatever shape `G-02` settles on, and building one now would be indexing a guess.
 *
 * **Access is flat, unlike `object_access`.** That table walks ancestors because objects nest;
 * maps do not, so a grant is a grant. The two share the `access_right` enum and `access_rank`
 * ordering from migration 033 rather than declaring a second one, because a second one would
 * eventually disagree with the first about what `write` means.
 */
export const migration044: Migration = {
  id: 44,
  name: 'maps',

  up: `
    CREATE TABLE map (
      id           bigserial PRIMARY KEY,
      name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),

      -- Five-star maps surface in the Home menu (§2, and G-09). The same 1..5 the tree uses, so
      -- an operator meets one idea of priority rather than two.
      priority     smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),

      -- The canvas. Empty until G-02 defines a widget; the column exists now so that ticket is a
      -- shape change rather than a migration that has to move live data.
      layout       jsonb NOT NULL DEFAULT '{"widgets": []}'::jsonb,

      -- **Optimistic concurrency, because a designer is a thing two people open at once.** The
      -- object tree already answers If-Match with a version rather than taking last-write-wins,
      -- and a canvas is the place where silently discarding somebody's work is most visible.
      version      bigint NOT NULL DEFAULT 1,

      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Case-insensitive, like user_group: two maps called "Core Network" and "core network" are a
    -- support call, not a feature.
    CREATE UNIQUE INDEX map_name_idx ON map (lower(name));

    -- The Home menu's query (G-09): the five-star maps, newest first.
    CREATE INDEX map_priority_idx ON map (priority DESC, updated_at DESC);

    COMMENT ON COLUMN map.layout IS
      'Widget documents (G-02). Deliberately not foreign-keyed to object: a deleted sensor must '
      'leave a widget that says so rather than vanishing from the dashboard or blocking the '
      'delete. G-01 documents the reasoning.';

    CREATE TABLE map_access (
      map_id     bigint NOT NULL REFERENCES map(id) ON DELETE CASCADE,
      group_id   bigint NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
      right_     access_right NOT NULL,

      granted_at timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account, for the reason object_access gives: an account can be
      -- deleted and the record of who granted a right should outlive it.
      granted_by text NOT NULL DEFAULT '' CHECK (length(granted_by) <= 64),

      PRIMARY KEY (map_id, group_id)
    );

    -- What may this group see? The administrator's question, and the resolver's.
    CREATE INDEX map_access_group_idx ON map_access (group_id);

    -- set_updated_at comes from migration 001, where the object tree declared it. Reusing it
    -- rather than writing a second one that does the same thing slightly differently.
    CREATE TRIGGER map_set_updated_at
      BEFORE UPDATE ON map
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `,

  down: `
    DROP TRIGGER IF EXISTS map_set_updated_at ON map;
    -- map_access first: it points at map, and dropping the parent with a dependent table present
    -- would need a CASCADE that could take something else with it.
    DROP TABLE IF EXISTS map_access;
    DROP TABLE IF EXISTS map;
  `,
};
