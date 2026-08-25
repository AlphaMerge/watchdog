import type { Migration } from './types.js';

/**
 * Manual sibling ordering (S-14).
 *
 * PRTG lets an operator arrange children within a parent by hand — the important device at the
 * top, the noisy one at the bottom — and someone migrating a tree they have hand-ordered for
 * years notices its absence on the first day.
 */
export const migration006: Migration = {
  id: 6,
  name: 'sibling-order',

  up: `
    -- ---------------------------------------------------------------------------------------
    -- Nullable, and null means "never arranged".
    --
    -- Not a default of zero: "the operator has not expressed an opinion" and "the operator put
    -- this first" are different facts, and collapsing them would make every newly created
    -- object claim the top of its parent's list. Null sorts last and falls back to name, so a
    -- tree nobody has touched reads exactly as it did before this column existed.
    --
    -- Deliberately no unique index on (parent_id, sort_order). Reordering rewrites a permutation
    -- of the positions in one statement, and PostgreSQL checks a non-deferrable unique index per
    -- row as it goes — so the transient state halfway through a legal permutation would violate
    -- it. A partial index cannot be deferred (only constraints can, and constraints cannot be
    -- partial). Ordering stays deterministic without it because name and id break every tie.
    -- ---------------------------------------------------------------------------------------
    ALTER TABLE object ADD COLUMN sort_order integer;

    -- The order every listing of children uses, matching
    -- "ORDER BY sort_order NULLS LAST, name, id" exactly so it can be answered by a scan.
    CREATE INDEX object_sibling_order_idx ON object (parent_id, sort_order NULLS LAST, name, id);

    -- ---------------------------------------------------------------------------------------
    -- The same ordering, as a sortable text key.
    --
    -- The tree walk builds a path array and sorts by it, so each level has to contribute
    -- something that compares the way "sort_order NULLS LAST" does. Digits only, and a fixed
    -- width: a punctuation sentinel like '~' would be at the mercy of the database's collation,
    -- where non-alphanumerics can be ignored at the primary weight and would then sort *before*
    -- the arranged siblings rather than after them. Digits order identically under every
    -- collation, and 9,999,999,999 is beyond any child count a parent can have.
    -- ---------------------------------------------------------------------------------------
    -- The parameter is "pos", not "position": position() is a reserved function name in
    -- PostgreSQL and the definition will not parse with it.
    CREATE FUNCTION sibling_key(pos integer) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
    $$ SELECT lpad(pos::text, 10, '0') $$;
  `,

  down: `
    DROP FUNCTION IF EXISTS sibling_key(integer);
    DROP INDEX IF EXISTS object_sibling_order_idx;
    ALTER TABLE object DROP COLUMN IF EXISTS sort_order;
  `,
};
