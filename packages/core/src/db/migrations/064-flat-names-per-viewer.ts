import type { Migration } from './types.js';

/**
 * A map's, a report's and a library's name is unique among what the caller can read (`L-06`).
 *
 * **The unique indexes were an existence oracle.** 044, 047 and 053 made each name unique across
 * the installation, so `MAP_NAME_TAKEN`, `REPORT_NAME_TAKEN` and `LIBRARY_NAME_TAKEN` told a
 * writer on one branch what another branch's were called, one guess at a time. The rule moves to
 * `FlatAccess.nameTaken`, which asks only among what the caller can read and serialises each name
 * with an advisory lock. The indexes stay, as plain ones, for that question.
 *
 * **The rollback renames, and `installation.md` says so.** Going back restores the unique indexes,
 * which a database holding two "Core Network"s cannot have. Every duplicate but the oldest,
 * compared as the index compares — case-folded — has " (#<id>)" appended, cut to fit the 100
 * characters a name may have, and its version moves on, so an editor still holding the old name
 * is refused rather than saving it back. A name that clashes even then — somebody already called a
 * map "Core Network (#12)" — fails the rollback whole, and the database stays as it was.
 */
export const migration064: Migration = {
  id: 64,
  name: 'flat-names-per-viewer',

  up: `
    DROP INDEX map_name_idx;
    CREATE INDEX map_name_idx ON map (lower(name));

    DROP INDEX report_name_idx;
    CREATE INDEX report_name_idx ON report (lower(name));

    DROP INDEX library_name_idx;
    CREATE INDEX library_name_idx ON library (lower(name));
  `,

  down: `
    UPDATE map m
    SET name = left(m.name, 100 - length(' (#' || m.id || ')')) || ' (#' || m.id || ')',
        version = m.version + 1
    WHERE EXISTS (SELECT 1 FROM map o WHERE lower(o.name) = lower(m.name) AND o.id < m.id);
    DROP INDEX map_name_idx;
    CREATE UNIQUE INDEX map_name_idx ON map (lower(name));

    UPDATE report r
    SET name = left(r.name, 100 - length(' (#' || r.id || ')')) || ' (#' || r.id || ')',
        version = r.version + 1
    WHERE EXISTS (SELECT 1 FROM report o WHERE lower(o.name) = lower(r.name) AND o.id < r.id);
    DROP INDEX report_name_idx;
    CREATE UNIQUE INDEX report_name_idx ON report (lower(name));

    UPDATE library l
    SET name = left(l.name, 100 - length(' (#' || l.id || ')')) || ' (#' || l.id || ')',
        version = l.version + 1
    WHERE EXISTS (SELECT 1 FROM library o WHERE lower(o.name) = lower(l.name) AND o.id < l.id);
    DROP INDEX library_name_idx;
    CREATE UNIQUE INDEX library_name_idx ON library (lower(name));
  `,
};
